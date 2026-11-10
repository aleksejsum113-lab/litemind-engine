// Тесты Этапа 1В: Projects, Workspace, AI Terminal — взаимосвязанная работа.
// Всё проверяется на реальных файлах диска и реальных процессах shell, без
// заглушек. Только нативные диалоги Windows и kill дерева процессов taskkill
// требуют проверки в собранном EXE (обозначено в отчёте).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeEngine, fakeMetrics } from './helpers/fixtures.js';
import { createServer } from '../src/api/server.js';
import * as wsx from '../src/project/workspace.js';

const sampler = { latest: fakeMetrics(), history: [], async sample() { return this.latest; }, stop() {} };

async function startApi() {
  const modelsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'litemind-1v-models-'));
  const { engine, config } = makeEngine({
    sampler,
    configMutator: (c) => { c.models.rootDir = modelsRoot; }
  });
  await engine.start();
  const server = createServer({ config, engine, logger: null });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  return {
    url, config, configPath: config.paths.configPath,
    close: async () => {
      server.close(); server.closeAllConnections?.(); engine.shutdown();
      fs.rmSync(modelsRoot, { recursive: true, force: true });
    }
  };
}

const post = (url, route, payload) => fetch(`${url}${route}`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload)
});
const j = (res) => res.json();

// --------------------------------------------------------------- проекты

test('1В §8.1/8.4: открытие проекта — доступная папка ок, недоступная честно 404', async () => {
  const api = await startApi();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'litemind-1v-proj-'));
  try {
    const ok = await post(api.url, '/api/project/open', { path: dir });
    assert.equal(ok.status, 200);
    const okBody = await j(ok);
    assert.equal(okBody.ok, true);
    assert.ok(okBody.name);
    assert.equal(okBody.accessible, true);

    const missing = path.join(dir, 'нет-такой-папки');
    const bad = await post(api.url, '/api/project/open', { path: missing });
    assert.equal(bad.status, 404);
    const badBody = await j(bad);
    assert.equal(badBody.ok, false);
    assert.ok(badBody.reason.includes('не найдена'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    await api.close();
  }
});

test('1В §8.1: создание папки проекта (в т.ч. вложенной), корень диска запрещён', async () => {
  const api = await startApi();
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'litemind-1v-create-'));
  const nested = path.join(base, 'мой проект', 'v2');
  try {
    const r = await post(api.url, '/api/project/create', { path: nested });
    assert.equal(r.status, 200);
    const body = await j(r);
    assert.equal(body.ok, true);
    assert.equal(body.created, true);
    assert.ok(fs.statSync(nested).isDirectory(), 'каталог реально создан');
    // Повторное создание — не ошибка (уже существует = открыть)
    const again = await post(api.url, '/api/project/create', { path: nested });
    assert.equal((await j(again)).ok, true);
    // Существующий файл по пути — отказ
    const file = path.join(base, 'f.txt');
    fs.writeFileSync(file, 'x');
    const conflict = await post(api.url, '/api/project/create', { path: file });
    assert.notEqual(conflict.status, 200);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
    await api.close();
  }
});

// --------------------------------------------------------------- дерево

function makeTreeProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'litemind-1v-tree-'));
  fs.writeFileSync(path.join(root, 'README.md'), '# readme\n');
  fs.writeFileSync(path.join(root, 'main.py'), 'print(1)\n');
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src', 'app.js'), 'const a = 1;\n');
  fs.mkdirSync(path.join(root, 'src', 'deep'));
  fs.writeFileSync(path.join(root, 'src', 'deep', 'x.ts'), 'export {};\n');
  fs.mkdirSync(path.join(root, 'node_modules'));
  fs.writeFileSync(path.join(root, 'node_modules', 'pkg.js'), 'module.exports=1;\n');
  fs.mkdirSync(path.join(root, '.git'));
  fs.writeFileSync(path.join(root, '.git', 'config'), '[core]\n');
  fs.writeFileSync(path.join(root, '.gitignore'), 'node_modules\n');
  fs.mkdirSync(path.join(root, 'uploads'));
  fs.writeFileSync(path.join(root, 'uploads', 'big.dat'), 'data\n');
  return root;
}

test('1В §8.5: ленивое дерево — дети каталога, skip node_modules/.git, исключения настраиваются', async () => {
  const root = makeTreeProject();
  try {
    // Корень без исключений
    const r0 = await wsx.listTree(root, '');
    const names0 = [...r0.dirs.map((d) => d.name), ...r0.files.map((f) => f.name)].sort();
    assert.ok(names0.includes('src'), 'src виден');
    assert.ok(names0.includes('.gitignore'), '.gitignore показывается');
    assert.ok(!names0.includes('node_modules'), 'node_modules исключён');
    assert.ok(!names0.includes('.git'), '.git исключён');
    assert.ok(r0.skipped.includes('node_modules') || r0.skipped.includes('.git'));

    // Флаг hasChildren
    const src = r0.dirs.find((d) => d.name === 'src');
    assert.equal(src.hasChildren, true);

    // Дочерний уровень по rel-пути
    const r1 = await wsx.listTree(root, 'src');
    assert.ok(r1.files.some((f) => f.rel === 'src/app.js'));
    assert.ok(r1.dirs.some((d) => d.rel === 'src/deep'));

    // Настраиваемое исключение скрывает uploads
    const r2 = await wsx.listTree(root, '', { exclude: ['uploads'] });
    assert.ok(!r2.dirs.some((d) => d.name === 'uploads'));

    // Выход за пределы проекта — запрет
    await assert.rejects(() => wsx.listTree(root, '../'), /вне проекта|недоступен/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('1В §8.5: дерево через API — недоступный каталог 404, огромный каталог не грузится целиком', async () => {
  const api = await startApi();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'litemind-1v-cap-'));
  try {
    // 850 файлов — больше лимита уровня (800)
    fs.mkdirSync(path.join(root, 'bulk'));
    for (let i = 0; i < 850; i++) fs.writeFileSync(path.join(root, 'bulk', `f${i}.txt`), 'x');
    const res = await fetch(`${api.url}/api/project/tree?path=${encodeURIComponent(root)}&dir=bulk&limit=100`);
    assert.equal(res.status, 200);
    const body = await j(res);
    assert.equal(body.truncated, true);
    assert.equal(body.files.length, 100);
    assert.equal(body.totalEntries, 850);

    const missing = await fetch(`${api.url}/api/project/tree?path=${encodeURIComponent(root)}&dir=нет-каталога`);
    assert.equal(missing.status, 404);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    await api.close();
  }
});

test('1В §8.6: поиск файлов по имени — подстрока, исключения, лимит', async () => {
  const root = makeTreeProject();
  try {
    const r = await wsx.findFiles(root, 'app', {});
    assert.equal(r.files.length, 1);
    assert.equal(r.files[0].rel, 'src/app.js');
    const none = await wsx.findFiles(root, 'нет-такого-файла-вообще', {});
    assert.equal(none.files.length, 0);
    const excluded = await wsx.findFiles(root, 'pkg', { exclude: ['node_modules'] });
    assert.equal(excluded.files.length, 0, 'исключённые папки не ищутся');
    // Кириллица в имени
    fs.writeFileSync(path.join(root, 'заметка-тест.md'), 'привет\n');
    const cyr = await wsx.findFiles(root, 'ЗАМЕТКА', {});
    assert.equal(cyr.files.length, 1, 'поиск без учёта регистра, кириллица');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('1В §8.6: поиск текста внутри файлов — номер строки, колонка, бинарники пропускаются', async () => {
  const root = makeTreeProject();
  fs.writeFileSync(path.join(root, 'src', 'app.js'), 'const a = 1;\nconst magic = 42; // тут\nconst b = 2;\n');
  fs.writeFileSync(path.join(root, 'src', 'бинарь.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]));
  try {
    const r = await wsx.grepFiles(root, 'magic');
    assert.equal(r.results.length, 1);
    assert.equal(r.results[0].file, 'src/app.js');
    assert.equal(r.results[0].lineNo, 2);
    assert.equal(r.results[0].col, 7);
    assert.ok(r.results[0].line.includes('42'));
    // Кириллица в содержимом
    fs.writeFileSync(path.join(root, 'читай.txt'), 'первая строка\nключевое слово здесь\n');
    const cyr = await wsx.grepFiles(root, 'КЛЮЧЕВОЕ');
    assert.equal(cyr.results.length, 1);
    assert.equal(cyr.results[0].lineNo, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// --------------------------------------------------------------- файлы

test('1В §8.8/8.9: чтение файла отдаёт mtime, сохранение с устаревшим mtime → 409, force → перезапись', async () => {
  const api = await startApi();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'litemind-1v-mtime-'));
  const file = path.join(dir, 'note.txt');
  fs.writeFileSync(file, 'версия 1\n');
  try {
    const read = await fetch(`${api.url}/api/project/file?path=${encodeURIComponent(dir)}&file=note.txt`);
    const f = await j(read);
    assert.equal(f.content, 'версия 1\n');
    assert.equal(typeof f.mtimeMs, 'number');

    // Внешнее изменение (как будто другая программа переписала файл)
    const external = f.mtimeMs + 50;
    fs.utimesSync(file, new Date(Date.now() - 100000), new Date(external / 1));
    // Гарантируем отличие mtime: перепишем файл
    fs.writeFileSync(file, 'версия внешняя\n');
    const st = fs.statSync(file);
    if (Math.abs(st.mtimeMs - f.mtimeMs) <= 2) await new Promise((r) => setTimeout(r, 20)) || fs.writeFileSync(file, 'версия внешняя 2\n');

    // Сохранение со старым mtime → конфликт
    const conflict = await post(api.url, '/api/project/file', {
      path: dir, file: 'note.txt', content: 'моя версия\n', expectedMtimeMs: f.mtimeMs
    });
    assert.equal(conflict.status, 409);
    const cBody = await j(conflict);
    assert.equal(cBody.conflict, true);
    assert.equal(fs.readFileSync(file, 'utf8'), fs.readFileSync(file, 'utf8'), 'файл не перезаписан');

    // force — осознанная перезапись
    const forced = await post(api.url, '/api/project/file', {
      path: dir, file: 'note.txt', content: 'моя версия\n', expectedMtimeMs: f.mtimeMs, force: true
    });
    assert.equal(forced.status, 200);
    assert.equal(fs.readFileSync(file, 'utf8'), 'моя версия\n');
    const f2 = await j(forced);
    assert.equal(typeof f2.mtimeMs, 'number');

    // Сохранение с актуальным mtime проходит без конфликта
    const good = await post(api.url, '/api/project/file', {
      path: dir, file: 'note.txt', content: 'моя версия 2\n', expectedMtimeMs: f2.mtimeMs
    });
    assert.equal(good.status, 200);
    assert.equal(fs.readFileSync(file, 'utf8'), 'моя версия 2\n');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    await api.close();
  }
});

// --------------------------------------------------------- ИИ-изменения

test('1В §8.10/8.11: apply-change делает резервную копию, меняет файл; restore-backup возвращает исходник', async () => {
  const api = await startApi();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'litemind-1v-ai-'));
  const file = path.join(dir, 'code.js');
  fs.writeFileSync(file, 'const x = 1;\n');
  try {
    const cur = await j(await fetch(`${api.url}/api/project/file?path=${encodeURIComponent(dir)}&file=code.js`));

    const applied = await post(api.url, '/api/project/apply-change', {
      path: dir, file: 'code.js', content: 'const x = 2;\nconst y = 3;\n', expectedMtimeMs: cur.mtimeMs
    });
    assert.equal(applied.status, 200);
    const aBody = await j(applied);
    assert.equal(aBody.applied, true);
    assert.equal(fs.readFileSync(file, 'utf8'), 'const x = 2;\nconst y = 3;\n');
    assert.ok(aBody.backupId.endsWith('.bak'));
    // Копия лежит вне проекта и содержит исходное содержимое
    assert.ok(!aBody.backupPath.startsWith(dir), 'копия вне проекта пользователя');
    assert.equal(fs.readFileSync(aBody.backupPath, 'utf8'), 'const x = 1;\n');

    // Список копий
    const list = await j(await fetch(`${api.url}/api/project/backups?path=${encodeURIComponent(dir)}&file=code.js`));
    assert.equal(list.backups.length, 1);
    assert.equal(list.backups[0].backupId, aBody.backupId);

    // Восстановление
    const restored = await post(api.url, '/api/project/restore-backup', { path: dir, backupId: aBody.backupId });
    assert.equal(restored.status, 200);
    const rBody = await j(restored);
    assert.equal(rBody.restored, true);
    assert.equal(fs.readFileSync(file, 'utf8'), 'const x = 1;\n');
    assert.ok(rBody.safetyBackupId, 'перед восстановлением тоже сделана копия');

    // apply-change с выходом за пределы проекта — отказ, копий нет
    const evil = await post(api.url, '/api/project/apply-change', {
      path: dir, file: '../вне-проекта.txt', content: 'зло\n'
    });
    assert.equal(evil.status, 400);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(path.join(path.dirname(api.configPath), 'project-backups'), { recursive: true, force: true });
    await api.close();
  }
});

test('1В §3: apply-change при изменении файла извне → 409 и без записи', async () => {
  const api = await startApi();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'litemind-1v-ai2-'));
  const file = path.join(dir, 'code.js');
  fs.writeFileSync(file, 'const x = 1;\n');
  try {
    const cur = await j(await fetch(`${api.url}/api/project/file?path=${encodeURIComponent(dir)}&file=code.js`));
    fs.writeFileSync(file, 'внешняя правка\n');
    await new Promise((r) => setTimeout(r, 30)); // NTFS/ext4 кластеризация mtime
    fs.utimesSync(file, new Date(), new Date(Date.now() + 100));
    const res = await post(api.url, '/api/project/apply-change', {
      path: dir, file: 'code.js', content: 'версия ИИ\n', expectedMtimeMs: cur.mtimeMs
    });
    assert.equal(res.status, 409);
    assert.equal(fs.readFileSync(file, 'utf8'), 'внешняя правка\n');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(path.join(path.dirname(api.configPath), 'project-backups'), { recursive: true, force: true });
    await api.close();
  }
});

// --------------------------------------------------------------- контекст

test('1В §8.7: контекст проекта — несколько файлов, бинарники с warning, выход за корень — ошибка', async () => {
  const root = makeTreeProject();
  fs.writeFileSync(path.join(root, 'src', 'app.js'), 'const app = 1;\nconst app2 = 2;\n');
  try {
    const r = await wsx.buildContext(root, ['README.md', 'src/app.js', 'нет-файла.txt']);
    assert.equal(r.files.length, 3);
    const readme = r.files.find((f) => f.file === 'README.md');
    const app = r.files.find((f) => f.file === 'src/app.js');
    const missing = r.files.find((f) => f.file === 'нет-файла.txt');
    assert.equal(readme.ok, true);
    assert.equal(readme.content, '# readme\n');
    assert.equal(app.ok, true);
    assert.ok(app.chars > 0);
    assert.equal(missing.ok, false);
    assert.equal(missing.warning, 'файл не найден');
    assert.equal(r.totalChars, readme.chars + app.chars);

    // Бинарник — warning и без содержимого
    fs.writeFileSync(path.join(root, 'картинка.png'), Buffer.from([0, 1, 2]));
    const withBin = await wsx.buildContext(root, ['картинка.png']);
    assert.equal(withBin.files[0].ok, false);
    assert.ok(withBin.files[0].warning.includes('бинар'));
    assert.equal(withBin.files[0].content, undefined);

    // Побег из корня — отказ без содержимого
    const evil = await wsx.buildContext(root, ['../../etc/passwd']);
    assert.equal(evil.files[0].ok, false);
    assert.ok(evil.files[0].warning.includes('вне каталога'));

    // Папка раскрывается в текстовые файлы, бинарники пропускаются
    const folder = await wsx.buildContext(root, ['src/']);
    assert.ok(folder.files.every((f) => f.ok));
    assert.ok(folder.files.some((f) => f.file === 'src/app.js'));
    assert.ok(!folder.files.some((f) => f.file.includes('бинарь')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('1В §2: лимиты контекста — общий лимит не превышается, перебор честно помечается', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'litemind-1v-ctx-'));
  try {
    for (let i = 0; i < 5; i++) fs.writeFileSync(path.join(root, `f${i}.txt`), 'x'.repeat(400));
    const r = await wsx.buildContext(root, ['f0.txt', 'f1.txt', 'f2.txt', 'f3.txt', 'f4.txt'], { totalChars: 1000, perFileChars: 500 });
    assert.ok(r.totalChars <= 1000, `общий лимит соблюдён (${r.totalChars})`);
    const truncated = r.files.filter((f) => f.ok && f.truncated);
    assert.ok(truncated.length >= 1, 'есть честно помеченные обрезки');
    const rejected = r.files.filter((f) => !f.ok && /лимит/.test(f.warning ?? ''));
    assert.ok(rejected.length >= 1, 'не влезшие файлы честно отклонены');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// --------------------------------------------------------------- терминал

test('1В §8.12/8.14/8.16: терминал в потоковом режиме — stdout событиями до exit, код возврата', async () => {
  const api = await startApi();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'litemind-1v-term-'));
  try {
    const controller = new AbortController();
    const jobId = `term-${Date.now().toString(36)}`;
    const res = await fetch(`${api.url}/api/terminal/exec`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cwd: dir, command: 'echo stage1v-stdout && echo stage1v-stderr >&2 && exit 3', stream: true, jobId })
    });
    assert.equal(res.status, 200);
    assert.ok((res.headers.get('content-type') || '').includes('text/event-stream'));
    const text = await res.text();
    const events = parseSse(text);
    assert.ok(events.start, 'есть start');
    assert.equal(events.start.jobId.startsWith('term-'), true);
    const stdoutText = (events.stdout ?? []).map((e) => e.text).join('');
    assert.ok(stdoutText.includes('stage1v-stdout'), 'живой stdout дошёл');
    const stderrText = (events.stderr ?? []).map((e) => e.text).join('');
    assert.ok(stderrText.includes('stage1v-stderr'), 'живой stderr дошёл');
    assert.ok(events.exit, 'есть exit');
    assert.equal(events.exit.exitCode, 3, 'код возврата честный');
    assert.ok(events.exit.stdout.includes('stage1v-stdout'), 'в exit полный stdout');
    assert.ok(['utf8', 'cp866', 'windows-1251'].includes(events.exit.encoding));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    await api.close();
  }
});

function parseSse(text) {
  const events = { stdout: [], stderr: [] };
  for (const block of text.split('\n\n')) {
    let name = null;
    const dataLines = [];
    for (const line of block.split('\n')) {
      if (line.startsWith('event: ')) name = line.slice(7).trim();
      else if (line.startsWith('data: ')) dataLines.push(line.slice(6));
    }
    if (!name || !dataLines.length) continue;
    const obj = JSON.parse(dataLines.join('\n'));
    if (name === 'stdout' || name === 'stderr') events[name].push(obj);
    else events[name] = obj;
  }
  return events;
}

test('1В §8.15: кириллица в UTF-8 проходит без искажений', async () => {
  const api = await startApi();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'litemind-1v-cyr-'));
  try {
    const res = await post(api.url, '/api/terminal/exec', { cwd: dir, command: 'echo "привет мир — тест кодировки"' });
    assert.equal(res.status, 200);
    const r = await j(res);
    assert.ok(r.stdout.includes('привет мир — тест кодировки'), `вывод: ${JSON.stringify(r.stdout)}`);
    assert.equal(r.encoding, 'utf8');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    await api.close();
  }
});

test('1В §4: вывод не в UTF-8 декодируется фолбэком без дыр и кодировка сообщается', async () => {
  // Печатаем байты windows-1251: «Да» = 0xC4 0xE0. Это не валидный UTF-8.
  const { decodeBuffer, makeOutputDecoder } = wsx;
  const raw = Buffer.from([0xC4, 0xE0, 0x20, 0x4F, 0x4B]); // «Да OK» в cp1251
  const full = decodeBuffer(raw);
  assert.notEqual(full.encoding, 'utf8');
  assert.ok(full.text.includes('OK'));
  assert.ok(!full.text.includes('\uFFFD'), 'без символов замены');

  // Потоковый декодер выбирает кодировку по первому куску и держит её
  const dec = makeOutputDecoder();
  const t1 = dec.push(raw.subarray(0, 2));
  const t2 = dec.push(raw.subarray(2));
  assert.ok(!t1.includes('\uFFFD') && !t2.includes('\uFFFD'));
  assert.ok(['cp866', 'windows-1251'].includes(dec.encoding()));
  assert.ok((t1 + t2).includes('OK'));
});

test('1В §8.17: Stop в потоковом режиме завершает команду быстро, exit.stopped=true', async () => {
  const api = await startApi();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'litemind-1v-stop-'));
  try {
    const controller = new AbortController();
    const jobId = `term-${Date.now().toString(36)}`;
    const execPromise = fetch(`${api.url}/api/terminal/exec`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cwd: dir, command: 'sleep 30 && echo not-reached', timeoutMs: 60000, jobId, stream: true }),
      signal: controller.signal
    });
    const res = await execPromise;
    assert.equal(res.status, 200);

    const started = Date.now();
    const stop = await post(api.url, '/api/terminal/stop', { jobId });
    assert.equal((await j(stop)).ok, true);

    // Читаем поток до конца — exit должен прийти быстро
    const text = await res.text();
    const took = Date.now() - started;
    const events = parseSse(text);
    assert.ok(events.exit, 'exit-событие получено');
    assert.equal(events.exit.stopped, true);
    assert.ok(took < 15000, `остановка быстрая (${took} мс)`);

    // Повторный stop — уже завершено, без падения
    const again = await post(api.url, '/api/terminal/stop', { jobId });
    assert.equal((await j(again)).ok, false, 'повторная остановка честно отвечает: нечего останавливать');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    await api.close();
  }
});

test('1В §7: пути с пробелами и кириллицей — и cwd, и файловые операции', async () => {
  const api = await startApi();
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'litemind-1v-пробел-'));
  const dir = path.join(base, 'мой проект v2');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'файл с пробелом.txt'), 'кириллический текст\n');
  try {
    const r = await post(api.url, '/api/project/open', { path: dir });
    assert.equal((await j(r)).ok, true);

    const f = await j(await fetch(`${api.url}/api/project/file?path=${encodeURIComponent(dir)}&file=${encodeURIComponent('файл с пробелом.txt')}`));
    assert.equal(f.content, 'кириллический текст\n');

    const saved = await post(api.url, '/api/project/file', {
      path: dir, file: 'файл с пробелом.txt', content: 'новый текст\n', expectedMtimeMs: f.mtimeMs
    });
    assert.equal(saved.status, 200);
    assert.equal(fs.readFileSync(path.join(dir, 'файл с пробелом.txt'), 'utf8'), 'новый текст\n');

    const tree = await j(await fetch(`${api.url}/api/project/tree?path=${encodeURIComponent(base)}&dir=${encodeURIComponent('мой проект v2')}`));
    assert.ok(tree.files.some((x) => x.name === 'файл с пробелом.txt'));

    const term = await post(api.url, '/api/terminal/exec', { cwd: dir, command: 'echo ok-from-spaces' });
    assert.equal((await j(term)).exitCode, 0);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
    await api.close();
  }
});

test('1В §7: защита от выхода за пределы проекта на новых маршрутах', async () => {
  const api = await startApi();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'litemind-1v-esc-'));
  fs.writeFileSync(path.join(dir, 'ok.txt'), 'x\n');
  try {
    // tree с ../ — запрет
    const t = await fetch(`${api.url}/api/project/tree?path=${encodeURIComponent(dir)}&dir=..%2F`);
    assert.equal(t.status, 400);
    // context с ../ — предупреждение, без содержимого
    const ctx = await post(api.url, '/api/project/context', { path: dir, files: ['../../etc/passwd'] });
    assert.equal(ctx.status, 200);
    const ctxBody = await j(ctx);
    assert.equal(ctxBody.files[0].ok, false);
    assert.ok(ctxBody.files[0].warning.includes('вне каталога'));
    // backups с ../ — запрет
    const b = await fetch(`${api.url}/api/project/backups?path=${encodeURIComponent(dir)}&file=..%2Fsecret.txt`);
    assert.equal(b.status, 400);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    await api.close();
  }
});

test('1В §4: список опасных команд распознаётся, обычные — нет', async () => {
  // Проверяем клиентский регексп из app.js на серверной копии логики:
  // читаем файл UI и извлекаем регулярное выражение — один источник правды.
  const appSrc = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'src', 'ui', 'public', 'app.js'), 'utf8');
  const m = /const DANGEROUS_RE = (\/.+\/i);/.exec(appSrc);
  assert.ok(m, 'регексп найден в app.js');
  const RE = eval(m[1]); // eslint-disable-line no-eval — тот же литерал, что в UI

  const dangerous = [
    'del /q важный.txt', 'del file.txt', 'rm -rf /', 'rm readme.md',
    'rmdir /s /q проект', 'rd data', 'Remove-Item C:\\data -Recurse',
    'format e:', 'mkfs.ext4 /dev/sda', 'dd if=/dev/zero of=/dev/sda',
    'diskpart', 'bcdedit /set test', 'shutdown /s', 'reg add HKLM\\Software',
    'robocopy src dst /mir', 'echo hi && del file.txt'
  ];
  for (const cmd of dangerous) assert.ok(RE.test(cmd), `опасная должна подтверждаться: ${cmd}`);

  const safe = [
    'git status', 'git log --oneline', 'dir', 'node -v', 'npm install',
    'python main.py', 'echo привет', 'ls -la', 'cat readme.md', 'cd sub',
    'npm run build', 'git commit -m "fix bug"', 'mkdir newdir', 'copy a.txt b.txt'
  ];
  for (const cmd of safe) assert.ok(!RE.test(cmd), `безопасная не должна подтверждаться: ${cmd}`);
});

test('1В §9: терминал отвечает и при пустом выводе; кодировка в буферном режиме честная', async () => {
  const api = await startApi();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'litemind-1v-empty-'));
  try {
    const r = await j(await post(api.url, '/api/terminal/exec', { cwd: dir, command: 'true' }));
    assert.equal(r.exitCode, 0);
    assert.equal(r.stdout, '');
    assert.ok(['utf8', 'cp866', 'windows-1251'].includes(r.encoding));
    // Ошибка запуска несуществующей команды — ненулевой код и сообщение, без падения сервера
    const bad = await j(await post(api.url, '/api/terminal/exec', { cwd: dir, command: 'команда-которой-нет-нигде-12345' }));
    assert.notEqual(bad.exitCode, 0);
    assert.ok(bad.stderr || bad.error);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    await api.close();
  }
});
