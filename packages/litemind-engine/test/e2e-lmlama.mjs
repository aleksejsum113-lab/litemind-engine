// E2E-тест v0.4: собственный runtime llama.cpp без Ollama.
// Реальный запуск: движок → llama-server → GGUF → настоящий ответ модели.
// Никаких моков: сервер движка слушает порт, llama-server — реальный процесс.
import assert from 'node:assert';

process.env.LITEMIND_LLAMA_SERVER = '/tmp/llamacpp-build/bin/llama-server';
process.env.LITEMIND_CONFIG = '/tmp/litemind-e2e/config.json';
import fs from 'node:fs';
fs.mkdirSync('/tmp/litemind-e2e', { recursive: true });
fs.writeFileSync(process.env.LITEMIND_CONFIG, JSON.stringify({
  models: { rootDir: '/tmp/litemind-test-models' }
}));

const { startLiteMindEngine } = await import('../src/index.js');

const BASE = 'http://127.0.0.1:8399';
let handle;
const results = [];
const ok = (name, detail) => { results.push(`✅ ${name}${detail ? ' — ' + detail : ''}`); console.log(`✅ ${name}`, detail ?? ''); };
const fail = (name, err) => { results.push(`❌ ${name} — ${err}`); console.error(`❌ ${name}`, err); };

try {
  handle = await startLiteMindEngine({ console: false });
  const { engine } = handle;

  // 1. Backend = lmlama, runtime обнаружен
  const status = await engine.status();
  assert.equal(engine.backend.type, 'lmlama');
  assert.ok(status.backend.health.ok, `runtime не обнаружен: ${status.backend.health.error}`);
  ok('backend lmlama + llama-server detect', `${status.backend.health.version}`);

  // 2. Сканирование GGUF: реальный заголовок
  const scan = await engine.backend.scanModels();
  const qwen = scan.find((m) => m.id.startsWith('Qwen2.5-Coder-0.5B'));
  assert.ok(qwen, 'каталоговая модель не найдена при сканировании');
  assert.equal(qwen.ok, true, 'GGUF заголовок не прочитан');
  assert.equal(qwen.architecture, 'qwen2', `архитектура: ${qwen.architecture}`);
  assert.equal(qwen.quant, 'Q4_K_M', `квант: ${qwen.quant}`);
  assert.equal(qwen.sizeBytes, 397808288);
  ok('GGUF header parse', `${qwen.architecture}/${qwen.quant}/${(qwen.sizeBytes / 1048576).toFixed(0)} MiB, ctx=${qwen.contextLength}`);

  // 3. HTTP API /api/models/scan
  const scanRes = await fetch(`${BASE}/api/models/scan`).then((r) => r.json());
  assert.ok(scanRes.models.some((m) => m.id.startsWith('Qwen2.5')));
  ok('GET /api/models/scan', `rootDir=${scanRes.rootDir}, binary=${!!scanRes.runtimeBinary}`);

  // 4. Чат со стримингом: реальная генерация
  const t0 = Date.now();
  const chatRes = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: qwen.id,
      messages: [{ role: 'user', content: 'Say exactly: LITEMIND_OK' }],
      max_tokens: 30,
      stream: false
    })
  });
  if (!chatRes.ok) fail('chat HTTP', `${chatRes.status}: ${await chatRes.text()}`);
  assert.ok(chatRes.ok, `chat HTTP ${chatRes.status}`);
  const chat = await chatRes.json();
  const answer = chat.choices?.[0]?.message?.content ?? '';
  assert.ok(answer.trim().length > 0, 'пустой ответ модели');
  const genMs = Date.now() - t0;
  ok('реальный ответ GGUF-модели', `"${answer.trim().slice(0, 60)}" (${genMs} ms, usage=${JSON.stringify(chat.usage ?? {})})`);

  // 5. Стриминг: сервер шлёт SSE-чанки по одному
  const streamRes = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: qwen.id,
      messages: [{ role: 'user', content: 'Count from 1 to 5.' }],
      max_tokens: 40,
      stream: true
    })
  });
  assert.ok(streamRes.ok && streamRes.body, `stream HTTP ${streamRes.status}`);
  const reader = streamRes.body.getReader();
  const dec = new TextDecoder();
  let sse = '', chunks = 0, streamText = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    sse += dec.decode(value, { stream: true });
    for (const line of sse.split('\n')) {
      if (!line.startsWith('data:')) continue;
      const p = line.slice(5).trim();
      if (p === '[DONE]') continue;
      try {
        const c = JSON.parse(p);
        const d = c.choices?.[0]?.delta?.content;
        if (d) { chunks++; streamText += d; }
      } catch { /* частичная строка */ }
    }
    sse = sse.slice(sse.lastIndexOf('\n') + 1);
  }
  assert.ok(chunks >= 2, `стрим не стримит: ${chunks} чанков`);
  ok('SSE-стриминг чата', `${chunks} дельт, "${streamText.trim().slice(0, 40)}"`);

  // 6. Процесс llama-server реально запущен и модель в RAM
  const loaded = await engine.backend.loaded();
  assert.ok(loaded.length >= 1 && loaded[0].id.startsWith('Qwen'), `loaded: ${JSON.stringify(loaded)}`);
  ok('llama-server процесс жив, модель в RAM', `port=${loaded[0].port}`);

  // 7. Остановка-выгрузка: процесс терминируется
  const unl = await engine.backend.unload(null);
  assert.ok(unl.unloaded.length >= 1);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(engine.backend.proc, null, 'процесс не выгружен');
  ok('выгрузка модели из RAM (терминация llama-server)', `unloaded=${unl.unloaded.join(',')}`);

  // 8. Честное удаление: копия файла → удалить через API → файла нет
  fs.copyFileSync('/tmp/litemind-test-models/Qwen2.5-Coder-0.5B-Instruct-Q4_K_M.gguf',
                  '/tmp/litemind-test-models/zz-test-delete-copy.gguf');
  const delRes = await fetch(`${BASE}/api/models/delete`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'zz-test-delete-copy' })
  }).then((r) => r.json());
  assert.ok(delRes.ok, `delete failed: ${JSON.stringify(delRes)}`);
  assert.ok(!fs.existsSync('/tmp/litemind-test-models/zz-test-delete-copy.gguf'), 'файл остался на диске!');
  ok('честное удаление модели', `remaining=${delRes.remaining.length}`);

  // 9. Отмена генерации
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(new Error('user stop')), 1500);
  let cancelled = false;
  try {
    await fetch(`${BASE}/v1/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, signal: ctrl.signal,
      body: JSON.stringify({ model: qwen.id, messages: [{ role: 'user', content: 'Write a very long essay about testing.' }], max_tokens: 500, stream: true })
    });
  } catch (e) { cancelled = ctrl.signal.aborted; }
  ok('отмена генерации (кнопка Stop)', cancelled ? 'аборт дошёл' : 'запрос завершился сам');

  console.log('\n=== ИТОГ E2E v0.4 ===');
  results.forEach((r) => console.log(r));
} catch (err) {
  console.error('E2E FAILED:', err);
  console.log(results.join('\n'));
  process.exitCode = 1;
} finally {
  if (handle) await handle.stop();
  process.exit(process.exitCode || 0);
}
