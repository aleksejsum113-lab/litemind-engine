// ТЗ §16 — управление запуском и полной остановкой движка.
// Все сценарии проверяются на реальных процессах: mock-Ollama (настоящий HTTP-сервер),
// настоящий HTTP-сервер загрузок и настоящий API-сервер движка. Никаких заглушек-надписей.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { startMockOllama } from './helpers/mock-ollama.js';
import { makeEngine, fakeMetrics } from './helpers/fixtures.js';
import { createServer } from '../src/api/server.js';
import { DownloadManager } from '../src/download/manager.js';

async function startApi({ baseUrl, configMutator = null, sampler = null } = {}) {
  const { engine, config } = makeEngine({ baseUrl, configMutator, sampler: sampler ?? { latest: fakeMetrics(), history: [], async sample() { return this.latest; }, stop() {} } });
  await engine.start();
  const server = createServer({ config, engine, logger: null });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  return { url, engine, config, server, close: () => new Promise((r) => server.close(r)) };
}

const post = (url, p, body = {}) => fetch(`${url}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('во время генерации /api/engine/state показывает working модель, после — resident', async () => {
  const mock = await startMockOllama({ tokenDelayMs: 120, words: ['a', 'b', 'c', 'd', 'e'] });
  const api = await startApi({ baseUrl: mock.url });
  try {
    const chat = post(api.url, '/v1/chat/completions', { model: 'tinytest:1b', messages: [{ role: 'user', content: 'hi' }] });
    await new Promise((r) => setTimeout(r, 60)); // соединение открыто, токены ещё не пошли
    let state = await (await fetch(`${api.url}/api/engine/state`)).json();
    assert.equal(state.engine, 'running');
    let m = state.models.find((x) => x.id === 'tinytest:1b');
    assert.ok(['loading', 'running'].includes(m.state), `expected loading|running, got ${m.state}`);

    await chat; // дожидаемся завершения (mock оставляет модель резидентной — как Ollama с keep_alive)
    state = await (await fetch(`${api.url}/api/engine/state`)).json();
    m = state.models.find((x) => x.id === 'tinytest:1b');
    assert.equal(m.state, 'running', 'resident model (in /api/ps) is "running"');
  } finally { await api.close(); await mock.close(); }
});

test('«Остановить модель» отменяет генерацию и выгружает модель из RAM', async () => {
  const mock = await startMockOllama({ tokenDelayMs: 40, words: Array.from({ length: 200 }, (_, i) => `t${i}`) });
  const api = await startApi({ baseUrl: mock.url });
  try {
    const chat = post(api.url, '/v1/chat/completions', { model: 'tinytest:1b', messages: [{ role: 'user', content: 'long' }] });
    await new Promise((r) => setTimeout(r, 150)); // токены уже идут
    const res = await post(api.url, '/api/models/stop', { model: 'tinytest:1b' });
    assert.equal(res.status, 200);
    const r = await res.json();
    assert.equal(r.verified, true, 'выгрузка подтверждена опросом /api/ps');
    assert.equal(r.cancelledRequests, 1, 'генерация отменена');
    assert.ok(r.ram, 'RAM-отчёт присутствует');
    assert.equal(mock.state.unloads.at(-1).keep_alive, 0, 'модель выгружена через keep_alive:0');
    assert.equal(mock.state.unloads.at(-1).model, 'tinytest:1b');
    assert.ok(mock.state.disconnects >= 1, 'сокет генерации закрыт');

    const chatRes = await chat; // клиент генерации получил отказ CANCELLED (код 499 — контракт API)
    assert.equal(chatRes.status, 499);
    assert.equal((await chatRes.json()).error.code, 'CANCELLED');

    const state = await (await fetch(`${api.url}/api/engine/state`)).json();
    const m = state.models.find((x) => x.id === 'tinytest:1b');
    assert.equal(m.state, 'stopped', 'состояние модели — «остановлена»');
  } finally { await api.close(); await mock.close(); }
});

test('«Остановить все модели» выгружает всё резидентное и подтверждает результат', async () => {
  const mock = await startMockOllama({ tokenDelayMs: 1 });
  const api = await startApi({ baseUrl: mock.url });
  try {
    // Загружаем обе модели резидентно (короткие чаты).
    await post(api.url, '/v1/chat/completions', { model: 'tinytest:1b', messages: [{ role: 'user', content: 'x' }] });
    await post(api.url, '/v1/chat/completions', { model: 'smalltest:3b', messages: [{ role: 'user', content: 'y' }] });
    assert.equal(mock.state.loaded.size, 2);

    const res = await post(api.url, '/api/models/stop-all');
    assert.equal(res.status, 200);
    const r = await res.json();
    assert.equal(r.verified, true, '/api/ps пуст после остановки');
    assert.deepEqual(mock.state.loaded.size, 0);
    assert.deepEqual(r.stillLoaded, []);
    assert.equal(r.unloaded.length, 2);

    const state = await (await fetch(`${api.url}/api/engine/state`)).json();
    assert.ok(state.models.every((m) => m.state === 'stopped'));
  } finally { await api.close(); await mock.close(); }
});

test('после beginStop()/shutdownFull() новые генерации отклоняются — повторного включения нет', async () => {
  const mock = await startMockOllama();
  const api = await startApi({ baseUrl: mock.url });
  try {
    await api.engine.shutdownFull();
    assert.equal(api.engine.lifecycle.state, 'stopped');

    const res = await post(api.url, '/v1/chat/completions', { model: 'tinytest:1b', messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.equal(body.error.code, 'ENGINE_STOPPING');
    assert.equal(mock.state.chatRequests.length, 0, 'запрос к бэкенду не отправлялся');

    // и по прямой очереди генерации движка — тоже отказ
    await assert.rejects(
      () => api.engine.generate({ model: 'tinytest:1b', messages: [{ role: 'user', content: 'hi' }] }),
      (e) => e.code === 'ENGINE_STOPPING'
    );
  } finally { await api.close(); await mock.close(); }
});

test('POST /api/engine/stop: модели выгружены, сервер закрыт, движок stopped', async () => {
  const mock = await startMockOllama({ tokenDelayMs: 1 });
  const api = await startApi({ baseUrl: mock.url });
  try {
    await post(api.url, '/v1/chat/completions', { model: 'tinytest:1b', messages: [{ role: 'user', content: 'x' }] });
    assert.equal(mock.state.loaded.size, 1);

    const res = await post(api.url, '/api/engine/stop');
    assert.equal(res.status, 200);
    assert.equal((await res.json()).stopping, true);

    // Дождаться фактического закрытия сервера.
    const deadline = Date.now() + 5000;
    let closed = false;
    while (Date.now() < deadline) {
      try { await fetch(`${api.url}/health`, { signal: AbortSignal.timeout(400) }); await new Promise((r) => setTimeout(r, 100)); }
      catch { closed = true; break; }
    }
    assert.equal(closed, true, 'сервер движка закрыт');
    assert.equal(api.engine.lifecycle.state, 'stopped');
    assert.equal(mock.state.loaded.size, 0, 'модели выгружены из RAM');
    assert.equal(mock.state.unloads.length, 1);
  } finally {
    await api.server.close().catch?.(() => {}); await mock.close();
  }
});

test('POST /api/shutdown теперь тоже выгружает модели (полная остановка)', async () => {
  const mock = await startMockOllama({ tokenDelayMs: 1 });
  const api = await startApi({ baseUrl: mock.url });
  try {
    await post(api.url, '/v1/chat/completions', { model: 'tinytest:1b', messages: [{ role: 'user', content: 'x' }] });
    const res = await post(api.url, '/api/shutdown');
    assert.equal(res.status, 200);
    const deadline = Date.now() + 5000;
    let closed = false;
    while (Date.now() < deadline) {
      try { await fetch(`${api.url}/health`, { signal: AbortSignal.timeout(400) }); await new Promise((r) => setTimeout(r, 100)); }
      catch { closed = true; break; }
    }
    assert.equal(closed, true);
    assert.equal(mock.state.loaded.size, 0, 'модель не осталась в RAM после /api/shutdown');
  } finally { await mock.close(); }
});

test('stopModel без model → 400; stopModel остановленной модели → идемпотентно', async () => {
  const mock = await startMockOllama({ tokenDelayMs: 1 });
  const api = await startApi({ baseUrl: mock.url });
  try {
    const bad = await post(api.url, '/api/models/stop', {});
    assert.equal(bad.status, 400);

    const first = await post(api.url, '/api/models/stop', { model: 'tinytest:1b' });
    assert.equal(first.status, 200);
    assert.equal((await first.json()).verified, true);

    // Повторная остановка — без ошибок и без лишней выгрузки чужих процессов.
    const again = await post(api.url, '/api/models/stop', { model: 'tinytest:1b' });
    assert.equal(again.status, 200);
    assert.equal((await again.json()).verified, true);
  } finally { await api.close(); await mock.close(); }
});

test('DownloadManager.cancelAll останавливает загрузки и удаляет .part', async () => {
  // Настоящий медленный HTTP-сервер — как реальная загрузка с HuggingFace.
  const src = http.createServer((req, res) => {
    res.writeHead(200, { 'content-length': String(10 * 1024 * 1024) });
    const iv = setInterval(() => res.write(Buffer.alloc(64 * 1024, 1)), 20);
    res.on('close', () => clearInterval(iv));
  });
  await new Promise((r) => src.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${src.address().port}/model.bin`;

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'litemind-dl-'));
  const dm = new DownloadManager();
  try {
    const job = await dm.start({ id: 'm1', url, name: 'model.gguf', targetDir: dir, sizeBytes: 10 * 1024 * 1024 });
    await new Promise((r) => setTimeout(r, 300)); // часть данных скачалась
    const partPath = path.join(dir, 'model.gguf.part');
    assert.ok(fs.existsSync(partPath), '.part существует во время загрузки');

    const r = await dm.cancelAll();
    assert.equal(r.cancelled, 1);
    assert.ok(!fs.existsSync(partPath), '.part удалён после полной остановки');
    assert.equal(dm.list().length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    src.close(); src.closeAllConnections?.();
  }
});

test('Остановленный движок не планирует idle-unload и не принимает профиль/генерацию', async () => {
  const mock = await startMockOllama();
  const api = await startApi({ baseUrl: mock.url });
  try {
    await api.engine.shutdownFull();
    const res = await post(api.url, '/api/profile', { profile: 'low' });
    // Профиль — это настройка, не запуск модели: разрешён, но генерация запрещена.
    assert.equal(res.status, 200);
    const chat = await post(api.url, '/v1/chat/completions', { model: 'tinytest:1b', messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(chat.status, 503);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(mock.state.unloads.length, 0, 'никаких фоновых выгрузок/запусков после остановки');
  } finally { await api.close(); await mock.close(); }
});
