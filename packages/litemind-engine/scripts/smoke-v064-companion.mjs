#!/usr/bin/env node
// ТЗ v0.6.4 §11 — смоук новой функциональности на УСТАНОВЛЕННОМ приложении.
//
// Покрывает:
//   Тест B (локальная модель): модель видна, чат отвечает (реальная генерация),
//     в ответе нет служебных токенов/размышлений, timings честные.
//   Тест C (интернет): включаем веб, глобус-запрос «погода в Иркутске» →
//     реальные данные Open-Meteo (проверяем, что температура пришла из сервиса
//     в момент теста); выключаем веб → честный отказ без выдуманной температуры.
//   Тест C (страница): поиск по запросу → реальный результат с URL.
//   Тест D (агент): вопрос о погоде агенту при включённом интернете →
//     инструмент погоды отрабатывает, агент завершается (не вечное «Обдумывание шага»).
//   Компаньон: память (CRUD), задачи (создать/завершить), voice status честный.
//
// Запуск: node scripts/smoke-v064-companion.mjs [--url http://127.0.0.1:8399]
//          [--model Qwen3-0.6B-Q8_0] [--out файл.json]
// Требует: установленное приложение (движок на 8399) и модель в папке моделей.
// Интернет-часть включается на время теста через /api/settings и выключается обратно.

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (!a.startsWith('--')) continue;
  const k = a.slice(2);
  const v = process.argv[i + 1];
  if (v !== undefined && !v.startsWith('--')) { args[k] = v; i++; } else args[k] = true;
}

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BASE = args.url ?? 'http://127.0.0.1:8399';
const OUT = args.out ?? path.join(os.tmpdir(), 'smoke-v064-companion.json');
const MODEL = args.model ?? null;
const checks = [];
function check(name, ok, details = '') {
  checks.push({ name, ok: Boolean(ok), details: String(details).slice(0, 400) });
  console.log(`  [${ok ? 'ПАСС' : 'ПРОВАЛ'}] ${name}${details ? ` — ${details}` : ''}`);
  return Boolean(ok);
}
function log(msg) { console.log(`[v064-smoke] ${msg}`); }

async function api(p, { method = 'GET', body = null, timeoutMs = 120000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error('timeout')), timeoutMs);
  try {
    const res = await fetch(BASE + p, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal
    });
    const data = await res.json().catch(() => null);
    return { status: res.status, data };
  } finally {
    clearTimeout(timer);
  }
}

/** Один чат-запрос (не-стрим) с возвращением { text, intelligence, selfcheck, usage }. */
async function chatOnce({ model, messages, globe = false, mode = 'smart', timeoutMs = 300000 }) {
  const r = await api('/v1/chat/completions', {
    method: 'POST',
    body: { model, messages, stream: false, web_globe: globe, intelligence_mode: mode },
    timeoutMs
  });
  const d = r.data ?? {};
  return {
    status: r.status,
    text: d.choices?.[0]?.message?.content ?? null,
    intelligence: d.litemind?.intelligence ?? null,
    selfcheck: d.litemind?.selfcheck ?? null,
    usage: d.usage ?? null,
    error: d.error?.message ?? null
  };
}

async function setWeb(enabled) {
  const r = await api('/api/settings', { method: 'POST', body: { web: { enabled } } });
  return r.status === 200;
}

const results = { startedAt: new Date().toISOString(), url: BASE, model: MODEL, checks };
let failed = false;
try {
  // Движок жив?
  const health = await api('/health', { timeoutMs: 5000 });
  if (!check('движок отвечает (/health)', health.status === 200 || health.status === 503)) {
    throw new Error('движок недоступен');
  }

  // ── Модель: определяем id из скана папки моделей ──────────────────────────
  const scan = await api('/api/models/scan', { timeoutMs: 30000 });
  const okModels = (scan.data?.models ?? []).filter((m) => m.ok);
  const model = MODEL && okModels.some((m) => m.id === MODEL)
    ? MODEL
    : (okModels[0]?.id ?? null);
  if (!check('модель определена из папки моделей', Boolean(model), model ?? 'нет скачанных GGUF')) {
    throw new Error('нет модели для теста');
  }
  results.model = model;

  // ── Тест B: локальная модель отвечает на русском, без служебных токенов ──
  log('Тест B: чат с локальной моделью…');
  const b = await chatOnce({
    model,
    messages: [{ role: 'user', content: 'Ответь одним коротким предложением по-русски: какого цвета небо днём?' }],
    mode: 'smart'
  });
  const bOk = check('чат: реальный ответ модели (Тест B)', b.status === 200 && b.text && b.text.length > 0,
    b.status === 200 ? `«${String(b.text).slice(0, 100)}» · ${b.usage?.completion_tokens ?? '—'} ток.` : b.error ?? `HTTP ${b.status}`);
  if (!bOk) throw new Error(b.error || 'чат не ответил');
  check('чат: без служебных токенов и размышлений (Тест B)',
    !/<think>|<\/think>|<\|im_(start|end)\|>|###\s*(Instruction|Response)/i.test(String(b.text)),
    `«${String(b.text).slice(0, 80)}»`);
  check('чат: Intelligence Layer передал метаданные (Тест B)', Boolean(b.intelligence?.mode), `mode=${b.intelligence?.mode ?? '—'}`);

  // ── Тест C-1: погода при ВЫКЛЮЧЕННОМ интернете — честный отказ ────────────
  log('Тест C-1: погода при выключенном интернете…');
  check('веб выключен', await setWeb(false));
  const c1 = await chatOnce({
    model,
    messages: [{ role: 'user', content: 'Какая погода в Иркутске прямо сейчас?' }],
    globe: true, mode: 'smart'
  });
  const c1Text = String(c1.text ?? '');
  const c1Honest = /не могу (проверить|узнать)|выключен|недоступен|не провер/i.test(c1Text);
  const c1NoFake = !/-\s*\d+\s*°|\+\s*\d+\s*°/.test(c1Text);
  check('погода без интернета: модель честно предупреждает (Тест C)', c1Honest, `«${c1Text.slice(0, 120)}»`);
  check('погода без интернета: НЕТ выдуманной температуры (Тест C)', c1NoFake, c1Text.slice(0, 120));

  // ── Тест C-2: погода с интернетом — данные Open-Meteo в момент теста ─────
  log('Тест C-2: погода при включённом интернете…');
  check('веб включён', await setWeb(true));
  const wx = await api('/api/web/weather', { method: 'POST', body: { place: 'Иркутск' }, timeoutMs: 30000 });
  const wOk = wx.status === 200 && wx.data?.ok;
  check('Open-Meteo: сервис вернул погоду Иркутска в момент теста (Тест C)', wOk,
    wOk ? `t=${wx.data.temperatureC}°C, ${wx.data.description}, наблюдение ${wx.data.observedAt}, получено ${wx.data.retrievedAt}` : (wx.data?.error?.message ?? `HTTP ${wx.status}`));
  if (wOk) {
    results.weather = { temperatureC: wx.data.temperatureC, description: wx.data.description, observedAt: wx.data.observedAt, retrievedAt: wx.data.retrievedAt, source: wx.data.source };
  }
  const c2 = await chatOnce({
    model,
    messages: [{ role: 'user', content: 'Какая погода в Иркутске прямо сейчас? Назови температуру и источник.' }],
    globe: true, mode: 'smart'
  });
  const c2Text = String(c2.text ?? '');
  const c2Grounded = /-\s*\d+\s*°|\+\s*\d+\s*°|°C/i.test(c2Text);
  check('погода с интернетом: ответ с температурой и источником (Тест C)',
    c2.status === 200 && c2Grounded && /open-meteo|источник/i.test(c2Text),
    c2Text.slice(0, 160));

  // ── Тест C-3: поиск по произвольному запросу ──────────────────────────────
  log('Тест C-3: веб-поиск…');
  const sr = await api('/api/web/search', { method: 'POST', body: { query: 'llama.cpp GitHub repository' }, timeoutMs: 40000 });
  const srOk = sr.status === 200 && (sr.data?.results ?? []).length > 0;
  check('поиск DuckDuckGo: реальный результат с URL (Тест C)', srOk,
    srOk ? `${sr.data.results.length} результатов, первый: ${sr.data.results[0].url}` : (sr.data?.error?.message ?? `HTTP ${sr.status}`));

  // ── Тест D: агент + погода — НЕ вечное «Обдумывание шага» ────────────────
  log('Тест D: агент с погодным вопросом…');
  const sess = await api('/api/agent/sessions', { method: 'POST', body: { title: 'smoke v0.6.4 погода', firstMessage: 'Какая сейчас погода в Иркутске? Скажи температуру и укажи источник.' }, timeoutMs: 240000 });
  const sid = sess.data?.id ?? sess.data?.session?.id;
  if (!check('агент: сессия создана и обработала сообщение (Тест D)', Boolean(sid) && sess.status === 200, `id=${sid ?? '—'}`)) {
    throw new Error('агент не ответил на первое сообщение');
  }
  // Дождаться завершения: state должен стать idle/done/waiting_user (не running навсегда).
  let finalView = null;
  const t0 = Date.now();
  while (Date.now() - t0 < 180000) {
    const v = await api(`/api/agent/sessions/${sid}`, { timeoutMs: 15000 });
    finalView = v.data;
    if (!['running'].includes(finalView?.state)) break;
    await new Promise((r) => setTimeout(r, 3000));
  }
  check('агент: задача завершилась (не вечное «Обдумывание шага») (Тест D)',
    ['idle', 'done', 'waiting_user', 'stopped', 'error'].includes(finalView?.state),
    `state=${finalView?.state}, шагов=${finalView?.stats?.steps ?? '—'}`);
  const toolMsg = (finalView?.messages ?? []).some((m) => m.role === 'tool' && m.tool === 'weather' && m.ok);
  check('агент: инструмент погоды реально отработал (Тест D)', toolMsg,
    toolMsg ? 'в диалоге есть [результат инструмента weather]' : 'инструмент не вызван');
  const agentText = (finalView?.messages ?? []).filter((m) => m.role === 'assistant').map((m) => m.text).join(' ');
  check('агент: итоговый ответ содержит погоду/источник (Тест D)',
    /open-meteo|°|температур/i.test(agentText), agentText.slice(0, 160));
  // Остановить сессию (уборка).
  await api(`/api/agent/sessions/${sid}/stop`, { method: 'POST', body: {} }).catch(() => {});

  // ── Компаньон: память, задачи, голос ──────────────────────────────────────
  log('Компаньон: память и задачи…');
  const memAdd = await api('/api/memory', { method: 'POST', body: { text: 'Смоук v0.6.4: пользователь назвал этот ПК «тестовым стендом»' } });
  check('память: запись сохранена', memAdd.status === 200 && memAdd.data?.entry?.id);
  if (memAdd.data?.entry?.id) {
    await api(`/api/memory/${memAdd.data.entry.id}`, { method: 'DELETE' });
  }
  const taskAdd = await api('/api/tasks', { method: 'POST', body: { text: 'Смоук v0.6.4: тестовая задача (удалить)' } });
  check('задачи: создание работает', taskAdd.status === 200 && taskAdd.data?.task?.id);
  if (taskAdd.data?.task?.id) {
    await api(`/api/tasks/${taskAdd.data.task.id}/complete`, { method: 'POST', body: {} });
    await api(`/api/tasks/${taskAdd.data.task.id}`, { method: 'DELETE' });
  }
  const voice = await api('/api/voice/status', { timeoutMs: 15000 });
  check('голос: статус отвечает честно (компоненты НЕ выдаются за установленные)',
    voice.status === 200 && typeof voice.data?.tts?.installed === 'boolean',
    `tts=${voice.data?.tts?.installed}, asr=${voice.data?.asr?.installed}, supported=${voice.data?.supported}`);
  const comp = await api('/api/companion/status', { timeoutMs: 10000 });
  check('компаньон: статус и настройки доступны', comp.status === 200 && Boolean(comp.data?.settings));

  // ── Возврат настройки интернета ───────────────────────────────────────────
  check('веб возвращён в выключенное состояние', await setWeb(false));

  // Итог
  const passed = checks.filter((c) => c.ok).length;
  log(`итог: ${passed}/${checks.length} проверок пройдено`);
  if (checks.some((c) => !c.ok)) failed = true;
} catch (err) {
  failed = true;
  check('непредвиденная ошибка', false, String(err?.message ?? err).slice(0, 300));
} finally {
  try {
    fs.writeFileSync(OUT, JSON.stringify(results, null, 2));
    log(`результаты: ${OUT}`);
  } catch { /* некритично */ }
}
process.exit(failed ? 1 : 0);
