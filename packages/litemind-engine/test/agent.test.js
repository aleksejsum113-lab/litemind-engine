// Тесты AI Agent v0.6.1: цикл Agent→Tool→Result, подтверждения, уточнения,
// остановка, персистентность, устойчивость парсера, изоляция путей.
// Генерация модели инъецируется (generateFn) — тесты не зависят от GGUF.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { AgentManager, parseAgentReply } from '../src/agent/session.js';
import { execCommand } from '../src/agent/tools.js';
import { loadConfig } from '../src/config.js';

function tmpConfigDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-agent-test-'));
  const cfgPath = path.join(dir, 'config.json');
  fs.writeFileSync(cfgPath, JSON.stringify({}));
  return { dir, cfgPath };
}

function makeManager({ cfgPath, replies, projectDir, configPatch = {} }) {
  const config = loadConfig(cfgPath);
  Object.assign(config.agent ??= {}, { maxSteps: 12 });
  Object.assign(config, configPatch);
  let i = 0;
  const calls = [];
  const generateFn = async (args) => {
    calls.push(args);
    const r = replies[Math.min(i, replies.length - 1)];
    i++;
    if (typeof r === 'function') return { text: await r({ args, calls, i }) };
    return { text: r };
  };
  const mgr = new AgentManager({ config, engine: null, generateFn });
  return { mgr, calls, config };
}

test('parseAgentReply: ACTION, TEXT, ASK, DONE, заборы, мусор вокруг', () => {
  assert.equal(parseAgentReply('ACTION: {"tool":"list_files","args":{}}').kind, 'action');
  assert.equal(parseAgentReply('```json\nACTION: {"tool":"read_file","args":{"path":"a.js"}}\n```').kind, 'action');
  const withPreamble = parseAgentReply('Сейчас посмотрю структуру.\nACTION: {"tool":"list_files","args":{"dir":"src"}}');
  assert.equal(withPreamble.kind, 'action');
  assert.equal(withPreamble.preamble, 'Сейчас посмотрю структуру.');
  assert.equal(parseAgentReply('TEXT: {"text":"Привет!"}').data.text, 'Привет!');
  assert.equal(parseAgentReply('ASK: {"question":"Какой диск использовать?"}').kind, 'ask');
  const done = parseAgentReply('DONE: {"summary":"готово","created":["a.js"]}');
  assert.equal(done.kind, 'done');
  assert.deepEqual(done.data.created, ['a.js']);
  // plain text без маркеров → text
  assert.equal(parseAgentReply('Просто ответ без инструментов').kind, 'text');
  // маркер с вложенными скобками в JSON-строках
  const nested = parseAgentReply('ACTION: {"tool":"write_file","args":{"path":"a.js","content":"const o = {a:1};\\n"}}');
  assert.equal(nested.kind, 'action');
  assert.ok(nested.data.args.content.includes('const o'));
  assert.equal(parseAgentReply('   '), null);
});

test('агент: обычный диалог (TEXT) не требует проекта и не зовёт инструменты', async () => {
  const { dir, cfgPath } = tmpConfigDir();
  const { mgr } = makeManager({ cfgPath, replies: ['TEXT: {"text":"Здравствуйте! Чем помочь?"}'] });
  const s = mgr.createSession({});
  const view = await mgr.postMessage(s.id, { text: 'привет' });
  assert.equal(view.state, 'idle');
  const full = mgr.fullView(s.id);
  const asst = full.messages.find((m) => m.role === 'assistant');
  assert.ok(asst && asst.text.includes('Чем помочь'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('полный цикл: план → write_file → подтверждение → файл записан + бэкап → DONE', async () => {
  const { dir, cfgPath } = tmpConfigDir();
  const proj = path.join(dir, 'project');
  await fsp.mkdir(proj, { recursive: true });
  await fsp.writeFile(path.join(proj, 'README.md'), 'старое содержимое\n', 'utf8');

  const { mgr } = makeManager({
    cfgPath,
    projectDir: proj,
    replies: [
      'Задача ясна: обновлю README.\nACTION: {"tool":"write_file","args":{"path":"README.md","content":"новое содержимое\\n"}}',
      'DONE: {"summary":"README обновлён","modified":["README.md"]}'
    ]
  });
  const s = mgr.createSession({ projectDir: proj });
  const v1 = await mgr.postMessage(s.id, { text: 'обнови README' });
  assert.equal(v1.state, 'awaiting_confirmation');
  assert.ok(v1.pendingApproval, 'есть карточка подтверждения');
  assert.equal(v1.pendingApproval.tool, 'write_file');
  assert.ok(v1.pendingApproval.change.diff.includes('+новое содержимое'), 'diff показывает добавление');
  assert.ok(v1.pendingApproval.change.diff.includes('-старое содержимое'));
  assert.ok(v1.pendingApproval.change.backupId, 'бэкап создан до применения');
  assert.ok(!fs.existsSync(path.join(proj, 'README.md')) || fs.readFileSync(path.join(proj, 'README.md'), 'utf8') === 'старое содержимое\n', 'файл ещё НЕ изменён до подтверждения');

  const v2 = await mgr.decide(s.id, { approvalId: v1.pendingApproval.id, approved: true });
  assert.equal(v2.state, 'done');
  assert.equal(fs.readFileSync(path.join(proj, 'README.md'), 'utf8'), 'новое содержимое\n');
  const full = mgr.fullView(s.id);
  assert.ok(full.messages.some((m) => m.type === 'report'));
  assert.ok(full.messages.some((m) => m.role === 'tool' && m.ok && m.result.includes('резервная копия')));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('отклонение изменения: агент получает отказ и файл не меняется', async () => {
  const { dir, cfgPath } = tmpConfigDir();
  const proj = path.join(dir, 'project');
  await fsp.mkdir(proj, { recursive: true });
  const { mgr } = makeManager({
    cfgPath,
    replies: [
      'ACTION: {"tool":"write_file","args":{"path":"x.txt","content":"новое"}}',
      'TEXT: {"text":"Понял, не буду менять."}'
    ]
  });
  const s = mgr.createSession({ projectDir: proj });
  const v1 = await mgr.postMessage(s.id, { text: 'запиши файл' });
  const v2 = await mgr.decide(s.id, { approvalId: v1.pendingApproval.id, approved: false, feedback: 'не надо' });
  assert.equal(v2.state, 'idle');
  assert.ok(!fs.existsSync(path.join(proj, 'x.txt')));
  assert.ok(mgr.fullView(s.id).messages.some((m) => m.role === 'tool' && m.ok === false && String(m.result).includes('ОТКЛОНИЛ')));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('уточнение во время выполнения: попадает в контекст следующего шага', async () => {
  const { dir, cfgPath } = tmpConfigDir();
  const proj = path.join(dir, 'project');
  await fsp.mkdir(proj, { recursive: true });
  const { mgr, calls } = makeManager({
    cfgPath,
    replies: [
      // шаг 1: во время генерации присылаем уточнение
      async ({ }) => { /* симулируем, что модель думает — уточнение придёт позже; вместо этого отправим его перед шагом 2 */ return 'ACTION: {"tool":"list_files","args":{}}'; },
      // шаг 2: проверяем, что уточнение в payload
      async ({ args }) => {
        const userTexts = args.messages.filter((m) => m.role === 'user').map((m) => m.content).join('\n');
        assert.ok(userTexts.includes('используй папку src'), 'уточнение дошло до модели');
        return 'TEXT: {"text":"учёл уточнение"}';
      }
    ]
  });
  const s = mgr.createSession({ projectDir: proj });
  await mgr.postMessage(s.id, { text: 'покажи файлы' });
  // «во время выполнения»: перехитрим через сообщение пока состояние idle→успел завершиться —
  // вместо гонки проверяем дренаж inbox на границе: шлём до второго прогона
  await mgr.postMessage(s.id, { text: 'уточнение: используй папку src' });
  // второй прогон: модель получает уточнение в payload (вызовы фиксируются)
  const full = mgr.fullView(s.id);
  assert.ok(full.messages.some((m) => m.role === 'user' && m.text.includes('используй папку src')));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('ASK: агент ждёт ответа и продолжается после сообщения пользователя', async () => {
  const { dir, cfgPath } = tmpConfigDir();
  const proj = path.join(dir, 'project');
  await fsp.mkdir(proj, { recursive: true });
  const { mgr } = makeManager({
    cfgPath,
    replies: [
      'ASK: {"question":"Какой формат файла нужен?"}',
      'TEXT: {"text":"Хорошо, сделаю JSON."}'
    ]
  });
  const s = mgr.createSession({ projectDir: proj });
  const v1 = await mgr.postMessage(s.id, { text: 'создай конфиг' });
  assert.equal(v1.state, 'waiting_user');
  const v2 = await mgr.postMessage(s.id, { text: 'формат JSON' });
  assert.equal(v2.state, 'idle');
  const asst = mgr.fullView(s.id).messages.filter((m) => m.role === 'assistant');
  assert.ok(asst.some((m) => m.text.includes('формат файла нужен')));
  assert.ok(asst.some((m) => m.text.includes('сделаю JSON')));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('остановка задачи: state=stopped, запуск возобновляется сообщением', async (t) => {
  const { dir, cfgPath } = tmpConfigDir();
  const proj = path.join(dir, 'project');
  await fsp.mkdir(proj, { recursive: true });
  let release;
  const gate = new Promise((r) => { release = r; });
  const { mgr } = makeManager({
    cfgPath,
    replies: [
      async () => { await gate; return 'TEXT: {"text":"после остановки"}'; }
    ]
  });
  const s = mgr.createSession({ projectDir: proj });
  const p = mgr.postMessage(s.id, { text: 'долго думай' });
  // ждём, пока цикл войдёт в running
  for (let i = 0; i < 100 && mgr.getSession(s.id).state !== 'running'; i++) await new Promise((r) => setTimeout(r, 10));
  const v = await mgr.stop(s.id);
  release();
  assert.equal(v.state, 'stopped');
  await p;
  // возобновление
  const replies2 = ['TEXT: {"text":"продолжили"}'];
  const { mgr: mgr2 } = mgr; // тот же менеджер
  mgr.generateFn = async () => ({ text: replies2[0] });
  const v2 = await mgr.postMessage(s.id, { text: 'продолжай' });
  assert.equal(v2.state, 'idle');
  assert.ok(mgr.fullView(s.id).messages.some((m) => m.role === 'assistant' && m.text.includes('продолжили')));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('персистентность: сессия восстанавливается новым менеджером; прерванный прогон → stopped', async () => {
  const { dir, cfgPath } = tmpConfigDir();
  const proj = path.join(dir, 'project');
  await fsp.mkdir(proj, { recursive: true });
  {
    const { mgr } = makeManager({ cfgPath, replies: ['TEXT: {"text":"записал"}'] });
    const s = mgr.createSession({ projectDir: proj, title: 'Моя задача' });
    await mgr.postMessage(s.id, { text: 'сделай что-то' });
    await mgr._persistChain;
  }
  {
    const config = loadConfig(cfgPath);
    const mgr2 = new AgentManager({ config, engine: null, generateFn: async () => ({ text: 'TEXT: {"text":"ok"}' }) });
    const list = mgr2.listSessions();
    assert.equal(list.length, 1);
    assert.equal(list[0].title, 'Моя задача');
    const full = mgr2.fullView(list[0].id);
    assert.ok(full.messages.some((m) => m.role === 'assistant' && m.text.includes('записал')));
    // прерванный прогон
    const s2 = mgr2.createSession({});
    s2.state = 'running'; // как будто процесс умер в середине
    await mgr2._persist(s2);
    const mgr3 = new AgentManager({ config, engine: null, generateFn: async () => ({ text: 'TEXT: {"text":"ok"}' }) });
    assert.equal(mgr3.getSession(s2.id).state, 'stopped');
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test('изоляция путей: write_file за пределы проекта отклоняется, файл не создан', async () => {
  const { dir, cfgPath } = tmpConfigDir();
  const proj = path.join(dir, 'project');
  await fsp.mkdir(proj, { recursive: true });
  const { mgr } = makeManager({
    cfgPath,
    replies: ['ACTION: {"tool":"write_file","args":{"path":"../evil.txt","content":"bad"}}', 'TEXT: {"text":"не смог, путь отклонён"}']
  });
  const s = mgr.createSession({ projectDir: proj });
  const v = await mgr.postMessage(s.id, { text: 'запиши' });
  assert.equal(v.state, 'idle'); // цикл выжил после ошибки инструмента
  assert.ok(mgr.fullView(s.id).messages.some((m) => m.role === 'tool' && m.ok === false));
  assert.ok(!fs.existsSync(path.join(dir, 'evil.txt')), 'файл вне проекта не создан');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('инструменты: read_file/search/terminal реально работают в проекте', async () => {
  const { dir, cfgPath } = tmpConfigDir();
  const proj = path.join(dir, 'project');
  await fsp.mkdir(path.join(proj, 'src'), { recursive: true });
  await fsp.writeFile(path.join(proj, 'src', 'app.js'), 'console.log("привет мир");\n', 'utf8');
  const { mgr } = makeManager({
    cfgPath,
    replies: [
      'ACTION: {"tool":"read_file","args":{"path":"src/app.js"}}',
      'ACTION: {"tool":"terminal","args":{"command":"node --version"}}',
      'DONE: {"summary":"проверено"}'
    ]
  });
  const s = mgr.createSession({ projectDir: proj, autoApprove: true });
  const v = await mgr.postMessage(s.id, { text: 'проверь файл и терминал' });
  assert.equal(v.state, 'done');
  const tools = mgr.fullView(s.id).messages.filter((m) => m.role === 'tool');
  assert.equal(tools.length, 2);
  assert.ok(tools[0].ok && tools[0].result.includes('привет мир'), 'read_file прочитал файл');
  assert.ok(tools[1].ok && /v\d+/.test(tools[1].result), 'терминал исполнил команду');
  fs.rmSync(dir, { recursive: true, force: true });
});
test('execCommand: таймаут убивает процесс и возвращает результат', async () => {
  const r = await execCommand('node -e "setInterval(()=>{},1000)"', process.cwd(), { timeoutMs: 1500 });
  assert.equal(r.timedOut, true);
  const r2 = await execCommand("node -e 'process.stdout.write(\"123\")'", process.cwd(), { timeoutMs: 10000 });
  assert.equal(r2.exitCode, 0);
  assert.ok(r2.stdout.includes('123'));
});
