// Download Manager — загрузка GGUF с HuggingFace в выбранную пользователем папку.
//
// Требования ТЗ §3: прогресс, скорость, ETA, пауза/возобновление/отмена,
// HTTP Range (докачка после обрыва и после паузы), выбор диска и папки,
// сохранение состояния между рестартами движка (файл *.part остаётся).
//
// Порядок работы:
//  1. start(entryId, fileName, targetDir) → скачивает в targetDir/<name>.part
//  2. По завершении — контроль размера (должен совпасть с каталогом) и
//     переименование в финальное имя. SHA-256 НЕ считаем на лету: Ollama
//     посчитает дайджест сам при установке (install/ollama.js).
//  3. Пауза = мягкая отмена с сохранением .part; resume = запрос с Range.

import fs from 'node:fs';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const RESUME_SUFFIX = '.part';
const UA = 'LiteMind-Engine/0.2 (local; Windows; +https://github.com/aleksejsum113-lab/litemind-engine)';

export class DownloadError extends Error {
  constructor(message, { code = 'DOWNLOAD_ERROR', status = 500 } = {}) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

let NEXT_ID = 1;

export class DownloadManager {
  constructor({ fetchImpl = fetch, onEvent = null } = {}) {
    this.fetch = fetchImpl;
    this.onEvent = onEvent; // (event) => void — для SSE-потока UI
    this.jobs = new Map(); // id -> job
  }

  list() {
    return [...this.jobs.values()].map((j) => this._snapshot(j));
  }

  get(id) {
    const job = this.jobs.get(id);
    return job ? this._snapshot(job) : null;
  }

  /**
   * Начать загрузку. Если в targetDir уже есть <name>.part — продолжит с offset.
   */
  async start({ id, url, name, targetDir, sizeBytes = null }) {
    if ([...this.jobs.values()].some((j) => j.key === `${id}:${name}` && ['downloading', 'paused'].includes(j.state))) {
      throw new DownloadError('Эта модель уже скачивается', { code: 'ALREADY_DOWNLOADING', status: 409 });
    }
    await fs.promises.mkdir(targetDir, { recursive: true });
    const partPath = path.join(targetDir, name + RESUME_SUFFIX);
    const finalPath = path.join(targetDir, name);

    let resumeFrom = 0;
    try {
      resumeFrom = (await fs.promises.stat(partPath)).size;
    } catch {
      /* нет .part — начинаем с нуля */
    }
    if (sizeBytes && resumeFrom === sizeBytes) {
      // часть уже докачана до полного размера — просто завершим
      await fs.promises.rename(partPath, finalPath).catch(() => {});
      return this.get(id) ?? { id, state: 'done' };
    }

    const job = {
      id: `dl_${NEXT_ID++}`,
      key: `${id}:${name}`,
      modelId: id,
      url,
      name,
      targetDir,
      finalPath,
      partPath,
      sizeBytes,
      received: resumeFrom,
      startedAt: Date.now(),
      state: 'downloading',
      error: null,
      speedBps: 0,
      etaSeconds: null,
      _ctrl: new AbortController(),
      _pauseRequested: false
    };
    this.jobs.set(job.id, job);
    this._emit({ type: 'start', ...this._snapshot(job) });

    // Фоновая задача; ошибки хранятся в job.state.
    this._run(job).catch((err) => {
      job.state = 'error';
      job.error = err.message;
      this._emit({ type: 'error', ...this._snapshot(job) });
    });
    return this._snapshot(job);
  }

  async _run(job) {
    const headers = { 'user-agent': UA };
    if (job.received > 0) {
      headers.range = `bytes=${job.received}-`;
      headers['accept-encoding'] = 'identity';
    }

    let res;
    try {
      res = await this.fetch(job.url, { headers, signal: job._ctrl.signal, redirect: 'follow' });
    } catch (err) {
      if (job._pauseRequested) {
        job.state = 'paused';
        this._emit({ type: 'paused', ...this._snapshot(job) });
        return;
      }
      throw new DownloadError(`Сеть недоступна: ${err.message}`, { code: 'NETWORK' });
    }

    if (job.received > 0 && res.status === 200) {
      // Сервер не поддержал Range — начинаем заново.
      job.received = 0;
    } else if (job.received > 0 && res.status !== 206) {
      throw new DownloadError(`Сервер не поддержал докачку (HTTP ${res.status})`, { code: 'NO_RANGE' });
    } else if (res.status >= 400) {
      throw new DownloadError(`HuggingFace вернул HTTP ${res.status}`, { code: 'HTTP_' + res.status });
    }

    const total = res.headers.get('content-length') ? Number(res.headers.get('content-length')) + job.received : job.sizeBytes;
    job.sizeBytes = total || job.sizeBytes;

    const source = Readable.fromWeb(res.body);
    const out = fs.createWriteStream(job.partPath, { flags: job.received > 0 ? 'a' : 'w' });

    let lastTick = Date.now();
    let lastBytes = job.received;

    // Счётчик в виде Transform: сохраняет backpressure pipeline и не
    // переводит исходный поток в flowing mode (иначе теряются чанки).
    const counter = new Transform({
      transform(chunk, _enc, cb) {
        job.received += chunk.length;
        const now = Date.now();
        if (now - lastTick >= 500) {
          const dt = (now - lastTick) / 1000;
          job.speedBps = Math.max(0, Math.round((job.received - lastBytes) / dt));
          lastTick = now;
          lastBytes = job.received;
          job.etaSeconds = job.sizeBytes && job.speedBps > 0 ? Math.max(0, Math.round((job.sizeBytes - job.received) / job.speedBps)) : null;
          this.push(chunk);
          cb();
          this._emitProgress?.();
          return;
        }
        cb(null, chunk);
      }
    });
    counter._emitProgress = () => this._emit({ type: 'progress', ...this._snapshot(job) });

    try {
      await pipeline(source, counter, out);
    } catch (err) {
      if (job._pauseRequested) {
        job.state = 'paused';
        this._emit({ type: 'paused', ...this._snapshot(job) });
        return;
      }
      if (job._ctrl.signal.aborted) {
        job.state = 'cancelled';
        this._emit({ type: 'cancelled', ...this._snapshot(job) });
        return;
      }
      throw new DownloadError(`Загрузка прервана: ${err.message}`, { code: 'INTERRUPTED' });
    }

    // Контроль размера (обязательный для GGUF — битый файл Ollama отклонит).
    const size = (await fs.promises.stat(job.partPath)).size;
    if (job.sizeBytes && size !== job.sizeBytes) {
      throw new DownloadError(`Размер файла не совпал: получено ${size}, ожидалось ${job.sizeBytes}. Файл .part сохранён — нажмите «Продолжить».`, { code: 'SIZE_MISMATCH' });
    }
    await fs.promises.rename(job.partPath, job.finalPath);
    job.state = 'done';
    job.etaSeconds = 0;
    this._emit({ type: 'done', ...this._snapshot(job) });
  }

  /** Пауза: закрывает соединение, .part сохраняется, resume продолжит с offset. */
  pause(id) {
    const job = this.jobs.get(id);
    if (!job || job.state !== 'downloading') return { paused: false, reason: 'not downloading' };
    job._pauseRequested = true;
    job._ctrl.abort(new Error('paused'));
    return { paused: true };
  }

  /** Продолжить после паузы/ошибки сети. */
  async resume(id) {
    const job = this.jobs.get(id);
    if (!job) throw new DownloadError('Загрузка не найдена', { status: 404 });
    if (job.state !== 'paused' && job.state !== 'error') return { resumed: false, reason: `state=${job.state}` };
    try {
      job.received = (await fs.promises.stat(job.partPath)).size;
    } catch {
      job.received = 0;
    }
    job.state = 'downloading';
    job.error = null;
    job._pauseRequested = false;
    job._ctrl = new AbortController();
    this._emit({ type: 'start', ...this._snapshot(job) });
    this._run(job).catch((err) => {
      job.state = 'error';
      job.error = err.message;
      this._emit({ type: 'error', ...this._snapshot(job) });
    });
    return { resumed: true };
  }

  /** Отмена: останавливает и удаляет .part. */
  async cancel(id) {
    const job = this.jobs.get(id);
    if (!job) return { cancelled: false, reason: 'not found' };
    if (job.state === 'downloading') {
      job.state = 'cancelling';
      job._ctrl.abort(new Error('cancelled'));
      // даём _run() шанс корректно завершиться
      await new Promise((r) => setTimeout(r, 150));
    }
    await fs.promises.rm(job.partPath, { force: true }).catch(() => {});
    job.state = 'cancelled';
    this.jobs.delete(id);
    this._emit({ type: 'cancelled', id });
    return { cancelled: true };
  }

  _snapshot(job) {
    return {
      id: job.id,
      modelId: job.modelId,
      name: job.name,
      targetDir: job.targetDir,
      state: job.state,
      receivedBytes: job.received,
      sizeBytes: job.sizeBytes,
      percent: job.sizeBytes ? Math.min(100, Math.round((job.received / job.sizeBytes) * 100)) : null,
      speedBps: job.speedBps,
      etaSeconds: job.etaSeconds,
      error: job.error,
      startedAt: job.startedAt
    };
  }

  _emit(event) {
    try { this.onEvent?.(event); } catch { /* слушатель не должен ломать загрузку */ }
  }
}
