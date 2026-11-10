// Тесты Этапа 1 / C3: остановка терминала, запуск и проверка GGUF по пути.
// Никаких заглушек там, где проверяется реальное поведение: реальные процессы,
// реальные файлы на диске, реальный SHA-256. Стаб только для llama-server,
// которого в тестовой среде нет.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeEngine, fakeMetrics } from './helpers/fixtures.js';
import { createServer } from '../src/api/server.js';

const sampler = { latest: fakeMetrics(), history: [], async sample() { return this.latest; }, stop() {} };

// API без внешнего backend (lmlama по умолчанию) и с отдельной папкой моделей.
async function startApi({ stubEnsureServer = false } = {}) {
  const modelsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'litemind-mmodels-'));
  const { engine, config } = makeEngine({
    sampler,
    configMutator: (c) => { c.models.rootDir = modelsRoot; }
  });
  if (stubEnsureServer) {
    // llama-server в тестовой среде отсутствует — проверяем только контракт API.
    engine.backend.ensureServer = async ({ file }) => `http://127.0.0.1:5999?file=${encodeURIComponent(file)}`;
  }
  await engine.start();
  const server = createServer({ config, engine, logger: null });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  return {
    url, config, engine, modelsRoot,
    close: async () => {
      server.close(); server.closeAllConnections?.(); engine.shutdown();
      fs.rmSync(modelsRoot, { recursive: true, force: true });
    }
  };
}

const post = (url, route, payload) => fetch(`${url}${route}`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload)
});

// ---------------------------------------------------------------- терминал

test('C3: «Остановить» убивает длинную команду быстро, stopped=true', async () => {
  const api = await startApi();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'litemind-term-'));
  try {
    const started = Date.now();
    // Клиент задаёт jobId заранее — иначе UI не знал бы, что останавливать.
    const pending = post(api.url, '/api/terminal/exec', {
      cwd: dir, command: 'node -e "setInterval(()=>{},1000)"', timeoutMs: 30000, jobId: 'stop-me-1'
    });
    await new Promise((r) => setTimeout(r, 900)); // команда гарантированно стартовала
    const stop = await post(api.url, '/api/terminal/stop', { jobId: 'stop-me-1' });
    assert.equal(stop.status, 200);
    const sj = await stop.json();
    assert.equal(sj.ok, true, `stop должен вернуть ok:true, получил ${JSON.stringify(sj)}`);

    const res = await pending;
    const r = await res.json();
    assert.equal(r.jobId, 'stop-me-1');
    assert.equal(r.stopped, true, 'exec должен пометить команду как остановленную пользователем');
    assert.equal(r.timedOut, false);
    assert.ok(r.durationMs < 6000, `остановка должна быть быстрой, получили ${r.durationMs} мс`);
    assert.ok(Date.now() - started < 10000, 'exec-запрос не должен висеть до таймаута');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    await api.close();
  }
});

test('C3: stop без jobId останавливает последнюю активную команду', async () => {
  const api = await startApi();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'litemind-term-'));
  try {
    const pending = post(api.url, '/api/terminal/exec', {
      cwd: dir, command: 'node -e "setInterval(()=>{},1000)"', timeoutMs: 30000
    });
    await new Promise((r) => setTimeout(r, 900));
    const stop = await post(api.url, '/api/terminal/stop', {});
    const sj = await stop.json();
    assert.equal(sj.ok, true);
    const r = await (await pending).json();
    assert.equal(r.stopped, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    await api.close();
  }
});

test('C3: stop завершённой команды — ok:false без ошибки сервера', async () => {
  const api = await startApi();
  try {
    const stop = await post(api.url, '/api/terminal/stop', { jobId: 'never-existed' });
    assert.equal(stop.status, 200);
    const sj = await stop.json();
    assert.equal(sj.ok, false);
    assert.ok(sj.error);
  } finally { await api.close(); }
});

test('C3: нормальная команда не помечается остановленной, jobId генерируется', async () => {
  const api = await startApi();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'litemind-term-'));
  try {
    const r = await (await post(api.url, '/api/terminal/exec', { cwd: dir, command: 'echo ok-c3' })).json();
    assert.equal(r.exitCode, 0);
    assert.equal(r.stopped, false);
    assert.equal(r.timedOut, false);
    assert.match(r.jobId, /^t[\w-]+$/);
    assert.match(r.stdout, /ok-c3/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    await api.close();
  }
});

// ------------------------------------------------- verify (режим «файл»)

function writeGguf(file, { magic = true, fillerMb = 1 } = {}) {
  const head = Buffer.alloc(8);
  if (magic) head.write('GGUF', 0, 'binary');
  head.writeUInt32LE(3, 4); // версия формата
  const body = Buffer.alloc(fillerMb * 1024 * 1024, 0x5a);
  fs.writeFileSync(file, Buffer.concat([head, body]));
}

test('C3: verify файла — корректный GGUF подтверждается, SHA-256 считается', async () => {
  const api = await startApi();
  try {
    const file = path.join(api.modelsRoot, 'good-model.gguf');
    writeGguf(file, { fillerMb: 1 });
    const expected = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    const r = await (await post(api.url, '/api/models/verify', { file })).json();
    assert.equal(r.ok, true);
    assert.equal(r.verified, true);
    assert.equal(r.magicOk, true);
    assert.equal(r.sizeBytes, fs.statSync(file).size);
    assert.equal(r.sha256, expected, 'SHA-256 из ответа должен совпадать с фактическим');
  } finally { await api.close(); }
});

test('C3: verify файла — битый файл (без сигнатуры GGUF) отклоняется', async () => {
  const api = await startApi();
  try {
    const file = path.join(api.modelsRoot, 'broken.gguf');
    fs.writeFileSync(file, Buffer.alloc(2 * 1024 * 1024, 0x00));
    const r = await (await post(api.url, '/api/models/verify', { file })).json();
    assert.equal(r.verified, false);
    assert.equal(r.magicOk, false);
    assert.match(r.message, /повреждён/i);
  } finally { await api.close(); }
});

test('C3: verify/run — путь вне папки моделей запрещён (защита от произвольного чтения)', async () => {
  const api = await startApi();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'litemind-outside-'));
  try {
    const outside = path.join(dir, 'secret.gguf');
    writeGguf(outside);
    const v = await post(api.url, '/api/models/verify', { file: outside });
    assert.equal(v.status, 400, 'verify файла вне папки моделей должен давать 400');
    const run = await post(api.url, '/api/models/run', { file: outside });
    assert.equal(run.status, 400, 'run файла вне папки моделей должен давать 400');

    // Обход через «..» внутри пути — тоже запрещён (после resolve это вне root).
    const evil = path.join(api.modelsRoot, '..', '..', 'secret.gguf');
    const v2 = await post(api.url, '/api/models/verify', { file: evil });
    assert.equal(v2.status, 400, 'обход через «..» должен отвергаться');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    await api.close();
  }
});

test('C3: verify — несуществующий файл и каталог дают предсказуемый ответ', async () => {
  const api = await startApi();
  try {
    const nf = await (await post(api.url, '/api/models/verify', { file: path.join(api.modelsRoot, 'nope.gguf') })).json();
    assert.equal(nf.ok, false);
    assert.equal(nf.reason, 'not_found');

    const dirResp = await post(api.url, '/api/models/verify', { file: api.modelsRoot });
    assert.equal(dirResp.status, 400, 'каталог вместо файла — 400, а не 500');
  } finally { await api.close(); }
});

// ------------------------------------------------- run (режим «файл»)

test('C3: run файла — не-GGUF отклоняется, отсутствующий файл даёт ok:false', async () => {
  const api = await startApi({ stubEnsureServer: true });
  try {
    const txt = path.join(api.modelsRoot, 'readme.txt');
    fs.writeFileSync(txt, 'not a model');
    const r1 = await post(api.url, '/api/models/run', { file: txt });
    assert.equal(r1.status, 400);
    assert.match((await r1.json()).error.message, /GGUF/i);

    const r2 = await (await post(api.url, '/api/models/run', { file: path.join(api.modelsRoot, 'ghost.gguf') })).json();
    assert.equal(r2.ok, false);
    assert.equal(r2.reason, 'not_found');
  } finally { await api.close(); }
});

test('C3: run файла — каталог вместо файла даёт 400', async () => {
  const api = await startApi({ stubEnsureServer: true });
  try {
    const dir = path.join(api.modelsRoot, 'folder.gguf'); // .gguf, но каталог
    fs.mkdirSync(dir);
    const resp = await post(api.url, '/api/models/run', { file: dir });
    assert.equal(resp.status, 400);
  } finally { await api.close(); }
});

test('C3: run файла — корректный GGUF запускается через backend (стаб)', async () => {
  const api = await startApi({ stubEnsureServer: true });
  try {
    const file = path.join(api.modelsRoot, 'qwen-test.gguf');
    writeGguf(file);
    const r = await (await post(api.url, '/api/models/run', { file, contextTokens: 2048 })).json();
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.model, 'qwen-test');
    assert.equal(r.file, file);
    assert.equal(r.contextTokens, 2048);
    assert.match(r.baseUrl, /^http:\/\/127\.0\.0\.1:5999/);
  } finally { await api.close(); }
});

test('C3: run на backend без ensureServer — 501 RUN_UNSUPPORTED', async () => {
  // baseUrl => registry выбирает ollama-backend, у него нет ensureServer.
  const modelsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'litemind-mmodels-'));
  const { engine, config } = makeEngine({
    baseUrl: 'http://127.0.0.1:1', sampler,
    configMutator: (c) => { c.models.rootDir = modelsRoot; }
  });
  await engine.start();
  const server = createServer({ config, engine, logger: null });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal(typeof engine.backend.ensureServer, 'undefined', 'у ollama-backend не должно быть ensureServer');
    const resp = await post(url, '/api/models/run', { file: path.join(modelsRoot, 'x.gguf') });
    assert.equal(resp.status, 501);
    const e = await resp.json();
    assert.equal(e.error.code, 'RUN_UNSUPPORTED');
  } finally {
    server.close(); server.closeAllConnections?.(); engine.shutdown();
    fs.rmSync(modelsRoot, { recursive: true, force: true });
  }
});
