// Resource Manager — RAM / CPU / paging monitoring.
//
// Этап 2 §2/§9: сэмплер ПЕРЕПИСАН на чистый Node без внешних процессов.
// Раньше каждый сэмпл (каждые 2 с) запускал powershell.exe с тремя WMI-запросами
// (Get-CimInstance) — на слабых машинах (Celeron N5095A) вызов регулярно выходил
// за 8-секундный таймаут, collectMetrics уходил в osFallback, а тот на Windows
// давал cpuPercent = 0 (нет /proc/loadavg). Пользователь видел «CPU около 0%»,
// хотя CPU был занят генерацией. Кроме того, постоянный запуск powershell —
// лишний фоновый процесс и лишняя работа для Defender (ТЗ §9).
//
// Теперь:
//   - RAM: os.totalmem()/os.freemem() — GlobalMemoryStatusEx, мгновенно и точно
//     («доступно» включает standby-кэш, как в Диспетчере задач Windows);
//   - CPU: дельта os.cpus() между сэмплами — точный агрегат по всем ядрам;
//   - paging (Windows): честно «недоступно» без отдельного WMI-вызова; признак
//     paging'а при необходимости уточняется движком в момент решения (gate).
// Этот модуль НИКОГДА не трогает чужие процессы: он только наблюдает.
import fs from 'node:fs';
import os from 'node:os';

/** Снимок суммарного времени ядер CPU (для расчёта загрузки по дельте). */
function cpuTimesSnapshot() {
  let idle = 0;
  let total = 0;
  try {
    for (const c of os.cpus()) {
      idle += c.times.idle;
      total += c.times.user + c.times.nice + c.times.sys + c.times.idle + c.times.irq;
    }
  } catch { /* os.cpus() не должен падать, но диагностика не бросает */ }
  return { idle, total };
}

/**
 * Снимок загрузки машины. Быстрее 1 мс, без подпроцессов, зависит только от os.
 * cpuPercent считается сэмплером по дельте (здесь null при первом сэмпле).
 */
export async function collectMetrics() {
  const totalMb = Math.round(os.totalmem() / 1048576);
  const availableMb = Math.round(os.freemem() / 1048576);
  return {
    totalRamMb: totalMb,
    availableRamMb: availableMb,
    usedRamMb: Math.round((totalMb - availableMb) * 10) / 10,
    cpuPercent: null,          // заполнит сэмплер по дельте os.cpus()
    hardFaultsPerSec: null,    // честно: без WMI не измеряем на регулярной основе
    committedPercent: null,
    vramTotalMb: null,
    gpuNames: [],
    source: 'node-os',
    at: Date.now()
  };
}

function parseProcMeminfo() {
  const text = fs.readFileSync('/proc/meminfo', 'utf8');
  const get = (key) => {
    const m = text.match(new RegExp(`^${key}:\\s+(\\d+)\\s*kB`, 'm'));
    return m ? Number(m[1]) * 1024 : null;
  };
  const total = get('MemTotal');
  const avail = get('MemAvailable') ?? get('MemFree');
  if (total == null || avail == null) return null;
  const totalMb = Math.round((total / 1048576) * 10) / 10;
  const availMb = Math.round((avail / 1048576) * 10) / 10;
  return { totalRamMb: totalMb, availableRamMb: availMb, usedRamMb: Math.round((totalMb - availMb) * 10) / 10 };
}

/** Уточнение RAM на Linux по /proc/meminfo (MemAvailable точнее os.freemem).
 *  Применяется только к данным дефолтного провайдера — инжектированные
 *  провайдеры (тесты) не перезаписываются. */
function refineWithProcMeminfo(metrics) {
  if (!metrics || metrics.source !== 'node-os') return metrics;
  try {
    const p = parseProcMeminfo();
    if (p) return { ...metrics, ...p, source: 'procfs' };
  } catch { /* не Linux — оставляем как есть */ }
  return metrics;
}

/**
 * Периодический сэмплер, используется движком и дашбордом.
 * CPU% считается по дельте os.cpus() между вызовами sample().
 * stop() завершает таймер; ошибки записываются, но никогда не бросаются.
 */
export class MetricsSampler {
  constructor({ intervalMs = 2000, provider = collectMetrics, onError = null } = {}) {
    this.intervalMs = intervalMs;
    this.provider = provider;
    this.onError = onError;
    this.latest = null;
    this.history = [];
    this.maxHistory = 180;
    this._timer = null;
    this._busy = false;
    this._lastCpu = null; // { idle, total }
  }

  async sample() {
    try {
      const m = await this.provider();
      this.latest = m ? { ...m } : m;
      if (this.latest) {
        // CPU% по дельте времён ядер: точный агрегат, без подпроцессов.
        const snap = cpuTimesSnapshot();
        if (this._lastCpu && snap.total > this._lastCpu.total) {
          const dTotal = snap.total - this._lastCpu.total;
          const dIdle = snap.idle - this._lastCpu.idle;
          this.latest.cpuPercent = Math.max(0, Math.min(100, Math.round((1 - dIdle / dTotal) * 1000) / 10));
        }
        this._lastCpu = snap;
        this.latest = refineWithProcMeminfo(this.latest);
        this.latest.at = Date.now();
        this.history.push({
          at: this.latest.at,
          cpu: this.latest.cpuPercent,
          used: this.latest.usedRamMb,
          available: this.latest.availableRamMb
        });
        if (this.history.length > this.maxHistory) this.history.shift();
      }
    } catch (err) {
      this.lastError = err.message;
      this.onError?.(err);
    }
    return this.latest;
  }

  start() {
    if (this._timer) return;
    this._timer = setInterval(() => {
      if (this._busy) return;
      this._busy = true;
      this.sample().finally(() => { this._busy = false; });
    }, this.intervalMs);
    this._timer.unref?.();
    this.sample();
    return this.latest;
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }
}
