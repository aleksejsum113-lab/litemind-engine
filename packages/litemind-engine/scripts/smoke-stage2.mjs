#!/usr/bin/env node
// Этап 2 §14 — smoke-тест связки «движок + llama-server + GGUF» на реальной ОС.
//
// Проверяет РЕАЛЬНЫЙ путь пользователя (без моков):
//   движок (bin/litemind.js serve) + llama-server (установленный или указанный)
//   + GGUF-модель → /health → /v1/chat/completions (SSE, max_tokens=16,
//   регрессия «пустой ответ») → профили (Бережный / Сбалансированный /
//   Производительный реально меняют параметры llama-server) → остановка модели
//   (дерево процессов llama-server гарантированно убито) → остановка движка.
//
// Безопасность: временный конфиг только в os.tmpdir(), порт 8397 (не 8399
// основной установки), пользовательские настройки/модели/история не читаются
// и не изменяются.
//
// Использование:
//   node scripts/smoke-stage2.mjs --model <путь/к/модели.gguf> \
//        [--server <путь/к/llama-server(.exe)>] [--engine <папка движка>] \
//        [--port 8397] [--out <файл-результата.json>]

const argv = process.argv;
const args = {};
for (let i = 2; i < argv.length; i++) {
  const a = argv[i];
  if (!a.startsWith('--')) continue;
  const k = a.slice(2);
  const v = argv[i + 1];
  if (v !== undefined && !v.startsWith('--')) { args[k] = v; i++; } else args[k] = true;
}

import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENGINE_DIR = path.resolve(args.engine ?? path.join(HERE, '..'));
const PORT = Number(args.port ?? 8397);
const OUT = args.out ?? path.join(os.tmpdir(), `smoke-stage2-${Date.now()}.json`);
const MODEL = args.model ?? null;
const SERVER = args.server ?? null;

// Ожидаемые параметры профилей считаем тем же кодом, что и движок.
// Модули движка — ESM: подключаем динамическим import (require() на ESM
// падает с ERR_REQUIRE_ESM в Node 20 — например, на CI).
const { resolveRuntimeParams } = await import(
  pathToFileURL(path.join(ENGINE_DIR, 'src', 'resource', 'threads.js')).href
);
const { DEFAULT_PROFILES } = await import(
  pathToFileURL(path.join(ENGINE_DIR, 'src', 'config.js')).href
);

const BASE = `http://127.0.0.1:${PORT}`;
const checks = [];
function check(name, ok, details = '') {
  checks.push({ name, ok: Boolean(ok), details: String(details).slice(0, 400) });
  console.log(`  [${ok ? 'ПАСС' : 'ПРОВАЛ'}] ${name}${details ? ` — ${details}` : ''}`);
  return Boolean(ok);
}
function log(msg) { console.log(`[smoke] ${msg}`); }

function execFileP(cmd, cmdArgs) {
  return new Promise((resolve) => {
    execFile(cmd, cmdArgs, { windowsHide: true, timeout: 10000 }, (err, stdout, stderr) => {
      resolve({ err, out: String(stdout || '') + String(stderr || '') });
    });
  });
}

/** Число живых процессов llama-server (0 = дерево процессов корректно завершено). */
async function serverProcessCount() {
  if (process.platform === 'win32') {
    const { out } = await execFileP('tasklist', ['/fi', 'IMAGENAME eq llama-server.exe', '/fo', 'CSV', '/nh']);
    return (out.match(/llama-server\.exe/gi) || []).length;
  }
  try {
    let n = 0;
    for (const d of fs.readdirSync('/proc')) {
      if (!/^\d+$/.test(d)) continue;
      let cmd = '';
      try { cmd = fs.readFileSync(`/proc/${d}/cmdline`, 'utf8'); } catch { continue; }
      if (cmd.includes('llama-server')) n++;
    }
    return n;
  } catch { return -1; }
}

/** Фактические командные строки работающих llama-server.exe (Win32_Process). */
async function llamaServerCommandLines() {
  if (process.platform !== 'win32') return [];
  const { out } = await execFileP('powershell.exe', ['-NoProfile', '-Command',
    "Get-CimInstance Win32_Process -Filter \"Name='llama-server.exe'\" | ForEach-Object { $_.CommandLine }"]);
  return out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

/** Имена загруженных модулей (DLL) работающего llama-server.exe. */
async function llamaServerModules() {
  if (process.platform !== 'win32') return [];
  const { out } = await execFileP('powershell.exe', ['-NoProfile', '-Command',
    "(Get-Process llama-server -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Modules | ForEach-Object { $_.ModuleName }) -join ';'"]);
  return out.split(';').map((l) => l.trim()).filter(Boolean);
}

async function waitHealth(timeoutMs = 90000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(1500) });
      return true; // любой ответ = сервер движка жив (503 = backend ещё не готов)
    } catch { /* ещё не поднялся */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

/** Один стрим-запрос к движку; возвращает честные счётчики по SSE. */
async function chatOnce({ maxTokens = 16, prompt = 'Ответь одним коротким предложением. Какого цвета небо? /no_think' } = {}) {
  const t0 = Date.now();
  const res = {
    httpStatus: null, contentChars: 0, reasoningChars: 0, chunks: 0,
    ttftMs: null, doneSeen: false, finishReason: null, usage: null, error: null, text: ''
  };
  try {
    const r = await fetch(`${BASE}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: MODEL_ID,
        stream: true,
        max_tokens: maxTokens,
        messages: [{ role: 'user', content: prompt }]
      })
    });
    res.httpStatus = r.status;
    if (!r.ok) { res.error = `HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`; return res; }
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
        if (payload === '[DONE]') { res.doneSeen = true; break stream; }
        let obj;
        try { obj = JSON.parse(payload); } catch { continue; }
        if (obj.error) { res.error = obj.error.message; return res; }
        const delta = obj.choices?.[0]?.delta;
        if (delta?.content) {
          if (res.ttftMs === null) res.ttftMs = Date.now() - t0;
          res.contentChars += delta.content.length;
          res.chunks++;
          res.text += delta.content;
        }
        if (delta?.reasoning_content) res.reasoningChars += delta.reasoning_content.length;
        const fr = obj.choices?.[0]?.finish_reason;
        if (fr) res.finishReason = fr;
        if (obj.usage) res.usage = obj.usage;
      }
    }
  } catch (err) {
    res.error = err.message;
  }
  return res;
}

// ── Подготовка ───────────────────────────────────────────────────────────────
if (!MODEL || !fs.existsSync(MODEL)) {
  console.error(`Модель не найдена: ${MODEL ?? '(не указана)'} — укажите --model <путь.gguf>`);
  process.exit(1);
}
const MODEL_ID = path.basename(MODEL).replace(/\.gguf$/i, '');
const modelStat = fs.statSync(MODEL);
const expectedBase = {
  file: path.resolve(MODEL),
  fileSizeBytes: modelStat.size,
  totalRamBytes: os.totalmem(),
  cores: os.cpus().length
};

const configPath = path.join(os.tmpdir(), `litemind-smoke-${PORT}.json`);
fs.writeFileSync(configPath, JSON.stringify({
  api: { port: PORT },
  models: { rootDir: path.dirname(path.resolve(MODEL)) },
  backend: { type: 'lmlama', serverPath: SERVER },
  profile: 'balanced'
}, null, 2));

const bin = path.join(ENGINE_DIR, 'bin', 'litemind.js');
if (!fs.existsSync(bin)) { console.error(`Не найден ${bin}`); process.exit(1); }
log(`движок: ${ENGINE_DIR} (порт ${PORT})`);
log(`llama-server: ${SERVER ?? '(автопоиск движка)'}`);
log(`модель: ${MODEL_ID} (${Math.round(modelStat.size / 1048576)} MB), ядер: ${expectedBase.cores}`);

const engineLog = [];
const child = spawn(process.execPath, [bin, 'serve'], {
  env: { ...process.env, LITEMIND_CONFIG: configPath, ...(SERVER ? { LITEMIND_LLAMA_SERVER: SERVER } : {}) },
  stdio: ['ignore', 'pipe', 'pipe']
});
child.stdout.on('data', (d) => engineLog.push(String(d)));
child.stderr.on('data', (d) => engineLog.push(String(d)));
const engineTail = () => engineLog.join('').split(/\r?\n/).filter(Boolean).slice(-12).join('\n');

const results = { startedAt: new Date().toISOString(), platform: process.platform, port: PORT, model: MODEL_ID, checks };
let status = null;
let failed = false;

try {
  // 1. Движок поднялся
  const up = await waitHealth();
  if (!check('движок запустился (HTTP /health отвечает)', up, engineTail())) throw new Error('engine down');

  // 2. Статус: backend lmlama, runtime найден, версия llama-server определена
  status = await fetch(`${BASE}/api/status`).then((r) => r.json());
  check('backend.type = lmlama (собственный runtime, без Ollama)', status?.backend?.type === 'lmlama', `type=${status?.backend?.type}`);
  check('llama-server обнаружен движком (backend health ok)', status?.backend?.health?.ok === true, status?.backend?.health?.version ?? status?.backend?.health?.error ?? '');
  const rtBinary = status?.runtime?.binary ?? null;
  check('runtime по ожидаемому пути (binary существует)', Boolean(rtBinary) && fs.existsSync(rtBinary), rtBinary ?? 'null');

  // 3. Регрессия «пустой ответ»: max_tokens=16 → непустой контент (SSE)
  const cold = await chatOnce({ maxTokens: 16 });
  results.cold = cold;
  check('SSE-стрим: получены чанки и [DONE]', cold.chunks > 0 && cold.doneSeen && !cold.error, `чанков=${cold.chunks}, done=${cold.doneSeen}, finish=${cold.finishReason}, ошибка=${cold.error ?? 'нет'}`);
  check('max_tokens=16 → непустой ответ (регрессия «пустой ответ» устранена)', cold.contentChars > 0, `символов=${cold.contentChars}, ttft=${cold.ttftMs} мс, usage=${JSON.stringify(cold.usage)}`);
  // Явный лимит клиента — жёсткий потолок: движок не вправе его увеличивать.
  const cTok = cold.usage?.completion_tokens;
  check('max_tokens=16 — жёсткий потолок (генерация не превысила лимит)',
    cTok == null || (cTok > 0 && cTok <= 16),
    cTok == null ? 'usage не пришёл — проверка нейтральна' : `completion_tokens=${cTok} из 16`);

  // 3б. Какой CPU-вариант ggml реально загружен (GGML_BACKEND_DL): механика
  // выбора совместимого бэкенда по CPUID. На CI-процессоре с AVX2 это
  // haswell/alderlake-класс; на N5095A (без AVX) ожидается sse42 — финальное
  // подтверждение на целевом ПК.
  const mods = await llamaServerModules();
  const cpuVariants = mods.filter((m) => /^ggml-cpu/i.test(m));
  results.cpuVariantModules = mods.filter((m) => /^ggml/i.test(m));
  check('runtime загрузил CPU-бэкенд ggml-cpu-*.dll (динамический выбор)', cpuVariants.length > 0,
    `ggml-модули: ${results.cpuVariantModules.join(', ') || 'не найдены'}`);

  // 4. Диагностика reasoning (без /no_think): честно показать разделение <think>
  const think = await chatOnce({ maxTokens: 16, prompt: 'Какого цвета небо?' });
  results.reasoningProbe = think;
  log(`reasoning-проба: content=${think.contentChars} симв., reasoning=${think.reasoningChars} симв., finish=${think.finishReason}`);

  // 5. Профили реально применяют параметры (ТЗ §8): каждая смена профиля →
  //    честный перезапуск llama-server с НОВЫМИ аргументами. Ожидания считаем
  //    тем же кодом, что и движок: движок подставляет в resolveRuntimeParams
  //    значения из DEFAULT_PROFILES (contextTokens/cpuThreads/numBatch/cacheReuse),
  //    threadsBatch не передаёт (авто по профилю), useMmap — из backend-конфига.
  const profileExpect = { low: {}, balanced: {}, high: {} };
  for (const name of ['low', 'balanced', 'high']) {
    const prof = DEFAULT_PROFILES[name] ?? {};
    const exp = resolveRuntimeParams({
      profile: name, ...expectedBase,
      contextTokens: prof.contextTokens ?? 0,
      cpuThreads: prof.cpuThreads ?? 0,
      cpuThreadsBatch: 0,
      numBatch: prof.numBatch ?? 0,
      useMmap: 'auto', cacheReuse: prof.cacheReuse ?? 0
    });
    profileExpect[name] = exp;
    const sw = await fetch(`${BASE}/api/profile`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ profile: name }) });
    check(`профиль «${name}» принят API`, sw.ok, `HTTP ${sw.status}`);

    const run = await chatOnce({ maxTokens: 16 });
    const st = await fetch(`${BASE}/api/status`).then((r) => r.json());
    const p = st?.runtime?.params ?? null;
    const fields = ['contextTokens', 'threads', 'threadsBatch', 'batchSize', 'ubatchSize', 'useMmap', 'cacheReuse'];
    const diff = p ? fields.filter((f) => p[f] !== exp[f]).map((f) => `${f}: факт ${p[f]} ≠ ожидание ${exp[f]}`) : ['runtime.params отсутствует'];
    check(`профиль «${name}» применён к llama-server (параметры = ожидаемым)`, run.contentChars > 0 && diff.length === 0,
      `потоки=${p?.threads}, threadsBatch=${p?.threadsBatch}, batch=${p?.batchSize}/${p?.ubatchSize}, ctx=${p?.contextTokens}, mmap=${p?.useMmap}, cacheReuse=${p?.cacheReuse}${diff.length ? `; РАСХОЖДЕНИЕ: ${diff.join('; ')}` : ''}`);

    // Фактическая командная строка работающего llama-server.exe: главный
    // аргументы должны совпасть с ожиданием профиля (не только внутренний отчёт движка).
    const cl = (await llamaServerCommandLines()).find((c) => /llama-server/i.test(c)) ?? '';
    const has = (flag, val) => cl.includes(`${flag} ${val}`);
    const clChecks = [
      ['--ctx-size', String(exp.contextTokens)],
      ['--threads', String(exp.threads)],
      ['--threads-batch', String(exp.threadsBatch)],
      ['--batch-size', String(exp.batchSize)],
      ['--ubatch-size', String(exp.ubatchSize)]
    ];
    if (exp.useMmap === false) clChecks.push(['--no-mmap', '']);
    if (exp.cacheReuse > 0) clChecks.push(['--cache-reuse', String(exp.cacheReuse)]);
    const clBad = clChecks.filter(([flag, val]) => (val ? !has(flag, val) : !cl.includes(flag)))
      .map(([flag, val]) => `${flag}${val ? ` ${val}` : ''} нет`).join(', ');
    check(`профиль «${name}»: фактическая командная строка llama-server совпадает`,
      Boolean(cl) && clBad.length === 0,
      cl ? `args: ${cl.slice(cl.indexOf('--ctx-size'))?.slice(0, 200) ?? cl.slice(-200)}` : 'процесс llama-server.exe не найден (WMI)');
    results[`profile_${name}`] = { params: p, expected: exp, chat: { contentChars: run.contentChars, ttftMs: run.ttftMs, error: run.error }, commandLineOk: Boolean(cl) && clBad.length === 0 };
  }
  await fetch(`${BASE}/api/profile`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ profile: 'balanced' }) });

  // 6. Остановка модели: дерево процессов llama-server завершено
  const stop = await fetch(`${BASE}/api/models/stop`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: MODEL_ID }) }).then((r) => r.json()).catch((e) => ({ error: e.message }));
  await new Promise((r) => setTimeout(r, 2500));
  const alive = await serverProcessCount();
  results.stopModel = { stop, llamaServerProcessesLeft: alive };
  check('остановка модели: llama-server завершён (taskkill /T /F, 0 процессов)', stop?.verified === true && alive === 0, `verified=${stop?.verified}, процессов осталось=${alive}, RAM освобождено=${stop?.ram?.freedMb ?? '?'} МБ`);

  // 7. Полная остановка движка
  const estop = await fetch(`${BASE}/api/engine/stop`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).catch((e) => ({ error: e.message }));
  const t0 = Date.now();
  let engineExited = false;
  while (Date.now() - t0 < 15000) {
    if (child.exitCode !== null || child.signalCode !== null) { engineExited = true; break; }
    try { await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(600) }); } catch { engineExited = true; break; }
    await new Promise((r) => setTimeout(r, 400));
  }
  results.engineStop = { engineExited, exitCode: child.exitCode, signal: child.signalCode };
  check('остановка движка: процесс движка завершился', engineExited, `exit=${child.exitCode}/${child.signalCode}`);
} catch (err) {
  failed = true;
  check('smoke-тест выполнен без исключений', false, err.message);
} finally {
  try { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); } catch { /* уже мёртв */ }
  // Страховка: не оставить llama-server висеть
  const alive = await serverProcessCount();
  if (alive > 0 && process.platform === 'win32') {
    await execFileP('taskkill', ['/IM', 'llama-server.exe', '/T', '/F']);
  } else if (alive > 0) {
    await execFileP('sh', ['-c', "pgrep -f llama-server | xargs -r kill -9"]);
  }
  results.finishedAt = new Date().toISOString();
  results.status = status ? {
    engineVersion: status?.engine, profile: status?.engine?.profile,
    backendHealth: status?.backend?.health, runtimeBinary: status?.runtime?.binary
  } : null;
  fs.writeFileSync(OUT, JSON.stringify(results, null, 2));
  log(`результат: ${OUT}`);
  const passed = checks.filter((c) => c.ok).length;
  console.log(`\n[smoke] ИТОГ: ${passed}/${checks.length} проверок пройдено${passed === checks.length && !failed ? '' : ' — ЕСТЬ ПРОВАЛЫ'}`);
  if (failed || passed !== checks.length) {
    console.error(`[smoke] журнал движка (последние строки):\n${engineTail()}`);
    process.exit(1);
  }
}
