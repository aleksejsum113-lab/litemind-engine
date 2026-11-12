// Image Models — обнаружение и проверка моделей генерации изображений.
//
// Поддерживаемые форматы stable-diffusion.cpp:
//   • .safetensors — полный чекпоинт (SD 1.5 fp16 ≈ 2 ГБ): первые 8 байт —
//     little-endian u64 с длиной JSON-заголовка, далее сам JSON;
//   • .gguf — квантованный чекпоинт (SD 1.5 Q4_0 ≈ 0.7 ГБ, Q8_0 ≈ 1.3 ГБ):
//     магия 'GGUF' (та же валидация, что у LLM-моделей).
//
// Сканируемая папка: config.image.modelsDir (по умолчанию <models.rootDir>/image).

import fs from 'node:fs';
import path from 'node:path';

export const IMAGE_EXTENSIONS = ['.safetensors', '.gguf'];
const MIN_IMAGE_MODEL_BYTES = 64 * 1024 * 1024; // настоящий чекпоинт SD не бывает меньше ~64 МБ

/** Магия/заголовок файла модели изображений (первые байты). */
export async function probeImageModel(file) {
  const st = await fs.promises.stat(file);
  if (st.size < MIN_IMAGE_MODEL_BYTES) {
    return { ok: false, reason: `Файл слишком мал для модели (${Math.round(st.size / 1048576)} МБ)` };
  }
  const fd = await fs.promises.open(file, 'r');
  try {
    const head = Buffer.alloc(512);
    await fd.read(head, 0, 512, 0);
    if (head.subarray(0, 4).toString('latin1') === 'GGUF') {
      return { ok: true, format: 'gguf', sizeBytes: st.size };
    }
    // safetensors: первые 8 байт — LE u64 длина заголовка, далее JSON '{'…
    const headerLen = head.readUIntLE(0, 6); // u64 читаем как 6 байт — достаточно
    if (headerLen > 8 && headerLen < 100 * 1024 * 1024 && head[8] === 0x7b /* '{' */) {
      return { ok: true, format: 'safetensors', sizeBytes: st.size };
    }
    return { ok: false, reason: 'Не похож на safetensors/gguf чекпоинт (магия не распознана)' };
  } finally {
    await fd.close().catch(() => { });
  }
}

/** Короткое имя без пути (защита от обхода папок). */
export function safeImageModelName(name) {
  const base = String(name || '').split(/[\\/]/).pop();
  if (!IMAGE_EXTENSIONS.some((e) => base.toLowerCase().endsWith(e))) {
    throw new Error('Имя модели должно оканчиваться на .safetensors или .gguf.');
  }
  if (base.startsWith('.')) throw new Error('Скрытые файлы недопустимы.');
  if (/[^\w.\-+() ]/.test(base)) throw new Error('Имя файла содержит недопустимые символы.');
  return base;
}

/**
 * Сканировать папку моделей изображений. Возвращает массив:
 * { id, file, name, format, sizeBytes, ok, reason }
 */
export async function scanImageModels(modelsDir) {
  const out = [];
  let entries = [];
  try { entries = await fs.promises.readdir(modelsDir, { withFileTypes: true }); }
  catch { return out; } // папки нет — моделей нет (это не ошибка)
  for (const ent of entries) {
    if (!ent.isFile()) continue;
    const lower = ent.name.toLowerCase();
    if (!IMAGE_EXTENSIONS.some((e) => lower.endsWith(e))) continue;
    const file = path.join(modelsDir, ent.name);
    const probe = await probeImageModel(file).catch((e) => ({ ok: false, reason: e.message }));
    out.push({
      id: 'img:' + ent.name,
      file,
      name: ent.name,
      format: probe.format ?? null,
      sizeBytes: probe.sizeBytes ?? null,
      ok: Boolean(probe.ok),
      reason: probe.reason ?? null
    });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}
