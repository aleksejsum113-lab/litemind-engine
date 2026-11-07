import test from 'node:test';
import assert from 'node:assert/strict';
import { startMockOllama } from './helpers/mock-ollama.js';
import { makeEngine, fakeMetrics } from './helpers/fixtures.js';
import { createServer, isLoopback, checkAccess } from '../src/api/server.js';

async function startApi({ baseUrl, configMutator = null, sampler = null } = {}) {
  const { engine, config } = makeEngine({ baseUrl, configMutator, sampler: sampler ?? { latest: fakeMetrics(), history: [], async sample() { return this.latest; }, stop() {} } });
  await engine.start();
  const server = createServer({ config, engine, logger: null });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  return {
    url, engine, config,
    close: async () => { server.close(); server.closeAllConnections?.(); engine.shutdown(); }
  };
}

async function readSse(res) {
  const text = await res.text();
  const events = [];
  for (const block of text.split('\n\n')) {
    const line = block.split('\n').find((l) => l.startsWith('data: '));
    if (!line) continue;
    const payload = line.slice(6);
    events.push(payload === '[DONE]' ? '[DONE]' : JSON.parse(payload));
  }
  return events;
}

test('isLoopback accepts only loopback addresses', () => {
  assert.equal(isLoopback('127.0.0.1'), true);
  assert.equal(isLoopback('::1'), true);
  assert.equal(isLoopback('::ffff:127.0.0.1'), true);
  assert.equal(isLoopback('192.168.1.50'), false);
  assert.equal(isLoopback('10.0.0.7'), false);
  assert.equal(isLoopback(null), false);
});

test('/health reports ok with a healthy backend', async () => {
  const mock = await startMockOllama();
  const api = await startApi({ baseUrl: mock.url });
  try {
    const res = await fetch(`${api.url}/health`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.status, 'ok');
    assert.equal(data.backend.healthy, true);
    assert.equal(data.profile, 'balanced');
  } finally { await api.close(); await mock.close(); }
});

test('/health reports 503 when backend is missing', async () => {
  const api = await startApi({ baseUrl: 'http://127.0.0.1:1' });
  try {
    const res = await fetch(`${api.url}/health`);
    assert.equal(res.status, 503);
    const data = await res.json();
    assert.equal(data.status, 'degraded');
    assert.match(data.backend.error, /not reachable/);
  } finally { await api.close(); }
});

test('/v1/models returns OpenAI list shape', async () => {
  const mock = await startMockOllama();
  const api = await startApi({ baseUrl: mock.url });
  try {
    const res = await fetch(`${api.url}/v1/models`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.object, 'list');
    assert.equal(data.data.length, 2);
    assert.deepEqual(Object.keys(data.data[0]).sort(), ['created', 'id', 'litemind', 'object', 'owned_by', 'size']);
    assert.equal(data.data[0].litemind.backend, 'ollama');
    assert.equal(typeof data.data[0].litemind.tools, 'boolean');
  } finally { await api.close(); await mock.close(); }
});

test('/v1/models returns 503 with a clear error when backend is down', async () => {
  const api = await startApi({ baseUrl: 'http://127.0.0.1:1' });
  try {
    const res = await fetch(`${api.url}/v1/models`);
    assert.equal(res.status, 503);
    const data = await res.json();
    assert.equal(data.error.code, 'BACKEND_UNAVAILABLE');
    assert.match(data.error.message, /not reachable/);
  } finally { await api.close(); }
});

test('non-streaming chat completion returns an OpenAI-shaped response', async () => {
  const mock = await startMockOllama();
  const api = await startApi({ baseUrl: mock.url });
  try {
    const res = await fetch(`${api.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'tinytest:1b', messages: [{ role: 'user', content: 'hi' }] })
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.object, 'chat.completion');
    assert.equal(data.choices[0].message.role, 'assistant');
    assert.equal(data.choices[0].message.content, 'Hello from the mock model');
    assert.equal(data.choices[0].finish_reason, 'stop');
    assert.ok(data.usage.completion_tokens > 0);
    assert.ok(data.litemind.request_id);
  } finally { await api.close(); await mock.close(); }
});

test('streaming chat completion yields SSE chunks and [DONE]', async () => {
  const mock = await startMockOllama();
  const api = await startApi({ baseUrl: mock.url });
  try {
    const res = await fetch(`${api.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'tinytest:1b', stream: true, messages: [{ role: 'user', content: 'hi' }] })
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/event-stream/);
    const events = await readSse(res);
    assert.equal(events.at(-1), '[DONE]');
    const text = events.filter((e) => e !== '[DONE]').map((e) => e.choices?.[0]?.delta?.content ?? '').join('');
    assert.equal(text, 'Hello from the mock model');
    const finish = events.filter((e) => e !== '[DONE]').at(-1);
    assert.equal(finish.choices[0].finish_reason, 'stop');
  } finally { await api.close(); await mock.close(); }
});

test('client disconnect mid-stream aborts generation and frees the slot', async () => {
  const mock = await startMockOllama({ tokenDelayMs: 40, words: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'] });
  const api = await startApi({ baseUrl: mock.url });
  try {
    const res = await fetch(`${api.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'tinytest:1b', stream: true, messages: [{ role: 'user', content: 'hi' }] })
    });
    const reader = res.body.getReader();
    await reader.read(); // wait for the first chunk, then walk away
    await reader.cancel();
    await new Promise((r) => setTimeout(r, 200));
    assert.ok(mock.state.disconnects >= 1, 'backend saw the abort');
    assert.equal(api.engine.active, 0, 'slot released');
    const health = await fetch(`${api.url}/health`);
    assert.equal(health.status, 200);
  } finally { await api.close(); await mock.close(); }
});

test('unknown model returns 404 with an OpenAI-style error', async () => {
  const mock = await startMockOllama();
  const api = await startApi({ baseUrl: mock.url });
  try {
    const res = await fetch(`${api.url}/v1/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'ghost:7b', messages: [{ role: 'user', content: 'hi' }] })
    });
    assert.equal(res.status, 404);
    const data = await res.json();
    assert.equal(data.error.code, 'MODEL_NOT_FOUND');
    assert.match(data.error.message, /tinytest:1b/);
  } finally { await api.close(); await mock.close(); }
});

test('invalid payloads return 400 with a readable message', async () => {
  const mock = await startMockOllama();
  const api = await startApi({ baseUrl: mock.url });
  try {
    const res = await fetch(`${api.url}/v1/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'tinytest:1b' })
    });
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.match(data.error.message, /messages/);

    const bad = await fetch(`${api.url}/v1/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{oops'
    });
    assert.equal(bad.status, 400);
  } finally { await api.close(); await mock.close(); }
});

test('POST /api/cancel is safe for unknown ids', async () => {
  const mock = await startMockOllama();
  const api = await startApi({ baseUrl: mock.url });
  try {
    const res = await fetch(`${api.url}/api/cancel`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ request_id: 'req_missing' })
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.cancelled, false);
    assert.match(data.reason, /unknown/);

    const missing = await fetch(`${api.url}/api/cancel`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}'
    });
    assert.equal(missing.status, 400);
  } finally { await api.close(); await mock.close(); }
});

test('queue overflow answers 429 instead of stacking requests', async () => {
  const mock = await startMockOllama({ tokenDelayMs: 40, words: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'] });
  const api = await startApi({ baseUrl: mock.url, configMutator: (c) => { c.profile = 'low'; c.profiles.low.queueLimit = 0; } });
  try {
    const first = fetch(`${api.url}/v1/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'tinytest:1b', messages: [{ role: 'user', content: 'hi' }] })
    });
    await new Promise((r) => setTimeout(r, 120));
    const second = await fetch(`${api.url}/v1/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'tinytest:1b', messages: [{ role: 'user', content: 'hi again' }] })
    });
    assert.equal(second.status, 429);
    const data = await second.json();
    assert.equal(data.error.code, 'QUEUE_FULL');
    await (await first).json();
  } finally { await api.close(); await mock.close(); }
});

test('access policy: loopback trusted, LAN refused without allowLan, token required with it', () => {
  const auth = { enabled: true, token: 'secret-token' };
  // loopback always allowed (dashboard + local tools work without a token)
  assert.equal(checkAccess({ remoteAddress: '127.0.0.1', allowLan: false, auth }).ok, true);
  assert.equal(checkAccess({ remoteAddress: '::1', allowLan: true, auth, token: null }).ok, true);
  // foreign client, default config -> refused
  const lan = checkAccess({ remoteAddress: '192.168.1.50', allowLan: false, auth });
  assert.equal(lan.ok, false);
  assert.equal(lan.status, 403);
  assert.match(lan.message, /only local clients/);
  // allowLan without configured auth -> refused
  const noAuth = checkAccess({ remoteAddress: '192.168.1.50', allowLan: true, auth: { enabled: false, token: null } });
  assert.equal(noAuth.ok, false);
  assert.equal(noAuth.status, 403);
  assert.match(noAuth.message, /authentication is not configured/);
  // allowLan with auth: token enforced for foreign clients
  assert.equal(checkAccess({ remoteAddress: '192.168.1.50', allowLan: true, auth, token: 'secret-token' }).ok, true);
  const bad = checkAccess({ remoteAddress: '192.168.1.50', allowLan: true, auth, token: 'nope' });
  assert.equal(bad.ok, false);
  assert.equal(bad.status, 401);
});

test('auth enabled does not lock out local clients (dashboard stays usable)', async () => {
  const mock = await startMockOllama();
  const api = await startApi({ baseUrl: mock.url, configMutator: (c) => { c.api.auth.enabled = true; c.api.auth.token = 'secret-token'; } });
  try {
    assert.equal((await fetch(`${api.url}/v1/models`)).status, 200, 'loopback without token is allowed');
    assert.equal((await fetch(`${api.url}/health`)).status, 200, 'health reachable locally');
    assert.equal((await fetch(`${api.url}/`)).status, 200, 'dashboard reachable');
    assert.equal((await fetch(`${api.url}/v1/models`, { headers: { authorization: 'Bearer secret-token' } })).status, 200, 'token also accepted');
  } finally { await api.close(); await mock.close(); }
});

test('dashboard is served without a bundler and references its controls', async () => {
  const mock = await startMockOllama();
  const api = await startApi({ baseUrl: mock.url });
  try {
    const page = await fetch(`${api.url}/`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type'), /text\/html/);
    const html = await page.text();
    for (const marker of ['id="model"', 'id="btn-stop"', 'id="btn-unload"', 'id="saver"', 'id="ctx"', 'LiteMind']) {
      assert.ok(html.includes(marker), `dashboard contains ${marker}`);
    }
    const css = await fetch(`${api.url}/style.css`);
    assert.equal(css.status, 200);
    assert.match(css.headers.get('content-type'), /text\/css/);
    const js = await fetch(`${api.url}/app.js`);
    assert.equal(js.status, 200);
    const unknown = await fetch(`${api.url}/nope`);
    assert.equal(unknown.status, 404);
    assert.equal((await unknown.json()).error.code, 'NOT_FOUND');
  } finally { await api.close(); await mock.close(); }
});

test('profile switch endpoint toggles the Low Resource mode', async () => {
  const mock = await startMockOllama();
  const api = await startApi({ baseUrl: mock.url });
  try {
    const res = await fetch(`${api.url}/api/profile`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ profile: 'balanced' })
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).profile.label, 'Balanced');
    const bad = await fetch(`${api.url}/api/profile`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ profile: 'turbo' })
    });
    assert.equal(bad.status, 400);
  } finally { await api.close(); await mock.close(); }
});

test('POST /api/shutdown closes this server gracefully', async () => {
  const mock = await startMockOllama();
  const api = await startApi({ baseUrl: mock.url });
  try {
    const res = await fetch(`${api.url}/api/shutdown`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}'
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).stopping, true);
    await new Promise((r) => setTimeout(r, 300));
    await assert.rejects(() => fetch(`${api.url}/health`), 'server is no longer accepting connections');
  } finally { await api.close(); await mock.close(); }
});
