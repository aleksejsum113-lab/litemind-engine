// Генератор фикстур вложений (DOCX + PDF) — чистый Node, без зависимостей.
//
// История: тесты attachments.test.js читали /tmp/litemind-attachments/*.docx|pdf,
// которые создавались внешним скриптом ВНЕ репозитория. В CI (и на любой чистой
// машине) файлов нет → ENOENT → оба теста падали (workflow-запуски #27/#28).
// Теперь тест сам создаёт детерминированные фикстуры во временном каталоге.
// Содержимое зафиксировано проверками теста (строки «LiteMind attachment test»,
// «Second paragraph with & entity», «Hello from PDF», «Second line here»).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

// ── CRC32 (IEEE, как в ZIP) ──────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ── Минимальный валидный ZIP с одной deflate-записью ─────────────────────────

function zipSingleFile(name, data) {
  const comp = zlib.deflateRawSync(data, { level: 9 });
  const crc = crc32(data);
  const nameBuf = Buffer.from(name, 'utf8');

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); // local file header signature
  local.writeUInt16LE(20, 4);         // version needed
  local.writeUInt16LE(0, 6);          // flags
  local.writeUInt16LE(8, 8);          // method: deflate
  local.writeUInt16LE(0, 10);         // mod time
  local.writeUInt16LE(0x21, 12);      // mod date (1980-01-01)
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(comp.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  local.writeUInt16LE(0, 28);         // extra len

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0); // central directory signature
  central.writeUInt16LE(20, 4);         // version made by
  central.writeUInt16LE(20, 6);         // version needed
  central.writeUInt16LE(0, 8);          // flags
  central.writeUInt16LE(8, 10);         // method: deflate
  central.writeUInt16LE(0, 12);         // mod time
  central.writeUInt16LE(0x21, 14);      // mod date
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(comp.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(nameBuf.length, 28);
  central.writeUInt16LE(0, 30);         // extra len
  central.writeUInt16LE(0, 32);         // comment len
  central.writeUInt16LE(0, 34);         // disk start
  central.writeUInt16LE(0, 36);         // internal attrs
  central.writeUInt32LE(0, 38);         // external attrs
  central.writeUInt32LE(0, 42);         // local header offset

  const cdOffset = local.length + nameBuf.length + comp.length;
  const cd = Buffer.concat([central, nameBuf]);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // EOCD signature
  eocd.writeUInt16LE(0, 4);          // disk number
  eocd.writeUInt16LE(0, 6);          // cd disk
  eocd.writeUInt16LE(1, 8);          // entries on this disk
  eocd.writeUInt16LE(1, 10);         // entries total
  eocd.writeUInt32LE(cd.length, 12); // cd size
  eocd.writeUInt32LE(cdOffset, 16);  // cd offset
  eocd.writeUInt16LE(0, 20);         // comment len

  return Buffer.concat([local, nameBuf, comp, cd, eocd]);
}

// ── Фикстуры ─────────────────────────────────────────────────────────────────

// Два абзаца: базовый текст + XML-сущность &amp; (проверка декодирования).
const DOCX_XML =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
  `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
  `<w:body>` +
  `<w:p><w:r><w:t>LiteMind attachment test</w:t></w:r></w:p>` +
  `<w:p><w:r><w:t>Second paragraph with &amp; entity</w:t></w:r></w:p>` +
  `</w:body></w:document>`;

/** Минимальный валидный PDF 1.4 с несжатым (plain) контентным потоком. */
function buildPdf() {
  const content = 'BT\n/F1 14 Tf\n72 720 Td\n(Hello from PDF) Tj\n0 -24 Td\n(Second line here) Tj\nET\n';
  const parts = [];
  const offsets = [];
  let pos = 0;
  const add = (s) => {
    const buf = Buffer.from(s, 'latin1');
    parts.push(buf);
    pos += buf.length;
  };

  add('%PDF-1.4\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}endstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  ];
  objects.forEach((body, i) => {
    offsets.push(pos);
    add(`${i + 1} 0 obj\n${body}\nendobj\n`);
  });

  const xrefPos = pos;
  let xref = 'xref\n0 6\n0000000000 65535 f \n';
  for (const o of offsets) xref += `${String(o).padStart(10, '0')} 00000 n \n`;
  add(xref);
  add(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`);
  return Buffer.concat(parts);
}

/**
 * Создаёт (и перезаписывает) фикстуры вложений в общем временном каталоге.
 * Путь — os.tmpdir()/litemind-attachments, тот же, что использовал e2e-скрипт.
 * @returns {{ dir: string, docxPath: string, pdfPath: string }}
 */
export function ensureAttachmentFixtures() {
  const dir = path.join(os.tmpdir(), 'litemind-attachments');
  fs.mkdirSync(dir, { recursive: true });
  const docxPath = path.join(dir, 'test.docx');
  const pdfPath = path.join(dir, 'test.pdf');
  fs.writeFileSync(docxPath, zipSingleFile('word/document.xml', Buffer.from(DOCX_XML, 'utf8')));
  fs.writeFileSync(pdfPath, buildPdf());
  return { dir, docxPath, pdfPath };
}
