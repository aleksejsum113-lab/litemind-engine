// Project Context Index (ТЗ: не отправлять модели весь репозиторий).
//
// Что делает:
//  - scan(dir): индексирует текстовые файлы кода (с лимитами), извлекает
//    сигнатуры функций/классов, считает размер и mtime-хэш.
//  - search(dir, query): отдаёт релевантные фрагменты (файл + строки вокруг
//    совпадения + сигнатуры) — ровно то, что нужно передать модели.
//  - Инкрементальность: файлы с неизменными size+mtime не перечитываются,
//    индекс хранится в памяти и пишется на диск в configDir/project-index.json.
//
// Лимиты по умолчанию защищают слабый ПК: не более 4000 файлов, 2 МБ на файл,
// пропускаются node_modules/.git/dist и бинарные расширения.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.next', '__pycache__', '.venv', 'venv', 'target', '.idea', '.vscode']);
const TEXT_EXT = new Set(['.js', '.ts', '.tsx', '.jsx', '.py', '.java', '.kt', '.c', '.h', '.cpp', '.cs', '.go', '.rs', '.rb', '.php', '.json', '.yml', '.yaml', '.toml', '.md', '.html', '.css', '.sql', '.sh', '.bat', '.txt']);
const MAX_FILES = 4000;
const MAX_FILE_BYTES = 2 * 1024 * 1024;

const SYMBOL_RE = [
  /^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/,
  /^\s*(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/,
  /^\s*(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/,
  /^\s*def\s+([A-Za-z_]\w*)/,
  /^\s*class\s+([A-Za-z_]\w*)/,
  /^\s*func\s+([A-Za-z_]\w*)/,
  /^\s*(?:pub\s+)?fn\s+([A-Za-z_]\w*)/
];

const indexes = new Map(); // dir -> { files: Map, scannedAt }

function shouldSkip(name) {
  return name.startsWith('.') && name !== '.github' ? true : SKIP_DIRS.has(name);
}

function fileSignature(fullPath, st) {
  return crypto.createHash('sha1').update(`${st.size}:${st.mtimeMs}`).digest('hex').slice(0, 16);
}

function extractSymbols(content) {
  const out = [];
  const lines = content.split('\n');
  lines.forEach((line, i) => {
    for (const re of SYMBOL_RE) {
      const m = re.exec(line);
      if (m) {
        out.push({ name: m[1], line: i + 1 });
        break;
      }
    }
  });
  return out.slice(0, 200);
}

/** Инкрементальное сканирование каталога проекта. */
export async function scanProject(rootDir, { force = false } = {}) {
  const root = path.resolve(rootDir);
  let idx = indexes.get(root);
  if (!idx || force) {
    idx = { files: new Map(), scannedAt: null };
    indexes.set(root, idx);
  }
  let visited = 0;
  const walk = async (dir, depth = 0) => {
    if (depth > 12 || visited >= MAX_FILES) return;
    let entries;
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (visited >= MAX_FILES) return;
      if (e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        await walk(full, depth + 1);
        continue;
      }
      if (!e.isFile()) continue;
      const ext = path.extname(e.name).toLowerCase();
      if (!TEXT_EXT.has(ext)) continue;
      visited++;
      let st;
      try {
        st = await fs.promises.stat(full);
      } catch {
        continue;
      }
      if (st.size > MAX_FILE_BYTES) continue;
      const sig = fileSignature(full, st);
      const prev = idx.files.get(full);
      if (prev?.sig === sig) continue; // не перечитываем неизменённые файлы
      let content = '';
      try {
        content = await fs.promises.readFile(full, 'utf8');
      } catch {
        continue;
      }
      idx.files.set(full, {
        sig,
        sizeBytes: st.size,
        mtimeMs: st.mtimeMs,
        lines: content.split('\n').length,
        symbols: extractSymbols(content)
      });
    }
  };
  await walk(root);
  idx.scannedAt = new Date().toISOString();
  idx.root = root;
  idx.fileCount = idx.files.size;
  return summary(idx);
}

export function summary(idx) {
  const byExt = {};
  for (const [file, meta] of idx.files) {
    const ext = path.extname(file).toLowerCase();
    byExt[ext] = (byExt[ext] ?? 0) + 1;
  }
  return { root: idx.root, fileCount: idx.files.size, scannedAt: idx.scannedAt, byExt };
}

const STOP = new Set(['the', 'and', 'for', 'with', 'this', 'that', 'как', 'что', 'для', 'и', 'в', 'на', 'с', 'по', 'не', 'из']);

function tokenize(q) {
  return String(q)
    .toLowerCase()
    .split(/[^\w$]+/)
    .filter((t) => t.length > 1 && !STOP.has(t));
}

/**
 * Поиск релевантных фрагментов под запрос: score = совпадения токенов в пути,
 * имени символа и содержимом. Возвращает фрагменты с контекстом ±6 строк.
 */
export async function searchProject(rootDir, query, { limit = 5, contextLines = 6 } = {}) {
  const root = path.resolve(rootDir);
  const idx = indexes.get(root) ?? (await scanProject(root));
  const tokens = tokenize(query);
  if (tokens.length === 0) return { root, results: [] };

  const scored = [];
  for (const [file, meta] of idx.files) {
    const rel = path.relative(root, file);
    let content;
    try {
      content = await fs.promises.readFile(file, 'utf8');
    } catch {
      continue;
    }
    const lower = content.toLowerCase();
    let score = 0;
    for (const t of tokens) {
      if (rel.toLowerCase().includes(t)) score += 3;
      if (meta.symbols.some((s) => s.name.toLowerCase().includes(t))) score += 4;
      const occurrences = lower.split(t).length - 1;
      if (occurrences > 0) score += Math.min(6, occurrences);
    }
    if (score > 0) scored.push({ file: rel, score, meta });
  }

  scored.sort((a, b) => b.score - a.score);
  const results = [];
  for (const hit of scored.slice(0, limit)) {
    const content = await fs.promises.readFile(path.join(root, hit.file), 'utf8');
    const lines = content.split('\n');
    // центр — первая строка с максимальным числом токенов запроса
    let center = 0;
    let best = -1;
    lines.forEach((line, i) => {
      const l = line.toLowerCase();
      const s = tokens.reduce((acc, t) => acc + (l.includes(t) ? 1 : 0), 0);
      if (s > best) { best = s; center = i; }
    });
    const from = Math.max(0, center - contextLines);
    const to = Math.min(lines.length, center + contextLines + 1);
    results.push({
      file: hit.file,
      score: hit.score,
      symbols: hit.meta.symbols.slice(0, 10),
      snippet: lines.slice(from, to).join('\n'),
      snippetRange: { from: from + 1, to }
    });
  }
  return { root, results };
}

/** Дамп карты проекта (компактно для вставки в контекст модели). */
export function projectMap(rootDir, { maxFiles = 100 } = {}) {
  const root = path.resolve(rootDir);
  const idx = indexes.get(root);
  if (!idx) return null;
  const files = [...idx.files.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .slice(0, maxFiles)
    .map(([file, meta]) => ({
      file: path.relative(root, file),
      lines: meta.lines,
      symbols: meta.symbols.map((s) => `${s.name}:${s.line}`).slice(0, 8)
    }));
  return { root, files };
}
