#!/usr/bin/env node
// Зонд агента: сессия «погода в Иркутске» → все сообщения сессии (диагностика
// заземления финального ответа). Запуск: node scripts/probe-agent.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const LLAMA_SERVER = '/home/z/work/e2e/build/bin/llama-server';
const MODEL_FILE = '/home/z/work/e2e/qwen25-05b-q4km.gguf';
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'litemind-agent-'));
fs.mkdirSync(path.join(WORK, 'models'), { recursive: true });
fs.copyFileSync(MODEL_FILE, path.join(WORK, 'models', 'Qwen2.5-0.5B-Instruct-Q4_K_M.gguf'));
const config = {
  backend: { type: 'lmlama', serverPath: LLAMA_SERVER },
  models: { rootDir: path.join(WORK, 'models') },
  web: { enabled: true },
  api: { port: 9323 },
  diagnostics: { level: 'error', dir: path.join(WORK, 'logs') },
  profile: 'high',
  profiles: { high: { contextTokens: 4096, memoryReserveMb: 512, kvOverheadKbPerToken: 24 } },
  resource: { maxRamUsageFraction: 0.95 }
};
fs.writeFileSync(path.join(WORK, 'config.json'), JSON.stringify(config));
process.env.LITEMIND_CONFIG = path.join(WORK, 'config.json');

const { startLiteMindEngine } = await import('../src/index.js');
const handle = await startLiteMindEngine({ port: 9323, console: false });
const BASE = `http://127.0.0.1:${handle.config.api.port}`;
console.log('engine up:', BASE);

try {
  const s0 = await (await fetch(`${BASE}/api/agent/sessions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'probe погода', firstMessage: 'Какая сейчас погода в Иркутске? Назови температуру и источник.' }) })).json();
  const sid = s0?.id;
  let view = null;
  const t0 = Date.now();
  let seenWork = false;
  while (Date.now() - t0 < 260000) {
    view = await (await fetch(`${BASE}/api/agent/sessions/${sid}`)).json();
    if (view?.state === 'running') seenWork = true;
    if (view?.state !== 'running' && (seenWork || (view?.messages ?? []).length > 1)) break;
    await new Promise((r) => setTimeout(r, 2000));
  }
  console.log('state:', view?.state, 'steps:', view?.stats?.steps);
  for (const m of view?.messages ?? []) {
    const body = String(m.text ?? m.result ?? '').replace(/\s+/g, ' ').slice(0, 220);
    console.log(`[${m.role}${m.tool ? ':' + m.tool : ''}${m.type ? ':' + m.type : ''}${m.ok === false ? ' !ok' : ''}]`, body);
    if (m.role === 'tool' && m.result) console.log('   result:', String(m.result).replace(/\s+/g, ' ').slice(0, 220));
  }
} catch (e) {
  console.error('PROBE FAIL:', e.message);
  process.exitCode = 1;
} finally {
  await handle.stop().catch(() => {});
  try { fs.rmSync(WORK, { recursive: true, force: true }); } catch { /* */ }
}
