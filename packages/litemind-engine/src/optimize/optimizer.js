// Автооптимизация модели (ТЗ: интеллектуальный движок запуска).
//
// При первом запуске модели движок перебирает несколько БЕЗОПАСНЫХ конфигураций
// (число потоков CPU; контекст фиксирован профилем), измеряет для каждой
// TTFT и tokens/sec на короткой генерации, выбирает быстрейшую и сохраняет
// её в config.optimizations[model]. Последующие запуски сразу используют
// сохранённые настройки — бесконечных тестов нет.
//
// Защита слабого ПК остаётся включённой на всём протяжении бенчмарка:
// каждая проба идёт через engine.generate() → очередь + memory-gate + таймауты.
import os from 'node:os';
import { saveConfig } from '../config.js';

// Промпт бенчмарка: короткий, побуждает к компактному ответу.
const BENCH_PROMPT = 'Напиши одно короткое предложение о море.';

// Ниже этой скорости (токенов/с) считаем работу «медленной» и советуем
// более лёгкий квант или модель (ТЗ §5).
export const SLOW_TOKENS_PER_SEC = 2.5;

/** Кандидаты num_thread (Этап 2: включаем и ВСЕ ядра — prefill и генерация
 *  на N5095A измеряются честно; раньше кандидаты никогда не включали cores).
 *  Уникальные, >= 1. */
export function threadCandidates({ cpuThreads = 0, cores = os.cpus().length } = {}) {
  const n = Math.max(1, cores || 4);
  const max = cpuThreads > 0 ? cpuThreads : Math.max(2, Math.min(4, n - 1));
  const set = new Set([n, max, Math.max(1, Math.ceil(max / 2)), 1]);
  return [...set].filter((k) => k >= 1 && k <= n).sort((a, b) => b - a);
}

/**
 * Одна проба: короткая генерация с фиксированными опциями.
 * Возвращает { threads, ttftMs, tokensPerSecond, outputTokens, durationMs, error }.
 */
export async function probe({ engine, model, threads, contextTokens, maxOutputTokens = 64 }) {
  const messages = [{ role: 'user', content: BENCH_PROMPT }];
  const result = await engine.generate({
    model,
    messages,
    contextTokens,
    maxOutputTokens,
    threads
  });
  return {
    threads,
    ttftMs: result.timings?.ttftMs ?? null,
    tokensPerSecond: result.timings?.tokensPerSecond ?? null,
    outputTokens: result.usage?.completionTokens ?? null,
    durationMs: result.timings?.durationMs ?? null
  };
}

/**
 * Полная автооптимизация модели. Перебирает кандидатов потоков, сохраняет лучшую
 * конфигурацию в config.optimizations и пишет конфиг на диск.
 * onProgress(stage) — для UI-прогресса: { stage: 'probe'|'done'|'error', index, total, threads, result? }.
 *
 * Этап 2: каждая проба теперь реально перезапускает llama-server с новым числом
 * потоков (args-key в ensureServer) — раньше все пробы шли на одном процессе с
 * одними и теми же потоками, и «оптимизация» измеряла шум.
 */
export async function optimizeModel({ engine, model, onProgress = null, maxOutputTokens = 64 }) {
  const profile = engine.profile;
  const contextTokens = profile.contextTokens;
  const candidates = threadCandidates({
    cpuThreads: profile.cpuThreads,
    cores: os.cpus().length
  });

  const tried = [];
  for (let i = 0; i < candidates.length; i++) {
    const threads = candidates[i];
    onProgress?.({ stage: 'probe', index: i, total: candidates.length, threads });
    try {
      const r = await probe({ engine, model, threads, contextTokens, maxOutputTokens });
      tried.push(r);
    } catch (err) {
      // Проба не удалась (например, gate не пустил) — фиксируем и продолжаем.
      tried.push({ threads, ttftMs: null, tokensPerSecond: null, error: err.message });
    }
  }

  const ok = tried.filter((t) => t.tokensPerSecond && t.tokensPerSecond > 0);
  if (ok.length === 0) {
    const err = new Error(
      `Не удалось измерить скорость модели ${model}: ` +
        (tried.find((t) => t.error)?.error ?? 'все пробы вернули нулевую скорость')
    );
    err.code = 'BENCH_FAILED';
    err.status = 503;
    onProgress?.({ stage: 'error', error: err.message });
    throw err;
  }

  // Быстрейшая стабильная конфигурация (по tokens/sec; при равенстве — меньший TTFT).
  const best = ok.sort((a, b) => (b.tokensPerSecond - a.tokensPerSecond) || (a.ttftMs - b.ttftMs))[0];

  const report = {
    model,
    threads: best.threads,
    tokensPerSecond: best.tokensPerSecond,
    ttftMs: best.ttftMs,
    contextTokens,
    profile: engine.config.profile,
    candidates: tried,
    measuredAt: new Date().toISOString(),
    advice: adviceFor(best.tokensPerSecond, engine.config.profile),
    // Этап 2: честная пометка, что пробы перезапускали runtime (args-key).
    measuredWithRestarts: true
  };

  engine.config.optimizations[model] = {
    threads: best.threads,
    tokensPerSecond: best.tokensPerSecond,
    ttftMs: best.ttftMs,
    contextTokens,
    measuredAt: report.measuredAt
  };
  try {
    saveConfig(engine.config, engine.config.paths.configPath);
  } catch (err) {
    // Настройки остаются в памяти; на диск не записались — не критично.
    engine.log?.warn?.('optimization not persisted', { error: err.message });
  }
  engine.log?.info?.('model optimized', { model, threads: best.threads, tps: best.tokensPerSecond });
  onProgress?.({ stage: 'done', report });
  return report;
}

/** Совет пользователю по скорости (ТЗ §5: не молчим, когда медленно). */
export function adviceFor(tokensPerSecond, profileName) {
  if (tokensPerSecond >= SLOW_TOKENS_PER_SEC * 4) {
    return 'Скорость комфортная — оптимизация сохранена.';
  }
  if (tokensPerSecond >= SLOW_TOKENS_PER_SEC) {
    return 'Приемлемая скорость. Для ускорения можно уменьшить контекст или выбрать квант поменьше.';
  }
  return (
    'Модель работает медленно для этого ПК. Рекомендуем: 1) квант Q2_K/Q3_K поменьше, ' +
    '2) модель 0.5B–1.5B из каталога, 3) профиль «Бережный».' +
    (profileName === 'low' ? '' : ' Также попробуйте профиль «Бережный».')
  );
}
