// LiteMind Model Catalog — verified entries only.
//
// Каждая запись проверена запросом к HuggingFace API (2026-11-07):
// репозиторий существует, не gated, список GGUF-файлов и размеры сняты с
// /api/models/<repo>/tree/main. Никаких «приблизительных» имён файлов.
//
// Политика каталога (ТЗ §3):
//  - приоритет coding-моделям 0.5B–7B в GGUF;
//  - Uncensored / Abliterated / Heretic версии помечены флагом
//    `uncensored: true` и вынесены в отдельную категорию;
//  - категория, RAM-оценка, лицензия и источник обязательны.

export const CATEGORIES = {
  'uncensored-coding': 'Uncensored / Abliterated Coding',
  'small-coding': 'Small Coding Models',
  'advanced-coding': 'Advanced Coding Models'
};

/**
 * Квант-варианты для каждой модели. Размеры — фактические из HF tree API
 * (байты, округлены до MiB). ollamaName — имя, под которым модель появится
 * в Ollama/LiteMind/OpenCode после установки.
 */
const MIB = 1024 * 1024;

function file(repo, name, mib) {
  return { url: `https://huggingface.co/${repo}/resolve/main/${name}`, name, sizeBytes: Math.round(mib * MIB) };
}

function entry(def) {
  return {
    id: def.id,
    ollamaName: def.ollamaName,
    displayName: def.displayName,
    category: def.category,
    uncensored: def.uncensored === true,
    uncensoredLabel: def.uncensoredLabel ?? null,
    params: def.params,
    family: def.family,
    purpose: def.purpose,
    license: def.license,
    licenseNote: def.licenseNote ?? null,
    source: `https://huggingface.co/${def.repo}`,
    repo: def.repo,
    contextTokens: def.contextTokens ?? 32768,
    tools: def.tools !== false,
    vision: false,
    notes: def.notes ?? null,
    files: def.files
  };
}

export const CATALOG = [
  // ── Uncensored / Abliterated Coding (ТЗ #3, проверено 2026-11-07) ────────
  entry({
    id: 'qwen2.5-coder-1.5b-abliterated',
    ollamaName: 'litemind-qwen2.5-coder-1.5b-abliterated',
    displayName: 'Qwen2.5 Coder 1.5B Abliterated',
    category: 'uncensored-coding',
    uncensored: true,
    uncensoredLabel: 'Abliterated',
    params: '1.5B',
    family: 'qwen2.5-coder',
    purpose: 'Кодинг без встроенных отказов; отвечает на темы, которые обычные модели блокируют.',
    license: 'apache-2.0',
    repo: 'bartowski/Qwen2.5-Coder-1.5B-Instruct-abliterated-GGUF',
    notes: 'Abliterated через направление активаций; качество кода может немного отличаться от обычной версии. Работает без AVX/AVX2.',
    files: [
      file('bartowski/Qwen2.5-Coder-1.5B-Instruct-abliterated-GGUF', 'Qwen2.5-Coder-1.5B-Instruct-abliterated-Q2_K.gguf', 717),
      file('bartowski/Qwen2.5-Coder-1.5B-Instruct-abliterated-GGUF', 'Qwen2.5-Coder-1.5B-Instruct-abliterated-Q3_K_M.gguf', 880),
      file('bartowski/Qwen2.5-Coder-1.5B-Instruct-abliterated-GGUF', 'Qwen2.5-Coder-1.5B-Instruct-abliterated-Q4_K_M.gguf', 1065)
    ]
  }),
  entry({
    id: 'qwen2.5-coder-3b-abliterated',
    ollamaName: 'litemind-qwen2.5-coder-3b-abliterated',
    displayName: 'Qwen2.5 Coder 3B Abliterated',
    category: 'uncensored-coding',
    uncensored: true,
    uncensoredLabel: 'Abliterated',
    params: '3B',
    family: 'qwen2.5-coder',
    purpose: 'Более умный coding без отказов; лучший баланс «ум / RAM» для 16 ГБ.',
    license: 'qwen-research (other)',
    repo: 'bartowski/Qwen2.5-Coder-3B-Instruct-abliterated-GGUF',
    notes: 'Лицензия Qwen Research — использование не в исследовательских целях требует проверки лицензии.',
    files: [
      file('bartowski/Qwen2.5-Coder-3B-Instruct-abliterated-GGUF', 'Qwen2.5-Coder-3B-Instruct-abliterated-Q2_K.gguf', 1219),
      file('bartowski/Qwen2.5-Coder-3B-Instruct-abliterated-GGUF', 'Qwen2.5-Coder-3B-Instruct-abliterated-Q3_K_M.gguf', 1515),
      file('bartowski/Qwen2.5-Coder-3B-Instruct-abliterated-GGUF', 'Qwen2.5-Coder-3B-Instruct-abliterated-Q4_K_M.gguf', 1843)
    ]
  }),
  entry({
    id: 'qwen2.5-coder-7b-abliterated',
    ollamaName: 'litemind-qwen2.5-coder-7b-abliterated',
    displayName: 'Qwen2.5 Coder 7B Abliterated',
    category: 'uncensored-coding',
    uncensored: true,
    uncensoredLabel: 'Abliterated',
    params: '7B',
    family: 'qwen2.5-coder',
    purpose: 'Мощный coding без отказов. Только 16+ ГБ RAM и только Q2/Q3 квант.',
    license: 'apache-2.0',
    repo: 'bartowski/Qwen2.5-Coder-7B-Instruct-abliterated-GGUF',
    notes: 'На 16 ГБ машинах рекомендуется только с Q2_K/Q3_K_S и закрытыми тяжёлыми приложениями.',
    files: [
      file('bartowski/Qwen2.5-Coder-7B-Instruct-abliterated-GGUF', 'Qwen2.5-Coder-7B-Instruct-abliterated-Q2_K.gguf', 2877),
      file('bartowski/Qwen2.5-Coder-7B-Instruct-abliterated-GGUF', 'Qwen2.5-Coder-7B-Instruct-abliterated-Q3_K_S.gguf', 3328),
      file('bartowski/Qwen2.5-Coder-7B-Instruct-abliterated-GGUF', 'Qwen2.5-Coder-7B-Instruct-abliterated-Q4_K_M.gguf', 4465)
    ]
  }),
  entry({
    id: 'qwen2.5-coder-1.5b-noncensure',
    ollamaName: 'litemind-qwen2.5-coder-1.5b-noncensure',
    displayName: 'Qwen2.5 Coder 1.5B Non-Censure (Tree-AI)',
    category: 'uncensored-coding',
    uncensored: true,
    uncensoredLabel: 'Uncensored',
    params: '1.5B',
    family: 'qwen2.5-coder',
    purpose: 'Uncensored-вариант для мобильных/слабых устройств, один готовый файл Q4_K_M.',
    license: 'not specified',
    licenseNote: 'Репозиторий не указывает лицензию — проверьте перед коммерческим использованием.',
    repo: 'Tree-AI-lab/Qwen2.5-Coder-1.5B-Instruct-non-censure-uncensored-coder-for-android-GGUF',
    files: [
      file('Tree-AI-lab/Qwen2.5-Coder-1.5B-Instruct-non-censure-uncensored-coder-for-android-GGUF', 'Qwen2.5-Coder-1.5B-Instruct-abliterated-Q4_K_M.gguf', 1065)
    ]
  }),

  // ── Small Coding Models ─────────────────────────────────────────────────
  entry({
    id: 'qwen2.5-coder-0.5b',
    ollamaName: 'litemind-qwen2.5-coder-0.5b',
    displayName: 'Qwen2.5 Coder 0.5B',
    category: 'small-coding',
    params: '0.5B',
    family: 'qwen2.5-coder',
    purpose: 'Самая лёгкая coding-модель: автодополнение, мелкие правки. Работает даже на 8 ГБ.',
    license: 'apache-2.0',
    repo: 'bartowski/Qwen2.5-Coder-0.5B-Instruct-GGUF',
    files: [
      file('bartowski/Qwen2.5-Coder-0.5B-Instruct-GGUF', 'Qwen2.5-Coder-0.5B-Instruct-Q4_K_M.gguf', 379),
      file('bartowski/Qwen2.5-Coder-0.5B-Instruct-GGUF', 'Qwen2.5-Coder-0.5B-Instruct-Q5_K_M.gguf', 399)
    ]
  }),
  entry({
    id: 'qwen2.5-coder-1.5b',
    ollamaName: 'litemind-qwen2.5-coder-1.5b',
    displayName: 'Qwen2.5 Coder 1.5B',
    category: 'small-coding',
    params: '1.5B',
    family: 'qwen2.5-coder',
    purpose: 'Оптимальная модель для N5095A / 16 ГБ: функции, рефакторинг, объяснение кода.',
    license: 'apache-2.0',
    repo: 'bartowski/Qwen2.5-Coder-1.5B-Instruct-GGUF',
    files: [
      file('bartowski/Qwen2.5-Coder-1.5B-Instruct-GGUF', 'Qwen2.5-Coder-1.5B-Instruct-Q2_K.gguf', 645),
      file('bartowski/Qwen2.5-Coder-1.5B-Instruct-GGUF', 'Qwen2.5-Coder-1.5B-Instruct-Q3_K_M.gguf', 789),
      file('bartowski/Qwen2.5-Coder-1.5B-Instruct-GGUF', 'Qwen2.5-Coder-1.5B-Instruct-Q4_K_M.gguf', 942)
    ]
  }),
  entry({
    id: 'qwen2.5-coder-3b',
    ollamaName: 'litemind-qwen2.5-coder-3b',
    displayName: 'Qwen2.5 Coder 3B',
    category: 'small-coding',
    params: '3B',
    family: 'qwen2.5-coder',
    purpose: 'Заметно умнее 1.5B: многокомпонентные правки, работа с проектом.',
    license: 'qwen-research (other)',
    repo: 'bartowski/Qwen2.5-Coder-3B-Instruct-GGUF',
    notes: 'Лицензия Qwen Research — использование не в исследовательских целях требует проверки лицензии.',
    files: [
      file('bartowski/Qwen2.5-Coder-3B-Instruct-GGUF', 'Qwen2.5-Coder-3B-Instruct-Q2_K.gguf', 1219),
      file('bartowski/Qwen2.5-Coder-3B-Instruct-GGUF', 'Qwen2.5-Coder-3B-Instruct-Q3_K_M.gguf', 1515),
      file('bartowski/Qwen2.5-Coder-3B-Instruct-GGUF', 'Qwen2.5-Coder-3B-Instruct-Q4_K_M.gguf', 1843)
    ]
  }),
  entry({
    id: 'deepseek-coder-1.3b',
    ollamaName: 'litemind-deepseek-coder-1.3b',
    displayName: 'DeepSeek Coder 1.3B',
    category: 'small-coding',
    params: '1.3B',
    family: 'deepseek-coder',
    purpose: 'Классический coding-инструктор; силён в Python и завершении кода.',
    license: 'deepseek (other)',
    repo: 'TheBloke/deepseek-coder-1.3b-instruct-GGUF',
    notes: 'Контекст 16k. Старее Qwen2.5-Coder, но до сих пор стабилен.',
    contextTokens: 16384,
    files: [
      file('TheBloke/deepseek-coder-1.3b-instruct-GGUF', 'deepseek-coder-1.3b-instruct.Q2_K.gguf', 604),
      file('TheBloke/deepseek-coder-1.3b-instruct-GGUF', 'deepseek-coder-1.3b-instruct.Q3_K_M.gguf', 676),
      file('TheBloke/deepseek-coder-1.3b-instruct-GGUF', 'deepseek-coder-1.3b-instruct.Q4_K_M.gguf', 829)
    ]
  }),
  entry({
    id: 'starcoder2-3b',
    ollamaName: 'litemind-starcoder2-3b',
    displayName: 'StarCoder2 3B Instruct',
    category: 'small-coding',
    params: '3B',
    family: 'starcoder2',
    purpose: '80+ языков программирования, альтернативный стиль ответов.',
    license: 'bigcode-openrail-m (other)',
    contextTokens: 16384,
    repo: 'QuantFactory/starcoder2-3b-instruct-v0.1-GGUF',
    files: [
      file('QuantFactory/starcoder2-3b-instruct-v0.1-GGUF', 'starcoder2-3b-instruct-v0.1.Q2_K.gguf', 1168),
      file('QuantFactory/starcoder2-3b-instruct-v0.1-GGUF', 'starcoder2-3b-instruct-v0.1.Q3_K_M.gguf', 1495),
      file('QuantFactory/starcoder2-3b-instruct-v0.1-GGUF', 'starcoder2-3b-instruct-v0.1.Q4_K_M.gguf', 1802)
    ]
  }),
  entry({
    id: 'granite-code-3b',
    ollamaName: 'litemind-granite-code-3b',
    displayName: 'Granite Code 3B Instruct',
    category: 'small-coding',
    params: '3B',
    family: 'granite-code',
    purpose: 'IBM-модель для корпоративного кода; аккуратные, консервативные ответы.',
    license: 'apache-2.0',
    contextTokens: 8192,
    repo: 'mradermacher/granite-3b-code-instruct-i1-GGUF',
    files: [
      file('mradermacher/granite-3b-code-instruct-i1-GGUF', 'granite-3b-code-instruct.i1-Q2_K.gguf', 1280),
      file('mradermacher/granite-3b-code-instruct-i1-GGUF', 'granite-3b-code-instruct.i1-Q3_K_M.gguf', 1649),
      file('mradermacher/granite-3b-code-instruct-i1-GGUF', 'granite-3b-code-instruct.i1-Q4_K_M.gguf', 2038)
    ]
  }),

  // ── Advanced Coding Models (только 16+ ГБ RAM) ──────────────────────────
  entry({
    id: 'qwen2.5-coder-7b',
    ollamaName: 'litemind-qwen2.5-coder-7b',
    displayName: 'Qwen2.5 Coder 7B',
    category: 'advanced-coding',
    params: '7B',
    family: 'qwen2.5-coder',
    purpose: 'Максимум качества в каталоге: сложный рефакторинг, большие правки, агенты.',
    license: 'apache-2.0',
    repo: 'bartowski/Qwen2.5-Coder-7B-Instruct-GGUF',
    notes: 'На 16 ГБ — только Q2_K/Q3_K_S; медленно на CPU без AVX (~1–3 ток/с).',
    files: [
      file('bartowski/Qwen2.5-Coder-7B-Instruct-GGUF', 'Qwen2.5-Coder-7B-Instruct-Q2_K.gguf', 2877),
      file('bartowski/Qwen2.5-Coder-7B-Instruct-GGUF', 'Qwen2.5-Coder-7B-Instruct-Q3_K_S.gguf', 3328),
      file('bartowski/Qwen2.5-Coder-7B-Instruct-GGUF', 'Qwen2.5-Coder-7B-Instruct-Q4_K_M.gguf', 4465)
    ]
  }),
  entry({
    id: 'deepseek-coder-6.7b',
    ollamaName: 'litemind-deepseek-coder-6.7b',
    displayName: 'DeepSeek Coder 6.7B',
    category: 'advanced-coding',
    params: '6.7B',
    family: 'deepseek-coder',
    purpose: 'Сильный конкурент Qwen 7B; глубокие объяснения и длинный код.',
    license: 'deepseek (other)',
    contextTokens: 16384,
    repo: 'TheBloke/deepseek-coder-6.7b-instruct-GGUF',
    notes: 'Только для 16 ГБ машин с Q2_K/Q3_K_S.',
    files: [
      file('TheBloke/deepseek-coder-6.7b-instruct-GGUF', 'deepseek-coder-6.7b-instruct.Q2_K.gguf', 2693),
      file('TheBloke/deepseek-coder-6.7b-instruct-GGUF', 'deepseek-coder-6.7b-instruct.Q3_K_S.gguf', 2816),
      file('TheBloke/deepseek-coder-6.7b-instruct-GGUF', 'deepseek-coder-6.7b-instruct.Q4_K_M.gguf', 3891)
    ]
  })
];

export function catalogEntry(id) {
  return CATALOG.find((m) => m.id === id) ?? null;
}
