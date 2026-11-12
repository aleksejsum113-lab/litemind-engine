// Регрессионный тест Генератора изображений (ТЗ v0.6.1 §2–5).
// Запуск: node scripts/test-imagegen.mjs
//
// Честность проверок:
//  • юнит-часть (параметры, URL, сканирование, галерея) — синтетические файлы;
//  • интеграционная часть — РЕАЛЬНЫЙ бинарник sd и РЕАЛЬНАЯ модель, если
//    найдены (env LITEMIND_SD_BIN / первый файл в папке моделей). Если нет —
//    часть честно помечается SKIP, а не «пройдено».

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const cfgImage = { sdPath: process.env.LITEMIND_SD_BIN ?? null, modelsDir: null, galleryDir: null };
const modelsRoot = process.env.LITEMIND_TEST_MODELS_ROOT ?? path.join(os.tmpdir(), 'litemind-test-models');
const config = {
  image: cfgImage,
  models: { rootDir: modelsRoot },
  resource: { maxRamUsageFraction: 0.75 }
};

let failures = 0;
let skipped = 0;
const check = (name, ok, details = '') => {
  console.log(`${ok ? '[ПАСС]' : '[ПРОВАЛ]'} ${name}${details ? ' — ' + details : ''}`);
  if (!ok) failures++;
};
const skip = (name, why) => { console.log(`[ПРОПУСК] ${name} — ${why}`); skipped++; };

// ---------- 1. sanitizeParams ----------
const { sanitizeParams, estimateImageRamMb } = await import(path.join(ROOT, 'src/image/generate.js'));
{
  const p = sanitizeParams({ prompt: 'кот', negative: 'мыло', width: 99999, height: -5, steps: 1000, cfg: 'abc', seed: -7, threads: 99 });
  check('параметры ограничены рамками', p.width === 1024 && p.height === 64 && p.steps === 50 && p.cfg === 7 && p.threads === 16 && p.seed === -1);
  const q = sanitizeParams({ prompt: 'x'.repeat(5000) });
  check('промпт обрезается до 4000', q.prompt.length === 4000);
  const r = sanitizeParams({});
  check('пустые параметры → значения по умолчанию', r.width === 512 && r.height === 512 && r.steps === 12 && r.cfg === 7);
  const est = estimateImageRamMb({ sizeBytes: 1566768416, width: 512, height: 512 });
  check('оценка RAM реалистична (2.5–4.5 ГБ для SD1.5 Q4_0 512²)', est >= 2500 && est <= 4500, `${est} МБ`);
}

// ---------- 2. checkDownloadUrl с ext ----------
const { checkDownloadUrl } = await import(path.join(ROOT, 'src/storage/storage.js'));
{
  const a = checkDownloadUrl('https://huggingface.co/x/resolve/main/m.safetensors');
  const b = checkDownloadUrl('https://huggingface.co/x/resolve/main/m.safetensors', { ext: ['safetensors', 'gguf'] });
  const c = checkDownloadUrl('https://evil.example.com/x/resolve/main/m.gguf', { ext: ['safetensors', 'gguf'] });
  const d = checkDownloadUrl('https://huggingface.co/x/resolve/main/virus.exe', { ext: ['safetensors', 'gguf'] });
  const e = checkDownloadUrl('https://huggingface.co/x/resolve/main/m.gguf', { ext: 'gguf' });
  check('LLM-правило отклоняет safetensors', !a.ok);
  check('image-правило принимает safetensors', b.ok);
  check('посторонний хост отклонён', !c.ok);
  check('.exe отклонён даже для image', !d.ok);
  check('gguf по-прежнему работает для LLM', e.ok);
}

// ---------- 3. Сканирование моделей изображений ----------
const { scanImageModels, probeImageModel } = await import(path.join(ROOT, 'src/image/models.js'));
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'img-models-'));
  // валидный safetensors: 8 байт длины заголовка + '{' + тело до 64+ МиБ
  const headLen = Buffer.alloc(8); headLen.writeUIntLE(96, 0, 6);
  const validSafe = Buffer.concat([headLen, Buffer.from('{"meta":{}}'), crypto.randomBytes(66 * 1024 * 1024)]);
  fs.writeFileSync(path.join(dir, 'good.safetensors'), validSafe);
  // валидный gguf
  const validGguf = Buffer.concat([Buffer.from('GGUF', 'latin1'), crypto.randomBytes(64 * 1024 * 1024)]);
  fs.writeFileSync(path.join(dir, 'good.gguf'), validGguf);
  // мусор с расширением
  fs.writeFileSync(path.join(dir, 'bad.safetensors'), Buffer.from('definitely not a model'));
  // посторонний файл
  fs.writeFileSync(path.join(dir, 'note.txt'), 'x');
  const found = await scanImageModels(dir);
  check('сканер видит 3 модели (2 хорошие + 1 битая)', found.length === 3, `найдено ${found.length}`);
  const gguf = found.find((m) => m.format === 'gguf');
  const safe = found.find((m) => m.format === 'safetensors');
  check('gguf распознан по магии', Boolean(gguf?.ok));
  check('safetensors распознан по заголовку', Boolean(safe?.ok));
  check('битый файл помечен ok=false', found.find((m) => m.name === 'bad.safetensors')?.ok === false);
  const empty = await scanImageModels(path.join(dir, 'нет-такой'));
  check('отсутствующая папка → пустой список (не ошибка)', Array.isArray(empty) && empty.length === 0);
  fs.rmSync(dir, { recursive: true, force: true });
}

// ---------- 4. Галерея ----------
const { ImageGallery } = await import(path.join(ROOT, 'src/image/gallery.js'));
{
  const gdir = fs.mkdtempSync(path.join(os.tmpdir(), 'img-gallery-'));
  const g = new ImageGallery(gdir);
  const tmp = path.join(gdir, 'tmp.png');
  fs.writeFileSync(tmp, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), crypto.randomBytes(4096)]));
  const rec = await g.accept(tmp, { prompt: 'тест', model: 'm.gguf', width: 512, height: 512, steps: 12, cfg: 7, seed: 42, durationMs: 1234 });
  check('accept переносит файл и пишет sidecar', fs.existsSync(path.join(gdir, rec.name)) && rec.prompt === 'тест' && rec.seed === 42);
  const list = await g.list();
  check('список галереи отдаёт метаданные', list.length === 1 && list[0].model === 'm.gguf' && list[0].durationMs === 1234);
  const file = g.fileFor(rec.name);
  check('fileFor не выпускает за пределы папки', file.startsWith(path.resolve(gdir)));
  let threw = false;
  try { g.fileFor('../../etc/passwd'); } catch { threw = true; }
  check('обход папок отклоняется', threw);
  await g.remove(rec.name);
  check('remove удаляет png+json', !fs.existsSync(path.join(gdir, rec.name)) && !fs.existsSync(path.join(gdir, rec.name.replace(/\.png$/, '.json'))));
  fs.rmSync(gdir, { recursive: true, force: true });
}

// ---------- 5. Интеграция: реальный sd + реальная модель ----------
{
  const { findSdBinary, sdVersion } = await import(path.join(ROOT, 'src/image/sdbin.js'));
  const { ImageGenManager } = await import(path.join(ROOT, 'src/image/generate.js'));
  const bin = findSdBinary(cfgImage);
  if (!bin) skip('интеграция sd', 'бинарник sd не найден (env LITEMIND_SD_BIN)');
  else {
    const ver = await sdVersion(bin);
    check('sd запускается и отдаёт версию', Boolean(ver), ver ?? 'null');
    const gdir = fs.mkdtempSync(path.join(os.tmpdir(), 'img-gen-'));
    const modelsDir = path.join(modelsRoot, 'image');
    const modelFile = process.env.LITEMIND_TEST_SD_MODEL ?? '';
    if (!modelFile || !fs.existsSync(modelFile)) {
      skip('реальная генерация', 'модель не задана (env LITEMIND_TEST_SD_MODEL)');
    } else {
      fs.mkdirSync(modelsDir, { recursive: true });
      const scanned = await scanImageModels(modelsDir);
      const mg = new ImageGenManager({ config, gallery: (await import(path.join(ROOT, 'src/image/gallery.js'))).ImageGallery && new (await import(path.join(ROOT, 'src/image/gallery.js'))).ImageGallery(gdir) });
      const st = await mg.generate({ modelFile, modelName: null, params: sanitizeParams({ prompt: 'a red apple on a wooden table', steps: 2, width: 256, height: 256, seed: 7 }) });
      // ждём завершения до 20 минут (слабый CPU)
      const t0 = Date.now();
      while (mg.busy && Date.now() - t0 < 20 * 60 * 1000) await new Promise((r) => setTimeout(r, 2000));
      const done = mg.status();
      check('реальная генерация завершилась состоянием done', done.job?.state === 'done', done.job?.error ?? `state=${done.job?.state}`);
      if (done.job?.state === 'done') {
        check('результат попал в галерею с параметрами', Boolean(done.job.result?.name && done.job.result.seed === 7));
        const items = await mg.gallery.list();
        check('файл в галерее существует и не пуст', items.length === 1 && items[0].sizeBytes > 1024);
        console.log(`   метрика: 256×256, 2 шага, ${Math.round((done.job.durationMs ?? 0) / 1000)} с, модель ${done.job.model}`);
      }
    }
    fs.rmSync(gdir, { recursive: true, force: true });
  }
}

console.log('');
console.log(`ИТОГ: провалов ${failures}, пропущено ${skipped}`);
process.exit(failures ? 1 : 0);
