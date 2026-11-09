// Извлечение текста из вложений чата — без внешних зависимостей.
//
// Поддержка (ТЗ v0.4 §AI Chat): TXT, MD, CSV, JSON, код — напрямую как UTF-8;
// DOCX — разбор ZIP (центральный каталог) + inflateRaw + вычистка XML;
// PDF — inflate FlateDecode-потоков и выуживание текстовых операторов
// (BT…ET, Tj/TJ). PDF и DOCX — best effort: при неудаче честная ошибка,
// никаких «пустых успехов».

import zlib from 'node:zlib';

export const TEXT_EXTENSIONS = new Set([
  'txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'jsonl', 'yaml', 'yml', 'xml', 'html', 'htm',
  'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'c', 'h', 'cpp', 'hpp', 'cs',
  'php', 'sh', 'bash', 'ps1', 'bat', 'cmd', 'sql', 'css', 'scss', 'ini', 'toml', 'conf', 'log', 'diff', 'patch'
]);

export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024; // 10 МБ
export const MAX_EXTRACTED_CHARS = 400_000;           // ~100k токенов — больше контекста не нужно

export class AttachmentError extends Error {
  constructor(message, { code = 'ATTACHMENT_ERROR', status = 400 } = {}) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export function extensionOf(name) {
  const m = String(name || '').toLowerCase().match(/\.([a-z0-9]+)$/);
  return m ? m[1] : '';
}

/** Главная точка входа: имя файла + содержимое (Buffer) → текст. */
export function extractText(fileName, data) {
  if (!Buffer.isBuffer(data)) throw new AttachmentError('Некорректное содержимое файла');
  if (data.length === 0) throw new AttachmentError('Файл пустой');
  if (data.length > MAX_ATTACHMENT_BYTES) {
    throw new AttachmentError(`Файл больше ${Math.round(MAX_ATTACHMENT_BYTES / 1048576)} МБ — прикрепите фрагмент`, { code: 'TOO_LARGE' });
  }
  const ext = extensionOf(fileName);
  if (ext === 'pdf') return extractPdf(data);
  if (ext === 'docx') return extractDocx(data);
  if (ext === 'doc') {
    throw new AttachmentError('Старый формат .doc не поддерживается — пересохраните как .docx или .txt', { code: 'UNSUPPORTED_FORMAT' });
  }
  // Всё остальное — текст (включая неизвестные расширения: пробуем как текст).
  const text = data.toString('utf8');
  if (hasBinaryJunk(text) && !TEXT_EXTENSIONS.has(ext)) {
    throw new AttachmentError(`Не удалось прочитать «${fileName}» как текст. Поддержка: TXT, MD, CSV, JSON, код, PDF, DOCX.`, { code: 'UNSUPPORTED_FORMAT' });
  }
  return { text: clip(text), kind: ext || 'txt', warning: null };
}

function hasBinaryJunk(text) {
  // Доля непечатаемых символов > 10% — это бинарник.
  let bad = 0;
  const sample = text.slice(0, 4000);
  for (const ch of sample) {
    const c = ch.codePointAt(0);
    if (c === 9 || c === 10 || c === 13) continue;
    if (c < 32 || (c >= 127 && c < 160)) bad++;
  }
  return bad / Math.max(1, sample.length) > 0.1;
}

function clip(text) {
  const t = text.replace(/\r\n/g, '\n').replace(/\u0000/g, '');
  if (t.length <= MAX_EXTRACTED_CHARS) return t;
  return t.slice(0, MAX_EXTRACTED_CHARS) + `\n\n[…обрезано: показаны первые ${MAX_EXTRACTED_CHARS} символов…]`;
}

// ── DOCX ─────────────────────────────────────────────────────────────────────
// Минимальный ZIP-ридер: центральный каталог + inflateRaw.

function zipEntries(buf) {
  // Ищем EOCD (End Of Central Directory) с хвоста.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65536); i--) {
    if (buf[i] === 0x50 && buf[i + 1] === 0x4b && buf[i + 2] === 0x05 && buf[i + 3] === 0x06) { eocd = i; break; }
  }
  if (eocd < 0) throw new AttachmentError('Это не ZIP/DOCX-файл (нет EOCD)', { code: 'BAD_DOCX' });
  const count = buf.readUInt16LE(eocd + 10);
  let ptr = buf.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let i = 0; i < count; i++) {
    if (ptr + 46 > buf.length || buf.readUInt32LE(ptr) !== 0x02014b50) break;
    const method = buf.readUInt16LE(ptr + 10);
    const compSize = buf.readUInt32LE(ptr + 20);
    const nameLen = buf.readUInt16LE(ptr + 28);
    const extraLen = buf.readUInt16LE(ptr + 30);
    const commLen = buf.readUInt16LE(ptr + 32);
    const localOff = buf.readUInt32LE(ptr + 42);
    const name = buf.toString('utf8', ptr + 46, ptr + 46 + nameLen);
    entries.set(name, { method, compSize, localOff });
    ptr += 46 + nameLen + extraLen + commLen;
  }
  return entries;
}

function zipRead(buf, entry) {
  const lo = entry.localOff;
  if (lo + 30 > buf.length || buf.readUInt32LE(lo) !== 0x04034b50) {
    throw new AttachmentError('Повреждённый ZIP/DOCX', { code: 'BAD_DOCX' });
  }
  const nameLen = buf.readUInt16LE(lo + 26);
  const extraLen = buf.readUInt16LE(lo + 28);
  const dataStart = lo + 30 + nameLen + extraLen;
  const raw = buf.subarray(dataStart, dataStart + entry.compSize);
  if (entry.method === 0) return raw;
  if (entry.method === 8) return zlib.inflateRawSync(raw);
  throw new AttachmentError(`Неподдерживаемый метод сжатия ZIP: ${entry.method}`, { code: 'BAD_DOCX' });
}

export function extractDocx(buf) {
  const entries = zipEntries(buf);
  const key = [...entries.keys()].find((n) => n === 'word/document.xml');
  if (!key) throw new AttachmentError('В DOCX нет word/document.xml — файл повреждён или это не DOCX', { code: 'BAD_DOCX' });
  const xml = zipRead(buf, entries.get(key)).toString('utf8');
  // Абзацы <w:p> → переводы строк; <w:tab/>, <w:br/> → соотв. символы; теги прочь; сущности базовые.
  const withBreaks = xml
    .replace(/<w:tab\b[^>]*\/>/g, '\t')
    .replace(/<w:br\b[^>]*\/>/g, '\n')
    .replace(/<\/w:p>/g, '\n');
  const text = withBreaks
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/\n{3,}/g, '\n\n');
  if (!text.trim()) {
    throw new AttachmentError('DOCX прочитан, но текста внутри не нашлось (возможно, только изображения)', { code: 'EMPTY_DOCX' });
  }
  return { text: clip(text), kind: 'docx', warning: null };
}

// ── PDF ──────────────────────────────────────────────────────────────────────

export function extractPdf(buf) {
  if (buf.subarray(0, 5).toString('latin1') !== '%PDF-') {
    throw new AttachmentError('Это не PDF-файл', { code: 'BAD_PDF' });
  }
  const raw = buf.toString('latin1');
  const pieces = [];

  // 1) Потоки stream…endstream — пробуем inflate, затем достаём текстовые операторы.
  const re = /stream\r?\n/g;
  let m;
  while ((m = re.exec(raw)) !== null) {
    const start = m.index + m[0].length;
    const end = raw.indexOf('endstream', start);
    if (end < 0) break;
    const chunk = buf.subarray(start, end);
    let content = null;
    try { content = zlib.inflateSync(chunk); } catch {
      try { content = zlib.inflateRawSync(chunk); } catch { /* не сжат или защищён */ }
    }
    if (content) {
      const txt = pdfTextOperators(content.toString('latin1'));
      if (txt) pieces.push(txt);
    }
    re.lastIndex = end;
  }

  // 2) Несжатые текстовые операторы прямо в теле (редко, но бывает).
  const plain = pdfTextOperators(raw);
  if (plain) pieces.push(plain);

  const text = pieces.join('\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (!text) {
    throw new AttachmentError(
      'Не удалось извлечь текст из PDF: файл защищён, отсканирован как изображение или использует нестандартное кодирование. ' +
      'Скопируйте текст вручную или сохраните как TXT/DOCX.',
      { code: 'PDF_NO_TEXT' }
    );
  }
  return { text: clip(text), kind: 'pdf', warning: null };
}

/** Вытащить строки из Tj/TJ операторов внутри BT…ET. */
function pdfTextOperators(content) {
  const out = [];
  const btRe = /BT([\s\S]*?)ET/g;
  let bt;
  while ((bt = btRe.exec(content)) !== null) {
    const block = bt[1];
    const segRe = /\((?:\\.|[^\\()])*\)\s*(?:Tj|TJ)|\[(?:[^\]\\]|\\.)*\]\s*TJ/g;
    let seg;
    while ((seg = segRe.exec(block)) !== null) {
      const strRe = /\((?:\\.|[^\\()])*\)/g;
      let s;
      let buf = '';
      while ((s = strRe.exec(seg[0])) !== null) {
        buf += pdfUnescape(s[0].slice(1, -1));
      }
      if (buf) out.push(buf);
    }
  }
  return out.filter(Boolean).join('\n');
}

function pdfUnescape(s) {
  return s
    .replace(/\\([nrtbf()\\])/g, (_, c) => ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '(': '(', ')': ')', '\\': '\\' }[c] ?? c))
    .replace(/\\([0-7]{1,3})/g, (_, oct) => String.fromCharCode(parseInt(oct, 8)));
}
