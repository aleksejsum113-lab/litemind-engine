// GGUF header parser — минимальный, без зависимостей.
//
// Формат: https://github.com/ggml-org/llama.cpp/blob/master/ggml/src/gguf.cpp
//   magic "GGUF" (u32) | version (u32) | tensor_count (u64) | kv_count (u64)
//   затем kv-пары: key = строка (u64 len + байты), value_type (u32), value.
//
// Мы читаем только заголовок и лениво выходим, как только собрали нужные поля
// (general.architecture, general.name, general.file_type, <arch>.context_length).
// Тензоры после kv-пар не читаются.

import fs from 'node:fs';

export const GGUF_MAGIC = 0x46554747; // "GGUF" little-endian

// enum GGUFType (ggml.h)
const T = { UINT8: 0, INT8: 1, UINT16: 2, INT16: 3, UINT32: 4, INT32: 5, FLOAT32: 6, BOOL: 7, STRING: 8, ARRAY: 9, UINT64: 10, INT64: 11, FLOAT64: 12 };
const SCALAR_SIZE = { 0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 4, 7: 1, 10: 8, 11: 8, 12: 8 };

// enum LLM_FTYPE (llama.h) → человекочитаемое имя квантования.
export const FILE_TYPES = {
  0: 'F32', 1: 'F16', 2: 'Q4_0', 3: 'Q4_1', 7: 'Q8_0', 8: 'Q5_0', 9: 'Q5_1',
  10: 'Q2_K', 11: 'Q3_K_S', 12: 'Q3_K_M', 13: 'Q3_K_L', 14: 'Q4_K_S', 15: 'Q4_K_M',
  16: 'Q5_K_S', 17: 'Q5_K_M', 18: 'Q6_K', 19: 'IQ2_XXS', 20: 'IQ2_XS', 21: 'Q2_K_S',
  22: 'IQ3_XS', 23: 'IQ3_XXS', 24: 'IQ1_S', 25: 'IQ4_NL', 26: 'IQ3_S', 27: 'IQ2_S',
  28: 'IQ4_XS', 29: 'IQ1_M', 30: 'BF16',
  // 4, 5, 6 — зарезервированы/legacy
};

/** Достать квант из имени файла: "…-Q4_K_M.gguf" → "Q4_K_M". */
export function quantFromName(name) {
  const m = String(name).match(/(IQ[1-4]_[A-Z0-9_]+|Q[2-8]_[0-9](?:_[KSMXL0]+)?|F16|BF16|F32)/i);
  return m ? m[1].toUpperCase() : null;
}

class Reader {
  constructor(fd) {
    this.fd = fd;
    this.pos = 0;
    this.buf = Buffer.alloc(0);
  }

  async _fill(n) {
    if (this.buf.length - this.pos >= n) return;
    const need = n - (this.buf.length - this.pos);
    const chunk = Buffer.alloc(Math.max(need, 64 * 1024));
    const { bytesRead } = await this.fd.read(chunk, 0, chunk.length, null);
    if (bytesRead <= 0) throw new Error('unexpected end of GGUF file');
    this.buf = this.pos > 0 && this.pos === this.buf.length
      ? chunk.subarray(0, bytesRead)
      : Buffer.concat([this.buf.subarray(this.pos), chunk.subarray(0, bytesRead)]);
    this.pos = 0;
  }

  async u32() { await this._fill(4); const v = this.buf.readUInt32LE(this.pos); this.pos += 4; return v; }
  async u64() { await this._fill(8); const v = this.buf.readBigUInt64LE(this.pos); this.pos += 8; return v; }

  async str() {
    const len = await this.u64();
    if (len > 4 * 1024 * 1024) throw new Error('GGUF string too long');
    await this._fill(Number(len));
    const s = this.buf.toString('utf8', this.pos, this.pos + Number(len));
    this.pos += Number(len);
    return s;
  }

  async skipScalar(type) {
    const size = SCALAR_SIZE[type];
    if (!size) throw new Error(`unknown scalar type ${type}`);
    await this._fill(size);
    this.pos += size;
  }

  async skipValue(type) {
    if (type === T.STRING) return void (await this.str());
    if (type === T.ARRAY) {
      const elemType = await this.u32();
      const count = await this.u64();
      // Массивы строк нельзя пропустить по размеру — читаем поэлементно.
      if (elemType === T.STRING) {
        for (let i = 0; i < Number(count); i++) await this.str();
        return;
      }
      if (elemType === T.ARRAY) throw new Error('nested GGUF arrays are not supported');
      const size = SCALAR_SIZE[elemType];
      if (!size) throw new Error(`unknown array elem type ${elemType}`);
      // Проверка переполнения: count * size может не влезть в заголовок.
      const total = Number(count) * size;
      if (total > 256 * 1024 * 1024) throw new Error('GGUF array too large');
      await this._fill(total);
      this.pos += total;
      return;
    }
    return void (await this.skipScalar(type));
  }
}

/**
 * Прочитать метаданные GGUF. Возвращает объект или бросает ошибку,
 * если файл не GGUF / повреждён.
 * @returns {Promise<{version:number, tensorCount:number, architecture:string|null,
 *   name:string|null, fileType:number|null, quant:string|null, contextLength:number|null}>}
 */
export async function readGgufHeader(filePath) {
  const fd = await fs.promises.open(filePath, 'r');
  try {
    const r = new Reader(fd);
    const magic = await r.u32();
    if (magic !== GGUF_MAGIC) throw new Error('not a GGUF file (bad magic)');
    const version = await r.u32();
    if (version < 1 || version > 3) throw new Error(`unsupported GGUF version ${version}`);
    const tensorCount = Number(await r.u64());
    const kvCount = Number(await r.u64());
    if (kvCount > 100000) throw new Error('implausible kv_count');

    const out = { version, tensorCount, architecture: null, name: null, fileType: null, quant: null, contextLength: null };
    const wanted = new Set(['general.architecture', 'general.name', 'general.file_type']);

    for (let i = 0; i < kvCount; i++) {
      const key = await r.str();
      const type = await r.u32();
      if (wanted.has(key)) {
        if (key === 'general.file_type') {
          await r._fill(4);
          out.fileType = r.buf.readUInt32LE(r.pos);
          r.pos += 4;
        } else {
          out[key === 'general.architecture' ? 'architecture' : 'name'] = await r.str();
        }
        continue;
      }
      // <arch>.context_length — знаем только после чтения architecture.
      if (out.architecture && key === `${out.architecture}.context_length` && type === T.UINT32) {
        await r._fill(4);
        out.contextLength = r.buf.readUInt32LE(r.pos);
        r.pos += 4;
        continue;
      }
      await r.skipValue(type);
      if (!out.architecture && wanted.size === 3) {
        // general.architecture могла идти позже — добавим ключ в wanted, если ещё не встречали.
      }
    }
    out.quant = (out.fileType !== null && FILE_TYPES[out.fileType]) || quantFromName(filePath);
    return out;
  } finally {
    await fd.close();
  }
}
