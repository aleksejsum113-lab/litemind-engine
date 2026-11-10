// Этап 2 §2 — замер стадий обработки запроса с временными метками.
//
// Требование ТЗ: «добавить измерения с временными метками и длительностью» для
// каждой стадии движения запроса — от получения от UI до освобождения ресурсов.
// StageTrace — минимальный, без зависимостей трассировщик: mark(name) открывает
// стадию, end(name) закрывает и фиксирует длительность. Итог — плоский список
// стадий, пригодный для JSON API и таблицы диагностики «Стадия → время».
//
// Принцип честности: если стадия не измерима на данной платформе (например,
// токенизация происходит внутри llama-server), она помечается как
// unavailable — не выдумываем цифры.

const CLOSED = Symbol('closed');

/**
 * Трассировщик стадий одного запроса.
 * Не бросает исключений: диагностика не должна ломать генерацию.
 */
export class StageTrace {
  constructor({ now = () => Date.now(), requestId = null, model = null } = {}) {
    this.now = now;
    this.requestId = requestId;
    this.model = model;
    this.list = []; // { stage, at, durMs, meta }
    this._open = new Map(); // name -> at
  }

  /** Открыть стадию. Повторный mark() той же стадии перезаписывает начало. */
  mark(name, meta = null) {
    this._open.set(name, { at: this.now(), meta });
  }

  /**
   * Закрыть стадию и записать длительность.
   * @returns {number|null} длительность в мс (null — стадия не была открыта)
   */
  end(name, meta = null) {
    const opened = this._open.get(name);
    if (!opened) {
      // Стадия закрывается без начала — фиксируем мгновенное событие, не выдумывая длительность.
      this.list.push({ stage: name, at: this.now(), durMs: null, meta: { unavailable: true, ...(meta || {}) } });
      return null;
    }
    this._open.delete(name);
    const durMs = Math.max(0, this.now() - opened.at);
    this.list.push({ stage: name, at: opened.at, durMs, meta: { ...(opened.meta || {}), ...(meta || {}) } });
    return durMs;
  }

  /** Мгновенное событие (открыть и тут же закрыть). */
  point(name, meta = null) {
    this.mark(name, meta);
    return this.end(name, meta);
  }

  /** Открыта ли стадия. */
  isOpen(name) {
    return this._open.has(name);
  }

  /** Плоский список стадий для JSON. */
  get stages() {
    return this.list.map((s) => ({ ...s }));
  }

  /** Длительность стадии или null. */
  durationOf(name) {
    const s = this.list.find((x) => x.stage === name && x.durMs != null);
    return s ? s.durMs : null;
  }

  toJSON() {
    return { requestId: this.requestId, model: this.model, stages: this.stages };
  }
}

/**
 * Сводка по стадиям за последние N запросов (для /api/perf и UI).
 * @param {Array<{stages: Array<{stage:string,durMs:number|null}>}>} traces
 */
export function summarizeStages(traces) {
  const acc = new Map(); // stage -> { count, durations[] }
  for (const t of traces) {
    const seen = new Set();
    for (const s of t.stages || []) {
      if (seen.has(s.stage)) continue; // одна стадия учитывается один раз на запрос
      seen.add(s.stage);
      const a = acc.get(s.stage) ?? { count: 0, durations: [] };
      a.count++;
      if (s.durMs != null) a.durations.push(s.durMs);
      acc.set(s.stage, a);
    }
  }
  const out = {};
  for (const [stage, a] of acc) {
    const sorted = [...a.durations].sort((x, y) => x - y);
    out[stage] = {
      count: a.count,
      avgMs: a.durations.length ? Math.round(a.durations.reduce((x, y) => x + y, 0) / a.durations.length) : null,
      p95Ms: sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] : null,
      maxMs: sorted.length ? sorted[sorted.length - 1] : null
    };
  }
  return out;
}

/** Названия стадий (единый источник для движка и UI). */
export const STAGES = {
  REQUEST_RECEIVED: 'request_received',   // запрос получен от UI/API
  QUEUED: 'queued',                       // ожидание в очереди движка
  MEMORY_GATE: 'memory_gate',             // прогноз памяти
  SERVER_START: 'server_start',           // запуск/переиспользование llama-server
  MODEL_LOAD: 'model_load',               // загрузка весов GGUF (spawn → /health ok)
  TOKENIZE: 'tokenize',                   // токенизация (внутри llama-server — обычно недоступна)
  PROMPT_SUBMIT: 'prompt_submit',         // отправка промпта в runtime
  FIRST_BYTE: 'first_byte',               // первый байт ответа runtime
  FIRST_TOKEN: 'first_token',             // первый токен (TTFT)
  GENERATION: 'generation',               // генерация остальных токенов
  TOTAL: 'total'                          // весь запрос
};
