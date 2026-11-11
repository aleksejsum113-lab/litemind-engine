// Тесты Model Discovery (ТЗ v0.6.2): эвристики имён, дедупликация каталога,
// версии файлов, устойчивость к сбою сети, безопасное скачивание.
// Сеть не используется — только мок-fetch.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  familyFromName, quantFromFileName, paramsFromName, purposesFromName,
  speedClassOf, isModelGgufFile, detectFlavor
} from '../src/discovery/heuristics.js';
import { DiscoveryCatalog, entryKey } from '../src/discovery/catalog.js';
import { DiscoveryManager } from '../src/discovery/discovery.js';
import { loadConfig } from '../src/config.js';

// ── helpers ─────────────────────────────────────────────────────────────────

function tempConfig() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-disco-test-'));
  const cfgPath = path.join(dir, 'config.json');
  fs.writeFileSync(cfgPath, JSON.stringify({ models: { rootDir: path.join(dir, 'models') } }));
  const config = loadConfig(cfgPath);
  return { config, dir };
}

/** Мок-fetch Hugging Face API: поиск + дерево файлов. */
function mockHfFetch(repos, trees) {
  return async (url) => {
    if (url.includes('/api/models?')) {
      const items = repos.map((r, i) => ({
        id: r.repo,
        tags: ['gguf', ...(r.license ? [`license:${r.license}`] : [])],
        lastModified: r.lastModified ?? '2026-11-01T00:00:00.000Z',
        createdAt: r.createdAt ?? '2026-10-01T00:00:00.000Z',
        downloads: 1000 + i,
        likes: 10 + i
      }));
      return mkRes(items);
    }
    const treeMatch = /\/api\/models\/(.+)\/tree\/main$/.exec(url);
    if (treeMatch) {
      const repo = decodeURIComponent(treeMatch[1]);
      return mkRes(trees[repo] ?? []);
    }
    throw new Error(`неожиданный URL в тесте: ${url}`);
  };
}

function mkRes(obj) {
  return {
    ok: true,
    status: 200,
    json: async () => JSON.parse(JSON.stringify(obj))
  };
}

const SYNTHETIC_HW = async () => ({
  totalRamMb: 16384,
  freeRamMb: 12288,
  cpu: { avx: false, avx2: false, cores: 4, model: 'Synthetic CPU' },
  recommendation: { maxContextTokens: 4096, windowsReserveMb: 2048, profile: 'balanced' }
});

// ── эвристики ───────────────────────────────────────────────────────────────

test('heuristics: семейство из имени репозитория, вендорные префиксы и Dolphin', () => {
  assert.equal(familyFromName('Qwen_Qwen3-0.6B-GGUF'), 'qwen3');
  assert.equal(familyFromName('bartowski/Meta-Llama-3.2-1B-Instruct-GGUF'), 'llama3.2');
  assert.equal(familyFromName('google_gemma-3-4b-it-GGUF'), 'gemma3');
  assert.equal(familyFromName('Dolphin3.0-Qwen3-8B-GGUF'), 'qwen3');
  assert.equal(detectFlavor('Dolphin3.0-Qwen3-8B-GGUF'), 'dolphin');
  assert.equal(familyFromName('Huihui-Qwen3-8B-abliterated-v2'), 'qwen3');
  assert.equal(detectFlavor('Huihui-Qwen3-8B-abliterated-v2'), 'huihui');
  // Неизвестное семейство — честный null, без выдумок.
  assert.equal(familyFromName('some-brand-new-model-GGUF'), null);
});

test('heuristics: квантование, параметры, назначение, скорость', () => {
  assert.equal(quantFromFileName('Qwen3-0.6B-Q8_0.gguf'), 'Q8_0');
  assert.equal(quantFromFileName('model-IQ4_XS.gguf'), 'IQ4_XS');
  assert.equal(quantFromFileName('noquant.gguf'), null);
  assert.equal(paramsFromName('Qwen3-0.6B-GGUF'), '0.6B');
  assert.equal(paramsFromName('Llama-3.2-1B-Instruct'), '1B');
  assert.equal(paramsFromName('Mixtral-8x7B-Instruct'), '8x7B');
  assert.deepEqual(purposesFromName('Qwen3-0.6B-Instruct-GGUF'), ['chat']);
  assert.deepEqual(purposesFromName('Qwen2.5-Coder-7B-GGUF'), ['coding']);
  assert.deepEqual(purposesFromName('plain-text-model-GGUF'), ['text']);
  assert.equal(speedClassOf('0.6B'), 'fast');
  assert.equal(speedClassOf('3B'), 'medium');
  assert.equal(speedClassOf('7B'), 'slow');
});

test('heuristics: mmproj и многочастные GGUF не модели', () => {
  assert.equal(isModelGgufFile('mmproj-Qwen3-0.6B.gguf'), false);
  assert.equal(isModelGgufFile('model-00001-of-00003.gguf'), false);
  assert.equal(isModelGgufFile('Qwen3-0.6B-Q8_0.gguf'), true);
});

// ── каталог ─────────────────────────────────────────────────────────────────

test('catalog: дедупликация по repo|файл, версии при изменении размера', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-disco-cat-'));
  const cat = new DiscoveryCatalog({ dir }).load();

  const c1 = { repo: 'a/m-GGUF', author: 'a', name: 'm-Q8_0.gguf', url: 'https://huggingface.co/a/m-GGUF/resolve/main/m-Q8_0.gguf', sizeBytes: 1000, sha256: 'aa'.repeat(32) };
  const r1 = cat.merge(c1);
  assert.equal(r1.isNew, true);
  const r2 = cat.merge({ ...c1 }); // тот же файл — НЕ дубль
  assert.equal(r2.isNew, false);
  assert.equal(r2.changed, false);
  assert.equal(cat.size, 1);

  // Размер изменился в источнике → запись обновлена, прежняя версия сохранена.
  const r3 = cat.merge({ ...c1, sizeBytes: 1234 });
  assert.equal(r3.changed, true);
  assert.equal(r3.isNew, false);
  assert.equal(cat.size, 1, 'ревизии не создают новых записей');
  assert.equal(r3.entry.revisions.length, 1);
  assert.equal(r3.entry.revisions[0].sizeBytes, 1000);
  assert.equal(r3.entry.sha256, 'aa'.repeat(32), 'SHA не трогаем, если источник не дал новый');

  // displayState: свежесозданная запись — «новинка».
  assert.equal(cat.displayState(cat.get(entryKey('a/m-GGUF', 'm-Q8_0.gguf'))), 'new');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('catalog: сохранение переживает пересоздание объекта (перезапуск приложения)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-disco-save-'));
  const cat = new DiscoveryCatalog({ dir }).load();
  cat.merge({ repo: 'a/b-GGUF', name: 'b-Q4_K_M.gguf', url: 'https://huggingface.co/a/b-GGUF/resolve/main/b-Q4_K_M.gguf', sizeBytes: 500 });
  await cat.save(); // атомарная запись tmp+rename

  const cat2 = new DiscoveryCatalog({ dir }).load();
  assert.ok(cat2.get(entryKey('a/b-GGUF', 'b-Q4_K_M.gguf')), 'запись читается после «перезапуска»');
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── DiscoveryManager: обновление каталога ───────────────────────────────────

test('discovery: refresh наполняет каталог из источников (мок-fetch)', async () => {
  const { config, dir } = tempConfig();
  const repos = [
    { repo: 'bartowski/Qwen3-0.6B-Instruct-GGUF', license: 'apache-2.0', lastModified: '2026-11-05T00:00:00.000Z' },
    { repo: 'QuantFactory/Dolphin3.0-Qwen3-8B-GGUF', lastModified: '2026-11-06T00:00:00.000Z' }
  ];
  const trees = {
    'bartowski/Qwen3-0.6B-Instruct-GGUF': [
      { type: 'file', path: 'Qwen3-0.6B-Instruct-Q8_0.gguf', size: 640_000_000, lfs: { size: 640_000_000, oid: 'AB'.repeat(32) } },
      { type: 'file', path: 'mmproj-Qwen3.gguf', size: 5_000_000, lfs: { size: 5_000_000, oid: 'CD'.repeat(32) } }
    ],
    'QuantFactory/Dolphin3.0-Qwen3-8B-GGUF': [
      { type: 'file', path: 'Dolphin3.0-Qwen3-8B-Q4_K_M.gguf', size: 4_900_000_000, lfs: { size: 4_900_000_000, oid: 'EF'.repeat(32) } }
    ]
  };
  const downloadsStarted = [];
  const dm = new DiscoveryManager({
    config,
    fetchImpl: mockHfFetch(repos, trees),
    hardwareProvider: SYNTHETIC_HW,
    downloads: { start: async (job) => { downloadsStarted.push(job); return { id: job.id, state: 'downloading' }; } }
  });

  const res = await dm.refresh();
  assert.equal(res.reposChecked, 2);
  assert.equal(res.added, 2, 'mmproj отфильтрован, добавлены 2 настоящие модели');
  assert.equal(res.errors, 0);

  const list = await dm.list({ filter: 'all' });
  assert.ok(list.models.length >= 2);
  const q8 = list.models.find((m) => m.name.includes('Q8_0'));
  assert.ok(q8, 'модель Q8_0 в списке');
  assert.equal(q8.quant, 'Q8_0');
  assert.equal(q8.family, 'qwen3');
  assert.equal(q8.sha256, 'ab'.repeat(32), 'эталонный SHA из LFS сохранён');
  assert.ok(q8.rating, 'оценка совместимости по железу рассчитана');
  assert.ok(q8.rating.level, `уровень: ${JSON.stringify(q8.rating)}`);

  const chat = await dm.list({ filter: 'chat' });
  assert.ok(chat.models.some((m) => m.name.includes('Q8_0')), 'instruct-модель видна в фильтре «Для общения»');
  const dolphin = await dm.list({ filter: 'dolphin' });
  assert.ok(dolphin.models.some((m) => m.flavor === 'dolphin'), 'Dolphin находится своим фильтром');

  // Статус: проверка успешна, счётчики на месте.
  const st = dm.status();
  assert.equal(st.checking, false);
  assert.ok(st.lastCheckAt);
  assert.equal(st.lastError, null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('discovery: сбой сети не портит каталог, ошибка показывается', async () => {
  const { config, dir } = tempConfig();
  const goodFetch = mockHfFetch(
    [{ repo: 'a/m1-GGUF', lastModified: '2026-11-05T00:00:00.000Z' }],
    { 'a/m1-GGUF': [{ type: 'file', path: 'm1-Q8_0.gguf', size: 1000, lfs: { size: 1000, oid: 'AA'.repeat(32) } }] }
  );
  const dm1 = new DiscoveryManager({ config, fetchImpl: goodFetch, hardwareProvider: SYNTHETIC_HW });
  await dm1.refresh();
  const before = dm1.status().counts.total;
  assert.ok(before >= 1);

  // Все источники легли: fetch падает по таймауту.
  const deadFetch = async () => { throw new Error('таймаут 15 с'); };
  const dm2 = new DiscoveryManager({ config, fetchImpl: deadFetch, hardwareProvider: SYNTHETIC_HW });
  const res = await dm2.refresh();
  assert.equal(res.errors, 1);
  const st = dm2.status();
  assert.ok(st.lastError, 'ошибка зафиксирована для UI');
  assert.equal(st.counts.total, before, 'ранее найденные модели сохранены');
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── скачивание ──────────────────────────────────────────────────────────────

test('discovery: download — безопасное имя, SHA-256 из источника, общий загрузчик', async () => {
  const { config, dir } = tempConfig();
  const repos = [{ repo: 'a/m1-GGUF', lastModified: '2026-11-05T00:00:00.000Z' }];
  const trees = {
    'a/m1-GGUF': [{ type: 'file', path: 'm1-Q8_0.gguf', size: 640_000_000, lfs: { size: 640_000_000, oid: 'AB'.repeat(32) } }]
  };
  const started = [];
  const dm = new DiscoveryManager({
    config,
    fetchImpl: mockHfFetch(repos, trees),
    hardwareProvider: SYNTHETIC_HW,
    downloads: { start: async (job) => { started.push(job); return { id: job.id, state: 'downloading' }; } }
  });
  await dm.refresh();

  const r = await dm.download(entryKey('a/m1-GGUF', 'm1-Q8_0.gguf'));
  assert.equal(started.length, 1, 'скачивание через общий DownloadManager');
  assert.equal(started[0].url, 'https://huggingface.co/a/m1-GGUF/resolve/main/m1-Q8_0.gguf');
  assert.equal(started[0].sha256, 'ab'.repeat(32), 'SHA-256 передан загрузчику для проверки после скачки');
  assert.match(started[0].name, /^[\w.-]+\.gguf$/, 'имя файла безопасное');
  assert.ok(r.ok);

  // Несуществующий ключ — 404-подобная ошибка.
  await assert.rejects(() => dm.download('nope|nope.gguf'), /не найдена/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('discovery: config-настройки читаются с ограничениями', async () => {
  const { config, dir } = tempConfig();
  config.discovery = { enabled: false, intervalHours: 9999, maxTreeFetchesPerCheck: 1 };
  const dm = new DiscoveryManager({ config, fetchImpl: async () => mkRes([]), hardwareProvider: SYNTHETIC_HW });
  assert.equal(dm.cfg.enabled, false);
  assert.equal(dm.cfg.intervalHours, 168, 'период зажат в 6..168 ч');
  assert.equal(dm.cfg.maxTreeFetches, 5, 'лимит деревьев зажат снизу');
  assert.ok(Array.isArray(dm.cfg.authors) && dm.cfg.authors.length > 0, 'авторы по умолчанию подставлены');
  fs.rmSync(dir, { recursive: true, force: true });
});
