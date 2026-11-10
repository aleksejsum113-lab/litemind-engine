#!/usr/bin/env node
// Этап 2 §13 — честный бенчмарк «до/после» на реальном llama-server.
//
// Запускает указанный движок (старый из git-worktree или новый) как процесс
// `bin/litemind.js serve` с заданным бинарником llama-server и меряет ТОЛЬКО
// то, что реально видит пользователь через HTTP API:
//   - время до первого чанка стрима (TTFT по-пользовательски, вкл. холодный старт);
//   - время полной генерации и tokens/sec;
//   - обрывы по таймауту (старый движок обрывал генерации длиннее 60 с);
//   - замеры движка из litemind.timings (новый движок: загрузка/стадии).
//
// Использование:
//   node scripts/bench-stage2.mjs --engine /tmp/litemind-before --port 8397 \
//        --server /tmp/llamacpp-build-A/bin/llama-server --model Qwen3-0.6B-Q8_0 \
//        --label "до (движок 1В + baseline-сборка)" --out /tmp/bench-old-A.json
//
// Никаких моков: реальный llama-server, реальный GGUF, реальный стрим.

const args = {};
for (let i = 2; i < process.argv.length; i += 2) {
  const k = process.argv[i]?.replace(/^--/, '');
  args[k] = process.argv[i + 1];
}

const ENGINE_DIR = args.engine ?? '/home/z/my-project/work/repo/packages/litemind-engine';
const PORT = Number(args.port ?? 8397);
const SERVER = args.server ?? '/tmp/llamacpp-build-A/bin/llama-server';
const MODEL = args.model ?? 'Qwen3-0.6B-Q8_0';
const LABEL = args.label ?? `engine=${path.basename(ENGINE_DIR)} server=${path.basename(path.dirname(path.dirname(SERVER)))}`;
const OUT = args.out ?? `/tmp/bench-${Date.now()}.json`;
const WARM_RUNS = Number(args.warm ?? 3);
const LONG_TOKENS = Number(args.long ?? 160);

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const BASE = `http://127.0.0.1:${PORT}`;
const results = { label: LABEL, engine: ENGINE_DIR, server: SERVER, model: MODEL, startedAt: new Date().toISOString(), runs: [] };

function log(msg) { console.log(`[bench] ${msg}`); }

const configPath = `/tmp/litemind-bench-${PORT}.json`;
fs.mkdirSync(path.dirname(configPath), { recursive: true });
// ОДИН и тот же профиль для всех прогонов: balanced (значения берутся из
// DEFAULT_PROFILES соответствующего движка — старый не знает новых полей,
// это и есть честное «до»).
fs.writeFileSync(configPath, JSON.stringify({
  api: { port: PORT },
  models: { rootDir: '/tmp/litemind-test-models' },
  backend: { serverPath: SERVER, useMmap: true },
  profile: 'balanced'
}, null, 2));
results.config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

async function waitForHealth(timeoutMs = 60000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(1500) });
      if (r.ok || r.status === 503) return true;
    } catch { /* ещё не поднялся */ }
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

async function stopEngine() {
  try { await fetch(`${BASE}/api/engine/stop`, { method: 'POST', body: '{}' }); } catch { /* уже мёртв */ }
}

/** Один прогон: стрим-запрос; возвращает замеры на клиенте + honest timings движка. */
async function runOnce({ maxTokens = 64, prompt = 'Напиши короткий рассказ (3-4 предложения) о море.' } = {}) {
  const t0 = Date.now();
  let firstChunkMs = null;
  let lastChunkMs = null;
  let tokens = 0;
  let text = '';
  let engineTimings = null;
  let error = null;
  try {
    const res = await fetch(`${BASE}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: MODEL,
        stream: true,
        max_tokens: maxTokens,
        messages: [{ role: 'user', content: prompt }]
      })
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    stream: for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) !== -1) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        for (const line of block.split('\n')) {
          if (!line.startsWith('data: ')) continue;
          const payload = line.slice(6);
          if (payload === '[DONE]') break stream;
          let obj;
          try { obj = JSON.parse(payload); } catch { continue; }
          if (obj.error) throw new Error(obj.error.message);
          if (obj.litemind?.timings) engineTimings = obj.litemind.timings;
          const delta = obj.choices?.[0]?.delta?.content;
          if (delta) {
            if (firstChunkMs === null) firstChunkMs = Date.now() - t0;
            tokens++;
            text += delta;
            lastChunkMs = Date.now() - t0;
          }
        }
      }
    }
  } catch (err) {
    error = err.message;
  }
  const run = {
    maxTokens,
    firstChunkMs,
    lastChunkMs,
    tokens,
    tokensPerSec: lastChunkMs && tokens > 1 ? Math.round((tokens / ((lastChunkMs - firstChunkMs) / 1000)) * 10) / 10 : null,
    error,
    abortedAt60s: error && /timeout|abort/i.test(error) ? error : null,
    engineTimings
  };
  results.runs.push(run);
  log(`${maxTokens} ток: первый чанк ${firstChunkMs ?? '—'} мс, последний ${lastChunkMs ?? '—'} мс, токенов ${tokens}, т/с ${run.tokensPerSec ?? '—'}${error ? ` ОШИБКА: ${error}` : ''}`);
  return run;
}

// ── Запуск ────────────────────────────────────────────────────────────────────
const bin = path.join(ENGINE_DIR, 'bin', 'litemind.js');
if (!fs.existsSync(bin)) {
  console.error(`Не найден ${bin}`);
  process.exit(1);
}
log(`движок: ${ENGINE_DIR} (порт ${PORT})`);
log(`llama-server: ${SERVER}`);
const child = spawn(process.execPath, [bin, 'serve'], {
  env: { ...process.env, LITEMIND_CONFIG: configPath, LITEMIND_LLAMA_SERVER: SERVER },
  stdio: ['ignore', 'pipe', 'pipe']
});
const engineLog = [];
child.stdout.on('data', (d) => engineLog.push(String(d)));
child.stderr.on('data', (d) => engineLog.push(String(d)));
child.on('exit', (code) => log(`движок завершился: код ${code}`));

const up = await waitForHealth();
if (!up) {
  log('движок не поднялся');
  console.error(engineLog.slice(-40).join(''));
  process.exit(1);
}

try {
  // 1. ХОЛОДНЫЙ запрос: llama-server не запущен, модель не в RAM.
  //    Примечание честности: файловый кэш ОС не сбрасываем (нужен root) —
  //    «холодный» здесь означает «процесс runtime не запущен».
  log('холодный запрос (spawn llama-server + загрузка модели)');
  const cold = await runOnce({ maxTokens: 24 });
  results.cold = cold;

  // 2. ТЁПЛЫЕ запросы: модель уже в RAM.
  for (let i = 0; i < WARM_RUNS; i++) {
    log(`тёплый запрос ${i + 1}/${WARM_RUNS}`);
    await runOnce({ maxTokens: 48 });
  }

  // 3. ДЛИННАЯ генерация: проверка регрессии «обрыв на 60-й секунде».
  log(`длинная генерация (${LONG_TOKENS} ток) — регрессия 60-секундного обрыва`);
  const long = await runOnce({ maxTokens: LONG_TOKENS, prompt: 'Напиши связный рассказ из десяти предложений о путешествии вдоль берега.' });
  results.long = long;

  // 4. Метрики движка (новый движок): стадии, серверные тайминги, runtime.
  try {
    const perf = await fetch(`${BASE}/api/perf`).then((r) => r.json());
    results.perf = {
      summary: perf.summary,
      stages: perf.stages,
      runtime: perf.runtime ? { params: perf.runtime.params, loadMs: perf.runtime.loadMs, restarts: perf.runtime.restarts, gpu: perf.runtime.gpu } : null
    };
  } catch { results.perf = null; }
} finally {
  await stopEngine();
  child.kill('SIGKILL');
}

results.finishedAt = new Date().toISOString();
results.host = { cpus: os.cpus().length, model: os.cpus()[0]?.model, totalRamMb: Math.round(os.totalmem() / 1048576), platform: process.platform };
fs.writeFileSync(OUT, JSON.stringify(results, null, 2));
log(`результаты: ${OUT}`);
