// Mock Ollama server — used by tests so no real model or download is ever needed.
import http from 'node:http';

export const DEFAULT_MODELS = [
  { name: 'tinytest:1b', size: 400 * 1048576, details: { parameter_size: '1B', quantization_level: 'Q4_0' } },
  { name: 'smalltest:3b', size: 1900 * 1048576, details: { parameter_size: '3B', quantization_level: 'Q4_K_M' } }
];

function readJson(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch { resolve({}); } });
  });
}

/**
 * @param {object} opts
 *  - models: array of {name,size}
 *  - tokenDelayMs: interval between streamed tokens
 *  - words: tokens to stream
 *  - hangAfter: stream N tokens then stall forever (timeout tests)
 *  - chatStatus: force an HTTP status for /api/chat
 *  - version: /api/version payload
 */
export async function startMockOllama(opts = {}) {
  const {
    models = DEFAULT_MODELS,
    tokenDelayMs = 5,
    words = ['Hello', ' from', ' the', ' mock', ' model'],
    hangAfter = null,
    chatStatus = null,
    version = '0.0.0-mock'
  } = opts;

  const state = {
    unloads: [],
    chatRequests: [],
    lastChatBody: null,
    disconnects: 0,
    loaded: new Set(),
    open: 0
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');

    if (req.method === 'GET' && url.pathname === '/api/version') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ version }));
    }

    if (req.method === 'GET' && url.pathname === '/api/tags') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ models }));
    }

    if (req.method === 'GET' && url.pathname === '/api/ps') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ models: [...state.loaded].map((name) => ({ name, size: models.find((m) => m.name === name)?.size ?? 0 })) }));
    }

    if (req.method === 'POST' && url.pathname === '/api/generate') {
      const body = await readJson(req);
      state.unloads.push({ model: body.model, keep_alive: body.keep_alive });
      if (body.model) state.loaded.delete(body.model);
      else state.loaded.clear();
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ done: 'success' }));
    }

    if (req.method === 'POST' && url.pathname === '/api/chat') {
      const body = await readJson(req);
      state.lastChatBody = body;
      state.chatRequests.push({ model: body.model, at: Date.now(), options: body.options });

      if (!models.some((m) => m.name === body.model)) {
        res.writeHead(404, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: `model '${body.model}' not found` }));
      }
      if (chatStatus) {
        res.writeHead(chatStatus, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: 'simulated backend failure' }));
      }

      state.loaded.add(body.model);
      state.open++;
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      let closed = false;
      let finished = false;
      let i = 0;
      // Cancellation shows up as the response/socket closing before we finish
      // streaming (IncomingMessage 'close' alone is unreliable here).
      res.on('close', () => {
        if (!finished) {
          if (!closed) { closed = true; state.disconnects++; state.open--; }
          finished = true;
        }
      });
      const iv = setInterval(() => {
        if (closed || finished) return;
        if (hangAfter !== null && i >= hangAfter) return; // stall on purpose
        if (i >= words.length) {
          finished = true;
          clearInterval(iv);
          state.open--;
          res.write(JSON.stringify({ message: { role: 'assistant', content: '' }, done: true, prompt_eval_count: 12, eval_count: words.length }) + '\n');
          res.end();
          return;
        }
        res.write(JSON.stringify({ message: { role: 'assistant', content: words[i] }, done: false }) + '\n');
        i++;
      }, tokenDelayMs);
      res.on('close', () => clearInterval(iv));
      return;
    }

    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;

  return {
    url,
    state,
    close: () => new Promise((resolve) => {
      for (const s of server._connections ? [] : []) void s;
      server.close(() => resolve());
      server.closeAllConnections?.();
    })
  };
}
