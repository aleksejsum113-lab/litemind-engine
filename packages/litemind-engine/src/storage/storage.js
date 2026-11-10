// Storage — папка моделей, перенос с проверкой целостности, реестр
// пользовательских GGUF (Этап 1Б §5.2, §6).
//
// Принципы ТЗ:
//  - при изменении пути старые файлы НЕ удаляются (копирование, а не перенос);
//    удаление источника — только опционально и только после успешной сверки
//    SHA-256 обеих копий;
//  - ни один файл не помечается «установленным», пока не проверен;
//  - реестр пользовательских моделей (файлы вне папки моделей) живёт в папке
//    конфигурации и не является каталогом: метаданные — только из GGUF-заголовка.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { readGgufHeader } from '../backends/gguf.js';

export class StorageError extends Error {
  constructor(message, { code = 'STORAGE_ERROR', status = 400 } = {}) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

// ── Безопасность загрузок (§5.5) ─────────────────────────────────────────────

// Допустимые источники GGUF. Официальные Hugging Face + их CDN-домены
// (redirect: 'follow' уводит скачивание на CDN — финальный хост проверяется
// тем же списком). Расширяемо: добавить домен = одна строка.
export const ALLOWED_DOWNLOAD_HOSTS = [
  'huggingface.co',
  'hf.co',
  'xethub.hf.co',
  'cas-bridge.xethub.hf.co',
  'transfer.xethub.hf.co'
];
const ALLOWED_HOST_SUFFIXES = ['.huggingface.co', '.hf.co'];

/** URL должен вести на официальный источник GGUF и заканчиваться на .gguf.
 *  allowLoopbackHttp — только для тестового стенда (локальный http-сервер
 *  вместо HF); в продакшне выключен по умолчанию и не ослабляет проверку
 *  реальных источников. */
export function checkDownloadUrl(rawUrl, { allowLoopbackHttp = false } = {}) {
  let u;
  try { u = new URL(rawUrl); } catch { return { ok: false, reason: 'URL не распознан' }; }
  if (u.protocol !== 'https:') {
    const isLoopbackHttp = u.protocol === 'http:' && ['127.0.0.1', '::1', 'localhost'].includes(u.hostname);
    if (!(allowLoopbackHttp && isLoopbackHttp)) {
      return { ok: false, reason: `Протокол ${u.protocol} запрещён — только https.` };
    }
  } else {
    const host = u.hostname.toLowerCase();
    const allowed = ALLOWED_DOWNLOAD_HOSTS.includes(host) || ALLOWED_HOST_SUFFIXES.some((s) => host.endsWith(s));
    if (!allowed) return { ok: false, reason: `Источник ${host} не входит в список разрешённых (официальные Hugging Face).` };
  }
  if (!/\.gguf$/i.test(u.pathname)) return { ok: false, reason: 'Загружать можно только файлы .gguf — исполняемые файлы под видом моделей запрещены.' };
  return { ok: true };
}

/** Имя файла: простой basename с расширением .gguf, без пути и обхода папок. */
export function safeGgufName(name) {
  const base = String(name || '').split(/[\\/]/).pop();
  if (!/\.gguf$/i.test(base)) throw new StorageError('Имя файла должно оканчиваться на .gguf.', { code: 'BAD_NAME' });
  if (base.startsWith('.')) throw new StorageError('Скрытые файлы недопустимы.', { code: 'BAD_NAME' });
  if (/[^\w.\-+() ]/.test(base)) throw new StorageError(`Имя файла содержит недопустимые символы: ${base}`, { code: 'BAD_NAME' });
  return base;
}

/** targetDir: абсолютный, без «..» после нормализации. */
export function safeTargetDir(dir) {
  if (!dir || typeof dir !== 'string' || !dir.trim()) throw new StorageError('Не указана папка сохранения.', { code: 'BAD_DIR' });
  const resolved = path.resolve(dir.trim());
  const parts = resolved.split(path.sep);
  if (parts.includes('..')) throw new StorageError('Путь не должен содержать «..».', { code: 'BAD_DIR' });
  return resolved;
}

// ── SHA-256 (потоковый, для многогигабайтных файлов) ─────────────────────────

export function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(file);
    stream.on('data', (c) => hash.update(c));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

// ── Информация о хранилище (§5.2) ────────────────────────────────────────────

/** Свободное место на диске, где лежит папка. */
export function diskSpace(dir) {
  try {
    const st = fs.statfsSync(dir);
    return { freeBytes: st.bsize * st.bfree, totalBytes: st.bsize * st.blocks };
  } catch {
    return { freeBytes: null, totalBytes: null };
  }
}

/** Размер установленных моделей + проверка существующих путей. */
export async function storageReport(rootDir, registeredModels = []) {
  const report = { rootDir, exists: fs.existsSync(rootDir), models: [], totalBytes: 0, partBytes: 0 };
  if (report.exists) {
    let entries = [];
    try { entries = await fs.promises.readdir(rootDir, { withFileTypes: true }); } catch { entries = []; }
    for (const e of entries) {
      if (!e.isFile()) continue;
      const full = path.join(rootDir, e.name);
      const st = await fs.promises.stat(full).catch(() => null);
      if (!st) continue;
      if (/\.gguf$/i.test(e.name)) {
        report.models.push({ name: e.name, path: full, sizeBytes: st.size, kind: 'gguf' });
        report.totalBytes += st.size;
      } else if (e.name.endsWith('.part')) {
        report.partBytes += st.size;
      }
    }
  }
  report.models.sort((a, b) => a.name.localeCompare(b.name));

  // Реестр пользовательских моделей: пути живы?
  report.registered = [];
  for (const r of registeredModels) {
    const exists = fs.existsSync(r.file);
    let sizeBytes = null;
    if (exists) sizeBytes = (await fs.promises.stat(r.file)).size;
    report.registered.push({ id: r.id, file: r.file, exists, sizeBytes, sizeMismatch: exists && r.sizeBytes != null && sizeBytes !== r.sizeBytes });
  }
  return report;
}

// ── Реестр пользовательских GGUF (§6) ────────────────────────────────────────

export class RegisteredModels {
  constructor(filePath) {
    this.filePath = filePath;
    this.items = [];
    this._load();
  }
  _load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      if (Array.isArray(raw.models)) this.items = raw.models.filter((m) => m && typeof m.file === 'string' && typeof m.id === 'string');
    } catch { /* файла нет — пустой реестр */ }
  }
  _save() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify({ version: 1, models: this.items }, null, 2) + '\n', 'utf8');
  }
  list() { return [...this.items]; }
  get(id) { return this.items.find((m) => m.id === id) ?? null; }
  isRegistered(file) {
    const abs = path.resolve(file);
    return this.items.find((m) => path.resolve(m.file).toLowerCase() === abs.toLowerCase()) ?? null;
  }
  /** Добавить файл: проверка GGUF, SHA-256, заголовок. Метаданные — только реальные. */
  async add(file) {
    const abs = path.resolve(file);
    const st = await fs.promises.stat(abs).catch(() => { throw new StorageError(`Файл не найден: ${abs}`, { code: 'NOT_FOUND', status: 404 }); });
    if (!st.isFile()) throw new StorageError(`Это не файл: ${abs}`, { code: 'NOT_FILE' });
    if (!/\.gguf$/i.test(abs)) throw new StorageError('Добавлять можно только файлы .gguf.', { code: 'BAD_EXT' });
    const existing = this.isRegistered(abs);
    if (existing) throw new StorageError(`Модель уже добавлена: «${existing.id}» (${abs}).`, { code: 'ALREADY_REGISTERED', status: 409 });

    // Формат GGUF: магия + читаемый заголовок (бросает, если файл битый).
    const header = await readGgufHeader(abs).catch((err) => {
      throw new StorageError(`Файл не является корректным GGUF: ${err.message}`, { code: 'BAD_GGUF' });
    });
    const sha256 = await sha256File(abs);
    const entry = {
      id: path.basename(abs).replace(/\.gguf$/i, ''),
      file: abs,
      sizeBytes: st.size,
      sha256,
      shaSource: 'local', // вычислен локально — не подтверждение источника
      architecture: header.architecture,
      name: header.name,
      quant: header.quant,
      contextLength: header.contextLength,
      addedAt: new Date().toISOString().slice(0, 10),
      source: null // файл добавлен пользователем; источник неизвестен — не выдумываем
    };
    this.items.push(entry);
    this._save();
    return entry;
  }
  /** Убрать из реестра (файл на диске не удаляется). */
  remove(id) {
    const before = this.items.length;
    this.items = this.items.filter((m) => m.id !== id);
    const changed = this.items.length !== before;
    if (changed) this._save();
    return changed;
  }
}

// ── Перенос моделей (§5.2) ───────────────────────────────────────────────────

/**
 * Перенос: копирование с проверкой SHA-256. Источник не удаляется, если
 * keepSource; при keepSource=false файл-источник удаляется ТОЛЬКО после
 * успешной сверки сумм. .part переносится копированием (докачка сохраняется).
 * Никакой частичной копии не остаётся «установленной»: при ошибке целевой
 * файл удаляется.
 */
export async function moveModels({ fromDir, toDir, keepSource = true, log = () => {} }) {
  const results = [];
  if (!fs.existsSync(fromDir)) throw new StorageError(`Исходная папка не существует: ${fromDir}`, { code: 'SRC_MISSING', status: 404 });
  await fs.promises.mkdir(toDir, { recursive: true });
  // Защита: не переносить папку саму в себя.
  if (path.resolve(fromDir).toLowerCase() === path.resolve(toDir).toLowerCase()) {
    throw new StorageError('Новая папка совпадает с текущей.', { code: 'SAME_DIR' });
  }
  const entries = (await fs.promises.readdir(fromDir, { withFileTypes: true })).filter((e) => e.isFile());
  for (const e of entries) {
    const src = path.join(fromDir, e.name);
    const dst = path.join(toDir, e.name);
    if (fs.existsSync(dst)) {
      results.push({ name: e.name, status: 'skipped_exists', message: 'В новой папке уже есть файл с таким именем — пропущен.' });
      continue;
    }
    try {
      await fs.promises.copyFile(src, dst + '.moving');
      if (/\.gguf$/i.test(e.name)) {
        const shaSrc = await sha256File(src);
        const shaDst = await sha256File(dst + '.moving');
        if (shaSrc !== shaDst) {
          await fs.promises.rm(dst + '.moving', { force: true });
          results.push({ name: e.name, status: 'failed', message: 'Контрольные суммы не совпали — копия удалена, источник не тронут.' });
          continue;
        }
        await fs.promises.rename(dst + '.moving', dst);
        if (!keepSource) await fs.promises.rm(src, { force: true });
        results.push({ name: e.name, status: 'moved', sha256: shaSrc, sourceRemoved: !keepSource });
        log('model moved', { name: e.name, sha256: shaSrc, sourceRemoved: !keepSource });
      } else if (e.name.endsWith('.part')) {
        await fs.promises.rename(dst + '.moving', dst);
        results.push({ name: e.name, status: 'moved_part', message: 'Недокачанный файл перенесён — загрузку можно продолжить в новой папке.' });
      } else {
        await fs.promises.rm(dst + '.moving', { force: true });
        results.push({ name: e.name, status: 'skipped_foreign', message: 'Посторонний файл не перенесён.' });
      }
    } catch (err) {
      await fs.promises.rm(dst + '.moving', { force: true }).catch(() => {});
      results.push({ name: e.name, status: 'failed', message: err.message });
    }
  }
  return { fromDir, toDir, keepSource, results };
}
