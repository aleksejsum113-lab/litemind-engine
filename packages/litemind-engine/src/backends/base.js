// Inference Backend — contract every backend adapter must satisfy.
// v0.1 ships `ollama`; future backends (llama.cpp server, etc.) implement this.

/**
 * @typedef {Object} BackendCapabilities
 * @property {boolean} stream       supports streaming tokens
 * @property {boolean} cancel       supports aborting a request
 * @property {boolean} unload       supports unloading a model from memory
 * @property {boolean} numCtx       supports per-request context size
 * @property {boolean} numThreads   supports CPU thread limit
 * @property {boolean} numPredict   supports max output token limit
 *
 * @typedef {Object} ModelInfo
 * @property {string} id
 * @property {number|null} sizeBytes
 * @property {string} [detail]
 *
 * @typedef {Object} GenerateParams
 * @property {string} model
 * @property {Array<{role:string,content:string}>} messages
 * @property {number} contextTokens
 * @property {number} maxOutputTokens
 * @property {number} [threads]
 * @property {AbortSignal} [signal]
 * @property {(delta: string, info?: object) => void} [onToken]
 *
 * @typedef {Object} GenerateResult
 * @property {string} text
 * @property {{promptTokens?:number, completionTokens?:number}} usage
 *
 * @typedef {Object} Backend
 * @property {string} type
 * @property {() => Promise<{ok:boolean, version?:string, detail?:string, error?:string}>} detect
 * @property {() => Promise<ModelInfo[]>} listModels
 * @property {() => BackendCapabilities} capabilities
 * @property {(p: GenerateParams) => Promise<GenerateResult>} generate
 * @property {(modelId: string|null) => Promise<{unloaded:string[]}>} unload
 * @property {() => Promise<object>} [loaded] — currently loaded models (optional)
 */

export const REQUIRED_METHODS = ['detect', 'listModels', 'capabilities', 'generate', 'unload'];

/** Throws with a precise message if an adapter does not honour the contract. */
export function assertBackendContract(backend) {
  const missing = REQUIRED_METHODS.filter((m) => typeof backend?.[m] !== 'function');
  if (missing.length) {
    throw new Error(`Backend "${backend?.type ?? 'unknown'}" does not implement: ${missing.join(', ')}`);
  }
  const caps = backend.capabilities();
  const missingCap = ['stream', 'cancel', 'unload', 'numCtx', 'numThreads', 'numPredict'].filter((k) => typeof caps[k] !== 'boolean');
  if (missingCap.length) throw new Error(`Backend "${backend.type}" capabilities missing flags: ${missingCap.join(', ')}`);
  return true;
}

export class BackendError extends Error {
  constructor(message, { code = 'BACKEND_ERROR', status = null, cause = null } = {}) {
    super(message);
    this.name = 'BackendError';
    this.code = code;
    this.status = status;
    if (cause) this.cause = cause;
  }
}

export class ModelNotFoundError extends BackendError {
  // ТЗ v0.6.3 §1.4: подсказка зависит от бэкенда — llama.cpp видит локальные
  // GGUF-файлы (совет «ollama pull» вводил в заблуждение: модель уже скачана
  // как .gguf). ollama сохраняет прежний текст (на него завязан тест).
  constructor(model, available = [], hint = null) {
    super(
      `Модель «${model}» не найдена среди локальных. ` +
        (available.length ? `Доступны: ${available.join(', ')}. ` : 'Локальных моделей нет. ') +
        (hint ?? 'LiteMind никогда не скачивает модели автоматически — установите модель командой `ollama pull <name>`.'),
      { code: 'MODEL_NOT_FOUND', status: 404 }
    );
    this.name = 'ModelNotFoundError';
    this.model = model;
  }
}
