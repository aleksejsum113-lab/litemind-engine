// Возможности runtime (честная карта, ТЗ: «не включать технологии ради функции»).
//
// Ollama = llama.cpp под капотом. Через HTTP API доступны только те опции,
// которые Ollama пробрасывает в llama.cpp. Всё, что API не поддерживает,
// помечено available: false — UI не показывает несуществующие тумблеры,
// движок не «применяет» фиктивные ускорения.
//
// Prompt caching: llama.cpp кэширует KV общего префикса автоматически при
// повторных запросах с тем же началом промпта. Adaptive Controller сохраняет
// стабильный префикс (system не переписывается) — кэш реально переиспользуется.

export const RUNTIME_CAPABILITIES = {
  ollama: {
    promptCache: {
      available: true,
      strategy: 'stable-prefix',
      note: 'KV общего префикса кэшируется llama.cpp автоматически; движок сохраняет неизменный system-префикс.'
    },
    promptLookupDecoding: {
      available: false,
      note: 'Ollama API не предоставляет n_lookup/prompt-lookup. Не включаем, чтобы не выдавать фиктивное ускорение.'
    },
    speculativeDecoding: {
      available: false,
      note: 'Ollama API не поддерживает draft-модель. На CPU N5095A выигрыш обычно отсутствует — не применяем.'
    },
    kvCacheQuantization: {
      available: false,
      note: 'type_k/type_v не пробрасываются Ollama API. Если появится прямой llama.cpp-адаптер — включим Q8_0.'
    },
    chunkedPrefill: {
      available: true,
      strategy: 'runtime-auto',
      note: 'Управляется llama.cpp автоматически; движок держит num_batch в безопасных пределах.'
    },
    mmap: { available: true, default: true },
    mlock: {
      available: true,
      default: false,
      note: 'Выключен по умолчанию: на машинах с 16 ГБ mlock усиливает давление на память Windows.'
    },
    options: ['num_thread', 'num_batch', 'num_ctx', 'num_predict', 'use_mmap', 'use_mlock', 'num_keep']
  }
};

export function capabilitiesFor(runtime) {
  return RUNTIME_CAPABILITIES[runtime] ?? { unknown: true, promptCache: { available: false, strategy: 'none' } };
}
