// Shared fixtures for engine/API tests.
import { loadConfig } from '../../src/config.js';
import os from 'node:os';
import path from 'node:path';
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

export function makeEngine({ baseUrl, overrides = {}, sampler = fakeSampler(), configMutator = null, logLevel = 'error', backend: backendOverride = null } = {}) {
  const config = loadConfig('this-path-does-not-exist.json'); // pure defaults
  config.backend.baseUrl = baseUrl;
  // Тесты с baseUrl целятся в мок Ollama — выбираем ollama-backend явно
  // (дефолт v0.4 — собственный runtime lmlama, ему baseUrl не нужен).
  if (baseUrl) config.backend.type = 'ollama';
  // Изолируем путь сохранения: persist движка (профиль производительности,
  // автооптимизация) не должен писать мусор в CWD и между тестами.
  config.paths = { configPath: path.join(os.tmpdir(), `litemind-test-${process.pid}-${Date.now()}.json`), existed: false };
  configMutator?.(config);
  const logger = new Logger({ console: false, level: logLevel });
  const perf = new PerfRecorder();
  const backend = backendOverride ?? createBackend(config, overrides);
  const engine = new Engine({ config, backend, sampler, logger, perf });
  return { engine, config, logger, perf, backend, sampler };
}
