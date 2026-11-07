import test from 'node:test';
import assert from 'node:assert/strict';
import { startMockOllama } from './helpers/mock-ollama.js';
import { OllamaBackend } from '../src/backends/ollama.js';
import { assertBackendContract } from '../src/backends/base.js';
import { createBackend } from '../src/backends/registry.js';

test('adapter satisfies the backend contract', () => {
  const backend = new OllamaBackend({ baseUrl: 'http://127.0.0.1:1' });
  assert.equal(assertBackendContract(backend), true);
  const caps = backend.capabilities();
  assert.equal(caps.stream, true);
  assert.equal(caps.cancel, true);
  assert.equal(caps.unload, true);
  assert.throws(() => assertBackendContract({ type: 'broken' }), /does not implement/);
});

test('registry creates the configured backend and rejects unknown types', () => {
  const cfg = { backend: { type: 'ollama', baseUrl: 'http://127.0.0.1:1' } };
  assert.ok(createBackend(cfg) instanceof OllamaBackend);
  assert.throws(() => createBackend({ backend: { type: 'nope' } }), /Unknown backend/);
});

test('detect succeeds against a running mock', async () => {
  const mock = await startMockOllama();
  try {
    const b = new OllamaBackend({ baseUrl: mock.url });
    const det = await b.detect();
    assert.equal(det.ok, true);
    assert.equal(det.version, '0.0.0-mock');
  } finally { await mock.close(); }
});

test('detect fails with an actionable message when Ollama is absent', async () => {
  const b = new OllamaBackend({ baseUrl: 'http://127.0.0.1:1', connectTimeoutMs: 300 });
  const det = await b.detect();
  assert.equal(det.ok, false);
  assert.match(det.error, /not reachable/);
  assert.match(det.error, /11434|installed|running/i);
});

test('listModels returns ids and sizes', async () => {
  const mock = await startMockOllama();
  try {
    const b = new OllamaBackend({ baseUrl: mock.url });
    const models = await b.listModels();
    assert.deepEqual(models.map((m) => m.id), ['tinytest:1b', 'smalltest:3b']);
    assert.ok(models[0].sizeBytes > 0);
  } finally { await mock.close(); }
});

test('listModels raises a clear backend error when unreachable', async () => {
  const b = new OllamaBackend({ baseUrl: 'http://127.0.0.1:1', connectTimeoutMs: 300 });
  await assert.rejects(() => b.listModels(), (err) => err.code === 'BACKEND_UNREACHABLE');
});

test('unknown model produces ModelNotFoundError listing installed models', async () => {
  const mock = await startMockOllama();
  try {
    const b = new OllamaBackend({ baseUrl: mock.url });
    await assert.rejects(
      () => b.generate({ model: 'nonexistent', messages: [{ role: 'user', content: 'hi' }] }),
      (err) => {
        assert.equal(err.code, 'MODEL_NOT_FOUND');
        assert.equal(err.status, 404);
        assert.match(err.message, /tinytest:1b/);
        assert.match(err.message, /never downloads models automatically/);
        return true;
      }
    );
  } finally { await mock.close(); }
});

test('streaming delivers tokens in order and reports usage', async () => {
  const mock = await startMockOllama();
  try {
    const b = new OllamaBackend({ baseUrl: mock.url });
    let got = '';
    const res = await b.generate({
      model: 'tinytest:1b',
      messages: [{ role: 'user', content: 'hi' }],
      contextTokens: 2048,
      maxOutputTokens: 128,
      threads: 2,
      onToken: (d) => { got += d; }
    });
    assert.equal(got, 'Hello from the mock model');
    assert.equal(res.text, got);
    assert.equal(res.usage.completionTokens, 5);
    // backend must forward Low Resource options
    assert.equal(mock.state.lastChatBody.options.num_ctx, 2048);
    assert.equal(mock.state.lastChatBody.options.num_predict, 128);
    assert.equal(mock.state.lastChatBody.options.num_thread, 2);
    assert.equal(mock.state.lastChatBody.stream, true);
  } finally { await mock.close(); }
});

test('aborting mid-stream cancels generation and closes the connection', async () => {
  const mock = await startMockOllama({ tokenDelayMs: 30, words: ['a', 'b', 'c', 'd', 'e', 'f'] });
  try {
    const b = new OllamaBackend({ baseUrl: mock.url });
    const ctrl = new AbortController();
    let tokens = 0;
    const p = b.generate({
      model: 'tinytest:1b',
      messages: [{ role: 'user', content: 'hi' }],
      signal: ctrl.signal,
      onToken: () => { if (++tokens === 2) ctrl.abort(new Error('user stopped')); }
    });
    await assert.rejects(p, (err) => err.code === 'CANCELLED' || err.name === 'AbortError');
    await new Promise((r) => setTimeout(r, 60));
    assert.ok(mock.state.disconnects >= 1, 'connection closed so Ollama stops generating');
    assert.ok(tokens <= 4, 'generation stopped early');
  } finally { await mock.close(); }
});

test('unload sends keep_alive: 0 for a specific model and for all', async () => {
  const mock = await startMockOllama();
  try {
    const b = new OllamaBackend({ baseUrl: mock.url });
    await b.generate({ model: 'tinytest:1b', messages: [{ role: 'user', content: 'hi' }] });
    const one = await b.unload('tinytest:1b');
    assert.deepEqual(one.unloaded, ['tinytest:1b']);
    assert.equal(mock.state.unloads.at(-1).keep_alive, 0);
    const all = await b.unload(null);
    assert.deepEqual(all.unloaded, []);
    await b.generate({ model: 'smalltest:3b', messages: [{ role: 'user', content: 'hi' }] });
    const all2 = await b.unload(null);
    assert.deepEqual(all2.unloaded, ['smalltest:3b']);
  } finally { await mock.close(); }
});

test('HTTP 500 from backend surfaces as BackendError', async () => {
  const mock = await startMockOllama({ chatStatus: 500 });
  try {
    const b = new OllamaBackend({ baseUrl: mock.url });
    await assert.rejects(
      () => b.generate({ model: 'tinytest:1b', messages: [{ role: 'user', content: 'hi' }] }),
      (err) => err.code === 'BACKEND_ERROR' && err.status === 500
    );
  } finally { await mock.close(); }
});
