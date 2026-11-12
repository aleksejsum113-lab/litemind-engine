// Inference Backend — собственный runtime LiteMind на базе llama.cpp (llama-server).
//
// ТЗ v0.4.0: движок сам управляет моделями — обнаружение GGUF в папке моделей,
// выбор и запуск llama-server, стриминг чата, остановка, удаление файлов.
// Ollama больше не требуется: backend "lmlama" — основной, "ollama" — опциональный.
//
// Этап 2 (оптимизация runtime):
//  - параметры запуска (потоки, threads-batch, batch/ubatch, mmap, cache-reuse,
//    контекст) разрешаются через resource/threads.js из активного профиля;
//  - ключ запуска (args-key): если параметры запроса отличаются от параметров
//    работающего llama-server — процесс ЧЕСТНО перезапускается с новыми
//    аргументами (раньше параметры молча игнорировались, а автооптимизация
//    потоков измеряла одну и ту же конфигурацию трижды);
//  - контекст grow-only: меньший контекст не вызывает перезапуск, больший —
//    расширяет KV-кэш (перезапуском) и запоминается как минимум сессии;
//  - замер стадий: загрузка модели (spawn → /health ok), HTTP-заголовки,
//    первый токен; из stderr llama-server разбираются его собственные тайминги
//    (prompt eval / eval time) — честное разделение prefill и генерации;
//  - таймаут соединения снимается сразу после получения заголовков ответа —
//    раньше таймер на 60 с жил ВЕСЬ стрим и убивал генерации длиннее минуты;
//  - detect() опрашивает llama-server --list-devices: честная диагностика GPU
//    (у комплектной CPU-сборки устройств не будет — и это не выдумывается).
//
// Как это работает:
//  1. findServerBinary() — где лежит llama-server(.exe): env LITEMIND_LLAMA_SERVER,
//     config.backend.serverPath, resources/llamacpp (в комплекте установщика), PATH.
//  2. listModels() — сканирует config.models.rootDir на *.gguf, читает заголовки.
//  3. generate() — поднимает llama-server с выбранной моделью (один процесс,
//     одна модель — как и требует Low Resource профиль), ждёт /health, стримит
//     SSE из /v1/chat/completions (OpenAI-совместимый контракт llama.cpp).
//  4. unload() — терминирует процесс: модель уходит из RAM/VRAM немедленно.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { BackendError, ModelNotFoundError } from './base.js';
import { readGgufHeader } from './gguf.js';
import { resolveRuntimeParams, runtimeStartKey, runtimeArgs } from '../resource/threads.js';
import { applyPriorityToPid } from '../resource/priority.js';

const EXE = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server';

/** Свободный TCP-порт на loopback. */
function freePort(host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, host, () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/**
 * Разобрать тайминги llama-server из строки лога.
 * Форматы (llama.cpp, slot print_timings):
 *   "prompt eval time =   123.45 ms /    32 tokens   (    3.86 ms per token,   259.2 tokens per second)"
 *   "eval time =  12345.67 ms /   256 tokens   (   48.23 ms per token,    20.7 tokens per second)"
 *   "total time =  12469.12 ms /   288 tokens"
 */
export function parseServerTimingLine(line) {
  const s = String(line || '');
  let m = s.match(/prompt eval time\s*=\s*([\d.]+)\s*ms\s*\/\s*(\d+)\s*tokens/i);
  if (m) return { kind: 'prompt_eval', promptEvalMs: Number(m[1]), promptTokens: Number(m[2]) };
  m = s.match(/(?<!prompt )eval time\s*=\s*([\d.]+)\s*ms\s*\/\s*(\d+)\s*tokens/i);
  if (m) return { kind: 'eval', evalMs: Number(m[1]), evalTokens: Number(m[2]) };
  m = s.match(/total time\s*=\s*([\d.]+)\s*ms/i);
  if (m) return { kind: 'total', totalMs: Number(m[1]) };
  return null;
}

export class LlamaCppBackend {
  constructor({ rootDir, serverPath = null, host = '127.0.0.1', logger = null, fetchImpl = fetch,
                contextTokens = 4096, threads = 0, chatTemplate = null, loadTimeoutMs = 180000 } = {}) {
    this.type = 'lmlama';
    this.rootDir = rootDir;
    this.host = host;
    this.log = logger;
    this.fetch = fetchImpl;
    this.serverPath = serverPath || null;
    this.defaultCtx = contextTokens;
    this.defaultThreads = threads;
    this.chatTemplate = chatTemplate;
    this.loadTimeoutMs = loadTimeoutMs;

    // Состояние процесса llama-server: не более одного загруженного файла.
    this.proc = null;
    this.port = null;
    this.baseUrl = null;
    this.modelFile = null;   // абсолютный путь к .gguf
    this.modelId = null;     // имя файла без .gguf
    this.exitInfo = null;    // { code, signal, stderrTail }
    this._scannedAt = 0;
    this._scanCache = [];

    // Этап 2: фактические параметры запуска и метаданные процесса.
    this._startKeyStr = null;   // args-key работающего процесса
    this._runtimeParams = null; // разрешённые параметры (для диагностики)
    this._startedAt = null;     // момент spawn
    this.lastLoadMs = null;     // длительность последней загрузки модели (spawn → health ok)
    this._ctxFloor = 0;         // grow-only контекст сессии (0 = не задан)
    this._restarts = 0;         // сколько раз перезапускали из-за смены параметров
    this._lastRestartReason = null;
    this.serverTimings = [];    // разобранные тайминги llama-server (последние 32)
    this._timingAcc = null;     // накапливаемые поля одного print_timings
    this.gpu = { probed: false, devices: [], note: null };

    // v0.6.1: сериализация жизненного цикла. Раньше два одновременных вызова
    // ensureServer (задача агента + кнопка «Запустить»/чат с другими
    // параметрами) устраивали гонку: второй честно убивал llama-server первого,
    // и генерация падала с «Стрим прервался»/«fetch failed». Все переходы
    // (spawn/stop/restart) теперь выстраиваются в цепочку, а смена параметров
    // во время активной генерации получает честный отказ RUNTIME_BUSY вместо
    // убийства чужого стрима.
    this._startChain = Promise.resolve(); // мьютекс жизненного цикла запусков
    this._activeStreams = 0;               // сколько генераций идёт прямо сейчас
  }

  capabilities() {
    return { stream: true, cancel: true, unload: true, numCtx: true, numThreads: true, numPredict: true, parallel: false };
  }

  /** Диагностика «что реально применено» (ТЗ Этапа 2 §8/§12). */
  runtimeInfo() {
    return {
      binary: this.findServerBinary(),
      modelFile: this.modelFile,
      modelId: this.modelId,
      running: Boolean(this.proc && this.modelFile),
      startedAt: this._startedAt,
      loadMs: this.lastLoadMs,
      params: this._runtimeParams,
      argsKey: this._startKeyStr,
      restarts: this._restarts,
      lastRestartReason: this._lastRestartReason,
      serverTimings: this.serverTimings.slice(-10),
      gpu: this.gpu
    };
  }

  /** Последние разобранные тайминги llama-server (и очистить очередь). */
  takeServerTimings() {
    const out = this.serverTimings.splice(0, this.serverTimings.length);
    return out;
  }

  /**
   * Смена профиля — явное намерение пользователя (ТЗ Этапа 2 §8: профили
   * реально меняют параметры runtime). Пол контекста (_ctxFloor) сбрасывается,
   * чтобы следующий запуск получил ровно профильные параметры — в том числе
   * МЕНЬШИЙ контекст «Бережного». Работающий процесс не трогаем: его честно
   * перезапустит ensureServer по изменившемуся args-key.
   * Вызывается движком из Engine.setProfile; у других бэкендов метод опционален.
   */
  resetSession({ reason = null } = {}) {
    this._ctxFloor = 0;
    if (reason) this._lastRestartReason = { at: new Date().toISOString(), changed: { session: reason } };
  }

  // ── Бинарник llama-server ────────────────────────────────────────────────

  /** Кандидаты пути к llama-server, по убыванию приоритета. Все проверяются на существование. */
  _candidates() {
    const list = [];
    if (process.env.LITEMIND_LLAMA_SERVER) list.push(process.env.LITEMIND_LLAMA_SERVER);
    if (this.serverPath) list.push(this.serverPath);
    // Внутри Electron: process.resourcesPath = <install>\resources
    if (process.resourcesPath) list.push(path.join(process.resourcesPath, 'llamacpp', EXE));
    // Dev-режим monorepo: packages/desktop/resources/llamacpp/<exe>
    try {
      const here = path.dirname(fileURLToPath(import.meta.url)); // …/src/backends
      list.push(path.join(here, '..', '..', '..', '..', 'desktop', 'resources', 'llamacpp', EXE));
    } catch { /* не критично */ }
    list.push(EXE); // PATH
    return list;
  }

  /** Найденный бинарник или null. */
  findServerBinary() {
    for (const cand of this._candidates()) {
      if (!cand) continue;
      if (cand === EXE) {
        // Поиск в PATH без внешних процессов.
        const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
        for (const d of dirs) {
          const p = path.join(d, EXE);
          try { if (fs.statSync(p).isFile()) return p; } catch { /* дальше */ }
        }
        continue;
      }
      try { if (fs.statSync(cand).isFile()) return path.resolve(cand); } catch { /* дальше */ }
    }
    return null;
  }

  /**
   * Этап 2 §10 — какие вычислительные устройства реально доступны runtime.
   * llama-server --list-devices честно перечисляет GPU-бэкенды; у комплектной
   * CPU-сборки их нет. Результат НЕ включает GPU автоматически (ТЗ §10:
   * без реального сравнения скорости iGPU не включается).
   */
  async probeGpuDevices(timeoutMs = 6000) {
    const bin = this.findServerBinary();
    if (!bin) {
      this.gpu = { probed: true, devices: [], note: 'llama-server не найден — устройства не опрошены' };
      return this.gpu;
    }
    try {
      const res = await new Promise((resolve) => {
        let out = '', err = '', done = false;
        const proc = spawn(bin, ['--list-devices'], { windowsHide: true });
        const finish = (r) => { if (!done) { done = true; resolve(r); } };
        const killer = setTimeout(() => { try { proc.kill(); } catch { /* уже мёртв */ } finish(null); }, timeoutMs);
        proc.stdout.on('data', (d) => { out += d; });
        proc.stderr.on('data', (d) => { err += d; });
        proc.on('error', () => { clearTimeout(killer); finish(null); });
        proc.on('close', () => { clearTimeout(killer); finish({ out, err }); });
      });
      const text = res ? `${res.out}\n${res.err}` : '';
      const devices = text.split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l && !/^available devices/i.test(l) && !/^list devices/i.test(l))
        // Строка устройства llama.cpp: "Vulkan0: Intel(R) UHD Graphics (...)" или "Vulkan: ..."
        .filter((l) => /:\s+\S/.test(l) && !/no devices/i.test(l))
        .slice(0, 8);
      this.gpu = {
        probed: true,
        devices,
        note: devices.length
          ? 'GPU-бэкенды обнаружены в runtime. Автовключения нет: iGPU сравнивается с CPU только по реальному замеру.'
          : 'Комплектный runtime собран только для CPU. Вычисления на Intel UHD не используются — это честно отражено.'
      };
    } catch (err) {
      this.gpu = { probed: true, devices: [], note: `опрос не удался: ${err.message}` };
    }
    return this.gpu;
  }

  /** Достижимость runtime: бинарник найден и запускается. Никогда не бросает. */
  async detect() {
    const bin = this.findServerBinary();
    if (!bin) {
      return {
        ok: false,
        error:
          `llama-server не найден. LiteMind 0.4 кладёт его в "<установка>\\resources\\llamacpp\\llama-server.exe". ` +
          `Проверьте установку или укажите путь вручную (config.backend.serverPath или LITEMIND_LLAMA_SERVER).`
      };
    }
    return await new Promise((resolve) => {
      let out = '', err = '', done = false;
      const proc = spawn(bin, ['--version'], { windowsHide: true });
      const finish = (result) => { if (!done) { done = true; resolve(result); } };
      const killer = setTimeout(() => { proc.kill(); finish({ ok: false, error: `llama-server --version не ответил за 10 с: ${bin}` }); }, 10000);
      proc.stdout.on('data', (d) => { out += d; });
      proc.stderr.on('data', (d) => { err += d; });
      proc.on('error', (e) => { clearTimeout(killer); finish({ ok: false, error: `Не удалось запустить llama-server (${bin}): ${e.message}` }); });
      proc.on('close', (code) => {
        clearTimeout(killer);
        if (code === 0) {
          const version = (out || err).split(/\r?\n/).find(Boolean) || 'unknown';
          finish({ ok: true, version: version.trim(), detail: bin });
        } else {
          finish({ ok: false, error: `llama-server завершился с кодом ${code}: ${(err || out).slice(0, 300)}` });
        }
      });
    });
  }

  // ── Обнаружение моделей ──────────────────────────────────────────────────

  /**
   * Сканировать папку моделей. Результат кэшируется на 4 c.
   * @returns {Promise<Array<{id:string,file:string,sizeBytes:number,architecture:string|null,
   *   name:string|null,quant:string|null,contextLength:number|null,ok:boolean,error:string|null,
   *   memoryEstimateMb:number,compatible:boolean}>>}
   */
  async scanModels() {
    if (Date.now() - this._scannedAt < 4000 && this._scanCache.length) return this._scanCache;
    const entries = [];
    let files = [];
    try {
      await fs.promises.mkdir(this.rootDir, { recursive: true });
      files = (await fs.promises.readdir(this.rootDir)).filter((f) => f.toLowerCase().endsWith('.gguf'));
    } catch (err) {
      this.log?.warn('scan failed', { dir: this.rootDir, error: err.message });
      return [];
    }

    const totalMemMb = os.totalmem() / (1024 * 1024);
    const budgetMb = totalMemMb * 0.7; // как resource/gate: не занимать больше 70% RAM

    for (const f of files) {
      const file = path.join(this.rootDir, f);
      let sizeBytes = 0;
      try { sizeBytes = (await fs.promises.stat(file)).size; } catch { continue; }
      const entry = {
        id: f.replace(/\.gguf$/i, ''),
        file,
        sizeBytes,
        architecture: null, name: null, quant: null, contextLength: null,
        ok: false, error: null
      };
      try {
        const hdr = await readGgufHeader(file);
        Object.assign(entry, hdr);
        entry.ok = true;
      } catch (err) {
        entry.error = `Файл повреждён или не GGUF: ${err.message}`;
      }
      // Оценка RAM: веса ≈ размер файла × 1.15 (буферы вычислений) + 256 МБ запас
      // под KV-кэш и активацию — консервативно для контекста ~4k у малых моделей.
      entry.memoryEstimateMb = Math.round((sizeBytes / (1024 * 1024)) * 1.15) + 256;
      entry.compatible = entry.memoryEstimateMb <= budgetMb;
      entries.push(entry);
    }
    entries.sort((a, b) => b.sizeBytes - a.sizeBytes);
    this._scanCache = entries;
    this._scannedAt = Date.now();
    return entries;
  }

  async listModels() {
    const scanned = await this.scanModels();
    return scanned
      .filter((m) => m.ok)
      .map((m) => ({
        id: m.id,
        sizeBytes: m.sizeBytes,
        detail: `${m.architecture ?? 'gguf'} · ${m.quant ?? 'unknown quant'} · ${(m.sizeBytes / (1024 * 1024)).toFixed(0)} MiB`,
        quantization: m.quant,
        family: m.architecture,
        parameterSize: null,
        contextLength: m.contextLength,
        compatible: m.compatible,
        memoryEstimateMb: m.memoryEstimateMb,
        runtime: 'llama.cpp',
        tools: false, // честно: поддержку tools у GGUF не обещаем
        vision: false
      }));
  }

  async loaded() {
    if (!this.proc || !this.modelId) return [];
    const healthy = await this._health(1500).catch(() => null);
    if (!healthy) return [];
    return [{ id: this.modelId, sizeBytes: null, file: this.modelFile, port: this.port }];
  }

  // ── Управление процессом llama-server ────────────────────────────────────

  async _health(timeoutMs = 2000) {
    if (!this.baseUrl) return null;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(new Error('timeout')), timeoutMs);
    try {
      const res = await this.fetch(`${this.baseUrl}/health`, { signal: ctrl.signal });
      if (!res.ok) return null;
      return await res.json().catch(() => ({}));
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Ждать /health === ok до deadlineMs. Пока модель грузится, /health отдаёт
   * { status: 'loading' } — это норма, ждём дальше. Возвращаем true, если
   * сервер готов; false — если процесс умер или время истекло.
   */
  async _waitHealth(deadlineMs = 30000) {
    const deadline = Date.now() + deadlineMs;
    while (Date.now() < deadline) {
      if (this.proc && (this.proc.exitCode !== null || this.proc.signalCode !== null)) return false;
      const h = await this._health(3000);
      if (h?.status === 'ok') return true;
      await new Promise((r) => setTimeout(r, 400));
    }
    return false;
  }

  _stopProc(force = false) {
    return new Promise((resolve) => {
      const proc = this.proc;
      if (!proc || proc.exitCode !== null || proc.signalCode !== null) { this._resetProc(); return resolve(); }
      const killed = setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* уже мёртв */ } }, 3000);
      proc.once('close', () => { clearTimeout(killed); this._resetProc(); resolve(); });
      try { proc.kill(force ? 'SIGKILL' : 'SIGTERM'); } catch { clearTimeout(killed); this._resetProc(); resolve(); }
      if (process.platform === 'win32') {
        // SIGTERM на Windows убивает процесс сразу — гарантия освобождения RAM.
        // v0.6.1: у spawn обязателен обработчик 'error' — без него отказ
        // taskkill (нет PID, ENOENT) становился uncaughtException и убивал
        // весь процесс движка.
        if (proc.pid) {
          try {
            const tk = spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { windowsHide: true });
            tk.on('error', () => { /* процесс уже мёртв или taskkill недоступен — SIGTERM выше */ });
          } catch { /* fallback выше */ }
        }
      }
    });
  }

  _resetProc() {
    this.proc = null;
    this.port = null;
    this.baseUrl = null;
    this.modelFile = null;
    this.modelId = null;
    this._startKeyStr = null;
    this._runtimeParams = null;
    this._startedAt = null;
    this._ctxFloor = 0; // сессия сброшена — контекст следующей загрузки ничем не связан
  }

  /**
   * Разрешить фактические параметры запуска из запроса + профиля.
   * Явные threads (автооптимизация/запрос UI) приоритетнее профиля.
   */
  _resolve({ file, contextTokens, threads, threadsBatch, numBatch, useMmap, cacheReuse, profile, fileSizeBytes }) {
    return resolveRuntimeParams({
      profile: profile || 'balanced',
      file: path.resolve(file),
      fileSizeBytes: fileSizeBytes ?? 0,
      totalRamBytes: os.totalmem(),
      contextTokens: Math.max(Number(contextTokens) || 0, this._ctxFloor || 0),
      cpuThreads: Number(threads) > 0 ? Number(threads) : this.defaultThreads,
      cpuThreadsBatch: Number(threadsBatch) > 0 ? Number(threadsBatch) : 0,
      numBatch: Number(numBatch) > 0 ? Number(numBatch) : 0,
      useMmap: useMmap === undefined || useMmap === null ? 'auto' : useMmap,
      cacheReuse: Number(cacheReuse) || 0,
      cores: os.cpus().length
    });
  }

  /**
   * Запустить (или переиспользовать) llama-server с файлом модели.
   * Бросает BackendError с честным текстом ошибки, если загрузить не удалось.
   *
   * Этап 2: если у работающего процесса другой args-key (потоки/batch/mmap/
   * cache-reuse/контекст) — процесс перезапускается с новыми аргументами.
   * Меньший контекст перезапуска НЕ вызывает (grow-only), чтобы частая смена
   * настройки контекста в UI не переигрывала загрузку модели.
   *
   * v0.6.1 + Этап 3: публичный ensureServer сериализован (_startChain):
   * Chat и AI Agent могут стартовать модель ОДНОВРЕМЕННО (профиль balanced
   * допускает 2 параллельных запроса). Без очереди оба вызова доходили до
   * spawn и дважды запускали llama-server на одном порту — проигравший
   * умирал («не смог загрузить модель, прожил 0.4 с»), а второй клон
   * оставался жить и держать RAM. Запуски выстраиваются в цепочку: второй
   * вызов видит уже загруженную модель и переиспользует её; ошибка одного
   * запуска не ломает цепочку для следующих.
   */
  async ensureServer(opts) {
    const run = (this._startChain ?? Promise.resolve())
      .catch(() => {}) // ошибка предыдущего запуска не должна валить текущий
      .then(() => this._ensureServerLocked(opts));
    this._startChain = run.then(() => {}, () => {});
    return run;
  }

  async _ensureServerLocked({ file, contextTokens, threads, threadsBatch, numBatch, useMmap, cacheReuse, profile }) {
    const bin = this.findServerBinary();
    if (!bin) {
      throw new BackendError(
        'llama-server не найден. Установите LiteMind через установщик (runtime в комплекте) или задайте config.backend.serverPath.',
        { code: 'RUNTIME_MISSING', status: 503 }
      );
    }

    let fileSizeBytes = null;
    try { fileSizeBytes = (await fs.promises.stat(path.resolve(file))).size; } catch { /* оценка останется 0 */ }

    const params = this._resolve({ file, contextTokens, threads, threadsBatch, numBatch, useMmap, cacheReuse, profile, fileSizeBytes });
    const key = runtimeStartKey(params);

    // v0.6.1: пока идёт генерация, работающий llama-server — не наша
    // собственность. Смена параметров/модели здесь убивала бы стрим живого
    // запроса (воспроизведено локально: агент получал «Стрим прервался:
    // terminated» после параллельного /api/models/run). Честный отказ вместо
    // тихой порчи: вызывающий повторит запрос после завершения генерации.
    const sameRuntime = this.proc && this.modelFile === params.file && this._startKeyStr === key;
    if (this.proc && !sameRuntime && this._activeStreams > 0) {
      throw new BackendError(
        'Runtime занят: идёт генерация. Смена модели/параметров будет применена после её завершения — повторите запрос.',
        { code: 'RUNTIME_BUSY', status: 409 }
      );
    }

    // Уже загружен (или ещё загружается) тот же файл с теми же параметрами —
    // ждём /health до loadTimeoutMs: параллельный запрос (Chat ↔ Agent) ждёт
    // окончания загрузки, а не убивает её посреди.
    if (sameRuntime) {
      const ok = await this._waitHealth(Math.max(1500, this.loadTimeoutMs));
      if (ok) return this.baseUrl;
      await this._stopProc(true); // мёртвый/завис — чистый перезапуск
    } else if (this.proc && this.modelFile === params.file) {
      // Параметры изменились — честный перезапуск (ТЗ Этапа 2 §8).
      const prev = this._runtimeParams;
      this._restarts++;
      this._lastRestartReason = {
        at: new Date().toISOString(),
        changed: this._paramDiff(prev, params)
      };
      this.log?.info('runtime params changed — restarting llama-server', {
        model: this.modelId, changed: this._lastRestartReason.changed
      });
      await this._stopProc(true);
    } else if (this.proc) {
      await this._stopProc(); // другая модель
    }

    await this._stopProc();
    const port = await freePort(this.host);
    const args = ['--host', this.host, '--port', String(port), ...runtimeArgs(params)];
    if (this.chatTemplate) args.push('--chat-template', this.chatTemplate);

    this.log?.info('starting llama-server', { bin, args: args.join(' ') });
    const startedAt = Date.now();
    const stderrTail = [];
    const proc = spawn(bin, args, { windowsHide: true });
    proc.stdout.on('data', (d) => { const s = String(d); if (s.trim()) this.log?.debug?.('llama-server', { line: s.trim().slice(0, 200) }); });
    proc.stderr.on('data', (d) => {
      const line = String(d).trim();
      if (!line) return;
      stderrTail.push(line);
      if (stderrTail.length > 40) stderrTail.shift();
      this._parseServerTiming(line);
      this.log?.debug?.('llama-server', { line: line.slice(0, 200) });
    });
    proc.on('error', (e) => { this.exitInfo = { error: e.message }; });
    proc.on('close', (code, signal) => { this.exitInfo = { code, signal, stderrTail: stderrTail.slice(-10).join('\n') }; });

    this.proc = proc;
    this.port = port;
    this.baseUrl = `http://${this.host}:${port}`;
    this.modelFile = params.file;
    this.modelId = path.basename(params.file).replace(/\.gguf$/i, '');
    this._startKeyStr = key;
    this._runtimeParams = params;
    this._startedAt = startedAt;
    this._ctxFloor = params.contextTokens;
    this.exitInfo = null;

    // Этап 2 §4/§11: приоритет процесса по профилю — сразу после запуска, по PID.
    applyPriorityToPid(proc.pid, params.profile, this.log);

    // Ждём /health === ok (загрузка модели с диска может занять десятки секунд).
    const deadline = Date.now() + this.loadTimeoutMs;
    while (Date.now() < deadline) {
      if (proc.exitCode !== null || proc.signalCode !== null || this.exitInfo?.error) {
        const tail = (this.exitInfo?.stderrTail || stderrTail.slice(-10).join('\n') || '').slice(-800);
        const loadAttemptedMs = Date.now() - startedAt;
        // Честная диагностика (§11): код выхода/сигнал — в сообщении, а не только в логе.
        const diag = tail
          || (this.exitInfo?.error ? `ошибка запуска: ${this.exitInfo.error}` : '')
          || (this.exitInfo && (this.exitInfo.code != null || this.exitInfo.signal)
            ? `код выхода=${this.exitInfo.code ?? '-'}${this.exitInfo.signal ? `, сигнал=${this.exitInfo.signal}` : ''} — процесс завершился без вывода в stderr`
            : '')
          || 'Процесс завершился без диагностики.';
        this._resetProc();
        throw new BackendError(
          `llama-server не смог загрузить модель: ${path.basename(file)}. Прожил ${Math.round(loadAttemptedMs / 100) / 10} с. ${diag}`,
          { code: 'RUNTIME_START_FAILED', status: 502 }
        );
      }
      const lastBody = await this._health(3000);
      if (lastBody?.status === 'ok') {
        this.lastLoadMs = Date.now() - startedAt;
        this.log?.info('llama-server ready', { model: this.modelId, port, loadMs: this.lastLoadMs });
        return this.baseUrl;
      }
      await new Promise((r) => setTimeout(r, 400));
    }
    const tail = stderrTail.slice(-10).join('\n').slice(-800);
    await this._stopProc(true);
    throw new BackendError(`llama-server не ответил /health за ${Math.round(this.loadTimeoutMs / 1000)} с. ${tail}`, { code: 'RUNTIME_TIMEOUT', status: 504 });
  }

  /** Список изменившихся параметров между двумя конфигурациями (для лога/UI). */
  _paramDiff(prev, next) {
    if (!prev) return null;
    const fields = ['contextTokens', 'threads', 'threadsBatch', 'batchSize', 'ubatchSize', 'useMmap', 'cacheReuse', 'profile'];
    const diff = {};
    for (const f of fields) {
      if (prev[f] !== next[f]) diff[f] = { was: prev[f], became: next[f] };
    }
    return Object.keys(diff).length ? diff : null;
  }

  /** Разобрать строку stderr llama-server с таймингами (print_timings). */
  _parseServerTiming(line) {
    const parsed = parseServerTimingLine(line);
    if (!parsed) return;
    if (parsed.kind === 'prompt_eval') {
      this._timingAcc = { promptEvalMs: parsed.promptEvalMs, promptTokens: parsed.promptTokens, evalMs: null, evalTokens: null, totalMs: null, at: null };
    } else if (parsed.kind === 'eval' && this._timingAcc) {
      this._timingAcc.evalMs = parsed.evalMs;
      this._timingAcc.evalTokens = parsed.evalTokens;
    } else if (parsed.kind === 'total' && this._timingAcc) {
      this._timingAcc.totalMs = parsed.totalMs;
      this._timingAcc.at = Date.now();
      if (this._timingAcc.evalMs != null) {
        this.serverTimings.push(this._timingAcc);
        if (this.serverTimings.length > 32) this.serverTimings.shift();
      }
      this._timingAcc = null;
    }
  }

  // ── Генерация ────────────────────────────────────────────────────────────

  /**
   * Стриминговый чат. Контракт как у OllamaBackend (base.js).
   * Отмена: abort signal закрывает соединение — llama-server останавливает генерацию.
   *
   * Этап 2: таймаут 60 с действует ТОЛЬКО до получения заголовков ответа.
   * Раньше таймер жил весь стрим и убивал генерации длиннее минуты — на слабых
   * машинах это выглядело как «ответ всегда обрывается на ~60-й секунде».
   * Возвращает { text, usage, server } — server несёт честные метаданные загрузки.
   */
  async generate({ model, messages, contextTokens = 4096, maxOutputTokens = 512, threads = 0, threadsBatch = 0,
                   numBatch = 0, useMmap = null, cacheReuse = 0, profile = null, signal, onToken,
                   onServerReady = null, onHeaders = null }) {
    const scanned = await this.scanModels();
    const meta = scanned.find((m) => m.id === model && m.ok);
    if (!meta) {
      const available = scanned.filter((m) => m.ok).map((m) => m.id);
      throw new ModelNotFoundError(model, available);
    }
    if (meta.error && !meta.ok) {
      throw new BackendError(`Файл модели повреждён: ${meta.error}`, { code: 'MODEL_CORRUPT', status: 422 });
    }

    const tServer0 = Date.now();
    const wasRunning = Boolean(this.proc && this.modelFile === meta.file);
    // v0.6.1: считаем активные генерации УЖЕ на этапе загрузки модели — иначе
    // между «health-ok первого запроса» и «першей порцией стрима» остаётся окно,
    // в котором чужой ensureServer с другими параметрами успевает убить runtime.
    this._activeStreams++;
    try {
      const baseUrl = await this.ensureServer({ file: meta.file, contextTokens, threads, threadsBatch, numBatch, useMmap, cacheReuse, profile });
      return await this._generateStreaming({ model, messages, baseUrl, meta, contextTokens, maxOutputTokens,
        threads, threadsBatch, numBatch, useMmap, cacheReuse, profile, signal, onToken, onServerReady, onHeaders,
        tServer0, wasRunning });
    } finally {
      this._activeStreams = Math.max(0, this._activeStreams - 1);
    }
  }

  async _generateStreaming({ model, messages, baseUrl, meta, contextTokens = 4096, maxOutputTokens = 512,
                            threads = 0, threadsBatch = 0, numBatch = 0, useMmap = null, cacheReuse = 0,
                            profile = null, signal, onToken, onServerReady = null, onHeaders = null,
                            tServer0, wasRunning }) {
    const serverInfo = {
      restarted: !wasRunning,
      loadMs: this.lastLoadMs,
      argsKey: this._startKeyStr,
      params: this._runtimeParams ? { ...this._runtimeParams, file: path.basename(this._runtimeParams.file || '') } : null,
      ms: Date.now() - tServer0
    };
    // Этап 2 §2: стадия «запуск/переиспользование сервера» закрыта здесь,
    // а не после генерации — длительности стадий не искажаются.
    onServerReady?.(serverInfo);

    const body = {
      model,
      messages,
      stream: true,
      max_tokens: maxOutputTokens > 0 ? maxOutputTokens : 512,
      stream_options: { include_usage: true }
    };

    // Abort-обвязка держится весь стрим: отключение клиента = остановка генерации.
    const ctrl = new AbortController();
    const onAbort = () => ctrl.abort(signal?.reason);
    signal?.addEventListener('abort', onAbort, { once: true });
    // Таймаут ТОЛЬКО на установку соединения и получение заголовков ответа:
    // после заголовков генерация может длиться сколько угодно — её сторожит
    // stream-idle-watchdog движка (запускается от первого токена).
    const connectTimer = setTimeout(() => ctrl.abort(new Error('connect timeout')), 60000);

    let res;
    let headersMs = null;
    try {
      const t0 = Date.now();
      res = await this.fetch(`${baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctrl.signal
      });
      headersMs = Date.now() - t0;
      // Заголовки получены — соединение установлено, таймер больше не нужен.
      clearTimeout(connectTimer);
      serverInfo.headersMs = headersMs;
      onHeaders?.(headersMs);
    } catch (err) {
      clearTimeout(connectTimer);
      signal?.removeEventListener('abort', onAbort);
      if (signal?.aborted) throw err;
      // v0.6.1: если llama-server умер МЕЖДУ health-ok и этим запросом —
      // диагностируем честно (код выхода + хвост stderr), а не голое
      // «fetch failed». Состояние процесса сбрасываем: следующий запрос
      // перезапустит runtime с нуля.
      const proc = this.proc;
      const died = proc && (proc.exitCode !== null || proc.signalCode !== null);
      let extra = '';
      if (died) {
        const info = this.exitInfo || {};
        const tail = String(info.stderrTail || '').slice(-400);
        extra = ` Процесс llama-server завершился (код ${info.code ?? '?'}${info.signal ? `, сигнал ${info.signal}` : ''}).${tail ? ` stderr: ${tail}` : ''}`;
        this._resetProc();
      }
      throw new BackendError(`Запрос к llama-server (${baseUrl}) не удался: ${err.message}.${extra || ' Процесс мог завершиться — попробуйте снова.'}`, { code: died ? 'RUNTIME_DIED' : 'BACKEND_UNREACHABLE', cause: err });
    }

    if (res.status === 404) {
      signal?.removeEventListener('abort', onAbort);
      const available = (await this.listModels()).map((m) => m.id);
      throw new ModelNotFoundError(model, available);
    }
    if (!res.ok) {
      signal?.removeEventListener('abort', onAbort);
      const text = await res.text().catch(() => '');
      throw new BackendError(`llama-server вернул HTTP ${res.status}${text ? `: ${text.slice(0, 300)}` : ''}`, { code: 'BACKEND_ERROR', status: res.status });
    }

    let text = '';
    let promptTokens = 0;
    let completionTokens = 0;
    let buffer = '';

    const detach = () => { signal?.removeEventListener('abort', onAbort); };
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 1);
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (payload === '[DONE]') continue;
          let chunk;
          try { chunk = JSON.parse(payload); } catch { continue; }
          if (chunk.error) throw new BackendError(`llama-server: ${chunk.error.message ?? JSON.stringify(chunk.error).slice(0, 200)}`, { code: 'BACKEND_ERROR' });
          const delta = chunk.choices?.[0]?.delta?.content ?? '';
          if (delta) {
            text += delta;
            onToken?.(delta, chunk);
          }
          if (chunk.usage) {
            promptTokens = chunk.usage.prompt_tokens ?? promptTokens;
            completionTokens = chunk.usage.completion_tokens ?? completionTokens;
          }
        }
      }
    } catch (err) {
      if (signal?.aborted || ctrl.signal.aborted) {
        const e = new Error('Generation cancelled');
        e.code = 'CANCELLED';
        e.name = 'CancelledError';
        throw e;
      }
      // v0.6.1: смерть llama-server посреди стрима — та же честная диагностика:
      // код выхода и хвост stderr вместо голого «terminated».
      const proc = this.proc;
      const died = proc && (proc.exitCode !== null || proc.signalCode !== null);
      if (died) {
        const info = this.exitInfo || {};
        const tail = String(info.stderrTail || '').slice(-400);
        this._resetProc();
        throw new BackendError(`Стрим прервался: llama-server завершился (код ${info.code ?? '?'}${info.signal ? `, сигнал ${info.signal}` : ''}).${tail ? ` stderr: ${tail}` : ' Процесс завершился без диагностики.'}`, { code: 'RUNTIME_DIED', cause: err });
      }
      throw new BackendError(`Стрим прервался: ${err.message}`, { code: 'BACKEND_ERROR', cause: err });
    } finally {
      detach();
    }

    if (signal?.aborted || ctrl.signal.aborted) {
      const e = new Error('Generation cancelled');
      e.code = 'CANCELLED';
      e.name = 'CancelledError';
      throw e;
    }

    return { text, usage: { promptTokens, completionTokens }, server: serverInfo };
  }

  // ── Выгрузка и удаление ──────────────────────────────────────────────────

  /** Выгрузить модель из RAM: терминировать llama-server. Идемпотентно. */
  async unload(modelId = null) {
    if (!this.proc) return { unloaded: [] };
    if (modelId && this.modelId && this.modelId !== modelId) return { unloaded: [] };
    const was = this.modelId;
    await this._stopProc();
    this.log?.info('model unloaded from RAM', { model: was });
    return { unloaded: was ? [was] : [] };
  }

  /**
   * Удалить файл модели на диске (ТЗ v0.4: честное удаление).
   * Если модель загружена — сначала выгружает процесс, затем удаляет файл.
   */
  async deleteModel(modelId) {
    const scanned = await this.scanModels();
    const meta = scanned.find((m) => m.id === modelId);
    if (!meta) {
      // Обновим кэш принудительно — модель могла появиться только что.
      this._scannedAt = 0;
      const fresh = await this.scanModels();
      const again = fresh.find((m) => m.id === modelId);
      if (!again) throw new BackendError(`Модель "${modelId}" не найдена в ${this.rootDir}`, { code: 'MODEL_NOT_FOUND', status: 404 });
      return this._removeFile(again);
    }
    return this._removeFile(meta);
  }

  async _removeFile(meta) {
    if (this.modelId === meta.id && this.proc) await this._stopProc();
    // Защита: удаляем только файлы из папки моделей.
    const resolved = path.resolve(meta.file);
    if (!resolved.startsWith(path.resolve(this.rootDir))) {
      throw new BackendError('Отказ удалять файл вне папки моделей', { code: 'FORBIDDEN_PATH', status: 403 });
    }
    await fs.promises.rm(resolved, { force: true });
    this._scannedAt = 0; // пересканировать при следующем listModels
    const left = await this.scanModels();
    this.log?.info('model file deleted', { model: meta.id, file: resolved, remaining: left.length });
    return { deleted: meta.id, file: resolved, remaining: left.filter((m) => m.ok).map((m) => m.id) };
  }

  /** Полная остановка runtime (ТЗ §16). */
  async shutdown() {
    await this._stopProc();
    return { stopped: true };
  }
}
