// Тесты собственного интерфейса LiteMind и новых API: Workspace (файлы) и AI Terminal.
// Проверяются реальные файлы на диске и реальные процессы shell — никаких заглушек.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startMockOllama } from './helpers/mock-ollama.js';
import { makeEngine, fakeMetrics } from './helpers/fixtures.js';
import { createServer } from '../src/api/server.js';

async function startApi() {
  const mock = await startMockOllama({});
  const { engine, config } = makeEngine({
    baseUrl: mock.url,
    sampler: { latest: fakeMetrics(), history: [], async sample() { return this.latest; }, stop() {} }
  });
  await engine.start();
  const server = createServer({ config, engine, logger: null });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  return { url, server, mock, close: () => new Promise((r) => server.close(r)) };
}

test('Workspace: чтение и сохранение файла проекта (реальные файлы)', async () => {
  const api = await startApi();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'litemind-ws-'));
  fs.writeFileSync(path.join(dir, 'main.py'), 'print("hello")\n');
  try {
    // Чтение
    const res = await fetch(`${api.url}/api/project/file?path=${encodeURIComponent(dir)}&file=main.py`);
    assert.equal(res.status, 200);
    const f = await res.json();
    assert.equal(f.content, 'print("hello")\n');
    assert.equal(f.file, 'main.py');

    // Запись
    const save = await fetch(`${api.url}/api/project/file`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: dir, file: 'main.py', content: 'print("edited")\n' })
    });
    assert.equal(save.status, 200);
    assert.equal(fs.readFileSync(path.join(dir, 'main.py'), 'utf8'), 'print("edited")\n');

    // Выход за пределы проекта — запрет
    const evil = await fetch(`${api.url}/api/project/file?path=${encodeURIComponent(dir)}&file=../outside.txt`);
    assert.equal(evil.status, 400);

    // Несуществующий файл — 404 и без создания
    const missing = await fetch(`${api.url}/api/project/file?path=${encodeURIComponent(dir)}&file=nope.txt`);
    assert.equal(missing.status, 404);
    assert.ok(!fs.existsSync(path.join(dir, 'nope.txt')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    await api.close(); await api.mock.close();
  }
});

test('Workspace: бинарный файл не открывается (415), большой файл — 413', async () => {
  const api = await startApi();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'litemind-ws-'));
  fs.writeFileSync(path.join(dir, 'bin.dat'), Buffer.from([0x00, 0x01, 0x02]));
  try {
    const res = await fetch(`${api.url}/api/project/file?path=${encodeURIComponent(dir)}&file=bin.dat`);
    assert.equal(res.status, 415);

    const big = path.join(dir, 'big.txt');
    fs.writeFileSync(big, 'x'.repeat(2 * 1024 * 1024 + 10));
    const res2 = await fetch(`${api.url}/api/project/file?path=${encodeURIComponent(dir)}&file=big.txt`);
    assert.equal(res2.status, 413);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    await api.close(); await api.mock.close();
  }
});

test('AI Terminal: команда выполняется реально, код возврата и вывод корректны', async () => {
  const api = await startApi();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'litemind-term-'));
  try {
    const res = await fetch(`${api.url}/api/terminal/exec`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cwd: dir, command: 'echo litemind-terminal-ok' })
    });
    assert.equal(res.status, 200);
    const r = await res.json();
    assert.equal(r.exitCode, 0);
    assert.match(r.stdout, /litemind-terminal-ok/);
    assert.ok(r.durationMs >= 0);

    // Ошибочная команда: ненулевой код выхода, stderr заполнен
    const bad = await fetch(`${api.url}/api/terminal/exec`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cwd: dir, command: 'node -e "process.exit(3)"' })
    });
    const rb = await bad.json();
    assert.equal(rb.exitCode, 3);

    // Несуществующая команда → код не 0
    const missing = await fetch(`${api.url}/api/terminal/exec`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cwd: dir, command: 'definitely-not-a-command-xyz' })
    });
    const rm = await missing.json();
    assert.notEqual(rm.exitCode, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    await api.close(); await api.mock.close();
  }
});

test('AI Terminal: таймаут принудительно завершает зависшую команду', async () => {
  const api = await startApi();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'litemind-term-'));
  try {
    const res = await fetch(`${api.url}/api/terminal/exec`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cwd: dir, command: 'node -e "setInterval(()=>{},1000)"', timeoutMs: 800 })
    });
    assert.equal(res.status, 200);
    const r = await res.json();
    assert.equal(r.timedOut, true);
    assert.ok(r.durationMs < 5000, `ожидали быстрый таймаут, получили ${r.durationMs} мс`);
    assert.ok(r.error, 'сообщение о таймауте присутствует');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    await api.close(); await api.mock.close();
  }
});

test('AI Terminal: несуществующий cwd → 404; пустая команда → 400', async () => {
  const api = await startApi();
  try {
    const res = await fetch(`${api.url}/api/terminal/exec`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cwd: '/definitely/not/here', command: 'ls' })
    });
    assert.equal(res.status, 404);

    const res2 = await fetch(`${api.url}/api/terminal/exec`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cwd: os.tmpdir(), command: '   ' })
    });
    assert.equal(res2.status, 400);
  } finally { await api.close(); await api.mock.close(); }
});
