// Smoke AI Agent v0.6.1 — Windows CI: реальная многошаговая задача на живой
// модели (Qwen3-0.6B-Q8_0) через установленное приложение (движок на 8399).
//
// Проверяет (ТЗ §12.8 + дополнение к ТЗ):
//   1. анализ проекта (list_files)          4. уточнение во время задачи
//   2. создание файла (write_file + diff)   5. остановка задачи
//   3. выполнение команды (terminal)        6. итоговый отчёт
//   7. Chat/Engine продолжает работать во время задачи агента
//
// Использование: node smoke-stage2-agent.mjs --model <имя> --port 8399 --out <файл>
// Режим CI: autoApprove=true (изменения применяются автоматически, лог полный).

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === '--model') args.model = process.argv[++i];
  else if (process.argv[i] === '--port') args.port = Number(process.argv[++i]);
  else if (process.argv[i] === '--out') args.out = process.argv[++i];
}
const PORT = args.port || 8399;
const BASE = `http://127.0.0.1:${PORT}`;
const MODEL = args.model || 'Qwen3-0.6B-Q8_0';
const OUT = args.out || path.join(os.tmpdir(), 'smoke-agent.json');

const checks = [];
const check = (name, ok, details) => {
  checks.push({ name, ok: !!ok, details: String(details ?? '').slice(0, 1200) });
  console.log(`${ok ? '[ПАСС]' : '[ПРОВАЛ]'} ${name} — ${String(details ?? '').slice(0, 300)}`);
};

async function jget(p) { const r = await fetch(BASE + p); return { status: r.status, body: await r.json().catch(() => null) }; }
async function jpost(p, body, timeoutMs = 60000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(new Error('client timeout')), timeoutMs);
  try {
    const r = await fetch(BASE + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}), signal: ctrl.signal });
    return { status: r.status, body: await r.json().catch(() => null) };
  } finally { clearTimeout(t); }
}

async function waitForState(id, states, timeoutMs, { quiet = false } = {}) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < timeoutMs) {
    await new Promise((r) => setTimeout(r, 3000));
    const g = await jget(`/api/agent/sessions/${id}`);
    last = g.body;
    if (!quiet && last?.currentStage) console.log(`   … ${last.currentStage} (шаг ${last.stats?.steps ?? 0})`);
    if (states.includes(last?.state)) return last;
  }
  return last;
}

async function main() {
  const result = { startedAt: new Date().toISOString(), model: MODEL, port: PORT, checks };
  const health = await jget('/health');
  check('движок приложения отвечает (health 200)', health.status === 200, `HTTP ${health.status}`);

  // Проект для агента
  const proj = path.join(os.tmpdir(), 'agent-proj');
  fs.rmSync(proj, { recursive: true, force: true });
  fs.mkdirSync(path.join(proj, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(proj, 'docs', 'note.txt'), 'тестовый проект LiteMind\n', 'utf8');

  // ── Задача 1: реальный многошаговый сценарий ────────────────────────────
  const s1 = await jpost('/api/agent/sessions', {
    projectDir: proj, model: MODEL, autoApprove: true,
    title: 'smoke: создать hello.js',
    firstMessage: 'Задача (выполняется ТОЛЬКО инструментами, словами не отчитываться): создай файл hello.js инструментом write_file — файл содержит строку «Привет, LiteMind!». После реального результата инструмента заверши задачу отчётом DONE.'
  });
  check('задача принята агентом', s1.status === 200 && !!s1.body?.id, `HTTP ${s1.status}, id=${s1.body?.id}`);
  const id1 = s1.body.id;

  // Chat движка работает ПАРАЛЛЕЛЬНО с задачей агента (переключение Chat/Agent)
  const chatDuring = jpost('/v1/chat/completions', {
    model: MODEL, stream: false, max_tokens: 24,
    messages: [{ role: 'user', content: 'Ответь одним словом: работает? /no_think' }]
  }, 180000);

  const fin1 = await waitForState(id1, ['done', 'error', 'stopped'], 8 * 60_000);
  result.agentTask1 = { state: fin1?.state, steps: fin1?.stats?.steps, error: fin1?.error ?? null };
  check('агент завершил задачу (state=done)', fin1?.state === 'done', `state=${fin1?.state}, шагов=${fin1?.stats?.steps}, ошибка=${fin1?.error ?? 'нет'}`);

  const helloPath = path.join(proj, 'hello.js');
  let helloOk = false;
  let helloContent = '';
  try { helloContent = fs.readFileSync(helloPath, 'utf8'); helloOk = helloContent.includes('Привет, LiteMind!'); } catch { /* нет файла */ }
  check('файл hello.js создан агентом с нужной строкой', helloOk, helloContent ? helloContent.slice(0, 200) : 'файл не найден');

  // Terminal вынесен в отдельную одношаговую инструкцию: прогон v0.6.2 №2
  // показал, что Qwen3-0.6B в многошаговой задаче завершает DONE после
  // write_file, не дойдя до terminal («команд не было»); прогон №3 — команда
  // node -e "..." с вложенными кавычками непосильна (SyntaxError, 19 шагов);
  // прогон №4 — 6× terminal с пустыми args + файл без console.log не печатает
  // ничего. Итог: команда echo smoke-terminal-ok (без кавычек и без
  // зависимости от сгенерированного моделью кода) + явный ПРИМЕР 3 в
  // системном промпте агента (args.command обязателен). История сессии
  // накапливается — terminal ищем по всей сессии, ok:false отбрасываем.
  const s1t = await jpost(`/api/agent/sessions/${id1}/messages`, {
    text: 'Следующий шаг (только инструментами): инструментом terminal выполни команду echo smoke-terminal-ok и после реального вывода инструмента заверши задачу отчётом DONE.'
  });
  check('terminal-инструкция принята агентом', s1t.status === 200, `HTTP ${s1t.status}`);
  const fin1t = await waitForState(id1, ['done', 'error', 'stopped'], 5 * 60_000);
  const runAll = (fin1t?.messages ?? []).filter((m) => m.role === 'tool' && m.tool === 'terminal');
  const runOk = runAll.some((m) => m.ok !== false && String(m.result ?? '').includes('smoke-terminal-ok'));
  check('агент выполнил команду и получил реальный вывод', runOk, runAll.map((m) => String(m.result).slice(0, 120)).join(' | ') || 'команд не было');
  result.agentTerminal = { state: fin1t?.state, steps: fin1t?.stats?.steps, terminalCalls: runAll.length };

  // ── Уточнение во время задачи (дополнение к ТЗ) ─────────────────────────
  const s2 = await jpost(`/api/agent/sessions/${id1}/messages`, {
    text: 'Продолжаем (только инструментами): инструментом edit_file добавь в конец файла hello.js строку-комментарий «// smoke test ok», затем инструментом terminal выполни команду echo ok. После реального результата — DONE.'
  });
  check('уточнение принято во время диалога', s2.status === 200, `HTTP ${s2.status}`);
  const fin2 = await waitForState(id1, ['done', 'error', 'stopped'], 6 * 60_000);
  let clarOk = false;
  try { clarOk = fs.readFileSync(helloPath, 'utf8').includes('// smoke test ok'); } catch { /* */ }
  check('уточнение выполнено: комментарий добавлен в файл', clarOk, `state=${fin2?.state}`);
  result.agentClarification = { state: fin2?.state, steps: fin2?.stats?.steps };

  // Диалог с историей: агент помнит контекст
  const s3 = await jpost(`/api/agent/sessions/${id1}/messages`, { text: 'Какой файл ты создал в этой задаче? Ответь одним названием.' });
  const fin3 = await waitForState(id1, ['idle', 'done', 'error', 'stopped'], 4 * 60_000);
  const lastAssistant = (fin3?.messages ?? []).filter((m) => m.role === 'assistant').pop();
  const memOk = lastAssistant && /hello\.js/i.test(lastAssistant.text ?? '');
  check('агент помнит историю диалога', !!memOk, (lastAssistant?.text ?? 'нет ответа').slice(0, 150));

  // Результат параллельного чата
  try {
    const chat = await chatDuring;
    const text = chat.body?.choices?.[0]?.message?.content ?? '';
    check('Chat работает во время задачи агента', chat.status === 200 && text.length > 0, `HTTP ${chat.status}, символов=${text.length}`);
  } catch (e) {
    check('Chat работает во время задачи агента', false, String(e.message));
  }

  // ── Остановка задачи ────────────────────────────────────────────────────
  const s4 = await jpost('/api/agent/sessions', {
    projectDir: proj, model: MODEL, autoApprove: true,
    title: 'smoke: остановка',
    firstMessage: 'Выполни инструментом terminal команду ping -n 30 127.0.0.1 и после её реального результата напиши TEXT с числом потерь.'
  });
  // ждём входа в running, затем останавливаем
  let enteredRunning = false;
  for (let i = 0; i < 75; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const g = await jget(`/api/agent/sessions/${s4.body.id}`);
    if (g.body?.state === 'running') { enteredRunning = true; break; }
    if (['done', 'error', 'stopped'].includes(g.body?.state)) break;
  }
  const stop = await jpost(`/api/agent/sessions/${s4.body.id}/stop`);
  check('остановка задачи принята', stop.status === 200 && stop.body?.state === 'stopped', `HTTP ${stop.status}, state=${stop.body?.state}, был running=${enteredRunning}`);
  await new Promise((r) => setTimeout(r, 4000));
  const after = await jget(`/api/agent/sessions/${s4.body.id}`);
  check('сессия остаётся остановленной (цикл не возобновился)', after.body?.state === 'stopped', `state=${after.body?.state}`);

  // ── Персистентность: сессии на диске движка ─────────────────────────────
  const list = await jget('/api/agent/sessions');
  check('список задач агента доступен (персистентность)', list.status === 200 && (list.body?.sessions?.length ?? 0) >= 2, `задач=${list.body?.sessions?.length}`);

  result.finishedAt = new Date().toISOString();
  result.status = { passed: checks.filter((c) => c.ok).length, total: checks.length };
  fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
  console.log(`\nИТОГ: ${result.status.passed}/${result.status.total} проверок пройдено → ${OUT}`);
  process.exit(result.status.passed === result.status.total ? 0 : 1);
}

main().catch((e) => {
  check('smoke агента не упал целиком', false, String(e?.stack ?? e).slice(0, 600));
  fs.writeFileSync(OUT, JSON.stringify({ checks }, null, 2));
  process.exit(1);
});
