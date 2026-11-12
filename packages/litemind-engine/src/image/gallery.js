// Image Gallery — хранилище результатов генерации.
//
// Структура: <galleryDir>/<ts>-<id>.png + рядом <…>.json с параметрами
// (prompt, negative, model, размер, шаги, CFG, seed, время генерации).
// Каталог по умолчанию: E:\LiteMind\images (Windows) / tmp (прочие ОС) —
// отдельно от системных файлов приложения (ТЗ v0.6.1 §4).

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const SIDECAR_EXT = '.json';

function safeItemName(name) {
  const base = String(name || '').split(/[\\/]/).pop();
  if (!/^[A-Za-z0-9._\-+() ]+\.png$/i.test(base)) {
    throw new Error('Недопустимое имя файла галереи.');
  }
  return base;
}

export class ImageGallery {
  constructor(dir) {
    this.dir = path.resolve(dir);
  }

  async ensureDir() {
    await fs.promises.mkdir(this.dir, { recursive: true });
  }

  /** Новое имя результата: img-<дата>-<случайная часть>.png */
  newItemName() {
    const d = new Date();
    const stamp = [
      d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')
    ].join('') + '-' + String(d.getHours()).padStart(2, '0') + String(d.getMinutes()).padStart(2, '0') + String(d.getSeconds()).padStart(2, '0');
    return `img-${stamp}-${crypto.randomBytes(3).toString('hex')}.png`;
  }

  pathsFor(itemName) {
    const png = path.join(this.dir, safeItemName(itemName));
    const json = png.slice(0, -4) + SIDECAR_EXT;
    return { png, json };
  }

  /** Регистрация готового файла: перенос из tmp-пути и запись параметров. */
  async accept(tmpPng, meta) {
    await this.ensureDir();
    const name = this.newItemName();
    const { png, json } = this.pathsFor(name);
    await fs.promises.rename(tmpPng, png).catch(async () => {
      await fs.promises.copyFile(tmpPng, png);
      await fs.promises.unlink(tmpPng).catch(() => { });
    });
    const st = await fs.promises.stat(png);
    const record = { name, sizeBytes: st.size, createdAt: Date.now(), ...meta };
    await fs.promises.writeFile(json, JSON.stringify(record, null, 2), 'utf8');
    return record;
  }

  /** Список результатов (новые сверху). */
  async list() {
    let entries = [];
    try { entries = await fs.promises.readdir(this.dir, { withFileTypes: true }); }
    catch { return []; }
    const items = [];
    for (const ent of entries) {
      if (!ent.isFile() || !ent.name.toLowerCase().endsWith('.png')) continue;
      const { json } = this.pathsFor(ent.name);
      let meta = {};
      try { meta = JSON.parse(await fs.promises.readFile(json, 'utf8')); } catch { meta = {}; }
      let sizeBytes = null, mtimeMs = null;
      try {
        const st = await fs.promises.stat(path.join(this.dir, ent.name));
        sizeBytes = st.size; mtimeMs = st.mtimeMs;
      } catch { continue; }
      items.push({
        name: ent.name,
        sizeBytes,
        createdAt: meta.createdAt ?? Math.round(mtimeMs),
        prompt: meta.prompt ?? null,
        negative: meta.negative ?? null,
        model: meta.model ?? null,
        width: meta.width ?? null,
        height: meta.height ?? null,
        steps: meta.steps ?? null,
        cfg: meta.cfg ?? null,
        seed: meta.seed ?? null,
        durationMs: meta.durationMs ?? null
      });
    }
    items.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
    return items;
  }

  /** Путь PNG по имени (для отдачи файла и предпросмотра). */
  fileFor(itemName) {
    const { png } = this.pathsFor(itemName);
    return png;
  }

  /** Удалить результат + sidecar. */
  async remove(itemName) {
    const { png, json } = this.pathsFor(itemName);
    await fs.promises.unlink(png);
    await fs.promises.unlink(json).catch(() => { });
    return true;
  }
}
