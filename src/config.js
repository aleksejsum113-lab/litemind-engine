// LiteMind Engine — configuration.
// Zero-dependency. Config is a JSON file merged over conservative defaults.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Profiles hold the tunables that protect weak machines.
 * `low` is the default and is intentionally conservative.
 */
export const DEFAULT_PROFILES = {
  low: {
    label: 'Low Resource',
    maxConcurrentRequests: 1,
    queueLimit: 16,
    contextTokens: 2048,
    maxOutputTokens: 512,
    cpuThreads: 2,
    requestTimeoutMs: 120000,
    idleUnloadSeconds: 300,
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
    cpuThreads: 0, // 0 = backend default
    requestTimeoutMs: 180000,
    idleUnloadSeconds: 600,
    autoLoadAtStartup: false,
    allowAutoDownload: false,
    memoryReserveMb: 1024,
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
    type: 'ollama',
    baseUrl: 'http://127.0.0.1:11434',
    connectTimeoutMs: 1500,
    streamIdleTimeoutMs: 60000
  },
  profile: 'low',
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
  if (config.backend?.type !== 'ollama') errors.push(`unsupported backend.type "${config.backend?.type}" (v0.1 supports "ollama")`);
  if (!/^https?:\/\//.test(config.backend?.baseUrl || '')) errors.push('backend.baseUrl must be an http(s) URL');
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
