// API Server — local OpenAI-compatible HTTP API + static dashboard.
// Bind: 127.0.0.1 by default. Non-loopback clients are refused unless
// api.allowLan is explicitly enabled AND api.auth.enabled with a token.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CATALOG, CATEGORIES, catalogEntry } from '../catalog/models.js';
import * as hardware from '../diagnostics/hardware.js';
import * as compat from '../compat.js';
import { DownloadManager } from '../download/manager.js';
import { OllamaInstaller } from '../install/ollama.js';
import { optimizeModel, SLOW_TOKENS_PER_SEC } from '../optimize/optimizer.js';
import { capabilitiesFor } from '../adaptive/capabilities.js';
import * as projectIndex from '../adaptive/project-index.js';
import { saveConfig } from '../config.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'ui', 'public');
const MAX_BODY = 1024 * 1024; // 1 MiB

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

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
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
    if (req.method === 'GET' && (p === '/app.js' || p === '/style.css')) return serveFile(res, p.slice(1));

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

    // --- Workspace: чтение и сохранение файлов проекта (ТЗ §4/§7) ---------
    // Чтение ограничено 2 МиБ и текстовыми файлами; запись требует, чтобы
    // файл уже существовал (создание файлов — через инструменты проекта).
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
      return json(res, 200, { file: path.relative(root, file), sizeBytes: stat.size, content: buf.toString('utf8') });
    }

    if (req.method === 'POST' && p === '/api/project/file') {
      const body = JSON.parse((await readBody(req)) || '{}');
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
      fs.writeFileSync(file, body.content, 'utf8');
      logger?.info('workspace file saved', { file: path.relative(root, file) });
      return json(res, 200, { saved: true, file: path.relative(root, file), sizeBytes: Buffer.byteLength(body.content, 'utf8') });
    }

    // --- AI Terminal: выполнение команд в проекте (ТЗ §4) ------------------
    // Реальный запуск через shell с таймаутом и ограничением вывода.
    // Работает только в каталоге проекта (cwd), выходные данные обрезаются.
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
      try {
        const { exec } = await import('node:child_process');
        const result = await new Promise((resolve) => {
          exec(command, { cwd, timeout: timeoutMs, maxBuffer: 2 * 1024 * 1024, windowsHide: true, killSignal: 'SIGKILL' }, (err, stdout, stderr) => {
            resolve({ err, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
          });
        });
        const durationMs = Date.now() - started;
        const timedOut = result.err?.killed === true || result.err?.signal === 'SIGKILL';
        if (timedOut) logger?.warn('terminal command timed out', { cwd, durationMs });
        else logger?.info('terminal command executed', { cwd, durationMs, exitCode: result.err?.code ?? 0 });
        return json(res, 200, {
          exitCode: result.err?.code ?? (result.err ? 1 : 0),
          timedOut,
          durationMs,
          stdout: result.stdout,
          stderr: result.stderr,
          error: timedOut ? `превышен таймаут ${timeoutMs} мс — процесс принудительно завершён` : result.err?.message ?? null
        });
      } catch (err) {
        return openaiError(res, 500, err.message, 'api_error', 'TERMINAL_FAILED');
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

    // --- OpenAI compatible ----------------------------------------------

    // --- LiteMind v0.2: hardware, catalog, downloads, install -----------
    await refreshInstalled();

    if (req.method === 'GET' && p === '/api/hardware') {
      const hw = await hardware.analyzeHardware({ candidateRoots: disksCandidateRoots() });
      hw.ggufFiles = await listGgufFiles(config.models.rootDir);
      return json(res, 200, hw);
    }

    if (req.method === 'GET' && p === '/api/settings') {
      return json(res, 200, { modelsRootDir: config.models.rootDir, profile: config.profile, configPath: config.paths.configPath });
    }

    if (req.method === 'POST' && p === '/api/settings') {
      const body = JSON.parse((await readBody(req)) || '{}');
      if (typeof body.modelsRootDir === 'string' && body.modelsRootDir.trim()) {
        config.models.rootDir = path.resolve(body.modelsRootDir.trim());
      }
      if (typeof body.profile === 'string') engine.setProfile(body.profile);
      const saved = saveConfig(config, config.paths.configPath);
      logger?.info('settings saved', { modelsRootDir: config.models.rootDir, profile: config.profile, path: saved });
      return json(res, 200, { ok: true, modelsRootDir: config.models.rootDir, profile: config.profile, configPath: saved });
    }

    if (req.method === 'GET' && p === '/api/catalog') {
      const hw = await hardware.analyzeHardware({ candidateRoots: disksCandidateRoots() });
      return json(res, 200, {
        categories: CATEGORIES,
        modelsRootDir: config.models.rootDir,
        models: CATALOG.map((m) => {
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
      const targetDir = path.resolve(body.targetDir || config.models.rootDir);
      // Проверка места на диске до старта (защита от забитого диска).
      try {
        const st = fs.statfsSync(targetDir);
        if (file.sizeBytes && st.bsize * st.bfree < file.sizeBytes + config.models.minFreeFraction * (st.bsize * st.blocks)) {
          return openaiError(res, 507, 'Недостаточно места на выбранном диске (с учётом резерва 5%). Выберите другой диск.', 'insufficient_storage', 'NO_DISK_SPACE');
        }
      } catch {
        /* каталог ещё не создан — mkdir сделает менеджер; проверка free места невозможна */
      }
      const job = await downloads.start({ id: model.id, url: file.url, name: file.name, targetDir, sizeBytes: file.sizeBytes });
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

    if (req.method === 'POST' && p === '/api/install') {
      const body = JSON.parse((await readBody(req)) || '{}');
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
    const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
    const finish = (reason) => {
      send({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: {}, finish_reason: reason }] });
      res.write('data: [DONE]\n\n');
      res.end();
    };

    const abort = new AbortController();
    const onClose = () => {
      if (!res.writableEnded) abort.abort(new Error('client disconnected'));
    };
    req.on('close', onClose);
    res.on('close', onClose);

    let requestId = null;
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
