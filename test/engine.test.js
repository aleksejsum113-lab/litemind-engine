import test from 'node:test';
import assert from 'node:assert/strict';
import { startMockOllama } from './helpers/mock-ollama.js';
import { makeEngine, fakeMetrics } from './helpers/fixtures.js';

const MSG = [{ role: 'user', content: 'hi' }];

test('engine detects backend at start and reports status', async () => {
  const mock = await startMockOllama();
  try {
    const { engine } = makeEngine({ baseUrl: mock.url });
    const health = await engine.start();
    assert.equal(health.ok, true);
    const s = await engine.status();
    assert.equal(s.backend.type, 'ollama');
    assert.equal(s.queue.limit, 1, 'Low Resource allows one active request');
    assert.equal(s.models.length, 2);
    assert.equal(s.engine.profile, 'low');
    engine.shutdown();
  } finally { await mock.close(); }
});

test('engine reports an actionable error when backend is missing', async () => {
  const { engine } = makeEngine({ baseUrl: 'http://127.0.0.1:1' });
  const health = await engine.start();
  assert.equal(health.ok, false);
  assert.match(health.error, /Ollama is not reachable/);
  const s = await engine.status();
  assert.match(s.modelsError, /not reachable/);
  engine.shutdown();
});

test('requests are serialised under the Low Resource concurrency limit', async () => {
  const mock = await startMockOllama({ tokenDelayMs: 15 });
  try {
    const { engine } = makeEngine({ baseUrl: mock.url });
    await engine.start();
    const p1 = engine.generate({ model: 'tinytest:1b', messages: MSG });
    const p2 = engine.generate({ model: 'tinytest:1b', messages: MSG });
    const [r1, r2] = await Promise.all([p1, p2]);
    assert.ok(r1.timings.durationMs > 0);
    // second request must have started only after the first finished
    const reqs = mock.state.chatRequests;
    assert.equal(reqs.length, 2);
    assert.ok(reqs[1].at >= reqs[0].at);
    assert.equal(engine.active, 0, 'slot released after completion');
    engine.shutdown();
  } finally { await mock.close(); }
});

test('queue overflow is rejected with QUEUE_FULL (429) instead of piling up', async () => {
  const mock = await startMockOllama({ tokenDelayMs: 10, words: ['x', 'y', 'z', 'w', 'q', 'e'] });
  try {
    const { engine, config } = makeEngine({ baseUrl: mock.url, configMutator: (c) => { c.profiles.low.queueLimit = 1; } });
    await engine.start();
    const p1 = engine.generate({ model: 'tinytest:1b', messages: MSG });
    const p2 = engine.generate({ model: 'tinytest:1b', messages: MSG }); // queues
    await new Promise((r) => setTimeout(r, 30));
    await assert.rejects(() => engine.generate({ model: 'tinytest:1b', messages: MSG }), (err) => {
      assert.equal(err.code, 'QUEUE_FULL');
      assert.equal(err.status, 429);
      return true;
    });
    await Promise.all([p1, p2]);
    assert.equal(engine.active, 0);
    assert.equal(engine.stats.rejectedQueueFull, 1);
    engine.shutdown();
  } finally { await mock.close(); }
});

test('a queued request can be cancelled before it runs', async () => {
  const mock = await startMockOllama({ tokenDelayMs: 20, words: ['a', 'b', 'c', 'd'] });
  try {
    const { engine } = makeEngine({ baseUrl: mock.url });
    await engine.start();
    const p1 = engine.generate({ model: 'tinytest:1b', messages: MSG });
    await new Promise((r) => setTimeout(r, 20));
    const p2 = engine.generate({ model: 'tinytest:1b', messages: MSG });
    await new Promise((r) => setTimeout(r, 10));
    const queuedId = [...engine.requests.values()].find((r) => r.state === 'queued')?.id;
    assert.ok(queuedId, 'second request is queued');
    const res = engine.cancel(queuedId);
    assert.equal(res.cancelled, true);
    await assert.rejects(p2, (err) => err.code === 'CANCELLED');
    await p1;
    assert.equal(engine.stats.cancelled, 1);
    engine.shutdown();
  } finally { await mock.close(); }
});

test('a running request can be stopped and frees its slot', async () => {
  const mock = await startMockOllama({ tokenDelayMs: 25, words: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'] });
  try {
    const { engine } = makeEngine({ baseUrl: mock.url });
    await engine.start();
    const p = engine.generate({ model: 'tinytest:1b', messages: MSG, onToken: null });
    await new Promise((r) => setTimeout(r, 60));
    const running = [...engine.requests.values()].find((r) => r.state === 'running');
    assert.ok(running, 'request is running');
    const res = engine.cancel(running.id);
    assert.equal(res.cancelled, true);
    await assert.rejects(p, (err) => err.code === 'CANCELLED');
    assert.equal(engine.active, 0, 'slot released after cancel');
    assert.equal(running.state, 'cancelled');
    engine.shutdown();
  } finally { await mock.close(); }
});

test('cancel of an unknown or finished request is a safe no-op', async () => {
  const mock = await startMockOllama();
  try {
    const { engine } = makeEngine({ baseUrl: mock.url });
    await engine.start();
    assert.equal(engine.cancel('req_nope').cancelled, false);
    const r = await engine.generate({ model: 'tinytest:1b', messages: MSG });
    assert.equal(engine.cancel(r.requestId).cancelled, false);
    engine.shutdown();
  } finally { await mock.close(); }
});

test('request timeout fires, returns TIMEOUT (504) and releases the slot', async () => {
  const mock = await startMockOllama({ tokenDelayMs: 10, hangAfter: 2, words: ['a', 'b', 'c', 'd', 'e', 'f'] });
  try {
    const { engine, config } = makeEngine({
      baseUrl: mock.url,
      configMutator: (c) => { c.profiles.low.requestTimeoutMs = 250; c.backend.streamIdleTimeoutMs = 150; }
    });
    await engine.start();
    const started = Date.now();
    await assert.rejects(() => engine.generate({ model: 'tinytest:1b', messages: MSG }), (err) => {
      assert.equal(err.code, 'TIMEOUT');
      assert.equal(err.status, 504);
      return true;
    });
    assert.ok(Date.now() - started < 3000, 'timeout actually bounded the wait');
    assert.equal(engine.active, 0, 'slot released after timeout');
    assert.equal(engine.stats.timeouts, 1);
    await new Promise((r) => setTimeout(r, 80)); // let the socket close reach the backend
    assert.ok(mock.state.disconnects >= 1, 'backend connection closed');
    engine.shutdown();
  } finally { await mock.close(); }
});

test('memory gate blocks a start that would exceed the safe budget', async () => {
  const mock = await startMockOllama();
  try {
    const sampler = { latest: fakeMetrics({ totalRamMb: 16000, availableRamMb: 2500, usedRamMb: 13500 }), history: [], async sample() { return this.latest; }, stop() {} };
    const { engine } = makeEngine({ baseUrl: mock.url, sampler });
    await engine.start();
    await assert.rejects(() => engine.generate({ model: 'smalltest:3b', messages: MSG }), (err) => {
      assert.equal(err.code, 'MEMORY_BUDGET');
      assert.equal(err.status, 503);
      assert.match(err.message, /Forecast|reserve|budget/i);
      return true;
    });
    assert.equal(engine.stats.rejectedBudget, 1);
    assert.equal(engine.active, 0, 'slot released after refusal');
    assert.equal(mock.state.chatRequests.length, 0, 'backend never asked to load the model');
    engine.shutdown();
  } finally { await mock.close(); }
});

test('memory gate allows a start inside the budget', async () => {
  const mock = await startMockOllama();
  try {
    const sampler = { latest: fakeMetrics({ totalRamMb: 16000, availableRamMb: 9000, usedRamMb: 7000 }), history: [], async sample() { return this.latest; }, stop() {} };
    const { engine } = makeEngine({ baseUrl: mock.url, sampler });
    await engine.start();
    const r = await engine.generate({ model: 'tinytest:1b', messages: MSG });
    assert.ok(r.text.length > 0);
    engine.shutdown();
  } finally { await mock.close(); }
});

test('missing model surfaces MODEL_NOT_FOUND through the engine', async () => {
  const mock = await startMockOllama();
  try {
    const { engine } = makeEngine({ baseUrl: mock.url });
    await engine.start();
    await assert.rejects(() => engine.generate({ model: 'ghost:7b', messages: MSG }), (err) => err.code === 'MODEL_NOT_FOUND');
    assert.equal(engine.active, 0);
    engine.shutdown();
  } finally { await mock.close(); }
});

test('backend crash mid-request fails cleanly, releases resources and marks health', async () => {
  const mock = await startMockOllama({ chatStatus: 500 });
  try {
    const { engine } = makeEngine({ baseUrl: mock.url });
    await engine.start();
    await assert.rejects(() => engine.generate({ model: 'tinytest:1b', messages: MSG }), (err) => err.status === 500);
    assert.equal(engine.active, 0, 'slot released after crash');
    assert.equal(engine.stats.failed, 1);
    assert.ok(engine.perf.summary().counters.errors >= 1, 'error recorded in diagnostics');
    engine.shutdown();
  } finally { await mock.close(); }
});

test('recovery: backend coming back is detected again by ensureHealthy', async () => {
  const { engine } = makeEngine({ baseUrl: 'http://127.0.0.1:1' });
  await engine.start();
  assert.equal(engine.health.ok, false);
  assert.equal(await engine.ensureHealthy(), false, 'still down');
  const mock = await startMockOllama();
  try {
    engine.config.backend.baseUrl = mock.url;
    engine.backend.baseUrl = mock.url;
    assert.equal(await engine.ensureHealthy(), true, 'backend restored');
    const r = await engine.generate({ model: 'tinytest:1b', messages: MSG });
    assert.ok(r.text.length > 0);
    engine.shutdown();
  } finally { await mock.close(); }
});

test('idle models are unloaded automatically after the profile timer', async () => {
  const mock = await startMockOllama();
  try {
    const { engine, config } = makeEngine({ baseUrl: mock.url, configMutator: (c) => { c.profiles.low.idleUnloadSeconds = 0.15; } });
    await engine.start();
    await engine.generate({ model: 'tinytest:1b', messages: MSG });
    assert.equal(mock.state.unloads.length, 0, 'not unloaded while active');
    await new Promise((r) => setTimeout(r, 400));
    assert.ok(mock.state.unloads.length >= 1, 'idle unload happened');
    assert.equal(mock.state.unloads[0].keep_alive, 0);
    engine.shutdown();
  } finally { await mock.close(); }
});

test('manual unload releases the model immediately', async () => {
  const mock = await startMockOllama();
  try {
    const { engine } = makeEngine({ baseUrl: mock.url });
    await engine.start();
    await engine.generate({ model: 'tinytest:1b', messages: MSG });
    const r = await engine.unload('tinytest:1b');
    assert.deepEqual(r.unloaded, ['tinytest:1b']);
    engine.shutdown();
  } finally { await mock.close(); }
});

test('profile switching is validated', async () => {
  const { engine } = makeEngine({ baseUrl: 'http://127.0.0.1:1' });
  assert.equal(engine.setProfile('balanced').label, 'Balanced');
  assert.throws(() => engine.setProfile('turbo'), (err) => err.code === 'BAD_PROFILE');
  assert.equal(engine.config.profile, 'balanced');
  engine.shutdown();
});
