// Diagnostics — structured JSONL log + performance metrics.
import fs from 'node:fs';
import path from 'node:path';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

export class Logger {
  constructor({ dir = null, level = 'info', console: useConsole = true } = {}) {
    this.dir = dir;
    this.level = LEVELS[level] ?? LEVELS.info;
    this.useConsole = useConsole;
    this.file = null;
    if (dir) {
      try {
        fs.mkdirSync(dir, { recursive: true });
        this.file = path.join(dir, `litemind-${new Date().toISOString().slice(0, 10)}.jsonl`);
      } catch {
        this.file = null;
      }
    }
  }

  _write(level, msg, data) {
    if ((LEVELS[level] ?? 0) < this.level) return;
    const rec = { ts: new Date().toISOString(), level, msg, ...(data || {}) };
    if (this.useConsole) {
      const extra = data && Object.keys(data).length ? ` ${JSON.stringify(data)}` : '';
      const line = `[${rec.ts}] ${level.toUpperCase()} ${msg}${extra}`;
      (level === 'error' ? process.stderr : process.stdout).write(line + '\n');
    }
    if (this.file) {
      try { fs.appendFileSync(this.file, JSON.stringify(rec) + '\n'); } catch { /* diagnostics must never crash the app */ }
    }
    this.last = rec;
    this.emit?.(rec);
  }

  debug(msg, data) { this._write('debug', msg, data); }
  info(msg, data) { this._write('info', msg, data); }
  warn(msg, data) { this._write('warn', msg, data); }
  error(msg, data) { this._write('error', msg, data); }
}

/** Records per-request performance numbers for docs/BENCHMARKS.md and /api/metrics. */
export class PerfRecorder {
  constructor({ max = 200 } = {}) {
    this.samples = [];
    this.max = max;
    this.counters = { requests: 0, errors: 0, cancelled: 0, timeouts: 0, tokens: 0 };
  }

  record(sample) {
    this.samples.push({ at: Date.now(), ...sample });
    if (this.samples.length > this.max) this.samples.shift();
    this.counters.requests++;
    if (sample.error) this.counters.errors++;
    if (sample.cancelled) this.counters.cancelled++;
    if (sample.timedOut) this.counters.timeouts++;
    if (sample.outputTokens) this.counters.tokens += sample.outputTokens;
  }

  summary() {
    const ok = this.samples.filter((s) => !s.error && !s.cancelled);
    const ttft = ok.map((s) => s.ttftMs).filter((v) => Number.isFinite(v));
    const dur = ok.map((s) => s.durationMs).filter((v) => Number.isFinite(v));
    const tps = ok.map((s) => s.tokensPerSecond).filter((v) => Number.isFinite(v));
    // Этап 2: честное разделение — TTFT готового runtime и загрузка модели.
    const ttftPure = ok.map((s) => s.ttftAfterServerMs).filter((v) => Number.isFinite(v));
    const loadMs = ok.map((s) => s.modelLoadMs).filter((v) => Number.isFinite(v));
    const avg = (a) => (a.length ? Math.round((a.reduce((x, y) => x + y, 0) / a.length) * 10) / 10 : null);
    const pct = (a, p) => {
      if (!a.length) return null;
      const s = [...a].sort((x, y) => x - y);
      return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
    };
    return {
      counters: { ...this.counters },
      ttftMs: { avg: avg(ttft), p95: pct(ttft, 95), min: ttft.length ? Math.min(...ttft) : null },
      ttftAfterServerMs: { avg: avg(ttftPure), p95: pct(ttftPure, 95), n: ttftPure.length },
      modelLoadMs: { avg: avg(loadMs), max: loadMs.length ? Math.max(...loadMs) : null, n: loadMs.length },
      durationMs: { avg: avg(dur), p95: pct(dur, 95) },
      tokensPerSecond: { avg: avg(tps), best: tps.length ? Math.max(...tps) : null },
      samples: this.samples.length
    };
  }
}
