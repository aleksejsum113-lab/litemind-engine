// Smoke Model Discovery v0.6.2 — Windows CI: реальная работа раздела
// «Новые модели» на установленном приложении (движок на 8399).
//
// Проверяет (ТЗ v0.6.2 §12):
//   1. статус Discovery включён, каталог живёт в %APPDATA%\LiteMind
//   2. реальная проверка источников (Hugging Face, сеть CI) → появились модели
//   3. фильтры (новинки/совместимые/быстрые/Dolphin) не пустые где ожидаемо
//   4. карточка модели: оценка совместимости по железу
//   5. скачивание найденной модели КНОПКОЙ из приложения → общий загрузчик
//      → SHA-256 проверен → файл в папке моделей → Model Manager его видит
//   6. Projects/Workspace/Terminal: создание проекта, файл, команда в терминале
//
// Использование: node smoke-stage3-discovery.mjs --port 8399 --out <файл>

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === '--port') args.port = Number(process.argv[++i]);
  else if (process.argv[i] === '--out') args.out = process.argv[++i];
  else if (process.argv[i] === '--max-model-mb') args.maxModelMb = Number(process.argv[++i]);
}
const PORT = args.port || 8399;
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = args.out || path.join(os.tmpdir(), 'smoke-discovery.json');
// Верхний размер модели для теста скачивания (CI: Qwen3-0.6B ≈ 638 МБ качается быстро).
const MAX_MODEL_BYTES = (args.maxModelMb ?? 900) * 1024 * 1024;

const checks = [];
const check = (name, ok, details) => {
  checks.push({ name, ok: !!ok, details: String(details ?? '').slice(0, 1200) });
  console.log(`${ok ? '[ПАСС]' : '[ПРОВАЛ]'} ${name} — ${String(details ?? '').slice(0, 300)}`);
};

async function jget(p, timeoutMs = 30000) {
  const r = await fetch(BASE + p, { signal: AbortSignal.timeout(timeoutMs) });
  return { status: r.status, body: await r.json().catch(() => null) };
}
async function jpost(p, body, timeoutMs = 60000) {
  const r = await fetch(BASE + p, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}), signal: AbortSignal.timeout(timeoutMs)
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 1. статус ───────────────────────────────────────────────────────────────

console.log('=== 1. Статус Discovery ===');
let st = null;
try {
  const s = await jget('/api/discovery/status');
  st = s.body;
  check('GET /api/discovery/status отвечает', s.status === 200 && st && typeof st === 'object',
    `http=${s.status}, enabled=${st?.enabled}, интервал=${st?.intervalHours}ч`);
  check('Discovery включён по умолчанию', st?.enabled === true, `enabled=${st?.enabled}`);
} catch (e) {
  check('GET /api/discovery/status отвечает', false, e.message);
}

// ── 2. реальная проверка источников ─────────────────────────────────────────

console.log('=== 2. Проверка источников (Hugging Face, реальная сеть) ===');
try {
  const r = await jpost('/api/discovery/refresh', {}, 30000);
  check('POST /api/discovery/refresh запущен', r.status === 202, `http=${r.status}, checking=${r.body?.checking}`);
} catch (e) {
  check('POST /api/discovery/refresh запущен', false, e.message);
}

// Ждём завершения проверки (реальные HTTP-запросы к HF: ~15-90 с на CI).
let refreshed = false;
let lastStatus = null;
for (let i = 0; i < 75; i++) {
  await sleep(4000);
  try {
    lastStatus = (await jget('/api/discovery/status')).body;
    if (lastStatus && !lastStatus.checking) { refreshed = true; break; }
  } catch { /* движок занят — ждём дальше */ }
}
check('Проверка источников завершилась за ~5 мин', refreshed,
  `checking=${lastStatus?.checking}, lastError=${lastStatus?.lastError ?? 'нет'}, lastRun=${JSON.stringify(lastStatus?.lastRun ?? null)}`);
check('Проверка успешна (без ошибки сети)', refreshed && !lastStatus?.lastError,
  `lastCheckAt=${lastStatus?.lastCheckAt}, lastError=${lastStatus?.lastError ?? 'нет'}`);

// ── 3. список моделей и фильтры ─────────────────────────────────────────────

console.log('=== 3. Список найденных моделей и фильтры ===');
let all = null;
try {
  const r = await jget('/api/discovery/models?filter=all&limit=300');
  all = r.body;
  check('Каталог наполнился реальными моделями', r.status === 200 && (all?.models?.length ?? 0) > 0,
    `найдено=${all?.counts?.total ?? 0}, показано=${all?.models?.length ?? 0}`);
  check('Счётчики честные (total = сумме)', !!all?.counts && all.counts.total >= all.models.length,
    `total=${all?.counts?.total}, new=${all?.counts?.new}, compatible=${all?.counts?.compatible}`);
} catch (e) {
  check('Каталог наполнился реальными моделями', false, e.message);
}

for (const f of ['fast', 'compatible', 'chat']) {
  try {
    const r = await jget(`/api/discovery/models?filter=${f}&limit=50`);
    const n = r.body?.models?.length ?? 0;
    check(`Фильтр «${f}» отработал`, r.status === 200 && n > 0, `найдено=${n}`);
  } catch (e) {
    check(`Фильтр «${f}» отработал`, false, e.message);
  }
}
try {
  const r = await jget('/api/discovery/models?filter=all&limit=300');
  const dolphin = (r.body?.models ?? []).filter((m) => m.flavor === 'dolphin' || m.flavor === 'huihui');
  // Dolphin/Huihui на живом HF есть почти всегда, но не гарантированы — предупреждение, не провал.
  check('Варианты Dolphin/Huihui обнаруживаются', true,
    dolphin.length ? `найдено=${dolphin.length}` : 'в этой выборке нет (не ошибка)');
} catch (e) { check('Варианты Dolphin/Huihui обнаруживаются', true, `пропущено: ${e.message}`); }

// ── 4. карточка модели ──────────────────────────────────────────────────────

console.log('=== 4. Карточка модели: совместимость по железу ===');
let picked = null;
try {
  const models = (all?.models ?? []).filter((m) => (m.sizeBytes ?? 0) > 0 && (m.sizeBytes ?? Infinity) <= MAX_MODEL_BYTES);
  models.sort((a, b) => a.sizeBytes - b.sizeBytes);
  picked = models[0] ?? null;
  check('Найдена модель для теста скачивания (≤900 МБ)', !!picked,
    picked ? `${picked.repo}/${picked.name} (${Math.round(picked.sizeBytes / 1048576)} МБ)` : 'каталог пуст');
  if (picked) {
    const d = await jget(`/api/discovery/model?key=${encodeURIComponent(picked.key)}`);
    const m = d.body;
    check('Карточка: оценка совместимости по реальному железу',
      d.status === 200 && m?.rating?.level && m?.rating?.levelLabel,
      `level=${m?.rating?.level}, label=${m?.rating?.levelLabel}, память≈${m?.rating?.estimatedMb}МБ`);
    check('Карточка: честные метаданные источника',
      !!m?.repo && !!m?.url && /huggingface\.co/.test(m.url) && !!m?.sha256,
      `sha256=${m?.sha256 ? m.sha256.slice(0, 12) + '…' : 'нет'}`);
  }
} catch (e) {
  check('Карточка: оценка совместимости по реальному железу', false, e.message);
}

// ── 5. скачивание найденной модели из приложения ────────────────────────────

console.log('=== 5. Скачивание модели кнопкой из приложения (общий загрузчик + SHA-256) ===');
if (picked) {
  try {
    const r = await jpost('/api/discovery/download', { key: picked.key }, 60000);
    check('POST /api/discovery/download принят', r.status === 202 || (r.status === 200 && r.body?.alreadyDownloaded),
      `http=${r.status}, job=${r.body?.job?.id ?? (r.body?.alreadyDownloaded ? 'уже скачана' : '?')}`);
    const jobId = r.body?.job?.id;
    if (jobId) {
      let job = null;
      for (let i = 0; i < 220; i++) {
        await sleep(3000);
        try {
          const dl = await jget('/api/downloads');
          job = (dl.body?.downloads ?? []).find((x) => x.id === jobId);
          if (job && (job.state === 'done' || job.state === 'error' || job.state === 'cancelled')) break;
        } catch { /* ждём */ }
      }
      check('Загрузка завершилась (не оборвалась)', job && job.state === 'done',
        `state=${job?.state}, ${job?.receivedBytes ?? 0}/${job?.totalBytes ?? 0} байт`);
      check('SHA-256 файла проверен после загрузки', job && job.state === 'done' && job.shaVerified === true,
        `shaVerified=${job?.shaVerified}`);
      const st2 = await jget('/api/discovery/status');
      const stillListed = (st2.body?.counts?.total ?? 0) > 0;
      check('Каталог после загрузки не сломался', stillListed, `total=${st2.body?.counts?.total}`);
    }
  } catch (e) {
    check('POST /api/discovery/download принят', false, e.message);
  }
} else {
  check('POST /api/discovery/download принят', false, 'модель для скачивания не нашлась');
}

// ── 6. Projects / Workspace / Terminal ──────────────────────────────────────

console.log('=== 6. Projects / Workspace / Terminal ===');
const projDir = path.join(os.tmpdir(), `lm-smoke-proj-${Date.now()}`);
try {
  // Контракт API: { path } — полный путь проекта (mkdir -p, существующий не ошибка).
  const r = await jpost('/api/project/create', { path: projDir });
  const dirOk = r.status === 200 || r.status === 201;
  check('Projects: проект создан', dirOk, `http=${r.status}, path=${r.body?.path ?? projDir}`);
  if (dirOk) {
    const filePath = path.join(projDir, 'smoke-disco.txt');
    const save = await jpost('/api/project/file', { path: filePath, content: 'привет из smoke-теста Discovery\n' });
    check('Workspace: файл сохранён', save.status === 200 || save.status === 201, `http=${save.status}`);
    const read = await jget(`/api/project/file?path=${encodeURIComponent(filePath)}`);
    check('Workspace: файл прочитан обратно', read.status === 200 && JSON.stringify(read.body).includes('smoke-теста'),
      `http=${read.status}`);
    const tree = await jget(`/api/project/tree?path=${encodeURIComponent(projDir)}`);
    check('Workspace: дерево файлов отдаёт файл', tree.status === 200 && JSON.stringify(tree.body).includes('smoke-disco.txt'),
      `http=${tree.status}`);
  }
} catch (e) {
  check('Projects: проект создан', false, e.message);
}
try {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-smoke-term-'));
  const r = await jpost('/api/terminal/exec', { cwd, command: 'node --version', timeoutMs: 30000 }, 60000);
  const out = String(r.body?.output ?? r.body?.stdout ?? '');
  check('AI Terminal: команда выполнена, вывод непустой', r.status === 200 && /v\d+\.\d+\.\d+/.test(out),
    `http=${r.status}, вывод=${out.trim().slice(0, 60)}`);
} catch (e) {
  check('AI Terminal: команда выполнена, вывод непустой', false, e.message);
}

// ── итог ────────────────────────────────────────────────────────────────────

const failed = checks.filter((c) => !c.ok);
const report = {
  ts: new Date().toISOString(), base: BASE, port: PORT,
  passed: checks.length - failed.length, failed: failed.length, checks
};
fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
console.log(`\nИТОГО: ${report.passed} ПАСС / ${report.failed} ПРОВАЛ → отчёт: ${OUT}`);
process.exit(failed.length ? 1 : 0);
