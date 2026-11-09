// Inference Backend — собственный runtime LiteMind на базе llama.cpp (llama-server).
//
// ТЗ v0.4.0: движок сам управляет моделями — обнаружение GGUF в папке моделей,
// выбор и запуск llama-server, стриминг чата, остановка, удаление файлов.
// Ollama больше не требуется: backend "lmlama" — основной, "ollama" — опциональный.
//
// Как это работает:
//  1. findServerBinary() — где лежит llama-server(.exe): env LITEMIND_LLAMA_SERVER,
//     config.backend.serverPath, resources/llamacpp (в комплекте установщика), PATH.
//  2. listModels() — сканирует config.models.rootDir на *.gguf, читает заголовки.
//  3. generate() — поднимает llama-server с выбранной моделью (один процесс,
//     одна модель — как и требует Low Resource профиль), ждёт /health, стримит
//     SSE из /v1/chat/completions (OpenAI-совместимый контракт llama.cpp).
//  4. unload() — терминирует процесс: модель уходит из RAM/VRAM немедленно.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { BackendError, ModelNotFoundError } from './base.js';
import { readGgufHeader } from './gguf.js';

const EXE = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server';

/** Свободный TCP-порт на loopback. */
function freePort(host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, host, () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

export class LlamaCppBackend {
  constructor({ rootDir, serverPath = null, host = '127.0.0.1', logger = null, fetchImpl = fetch,
                contextTokens = 4096, threads = 0, chatTemplate = null, loadTimeoutMs = 180000 } = {}) {
    this.type = 'lmlama';
    this.rootDir = rootDir;
    this.host = host;
    this.log = logger;
    this.fetch = fetchImpl;
    this.serverPath = serverPath || null;
    this.defaultCtx = contextTokens;
    this.defaultThreads = threads;
    this.chatTemplate = chatTemplate;
    this.loadTimeoutMs = loadTimeoutMs;

    // Состояние процесса llama-server: не более одного загруженного файла.
    this.proc = null;
    this.port = null;
    this.baseUrl = null;
    this.modelFile = null;   // абсолютный путь к .gguf
    this.modelId = null;     // имя файла без .gguf
    this.exitInfo = null;    // { code, signal, stderrTail }
    this._scannedAt = 0;
    this._scanCache = [];
  }

  capabilities() {
    return { stream: true, cancel: true, unload: true, numCtx: true, numThreads: true, numPredict: true, parallel: false };
  }

  // ── Бинарник llama-server ────────────────────────────────────────────────

  /** Кандидаты пути к llama-server, по убыванию приоритета. Все проверяются на существование. */
  _candidates() {
    const list = [];
    if (process.env.LITEMIND_LLAMA_SERVER) list.push(process.env.LITEMIND_LLAMA_SERVER);
    if (this.serverPath) list.push(this.serverPath);
    // Внутри Electron: process.resourcesPath = <install>\resources
    if (process.resourcesPath) list.push(path.join(process.resourcesPath, 'llamacpp', EXE));
    // Dev-режим monorepo: packages/desktop/resources/llamacpp/<exe>
    try {
      const here = path.dirname(fileURLToPath(import.meta.url)); // …/src/backends
      list.push(path.join(here, '..', '..', '..', '..', 'desktop', 'resources', 'llamacpp', EXE));
    } catch { /* не критично */ }
    list.push(EXE); // PATH
    return list;
  }

  /** Найденный бинарник или null. */
  findServerBinary() {
    for (const cand of this._candidates()) {
      if (!cand) continue;
      if (cand === EXE) {
        // Поиск в PATH без внешних процессов.
        const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
        for (const d of dirs) {
          const p = path.join(d, EXE);
          try { if (fs.statSync(p).isFile()) return p; } catch { /* дальше */ }
        }
        continue;
      }
      try { if (fs.statSync(cand).isFile()) return path.resolve(cand); } catch { /* дальше */ }
    }
    return null;
  }

  /** Достижимость runtime: бинарник найден и запускается. Никогда не бросает. */
  async detect() {
    const bin = this.findServerBinary();
    if (!bin) {
      return {
        ok: false,
        error:
          `llama-server не найден. LiteMind 0.4 кладёт его в "<установка>\\resources\\llamacpp\\llama-server.exe". ` +
          `Проверьте установку или укажите путь вручную (config.backend.serverPath или LITEMIND_LLAMA_SERVER).`
      };
    }
    return await new Promise((resolve) => {
      let out = '', err = '', done = false;
      const proc = spawn(bin, ['--version'], { windowsHide: true });
      const finish = (result) => { if (!done) { done = true; resolve(result); } };
      const killer = setTimeout(() => { proc.kill(); finish({ ok: false, error: `llama-server --version не ответил за 10 с: ${bin}` }); }, 10000);
      proc.stdout.on('data', (d) => { out += d; });
      proc.stderr.on('data', (d) => { err += d; });
      proc.on('error', (e) => { clearTimeout(killer); finish({ ok: false, error: `Не удалось запустить llama-server (${bin}): ${e.message}` }); });
      proc.on('close', (code) => {
        clearTimeout(killer);
        if (code === 0) {
          const version = (out || err).split(/\r?\n/).find(Boolean) || 'unknown';
          finish({ ok: true, version: version.trim(), detail: bin });
        } else {
          finish({ ok: false, error: `llama-server завершился с кодом ${code}: ${(err || out).slice(0, 300)}` });
        }
      });
    });
  }

  // ── Обнаружение моделей ──────────────────────────────────────────────────

  /**
   * Сканировать папку моделей. Результат кэшируется на 4 c.
   * @returns {Promise<Array<{id:string,file:string,sizeBytes:number,architecture:string|null,
   *   name:string|null,quant:string|null,contextLength:number|null,ok:boolean,error:string|null,
   *   memoryEstimateMb:number,compatible:boolean}>>}
   */
  async scanModels() {
    if (Date.now() - this._scannedAt < 4000 && this._scanCache.length) return this._scanCache;
    const entries = [];
    let files = [];
    try {
      await fs.promises.mkdir(this.rootDir, { recursive: true });
      files = (await fs.promises.readdir(this.rootDir)).filter((f) => f.toLowerCase().endsWith('.gguf'));
    } catch (err) {
      this.log?.warn('scan failed', { dir: this.rootDir, error: err.message });
      return [];
    }

    const totalMemMb = os.totalmem() / (1024 * 1024);
    const budgetMb = totalMemMb * 0.7; // как resource/gate: не занимать больше 70% RAM

    for (const f of files) {
      const file = path.join(this.rootDir, f);
      let sizeBytes = 0;
      try { sizeBytes = (await fs.promises.stat(file)).size; } catch { continue; }
      const entry = {
        id: f.replace(/\.gguf$/i, ''),
        file,
        sizeBytes,
        architecture: null, name: null, quant: null, contextLength: null,
        ok: false, error: null
      };
      try {
        const hdr = await readGgufHeader(file);
        Object.assign(entry, hdr);
        entry.ok = true;
      } catch (err) {
        entry.error = `Файл повреждён или не GGUF: ${err.message}`;
      }
      // Оценка RAM: веса ≈ размер файла × 1.15 (буферы вычислений) + 256 МБ запас
      // под KV-кэш и активацию — консервативно для контекста ~4k у малых моделей.
      entry.memoryEstimateMb = Math.round((sizeBytes / (1024 * 1024)) * 1.15) + 256;
      entry.compatible = entry.memoryEstimateMb <= budgetMb;
      entries.push(entry);
    }
    entries.sort((a, b) => b.sizeBytes - a.sizeBytes);
    this._scanCache = entries;
    this._scannedAt = Date.now();
    return entries;
  }

  async listModels() {
    const scanned = await this.scanModels();
    return scanned
      .filter((m) => m.ok)
      .map((m) => ({
        id: m.id,
        sizeBytes: m.sizeBytes,
        detail: `${m.architecture ?? 'gguf'} · ${m.quant ?? 'unknown quant'} · ${(m.sizeBytes / (1024 * 1024)).toFixed(0)} MiB`,
        quantization: m.quant,
        family: m.architecture,
        parameterSize: null,
        contextLength: m.contextLength,
        compatible: m.compatible,
        memoryEstimateMb: m.memoryEstimateMb,
        runtime: 'llama.cpp',
        tools: false, // честно: поддержку tools у GGUF не обещаем
        vision: false
      }));
  }

  async loaded() {
    if (!this.proc || !this.modelId) return [];
    const healthy = await this._health(1500).catch(() => null);
    if (!healthy) return [];
    return [{ id: this.modelId, sizeBytes: null, file: this.modelFile, port: this.port }];
  }

  // ── Управление процессом llama-server ────────────────────────────────────

  async _health(timeoutMs = 2000) {
    if (!this.baseUrl) return null;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(new Error('timeout')), timeoutMs);
    try {
      const res = await this.fetch(`${this.baseUrl}/health`, { signal: ctrl.signal });
      if (!res.ok) return null;
      return await res.json().catch(() => ({}));
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  _stopProc(force = false) {
    return new Promise((resolve) => {
      const proc = this.proc;
      if (!proc || proc.exitCode !== null || proc.signalCode !== null) { this._resetProc(); return resolve(); }
      const killed = setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* уже мёртв */ } }, 3000);
      proc.once('close', () => { clearTimeout(killed); this._resetProc(); resolve(); });
      try { proc.kill(force ? 'SIGKILL' : 'SIGTERM'); } catch { clearTimeout(killed); this._resetProc(); resolve(); }
      if (process.platform === 'win32' && !force) {
        // SIGTERM на Windows убивает процесс сразу — гарантия освобождения RAM.
        try { spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { windowsHide: true }); } catch { /* fallback выше */ }
      }
    });
  }

  _resetProc() {
    this.proc = null;
    this.port = null;
    this.baseUrl = null;
    this.modelFile = null;
    this.modelId = null;
  }

  /**
   * Запустить (или переиспользовать) llama-server с файлом модели.
   * Бросает BackendError с честным текстом ошибки, если загрузить не удалось.
   */
  async ensureServer({ file, contextTokens, threads, useMmap }) {
    const bin = this.findServerBinary();
    if (!bin) {
      throw new BackendError(
        'llama-server не найден. Установите LiteMind через установщик (runtime в комплекте) или задайте config.backend.serverPath.',
        { code: 'RUNTIME_MISSING', status: 503 }
      );
    }

    const ctx = Math.max(512, contextTokens || this.defaultCtx);
    const wantThreads = threads > 0 ? threads : this.defaultThreads;

    // Уже загружен тот же файл с достаточным контекстом — переиспользуем.
    if (this.proc && this.modelFile === path.resolve(file)) {
      const h = await this._health(1500);
      if (h?.status === 'ok') return this.baseUrl;
      await this._stopProc(true); // загружается, но завис/умер — чистый перезапуск
    }

    await this._stopProc();
    const port = await freePort(this.host);
    const args = [
      '--model', path.resolve(file),
      '--host', this.host,
      '--port', String(port),
      '--ctx-size', String(ctx),
      '--parallel', '1'
    ];
    if (wantThreads > 0) args.push('--threads', String(wantThreads));
    if (useMmap === false) args.push('--no-mmap');
    if (this.chatTemplate) args.push('--chat-template', this.chatTemplate);

    this.log?.info('starting llama-server', { bin, args: args.join(' ') });
    const stderrTail = [];
    const proc = spawn(bin, args, { windowsHide: true });
    proc.stdout.on('data', (d) => { const s = String(d); if (s.trim()) this.log?.debug?.('llama-server', { line: s.trim().slice(0, 200) }); });
    proc.stderr.on('data', (d) => {
      const line = String(d).trim();
      if (!line) return;
      stderrTail.push(line);
      if (stderrTail.length > 40) stderrTail.shift();
      this.log?.debug?.('llama-server', { line: line.slice(0, 200) });
    });
    proc.on('error', (e) => { this.exitInfo = { error: e.message }; });
    proc.on('close', (code, signal) => { this.exitInfo = { code, signal, stderrTail: stderrTail.slice(-10).join('\n') }; });

    this.proc = proc;
    this.port = port;
    this.baseUrl = `http://${this.host}:${port}`;
    this.modelFile = path.resolve(file);
    this.modelId = path.basename(file).replace(/\.gguf$/i, '');
    this.exitInfo = null;

    // Ждём /health === ok (загрузка модели с диска может занять десятки секунд).
    const deadline = Date.now() + this.loadTimeoutMs;
    let lastBody = null;
    while (Date.now() < deadline) {
      if (proc.exitCode !== null || proc.signalCode !== null || this.exitInfo?.error) {
        const tail = (this.exitInfo?.stderrTail || stderrTail.slice(-10).join('\n') || '').slice(-800);
        this._resetProc();
        throw new BackendError(
          `llama-server не смог загрузить модель: ${path.basename(file)}. ${tail || 'Процесс завершился без диагностики.'}`,
          { code: 'RUNTIME_START_FAILED', status: 502 }
        );
      }
      lastBody = await this._health(3000);
      if (lastBody?.status === 'ok') {
        this.log?.info('llama-server ready', { model: this.modelId, port });
        return this.baseUrl;
      }
      await new Promise((r) => setTimeout(r, 400));
    }
    const tail = stderrTail.slice(-10).join('\n').slice(-800);
    await this._stopProc(true);
    throw new BackendError(`llama-server не ответил /health за ${Math.round(this.loadTimeoutMs / 1000)} с. ${tail}`, { code: 'RUNTIME_TIMEOUT', status: 504 });
  }

  // ── Генерация ────────────────────────────────────────────────────────────

  /**
   * Стриминговый чат. Контракт как у OllamaBackend (base.js).
   * Отмена: abort signal закрывает соединение — llama-server останавливает генерацию.
   */
  async generate({ model, messages, contextTokens = 4096, maxOutputTokens = 512, threads = 0, numBatch = 0, useMmap = null, signal, onToken }) {
    const scanned = await this.scanModels();
    const meta = scanned.find((m) => m.id === model && m.ok);
    if (!meta) {
      const available = scanned.filter((m) => m.ok).map((m) => m.id);
      throw new ModelNotFoundError(model, available);
    }
    if (meta.error && !meta.ok) {
      throw new BackendError(`Файл модели повреждён: ${meta.error}`, { code: 'MODEL_CORRUPT', status: 422 });
    }

    const baseUrl = await this.ensureServer({ file: meta.file, contextTokens, threads, useMmap });

    const body = {
      model,
      messages,
      stream: true,
      max_tokens: maxOutputTokens > 0 ? maxOutputTokens : 512,
      stream_options: { include_usage: true }
    };

    // Abort-обвязка держится весь стрим: отключение клиента = остановка генерации.
    const ctrl = new AbortController();
    const onAbort = () => ctrl.abort(signal?.reason);
    signal?.addEventListener('abort', onAbort, { once: true });
    const connectTimer = setTimeout(() => ctrl.abort(new Error('connect timeout')), 60000);
    const detach = () => { clearTimeout(connectTimer); signal?.removeEventListener('abort', onAbort); };

    let res;
    try {
      res = await this.fetch(`${baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctrl.signal
      });
    } catch (err) {
      detach();
      if (signal?.aborted) throw err;
      throw new BackendError(`Запрос к llama-server (${baseUrl}) не удался: ${err.message}. Процесс мог завершиться — попробуйте снова.`, { code: 'BACKEND_UNREACHABLE', cause: err });
    }

    if (res.status === 404) {
      detach();
      const available = (await this.listModels()).map((m) => m.id);
      throw new ModelNotFoundError(model, available);
    }
    if (!res.ok) {
      detach();
      const text = await res.text().catch(() => '');
      throw new BackendError(`llama-server вернул HTTP ${res.status}${text ? `: ${text.slice(0, 300)}` : ''}`, { code: 'BACKEND_ERROR', status: res.status });
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
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (payload === '[DONE]') continue;
          let chunk;
          try { chunk = JSON.parse(payload); } catch { continue; }
          if (chunk.error) throw new BackendError(`llama-server: ${chunk.error.message ?? JSON.stringify(chunk.error).slice(0, 200)}`, { code: 'BACKEND_ERROR' });
          const delta = chunk.choices?.[0]?.delta?.content ?? '';
          if (delta) {
            text += delta;
            onToken?.(delta, chunk);
          }
          if (chunk.usage) {
            promptTokens = chunk.usage.prompt_tokens ?? promptTokens;
            completionTokens = chunk.usage.completion_tokens ?? completionTokens;
          }
        }
      }
    } catch (err) {
      if (signal?.aborted || ctrl.signal.aborted) {
        const e = new Error('Generation cancelled');
        e.code = 'CANCELLED';
        e.name = 'CancelledError';
        throw e;
      }
      throw new BackendError(`Стрим прервался: ${err.message}`, { code: 'BACKEND_ERROR', cause: err });
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

  // ── Выгрузка и удаление ──────────────────────────────────────────────────

  /** Выгрузить модель из RAM: терминировать llama-server. Идемпотентно. */
  async unload(modelId = null) {
    if (!this.proc) return { unloaded: [] };
    if (modelId && this.modelId && this.modelId !== modelId) return { unloaded: [] };
    const was = this.modelId;
    await this._stopProc();
    this.log?.info('model unloaded from RAM', { model: was });
    return { unloaded: was ? [was] : [] };
  }

  /**
   * Удалить файл модели на диске (ТЗ v0.4: честное удаление).
   * Если модель загружена — сначала выгружает процесс, затем удаляет файл.
   */
  async deleteModel(modelId) {
    const scanned = await this.scanModels();
    const meta = scanned.find((m) => m.id === modelId);
    if (!meta) {
      // Обновим кэш принудительно — модель могла появиться только что.
      this._scannedAt = 0;
      const fresh = await this.scanModels();
      const again = fresh.find((m) => m.id === modelId);
      if (!again) throw new BackendError(`Модель "${modelId}" не найдена в ${this.rootDir}`, { code: 'MODEL_NOT_FOUND', status: 404 });
      return this._removeFile(again);
    }
    return this._removeFile(meta);
  }

  async _removeFile(meta) {
    if (this.modelId === meta.id && this.proc) await this._stopProc();
    // Защита: удаляем только файлы из папки моделей.
    const resolved = path.resolve(meta.file);
    if (!resolved.startsWith(path.resolve(this.rootDir))) {
      throw new BackendError('Отказ удалять файл вне папки моделей', { code: 'FORBIDDEN_PATH', status: 403 });
    }
    await fs.promises.rm(resolved, { force: true });
    this._scannedAt = 0; // пересканировать при следующем listModels
    const left = await this.scanModels();
    this.log?.info('model file deleted', { model: meta.id, file: resolved, remaining: left.length });
    return { deleted: meta.id, file: resolved, remaining: left.filter((m) => m.ok).map((m) => m.id) };
  }

  /** Полная остановка runtime (ТЗ §16). */
  async shutdown() {
    await this._stopProc();
    return { stopped: true };
  }
}
