#!/usr/bin/env node
// E2E v0.6.4 на реальном llama-server (локальная песочница): Intelligence Layer
// + lmlama + think-фильтр + самопроверка + настоящая погода/поиск через интернет.
// Запуск: node scripts/e2e-v064-local.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const LLAMA_SERVER = '/home/z/work/e2e/build/bin/llama-server';
const MODEL_FILE = '/home/z/work/e2e/qwen25-05b-q4km.gguf';
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'litemind-e2e-'));

const checks = [];
function check(name, ok, details = '') {
  checks.push({ name, ok: Boolean(ok), details: String(details).slice(0, 300) });
  console.log(`  [${ok ? 'ПАСС' : 'ПРОВАЛ'}] ${name}${details ? ` — ${details}` : ''}`);
}

// Конфиг движка: свой runtime + папка моделей.
fs.mkdirSync(path.join(WORK, 'models'), { recursive: true });
fs.copyFileSync(MODEL_FILE, path.join(WORK, 'models', 'Qwen2.5-0.5B-Instruct-Q4_K_M.gguf'));
const config = {
  backend: { type: 'lmlama', serverPath: LLAMA_SERVER },
  models: { rootDir: path.join(WORK, 'models') },
  web: { enabled: true },
  api: { port: 9321 },
  diagnostics: { level: 'error', dir: path.join(WORK, 'logs') },
  // В песочнице CI/локального прогона RAM ограничена (~4 ГБ) — профиль
  // high (кэш промпта + бюджет 512 МБ резерва) убирает флаковые блоки
  // memory-gate. На реальном ПК 16 ГБ работает профиль пользователя.
  profile: 'high',
  profiles: { high: { memoryReserveMb: 512 } }
};
fs.writeFileSync(path.join(WORK, 'config.json'), JSON.stringify(config));
process.env.LITEMIND_CONFIG = path.join(WORK, 'config.json');

const { startLiteMindEngine } = await import('../src/index.js');
const handle = await startLiteMindEngine({ port: 9321, console: false });
const BASE = `http://127.0.0.1:${handle.config.api.port}`;
console.log('engine up:', BASE);

async function chatOnce({ messages, globe = false, mode = 'smart', timeoutMs = 240000 }) {
  const r = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'Qwen2.5-0.5B-Instruct-Q4_K_M', messages, stream: false, web_globe: globe, intelligence_mode: mode }),
    signal: AbortSignal.timeout(timeoutMs)
  });
  const d = await r.json();
  return { status: r.status, text: d.choices?.[0]?.message?.content ?? null, timings: d.litemind?.timings ?? null, intelligence: d.litemind?.intelligence ?? null, selfcheck: d.litemind?.selfcheck ?? null, error: d.error?.message ?? null };
}

try {
  // ── 1. Холодный запуск + первый чат (загрузка модели входит) ──────────────
  const t0 = Date.now();
  const cold = await chatOnce({ messages: [{ role: 'user', content: 'Ответь одним коротким предложением по-русски: какого цвета небо днём?' }] });
  const coldMs = Date.now() - t0;
  check('чат с реальной моделью: непустой ответ', cold.status === 200 && cold.text && cold.text.length > 0,
    `${coldMs} мс · «${String(cold.text).slice(0, 80)}»`);
  console.log('  timings:', JSON.stringify(cold.timings));
  check('timings честные (ttft/tokensPerSecond присутствуют)', cold.timings?.ttftMs != null && cold.timings?.tokensPerSecond != null,
    `ttft=${cold.timings?.ttftMs} мс, t/s=${cold.timings?.tokensPerSecond}, out=${cold.timings?.usage?.completionTokens}`);
  check('без служебных токенов и think-размышлений',
    !/<think>|<\/think>|<\|im_|###\s*(Instruction|Response)/i.test(String(cold.text)));

  // ── 2. Тёплый запрос: prompt-cache → быстрый первый токен ────────────────
  const warm = await chatOnce({ messages: [{ role: 'user', content: 'Ответь одним словом: два плюс два?' }] });
  check('тёплый запрос отвечает', warm.status === 200 && warm.text,
    `${Date.now() - t0 >= 0 ? '' : ''}ttft=${warm.timings?.ttftMs} мс (без загрузки модели: ${warm.timings?.ttftAfterServerMs ?? '—'}), t/s=${warm.timings?.tokensPerSecond}`);
  console.log('  ПАРАМЕТРЫ runtime:', JSON.stringify((await (await fetch(`${BASE}/api/resources`)).json()).runtime));
  const warmTtft = warm.timings?.ttftAfterServerMs ?? warm.timings?.ttftMs ?? Infinity;

  // ── 3. Тест Иркутска: интернет ВКЛЮЧЁН — реальная Open-Meteo ─────────────
  const wx = await (await fetch(`${BASE}/api/web/weather`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ place: 'Иркутск' }) })).json();
  check('Open-Meteo: реальная погода Иркутска сейчас', wx?.ok === true && Number.isFinite(wx.temperatureC),
    `t=${wx.temperatureC}°C (${wx.description}), наблюдение=${wx.observedAt}, получено=${wx.retrievedAt}, источник=${wx.source}`);
  const chatWx = await chatOnce({
    globe: true,
    messages: [{ role: 'user', content: 'Какая сейчас погода в Иркутске? Назови температуру и источник данных.' }]
  });
  check('чат с глобусом: ответ содержит температуру источника', /-\s*\d+\s*°|\+\s*\d+\s*°|°\s*[cс]/i.test(String(chatWx.text)) && /open-meteo|источник/i.test(String(chatWx.text)),
    String(chatWx.text).slice(0, 160));
  // Честная сверка: температура в ответе модели = температура от сервиса.
  const wxTemp = Math.round(wx.temperatureC);
  const re = new RegExp(`[-+]?${Math.abs(wxTemp)}\\s*°`);
  check('температура в ответе = температура сервиса (не выдумка)', re.test(String(chatWx.text)),
    `сервис: ${wxTemp}°C; ответ содержит: ${re.test(String(chatWx.text))}`);

  // ── 4. Поиск ──────────────────────────────────────────────────────────────
  const sr = await (await fetch(`${BASE}/api/web/search`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: 'llama.cpp github' }) })).json();
  check('DuckDuckGo поиск: результаты с URL', (sr?.results ?? []).length > 0,
    sr?.results?.length ? `${sr.results.length} шт., первый: ${sr.results[0].url}` : (sr?.error?.message ?? 'нет данных'));

  // ── 5. Интернет ВЫКЛЮЧЕН: честный отказ ──────────────────────────────────
  await fetch(`${BASE}/api/settings`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ web: { enabled: false } }) });
  const honest = await chatOnce({ globe: true, messages: [{ role: 'user', content: 'Какая погода в Иркутске прямо сейчас?' }] });
  check('без интернета: модель НЕ выдумывает погоду',
    /не могу (проверить|узнать)|выключен|недоступен|не провер/i.test(String(honest.text)) && !/-\s*\d+\s*°|\+\s*\d+\s*°/.test(String(honest.text)),
    String(honest.text).slice(0, 160));
  await fetch(`${BASE}/api/settings`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ web: { enabled: true } }) });

  // ── 6. Агент: погода → инструмент → итог (без вечного «Обдумывание шага») ─
  const s0 = await (await fetch(`${BASE}/api/agent/sessions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'e2e погода', firstMessage: 'Какая сейчас погода в Иркутске? Назови температуру и источник.' }) })).json();
  const sid = s0?.id;
  let finalView = null;
  let seenWork = false;
  const tA = Date.now();
  while (Date.now() - tA < 240000) {
    finalView = await (await fetch(`${BASE}/api/agent/sessions/${sid}`)).json();
    if (finalView?.state === 'running') seenWork = true;
    const msgs = finalView?.messages ?? [];
    const hasProgress = msgs.some((m) => m.role === 'assistant' || m.role === 'tool');
    // Ждём работы агента: выход — только когда он реально начал и завершился
    // (первый 'idle' до запуска — не результат).
    if (finalView?.state !== 'running' && (seenWork || hasProgress || msgs.length > 1)) break;
    await new Promise((r) => setTimeout(r, 2000));
  }
  check('агент завершился за конечное время', ['idle', 'done', 'waiting_user', 'stopped'].includes(finalView?.state),
    `state=${finalView?.state}, шагов=${finalView?.stats?.steps}, ${Math.round((Date.now() - tA) / 1000)} с`);
  const toolOk = (finalView?.messages ?? []).some((m) => m.role === 'tool' && m.tool === 'weather' && m.ok);
  check('агент вызвал инструмент погоды и получил данные', toolOk);
  const agentText = (finalView?.messages ?? []).filter((m) => m.role === 'assistant').map((m) => m.text).join(' ');
  check('итоговый ответ агента с температурой/источником', /open-meteo|°|температур/i.test(agentText), agentText.slice(0, 160));

  // ── 7. Память: сохранить → использовать в чате ───────────────────────────
  await fetch(`${BASE}/api/memory`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'Тест e2e: любимый цвет пользователя — синий' }) });
  const memChat = await chatOnce({ messages: [{ role: 'user', content: 'Какой мой любимый цвет? Ответь одним словом.' }] });
  check('память подмешивается в контекст чата', /син/i.test(String(memChat.text)), String(memChat.text).slice(0, 100));

  // ── 8. Компаньон + голос ─────────────────────────────────────────────────
  const comp = await (await fetch(`${BASE}/api/companion/status`)).json();
  check('компаньон: статус/настройки живы', Boolean(comp?.settings));
  const voice = await (await fetch(`${BASE}/api/voice/status`)).json();
  check('голос: честный статус (на linux — компоненты не установлены)', voice?.supported === false || voice?.tts?.installed === false, `supported=${voice.supported}, tts=${voice.tts.installed}`);

  const passed = checks.filter((c) => c.ok).length;
  console.log(`\nИТОГ E2E: ${passed}/${checks.length}`);
  fs.writeFileSync(path.join(WORK, 'e2e-results.json'), JSON.stringify({ checks, warmTtft }, null, 2));
  if (passed !== checks.length) process.exitCode = 1;
} catch (err) {
  console.error('E2E FAIL:', err?.message ?? err);
  check('e2e завершился без исключений', false, String(err?.message ?? err));
  process.exitCode = 1;
} finally {
  await handle.stop().catch(() => {});
  // Рабочий каталог содержит копию модели (~400 МБ) — не оставляем мусор на диске.
  try { fs.rmSync(WORK, { recursive: true, force: true }); } catch { /* занятое — не критично */ }
}
