// Тесты v0.6.4 — Intelligence Layer, память, задачи, компаньон, голос, веб-поиск, погода.
// Все сетевые вызовы — на мок-fetch: реальные запросы не выполняются.
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';

import { evaluateExpression, findMathExpression } from '../src/intelligence/calculator.js';
import { classifyIntent, extractWeatherPlace } from '../src/intelligence/intents.js';
import { createIntelligenceLayer, modelFamily, stopSequencesFor, samplerFor, cleanReplyText, checkReply } from '../src/intelligence/layer.js';
import { parseDdgHtml, parseDdgLite, unwrapDdgUrl, webSearch } from '../src/web/search.js';
import { currentWeather, describeWeatherCode, geocodePlace } from '../src/web/weather.js';
import { parseReminder, formatWhen } from '../src/tasks/datetime.js';
import { MemoryStore, extractAutoFact } from '../src/memory/store.js';
import { TaskStore } from '../src/tasks/store.js';
import { CompanionHub } from '../src/companion/companion.js';
import { VOICE_COMPONENTS, createVoiceManager } from '../src/voice/voice.js';
import { createServer } from '../src/api/server.js';
import { loadConfig } from '../src/config.js';

function tmpDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `litemind-v064-${tag}-`));
}

function fixtureConfig(dir) {
  const config = loadConfig('this-path-does-not-exist.json');
  config.paths = { configPath: path.join(dir, 'config.json'), existed: false };
  config.web = { enabled: true, allowGithub: true, githubToken: null };
  return config;
}

/* ───────────────────────── Калькулятор ───────────────────────── */

test('калькулятор: арифметика, приоритеты, скобки, унарный минус', () => {
  assert.equal(evaluateExpression('2+2*2'), 6);
  assert.equal(evaluateExpression('(2+2)*2'), 8);
  assert.equal(evaluateExpression('-5+3'), -2);
  assert.equal(evaluateExpression('2^10'), 1024);
  assert.equal(evaluateExpression('100/4'), 25);
  assert.equal(evaluateExpression('10 % 3'), 1);
  assert.equal(evaluateExpression('3,5 + 1,5'), 5);
});

test('калькулятор: функции и константы', () => {
  assert.equal(evaluateExpression('sqrt(81)'), 9);
  assert.equal(evaluateExpression('abs(-7)'), 7);
  assert.equal(evaluateExpression('round(3.6)'), 4);
  assert.ok(Math.abs(evaluateExpression('sin(0)')) < 1e-12);
  assert.ok(evaluateExpression('pi') > 3.14 && evaluateExpression('pi') < 3.15);
});

test('калькулятор: честные ошибки (деление на ноль, мусор, неизвестные имена)', () => {
  assert.throws(() => evaluateExpression('5/0'), /деление на ноль/);
  assert.throws(() => evaluateExpression('rm -rf'), /неизвестное имя|недопустимый символ/);
  assert.throws(() => evaluateExpression('foo(2)'), /неизвестное имя/);
  assert.throws(() => evaluateExpression('(2+3'), /несогласованн/);
});

test('калькулятор: findMathExpression в русском тексте', () => {
  const r = findMathExpression('сколько будет 234*7');
  assert.ok(r, 'выражение найдено');
  assert.equal(r.result, 1638);
  assert.equal(findMathExpression('напиши функцию на Python'), null);
});

/* ───────────────────────── Интенты ───────────────────────── */

test('интенты: погода с местом и без', () => {
  const w = classifyIntent('Какая погода в Иркутске сейчас?');
  assert.equal(w.intent, 'weather');
  assert.equal(w.slots.place, 'Иркутске');
  const w2 = classifyIntent('Какая погода?');
  assert.equal(w2.intent, 'weather');
  assert.equal(w2.slots.place, null);
});

test('extractWeatherPlace: предлоги и падежи', () => {
  assert.equal(extractWeatherPlace('сколько градусов в Москве'), 'Москве');
  assert.equal(extractWeatherPlace('прогноз погоды на завтра в Питере'), 'Питере');
});

test('интенты: время, математика, память, задачи, экран, окна', () => {
  assert.equal(classifyIntent('Который час?').intent, 'clock');
  assert.equal(classifyIntent('сколько будет 12*12').intent, 'math');
  assert.equal(classifyIntent('запомни, что мой проект называется LiteMind').intent, 'remember');
  assert.equal(classifyIntent('Напомни завтра в 10:00 позвонить').intent, 'task');
  assert.equal(classifyIntent('посмотри на экран и найди кнопку').intent, 'screen');
  assert.equal(classifyIntent('открой проводник').intent, 'windows');
});

test('интенты: поиск только при включённом интернете/глобусе', () => {
  const off = classifyIntent('найди новости про Иркутск', { webEnabled: false });
  assert.notEqual(off.intent, 'search');
  const on = classifyIntent('найди новости про Иркутск', { webEnabled: true });
  assert.equal(on.intent, 'search');
});

/* ───────────────────────── Даты напоминаний ───────────────────────── */

test('parseReminder: «завтра в 10:00»', () => {
  const now = new Date(2026, 10, 14, 8, 0); // 14.11.2026 08:00
  const r = parseReminder('Напомни завтра в 10:00 позвонить маме', { now });
  assert.ok(r.dueAt);
  assert.equal(r.dueAt.getDate(), 15);
  assert.equal(r.dueAt.getHours(), 10);
  assert.equal(r.repeat, 'none');
  assert.equal(r.text, 'позвонить маме');
});

test('parseReminder: «через 5 минут»', () => {
  const now = new Date(2026, 10, 14, 8, 0);
  const r = parseReminder('напомни через 5 минут проверить чайник', { now });
  const diff = r.dueAt.getTime() - now.getTime();
  assert.ok(diff >= 4.9 * 60_000 && diff <= 5.1 * 60_000, `разница ${diff}`);
});

test('parseReminder: повторы', () => {
  const now = new Date(2026, 10, 14, 8, 0);
  const wd = parseReminder('каждый будний день в 9:00 проверяй задачу', { now });
  assert.equal(wd.repeat, 'weekdays');
  assert.equal(wd.dueAt.getHours(), 9);
  assert.equal(wd.dueAt.getDay() >= 1 && wd.dueAt.getDay() <= 5, true);
  const daily = parseReminder('ежедневно в 8:00 зарядка', { now });
  assert.equal(daily.repeat, 'daily');
});

test('parseReminder: «в 18:30» без дня — сегодня или завтра', () => {
  const now = new Date(2026, 10, 14, 19, 0); // 19:00 — 18:30 уже прошло
  const r = parseReminder('напомни в 18:30 покормить кота', { now });
  assert.equal(r.dueAt.getDate(), 15); // завтра
});

test('parseReminder: без времени — честный null или дефолт 9 утра', () => {
  const now = new Date(2026, 10, 14, 12, 0);
  const r = parseReminder('запомни, что нужно закончить проект', { now });
  assert.equal(r.dueAt, null); // это не задача с напоминанием
  const r2 = parseReminder('напомни закончить проект', { now });
  assert.ok(r2.dueAt, 'для «напомни» без времени берём 9:00');
  assert.equal(r2.dueAt.getHours(), 9);
});

/* ───────────────────────── Память ───────────────────────── */

test('память: добавление, дедупликация, поиск, запрет тем', () => {
  const dir = tmpDir('memory');
  const m = new MemoryStore(dir, { logger: null });
  const a = m.add({ text: 'Мой проект называется LiteMind' });
  assert.equal(a.updated, false);
  const b = m.add({ text: 'мой проект называется litemind' });
  assert.equal(b.updated, true, 'дубликат обновляет запись');
  m.add({ text: 'Пользователь живёт в Иркутске', pinned: true });
  const hits = m.search('иркутск');
  assert.ok(hits.some((e) => e.text.includes('Иркутске')));
  m.blockTopic('пароль');
  assert.throws(() => m.add({ text: 'мой пароль: 123' }), /запрещено/, 'запретная тема отклоняется');
  const clear = m.clear({ keepPinned: true });
  assert.equal(clear.remaining, 1);
  assert.equal(m.entries[0].text.includes('Иркутске'), true);
  assert.equal(extractAutoFact('Меня зовут Алексей'), 'Имя пользователя: Алексей');
  assert.equal(extractAutoFact('Привет, как дела?'), null);
});

test('память: переживает перезапуск (загрузка с диска)', async () => {
  const dir = tmpDir('memory2');
  const m1 = new MemoryStore(dir);
  m1.add({ text: 'тест персистентности' });
  await m1._persist(); // запись асинхронная — дожидаемся перед перезагрузкой
  const m2 = new MemoryStore(dir);
  assert.equal(m2.entries.some((e) => e.text === 'тест персистентности'), true);
});

/* ───────────────────────── Задачи ───────────────────────── */

test('задачи: добавление, выполнение, повтор, срабатывание просроченных', async () => {
  const dir = tmpDir('tasks');
  const fired = [];
  const t = new TaskStore(dir, { logger: null, onDue: async (task) => fired.push(task.id) });
  const past = new Date(Date.now() - 60_000).toISOString();
  const task = t.add({ text: 'позвонить маме', dueAt: past, repeat: 'none' });
  await t._tick();
  assert.equal(fired.length, 1);
  assert.equal(t.tasks.find((x) => x.id === task.id).notifiedAt != null, true, 'сработавший не срабатывает снова');
  await t._tick();
  assert.equal(fired.length, 1, 'второй тик не дублирует');

  // Повтор: после срабатывания получает следующую дату в будущем.
  const t2 = new TaskStore(tmpDir('tasks2'), { logger: null });
  const rep = t2.add({ text: 'зарядка', dueAt: new Date(Date.now() - 30_000).toISOString(), repeat: 'daily' });
  await t2._tick();
  const after = t2.tasks.find((x) => x.id === rep.id);
  assert.equal(after.done, false);
  assert.ok(Date.parse(after.dueAt) > Date.now(), 'повтор сдвинут в будущее');
  assert.equal(after.notifiedAt, null, 'повтор ждёт следующего срабатывания');

  assert.equal(Boolean(t.complete(task.id)), true);
  assert.equal(t.list().some((x) => x.id === task.id && x.done), true);
  assert.equal(Boolean(t.reopen(task.id)), true);
  assert.equal(Boolean(t.remove(task.id)), true);
  t.stop();
});

test('задачи: переживают перезапуск', async () => {
  const dir = tmpDir('tasks3');
  const t1 = new TaskStore(dir, { logger: null });
  t1.add({ text: 'тест перезапуска', dueAt: new Date(Date.now() + 3600_000).toISOString() });
  await t1._persist(); // дождаться записи на диск
  t1.stop();
  const t2 = new TaskStore(dir, { logger: null });
  assert.equal(t2.tasks.some((x) => x.text === 'тест перезапуска'), true);
  t2.stop();
});

/* ───────────────────────── Компаньон ───────────────────────── */

test('компаньон: настройки с ограничениями, состояния, события', () => {
  const config = fixtureConfig(tmpDir('companion'));
  const c = new CompanionHub({ config });
  c.updateSettings({ size: 9999, opacity: 0.1 });
  assert.equal(config.companion.size, 280);
  assert.equal(config.companion.opacity, 0.4);
  assert.equal(c.setState('thinking', 'тест').stateLabel, 'Думает');
  c.event('tools', 'инструменты: погода');
  assert.equal(c.eventsList()[0].text, 'инструменты: погода');
  assert.equal(c.setState('nonsense').state, 'thinking', 'неизвестное состояние игнорируется');
});

/* ───────────────────────── Веб-поиск (мок) ───────────────────────── */

const DDG_FIXTURE = `<html><div class="result results_links">
<a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Firina&amp;rut=abc">Погода в Иркутске</a>
<a class="result__snippet" href="#">Текущая погода и прогноз</a>
</div></html>`;

test('поиск: разбор DDG HTML и unwrap трекер-ссылок', () => {
  const results = parseDdgHtml(DDG_FIXTURE);
  assert.equal(results.length, 1);
  assert.equal(results[0].url, 'https://example.com/irina');
  assert.equal(results[0].title, 'Погода в Иркутске');
  assert.equal(unwrapDdgUrl('//duckduckgo.com/l/?uddg=https%3A%2F%2Fa.b%2Fc&rut=x'), 'https://a.b/c');
  assert.equal(unwrapDdgUrl('https://direct.example.com'), 'https://direct.example.com');
});

test('поиск: webSearch на мок-fetch, честная ошибка при пустой выдаче', async () => {
  const okFetch = async () => ({ ok: true, status: 200, text: async () => DDG_FIXTURE });
  const r = await webSearch('погода иркутск', { fetchImpl: okFetch });
  assert.equal(r.results.length, 1);
  assert.equal(r.engine, 'duckduckgo');
  const emptyFetch = async () => ({ ok: true, status: 200, text: async () => '<html>ничего нет</html>' });
  await assert.rejects(() => webSearch('редкий запрос', { fetchImpl: emptyFetch }), /не вернул результатов|не удалась|не удался/);
});

/* ───────────────────────── Погода (мок Open-Meteo) ───────────────────────── */

function mockOpenMeteoFetch() {
  return async (url) => {
    const u = String(url);
    if (u.includes('geocoding-api')) {
      return { ok: true, status: 200, json: async () => ({ results: [{ latitude: 52.28, longitude: 104.3, name: 'Иркутск', country: 'Россия', country_code: 'RU', admin1: 'Иркутская область' }] }) };
    }
    if (u.includes('api.open-meteo.com')) {
      return {
        ok: true, status: 200,
        json: async () => ({ current: { time: '2026-11-14T15:00', temperature_2m: -3.4, apparent_temperature: -8.1, relative_humidity_2m: 71, weather_code: 71, wind_speed_10m: 12.3, is_day: 1 } })
      };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
}

test('погода: геокодирование + текущая погода с честными полями', async () => {
  const w = await currentWeather('Иркутск', { fetchImpl: mockOpenMeteoFetch() });
  assert.equal(w.place, 'Иркутск, Иркутская область, Россия');
  assert.equal(w.temperatureC, -3.4);
  assert.equal(w.description, 'слабый снег');
  assert.ok(w.observedAt.includes('2026-11-14'));
  assert.ok(w.source.includes('open-meteo.com'));
  assert.ok(w.summary.includes('-3 °C'));
  assert.equal(describeWeatherCode(0), 'ясно');
});

test('погода: неизвестное место — честная ошибка (никаких выдуманных значений)', async () => {
  const failing = async (url) => {
    if (String(url).includes('geocoding-api')) return { ok: true, status: 200, json: async () => ({}) };
    throw new Error('should not be called');
  };
  await assert.rejects(() => currentWeather('Нигдеград', { fetchImpl: failing }), /не найдено в геокодере/);
  const geo = await geocodePlace('Иркутск', { fetchImpl: mockOpenMeteoFetch() });
  assert.equal(geo.latitude, 52.28);
});

/* ───────────────────────── Intelligence Layer ───────────────────────── */

function makeLayer({ webEnabled = true, memory = null, tasks = null, host = null, fetchImpl = mockOpenMeteoFetch(), ddgFetch = async () => ({ ok: true, status: 200, text: async () => DDG_FIXTURE }) } = {}) {
  const dir = tmpDir('layer');
  const config = fixtureConfig(dir);
  const mem = memory ?? new MemoryStore(path.join(dir, 'memory'), { logger: null });
  const tsk = tasks ?? new TaskStore(path.join(dir, 'tasks'), { logger: null });
  const layer = createIntelligenceLayer({
    config, engine: null, logger: null, memory: mem, tasks: tsk,
    web: { enabled: () => webEnabled, fetchText: async (u) => ({ text: 'содержимое страницы примера ' + u }), fetchImpl },
    host
  });
  // Тестовый fetch для поиска — по URL.
  layer._testFetch = async (url) => (String(url).includes('duckduckgo') ? ddgFetch(url) : fetchImpl(url));
  return { layer, config, mem, tsk, dir };
}

test('слой: stop-последовательности и сэмплер по семейству модели', () => {
  assert.equal(modelFamily('deepseek-coder-1.3b-instruct.Q4_K_M'), 'deepseek');
  assert.equal(modelFamily('Qwen2.5-Coder-0.5B'), 'qwen');
  assert.ok(stopSequencesFor('qwen').includes('<|im_end|>'));
  assert.ok(stopSequencesFor('deepseek').includes('<|EOT|>'));
  const s = samplerFor('deepseek');
  assert.ok(s.repeat_penalty >= 1.1);
});

test('слой: погодный запрос при выключенном интернете — честный отказ, не выдумка', async () => {
  const { layer } = makeLayer({ webEnabled: false });
  const prep = await layer.prepareRequest({
    messages: [{ role: 'user', content: 'Какая погода в Иркутске?' }],
    model: 'deepseek-coder-1.3b-instruct.Q4_K_M'
  });
  const fact = prep.messages.find((m) => m.role === 'system' && String(m.content).includes('Данные инструмента'));
  assert.ok(fact, 'блок фактов добавлен');
  assert.ok(/Интернет выключен/.test(fact.content), 'факт честно сообщает об отключённом интернете');
  assert.equal(prep.meta.facts[0].ok, false);
});

test('слой: погодный запрос с включённым интернетом подставляет данные Open-Meteo', async () => {
  const { layer } = makeLayer({ webEnabled: true });
  const prep = await layer.prepareRequest({
    messages: [{ role: 'user', content: 'Какая погода в Иркутске?' }],
    model: 'qwen2.5-0.5b-instruct-q4_k_m'
  });
  const fact = prep.messages.find((m) => m.role === 'system' && String(m.content).includes('Open-Meteo'));
  assert.ok(fact, 'факт с данными Open-Meteo');
  assert.ok(/-3 °C/.test(fact.content), 'температура из источника');
  assert.ok(fact.content.includes('Время наблюдения'), 'время наблюдения');
});

test('слой: время и калькулятор — детерминированные факты', async () => {
  const { layer } = makeLayer();
  const clock = await layer.prepareRequest({ messages: [{ role: 'user', content: 'Который час?' }], model: 'm' });
  assert.ok(clock.messages.some((m) => String(m.content).includes('Локальное время компьютера')));
  const math = await layer.prepareRequest({ messages: [{ role: 'user', content: 'сколько будет 234*7' }], model: 'm' });
  assert.ok(math.messages.some((m) => String(m.content).includes('234*7 = 1638')));
});

test('слой: режим quick — без фактов и без памяти, минимальный префикс', async () => {
  const { layer } = makeLayer();
  const prep = await layer.prepareRequest({
    messages: [{ role: 'user', content: 'Какая погода в Иркутске?' }],
    model: 'm',
    modeOverride: 'quick'
  });
  assert.equal(prep.meta.mode, 'quick');
  assert.equal(prep.meta.facts.length, 0);
  assert.equal(prep.messages.filter((m) => m.role === 'system').length, 1);
});

test('слой: память подмешивается в smart-режиме', async () => {
  const dir = tmpDir('layer-mem');
  const mem = new MemoryStore(path.join(dir, 'memory'));
  mem.add({ text: 'Пользователь живёт в Иркутске', pinned: true });
  const { layer } = makeLayer({ memory: mem });
  const prep = await layer.prepareRequest({ messages: [{ role: 'user', content: 'что ты знаешь про Иркутск?' }], model: 'm' });
  assert.ok(prep.messages[0].content.includes('Пользователь живёт в Иркутске'), 'память в системном промпте');
  assert.equal(prep.meta.memoryUsed, 1);
});

test('слой: «запомни» сохраняет в память и подтверждает', async () => {
  const dir = tmpDir('layer-rem');
  const mem = new MemoryStore(path.join(dir, 'memory'));
  const { layer } = makeLayer({ memory: mem });
  const prep = await layer.prepareRequest({ messages: [{ role: 'user', content: 'запомни, что мой проект называется LiteMind' }], model: 'm' });
  assert.ok(prep.meta.toolsRun.includes('память'));
  assert.ok(mem.entries.some((e) => e.text.includes('LiteMind')));
});

test('слой: «напомни завтра в 10:00» создаёт задачу', async () => {
  const dir = tmpDir('layer-task');
  const tsk = new TaskStore(path.join(dir, 'tasks'), { logger: null });
  const { layer } = makeLayer({ tasks: tsk });
  const prep = await layer.prepareRequest({ messages: [{ role: 'user', content: 'Напомни завтра в 10:00 позвонить маме' }], model: 'm' });
  assert.ok(prep.meta.toolsRun.includes('задачи'));
  assert.equal(tsk.tasks.length, 1);
  assert.ok(tsk.tasks[0].dueAt);
  assert.ok(tsk.tasks[0].text.includes('позвонить маме'));
});

test('слой: самопроверка — утечки токенов, повторы, роли; cleanReplyText', () => {
  const bad = checkReply({ text: 'Ответ <|im_end|> продолжение' });
  assert.equal(bad.ok, false);
  assert.ok(bad.issues.some((i) => i.includes('токенов')));
  const looped = checkReply({ text: Array(4).fill('я повторяю один и тот же текст снова и снова каждое утро').join(' ') });
  assert.equal(looped.ok, false);
  assert.ok(looped.issues.some((i) => i.includes('повтор')));
  assert.equal(checkReply({ text: '' }).ok, false);
  assert.equal(checkReply({ text: 'Обычный нормальный ответ на вопрос пользователя.' }).ok, true);
  const cleaned = cleanReplyText('Привет <|im_end|> мир <|endoftext|>');
  assert.ok(!cleaned.includes('im_end'));
  assert.ok(!cleaned.includes('endoftext'));
  assert.ok(cleaned.includes('Привет'));
  assert.ok(cleaned.includes('мир'));
});

test('слой: экран без разрешения — честный отказ', async () => {
  const { layer } = makeLayer({ host: { captureScreenText: async () => ({ ok: true, text: 'экран' }) } });
  const prep = await layer.prepareRequest({ messages: [{ role: 'user', content: 'посмотри на экран' }], model: 'm' });
  const fact = prep.messages.find((m) => String(m.content).includes('Данные инструмента'));
  assert.ok(/выключена|выключен/.test(fact.content), 'без разрешения — отказ');
});

test('слой: экран с разрешением и host-мостом — текст экрана в фактах', async () => {
  const dir = tmpDir('layer-screen');
  const config = fixtureConfig(dir);
  config.intelligence.permissions.screenLook = true;
  const host = { captureScreenText: async () => ({ ok: true, text: 'Кнопка Сохранить, поле поиска', retrievedAt: new Date().toISOString() }) };
  const layer = createIntelligenceLayer({
    config, engine: null, logger: null,
    memory: new MemoryStore(path.join(dir, 'memory')), tasks: new TaskStore(path.join(dir, 'tasks')),
    web: { enabled: () => true, fetchText: async () => ({ text: '' }), fetchImpl: mockOpenMeteoFetch() },
    host
  });
  const prep = await layer.prepareRequest({ messages: [{ role: 'user', content: 'что открыто на экране?' }], model: 'm' });
  const fact = prep.messages.find((m) => String(m.content).includes('Кнопка Сохранить'));
  assert.ok(fact, 'текст экрана передан модели');
});

/* ───────────────────────── Голос ───────────────────────── */

test('голос: каталог с реальными SHA-256 (не плейсхолдеры) и размерами', () => {
  for (const [id, c] of Object.entries(VOICE_COMPONENTS)) {
    assert.ok(!c.sha256.startsWith('PLACEHOLDER'), `${id}: sha256 должен быть вычислен из реального файла`);
    assert.ok(c.sizeBytes > 0, `${id}: размер известен`);
    assert.ok(c.url.startsWith('https://'), `${id}: https-источник`);
  }
});

test('голос: статус без установки — честные not installed', async () => {
  const dir = tmpDir('voice');
  const config = fixtureConfig(dir);
  const v = createVoiceManager({ config, logger: null });
  const st = await v.status();
  assert.equal(st.supported, process.platform === 'win32');
  assert.equal(st.tts.installed, false);
  assert.equal(st.asr.installed, false);
  assert.ok(st.components.length >= 5);
  const tts = await v.tts('тест');
  if (process.platform !== 'win32') assert.equal(tts.ok, false);
});

/* ───────────────────────── HTTP API сервера ───────────────────────── */

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

async function req(port, method, p, body) {
  const res = await fetch(`http://127.0.0.1:${port}${p}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

test('HTTP API v0.6.4: память, задачи, интеллект, компаньон — полный цикл', async () => {
  const dir = tmpDir('server');
  const config = fixtureConfig(dir);
  config.web.enabled = false; // поиск/погода должны честно отказать
  const { engine, config: _c, logger, perf, backend, sampler } = await import('./helpers/fixtures.js').then((m) => m.makeEngine({ configMutator: (c) => { c.paths = config.paths; } }));
  const server = createServer({ config, engine, logger, downloads: null });
  const port = await listen(server);
  try {
    // Интеллект: GET/POST режима.
    let r = await req(port, 'GET', '/api/intelligence');
    assert.equal(r.status, 200);
    assert.equal(r.data.mode, 'smart');
    r = await req(port, 'POST', '/api/intelligence', { mode: 'expert', permissions: { screenLook: true } });
    assert.equal(r.data.config.mode, 'expert');
    assert.equal(r.data.config.permissions.screenLook, true);
    r = await req(port, 'POST', '/api/intelligence', { mode: 'bogus' });
    assert.equal(r.status, 200);
    assert.equal((await req(port, 'GET', '/api/intelligence')).data.mode, 'expert');

    // Память: добавить → найти → запретить.
    r = await req(port, 'POST', '/api/memory', { text: 'Проект пользователя: LiteMind' });
    assert.equal(r.status, 200);
    const memId = r.data.entry.id;
    r = await req(port, 'POST', '/api/memory/search', { query: 'litemind' });
    assert.equal(r.data.entries.length, 1);
    r = await req(port, 'PATCH', `/api/memory/${memId}`, { text: 'Проект пользователя: LiteMind Engine' });
    assert.equal(r.status, 200);
    r = await req(port, 'POST', '/api/memory/block', { topic: 'секреты' });
    assert.equal(r.status, 200);
    r = await req(port, 'POST', '/api/memory', { text: 'мои секреты в сейфе' });
    assert.equal(r.status, 403);
    r = await req(port, 'DELETE', `/api/memory/${memId}`);
    assert.equal(r.status, 200);

    // Задачи: создать → завершить → удалить.
    r = await req(port, 'POST', '/api/tasks', { text: 'тестовая задача', dueAt: new Date(Date.now() + 3600_000).toISOString() });
    assert.equal(r.status, 200);
    const taskId = r.data.task.id;
    r = await req(port, 'POST', `/api/tasks/${taskId}/complete`, {});
    assert.equal(r.status, 200);
    r = await req(port, 'DELETE', `/api/tasks/${taskId}`);
    assert.equal(r.status, 200);

    // Компаньон: статус, настройки, события.
    r = await req(port, 'GET', '/api/companion/status');
    assert.equal(r.status, 200);
    r = await req(port, 'POST', '/api/companion/settings', { character: 'spark', size: 200 });
    assert.equal(r.data.settings.character, 'spark');
    r = await req(port, 'POST', '/api/companion/event', { type: 'note', text: 'тест события' });
    assert.equal(r.status, 200);
    r = await req(port, 'GET', '/api/companion/events');
    assert.ok(r.data.events.some((e) => e.text === 'тест события'));

    // Честный отказ веб-инструментов при выключенном интернете.
    r = await req(port, 'POST', '/api/web/search', { query: 'тест' });
    assert.equal(r.status, 403);
    r = await req(port, 'POST', '/api/web/weather', { place: 'Иркутск' });
    assert.equal(r.status, 403);

    // Голос: статус отвечает, ASR/TTS без установки — честный отказ.
    r = await req(port, 'GET', '/api/voice/status');
    assert.equal(r.status, 200);
    r = await req(port, 'POST', '/api/voice/tts', { text: 'привет' });
    assert.ok([503, 500].includes(r.status), `TTS без движка отказывает: ${r.status}`);
  } finally {
    server.close();
    server.closeAllConnections?.();
    perf?.stop?.();
    sampler?.stop?.();
    void backend?.shutdown?.().catch?.(() => {});
  }
});

/* ───────────────────────── Прогон агента с инструментами v0.6.4 ───────── */

test('агент: пошаговый таймаут — «Обдумывание шага» не вечен', async () => {
  const { AgentManager } = await import('../src/agent/session.js');
  const dir = tmpDir('agent-timeout');
  const config = fixtureConfig(dir);
  config.agent = { ...(config.agent ?? {}), stepTimeoutMs: 50 };
  const neverResolve = () => new Promise((_resolve, reject) => {
    const e = new Error('таймаут шага — модель отвечала слишком долго');
    e.code = 'STEP_TIMEOUT';
    setTimeout(() => reject(e), 30);
  });
  const agent = new AgentManager({
    config, engine: null, logger: null,
    generateFn: neverResolve
  });
  const s = agent.createSession({ title: 'тест таймаута' });
  await agent.postMessage(s.id, { text: 'проверь что-нибудь', wait: true });
  const session = agent.getSession(s.id);
  assert.equal(session.state, 'error', 'зависший шаг завершается ошибкой');
  assert.ok(session.error.includes('таймаут') || session.error.includes('Timeout') || session.error.includes('время'));
});

/* ───────────────────────── Think-фильтр lmlama (ТЗ §4) ───────────────── */

test('think-фильтр: скрытые размышления не попадают в стрим, разрыв тегов держится', async () => {
  const { makeThinkFilter } = await import('../src/backends/lmlama.js');
  const f = makeThinkFilter();
  let out = '';
  out += f.push('До <th');
  out += f.push('ink>скрытый reasoning прод');
  out += f.push('олжается</thi');
  out += f.push('nk>После');
  out += f.flush();
  assert.equal(out, 'До После');
  const g = makeThinkFilter();
  const plain = g.push('привет, мир!') + g.flush();
  assert.equal(plain, 'привет, мир!', 'модель без think — текст идёт без задержек');
  const h = makeThinkFilter();
  const unclosed = h.push('a<think>внутри оборванной генерации') + h.flush();
  assert.ok(unclosed.startsWith('a'), 'хвост честно возвращается');
  const q = makeThinkFilter();
  const two = q.push('<think>1</think>') + q.push('A<think>2</think>B') + q.flush();
  assert.equal(two, 'AB');
});

test('cleanReplyText вычищает <think> и служебные токены', async () => {
  const cleaned = cleanReplyText('<think>размышления</think>Готовый ответ <|im_end|>');
  assert.equal(cleaned, 'Готовый ответ');
});
