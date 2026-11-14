// LiteMind Engine — состояние компаньона (ТЗ v0.6.4, Roamies-дополнение §1/§8).
//
// Настройки персонажа живут в config.companion (перезапуск безопасен). Здесь:
// runtime-состояние (слушает/думает/говорит/выполняет задачу), журнал событий
// компаньона для панели «История действий» и шина событий для оверлея
// (Desktop получает их через SSE /api/companion/events).

import { randomUUID } from 'node:crypto';

const STATE_LABELS = {
  idle: 'Ждёт',
  listening: 'Слушает',
  thinking: 'Думает',
  speaking: 'Говорит',
  working: 'Выполняет задачу',
  searching: 'Ищет в интернете'
};

const MAX_EVENTS = 200;

export class CompanionHub {
  constructor({ config, logger = null } = {}) {
    this.config = config;
    this.log = logger;
    this.state = 'idle';
    this.stateDetail = null;
    this.events = []; // { id, at, type, text }
    this.listeners = new Set(); // SSE-ответы оверлея
    this.visible = true; // оверлей виден (управляет Desktop)
  }

  settings() {
    return { ...(this.config.companion ?? {}) };
  }

  updateSettings(patch = {}) {
    const c = this.config.companion ?? (this.config.companion = {});
    const allowed = ['enabled', 'character', 'size', 'opacity', 'alwaysOnTop', 'autoShowOnStart'];
    for (const k of allowed) {
      if (k in patch) c[k] = patch[k];
    }
    if ('position' in patch && patch.position && Number.isFinite(patch.position.x) && Number.isFinite(patch.position.y)) {
      c.position = { x: Math.round(patch.position.x), y: Math.round(patch.position.y) };
    }
    // Ограничения честных значений.
    c.size = Math.max(80, Math.min(280, Math.round(Number(c.size) || 140)));
    c.opacity = Math.max(0.4, Math.min(1, Number(c.opacity) || 0.95));
    this.emit('settings', { settings: c });
    return c;
  }

  label() {
    return STATE_LABELS[this.state] ?? this.state;
  }

  /** Смена состояния (движок/голос/агент сообщают о работе). */
  setState(state, detail = null) {
    if (!STATE_LABELS[state] && state !== 'idle') return this.status();
    this.state = state;
    this.stateDetail = detail ?? null;
    this.emit('state', { state, label: this.label(), detail });
    return this.status();
  }

  visibleNow() {
    return this.visible;
  }

  setVisible(v) {
    this.visible = v === true;
    this.emit('visible', { visible: this.visible });
  }

  /** Записать событие в историю действий компаньона. */
  event(type, text) {
    const e = { id: `ev_${randomUUID().slice(0, 8)}`, at: new Date().toISOString(), type: String(type ?? 'note').slice(0, 24), text: String(text ?? '').slice(0, 400) };
    this.events.unshift(e);
    if (this.events.length > MAX_EVENTS) this.events.length = MAX_EVENTS;
    this.emit('event', e);
    return e;
  }

  eventsList({ limit = 60 } = {}) {
    return this.events.slice(0, limit);
  }

  status() {
    return {
      state: this.state,
      stateLabel: this.label(),
      stateDetail: this.stateDetail,
      visible: this.visible,
      settings: this.settings(),
      voice: this.config.voice ?? {}
    };
  }

  // ── SSE для оверлея ────────────────────────────────────────────────────────

  subscribe(res) {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'access-control-allow-origin': '*',
      'x-accel-buffering': 'no'
    });
    res.write(`data: ${JSON.stringify({ type: 'hello', status: this.status() })}\n\n`);
    this.listeners.add(res);
    const ping = setInterval(() => { try { res.write(':ping\n\n'); } catch { /* */ } }, 15000);
    res.on('close', () => { clearInterval(ping); this.listeners.delete(res); });
  }

  emit(type, payload) {
    const data = `data: ${JSON.stringify({ type, ...payload })}\n\n`;
    for (const res of this.listeners) {
      try { res.write(data); } catch { this.listeners.delete(res); }
    }
  }
}
