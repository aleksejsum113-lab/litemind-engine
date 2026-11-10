// Compatibility — честная оценка модели на конкретном железе (Этап 1Б §2.3).
//
// Четыре уровня (ТЗ): подходит / подходит с ограничениями / не рекомендуется /
// несовместима. Оценка НЕ сводится к размеру файла: учитываются архитектура
// (проверенные семейства runtime), требования к инструкциям CPU, квантование,
// контекст и память (веса + KV-кэш + накладные расходы рантайма + резерв
// Windows). Размер файла и объём RAM при запуске — разные вещи и в ответе
// показываются раздельно.
//
// Бюджет памяти модели = веса (файл GGUF) + KV-кэш (контекст) + накладные
// расходы рантайма (~15%) + резерв Windows. Промежуточные статусы:
//   green  — влезает с запасом ≥ 25%;
//   yellow — влезает, но запас мал (< 25%) — закройте тяжёлые приложения;
//   red    — не влезает / нет достоверных данных о свободной RAM.

import { estimateModelMemoryMb } from './resource/gate.js';
import { RUNTIME_VERIFIED_FAMILIES } from './catalog/models.js';

export const STATUS = { GREEN: 'green', YELLOW: 'yellow', RED: 'red' };

// Четыре уровня совместимости (Этап 1Б §2.3).
export const LEVEL = {
  OK: 'ok',                       // подходит
  LIMITED: 'limited',             // подходит с ограничениями
  NOT_RECOMMENDED: 'not_recommended', // не рекомендуется
  INCOMPATIBLE: 'incompatible'    // несовместима
};

export const LEVEL_LABEL = {
  [LEVEL.OK]: 'Подходит',
  [LEVEL.LIMITED]: 'Подходит с ограничениями',
  [LEVEL.NOT_RECOMMENDED]: 'Не рекомендуется',
  [LEVEL.INCOMPATIBLE]: 'Несовместима'
};

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

function speedOf(model) {
  return model.speed ?? (parseFloat(String(model.params ?? '0')) >= 7 ? 'slow' : parseFloat(String(model.params ?? '0')) >= 3 ? 'medium' : 'fast');
}

/**
 * Полная оценка модели (каталог v3).
 * Возвращает прежние поля (status/fit/fitLabel — для совместимости) плюс
 * новый четырёхуровневый вердикт: level / levelLabel / levelReasons[].
 */
export function rateCatalogModel(model, hw, { contextTokens } = {}) {
  const ctxKnown = model.contextTokens != null;
  const ctx = contextTokens ?? (ctxKnown
    ? Math.min(model.contextTokens, hw.recommendation.maxContextTokens)
    : hw.recommendation.maxContextTokens);
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

  // Пятиуровневая оценка «подходит ли именно вам» (каталог v2, сохранена):
  //   great — отлично подходит; ok — подходит с ограничениями;
  //   slow  — будет работать медленно; avoid — не рекомендуется.
  const modelSpeed = speedOf(model);
  const fit =
    overall === STATUS.GREEN
      ? modelSpeed === 'fast' ? 'great' : modelSpeed === 'medium' ? 'ok' : 'slow'
      : overall === STATUS.YELLOW
        ? modelSpeed === 'fast' ? 'ok' : 'slow'
        : 'avoid';
  const fitLabel = {
    great: 'Отлично подходит',
    ok: 'Подходит с ограничениями',
    slow: 'Будет работать медленно',
    avoid: 'Не рекомендуется'
  }[fit];

  const speedNote =
    hw.cpu.avx === false
      ? model.params === '7B' || model.params === '6.7B' || model.params === '8B'
        ? '7–8B на CPU без AVX: ~1–3 ток/с. Рекомендуются модели ≤ 3B.'
        : model.params === '3B' || model.params === '3.2B'
          ? '3B на CPU без AVX: ~3–6 ток/с — терпимо для кода.'
          : 'Малые модели отвечают достаточно быстро даже без AVX.'
      : null;

  // ── Четырёхуровневый вердикт (Этап 1Б §2.3) ─────────────────────────────
  const reasons = [];
  let level;

  // 1) Требования к инструкциям CPU: модель с AVX2-only квантованием не
  //    показывается совместимой, если CPU/сборка не поддерживают режим.
  if (model.requiresAvx2 && hw.cpu.avx2 === false) {
    level = LEVEL.INCOMPATIBLE;
    reasons.push('Квантование требует AVX2 — этот процессор и сборка runtime его не поддерживают.');
  } else {
    // 2) Архитектура: неизвестное семейство — никогда «гарантированно совместима».
    const familyVerified = RUNTIME_VERIFIED_FAMILIES.has(model.family);
    if (!familyVerified) {
      reasons.push(`Совместимость семейства «${model.family}» с текущей сборкой runtime не проверена — модель может не запуститься.`);
      level = LEVEL.NOT_RECOMMENDED;
    } else if (overall === STATUS.RED) {
      // 3) Память: даже минимальный квант не влезает в бюджет с минимальным контекстом.
      const minCtx = 2048;
      const minFit = rateFile({
        fileBytes: best.sizeBytes,
        contextTokens: minCtx,
        availableRamMb: hw.freeRamMb,
        totalRamMb: hw.totalRamMb,
        reserveMb: hw.recommendation.windowsReserveMb
      });
      if (minFit.status === STATUS.RED) {
        level = LEVEL.INCOMPATIBLE;
        reasons.push(`Не хватает памяти даже в самом лёгком квантовании: ~${Math.round(minFit.estimatedMb)} МБ RAM при контексте ${minCtx} ток., бюджет ~${Math.round(minFit.budgetMb)} МБ.`);
      } else {
        level = LEVEL.NOT_RECOMMENDED;
        reasons.push(`Памяти хватает только на минимальный контекст: ${minFit.reason}`);
      }
    } else {
      // 4) Обычная шкала RAM + скорость CPU.
      if (overall === STATUS.YELLOW) {
        level = LEVEL.LIMITED;
        reasons.push('Памяти влезает впритык: закройте тяжёлые приложения перед генерацией.');
      } else if (modelSpeed === 'slow') {
        level = LEVEL.NOT_RECOMMENDED;
        reasons.push('Скорость на этом CPU будет низкой (единицы ток/с) — используйте, только если готовы ждать.');
      } else if (modelSpeed === 'medium') {
        level = LEVEL.OK;
      } else {
        level = LEVEL.OK;
      }
      if (hw.cpu.avx === false && modelSpeed !== 'fast') {
        reasons.push('CPU без AVX/AVX2: сборка LiteMind работает, но медленнее (см. оценку скорости).');
      }
      if (!ctxKnown) {
        reasons.push(`Контекстное окно модели неизвестно — оценка памяти дана для ${ctx} ток.`);
      }
      if (level === LEVEL.OK && !reasons.length) reasons.push('Памяти и скорости достаточно для комфортной работы.');
    }
  }
  if (hw.cpu.avx === false && !reasons.some((r) => r.includes('AVX'))) {
    reasons.push('CPU без AVX/AVX2: LiteMind использует совместимую сборку — модель запустится, но медленнее.');
  }

  // Требования к железу (ТЗ §2): общие для CPU-инференса собственной сборкой.
  const hwRequirements = {
    cpu: 'x86-64 (Intel/AMD). Сборка LiteMind работает на CPU без AVX/AVX2 — медленнее, но запускается.',
    gpu: 'Не требуется: генерация выполняется на CPU; дискретная видеокарта не используется.',
    ram: `Ориентир: вес модели в RAM ≈ размер файла × 1,15 + KV-кэш (зависит от контекста). Для ${model.params ?? '?'} при контексте ${ctx} ток. — ~${best ? Math.round(best.estimatedMb) : '?'} МБ.`,
    windows: 'Windows 10/11 x64.',
    disk: `Файл GGUF: ${best ? fmt(best.sizeBytes) : '?'}; при загрузке дополнительно нужен такой же объём во время докачки (.part).`
  };

  return {
    modelId: model.id,
    status: overall,
    fit,
    fitLabel,
    level,
    levelLabel: LEVEL_LABEL[level],
    levelReasons: reasons,
    contextTokens: ctx,
    contextKnown: ctxKnown,
    files: rated,
    recommended: recommended ? { name: recommended.name, sizeBytes: recommended.sizeBytes, url: recommended.url, quant: recommended.quant ?? null, sha256: recommended.sha256 ?? null } : null,
    speedNote,
    hwRequirements
  };
}

function fmt(bytes) {
  const gb = bytes / (1024 * 1024 * 1024);
  if (gb >= 1) return `${gb.toFixed(1)} ГБ`;
  return `${(bytes / (1024 * 1024)).toFixed(0)} МБ`;
}
