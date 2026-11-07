import test from 'node:test';
import assert from 'node:assert/strict';
import { checkStartBudget, estimateModelMemoryMb } from '../src/resource/gate.js';
import { collectMetrics, MetricsSampler } from '../src/resource/metrics.js';

test('estimate returns null when model size is unknown', () => {
  assert.equal(estimateModelMemoryMb({ modelSizeBytes: null, contextTokens: 2048 }), null);
  assert.equal(estimateModelMemoryMb({ modelSizeBytes: undefined, contextTokens: 2048 }), null);
});

test('estimate includes weights, KV cache and runtime overhead', () => {
  const mb = estimateModelMemoryMb({ modelSizeBytes: 1000 * 1048576, contextTokens: 2048, kvOverheadKbPerToken: 64 });
  // 1000 MB weights + 128 MB KV + 256 MB overhead
  assert.ok(mb >= 1384 && mb <= 1385, `got ${mb}`);
});

test('blocks start when forecast exceeds available minus reserve', () => {
  const r = checkStartBudget({ estimatedMb: 8000, availableRamMb: 5000, totalRamMb: 16000, usedRamMb: 11000, reserveMb: 2048 });
  assert.equal(r.allowed, false);
  assert.equal(r.severity, 'block');
  assert.match(r.reason, /exceeds safe budget/);
});

test('blocks when reserve alone is not covered', () => {
  const r = checkStartBudget({ estimatedMb: 100, availableRamMb: 1500, totalRamMb: 16000, usedRamMb: 14500, reserveMb: 2048 });
  assert.equal(r.allowed, false);
  assert.match(r.reason, /Windows reserve/);
});

test('blocks when projected usage exceeds the RAM safety cap', () => {
  const r = checkStartBudget({ estimatedMb: 3500, availableRamMb: 7000, totalRamMb: 16000, usedRamMb: 9000, reserveMb: 2048, maxRamUsageFraction: 0.75 });
  assert.equal(r.allowed, false);
  assert.match(r.reason, /safety cap/);
});

test('warns when forecast sits near the edge of the budget', () => {
  const r = checkStartBudget({ estimatedMb: 3900, availableRamMb: 6000, totalRamMb: 16000, usedRamMb: 5000, reserveMb: 2048 });
  assert.equal(r.allowed, true);
  assert.equal(r.severity, 'warn');
});

test('unknown estimate: warn by default, block under strict policy', () => {
  const lenient = checkStartBudget({ estimatedMb: null, availableRamMb: 9000, totalRamMb: 16000, reserveMb: 2048 });
  assert.equal(lenient.allowed, true);
  assert.equal(lenient.severity, 'warn');
  const strict = checkStartBudget({ estimatedMb: null, availableRamMb: 9000, totalRamMb: 16000, reserveMb: 2048, blockOnUnknownEstimate: true });
  assert.equal(strict.allowed, false);
});

test('collectMetrics returns a complete, non-crashing snapshot', async () => {
  const m = await collectMetrics();
  assert.ok(m.totalRamMb > 0, 'total RAM known');
  assert.ok(m.availableRamMb >= 0, 'available RAM known');
  assert.ok(typeof m.cpuPercent === 'number', 'CPU load number');
  assert.ok(['windows-cim', 'procfs', 'fallback'].includes(m.source), `source=${m.source}`);
});

test('MetricsSampler samples, keeps bounded history and stops cleanly', async () => {
  let n = 0;
  const sampler = new MetricsSampler({ intervalMs: 10, provider: async () => ({ totalRamMb: 100, usedRamMb: 40, availableRamMb: 60, cpuPercent: n++, at: Date.now() }) });
  await sampler.sample();
  await sampler.sample();
  assert.equal(sampler.latest.totalRamMb, 100);
  assert.equal(sampler.history.length, 2);
  sampler.start();
  await new Promise((r) => setTimeout(r, 60));
  sampler.stop();
  assert.ok(sampler.history.length >= 2, 'polling happened');
  assert.ok(sampler.history.length <= 180, 'history bounded');
});
