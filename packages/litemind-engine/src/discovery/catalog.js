// Model Discovery — постоянный каталог найденных моделей (ТЗ v0.6.2 §5).
//
// Хранится в <configDir>/discovery/model-catalog.json рядом с config.json —
// переживает перезапуск приложения (критерий §11.9). Запись атомарная
// (tmp + rename), как у agent-sessions. Сеть недоступна → файл не трогаем,
// ранее найденные модели сохраняются (критерий §11.10).
//
// Дедупликация: ключ = «repo|fileName». Повторное появление того же файла
// из того же источника НЕ создаёт дубль (критерий §11.3). Изменение размера
// или SHA-256 помечает модель как обновлённую и сохраняет прежние версии
// (revisions, до 3) — ТЗ §8: возврат к предыдущей версии возможен, пока
// пользователь не удалил старый файл.

import fs from 'node:fs';
import path from 'node:path';

const CATALOG_FILE = 'model-catalog.json';
const MAX_REVISIONS = 3;

export function entryKey(repo, fileName) {
  return `${repo}|${fileName}`;
}

export class DiscoveryCatalog {
  constructor({ dir, logger = null } = {}) {
    this.dir = dir;
    this.logger = logger;
    this.file = path.join(dir, CATALOG_FILE);
    this.data = { version: 1, lastCheckAt: null, lastSuccessAt: null, lastError: null, entries: {} };
    this._chain = Promise.resolve(); // сериализация атомарных записей
  }

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (raw && typeof raw === 'object' && raw.entries && typeof raw.entries === 'object') {
        this.data = {
          version: 1,
          lastCheckAt: raw.lastCheckAt ?? null,
          lastSuccessAt: raw.lastSuccessAt ?? null,
          lastError: raw.lastError ?? null,
          entries: raw.entries
        };
      }
    } catch (err) {
      if (err.code !== 'ENOENT') {
        // Повреждённый файл не должен ломать приложение — начинаем пустой каталог.
        this.logger?.warn?.('discovery: каталог повреждён, начат заново', { error: err.message });
      }
    }
    return this;
  }

  /** Атомарное сохранение: сначала tmp-файл, затем rename. */
  save() {
    this._chain = this._chain.then(async () => {
      try {
        await fs.promises.mkdir(this.dir, { recursive: true });
        const tmp = `${this.file}.${process.pid}.tmp`;
        await fs.promises.writeFile(tmp, JSON.stringify(this.data, null, 1), 'utf8');
        await fs.promises.rename(tmp, this.file);
      } catch (err) {
        this.logger?.warn?.('discovery: не удалось сохранить каталог', { error: err.message });
      }
    }).catch(() => {});
    return this._chain;
  }

  get(key) {
    return this.data.entries[key] ?? null;
  }

  /** Сколько записей хранится (включая старые версии). */
  get size() {
    return Object.keys(this.data.entries).length;
  }

  /**
   * Слияние кандидата в каталог. Возвращает {entry, changed} —
   * changed = true, если запись создана или обновилась.
   */
  merge(candidate) {
    const key = entryKey(candidate.repo, candidate.name);
    const prev = this.data.entries[key];
    const now = new Date().toISOString();

    if (!prev) {
      const entry = {
        key,
        repo: candidate.repo,
        author: candidate.author ?? candidate.repo.split('/')[0] ?? null,
        name: candidate.name,
        url: candidate.url,
        sizeBytes: candidate.sizeBytes,
        sha256: candidate.sha256 ?? null,
        quant: candidate.quant ?? null,
        family: candidate.family ?? null,
        flavor: candidate.flavor ?? null,
        params: candidate.params ?? null,
        purposes: candidate.purposes ?? ['text'],
        speedClass: candidate.speedClass ?? 'medium',
        license: candidate.license ?? null,
        description: candidate.description ?? null,
        createdAt: candidate.createdAt ?? null,
        updatedAt: candidate.updatedAt ?? null,
        downloads: candidate.downloads ?? 0,
        likes: candidate.likes ?? 0,
        firstSeenAt: now,
        lastChangedAt: now,
        revisions: []
      };
      this.data.entries[key] = entry;
      return { entry, changed: true, isNew: true };
    }

    const sizeChanged = prev.sizeBytes !== candidate.sizeBytes;
    const shaChanged = !!(candidate.sha256 && prev.sha256 && candidate.sha256 !== prev.sha256);
    const urlChanged = prev.url !== candidate.url;
    if (!sizeChanged && !shaChanged && !urlChanged) {
      // Обновляем только вспомогательные метаданные, состояние не трогаем.
      prev.updatedAt = candidate.updatedAt ?? prev.updatedAt;
      prev.license = candidate.license ?? prev.license;
      prev.downloads = candidate.downloads ?? prev.downloads;
      prev.likes = candidate.likes ?? prev.likes;
      return { entry: prev, changed: false, isNew: false };
    }

    // Изменился файл в источнике — прежняя версия сохраняется в revisions.
    prev.revisions.push({
      sizeBytes: prev.sizeBytes,
      sha256: prev.sha256,
      url: prev.url,
      changedAt: prev.lastChangedAt
    });
    if (prev.revisions.length > MAX_REVISIONS) prev.revisions.shift();
    prev.sizeBytes = candidate.sizeBytes;
    prev.sha256 = candidate.sha256 ?? prev.sha256;
    prev.url = candidate.url;
    prev.updatedAt = candidate.updatedAt ?? prev.updatedAt;
    prev.lastChangedAt = now;
    return { entry: prev, changed: true, isNew: false };
  }

  /** Отметка времени проверки: attempt — любой прогон, success — удачный. */
  markCheck({ ok, error = null, at = new Date().toISOString() } = {}) {
    this.data.lastCheckAt = at;
    if (ok) {
      this.data.lastSuccessAt = at;
      this.data.lastError = null;
    } else {
      this.data.lastError = error ?? 'неизвестная ошибка';
    }
  }

  /** Отображаемое состояние (ТЗ §6): новинка / обновление / известная. */
  displayState(entry, { freshDays = 7 } = {}) {
    const age = (iso) => (iso ? (Date.now() - Date.parse(iso)) / 86400000 : Infinity);
    if (age(entry.firstSeenAt) <= freshDays) return 'new';
    if (age(entry.lastChangedAt) <= freshDays) return 'updated';
    return 'known';
  }

  /** Топ-N свежих записей по времени изменения источника. */
  listSorted({ limit = 400 } = {}) {
    const arr = Object.values(this.data.entries);
    arr.sort((a, b) => String(b.updatedAt ?? b.lastChangedAt ?? '').localeCompare(String(a.updatedAt ?? a.lastChangedAt ?? '')));
    return arr.slice(0, limit);
  }
}
