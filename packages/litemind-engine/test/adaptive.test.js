// Tests for the Adaptive Controller: task classification, context compaction,
// long-input digest, runtime capabilities, project index, engine integration.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  classifyTask, compactMessages, prepareRequest, digestLongInput, estimateTokens, COMPLEXITY_POLICY
} from '../src/adaptive/controller.js';
import { capabilitiesFor } from '../src/adaptive/capabilities.js';
import { scanProject, searchProject, projectMap } from '../src/adaptive/project-index.js';
import { threadCandidates, adviceFor, SLOW_TOKENS_PER_SEC } from '../src/optimize/optimizer.js';

// ---------------------------------------------------------------- classify

test('adaptive: classify simple / file / project / hard', () => {
  assert.equal(classifyTask([{ role: 'user', content: 'Привет, как дела?' }]).complexity, 'simple');
  const fileQ = 'Исправь баг в utils.js: функция formatDate падает';
  assert.equal(classifyTask([{ role: 'user', content: fileQ }]).complexity, 'file');
  const projectQ = 'Отрефактори модули server.js, client.js и config.ts под новую схему. '.repeat(20);
  assert.equal(classifyTask([{ role: 'user', content: projectQ }]).complexity, 'project');
  const hardQ = { role: 'user', content: '```python\ndef f():\n  pass\n```\nОбъясни почему tracefback показывает этот exception и как исправить. ' + 'x'.repeat(500) };
  assert.equal(classifyTask([hardQ]).complexity, 'hard');
});

// ---------------------------------------------------------------- compact

function longHistory(n) {
  const out = [{ role: 'system', content: 'Ты полезный ассистент-кодер.' }];
  for (let i = 0; i < n; i++) {
    out.push({ role: 'user', content: `Вопрос номер ${i}: расскажи о модуле ${i} подробно. ` + 'детали '.repeat(30) });
    out.push({ role: 'assistant', content: `Ответ на вопрос ${i}. ` + 'текст '.repeat(30) });
  }
  out.push({ role: 'user', content: 'Итоговый вопрос: что делать дальше?' });
  return out;
}

test('adaptive: compaction keeps system, first task, recent tail; adds summary', () => {
  const policy = COMPLEXITY_POLICY.file;
  const messages = longHistory(20);
  const r = compactMessages({ messages, contextTokens: 1024, policy });
  assert.ok(r.dropped > 0, 'should drop middle messages');
  assert.equal(r.messages[0].role, 'system');
  assert.match(r.messages[0].content, /ассистент-кодер/, 'system prompt intact');
  const summary = r.messages.find((m) => m.role === 'system' && m.content.includes('Сжатая история'));
  assert.ok(summary, 'summary stub present');
  const last = r.messages[r.messages.length - 1];
  assert.match(last.content, /Итоговый вопрос/, 'recent tail preserved');
  const keptText = r.messages.map((m) => m.content).join('\n');
  assert.match(keptText, /Вопрос номер 0/, 'first user task preserved');
});

test('adaptive: prepare reduces output budget for simple, raises for hard', () => {
  const base = { contextTokens: 4096, maxOutputTokens: 1024, adaptive: { enabled: true } };
  const simple = prepareRequest({ messages: [{ role: 'user', content: 'привет' }], ...base });
  assert.equal(simple.complexity, 'simple');
  assert.ok(simple.maxOutputTokens >= COMPLEXITY_POLICY.simple.minOutputTokens);
  assert.ok(simple.maxOutputTokens < 1024, 'simple gets reduced budget');

  const hard = prepareRequest({ messages: [{ role: 'user', content: '```js\nconst x=1;\n```\n' + 'найди ошибку и исправь refactoring '.repeat(50) }], ...base });
  assert.ok(['hard', 'project'].includes(hard.complexity));
  assert.ok(hard.maxOutputTokens >= 1024, 'hard keeps full/greater budget');

  const off = prepareRequest({ messages: [{ role: 'user', content: 'привет' }], ...base, adaptive: { enabled: false } });
  assert.equal(off.maxOutputTokens, 1024);
  assert.equal(off.meta.adaptive, 'off');
});

test('adaptive: digest of long input fits budget and keeps facts', () => {
  const big = [
    'Задача: переписать модуль авторизации на сервере.',
    'Требуется поддержка OAuth2 и refresh-токенов.',
    ...Array.from({ length: 40 }, (_, i) => `Раздел ${i}: описание архитектуры, повторяющийся текст без фактов. ` + 'заполнитель '.repeat(20)),
    'Важно: порт 8443, таймаут 30 секунд.'
  ].join('\n\n');
  const out = digestLongInput(big, 400);
  assert.ok(estimateTokens(out) <= 450, 'digest fits budget');
  assert.match(out, /8443/, 'kept the port fact');
  assert.match(out, /Задача/, 'kept the head');
  assert.match(out, /вход сокращён/, 'notified about truncation');
  assert.equal(digestLongInput('короткий текст', 400), 'короткий текст');
});

// ---------------------------------------------------------------- capabilities

test('adaptive: runtime capabilities are honest about ollama', () => {
  const c = capabilitiesFor('ollama');
  assert.equal(c.promptCache.available, true);
  assert.equal(c.promptLookupDecoding.available, false);
  assert.equal(c.speculativeDecoding.available, false);
  assert.equal(c.kvCacheQuantization.available, false);
  assert.equal(c.mlock.default, false);
  const unknown = capabilitiesFor('nonexistent');
  assert.equal(unknown.promptCache.available, false);
});

// ---------------------------------------------------------------- optimizer

test('optimizer: thread candidates and advice thresholds', () => {
  // Этап 2: кандидаты включают ВСЕ ядра (prefill на N5095A честно измеряется).
  assert.deepEqual(threadCandidates({ cpuThreads: 4, cores: 4 }), [4, 2, 1]);
  assert.deepEqual(threadCandidates({ cpuThreads: 0, cores: 4 }), [4, 3, 2, 1]);
  assert.deepEqual(threadCandidates({ cpuThreads: 0, cores: 8 }), [8, 4, 2, 1]);
  assert.equal(adviceFor(10, 'balanced').includes('комфортная'), true);
  assert.equal(adviceFor(1, 'balanced').includes('медленно'), true);
  assert.ok(SLOW_TOKENS_PER_SEC > 0);
});

// ---------------------------------------------------------------- project index

test('project index: scan extracts symbols, search finds relevant snippet', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-proj-'));
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src', 'auth.js'), [
    'export function login(user, pass) {',
    '  return verify(user, pass);',
    '}',
    '',
    'export class Session {',
    '  constructor(ttl) { this.ttl = ttl; }',
    '}'
  ].join('\n'));
  fs.writeFileSync(path.join(dir, 'src', 'math.py'), 'def add(a, b):\n    return a + b\n');
  fs.mkdirSync(path.join(dir, 'node_modules', 'ignored'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'node_modules', 'ignored', 'x.js'), 'function shouldNotBeIndexed() {}');

  const s = await scanProject(dir);
  assert.equal(s.fileCount, 2, 'node_modules skipped');
  const search = await searchProject(dir, 'login auth session');
  assert.ok(search.results.length >= 1);
  assert.equal(search.results[0].file, path.join('src', 'auth.js'));
  assert.match(search.results[0].snippet, /function login|export class Session|verify/);
  const map = projectMap(dir);
  const authFile = map.files.find((f) => f.file.endsWith('auth.js'));
  assert.ok(authFile.symbols.some((x) => x.startsWith('login:')));
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------- engine integration

test('engine: adaptive compaction happens inside generate and stats update', async () => {
  const { makeEngine, fakeMetrics } = await import('./helpers/fixtures.js');
  const seen = [];
  let calls = 0;
  const { engine } = makeEngine({
    baseUrl: 'http://127.0.0.1:1',
    configMutator: (c) => { c.adaptive = { enabled: true, contextCompaction: true, auxEnabled: false, auxModel: null }; },
    sampler: { latest: fakeMetrics(), history: [], async sample() { return this.latest; }, stop() {} },
    backend: {
      type: 'ollama',
      async detect() { return { ok: true, version: 'test' }; },
      async listModels() { return [{ id: 'm', sizeBytes: 700 * 1024 * 1024 }]; },
      async generate({ messages }) { calls++; seen.push(messages.map((m) => m.content.slice(0, 40))); return { text: 'ok', usage: { promptTokens: 10, completionTokens: 20 } }; },
      async unload() { return { unloaded: [] }; },
      capabilities() { return {}; }
    }
  });
  engine.config.backend.streamIdleTimeoutMs = 5000;
  const messages = [{ role: 'system', content: 'sys' }];
  for (let i = 0; i < 30; i++) {
    messages.push({ role: 'user', content: `msg ${i} ` + 'заполнитель '.repeat(40) });
    messages.push({ role: 'assistant', content: 'ответ ' + 'текст '.repeat(40) });
  }
  messages.push({ role: 'user', content: 'финальный вопрос' });
  const res = await engine.generate({ model: 'm', messages, contextTokens: 1024, maxOutputTokens: 512 });
  assert.equal(res.text, 'ok');
  assert.equal(calls, 1);
  const sent = seen[0].join('\n');
  assert.ok(sent.length < messages.map((m) => m.content).join('\n').length, 'context was compacted');
  assert.match(sent, /Сжатая история|финальный вопрос/);
  assert.ok(engine.adaptiveStats.compacted >= 1);
  assert.ok(engine.adaptiveStats.byComplexity.simple + engine.adaptiveStats.byComplexity.file + engine.adaptiveStats.byComplexity.project + engine.adaptiveStats.byComplexity.hard >= 1);
});
