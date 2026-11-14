// Backend registry — keeps Core independent from any concrete inference engine.
import { OllamaBackend } from './ollama.js';
import { LlamaCppBackend } from './lmlama.js';
import { assertBackendContract } from './base.js';

const FACTORIES = {
  // Основной runtime с v0.4: собственный llama.cpp, без внешних сервисов.
  lmlama: (cfg) => new LlamaCppBackend({
    rootDir: cfg.models.rootDir,
    serverPath: cfg.backend.serverPath || null,
    host: cfg.backend.host || '127.0.0.1',
    contextTokens: cfg.profiles?.[cfg.profile]?.contextTokens ?? 4096,
    threads: cfg.profiles?.[cfg.profile]?.cpuThreads ?? 0,
    chatTemplate: cfg.backend.chatTemplate || null,
    // ТЗ v0.6.3 §1.5: таймаут заголовков — конфигурируемый (дефолт 10 мин).
    headersTimeoutMs: cfg.backend.headersTimeoutMs ?? 600000
  }),
  // Опциональная интеграция: если Ollama установлена, ею можно пользоваться.
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
