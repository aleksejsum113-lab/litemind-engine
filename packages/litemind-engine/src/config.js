// LiteMind Engine — configuration.
// Zero-dependency. Config is a JSON file merged over conservative defaults.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Profiles hold the tunables that protect weak machines.
 * `balanced` is the default (ТЗ Этапа 2 §8: профили реально меняют параметры
 * runtime — потоки, batch, приоритет, резерв RAM, кэш; см. resource/threads.js).
 * Значения cpuThreads/cpuThreadsBatch 0 = авто (разрешается по числу ядер:
 * N5095A 4C/4T → генерация 2/3/4 потока, prefill 2/4/4 для low/balanced/high).
 */
export const DEFAULT_PROFILES = {
  low: {
    label: 'Low Resource',
    maxConcurrentRequests: 1,
    queueLimit: 16,
    contextTokens: 2048,
    maxOutputTokens: 512,
    cpuThreads: 2,
    cpuThreadsBatch: 0,
    numBatch: 512,
    cacheReuse: 0,
    // Таймаут всего запроса: длинный ответ слабой модели (2 т/с × 512 токенов)
    // занимает ~4-6 минут — прежние 120 с обрывали легитимные ответы.
    requestTimeoutMs: 600000,
    idleUnloadSeconds: 900,
    autoLoadAtStartup: false,
    allowAutoDownload: false,
    memoryReserveMb: 2048,
    kvOverheadKbPerToken: 64,
    blockOnUnknownEstimate: false
  },
  balanced: {
    label: 'Balanced',
    maxConcurrentRequests: 2,
    queueLimit: 32,
    contextTokens: 4096,
    maxOutputTokens: 1024,
    cpuThreads: 0, // авто: N5095A → 3 (одно ядро остаётся Windows)
    cpuThreadsBatch: 0, // авто: все ядра на prefill (короткая фаза)
    numBatch: 1024,
    cacheReuse: 0,
    requestTimeoutMs: 900000,
    idleUnloadSeconds: 1800,
    autoLoadAtStartup: false,
    allowAutoDownload: false,
    memoryReserveMb: 1024,
    kvOverheadKbPerToken: 64,
    blockOnUnknownEstimate: false
  },
  // «Производительный»: максимум ресурсов для ИИ, но безопасный резерв
  // системы и строгий memory-gate сохраняются.
  high: {
    label: 'High Performance',
    maxConcurrentRequests: 2,
    queueLimit: 48,
    contextTokens: 8192,
    maxOutputTokens: 2048,
    cpuThreads: 0, // авто: все ядра модели
    cpuThreadsBatch: 0,
    numBatch: 2048,
    cacheReuse: 256, // повторное использование KV после контекстного сдвига (llama.cpp)
    requestTimeoutMs: 1800000,
    idleUnloadSeconds: 3600,
    autoLoadAtStartup: false,
    allowAutoDownload: false,
    memoryReserveMb: 768,
    kvOverheadKbPerToken: 64,
    blockOnUnknownEstimate: false
  }
};

export const DEFAULT_CONFIG = {
  api: {
    host: '127.0.0.1',
    port: 8399,
    // Never expose outside loopback unless allowLan is true AND auth is enabled.
    allowLan: false,
    auth: { enabled: false, token: null }
  },
  backend: {
    // v0.4: собственный runtime llama.cpp (llama-server) — основной, без
    // внешних сервисов. «ollama» остаётся доступным как опциональная интеграция.
    type: 'lmlama',
    // Путь к llama-server(.exe). null → поиск: env LITEMIND_LLAMA_SERVER →
    // <установка>\resources\llamacpp\ → PATH.
    serverPath: null,
    host: '127.0.0.1',
    baseUrl: 'http://127.0.0.1:11434',
    connectTimeoutMs: 1500,
    streamIdleTimeoutMs: 60000,
    // Этап 2 §3: 'auto' — mmap выключается для моделей, которые заведомо
    // помещаются в RAM (последовательное чтение грузит их быстрее холодного
    // mmap и ускоряет генерацию); большие модели остаются на mmap, чтобы
    // Windows могла вытеснять холодные страницы. true/false — явное значение.
    useMmap: 'auto',
    useMlock: false
  },
  // ТЗ §6: профиль по умолчанию — Сбалансированный.
  profile: 'balanced',
  models: {
    // Папка загрузок по умолчанию. На Windows пользователь выбирает диск
    // (ТЗ: предпочтительно E:\LiteMind\models); в песочнице/на CI — tmp.
    rootDir: process.platform === 'win32' ? 'E:\\LiteMind\\models' : path.join(os.tmpdir(), 'litemind-models'),
    // Насколько заполненным может стать диск (0..1), прежде чем загрузка отклоняется.
    minFreeFraction: 0.05,
    // Этап 1Б §8: опциональный удалённый JSON для обновления каталога без
    // обновления приложения. null = только вшитый каталог (+ локальный
    // catalog-override.json). При отсутствии интернета каталог работает
    // полностью — удалённые данные не обязательны.
    catalogUrl: null
  },
  // Лучшие измеренные настройки генерации на модель (заполняет автооптимизация).
  // Формат: { [model]: { threads, tokensPerSecond, ttftMs, measuredAt, candidates } }
  optimizations: {},
  // Adaptive Controller (ТЗ Adaptive Engine): управление контекстом и нагрузкой.
  adaptive: {
    enabled: true,
    // Уплотнение истории чата (система/первая задача/недавние — сохраняются).
    contextCompaction: true,
    // Вспомогательная модель: ВЫКЛЮЧЕНА по умолчанию. Классификация выполняется
    // эвристикой (нулевая нагрузка). Пользователь может включить вручную.
    auxEnabled: false,
    auxModel: null
  },
  resource: {
    pollIntervalMs: 2000,
    // Refuse to start a model when forecast exceeds this share of total RAM.
    maxRamUsageFraction: 0.75
  },
  diagnostics: {
    dir: null, // null -> <configDir>/logs
    level: 'info'
  }
};

export function defaultConfigPath() {
  if (process.env.LITEMIND_CONFIG) return process.env.LITEMIND_CONFIG;
  if (process.platform === 'win32') {
    const base = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(base, 'LiteMind', 'config.json');
  }
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(base, 'litemind', 'config.json');
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function cloneValue(v) {
  if (Array.isArray(v)) return v.map(cloneValue);
  if (isPlainObject(v)) {
    const out = {};
    for (const [k, val] of Object.entries(v)) out[k] = cloneValue(val);
    return out;
  }
  return v;
}

export function mergeDeep(base, override) {
  // Always deep-copy base: sharing nested references would let one config
  // mutation leak into every later-loaded config (defaults included).
  const out = cloneValue(base);
  if (!isPlainObject(override)) return out;
  for (const [k, v] of Object.entries(override)) {
    if (isPlainObject(v) && isPlainObject(out[k])) out[k] = mergeDeep(out[k], v);
    else out[k] = cloneValue(v);
  }
  return out;
}

export function validateConfig(config) {
  const errors = [];
  const port = config.api?.port;
  if (!Number.isInteger(port) || port < 1 || port > 65535) errors.push(`api.port must be 1..65535, got ${port}`);
  if (config.api?.allowLan && !config.api?.auth?.enabled) {
    errors.push('api.allowLan requires api.auth.enabled with a token (LAN exposure without auth is refused)');
  }
  if (!DEFAULT_PROFILES[config.profile]) errors.push(`profile must be one of ${Object.keys(DEFAULT_PROFILES).join(', ')}`);
  const mmap = config.backend?.useMmap;
  if (![true, false, 'auto', null, undefined].includes(mmap)) {
    errors.push(`backend.useMmap must be true, false, "auto" or null, got ${JSON.stringify(mmap)}`);
  }
  if (!['lmlama', 'ollama'].includes(config.backend?.type)) {
    errors.push(`unsupported backend.type "${config.backend?.type}" (supported: "lmlama" — собственный llama.cpp runtime, "ollama" — опциональная интеграция)`);
  }
  // baseUrl нужен только опциональному ollama-backend'у.
  if (config.backend?.type === 'ollama' && !/^https?:\/\//.test(config.backend?.baseUrl || '')) {
    errors.push('backend.baseUrl must be an http(s) URL');
  }
  if (errors.length) {
    const err = new Error(`Invalid config:\n - ${errors.join('\n - ')}`);
    err.code = 'CONFIG_INVALID';
    throw err;
  }
  return config;
}

/** Load config file (if present), merge over defaults, validate. */
export function loadConfig(configPath = defaultConfigPath()) {
  let fileConfig = {};
  let existed = false;
  try {
    const raw = fs.readFileSync(configPath, 'utf8');
    existed = true;
    fileConfig = JSON.parse(raw);
  } catch (err) {
    if (err.code !== 'ENOENT') {
      if (err instanceof SyntaxError) {
        const e = new Error(`Config file is not valid JSON: ${configPath}`);
        e.code = 'CONFIG_INVALID';
        throw e;
      }
      throw err;
    }
  }
  const config = mergeDeep(DEFAULT_CONFIG, fileConfig);
  config.profiles = mergeDeep(DEFAULT_PROFILES, fileConfig.profiles || {});
  config.paths = { configPath, existed };
  return validateConfig(config);
}

export function saveConfig(config, configPath = defaultConfigPath()) {
  const { paths, profiles, ...data } = config;
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(data, null, 2) + '\n', 'utf8');
  return configPath;
}

export function activeProfile(config) {
  return config.profiles[config.profile];
}
