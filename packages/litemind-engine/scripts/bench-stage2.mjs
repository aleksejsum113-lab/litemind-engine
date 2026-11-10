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
// Короткий безопасный режим (минимум нагрузки, для запуска пользователем):
//   node scripts/bench-stage2.mjs --quick --port 8397 --out /tmp/bench-quick.json
//
// Никаких моков: реальный llama-server, реальный GGUF, реальный стрим.
// Дополнительно (Этап 2 §4/§13): выборочный замер RAM процессов
// (llama-server + движок) и загрузки CPU по фазам (холодный/тёплые/длинный).

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
// Короткий режим: 1 тёплый прогон, короткие ответы — нужен, чтобы пользователь
// мог безопасно проверить производительность без длительной нагрузки на своей машине.
const QUICK = process.argv.includes('--quick');
const WARM_RUNS_EFF = QUICK ? 1 : WARM_RUNS;
const LONG_TOKENS_EFF = QUICK ? Math.min(LONG_TOKENS, 64) : LONG_TOKENS;
const COLD_TOKENS = QUICK ? 16 : 24;
const WARM_TOKENS = QUICK ? 32 : 48;

import { spawn, execFile } from 'node:child_process';
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

// ── Наблюдение за процессами: RAM (RSS) llama-server и движка + загрузка CPU ──
const mem = { serverPeakMb: 0, enginePeakMb: 0, phases: {} };
let currentPhase = 'startup';
let serverPid = null;
let cpuPrev = os.cpus();
let cpuAccum = { busy: 0, total: 0, n: 0 };

function setPhase(name) {
  currentPhase = name;
  cpuAccum = { busy: 0, total: 0, n: 0 };
}

function findServerPid() {
  if (process.platform === 'win32') {
    return new Promise((resolve) => {
      execFile('tasklist', ['/fi', 'IMAGENAME eq llama-server.exe', '/fo', 'CSV', '/nh'],
        { windowsHide: true }, (err, out) => {
          if (err) return resolve(null);
          const m = String(out).match(/"llama-server\.exe","(\d+)"/i);
          resolve(m ? Number(m[1]) : null);
        });
    });
  }
  try {
    for (const d of fs.readdirSync('/proc')) {
      if (!/^\d+$/.test(d)) continue;
      let cmd = '';
      try { cmd = fs.readFileSync(`/proc/${d}/cmdline`, 'utf8'); } catch { continue; }
      if (cmd.includes('llama-server')) return Promise.resolve(Number(d));
    }
  } catch { /* не linux */ }
  return Promise.resolve(null);
}

async function rssMb(pid) {
  if (!pid) return null;
  if (process.platform !== 'win32') {
    try {
      const st = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
      const m = st.match(/VmRSS:\s+(\d+)\s+kB/);
      return m ? Math.round(Number(m[1]) / 1024) : null;
    } catch { return null; }
  }
  return new Promise((resolve) => {
    execFile('tasklist', ['/fi', `PID eq ${pid}`, '/fo', 'CSV', '/nh'],
      { windowsHide: true }, (err, out) => {
        if (err) return resolve(null);
        const m = String(out).match(/"([^\"]*K)"\s*\r?\n?$/);
        resolve(m ? Math.round(Number(String(m[1]).replace(/\D/g, '')) / 1024) || null : null);
      });
  });
}

function cpuTick() {
  const now = os.cpus();
  for (let i = 0; i < now.length && i < cpuPrev.length; i++) {
    const a = cpuPrev[i].times, b = now[i].times;
    const t = b.user + b.nice + b.sys + b.idle + b.irq;
    const at = a.user + a.nice + a.sys + a.idle + a.irq;
    cpuAccum.total += t - at;
    cpuAccum.busy += t - at - (b.idle - a.idle);
  }
  cpuAccum.n++;
  cpuPrev = now;
}

const sampler = setInterval(() => {
  (async () => {
    try {
      if (!serverPid) serverPid = await findServerPid();
      const s = await rssMb(serverPid);
      const e = await rssMb(child.pid);
      if (s != null) mem.serverPeakMb = Math.max(mem.serverPeakMb, s);
      if (e != null) mem.enginePeakMb = Math.max(mem.enginePeakMb, e);
      cpuTick();
      const ph = (mem.phases[currentPhase] = mem.phases[currentPhase] || { serverMb: null, engineMb: null, cpuBusyPct: null, cpuSamples: 0 });
      if (s != null) ph.serverMb = s;
      if (e != null) ph.engineMb = e;
      if (cpuAccum.total > 0) {
        ph.cpuBusyPct = Math.round((cpuAccum.busy / cpuAccum.total) * 100);
        ph.cpuSamples = cpuAccum.n;
      }
    } catch { /* наблюдение не должно ронять бенчмарк */ }
  })();
}, 1500);

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
  setPhase('cold');
  log('холодный запрос (spawn llama-server + загрузка модели)');
  const cold = await runOnce({ maxTokens: COLD_TOKENS });
  results.cold = cold;

  // 2. ТЁПЛЫЕ запросы: модель уже в RAM.
  setPhase('warm');
  for (let i = 0; i < WARM_RUNS_EFF; i++) {
    log(`тёплый запрос ${i + 1}/${WARM_RUNS_EFF}`);
    await runOnce({ maxTokens: WARM_TOKENS });
  }

  // 3. ДЛИННАЯ генерация: проверка регрессии «обрыв на 60-й секунде».
  setPhase('long');
  log(`длинная генерация (${LONG_TOKENS_EFF} ток) — регрессия 60-секундного обрыва`);
  const long = await runOnce({ maxTokens: LONG_TOKENS_EFF, prompt: 'Напиши связный рассказ из десяти предложений о путешествии вдоль берега.' });
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
  results.quickMode = QUICK;
  results.ram = mem;
} finally {
  clearInterval(sampler);
  await stopEngine();
  child.kill('SIGKILL');
}

results.finishedAt = new Date().toISOString();
results.host = { cpus: os.cpus().length, model: os.cpus()[0]?.model, totalRamMb: Math.round(os.totalmem() / 1048576), platform: process.platform };
fs.writeFileSync(OUT, JSON.stringify(results, null, 2));
log(`результаты: ${OUT}`);
