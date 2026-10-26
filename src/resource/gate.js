// Memory forecast gate: decide whether a model may start on this machine.
// Conservative by design: estimate high, require free memory, keep a Windows reserve.

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

  const budget = availableRamMb - reserveMb;
  if (budget <= 0) {
    return {
      allowed: false, severity: 'block', estimateMb: estimatedMb,
      reason: `Available RAM ${availableRamMb} MB does not even cover the ${reserveMb} MB Windows reserve.`,
      availableRamMb
    };
  }
  if (estimatedMb > budget) {
    return {
      allowed: false, severity: 'block', estimateMb: estimatedMb,
      reason: `Forecast ${estimatedMb} MB exceeds safe budget ${Math.floor(budget)} MB (available ${availableRamMb} MB − reserve ${reserveMb} MB).`,
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
