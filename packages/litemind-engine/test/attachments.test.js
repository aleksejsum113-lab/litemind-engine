// Unit-тесты экстрактора вложений: TXT, DOCX, PDF, бинарный отбраковка.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { extractText, extractDocx, extractPdf } from '../src/attachments/extract.js';
import { ensureAttachmentFixtures } from './helpers/attachment-fixtures.js';

// Фикстуры создаются самим тестом (детерминированно, без внешних скриптов) —
// раньше они генерировались вне репозитория и в CI их не было (ENOENT).
const fixtures = ensureAttachmentFixtures();

test('TXT читается как есть', () => {
  const r = extractText('notes.txt', Buffer.from('привет\nстрока два', 'utf8'));
  assert.equal(r.kind, 'txt');
  assert.ok(r.text.includes('строка два'));
});

test('CSV/JSON/код — текст', () => {
  assert.equal(extractText('data.csv', Buffer.from('a,b\n1,2')).kind, 'csv');
  assert.equal(extractText('main.py', Buffer.from('print(1)')).kind, 'py');
});

test('DOCX: текст из word/document.xml', () => {
  const buf = fs.readFileSync(fixtures.docxPath);
  const r = extractText('test.docx', buf);
  assert.equal(r.kind, 'docx');
  assert.ok(r.text.includes('LiteMind attachment test'), r.text);
  assert.ok(r.text.includes('Second paragraph with & entity'));
  assert.ok(r.text.split('\n').length >= 2, 'абзацы разделены');
});

test('PDF: текст из несжатых операторов', () => {
  const buf = fs.readFileSync(fixtures.pdfPath);
  const r = extractText('test.pdf', buf);
  assert.equal(r.kind, 'pdf');
  assert.ok(r.text.includes('Hello from PDF'), r.text);
  assert.ok(r.text.includes('Second line here'));
});

test('PDF без текста (скан/защита) — честная ошибка', () => {
  const fake = Buffer.from('%PDF-1.7\nnothing here');
  assert.throws(() => extractText('scan.pdf', fake), /Не удалось извлечь текст из PDF/);
});

test('бинарный файл отбраковывается с понятным сообщением', () => {
  const bin = Buffer.from([0x00, 0x01, 0x02, 0x7f, 0x80, 0x81, 0x99, 0x00, 0x01]);
  assert.throws(() => extractText('blob.xyz', bin), /Не удалось прочитать/);
});

test('пустой файл — ошибка, слишком большой — ошибка', () => {
  assert.throws(() => extractText('a.txt', Buffer.alloc(0)), /пустой/);
  assert.throws(() => extractText('a.txt', Buffer.alloc(11 * 1024 * 1024, 32)), /10 МБ/);
});

test('.doc старый формат — честный отказ', () => {
  assert.throws(() => extractText('old.doc', Buffer.from('x')), /\.doc/);
});

test('extractDocx/extractPdf экспортируются отдельно', () => {
  assert.equal(typeof extractDocx, 'function');
  assert.equal(typeof extractPdf, 'function');
});
