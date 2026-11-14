#!/usr/bin/env node
// Зонд E2E-провалов v0.6.4: погода через API сервера, чат с web_globe, тёплый чат.
// Запуск: node packages/litemind-engine/scripts/probe-v064.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const LLAMA_SERVER = '/home/z/work/e2e/build/bin/llama-server';
const MODEL_FILE = '/home/z/work/e2e/qwen25-05b-q4km.gguf';
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'litemind-probe-'));

fs.mkdirSync(path.join(WORK, 'models'), { recursive: true });
fs.copyFileSync(MODEL_FILE, path.join(WORK, 'models', 'Qwen2.5-0.5B-Instruct-Q4_K_M.gguf'));
const config = {
  backend: { type: 'lmlama', serverPath: LLAMA_SERVER },
  models: { rootDir: path.join(WORK, 'models') },
  web: { enabled: true },
  api: { port: 9322 },
  diagnostics: { level: 'debug', dir: path.join(WORK, 'logs') }
};
fs.writeFileSync(path.join(WORK, 'config.json'), JSON.stringify(config));
process.env.LITEMIND_CONFIG = path.join(WORK, 'config.json');

const { startLiteMindEngine } = await import('../src/index.js');
const handle = await startLiteMindEngine({ port: 9322, console: false });
const BASE = `http://127.0.0.1:${handle.config.api.port}`;
console.log('engine up:', BASE, '| work:', WORK);

try {
  // 1. Погода через API сервера (как в E2E)
  const wres = await fetch(`${BASE}/api/web/weather`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ place: 'Иркутск' })
  });
  const wx = await wres.json();
  console.log('WEATHER status=', wres.status, '→', JSON.stringify(wx).slice(0, 400));

  // 2. Чат с web_globe=true (как в E2E, шаг 3)
  const cres = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'Qwen2.5-0.5B-Instruct-Q4_K_M', messages: [{ role: 'user', content: 'Какая сейчас погода в Иркутске? Назови температуру и источник данных.' }], stream: false, web_globe: true, intelligence_mode: 'smart' })
  });
  const cd = await cres.json();
  console.log('GLOBE CHAT status=', cres.status, '→', JSON.stringify(cd.litemind?.intelligence ?? cd.error ?? cd).slice(0, 500));
  console.log('GLOBE TEXT:', String(cd.choices?.[0]?.message?.content ?? '(пусто)').slice(0, 300));

  // 3. Тёплый чат (как в E2E, шаг 2)
  const warm = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'Qwen2.5-0.5B-Instruct-Q4_K_M', messages: [{ role: 'user', content: 'Ответь одним словом: два плюс два?' }], stream: false, web_globe: false, intelligence_mode: 'smart' })
  });
  const wd = await warm.json();
  console.log('WARM status=', warm.status, '→ text:', String(wd.choices?.[0]?.message?.content ?? '(пусто)').slice(0, 120));
  console.log('WARM timings:', JSON.stringify(wd.litemind?.timings ?? wd.error ?? null));

  console.log('ENGINE LOG (последние строки):');
  const logFile = path.join(WORK, 'logs', fs.readdirSync(path.join(WORK, 'logs')).at(-1));
  console.log(fs.readFileSync(logFile, 'utf8').split('\n').slice(-14).join('\n'));
} catch (e) {
  console.error('PROBE FAIL:', e.message);
  process.exitCode = 1;
} finally {
  await handle.stop().catch(() => {});
  try { fs.rmSync(WORK, { recursive: true, force: true }); } catch { /* занятое — не критично */ }
}
