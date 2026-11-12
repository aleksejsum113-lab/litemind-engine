#!/usr/bin/env node
// Этап 2 §14 — smoke-тест УСТАНОВЛЕННОГО приложения LiteMind (Windows).
//
// Приложение поднимает движок в своём процессе на 127.0.0.1:8399
// (packages/desktop/src/main/service/litemind-host.ts). Скрипт опрашивает
// этот API и проверяет путь пользователя: движок внутри установленного GUI
// нашёл комплектный runtime (resources\llamacpp\llama-server.exe), сгенерировал
// непустой ответ при max_tokens=16 и корректно завершил llama-server.
//
// Не требует прав администратора; пользовательские данные не затрагивает
// (выполняется на CI-раннере или с явного разрешения пользователя).
//
// Использование:
//   node scripts/smoke-stage2-gui.mjs [--url http://127.0.0.1:8399] \
//        [--model Qwen3-0.6B-Q8_0] [--out файл.json]

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (!a.startsWith('--')) continue;
  const k = a.slice(2);
  const v = process.argv[i + 1];
  if (v !== undefined && !v.startsWith('--')) { args[k] = v; i++; } else args[k] = true;
}

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';

const BASE = args.url ?? 'http://127.0.0.1:8399';
const MODEL_ID = args.model ?? 'Qwen3-0.6B-Q8_0';
const OUT = args.out ?? path.join(os.tmpdir(), 'smoke-stage2-gui.json');

const checks = [];
function check(name, ok, details = '') {
  checks.push({ name, ok: Boolean(ok), details: String(details).slice(0, 400) });
  console.log(`  [${ok ? 'ПАСС' : 'ПРОВАЛ'}] ${name}${details ? ` — ${details}` : ''}`);
  return Boolean(ok);
}
function log(msg) { console.log(`[gui-smoke] ${msg}`); }

function execFileP(cmd, cmdArgs) {
  return new Promise((resolve) => {
    execFile(cmd, cmdArgs, { windowsHide: true, timeout: 10000 }, (err, stdout) => {
      resolve(String(stdout || ''));
    });
  });
}

async function serverProcessCount() {
  if (process.platform === 'win32') {
    const out = await execFileP('tasklist', ['/fi', 'IMAGENAME eq llama-server.exe', '/fo', 'CSV', '/nh']);
    return (out.match(/llama-server\.exe/gi) || []).length;
  }
  return -1; // вне Windows проверка процессов не выполняется
}

async function pollEngine(timeoutMs = 120000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(1500) });
      return r.status; // 200/503 — движок в приложении отвечает
    } catch { /* ещё не поднялся */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return null;
}

const results = { startedAt: new Date().toISOString(), url: BASE, model: MODEL_ID, checks };
let failed = false;
try {
  const status = await pollEngine();
  if (!check('движок внутри приложения отвечает (HTTP /health)', status !== null, `HTTP ${status ?? 'нет ответа за 120 с'}`)) {
    throw new Error('app engine unreachable');
  }

  const st = await fetch(`${BASE}/api/status`).then((r) => r.json());
  results.status = {
    engine: st?.engine, profile: st?.engine?.profile, backendType: st?.backend?.type,
    health: st?.backend?.health, runtimeBinary: st?.runtime?.binary
  };
  check('backend.type = lmlama внутри установленного приложения', st?.backend?.type === 'lmlama', `type=${st?.backend?.type}`);
  check('комплектный runtime обнаружен (llama-server --version ok)', st?.backend?.health?.ok === true, st?.backend?.health?.version ?? st?.backend?.health?.error ?? '');
  const bin = st?.runtime?.binary ?? '';
  check('runtime лежит в <установка>\\resources\\llamacpp', /llamacpp.+llama-server(\.exe)?$/.test(bin), bin || 'null');

  // Генерация через ДВИЖОК ПРИЛОЖЕНИЯ (SSE, max_tokens=16, /no_think)
  const t0 = Date.now();
  let contentChars = 0, chunks = 0, ttftMs = null, doneSeen = false, error = null, text = '';
  const r = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: MODEL_ID, stream: true, max_tokens: 16,
      messages: [{ role: 'user', content: 'Ответь одним коротким предложением. Какого цвета небо? /no_think' }]
    })
  });
  if (!r.ok) {
    error = `HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`;
  } else {
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    stream: for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') { doneSeen = true; break stream; }
        let obj;
        try { obj = JSON.parse(payload); } catch { continue; }
        if (obj.error) { error = obj.error.message; break stream; }
        const delta = obj.choices?.[0]?.delta?.content;
        if (delta) {
          if (ttftMs === null) ttftMs = Date.now() - t0;
          contentChars += delta.length;
          chunks++;
          text += delta;
        }
      }
    }
  }
  results.chat = { contentChars, chunks, ttftMs, doneSeen, error, text: text.slice(0, 200) };
  check('генерация через приложение: SSE-чанки и [DONE]', chunks > 0 && doneSeen && !error, `чанков=${chunks}, ошибка=${error ?? 'нет'}`);
  check('max_tokens=16 → непустой ответ в приложении', contentChars > 0, `символов=${contentChars}, ttft=${ttftMs} мс`);

  // Фактические параметры runtime (диагностика Этапа 2 §12)
  const perf = await fetch(`${BASE}/api/perf`).then((x) => x.json()).catch(() => null);
  results.perf = { params: perf?.runtime?.params ?? null, loadMs: perf?.runtime?.loadMs ?? null, restarts: perf?.runtime?.restarts ?? null };
  if (perf?.runtime?.params) {
    log(`применённые параметры: ${JSON.stringify(perf.runtime.params)}`);
  }

  // Остановка модели из API приложения: llama-server должен исчезнуть
  const stop = await fetch(`${BASE}/api/models/stop`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: MODEL_ID }) }).then((x) => x.json()).catch((e) => ({ error: e.message }));
  await new Promise((r) => setTimeout(r, 2500));
  const alive = await serverProcessCount();
  results.stopModel = { stop, llamaServerProcessesLeft: alive };
  if (process.platform === 'win32') {
    check('остановка модели: llama-server завершён (0 процессов)', stop?.verified === true && alive === 0, `verified=${stop?.verified}, осталось=${alive}, RAM освобождено=${stop?.ram?.freedMb ?? '?'} МБ`);
  }
} catch (err) {
  failed = true;
  check('gui smoke выполнен без исключений', false, err.message);
} finally {
  results.finishedAt = new Date().toISOString();
  fs.writeFileSync(OUT, JSON.stringify(results, null, 2));
  log(`результат: ${OUT}`);
  const passed = checks.filter((c) => c.ok).length;
  console.log(`\n[gui-smoke] ИТОГ: ${passed}/${checks.length} проверок пройдено`);
  if (failed || passed !== checks.length) process.exit(1);
}
