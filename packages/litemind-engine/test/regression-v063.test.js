// Регресс-тесты v0.6.3 — баги, найденные на реальном ПК пользователя (ТЗ §1.1–1.5).
// Каждый тест держит одну причину, исправленную в этой версии.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startMockOllama } from './helpers/mock-ollama.js';
import { makeEngine } from './helpers/fixtures.js';
import { loadConfig } from '../src/config.js';
import { createBackend } from '../src/backends/registry.js';
import { LlamaCppBackend } from '../src/backends/lmlama.js';

const MSG = [{ role: 'user', content: 'привет' }];

// ── ТЗ §1.4: «Model "[object Object]" is not available locally» ──────────────
// Причина: UI присылал DOM-элемент вместо строки; объект доходил до бэкенда.

test('1.4: engine.generate приводит {id} к строке-идентификатору модели', async () => {
  const mock = await startMockOllama();
  try {
    const { engine } = makeEngine({ baseUrl: mock.url });
    await engine.start();
    // раньше: объект уходил в бэкенд как есть → «Model "[object Object]"»
    const r = await engine.generate({ model: { id: 'tinytest:1b' }, messages: MSG });
    assert.ok(r.text.length > 0);
    const reqs = mock.state.chatRequests;
    assert.equal(reqs.at(-1).model, 'tinytest:1b', 'бэкенд получил СТРОКУ-идентификатор');
    engine.shutdown();
  } finally { await mock.close(); }
});

test('1.4: engine.generate отвергает модель без строкового id (BAD_MODEL)', async () => {
  const mock = await startMockOllama();
  try {
    const { engine } = makeEngine({ baseUrl: mock.url });
    await engine.start();
    await assert.rejects(() => engine.generate({ model: {}, messages: MSG }), (err) => {
      assert.equal(err.code, 'BAD_MODEL');
      assert.equal(err.status, 400);
      return true;
    });
    await assert.rejects(() => engine.generate({ model: 42, messages: MSG }), (err) => err.code === 'BAD_MODEL');
    engine.shutdown();
  } finally { await mock.close(); }
});

test('1.4: ошибка «модель не найдена» для llama.cpp не советует ollama pull', async () => {
  // минимальный фейковый rootDir без моделей — scanModels вернёт пустой список
  const b = new LlamaCppBackend({ rootDir: '/tmp/litemind-v063-empty-models-' + process.pid });
  await assert.rejects(() => b.generate({ model: 'deepseek-coder-1.3b-instruct.Q4_K_M', messages: MSG }), (err) => {
    assert.equal(err.code, 'MODEL_NOT_FOUND');
    assert.match(err.message, /не найдена среди локальных/);
    assert.doesNotMatch(err.message, /ollama pull/, 'подсказка llama.cpp не должна отправлять пользователя в Ollama');
    assert.match(err.message, /Каталог/, 'подсказка указывает на разделы интерфейса LiteMind');
    return true;
  });
});

// ── ТЗ §1.5: «connect timeout» у ИИ-агента на CPU без AVX ────────────────────
// Причина: таймаут на заголовки ответа был захардкожен 60 с — меньше времени
// prefill системного промпта агента на N5095A.

test('1.5: headersTimeoutMs конфигурируем, дефолт 10 минут (не 60 с)', () => {
  const b = new LlamaCppBackend({ rootDir: '/tmp/x' });
  assert.equal(b.headersTimeoutMs, 600000);
});

test('1.5: registry пробрасывает headersTimeoutMs из config.backend', () => {
  const cfg = loadConfig('this-path-does-not-exist.json'); // чистые дефолты
  assert.equal(cfg.backend.headersTimeoutMs, 600000, 'config.js: дефолт 600000');
  cfg.backend.headersTimeoutMs = 45000;
  const b = createBackend(cfg);
  assert.equal(b.headersTimeoutMs, 45000, 'фабрика бэкенда читает значение из конфига');
});
