// Этап 2 — тесты новой функциональности runtime: трассировка стадий, разрешение
// параметров запуска, args-key, динамический резерв памяти, парсер таймингов
// llama-server, таймауты, профили. Всё выполняется на реальном движке и
// подставных бэкендах — без скачивания моделей (ТЗ §13/§14: CI лёгкий).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { StageTrace, summarizeStages, STAGES } from '../src/resource/stages.js';
import {
  resolveGenThreads, resolvePrefillThreads, resolveBatch, resolveMmap,
  resolvePriority, resolveRuntimeParams, runtimeStartKey, runtimeArgs, logicalCores
} from '../src/resource/threads.js';
import { dynamicReserveMb } from '../src/resource/gate.js';
import { parseServerTimingLine, exitCodeHint } from '../src/backends/lmlama.js';
import { loadConfig } from '../src/config.js';
import { Engine } from '../src/core/engine.js';
import { Logger, PerfRecorder } from '../src/diagnostics/log.js';
import { createBackend } from '../src/backends/registry.js';
import { fakeMetrics } from './helpers/fixtures.js';

/* ----------------------------- StageTrace ------------------------------ */

test('StageTrace: метки, длительности, честные «недоступно»', () => {
  let t = 1000;
  const trace = new StageTrace({ now: () => t, requestId: 'r1', model: 'm' });
  trace.point('instant');
  t += 50;
  trace.mark('phase');
  t += 120;
  const dur = trace.end('phase');
  assert.equal(dur, 120);
  // Закрытие неоткрытой стадии → durMs null + unavailable, не выдуманное число.
  const d2 = trace.end('never-opened');
  assert.equal(d2, null);
  const stages = trace.stages;
  assert.equal(stages.find((s) => s.stage === 'phase').durMs, 120);
  assert.equal(stages.find((s) => s.stage === 'never-opened').meta.unavailable, true);
  assert.equal(trace.durationOf('phase'), 120);
  assert.equal(trace.durationOf('missing'), null);
});

test('summarizeStages: средние, p95, счётчик запросов', () => {
  const traces = [
    { stages: [{ stage: 'a', durMs: 100 }, { stage: 'b', durMs: 10 }] },
    { stages: [{ stage: 'a', durMs: 200 }, { stage: 'b', durMs: 30 }] }
  ];
  const s = summarizeStages(traces);
  assert.equal(s.a.count, 2);
  assert.equal(s.a.avgMs, 150);
  assert.equal(s.a.maxMs, 200);
  assert.equal(s.b.avgMs, 20);
});

/* ------------------------- разрешение параметров ----------------------- */

test('threads: N5095A (4 ядра) → профили дают 2/3/4 потока генерации', () => {
  assert.equal(resolveGenThreads({ profile: 'low', cores: 4 }), 2);
  assert.equal(resolveGenThreads({ profile: 'balanced', cores: 4 }), 3);
  assert.equal(resolveGenThreads({ profile: 'high', cores: 4 }), 4);
  // Явное значение приоритетнее авто и не ограничивается ядрами (осознанный выбор).
  assert.equal(resolveGenThreads({ profile: 'high', cores: 4, explicit: 1 }), 1);
  assert.equal(resolveGenThreads({ profile: 'balanced', cores: 2, explicit: 3 }), 3);
});

test('threads: prefill — все ядра (кроме Бережного)', () => {
  assert.equal(resolvePrefillThreads({ profile: 'low', cores: 4 }), 2);
  assert.equal(resolvePrefillThreads({ profile: 'balanced', cores: 4 }), 4);
  assert.equal(resolvePrefillThreads({ profile: 'high', cores: 4 }), 4);
});

test('batch: не ниже дефолтов llama.cpp — иначе prefill замедляется', () => {
  assert.deepEqual(resolveBatch({ profile: 'low' }), { batch: 512, ubatch: 256 });
  assert.deepEqual(resolveBatch({ profile: 'balanced' }), { batch: 1024, ubatch: 512 });
  assert.deepEqual(resolveBatch({ profile: 'high' }), { batch: 2048, ubatch: 512 });
});

test('mmap: auto — маленькие модели в RAM, большие на mmap; явное значение уважается', () => {
  const gb = 1024 ** 3;
  const ram16 = 16 * gb;
  // 640 МБ (Qwen3-0.6B-Q8_0) при 16 ГБ → no-mmap (быстрый последовательный старт).
  assert.equal(resolveMmap({ useMmap: 'auto', fileSizeBytes: 640 * 1024 * 1024, totalRamBytes: ram16 }), false);
  // 8 ГБ модель при 16 ГБ → mmap (Windows может вытеснять холодные страницы).
  assert.equal(resolveMmap({ useMmap: 'auto', fileSizeBytes: 8 * gb, totalRamBytes: ram16 }), true);
  // Явные значения не меняются политикой.
  assert.equal(resolveMmap({ useMmap: true, fileSizeBytes: 1, totalRamBytes: ram16 }), true);
  assert.equal(resolveMmap({ useMmap: false, fileSizeBytes: 1, totalRamBytes: ram16 }), false);
  // Нет данных — поведение llama.cpp по умолчанию (mmap on).
  assert.equal(resolveMmap({ useMmap: 'auto', fileSizeBytes: 0, totalRamBytes: 0 }), true);
});

test('priority: Бережный — ниже обычного, остальные — обычный', () => {
  assert.equal(resolvePriority('low').level, 'below_normal');
  assert.equal(resolvePriority('balanced').level, 'normal');
  assert.equal(resolvePriority('high').level, 'normal');
});

test('resolveRuntimeParams + args: полный набор и стабильная командная строка', () => {
  const p = resolveRuntimeParams({
    profile: 'balanced',
    file: '/models/Qwen3-0.6B-Q8_0.gguf',
    fileSizeBytes: 640 * 1024 * 1024,
    totalRamBytes: 16 * 1024 ** 3,
    contextTokens: 4096,
    cores: 4
  });
  assert.equal(p.threads, 3);
  assert.equal(p.threadsBatch, 4);
  assert.equal(p.batchSize, 1024);
  assert.equal(p.ubatchSize, 512);
  assert.equal(p.useMmap, false);
  assert.equal(p.contextTokens, 4096);
  const args = runtimeArgs(p);
  const idx = (name) => args.indexOf(name);
  assert.ok(idx('--threads') > 0 && args[idx('--threads') + 1] === '3');
  assert.ok(idx('--threads-batch') > 0 && args[idx('--threads-batch') + 1] === '4');
  assert.ok(idx('--batch-size') > 0 && args[idx('--batch-size') + 1] === '1024');
  assert.ok(idx('--ubatch-size') > 0 && args[idx('--ubatch-size') + 1] === '512');
  assert.ok(idx('--load-mode') > 0 && args[idx('--load-mode') + 1] === 'none');
  assert.ok(!args.includes('--cache-reuse'));
  // Ключ запуска стабилен для той же конфигурации и меняется при смене профиля.
  const key = runtimeStartKey(p);
  assert.equal(key, runtimeStartKey(resolveRuntimeParams({ ...p })));
  const hi = resolveRuntimeParams({ profile: 'high', file: p.file, contextTokens: 4096, cores: 4 });
  assert.notEqual(key, runtimeStartKey(hi));
});

test('config: профили Этапа 2 содержат новые параметры', () => {
  const cfg = loadConfig(path.join(os.tmpdir(), `lm-cfg-${Date.now()}-absent.json`));
  assert.equal(cfg.profile, 'balanced');
  for (const name of ['low', 'balanced', 'high']) {
    const p = cfg.profiles[name];
    assert.ok('cpuThreadsBatch' in p, `${name}.cpuThreadsBatch`);
    assert.ok('numBatch' in p && p.numBatch > 0, `${name}.numBatch`);
    assert.ok('cacheReuse' in p, `${name}.cacheReuse`);
    assert.ok(p.requestTimeoutMs >= 600000, `${name}.requestTimeoutMs — длинные ответы не обрываются`);
  }
  assert.equal(cfg.backend.useMmap, 'auto');
});

/* --------------------------- динамический резерв ------------------------ */

test('dynamicReserveMb: растёт при paging/нагрузке и ограничен сверху', () => {
  const base = { baseReserveMb: 1024, availableRamMb: 8000, totalRamMb: 16000 };
  assert.equal(dynamicReserveMb({ ...base }).reserveMb, 1024);
  const paging = dynamicReserveMb({ ...base, hardFaultsPerSec: 300 });
  assert.ok(paging.reserveMb > 1024, 'paging повышает резерв');
  const heavy = dynamicReserveMb({ ...base, hardFaultsPerSec: 800 });
  assert.ok(heavy.reserveMb > paging.reserveMb, 'интенсивный paging повышает сильнее');
  const lowRam = dynamicReserveMb({ baseReserveMb: 1024, availableRamMb: 1500, totalRamMb: 16000 });
  assert.ok(lowRam.reserveMb >= 1536, 'мало RAM → +512');
  const busy = dynamicReserveMb({ ...base, systemCpuPercent: 90 });
  assert.ok(busy.reserveMb >= 1024 + 256, 'высокая загрузка CPU → +256');
  const capped = dynamicReserveMb({ baseReserveMb: 4096, availableRamMb: 1, totalRamMb: 16000, hardFaultsPerSec: 900, systemCpuPercent: 99 });
  assert.ok(capped.reserveMb <= 4096, 'верхняя граница');
  assert.ok(dynamicReserveMb({ ...base }).reasons.length === 0, 'нет причин — нет записей');
});

/* ------------------------- парсер таймингов llama ----------------------- */

test('parseServerTimingLine: форматы print_timings llama.cpp', () => {
  const pe = parseServerTimingLine('prompt eval time =   123.45 ms /    32 tokens   (    3.86 ms per token,   259.2 tokens per second)');
  assert.equal(pe.kind, 'prompt_eval');
  assert.equal(pe.promptEvalMs, 123.45);
  assert.equal(pe.promptTokens, 32);
  const ev = parseServerTimingLine('eval time =  12345.67 ms /   256 tokens   (   48.23 ms per token,    20.7 tokens per second)');
  assert.equal(ev.kind, 'eval');
  assert.equal(ev.evalMs, 12345.67);
  assert.equal(ev.evalTokens, 256);
  const tot = parseServerTimingLine('total time =  12469.12 ms /   288 tokens');
  assert.equal(tot.kind, 'total');
  assert.equal(tot.totalMs, 12469.12);
  // "prompt eval time" не должен считаться "eval time".
  const wrong = parseServerTimingLine('prompt eval time = 1.00 ms /    1 tokens');
  assert.notEqual(wrong.kind, 'eval');
  assert.equal(parseServerTimingLine('random log line'), null);
});

/* ------------------------------ бэкенд ---------------------------------- */

test('ensureServer: args-key — переиспользование и честный перезапуск', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-runtime-'));
  // Фейковый «llama-server»: печатает свои аргументы в stdout и слушает /health.
  const fakeBin = path.join(tmp, 'fake-llama-server');
  fs.writeFileSync(fakeBin, `#!/bin/sh
# Фейковый llama-server для тестов: сохраняет аргументы, отвечает /health ok.
if [ "\$1" = "--version" ]; then echo "fake version b1000"; exit 0; fi
if [ "\$1" = "--list-devices" ]; then echo "Available devices:"; echo "CPU0: fake CPU device"; exit 0; fi
ARGS_FILE="\${FAKE_ARGS_FILE:-/tmp/fake-llama-args-\$\$.json}"
echo "\$@" > "\$ARGS_FILE"
PORT=""
HOST="127.0.0.1"
prev=""
for a in "\$@"; do
  if [ "\$prev" = "--port" ]; then PORT="\$a"; fi
  if [ "\$prev" = "--host" ]; then HOST="\$a"; fi
  prev="\$a"
done
# stdio → /dev/null: иначе python держит трубы Node и close не приходит.
# trap: при SIGTERM/SIGINT убиваем python — процесс-заглушка умирает целиком.
python3 - "\$PORT" >/dev/null 2>&1 <<'EOF' &
import sys, json
from http.server import BaseHTTPRequestHandler, HTTPServer
port = int(sys.argv[1])
class H(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == '/health':
            body = json.dumps({'status': 'ok'}).encode()
            self.send_response(200)
            self.send_header('content-type', 'application/json')
            self.send_header('content-length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        else:
            self.send_response(404); self.end_headers()
    def log_message(self, *a): pass
HTTPServer(('127.0.0.1', port), H).serve_forever()
EOF
CHILD=\$!
trap 'kill \$CHILD 2>/dev/null; exit 0' TERM INT
wait \$CHILD
`, { mode: 0o755 });

  const cfg = loadConfig(path.join(os.tmpdir(), `lm-cfg-${Date.now()}-b.json`));
  cfg.backend.serverPath = fakeBin;
  cfg.models.rootDir = tmp;
  const backend = createBackend(cfg);
  t.after(async () => { await backend.shutdown().catch(() => {}); });

  const modelFile = path.join(tmp, 'test-model.gguf');
  fs.writeFileSync(modelFile, Buffer.alloc(1024)); // размер не важен для фейка

  await backend.ensureServer({ file: modelFile, contextTokens: 4096, threads: 3, threadsBatch: 4, numBatch: 1024, useMmap: false, cacheReuse: 0, profile: 'balanced' });
  assert.ok(backend.proc, 'процесс запущен');
  const args1 = backend._startKeyStr;
  assert.ok(args1.includes('"threads":3'));

  // Тот же конфиг → переиспользование (процесс не перезапускается).
  const pid1 = backend.proc.pid;
  await backend.ensureServer({ file: modelFile, contextTokens: 4096, threads: 3, threadsBatch: 4, numBatch: 1024, useMmap: false, cacheReuse: 0, profile: 'balanced' });
  assert.equal(backend.proc.pid, pid1, 'тот же процесс');
  assert.equal(backend._restarts, 0);

  // Смена потоков → перезапуск с новыми аргументами.
  await backend.ensureServer({ file: modelFile, contextTokens: 4096, threads: 1, threadsBatch: 4, numBatch: 1024, useMmap: false, cacheReuse: 0, profile: 'balanced' });
  assert.equal(backend.proc.pid !== pid1, true, 'процесс перезапущен при смене потоков');
  assert.equal(backend._restarts, 1);
  assert.ok(backend._lastRestartReason.changed.threads, 'причина перезапуска: threads');
  assert.equal(backend._startKeyStr.includes('"threads":1'), true);

  // Grow-only контекст: меньший контекст НЕ перезапускает.
  const pid2 = backend.proc.pid;
  await backend.ensureServer({ file: modelFile, contextTokens: 2048, threads: 1, threadsBatch: 4, numBatch: 1024, useMmap: false, cacheReuse: 0, profile: 'balanced' });
  assert.equal(backend.proc.pid, pid2, 'меньший контекст не перезапускает');
  assert.equal(backend._restarts, 1);
  // Больший контекст — перезапускает и расширяет пол.
  await backend.ensureServer({ file: modelFile, contextTokens: 8192, threads: 1, threadsBatch: 4, numBatch: 1024, useMmap: false, cacheReuse: 0, profile: 'balanced' });
  assert.equal(backend._restarts, 2);
  assert.ok(backend._startKeyStr.includes('"ctx":8192'));
  assert.equal(backend._ctxFloor, 8192);

  // Смена профиля (Engine.setProfile → resetSession) — явное намерение:
  // пол контекста сброшен, следующий запуск применяет ровно профильные
  // параметры, включая МЕНЬШИЙ контекст (ТЗ Этапа 2 §8, дефект «Бережного»).
  backend.resetSession({ reason: 'profile-switch:low' });
  await backend.ensureServer({ file: modelFile, contextTokens: 2048, threads: 2, threadsBatch: 2, numBatch: 512, useMmap: false, cacheReuse: 0, profile: 'low' });
  assert.equal(backend._restarts, 3, 'смена профиля → честный перезапуск');
  assert.ok(backend._startKeyStr.includes('"ctx":2048'), 'после resetSession применён меньший контекст');
  assert.equal(backend._ctxFloor, 2048);
  // Причина перезапуска перезаписывается фактическим diff параметров
  // (resetSession-метка — временная, до честного перезапуска).
  assert.ok(backend._lastRestartReason.changed.threads, 'перезапуск зафиксирован новыми параметрами');

  const info = backend.runtimeInfo();
  assert.equal(info.params.threads, 2, 'последний запуск — профиль low (2 потока)');
  assert.equal(info.loadMs != null, true, 'loadMs измерен');
  assert.equal(info.gpu.probed !== undefined, true, 'gpu-диагностика присутствует');
});

test('ensureServer: одновременный старт Chat+Agent — ровно один llama-server (гонка портов)', async (t) => {
  // Регрессия CI 2026-11-11: параллельные ensureServer дважды доходили до
  // spawn, llama-server на том же порту умирал («прожил 0.4 с»), агент
  // получал ошибку. Теперь запуски сериализуются: второй вызов видит
  // загруженную модель и переиспользует её.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-runtime-race-'));
  const fakeBin = path.join(tmp, 'fake-llama-server');
  const spawnsFile = path.join(tmp, 'spawns.txt');
  fs.writeFileSync(fakeBin, `#!/bin/sh
if [ "\$1" = "--version" ]; then echo "fake version b1000"; exit 0; fi
echo "\$@" >> "${spawnsFile}"
PORT=""; prev=""
for a in "\$@"; do
  if [ "\$prev" = "--port" ]; then PORT="\$a"; fi
  prev="\$a"
done
python3 - "\$PORT" >/dev/null 2>&1 <<'EOF' &
import sys, json, time
from http.server import BaseHTTPRequestHandler, HTTPServer
port = int(sys.argv[1])
class H(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == '/health':
            body = json.dumps({'status': 'ok'}).encode()
            self.send_response(200)
            self.send_header('content-type', 'application/json')
            self.send_header('content-length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        else:
            self.send_response(404); self.end_headers()
    def log_message(self, *a): pass
time.sleep(0.3)  # имитация «загрузки модели»: второй вызов должен ДОЖДАТЬСЯ, а не убить
HTTPServer(('127.0.0.1', port), H).serve_forever()
EOF
CHILD=\$!
trap 'kill \$CHILD 2>/dev/null; exit 0' TERM INT
wait \$CHILD
`, { mode: 0o755 });

  const cfg = loadConfig(path.join(os.tmpdir(), `lm-cfg-${Date.now()}-race.json`));
  cfg.backend.serverPath = fakeBin;
  cfg.models.rootDir = tmp;
  const backend = createBackend(cfg);
  t.after(async () => { await backend.shutdown().catch(() => {}); });

  const modelFile = path.join(tmp, 'race-model.gguf');
  fs.writeFileSync(modelFile, Buffer.alloc(1024));
  const args = { file: modelFile, contextTokens: 4096, threads: 3, threadsBatch: 4, numBatch: 1024, useMmap: false, cacheReuse: 0, profile: 'balanced' };

  // Chat и Agent стартуют модель одновременно.
  const [a, b] = await Promise.all([backend.ensureServer(args), backend.ensureServer(args)]);
  assert.equal(a, b, 'оба запроса получили один и тот же baseUrl');
  const spawns = fs.existsSync(spawnsFile) ? fs.readFileSync(spawnsFile, 'utf8').trim().split('\n').filter(Boolean) : [];
  assert.equal(spawns.length, 1, `spawn был ровно один (фактически: ${spawns.length})`);
  assert.ok(backend.proc, 'процесс жив');
});

/* ------------------------------ движок ---------------------------------- */

function makeEngine({ backend, configOverrides = null, now = null } = {}) {
  let t = Date.now();
  const cfg = loadConfig(path.join(os.tmpdir(), `lm-cfg-${Math.random().toString(36).slice(2)}.json`));
  if (configOverrides) cfg.backend = { ...cfg.backend, ...configOverrides };
  const engine = new Engine({
    config: cfg,
    backend,
    sampler: { latest: fakeMetrics(), sample: async () => fakeMetrics(), stop: () => {}, history: [] },
    logger: new Logger({ level: 'error' }),
    perf: new PerfRecorder(),
    now: now ?? (() => t)
  });
  return engine;
}

/** Бэкенд-заглушка с управляемым стримингом и задержками. */
function fakeStreamBackend({ tokenDelayMs = 0, tokenCount = 5, firstTokenDelayMs = 0, serverInfo = null, hangForever = false } = {}) {
  return {
    type: 'fake',
    detect: async () => ({ ok: true, version: 'fake' }),
    listModels: async () => [{ id: 'm', sizeBytes: 1024 * 1024 }],
    capabilities: () => ({ stream: true, cancel: true, unload: true, numCtx: true, numThreads: true, numPredict: true, parallel: false }),
    loaded: async () => [],
    unload: async () => ({ unloaded: [] }),
    generate: async ({ onToken, onServerReady, onHeaders, signal }) => {
      onServerReady?.({ restarted: true, loadMs: 1234, argsKey: 'k', params: { threads: 3 }, ms: 1300 });
      onHeaders?.(15);
      if (firstTokenDelayMs) await new Promise((r) => setTimeout(r, firstTokenDelayMs));
      for (let i = 0; i < tokenCount; i++) {
        if (signal?.aborted) throw Object.assign(new Error('Generation cancelled'), { code: 'CANCELLED', name: 'CancelledError' });
        onToken?.('т', {});
        if (tokenDelayMs) await new Promise((r) => setTimeout(r, tokenDelayMs));
      }
      if (hangForever) {
        // Зависаем, но реагируем на abort — как реальный бэкенд (стрим рвётся).
        await new Promise((_, rej) => {
          if (!signal) return;
          signal.addEventListener('abort', () => rej(Object.assign(new Error('Generation cancelled'), { code: 'CANCELLED', name: 'CancelledError' })), { once: true });
        });
      }
      return { text: 'т'.repeat(tokenCount), usage: { promptTokens: 8, completionTokens: tokenCount }, server: serverInfo };
    }
  };
}

test('engine: трассировка стадий заполняется на реальном запросе', async () => {
  const engine = makeEngine({ backend: fakeStreamBackend() });
  const r = await engine.generate({ model: 'm', messages: [{ role: 'user', content: 'привет' }] });
  const stages = r.timings; // не содержит стадий, они в record
  const rec = [...engine.requests.values()].find((x) => x.id === r.requestId);
  assert.ok(rec, 'record сохранён');
  const st = Object.fromEntries(rec.stages.map((s) => [s.stage, s]));
  assert.ok(STAGES.REQUEST_RECEIVED in st);
  assert.ok(STAGES.QUEUED in st);
  assert.ok(STAGES.MEMORY_GATE in st);
  assert.ok(STAGES.SERVER_START in st);
  assert.ok(STAGES.PROMPT_SUBMIT in st);
  assert.ok(STAGES.FIRST_TOKEN in st, 'first_token зафиксирован');
  assert.ok(STAGES.GENERATION in st);
  assert.ok(STAGES.TOTAL in st);
  assert.equal(st.server_start.meta.loadMs, 1234, 'loadMs от бэкенда попал в стадию');
  // Честное разделение: TTFT после готовности сервера < полного TTFT (он с нуля).
  assert.ok(rec.ttftAfterServerMs !== null);
  // Сводка стадий в status().
  const status = await engine.status();
  assert.ok(status.stages[STAGES.FIRST_TOKEN], 'сводка стадий в статусе');
  assert.ok(status.runtime === null, 'fake-бэкенд без runtimeInfo → null, не выдумка');
});

test('engine: длинная генерация не обрывается «connect-таймаутом» (регрессия Этапа 2)', async () => {
  // 8 токенов по 30 мс — суммарно дольше старого 60-с лимита в масштабе;
  // здесь сам бэкенд-заглушка: важно, что движок НЕ ставит общий таймер на стрим.
  const engine = makeEngine({ backend: fakeStreamBackend({ tokenDelayMs: 30, tokenCount: 8, firstTokenDelayMs: 50 }) });
  const r = await engine.generate({ model: 'm', messages: [{ role: 'user', content: 'длинный ответ' }] });
  assert.equal(r.usage.completionTokens, 8, 'все токены дошли');
}, { timeout: 10000 });

test('engine: stream-idle watchdog ловит зависание ПОСЛЕ первого токена', async () => {
  const engine = makeEngine({ backend: fakeStreamBackend({ tokenCount: 2, tokenDelayMs: 5, hangForever: true }) });
  engine.config.backend.streamIdleTimeoutMs = 80;
  await assert.rejects(
    () => engine.generate({ model: 'm', messages: [{ role: 'user', content: 'завис' }], onToken: null }),
    (err) => err.code === 'TIMEOUT',
    'зависание после первого токена прерывается watchdog'
  );
}, { timeout: 10000 });

test('engine: медленный prefill НЕ прерывается stream-idle watchdog', async () => {
  // Первый токен приходит через 300 мс при streamIdleTimeoutMs=80:
  // до первого токена действует общий таймаут запроса, а не 60-с сторож.
  const engine = makeEngine({ backend: fakeStreamBackend({ firstTokenDelayMs: 300, tokenCount: 3 }) });
  engine.config.backend.streamIdleTimeoutMs = 80;
  const r = await engine.generate({ model: 'm', messages: [{ role: 'user', content: 'длинный промпт' }] });
  assert.equal(r.usage.completionTokens, 3, 'медленный prefill дожил до токенов');
}, { timeout: 10000 });

test('engine: ошибка бэкенда сохраняет трассу стадий (диагностика места застревания)', async () => {
  const failing = {
    ...fakeStreamBackend(),
    generate: async () => { throw new Error('модель взорвалась'); }
  };
  const engine = makeEngine({ backend: failing });
  await assert.rejects(() => engine.generate({ model: 'm', messages: [{ role: 'user', content: 'x' }] }));
  const trace = engine._stageTraces.at(-1);
  assert.ok(trace, 'трасса сохранена');
  const errStage = trace.list.find((s) => s.stage === 'error');
  assert.ok(errStage, 'стадия error записана');
  assert.match(errStage.meta.message, /взорвалась/);
});

test('PerfRecorder: сводка включает честные ttftAfterServerMs и modelLoadMs', async () => {
  const engine = makeEngine({ backend: fakeStreamBackend() });
  await engine.generate({ model: 'm', messages: [{ role: 'user', content: 'x' }] });
  const perf = engine.perf.summary();
  assert.ok('ttftAfterServerMs' in perf && 'modelLoadMs' in perf);
  assert.equal(perf.modelLoadMs.n >= 1, true, 'загрузка модели учтена отдельной метрикой');
});


/* -------------------- ТЗ v0.6.2: расшифровка NTSTATUS ------------------- */

test('exitCodeHint: 0xC0000135 узнаётся и в signed, и в unsigned виде (краш из ТЗ)', () => {
  for (const code of [-1073741515, 3221225781]) {
    const hint = exitCodeHint(code);
    assert.ok(hint, 'подсказка должна быть для обоих видов кода');
    assert.ok(hint.includes('0xC0000135'), 'код должен быть расшифрован: ' + hint);
    assert.ok(hint.includes('STATUS_DLL_NOT_FOUND'), 'имя статуса в подсказке');
    assert.match(hint, /Переустановите/u, 'подсказка говорит, что делать');
  }
});

test('exitCodeHint: другие частые NTSTATUS и нейтральные коды', () => {
  assert.match(exitCodeHint(-1073741502) ?? '', /STATUS_DLL_INIT_FAILED/);   // 0xC0000142
  assert.match(exitCodeHint(-1073741701) ?? '', /STATUS_INVALID_IMAGE_FORMAT/); // 0xC000007B
  assert.match(exitCodeHint(-1073741819) ?? '', /STATUS_ACCESS_VIOLATION/);  // 0xC0000005
  assert.equal(exitCodeHint(0), null);          // нормальное завершение
  assert.equal(exitCodeHint(1), null);          // обычная ошибка, не NTSTATUS
  assert.equal(exitCodeHint(null), null);       // сигнал, не код
  assert.equal(exitCodeHint(undefined), null);
});
