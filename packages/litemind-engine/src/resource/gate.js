// Memory forecast gate: decide whether a model may start on this machine.
// Conservative by design: estimate high, require free memory, keep a Windows reserve.

/**
 * Этап 2 §3 — динамический резерв RAM для Windows и других приложений.
 * Резерв НЕ фиксирован: при признаках страничного обмена (paging) и высокой
 * нагрузке системы резерв растёт, при большом объёме свободной памяти —
 * возвращается к базовому значению профиля.
 *
 * @param {{ baseReserveMb: number, availableRamMb: number, totalRamMb: number,
 *           hardFaultsPerSec?: number|null, systemCpuPercent?: number|null }} p
 * @returns {{ reserveMb: number, reasons: string[] }}
 */
export function dynamicReserveMb({ baseReserveMb = 1024, availableRamMb = 0, totalRamMb = 0, hardFaultsPerSec = null, systemCpuPercent = null } = {}) {
  let reserve = Math.max(256, Number(baseReserveMb) || 0);
  const reasons = [];
  const available = Math.max(0, Number(availableRamMb) || 0);
  const total = Math.max(0, Number(totalRamMb) || 0);

  // 1) Интенсивный paging: Windows уже читает с диска страницы памяти —
  //    добавляем резерв, чтобы не усугублять обмен с файлом подкачки.
  const hf = Number(hardFaultsPerSec);
  if (Number.isFinite(hf) && hf > 100) {
    const bump = Math.min(1024, Math.round(reserve * (hf > 500 ? 0.5 : 0.25)));
    if (bump > 0) { reserve += bump; reasons.push(`paging: ${Math.round(hf)} стр. ошибок/с → +${bump} МБ`); }
  }

  // 2) Мало свободной памяти: резервируем больше, если доступно < 15% RAM.
  if (total > 0 && available > 0 && available / total < 0.15) {
    reserve += 512;
    reasons.push(`мало свободной RAM: ${Math.round(available)} МБ → +512 МБ`);
  }

  // 3) Высокая загрузка CPU системой — другие приложения активно работают.
  const cpu = Number(systemCpuPercent);
  if (Number.isFinite(cpu) && cpu >= 80) {
    reserve += 256;
    reasons.push(`высокая загрузка CPU: ${Math.round(cpu)}% → +256 МБ`);
  }

  // Верхняя граница: резерв не должен съедать больше половины 16 ГБ даже в пике.
  return { reserveMb: Math.min(reserve, 4096), reasons };
}

export function estimateModelMemoryMb({ modelSizeBytes, contextTokens, kvOverheadKbPerToken = 64 }) {
  if (!modelSizeBytes || !Number.isFinite(modelSizeBytes)) return null; // unknown estimate
  const weightsMb = modelSizeBytes / 1048576;
  const kvMb = ((Number(contextTokens) || 0) * kvOverheadKbPerToken) / 1024;
  const runtimeOverheadMb = 256; // backend process, buffers, fragmentation
  return Math.ceil(weightsMb + kvMb + runtimeOverheadMb);
}

/**
 * @returns {{allowed: boolean, reason?: string, severity?: 'block'|'warn', estimateMb: number|null, availableRamMb: number}}
 */
export function checkStartBudget({
  estimatedMb,
  availableRamMb,
  totalRamMb,
  reserveMb = 2048,
  maxRamUsageFraction = 0.75,
  usedRamMb = null,
  blockOnUnknownEstimate = false
}) {
  if (estimatedMb == null) {
    if (blockOnUnknownEstimate) {
      return { allowed: false, severity: 'block', reason: 'Model size is unknown and policy forbids starting on an unknown estimate.', estimateMb: null, availableRamMb };
    }
    return { allowed: true, severity: 'warn', reason: 'Model size unknown: forecast impossible, starting with a warning.', estimateMb: null, availableRamMb };
  }

  const reserve = typeof reserveMb === 'object' && reserveMb !== null ? reserveMb.reserveMb : reserveMb;
  // В сообщениях всегда число: reserveMb-параметр может быть объектом
  // {reserveMb, reasons} от dynamicReserveMb — интерполяция объекта даёт
  // «[object Object]» в ошибке MEMORY_BUDGET (найдено E2E v0.6.4).
  const budget = availableRamMb - reserve;
  if (budget <= 0) {
    return {
      allowed: false, severity: 'block', estimateMb: estimatedMb,
      reason: `Available RAM ${availableRamMb} MB does not even cover the ${reserve} MB Windows reserve.`,
      availableRamMb
    };
  }
  if (estimatedMb > budget) {
    return {
      allowed: false, severity: 'block', estimateMb: estimatedMb,
      reason: `Forecast ${estimatedMb} MB exceeds safe budget ${Math.floor(budget)} MB (available ${availableRamMb} MB − reserve ${reserve} MB).`,
      availableRamMb
    };
  }
  if (totalRamMb && usedRamMb != null) {
    const projectedFraction = (usedRamMb + estimatedMb) / totalRamMb;
    if (projectedFraction > maxRamUsageFraction) {
      return {
        allowed: false, severity: 'block', estimateMb: estimatedMb,
        reason: `Projected RAM usage ${Math.round(projectedFraction * 100)}% would exceed the ${Math.round(maxRamUsageFraction * 100)}% safety cap.`,
        availableRamMb
      };
    }
  }
  if (estimatedMb > budget * 0.8) {
    return {
      allowed: true, severity: 'warn', estimateMb: estimatedMb,
      reason: `Forecast ${estimatedMb} MB uses over 80% of the ${Math.floor(budget)} MB budget — expect Windows to slow down.`,
      availableRamMb
    };
  }
  return { allowed: true, estimateMb: estimatedMb, availableRamMb, reason: 'within budget' };
}
