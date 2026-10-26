// Inference Backend — Ollama adapter (local HTTP API, default http://127.0.0.1:11434).
// Why Ollama over direct llama.cpp for v0.1: a stable HTTP contract (detect/list/stream/
// unload via keep_alive:0), automatic model load/unload, packaged installs for Windows,
// while LiteMind keeps all policy (concurrency, memory gate, limits) on its side of the
// interface. Direct llama.cpp server integration is planned as a second adapter; base.js
// exists precisely so that swap is possible without touching Core/API/UI.
import { BackendError, ModelNotFoundError } from './base.js';

const NDJSON = 'application/x-ndjson';

export class OllamaBackend {
  constructor({ baseUrl = 'http://127.0.0.1:11434', connectTimeoutMs = 1500, fetchImpl = fetch } = {}) {
    this.type = 'ollama';
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.connectTimeoutMs = connectTimeoutMs;
    this.fetch = fetchImpl;
    this._lastDetect = null;
  }

  capabilities() {
    return { stream: true, cancel: true, unload: true, numCtx: true, numThreads: true, numPredict: true, parallel: false };
  }

  async _fetch(pathname, { method = 'GET', body = null, signal = null, timeoutMs = 15000 } = {}) {
    const ctrl = new AbortController();
    const onAbort = () => ctrl.abort(signal?.reason);
    signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => ctrl.abort(new Error('timeout')), timeoutMs);
    try {
      return await this.fetch(this.baseUrl + pathname, {
        method,
        headers: body ? { 'content-type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        signal: ctrl.signal
      });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  /** Reachability + version. Never throws: returns a structured result. */
  async detect() {
    try {
      const res = await this._fetch('/api/version', { timeoutMs: this.connectTimeoutMs });
      if (!res.ok) {
        this._lastDetect = { ok: false, error: `Ollama answered HTTP ${res.status}` };
        return this._lastDetect;
      }
      const data = await res.json().catch(() => ({}));
      this._lastDetect = { ok: true, version: data.version || 'unknown' };
      return this._lastDetect;
    } catch (err) {
      this._lastDetect = {
        ok: false,
        error:
          `Ollama is not reachable at ${this.baseUrl}: ${err.message}. ` +
          'Is it installed and running? (Windows: start "Ollama" from the Start menu; it serves on 127.0.0.1:11434.)'
      };
      return this._lastDetect;
    }
  }

  async listModels() {
    let res;
    try {
      res = await this._fetch('/api/tags', { timeoutMs: 5000 });
    } catch (err) {
      throw new BackendError(`Cannot list models: Ollama unreachable at ${this.baseUrl} (${err.message}).`, { code: 'BACKEND_UNREACHABLE', cause: err });
    }
    if (!res.ok) throw new BackendError(`Cannot list models: HTTP ${res.status}`, { code: 'BACKEND_ERROR', status: res.status });
    const data = await res.json();
    return (data.models || []).map((m) => ({
      id: m.name,
      sizeBytes: typeof m.size === 'number' ? m.size : null,
      detail: m.details?.quantization_level ? `${m.details.parameter_size ?? ''} ${m.details.quantization_level}`.trim() : undefined,
      modifiedAt: m.modified_at
    }));
  }

  async loaded() {
    try {
      const res = await this._fetch('/api/ps', { timeoutMs: 3000 });
      if (!res.ok) return [];
      const data = await res.json();
      return (data.models || []).map((m) => ({ id: m.name, sizeBytes: m.size ?? null, expiresAt: m.expires_at ?? null }));
    } catch {
      return [];
    }
  }

  /**
   * Stream a chat completion. Resolves when Ollama finishes.
   * Cancellation: aborting `signal` closes the socket, which stops generation server-side.
   */
  async generate({ model, messages, contextTokens = 2048, maxOutputTokens = 512, threads = 0, signal, onToken }) {
    const options = {};
    if (contextTokens > 0) options.num_ctx = contextTokens;
    if (maxOutputTokens > 0) options.num_predict = maxOutputTokens;
    if (threads > 0) options.num_thread = threads;

    const body = { model, messages, stream: true, options };

    // Abort wiring is kept for the WHOLE stream: removing it after the response
    // headers arrive would silently break cancellation mid-generation.
    const ctrl = new AbortController();
    const onAbort = () => ctrl.abort(signal?.reason);
    signal?.addEventListener('abort', onAbort, { once: true });
    const connectTimer = setTimeout(() => ctrl.abort(new Error('connect timeout')), 60000);
    const detach = () => {
      clearTimeout(connectTimer);
      signal?.removeEventListener('abort', onAbort);
    };

    let res;
    try {
      res = await this.fetch(this.baseUrl + '/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctrl.signal
      });
    } catch (err) {
      detach();
      if (signal?.aborted) throw err; // cancellation propagates as-is
      throw new BackendError(`Ollama request failed to start: ${err.message}`, { code: 'BACKEND_UNREACHABLE', cause: err });
    }

    if (res.status === 404) {
      detach();
      const list = await this.listModels().catch(() => []);
      throw new ModelNotFoundError(model, list.map((m) => m.id));
    }
    if (!res.ok) {
      detach();
      const text = await res.text().catch(() => '');
      throw new BackendError(`Ollama returned HTTP ${res.status}${text ? `: ${text.slice(0, 300)}` : ''}`, { code: 'BACKEND_ERROR', status: res.status });
    }

    let text = '';
    let promptTokens = 0;
    let completionTokens = 0;
    let buffer = '';

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 1);
          if (!line) continue;
          let chunk;
          try { chunk = JSON.parse(line); } catch { continue; }
          if (chunk.error) throw new BackendError(`Ollama error: ${chunk.error}`, { code: 'BACKEND_ERROR' });
          const delta = chunk.message?.content ?? '';
          if (delta) {
            text += delta;
            onToken?.(delta, chunk);
          }
          if (chunk.prompt_eval_count) promptTokens = chunk.prompt_eval_count;
          if (chunk.eval_count) completionTokens = chunk.eval_count;
        }
      }
    } catch (err) {
      if (signal?.aborted || ctrl.signal.aborted) {
        const e = new Error('Generation cancelled');
        e.code = 'CANCELLED';
        e.name = 'CancelledError';
        throw e;
      }
      throw new BackendError(`Stream failed: ${err.message}`, { code: 'BACKEND_ERROR', cause: err });
    } finally {
      detach();
    }

    if (signal?.aborted || ctrl.signal.aborted) {
      const e = new Error('Generation cancelled');
      e.code = 'CANCELLED';
      e.name = 'CancelledError';
      throw e;
    }

    return { text, usage: { promptTokens, completionTokens } };
  }

  /** Unload one model (or all) from GPU/RAM immediately via keep_alive: 0. */
  async unload(modelId = null) {
    const targets = modelId ? [{ id: modelId }] : await this.loaded();
    const unloaded = [];
    for (const m of targets) {
      try {
        const res = await this._fetch('/api/generate', {
          method: 'POST',
          body: { model: m.id, keep_alive: 0, prompt: '' },
          timeoutMs: 15000
        });
        if (res.ok) unloaded.push(m.id);
      } catch (err) {
        // keep going: one failed unload must not block the rest
        this.unloadErrors = this.unloadErrors || [];
        this.unloadErrors.push({ model: m.id, error: err.message });
      }
    }
    return { unloaded };
  }
}
