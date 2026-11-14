// LiteMind Engine — задачи и напоминания (ТЗ v0.6.4, компаньон §4).
//
// Хранение: JSON-файл tasks.json рядом с config.json — напоминания переживают
// перезапуск LiteMind (ТЗ §4: «должны срабатывать даже после перезапуска»).
// Планировщик: setInterval 20 с — проверка просроченных задач; срабатывание
// ровно один раз (notifiedAt), повторяющиеся получают следующую дату.
// Уведомление уходит колбэком onDue: UI тост + уведомление Windows + опционально TTS.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const MAX_TASKS = 300;
const TICK_MS = 20_000;

export class TaskStore {
  constructor(dir, { logger = null, onDue = null } = {}) {
    this.dir = dir;
    this.log = logger;
    this.file = path.join(dir, 'tasks.json');
    this.tasks = [];
    this.onDue = onDue; // async (task) => void
    this._chain = Promise.resolve();
    this._timer = null;
    this._load();
    this.start();
  }

  _load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (Array.isArray(raw.tasks)) this.tasks = raw.tasks.filter((t) => t && typeof t.text === 'string');
    } catch {
      /* первый запуск */
    }
    // Перезапуск приложения: просроченные, но не сработавшие задачи сработают
    // на первом тике (ТЗ: напоминания выживают после перезапуска).
  }

  _persist() {
    this._chain = this._chain.then(async () => {
      try {
        await fsp.mkdir(this.dir, { recursive: true });
        const tmp = this.file + '.tmp';
        await fsp.writeFile(tmp, JSON.stringify({ tasks: this.tasks }, null, 2));
        await fsp.rename(tmp, this.file);
      } catch (err) {
        this.log?.warn?.('tasks persist failed', { error: String(err?.message ?? err) });
      }
    });
    return this._chain;
  }

  start() {
    if (this._timer) return;
    this._timer = setInterval(() => this._tick().catch(() => {}), TICK_MS);
    this._timer.unref?.();
    void this._tick().catch(() => {});
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }

  add({ text, dueAt = null, repeat = 'none', source = 'user', tags = [] }) {
    const clean = String(text ?? '').replace(/\s+/g, ' ').trim();
    if (!clean) throw Object.assign(new Error('пустой текст задачи'), { status: 400 });
    let due = null;
    if (dueAt) {
      due = new Date(dueAt);
      if (Number.isNaN(due.getTime())) throw Object.assign(new Error('некорректная дата напоминания'), { status: 400 });
    }
    if (!['none', 'daily', 'weekdays', 'weekly'].includes(repeat)) repeat = 'none';
    const task = {
      id: `task_${randomUUID().slice(0, 10)}`,
      text: clean.slice(0, 500),
      dueAt: due ? due.toISOString() : null,
      repeat,
      done: false,
      notifiedAt: null,
      source,
      tags: tags.slice(0, 6),
      createdAt: new Date().toISOString()
    };
    this.tasks.unshift(task);
    if (this.tasks.length > MAX_TASKS) {
      // Удаляем самые старые выполненные; если их нет — самую старую запись.
      const doneIdx = [...this.tasks].reverse().findIndex((t) => t.done);
      if (doneIdx >= 0) this.tasks.splice(this.tasks.length - 1 - doneIdx, 1);
      else this.tasks.pop();
    }
    void this._persist();
    return task;
  }

  list({ includeDone = true } = {}) {
    const active = this.tasks.filter((t) => !t.done);
    const done = this.tasks.filter((t) => t.done);
    const byDue = (a, b) => (a.dueAt ? Date.parse(a.dueAt) : Infinity) - (b.dueAt ? Date.parse(b.dueAt) : Infinity);
    const out = [...active].sort(byDue);
    if (includeDone) out.push(...[...done].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 50));
    return out;
  }

  dueSoon(hours = 24) {
    const limit = Date.now() + hours * 3600_000;
    return this.tasks.filter((t) => !t.done && t.dueAt && Date.parse(t.dueAt) <= limit)
      .sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt));
  }

  complete(id) {
    const t = this.tasks.find((x) => x.id === id);
    if (!t) return null;
    t.done = true;
    t.doneAt = new Date().toISOString();
    void this._persist();
    return t;
  }

  /** Вернуть в работу. */
  reopen(id) {
    const t = this.tasks.find((x) => x.id === id);
    if (!t) return null;
    t.done = false;
    delete t.doneAt;
    void this._persist();
    return t;
  }

  remove(id) {
    const before = this.tasks.length;
    this.tasks = this.tasks.filter((t) => t.id !== id);
    if (this.tasks.length === before) return false;
    void this._persist();
    return true;
  }

  clearDone() {
    this.tasks = this.tasks.filter((t) => !t.done);
    void this._persist();
  }

  stats() {
    return {
      active: this.tasks.filter((t) => !t.done).length,
      done: this.tasks.filter((t) => t.done).length,
      pendingReminders: this.tasks.filter((t) => !t.done && t.dueAt && !t.notifiedAt).length
    };
  }

  /** Тик планировщика: срабатывание просроченных напоминаний. */
  async _tick() {
    const now = Date.now();
    const due = this.tasks.filter((t) => !t.done && t.dueAt && !t.notifiedAt && Date.parse(t.dueAt) <= now);
    for (const t of due) {
      t.notifiedAt = new Date().toISOString();
      if (t.repeat !== 'none') {
        // Вычислить следующее срабатывание.
        const base = new Date(t.dueAt);
        do {
          if (t.repeat === 'daily') base.setDate(base.getDate() + 1);
          else if (t.repeat === 'weekly') base.setDate(base.getDate() + 7);
          else if (t.repeat === 'weekdays') {
            do { base.setDate(base.getDate() + 1); } while (base.getDay() === 0 || base.getDay() === 6);
          }
        } while (base.getTime() <= now);
        t.dueAt = base.toISOString();
        t.notifiedAt = null; // будущий повтор снова ждёт срабатывания
        // Сохраняем факт последнего срабатывания отдельным полем (для истории).
        t.lastFiredAt = new Date().toISOString();
      }
      try {
        await this.onDue?.(t);
      } catch (err) {
        this.log?.warn?.('task onDue handler failed', { id: t.id, error: String(err?.message ?? err) });
      }
    }
    if (due.length) await this._persist();
  }
}
