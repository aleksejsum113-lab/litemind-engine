// Этап 1В: файловая подсистема Projects/Workspace.
//
// Всё работает с реальными каталогами и файлами, асинхронно и с жёсткими
// лимитами, чтобы просмотр проекта не тормозил слабый ПК:
//  - ленивое дерево (по одному уровню за запрос) вместо чтения всего проекта;
//  - поиск файлов по имени и поиск текста с номерами строк;
//  - сборка контекста проекта для чата из явно выбранных пользователем файлов;
//  - резервные копии перед изменением файлов по требованию ИИ (в папке
//    конфигурации движка, НЕ внутри проекта пользователя);
//  - честный декодер вывода консоли Windows (UTF-8 → CP866 → windows-1251).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// Тяжёлые служебные каталоги — не сканируем ни при каком поиске.
export const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', '.next', 'nuxt',
  '__pycache__', '.venv', 'venv', 'env', 'target', '.idea', '.vscode',
  '.gradle', '.cache', 'coverage', '.pytest_cache', '.mypy_cache',
  'vendor', '.tox', '.terraform', 'obj'
]);

const BINARY_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp', '.tiff', '.pdf',
  '.zip', '.7z', '.rar', '.gz', '.bz2', '.xz', '.tar', '.exe', '.dll', '.so',
  '.dylib', '.a', '.lib', '.o', '.obj', '.class', '.jar', '.wasm', '.pyc',
  '.pyd', '.node', '.ttf', '.otf', '.woff', '.woff2', '.eot', '.mp3', '.mp4',
  '.avi', '.mkv', '.mov', '.wav', '.ogg', '.flac', '.db', '.sqlite',
  '.sqlite3', '.gguf', '.bin', '.dat', '.iso', '.msi', '.apk', '.psd'
]);

const MAX_DIR_ENTRIES = 800;   // записей на каталог дерева
const MAX_WALK_FILES = 6000;   // предохранитель для рекурсивных обходов
const MAX_GREP_FILE_BYTES = 2 * 1024 * 1024;
const MAX_GREP_TOTAL_BYTES = 32 * 1024 * 1024;
const MAX_CONTEXT_FILES = 50;
const MAX_CONTEXT_FILE_CHARS = 120_000;
const MAX_CONTEXT_TOTAL_CHARS = 900_000;

export function isBinaryName(name) {
  return BINARY_EXT.has(path.extname(name).toLowerCase());
}

function excluded(name, extra) {
  if (name.startsWith('.')) return true;
  return SKIP_DIRS.has(name) || extra.has(name.toLowerCase());
}

function isInside(root, target) {
  const rel = path.relative(root, target);
  return rel !== '' && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
}

/** Дочерние записи одного каталога (ленивое дерево, Этап 1В §2). */
export async function listTree(rootDir, relDir = '', { exclude = [], limit = MAX_DIR_ENTRIES } = {}) {
  const root = path.resolve(rootDir);
  const extra = new Set(exclude.map((e) => String(e).toLowerCase()));
  const dirAbs = relDir ? path.resolve(root, relDir) : root;
  if (dirAbs !== root && !isInside(root, dirAbs)) {
    throw Object.assign(new Error('каталог вне проекта'), { status: 400 });
  }
  let entries;
  try {
    entries = await fs.promises.readdir(dirAbs, { withFileTypes: true });
  } catch (err) {
    throw Object.assign(new Error(`Каталог недоступен: ${err.code ?? err.message}`), {
      status: err.code === 'ENOENT' ? 404 : 400
    });
  }
  const dirs = [];
  const files = [];
  const skipped = [];
  let seen = 0;
  for (const e of entries) {
    if (e.name.startsWith('.')) {
      // Скрытые: не индексируем, но в дереве показываем .gitignore/.gitattributes —
      // их содержимое пользователю полезно.
      if (!['.gitignore', '.gitattributes', '.env.example', '.editorconfig'].includes(e.name)) {
        skipped.push(e.name);
        continue;
      }
    }
    if (SKIP_DIRS.has(e.name) || extra.has(e.name.toLowerCase())) {
      if (!skipped.includes(e.name)) skipped.push(e.name);
      continue;
    }
    seen++;
    if (dirs.length + files.length >= limit) continue; // считаем все, отдаём лимит
    const rel = relDir ? relDir.replaceAll('\\', '/').replace(/\/$/, '') + '/' + e.name : e.name;
    if (e.isDirectory()) {
      let hasChildren = null;
      try {
        const kids = await fs.promises.readdir(path.join(dirAbs, e.name), { withFileTypes: true });
        hasChildren = kids.some((k) => !excluded(k.name, extra));
      } catch { hasChildren = false; }
      dirs.push({ name: e.name, rel, hasChildren });
    } else if (e.isFile()) {
      let st = null;
      try { st = await fs.promises.stat(path.join(dirAbs, e.name)); } catch { /* доступ пропал — без размера */ }
      files.push({
        name: e.name, rel,
        sizeBytes: st?.size ?? null,
        mtimeMs: st?.mtimeMs ?? null,
        binary: isBinaryName(e.name)
      });
    }
  }
  dirs.sort((a, b) => a.name.localeCompare(b.name, 'ru'));
  files.sort((a, b) => a.name.localeCompare(b.name, 'ru'));
  return {
    root, dir: relDir, dirs: dirs.slice(0, limit), files: files.slice(0, limit),
    skipped: skipped.slice(0, 20),
    truncated: seen > dirs.length + files.length,
    totalEntries: seen
  };
}

/** Рекурсивный обход с лимитами; visitor получает абсолютные пути файлов. */
async function walkFiles(root, exclude, visitor) {
  const extra = new Set(exclude.map((e) => String(e).toLowerCase()));
  let visited = 0;
  const walk = async (dir, depth) => {
    if (depth > 14 || visited >= MAX_WALK_FILES) return;
    let entries;
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch { return; }
    for (const e of entries) {
      if (visited >= MAX_WALK_FILES) return;
      if (excluded(e.name, extra)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { await walk(full, depth + 1); continue; }
      if (!e.isFile()) continue;
      visited++;
      if (await visitor(full, e.name) === false) return;
    }
  };
  await walk(path.resolve(root), 0);
  return visited;
}

/** Поиск файлов по имени (подстрока, без регистра). */
export async function findFiles(rootDir, query, { exclude = [], limit = 100 } = {}) {
  const root = path.resolve(rootDir);
  const q = String(query).toLowerCase();
  if (!q) return { root, files: [], truncated: false, scanned: 0 };
  const hits = [];
  let truncated = false;
  const scanned = await walkFiles(root, exclude, async (full, name) => {
    if (name.toLowerCase().includes(q)) {
      if (hits.length >= limit) { truncated = true; return false; }
      let st = null;
      try { st = await fs.promises.stat(full); } catch { /* нет доступа — без размера */ }
      hits.push({ name, rel: path.relative(root, full), sizeBytes: st?.size ?? null, mtimeMs: st?.mtimeMs ?? null });
    }
    return true;
  });
  return { root, files: hits, truncated, scanned };
}

/** Поиск текста внутри файлов: номер строки, позиция, строка целиком. */
export async function grepFiles(rootDir, query, { exclude = [], limit = 60, perFile = 5, caseSensitive = false } = {}) {
  const root = path.resolve(rootDir);
  const q = String(query);
  if (!q) return { root, results: [], truncated: false, scannedFiles: 0, scannedBytes: 0 };
  const needle = caseSensitive ? q : q.toLowerCase();
  const results = [];
  let truncated = false;
  let scannedBytes = 0;
  const scannedFiles = await walkFiles(root, exclude, async (full, name) => {
    if (isBinaryName(name)) return true;
    let st;
    try { st = await fs.promises.stat(full); } catch { return true; }
    if (st.size > MAX_GREP_FILE_BYTES) return true;
    if (scannedBytes + st.size > MAX_GREP_TOTAL_BYTES) { truncated = true; return false; }
    let content;
    try { content = await fs.promises.readFile(full); } catch { return true; }
    scannedBytes += st.size;
    const head = content.subarray(0, 8192);
    if (head.includes(0)) return true; // бинарник
    const text = content.toString('utf8');
    const lines = text.split('\n');
    let inFile = 0;
    for (let i = 0; i < lines.length; i++) {
      const hay = caseSensitive ? lines[i] : lines[i].toLowerCase();
      const col = hay.indexOf(needle);
      if (col === -1) continue;
      if (results.length >= limit) { truncated = true; return false; }
      if (inFile >= perFile) continue;
      results.push({
        file: path.relative(root, full),
        lineNo: i + 1,
        col: col + 1,
        line: lines[i].slice(0, 300)
      });
      inFile++;
    }
    return true;
  });
  return { root, results, truncated, scannedFiles, scannedBytes };
}

/** Открытие проекта: папка существует, это каталог, он читается. */
export async function openProject(dirRaw) {
  const dir = path.resolve(String(dirRaw || ''));
  let st;
  try {
    st = await fs.promises.stat(dir);
  } catch (err) {
    return { ok: false, path: dir, name: path.basename(dir) || dir, accessible: false, reason: `папка не найдена (${err.code ?? 'ошибка'})` };
  }
  if (!st.isDirectory()) {
    return { ok: false, path: dir, name: path.basename(dir) || dir, accessible: false, reason: 'по этому пути файл, а не папка' };
  }
  try {
    await fs.promises.access(dir, fs.constants.R_OK | fs.constants.X_OK);
  } catch (err) {
    return { ok: false, path: dir, name: path.basename(dir) || dir, accessible: false, reason: `нет доступа (${err.code ?? 'ошибка'})` };
  }
  return { ok: true, path: dir, name: path.basename(dir) || dir, accessible: true };
}

/** Создание папки проекта (mkdir -p). Существующий каталог — не ошибка. */
export async function createProject(dirRaw) {
  const dir = path.resolve(String(dirRaw || ''));
  if (!dir || dir === path.parse(dir).root) {
    return { ok: false, path: dir, reason: 'нельзя сделать проектом корень диска' };
  }
  let st = null;
  try { st = await fs.promises.stat(dir); } catch { /* ещё нет — создадим */ }
  if (st && !st.isDirectory()) {
    return { ok: false, path: dir, reason: 'по этому пути уже лежит файл' };
  }
  try {
    await fs.promises.mkdir(dir, { recursive: true });
  } catch (err) {
    return { ok: false, path: dir, reason: `не удалось создать папку: ${err.code ?? err.message}` };
  }
  return { ...(await openProject(dir)), created: !st };
}

/** Нормализовать относительный путь файла и проверить, что он внутри проекта. */
export function safeRelPath(root, rel) {
  const file = path.resolve(root, String(rel ?? ''));
  if (!isInside(root, file)) {
    throw Object.assign(new Error('файл вне каталога проекта'), { status: 400 });
  }
  return { file, rel: path.relative(root, file) };
}

/**
 * Контекст проекта для чата (Этап 1В §2): только явно выбранные пользователем
 * файлы/папки, лимиты на файл и на сумму; бинарные/большие/недоступные —
 * честное warning вместо тихой порчи содержимого. Папка (путь со слешем на
 * конце) раскрывается в свои текстовые файлы с лимитом на количество.
 */
export async function buildContext(rootDir, relFiles, {
  perFileChars = MAX_CONTEXT_FILE_CHARS,
  totalChars = MAX_CONTEXT_TOTAL_CHARS,
  maxFiles = MAX_CONTEXT_FILES,
  maxFilesPerFolder = 30
} = {}) {
  const root = path.resolve(rootDir);
  const raw = (Array.isArray(relFiles) ? relFiles : []).map(String);
  // Папки раскрываем в файлы сразу, честно считая, сколько всего выбрано.
  const expanded = [];
  for (const entry of raw) {
    if (entry.endsWith('/') || entry.endsWith('\\')) {
      const added = await expandFolder(root, entry, { exclude: [], maxFilesPerFolder });
      expanded.push(...added.files);
      expanded.folderWarnings = expanded.folderWarnings ?? [];
      for (const w of added.warnings) expanded.folderWarnings.push(w);
    } else {
      expanded.push(entry);
    }
  }
  const list = expanded.slice(0, maxFiles);
  const files = [];
  let total = 0;
  const skippedTooMany = Math.max(0, expanded.length - list.length);
  for (const rel of list) {
    let fileAbs;
    try {
      ({ file: fileAbs } = safeRelPath(root, rel));
    } catch (err) {
      files.push({ file: rel, ok: false, warning: err.message });
      continue;
    }
    let st;
    try { st = await fs.promises.stat(fileAbs); } catch {
      files.push({ file: rel, ok: false, warning: 'файл не найден' });
      continue;
    }
    if (!st.isFile()) { files.push({ file: rel, ok: false, warning: 'это не файл' }); continue; }
    if (isBinaryName(rel)) { files.push({ file: rel, ok: false, sizeBytes: st.size, warning: 'бинарный формат — содержимое не передаётся' }); continue; }
    if (st.size > MAX_GREP_FILE_BYTES) {
      files.push({ file: rel, ok: false, sizeBytes: st.size, warning: `файл больше ${Math.round(MAX_GREP_FILE_BYTES / 1024 / 1024)} МиБ — слишком большой для контекста` });
      continue;
    }
    let buf;
    try { buf = await fs.promises.readFile(fileAbs); } catch (err) {
      files.push({ file: rel, ok: false, warning: `не читается: ${err.code ?? err.message}` });
      continue;
    }
    if (buf.subarray(0, 8192).includes(0)) { files.push({ file: rel, ok: false, sizeBytes: st.size, warning: 'бинарный файл — содержимое не передаётся' }); continue; }
    const remain = totalChars - total;
    if (remain <= 0) { files.push({ file: rel, ok: false, sizeBytes: st.size, warning: 'лимит общего размера контекста исчерпан — файл не передан' }); continue; }
    let text = buf.toString('utf8');
    let truncatedFile = false;
    if (text.length > perFileChars) { text = text.slice(0, perFileChars); truncatedFile = true; }
    if (text.length > remain) { text = text.slice(0, Math.max(0, remain)); truncatedFile = true; }
    total += text.length;
    files.push({
      file: path.relative(root, fileAbs),
      ok: true,
      sizeBytes: st.size,
      chars: text.length,
      truncated: truncatedFile,
      content: text
    });
  }
  if (expanded.folderWarnings?.length) files.folderWarnings = expanded.folderWarnings;
  return { root, files, totalChars: total, skippedTooMany, limits: { perFileChars, totalChars, maxFiles } };
}

/** Раскрытие папки в список текстовых файлов (для контекста чата). */
async function expandFolder(root, relDir, { maxFilesPerFolder, exclude }) {
  const warnings = [];
  const dirAbs = path.resolve(root, relDir);
  if (!isInside(root, dirAbs)) return { files: [], warnings: [`папка вне проекта: ${relDir}`] };
  const extra = new Set((exclude ?? []).map((e) => String(e).toLowerCase()));
  const out = [];
  let visited = 0;
  const walk = async (dir, depth) => {
    if (depth > 10 || out.length >= maxFilesPerFolder || visited >= MAX_WALK_FILES) return;
    let entries;
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (out.length >= maxFilesPerFolder || visited >= MAX_WALK_FILES) return;
      if (excluded(e.name, extra)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { await walk(full, depth + 1); continue; }
      if (!e.isFile()) continue;
      visited++;
      if (isBinaryName(e.name)) continue;
      let st;
      try { st = await fs.promises.stat(full); } catch { continue; }
      if (st.size > MAX_GREP_FILE_BYTES) continue;
      out.push(path.relative(root, full));
    }
  };
  try {
    const st = await fs.promises.stat(dirAbs);
    if (!st.isDirectory()) return { files: [], warnings: [`это не папка: ${relDir}`] };
    await walk(dirAbs, 0);
  } catch {
    return { files: [], warnings: [`папка недоступна: ${relDir}`] };
  }
  if (out.length >= maxFilesPerFolder) {
    warnings.push(`в папке ${relDir} взяты первые ${maxFilesPerFolder} текстовых файлов — добавьте файлы точечно, если нужно больше`);
  }
  return { files: out.sort(), warnings };
}

// --------------------------------------------------------------------------
// Резервные копии перед изменением файлов через ИИ (Этап 1В §3).
// Хранятся ВНЕ проекта: <папка конфигурации>/project-backups/<hash корня>/.
// --------------------------------------------------------------------------

function backupsDirFor(root, configPath) {
  const base = configPath ? path.dirname(configPath) : process.cwd();
  const hash = crypto.createHash('sha1').update(path.resolve(root)).digest('hex').slice(0, 12);
  return path.join(base, 'project-backups', hash);
}

const encodeRel = (rel) => encodeURIComponent(rel).replace(/[*]/g, '~');

function parseBackupId(id) {
  const m = /^(.*)\.(\d{13,})\.bak$/.exec(String(id ?? ''));
  if (!m) throw Object.assign(new Error('неверный id резервной копии'), { status: 400 });
  return { rel: decodeURIComponent(m[1]), ts: m[2] };
}

/** Копия текущего содержимого файла в хранилище резервных копий. */
export async function makeBackup(root, rel, { configPath } = {}) {
  const { file, rel: cleanRel } = safeRelPath(root, rel);
  const buf = await fs.promises.readFile(file); // ENOENT пробросится: менять нечего
  const dir = backupsDirFor(root, configPath);
  await fs.promises.mkdir(dir, { recursive: true });
  const ts = Date.now();
  const name = backupName(cleanRel, ts);
  const dest = path.join(dir, name);
  await fs.promises.writeFile(dest, buf);
  return { backupId: name, backupPath: dest, sizeBytes: buf.length, ts };
}

function backupName(rel, ts) {
  return `${encodeRel(rel)}.${ts}.bak`;
}

/** Список копий одного файла, новые сверху. */
export async function listBackups(root, rel, { configPath } = {}) {
  const { rel: cleanRel } = safeRelPath(root, rel);
  const dir = backupsDirFor(root, configPath);
  let names = [];
  try { names = await fs.promises.readdir(dir); } catch { return []; }
  const prefix = encodeRel(cleanRel) + '.';
  return names.filter((n) => n.startsWith(prefix) && n.endsWith('.bak'))
    .sort((a, b) => b.localeCompare(a))
    .map((n) => {
      const st = fs.statSync(path.join(dir, n));
      return { backupId: n, ts: Number(n.slice(prefix.length, -4)), sizeBytes: st.size };
    });
}

/** Содержимое резервной копии по id. */
export async function readBackup(root, backupId, { configPath } = {}) {
  const { rel } = parseBackupId(backupId);
  const dir = backupsDirFor(root, configPath);
  const name = path.basename(String(backupId));
  if (!name.endsWith('.bak') || name.includes('/') || name.includes('\\')) {
    throw Object.assign(new Error('неверный id резервной копии'), { status: 400 });
  }
  const buf = await fs.promises.readFile(path.join(dir, name));
  return { rel, content: buf.toString('utf8'), sizeBytes: buf.length };
}

// --------------------------------------------------------------------------
// Декодер вывода консоли: Windows CMD печатает по-русски в CP866, PowerShell
// и современные утилиты — в UTF-8 или windows-1251. Определяем по факту:
// строгий UTF-8 прошёл — значит UTF-8; появились битые байты — CP866;
// остались дыры — windows-1251. Кодировка сообщается в ответе честно.
// --------------------------------------------------------------------------

export function makeOutputDecoder() {
  let dec = null;
  let encoding = 'utf8';
  let decided = false;
  const buildUtf8Strict = () => { try { return new TextDecoder('utf-8', { fatal: true }); } catch { return null; } };
  const build = (enc) => { try { return new TextDecoder(enc); } catch { return null; } };

  function pick(raw) {
    // UTF-8 сначала: строгий декодер с буферизацией незавершённых последовательностей.
    const utf8 = buildUtf8Strict();
    if (utf8) {
      try {
        const text = utf8.decode(raw, { stream: true });
        decided = true;
        encoding = 'utf8';
        dec = utf8;
        return text;
      } catch { /* не UTF-8 — попробуем однобайтовые кодировки */ }
    }
    for (const enc of ['ibm866', 'windows-1251']) {
      const d = build(enc);
      if (!d) continue;
      const text = d.decode(raw, { stream: true });
      if (!text.includes('\uFFFD')) {
        decided = true;
        encoding = enc === 'ibm866' ? 'cp866' : 'windows-1251';
        dec = d;
        return text;
      }
    }
    // Никакая не подошла идеально — берём UTF-8 с заменами.
    decided = true;
    encoding = 'utf8';
    dec = buildUtf8Strict() ?? build('utf-8');
    return dec.decode(raw, { stream: true });
  }

  return {
    push(raw) {
      if (!decided) return pick(raw);
      try {
        return dec.decode(raw, { stream: true });
      } catch {
        // Строгий UTF-8 споткнулся посреди потока — сбрасываем состояние.
        dec = build('utf-8');
        return dec.decode(raw);
      }
    },
    encoding: () => (decided ? encoding : null)
  };
}

/** Полный буфер → текст (для финального события и буферизованного режима). */
export function decodeBuffer(raw) {
  const strict = (() => { try { return new TextDecoder('utf-8', { fatal: true }); } catch { return null; } })();
  if (strict) {
    try { return { encoding: 'utf8', text: strict.decode(raw) }; } catch { /* ниже */ }
  }
  for (const enc of ['ibm866', 'windows-1251']) {
    const d = (() => { try { return new TextDecoder(enc); } catch { return null; } })();
    if (!d) continue;
    const text = d.decode(raw);
    if (!text.includes('\uFFFD')) return { encoding: enc === 'ibm866' ? 'cp866' : 'windows-1251', text };
  }
  const d = (() => { try { return new TextDecoder('utf-8'); } catch { return null; } })();
  return { encoding: 'utf8', text: d ? d.decode(raw) : raw.toString('utf8') };
}
