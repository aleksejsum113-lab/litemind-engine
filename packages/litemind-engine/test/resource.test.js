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

test('регресс [object Object]: reserveMb можно передать объектом от dynamicReserveMb', () => {
  // engine._memoryGate передаёт reserveMb: dynamicReserveMb(...) → {reserveMb, reasons}.
  const obj = { reserveMb: 1280, reasons: ['мало свободной RAM: 2000 МБ → +512 МБ'] };
  const r = checkStartBudget({ estimatedMb: 892, availableRamMb: 2023, totalRamMb: 16000, usedRamMb: 14000, reserveMb: obj });
  assert.equal(r.allowed, false);
  assert.equal(r.severity, 'block');
  assert.match(r.reason, /exceeds safe budget 743 MB/);
  assert.ok(!r.reason.includes('[object Object]'), `нет подмены объекта: ${r.reason}`);
  assert.ok(r.reason.includes('reserve 1280 MB'), `число резерва в сообщении: ${r.reason}`);

  const r2 = checkStartBudget({ estimatedMb: 100, availableRamMb: 1000, totalRamMb: 16000, usedRamMb: 900, reserveMb: obj });
  assert.match(r2.reason, /cover the 1280 MB Windows reserve/);
  assert.ok(!r2.reason.includes('[object Object]'), `нет подмены объекта: ${r2.reason}`);
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
  // Этап 2: cpuPercent считается сэмплером по дельте os.cpus() — в первом
  // снимке его честно нет (null), а не подставленный ноль.
  assert.ok(m.cpuPercent === null || typeof m.cpuPercent === 'number', 'cpuPercent null or number');
  assert.ok(['node-os', 'procfs'].includes(m.source), `source=${m.source}`);
});

test('MetricsSampler computes cpuPercent from deltas and keeps bounded history', async () => {
  let n = 0;
  const sampler = new MetricsSampler({ intervalMs: 10, provider: async () => ({ totalRamMb: 100, usedRamMb: 40, availableRamMb: 60, cpuPercent: n++, at: Date.now() }) });
  await sampler.sample();
  await sampler.sample();
  assert.equal(sampler.latest.totalRamMb, 100);
  assert.equal(sampler.history.length, 2);
  // Второй сэмпл: CPU% вычислен по дельте os.cpus() (число, а не null).
  assert.equal(typeof sampler.latest.cpuPercent, 'number', 'cpu computed on second sample');
  sampler.start();
  await new Promise((r) => setTimeout(r, 60));
  sampler.stop();
  assert.ok(sampler.history.length >= 2, 'polling happened');
  assert.ok(sampler.history.length <= 180, 'history bounded');
});

test('applyPriorityToPid всегда возвращает Promise (регрессия image/generate)', async () => {
  // Прогон smoke v0.6.2 №6: generate.js вешает .catch() на результат, а
  // функция возвращала undefined → TypeError «Cannot read properties of
  // undefined (reading 'catch')» на первой же генерации изображения.
  const { applyPriorityToPid } = await import('../src/resource/priority.js');
  assert.equal(typeof applyPriorityToPid(12345, 'low')?.catch, 'function', 'PID задан');
  assert.equal(typeof applyPriorityToPid(null, 'low')?.catch, 'function', 'PID отсутствует');
  assert.equal(typeof applyPriorityToPid('не число', 'low')?.catch, 'function', 'PID не число');
  await applyPriorityToPid(null, 'low');
});
