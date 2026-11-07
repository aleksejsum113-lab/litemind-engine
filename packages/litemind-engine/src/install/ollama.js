// Ollama Import — установка скачанного GGUF в локальную Ollama.
//
// Схема (Ollama ≥ 0.5):
//  1. Считаем SHA-256 GGUF-файла (стримингово, без чтения в память).
//  2. POST /api/blobs/sha256:<digest> — Ollama сама проверит дайджест;
//     если blob уже есть, вернёт 201 без повторной загрузки.
//  3. POST /api/create { model, files: {"model.gguf": "sha256:<digest>"} }
//     — Ollama собирает модель; статус приходит NDJSON-потоком.
//
// После этого модель видна через /api/tags → LiteMind → OpenCode.

import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';

export class InstallError extends Error {
  constructor(message, { code = 'INSTALL_ERROR', status = 500 } = {}) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export function sha256File(filePath, { onProgress = null } = {}) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    let read = 0;
    stream.on('data', (chunk) => {
      hash.update(chunk);
      read += chunk.length;
      onProgress?.(read);
    });
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

export class OllamaInstaller {
  constructor({ baseUrl = 'http://127.0.0.1:11434', fetchImpl = fetch } = {}) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.fetch = fetchImpl;
  }

  /**
   * Полный цикл установки. onStage({stage, detail}) — события для UI.
   * Возвращает { model, digest }.
   */
  async installFromGguf({ ggufPath, modelName, onStage = null } = {}) {
    const name = path.basename(ggufPath);
    if (!/\.gguf$/i.test(name)) {
      throw new InstallError(`Файл не является GGUF: ${name}`, { status: 400 });
    }

    onStage?.({ stage: 'hash', detail: name });
    const digest = await sha256File(ggufPath);

    onStage?.({ stage: 'blob', detail: digest });
    const blobPath = `/api/blobs/sha256:${digest}`;
    let blobRes;
    try {
      const stat = await fs.promises.stat(ggufPath);
      const body = fs.createReadStream(ggufPath);
      blobRes = await fetch(this.baseUrl + blobPath, {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream', 'content-length': String(stat.size) },
        body: body,
        duplex: 'half'
      });
    } catch (err) {
      throw new InstallError(`Ollama недоступна (${err.message}). Установлена и запущена ли она?`, { code: 'OLLAMA_UNREACHABLE' });
    }
    if (!blobRes.ok) {
      const text = await blobRes.text().catch(() => '');
      throw new InstallError(`Загрузка blob не удалась: HTTP ${blobRes.status} ${text.slice(0, 200)}`, { code: 'BLOB_FAILED' });
    }

    onStage?.({ stage: 'create', detail: modelName });
    const createRes = await fetch(this.baseUrl + '/api/create', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: modelName,
        from: null,
        files: { [name]: `sha256:${digest}` }
      })
    }).catch((err) => {
      throw new InstallError(`Ollama create не удался: ${err.message}`, { code: 'CREATE_FAILED' });
    });

    if (!createRes.ok) {
      const text = await createRes.text().catch(() => '');
      throw new InstallError(`Ollama create: HTTP ${createRes.status} ${text.slice(0, 200)}`, { code: 'CREATE_FAILED' });
    }

    // NDJSON-статус; читаем до конца, последняя ошибка — в результат.
    const reader = createRes.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let lastStatus = 'ok';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.error) throw new InstallError(`Ollama: ${msg.error}`, { code: 'CREATE_FAILED' });
          if (msg.status) {
            lastStatus = msg.status;
            onStage?.({ stage: 'create-progress', detail: msg.status });
          }
        } catch (e) {
          if (e instanceof InstallError) throw e;
          /* игнорируем мусорные строки */
        }
      }
    }

    onStage?.({ stage: 'done', detail: lastStatus });
    return { model: modelName, digest };
  }
}
