// LiteMind Engine — долговременная память помощника (ТЗ v0.6.4, компаньон §3).
//
// Хранение: JSON-файл рядом с config.json (memory.json). Записи переживают
// перезапуск приложения. Всё локально — никаких внешних сервисов (ТЗ §3:
// «не передавать личные данные во внешние сервисы без явного разрешения»).
//
// Возможности: добавление (вручную/автоматом с пометкой источника), поиск по
// релевантности (пересечение слов), редактирование, удаление, полная очистка,
// запрет сохранения отдельных тем (запретный список пользователя).

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const MAX_ENTRIES = 500;
const MAX_TEXT_CHARS = 2000;

/** Нормализация для дедупликации и поиска. */
function normText(s) {
  return String(s ?? '').toLowerCase().replace(/[ё]/g, 'е').replace(/[^\wа-я\s-]/gi, ' ').replace(/\s+/g, ' ').trim();
}

/** Значимые слова для поиска (без стоп-слов). */
const STOP = new Set(['и', 'в', 'на', 'с', 'по', 'что', 'как', 'это', 'для', 'не', 'я', 'он', 'она', 'мы', 'вы', 'о', 'а', 'но', 'же', 'то', 'бы', 'из', 'у', 'к', 'за', 'от', 'до', 'при', 'the', 'a', 'an', 'of', 'to', 'in', 'is', 'are']);

export function keywordsOf(text) {
  return normText(text).split(' ').filter((w) => w.length > 2 && !STOP.has(w)).slice(0, 24);
}

export class MemoryStore {
  /**
   * @param {string} dir каталог данных (рядом с config.json)
   * @param {object} opts { logger }
   */
  constructor(dir, { logger = null } = {}) {
    this.dir = dir;
    this.log = logger;
    this.file = path.join(dir, 'memory.json');
    this.entries = [];
    this.blocked = []; // запрещённые темы (подстроки); сохранение такого текста отклоняется
    this._chain = Promise.resolve();
    this._load();
  }

  _load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (Array.isArray(raw.entries)) this.entries = raw.entries.filter((e) => e && typeof e.text === 'string');
      if (Array.isArray(raw.blocked)) this.blocked = raw.blocked.filter((b) => typeof b === 'string');
    } catch {
      /* первый запуск — пустая память */
    }
  }

  _persist() {
    this._chain = this._chain.then(async () => {
      try {
        await fsp.mkdir(this.dir, { recursive: true });
        const tmp = this.file + '.tmp';
        await fsp.writeFile(tmp, JSON.stringify({ entries: this.entries, blocked: this.blocked }, null, 2));
        await fsp.rename(tmp, this.file);
      } catch (err) {
        this.log?.warn?.('memory persist failed', { error: String(err?.message ?? err) });
      }
    });
    return this._chain;
  }

  _isBlocked(text) {
    const low = normText(text);
    return this.blocked.find((b) => low.includes(normText(b))) ?? null;
  }

  /**
   * Сохранить факт. Дубликат (совпадающая нормализованная текст) обновляет
   * существующую запись. Возвращает { entry, updated }.
   */
  add({ text, tags = [], source = 'user', pinned = false }) {
    const clean = String(text ?? '').replace(/\s+/g, ' ').trim();
    if (!clean) throw Object.assign(new Error('пустой текст памяти'), { status: 400 });
    if (clean.length > MAX_TEXT_CHARS) throw Object.assign(new Error(`текст длиннее ${MAX_TEXT_CHARS} символов`), { status: 400 });
    const blockedBy = this._isBlocked(clean);
    if (blockedBy) {
      throw Object.assign(new Error(`сохранение запрещено пользователем (тема «${blockedBy}»)`, { code: 'MEMORY_BLOCKED' }), { status: 403 });
    }
    const norm = normText(clean);
    const existing = this.entries.find((e) => normText(e.text) === norm);
    const now = new Date().toISOString();
    if (existing) {
      existing.text = clean;
      existing.updatedAt = now;
      existing.source = source;
      existing.tags = [...new Set([...(existing.tags ?? []), ...tags])].slice(0, 8);
      existing.pinned = existing.pinned || pinned === true;
      void this._persist();
      return { entry: existing, updated: true };
    }
    const entry = {
      id: `mem_${randomUUID().slice(0, 10)}`,
      text: clean,
      tags: tags.slice(0, 8),
      source, // 'user' (явная просьба) | 'auto' (автоматическое извлечение) | 'companion'
      pinned: pinned === true,
      createdAt: now,
      updatedAt: now
    };
    this.entries.unshift(entry);
    if (this.entries.length > MAX_ENTRIES) {
      // Вытесняем самые старые не-закреплённые записи.
      const idx = [...this.entries].reverse().findIndex((e) => !e.pinned);
      if (idx >= 0) this.entries.splice(this.entries.length - 1 - idx, 1);
      else this.entries.pop();
    }
    void this._persist();
    return { entry, updated: false };
  }

  /** Поиск по релевантности: пересечение ключевых слов, закреплённые всегда выше. */
  search(query, { limit = 6 } = {}) {
    const qWords = keywordsOf(query);
    if (!qWords.length) return this.entries.filter((e) => e.pinned).slice(0, limit);
    const scored = [];
    for (const e of this.entries) {
      const words = new Set(keywordsOf(e.text));
      let score = 0;
      for (const w of qWords) if (words.has(w)) score += 1;
      if (e.pinned) score += 0.5;
      if (score > 0) scored.push({ e, score: score / Math.max(1, qWords.length ** 0.5) });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit).map((x) => x.e);
  }

  update(id, { text = null, pinned = null } = {}) {
    const e = this.entries.find((x) => x.id === id);
    if (!e) return null;
    if (typeof text === 'string' && text.trim()) {
      const blockedBy = this._isBlocked(text);
      if (blockedBy) throw Object.assign(new Error(`сохранение запрещено (тема «${blockedBy}»)`, { code: 'MEMORY_BLOCKED' }), { status: 403 });
      e.text = text.replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT_CHARS);
    }
    if (pinned !== null) e.pinned = pinned === true;
    e.updatedAt = new Date().toISOString();
    void this._persist();
    return e;
  }

  remove(id) {
    const before = this.entries.length;
    this.entries = this.entries.filter((e) => e.id !== id);
    if (this.entries.length === before) return false;
    void this._persist();
    return true;
  }

  clear({ keepPinned = false } = {}) {
    this.entries = keepPinned ? this.entries.filter((e) => e.pinned) : [];
    void this._persist();
    return { remaining: this.entries.length };
  }

  /** Запретить сохранение темы (подстрока). */
  blockTopic(topic) {
    const t = String(topic ?? '').trim();
    if (!t) throw Object.assign(new Error('пустая тема'), { status: 400 });
    if (!this.blocked.includes(t)) {
      this.blocked.push(t);
      // Уже сохранённые записи с этой темой удаляем — запрет работает и задним числом.
      this.entries = this.entries.filter((e) => !normText(e.text).includes(normText(t)));
      void this._persist();
    }
    return { blocked: [...this.blocked] };
  }

  unblockTopic(topic) {
    this.blocked = this.blocked.filter((b) => b !== topic);
    void this._persist();
    return { blocked: [...this.blocked] };
  }

  stats() {
    return { count: this.entries.length, blocked: [...this.blocked] };
  }
}

/**
 * Автоматическое извлечение фактов из сообщений пользователя (дополнение §3:
 * «выделение важных фактов»). Консервативно: только явные саморассказы.
 * Возвращает строку факта или null. ВЫЗЫВАЕТСЯ только при включённом
 * autoMemory пользователем (по умолчанию выключено — приватность).
 */
export function extractAutoFact(userText) {
  const s = String(userText ?? '').replace(/\s+/g, ' ').trim();
  const patterns = [
    { re: /^меня зовут\s+(.{2,60})$/i, fmt: (m) => `Имя пользователя: ${m[1]}` },
    { re: /^я\s+(?:работаю|работаю в|тружусь)\s+(?:в\s+)?(.{2,80})$/i, fmt: (m) => `Работа пользователя: ${m[1]}` },
    { re: /^мой проект[,:]?\s+(.{2,120})$/i, fmt: (m) => `Проект пользователя: ${m[1]}` },
    { re: /^(?:я\s+)?(?:люблю|предпочитаю|нравится)\s+(.{2,120})$/i, fmt: (m) => `Предпочтение: ${m[1]}` },
    { re: /^я\s+(?:живу|нахожусь)\s+(?:в\s+)?(.{2,80})$/i, fmt: (m) => `Живёт в: ${m[1]}` },
    { re: /^м(?:ой|оя)\s+(?:город|стран[аы])\s*[—-]?\s*(.{2,60})$/i, fmt: (m) => `Местоположение: ${m[1]}` }
  ];
  for (const p of patterns) {
    const m = s.match(p.re);
    if (m) return p.fmt(m).trim();
  }
  return null;
}
