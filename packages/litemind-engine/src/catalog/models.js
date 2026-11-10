// LiteMind Model Catalog v3 — только проверенные записи.
//
// Источник данных: официальный Hugging Face API (последняя проверка: 2026-11-10):
//  - репозиторий существует и публичен (gated-репозитории не попадают или помечены);
//  - размер и LFS SHA-256 каждого GGUF сняты с /api/models/<repo>/tree/main;
//  - лицензия — из тегов репозитория, сомнительные помечены licenseNote;
//  - developer — автор модели (или «дообучение», если модель производная);
//  - purposes — назначения по ТЗ Этапа 1Б §2.1 (одна модель может иметь несколько);
//  - verifiedAt — дата последней проверки сведений записи.
// Сгенерировано scripts/gen-catalog-v3.mjs. Никаких фиктивных ссылок.
//
// Категории ограничений (ТЗ):
//  - restrictions: 'standard' — обычные встроенные ограничения разработчика;
//  - restrictions: 'reduced'  — uncensored/abliterated: отказы ослаблены обучением,
//    но «абсолютной свободы» не существует — поведение зависит от модели.
//
// Расширяемость (ТЗ §8): сервер может дополнять каталог файлом-оверрайдом
// (catalog-override.json в папке конфигурации) и опциональным удалённым JSON.
// Без интернета каталог работает в полном объёме — данные вшиты в приложение.

export const CATALOG_VERSION = { version: 3, verifiedAt: '2026-11-10', generatedBy: 'scripts/gen-catalog-v3.mjs' };

export const CATEGORIES = {
  "chat-tiny": "Общение · до 1B (сверхлёгкие)",
  "chat-small": "Общение · 1–4B (зона слабых ПК)",
  "chat-mid": "Общение · 7B+ (мощные)",
  "small-coding": "Coding · компактные",
  "advanced-coding": "Coding · продвинутые",
  "reasoning": "Логика и анализ (reasoning)",
  "russian": "Русский язык",
  "uncensored-coding": "Ослабленные ограничения · Coding",
  "uncensored-chat": "Ослабленные ограничения · Общение"
};

// Назначения моделей (Этап 1Б §2.1). Ключи используются в поле purposes записей.
export const PURPOSES = {
  "coding": "Программирование и разработка",
  "chat": "Общение и универсальные задачи",
  "writing": "Написание текстов",
  "analysis": "Анализ документов",
  "translation": "Перевод",
  "math": "Математика и логика",
  "long-context": "Работа с длинным контекстом",
  "creative": "Творческие задачи",
  "multilingual": "Мультиязычные модели"
};

// Семейства, проверенные на собственном runtime LiteMind (llama.cpp сборка
// без AVX-требований). Модели с неизвестным семейством не помечаются как
// гарантированно совместимые — см. compat.js.
export const RUNTIME_VERIFIED_FAMILIES = new Set([
  "smollm2", "smollm3", "qwen2.5", "qwen2.5-coder", "qwen3", "qwen3.5",
  "vikhr", "gemma2", "gemma3", "llama3.2", "tinyllama", "mistral",
  "ministral", "phi4", "phi3.5", "deepseek-r1", "deepseek-coder",
  "saiga", "starcoder2", "granite-code", "dolphin",
  "huihui-qwen2.5", "huihui-qwen3", "huihui-qwen3.5", "huihui-llama3.2"
]);

export const CATALOG = [
  {
    "id": "smollm2-360m-instruct",
    "ollamaName": "litemind-smollm2-360m-instruct",
    "displayName": "SmolLM2 360M Instruct",
    "category": "chat-tiny",
    "restrictions": "standard",
    "uncensored": false,
    "uncensoredLabel": null,
    "tags": [
      "chat",
      "general",
      "tiny"
    ],
    "languages": [
      "en"
    ],
    "params": "0.36B",
    "family": "smollm2",
    "purpose": "Сверхлёгкая модель-болталка от Hugging Face. Работает даже на 4 ГБ RAM и очень быстра на N5095A.",
    "quality": "Скромный интеллект, но живой и надёжный для простых вопросов и черновиков.",
    "speed": "fast",
    "license": "apache-2.0",
    "licenseNote": null,
    "source": "https://huggingface.co/mradermacher/SmolLM2-360M-Instruct-GGUF",
    "repo": "mradermacher/SmolLM2-360M-Instruct-GGUF",
    "quantAuthor": "mradermacher (кванты; модель — HuggingFaceTB)",
    "contextTokens": 8192,
    "tools": true,
    "vision": false,
    "notes": null,
    "files": [
      {
        "quant": "Q4_K_M",
        "name": "SmolLM2-360M-Instruct.Q4_K_M.gguf",
        "url": "https://huggingface.co/mradermacher/SmolLM2-360M-Instruct-GGUF/resolve/main/SmolLM2-360M-Instruct.Q4_K_M.gguf",
        "sizeBytes": 270590976,
        "sha256": "ade7aee1e5bd7c3b8f1fedafc61a1a0be31e8afa64e006607cd202323e2ccce0"
      },
      {
        "quant": "Q5_K_M",
        "name": "SmolLM2-360M-Instruct.Q5_K_M.gguf",
        "url": "https://huggingface.co/mradermacher/SmolLM2-360M-Instruct-GGUF/resolve/main/SmolLM2-360M-Instruct.Q5_K_M.gguf",
        "sizeBytes": 289944576,
        "sha256": "c4f7c7eb372d2561d06e7870774e33c06d90e603c900948185f459a989493f3a"
      },
      {
        "quant": "Q6_K",
        "name": "SmolLM2-360M-Instruct.Q6_K.gguf",
        "url": "https://huggingface.co/mradermacher/SmolLM2-360M-Instruct-GGUF/resolve/main/SmolLM2-360M-Instruct.Q6_K.gguf",
        "sizeBytes": 367358976,
        "sha256": "dae31e991b410abcef7fc3b2b0c6a06a78dc632693c5ba154e7be834108d03d4"
      },
      {
        "quant": "Q8_0",
        "name": "SmolLM2-360M-Instruct.Q8_0.gguf",
        "url": "https://huggingface.co/mradermacher/SmolLM2-360M-Instruct-GGUF/resolve/main/SmolLM2-360M-Instruct.Q8_0.gguf",
        "sizeBytes": 386405376,
        "sha256": "0e9edf66381198c0a2710fd1ef46309c6e812ef60ae339d9037bb5b13fcad5b7"
      }
    ],
    "developer": "HuggingFaceTB",
    "purposes": [
      "chat",
      "writing",
      "creative"
    ],
    "verifiedAt": "2026-11-10"
  },
  {
    "id": "qwen3-0.6b",
    "ollamaName": "litemind-qwen3-0.6b",
    "displayName": "Qwen3 0.6B",
    "category": "chat-tiny",
    "restrictions": "standard",
    "uncensored": false,
    "uncensoredLabel": null,
    "tags": [
      "chat",
      "general",
      "tiny",
      "reasoning-lite"
    ],
    "languages": [
      "ru",
      "en",
      "multi"
    ],
    "params": "0.6B",
    "family": "qwen3",
    "purpose": "Молодое поколение Qwen: рассуждения в стиле «thinking», честный русский для размера.",
    "quality": "Заметно умнее TinyLlama при том же размере; режим thinking можно отключить в промпте.",
    "speed": "fast",
    "license": "qwen-research (other)",
    "licenseNote": "Лицензия Qwen Research — проверьте условия для коммерческого использования.",
    "source": "https://huggingface.co/bartowski/Qwen_Qwen3-0.6B-GGUF",
    "repo": "bartowski/Qwen_Qwen3-0.6B-GGUF",
    "quantAuthor": "bartowski",
    "contextTokens": 32768,
    "tools": true,
    "vision": false,
    "notes": "Лицензия Qwen Research — проверьте условия для коммерческого использования.",
    "files": [
      {
        "quant": "Q4_K_M",
        "name": "Qwen_Qwen3-0.6B-Q4_K_M.gguf",
        "url": "https://huggingface.co/bartowski/Qwen_Qwen3-0.6B-GGUF/resolve/main/Qwen_Qwen3-0.6B-Q4_K_M.gguf",
        "sizeBytes": 484220320,
        "sha256": "9acfc1e001311f34b4252001b626f2e466d592a42065f66571bff3790d4e1b14"
      },
      {
        "quant": "Q5_K_M",
        "name": "Qwen_Qwen3-0.6B-Q5_K_M.gguf",
        "url": "https://huggingface.co/bartowski/Qwen_Qwen3-0.6B-GGUF/resolve/main/Qwen_Qwen3-0.6B-Q5_K_M.gguf",
        "sizeBytes": 551378336,
        "sha256": "2df7894c99ee7716f0ed3c7d454c2386a7ae976c4b0ad0e716d55399c1360648"
      },
      {
        "quant": "Q6_K",
        "name": "Qwen_Qwen3-0.6B-Q6_K.gguf",
        "url": "https://huggingface.co/bartowski/Qwen_Qwen3-0.6B-GGUF/resolve/main/Qwen_Qwen3-0.6B-Q6_K.gguf",
        "sizeBytes": 622733728,
        "sha256": "21e95febea68b223089e2382378e8c3155e587f5a6618ae3595e3d00c6885575"
      },
      {
        "quant": "Q8_0",
        "name": "Qwen_Qwen3-0.6B-Q8_0.gguf",
        "url": "https://huggingface.co/bartowski/Qwen_Qwen3-0.6B-GGUF/resolve/main/Qwen_Qwen3-0.6B-Q8_0.gguf",
        "sizeBytes": 804753824,
        "sha256": "c159d1518f16bc42533d9a09f034eb598b670341adc2b08b9a9751614aea71eb"
      }
    ],
    "developer": "Qwen Team (Alibaba)",
    "purposes": [
      "chat",
      "writing",
      "creative",
      "math",
      "multilingual",
      "translation",
      "long-context"
    ],
    "verifiedAt": "2026-11-10"
  },
  {
    "id": "vikhr-qwen-0.5b",
    "ollamaName": "litemind-vikhr-qwen-0.5b",
    "displayName": "Vikhr Qwen 2.5 0.5B (RU)",
    "category": "chat-tiny",
    "restrictions": "standard",
    "uncensored": false,
    "uncensoredLabel": null,
    "tags": [
      "chat",
      "russian",
      "tiny"
    ],
    "languages": [
      "ru",
      "en"
    ],
    "params": "0.5B",
    "family": "vikhr",
    "purpose": "Русскоязычная адаптация Qwen 2.5 0.5B от команды Vikhr: живой русский в самой лёгкой весовой категории.",
    "quality": "Для своих 0.5B — один из лучших русских вариантов; сложные темы не потянет.",
    "speed": "fast",
    "license": "apache-2.0",
    "licenseNote": null,
    "source": "https://huggingface.co/Vikhrmodels/Vikhr-Qwen-2.5-0.5B-instruct-GGUF",
    "repo": "Vikhrmodels/Vikhr-Qwen-2.5-0.5B-instruct-GGUF",
    "quantAuthor": "Vikhrmodels (официальный)",
    "contextTokens": 32768,
    "tools": true,
    "vision": false,
    "notes": null,
    "files": [
      {
        "quant": "Q4_K_M",
        "name": "Vikhr-Qwen-2.5-0.5B-instruct-Q4_K_M.gguf",
        "url": "https://huggingface.co/Vikhrmodels/Vikhr-Qwen-2.5-0.5B-instruct-GGUF/resolve/main/Vikhr-Qwen-2.5-0.5B-instruct-Q4_K_M.gguf",
        "sizeBytes": 397543680,
        "sha256": "8f45f00da2bcd70205461639e978db7c8245e205c8604cfe2ab7f5430506bf32"
      },
      {
        "quant": "Q5_K_M",
        "name": "Vikhr-Qwen-2.5-0.5B-instruct-Q5_K_M.gguf",
        "url": "https://huggingface.co/Vikhrmodels/Vikhr-Qwen-2.5-0.5B-instruct-GGUF/resolve/main/Vikhr-Qwen-2.5-0.5B-instruct-Q5_K_M.gguf",
        "sizeBytes": 419821824,
        "sha256": "7a37b861539603247887fe4044d69535c0230291e9707718dfd106efc6dbe81e"
      },
      {
        "quant": "Q6_K",
        "name": "Vikhr-Qwen-2.5-0.5B-instruct-Q6_K.gguf",
        "url": "https://huggingface.co/Vikhrmodels/Vikhr-Qwen-2.5-0.5B-instruct-GGUF/resolve/main/Vikhr-Qwen-2.5-0.5B-instruct-Q6_K.gguf",
        "sizeBytes": 505472256,
        "sha256": "9f728fcb4bb527fec59d993c02850e034fcba86a723f9b515095cfe3549a5550"
      },
      {
        "quant": "Q8_0",
        "name": "Vikhr-Qwen-2.5-0.5B-instruct-Q8_0.gguf",
        "url": "https://huggingface.co/Vikhrmodels/Vikhr-Qwen-2.5-0.5B-instruct-GGUF/resolve/main/Vikhr-Qwen-2.5-0.5B-instruct-Q8_0.gguf",
        "sizeBytes": 530803968,
        "sha256": "43df3b688d17f68321648bbf55c871ee9674350417b630994fa41b73a7557352"
      }
    ],
    "developer": "Vikhrmodels",
    "purposes": [
      "chat",
      "writing",
      "creative",
      "long-context"
    ],
    "verifiedAt": "2026-11-10"
  },
  {
    "id": "qwen2.5-1.5b-instruct",
    "ollamaName": "litemind-qwen2.5-1.5b-instruct",
    "displayName": "Qwen2.5 1.5B Instruct",
    "category": "chat-small",
    "restrictions": "standard",
    "uncensored": false,
    "uncensoredLabel": null,
    "tags": [
      "chat",
      "general"
    ],
    "languages": [
      "ru",
      "en",
      "multi"
    ],
    "params": "1.5B",
    "family": "qwen2.5",
    "purpose": "Универсальная модель для общения и текстов; уверенный русский, инструменты, 32k контекст.",
    "quality": "Лучший баланс «скорость/ум» для слабых ПК без видеокарты.",
    "speed": "fast",
    "license": "apache-2.0",
    "licenseNote": null,
    "source": "https://huggingface.co/bartowski/Qwen2.5-1.5B-Instruct-GGUF",
    "repo": "bartowski/Qwen2.5-1.5B-Instruct-GGUF",
    "quantAuthor": "bartowski",
    "contextTokens": 32768,
    "tools": true,
    "vision": false,
    "notes": null,
    "files": [
      {
        "quant": "Q3_K_M",
        "name": "Qwen2.5-1.5B-Instruct-Q3_K_M.gguf",
        "url": "https://huggingface.co/bartowski/Qwen2.5-1.5B-Instruct-GGUF/resolve/main/Qwen2.5-1.5B-Instruct-Q3_K_M.gguf",
        "sizeBytes": 824178784,
        "sha256": "7437ad04011a14fb890074cc783df4c1d537197942337353a824ff7e6115ef9b"
      },
      {
        "quant": "Q4_K_M",
        "name": "Qwen2.5-1.5B-Instruct-Q4_K_M.gguf",
        "url": "https://huggingface.co/bartowski/Qwen2.5-1.5B-Instruct-GGUF/resolve/main/Qwen2.5-1.5B-Instruct-Q4_K_M.gguf",
        "sizeBytes": 986048768,
        "sha256": "1adf0b11065d8ad2e8123ea110d1ec956dab4ab038eab665614adba04b6c3370"
      },
      {
        "quant": "Q5_K_M",
        "name": "Qwen2.5-1.5B-Instruct-Q5_K_M.gguf",
        "url": "https://huggingface.co/bartowski/Qwen2.5-1.5B-Instruct-GGUF/resolve/main/Qwen2.5-1.5B-Instruct-Q5_K_M.gguf",
        "sizeBytes": 1125050624,
        "sha256": "cf240adc57e126e86102335f6565fb23e523b28d287c75bdb0759f064e8bb572"
      },
      {
        "quant": "Q6_K",
        "name": "Qwen2.5-1.5B-Instruct-Q6_K.gguf",
        "url": "https://huggingface.co/bartowski/Qwen2.5-1.5B-Instruct-GGUF/resolve/main/Qwen2.5-1.5B-Instruct-Q6_K.gguf",
        "sizeBytes": 1272740096,
        "sha256": "1b01b4ea4ccdd5aa6a5972790002e120a5d500a5175be571114d642a8db4d14e"
      }
    ],
    "developer": "Qwen Team (Alibaba)",
    "purposes": [
      "chat",
      "writing",
      "creative",
      "multilingual",
      "translation",
      "long-context"
    ],
    "verifiedAt": "2026-11-10"
  },
  {
    "id": "qwen3-1.7b",
    "ollamaName": "litemind-qwen3-1.7b",
    "displayName": "Qwen3 1.7B",
    "category": "chat-small",
    "restrictions": "standard",
    "uncensored": false,
    "uncensoredLabel": null,
    "tags": [
      "chat",
      "general",
      "reasoning-lite"
    ],
    "languages": [
      "ru",
      "en",
      "multi"
    ],
    "params": "1.7B",
    "family": "qwen3",
    "purpose": "Поколение Qwen3: гибридное «мышление», крепкая логика и русский для 1.7B.",
    "quality": "Один из самых умных вариантов в классе до 2B.",
    "speed": "fast",
    "license": "qwen-research (other)",
    "licenseNote": "Лицензия Qwen Research — проверьте условия для коммерческого использования.",
    "source": "https://huggingface.co/bartowski/Qwen_Qwen3-1.7B-GGUF",
    "repo": "bartowski/Qwen_Qwen3-1.7B-GGUF",
    "quantAuthor": "bartowski",
    "contextTokens": 32768,
    "tools": true,
    "vision": false,
    "notes": "Лицензия Qwen Research — проверьте условия для коммерческого использования.",
    "files": [
      {
        "quant": "Q3_K_M",
        "name": "Qwen_Qwen3-1.7B-Q3_K_M.gguf",
        "url": "https://huggingface.co/bartowski/Qwen_Qwen3-1.7B-GGUF/resolve/main/Qwen_Qwen3-1.7B-Q3_K_M.gguf",
        "sizeBytes": 1073242528,
        "sha256": "d544d30dbb7b2f608775d69c939a9b8d89c45df2be1a5ad1390ddc1bd7f8d6f5"
      },
      {
        "quant": "Q4_K_M",
        "name": "Qwen_Qwen3-1.7B-Q4_K_M.gguf",
        "url": "https://huggingface.co/bartowski/Qwen_Qwen3-1.7B-GGUF/resolve/main/Qwen_Qwen3-1.7B-Q4_K_M.gguf",
        "sizeBytes": 1282439584,
        "sha256": "72c5c3cb38fa32d5256e2fe30d03e7a64c6c79e668ad84057e3bd66e250b24fb"
      },
      {
        "quant": "Q5_K_M",
        "name": "Qwen_Qwen3-1.7B-Q5_K_M.gguf",
        "url": "https://huggingface.co/bartowski/Qwen_Qwen3-1.7B-GGUF/resolve/main/Qwen_Qwen3-1.7B-Q5_K_M.gguf",
        "sizeBytes": 1471805856,
        "sha256": "4287aca1b231f27dbd20012c4bf9693c89b6c849dc02b7027096da54564d4037"
      },
      {
        "quant": "Q6_K",
        "name": "Qwen_Qwen3-1.7B-Q6_K.gguf",
        "url": "https://huggingface.co/bartowski/Qwen_Qwen3-1.7B-GGUF/resolve/main/Qwen_Qwen3-1.7B-Q6_K.gguf",
        "sizeBytes": 1673007520,
        "sha256": "95aec3c8e76caf949b5a7a3b02adbb7e307eb0aa55880f6a6f9fb5f46abe6d4f"
      }
    ],
    "developer": "Qwen Team (Alibaba)",
    "purposes": [
      "chat",
      "writing",
      "creative",
      "math",
      "multilingual",
      "translation",
      "long-context"
    ],
    "verifiedAt": "2026-11-10"
  },
  {
    "id": "qwen3.5-4b",
    "ollamaName": "litemind-qwen3.5-4b",
    "displayName": "Qwen3.5 4B",
    "category": "chat-small",
    "restrictions": "standard",
    "uncensored": false,
    "uncensoredLabel": null,
    "tags": [
      "chat",
      "general",
      "reasoning-lite"
    ],
    "languages": [
      "ru",
      "en",
      "multi"
    ],
    "params": "4B",
    "family": "qwen3.5",
    "purpose": "Свежая модель Qwen 4B под Apache-2.0: сильные рассуждения и русский в весе, который реально тянет 16 ГБ.",
    "quality": "Топ класса 4B в 2026; рекомендуемый «умный» выбор для N5095A/16 ГБ.",
    "speed": "medium",
    "license": "apache-2.0",
    "licenseNote": null,
    "source": "https://huggingface.co/bartowski/Qwen_Qwen3.5-4B-GGUF",
    "repo": "bartowski/Qwen_Qwen3.5-4B-GGUF",
    "quantAuthor": "bartowski",
    "contextTokens": 32768,
    "tools": true,
    "vision": false,
    "notes": null,
    "files": [
      {
        "quant": "Q2_K",
        "name": "Qwen_Qwen3.5-4B-Q2_K.gguf",
        "url": "https://huggingface.co/bartowski/Qwen_Qwen3.5-4B-GGUF/resolve/main/Qwen_Qwen3.5-4B-Q2_K.gguf",
        "sizeBytes": 2191779808,
        "sha256": "8875934081d3b9b51b41de628e34d964a15d3fac5b5592baf2c01c5a04460c9a"
      },
      {
        "quant": "Q3_K_M",
        "name": "Qwen_Qwen3.5-4B-Q3_K_M.gguf",
        "url": "https://huggingface.co/bartowski/Qwen_Qwen3.5-4B-GGUF/resolve/main/Qwen_Qwen3.5-4B-Q3_K_M.gguf",
        "sizeBytes": 2575656928,
        "sha256": "049c71be191fb980a2851ee4d141f437feb50f001191e9b51bd4f6ab2b04146a"
      },
      {
        "quant": "Q4_K_M",
        "name": "Qwen_Qwen3.5-4B-Q4_K_M.gguf",
        "url": "https://huggingface.co/bartowski/Qwen_Qwen3.5-4B-GGUF/resolve/main/Qwen_Qwen3.5-4B-Q4_K_M.gguf",
        "sizeBytes": 3013027808,
        "sha256": "13c16f426047e2de38cd075bdade4a7bcbc8c774384876f677740cda65f8a983"
      },
      {
        "quant": "Q5_K_M",
        "name": "Qwen_Qwen3.5-4B-Q5_K_M.gguf",
        "url": "https://huggingface.co/bartowski/Qwen_Qwen3.5-4B-GGUF/resolve/main/Qwen_Qwen3.5-4B-Q5_K_M.gguf",
        "sizeBytes": 3443763168,
        "sha256": "21c4643259ce62ffd979848e5819ce03823fd9e9902279ab54cc0d572d83d33e"
      }
    ],
    "developer": "Qwen Team (Alibaba)",
    "purposes": [
      "chat",
      "writing",
      "creative",
      "analysis",
      "math",
      "multilingual",
      "translation",
      "long-context"
    ],
    "verifiedAt": "2026-11-10"
  },
  {
    "id": "qwen3-4b",
    "ollamaName": "litemind-qwen3-4b",
    "displayName": "Qwen3 4B",
    "category": "chat-small",
    "restrictions": "standard",
    "uncensored": false,
    "uncensoredLabel": null,
    "tags": [
      "chat",
      "general",
      "reasoning-lite"
    ],
    "languages": [
      "ru",
      "en",
      "multi"
    ],
    "params": "4B",
    "family": "qwen3",
    "purpose": "Проверенная Qwen3 4B с режимом рассуждений; универсальный рабочий конь.",
    "quality": "Сильная логика для 4B; русский добротный.",
    "speed": "medium",
    "license": "qwen-research (other)",
    "licenseNote": "Лицензия Qwen Research — проверьте условия для коммерческого использования.",
    "source": "https://huggingface.co/bartowski/Qwen_Qwen3-4B-GGUF",
    "repo": "bartowski/Qwen_Qwen3-4B-GGUF",
    "quantAuthor": "bartowski",
    "contextTokens": 32768,
    "tools": true,
    "vision": false,
    "notes": "Лицензия Qwen Research — проверьте условия для коммерческого использования.",
    "files": [
      {
        "quant": "Q2_K",
        "name": "Qwen_Qwen3-4B-Q2_K.gguf",
        "url": "https://huggingface.co/bartowski/Qwen_Qwen3-4B-GGUF/resolve/main/Qwen_Qwen3-4B-Q2_K.gguf",
        "sizeBytes": 1669499840,
        "sha256": "ebdb400de15507a3ac524785929464e7b7d1df9677b0387a3977958a56bd38bb"
      },
      {
        "quant": "Q3_K_M",
        "name": "Qwen_Qwen3-4B-Q3_K_M.gguf",
        "url": "https://huggingface.co/bartowski/Qwen_Qwen3-4B-GGUF/resolve/main/Qwen_Qwen3-4B-Q3_K_M.gguf",
        "sizeBytes": 2075618240,
        "sha256": "29183d72b1b4e9666287d82acb9aea189512c99cb3bf6d9c77c4a43ebcb30414"
      },
      {
        "quant": "Q4_K_M",
        "name": "Qwen_Qwen3-4B-Q4_K_M.gguf",
        "url": "https://huggingface.co/bartowski/Qwen_Qwen3-4B-GGUF/resolve/main/Qwen_Qwen3-4B-Q4_K_M.gguf",
        "sizeBytes": 2497280960,
        "sha256": "fbe1d5edd4ce802ae3ae7c7e4ab7d09789d697fdac1fc7929f8df4ca3c41bae3"
      },
      {
        "quant": "Q5_K_M",
        "name": "Qwen_Qwen3-4B-Q5_K_M.gguf",
        "url": "https://huggingface.co/bartowski/Qwen_Qwen3-4B-GGUF/resolve/main/Qwen_Qwen3-4B-Q5_K_M.gguf",
        "sizeBytes": 2889513920,
        "sha256": "3e6002bee4457c8061c04bfb742c3b23aca976606dfe0e0963cbfd434a370eac"
      }
    ],
    "developer": "Qwen Team (Alibaba)",
    "purposes": [
      "chat",
      "writing",
      "creative",
      "analysis",
      "math",
      "multilingual",
      "translation",
      "long-context"
    ],
    "verifiedAt": "2026-11-10"
  },
  {
    "id": "gemma-3-1b-it",
    "ollamaName": "litemind-gemma-3-1b-it",
    "displayName": "Gemma 3 1B Instruct",
    "category": "chat-small",
    "restrictions": "standard",
    "uncensored": false,
    "uncensoredLabel": null,
    "tags": [
      "chat",
      "general",
      "tiny"
    ],
    "languages": [
      "ru",
      "en",
      "multi"
    ],
    "params": "1B",
    "family": "gemma3",
    "purpose": "Компактная Google Gemma 3: аккуратный тон, хороший мультиязык, 128k контекст (в LiteMind ограничивается по RAM).",
    "quality": "Для 1B — очень достойный текст и стиль.",
    "speed": "fast",
    "license": "gemma",
    "licenseNote": "Лицензия Gemma: разрешено коммерческое использование с ограничениями Google.",
    "source": "https://huggingface.co/bartowski/google_gemma-3-1b-it-GGUF",
    "repo": "bartowski/google_gemma-3-1b-it-GGUF",
    "quantAuthor": "bartowski",
    "contextTokens": 32768,
    "tools": true,
    "vision": false,
    "notes": "Лицензия Gemma: разрешено коммерческое использование с ограничениями Google.",
    "files": [
      {
        "quant": "Q4_K_M",
        "name": "google_gemma-3-1b-it-Q4_K_M.gguf",
        "url": "https://huggingface.co/bartowski/google_gemma-3-1b-it-GGUF/resolve/main/google_gemma-3-1b-it-Q4_K_M.gguf",
        "sizeBytes": 806058496,
        "sha256": "12bf0fff8815d5f73a3c9b586bd8fee8e7b248c935de70dec367679873d0f29d"
      },
      {
        "quant": "Q5_K_M",
        "name": "google_gemma-3-1b-it-Q5_K_M.gguf",
        "url": "https://huggingface.co/bartowski/google_gemma-3-1b-it-GGUF/resolve/main/google_gemma-3-1b-it-Q5_K_M.gguf",
        "sizeBytes": 851345920,
        "sha256": "59a10a3c8dc8a9c0bda2c8882198073b1cfebbb2b443aa2fc4cfca4f92eeb805"
      },
      {
        "quant": "Q6_K",
        "name": "google_gemma-3-1b-it-Q6_K.gguf",
        "url": "https://huggingface.co/bartowski/google_gemma-3-1b-it-GGUF/resolve/main/google_gemma-3-1b-it-Q6_K.gguf",
        "sizeBytes": 1011738880,
        "sha256": "ccad0cb14e9008f699f4b820110b899cf81983a987c40a05a8a1128d2fb713fb"
      },
      {
        "quant": "Q8_0",
        "name": "google_gemma-3-1b-it-Q8_0.gguf",
        "url": "https://huggingface.co/bartowski/google_gemma-3-1b-it-GGUF/resolve/main/google_gemma-3-1b-it-Q8_0.gguf",
        "sizeBytes": 1069306624,
        "sha256": "375e12a4a18929a641f9744b060d4a7cf4e279530750555828ec0c117870bc96"
      }
    ],
    "developer": "Google DeepMind",
    "purposes": [
      "chat",
      "writing",
      "creative",
      "multilingual",
      "translation",
      "long-context"
    ],
    "verifiedAt": "2026-11-10"
  },
  {
    "id": "gemma-2-2b-it",
    "ollamaName": "litemind-gemma-2-2b-it",
    "displayName": "Gemma 2 2B Instruct",
    "category": "chat-small",
    "restrictions": "standard",
    "uncensored": false,
    "uncensoredLabel": null,
    "tags": [
      "chat",
      "general"
    ],
    "languages": [
      "ru",
      "en",
      "multi"
    ],
    "params": "2B",
    "family": "gemma2",
    "purpose": "Классика Google 2B: спокойные, связные ответы, хорошо держит русский.",
    "quality": "Надёжная «рабочая лошадка» до 4 ГБ весов.",
    "speed": "fast",
    "license": "gemma",
    "licenseNote": "Лицензия Gemma: разрешено коммерческое использование с ограничениями Google.",
    "source": "https://huggingface.co/bartowski/gemma-2-2b-it-GGUF",
    "repo": "bartowski/gemma-2-2b-it-GGUF",
    "quantAuthor": "bartowski",
    "contextTokens": 8192,
    "tools": true,
    "vision": false,
    "notes": "Лицензия Gemma: разрешено коммерческое использование с ограничениями Google.",
    "files": [
      {
        "quant": "Q3_K_M",
        "name": "gemma-2-2b-it-IQ3_M.gguf",
        "url": "https://huggingface.co/bartowski/gemma-2-2b-it-GGUF/resolve/main/gemma-2-2b-it-IQ3_M.gguf",
        "sizeBytes": 1393561440,
        "sha256": "0cf261fa4069526530535a8d20ea4cf4c3d532b6b2047508d7349bb0cda14b2a"
      },
      {
        "quant": "Q4_K_M",
        "name": "gemma-2-2b-it-Q4_K_M.gguf",
        "url": "https://huggingface.co/bartowski/gemma-2-2b-it-GGUF/resolve/main/gemma-2-2b-it-Q4_K_M.gguf",
        "sizeBytes": 1708582752,
        "sha256": "e0aee85060f168f0f2d8473d7ea41ce2f3230c1bc1374847505ea599288a7787"
      },
      {
        "quant": "Q5_K_M",
        "name": "gemma-2-2b-it-Q5_K_M.gguf",
        "url": "https://huggingface.co/bartowski/gemma-2-2b-it-GGUF/resolve/main/gemma-2-2b-it-Q5_K_M.gguf",
        "sizeBytes": 1923278688,
        "sha256": "be65d5966f7efd40d9d8c9d5f6667582d861de52df20133991e2e9cb491150da"
      },
      {
        "quant": "Q6_K",
        "name": "gemma-2-2b-it-Q6_K.gguf",
        "url": "https://huggingface.co/bartowski/gemma-2-2b-it-GGUF/resolve/main/gemma-2-2b-it-Q6_K.gguf",
        "sizeBytes": 2151393120,
        "sha256": "f82c5c2230a8b452221706461eb93203443373625d96a05912d4f96c845c2775"
      }
    ],
    "developer": "Google DeepMind",
    "purposes": [
      "chat",
      "writing",
      "creative",
      "multilingual",
      "translation"
    ],
    "verifiedAt": "2026-11-10"
  },
  {
    "id": "llama-3.2-1b-instruct",
    "ollamaName": "litemind-llama-3.2-1b-instruct",
    "displayName": "Llama 3.2 1B Instruct",
    "category": "chat-small",
    "restrictions": "standard",
    "uncensored": false,
    "uncensoredLabel": null,
    "tags": [
      "chat",
      "general",
      "tiny"
    ],
    "languages": [
      "en",
      "multi"
    ],
    "params": "1.24B",
    "family": "llama3.2",
    "purpose": "Meta Llama 3.2 1B — эталон крошечной универсальной модели; русский слабее Qwen.",
    "quality": "Отличный английский и следование инструкциям; русский — базовый.",
    "speed": "fast",
    "license": "llama3.2",
    "licenseNote": "Лицензия Meta Llama 3.2: коммерческое использование разрешено (условия Meta).",
    "source": "https://huggingface.co/bartowski/Llama-3.2-1B-Instruct-GGUF",
    "repo": "bartowski/Llama-3.2-1B-Instruct-GGUF",
    "quantAuthor": "bartowski",
    "contextTokens": 32768,
    "tools": true,
    "vision": false,
    "notes": "Лицензия Meta Llama 3.2: коммерческое использование разрешено (условия Meta).",
    "files": [
      {
        "quant": "Q3_K_M",
        "name": "Llama-3.2-1B-Instruct-IQ3_M.gguf",
        "url": "https://huggingface.co/bartowski/Llama-3.2-1B-Instruct-GGUF/resolve/main/Llama-3.2-1B-Instruct-IQ3_M.gguf",
        "sizeBytes": 657289344,
        "sha256": "c80cc062a721c267ec50fee83fe6b55d36fc7abe708392dbe22e16fbd42687e8"
      },
      {
        "quant": "Q4_K_M",
        "name": "Llama-3.2-1B-Instruct-Q4_K_M.gguf",
        "url": "https://huggingface.co/bartowski/Llama-3.2-1B-Instruct-GGUF/resolve/main/Llama-3.2-1B-Instruct-Q4_K_M.gguf",
        "sizeBytes": 807694464,
        "sha256": "6f85a640a97cf2bf5b8e764087b1e83da0fdb51d7c9fab7d0fece9385611df83"
      },
      {
        "quant": "Q5_K_M",
        "name": "Llama-3.2-1B-Instruct-Q5_K_M.gguf",
        "url": "https://huggingface.co/bartowski/Llama-3.2-1B-Instruct-GGUF/resolve/main/Llama-3.2-1B-Instruct-Q5_K_M.gguf",
        "sizeBytes": 911503488,
        "sha256": "4f22f95fb1679ef8e2fd6f1659d23f06cd1dbedb79ff291db7413a7ae509e2a9"
      },
      {
        "quant": "Q6_K",
        "name": "Llama-3.2-1B-Instruct-Q6_K.gguf",
        "url": "https://huggingface.co/bartowski/Llama-3.2-1B-Instruct-GGUF/resolve/main/Llama-3.2-1B-Instruct-Q6_K.gguf",
        "sizeBytes": 1021800576,
        "sha256": "0f4c510daf16e0d1b3bc94931fd9296c28936bebdda2593687d4eb70c5b70628"
      }
    ],
    "developer": "Meta",
    "purposes": [
      "chat",
      "writing",
      "creative",
      "multilingual",
      "translation",
      "long-context"
    ],
    "verifiedAt": "2026-11-10"
  },
  {
    "id": "llama-3.2-3b-instruct",
    "ollamaName": "litemind-llama-3.2-3b-instruct",
    "displayName": "Llama 3.2 3B Instruct",
    "category": "chat-small",
    "restrictions": "standard",
    "uncensored": false,
    "uncensoredLabel": null,
    "tags": [
      "chat",
      "general"
    ],
    "languages": [
      "en",
      "multi"
    ],
    "params": "3.2B",
    "family": "llama3.2",
    "purpose": "Meta Llama 3.2 3B: зрелая экосистема, крепкие инструкции; русский средний.",
    "quality": "Стабильное качество 3B-класса от Meta.",
    "speed": "medium",
    "license": "llama3.2",
    "licenseNote": "Лицензия Meta Llama 3.2: коммерческое использование разрешено (условия Meta).",
    "source": "https://huggingface.co/bartowski/Llama-3.2-3B-Instruct-GGUF",
    "repo": "bartowski/Llama-3.2-3B-Instruct-GGUF",
    "quantAuthor": "bartowski",
    "contextTokens": 32768,
    "tools": true,
    "vision": false,
    "notes": "Лицензия Meta Llama 3.2: коммерческое использование разрешено (условия Meta).",
    "files": [
      {
        "quant": "Q3_K_M",
        "name": "Llama-3.2-3B-Instruct-IQ3_M.gguf",
        "url": "https://huggingface.co/bartowski/Llama-3.2-3B-Instruct-GGUF/resolve/main/Llama-3.2-3B-Instruct-IQ3_M.gguf",
        "sizeBytes": 1599668768,
        "sha256": "deac83b571f3982a12377181fdfd7780bf4ce8cbfbdcac179e4bf2ad47b1b228"
      },
      {
        "quant": "Q4_K_M",
        "name": "Llama-3.2-3B-Instruct-Q4_K_M.gguf",
        "url": "https://huggingface.co/bartowski/Llama-3.2-3B-Instruct-GGUF/resolve/main/Llama-3.2-3B-Instruct-Q4_K_M.gguf",
        "sizeBytes": 2019377696,
        "sha256": "6c1a2b41161032677be168d354123594c0e6e67d2b9227c84f296ad037c728ff"
      },
      {
        "quant": "Q5_K_M",
        "name": "Llama-3.2-3B-Instruct-Q5_K_M.gguf",
        "url": "https://huggingface.co/bartowski/Llama-3.2-3B-Instruct-GGUF/resolve/main/Llama-3.2-3B-Instruct-Q5_K_M.gguf",
        "sizeBytes": 2322154016,
        "sha256": "0b94ccd04d908304cec5246a3d942b64417a423bc5c6d47c73bc557e590b5194"
      },
      {
        "quant": "Q6_K",
        "name": "Llama-3.2-3B-Instruct-Q6_K.gguf",
        "url": "https://huggingface.co/bartowski/Llama-3.2-3B-Instruct-GGUF/resolve/main/Llama-3.2-3B-Instruct-Q6_K.gguf",
        "sizeBytes": 2643853856,
        "sha256": "1771887c15fc3d327cfee6fd593553b2126e88834bf48eae50e709d3f70dd998"
      }
    ],
    "developer": "Meta",
    "purposes": [
      "chat",
      "writing",
      "creative",
      "analysis",
      "multilingual",
      "translation",
      "long-context"
    ],
    "verifiedAt": "2026-11-10"
  },
  {
    "id": "qwen2.5-3b-instruct",
    "ollamaName": "litemind-qwen2.5-3b-instruct",
    "displayName": "Qwen2.5 3B Instruct",
    "category": "chat-small",
    "restrictions": "standard",
    "uncensored": false,
    "uncensoredLabel": null,
    "tags": [
      "chat",
      "general"
    ],
    "languages": [
      "ru",
      "en",
      "multi"
    ],
    "params": "3B",
    "family": "qwen2.5",
    "purpose": "Умная универсальная модель 3B: русский, тексты, объяснения — с запасом для 16 ГБ.",
    "quality": "Заметно умнее 1.5B, остаётся быстрой на 4 ядрах без AVX.",
    "speed": "medium",
    "license": "qwen-research (other)",
    "licenseNote": "Лицензия Qwen Research — проверьте условия для коммерческого использования.",
    "source": "https://huggingface.co/bartowski/Qwen2.5-3B-Instruct-GGUF",
    "repo": "bartowski/Qwen2.5-3B-Instruct-GGUF",
    "quantAuthor": "bartowski",
    "contextTokens": 32768,
    "tools": true,
    "vision": false,
    "notes": "Лицензия Qwen Research — проверьте условия для коммерческого использования.",
    "files": [
      {
        "quant": "Q2_K",
        "name": "Qwen2.5-3B-Instruct-Q2_K.gguf",
        "url": "https://huggingface.co/bartowski/Qwen2.5-3B-Instruct-GGUF/resolve/main/Qwen2.5-3B-Instruct-Q2_K.gguf",
        "sizeBytes": 1274756256,
        "sha256": "26c74930402314e93c3152635f719ad9c102540ad78b011be3600eb82894a8ef"
      },
      {
        "quant": "Q3_K_M",
        "name": "Qwen2.5-3B-Instruct-Q3_K_M.gguf",
        "url": "https://huggingface.co/bartowski/Qwen2.5-3B-Instruct-GGUF/resolve/main/Qwen2.5-3B-Instruct-Q3_K_M.gguf",
        "sizeBytes": 1590475936,
        "sha256": "8eff4e0eb51a8148abdaa9849f14f187e5ac6cd7d795610caf996a287277c59d"
      },
      {
        "quant": "Q4_K_M",
        "name": "Qwen2.5-3B-Instruct-Q4_K_M.gguf",
        "url": "https://huggingface.co/bartowski/Qwen2.5-3B-Instruct-GGUF/resolve/main/Qwen2.5-3B-Instruct-Q4_K_M.gguf",
        "sizeBytes": 1929903264,
        "sha256": "9c9f56a391a3abbd5b89d0245bf6106081bcc3173119d4229235dd9d23253f94"
      },
      {
        "quant": "Q5_K_M",
        "name": "Qwen2.5-3B-Instruct-Q5_K_M.gguf",
        "url": "https://huggingface.co/bartowski/Qwen2.5-3B-Instruct-GGUF/resolve/main/Qwen2.5-3B-Instruct-Q5_K_M.gguf",
        "sizeBytes": 2224815264,
        "sha256": "e4180cbad78d8848bd10839e7fd07edd573c4a5b01148c2b3f7ce2763a2a0938"
      }
    ],
    "developer": "Qwen Team (Alibaba)",
    "purposes": [
      "chat",
      "writing",
      "creative",
      "analysis",
      "multilingual",
      "translation",
      "long-context"
    ],
    "verifiedAt": "2026-11-10"
  },
  {
    "id": "phi-4-mini-instruct",
    "ollamaName": "litemind-phi-4-mini-instruct",
    "displayName": "Phi-4-mini Instruct (3.8B)",
    "category": "chat-small",
    "restrictions": "standard",
    "uncensored": false,
    "uncensoredLabel": null,
    "tags": [
      "chat",
      "general",
      "reasoning-lite"
    ],
    "languages": [
      "en",
      "multi"
    ],
    "params": "3.8B",
    "family": "phi4",
    "purpose": "Microsoft Phi-4-mini: логика и математика выше веса; русский ограничен.",
    "quality": "Один из лучших «мозгов» на границе 4B; инструкция MIT.",
    "speed": "medium",
    "license": "mit",
    "licenseNote": null,
    "source": "https://huggingface.co/unsloth/Phi-4-mini-instruct-GGUF",
    "repo": "unsloth/Phi-4-mini-instruct-GGUF",
    "quantAuthor": "unsloth",
    "contextTokens": 32768,
    "tools": true,
    "vision": false,
    "notes": null,
    "files": [
      {
        "quant": "Q3_K_M",
        "name": "Phi-4-mini-instruct-Q3_K_M.gguf",
        "url": "https://huggingface.co/unsloth/Phi-4-mini-instruct-GGUF/resolve/main/Phi-4-mini-instruct-Q3_K_M.gguf",
        "sizeBytes": 2117532640,
        "sha256": "8eb40b196ca664365bb0012eac556e9700345fcf68b41cfc35e8bf4a47687653"
      },
      {
        "quant": "Q4_K_M",
        "name": "Phi-4-mini-instruct-Q4_K_M.gguf",
        "url": "https://huggingface.co/unsloth/Phi-4-mini-instruct-GGUF/resolve/main/Phi-4-mini-instruct-Q4_K_M.gguf",
        "sizeBytes": 2491874272,
        "sha256": "88c00229914083cd112853aab84ed51b87bdf6b9ce42f532d8c85c7c63b1730a"
      },
      {
        "quant": "Q5_K_M",
        "name": "Phi-4-mini-instruct-Q5_K_M.gguf",
        "url": "https://huggingface.co/unsloth/Phi-4-mini-instruct-GGUF/resolve/main/Phi-4-mini-instruct-Q5_K_M.gguf",
        "sizeBytes": 2848127968,
        "sha256": "b5a981febb25f218762d52411f5a4af6aad8b3a203bb1004a576545350ad08e3"
      },
      {
        "quant": "Q6_K",
        "name": "Phi-4-mini-instruct-Q6_K.gguf",
        "url": "https://huggingface.co/unsloth/Phi-4-mini-instruct-GGUF/resolve/main/Phi-4-mini-instruct-Q6_K.gguf",
        "sizeBytes": 3155622880,
        "sha256": "72b8446a3db55617950bef48d296659050867cca41bd7a7be4622010c9589400"
      }
    ],
    "developer": "Microsoft",
    "purposes": [
      "chat",
      "writing",
      "creative",
      "analysis",
      "math",
      "multilingual",
      "translation",
      "long-context"
    ],
    "verifiedAt": "2026-11-10"
  },
  {
    "id": "smollm2-1.7b-instruct",
    "ollamaName": "litemind-smollm2-1.7b-instruct",
    "displayName": "SmolLM2 1.7B Instruct",
    "category": "chat-small",
    "restrictions": "standard",
    "uncensored": false,
    "uncensoredLabel": null,
    "tags": [
      "chat",
      "general"
    ],
    "languages": [
      "en"
    ],
    "params": "1.7B",
    "family": "smollm2",
    "purpose": "Hugging Face SmolLM2 1.7B: лёгкая, шустрая, честно английская.",
    "quality": "Хороший английский и следование инструкциям для 1.7B.",
    "speed": "fast",
    "license": "apache-2.0",
    "licenseNote": null,
    "source": "https://huggingface.co/HuggingFaceTB/SmolLM2-1.7B-Instruct-GGUF",
    "repo": "HuggingFaceTB/SmolLM2-1.7B-Instruct-GGUF",
    "quantAuthor": "HuggingFaceTB (официальный)",
    "contextTokens": 8192,
    "tools": true,
    "vision": false,
    "notes": null,
    "files": [
      {
        "quant": "Q4_K_M",
        "name": "smollm2-1.7b-instruct-q4_k_m.gguf",
        "url": "https://huggingface.co/HuggingFaceTB/SmolLM2-1.7B-Instruct-GGUF/resolve/main/smollm2-1.7b-instruct-q4_k_m.gguf",
        "sizeBytes": 1055609536,
        "sha256": "decd2598bc2c8ed08c19adc3c8fdd461ee19ed5708679d1c54ef54a5a30d4f33"
      }
    ],
    "developer": "HuggingFaceTB",
    "purposes": [
      "chat",
      "writing",
      "creative"
    ],
    "verifiedAt": "2026-11-10"
  },
  {
    "id": "smollm3-3b",
    "ollamaName": "litemind-smollm3-3b",
    "displayName": "SmolLM3 3B",
    "category": "chat-small",
    "restrictions": "standard",
    "uncensored": false,
    "uncensoredLabel": null,
    "tags": [
      "chat",
      "general",
      "reasoning-lite"
    ],
    "languages": [
      "ru",
      "en",
      "multi"
    ],
    "params": "3B",
    "family": "smollm3",
    "purpose": "Третье поколение SmolLM: режим размышления, мультиязычность и 128k контекст под Apache-2.0.",
    "quality": "Свежий и сильный 3B; приятный сюрприз для слабых ПК.",
    "speed": "medium",
    "license": "apache-2.0",
    "licenseNote": null,
    "source": "https://huggingface.co/bartowski/HuggingFaceTB_SmolLM3-3B-GGUF",
    "repo": "bartowski/HuggingFaceTB_SmolLM3-3B-GGUF",
    "quantAuthor": "bartowski",
    "contextTokens": 32768,
    "tools": true,
    "vision": false,
    "notes": null,
    "files": [
      {
        "quant": "Q2_K",
        "name": "HuggingFaceTB_SmolLM3-3B-Q2_K.gguf",
        "url": "https://huggingface.co/bartowski/HuggingFaceTB_SmolLM3-3B-GGUF/resolve/main/HuggingFaceTB_SmolLM3-3B-Q2_K.gguf",
        "sizeBytes": 1253302080,
        "sha256": "794509645d684d6b563b054c312f502af793e040155080d4de358e698f638354"
      },
      {
        "quant": "Q3_K_M",
        "name": "HuggingFaceTB_SmolLM3-3B-Q3_K_M.gguf",
        "url": "https://huggingface.co/bartowski/HuggingFaceTB_SmolLM3-3B-GGUF/resolve/main/HuggingFaceTB_SmolLM3-3B-Q3_K_M.gguf",
        "sizeBytes": 1571069760,
        "sha256": "5e5c70fdc3429023ed88ead8af2a70684047e2628258b650bdb729c8437639d0"
      },
      {
        "quant": "Q4_K_M",
        "name": "HuggingFaceTB_SmolLM3-3B-Q4_K_M.gguf",
        "url": "https://huggingface.co/bartowski/HuggingFaceTB_SmolLM3-3B-GGUF/resolve/main/HuggingFaceTB_SmolLM3-3B-Q4_K_M.gguf",
        "sizeBytes": 1915305792,
        "sha256": "519732558d5fa7420ab058e1b776dcfe73da78013c2fe59c7ca43c325ef89132"
      },
      {
        "quant": "Q5_K_M",
        "name": "HuggingFaceTB_SmolLM3-3B-Q5_K_M.gguf",
        "url": "https://huggingface.co/bartowski/HuggingFaceTB_SmolLM3-3B-GGUF/resolve/main/HuggingFaceTB_SmolLM3-3B-Q5_K_M.gguf",
        "sizeBytes": 2213756736,
        "sha256": "65a6490c29a728d1bde5b6a6858418715e773e061433386dbbc39b3f0a088f3d"
      }
    ],
    "developer": "HuggingFaceTB",
    "purposes": [
      "chat",
      "writing",
      "creative",
      "analysis",
      "math",
      "multilingual",
      "translation",
      "long-context"
    ],
    "verifiedAt": "2026-11-10"
  },
  {
    "id": "tinyllama-1.1b-chat",
    "ollamaName": "litemind-tinyllama-1.1b-chat",
    "displayName": "TinyLlama 1.1B Chat",
    "category": "chat-tiny",
    "restrictions": "standard",
    "uncensored": false,
    "uncensoredLabel": null,
    "tags": [
      "chat",
      "general",
      "tiny"
    ],
    "languages": [
      "en"
    ],
    "params": "1.1B",
    "family": "tinyllama",
    "purpose": "Легендарная крошка на архитектуре Llama: минимальные требования, мгновенный отклик.",
    "quality": "Старая (2024) и простая; хороша для офлайн-экспериментов на самых слабых машинах.",
    "speed": "fast",
    "license": "apache-2.0",
    "licenseNote": null,
    "source": "https://huggingface.co/TheBloke/TinyLlama-1.1B-Chat-v1.0-GGUF",
    "repo": "TheBloke/TinyLlama-1.1B-Chat-v1.0-GGUF",
    "quantAuthor": "TheBloke",
    "contextTokens": 2048,
    "tools": true,
    "vision": false,
    "notes": null,
    "files": [
      {
        "quant": "Q4_K_M",
        "name": "tinyllama-1.1b-chat-v1.0.Q4_K_M.gguf",
        "url": "https://huggingface.co/TheBloke/TinyLlama-1.1B-Chat-v1.0-GGUF/resolve/main/tinyllama-1.1b-chat-v1.0.Q4_K_M.gguf",
        "sizeBytes": 668788096,
        "sha256": "9fecc3b3cd76bba89d504f29b616eedf7da85b96540e490ca5824d3f7d2776a0"
      },
      {
        "quant": "Q5_K_M",
        "name": "tinyllama-1.1b-chat-v1.0.Q5_K_M.gguf",
        "url": "https://huggingface.co/TheBloke/TinyLlama-1.1B-Chat-v1.0-GGUF/resolve/main/tinyllama-1.1b-chat-v1.0.Q5_K_M.gguf",
        "sizeBytes": 783017344,
        "sha256": "aa54a5fb99ace5b964859cf072346631b2da6109715a805d07161d157c66ce7f"
      },
      {
        "quant": "Q8_0",
        "name": "tinyllama-1.1b-chat-v1.0.Q8_0.gguf",
        "url": "https://huggingface.co/TheBloke/TinyLlama-1.1B-Chat-v1.0-GGUF/resolve/main/tinyllama-1.1b-chat-v1.0.Q8_0.gguf",
        "sizeBytes": 1170781568,
        "sha256": "a4c9bb1dbaa372f6381a035fa5c02ef087aaa1ff1f843a56a22328114f03fc59"
      }
    ],
    "developer": "TinyLlama project",
    "purposes": [
      "chat",
      "writing",
      "creative"
    ],
    "verifiedAt": "2026-11-10"
  },
  {
    "id": "qwen2.5-7b-instruct",
    "ollamaName": "litemind-qwen2.5-7b-instruct",
    "displayName": "Qwen2.5 7B Instruct",
    "category": "chat-mid",
    "restrictions": "standard",
    "uncensored": false,
    "uncensoredLabel": null,
    "tags": [
      "chat",
      "general"
    ],
    "languages": [
      "ru",
      "en",
      "multi"
    ],
    "params": "7B",
    "family": "qwen2.5",
    "purpose": "Максимум общего качества для 16 ГБ: глубокие ответы, русский, инструменты.",
    "quality": "Заметно умнее всех моделей до 4B; на CPU без AVX — терпение (1–3 ток/с).",
    "speed": "slow",
    "license": "apache-2.0",
    "licenseNote": null,
    "source": "https://huggingface.co/bartowski/Qwen2.5-7B-Instruct-GGUF",
    "repo": "bartowski/Qwen2.5-7B-Instruct-GGUF",
    "quantAuthor": "bartowski",
    "contextTokens": 32768,
    "tools": true,
    "vision": false,
    "notes": null,
    "files": [
      {
        "quant": "Q2_K",
        "name": "Qwen2.5-7B-Instruct-Q2_K.gguf",
        "url": "https://huggingface.co/bartowski/Qwen2.5-7B-Instruct-GGUF/resolve/main/Qwen2.5-7B-Instruct-Q2_K.gguf",
        "sizeBytes": 3015940800,
        "sha256": "f04eb1416242987e53ceb567620a4bf7258f094705fc6c4086b24afaf85ed26c"
      },
      {
        "quant": "Q3_K_M",
        "name": "Qwen2.5-7B-Instruct-Q3_K_M.gguf",
        "url": "https://huggingface.co/bartowski/Qwen2.5-7B-Instruct-GGUF/resolve/main/Qwen2.5-7B-Instruct-Q3_K_M.gguf",
        "sizeBytes": 3808391872,
        "sha256": "6738a2d4f9b280c55b2a19a7ab27334a75d2cafc6ef82a11a075f4b5613eb736"
      },
      {
        "quant": "Q4_K_M",
        "name": "Qwen2.5-7B-Instruct-Q4_K_M.gguf",
        "url": "https://huggingface.co/bartowski/Qwen2.5-7B-Instruct-GGUF/resolve/main/Qwen2.5-7B-Instruct-Q4_K_M.gguf",
        "sizeBytes": 4683074240,
        "sha256": "65b8fcd92af6b4fefa935c625d1ac27ea29dcb6ee14589c55a8f115ceaaa1423"
      }
    ],
    "developer": "Qwen Team (Alibaba)",
    "purposes": [
      "chat",
      "writing",
      "creative",
      "analysis",
      "multilingual",
      "translation",
      "long-context"
    ],
    "verifiedAt": "2026-11-10"
  },
  {
    "id": "mistral-7b-instruct-v0.3",
    "ollamaName": "litemind-mistral-7b-instruct-v0.3",
    "displayName": "Mistral 7B Instruct v0.3",
    "category": "chat-mid",
    "restrictions": "standard",
    "uncensored": false,
    "uncensoredLabel": null,
    "tags": [
      "chat",
      "general"
    ],
    "languages": [
      "en",
      "multi"
    ],
    "params": "7.2B",
    "family": "mistral",
    "purpose": "Классический Mistral 7B под Apache-2.0; европейская школа, лаконичные ответы.",
    "quality": "Проверенное время качество; русский средний.",
    "speed": "slow",
    "license": "apache-2.0",
    "licenseNote": null,
    "source": "https://huggingface.co/bartowski/Mistral-7B-Instruct-v0.3-GGUF",
    "repo": "bartowski/Mistral-7B-Instruct-v0.3-GGUF",
    "quantAuthor": "bartowski",
    "contextTokens": 32768,
    "tools": true,
    "vision": false,
    "notes": null,
    "files": [
      {
        "quant": "Q2_K",
        "name": "Mistral-7B-Instruct-v0.3-Q2_K.gguf",
        "url": "https://huggingface.co/bartowski/Mistral-7B-Instruct-v0.3-GGUF/resolve/main/Mistral-7B-Instruct-v0.3-Q2_K.gguf",
        "sizeBytes": 2722877664,
        "sha256": "6696020e424ccf3bc4ab6ac2bc639220f3d09ad6a225d5c3e16033a1ff9a4885"
      },
      {
        "quant": "Q3_K_M",
        "name": "Mistral-7B-Instruct-v0.3-Q3_K_M.gguf",
        "url": "https://huggingface.co/bartowski/Mistral-7B-Instruct-v0.3-GGUF/resolve/main/Mistral-7B-Instruct-v0.3-Q3_K_M.gguf",
        "sizeBytes": 3522941152,
        "sha256": "145b11df092f04bbecb9fd99e83d1f3d8a6d1e53805682bfba1fe314f306e1d5"
      },
      {
        "quant": "Q4_K_M",
        "name": "Mistral-7B-Instruct-v0.3-Q4_K_M.gguf",
        "url": "https://huggingface.co/bartowski/Mistral-7B-Instruct-v0.3-GGUF/resolve/main/Mistral-7B-Instruct-v0.3-Q4_K_M.gguf",
        "sizeBytes": 4372812000,
        "sha256": "1270d22c0fbb3d092fb725d4d96c457b7b687a5f5a715abe1e818da303e562b6"
      }
    ],
    "developer": "Mistral AI",
    "purposes": [
      "chat",
      "writing",
      "creative",
      "analysis",
      "multilingual",
      "translation",
      "long-context"
    ],
    "verifiedAt": "2026-11-10"
  },
  {
    "id": "ministral-8b-instruct-2410",
    "ollamaName": "litemind-ministral-8b-instruct-2410",
    "displayName": "Ministral 8B Instruct 2410",
    "category": "chat-mid",
    "restrictions": "standard",
    "uncensored": false,
    "uncensoredLabel": null,
    "tags": [
      "chat",
      "general"
    ],
    "languages": [
      "en",
      "multi"
    ],
    "params": "8B",
    "family": "ministral",
    "purpose": "Ministral 8B от Mistral AI: аккуратные ответы на 8B; лицензия исследовательская.",
    "quality": "Крепкая 8B-модель; русский ограниченный.",
    "speed": "slow",
    "license": "mistral-research (other)",
    "licenseNote": "Mistral Research License — только некоммерческое использование.",
    "source": "https://huggingface.co/bartowski/Ministral-8B-Instruct-2410-GGUF",
    "repo": "bartowski/Ministral-8B-Instruct-2410-GGUF",
    "quantAuthor": "bartowski",
    "contextTokens": 32768,
    "tools": true,
    "vision": false,
    "notes": "Mistral Research License — только некоммерческое использование.",
    "files": [
      {
        "quant": "Q2_K",
        "name": "Ministral-8B-Instruct-2410-Q2_K.gguf",
        "url": "https://huggingface.co/bartowski/Ministral-8B-Instruct-2410-GGUF/resolve/main/Ministral-8B-Instruct-2410-Q2_K.gguf",
        "sizeBytes": 3185478464,
        "sha256": "a9bdba6ab1578e7b99dc9bcd22ef7e5202c77606192dc6d35f8127e2f18965ba"
      },
      {
        "quant": "Q3_K_M",
        "name": "Ministral-8B-Instruct-2410-Q3_K_M.gguf",
        "url": "https://huggingface.co/bartowski/Ministral-8B-Instruct-2410-GGUF/resolve/main/Ministral-8B-Instruct-2410-Q3_K_M.gguf",
        "sizeBytes": 4019227456,
        "sha256": "7ed406e06ef9022c3293dfd77c9c7dfb3c2911648eeecf22bf9f762b0d6caa00"
      },
      {
        "quant": "Q4_K_M",
        "name": "Ministral-8B-Instruct-2410-Q4_K_M.gguf",
        "url": "https://huggingface.co/bartowski/Ministral-8B-Instruct-2410-GGUF/resolve/main/Ministral-8B-Instruct-2410-Q4_K_M.gguf",
        "sizeBytes": 4911500096,
        "sha256": "bbe8d91c196491b1802b20aba121d2ef38945a8e6c6c6a8710bfd2ef393fe73f"
      }
    ],
    "developer": "Mistral AI",
    "purposes": [
      "chat",
      "writing",
      "creative",
      "analysis",
      "multilingual",
      "translation",
      "long-context"
    ],
    "verifiedAt": "2026-11-10"
  },
  {
    "id": "phi-3.5-mini-instruct",
    "ollamaName": "litemind-phi-3.5-mini-instruct",
    "displayName": "Phi-3.5-mini Instruct (3.8B)",
    "category": "chat-small",
    "restrictions": "standard",
    "uncensored": false,
    "uncensoredLabel": null,
    "tags": [
      "chat",
      "general",
      "reasoning-lite"
    ],
    "languages": [
      "en",
      "multi"
    ],
    "params": "3.8B",
    "family": "phi3.5",
    "purpose": "Microsoft Phi-3.5-mini: логика и код выше веса при MIT-лицензии.",
    "quality": "Крепкий середняк 4B-класса; русский слабоват.",
    "speed": "medium",
    "license": "mit",
    "licenseNote": null,
    "source": "https://huggingface.co/bartowski/Phi-3.5-mini-instruct-GGUF",
    "repo": "bartowski/Phi-3.5-mini-instruct-GGUF",
    "quantAuthor": "bartowski",
    "contextTokens": 16384,
    "tools": true,
    "vision": false,
    "notes": null,
    "files": [
      {
        "quant": "Q3_K_M",
        "name": "Phi-3.5-mini-instruct-Q3_K_M.gguf",
        "url": "https://huggingface.co/bartowski/Phi-3.5-mini-instruct-GGUF/resolve/main/Phi-3.5-mini-instruct-Q3_K_M.gguf",
        "sizeBytes": 1955477280,
        "sha256": "5e005a663fc15ee51c9aea089fbd63a557458b020ee799e369d17da273a8b855"
      },
      {
        "quant": "Q4_K_M",
        "name": "Phi-3.5-mini-instruct-Q4_K_M.gguf",
        "url": "https://huggingface.co/bartowski/Phi-3.5-mini-instruct-GGUF/resolve/main/Phi-3.5-mini-instruct-Q4_K_M.gguf",
        "sizeBytes": 2393232672,
        "sha256": "e4165e3a71af97f1b4820da61079826d8752a2088e313af0c7d346796c38eff5"
      },
      {
        "quant": "Q5_K_M",
        "name": "Phi-3.5-mini-instruct-Q5_K_M.gguf",
        "url": "https://huggingface.co/bartowski/Phi-3.5-mini-instruct-GGUF/resolve/main/Phi-3.5-mini-instruct-Q5_K_M.gguf",
        "sizeBytes": 2815276320,
        "sha256": "3fb19cc624c455ed4b513ce5d698585e4ccdbaeb151138bdac25eec82b2c20dc"
      },
      {
        "quant": "Q6_K",
        "name": "Phi-3.5-mini-instruct-Q6_K.gguf",
        "url": "https://huggingface.co/bartowski/Phi-3.5-mini-instruct-GGUF/resolve/main/Phi-3.5-mini-instruct-Q6_K.gguf",
        "sizeBytes": 3135853344,
        "sha256": "cc4f0d756eb82447035314dbd247809a564189c20583e1d6fb926f9b6e1eb890"
      }
    ],
    "developer": "Microsoft",
    "purposes": [
      "chat",
      "writing",
      "creative",
      "analysis",
      "math",
      "multilingual",
      "translation"
    ],
    "verifiedAt": "2026-11-10"
  },
  {
    "id": "gemma-2-9b-it",
    "ollamaName": "litemind-gemma-2-9b-it",
    "displayName": "Gemma 2 9B Instruct",
    "category": "chat-mid",
    "restrictions": "standard",
    "uncensored": false,
    "uncensoredLabel": null,
    "tags": [
      "chat",
      "general"
    ],
    "languages": [
      "ru",
      "en",
      "multi"
    ],
    "params": "9B",
    "family": "gemma2",
    "purpose": "Крупная Google-модель с очень связным текстом; для 16 ГБ — только Q2/Q3 и без фоновых программ.",
    "quality": "Качество текста заметно выше 7B-класса.",
    "speed": "slow",
    "license": "gemma",
    "licenseNote": "Лицензия Gemma: разрешено коммерческое использование с ограничениями Google.",
    "source": "https://huggingface.co/bartowski/gemma-2-9b-it-GGUF",
    "repo": "bartowski/gemma-2-9b-it-GGUF",
    "quantAuthor": "bartowski",
    "contextTokens": 8192,
    "tools": true,
    "vision": false,
    "notes": "Лицензия Gemma: разрешено коммерческое использование с ограничениями Google.",
    "files": [
      {
        "quant": "Q2_K",
        "name": "gemma-2-9b-it-Q2_K.gguf",
        "url": "https://huggingface.co/bartowski/gemma-2-9b-it-GGUF/resolve/main/gemma-2-9b-it-Q2_K.gguf",
        "sizeBytes": 3805397952,
        "sha256": "2efce51c0d774a47c247c07ec6f109f670e3da4f4eec0f9322d72e3635622403"
      },
      {
        "quant": "Q3_K_M",
        "name": "gemma-2-9b-it-Q3_K_M.gguf",
        "url": "https://huggingface.co/bartowski/gemma-2-9b-it-GGUF/resolve/main/gemma-2-9b-it-Q3_K_M.gguf",
        "sizeBytes": 4761781184,
        "sha256": "3b5cb881500b1f72d456784a70214c8e49b7b3f49dae4fe524ca2c19e650b18b"
      },
      {
        "quant": "Q4_K_M",
        "name": "gemma-2-9b-it-Q4_K_M-fp16.gguf",
        "url": "https://huggingface.co/bartowski/gemma-2-9b-it-GGUF/resolve/main/gemma-2-9b-it-Q4_K_M-fp16.gguf",
        "sizeBytes": 6843425696,
        "sha256": "0452e54ba9b6c5b2e466fbd7f28c089fefb7c3dceddcc2b75becab6b16cae523"
      }
    ],
    "developer": "Google DeepMind",
    "purposes": [
      "chat",
      "writing",
      "creative",
      "analysis",
      "multilingual",
      "translation"
    ],
    "verifiedAt": "2026-11-10"
  },
  {
    "id": "deepseek-r1-distill-qwen-1.5b",
    "ollamaName": "litemind-deepseek-r1-distill-qwen-1.5b",
    "displayName": "DeepSeek R1 Distill Qwen 1.5B",
    "category": "reasoning",
    "restrictions": "standard",
    "uncensored": false,
    "uncensoredLabel": null,
    "tags": [
      "reasoning",
      "chat"
    ],
    "languages": [
      "en",
      "zh"
    ],
    "params": "1.5B",
    "family": "deepseek-r1",
    "purpose": "Дистиллят DeepSeek-R1: пошаговые рассуждения, математика, логические задачи.",
    "quality": "Для 1.5B рассуждает на удивление здраво; пишет цепочку мысли перед ответом.",
    "speed": "fast",
    "license": "mit",
    "licenseNote": null,
    "source": "https://huggingface.co/bartowski/DeepSeek-R1-Distill-Qwen-1.5B-GGUF",
    "repo": "bartowski/DeepSeek-R1-Distill-Qwen-1.5B-GGUF",
    "quantAuthor": "bartowski",
    "contextTokens": 32768,
    "tools": true,
    "vision": false,
    "notes": null,
    "files": [
      {
        "quant": "Q3_K_M",
        "name": "DeepSeek-R1-Distill-Qwen-1.5B-Q3_K_M.gguf",
        "url": "https://huggingface.co/bartowski/DeepSeek-R1-Distill-Qwen-1.5B-GGUF/resolve/main/DeepSeek-R1-Distill-Qwen-1.5B-Q3_K_M.gguf",
        "sizeBytes": 924456032,
        "sha256": "b1094879ee7e222cba5be013e6de2d0658c64f91aef5d3c9bff0db5cefbfa020"
      },
      {
        "quant": "Q4_K_M",
        "name": "DeepSeek-R1-Distill-Qwen-1.5B-Q4_K_M.gguf",
        "url": "https://huggingface.co/bartowski/DeepSeek-R1-Distill-Qwen-1.5B-GGUF/resolve/main/DeepSeek-R1-Distill-Qwen-1.5B-Q4_K_M.gguf",
        "sizeBytes": 1117320800,
        "sha256": "1741e5b2d062b07acf048bf0d2c514dadf2a48f94e2b4aa0cfe069af3838ee2f"
      },
      {
        "quant": "Q5_K_M",
        "name": "DeepSeek-R1-Distill-Qwen-1.5B-Q5_K_M.gguf",
        "url": "https://huggingface.co/bartowski/DeepSeek-R1-Distill-Qwen-1.5B-GGUF/resolve/main/DeepSeek-R1-Distill-Qwen-1.5B-Q5_K_M.gguf",
        "sizeBytes": 1285494368,
        "sha256": "4d8f6465e96258cf44303eb02812c391d15f6c77f0d72e47757c98fd14994608"
      },
      {
        "quant": "Q6_K",
        "name": "DeepSeek-R1-Distill-Qwen-1.5B-Q6_K.gguf",
        "url": "https://huggingface.co/bartowski/DeepSeek-R1-Distill-Qwen-1.5B-GGUF/resolve/main/DeepSeek-R1-Distill-Qwen-1.5B-Q6_K.gguf",
        "sizeBytes": 1464178784,
        "sha256": "c9c8aff5a84e2e9c1fd6ea57af5ab52cf5d7272d34460403d82880075e611039"
      }
    ],
    "developer": "DeepSeek",
    "purposes": [
      "math",
      "analysis",
      "chat",
      "long-context"
    ],
    "verifiedAt": "2026-11-10"
  },
  {
    "id": "deepseek-r1-distill-qwen-7b",
    "ollamaName": "litemind-deepseek-r1-distill-qwen-7b",
    "displayName": "DeepSeek R1 Distill Qwen 7B",
    "category": "reasoning",
    "restrictions": "standard",
    "uncensored": false,
    "uncensoredLabel": null,
    "tags": [
      "reasoning",
      "chat"
    ],
    "languages": [
      "en",
      "zh"
    ],
    "params": "7B",
    "family": "deepseek-r1",
    "purpose": "Сильный reasoning 7B: олимпиадная математика, логика, анализ; русский почти отсутствует.",
    "quality": "Лучший «аналитик» каталога для 16 ГБ; медленно на CPU без AVX.",
    "speed": "slow",
    "license": "mit",
    "licenseNote": null,
    "source": "https://huggingface.co/bartowski/DeepSeek-R1-Distill-Qwen-7B-GGUF",
    "repo": "bartowski/DeepSeek-R1-Distill-Qwen-7B-GGUF",
    "quantAuthor": "bartowski",
    "contextTokens": 32768,
    "tools": true,
    "vision": false,
    "notes": null,
    "files": [
      {
        "quant": "Q2_K",
        "name": "DeepSeek-R1-Distill-Qwen-7B-Q2_K.gguf",
        "url": "https://huggingface.co/bartowski/DeepSeek-R1-Distill-Qwen-7B-GGUF/resolve/main/DeepSeek-R1-Distill-Qwen-7B-Q2_K.gguf",
        "sizeBytes": 3015940064,
        "sha256": "fb0667a00ac788f4450c42457cc3f03be548d567454775b848dc85d8bc8a7837"
      },
      {
        "quant": "Q3_K_M",
        "name": "DeepSeek-R1-Distill-Qwen-7B-Q3_K_M.gguf",
        "url": "https://huggingface.co/bartowski/DeepSeek-R1-Distill-Qwen-7B-GGUF/resolve/main/DeepSeek-R1-Distill-Qwen-7B-Q3_K_M.gguf",
        "sizeBytes": 3808391136,
        "sha256": "5c4f966a3b2907e08734dff2bea87acb01ec868a07ca1d8f7e30a3c6c62a98f3"
      },
      {
        "quant": "Q4_K_M",
        "name": "DeepSeek-R1-Distill-Qwen-7B-Q4_K_M.gguf",
        "url": "https://huggingface.co/bartowski/DeepSeek-R1-Distill-Qwen-7B-GGUF/resolve/main/DeepSeek-R1-Distill-Qwen-7B-Q4_K_M.gguf",
        "sizeBytes": 4683073504,
        "sha256": "731ece8d06dc7eda6f6572997feb9ee1258db0784827e642909d9b565641937b"
      }
    ],
    "developer": "DeepSeek",
    "purposes": [
      "math",
      "analysis",
      "chat",
      "long-context"
    ],
    "verifiedAt": "2026-11-10"
  },
  {
    "id": "vikhr-gemma-2b",
    "ollamaName": "litemind-vikhr-gemma-2b",
    "displayName": "Vikhr Gemma 2B (RU)",
    "category": "russian",
    "restrictions": "standard",
    "uncensored": false,
    "uncensoredLabel": null,
    "tags": [
      "chat",
      "russian"
    ],
    "languages": [
      "ru",
      "en"
    ],
    "params": "2B",
    "family": "vikhr",
    "purpose": "Русскоязычная адаптация Gemma 2B от Vikhrmodels: живой русский язык в компактном весе.",
    "quality": "Один из лучших русскоязычных вариантов до 3B.",
    "speed": "fast",
    "license": "apache-2.0",
    "licenseNote": null,
    "source": "https://huggingface.co/Vikhrmodels/Vikhr-Gemma-2B-instruct-GGUF",
    "repo": "Vikhrmodels/Vikhr-Gemma-2B-instruct-GGUF",
    "quantAuthor": "Vikhrmodels (официальный)",
    "contextTokens": 8192,
    "tools": true,
    "vision": false,
    "notes": null,
    "files": [
      {
        "quant": "Q3_K_M",
        "name": "Vikhr-Gemma-2B-instruct-Q3_K_M.gguf",
        "url": "https://huggingface.co/Vikhrmodels/Vikhr-Gemma-2B-instruct-GGUF/resolve/main/Vikhr-Gemma-2B-instruct-Q3_K_M.gguf",
        "sizeBytes": 1461668192,
        "sha256": "afd714bdc7d5205497234fcc1d7200cd5ee2230095b773d2eb6c245be5c75138"
      },
      {
        "quant": "Q4_K_M",
        "name": "Vikhr-Gemma-2B-instruct-Q4_K_M.gguf",
        "url": "https://huggingface.co/Vikhrmodels/Vikhr-Gemma-2B-instruct-GGUF/resolve/main/Vikhr-Gemma-2B-instruct-Q4_K_M.gguf",
        "sizeBytes": 1708582848,
        "sha256": "e8ae6ac82f6c7b120cd2b5a1fd3b185bb20fc37cc517eb42b14fad75a6b963cd"
      },
      {
        "quant": "Q5_K_M",
        "name": "Vikhr-Gemma-2B-instruct-Q5_K_M.gguf",
        "url": "https://huggingface.co/Vikhrmodels/Vikhr-Gemma-2B-instruct-GGUF/resolve/main/Vikhr-Gemma-2B-instruct-Q5_K_M.gguf",
        "sizeBytes": 1923278784,
        "sha256": "ed58ee9d9f36dd8f6040bae0829a07b30dbbc4d518272f0dffaedd8c69411c26"
      },
      {
        "quant": "Q6_K",
        "name": "Vikhr-Gemma-2B-instruct-Q6_K.gguf",
        "url": "https://huggingface.co/Vikhrmodels/Vikhr-Gemma-2B-instruct-GGUF/resolve/main/Vikhr-Gemma-2B-instruct-Q6_K.gguf",
        "sizeBytes": 2151393216,
        "sha256": "4d3d34c055cd3c4bfa84294aeac94d53ea2353098af34b61f6095beb5e5843b3"
      }
    ],
    "developer": "Vikhrmodels",
    "purposes": [
      "chat",
      "writing"
    ],
    "verifiedAt": "2026-11-10"
  },
  {
    "id": "vikhr-qwen-1.5b",
    "ollamaName": "litemind-vikhr-qwen-1.5b",
    "displayName": "Vikhr Qwen 2.5 1.5B (RU)",
    "category": "russian",
    "restrictions": "standard",
    "uncensored": false,
    "uncensoredLabel": null,
    "tags": [
      "chat",
      "russian"
    ],
    "languages": [
      "ru",
      "en"
    ],
    "params": "1.5B",
    "family": "vikhr",
    "purpose": "Викhr поверх Qwen 2.5 1.5B: русский, инструкции, 32k контекст, Apache-2.0.",
    "quality": "Хороший русский для 1.5B; рекомендован для слабых ПК.",
    "speed": "fast",
    "license": "apache-2.0",
    "licenseNote": null,
    "source": "https://huggingface.co/Vikhrmodels/Vikhr-Qwen-2.5-1.5B-Instruct-GGUF",
    "repo": "Vikhrmodels/Vikhr-Qwen-2.5-1.5B-Instruct-GGUF",
    "quantAuthor": "Vikhrmodels (официальный)",
    "contextTokens": 32768,
    "tools": true,
    "vision": false,
    "notes": null,
    "files": [
      {
        "quant": "Q3_K_M",
        "name": "Vikhr-Qwen-2.5-1.5b-Instruct-Q3_K_M.gguf",
        "url": "https://huggingface.co/Vikhrmodels/Vikhr-Qwen-2.5-1.5B-Instruct-GGUF/resolve/main/Vikhr-Qwen-2.5-1.5b-Instruct-Q3_K_M.gguf",
        "sizeBytes": 823831168,
        "sha256": "9e75e92e12a48ba2c7d06b3768a13b12b3e4f12fb7419978101c3ee4a2426bc1"
      },
      {
        "quant": "Q4_K_M",
        "name": "Vikhr-Qwen-2.5-1.5b-Instruct-Q4_K_M.gguf",
        "url": "https://huggingface.co/Vikhrmodels/Vikhr-Qwen-2.5-1.5B-Instruct-GGUF/resolve/main/Vikhr-Qwen-2.5-1.5b-Instruct-Q4_K_M.gguf",
        "sizeBytes": 985700992,
        "sha256": "d82b16244a33dbbde4742e38e42b2b3d74dd883f4b8ff4ae53eca29aabf60662"
      },
      {
        "quant": "Q5_K_M",
        "name": "Vikhr-Qwen-2.5-1.5b-Instruct-Q5_K_M.gguf",
        "url": "https://huggingface.co/Vikhrmodels/Vikhr-Qwen-2.5-1.5B-Instruct-GGUF/resolve/main/Vikhr-Qwen-2.5-1.5b-Instruct-Q5_K_M.gguf",
        "sizeBytes": 1124702848,
        "sha256": "52d7e58307cb9192fb084773f303cf03db5335cba187535144735746c96b237f"
      },
      {
        "quant": "Q6_K",
        "name": "Vikhr-Qwen-2.5-1.5b-Instruct-Q6_K.gguf",
        "url": "https://huggingface.co/Vikhrmodels/Vikhr-Qwen-2.5-1.5B-Instruct-GGUF/resolve/main/Vikhr-Qwen-2.5-1.5b-Instruct-Q6_K.gguf",
        "sizeBytes": 1272392320,
        "sha256": "48733fdb79be6aa0e5032818d802643d0cb5898d0056f4d228eae262d71bcf5f"
      }
    ],
    "developer": "Vikhrmodels",
    "purposes": [
      "chat",
      "writing",
      "long-context"
    ],
    "verifiedAt": "2026-11-10"
  },
  {
    "id": "saiga2-7b",
    "ollamaName": "litemind-saiga2-7b",
    "displayName": "Saiga2 7B (RU)",
    "category": "russian",
    "restrictions": "standard",
    "uncensored": false,
    "uncensoredLabel": null,
    "tags": [
      "chat",
      "russian"
    ],
    "languages": [
      "ru",
      "en"
    ],
    "params": "7B",
    "family": "saiga",
    "purpose": "Известный русскоязычный файнтюн Llama 2 от Ильи Гусева: свободный разговорный русский.",
    "quality": "Классика русских локальных моделей; ограничение лицензии llama2 + nc-оговорки.",
    "speed": "slow",
    "license": "llama2",
    "licenseNote": "Лицензия Llama 2; использование — по условиям Meta. Некоммерческое происхождение датасета.",
    "source": "https://huggingface.co/IlyaGusev/saiga2_7b_gguf",
    "repo": "IlyaGusev/saiga2_7b_gguf",
    "quantAuthor": "IlyaGusev (официальный)",
    "contextTokens": 4096,
    "tools": true,
    "vision": false,
    "notes": "Лицензия Llama 2; использование — по условиям Meta. Некоммерческое происхождение датасета.",
    "files": [
      {
        "quant": "Q2_K",
        "name": "model-q2_K.gguf",
        "url": "https://huggingface.co/IlyaGusev/saiga2_7b_gguf/resolve/main/model-q2_K.gguf",
        "sizeBytes": 2825940544,
        "sha256": "ecdb8ac229f6cdc3f21d5a3e95dcd26f31c355b727299e96b44ab7a7dbc34fb4"
      },
      {
        "quant": "Q3_K",
        "name": "model-q3_K.gguf",
        "url": "https://huggingface.co/IlyaGusev/saiga2_7b_gguf/resolve/main/model-q3_K.gguf",
        "sizeBytes": 3298004544,
        "sha256": "04ec17b11219d55186d69deae515ec909ea54ecd5918b803f8deabd7a575396c"
      },
      {
        "quant": "Q4_K",
        "name": "model-q4_K.gguf",
        "url": "https://huggingface.co/IlyaGusev/saiga2_7b_gguf/resolve/main/model-q4_K.gguf",
        "sizeBytes": 4081004096,
        "sha256": "b6d9ab608346c90e70eae6ab086524550c7ff5d5a34e6eb98b5b0531ef62b991"
      },
      {
        "quant": "Q5_K",
        "name": "model-q5_K.gguf",
        "url": "https://huggingface.co/IlyaGusev/saiga2_7b_gguf/resolve/main/model-q5_K.gguf",
        "sizeBytes": 4783156800,
        "sha256": "149862753771f3a096e05b3732c520d37d8a2b099b795a4434b813fe989d1f58"
      }
    ],
    "developer": "Илья Гусев (Saiga)",
    "purposes": [
      "chat",
      "writing",
      "analysis"
    ],
    "verifiedAt": "2026-11-10"
  },
  {
    "id": "qwen2.5-coder-0.5b",
    "ollamaName": "litemind-qwen2.5-coder-0.5b",
    "displayName": "Qwen2.5 Coder 0.5B",
    "category": "small-coding",
    "restrictions": "standard",
    "uncensored": false,
    "uncensoredLabel": null,
    "tags": [
      "coding"
    ],
    "languages": [
      "ru",
      "en",
      "multi"
    ],
    "params": "0.5B",
    "family": "qwen2.5-coder",
    "purpose": "Самая лёгкая coding-модель: автодополнение, мелкие правки. Работает даже на 8 ГБ.",
    "quality": "Скромная, но молниеносная; идеал для старта.",
    "speed": "fast",
    "license": "apache-2.0",
    "licenseNote": null,
    "source": "https://huggingface.co/bartowski/Qwen2.5-Coder-0.5B-Instruct-GGUF",
    "repo": "bartowski/Qwen2.5-Coder-0.5B-Instruct-GGUF",
    "quantAuthor": "bartowski",
    "contextTokens": 32768,
    "tools": true,
    "vision": false,
    "notes": null,
    "files": [
      {
        "quant": "Q4_K_M",
        "name": "Qwen2.5-Coder-0.5B-Instruct-Q4_K_M.gguf",
        "url": "https://huggingface.co/bartowski/Qwen2.5-Coder-0.5B-Instruct-GGUF/resolve/main/Qwen2.5-Coder-0.5B-Instruct-Q4_K_M.gguf",
        "sizeBytes": 397808288,
        "sha256": "0128e77564e43d40682f82d7ebe8a9abdf0c24c8f55fa85629f8cc156b1b6560"
      },
      {
        "quant": "Q5_K_M",
        "name": "Qwen2.5-Coder-0.5B-Instruct-Q5_K_M.gguf",
        "url": "https://huggingface.co/bartowski/Qwen2.5-Coder-0.5B-Instruct-GGUF/resolve/main/Qwen2.5-Coder-0.5B-Instruct-Q5_K_M.gguf",
        "sizeBytes": 420086432,
        "sha256": "88ff6e9e6ef96f06dc134e4adcdfbd7e2412bcb1acb1dcebaabf141ea20a0bc6"
      }
    ],
    "developer": "Qwen Team (Alibaba)",
    "purposes": [
      "coding",
      "multilingual",
      "translation",
      "long-context"
    ],
    "verifiedAt": "2026-11-10"
  },
  {
    "id": "qwen2.5-coder-1.5b",
    "ollamaName": "litemind-qwen2.5-coder-1.5b",
    "displayName": "Qwen2.5 Coder 1.5B",
    "category": "small-coding",
    "restrictions": "standard",
    "uncensored": false,
    "uncensoredLabel": null,
    "tags": [
      "coding"
    ],
    "languages": [
      "ru",
      "en",
      "multi"
    ],
    "params": "1.5B",
    "family": "qwen2.5-coder",
    "purpose": "Оптимальная coding-модель для N5095A / 16 ГБ: функции, рефакторинг, объяснение кода.",
    "quality": "Лучшее соотношение пользы и скорости в coding-классе.",
    "speed": "fast",
    "license": "apache-2.0",
    "licenseNote": null,
    "source": "https://huggingface.co/bartowski/Qwen2.5-Coder-1.5B-Instruct-GGUF",
    "repo": "bartowski/Qwen2.5-Coder-1.5B-Instruct-GGUF",
    "quantAuthor": "bartowski",
    "contextTokens": 32768,
    "tools": true,
    "vision": false,
    "notes": null,
    "files": [
      {
        "quant": "Q2_K",
        "name": "Qwen2.5-Coder-1.5B-Instruct-Q2_K.gguf",
        "url": "https://huggingface.co/bartowski/Qwen2.5-Coder-1.5B-Instruct-GGUF/resolve/main/Qwen2.5-Coder-1.5B-Instruct-Q2_K.gguf",
        "sizeBytes": 676305184,
        "sha256": "f2fb79a783a0ee3fc7175b750c94649cc942bf98e8fd35587812be8b191b5c23"
      },
      {
        "quant": "Q3_K_M",
        "name": "Qwen2.5-Coder-1.5B-Instruct-Q3_K_M.gguf",
        "url": "https://huggingface.co/bartowski/Qwen2.5-Coder-1.5B-Instruct-GGUF/resolve/main/Qwen2.5-Coder-1.5B-Instruct-Q3_K_M.gguf",
        "sizeBytes": 824178976,
        "sha256": "0136801c84c9bb39f2e028a069f6b02a0a284073363550cea1a2ae5f2900c4d3"
      },
      {
        "quant": "Q4_K_M",
        "name": "Qwen2.5-Coder-1.5B-Instruct-Q4_K_M.gguf",
        "url": "https://huggingface.co/bartowski/Qwen2.5-Coder-1.5B-Instruct-GGUF/resolve/main/Qwen2.5-Coder-1.5B-Instruct-Q4_K_M.gguf",
        "sizeBytes": 986048800,
        "sha256": "f530705d447660a4336c329981af164b471b60b974b1d808d57e8ec9fe23b239"
      }
    ],
    "developer": "Qwen Team (Alibaba)",
    "purposes": [
      "coding",
      "multilingual",
      "translation",
      "long-context"
    ],
    "verifiedAt": "2026-11-10"
  },
  {
    "id": "qwen2.5-coder-3b",
    "ollamaName": "litemind-qwen2.5-coder-3b",
    "displayName": "Qwen2.5 Coder 3B",
    "category": "small-coding",
    "restrictions": "standard",
    "uncensored": false,
    "uncensoredLabel": null,
    "tags": [
      "coding"
    ],
    "languages": [
      "ru",
      "en",
      "multi"
    ],
    "params": "3B",
    "family": "qwen2.5-coder",
    "purpose": "Заметно умнее 1.5B: многокомпонентные правки, работа с проектом.",
    "quality": "Основной рабочий вариант coding для 16 ГБ.",
    "speed": "medium",
    "license": "qwen-research (other)",
    "licenseNote": "Лицензия Qwen Research — проверьте условия для коммерческого использования.",
    "source": "https://huggingface.co/bartowski/Qwen2.5-Coder-3B-Instruct-GGUF",
    "repo": "bartowski/Qwen2.5-Coder-3B-Instruct-GGUF",
    "quantAuthor": "bartowski",
    "contextTokens": 32768,
    "tools": true,
    "vision": false,
    "notes": "Лицензия Qwen Research — проверьте условия для коммерческого использования.",
    "files": [
      {
        "quant": "Q2_K",
        "name": "Qwen2.5-Coder-3B-Instruct-Q2_K.gguf",
        "url": "https://huggingface.co/bartowski/Qwen2.5-Coder-3B-Instruct-GGUF/resolve/main/Qwen2.5-Coder-3B-Instruct-Q2_K.gguf",
        "sizeBytes": 1274756352,
        "sha256": "2e66080a6615da04f1b37446a580bc0d1a75ef5e49bf19d0bed3216baca7d7a1"
      },
      {
        "quant": "Q3_K_M",
        "name": "Qwen2.5-Coder-3B-Instruct-Q3_K_M.gguf",
        "url": "https://huggingface.co/bartowski/Qwen2.5-Coder-3B-Instruct-GGUF/resolve/main/Qwen2.5-Coder-3B-Instruct-Q3_K_M.gguf",
        "sizeBytes": 1590476032,
        "sha256": "27ffec3ed4c1482eeaee279f56ea5eb937921c550a528842d071ea80729d08f4"
      },
      {
        "quant": "Q4_K_M",
        "name": "Qwen2.5-Coder-3B-Instruct-Q4_K_M.gguf",
        "url": "https://huggingface.co/bartowski/Qwen2.5-Coder-3B-Instruct-GGUF/resolve/main/Qwen2.5-Coder-3B-Instruct-Q4_K_M.gguf",
        "sizeBytes": 1929903360,
        "sha256": "3da3afe6cf5c674ac195803ea0dd6fee7e1c228c2105c1ce8c66890d1d4ab460"
      }
    ],
    "developer": "Qwen Team (Alibaba)",
    "purposes": [
      "coding",
      "multilingual",
      "translation",
      "long-context"
    ],
    "verifiedAt": "2026-11-10"
  },
  {
    "id": "deepseek-coder-1.3b",
    "ollamaName": "litemind-deepseek-coder-1.3b",
    "displayName": "DeepSeek Coder 1.3B",
    "category": "small-coding",
    "restrictions": "standard",
    "uncensored": false,
    "uncensoredLabel": null,
    "tags": [
      "coding"
    ],
    "languages": [
      "en"
    ],
    "params": "1.3B",
    "family": "deepseek-coder",
    "purpose": "Классический coding-инструктор; силён в Python и завершении кода.",
    "quality": "Старее Qwen2.5-Coder, но стабилен.",
    "speed": "fast",
    "license": "deepseek (other)",
    "licenseNote": null,
    "source": "https://huggingface.co/TheBloke/deepseek-coder-1.3b-instruct-GGUF",
    "repo": "TheBloke/deepseek-coder-1.3b-instruct-GGUF",
    "quantAuthor": "TheBloke",
    "contextTokens": 16384,
    "tools": true,
    "vision": false,
    "notes": null,
    "files": [
      {
        "quant": "Q2_K",
        "name": "deepseek-coder-1.3b-instruct.Q2_K.gguf",
        "url": "https://huggingface.co/TheBloke/deepseek-coder-1.3b-instruct-GGUF/resolve/main/deepseek-coder-1.3b-instruct.Q2_K.gguf",
        "sizeBytes": 631705632,
        "sha256": "80648071361b5d0d71457bfabf71c40d7475e1792a988bc7c64f5598ab20e4c1"
      },
      {
        "quant": "Q3_K_M",
        "name": "deepseek-coder-1.3b-instruct.Q3_K_M.gguf",
        "url": "https://huggingface.co/TheBloke/deepseek-coder-1.3b-instruct-GGUF/resolve/main/deepseek-coder-1.3b-instruct.Q3_K_M.gguf",
        "sizeBytes": 704966688,
        "sha256": "ff02a88557469e4ea95500f7a845562bb8b670f119809ec9e71baaab5ed84db6"
      },
      {
        "quant": "Q4_K_M",
        "name": "deepseek-coder-1.3b-instruct.Q4_K_M.gguf",
        "url": "https://huggingface.co/TheBloke/deepseek-coder-1.3b-instruct-GGUF/resolve/main/deepseek-coder-1.3b-instruct.Q4_K_M.gguf",
        "sizeBytes": 873582624,
        "sha256": "04cebb6fafa40ae628cf6bfeb76032ec792852f54020c559ad0a56b9f2839118"
      }
    ],
    "developer": "DeepSeek",
    "purposes": [
      "coding"
    ],
    "verifiedAt": "2026-11-10"
  },
  {
    "id": "starcoder2-3b",
    "ollamaName": "litemind-starcoder2-3b",
    "displayName": "StarCoder2 3B Instruct",
    "category": "small-coding",
    "restrictions": "standard",
    "uncensored": false,
    "uncensoredLabel": null,
    "tags": [
      "coding"
    ],
    "languages": [
      "en",
      "multi"
    ],
    "params": "3B",
    "family": "starcoder2",
    "purpose": "80+ языков программирования, альтернативный стиль ответов.",
    "quality": "Широкое покрытие языков от BigCode.",
    "speed": "medium",
    "license": "bigcode-openrail-m (other)",
    "licenseNote": null,
    "source": "https://huggingface.co/QuantFactory/starcoder2-3b-instruct-v0.1-GGUF",
    "repo": "QuantFactory/starcoder2-3b-instruct-v0.1-GGUF",
    "quantAuthor": "QuantFactory",
    "contextTokens": 16384,
    "tools": true,
    "vision": false,
    "notes": null,
    "files": [
      {
        "quant": "Q2_K",
        "name": "starcoder2-3b-instruct-v0.1.Q2_K.gguf",
        "url": "https://huggingface.co/QuantFactory/starcoder2-3b-instruct-v0.1-GGUF/resolve/main/starcoder2-3b-instruct-v0.1.Q2_K.gguf",
        "sizeBytes": 1223505600,
        "sha256": "4dfe53a75542cacc859051d2dc751e1f5f57f0ae7a5506872edbcc55b97059e2"
      },
      {
        "quant": "Q3_K_M",
        "name": "starcoder2-3b-instruct-v0.1.Q3_K_M.gguf",
        "url": "https://huggingface.co/QuantFactory/starcoder2-3b-instruct-v0.1-GGUF/resolve/main/starcoder2-3b-instruct-v0.1.Q3_K_M.gguf",
        "sizeBytes": 1562592960,
        "sha256": "71d550bfbd7a6069b3eab2660f4dd50a49d150c6e83fdf344c151f8d80b38e42"
      },
      {
        "quant": "Q4_K_M",
        "name": "starcoder2-3b-instruct-v0.1.Q4_K_M.gguf",
        "url": "https://huggingface.co/QuantFactory/starcoder2-3b-instruct-v0.1-GGUF/resolve/main/starcoder2-3b-instruct-v0.1.Q4_K_M.gguf",
        "sizeBytes": 1887905472,
        "sha256": "8a5832f519083dd689e5cf0e16b6e93922253b0eb8ac3771416782d40985bbf8"
      }
    ],
    "developer": "BigCode",
    "purposes": [
      "coding",
      "multilingual",
      "translation"
    ],
    "verifiedAt": "2026-11-10"
  },
  {
    "id": "granite-code-3b",
    "ollamaName": "litemind-granite-code-3b",
    "displayName": "Granite Code 3B Instruct",
    "category": "small-coding",
    "restrictions": "standard",
    "uncensored": false,
    "uncensoredLabel": null,
    "tags": [
      "coding"
    ],
    "languages": [
      "en",
      "multi"
    ],
    "params": "3B",
    "family": "granite-code",
    "purpose": "IBM-модель для корпоративного кода; аккуратные, консервативные ответы.",
    "quality": "Спокойный стиль, хорошая база.",
    "speed": "medium",
    "license": "apache-2.0",
    "licenseNote": null,
    "source": "https://huggingface.co/mradermacher/granite-3b-code-instruct-i1-GGUF",
    "repo": "mradermacher/granite-3b-code-instruct-i1-GGUF",
    "quantAuthor": "mradermacher",
    "contextTokens": 8192,
    "tools": true,
    "vision": false,
    "notes": null,
    "files": [
      {
        "quant": "Q2_K",
        "name": "granite-3b-code-instruct.i1-Q2_K.gguf",
        "url": "https://huggingface.co/mradermacher/granite-3b-code-instruct-i1-GGUF/resolve/main/granite-3b-code-instruct.i1-Q2_K.gguf",
        "sizeBytes": 1338694048,
        "sha256": "0d98ed296d3451199c1a5fe4796383644251b999392ec3db06e67ebb00b170c9"
      },
      {
        "quant": "Q3_K_M",
        "name": "granite-3b-code-instruct.i1-Q3_K_M.gguf",
        "url": "https://huggingface.co/mradermacher/granite-3b-code-instruct-i1-GGUF/resolve/main/granite-3b-code-instruct.i1-Q3_K_M.gguf",
        "sizeBytes": 1726994848,
        "sha256": "604728ef55c007b5590d9ab95caa32dd4cebef32d778b996e80f77d25af27e86"
      },
      {
        "quant": "Q4_K_M",
        "name": "granite-3b-code-instruct.i1-Q4_K_M.gguf",
        "url": "https://huggingface.co/mradermacher/granite-3b-code-instruct-i1-GGUF/resolve/main/granite-3b-code-instruct.i1-Q4_K_M.gguf",
        "sizeBytes": 2132498848,
        "sha256": "b80229ef971a0acce252f3d7db3e30f2ed8c29ad0f5b4cb26e4c9631c853c539"
      }
    ],
    "developer": "IBM",
    "purposes": [
      "coding",
      "multilingual",
      "translation"
    ],
    "verifiedAt": "2026-11-10"
  },
  {
    "id": "qwen2.5-coder-7b",
    "ollamaName": "litemind-qwen2.5-coder-7b",
    "displayName": "Qwen2.5 Coder 7B",
    "category": "advanced-coding",
    "restrictions": "standard",
    "uncensored": false,
    "uncensoredLabel": null,
    "tags": [
      "coding"
    ],
    "languages": [
      "ru",
      "en",
      "multi"
    ],
    "params": "7B",
    "family": "qwen2.5-coder",
    "purpose": "Максимум качества в coding: сложный рефакторинг, большие правки, агенты.",
    "quality": "Лучший кодер каталога; на CPU без AVX — 1–3 ток/с.",
    "speed": "slow",
    "license": "apache-2.0",
    "licenseNote": null,
    "source": "https://huggingface.co/bartowski/Qwen2.5-Coder-7B-Instruct-GGUF",
    "repo": "bartowski/Qwen2.5-Coder-7B-Instruct-GGUF",
    "quantAuthor": "bartowski",
    "contextTokens": 32768,
    "tools": true,
    "vision": false,
    "notes": null,
    "files": [
      {
        "quant": "Q2_K",
        "name": "Qwen2.5-Coder-7B-Instruct-Q2_K.gguf",
        "url": "https://huggingface.co/bartowski/Qwen2.5-Coder-7B-Instruct-GGUF/resolve/main/Qwen2.5-Coder-7B-Instruct-Q2_K.gguf",
        "sizeBytes": 3015940896,
        "sha256": "85d75a97b3ef455daf2f69c86fff876fe854cfbc14fc59d75b2746a0cd7e72c5"
      },
      {
        "quant": "Q3_K_S",
        "name": "Qwen2.5-Coder-7B-Instruct-Q3_K_S.gguf",
        "url": "https://huggingface.co/bartowski/Qwen2.5-Coder-7B-Instruct-GGUF/resolve/main/Qwen2.5-Coder-7B-Instruct-Q3_K_S.gguf",
        "sizeBytes": 3492369184,
        "sha256": "1c89e2deba07e577246931dc3c2d5fac3278bebb1748277df16d642be4fa127b"
      },
      {
        "quant": "Q4_K_M",
        "name": "Qwen2.5-Coder-7B-Instruct-Q4_K_M.gguf",
        "url": "https://huggingface.co/bartowski/Qwen2.5-Coder-7B-Instruct-GGUF/resolve/main/Qwen2.5-Coder-7B-Instruct-Q4_K_M.gguf",
        "sizeBytes": 4683074336,
        "sha256": "1664fccab734674a50763490a8c6931b70e3f2f8ec10031b54806d30e5f956b6"
      }
    ],
    "developer": "Qwen Team (Alibaba)",
    "purposes": [
      "coding",
      "multilingual",
      "translation",
      "long-context"
    ],
    "verifiedAt": "2026-11-10"
  },
  {
    "id": "deepseek-coder-6.7b",
    "ollamaName": "litemind-deepseek-coder-6.7b",
    "displayName": "DeepSeek Coder 6.7B",
    "category": "advanced-coding",
    "restrictions": "standard",
    "uncensored": false,
    "uncensoredLabel": null,
    "tags": [
      "coding"
    ],
    "languages": [
      "en"
    ],
    "params": "6.7B",
    "family": "deepseek-coder",
    "purpose": "Сильный конкурент Qwen 7B; глубокие объяснения и длинный код.",
    "quality": "Мощный кодер; только для 16 ГБ с Q2/Q3.",
    "speed": "slow",
    "license": "deepseek (other)",
    "licenseNote": null,
    "source": "https://huggingface.co/TheBloke/deepseek-coder-6.7b-instruct-GGUF",
    "repo": "TheBloke/deepseek-coder-6.7b-instruct-GGUF",
    "quantAuthor": "TheBloke",
    "contextTokens": 16384,
    "tools": true,
    "vision": false,
    "notes": null,
    "files": [
      {
        "quant": "Q2_K",
        "name": "deepseek-coder-6.7b-instruct.Q2_K.gguf",
        "url": "https://huggingface.co/TheBloke/deepseek-coder-6.7b-instruct-GGUF/resolve/main/deepseek-coder-6.7b-instruct.Q2_K.gguf",
        "sizeBytes": 2827706592,
        "sha256": "56447b37bd7c606c081d9b216b69c6cd77db6b473721b709a7b21ed4606e4960"
      },
      {
        "quant": "Q3_K_S",
        "name": "deepseek-coder-6.7b-instruct.Q3_K_S.gguf",
        "url": "https://huggingface.co/TheBloke/deepseek-coder-6.7b-instruct-GGUF/resolve/main/deepseek-coder-6.7b-instruct.Q3_K_S.gguf",
        "sizeBytes": 2950176992,
        "sha256": "176ed1c984911dfb1707e85e4f56b8ab6986f21eec9fc7d6a31d5e3cce141e52"
      },
      {
        "quant": "Q4_K_M",
        "name": "deepseek-coder-6.7b-instruct.Q4_K_M.gguf",
        "url": "https://huggingface.co/TheBloke/deepseek-coder-6.7b-instruct-GGUF/resolve/main/deepseek-coder-6.7b-instruct.Q4_K_M.gguf",
        "sizeBytes": 4083015904,
        "sha256": "92da6238854f2fa902d8b2ad79d548536af1d3ab06821f323bd5bbcea2013276"
      }
    ],
    "developer": "DeepSeek",
    "purposes": [
      "coding"
    ],
    "verifiedAt": "2026-11-10"
  },
  {
    "id": "qwen2.5-coder-1.5b-abliterated",
    "ollamaName": "litemind-qwen2.5-coder-1.5b-abliterated",
    "displayName": "Qwen2.5 Coder 1.5B Abliterated",
    "category": "uncensored-coding",
    "restrictions": "reduced",
    "uncensored": true,
    "uncensoredLabel": "Abliterated",
    "tags": [
      "coding"
    ],
    "languages": [
      "ru",
      "en",
      "multi"
    ],
    "params": "1.5B",
    "family": "qwen2.5-coder",
    "purpose": "Coding без встроенных отказов; отвечает на темы, которые обычные модели блокируют.",
    "quality": "Качество кода близко к оригиналу; отказов почти нет.",
    "speed": "fast",
    "license": "apache-2.0",
    "licenseNote": null,
    "source": "https://huggingface.co/bartowski/Qwen2.5-Coder-1.5B-Instruct-abliterated-GGUF",
    "repo": "bartowski/Qwen2.5-Coder-1.5B-Instruct-abliterated-GGUF",
    "quantAuthor": "bartowski",
    "contextTokens": 32768,
    "tools": true,
    "vision": false,
    "notes": null,
    "files": [
      {
        "quant": "Q2_K",
        "name": "Qwen2.5-Coder-1.5B-Instruct-abliterated-Q2_K.gguf",
        "url": "https://huggingface.co/bartowski/Qwen2.5-Coder-1.5B-Instruct-abliterated-GGUF/resolve/main/Qwen2.5-Coder-1.5B-Instruct-abliterated-Q2_K.gguf",
        "sizeBytes": 752881120,
        "sha256": "9a7b865ad68e2cce58b5bed9c6fc65096c0a88b1eceb5a12f55005ffc75c2d1f"
      },
      {
        "quant": "Q3_K_M",
        "name": "Qwen2.5-Coder-1.5B-Instruct-abliterated-Q3_K_M.gguf",
        "url": "https://huggingface.co/bartowski/Qwen2.5-Coder-1.5B-Instruct-abliterated-GGUF/resolve/main/Qwen2.5-Coder-1.5B-Instruct-abliterated-Q3_K_M.gguf",
        "sizeBytes": 924456928,
        "sha256": "1e7d20fc77b8e22e43f11d86246a4858ce97d65fe54bbd80b53814adf6497cac"
      },
      {
        "quant": "Q4_K_M",
        "name": "Qwen2.5-Coder-1.5B-Instruct-abliterated-Q4_K_M.gguf",
        "url": "https://huggingface.co/bartowski/Qwen2.5-Coder-1.5B-Instruct-abliterated-GGUF/resolve/main/Qwen2.5-Coder-1.5B-Instruct-abliterated-Q4_K_M.gguf",
        "sizeBytes": 1117321696,
        "sha256": "389b8172028c874b79a11358d258222dbce272b56ab3512ccc743893a25e06b4"
      }
    ],
    "developer": "Qwen Team (Alibaba)",
    "purposes": [
      "coding",
      "multilingual",
      "translation",
      "long-context"
    ],
    "verifiedAt": "2026-11-10"
  },
  {
    "id": "qwen2.5-coder-3b-abliterated",
    "ollamaName": "litemind-qwen2.5-coder-3b-abliterated",
    "displayName": "Qwen2.5 Coder 3B Abliterated",
    "category": "uncensored-coding",
    "restrictions": "reduced",
    "uncensored": true,
    "uncensoredLabel": "Abliterated",
    "tags": [
      "coding"
    ],
    "languages": [
      "ru",
      "en",
      "multi"
    ],
    "params": "3B",
    "family": "qwen2.5-coder",
    "purpose": "Более умный coding без отказов; лучший баланс «ум / RAM» для 16 ГБ.",
    "quality": "Практически без отказов при сохранении качества 3B.",
    "speed": "medium",
    "license": "qwen-research (other)",
    "licenseNote": "Лицензия Qwen Research — проверьте условия для коммерческого использования.",
    "source": "https://huggingface.co/bartowski/Qwen2.5-Coder-3B-Instruct-abliterated-GGUF",
    "repo": "bartowski/Qwen2.5-Coder-3B-Instruct-abliterated-GGUF",
    "quantAuthor": "bartowski",
    "contextTokens": 32768,
    "tools": true,
    "vision": false,
    "notes": "Лицензия Qwen Research — проверьте условия для коммерческого использования.",
    "files": [
      {
        "quant": "Q2_K",
        "name": "Qwen2.5-Coder-3B-Instruct-abliterated-Q2_K.gguf",
        "url": "https://huggingface.co/bartowski/Qwen2.5-Coder-3B-Instruct-abliterated-GGUF/resolve/main/Qwen2.5-Coder-3B-Instruct-abliterated-Q2_K.gguf",
        "sizeBytes": 1274756480,
        "sha256": "0317a9b6b369491efa29263440b0a76c76afb5aa85cd0996673a67376f718eb5"
      },
      {
        "quant": "Q3_K_M",
        "name": "Qwen2.5-Coder-3B-Instruct-abliterated-Q3_K_M.gguf",
        "url": "https://huggingface.co/bartowski/Qwen2.5-Coder-3B-Instruct-abliterated-GGUF/resolve/main/Qwen2.5-Coder-3B-Instruct-abliterated-Q3_K_M.gguf",
        "sizeBytes": 1590476160,
        "sha256": "019caba6c381b2a43aade0adaa60b13124525cd9a648e9b0d067a59ea7746892"
      },
      {
        "quant": "Q4_K_M",
        "name": "Qwen2.5-Coder-3B-Instruct-abliterated-Q4_K_M.gguf",
        "url": "https://huggingface.co/bartowski/Qwen2.5-Coder-3B-Instruct-abliterated-GGUF/resolve/main/Qwen2.5-Coder-3B-Instruct-abliterated-Q4_K_M.gguf",
        "sizeBytes": 1929903488,
        "sha256": "d5c108dfbdac44c738e45a84d5624716cfb8522d1410f46a7108167ee4bd0cac"
      }
    ],
    "developer": "Qwen Team (Alibaba)",
    "purposes": [
      "coding",
      "multilingual",
      "translation",
      "long-context"
    ],
    "verifiedAt": "2026-11-10"
  },
  {
    "id": "qwen2.5-coder-7b-abliterated",
    "ollamaName": "litemind-qwen2.5-coder-7b-abliterated",
    "displayName": "Qwen2.5 Coder 7B Abliterated",
    "category": "uncensored-coding",
    "restrictions": "reduced",
    "uncensored": true,
    "uncensoredLabel": "Abliterated",
    "tags": [
      "coding"
    ],
    "languages": [
      "ru",
      "en",
      "multi"
    ],
    "params": "7B",
    "family": "qwen2.5-coder",
    "purpose": "Мощный coding без отказов. Только 16+ ГБ RAM и только Q2/Q3 квант.",
    "quality": "Максимум кода без отказов; медленно на CPU без AVX.",
    "speed": "slow",
    "license": "apache-2.0",
    "licenseNote": null,
    "source": "https://huggingface.co/bartowski/Qwen2.5-Coder-7B-Instruct-abliterated-GGUF",
    "repo": "bartowski/Qwen2.5-Coder-7B-Instruct-abliterated-GGUF",
    "quantAuthor": "bartowski",
    "contextTokens": 32768,
    "tools": true,
    "vision": false,
    "notes": null,
    "files": [
      {
        "quant": "Q2_K",
        "name": "Qwen2.5-Coder-7B-Instruct-abliterated-Q2_K.gguf",
        "url": "https://huggingface.co/bartowski/Qwen2.5-Coder-7B-Instruct-abliterated-GGUF/resolve/main/Qwen2.5-Coder-7B-Instruct-abliterated-Q2_K.gguf",
        "sizeBytes": 3015940960,
        "sha256": "469810f66a49925ee1a96592979b230fa79223def9ec3450f9d6834daa6ce47f"
      },
      {
        "quant": "Q3_K_S",
        "name": "Qwen2.5-Coder-7B-Instruct-abliterated-Q3_K_S.gguf",
        "url": "https://huggingface.co/bartowski/Qwen2.5-Coder-7B-Instruct-abliterated-GGUF/resolve/main/Qwen2.5-Coder-7B-Instruct-abliterated-Q3_K_S.gguf",
        "sizeBytes": 3492369248,
        "sha256": "ca328bb73083768f502ca59e58d77eeda1b54e898d5cf639cb234e5d70877735"
      },
      {
        "quant": "Q4_K_M",
        "name": "Qwen2.5-Coder-7B-Instruct-abliterated-Q4_K_M.gguf",
        "url": "https://huggingface.co/bartowski/Qwen2.5-Coder-7B-Instruct-abliterated-GGUF/resolve/main/Qwen2.5-Coder-7B-Instruct-abliterated-Q4_K_M.gguf",
        "sizeBytes": 4683074400,
        "sha256": "fdf02c16fb654ff60b2c30f1e91573ebc603a7084df3449df89120dca2b18170"
      }
    ],
    "developer": "Qwen Team (Alibaba)",
    "purposes": [
      "coding",
      "multilingual",
      "translation",
      "long-context"
    ],
    "verifiedAt": "2026-11-10"
  },
  {
    "id": "qwen2.5-coder-1.5b-noncensure",
    "ollamaName": "litemind-qwen2.5-coder-1.5b-noncensure",
    "displayName": "Qwen2.5 Coder 1.5B Non-Censure (Tree-AI)",
    "category": "uncensored-coding",
    "restrictions": "reduced",
    "uncensored": true,
    "uncensoredLabel": "Uncensored",
    "tags": [
      "coding"
    ],
    "languages": [
      "ru",
      "en"
    ],
    "params": "1.5B",
    "family": "qwen2.5-coder",
    "purpose": "Uncensored-вариант для слабых устройств, один готовый файл Q4_K_M.",
    "quality": "Происхождение — авторский файнтюн; качество проверяйте на своих задачах.",
    "speed": "fast",
    "license": "not specified",
    "licenseNote": "Репозиторий не указывает лицензию — проверьте перед коммерческим использованием.",
    "source": "https://huggingface.co/Tree-AI-lab/Qwen2.5-Coder-1.5B-Instruct-non-censure-uncensored-coder-for-android-GGUF",
    "repo": "Tree-AI-lab/Qwen2.5-Coder-1.5B-Instruct-non-censure-uncensored-coder-for-android-GGUF",
    "quantAuthor": "Tree-AI-lab",
    "contextTokens": 32768,
    "tools": true,
    "vision": false,
    "notes": "Репозиторий не указывает лицензию — проверьте перед коммерческим использованием.",
    "files": [
      {
        "quant": "Q4_K_M",
        "name": "Qwen2.5-Coder-1.5B-Instruct-abliterated-Q4_K_M.gguf",
        "url": "https://huggingface.co/Tree-AI-lab/Qwen2.5-Coder-1.5B-Instruct-non-censure-uncensored-coder-for-android-GGUF/resolve/main/Qwen2.5-Coder-1.5B-Instruct-abliterated-Q4_K_M.gguf",
        "sizeBytes": 1117321856,
        "sha256": "e3a3e812128b3499a36982841720f52827ea1c315ebd152a17778b3a121b230d"
      }
    ],
    "developer": "Qwen Team (Alibaba)",
    "purposes": [
      "coding",
      "long-context"
    ],
    "verifiedAt": "2026-11-10"
  },
  {
    "id": "dolphin3.0-llama3.2-3b",
    "ollamaName": "litemind-dolphin3.0-llama3.2-3b",
    "displayName": "Dolphin 3.0 Llama 3.2 3B",
    "category": "uncensored-chat",
    "restrictions": "reduced",
    "uncensored": true,
    "uncensoredLabel": "Uncensored",
    "tags": [
      "chat",
      "general"
    ],
    "languages": [
      "en",
      "multi"
    ],
    "params": "3.2B",
    "family": "dolphin",
    "purpose": "Dolphin от Cognitive Computations: ослабленные отказы, послушание инструкциям, на базе Llama 3.2 3B.",
    "quality": "Популярная uncensored-линейка с живым сообществом; отказов мало, но они не «абсолютные».",
    "speed": "medium",
    "license": "llama3.2",
    "licenseNote": "Базовая лицензия Meta Llama 3.2; поведение модели — ответственность пользователя.",
    "source": "https://huggingface.co/bartowski/Dolphin3.0-Llama3.2-3B-GGUF",
    "repo": "bartowski/Dolphin3.0-Llama3.2-3B-GGUF",
    "quantAuthor": "bartowski",
    "contextTokens": 32768,
    "tools": true,
    "vision": false,
    "notes": "Базовая лицензия Meta Llama 3.2; поведение модели — ответственность пользователя.",
    "files": [
      {
        "quant": "Q2_K",
        "name": "Dolphin3.0-Llama3.2-3B-Q2_K.gguf",
        "url": "https://huggingface.co/bartowski/Dolphin3.0-Llama3.2-3B-GGUF/resolve/main/Dolphin3.0-Llama3.2-3B-Q2_K.gguf",
        "sizeBytes": 1363940480,
        "sha256": "c43919526d31d95a9832e2df327e0ebfc2d016413b5d231eda709ac833974860"
      },
      {
        "quant": "Q3_K_M",
        "name": "Dolphin3.0-Llama3.2-3B-Q3_K_M.gguf",
        "url": "https://huggingface.co/bartowski/Dolphin3.0-Llama3.2-3B-GGUF/resolve/main/Dolphin3.0-Llama3.2-3B-Q3_K_M.gguf",
        "sizeBytes": 1687164032,
        "sha256": "fd7a13e2eb7ec276c24062880b249ac3990fdc38c61abcae9d15dc9b849b35b3"
      },
      {
        "quant": "Q4_K_M",
        "name": "Dolphin3.0-Llama3.2-3B-Q4_K_M.gguf",
        "url": "https://huggingface.co/bartowski/Dolphin3.0-Llama3.2-3B-GGUF/resolve/main/Dolphin3.0-Llama3.2-3B-Q4_K_M.gguf",
        "sizeBytes": 2019382400,
        "sha256": "5d6d02eeefa1ab5dbf23f97afdf5c2c95ad3d946dc3b6e9ab72e6c1637d54177"
      },
      {
        "quant": "Q5_K_M",
        "name": "Dolphin3.0-Llama3.2-3B-Q5_K_M.gguf",
        "url": "https://huggingface.co/bartowski/Dolphin3.0-Llama3.2-3B-GGUF/resolve/main/Dolphin3.0-Llama3.2-3B-Q5_K_M.gguf",
        "sizeBytes": 2322158720,
        "sha256": "6d80400d2354e95966e324fe0840ce3d0d4f6f72b16f4bea940baa4aa1be4a86"
      }
    ],
    "developer": "Cognitive Computations",
    "purposes": [
      "chat",
      "writing",
      "creative",
      "multilingual",
      "translation",
      "long-context"
    ],
    "verifiedAt": "2026-11-10"
  },
  {
    "id": "dolphin-2.9.3-mistral-7b",
    "ollamaName": "litemind-dolphin-2.9.3-mistral-7b",
    "displayName": "Dolphin 2.9.3 Mistral 7B",
    "category": "uncensored-chat",
    "restrictions": "reduced",
    "uncensored": true,
    "uncensoredLabel": "Uncensored",
    "tags": [
      "chat",
      "general"
    ],
    "languages": [
      "en",
      "multi"
    ],
    "params": "7.2B",
    "family": "dolphin",
    "purpose": "Старшая версия Dolphin на Mistral 7B: минимум отказов, хорошо следует инструкциям.",
    "quality": "Классика uncensored-класса; на 16 ГБ — только Q2/Q3.",
    "speed": "slow",
    "license": "apache-2.0",
    "licenseNote": null,
    "source": "https://huggingface.co/bartowski/dolphin-2.9.3-mistral-7B-32k-GGUF",
    "repo": "bartowski/dolphin-2.9.3-mistral-7B-32k-GGUF",
    "quantAuthor": "bartowski",
    "contextTokens": 32768,
    "tools": true,
    "vision": false,
    "notes": null,
    "files": [
      {
        "quant": "Q2_K",
        "name": "dolphin-2.9.3-mistral-7B-32k-Q2_K.gguf",
        "url": "https://huggingface.co/bartowski/dolphin-2.9.3-mistral-7B-32k-GGUF/resolve/main/dolphin-2.9.3-mistral-7B-32k-Q2_K.gguf",
        "sizeBytes": 2722887040,
        "sha256": "9d908cff6826fbaa8487421da7c561d3a328a01d103d0e98c779f360e630397f"
      },
      {
        "quant": "Q3_K_M",
        "name": "dolphin-2.9.3-mistral-7B-32k-Q3_K_M.gguf",
        "url": "https://huggingface.co/bartowski/dolphin-2.9.3-mistral-7B-32k-GGUF/resolve/main/dolphin-2.9.3-mistral-7B-32k-Q3_K_M.gguf",
        "sizeBytes": 3522951360,
        "sha256": "4743d456a842e1b603cf2bcda1b3bc53ed31f925b02b8a389d905eb1e05319bc"
      },
      {
        "quant": "Q4_K_M",
        "name": "dolphin-2.9.3-mistral-7B-32k-Q4_K_M.gguf",
        "url": "https://huggingface.co/bartowski/dolphin-2.9.3-mistral-7B-32k-GGUF/resolve/main/dolphin-2.9.3-mistral-7B-32k-Q4_K_M.gguf",
        "sizeBytes": 4372823296,
        "sha256": "91ae62516b835a06ece6cee2c20b66c34647287175d2dfb13bc4dcf119ac0bbe"
      }
    ],
    "developer": "Cognitive Computations",
    "purposes": [
      "chat",
      "writing",
      "creative",
      "analysis",
      "multilingual",
      "translation",
      "long-context"
    ],
    "verifiedAt": "2026-11-10"
  },
  {
    "id": "llama-3.2-1b-abliterated",
    "ollamaName": "litemind-llama-3.2-1b-abliterated",
    "displayName": "Llama 3.2 1B Instruct Abliterated (Huihui)",
    "category": "uncensored-chat",
    "restrictions": "reduced",
    "uncensored": true,
    "uncensoredLabel": "Abliterated",
    "tags": [
      "chat",
      "tiny"
    ],
    "languages": [
      "en"
    ],
    "params": "1.24B",
    "family": "llama3.2",
    "purpose": "Abliterated-версия Llama 3.2 1B от huihui-ai: сверхлёгкая модель с ослабленными отказами.",
    "quality": "Компромиссное качество 1B; отказов меньше, но интеллект ограничен.",
    "speed": "fast",
    "license": "llama3.2",
    "licenseNote": "Базовая лицензия Meta Llama 3.2.",
    "source": "https://huggingface.co/RichardErkhov/huihui-ai_-_Llama-3.2-1B-Instruct-abliterated-gguf",
    "repo": "RichardErkhov/huihui-ai_-_Llama-3.2-1B-Instruct-abliterated-gguf",
    "quantAuthor": "huihui-ai (GGUF — RichardErkhov)",
    "contextTokens": 32768,
    "tools": true,
    "vision": false,
    "notes": "Базовая лицензия Meta Llama 3.2.",
    "files": [
      {
        "quant": "Q4_K_M",
        "name": "Llama-3.2-1B-Instruct-abliterated.Q4_K_M.gguf",
        "url": "https://huggingface.co/RichardErkhov/huihui-ai_-_Llama-3.2-1B-Instruct-abliterated-gguf/resolve/main/Llama-3.2-1B-Instruct-abliterated.Q4_K_M.gguf",
        "sizeBytes": 955445312,
        "sha256": "2ee12dd7a070fa7ff1e8e3c1d453e926e3e24f90b967aac83db5188bfb89120d"
      },
      {
        "quant": "Q5_K_M",
        "name": "Llama-3.2-1B-Instruct-abliterated.Q5_K_M.gguf",
        "url": "https://huggingface.co/RichardErkhov/huihui-ai_-_Llama-3.2-1B-Instruct-abliterated-gguf/resolve/main/Llama-3.2-1B-Instruct-abliterated.Q5_K_M.gguf",
        "sizeBytes": 1092087872,
        "sha256": "ea28944e211bb4f79e37dfaaedc89583e75d05a48a368721bc10c59e4ed6982c"
      },
      {
        "quant": "Q6_K",
        "name": "Llama-3.2-1B-Instruct-abliterated.Q6_K.gguf",
        "url": "https://huggingface.co/RichardErkhov/huihui-ai_-_Llama-3.2-1B-Instruct-abliterated-gguf/resolve/main/Llama-3.2-1B-Instruct-abliterated.Q6_K.gguf",
        "sizeBytes": 1237270592,
        "sha256": "701db8fe1e1daf60ac7428103d6c23f5cc75cfd8e478bd010c844f47d40d177c"
      },
      {
        "quant": "Q8_0",
        "name": "Llama-3.2-1B-Instruct-abliterated.Q8_0.gguf",
        "url": "https://huggingface.co/RichardErkhov/huihui-ai_-_Llama-3.2-1B-Instruct-abliterated-gguf/resolve/main/Llama-3.2-1B-Instruct-abliterated.Q8_0.gguf",
        "sizeBytes": 1600168000,
        "sha256": "e3074a9e9ddd88234106791e2aed3da9fc58d50ec327cb2bbce7de68fc0fa311"
      }
    ],
    "developer": "Meta",
    "purposes": [
      "chat",
      "writing",
      "creative",
      "long-context"
    ],
    "verifiedAt": "2026-11-10"
  },
  {
    "id": "llama-3.2-3b-abliterated",
    "ollamaName": "litemind-llama-3.2-3b-abliterated",
    "displayName": "Llama 3.2 3B Instruct Abliterated (Huihui)",
    "category": "uncensored-chat",
    "restrictions": "reduced",
    "uncensored": true,
    "uncensoredLabel": "Abliterated",
    "tags": [
      "chat"
    ],
    "languages": [
      "en"
    ],
    "params": "3.2B",
    "family": "llama3.2",
    "purpose": "Abliterated-версия Llama 3.2 3B от huihui-ai: ослабленные отказы при крепком базовом интеллекте.",
    "quality": "Один из качественных abliterated-вариантов 3B.",
    "speed": "medium",
    "license": "llama3.2",
    "licenseNote": "Базовая лицензия Meta Llama 3.2.",
    "source": "https://huggingface.co/RichardErkhov/huihui-ai_-_Llama-3.2-3B-Instruct-abliterated-gguf",
    "repo": "RichardErkhov/huihui-ai_-_Llama-3.2-3B-Instruct-abliterated-gguf",
    "quantAuthor": "huihui-ai (GGUF — RichardErkhov)",
    "contextTokens": 32768,
    "tools": true,
    "vision": false,
    "notes": "Базовая лицензия Meta Llama 3.2.",
    "files": [
      {
        "quant": "Q2_K",
        "name": "Llama-3.2-3B-Instruct-abliterated.Q2_K.gguf",
        "url": "https://huggingface.co/RichardErkhov/huihui-ai_-_Llama-3.2-3B-Instruct-abliterated-gguf/resolve/main/Llama-3.2-3B-Instruct-abliterated.Q2_K.gguf",
        "sizeBytes": 1493217760,
        "sha256": "b8907e42e5dd19550a0ea54db63c22f88f428dab65020ab8847a2bfe7c6549d2"
      },
      {
        "quant": "Q3_K_M",
        "name": "Llama-3.2-3B-Instruct-abliterated.Q3_K_M.gguf",
        "url": "https://huggingface.co/RichardErkhov/huihui-ai_-_Llama-3.2-3B-Instruct-abliterated-gguf/resolve/main/Llama-3.2-3B-Instruct-abliterated.Q3_K_M.gguf",
        "sizeBytes": 1856457184,
        "sha256": "9f5be6d61621e806c84f39d0dfe74af00e1f338de68181b128e13bf801557228"
      },
      {
        "quant": "Q4_K_M",
        "name": "Llama-3.2-3B-Instruct-abliterated.Q4_K_M.gguf",
        "url": "https://huggingface.co/RichardErkhov/huihui-ai_-_Llama-3.2-3B-Instruct-abliterated-gguf/resolve/main/Llama-3.2-3B-Instruct-abliterated.Q4_K_M.gguf",
        "sizeBytes": 2241004000,
        "sha256": "e92d124259f57b89f4c2b40b5cac7049e27318389222d9ac506424db96291abf"
      },
      {
        "quant": "Q5_K_M",
        "name": "Llama-3.2-3B-Instruct-abliterated.Q5_K_M.gguf",
        "url": "https://huggingface.co/RichardErkhov/huihui-ai_-_Llama-3.2-3B-Instruct-abliterated-gguf/resolve/main/Llama-3.2-3B-Instruct-abliterated.Q5_K_M.gguf",
        "sizeBytes": 2593030624,
        "sha256": "d44d400b3abfde73a6fa2dab8df3226b71ed08be360ddc96e08d58136b81554a"
      }
    ],
    "developer": "Meta",
    "purposes": [
      "chat",
      "writing",
      "creative",
      "long-context"
    ],
    "verifiedAt": "2026-11-10"
  },
  {
    "id": "huihui-qwen2.5-0.5b-abliterated-v3",
    "ollamaName": "litemind-huihui-qwen2.5-0.5b-abliterated-v3",
    "displayName": "Huihui Qwen2.5 0.5B Abliterated v3",
    "category": "uncensored-chat",
    "restrictions": "reduced",
    "uncensored": true,
    "uncensoredLabel": "Abliterated",
    "tags": [
      "chat",
      "uncensored",
      "tiny"
    ],
    "languages": [
      "ru",
      "en",
      "multi"
    ],
    "params": "0.5B",
    "family": "huihui-qwen2.5",
    "purpose": "Ослабленная (abliterated) версия Qwen2.5 0.5B от Huihui-ai: отвечает в свободном стиле, отказов даёт заметно меньше базовой модели. Самая лёгкая из линейки Huihui.",
    "quality": "Для своих 0.5B — живой и быстрый собеседник; сложные рассуждения не потянет. Работает даже на слабом ПК.",
    "speed": "fast",
    "license": "apache-2.0",
    "licenseNote": null,
    "source": "https://huggingface.co/mradermacher/Qwen2.5-0.5B-Instruct-abliterated-v3-GGUF",
    "repo": "mradermacher/Qwen2.5-0.5B-Instruct-abliterated-v3-GGUF",
    "quantAuthor": "mradermacher (кванты; модель — huihui-ai)",
    "contextTokens": 32768,
    "tools": false,
    "vision": false,
    "notes": "Оригинальные веса: huihui-ai/Qwen2.5-0.5B-Instruct-abliterated-v3 (Apache-2.0).",
    "developer": "Qwen Team (Alibaba) · дообучение Huihui-ai",
    "purposes": [
      "chat",
      "writing",
      "creative",
      "multilingual",
      "translation",
      "long-context"
    ],
    "verifiedAt": "2026-11-10",
    "files": [
      {
        "quant": "Q4_K_M",
        "name": "Qwen2.5-0.5B-Instruct-abliterated-v3.Q4_K_M.gguf",
        "url": "https://huggingface.co/mradermacher/Qwen2.5-0.5B-Instruct-abliterated-v3-GGUF/resolve/main/Qwen2.5-0.5B-Instruct-abliterated-v3.Q4_K_M.gguf",
        "sizeBytes": 397808544,
        "sha256": "675532c67ddb159b2148c6389933ac9cae78af1527d0cdfcd82b95f85071bfa2"
      },
      {
        "quant": "Q5_K_M",
        "name": "Qwen2.5-0.5B-Instruct-abliterated-v3.Q5_K_M.gguf",
        "url": "https://huggingface.co/mradermacher/Qwen2.5-0.5B-Instruct-abliterated-v3-GGUF/resolve/main/Qwen2.5-0.5B-Instruct-abliterated-v3.Q5_K_M.gguf",
        "sizeBytes": 420086688,
        "sha256": "b336eefdc5d81f2b70539fff5475a0f4571847738356bd0229ea9788fdc4b260"
      },
      {
        "quant": "Q6_K",
        "name": "Qwen2.5-0.5B-Instruct-abliterated-v3.Q6_K.gguf",
        "url": "https://huggingface.co/mradermacher/Qwen2.5-0.5B-Instruct-abliterated-v3-GGUF/resolve/main/Qwen2.5-0.5B-Instruct-abliterated-v3.Q6_K.gguf",
        "sizeBytes": 505737120,
        "sha256": "a80988434b665fb4fb703827765120f44572fe1070528ffb11844da2507e739e"
      },
      {
        "quant": "Q8_0",
        "name": "Qwen2.5-0.5B-Instruct-abliterated-v3.Q8_0.gguf",
        "url": "https://huggingface.co/mradermacher/Qwen2.5-0.5B-Instruct-abliterated-v3-GGUF/resolve/main/Qwen2.5-0.5B-Instruct-abliterated-v3.Q8_0.gguf",
        "sizeBytes": 531068832,
        "sha256": "9b29389f734f8d263fe456f6c65b65511bf1628634de6a1fd9a10631e38deadc"
      }
    ]
  },
  {
    "id": "huihui-qwen3-1.7b-abliterated",
    "ollamaName": "litemind-huihui-qwen3-1.7b-abliterated",
    "displayName": "Huihui Qwen3 1.7B Abliterated",
    "category": "uncensored-chat",
    "restrictions": "reduced",
    "uncensored": true,
    "uncensoredLabel": "Abliterated",
    "tags": [
      "chat",
      "uncensored",
      "small"
    ],
    "languages": [
      "ru",
      "en",
      "multi"
    ],
    "params": "1.7B",
    "family": "huihui-qwen3",
    "purpose": "Abliterated-версия Qwen3 1.7B от Huihui-ai: свободный стиль ответов при сохранении навыков Qwen3 (режим thinking наследуется).",
    "quality": "Заметно умнее 0.5–0.6B моделей, при этом остаётся достаточно быстрой на CPU без AVX.",
    "speed": "fast",
    "license": "apache-2.0",
    "licenseNote": null,
    "source": "https://huggingface.co/mradermacher/Qwen3-1.7B-abliterated-GGUF",
    "repo": "mradermacher/Qwen3-1.7B-abliterated-GGUF",
    "quantAuthor": "mradermacher (кванты; модель — huihui-ai)",
    "contextTokens": 32768,
    "tools": false,
    "vision": false,
    "notes": "Репозиторий модели у huihui-ai помечен gated:auto — кванты взяты из публичного рерайта mradermacher.",
    "developer": "Qwen Team (Alibaba) · дообучение Huihui-ai",
    "purposes": [
      "chat",
      "writing",
      "creative",
      "multilingual",
      "translation",
      "long-context"
    ],
    "verifiedAt": "2026-11-10",
    "files": [
      {
        "quant": "Q4_K_M",
        "name": "Qwen3-1.7B-abliterated.Q4_K_M.gguf",
        "url": "https://huggingface.co/mradermacher/Qwen3-1.7B-abliterated-GGUF/resolve/main/Qwen3-1.7B-abliterated.Q4_K_M.gguf",
        "sizeBytes": 1107409024,
        "sha256": "6fb5977ef935e2a54c0bd5ec45e841d5ba4256b2223c25b4f707553abac8f448"
      },
      {
        "quant": "Q5_K_M",
        "name": "Qwen3-1.7B-abliterated.Q5_K_M.gguf",
        "url": "https://huggingface.co/mradermacher/Qwen3-1.7B-abliterated-GGUF/resolve/main/Qwen3-1.7B-abliterated.Q5_K_M.gguf",
        "sizeBytes": 1257879680,
        "sha256": "0997547ff78893ecd8311a8a91883c31cad59331238764f485f67cc6a5ec8ce5"
      },
      {
        "quant": "Q6_K",
        "name": "Qwen3-1.7B-abliterated.Q6_K.gguf",
        "url": "https://huggingface.co/mradermacher/Qwen3-1.7B-abliterated-GGUF/resolve/main/Qwen3-1.7B-abliterated.Q6_K.gguf",
        "sizeBytes": 1417754752,
        "sha256": "b6681fb38d1a2691ffaa9aec9b8704fd2038f5bab463594963105165e6639f76"
      },
      {
        "quant": "Q8_0",
        "name": "Qwen3-1.7B-abliterated.Q8_0.gguf",
        "url": "https://huggingface.co/mradermacher/Qwen3-1.7B-abliterated-GGUF/resolve/main/Qwen3-1.7B-abliterated.Q8_0.gguf",
        "sizeBytes": 1834426496,
        "sha256": "e75ff8310f03905a255b114e1c5d9225a40bc3021def4d4055b220e903b3019f"
      }
    ]
  },
  {
    "id": "huihui-qwen3.5-0.8b-abliterated",
    "ollamaName": "litemind-huihui-qwen3.5-0.8b-abliterated",
    "displayName": "Huihui Qwen3.5 0.8B Abliterated",
    "category": "uncensored-chat",
    "restrictions": "reduced",
    "uncensored": true,
    "uncensoredLabel": "Abliterated",
    "tags": [
      "chat",
      "uncensored",
      "tiny"
    ],
    "languages": [
      "ru",
      "en",
      "multi"
    ],
    "params": "0.8B",
    "family": "huihui-qwen3.5",
    "purpose": "Ослабленная версия Qwen3.5 0.8B от Huihui-ai: минимальные требования, свободный стиль, русский от семейства Qwen.",
    "quality": "Сверхлёгкая: мгновенный отклик на N5095A. Интеллект скромный — простые вопросы и черновики.",
    "speed": "fast",
    "license": "apache-2.0",
    "licenseNote": null,
    "source": "https://huggingface.co/mradermacher/Huihui-Qwen3.5-0.8B-abliterated-GGUF",
    "repo": "mradermacher/Huihui-Qwen3.5-0.8B-abliterated-GGUF",
    "quantAuthor": "mradermacher (кванты; модель — huihui-ai)",
    "contextTokens": 32768,
    "tools": false,
    "vision": false,
    "notes": "В репозитории есть mmproj (зрение) — LiteMind скачивает только текстовую GGUF.",
    "developer": "Qwen Team (Alibaba) · дообучение Huihui-ai",
    "purposes": [
      "chat",
      "writing",
      "creative",
      "multilingual",
      "translation",
      "long-context"
    ],
    "verifiedAt": "2026-11-10",
    "files": [
      {
        "quant": "Q4_K_M",
        "name": "Huihui-Qwen3.5-0.8B-abliterated.Q4_K_M.gguf",
        "url": "https://huggingface.co/mradermacher/Huihui-Qwen3.5-0.8B-abliterated-GGUF/resolve/main/Huihui-Qwen3.5-0.8B-abliterated.Q4_K_M.gguf",
        "sizeBytes": 527503840,
        "sha256": "411e0f945a5d57c63f33bcb5bfa4d5c2711d1ce28cb7635201ac0c311a7dfdf0"
      },
      {
        "quant": "Q5_K_M",
        "name": "Huihui-Qwen3.5-0.8B-abliterated.Q5_K_M.gguf",
        "url": "https://huggingface.co/mradermacher/Huihui-Qwen3.5-0.8B-abliterated-GGUF/resolve/main/Huihui-Qwen3.5-0.8B-abliterated.Q5_K_M.gguf",
        "sizeBytes": 584823264,
        "sha256": "f20fe2718de7d7414ae4121b35a5943c8e3cdd0af6355025d0fe0f24b2a1db38"
      },
      {
        "quant": "Q6_K",
        "name": "Huihui-Qwen3.5-0.8B-abliterated.Q6_K.gguf",
        "url": "https://huggingface.co/mradermacher/Huihui-Qwen3.5-0.8B-abliterated-GGUF/resolve/main/Huihui-Qwen3.5-0.8B-abliterated.Q6_K.gguf",
        "sizeBytes": 629744608,
        "sha256": "631e126473dcd1452145cb4c203f873b3c3b3eb02e10f198fc1e2471ff225693"
      },
      {
        "quant": "Q8_0",
        "name": "Huihui-Qwen3.5-0.8B-abliterated.Q8_0.gguf",
        "url": "https://huggingface.co/mradermacher/Huihui-Qwen3.5-0.8B-abliterated-GGUF/resolve/main/Huihui-Qwen3.5-0.8B-abliterated.Q8_0.gguf",
        "sizeBytes": 811844064,
        "sha256": "54e2a3903cbd0ff264b770f29ac59c1fc547d2865db2b42e4e3ef36700767946"
      }
    ]
  },
  {
    "id": "huihui-qwen3.5-2b-abliterated",
    "ollamaName": "litemind-huihui-qwen3.5-2b-abliterated",
    "displayName": "Huihui Qwen3.5 2B Abliterated",
    "category": "uncensored-chat",
    "restrictions": "reduced",
    "uncensored": true,
    "uncensoredLabel": "Abliterated",
    "tags": [
      "chat",
      "uncensored",
      "small"
    ],
    "languages": [
      "ru",
      "en",
      "multi"
    ],
    "params": "2B",
    "family": "huihui-qwen3.5",
    "purpose": "Средний размер линейки Huihui Qwen3.5: свободный стиль ответов, приемлемая скорость на слабом CPU.",
    "quality": "Баланс ума и скорости в линейке Qwen3.5; в Q4_K_M занимает ~1,2 ГБ и ~2 ГБ RAM с контекстом.",
    "speed": "medium",
    "license": "apache-2.0",
    "licenseNote": null,
    "source": "https://huggingface.co/mradermacher/Huihui-Qwen3.5-2B-abliterated-GGUF",
    "repo": "mradermacher/Huihui-Qwen3.5-2B-abliterated-GGUF",
    "quantAuthor": "mradermacher (кванты; модель — huihui-ai)",
    "contextTokens": 32768,
    "tools": false,
    "vision": false,
    "notes": null,
    "developer": "Qwen Team (Alibaba) · дообучение Huihui-ai",
    "purposes": [
      "chat",
      "writing",
      "creative",
      "multilingual",
      "translation",
      "long-context"
    ],
    "verifiedAt": "2026-11-10",
    "files": [
      {
        "quant": "Q4_K_M",
        "name": "Huihui-Qwen3.5-2B-abliterated.Q4_K_M.gguf",
        "url": "https://huggingface.co/mradermacher/Huihui-Qwen3.5-2B-abliterated-GGUF/resolve/main/Huihui-Qwen3.5-2B-abliterated.Q4_K_M.gguf",
        "sizeBytes": 1270809024,
        "sha256": "aa25eea787afe56a097268f7ed3460cb623e1901d2e89cd2b654cabb42f80636"
      },
      {
        "quant": "Q5_K_M",
        "name": "Huihui-Qwen3.5-2B-abliterated.Q5_K_M.gguf",
        "url": "https://huggingface.co/mradermacher/Huihui-Qwen3.5-2B-abliterated-GGUF/resolve/main/Huihui-Qwen3.5-2B-abliterated.Q5_K_M.gguf",
        "sizeBytes": 1424769472,
        "sha256": "f6b5287dcce25d3ac331e1f13ad295c31b4c339dfa70dc2bf6852bcf9d776944"
      },
      {
        "quant": "Q6_K",
        "name": "Huihui-Qwen3.5-2B-abliterated.Q6_K.gguf",
        "url": "https://huggingface.co/mradermacher/Huihui-Qwen3.5-2B-abliterated-GGUF/resolve/main/Huihui-Qwen3.5-2B-abliterated.Q6_K.gguf",
        "sizeBytes": 1556391360,
        "sha256": "7774b240ec1e14990baa58ca844019778d130953b6db8c905b6b230961e3d96c"
      },
      {
        "quant": "Q8_0",
        "name": "Huihui-Qwen3.5-2B-abliterated.Q8_0.gguf",
        "url": "https://huggingface.co/mradermacher/Huihui-Qwen3.5-2B-abliterated-GGUF/resolve/main/Huihui-Qwen3.5-2B-abliterated.Q8_0.gguf",
        "sizeBytes": 2012012992,
        "sha256": "fb724dfeb9c268e4752b944d35213e959b525cab39db021cc2bdf439901d4deb"
      }
    ]
  },
  {
    "id": "huihui-qwen3.5-4b-abliterated",
    "ollamaName": "litemind-huihui-qwen3.5-4b-abliterated",
    "displayName": "Huihui Qwen3.5 4B Abliterated",
    "category": "uncensored-chat",
    "restrictions": "reduced",
    "uncensored": true,
    "uncensoredLabel": "Abliterated",
    "tags": [
      "chat",
      "uncensored",
      "small"
    ],
    "languages": [
      "ru",
      "en",
      "multi"
    ],
    "params": "4B",
    "family": "huihui-qwen3.5",
    "purpose": "Старшая компактная abliterated-модель Qwen3.5 от Huihui-ai: свободный стиль при заметном уме для своего размера.",
    "quality": "Один из лучших вариантов «свободного общения» для 16 ГБ RAM: ум на уровне 4B, скорость средняя.",
    "speed": "medium",
    "license": "apache-2.0",
    "licenseNote": null,
    "source": "https://huggingface.co/mradermacher/Huihui-Qwen3.5-4B-abliterated-GGUF",
    "repo": "mradermacher/Huihui-Qwen3.5-4B-abliterated-GGUF",
    "quantAuthor": "mradermacher (кванты; модель — huihui-ai)",
    "contextTokens": 32768,
    "tools": false,
    "vision": false,
    "notes": null,
    "developer": "Qwen Team (Alibaba) · дообучение Huihui-ai",
    "purposes": [
      "chat",
      "writing",
      "creative",
      "multilingual",
      "translation",
      "long-context"
    ],
    "verifiedAt": "2026-11-10",
    "files": [
      {
        "quant": "Q4_K_M",
        "name": "Huihui-Qwen3.5-4B-abliterated.Q4_K_M.gguf",
        "url": "https://huggingface.co/mradermacher/Huihui-Qwen3.5-4B-abliterated-GGUF/resolve/main/Huihui-Qwen3.5-4B-abliterated.Q4_K_M.gguf",
        "sizeBytes": 2707514688,
        "sha256": "423f10b6ec2d99c3378143d7cd3b80eb4887b3ed92103103ac59173b404f4f7c"
      },
      {
        "quant": "Q5_K_M",
        "name": "Huihui-Qwen3.5-4B-abliterated.Q5_K_M.gguf",
        "url": "https://huggingface.co/mradermacher/Huihui-Qwen3.5-4B-abliterated-GGUF/resolve/main/Huihui-Qwen3.5-4B-abliterated.Q5_K_M.gguf",
        "sizeBytes": 3108758848,
        "sha256": "a93fe75df87619da6f28bef8faf895799a8bbda238c29bc0dbb40ae418054ad4"
      },
      {
        "quant": "Q6_K",
        "name": "Huihui-Qwen3.5-4B-abliterated.Q6_K.gguf",
        "url": "https://huggingface.co/mradermacher/Huihui-Qwen3.5-4B-abliterated-GGUF/resolve/main/Huihui-Qwen3.5-4B-abliterated.Q6_K.gguf",
        "sizeBytes": 3464056128,
        "sha256": "8deb9dcea61455b5c2ca5523e08c41c5c5d884c6180e4536dd85f6b51c37c7c6"
      },
      {
        "quant": "Q8_0",
        "name": "Huihui-Qwen3.5-4B-abliterated.Q8_0.gguf",
        "url": "https://huggingface.co/mradermacher/Huihui-Qwen3.5-4B-abliterated-GGUF/resolve/main/Huihui-Qwen3.5-4B-abliterated.Q8_0.gguf",
        "sizeBytes": 4482403648,
        "sha256": "1e78f9b48c8b69242fa45bbbbeb439ed818a71381a6362130d62a38561c3756d"
      }
    ]
  },
  {
    "id": "huihui-llama-3.2-3b-abliterated",
    "ollamaName": "litemind-huihui-llama-3.2-3b-abliterated",
    "displayName": "Huihui Llama 3.2 3B Abliterated",
    "category": "uncensored-chat",
    "restrictions": "reduced",
    "uncensored": true,
    "uncensoredLabel": "Abliterated",
    "tags": [
      "chat",
      "uncensored",
      "small"
    ],
    "languages": [
      "en",
      "multi"
    ],
    "params": "3.2B",
    "family": "huihui-llama3.2",
    "purpose": "Abliterated-версия Llama 3.2 3B от Huihui-ai: свободный стиль, английский и основные европейские языки.",
    "quality": "Крепкая 3B-модель для общения и текстов; русский слабее, чем у Qwen-семейства.",
    "speed": "medium",
    "license": "llama3.2",
    "licenseNote": null,
    "source": "https://huggingface.co/mradermacher/Llama-3.2-3B-Instruct-abliterated-GGUF",
    "repo": "mradermacher/Llama-3.2-3B-Instruct-abliterated-GGUF",
    "quantAuthor": "mradermacher (кванты; модель — huihui-ai)",
    "contextTokens": 32768,
    "tools": false,
    "vision": false,
    "notes": "Лицензия Llama 3.2 Community — используйте по условиям Meta.",
    "developer": "Meta · дообучение Huihui-ai",
    "purposes": [
      "chat",
      "writing",
      "creative",
      "multilingual",
      "translation",
      "long-context"
    ],
    "verifiedAt": "2026-11-10",
    "files": [
      {
        "quant": "Q4_K_M",
        "name": "Llama-3.2-3B-Instruct-abliterated.Q4_K_M.gguf",
        "url": "https://huggingface.co/mradermacher/Llama-3.2-3B-Instruct-abliterated-GGUF/resolve/main/Llama-3.2-3B-Instruct-abliterated.Q4_K_M.gguf",
        "sizeBytes": 2241004512,
        "sha256": "3a8ad1732ca90048bc5ecf44dcb3b789469e8a68d389ab79516853bf0d27ad34"
      },
      {
        "quant": "Q5_K_M",
        "name": "Llama-3.2-3B-Instruct-abliterated.Q5_K_M.gguf",
        "url": "https://huggingface.co/mradermacher/Llama-3.2-3B-Instruct-abliterated-GGUF/resolve/main/Llama-3.2-3B-Instruct-abliterated.Q5_K_M.gguf",
        "sizeBytes": 2593031136,
        "sha256": "76a4a06bf7a868b7e3c4f83afc224b5dc635c659282d1292e56dc3300c63a1e1"
      },
      {
        "quant": "Q6_K",
        "name": "Llama-3.2-3B-Instruct-abliterated.Q6_K.gguf",
        "url": "https://huggingface.co/mradermacher/Llama-3.2-3B-Instruct-abliterated-GGUF/resolve/main/Llama-3.2-3B-Instruct-abliterated.Q6_K.gguf",
        "sizeBytes": 2967059424,
        "sha256": "7eba702b4d42fb0c911b51c1c707d984f991786dbbb4cf6831bb4adb286eb19c"
      },
      {
        "quant": "Q8_0",
        "name": "Llama-3.2-3B-Instruct-abliterated.Q8_0.gguf",
        "url": "https://huggingface.co/mradermacher/Llama-3.2-3B-Instruct-abliterated-GGUF/resolve/main/Llama-3.2-3B-Instruct-abliterated.Q8_0.gguf",
        "sizeBytes": 3840527328,
        "sha256": "c803fb4103282db1a60a9256dbc482bb69b3033eb77ede6324cd725cd44ef04c"
      }
    ]
  },
  {
    "id": "huihui-qwen3-8b-abliterated-v2",
    "ollamaName": "litemind-huihui-qwen3-8b-abliterated-v2",
    "displayName": "Huihui Qwen3 8B Abliterated v2",
    "category": "uncensored-chat",
    "restrictions": "reduced",
    "uncensored": true,
    "uncensoredLabel": "Abliterated",
    "tags": [
      "chat",
      "uncensored",
      "mid"
    ],
    "languages": [
      "ru",
      "en",
      "multi"
    ],
    "params": "8B",
    "family": "huihui-qwen3",
    "purpose": "Старшая abliterated-модель Huihui в каталоге: максимум свободы и ума, но тяжёлая для слабого CPU.",
    "quality": "Заметно умнее 4B, однако на CPU без AVX скорость — единицы токенов в секунду. Каталог честно пометит «не рекомендуется».",
    "speed": "slow",
    "license": "apache-2.0",
    "licenseNote": null,
    "source": "https://huggingface.co/mradermacher/Huihui-Qwen3-8B-abliterated-v2-GGUF",
    "repo": "mradermacher/Huihui-Qwen3-8B-abliterated-v2-GGUF",
    "quantAuthor": "mradermacher (кванты; модель — huihui-ai)",
    "contextTokens": 32768,
    "tools": false,
    "vision": false,
    "notes": "Для этой модели желательна дискретная видеокарта; на N5095A запуск возможен, но медленный.",
    "developer": "Qwen Team (Alibaba) · дообучение Huihui-ai",
    "purposes": [
      "chat",
      "writing",
      "creative",
      "analysis",
      "multilingual",
      "translation",
      "long-context"
    ],
    "verifiedAt": "2026-11-10",
    "files": [
      {
        "quant": "Q4_K_M",
        "name": "Huihui-Qwen3-8B-abliterated-v2.Q4_K_M.gguf",
        "url": "https://huggingface.co/mradermacher/Huihui-Qwen3-8B-abliterated-v2-GGUF/resolve/main/Huihui-Qwen3-8B-abliterated-v2.Q4_K_M.gguf",
        "sizeBytes": 5027780352,
        "sha256": "0bdba3b32d450374b3c404d9ad531703db139b33798149efc84e2bce45eedbb5"
      },
      {
        "quant": "Q5_K_M",
        "name": "Huihui-Qwen3-8B-abliterated-v2.Q5_K_M.gguf",
        "url": "https://huggingface.co/mradermacher/Huihui-Qwen3-8B-abliterated-v2-GGUF/resolve/main/Huihui-Qwen3-8B-abliterated-v2.Q5_K_M.gguf",
        "sizeBytes": 5851109120,
        "sha256": "2334bb2c7c2dd76cbd48da98a095c269dbe5a449124214a6456d5768f6114159"
      },
      {
        "quant": "Q6_K",
        "name": "Huihui-Qwen3-8B-abliterated-v2.Q6_K.gguf",
        "url": "https://huggingface.co/mradermacher/Huihui-Qwen3-8B-abliterated-v2-GGUF/resolve/main/Huihui-Qwen3-8B-abliterated-v2.Q6_K.gguf",
        "sizeBytes": 6725895936,
        "sha256": "c0d17e9a0523ae14fdfab98ec8289201349113f4bfb6062597958eebb891e8bf"
      },
      {
        "quant": "Q8_0",
        "name": "Huihui-Qwen3-8B-abliterated-v2.Q8_0.gguf",
        "url": "https://huggingface.co/mradermacher/Huihui-Qwen3-8B-abliterated-v2-GGUF/resolve/main/Huihui-Qwen3-8B-abliterated-v2.Q8_0.gguf",
        "sizeBytes": 8709515008,
        "sha256": "b8769fc34d064ccb52667504931bb4ae997eab5d8a22842f18dc55eea378b9b8"
      }
    ]
  }
];

export function catalogEntry(id) {
  return CATALOG.find((m) => m.id === id) ?? null;
}
