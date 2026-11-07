// LiteMind Core — request lifecycle, queueing, cancellation, timeouts, model unload.
// Owns policy (Low Resource limits, memory gate); never implements inference itself.
import { randomUUID } from 'node:crypto';
import { activeProfile, saveConfig } from '../config.js';
import { checkStartBudget, estimateModelMemoryMb } from '../resource/gate.js';
import { applyBackendPriority } from '../resource/priority.js';
import { prepareRequest } from '../adaptive/controller.js';
import { BackendError } from '../backends/base.js';

export class EngineError extends Error {
  constructor(message, { code = 'ENGINE_ERROR', status = 500, details = null } = {}) {
    super(message);
    this.name = 'EngineError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export class Engine {
  constructor({ config, backend, sampler, logger, perf, now = () => Date.now() }) {
    this.config = config;
    this.backend = backend;
    this.sampler = sampler;
    this.log = logger;
    this.perf = perf;
    this.now = now;

    this.health = { ok: false, checked: false, version: null, error: null };
    this.requests = new Map(); // id -> record
    this.queue = [];
    this.active = 0;
    this._idleTimer = null;
    this._modelsCache = { at: 0, models: null, ttlMs: 4000 };
    this.stats = { enqueued: 0, rejectedQueueFull: 0, rejectedBudget: 0, cancelled: 0, timeouts: 0, completed: 0, failed: 0 };
    this.adaptiveStats = { compacted: 0, tokensSaved: 0, byComplexity: { simple: 0, file: 0, project: 0, hard: 0 } };
  }

  get profile() {
    return activeProfile(this.config);
  }

  setProfile(name) {
    if (!this.config.profiles[name]) {
      throw new EngineError(`Unknown profile "${name}". Available: ${Object.keys(this.config.profiles).join(', ')}`, { code: 'BAD_PROFILE', status: 400 });
    }
    this.config.profile = name;
    // Приоритет процессов инференса (Бережный → BelowNormal). Fire-and-forget.
    applyBackendPriority({ profile: name, log: this.log });
    this.log.info('profile switched', { profile: name });
    return this.profile;
  }

  async start() {
    this.health = { ok: false, checked: true, version: null, error: null, at: this.now() };
    const det = await this.backend.detect();
    this.health = { ok: det.ok, checked: true, version: det.version ?? null, error: det.error ?? null, at: this.now() };
    if (det.ok) this.log.info('backend detected', { type: this.backend.type, version: det.version, baseUrl: this.config.backend.baseUrl });
    else this.log.warn('backend not available', { error: det.error });
    return this.health;
  }

  /** Re-detect lazily when the backend was down before. */
  async ensureHealthy() {
    if (this.health.ok) return true;
    const det = await this.backend.detect();
    this.health = { ok: det.ok, checked: true, version: det.version ?? null, error: det.error ?? null, at: this.now() };
    return det.ok;
  }

  async listModels({ force = false } = {}) {
    const now = this.now();
    if (!force && this._modelsCache.models && now - this._modelsCache.at < this._modelsCache.ttlMs) {
      return this._modelsCache.models;
    }
    const models = await this.backend.listModels();
    this._modelsCache = { at: now, models };
    return models;
  }

  async status({ refreshModels = false } = {}) {
    const metrics = this.sampler?.latest ?? null;
    const out = {
      engine: { name: 'LiteMind Engine', version: '0.1.0', profile: this.config.profile, profileLabel: this.profile.label },
      backend: { type: this.backend.type, baseUrl: this.config.backend.baseUrl, health: this.health, capabilities: this.backend.capabilities() },
      queue: { active: this.active, waiting: this.queue.length, limit: this.profile.maxConcurrentRequests, queueLimit: this.profile.queueLimit },
      limits: {
        contextTokens: this.profile.contextTokens,
        maxOutputTokens: this.profile.maxOutputTokens,
        cpuThreads: this.profile.cpuThreads,
        idleUnloadSeconds: this.profile.idleUnloadSeconds,
        requestTimeoutMs: this.profile.requestTimeoutMs,
        memoryReserveMb: this.profile.memoryReserveMb
      },
      requests: [...this.requests.values()].slice(-10).reverse(),
      metrics,
      stats: { ...this.stats },
      adaptive: this.adaptiveStats,
      optimizations: this.config.optimizations ?? {},
      perf: this.perf?.summary() ?? null,
      models: [],
      modelsError: null
    };
    if (this.health.ok || refreshModels) {
      try {
        out.models = await this.listModels({ force: refreshModels });
      } catch (err) {
        out.modelsError = err.message;
      }
    } else {
      out.modelsError = this.health.error ?? 'backend not detected';
    }
    return out;
  }

  _record(record, patch) {
    Object.assign(record, patch);
    this.requests.set(record.id, record);
    if (this.requests.size > 200) {
      const oldest = [...this.requests.keys()].slice(0, this.requests.size - 200);
      for (const k of oldest) this.requests.delete(k);
    }
  }

  async _acquire(record) {
    const limit = this.profile.maxConcurrentRequests;
    if (this.active < limit) {
      this.active++;
      return;
    }
    if (this.queue.length >= this.profile.queueLimit) {
      this.stats.rejectedQueueFull++;
      throw new EngineError(
        `Queue is full (${this.profile.queueLimit} waiting, ${limit} active). Low Resource profile allows one request at a time — wait for the current generation to finish.`,
        { code: 'QUEUE_FULL', status: 429 }
      );
    }
    this.stats.enqueued++;
    this._record(record, { state: 'queued' });
    await new Promise((resolve, reject) => {
      this.queue.push({ record, resolve, reject });
    });
    this.active++; // hand-off slot: _release() only decremented, acquisition counts here
    record._acquired = true;
  }

  _release() {
    this.active = Math.max(0, this.active - 1);
    const next = this.queue.shift();
    if (next) {
      this._record(next.record, { state: 'running', startedAt: this.now() });
      next.resolve();
    } else {
      this._scheduleIdleUnload();
    }
  }

  /**
   * Run one chat completion. Honours: queue limit, memory gate, cancellation,
   * request timeout, stream idle watchdog. Always releases its slot.
   */
  async generate({ model, messages, contextTokens, maxOutputTokens, threads, signal, onToken }) {
    const p = this.profile;
    const ctx = Number(contextTokens) > 0 ? Number(contextTokens) : p.contextTokens;
    const maxOut = Number(maxOutputTokens) > 0 ? Number(maxOutputTokens) : p.maxOutputTokens;
    let thr = threads === undefined || threads === null ? p.cpuThreads : Number(threads);
    // Автооптимизация: измеренная для модели конфигурация потоков имеет приоритет
    // над профилем (если вызывающий не передал threads явно).
    const savedOpt = this.config.optimizations?.[model];
    if ((threads === undefined || threads === null) && savedOpt?.threads) thr = savedOpt.threads;

    const record = {
      id: `req_${randomUUID().slice(0, 8)}`,
      model,
      state: 'new',
      createdAt: this.now(),
      startedAt: null,
      finishedAt: null,
      error: null,
      ttftMs: null,
      outputTokens: 0
    };
    this.requests.set(record.id, record);

    // --- Adaptive Controller: сложность, уплотнение контекста, бюджет генерации ---
    const prepared = prepareRequest({
      messages,
      contextTokens: ctx,
      maxOutputTokens: maxOut,
      adaptive: this.config.adaptive ?? {}
    });
    if (prepared.meta?.adaptive === 'on') {
      if (prepared.meta.compaction) {
        this.adaptiveStats.compacted++;
        this.adaptiveStats.tokensSaved += prepared.meta.compaction.dropped;
      }
      if (prepared.complexity) this.adaptiveStats.byComplexity[prepared.complexity]++;
    }

    const ctrl = new AbortController();
    record._ctrl = ctrl;
    const onOuterAbort = () => ctrl.abort(new Error('cancelled by client'));
    if (signal) {
      if (signal.aborted) onOuterAbort();
      else signal.addEventListener('abort', onOuterAbort, { once: true });
    }

    let timedOut = false;
    let cancelled = false;
    let overloaded = false;
    let watchdog = null;
    let overloadWatch = null;
    const armWatchdog = () => {
      if (watchdog) clearTimeout(watchdog);
      watchdog = setTimeout(() => {
        timedOut = true;
        ctrl.abort(new Error(`stream idle timeout after ${this.config.backend.streamIdleTimeoutMs} ms`));
      }, this.config.backend.streamIdleTimeoutMs);
      watchdog.unref?.();
    };

    const overallTimer = setTimeout(() => {
      timedOut = true;
      ctrl.abort(new Error(`request timeout after ${p.requestTimeoutMs} ms`));
    }, p.requestTimeoutMs);
    overallTimer.unref?.();

    let acquired = false;
    try {
      await this._acquire(record);
      acquired = true;
      this._clearIdleTimer();
      this._record(record, { state: 'running', startedAt: this.now() });
      if (ctrl.signal.aborted) cancelled = true;

      // --- memory gate (never start a model that does not fit) ---
      if (!cancelled) {
        const gate = await this._memoryGate(model, ctx);
        if (!gate.allowed) {
          this.stats.rejectedBudget++;
          throw new EngineError(gate.reason, { code: 'MEMORY_BUDGET', status: 503, details: gate });
        }
        if (gate.severity === 'warn') this.log.warn('memory forecast warning', { model, ...gate });
      }

      // --- контроль памяти ВО ВРЕМЯ генерации (защита Windows от зависаний) ---
      overloadWatch = this._startOverloadWatch(ctrl, () => { overloaded = true; });

      const started = this.now();
      let firstTokenAt = null;

      const wrappedOnToken = (delta, info) => {
        armWatchdog();
        if (firstTokenAt === null) {
          firstTokenAt = this.now();
          record.ttftMs = firstTokenAt - started;
        }
        record.outputTokens++;
        onToken?.(delta, info);
      };
      armWatchdog();

      const result = await this.backend.generate({
        model,
        messages: prepared.messages,
        contextTokens: prepared.contextTokens,
        maxOutputTokens: prepared.maxOutputTokens,
        threads: thr,
        numBatch: p.numBatch ?? 0,
        useMmap: this.config.backend.useMmap ?? null,
        signal: ctrl.signal,
        onToken: wrappedOnToken
      });

      const finishedAt = this.now();
      const durationMs = finishedAt - started;
      const outputTokens = result.usage?.completionTokens || record.outputTokens;
      const sample = {
        requestId: record.id,
        model,
        complexity: prepared.complexity,
        durationMs,
        ttftMs: record.ttftMs,
        outputTokens,
        tokensPerSecond: durationMs > 0 && outputTokens ? Math.round((outputTokens / (durationMs / 1000)) * 10) / 10 : null,
        queuedMs: record.startedAt - record.createdAt
      };
      this.perf?.record(sample);
      this._trackModelPerformance(model, sample);
      this.stats.completed++;
      this._record(record, { state: 'done', finishedAt, outputTokens, durationMs, ttftMs: record.ttftMs });
      return { ...result, requestId: record.id, timings: sample };
    } catch (err) {
      if (overloaded) {
        this.stats.failed++;
        // Безопасно выгружаем модель: RAM должна вернуться системе сразу.
        this.backend.unload(model).catch(() => {});
        const e = new EngineError(
          'Обнаружена опасная нагрузка на память — генерация остановлена для защиты Windows. ' +
            'Попробуйте меньший контекст, более лёгкий квант или профиль «Бережный».',
          { code: 'MEMORY_OVERLOAD', status: 503 }
        );
        this.perf?.record({ requestId: record.id, model, error: e.message, overloaded: true });
        this._record(record, { state: 'error', finishedAt: this.now(), error: e.message });
        this.log.warn('generation stopped: memory overload', { id: record.id, model });
        throw e;
      }
      if (timedOut && !signal?.aborted) {
        this.stats.timeouts++;
        const e = new EngineError(
          err.message?.includes('timeout') ? err.message : `Request timed out after ${p.requestTimeoutMs} ms`,
          { code: 'TIMEOUT', status: 504 }
        );
        this.perf?.record({ requestId: record.id, model, error: e.message, timedOut: true });
        this._record(record, { state: 'timeout', finishedAt: this.now(), error: e.message });
        this.log.warn('request timed out', { id: record.id, model });
        throw e;
      }
      if (ctrl.signal.aborted || err?.code === 'CANCELLED' || err?.name === 'AbortError') {
        cancelled = true;
      }
      if (cancelled) {
        this.stats.cancelled++;
        const e = new EngineError('Generation cancelled', { code: 'CANCELLED', status: 499 });
        this.perf?.record({ requestId: record.id, model, cancelled: true });
        this._record(record, { state: 'cancelled', finishedAt: this.now(), error: 'cancelled' });
        this.log.info('request cancelled', { id: record.id, model });
        throw e;
      }
      this.stats.failed++;
      const status = err instanceof BackendError || err instanceof EngineError ? err.status : 500;
      const code = err.code || 'GENERATION_FAILED';
      if (code === 'BACKEND_UNREACHABLE') {
        this.health = { ...this.health, ok: false, error: err.message, at: this.now() };
      }
      this.perf?.record({ requestId: record.id, model, error: err.message });
      this._record(record, { state: 'error', finishedAt: this.now(), error: err.message });
      this.log.error('request failed', { id: record.id, model, code, error: err.message });
      const wrapped = new EngineError(err.message, { code, status: status || 500 });
      wrapped.cause = err;
      throw wrapped;
    } finally {
      clearTimeout(overallTimer);
      if (watchdog) clearTimeout(watchdog);
      if (overloadWatch) clearInterval(overloadWatch);
      signal?.removeEventListener('abort', onOuterAbort);
      if (acquired) this._release();
    }
  }

  /**
   * Периодическая проверка памяти во время генерации. При опасном уровне
   * (выше maxRamUsageFraction + 15%) прерывает генерацию — Windows остаётся
   * отзывчивой, модель затем выгружается вызывающим кодом.
   */
  _startOverloadWatch(ctrl, onOverload) {
    const interval = Math.max(1000, this.config.resource.pollIntervalMs || 2000);
    const critical = (this.config.resource.maxRamUsageFraction ?? 0.75) + 0.15;
    const timer = setInterval(() => {
      Promise.resolve(this.sampler?.sample?.())
        .then((m) => {
          if (!m?.totalRamMb) return;
          const frac = (m.totalRamMb - (m.availableRamMb ?? m.totalRamMb)) / m.totalRamMb;
          if (frac >= critical && !ctrl.signal.aborted) {
            this.log.warn('memory overload detected', { usedFraction: Math.round(frac * 100) + '%' });
            onOverload();
            ctrl.abort(new Error('memory overload'));
          }
        })
        .catch(() => {});
    }, interval);
    timer.unref?.();
    return timer;
  }

  /**
   * Самообучение (ТЗ §7): живые метрики каждой модели (EMA tokens/sec, TTFT,
   * число запросов, стабильность) копятся в config.optimizations и периодически
   * пишутся на диск. Бенчмарк-метки (threads/measuredAt) не перезаписываются.
   */
  _trackModelPerformance(model, sample) {
    const o = this.config.optimizations ?? (this.config.optimizations = {});
    const cur = o[model] ?? {};
    const ema = (prev, val, k = 0.3) => {
      if (val == null || !Number.isFinite(val)) return prev ?? null;
      if (prev == null || !Number.isFinite(prev)) return Math.round(val * 10) / 10;
      return Math.round((prev * (1 - k) + val * k) * 10) / 10;
    };
    o[model] = {
      ...cur,
      tokensPerSecond: ema(cur.tokensPerSecond, sample.tokensPerSecond),
      ttftMs: ema(cur.ttftMs, sample.ttftMs),
      requests: (cur.requests ?? 0) + 1,
      lastSeenAt: new Date().toISOString()
    };
    if (!this._perfPersistAt || Date.now() - this._perfPersistAt > 60000) {
      this._perfPersistAt = Date.now();
      try { saveConfig(this.config, this.config.paths.configPath); } catch { /* не критично */ }
    }
  }

  async _memoryGate(model, contextTokens) {
    const p = this.profile;
    let modelSize = null;
    try {
      const models = await this.listModels();
      modelSize = models.find((m) => m.id === model || m.id.split(':')[0] === model)?.sizeBytes ?? null;
    } catch {
      modelSize = null;
    }
    const metrics = await (this.sampler?.sample?.() ?? Promise.resolve(null));
    const estimatedMb = estimateModelMemoryMb({
      modelSizeBytes: modelSize,
      contextTokens,
      kvOverheadKbPerToken: p.kvOverheadKbPerToken
    });
    return checkStartBudget({
      estimatedMb,
      availableRamMb: metrics?.availableRamMb ?? 0,
      totalRamMb: metrics?.totalRamMb ?? 0,
      usedRamMb: metrics?.usedRamMb ?? null,
      reserveMb: p.memoryReserveMb,
      maxRamUsageFraction: this.config.resource.maxRamUsageFraction,
      blockOnUnknownEstimate: p.blockOnUnknownEstimate
    });
  }

  /** Cancel one in-flight/queued request by id. */
  cancel(requestId) {
    const rec = this.requests.get(requestId);
    if (!rec) return { cancelled: false, reason: 'unknown request id' };
    if (['done', 'error', 'cancelled', 'timeout'].includes(rec.state)) return { cancelled: false, reason: `request already ${rec.state}` };
    const entry = this.queue.find((q) => q.record.id === requestId);
    if (entry) {
      this.queue = this.queue.filter((q) => q !== entry);
      this._record(rec, { state: 'cancelled', finishedAt: this.now(), error: 'cancelled while queued' });
      // stats.cancelled is counted by generate()'s catch to avoid double counting
      entry.reject(new EngineError('Generation cancelled while queued', { code: 'CANCELLED', status: 499 }));
      return { cancelled: true };
    }
    const signalled = Boolean(rec._ctrl && !rec._ctrl.signal.aborted && (rec._ctrl.abort(new Error('cancelled by user')), true));
    return { cancelled: true, signalled };
  }

  /** Cancel everything (stop button). */
  cancelAll() {
    let n = 0;
    for (const rec of this.requests.values()) {
      if (['queued', 'running', 'new'].includes(rec.state)) {
        if (this.cancel(rec.id).cancelled) n++;
      }
    }
    return { cancelled: n };
  }

  async unload(modelId = null) {
    const res = await this.backend.unload(modelId);
    this.log.info('model unloaded', { models: res.unloaded, model: modelId ?? '(all)' });
    this._clearIdleTimer();
    return res;
  }

  _clearIdleTimer() {
    if (this._idleTimer) {
      clearTimeout(this._idleTimer);
      this._idleTimer = null;
    }
  }

  /** Unload idle models after profile.idleUnloadSeconds (0 disables). */
  _scheduleIdleUnload() {
    this._clearIdleTimer();
    const secs = this.profile.idleUnloadSeconds;
    if (!secs || secs <= 0 || this.active > 0) return;
    this._idleTimer = setTimeout(() => {
      this._idleTimer = null;
      if (this.active > 0) return;
      this.backend.unload(null)
        .then((r) => this.log.info('idle unload', { models: r.unloaded }))
        .catch((e) => this.log.warn('idle unload failed', { error: e.message }));
    }, secs * 1000);
    this._idleTimer.unref?.();
  }

  shutdown() {
    this._clearIdleTimer();
    this.cancelAll();
    this.sampler?.stop?.();
  }
}
