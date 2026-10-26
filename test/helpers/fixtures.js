// Shared fixtures for engine/API tests.
import { loadConfig } from '../../src/config.js';
import { createBackend } from '../../src/backends/registry.js';
import { Engine } from '../../src/core/engine.js';
import { Logger, PerfRecorder } from '../../src/diagnostics/log.js';

export function fakeMetrics(overrides = {}) {
  return {
    totalRamMb: 16000,
    usedRamMb: 7000,
    availableRamMb: 9000,
    cpuPercent: 12,
    vramTotalMb: 3072,
    gpuNames: ['Mock iGPU'],
    source: 'test',
    at: Date.now(),
    ...overrides
  };
}

export function fakeSampler(initial = fakeMetrics()) {
  let latest = initial;
  return {
    get latest() { return latest; },
    history: [],
    async sample(m = latest) { latest = m; return latest; },
    stop() {}
  };
}

export function makeEngine({ baseUrl, overrides = {}, sampler = fakeSampler(), configMutator = null, logLevel = 'error' } = {}) {
  const config = loadConfig('this-path-does-not-exist.json'); // pure defaults
  config.backend.baseUrl = baseUrl;
  configMutator?.(config);
  const logger = new Logger({ console: false, level: logLevel });
  const perf = new PerfRecorder();
  const backend = createBackend(config, overrides);
  const engine = new Engine({ config, backend, sampler, logger, perf });
  return { engine, config, logger, perf, backend, sampler };
}
