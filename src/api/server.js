// API Server — local OpenAI-compatible HTTP API + static dashboard.
// Bind: 127.0.0.1 by default. Non-loopback clients are refused unless
// api.allowLan is explicitly enabled AND api.auth.enabled with a token.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
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

export function createServer({ config, engine, logger }) {
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

    // Graceful shutdown: closes only this server; the CLI exits on 'close'.
    if (req.method === 'POST' && p === '/api/shutdown') {
      json(res, 200, { stopping: true });
      setTimeout(() => {
        engine.shutdown();
        server.close();
        server.closeAllConnections?.();
      }, 50);
      return;
    }

    // --- OpenAI compatible ----------------------------------------------
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
        data: models.map((m) => ({ id: m.id, object: 'model', created: 0, owned_by: 'litemind', size: m.sizeBytes ?? null }))
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
