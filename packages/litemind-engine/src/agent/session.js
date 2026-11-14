// LiteMind Agent — диалоговые сессии и цикл Agent → Tool → Result.
//
// Сессия — полноценный диалог (ТЗ AI Agent + дополнение): пользователь пишет
// сообщения на русском, агент отвечает текстом, строит план, вызывает
// инструменты (реальное исполнение), показывает diff и ждёт подтверждения,
// принимает уточнения во время работы. Всё состояние сохраняется на диск —
// диалог и задача переживают перезапуск приложения.
//
// Протокол модели (текстовый, устойчив на малых GGUF-моделях):
//   TEXT: {"text": "..."}            — обычный ответ в диалоге
//   ACTION: {"tool":"...","args":{}} — вызов инструмента
//   ASK: {"question":"..."}          — вопрос пользователю (пауза)
//   DONE: {"summary":"..."}          — завершение задачи с отчётом
// Парсер устойчив к ```-заборам, префиксам и лишнему тексту вокруг.

import fsp from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { createToolRegistry, toolsPromptLine } from './tools.js';
import { verifyToolAnswers } from '../intelligence/layer.js';
import { extractText, AttachmentError } from '../attachments/extract.js';

const DEFAULTS = {
  maxSteps: 24,                 // максимум вызовов инструментов на один прогон
  stepMaxOutputTokens: 800,     // ответ модели на шаг (ACTION-блок короткий)
  maxRuntimeMs: 20 * 60_000,    // предохранитель по времени на прогон
  maxDialogChars: 600_000,      // физический предел истории сессии
  toolResultChars: 6_000,       // сколько символов результата инструмента уходит модели
  // ТЗ v0.6.4 (агент §6): предел на ОДИН шаг модели. Раньше «Обдумывание шага»
  // могло висеть вечно (медленный prefill/перезапуск модели), пользователь не
  // получал ни ответа, ни ошибки. Теперь шаг, дольше 5 минут, честно завершается
  // ошибкой с понятным сообщением и возможностью повторить/остановить.
  stepTimeoutMs: 5 * 60_000
};

const STATE_LABEL = {
  idle: 'Готов',
  running: 'Выполняет задачу',
  awaiting_confirmation: 'Ожидает подтверждения',
  waiting_user: 'Ждёт ответа',
  done: 'Завершено',
  error: 'Ошибка',
  stopped: 'Остановлено'
};

function nowIso() { return new Date().toISOString(); }

/** Достать первое вхождение маркера из текста модели (устойчиво к ``` и мусору). */
export function parseAgentReply(raw) {
  const text = String(raw ?? '');
  const markers = ['DONE', 'ACTION', 'ASK', 'TEXT'];
  for (const m of markers) {
    // маркер в начале строки (после ```/пробелов/рассуждений), JSON — до конца строки или блока
    const re = new RegExp(`(?:^|\\n)[^\\n{}]*?${m}\\s*:\\s*`, 'i');
    const match = re.exec(text);
    if (!match) continue;
    const rest = text.slice(match.index + match[0].length);
    const jsonStr = extractJson(rest);
    if (jsonStr == null) continue;
    try {
      const obj = JSON.parse(jsonStr);
      const before = text.slice(0, match.index).trim();
      return { kind: m.toLowerCase(), data: obj, preamble: stripNoise(before) };
    } catch { /* попробуем следующий маркер */ }
  }
  // ни одного корректного маркера — считаем весь ответ обычным текстом,
  // отрезав служебные заборы
  const clean = stripNoise(text);
  if (!clean) return null;
  return { kind: 'text', data: { text: clean }, preamble: '' };
}

/** Вырезать JSON-объект: {...} с учётом вложенности и строк. */
function extractJson(s) {
  const start = s.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

function stripNoise(s) {
  return String(s ?? '')
    .replace(/```[a-z]*\n?/gi, '')
    .replace(/<\/?think>/gi, '')
    .trim();
}

export class AgentManager {
  /**
   * @param {object} opts
   * @param opts.config     конфиг движка (config.paths.configPath — база данных)
   * @param opts.engine     Engine (для generate)
   * @param opts.logger
   * @param opts.generateFn инъекция генерации для тестов (по умолчанию engine.generate)
   */
  constructor({ config, engine, logger = null, generateFn = null } = {}) {
    this.config = config;
    this.engine = engine;
    this.log = logger;
    this.generateFn = generateFn
      ? (args) => generateFn(args)
      : (args) => engine.generate(args);
    this.tools = createToolRegistry({ config, logger });
    this.sessions = new Map();
    this.subscribers = new Map(); // id → Set<res>
    const cfg = { ...DEFAULTS, ...(config.agent ?? {}) };
    this.limits = cfg;
    this.dir = path.join(path.dirname(config.paths.configPath), 'agent-sessions');
    fs.mkdirSync(this.dir, { recursive: true });
    this._persistChain = Promise.resolve(); // сериализация записи на диск
    this._webCtx = { enabled: false, fetchText: null, github: null }; // до setWebContext()
    this._loadExisting();
  }

  // ── Хранилище ────────────────────────────────────────────────────────────

  _file(id) { return path.join(this.dir, `${id}.json`); }

  _loadExisting() {
    let names = [];
    try { names = fs.readdirSync(this.dir); } catch { return; }
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      try {
        const s = JSON.parse(fs.readFileSync(path.join(this.dir, name), 'utf8'));
        // прогон, прерванный перезапуском процесса, не «running» — он остановлен
        if (s.state === 'running' || s.state === 'awaiting_confirmation' || s.state === 'waiting_user') {
          if (s.state === 'running') s.state = 'stopped';
        }
        this.sessions.set(s.id, s);
      } catch { /* повреждённый файл сессии не роняет движок */ }
    }
  }

  _persist(s) {
    // serialize: две одновременные записи в один tmp-файл недопустимы
    s.updatedAt = nowIso();
    this._persistChain = this._persistChain.then(async () => {
      const tmp = this._file(s.id) + '.tmp';
      try {
        await fsp.writeFile(tmp, JSON.stringify(s));
        await fsp.rename(tmp, this._file(s.id));
      } catch (err) {
        this.log?.warn?.('agent persist failed', { id: s.id, error: String(err?.message ?? err) });
      }
    });
    return this._persistChain;
  }

  // ── Публичный API ────────────────────────────────────────────────────────

  createSession({ title = null, projectDir = null, model = null, autoApprove = false } = {}) {
    const s = {
      id: `agt_${randomUUID().slice(0, 12)}`,
      title: title ? String(title).slice(0, 80) : 'Новая задача агента',
      createdAt: nowIso(),
      updatedAt: nowIso(),
      projectDir: projectDir ? path.resolve(String(projectDir)) : null,
      model: model || null,
      autoApprove: autoApprove === true,
      state: 'idle',
      plan: [],
      currentStage: null,
      messages: [],           // диалог: {id, role, ...}
      pendingApproval: null,
      inbox: [],              // непрочитанные сообщения (транзиент)
      cursor: 0,              // id последнего сообщения/события
      stats: { steps: 0, runs: 0, startedAt: null, endedAt: null },
      error: null
    };
    this.sessions.set(s.id, s);
    void this._persist(s);
    return this.publicView(s);
  }

  listSessions() {
    return [...this.sessions.values()]
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map((s) => this.publicView(s));
  }

  /** Сводный статус для боковой панели (ТЗ §3). */
  status() {
    const list = this.listSessions();
    const active = list.find((s) => ['running', 'awaiting_confirmation', 'waiting_user'].includes(s.state));
    return {
      hasActive: !!active,
      active: active ?? null,
      counts: {
        total: list.length,
        running: list.filter((s) => s.state === 'running').length,
        awaiting_confirmation: list.filter((s) => s.state === 'awaiting_confirmation').length,
        waiting_user: list.filter((s) => s.state === 'waiting_user').length,
        error: list.filter((s) => s.state === 'error').length
      }
    };
  }

  publicView(s) {
    return {
      id: s.id, title: s.title, state: s.state, stateLabel: STATE_LABEL[s.state] ?? s.state,
      projectDir: s.projectDir, model: s.model, autoApprove: !!s.autoApprove,
      plan: s.plan, currentStage: s.currentStage,
      pendingApproval: s.pendingApproval ? { ...s.pendingApproval, _apply: undefined } : null,
      messagesCount: s.messages.length,
      createdAt: s.createdAt, updatedAt: s.updatedAt,
      stats: { steps: s.stats.steps, runs: s.stats.runs },
      error: s.error
    };
  }

  getSession(id) {
    const s = this.sessions.get(String(id));
    if (!s) throw Object.assign(new Error('сессия агента не найдена'), { status: 404 });
    return s;
  }

  /** Полная сессия для UI (диалог). */
  fullView(id) {
    const s = this.getSession(id);
    return { ...this.publicView(s), messages: s.messages, cursor: s.cursor };
  }

  async deleteSession(id) {
    const s = this.getSession(id);
    if (s.state === 'running') await this.stop(id);
    this.sessions.delete(s.id);
    try { await fsp.unlink(this._file(s.id)); } catch { /* уже удалена */ }
    return { ok: true };
  }

  /**
   * Сообщение пользователя (в любой момент: во время задачи — учтётся на границе шага).
   * По умолчанию НЕ ждёт завершения прогона (HTTP и UI не блокируются);
   * тесты передают { wait: true }.
   */
  async postMessage(id, { text = '', attachments = null, projectDir = null, autoApprove = null, wait = false } = {}) {
    const s = this.getSession(id);
    if (projectDir) s.projectDir = path.resolve(String(projectDir));
    if (autoApprove !== null) s.autoApprove = autoApprove === true;

    let full = String(text ?? '').trim();
    if (Array.isArray(attachments) && attachments.length) {
      for (const a of attachments.slice(0, 6)) {
        try {
          const buf = Buffer.from(String(a.dataBase64 ?? ''), 'base64');
          const extracted = extractText(String(a.name ?? 'file'), buf);
          full += `\n\n[вложение: ${a.name}]\n` + String(extracted).slice(0, 20_000);
        } catch (e) {
          const msg = e instanceof AttachmentError ? e.message : 'не удалось прочитать вложение';
          this._append(s, { role: 'event', type: 'error', text: `вложение ${a.name}: ${msg}` });
        }
      }
    }
    if (!full && !s.pendingApproval) {
      throw Object.assign(new Error('пустое сообщение'), { status: 400 });
    }
    this._append(s, { role: 'user', text: full });
    s.title = s.title === 'Новая задача агента' && full
      ? full.replace(/\s+/g, ' ').slice(0, 60) : s.title;

    // если агент ждёт ответа/стоял — запускаем цикл; если работает — сообщение
    // подхватится на ближайшей границе шага. Цикл живёт в фоне: HTTP и UI
    // не блокируются на время задачи (ТЗ: уточнения во время выполнения).
    if (s.state !== 'running') {
      if (wait) await this._kick(s);
      else void this._kick(s);
    } else {
      void this._persist(s);
    }
    return this.publicView(s);
  }

  /** Решение по подтверждению (diff-карточка): approve/reject + отзыв. Не блокирует HTTP. */
  async decide(id, { approvalId, approved, feedback = '', wait = false } = {}) {
    const s = this.getSession(id);
    if (!s.pendingApproval || s.pendingApproval.id !== approvalId) {
      throw Object.assign(new Error('нет активного подтверждения с таким id'), { status: 409 });
    }
    const pa = s.pendingApproval;
    s.pendingApproval = null;
    if (approved) {
      this._append(s, { role: 'event', type: 'confirmation', decision: 'approved', text: `изменение подтверждено: ${pa.tool}`, change: pa.change });
      let result;
      if (typeof pa.apply !== 'function') {
        // подтверждение пережило перезапуск процесса — функция применения недоступна
        result = { ok: false, result: 'изменение не может быть применено: приложение перезапускалось после запроса. Попросите агента повторить действие.' };
      } else {
        try {
          result = await pa.apply();
        } catch (err) {
          result = { ok: false, result: `ошибка применения: ${err.message}` };
        }
      }
      this._append(s, {
        role: 'tool', tool: pa.tool, args: pa.args, ok: result.ok !== false,
        result: result.result ?? '', ts: nowIso()
      });
      s.state = 'running';
      s.currentStage = 'продолжение после подтверждения'; // стадия сбрасывается _stage() в цикле
      void this._persist(s);
      if (wait) await this._kick(s);
      else void this._kick(s);
    } else {
      this._append(s, { role: 'event', type: 'confirmation', decision: 'rejected', text: `изменение отклонено: ${pa.tool}`, change: pa.change });
      this._append(s, {
        role: 'tool', tool: pa.tool, args: pa.args, ok: false,
        result: `ПОЛЬЗОВАТЕЛЬ ОТКЛОНИЛ изменение${feedback ? `, комментарий: «${feedback}»` : ''}. Предложи другой подход или уточни требования.`
      });
      s.state = 'running';
      void this._persist(s);
      if (wait) await this._kick(s);
      else void this._kick(s);
    }
    return this.publicView(s);
  }

  async stop(id) {
    const s = this.getSession(id);
    if (s._ctrl) { try { s._ctrl.abort(new Error('остановлено пользователем')); } catch { /* */ } }
    // убить запущенные агентом команды (ТЗ: корректная остановка процессов)
    for (const kill of s._termKills ?? []) { try { kill(); } catch { /* */ } }
    s._termKills = [];
    if (s.state === 'running') {
      s.state = 'stopped';
      s.stats.endedAt = nowIso();
      this._append(s, { role: 'event', type: 'stopped', text: 'задача остановлена пользователем (можно продолжить сообщением)' });
      await this._persist(s);
    }
    return this.publicView(s);
  }

  // ── SSE ──────────────────────────────────────────────────────────────────

  subscribe(id, res, { cursor = null } = {}) {
    const s = this.getSession(id);
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'access-control-allow-origin': '*'
    });
    res.write(':ok\n\n');
    // реплей с курсора (переподключение UI)
    const from = Number.isFinite(Number(cursor)) ? Number(cursor) : 0;
    for (const m of s.messages) {
      if (m.id > from) res.write(`id: ${m.id}\ndata: ${JSON.stringify(m)}\n\n`);
    }
    let set = this.subscribers.get(s.id);
    if (!set) { set = new Set(); this.subscribers.set(s.id, set); }
    set.add(res);
    const ping = setInterval(() => { try { res.write(':ping\n\n'); } catch { /* */ } }, 15000);
    res.on('close', () => { clearInterval(ping); set.delete(res); });
  }

  _broadcast(s, msg) {
    const set = this.subscribers.get(s.id);
    if (!set) return;
    const payload = `id: ${msg.id}\ndata: ${JSON.stringify(msg)}\n\n`;
    for (const res of set) { try { res.write(payload); } catch { set.delete(res); } }
  }

  _append(s, msg) {
    const m = { id: ++s.cursor, ts: nowIso(), ...msg };
    s.messages.push(m);
    if (s.messages.length > 400) s.messages.splice(0, s.messages.length - 400); // физический предел
    this._broadcast(s, m);
    void this._persist(s);
    return m;
  }

  // ── Цикл агента ──────────────────────────────────────────────────────────

  async _kick(s) {
    // Если прежний прогон ещё разматывается (стоп/подтверждение) — ставим
    // очередь: новый запуск произойдёт сразу после его завершения.
    if (s._running) { s._kickQueued = true; return; }
    s._running = true;
    try {
      do {
        s._kickQueued = false;
        try {
          await this._runLoop(s);
        } catch (err) {
          if (s.state !== 'stopped') {
            s.state = 'error';
            s.error = String(err?.message ?? err).slice(0, 400);
            s.stats.endedAt = nowIso();
            this._append(s, { role: 'event', type: 'error', text: `ошибка агента: ${s.error}` });
          }
        }
        await this._persist(s);
      } while (s._kickQueued);
    } finally {
      s._running = false;
      s._ctrl = null;
      await this._persist(s);
    }
  }

  _assertProject(s) {
    // Проект обязателен только для инструментов (они сами проверяют ctx.projectRoot).
    // Здесь проверяем лишь то, что указанная папка существует.
    if (s.projectDir && (!fs.existsSync(s.projectDir) || !fs.statSync(s.projectDir).isDirectory())) {
      throw Object.assign(new Error(`папка проекта недоступна: ${s.projectDir}`), { status: 400 });
    }
  }

  /** Диалог → payload для модели (система + компактная история). */
  _buildMessages(s) {
    const sys = this._systemPrompt(s);
    const keep = 16; // последние 16 записей целиком
    const history = [];
    const older = s.messages.slice(0, Math.max(0, s.messages.length - keep));
    const recent = s.messages.slice(-keep);
    if (older.length) {
      const summary = older.slice(-8).map((m) => {
        if (m.role === 'user') return `пользователь: ${String(m.text).slice(0, 120)}`;
        if (m.role === 'assistant') return `агент: ${String(m.text).slice(0, 120)}`;
        if (m.role === 'tool') return `инструмент ${m.tool}: ${m.ok ? 'выполнен' : 'ошибка'}`;
        if (m.type === 'confirmation') return `подтверждение: ${m.decision}`;
        return null;
      }).filter(Boolean).join('\n');
      history.push({ role: 'user', content: `[контекст: начало диалога]\n${summary}\n[конец краткого контекста]` });
      history.push({ role: 'assistant', content: 'Принято, продолжаю с учётом истории.' });
    }
    for (const m of recent) {
      if (m.role === 'user') history.push({ role: 'user', content: m.text });
      else if (m.role === 'assistant') history.push({ role: 'assistant', content: m.text });
      else if (m.role === 'tool') {
        history.push({
          role: 'user',
          content: `[результат инструмента ${m.tool}] ${m.ok ? '' : 'ОШИБКА: '}${String(m.result).slice(0, this.limits.toolResultChars)}`
        });
      } else if (m.role === 'event') {
        if (m.type === 'confirmation' && m.decision) {
          history.push({ role: 'user', content: `[пользователь ${m.decision === 'approved' ? 'подтвердил' : 'отклонил'} изменение: ${m.change?.tool ?? ''}]` });
        }
        // прочие события в модель не идут
      }
    }
    return [{ role: 'system', content: sys }, ...history];
  }

  _systemPrompt(s) {
    return [
      'Ты — AI Agent внутри приложения LiteMind, работаешь на компьютере пользователя Windows.',
      '/no_think',
      `Твоя рабочая папка (корень проекта): ${s.projectDir ?? '(не задана)'}`,
      'Все пути файлов указывай ОТНОСИТЕЛЬНО корня проекта, слэши — обычные /.',
      '',
      'ДОСТУПНЫЕ ИНСТРУМЕНТЫ:',
      toolsPromptLine(),
      '',
      'ФОРМАТ КАЖДОГО ОТВЕТА (строго один блок, без markdown-заборов вокруг):',
      'ACTION: {"tool":"имя","args":{...}} — выполнить один шаг инструментом',
      'TEXT: {"text":"..."} — обычный ответ/пояснение без действий',
      'ASK: {"question":"..."} — задать вопрос пользователю и подождать',
      'DONE: {"summary":"итог","created":["..."],"modified":["..."],"failed":["..."]} — задача выполнена',
      '',
      'ПРАВИЛА:',
      '- Перед первым действием для нетривиальной задачи кратко напиши план по-русски, затем вызывай инструменты.',
      '- Один ответ = один ACTION (или TEXT/ASK/DONE). JSON валидный, в одну строку.',
      '- Содержимое файлов передавай в write_file.args.content целиком.',
      '- После каждого инструмента ты получишь [результат инструмента] — учитывай его.',
      '- Изменения файлов и команды терминала пользователь подтверждает сам; если пользователь отклонил — предложи другой способ.',
      '- Уточнение пользователя во время задачи — продолжай текущую задачу с учётом уточнения. Новое поручение — составь новый план.',
      '- Если задача не требует инструментов (просто поболтать/объяснить) — отвечай TEXT.',
      '- КАТЕГОРИЧЕСКИ ЗАПРЕЩЕНО: отвечать DONE или TEXT «я создал/выполнил», если ты не вызвал инструмент и не получил [результат инструмента]. Действия выполняются ТОЛЬКО инструментами.',
      '- Пиши по-русски, кратко и по делу.',
      '',
      'ПРИМЕР ПРАВИЛЬНОЙ РАБОТЫ.',
      'Пользователь: «Создай файл a.txt с текстом привет».',
      'Твой ход 1: ACTION: {"tool":"write_file","args":{"path":"a.txt","content":"привет"}}',
      'Система: [результат инструмента write_file] файл записан: a.txt',
      'Твой ход 2: DONE: {"summary":"файл a.txt создан","created":["a.txt"]}',
      '',
      'ПРИМЕР НЕПРАВИЛЬНО (так нельзя): сразу ответить DONE: {"summary":"файл создан"} — файл НЕ создан, отчёт ложный.',
      '',
      'ПРИМЕР 2. Пользователь: «покажи файлы проекта». Твой ход 1: ACTION: {"tool":"list_files","args":{}} — затем краткий TEXT со списком.',
      '',
      'ПРИМЕР 3 (terminal — аргумент command ОБЯЗАТЕЛЕН). Пользователь: «выполни команду echo ok».',
      'Твой ход 1: ACTION: {"tool":"terminal","args":{"command":"echo ok"}}',
      'Система: [результат инструмента terminal] код завершения: 0 … вывод команды …',
      'Твой ход 2: TEXT: {"text":"Команда выполнилась, вывод: …"} или DONE с итогом.',
      'Нельзя вызывать terminal с пустыми args — команду всегда указывай в args.command.'
    ].join('\n');
  }

  /**
   * v0.6.1: модель сессии по умолчанию. Раньше сессия без явной модели уходила
   * в engine.generate с model: undefined и падала с «Model "undefined" is not
   * available locally» — локальные тесты этого не ловили, потому что мокали
   * generateFn. Теперь: явная модель сессии → загруженная прямо сейчас →
   * первая совместимая локальная модель (выбор запоминается в сессии).
   */
  async _resolveModel(s) {
    if (s.model) return s.model;
    try {
      const runtime = await this.engine?.modelRuntime?.();
      const active = (runtime ?? []).find((m) => m?.id && m.state === 'running');
      if (active?.id) { s.model = active.id; return s.model; }
    } catch { /* движок может быть ещё не запущен — попробуем список моделей */ }
    try {
      const models = await this.engine?.listModels?.();
      const compatible = (models ?? []).filter((m) => m?.compatible !== false);
      const pick = compatible[0] ?? (models ?? [])[0];
      if (pick?.id) { s.model = pick.id; this._append(s, { role: 'event', type: 'note', text: `модель не задана — использую «${pick.id}»` }); return s.model; }
    } catch { /* нет ни одной модели — честная ошибка ниже */ }
    // Живой движок без моделей — честный отказ; тестовый режим (engine: null,
    // generateFn — мок) принимает undefined, как до появления _resolveModel.
    if (this.engine) {
      throw Object.assign(new Error('нет доступной локальной модели: установите или скачайте GGUF-модель и повторите'), { status: 409 });
    }
    return undefined;
  }

  /** Видимый статус этапа: в сессию + мгновенно в SSE (не хранится в диалоге). */
  _stage(s, text) {
    s.currentStage = text;
    this._broadcast(s, { id: s.cursor, role: 'stage', text, ts: nowIso(), _transient: true });
  }

  /**
   * ТЗ v0.6.4 §6.1: детерминированная маршрутизация типовых запросов ПЕРЕД
   * первым шагом модели. Погода и поиск — инструменты приложения (модель
   * только озвучивает результат); результат кладётся в диалог как
   * [результат инструмента]. Выполняется один раз на сообщение пользователя
   * (s._preRoutedFor = id последнего user-сообщения).
   */
  async _preRoute(s, ctx) {
    const lastUser = [...s.messages].reverse().find((m) => m.role === 'user');
    if (!lastUser) return;
    if (s._preRoutedFor === lastUser.id) return; // повторный прогон (нудж/уточнение) — не дублируем
    const text = String(lastUser.text ?? '');
    const { classifyIntent } = await import('../intelligence/intents.js');
    const intent = classifyIntent(text, { webEnabled: Boolean(ctx.web?.enabled) });
    if (!['weather', 'search'].includes(intent.intent)) return;

    s._preRoutedFor = lastUser.id;
    const tool = intent.intent === 'weather' ? 'weather' : 'web_search';
    const args = intent.intent === 'weather'
      ? { place: intent.slots.place ?? '' }
      : { query: text.slice(0, 200) };
    this._stage(s, intent.intent === 'weather'
      ? `погода: запрос к сервису${intent.slots.place ? ` (${intent.slots.place})` : ''}`
      : 'поиск: DuckDuckGo');
    if (intent.intent === 'weather' && !intent.slots.place) {
      s._weatherFact = { kind: 'погода', ok: false, webOff: false, error: 'в запросе не указан город' };
      this._append(s, {
        role: 'tool', tool, args, ok: false,
        result: 'в запросе не указан город. Пользователю нужен честный вопрос «о каком городе?» — погоду без города называть НЕЛЬЗЯ.'
      });
      return;
    }
    if (intent.intent === 'weather' && !ctx.web?.enabled) {
      s._weatherFact = { kind: 'погода', ok: false, webOff: true };
      this._append(s, {
        role: 'tool', tool, args, ok: false,
        result: 'доступ к интернету выключен (кнопка «земной шар»). Актуальную погоду проверить НЕЛЬЗЯ — сообщи пользователю прямо: не проверял и не буду выдумывать.'
      });
      return;
    }
    let exec;
    try {
      exec = await this.tools.execute(tool, args, ctx);
    } catch (err) {
      s._weatherFact = { kind: 'погода', ok: false, webOff: false, error: String(err?.message ?? err).slice(0, 200) };
      this._append(s, { role: 'tool', tool, args, ok: false, result: `ошибка инструмента: ${String(err?.message ?? err).slice(0, 400)}` });
      return;
    }
    s.stats.toolCalls = (s.stats.toolCalls ?? 0) + 1;
    // Структурированный факт — для заземления финального ответа модели
    // (числа сервиса не доверяются пересказу). Форма СТРОГО как в
    // intelligence/layer.js verifyToolAnswers: {kind:'погода', ok, data} —
    // сырой объект w без обёртки факт не находится и заземление мёртвое.
    s._weatherFact = exec.data ? { kind: 'погода', ok: true, data: exec.data } : null;
    this._append(s, { role: 'tool', tool, args, ok: exec.ok !== false, result: exec.result ?? '' });
    this._stage(s, intent.intent === 'weather' ? 'погода: данные получены' : 'поиск: источники получены');
  }

  /**
   * Заземлить финальный текст агента по факту погоды: выдуманные температуры
   * или путаный отказ заменяются детерминированным ответом из данных сервиса
   * (ТЗ: модель не должна выдавать выдумку за результат инструмента).
   */
  _grounded(s, text) {
    if (!s?._weatherFact) return { text: String(text ?? ''), replaced: false };
    return verifyToolAnswers({ meta: { __factDetails: [s._weatherFact] }, text });
  }

  async _runLoop(s) {
    this._assertProject(s);
    s.stats.runs++;
    s.stats.startedAt = nowIso();
    s.stats.endedAt = null;
    s.stats.toolCalls = 0;
    s._nudges = 0;
    s.error = null;
    s._ctrl = new AbortController();
    const ctx = {
      projectRoot: s.projectDir,
      web: this.webCtx(),
      signal: s._ctrl.signal,
      // ТЗ v0.6.4: сервисы компаньона для инструментов memory_*/task_*/screen_look
      services: this.services(),
      // процессы терминала регистрируются в сессии — stop() убивает их дерево
      onTermStart: (pid, kill) => { (s._termKills ??= []).push(kill); }
    };
    const startedAt = Date.now();
    let parseFails = 0;

    // ТЗ v0.6.4 (агент §6.1): надёжная маршрутизация приложения для типовых
    // запросов. Погода/поиск выполняются ИНСТРУМЕНТОМ сразу — слабая модель
    // получает готовые факты и формулирует ответ, а не висит «в раздумьях».
    try {
      await this._preRoute(s, ctx);
    } catch (err) {
      // Ошибка маршрутизации не убивает цикл: модель получит текст ошибки
      // как [результат инструмента] и честно сообщит пользователю.
      this.log?.warn?.('agent pre-route failed', { id: s.id, error: String(err?.message ?? err).slice(0, 200) });
    }

    try {
      while (true) {
        // предохранители
        if (s._ctrl.signal.aborted) { s.state = 'stopped'; s.stats.endedAt = nowIso(); return; }
        if (s.stats.steps >= this.limits.maxSteps) {
          s.state = 'error'; s.error = `достигнут лимит шагов (${this.limits.maxSteps})`;
          this._append(s, { role: 'event', type: 'error', text: `${s.error}. Продолжите сообщением или остановите.` });
          return;
        }
        if (Date.now() - startedAt > this.limits.maxRuntimeMs) {
          s.state = 'error'; s.error = 'превышено время выполнения задачи';
          this._append(s, { role: 'event', type: 'error', text: `${s.error}. Продолжите сообщением.` });
          return;
        }

        // 1. шаг: генерация ответа модели (стрим в диалог)
        s.state = 'running';
        this._stage(s, 'анализ задачи');
        const payload = this._buildMessages(s);
        let full = '';
        let lastEmit = 0;
        const onToken = (delta) => {
          full += delta;
          const t = Date.now();
          if (t - lastEmit > 150) {
            lastEmit = t;
            this._broadcast(s, { id: s.cursor, role: 'delta', text: full, ts: nowIso(), _transient: true });
          }
        };
        // ТЗ v0.6.4: пошаговый таймаут — «Обдумывание шага» больше не вечно.
        const stepStarted = Date.now();
        let res;
        try {
          const stepTimer = new Promise((_resolve, reject) => {
            const t = setTimeout(() => {
              const e = new Error(`модель отвечала дольше ${Math.round(this.limits.stepTimeoutMs / 1000)} с на одном шаге — шаг остановлен`);
              e.code = 'STEP_TIMEOUT';
              reject(e);
            }, Math.max(5_000, Number(this.limits.stepTimeoutMs) || 300_000));
            t.unref?.();
            s._stepTimer = t;
          });
          try {
            res = await Promise.race([
              this.generateFn({
                model: await this._resolveModel(s),
                messages: payload,
                maxOutputTokens: this.limits.stepMaxOutputTokens,
                signal: s._ctrl.signal,
                onToken
              }),
              stepTimer
            ]);
          } finally {
            if (s._stepTimer) { clearTimeout(s._stepTimer); s._stepTimer = null; }
          }
        } catch (stepErr) {
          if (s._ctrl.signal.aborted) { s.state = 'stopped'; s.stats.endedAt = nowIso(); return; }
          const msg = String(stepErr?.message ?? stepErr).slice(0, 300);
          s.state = 'error';
          s.error = msg;
          s.stats.endedAt = nowIso();
          this._append(s, { role: 'event', type: 'error', text: `шаг не завершился: ${msg}. Задачу можно продолжить сообщением или остановить.` });
          return;
        }
        const reply = String(res?.text ?? full ?? '');
        s.stats.steps++;

        const parsed = parseAgentReply(reply);
        if (!parsed) {
          if (++parseFails >= 3) {
            s.state = 'error'; s.error = 'модель трижды вернула нечитаемый ответ';
            this._append(s, { role: 'event', type: 'error', text: `${s.error}. Переформулируйте задачу или смените модель.` });
            return;
          }
          this._append(s, { role: 'event', type: 'note', text: 'ответ модели не распознан, повторяю с подсказкой' });
          s.messages.push({ id: ++s.cursor, role: 'user', ts: nowIso(), text: '[система: твой предыдущий ответ не соответствовал формату ACTION/TEXT/ASK/DONE. Ответь строго одним блоком формата.]' });
          continue;
        }
        parseFails = 0;

        const preambleText = parsed.preamble;
        if (preambleText && parsed.kind !== 'text') {
          this._append(s, { role: 'assistant', text: preambleText }); // «рассуждение» перед действием
        }

        // 2. разбор вида ответа
        if (parsed.kind === 'text') {
          let t = String(parsed.data.text ?? '').trim();
          if (!t) continue;
          const g = this._grounded(s, t); // погода: выдумка/путаница → детерминированный ответ
          t = g.text;
          // Анти-фейк TEXT (ТЗ §5: «запретить ложные сообщения „готово"»):
          // ответ словами при нуле реальных инструментальных вызовов не
          // принимается — подсказка требует ACTION (симметрично отказу
          // «пустого DONE»; smoke v0.6.4: 0.6B отчиталась «файл создан»,
          // не вызвав write_file). Максимум 2 подсказки, затем принимаем
          // текст — модель могла честно объяснить невозможность.
          if ((s.stats.toolCalls ?? 0) === 0 && (s._textNudges ?? 0) < 2) {
            s._textNudges = (s._textNudges ?? 0) + 1;
            this._append(s, { role: 'event', type: 'note', text: 'модель ответила словами, не вызвав ни одного инструмента — требую реальные действия' });
            s.messages.push({ id: ++s.cursor, role: 'user', ts: nowIso(), text: '[система: отказано. Ты не вызвал ни одного инструмента — словами задача не выполнена. Ответь РОВНО ОДНОЙ строкой формата ACTION: {"tool":"имя_инструмента","args":{...}} — подходящий инструмент (write_file/terminal/edit_file/…), без слов до и после строки. Дождись [результат инструмента] и только потом сообщай результат.]' });
            continue;
          }
          this._append(s, { role: 'assistant', text: t });
          s.state = 'idle'; // ответ дан, ждём пользователя; задача может быть продолжена
          this._stage(s, 'готово');
          await this._persist(s);
          return;
        }

        if (parsed.kind === 'ask') {
          const q = String(parsed.data.question ?? parsed.data.text ?? '').trim();
          // Погодный факт уже получен инструментом: уточняющий вопрос малой
          // модели («Какая погода в Иркутске?» вместо ответа) — нечестен и
          // бесполезен. Отдаём детерминированный ответ из данных сервиса.
          if (s._weatherFact?.ok) {
            const g = this._grounded(s, q);
            this._append(s, { role: 'assistant', text: g.text });
            s.state = 'idle';
            this._stage(s, 'готово');
            await this._persist(s);
            return;
          }
          if (q) this._append(s, { role: 'assistant', text: q });
          s.state = 'waiting_user';
          this._stage(s, 'ждёт ответа пользователя');
          await this._persist(s);
          return; // цикл перезапустится из postMessage
        }

        if (parsed.kind === 'done') {
          // Отказ от «пустого DONE»: задача не может быть выполнена, если агент
          // не вызвал ни одного инструмента (малые модели любят отчитаться
          // словами). Дважды подсказываем и продолжаем цикл.
          if ((s.stats.toolCalls ?? 0) === 0 && (s._nudges ?? 0) < 2) {
            s._nudges = (s._nudges ?? 0) + 1;
            this._append(s, { role: 'event', type: 'note', text: 'модель отчиталась без выполнения действий — требую инструменты' });
            s.messages.push({ id: ++s.cursor, role: 'user', ts: nowIso(), text: '[система: отказано. Ты не вызвал ни одного инструмента — задача фактически не выполнена. Ответь РОВНО ОДНОЙ строкой формата ACTION: {"tool":"имя_инструмента","args":{...}} — подходящий инструмент (write_file/terminal/edit_file/…), без слов до и после строки. Дождись [результат инструмента] и только потом DONE.]' });
            continue;
          }
          const report = {
            summary: this._grounded(s, String(parsed.data.summary ?? 'задача завершена')).text,
            created: parsed.data.created ?? [],
            modified: parsed.data.modified ?? [],
            failed: parsed.data.failed ?? []
          };
          // Погодный вопрос: детерминированный ответ сервиса виден пользователю
          // как ответ ассистента (DONE-отчёт — служебное событие в истории).
          if (s._weatherFact) {
            this._append(s, { role: 'assistant', text: report.summary });
          }
          this._append(s, { role: 'event', type: 'report', text: report.summary, report });
          s.state = 'done';
          this._stage(s, 'задача выполнена');
          s.plan = [];
          s.stats.endedAt = nowIso();
          await this._persist(s);
          return;
        }

        // ACTION
        const tool = String(parsed.data.tool ?? '').trim();
        const args = parsed.data.args ?? {};
        s.stats.toolCalls = (s.stats.toolCalls ?? 0) + 1;
        if (!this.tools.names().includes(tool)) {
          this._append(s, {
            role: 'tool', tool, args, ok: false,
            result: `неизвестный инструмент «${tool}». Доступны: ${this.tools.names().join(', ')}`
          });
          continue;
        }

        // план: первое ACTION после постановки задачи — фиксируем заголовок этапа
        this._stage(s, `выполнение: ${tool}`);

        // Ошибки инструмента (плохой путь, нет файла и т.п.) не убивают цикл —
        // модель получает текст ошибки и корректирует следующий шаг.
        let exec;
        try {
          exec = await this.tools.execute(tool, args, ctx);
        } catch (err) {
          this._append(s, {
            role: 'tool', tool, args, ok: false,
            result: `ошибка инструмента: ${String(err?.message ?? err).slice(0, 500)}`
          });
          continue;
        }

        if (exec.needsConfirmation) {
          if (s.autoApprove) {
            // тестовый/доверенный режим: применяем сразу, но факт логируем
            const applied = await exec._apply();
            this._append(s, { role: 'tool', tool, args, ok: applied.ok !== false, result: applied.result });
            s.plan.push(applied.result?.slice(0, 100) ?? tool);
            continue;
          }
          s.pendingApproval = {
            id: `apr_${randomUUID().slice(0, 8)}`,
            tool, args, change: exec.change,
            apply: exec._apply
          };
          s.state = 'awaiting_confirmation';
          s.currentStage = `ожидает подтверждения: ${tool}`;
          this._append(s, {
            role: 'event', type: 'confirmation', decision: null,
            approvalId: s.pendingApproval.id,
            text: `агент запрашивает: ${tool}`,
            change: exec.change
          });
          await this._persist(s);
          return; // цикл продолжится из decide()
        }

        const r = exec;
        this._append(s, { role: 'tool', tool, args, ok: r.ok !== false, result: r.result ?? '' });
        if (r.ok === false) {
          // ошибка инструмента — модель сама решает, как скорректироваться
          continue;
        }
        // успешный шаг — продолжаем цикл
      }
    } finally {
      if (s.state === 'running') s.state = 'idle';
    }
  }

  /** Контекст веба для инструментов (раздел 7 ТЗ). По умолчанию — выключен. */
  webCtx() {
    return this._webCtx;
  }
}

  /** Установка веб-контекста извне (server.js импортирует fetcher и передаёт сюда). */
  AgentManager.prototype.setWebContext = function (webCtx) {
    this._webCtx = webCtx ?? { enabled: false, fetchText: null, github: null };
  };

  /**
   * ТЗ v0.6.4: сервисы компаньона (память/задачи/intelligence) — передаются
   * сервером; их используют инструменты memory_save, task_create, screen_look.
   */
  AgentManager.prototype.setServices = function (services) {
    this._services = services ?? {};
  };

  AgentManager.prototype.services = function () {
    return this._services ?? {};
  };
