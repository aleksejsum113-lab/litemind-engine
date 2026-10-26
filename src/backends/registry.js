// Backend registry — keeps Core independent from any concrete inference engine.
import { OllamaBackend } from './ollama.js';
import { assertBackendContract } from './base.js';

const FACTORIES = {
  ollama: (cfg) => new OllamaBackend(cfg.backend)
};

export function registerBackend(type, factory) {
  FACTORIES[type] = factory;
}

export function createBackend(config, overrides = {}) {
  const type = config.backend?.type;
  const factory = FACTORIES[type];
  if (!factory) {
    throw new Error(`Unknown backend "${type}". Registered: ${Object.keys(FACTORIES).join(', ')}`);
  }
  const backend = factory(config);
  Object.assign(backend, overrides);
  assertBackendContract(backend);
  return backend;
}

export function availableBackends() {
  return Object.keys(FACTORIES);
}
