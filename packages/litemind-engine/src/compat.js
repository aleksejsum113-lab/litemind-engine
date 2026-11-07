// Compatibility — зелёный/жёлтый/красный статус модели на конкретном железе
// и выбор безопасного квантования (ТЗ §4).
//
// Бюджет памяти модели = веса (файл GGUF) + KV-кэш (контекст) + накладные
// расходы рантайма (~15%) + резерв Windows. Модель помечается:
//   green  — влезает с запасом ≥ 25%;
//   yellow — влезает, но запас мал (< 25%) — закройте тяжёлые приложения;
//   red    — не влезает / нет достоверных данных о свободной RAM.

import { estimateModelMemoryMb } from './resource/gate.js';

export const STATUS = { GREEN: 'green', YELLOW: 'yellow', RED: 'red' };

export function estimateContextMb({ fileBytes, contextTokens, kvOverheadKbPerToken = 64 }) {
  const est = estimateModelMemoryMb({
    modelSizeBytes: fileBytes,
    contextTokens,
    kvOverheadKbPerToken
  });
  return est;
}

/**
 * Оценка совместимости одного квант-варианта.
 * @param {object} args
 * @param {number} args.fileBytes            размер GGUF
 * @param {number} args.contextTokens        запрошенный контекст
 * @param {number|null} args.availableRamMb  свободная RAM (если известна)
 * @param {number} args.totalRamMb           общая RAM
 * @param {number} args.reserveMb            резерв под Windows
 * @param {number} args.kvOverheadKbPerToken KB на токен KV-кэша
 */
export function rateFile({
  fileBytes,
  contextTokens = 4096,
  availableRamMb = null,
  totalRamMb,
  reserveMb,
  kvOverheadKbPerToken = 64
}) {
  const estimatedMb = estimateModelMemoryMb({
    modelSizeBytes: fileBytes,
    contextTokens,
    kvOverheadKbPerToken
  });
  const budgetMb = (availableRamMb ?? Math.max(0, totalRamMb - reserveMb)) * 0.9; // 10% на фрагментацию

  if (availableRamMb === null && totalRamMb <= 0) {
    return { status: STATUS.RED, estimatedMb, budgetMb, reason: 'RAM не определена' };
  }
  if (estimatedMb <= budgetMb * 0.75) return { status: STATUS.GREEN, estimatedMb, budgetMb };
  if (estimatedMb <= budgetMb) {
    return {
      status: STATUS.YELLOW,
      estimatedMb,
      budgetMb,
      reason: 'Влезает впритык: закройте браузер и тяжёлые приложения перед генерацией.'
    };
  }
  return {
    status: STATUS.RED,
    estimatedMb,
    budgetMb,
    reason: `Требуется ~${Math.round(estimatedMb)} MB, доступно ~${Math.round(budgetMb)} MB с учётом резерва Windows.`
  };
}

/**
 * Оценка всей модели: лучший (минимальный) файл → зелёный/жёлтый;
 * рекомендованное квантование — самый качественный вариант, проходящий в зелёную зону.
 */
export function rateCatalogModel(model, hw, { contextTokens } = {}) {
  const ctx = contextTokens ?? Math.min(model.contextTokens, hw.recommendation.maxContextTokens);
  const files = [...model.files].sort((a, b) => a.sizeBytes - b.sizeBytes);
  const rated = files.map((f, index) => {
    const r = rateFile({
      fileBytes: f.sizeBytes,
      contextTokens: ctx,
      availableRamMb: hw.freeRamMb,
      totalRamMb: hw.totalRamMb,
      reserveMb: hw.recommendation.windowsReserveMb,
      kvOverheadKbPerToken: 64
    });
    // качественность кванта: больший файл обычно качественнее — ранжируем по размеру
    return { ...f, qualityRank: index, ...r };
  });

  const best = rated[0]; // самый маленький — гарантия запуска
  const overall = best?.status ?? STATUS.RED;

  // Рекомендованный квант: самый большой файл со статусом green; иначе yellow; иначе минимальный.
  const green = rated.filter((r) => r.status === STATUS.GREEN);
  const yellow = rated.filter((r) => r.status === STATUS.YELLOW);
  const recommended = green.length ? green[green.length - 1] : yellow.length ? yellow[yellow.length - 1] : best;

  const speedNote =
    hw.cpu.avx === false
      ? model.params === '7B' || model.params === '6.7B'
        ? '7B на CPU без AVX: ~1–3 ток/с. Рекомендуются модели ≤ 3B.'
        : model.params === '3B'
          ? '3B на CPU без AVX: ~3–6 ток/с — терпимо для кода.'
          : 'Малые модели отвечают достаточно быстро даже без AVX.'
      : null;

  return {
    modelId: model.id,
    status: overall,
    contextTokens: ctx,
    files: rated,
    recommended: recommended ? { name: recommended.name, sizeBytes: recommended.sizeBytes, url: recommended.url } : null,
    speedNote
  };
}
