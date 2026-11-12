// API Server — local OpenAI-compatible HTTP API + static dashboard.
// Bind: 127.0.0.1 by default. Non-loopback clients are refused unless
// api.allowLan is explicitly enabled AND api.auth.enabled with a token.
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CATALOG, CATEGORIES, PURPOSES, CATALOG_VERSION, catalogEntry } from '../catalog/models.js';
import * as hardware from '../diagnostics/hardware.js';
import * as compat from '../compat.js';
import { DownloadManager } from '../download/manager.js';
import { OllamaInstaller } from '../install/ollama.js';
import { optimizeModel, SLOW_TOKENS_PER_SEC } from '../optimize/optimizer.js';
import { capabilitiesFor } from '../adaptive/capabilities.js';
import * as projectIndex from '../adaptive/project-index.js';
import * as wsx from '../project/workspace.js';
import { extractText } from '../attachments/extract.js';
import { saveConfig } from '../config.js';
import { AgentManager } from '../agent/session.js';
// ТЗ v0.6.1 §2–5: Генератор изображений (stable-diffusion.cpp) — CLI-процесс,
// без сторонних портов; память проверяется тем же gate'ом, что и у LLM.
import { ImageGenManager, sanitizeParams } from '../image/generate.js';
import { ImageGallery } from '../image/gallery.js';
import { checkStartBudget, dynamicReserveMb } from '../resource/gate.js';
import { safeImageModelName } from '../image/models.js';
import { createWebContext, DEFAULT_WEB_CONFIG } from '../web/fetcher.js';
import { DiscoveryManager } from '../discovery/discovery.js';
import {
  RegisteredModels,
  StorageError,
  checkDownloadUrl,
  diskSpace,
  moveModels,
  safeGgufName,
  safeTargetDir,
  storageReport
} from '../storage/storage.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'ui', 'public');
const MAX_BODY = 1024 * 1024; // 1 МиБ — файлы проекта идут по другому лимиту (8 МиБ)
const MAX_BODY_FILE = 8 * 1024 * 1024;

/** Конфигурируемые исключения сканирования (?exclude=node_modules,tmp). */
function excludesFrom(url) {
  const raw = url.searchParams.get('exclude') ?? '';
  return raw.split(',').map((s) => s.trim()).filter(Boolean).slice(0, 32);
}

/** mtime файла или null (файл исчез). Точность NTFS ~100 нс, ext4 — нс. */
function mtimeOf(file) {
  try { return fs.statSync(file).mtimeMs; } catch { return null; }
}

/** Проверка expectedMtimeMs перед записью: 409, если файл меняли извне. */
function checkMtimeConflict(file, expected, body) {
  if (expected == null || body.force === true) return null;
  const current = mtimeOf(file);
  if (current == null) return null;
  if (Math.abs(current - Number(expected)) > 2) {
    return Object.assign(new Error('файл изменён другой программой после загрузки в редактор'), {
      status: 409, conflict: true, mtimeMs: current
    });
  }
  return null;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

export function isLoopback(address) {
  if (!address) return false;
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1' || address.startsWith('127.');
}

/**
 * Access policy (ТЗ §6): loopback clients are trusted by default; anything
 * outside loopback is refused unless allowLan is set explicitly, and then a
 * valid bearer token is mandatory. Never expose without auth.
 * @returns {{ok: boolean, status?: number, message?: string, type?: string}}
 */
export function checkAccess({ remoteAddress, allowLan = false, auth = { enabled: false, token: null }, token = null }) {
  if (isLoopback(remoteAddress)) return { ok: true };
  if (!allowLan) {
    return { ok: false, status: 403, type: 'permission_error', message: 'Access denied: only local clients (127.0.0.1) are allowed. LAN exposure requires api.allowLan plus auth.' };
  }
  if (!auth.enabled || !auth.token) {
    return { ok: false, status: 403, type: 'permission_error', message: 'LAN access is enabled but authentication is not configured.' };
  }
  if (!token || token !== auth.token) {
    return { ok: false, status: 401, type: 'authentication_error', message: 'Invalid or missing API token.' };
  }
  return { ok: true };
}

function tokenFrom(req, url) {
  const header = req.headers.authorization || '';
  if (header.startsWith('Bearer ')) return header.slice(7);
  return url.searchParams.get('token');
}

function json(res, status, data) {
  const body = JSON.stringify(data);
  // ТЗ §16: рендерер Electron (origin oc://renderer) и dev-браузер управляют
  // движком через fetch — без CORS-заголовков Chromium блокирует ответы.
  // Сервер доступен только с 127.0.0.1 (проверка checkAccess выше), поэтому
  // открытый origin безопасен; авторизация для LAN сохраняется.
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type, authorization'
  });
  res.end(body);
}

function openaiError(res, status, message, type = 'invalid_request_error', code = null) {
  json(res, status, { error: { message, type, code, param: null, line: null } });
}

/**
 * Путь лежит внутри rootDir (и не совпадает с ним)?
 * path.relative на Windows сравнивает диск/папки без учёта регистра,
 * поэтому «C:\Models\m.gguf» при rootDir «c:\models» корректно признаётся
 * внутренним — простой startsWith() здесь даёт ложные отказы.
 */
function isInsideDir(rootDir, file) {
  const rel = path.relative(rootDir, file);
  return rel !== '' && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
}

function readBody(req, maxBytes = MAX_BODY) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > maxBytes) {
        reject(Object.assign(new Error('Request body too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export function createServer({ config, engine, logger, downloads: downloadsOverride = null, onEngineStopped = null }) {
  // v0.6.1: предохранители процесса. Без них ЛЮБОЕ необработанное отклонение
  // (Node >= 15 — crash по умолчанию) или редкое событие 'error' на потоке
  // убивало весь движок: smoke в CI показывал «после приёма задачи движок
  // целиком не отвечает». Теперь сбой пишется в журнал, сервер продолжает
  // отвечать остальным запросам (не маскировка ошибки — её фиксация).
  process.on('unhandledRejection', (reason) => {
    try { logger?.error('unhandledRejection (сервер продолжает работу)', { error: String(reason?.stack || reason).slice(0, 1200) }); } catch { /* */ }
  });
  process.on('uncaughtException', (err) => {
    try { logger?.error('uncaughtException (сервер продолжает работу)', { error: String(err?.stack || err).slice(0, 1200) }); } catch { /* */ }
  });
  // --- LiteMind v0.2 services -----------------------------------------
  // DownloadManager можно передать снаружи (index.js/Desktop), чтобы полный
  // stop() хоста отменял те же загрузки, что видит API (ТЗ §16.3).
  const downloads = downloadsOverride ?? new DownloadManager({
    onEvent: (e) => logger?.info('download', { ...e })
  });
  const installer = new OllamaInstaller({ baseUrl: config.backend.baseUrl });
  const disksCandidateRoots = () => {
    const roots = process.platform === 'win32' ? ['C:\\', 'D:\\', 'E:\\', 'F:\\'] : ['/'];
    const configuredRoot = path.parse(path.resolve(config.models.rootDir)).root;
    return roots.includes(configuredRoot) ? roots : [configuredRoot, ...roots];
  };
  const installedNames = new Set();
  let installedCacheAt = 0;
  // Этап 1Б §6: реестр пользовательских GGUF (файлы вне папки моделей).
  const registeredModels = new RegisteredModels(path.join(path.dirname(config.paths.configPath), 'registered-models.json'));
  // Этап 1 §11: выполняющиеся команды терминала (для кнопки «Остановить»).
  const terminalJobs = new Map();
  let terminalJobSeq = 0;
  // ТЗ v0.6.1: AI Agent (диалоговые сессии + инструменты) и управляемый интернет.
  const webCtx = createWebContext(config);
  const agent = new AgentManager({ config, engine, logger });
  agent.setWebContext(webCtx);
  // ТЗ v0.6.1 §5: генерация изображений и LLM делят одну память — при
  // нехватке честно предлагаем выгрузить модель, а не висим/падаем.
  const imageGateVerdict = async (est) => {
    const m = engine.sampler?.latest ?? await engine.sampler?.sample?.().catch(() => null) ?? null;
    if (!m || !Number.isFinite(m.availableRamMb)) {
      return { allowed: true, severity: 'warn', reason: 'Память не измерена — запуск с предупреждением.' };
    }
    const reserve = dynamicReserveMb({
      baseReserveMb: 1024,
      availableRamMb: m.availableRamMb,
      totalRamMb: m.totalRamMb,
      hardFaultsPerSec: m.hardFaultsPerSec ?? null,
      systemCpuPercent: m.cpuPercent ?? null
    });
    const verdict = checkStartBudget({
      estimatedMb: est.estimateMb,
      availableRamMb: m.availableRamMb,
      totalRamMb: m.totalRamMb,
      reserveMb: reserve.reserveMb,
      maxRamUsageFraction: config.resource?.maxRamUsageFraction ?? 0.75
    });
    const llm = engine.backend?.runtimeInfo?.();
    if (llm?.running && !verdict.allowed) {
      verdict.reason = 'Недостаточно памяти для генерации изображения. Сейчас загружена чат-модель — нажмите «Выгрузить» в разделе «Мои модели», затем повторите.' + (verdict.reason ? ` (${verdict.reason})` : '');
    }
    return verdict;
  };
  const imageGallery = new ImageGallery(
    config.image?.galleryDir ?? path.join(path.dirname(path.resolve(config.models.rootDir)), 'images')
  );
  const imageGen = new ImageGenManager({ config, log: logger, gallery: imageGallery, gate: imageGateVerdict });

  // ТЗ v0.6.2: Model Discovery — общий загрузчик, общий compat, общая папка моделей.
  const discovery = new DiscoveryManager({ config, logger, downloads });
  discovery.schedule();
  // Убить всё дерево процессов команды: shell-обёртка (cmd.exe / sh) порождает
  // дочерние процессы, и kill() самого child оставил бы их жить и держать RAM
  // и пайпы. Windows — taskkill /T /F (как в lmlama.js для llama-server);
  // POSIX — SIGKILL всей группе (child запущен detached со своей группой).
  const killProcessTree = (child) => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    try {
      if (process.platform === 'win32') {
        if (child.pid) spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
      } else {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
      }
    } catch { try { child.kill('SIGKILL'); } catch { /* уже завершён */ } }
  };
  const refreshInstalled = async () => {
    if (Date.now() - installedCacheAt < 5000) return;
    try {
      const models = await engine.listModels({ force: false });
      for (const m of models) installedNames.add(m.id);
      installedCacheAt = Date.now();
    } catch {
      /* backend может быть выключен — каталог всё равно работает */
    }
  };

  /** Список скачанных GGUF (только верхний уровень папки моделей). */
  async function listGgufFiles(rootDir) {
    try {
      const entries = await fs.promises.readdir(rootDir, { withFileTypes: true });
      const out = [];
      for (const e of entries) {
        if (!e.isFile() || !/\.gguf$/i.test(e.name) || e.name.endsWith('.part')) continue;
        const st = await fs.promises.stat(path.join(rootDir, e.name));
        out.push({ name: e.name, path: path.join(rootDir, e.name), sizeBytes: st.size });
      }
      return out.sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      return [];
    }
  }

  const server = http.createServer(async (req, res) => {
    try {
      await route(req, res);
    } catch (err) {
      const status = err.status || 500;
      if (!res.headersSent) openaiError(res, status, err.message, 'api_error', err.code || null);
      else res.end();
      logger?.error('http error', { url: req.url, error: err.message });
    }
  });

  async function route(req, res) {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const p = url.pathname;

    // --- access control -------------------------------------------------
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET, POST, OPTIONS',
        'access-control-allow-headers': 'content-type, authorization',
        'access-control-max-age': '600'
      });
      return res.end();
    }
    const access = checkAccess({
      remoteAddress: req.socket.remoteAddress,
      allowLan: config.api.allowLan,
      auth: config.api.auth,
      token: tokenFrom(req, url)
    });
    if (!access.ok) {
      return openaiError(res, access.status, access.message, access.type);
    }

    // --- dashboard static ----------------------------------------------
    if (req.method === 'GET' && (p === '/' || p === '/index.html')) return serveFile(res, 'index.html');
    if (req.method === 'GET' && (p === '/app.js' || p === '/agent-ui.js' || p === '/discovery-ui.js' || p === '/style.css')) return serveFile(res, p.slice(1));

    // --- health / status --------------------------------------------------
    if (req.method === 'GET' && p === '/health') {
      const ok = engine.health.ok;
      return json(res, ok ? 200 : 503, {
        status: ok ? 'ok' : 'degraded',
        backend: { type: engine.backend.type, healthy: ok, version: engine.health.version, error: engine.health.error },
        queue: { active: engine.active, waiting: engine.queue.length },
        profile: engine.config.profile
      });
    }

    if (req.method === 'GET' && p === '/api/status') return json(res, 200, await engine.status());
    if (req.method === 'GET' && p === '/api/metrics') return json(res, 200, { perf: engine.perf.summary(), history: engine.sampler?.history ?? [] });
    // Этап 2 §2/§12: подробная производительность — трассы стадий, серверные тайминги,
    // фактические параметры runtime. Честные значения или null («недоступно»).
    if (req.method === 'GET' && p === '/api/perf') {
      return json(res, 200, {
        summary: engine.perf.summary(),
        stages: engine.stageSummary(),
        traces: engine._stageTraces.slice(-10).map((t) => t.toJSON()),
        requests: [...engine.requests.values()].slice(-10).reverse().map((r) => ({
          id: r.id, model: r.model, state: r.state, ttftMs: r.ttftMs,
          ttftAfterServerMs: r.ttftAfterServerMs ?? null, modelLoadMs: r.modelLoadMs ?? null,
          outputTokens: r.outputTokens, durationMs: r.durationMs ?? null, error: r.error
        })),
        runtime: engine.backend.runtimeInfo ? engine.backend.runtimeInfo() : null,
        serverTimings: engine.backend.runtimeInfo ? (engine.backend.runtimeInfo().serverTimings ?? []) : []
      });
    }

    if (req.method === 'POST' && p === '/api/profile') {
      const body = JSON.parse((await readBody(req)) || '{}');
      return json(res, 200, { profile: engine.setProfile(body.profile) });
    }

    if (req.method === 'POST' && p === '/api/unload') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const r = await engine.unload(body.model ?? null);
      return json(res, 200, r);
    }

    if (req.method === 'POST' && p === '/api/cancel') {
      const body = JSON.parse((await readBody(req)) || '{}');
      if (!body.request_id) return openaiError(res, 400, 'request_id is required', 'invalid_request_error');
      const r = engine.cancel(body.request_id);
      return json(res, 200, { request_id: body.request_id, ...r });
    }

    if (req.method === 'POST' && p === '/api/stop') return json(res, 200, engine.cancelAll());

    // --- ТЗ §16: управление запуском и полной остановкой ------------------

    if (req.method === 'GET' && p === '/api/engine/state') {
      const models = await engine.modelRuntime();
      return json(res, 200, {
        engine: engine.lifecycle.state,
        since: engine.lifecycle.since,
        models,
        backend: { type: engine.backend.type, healthy: engine.health.ok, error: engine.health.error },
        queue: { active: engine.active, waiting: engine.queue.length },
        downloads: downloads.list().filter((d) => ['downloading', 'paused'].includes(d.state)).length,
        metrics: engine.sampler?.latest ?? null
      });
    }

    if (req.method === 'POST' && p === '/api/models/stop') {
      const body = JSON.parse((await readBody(req)) || '{}');
      if (!body.model) return openaiError(res, 400, 'model is required', 'invalid_request_error');
      try {
        const before = await engine.sampler?.sample?.();
        const r = await engine.stopModel(String(body.model));
        const after = await engine.sampler?.sample?.();
        return json(res, 200, {
          ...r,
          ram: {
            availableRamMbBefore: before?.availableRamMb ?? null,
            availableRamMbAfter: after?.availableRamMb ?? null,
            freedMb: before?.availableRamMb != null && after?.availableRamMb != null ? after.availableRamMb - before.availableRamMb : null
          }
        });
      } catch (err) {
        return openaiError(res, err.status || 500, err.message, 'api_error', err.code || null);
      }
    }

    if (req.method === 'POST' && p === '/api/models/stop-all') {
      try {
        const before = await engine.sampler?.sample?.();
        const r = await engine.stopAllModels();
        const after = await engine.sampler?.sample?.();
        return json(res, 200, {
          ...r,
          ram: {
            availableRamMbBefore: before?.availableRamMb ?? null,
            availableRamMbAfter: after?.availableRamMb ?? null,
            freedMb: before?.availableRamMb != null && after?.availableRamMb != null ? after.availableRamMb - before.availableRamMb : null
          }
        });
      } catch (err) {
        return openaiError(res, err.status || 500, err.message, 'api_error', err.code || null);
      }
    }

    if (req.method === 'POST' && p === '/api/engine/stop') {
      if (engine.lifecycle.state !== 'running') {
        return json(res, 200, { stopping: true, engine: engine.lifecycle.state });
      }
      const before = await engine.sampler?.sample?.();
      json(res, 200, { stopping: true, engine: 'stopping', modelsBeingUnloaded: true });
      // Отвечаем сразу, затем корректно завершаем всё принадлежащее движку:
      // генерации → загрузки → выгрузка моделей из RAM/VRAM → закрытие сервера.
      setTimeout(async () => {
        try {
          engine.beginStop();
          await downloads.cancelAll();
          await engine.stopAllModels();
          await imageGen.shutdown(); // v0.6.1: корректное завершение генерации изображений
        } catch (err) {
          logger?.error('engine stop sequence failed', { error: err.message });
        }
        const after = await engine.sampler?.sample?.().catch(() => null);
        logger?.info('engine fully stopped via API', {
          freedRamMb: before?.availableRamMb != null && after?.availableRamMb != null ? after.availableRamMb - before.availableRamMb : null
        });
        await engine.shutdownFull();
        // Дать клиентам прочитать ответы (HTTP keep-alive) до принудительного разрыва,
        // затем закрыть всё — не оставляя ни одного открытого сокета.
        server.close();
        server.closeIdleConnections?.();
        setTimeout(() => server.closeAllConnections?.(), 300);
        onEngineStopped?.();
      }, 30);
      return;
    }

    if (req.method === 'GET' && p === '/api/optimize') {
      return json(res, 200, {
        optimizations: config.optimizations ?? {},
        slowTokensPerSec: SLOW_TOKENS_PER_SEC,
        activeProfile: config.profile
      });
    }
    if (req.method === 'POST' && p === '/api/optimize') {
      const body = JSON.parse((await readBody(req)) || '{}');
      if (!body.model || typeof body.model !== 'string') {
        return openaiError(res, 400, 'model is required', 'invalid_request_error');
      }
      if (!(await engine.ensureHealthy())) {
        return openaiError(res, 503, engine.health.error || 'Backend is not reachable.', 'api_error', 'BACKEND_UNAVAILABLE');
      }
      try {
        const report = await optimizeModel({
          engine,
          model: body.model,
          onProgress: (s) => logger?.info('optimize', { model: body.model, ...s })
        });
        return json(res, 200, report);
      } catch (err) {
        return openaiError(res, err.status || 500, err.message, 'optimize_error', err.code || null);
      }
    }

    // --- Adaptive Controller: настройки и статистика ----------------------
    if (req.method === 'GET' && p === '/api/adaptive') {
      return json(res, 200, {
        config: config.adaptive ?? {},
        stats: engine.adaptiveStats ?? null,
        optimizations: config.optimizations ?? {},
        activeProfile: config.profile
      });
    }
    if (req.method === 'POST' && p === '/api/adaptive') {
      const body = JSON.parse((await readBody(req)) || '{}');
      config.adaptive = config.adaptive ?? {};
      if (typeof body.enabled === 'boolean') config.adaptive.enabled = body.enabled;
      if (typeof body.contextCompaction === 'boolean') config.adaptive.contextCompaction = body.contextCompaction;
      if (typeof body.auxEnabled === 'boolean') config.adaptive.auxEnabled = body.auxEnabled;
      if ('auxModel' in body) config.adaptive.auxModel = body.auxModel ? String(body.auxModel) : null;
      saveConfig(config, config.paths.configPath);
      logger?.info('adaptive settings saved', { adaptive: config.adaptive });
      return json(res, 200, { ok: true, config: config.adaptive });
    }

    // --- Project Context (индексация и поиск по проекту) ------------------
    if (req.method === 'POST' && p === '/api/project/scan') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const dir = body.path ? path.resolve(body.path) : null;
      if (!dir) return openaiError(res, 400, 'path is required', 'invalid_request_error');
      if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
        return openaiError(res, 404, `Каталог не найден: ${dir}`, 'invalid_request_error');
      }
      const summary = await projectIndex.scanProject(dir, { force: body.force === true });
      return json(res, 200, summary);
    }
    if (req.method === 'GET' && p === '/api/project/search') {
      const dir = url.searchParams.get('path');
      const q = url.searchParams.get('q');
      if (!dir || !q) return openaiError(res, 400, 'path and q are required', 'invalid_request_error');
      try {
        const result = await projectIndex.searchProject(dir, q, { limit: Number(url.searchParams.get('limit')) || 5 });
        return json(res, 200, result);
      } catch (err) {
        return openaiError(res, 500, err.message, 'api_error', 'PROJECT_SEARCH_FAILED');
      }
    }
    if (req.method === 'GET' && p === '/api/project/map') {
      const dir = url.searchParams.get('path');
      if (!dir) return openaiError(res, 400, 'path is required', 'invalid_request_error');
      return json(res, 200, projectIndex.projectMap(dir) ?? { error: 'проект не просканирован' });
    }

    // --- Projects: открытие/создание папки (Этап 1В §2) --------------------
    // Честная проверка доступности: «недоступная папка» не становится
    // активным проектом. Создание = mkdir -p; существующий каталог не ошибка.
    if (req.method === 'POST' && p === '/api/project/open') {
      const body = JSON.parse((await readBody(req)) || '{}');
      if (!body.path) return openaiError(res, 400, 'path is required', 'invalid_request_error');
      const r = await wsx.openProject(body.path);
      return json(res, r.ok ? 200 : 404, r);
    }
    if (req.method === 'POST' && p === '/api/project/create') {
      const body = JSON.parse((await readBody(req)) || '{}');
      if (!body.path) return openaiError(res, 400, 'path is required', 'invalid_request_error');
      const r = await wsx.createProject(body.path);
      return json(res, r.ok ? 200 : 400, r);
    }

    // --- Workspace: ленивое дерево файлов (Этап 1В §2) ---------------------
    // Один уровень каталога за запрос — огромные проекты не грузятся в память.
    if (req.method === 'GET' && p === '/api/project/tree') {
      const dir = url.searchParams.get('path');
      const rel = url.searchParams.get('dir') ?? '';
      if (!dir) return openaiError(res, 400, 'path is required', 'invalid_request_error');
      if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
        return openaiError(res, 404, `Каталог не найден: ${dir}`, 'invalid_request_error');
      }
      try {
        const t = await wsx.listTree(dir, rel, { exclude: excludesFrom(url), limit: Number(url.searchParams.get('limit')) || undefined });
        return json(res, 200, t);
      } catch (err) {
        return openaiError(res, err.status || 500, err.message, 'invalid_request_error', 'TREE_FAILED');
      }
    }

    // Поиск файлов по имени.
    if (req.method === 'GET' && p === '/api/project/find') {
      const dir = url.searchParams.get('path');
      const q = url.searchParams.get('q');
      if (!dir || !q) return openaiError(res, 400, 'path and q are required', 'invalid_request_error');
      if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
        return openaiError(res, 404, `Каталог не найден: ${dir}`, 'invalid_request_error');
      }
      const r = await wsx.findFiles(dir, q, { exclude: excludesFrom(url), limit: Math.min(Number(url.searchParams.get('limit')) || 100, 200) });
      return json(res, 200, r);
    }

    // Поиск текста внутри файлов: файл, строка, колонка, номер строки.
    if (req.method === 'GET' && p === '/api/project/grep') {
      const dir = url.searchParams.get('path');
      const q = url.searchParams.get('q');
      if (!dir || !q) return openaiError(res, 400, 'path and q are required', 'invalid_request_error');
      if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
        return openaiError(res, 404, `Каталог не найден: ${dir}`, 'invalid_request_error');
      }
      try {
        const r = await wsx.grepFiles(dir, q, {
          exclude: excludesFrom(url),
          limit: Math.min(Number(url.searchParams.get('limit')) || 60, 200),
          caseSensitive: url.searchParams.get('case') === '1'
        });
        return json(res, 200, r);
      } catch (err) {
        return openaiError(res, err.status || 500, err.message, 'api_error', 'GREP_FAILED');
      }
    }

    // Контекст проекта для чата: только явно выбранные пользователем файлы.
    if (req.method === 'POST' && p === '/api/project/context') {
      const body = JSON.parse((await readBody(req, MAX_BODY_FILE)) || '{}');
      const dir = body.path ? path.resolve(body.path) : null;
      if (!dir) return openaiError(res, 400, 'path is required', 'invalid_request_error');
      if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
        return openaiError(res, 404, `Каталог не найден: ${dir}`, 'invalid_request_error');
      }
      const r = await wsx.buildContext(dir, body.files ?? [], {
        perFileChars: Math.min(Number(body.perFileChars) || undefined, 500_000) || undefined,
        totalChars: Math.min(Number(body.totalChars) || undefined, 2_000_000) || undefined
      });
      return json(res, 200, r);
    }

    // --- Изменения файлов через ИИ: бэкап → применить → восстановить -------
    // Ничего не перезаписывается без явного подтверждения пользователя в UI:
    // это API подготовки и применения, а не автономный агент.
    if (req.method === 'GET' && p === '/api/project/backups') {
      const dir = url.searchParams.get('path');
      const rel = url.searchParams.get('file');
      if (!dir || !rel) return openaiError(res, 400, 'path and file are required', 'invalid_request_error');
      try {
        const list = await wsx.listBackups(dir, rel, { configPath: config.paths.configPath });
        return json(res, 200, { file: rel, backups: list });
      } catch (err) {
        return openaiError(res, err.status || 500, err.message, 'invalid_request_error', 'BACKUPS_FAILED');
      }
    }
    if (req.method === 'POST' && p === '/api/project/apply-change') {
      const body = JSON.parse((await readBody(req, MAX_BODY_FILE)) || '{}');
      const dir = body.path ? path.resolve(body.path) : null;
      const rel = typeof body.file === 'string' ? body.file : null;
      if (!dir || !rel) return openaiError(res, 400, 'path and file are required', 'invalid_request_error');
      if (typeof body.content !== 'string') return openaiError(res, 400, 'content must be a string', 'invalid_request_error');
      if (Buffer.byteLength(body.content, 'utf8') > 2 * 1024 * 1024) {
        return openaiError(res, 413, 'файл больше 2 МиБ', 'invalid_request_error');
      }
      if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
        return openaiError(res, 404, `Каталог не найден: ${dir}`, 'invalid_request_error');
      }
      try {
        const root = path.resolve(dir);
        const { file } = wsx.safeRelPath(root, rel);
        if (!fs.existsSync(file)) {
          return openaiError(res, 404, `Файл не найден: ${rel}`, 'invalid_request_error');
        }
        const conflict = checkMtimeConflict(file, body.expectedMtimeMs, body);
        if (conflict) {
          return json(res, 409, {
            error: { message: conflict.message + ' — сначала посмотрите текущее содержимое', type: 'conflict_error', code: 'FILE_CHANGED_EXTERNALLY', param: null, line: null },
            conflict: true, mtimeMs: conflict.mtimeMs
          });
        }
        // 1) Резервная копия текущего содержимого (вне проекта).
        const backup = await wsx.makeBackup(root, rel, { configPath: config.paths.configPath });
        // 2) Запись нового содержимого.
        fs.writeFileSync(file, body.content, 'utf8');
        const st = fs.statSync(file);
        logger?.warn('ai file change applied', { file: rel, backup: backup.backupId });
        return json(res, 200, {
          applied: true, file: path.relative(root, file),
          sizeBytes: st.size, mtimeMs: st.mtimeMs,
          backupId: backup.backupId, backupPath: backup.backupPath
        });
      } catch (err) {
        return openaiError(res, err.status || 500, err.message, 'invalid_request_error', 'APPLY_FAILED');
      }
    }
    if (req.method === 'POST' && p === '/api/project/restore-backup') {
      const body = JSON.parse((await readBody(req, MAX_BODY_FILE)) || '{}');
      const dir = body.path ? path.resolve(body.path) : null;
      if (!dir || !body.backupId) return openaiError(res, 400, 'path and backupId are required', 'invalid_request_error');
      if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
        return openaiError(res, 404, `Каталог не найден: ${dir}`, 'invalid_request_error');
      }
      try {
        const root = path.resolve(dir);
        const b = await wsx.readBackup(root, body.backupId, { configPath: config.paths.configPath });
        const target = path.resolve(root, b.rel);
        if (!fs.existsSync(target)) {
          return openaiError(res, 404, `Файл исчез: ${b.rel}`, 'invalid_request_error');
        }
        // Перед восстановлением сохраняем и текущее содержимое — откат тоже обратим.
        const safety = await wsx.makeBackup(root, b.rel, { configPath: config.paths.configPath });
        const conflict = checkMtimeConflict(target, body.expectedMtimeMs, body);
        if (conflict && body.force !== true) {
          return json(res, 409, {
            error: { message: conflict.message, type: 'conflict_error', code: 'FILE_CHANGED_EXTERNALLY', param: null, line: null },
            conflict: true, mtimeMs: conflict.mtimeMs, safetyBackupId: safety.backupId
          });
        }
        fs.writeFileSync(target, b.content, 'utf8');
        const st = fs.statSync(target);
        logger?.warn('ai file change restored from backup', { file: b.rel, backup: body.backupId });
        return json(res, 200, {
          restored: true, file: b.rel, sizeBytes: st.size, mtimeMs: st.mtimeMs,
          restoredFrom: body.backupId, safetyBackupId: safety.backupId
        });
      } catch (err) {
        return openaiError(res, err.status || 500, err.message, 'invalid_request_error', 'RESTORE_FAILED');
      }
    }

    // --- Workspace: чтение и сохранение файлов проекта (ТЗ §4/§7) ---------
    // Чтение ограничено 2 МиБ и текстовыми файлами; запись требует, чтобы
    // файл уже существовал (создание файлов — через инструменты проекта).
    // Этап 1В: вместе с содержимым отдаётся mtimeMs, а запись умеет проверять
    // expectedMtimeMs — защита от затирания изменений, сделанных другой
    // программой (409 conflict), с явной опцией force.
    if (req.method === 'GET' && p === '/api/project/file') {
      const dir = url.searchParams.get('path');
      const rel = url.searchParams.get('file');
      if (!dir || !rel) return openaiError(res, 400, 'path and file are required', 'invalid_request_error');
      const root = path.resolve(dir);
      const file = path.resolve(root, rel);
      if (!file.startsWith(root + path.sep) && file !== root) {
        return openaiError(res, 400, 'файл вне каталога проекта', 'invalid_request_error');
      }
      if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
        return openaiError(res, 404, `Файл не найден: ${rel}`, 'invalid_request_error');
      }
      const stat = fs.statSync(file);
      if (stat.size > 2 * 1024 * 1024) {
        return openaiError(res, 413, 'файл больше 2 МиБ — откройте во внешнем редакторе', 'invalid_request_error');
      }
      const buf = fs.readFileSync(file);
      // Бинарный файл? Проверяем наличие нулевого байта в первых 8 КиБ.
      const head = buf.subarray(0, 8192);
      if (head.includes(0)) {
        return openaiError(res, 415, 'бинарный файл не отображается в Workspace', 'invalid_request_error');
      }
      return json(res, 200, {
        file: path.relative(root, file),
        sizeBytes: stat.size,
        mtimeMs: stat.mtimeMs,
        content: buf.toString('utf8')
      });
    }

    if (req.method === 'POST' && p === '/api/project/file') {
      const body = JSON.parse((await readBody(req, MAX_BODY_FILE)) || '{}');
      const dir = body.path ? path.resolve(body.path) : null;
      const rel = typeof body.file === 'string' ? body.file : null;
      if (!dir || !rel) return openaiError(res, 400, 'path and file are required', 'invalid_request_error');
      const root = path.resolve(dir);
      const file = path.resolve(root, rel);
      if (!file.startsWith(root + path.sep) && file !== root) {
        return openaiError(res, 400, 'файл вне каталога проекта', 'invalid_request_error');
      }
      if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
        return openaiError(res, 404, `Файл не найден: ${rel} (создание новых файлов не поддерживается)`, 'invalid_request_error');
      }
      if (typeof body.content !== 'string') return openaiError(res, 400, 'content must be a string', 'invalid_request_error');
      if (Buffer.byteLength(body.content, 'utf8') > 2 * 1024 * 1024) {
        return openaiError(res, 413, 'файл больше 2 МиБ', 'invalid_request_error');
      }
      const conflict = checkMtimeConflict(file, body.expectedMtimeMs, body);
      if (conflict) {
        return json(res, 409, {
          error: { message: conflict.message, type: 'conflict_error', code: 'FILE_CHANGED_EXTERNALLY', param: null, line: null },
          conflict: true, mtimeMs: conflict.mtimeMs
        });
      }
      fs.writeFileSync(file, body.content, 'utf8');
      const st = fs.statSync(file);
      logger?.info('workspace file saved', { file: path.relative(root, file) });
      return json(res, 200, { saved: true, file: path.relative(root, file), sizeBytes: st.size, mtimeMs: st.mtimeMs });
    }

    // --- AI Terminal: выполнение команд в проекте (ТЗ §4) ------------------
    // Реальный запуск через shell с таймаутом и ограничением вывода.
    // Работает только в каталоге проекта (cwd), выходные данные обрезаются.
    // Этап 1: spawn вместо exec — команда получает jobId, «Остановить»
    // (/api/terminal/stop) и таймаут убивают всё дерево процессов, а не только
    // shell-обёртку; вывод собирается с лимитом 2 МБ без буферизации всего.
    if (req.method === 'POST' && p === '/api/terminal/exec') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const cwd = body.cwd ? path.resolve(body.cwd) : null;
      const command = typeof body.command === 'string' ? body.command : '';
      if (!cwd || !command.trim()) return openaiError(res, 400, 'cwd and command are required', 'invalid_request_error');
      if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
        return openaiError(res, 404, `Каталог не найден: ${cwd}`, 'invalid_request_error');
      }
      if (command.length > 4000) return openaiError(res, 400, 'команда слишком длинная', 'invalid_request_error');
      const timeoutMs = Math.min(Number(body.timeoutMs) || 30000, 120000);
      const started = Date.now();
      // jobId может задать клиент ДО запуска (иначе UI не знал бы, что
      // останавливать: ответ приходит только по завершении команды).
      // Столкновение id — старая команда убивается, её место занимает новая.
      const jobId = typeof body.jobId === 'string' && /^[\w-]{1,64}$/.test(body.jobId)
        ? body.jobId
        : `t${Date.now().toString(36)}${(terminalJobSeq++).toString(36)}`;
      const previous = terminalJobs.get(jobId);
      if (previous) { try { (previous.kill ?? (() => killProcessTree(previous.child)))(); } catch { /* завершится сам */ } }

      // --- Этап 1В: потоковый режим (SSE) — вывод живой, а не после выхода ---
      if (body.stream === true) {
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-store',
          connection: 'keep-alive',
          'access-control-allow-origin': '*',
          'x-accel-buffering': 'no'
        });
        const send = (event, data) => {
          if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        };
        const finishSse = (payload) => {
          send('exit', payload);
          res.end();
        };
        const result = await new Promise((resolve) => {
          const child = spawn(command, { cwd, shell: true, windowsHide: true, detached: process.platform !== 'win32' });
          const cap = 2 * 1024 * 1024;
          const out = [];
          const errOut = [];
          let outN = 0;
          let errN = 0;
          let truncated = false;
          let timedOut = false;
          let stoppedByUser = false;
          let spawnError = null;
          let settled = false;
          let graceTimer = null;
          // Живой вывод: кодировка определяется по первому куску (§4):
          // строгий UTF-8 → CP866 → windows-1251. Финальный текст считается
          // по полному буферу — он и уходит в «Вывод в чат».
          const decOut = wsx.makeOutputDecoder();
          const decErr = wsx.makeOutputDecoder();
          send('start', { jobId, cwd, command });
          child.stdout?.on('data', (chunk) => {
            if (outN < cap) {
              const take = chunk.subarray(0, cap - outN);
              out.push(take);
              outN += take.length;
              if (take.length < chunk.length) truncated = true;
              send('stdout', { text: decOut.push(take), encoding: decOut.encoding() });
            } else truncated = true;
          });
          child.stderr?.on('data', (chunk) => {
            if (errN < cap) {
              const take = chunk.subarray(0, cap - errN);
              errOut.push(take);
              errN += take.length;
              if (take.length < chunk.length) truncated = true;
              send('stderr', { text: decErr.push(take), encoding: decErr.encoding() });
            } else truncated = true;
          });
          child.on('error', (e) => { spawnError = e.message; send('error', { message: e.message }); });
          const finish = () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            clearTimeout(graceTimer);
            terminalJobs.delete(jobId);
            resolve({
              code: child.exitCode,
              signal: child.signalCode,
              stdoutRaw: Buffer.concat(out),
              stderrRaw: Buffer.concat(errOut),
              timedOut, stoppedByUser, truncated, spawnError
            });
          };
          child.on('close', finish);
          // Убитому дереву даём 3 с на отпускание пайпов (демоны), затем
          // отдаём собранное — HTTP-ответ не зависает (§4).
          const startGrace = () => {
            if (graceTimer) return;
            graceTimer = setTimeout(() => {
              finish();
              try { child.stdout?.destroy(); child.stderr?.destroy(); } catch { /* уже закрыты */ }
            }, 3000);
          };
          const timer = setTimeout(() => { timedOut = true; killProcessTree(child); startGrace(); }, timeoutMs);
          // Клиент отвалился (закрыл окно/вкладку) — не оставляем процесс жить.
          res.on('close', () => { if (!settled) { stoppedByUser = true; killProcessTree(child); startGrace(); } });
          terminalJobs.set(jobId, {
            child,
            kill: () => { stoppedByUser = true; killProcessTree(child); startGrace(); },
            cwd,
            command: command.slice(0, 200)
          });
        });
        const durationMs = Date.now() - started;
        const outDec = wsx.decodeBuffer(result.stdoutRaw);
        const errDec = wsx.decodeBuffer(result.stderrRaw);
        if (result.timedOut) logger?.warn('terminal command timed out', { cwd, durationMs, stream: true });
        else if (result.stoppedByUser) logger?.warn('terminal command stopped by user', { cwd, durationMs, stream: true });
        else logger?.info('terminal command executed', { cwd, durationMs, exitCode: result.code ?? 0, stream: true });
        finishSse({
          jobId,
          exitCode: result.spawnError ? 1 : (result.code ?? (result.signal || result.timedOut || result.stoppedByUser ? 1 : 0)),
          timedOut: result.timedOut,
          stopped: result.stoppedByUser,
          truncated: result.truncated,
          durationMs,
          stdout: outDec.text,
          stderr: errDec.text,
          encoding: outDec.encoding,
          error: result.spawnError
            ?? (result.timedOut ? `превышен таймаут ${timeoutMs} мс — процесс принудительно завершён` : null)
        });
        return;
      }

      try {
        const result = await new Promise((resolve) => {
          // detached (POSIX): своя группа процессов — kill(-pid) убивает и
          // потомков команды. На Windows дерево добивает taskkill /T.
          const child = spawn(command, { cwd, shell: true, windowsHide: true, detached: process.platform !== 'win32' });
          const cap = 2 * 1024 * 1024;
          const out = [];
          const errOut = [];
          let outN = 0;
          let errN = 0;
          let truncated = false;
          let timedOut = false;
          let stoppedByUser = false;
          let spawnError = null;
          let settled = false;
          let graceTimer = null;
          child.stdout?.on('data', (chunk) => {
            if (outN < cap) { const take = chunk.subarray(0, cap - outN); out.push(take); outN += take.length; if (take.length < chunk.length) truncated = true; }
            else truncated = true;
          });
          child.stderr?.on('data', (chunk) => {
            if (errN < cap) { const take = chunk.subarray(0, cap - errN); errOut.push(take); errN += take.length; if (take.length < chunk.length) truncated = true; }
            else truncated = true;
          });
          child.on('error', (e) => { spawnError = e.message; });
          const finish = () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            clearTimeout(graceTimer);
            terminalJobs.delete(jobId);
            // Кодировка честная: UTF-8 или реальная кодировка консоли Windows.
            const outDec = wsx.decodeBuffer(Buffer.concat(out));
            const errDec = wsx.decodeBuffer(Buffer.concat(errOut));
            resolve({
              code: child.exitCode,
              signal: child.signalCode,
              stdout: outDec.text,
              stderr: errDec.text,
              encoding: outDec.encoding,
              timedOut, stoppedByUser, truncated, spawnError
            });
          };
          // «close» — процесс и stdio закрыты; обычный путь завершения.
          child.on('close', finish);
          // Если после убийства дерева кто-то держит пайпы (демонизировался) —
          // через 3 с отдаём то, что успели собрать, без зависшего HTTP-ответа.
          const startGrace = () => {
            if (graceTimer) return;
            graceTimer = setTimeout(() => {
              finish();
              try { child.stdout?.destroy(); child.stderr?.destroy(); } catch { /* уже закрыты */ }
            }, 3000);
          };
          const timer = setTimeout(() => { timedOut = true; killProcessTree(child); startGrace(); }, timeoutMs);
          terminalJobs.set(jobId, {
            child,
            kill: () => { stoppedByUser = true; killProcessTree(child); startGrace(); },
            cwd,
            command: command.slice(0, 200)
          });
        });
        const durationMs = Date.now() - started;
        if (result.timedOut) logger?.warn('terminal command timed out', { cwd, durationMs });
        else if (result.stoppedByUser) logger?.warn('terminal command stopped by user', { cwd, durationMs });
        else logger?.info('terminal command executed', { cwd, durationMs, exitCode: result.code ?? 0 });
        return json(res, 200, {
          jobId,
          exitCode: result.spawnError ? 1 : (result.code ?? (result.signal || result.timedOut || result.stoppedByUser ? 1 : 0)),
          timedOut: result.timedOut,
          stopped: result.stoppedByUser,
          truncated: result.truncated,
          durationMs,
          stdout: result.stdout,
          stderr: result.stderr,
          encoding: result.encoding,
          error: result.spawnError
            ?? (result.timedOut ? `превышен таймаут ${timeoutMs} мс — процесс принудительно завершён` : null)
        });
      } catch (err) {
        terminalJobs.delete(jobId);
        return openaiError(res, 500, err.message, 'api_error', 'TERMINAL_FAILED');
      }
    }

    // Остановка выполняющейся команды терминала (ТЗ Этап 1 §11).
    // Без jobId останавливается последняя запущенная — у интерфейса один
    // терминал, и это ровно та команда, которую пользователь видит на экране.
    if (req.method === 'POST' && p === '/api/terminal/stop') {
      let body;
      try { body = JSON.parse((await readBody(req)) || '{}'); } catch { body = {}; }
      const wanted = String(body.jobId || '');
      const job = wanted ? terminalJobs.get(wanted) : terminalJobs.get([...terminalJobs.keys()].at(-1));
      if (!job) return json(res, 200, { ok: false, error: 'команда уже завершена или не найдена' });
      try {
        (job.kill ?? (() => killProcessTree(job.child)))();
        logger?.warn('terminal command stopped by user', { cwd: job.cwd, command: job.command });
        return json(res, 200, { ok: true, jobId: wanted || [...terminalJobs.keys()].at(-1) });
      } catch (err) {
        return json(res, 200, { ok: false, error: err.message });
      }
    }

    // --- Карта возможностей runtime (честная) -----------------------------
    if (req.method === 'GET' && p === '/api/capabilities') {
      return json(res, 200, { runtime: engine.backend.type, capabilities: capabilitiesFor(engine.backend.type) });
    }

    // Полная остановка (ТЗ §16): выгружает модели, отменяет генерации и
    // загрузки, затем закрывает сервер. В standalone-режиме CLI завершает
    // процесс по событию 'close'.
    if (req.method === 'POST' && p === '/api/shutdown') {
      if (engine.lifecycle.state === 'running') {
        json(res, 200, { stopping: true });
        setTimeout(async () => {
          try {
            engine.beginStop();
            await downloads.cancelAll();
            await engine.stopAllModels();
            await imageGen.shutdown(); // v0.6.1: корректное завершение генерации изображений
          } catch (err) {
            logger?.error('shutdown sequence failed', { error: err.message });
          }
          await engine.shutdownFull();
          server.close();
          server.closeIdleConnections?.();
          setTimeout(() => server.closeAllConnections?.(), 300);
          onEngineStopped?.();
        }, 30);
      } else {
        json(res, 200, { stopping: true, engine: engine.lifecycle.state });
      }
      return;
    }

    // --- ТЗ v0.6.1 §2: Генератор изображений ----------------------------

    if (req.method === 'GET' && p === '/api/image/status') {
      const info = await imageGen.backendInfo();
      const st = imageGen.status();
      return json(res, 200, {
        backend: info,
        busy: st.busy,
        job: st.job,
        modelsDir: imageGen.imageModelsDir(),
        galleryDir: imageGallery.dir,
        defaults: {
          steps: config.image?.defaultSteps ?? 12,
          cfg: config.image?.defaultCfg ?? 7,
          threads: config.image?.threads ?? 0
        },
        llmRunning: Boolean(engine.backend?.runtimeInfo?.().running)
      });
    }

    if (req.method === 'GET' && p === '/api/image/models') {
      const models = await imageGen.listModels();
      return json(res, 200, { models, modelsDir: imageGen.imageModelsDir() });
    }

    if (req.method === 'POST' && p === '/api/image/generate') {
      const body = await readBody(req);
      const params = sanitizeParams(body);
      if (!params.prompt.trim()) {
        return openaiError(res, 400, 'Введите текстовое описание изображения (промпт).', 'invalid_request_error');
      }
      try {
        const st = await imageGen.generate({
          modelFile: body.modelFile ?? null,
          modelName: body.model ?? null,
          params
        });
        return json(res, 200, st);
      } catch (err) {
        return openaiError(res, err.status || 500, err.message, err.code || 'image_error', err.details ?? null);
      }
    }

    if (req.method === 'GET' && p === '/api/image/job') {
      return json(res, 200, imageGen.status());
    }

    if (req.method === 'POST' && p === '/api/image/stop') {
      return json(res, 200, await imageGen.stop());
    }

    if (req.method === 'GET' && p === '/api/image/gallery') {
      return json(res, 200, { items: await imageGallery.list(), dir: imageGallery.dir });
    }

    if (req.method === 'GET' && p === '/api/image/file') {
      let file;
      try { file = imageGallery.fileFor(url.searchParams.get('name') ?? ''); }
      catch { return openaiError(res, 400, 'Недопустимое имя файла галереи.', 'invalid_request_error'); }
      let st;
      try { st = await fs.promises.stat(file); }
      catch { return openaiError(res, 404, 'Файл не найден.', 'invalid_request_error'); }
      res.writeHead(200, { 'content-type': 'image/png', 'content-length': st.size, 'cache-control': 'no-cache' });
      fs.createReadStream(file).pipe(res);
      return;
    }

    if ((req.method === 'POST' && p === '/api/image/delete') || (req.method === 'DELETE' && p === '/api/image/item')) {
      const name = req.method === 'DELETE'
        ? url.searchParams.get('name')
        : (await readBody(req)).name;
      try {
        await imageGallery.remove(name ?? '');
        return json(res, 200, { deleted: name });
      } catch (err) {
        return openaiError(res, err.code === 'ENOENT' ? 404 : 400, `Не удалось удалить: ${err.message}`, 'invalid_request_error');
      }
    }


    // --- LiteMind v0.2: hardware, catalog, downloads, install -----------
    await refreshInstalled();

    if (req.method === 'GET' && p === '/api/hardware') {
      const hw = await hardware.analyzeHardware({ candidateRoots: disksCandidateRoots() });
      hw.ggufFiles = await listGgufFiles(config.models.rootDir);
      return json(res, 200, hw);
    }

    if (req.method === 'GET' && p === '/api/settings') {
      return json(res, 200, {
        modelsRootDir: config.models.rootDir, profile: config.profile, configPath: config.paths.configPath,
        web: { enabled: !!config.web?.enabled, allowGithub: config.web?.allowGithub !== false, hasToken: !!config.web?.githubToken },
        discovery: {
          enabled: config.discovery?.enabled !== false,
          intervalHours: config.discovery?.intervalHours ?? 24
        }
      });
    }

    if (req.method === 'POST' && p === '/api/settings') {
      const body = JSON.parse((await readBody(req)) || '{}');
      if (typeof body.modelsRootDir === 'string' && body.modelsRootDir.trim()) {
        config.models.rootDir = path.resolve(body.modelsRootDir.trim());
      }
      if (typeof body.profile === 'string') engine.setProfile(body.profile);
      // ТЗ §7: управляемый интернет — переключение только явным действием
      if (body.web && typeof body.web === 'object') {
        if (typeof body.web.enabled === 'boolean') config.web.enabled = body.web.enabled;
        if (typeof body.web.allowGithub === 'boolean') config.web.allowGithub = body.web.allowGithub;
        if (typeof body.web.githubToken === 'string') {
          const t = body.web.githubToken.trim();
          config.web.githubToken = t ? t : null; // пустая строка — убрать токен
        }
      }
      // ТЗ v0.6.2: настройки Discovery (автопроверка и её период).
      if (body.discovery && typeof body.discovery === 'object') {
        if (typeof body.discovery.enabled === 'boolean') config.discovery.enabled = body.discovery.enabled;
        if (body.discovery.intervalHours != null) {
          const n = Math.round(Number(body.discovery.intervalHours));
          if (Number.isFinite(n) && n >= 6 && n <= 168) config.discovery.intervalHours = n;
        }
        if (config.discovery.enabled) discovery.schedule();
      }
      const saved = saveConfig(config, config.paths.configPath);
      logger?.info('settings saved', { modelsRootDir: config.models.rootDir, profile: config.profile, webEnabled: !!config.web?.enabled, path: saved });
      return json(res, 200, {
        ok: true, modelsRootDir: config.models.rootDir, profile: config.profile, configPath: saved,
        web: { enabled: !!config.web?.enabled, allowGithub: config.web?.allowGithub !== false, hasToken: !!config.web?.githubToken },
        discovery: {
          enabled: config.discovery?.enabled !== false,
          intervalHours: config.discovery?.intervalHours ?? 24
        }
      });
    }

    // --- Model Discovery (ТЗ v0.6.2): новые модели из открытых источников ---
    if (req.method === 'GET' && p === '/api/discovery/status') {
      return json(res, 200, discovery.status());
    }

    if (req.method === 'POST' && p === '/api/discovery/refresh') {
      // Запуск проверки вручную: кнопка «Проверить новые модели» (§5).
      // Работает в фоне — UI опрашивает /api/discovery/status (checking).
      discovery.refresh().catch((err) => logger?.warn?.('discovery: ручная проверка упала', { error: err.message }));
      return json(res, 202, { ok: true, checking: true, status: discovery.status() });
    }

    if (req.method === 'GET' && p === '/api/discovery/models') {
      const url = new URL(req.url, 'http://x');
      const filter = (url.searchParams.get('filter') ?? 'all').trim();
      const limitRaw = Number(url.searchParams.get('limit'));
      const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(400, limitRaw) : 200;
      try {
        return json(res, 200, await discovery.list({ filter, limit }));
      } catch (err) {
        return openaiError(res, err.status || 500, err.message || 'Ошибка Discovery', 'discovery_error', err.code);
      }
    }

    if (req.method === 'GET' && p === '/api/discovery/model') {
      const url = new URL(req.url, 'http://x');
      const key = url.searchParams.get('key') ?? '';
      const d = await discovery.detail(key);
      if (!d) return openaiError(res, 404, 'Модель не найдена в каталоге Discovery.', 'not_found');
      return json(res, 200, d);
    }

    if (req.method === 'POST' && p === '/api/discovery/download') {
      const body = JSON.parse((await readBody(req)) || '{}');
      if (typeof body.key !== 'string' || !body.key) {
        return openaiError(res, 400, 'Нужен key записи Discovery.', 'invalid_request_error');
      }
      try {
        const r = await discovery.download(body.key, {
          targetDir: typeof body.targetDir === 'string' && body.targetDir.trim() ? body.targetDir.trim() : null,
          overwrite: body.overwrite === true
        });
        return json(res, r.alreadyDownloaded ? 200 : 202, r);
      } catch (err) {
        return openaiError(res, err.status || 500, err.message, 'download_error', err.code);
      }
    }

    if (req.method === 'GET' && p === '/api/catalog') {
      const hw = await hardware.analyzeHardware({ candidateRoots: disksCandidateRoots() });
      // Этап 1Б §8: базовый каталог всегда работает локально; опционально
      // дополняется оверрайдом (catalog-override.json рядом с config.json)
      // и удалённым JSON (config.models.catalogUrl) — при недоступности сети
      // приложение продолжает работать на вшитом каталоге.
      let catalog = CATALOG;
      let overrideSource = null;
      const overridePath = path.join(path.dirname(config.paths.configPath), 'catalog-override.json');
      try {
        if (fs.existsSync(overridePath)) {
          const ov = JSON.parse(fs.readFileSync(overridePath, 'utf8'));
          if (Array.isArray(ov.models)) {
            const byId = new Map(catalog.map((m) => [m.id, m]));
            for (const m of ov.models) {
              if (!m || typeof m.id !== 'string' || !Array.isArray(m.files) || !m.files.length) continue;
              // Существующие записи не удаляются и не теряют поля — только обновление/добавление.
              byId.set(m.id, { ...(byId.get(m.id) ?? {}), ...m });
            }
            catalog = [...byId.values()];
            overrideSource = 'local';
          }
        }
      } catch (err) {
        logger?.warn('catalog override ignored', { error: err.message });
      }
      if (config.models.catalogUrl) {
        try {
          const ctrl = new AbortController();
          const t = setTimeout(() => ctrl.abort(), 8000);
          const remote = await fetch(config.models.catalogUrl, { signal: ctrl.signal }).then((r) => (r.ok ? r.json() : null));
          clearTimeout(t);
          if (Array.isArray(remote?.models) && remote.models.length) {
            const byId = new Map(catalog.map((m) => [m.id, m]));
            for (const m of remote.models) {
              if (!m || typeof m.id !== 'string' || !Array.isArray(m.files) || !m.files.length) continue;
              // v0.6.1: из удалённого каталога берём только честные записи —
              // у каждого файла обязаны быть проверяемые размер и SHA-256.
              // Иначе Discovery тащит в список готовых моделей битые/фиктивные
              // файлы (случай smoke №48: 512-байтовый указатель LFS).
              const okFiles = m.files.filter((f) => f && typeof f.url === 'string' && f.url.startsWith('https://')
                && Number(f.sizeBytes) > 0 && typeof f.sha256 === 'string' && /^[0-9a-fA-F]{64}$/.test(f.sha256));
              if (!okFiles.length) continue;
              byId.set(m.id, { ...(byId.get(m.id) ?? {}), ...m, files: okFiles });
            }
            catalog = [...byId.values()];
            overrideSource = 'remote';
          }
        } catch (err) {
          logger?.info('remote catalog unavailable — using bundled', { error: err.message });
        }
      }
      return json(res, 200, {
        version: CATALOG_VERSION,
        purposes: PURPOSES,
        categories: CATEGORIES,
        modelsRootDir: config.models.rootDir,
        overrideSource,
        models: catalog.map((m) => {
          const rating = compat.rateCatalogModel(m, hw);
          const installed = installedNames.has(m.ollamaName);
          const downloaded = fs.existsSync(path.join(config.models.rootDir, rating.recommended?.name ?? ''));
          return { ...m, compatibility: rating, installed, downloaded };
        }),
        hardware: { totalRamMb: hw.totalRamMb, freeRamMb: hw.freeRamMb, cpu: hw.cpu, recommendation: hw.recommendation }
      });
    }

    if (req.method === 'GET' && p === '/api/downloads') {
      return json(res, 200, { downloads: downloads.list(), rootDir: config.models.rootDir });
    }

    if (req.method === 'POST' && p === '/api/downloads') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const model = catalogEntry(body.modelId);
      if (!model) return openaiError(res, 404, `Unknown catalog model: ${body.modelId}`, 'invalid_request_error');
      const file = model.files.find((f) => f.name === body.fileName) ?? model.files[model.files.length - 1];
      // ТЗ v0.6.1 §4: модели изображений (категория image-*) — safetensors/gguf
      // в папку моделей изображений; LLM — gguf в папку моделей.
      const isImageModel = String(model.category ?? '').startsWith('image-');
      const kind = isImageModel ? 'image' : 'llm';
      const urlCheck = checkDownloadUrl(file.url, { ext: kind === 'llm' ? 'gguf' : ['safetensors', 'gguf'] });
      if (!urlCheck.ok) return openaiError(res, 400, `Ссылка отклонена: ${urlCheck.reason}`, 'invalid_request_error', 'URL_REJECTED');
      let name;
      let targetDir;
      try {
        name = isImageModel ? safeImageModelName(file.name) : safeGgufName(file.name);
        targetDir = safeTargetDir(body.targetDir || (isImageModel ? imageGen.imageModelsDir() : config.models.rootDir));
      } catch (err) {
        return openaiError(res, 400, err.message, 'invalid_request_error', err.code);
      }
      // §5.5: не качать повторно уже существующий проверенный файл; не удалять
      // существующий файл без явного подтверждения (overwrite: true).
      const finalPath = path.join(targetDir, name);
      if (fs.existsSync(finalPath)) {
        const existingSize = fs.statSync(finalPath).size;
        if (file.sizeBytes && existingSize === file.sizeBytes) {
          return json(res, 200, { ok: true, alreadyDownloaded: true, name, targetDir, sizeBytes: existingSize, message: 'Файл уже скачан и имеет правильный размер — повторная загрузка не нужна.' });
        }
        if (!body.overwrite) {
          return openaiError(res, 409, `В папке уже есть файл «${name}» (${existingSize} байт), размер не совпадает с каталогом. Подтвердите замену — старый файл будет перезаписан.`, 'conflict', 'FILE_EXISTS');
        }
      }
      // Проверка места на диске до старта (защита от забитого диска).
      try {
        const st = fs.statfsSync(targetDir);
        if (file.sizeBytes && st.bsize * st.bfree < file.sizeBytes + config.models.minFreeFraction * (st.bsize * st.blocks)) {
          return openaiError(res, 507, 'Недостаточно места на выбранном диске (с учётом резерва 5%). Выберите другой диск.', 'insufficient_storage', 'NO_DISK_SPACE');
        }
      } catch {
        /* каталог ещё не создан — mkdir сделает менеджер; проверка free места невозможна */
      }
      const job = await downloads.start({ id: model.id, url: file.url, name, targetDir, sizeBytes: file.sizeBytes, sha256: file.sha256 ?? null, kind });
      return json(res, 202, job);
    }

    {
      const m = /^\/api\/downloads\/([^/]+)\/(pause|resume|cancel)$/.exec(p);
      if (m && req.method === 'POST') {
        const [, id, action] = m;
        if (action === 'pause') return json(res, 200, downloads.pause(id));
        if (action === 'resume') return json(res, 200, await downloads.resume(id));
        return json(res, 200, await downloads.cancel(id));
      }
    }

    // --- Хранилище моделей (Этап 1Б §5.2) --------------------------------
    // Текущая папка, свободное место, общий размер установленных моделей,
    // проверка существующих путей. Отдельно от /api/settings — UI «Настройки
    // → Хранение моделей» обновляет её без перезагрузки страницы.
    if (req.method === 'GET' && p === '/api/storage') {
      const report = await storageReport(config.models.rootDir, registeredModels.list());
      const disk = diskSpace(config.models.rootDir);
      return json(res, 200, { ...report, disk, activeDownloads: downloads.list().filter((d) => ['downloading', 'paused'].includes(d.state)).length });
    }

    // Проверка путей без переноса: для каждой модели — существует ли файл,
    // совпадает ли размер (§5.2 «проверка существующих путей»).
    if (req.method === 'POST' && p === '/api/storage/check') {
      const report = await storageReport(config.models.rootDir, registeredModels.list());
      const problems = [
        ...report.models.filter((m) => m.sizeBytes === 0).map((m) => ({ file: m.path, issue: 'файл пустой' })),
        ...report.registered.filter((r) => !r.exists).map((r) => ({ file: r.file, issue: 'файл не найден (реестр пользовательских моделей)' })),
        ...report.registered.filter((r) => r.sizeMismatch).map((r) => ({ file: r.file, issue: `размер изменился: было ${r.sizeBytes ?? '—'} байт` }))
      ];
      return json(res, 200, { ok: problems.length === 0, problems, checked: report.models.length + report.registered.length, report });
    }

    // Перенос моделей в новую папку с проверкой SHA-256. По умолчанию старые
    // файлы НЕ удаляются (keepSource: true) — восстановление возможно всегда.
    // После успешного переноса rootDir переключается и сохраняется.
    if (req.method === 'POST' && p === '/api/storage/move') {
      let body;
      try { body = JSON.parse((await readBody(req)) || '{}'); } catch { return openaiError(res, 400, 'Ожидался JSON: { toDir, keepSource? }', 'invalid_request_error'); }
      let toDir;
      try { toDir = safeTargetDir(body.toDir); } catch (err) { return openaiError(res, 400, err.message, 'invalid_request_error', err.code); }
      const active = downloads.list().filter((d) => ['downloading', 'paused'].includes(d.state));
      if (active.length) {
        return openaiError(res, 409, `Идёт загрузка (${active.length}). Поставьте её на паузу или отмените перед переносом моделей.`, 'conflict', 'DOWNLOADS_ACTIVE');
      }
      try {
        const result = await moveModels({
          fromDir: config.models.rootDir,
          toDir,
          keepSource: body.keepSource !== false,
          log: (msg, meta) => logger?.info(msg, meta)
        });
        // Новая папка становится папкой моделей только после успешного переноса.
        config.models.rootDir = toDir;
        saveConfig(config, config.paths.configPath);
        engine.backend.rootDir = toDir; // сканирование сразу из новой папки
        logger?.info('models root dir changed', { rootDir: toDir, moved: result.results.filter((r) => r.status.startsWith('moved')).length });
        return json(res, 200, { ok: true, ...result, rootDir: toDir });
      } catch (err) {
        const status = err instanceof StorageError ? err.status : 500;
        return openaiError(res, status, err.message, 'storage_error', err.code);
      }
    }

    // --- Регистрация пользовательского GGUF (Этап 1Б §6) -----------------
    // Файл выбирается в проводнике (Desktop) или указывается вручную; проверяем
    // формат, считаем SHA-256, извлекаем метаданные из заголовка. Модель
    // становится видна менеджеру и запускается через Engine API. Метаданные,
    // которых нет в GGUF, не придумываем.
    if (req.method === 'POST' && p === '/api/models/register') {
      let body;
      try { body = JSON.parse((await readBody(req)) || '{}'); } catch { return openaiError(res, 400, 'Ожидался JSON: { file }', 'invalid_request_error'); }
      if (typeof body.file !== 'string' || !body.file.trim()) {
        return openaiError(res, 400, 'Укажите путь к GGUF-файлу (поле file).', 'invalid_request_error');
      }
      try {
        const entry = await registeredModels.add(body.file.trim());
        logger?.info('local model registered', { id: entry.id, file: entry.file, sizeBytes: entry.sizeBytes });
        return json(res, 200, { ok: true, model: entry, message: `Модель «${entry.id}» добавлена в менеджер. SHA-256 вычислен локально.` });
      } catch (err) {
        const status = err instanceof StorageError ? err.status : 500;
        return openaiError(res, status, err.message, 'register_error', err.code);
      }
    }

    // Убрать из реестра пользовательских моделей. Файл на диске НЕ удаляется:
    // он принадлежит пользователю и может лежать вне папки моделей.
    {
      const m = p.match(/^\/api\/models\/registered\/([^/]+)$/);
      if (m && req.method === 'DELETE') {
        const id = decodeURIComponent(m[1]);
        const removed = registeredModels.remove(id);
        if (!removed) return openaiError(res, 404, `В реестре нет модели «${id}».`, 'invalid_request_error');
        logger?.info('local model unregistered', { id });
        return json(res, 200, { ok: true, id, note: 'Модель убрана из списка. Файл на диске не удалялся.' });
      }
    }


    if (req.method === 'POST' && p === '/api/install') {
      const body = JSON.parse((await readBody(req)) || '{}');
      // v0.4: при собственном runtime «lmlama» установка не нужна — скачанный
      // GGUF уже виден движку (сканирование папки моделей). Метод сохранён для
      // опциональной интеграции с Ollama.
      if (config.backend.type === 'lmlama') {
        const targetName = body.modelId ? (catalogEntry(body.modelId)?.displayName ?? body.modelId) : (body.ggufPath ?? 'unknown');
        logger?.info('install skipped: lmlama runtime uses GGUF files directly', { model: targetName });
        return json(res, 200, {
          ok: true,
          skipped: true,
          reason: 'Собственный runtime llama.cpp использует GGUF напрямую — установка не требуется. Модель появится в «Моих моделях» после скачивания.',
          model: targetName
        });
      }
      // Форма А: ggufPath (вкладка «Мои модели») — имя модели генерируем.
      // Форма Б: modelId [+ fileName] (каталог) — фирменное имя из каталога.
      let ggufPath = null;
      let modelName = null;
      if (body.modelId) {
        const model = catalogEntry(body.modelId);
        if (!model) return openaiError(res, 404, `Unknown catalog model: ${body.modelId}`, 'invalid_request_error');
        const rating = compat.rateCatalogModel(model, await hardware.analyzeHardware({ candidateRoots: disksCandidateRoots() }));
        const fileName = body.fileName ?? rating.recommended?.name;
        if (!fileName) return openaiError(res, 409, 'Не удалось выбрать квантование — передайте fileName.', 'invalid_request_error');
        ggufPath = path.join(body.targetDir || config.models.rootDir, fileName);
        modelName = model.ollamaName;
      } else if (typeof body.ggufPath === 'string' && body.ggufPath.trim()) {
        ggufPath = path.resolve(body.ggufPath.trim());
        const base = path.basename(ggufPath).replace(/\.gguf$/i, '').replace(/[^\w.-]+/g, '-').toLowerCase();
        modelName = body.modelName ?? `litemind-custom-${base.slice(0, 48)}`;
      } else {
        return openaiError(res, 400, 'Нужен modelId или ggufPath.', 'invalid_request_error');
      }
      if (!fs.existsSync(ggufPath)) {
        return openaiError(res, 409, `GGUF не найден: ${ggufPath}. Сначала скачайте модель.`, 'invalid_request_error', 'GGUF_NOT_FOUND');
      }
      try {
        const result = await installer.installFromGguf({
          ggufPath,
          modelName,
          onStage: (s) => logger?.info('install stage', { model: modelName, ...s })
        });
        installedNames.add(result.model);
        installedCacheAt = Date.now();
        logger?.info('model installed into backend', { model: result.model, digest: result.digest });
        return json(res, 200, { ok: true, ...result });
      } catch (err) {
        return openaiError(res, err.status || 500, err.message, 'install_error', err.code);
      }
    }

    // --- Управление локальными GGUF-моделями (собственный runtime v0.4) ---
    if (req.method === 'GET' && p === '/api/models/scan') {
      // Полная информация для менеджера моделей: размер, формат, квант,
      // совместимость с RAM, статус файла (включая повреждённые).
      // Этап 1Б: плюс реестр пользовательских моделей (файлы вне папки моделей).
      try {
        const scanned = await engine.backend.scanModels();
        const registeredEntries = registeredModels.list();
        const rootFiles = new Set(scanned.map((m) => path.resolve(m.file).toLowerCase()));
        const registeredScanned = [];
        for (const r of registeredEntries) {
          if (rootFiles.has(path.resolve(r.file).toLowerCase())) continue; // уже в папке моделей
          const st = await fs.promises.stat(r.file).catch(() => null);
          registeredScanned.push({
            id: r.id,
            file: r.file,
            sizeBytes: st?.size ?? 0,
            architecture: r.architecture ?? null,
            name: r.name ?? null,
            quant: r.quant ?? null,
            contextLength: r.contextLength ?? null,
            ok: !!st,
            error: st ? null : 'Файл не найден (путь из реестра пользовательских моделей).',
            memoryEstimateMb: st ? Math.round((st.size / (1024 * 1024)) * 1.15) + 256 : 0,
            compatible: !!st,
            registered: true,
            sha256: r.sha256 ?? null,
            shaSource: 'local',
            addedAt: r.addedAt ?? null
          });
        }
        return json(res, 200, {
          rootDir: config.models.rootDir,
          backend: engine.backend.type,
          runtimeBinary: engine.backend.findServerBinary?.() ?? null,
          models: [...registeredScanned, ...scanned]
        });
      } catch (err) {
        return openaiError(res, 500, err.message, 'scan_error');
      }
    }

    // --- Каталог v2: проверка целостности скачанного файла (SHA-256 из HF) ---
    // Этап 1 §7: два режима — { modelId } (каталог, сверка с эталоном) и
    // { file } (локальная GGUF: сигнатура GGUF, размер, фактическая сумма).
    if (req.method === 'POST' && p === '/api/models/verify') {
      let body;
      try { body = JSON.parse((await readBody(req)) || '{}'); } catch { return openaiError(res, 400, 'Ожидался JSON: { modelId, fileName? } или { file }', 'invalid_request_error'); }
      if (!body.modelId && typeof body.file === 'string' && body.file.trim()) {
        const file = path.resolve(body.file.trim());
        const rootDir = path.resolve(config.models.rootDir);
        // Этап 1Б §6: зарегистрированные пользовательские модели могут лежать
        // вне папки моделей — их проверять разрешено.
        const reg = registeredModels.isRegistered(file);
        if (!reg && !isInsideDir(rootDir, file)) {
          return openaiError(res, 400, `Путь должен указывать на файл внутри папки моделей (${rootDir}) или на зарегистрированную пользовательскую модель.`, 'invalid_request_error');
        }
        if (!fs.existsSync(file)) return json(res, 200, { ok: false, verified: false, reason: 'not_found', message: 'Файл не найден.' });
        const stat = fs.statSync(file);
        if (!stat.isFile()) return openaiError(res, 400, `Это не файл: ${file}`, 'invalid_request_error');
        const hash = crypto.createHash('sha256');
        let magicOk = false;
        await new Promise((resolve, reject) => {
          const stream = fs.createReadStream(file);
          let first = true;
          stream.on('data', (chunk) => {
            if (first) { magicOk = chunk.subarray(0, 4).toString('binary') === 'GGUF'; first = false; }
            hash.update(chunk);
          });
          stream.on('end', resolve);
          stream.on('error', reject);
        });
        const verified = magicOk && stat.size > 0;
        logger?.info('model file verified (file mode)', { file, verified, sizeBytes: stat.size });
        return json(res, 200, {
          ok: true, verified, file, sizeBytes: stat.size, magicOk,
          sha256: hash.digest('hex'), expectedSha256: null, shaOk: null, sizeOk: stat.size > 0,
          shaSource: 'local', // §5.4: честная пометка — хеш вычислен локально
          message: verified
            ? 'Файл цел: корректная сигнатура GGUF. SHA-256 вычислен локально — это проверка целостности, а не подтверждение подлинности источника.'
            : 'Файл повреждён: отсутствует сигнатура GGUF. Скачайте модель заново.'
        });
      }
      const model = catalogEntry(String(body.modelId || ''));
      if (!model) return openaiError(res, 404, `Unknown catalog model: ${body.modelId}`, 'invalid_request_error');
      const entryFile = body.fileName
        ? model.files.find((f) => f.name === body.fileName)
        : model.files.slice().sort((a, b) => a.sizeBytes - b.sizeBytes)[0];
      if (!entryFile) return openaiError(res, 404, `Файл не найден в записи каталога: ${body.fileName ?? '(recommended)'}`, 'invalid_request_error');
      const diskPath = path.join(config.models.rootDir, entryFile.name);
      if (!fs.existsSync(diskPath)) {
        return json(res, 200, { ok: false, verified: false, reason: 'not_downloaded', message: 'Файл ещё не скачан.', file: entryFile.name });
      }
      const stat = fs.statSync(diskPath);
      const hash = crypto.createHash('sha256');
      await new Promise((resolve, reject) => {
        const stream = fs.createReadStream(diskPath);
        stream.on('data', (chunk) => hash.update(chunk));
        stream.on('end', resolve);
        stream.on('error', reject);
      });
      const actualSha256 = hash.digest('hex');
      const sizeOk = stat.size === entryFile.sizeBytes;
      const shaOk = entryFile.sha256 ? actualSha256 === entryFile.sha256 : null;
      const verified = sizeOk && (shaOk !== false);
      logger?.info('model file verified', { model: model.id, file: entryFile.name, verified, sizeOk, shaOk });
      return json(res, 200, {
        ok: true,
        verified,
        file: entryFile.name,
        sizeBytes: stat.size,
        expectedSizeBytes: entryFile.sizeBytes,
        sizeOk,
        sha256: actualSha256,
        expectedSha256: entryFile.sha256,
        shaOk,
        shaSource: entryFile.sha256 ? 'huggingface' : 'local',
        message: verified
          ? (shaOk ? 'Файл цел: размер и SHA-256 совпадают с эталоном Hugging Face.' : 'Размер совпадает; эталонная сумма у источника отсутствует — ниже локально вычисленный хеш: это проверка целостности, а не подтверждение источника.')
          : 'Файл повреждён или докачан не полностью: скачайте заново.'
      });
    }

    // --- Каталог v2: запуск скачанной модели (llama-server без генерации) ---
    // Этап 1 §7: два режима — { modelId } (каталог) и { file } (любая локальная
    // GGUF из папки моделей, кнопка «Запустить» в менеджере моделей).
    if (req.method === 'POST' && p === '/api/models/run') {
      let body;
      try { body = JSON.parse((await readBody(req)) || '{}'); } catch { return openaiError(res, 400, 'Ожидался JSON: { modelId } или { file }', 'invalid_request_error'); }
      if (typeof engine.backend.ensureServer !== 'function') {
        return openaiError(res, 501, `Backend "${engine.backend.type}" не поддерживает прямой запуск. Переключитесь на backend "lmlama".`, 'not_supported', 'RUN_UNSUPPORTED');
      }
      const hw = await hardware.analyzeHardware({ candidateRoots: disksCandidateRoots() });
      // Режим «файл»: GGUF из папки моделей или зарегистрированная пользовательская модель.
      if (!body.modelId && typeof body.file === 'string' && body.file.trim()) {
        const file = path.resolve(body.file.trim());
        const rootDir = path.resolve(config.models.rootDir);
        if (!file.toLowerCase().endsWith('.gguf')) {
          return openaiError(res, 400, 'Запускать можно только GGUF-файлы.', 'invalid_request_error');
        }
        // Этап 1Б §6: зарегистрированные пользовательские модели разрешено
        // запускать из любого места (реестр — единственный источник доверия).
        const reg = registeredModels.isRegistered(file);
        if (!reg && !isInsideDir(rootDir, file)) {
          return openaiError(res, 400, `Файл вне папки моделей (${rootDir}) и не зарегистрирован. Добавьте его кнопкой «Добавить свою модель» или измените папку в «Настройках».`, 'invalid_request_error');
        }
        if (!fs.existsSync(file)) {
          return json(res, 200, { ok: false, reason: 'not_found', message: `Файл не найден: ${file}` });
        }
        if (!fs.statSync(file).isFile()) {
          return openaiError(res, 400, `Это не файл: ${file}`, 'invalid_request_error');
        }
        try {
          const prof = config.profiles?.[config.profile] ?? {};
          const started = await engine.backend.ensureServer({
            file,
            contextTokens: Number(body.contextTokens) || hw.recommendation?.maxContextTokens || 4096,
            threads: Number(body.threads) || prof.cpuThreads || 0,
            threadsBatch: prof.cpuThreadsBatch ?? 0,
            numBatch: prof.numBatch ?? 0,
            cacheReuse: prof.cacheReuse ?? 0,
            profile: config.profile,
            useMmap: config.backend.useMmap ?? 'auto'
          });
          logger?.info('local model started from file', { file });
          return json(res, 200, { ok: true, model: path.basename(file).replace(/\.gguf$/i, ''), file, contextTokens: Number(body.contextTokens) || hw.recommendation?.maxContextTokens || 4096, baseUrl: started ?? null, runtime: engine.backend.runtimeInfo?.() ?? null });
        } catch (err) {
          return openaiError(res, err.status || 500, err.message, 'run_error', err.code);
        }
      }
      const model = catalogEntry(String(body.modelId || ''));
      if (!model) return openaiError(res, 404, `Unknown catalog model: ${body.modelId}`, 'invalid_request_error');
      const rating = compat.rateCatalogModel(model, hw);
      const target = rating.recommended;
      if (!target) return openaiError(res, 409, 'Не удалось выбрать файл модели.', 'run_error');
      const diskPath = path.join(config.models.rootDir, target.name);
      if (!fs.existsSync(diskPath)) {
        return json(res, 200, { ok: false, reason: 'not_downloaded', message: 'Модель ещё не скачана — нажмите «Скачать».' });
      }
      if (rating.status === 'red') {
        return json(res, 200, { ok: false, reason: 'incompatible', message: `Модель не рекомендуется: ${rating.fitLabel}. ${rating.files[0]?.reason ?? ''}` });
      }
      try {
        const prof = config.profiles?.[config.profile] ?? {};
        const started = await engine.backend.ensureServer({
          file: diskPath,
          contextTokens: rating.contextTokens,
          threads: Number(body.threads) || prof.cpuThreads || 0,
          threadsBatch: prof.cpuThreadsBatch ?? 0,
          numBatch: prof.numBatch ?? 0,
          cacheReuse: prof.cacheReuse ?? 0,
          profile: config.profile,
          useMmap: config.backend.useMmap ?? 'auto'
        });
        logger?.info('catalog model started', { model: model.id, file: target.name });
        return json(res, 200, { ok: true, model: model.id, file: target.name, quant: target.quant ?? null, contextTokens: rating.contextTokens, baseUrl: started ?? null, runtime: engine.backend.runtimeInfo?.() ?? null });
      } catch (err) {
        return openaiError(res, err.status || 500, err.message, 'run_error', err.code);
      }
    }

    const deleteMatch = p.match(/^\/api\/models\/(?:delete\/([^/]+)|([^/]+))$/);
    if ((req.method === 'DELETE' && deleteMatch) || (req.method === 'POST' && p === '/api/models/delete')) {
      let id = null;
      if (req.method === 'DELETE') {
        id = decodeURIComponent(deleteMatch[1] || deleteMatch[2] || '');
      } else {
        try { id = String(JSON.parse((await readBody(req)) || '{}').id || ''); } catch { /* ниже */ }
      }
      if (!id) return openaiError(res, 400, 'Укажите id модели (имя файла без .gguf).', 'invalid_request_error');
      // Этап 1Б: зарегистрированная пользовательская модель убирается только
      // из реестра — файл на диске не удаляется (он может лежать вне папки
      // моделей и принадлежит пользователю, ТЗ: «не удалять пользовательские модели»).
      if (registeredModels.get(id) && !isInsideDir(path.resolve(config.models.rootDir), registeredModels.get(id).file)) {
        registeredModels.remove(id);
        logger?.info('registered model unregistered via delete', { id });
        return json(res, 200, { ok: true, unregistered: true, id, note: 'Модель убрана из менеджера. Файл на диске не удалялся.' });
      }
      if (typeof engine.backend.deleteModel !== 'function') {
        return openaiError(res, 501, `Backend "${engine.backend.type}" не поддерживает удаление файлов. Переключитесь на backend "lmlama".`, 'not_supported', 'DELETE_UNSUPPORTED');
      }
      try {
        const result = await engine.backend.deleteModel(id);
        logger?.info('model deleted via API', { model: id, by: 'user' });
        return json(res, 200, { ok: true, ...result });
      } catch (err) {
        return openaiError(res, err.status || 500, err.message, 'delete_error', err.code);
      }
    }

    // --- Вложения чата: извлечение текста (TXT/MD/CSV/JSON/код/PDF/DOCX) ---
    if (req.method === 'POST' && p === '/api/attachments') {
      let body;
      try {
        body = JSON.parse((await readBody(req, 14 * 1024 * 1024)) || '{}');
      } catch {
        return openaiError(res, 400, 'Ожидался JSON: { name, dataBase64 }', 'invalid_request_error');
      }
      const name = String(body.name || 'attachment.txt');
      if (!body.dataBase64) return openaiError(res, 400, 'Поле dataBase64 обязательно.', 'invalid_request_error');
      let buf;
      try {
        buf = Buffer.from(String(body.dataBase64).replace(/^data:[^,]+,/, ''), 'base64');
      } catch {
        return openaiError(res, 400, 'dataBase64 не является корректным base64.', 'invalid_request_error');
      }
      try {
        const result = extractText(name, buf);
        logger?.info('attachment extracted', { name, kind: result.kind, chars: result.text.length });
        return json(res, 200, { ok: true, name, kind: result.kind, chars: result.text.length, warning: result.warning, text: result.text });
      } catch (err) {
        return openaiError(res, err.status || 400, err.message, 'attachment_error', err.code);
      }
    }

    // --- OpenAI compatible: models --------------------------------------
    if (req.method === 'GET' && (p === '/v1/models' || p === '/api/models')) {
      let models = [];
      let err = null;
      try {
        if (!(await engine.ensureHealthy())) throw new Error(engine.health.error || 'backend unavailable');
        models = await engine.listModels({ force: true });
      } catch (e) {
        err = e.message;
      }
      const data = {
        object: 'list',
        data: models.map((m) => ({
          id: m.id,
          object: 'model',
          created: 0,
          owned_by: 'litemind',
          size: m.sizeBytes ?? null,
          litemind: {
            sizeBytes: m.sizeBytes ?? null,
            quantization: m.quantization ?? null,
            family: m.family ?? null,
            contextTokens: null,
            tools: m.tools ?? true,
            vision: m.vision ?? false,
            backend: engine.backend.type
          }
        }))
      };
      if (err && models.length === 0) {
        return openaiError(res, 503, `Backend unavailable: ${err}`, 'api_error', 'BACKEND_UNAVAILABLE');
      }
      return json(res, 200, data);
    }

    if (req.method === 'POST' && (p === '/v1/chat/completions' || p === '/v1/completions')) {
      return handleCompletions(req, res, p.endsWith('/completions') && !p.includes('chat'));
    }

    // --- ТЗ v0.6.1: AI Agent — диалоговые сессии (Agent → Tool → Result) ---
    if (p === '/api/agent/status' && req.method === 'GET') {
      return json(res, 200, agent.status());
    }
    if (p === '/api/agent/sessions' && req.method === 'GET') {
      return json(res, 200, { sessions: agent.listSessions() });
    }
    if (p === '/api/agent/sessions' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      try {
        const s = agent.createSession(body);
        if (body.firstMessage) return json(res, 200, await agent.postMessage(s.id, { text: String(body.firstMessage), projectDir: body.projectDir }));
        return json(res, 200, s);
      } catch (err) {
        return openaiError(res, err.status || 500, err.message, 'agent_error');
      }
    }
    {
      const m = /^\/api\/agent\/sessions\/([\w-]+)(\/.*)?$/.exec(p);
      if (m) {
        const id = m[1];
        const action = m[2] || '';
        try {
          if (req.method === 'GET' && action === '') return json(res, 200, agent.fullView(id));
          if (req.method === 'DELETE' && action === '') return json(res, 200, await agent.deleteSession(id));
          if (req.method === 'POST' && action === '/messages') {
            const body = JSON.parse((await readBody(req, MAX_BODY_FILE)) || '{}');
            return json(res, 200, await agent.postMessage(id, body));
          }
          if (req.method === 'POST' && action === '/decision') {
            const body = JSON.parse((await readBody(req)) || '{}');
            return json(res, 200, await agent.decide(id, body));
          }
          if (req.method === 'POST' && action === '/stop') return json(res, 200, await agent.stop(id));
          if (req.method === 'GET' && action === '/events') {
            const cursor = Number(url.searchParams.get('cursor') ?? 0);
            return agent.subscribe(id, res, { cursor });
          }
        } catch (err) {
          return openaiError(res, err.status || 500, err.message, 'agent_error');
        }
      }
    }

    // --- ТЗ §7: управляемый интернет (по умолчанию выключен) -------------
    if (req.method === 'POST' && p === '/api/web/fetch') {
      try {
        const body = JSON.parse((await readBody(req)) || '{}');
        const r = await webCtx.fetchText(String(body.url ?? ''));
        return json(res, 200, { ok: true, ...r, text: r.text.slice(0, 20000) });
      } catch (err) {
        return openaiError(res, err.status || 400, err.message, 'web_error');
      }
    }
    if (req.method === 'POST' && p === '/api/web/github') {
      try {
        const body = JSON.parse((await readBody(req)) || '{}');
        const r = await webCtx.github(body);
        return json(res, 200, { ok: true, ...r, text: r.text.slice(0, 20000) });
      } catch (err) {
        return openaiError(res, err.status || 400, err.message, 'web_error');
      }
    }

    return openaiError(res, 404, `Unknown route: ${req.method} ${p}`, 'invalid_request_error', 'NOT_FOUND');
  }

  async function handleCompletions(req, res, legacyCompletions) {
    let body;
    try {
      body = JSON.parse((await readBody(req)) || '{}');
    } catch (e) {
      return openaiError(res, e.status || 400, `Invalid JSON body: ${e.message}`, 'invalid_request_error');
    }

    let model = body.model;
    let messages = body.messages;
    if (legacyCompletions) {
      messages = [{ role: 'user', content: String(body.prompt ?? '') }];
    }
    if (!model || !Array.isArray(messages) || messages.length === 0) {
      return openaiError(res, 400, 'Both "model" and a non-empty "messages" array are required.', 'invalid_request_error');
    }
    messages = messages.map((m) => ({ role: m.role || 'user', content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) }));

    const healthy = await engine.ensureHealthy();
    if (!healthy) {
      return openaiError(res, 503, engine.health.error || 'Backend is not reachable.', 'api_error', 'BACKEND_UNAVAILABLE');
    }

    const stream = body.stream === true;
    const id = `chatcmpl-${Math.random().toString(36).slice(2, 10)}`;
    const created = Math.floor(Date.now() / 1000);

    if (!stream) {
      try {
        const result = await engine.generate({
          model,
          messages,
          contextTokens: body.context_tokens,
          maxOutputTokens: body.max_tokens ?? body.max_completion_tokens,
          threads: body.num_threads
        });
        return json(res, 200, {
          id,
          object: 'chat.completion',
          created,
          model,
          choices: [{ index: 0, message: { role: 'assistant', content: result.text }, finish_reason: 'stop' }],
          usage: {
            prompt_tokens: result.usage.promptTokens ?? null,
            completion_tokens: result.usage.completionTokens ?? null,
            total_tokens: (result.usage.promptTokens ?? 0) + (result.usage.completionTokens ?? 0)
          },
          litemind: { request_id: result.requestId, timings: result.timings }
        });
      } catch (err) {
        const status = err.status && err.status !== 499 ? err.status : 500;
        if (err.code === 'CANCELLED') return openaiError(res, 499, 'Generation cancelled', 'api_error', 'CANCELLED');
        return openaiError(res, status, err.message, 'api_error', err.code || null);
      }
    }

    // ---- streaming (SSE) ----
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no'
    });
    // v0.6.1: запись в сокет, который клиент уже закрыл, выбрасывала
    // событие 'error' без слушателя → uncaughtException → смерть движка.
    const send = (obj) => {
      if (res.writableEnded) return;
      try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch { /* клиент ушёл */ }
    };
    const finish = (reason) => {
      send({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: {}, finish_reason: reason }] });
      try { if (!res.writableEnded) { res.write('data: [DONE]\n\n'); res.end(); } } catch { /* */ }
    };

    const abort = new AbortController();
    const onClose = () => {
      if (!res.writableEnded) abort.abort(new Error('client disconnected'));
    };
    req.on('close', onClose);
    res.on('close', onClose);

    let requestId = null;
    let finalTimings = null;
    try {
      const result = await engine.generate({
        model,
        messages,
        contextTokens: body.context_tokens,
        maxOutputTokens: body.max_tokens ?? body.max_completion_tokens,
        threads: body.num_threads,
        signal: abort.signal,
        onToken: (delta) => {
          send({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { content: delta }, finish_reason: null }] });
        }
      });
      requestId = result.requestId;
      // Этап 2 §7/§12: честные числа в последнем чанке — UI показывает их под ответом:
      // загрузка модели, TTFT без загрузки, скорость генерации. Не выдуманные цифры.
      finalTimings = {
        ...(result.timings ?? {}),
        usage: result.usage ?? null,
        server: result.server ?? null
      };
      send({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: {}, finish_reason: null }], litemind: { request_id: requestId, timings: finalTimings } });
      finish('stop');
    } catch (err) {
      const reason = err.code === 'CANCELLED' || abort.signal.aborted ? 'cancelled' : 'error';
      if (reason === 'error') {
        send({ error: { message: err.message, type: 'api_error', code: err.code || null } });
        logger?.error('stream failed', { error: err.message, code: err.code });
      }
      finish(reason);
    } finally {
      req.off('close', onClose);
      res.off('close', onClose);
    }
  }

  function serveFile(res, name) {
    const file = path.join(PUBLIC_DIR, name);
    if (!file.startsWith(PUBLIC_DIR) || !fs.existsSync(file)) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      return res.end('not found');
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(fs.readFileSync(file));
  }

  return server;
}
