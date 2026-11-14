// LiteMind Intelligence Layer — посредник между пользователем, моделью и инструментами
// (ТЗ v0.6.4, дополнение §1–§8).
//
// Что делает ПЕРЕД генерацией (детерминированно, 0 вызовов модели):
//   1. Классифицирует запрос (интенты на регулярках — нулевая нагрузка на CPU).
//   2. Для типовых действий выполняет НАДЁЖНЫЙ инструмент на стороне приложения:
//      погода → Open-Meteo; поиск → DuckDuckGo; математика → точный вычислитель;
//      время → локальные часы; «запомни» → память; «напомни» → планировщик задач;
//      «посмотри на экран» → host-мост (скриншот + OCR, только по разрешению).
//   3. Собирает КРАТКИЙ контекст: стабильный системный промпт (prompt-cache
//      llama.cpp переиспользует его KV — первый токен ускоряется), релевантные
//      факты из памяти (smart/expert), блок фактов инструмента.
//   4. Подбирает параметры генерации под семейство модели (stop-токены,
//      repetition_penalty) — служебные токены не попадают в ответ (ТЗ §4).
//
// ПОСЛЕ генерации: самопроверка (дополнение §6) — не более ОДНОЙ исправляющей
// попытки (в экспертном режиме), чтобы не замедлять слабый ПК.
//
// Режимы (дополнение §7) действительно меняют поведение:
//   quick  — минимум контекста, без памяти, без самопроверки (самый быстрый);
//   smart  — память + инструменты + проверка на утечки/повторы (по умолчанию);
//   expert — дополнительно: разбиение на шаги (подсказка модели) + исправляющая
//            попытка при провале самопроверки.

import { classifyIntent } from './intents.js';
import { evaluateExpression, findMathExpression } from './calculator.js';
import { webSearch, fetchSearchPages } from '../web/search.js';
import { currentWeather } from '../web/weather.js';
import { extractAutoFact } from '../memory/store.js';
import { parseReminder, formatWhen } from '../tasks/datetime.js';

export const MODES = { quick: 'Быстрый', smart: 'Умный', expert: 'Экспертный' };

/** Регулярка утечек служебных токенов чат-шаблонов. */
const LEAK_RE = /<\|im_(start|end)\|>|<\|[A-Za-z_]{2,24}\|>|<start_of_turn>|<end_of_turn>|###\s*(Instruction|Response)/i;

/**
 * Составить честный ответ из факта инструмента — БЕЗ участия модели
 * (дополнение ТЗ §1: «для простых и типовых действий использовать надёжные
 * алгоритмы на стороне LiteMind»). Такой ответ невозможно «выдумать».
 */
export function composeToolAnswer(fact) {
  const at = new Date().toISOString();
  if (fact?.kind === 'погода') {
    if (!fact.ok) {
      // Две разные причины отказа — и два разных честных ответа (E2E v0.6.4:
      // нельзя говорить «интернет выключен», когда источник недоступен).
      if (fact.webOff === true) {
        return [
          'Интернет выключен, поэтому актуальную погоду проверить не могу —',
          'называть температуру догадкой не буду.',
          'Включите кнопку «земной шар» (и доступ к интернету в Настройках),',
          'и я покажу реальную погоду с источником и временем наблюдения.'
        ].join(' ');
      }
      return [
        'Погодный сервис сейчас недоступен',
        fact.error ? `(${fact.error})` : '',
        '— актуальную температуру назвать не могу, догадкой это не будет.',
        'Попробуйте ещё раз позже; если интернет выключен — включите кнопку «земной шар» и повторите запрос.'
      ].filter(Boolean).join(' ');
    }
    const d = fact.data ?? {};
    const bits = [`Сейчас ${d.place ?? 'в выбранном месте'}: ${d.temperatureC > 0 ? '+' : ''}${d.temperatureC} °C, ${d.description ?? ''}`];
    if (d.apparentC != null) bits.push(`ощущается как ${d.apparentC} °C`);
    if (d.windKph != null) bits.push(`ветер ${d.windKph} км/ч`);
    if (d.humidityPct != null) bits.push(`влажность ${d.humidityPct}%`);
    return `${bits.join(', ')}. Наблюдение: ${d.observedAt ?? '—'} (местное время). Источник: Open-Meteo — ${d.source ?? 'https://open-meteo.com'} (получено ${d.retrievedAt ?? at}).`;
  }
  return null;
}

/**
 * Детерминированная проверка ответа по фактам инструментов (дополнение §6:
 * «действительно ли выполнен запрошенный инструмент; не выдуманы ли…»).
 * Возвращает { text, replaced, issues }:
 *  - погода ok: в ответе должны быть ТОЛЬКО числа сервиса (°) — иначе
 *    ответ заменяется составленным (модельный текст ненадёжен для чисел);
 *  - погода !ok: любые «°» в ответе — выдумка, заменяем на честный отказ;
 *  - вычисление ok: точный результат обязан быть в ответе — иначе дописываем.
 */
export function verifyToolAnswers({ meta, text }) {
  const t = String(text ?? '');
  const facts = meta?.facts ?? [];
  const factList = meta?.__factDetails ?? [];
  const weather = factList.find((f) => f?.kind === 'погода');
  if (weather) {
    if (!weather.ok) {
      // Малые модели не умеют отказываться аккуратно (E2E v0.6.4: 0.5B вместо
      // честного «не могу проверить» выдала бессвязный список городов). Любой
      // ответ при неуспешном инструменте погоды заменяется детерминированным
      // честным текстом — без выдуманных температур и без путаницы.
      return { text: composeToolAnswer(weather), replaced: true, issues: ['ответ заменён детерминированным честным отказом'] };
    }
    const d = weather.data ?? {};
    const allowed = new Set([Math.round(d.temperatureC), Math.round(d.apparentC ?? NaN)].filter(Number.isFinite));
    const nums = [...t.matchAll(/([-+]?\d{1,2}(?:[.,]\d)?)\s*°/g)].map((m) => Math.round(Number(m[1].replace(',', '.'))));
    const grounded = nums.length > 0 && nums.every((n) => allowed.has(n));
    if (!grounded) {
      return { text: composeToolAnswer(weather), replaced: true, issues: ['в ответе нет точных данных источника — подставлены данные Open-Meteo'] };
    }
    if (!/open-meteo/i.test(t)) {
      return { text: `${t}\nИсточник: Open-Meteo — ${d.source ?? 'https://open-meteo.com'} (наблюдение ${d.observedAt ?? '—'}).`, replaced: false, issues: [] };
    }
    return { text: t, replaced: false, issues: [] };
  }
  const math = factList.find((f) => f?.kind === 'вычисление');
  if (math?.ok) {
    const m = String(math.data?.result ?? '');
    if (m && !t.includes(m.replace(/\.0+$/, ''))) {
      return { text: `${t}\nТочный результат: ${math.data.expression} = ${math.data.result} (вычислено калькулятором LiteMind).`, replaced: false, issues: [] };
    }
  }
  return { text: t, replaced: false, issues: [] };
}

/**
 * Самопроверка ответа (дополнение §6): соответствует ли вопросу (непустой),
 * нет ли утечек шаблона, зацикленных повторов, перепутанных ролей, выдуманных
 * погодных цифр. Дешёвая (регулярки), для слабого ПК — 0 мс и 0 вызовов модели.
 */
export function checkReply({ text, userText = '' }) {
  const t = String(text ?? '').trim();
  const issues = [];
  if (!t) issues.push('пустой ответ');
  if (LEAK_RE.test(t)) issues.push('утечка служебных токенов');
  const norm = t.toLowerCase().replace(/\s+/g, ' ');
  // Зацикливание: одна и та же фраза (10+ слов) встречается 3+ раз.
  const words = norm.split(' ').filter(Boolean);
  const n = 10;
  if (words.length > n * 3) {
    const counts = new Map();
    for (let i = 0; i + n <= words.length; i++) {
      const gram = words.slice(i, i + n).join(' ');
      counts.set(gram, (counts.get(gram) ?? 0) + 1);
    }
    for (const [gram, c] of counts) {
      if (c >= 3) { issues.push(`повтор фрагмента «${gram.slice(0, 40)}…» ×${c}`); break; }
    }
  }
  // Роли перепутаны: ответ начинается как чужое системное сообщение.
  if (/^(user\s*:|system\s*:)/i.test(t)) issues.push('перепутаны роли');
  // Погодные цифры без источника — запрещены ТЗ §5.3.
  if (/погод|температур/i.test(userText) && /погод/i.test(t)) {
    const honest = /не могу (проверить|узнать)|интернет выключен|недоступен|open-meteo|источник/i.test(t.toLowerCase());
    const grounded = /°\s*[cс]/i.test(t) || /-?\d+\s*°/.test(t);
    if (!honest && !grounded && /\d+\s*°/.test(t)) issues.push('погодные цифры без источника');
  }
  return { ok: issues.length === 0, issues };
}

/** Очистка служебных фрагментов из текста ответа (ТЗ §4). */
export function cleanReplyText(text) {
  return String(text ?? '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<\/?(think)>/gi, '')
    .replace(/<\|im_(start|end)\|>/g, '')
    .replace(/<\|[^|]{1,24}\|>/g, '')
    .replace(/<\/?[a-z_]+_of_turn>/g, '')
    .replace(/###\s*(Instruction|Response):?/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Семейство модели по её идентификатору — для stop-токенов и подсказок. */
export function modelFamily(model) {
  const id = String(model ?? '').toLowerCase();
  if (/deepseek/.test(id)) return 'deepseek';
  if (/qwen/.test(id)) return 'qwen';
  if (/llama[-_]?3|llama3/.test(id)) return 'llama3';
  if (/gemma/.test(id)) return 'gemma';
  if (/phi[-_]?3|phi[-_]?4|phi3|phi4/.test(id)) return 'phi';
  if (/mistral|ministral|mixtral/.test(id)) return 'mistral';
  if (/tinyllama|stablelm|smol/.test(id)) return 'generic';
  return 'generic';
}

/**
 * Stop-последовательности по семейству: служебные токены чат-шаблонов
 * останавливают генерацию ДО того, как «<|im_end|>», «user» и прочие фрагменты
 * попадут в видимый ответ (ТЗ §4: «не показывать пользователю внутренние
 * управляющие токены»).
 */
export function stopSequencesFor(family) {
  switch (family) {
    case 'qwen': return ['<|im_end|>', '<|im_start|>', '<|endoftext|>'];
    case 'deepseek': return ['<|EOT|>', '<|end▁of▁sentence|>', '### Instruction:', '<|User|>', '<|Assistant|>'];
    case 'llama3': return ['<|eot_id|>', '<|end_of_text|>', '<|start_header_id|>'];
    case 'gemma': return ['<end_of_turn>', '<start_of_turn>'];
    case 'phi': return ['<|end|>', '<|user|>', '<|assistant|>'];
    case 'mistral': return ['</s>', '[INST]'];
    default: return ['</s>', '<|endoftext|>'];
  }
}

/** Параметры сэмплирования по семейству: борьба с повторами (ТЗ §4). */
export function samplerFor(family) {
  const base = { temperature: 0.7, top_p: 0.9, repeat_penalty: 1.1, presence_penalty: 0.3, frequency_penalty: 0.2 };
  if (family === 'deepseek') return { ...base, temperature: 0.6, repeat_penalty: 1.15 };
  if (family === 'qwen') return { ...base, temperature: 0.7 };
  if (family === 'llama3') return { ...base, temperature: 0.65 };
  return base;
}

/** Короткий стабильный системный промпт (кэшируемый префикс). */
function baseSystemPrompt({ family, mode, hasHost }) {
  const lines = [
    'Ты — LiteMind, локальный ИИ-помощник на компьютере пользователя. Отвечай на языке вопроса (по умолчанию — по-русски).',
    'Правила: отвечай по существу и кратко; не выдумывай факты, цифры и источники — если чего-то не знаешь или данные могут быть устаревшими, скажи об этом прямо.',
    'Не показывай служебные токены и разметку шаблонов. Пиши готовым текстом, без рассуждений о том, кто ты.',
    'Не повторяй один и тот же абзац несколько раз. Завершай ответ после сути.'
  ];
  if (family === 'deepseek') {
    lines.push('Ты помогаешь и с кодом, и с обычными вопросами — в этом чате не только программирование.');
  }
  if (mode === 'expert') {
    lines.push('Если задача сложная — сначала краткий план из 2-4 пунктов, затем выполнение по шагам.');
  }
  if (hasHost === false) {
    lines.push('Управление компьютером и просмотр экрана недоступны в этом режиме.');
  }
  return lines.join(' ');
}

/** Компактный блок фактов инструмента (не раздуваем контекст — ТЗ дополнение §3). */
function factBlock(kind, payload) {
  return `[Данные инструмента LiteMind · ${kind} · получено ${payload.retrievedAt}]\n${payload.text}`;
}

function clipText(s, n) {
  const t = String(s ?? '').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
}

export function createIntelligenceLayer({ config, engine, logger = null, memory = null, tasks = null, web = null, host = null } = {}) {
  const cfg = config.intelligence ?? {};
  const mode = () => cfg.mode ?? 'smart';

  const hasHost = () => Boolean(host && typeof host === 'object');

  async function doWeather(place) {
    if (!web?.enabled?.()) {
      return {
        kind: 'погода',
        ok: false,
        webOff: true,
        retrievedAt: new Date().toISOString(),
        text: 'Интернет выключен. Я НЕ могу проверить актуальную погоду и НЕ буду выдумывать температуру. Скажите пользователю прямо: для текущей погоды включите доступ к интернету (кнопка «земной шар») и повторите запрос.'
      };
    }
    try {
      const w = await currentWeather(place ?? '', { fetchImpl: web.fetchImpl ?? fetch });
      return { kind: 'погода', ok: true, retrievedAt: w.retrievedAt, text: `${w.summary} Время наблюдения (местное): ${w.observedAt}. Источник: Open-Meteo (${w.source}). Используй ТОЛЬКО эти числа; не придумывай другие значения.`, data: w };
    } catch (err) {
      return {
        kind: 'погода', ok: false, webOff: false, error: String(err?.message ?? err).slice(0, 200),
        retrievedAt: new Date().toISOString(),
        text: `Погодный источник недоступен или место не найдено: ${err.message}. Скажи пользователю об этом честно и не выдумывай погоду.`
      };
    }
  }

  async function doSearch(query, { signal } = {}) {
    if (!web?.enabled?.()) {
      return {
        kind: 'поиск', ok: false, webOff: true, retrievedAt: new Date().toISOString(),
        text: 'Интернет выключен (кнопка «земной шар»). Актуальные сведения проверить не могу — ответь без выдуманных фактов и предупреди пользователя.'
      };
    }
    try {
      const { results, engine: searchEngine, fetchedAt } = await webSearch(query, { fetchImpl: web.fetchImpl ?? fetch });
      const pages = await fetchSearchPages(results.slice(0, 3), { fetchText: (u) => web.fetchText(u), perPageChars: 2600, signal });
      const lines = [`Поиск (${searchEngine}) по запросу «${query}», время получения: ${fetchedAt}.`];
      results.slice(0, 6).forEach((r, i) => lines.push(`${i + 1}. ${r.title} — ${r.url}${r.snippet ? ` — ${clipText(r.snippet, 160)}` : ''}`));
      const good = pages.filter((p) => p.ok);
      if (good.length) {
        lines.push('');
        lines.push('Содержимое прочитанных страниц:');
        good.forEach((p, i) => {
          lines.push(`--- Источник: ${p.url} (получено ${fetchedAt}) ---`);
          lines.push(clipText(p.text, 2600));
        });
      } else {
        lines.push('');
        lines.push('Содержимое страниц прочитать не удалось (источники недоступны) — опирайся только на сниппеты выше и скажи, что страницы не открылись.');
      }
      return { kind: 'поиск', ok: true, retrievedAt: fetchedAt, text: lines.join('\n'), sources: results.slice(0, 6), pages };
    } catch (err) {
      return {
        kind: 'поиск', ok: false, retrievedAt: new Date().toISOString(),
        text: `Поиск не удался: ${err.message}. Скажи пользователю, что поиск сейчас недоступен, и не выдумывай сведения.`
      };
    }
  }

  function doClock() {
    const now = new Date();
    const text = `Локальное время компьютера: ${now.toLocaleTimeString('ru-RU')}, дата: ${now.toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })} (часовой пояс: ${Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'системный'}). Используй эти значения.`;
    return { kind: 'время', ok: true, retrievedAt: now.toISOString(), text };
  }

  function doMath(text) {
    const found = findMathExpression(text) ?? (findMathExpression(text.replace(/вычисли|посчитай|сколько будет/gi, '')) ?? null);
    if (!found) return null;
    return {
      kind: 'вычисление', ok: true, retrievedAt: new Date().toISOString(),
      data: { expression: found.expression, result: found.result },
      text: `Точный результат выражения ${found.expression} = ${found.result}. Сообщи этот результат пользователю; объяснять вычисление не нужно, если не просили.`
    };
  }

  function doRemember(content) {
    if (!memory) return { kind: 'память', ok: false, retrievedAt: new Date().toISOString(), text: 'Память недоступна — сообщи об этом.' };
    try {
      const { entry, updated } = memory.add({ text: content, source: 'user', pinned: false });
      return {
        kind: 'память', ok: true, retrievedAt: entry.updatedAt,
        text: `Факт сохранён в долговременную память${updated ? ' (запись обновлена)' : ''}: «${clipText(entry.text, 200)}». Подтверди пользователю коротко, что запомнил.`
      };
    } catch (err) {
      return { kind: 'память', ok: false, retrievedAt: new Date().toISOString(), text: `Не удалось сохранить: ${err.message}. Скажи об этом пользователю.` };
    }
  }

  function doTask(text) {
    if (!tasks) return { kind: 'задачи', ok: false, retrievedAt: new Date().toISOString(), text: 'Планировщик недоступен — сообщи об этом.' };
    const parsed = parseReminder(text);
    const task = tasks.add({ text: parsed.text || text.slice(0, 200), dueAt: parsed.dueAt ? parsed.dueAt.toISOString() : null, repeat: parsed.repeat, source: 'assistant' });
    const when = formatWhen(task.dueAt, task.repeat);
    return {
      kind: 'задачи', ok: true, retrievedAt: task.createdAt,
      text: `Задача сохранена: «${clipText(task.text, 120)}», напоминание: ${when}. Подтверди пользователю: что именно записано и когда напомню.`
    };
  }

  async function doScreen(text) {
    const perms = cfg.permissions ?? {};
    if (!perms.screenLook) {
      return { kind: 'экран', ok: false, retrievedAt: new Date().toISOString(), text: 'Просмотр экрана выключен (Компаньон → Разрешения). Не притворяйся, что видишь экран: предложи пользователю включить «Посмотри на экран» в настройках разрешений.' };
    }
    if (!hasHost() || typeof host.captureScreenText !== 'function') {
      return { kind: 'экран', ok: false, retrievedAt: new Date().toISOString(), text: 'Просмотр экрана доступен только в LiteMind Desktop с включённым разрешением. Честно сообщи об этом.' };
    }
    try {
      const r = await host.captureScreenText({ signal: null });
      if (!r?.ok) {
        return { kind: 'экран', ok: false, retrievedAt: new Date().toISOString(), text: `Экран прочитать не удалось: ${r?.error ?? 'неизвестная ошибка'}. Скажи об этом честно.` };
      }
      return { kind: 'экран', ok: true, retrievedAt: r.retrievedAt ?? new Date().toISOString(), text: `Содержимое активного экрана (текст с экрана, получено ${r.retrievedAt}):\n${clipText(r.text, 4000)}\nИспользуй только этот текст, чтобы объяснить пользователю, что открыто и куда нажать.` };
    } catch (err) {
      return { kind: 'экран', ok: false, retrievedAt: new Date().toISOString(), text: `Просмотр экрана не удался: ${err.message}. Честно сообщи об этом.` };
    }
  }

  /**
   * Подготовка запроса к модели. Вызывается API-сервером перед engine.generate.
   * @returns {{ messages, stop, sampler, facts, sources, meta }}
   */
  async function prepareRequest({ messages, model, globeEnabled = false, modeOverride = null, signal = null }) {
    const effMode = modeOverride && MODES[modeOverride] ? modeOverride : mode();
    const lastUser = [...(messages ?? [])].reverse().find((m) => m.role === 'user');
    const userText = typeof lastUser?.content === 'string' ? lastUser.content : '';
    const family = modelFamily(model);
    const meta = { mode: effMode, family, facts: [], sources: null, toolsRun: [], memoryUsed: 0, intelligence: 'on' };

    if (effMode === 'quick' || !userText.trim()) {
      // Быстрый режим: стабильный минимальный префикс, ничего лишнего.
      const sys = { role: 'system', content: baseSystemPrompt({ family, mode: effMode, hasHost: hasHost() }) };
      return { messages: [sys, ...messages], stop: stopSequencesFor(family), sampler: samplerFor(family), meta };
    }

    const intent = classifyIntent(userText, { webEnabled: Boolean(web?.enabled?.()) && globeEnabled, forceWeb: globeEnabled });
    meta.intent = intent.intent;

    const facts = [];
    try {
      switch (intent.intent) {
        case 'weather':
          meta.toolsRun.push('погода');
          facts.push(await doWeather(intent.slots.place));
          break;
        case 'search': {
          meta.toolsRun.push('поиск');
          const r = await doSearch(userText, { signal });
          facts.push(r);
          if (r.ok && r.sources) meta.sources = r.sources;
          break;
        }
        case 'clock':
          meta.toolsRun.push('время');
          facts.push(doClock());
          break;
        case 'math': {
          const r = doMath(userText);
          if (r) { meta.toolsRun.push('калькулятор'); facts.push(r); }
          break;
        }
        case 'remember':
          meta.toolsRun.push('память');
          facts.push(doRemember(intent.slots.content || userText));
          break;
        case 'task':
          meta.toolsRun.push('задачи');
          facts.push(doTask(userText));
          break;
        case 'screen':
          meta.toolsRun.push('экран');
          facts.push(await doScreen(userText));
          break;
        default:
          break;
      }
    } catch (err) {
      logger?.warn?.('intelligence tool failed', { intent: intent.intent, error: String(err?.message ?? err) });
      facts.push({ kind: intent.intent, ok: false, retrievedAt: new Date().toISOString(), text: `Инструмент завершился ошибкой: ${err.message}. Не выдумывай результат.` });
    }

    // Память: релевантные факты + закреплённые (smart/expert).
    let memLines = [];
    if (memory && intent.intent !== 'remember') {
      const hits = memory.search(userText, { limit: 4 });
      if (hits.length) {
        memLines = hits.slice(0, 4).map((e) => `- ${clipText(e.text, 220)}`);
        meta.memoryUsed = hits.length;
      }
    }

    const sysContent = baseSystemPrompt({ family, mode: effMode, hasHost: hasHost() })
      + (memLines.length ? `\n\nПамять о пользователе (долговременная, локальная):\n${memLines.join('\n')}\nИспользуй эти сведения, когда они уместны.` : '');

    const sys = { role: 'system', content: sysContent };
    const out = [sys, ...messages];

    const okFacts = facts.filter(Boolean);
    if (okFacts.length) {
      // Детали фактов — для детерминированной проверки ответа (числа сервиса).
      meta.__factDetails = okFacts.map((f) => ({ kind: f.kind, ok: f.ok, data: f.data ?? null }));
      const block = okFacts.map((f) => factBlock(f.kind, f)).join('\n\n');
      // Факты идут СТРОГО перед последним сообщением пользователя — стабильный
      // префикс (system + история) остаётся кэшируемым.
      const lastIdx = out.length - 1;
      out.splice(lastIdx, 0, { role: 'system', content: block });
      meta.facts = okFacts.map((f) => ({ kind: f.kind, ok: f.ok, retrievedAt: f.retrievedAt }));
    }

    return { messages: out, stop: stopSequencesFor(family), sampler: samplerFor(family), meta };
  }

  return {
    prepareRequest,
    checkReply,
    verifyToolAnswers,
    composeToolAnswer,
    cleanReplyText,
    mode,
    tools: { doWeather, doSearch: (q, o) => doSearch(q, o), doClock, doMath, doScreen: (t) => doScreen(t) },
    setHost: (h) => { host = h ?? null; },
    host: () => host,
    hasHost
  };
}
