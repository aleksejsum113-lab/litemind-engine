// Tests for LiteMind v0.2 modules: catalog integrity, compatibility rating,
// download manager (Range resume / pause / cancel), Ollama installer, API surface.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import { CATALOG, CATEGORIES, catalogEntry } from '../src/catalog/models.js';
import { rateFile, rateCatalogModel, STATUS } from '../src/compat.js';
import { DownloadManager } from '../src/download/manager.js';
import { OllamaInstaller, sha256File } from '../src/install/ollama.js';
import { analyzeHardware } from '../src/diagnostics/hardware.js';
import { createServer } from '../src/api/server.js';
import { makeEngine, fakeMetrics } from './helpers/fixtures.js';

// ---------------------------------------------------------------- catalog

test('catalog: every entry is complete and internally consistent', () => {
  assert.ok(CATALOG.length >= 10, `expected >= 10 verified models, got ${CATALOG.length}`);
  for (const m of CATALOG) {
    // image-модели (Генератор изображений) не приходят из Ollama — ollamaName допустимо null.
    if (String(m.category).startsWith('image-')) {
      assert.ok(m.id && m.displayName && m.category, `${m.id}: base fields (image)`);
    } else {
      assert.ok(m.id && m.ollamaName && m.displayName && m.category, `${m.id}: base fields`);
    }
    assert.ok(CATEGORIES[m.category], `${m.id}: category must exist in CATEGORIES`);
    assert.ok(m.purpose && m.license && m.source.startsWith('https://huggingface.co/'), `${m.id}: purpose/license/source`);
    assert.ok(m.files.length >= 1, `${m.id}: at least one quant file`);
    for (const f of m.files) {
      if (String(m.category).startsWith('image-')) {
        // image-модели: safetensors/gguf, источник — HF, репо может отличаться от m.repo (fp32-оригинал).
        assert.match(f.url, /^https:\/\/huggingface\.co\/[^/]+\/[^/]+\/resolve\//, `${m.id}: image url matches HF`);
        assert.match(f.name, /\.(gguf|safetensors)$/i, `${m.id}: image file format`);
      } else {
        assert.match(f.url, new RegExp(`^https://huggingface.co/${m.repo.replace(/\//g, '\\/')}/resolve/main/`), `${m.id}: url matches repo`);
        assert.match(f.name, /\.gguf$/i, `${m.id}: gguf file`);
      }
      assert.ok(f.sizeBytes > 100 * 1024 * 1024, `${m.id}: size looks realistic (> 100 MB)`);
    }
  }
});

test('catalog: uncensored entries are flagged and categorised', () => {
  const uncensored = CATALOG.filter((m) => m.uncensored);
  assert.ok(uncensored.length >= 6, 'expected at least 6 uncensored/abliterated entries');
  for (const m of uncensored) {
    assert.ok(['uncensored-coding', 'uncensored-chat'].includes(m.category), `${m.id}: uncensored category`);
    assert.ok(m.uncensoredLabel, `${m.id}: uncensoredLabel required`);
  }
});

test('catalog v2: restrictions split is explicit and consistent', () => {
  const reduced = CATALOG.filter((m) => m.restrictions === 'reduced');
  const standard = CATALOG.filter((m) => m.restrictions === 'standard');
  assert.ok(standard.length >= 20, `expected >= 20 standard models, got ${standard.length}`);
  assert.equal(reduced.length + standard.length, CATALOG.length, 'every entry must declare restrictions');
  for (const m of reduced) assert.equal(m.uncensored, true, `${m.id}: reduced implies uncensored flag`);
  for (const m of standard) assert.equal(m.uncensored, false, `${m.id}: standard must not be uncensored`);
});

test('catalog v2: families, languages, tags and per-file quants/checksums', () => {
  const families = new Set(CATALOG.map((m) => m.family));
  for (const expected of ['qwen2.5', 'qwen3', 'llama3.2', 'gemma2', 'phi4', 'mistral', 'smollm2', 'tinyllama', 'deepseek-r1', 'vikhr', 'dolphin'])
    assert.ok(families.has(expected), `family ${expected} must be present`);
  for (const m of CATALOG) {
    // image-модели внетекстовые: список языков к ним неприменим.
    if (String(m.category).startsWith('image-')) {
      assert.ok(Array.isArray(m.languages), `${m.id}: languages (image)`);
    } else {
      assert.ok(Array.isArray(m.languages) && m.languages.length >= 1, `${m.id}: languages`);
    }
    assert.ok(Array.isArray(m.tags) && m.tags.length >= 1, `${m.id}: tags`);
    assert.ok(['fast', 'medium', 'slow'].includes(m.speed), `${m.id}: speed class`);
    assert.ok(m.quantAuthor, `${m.id}: quant author`);
    for (const f of m.files) {
      // image-модели: свободная метка кванта (Q4_0/Q8_0/f16/safetensors fp32), строгий LLM-регекс не применим.
      if (!String(m.category).startsWith('image-')) {
        assert.match(f.quant, /^(Q[2-8]_K(_[SML])?|Q8_0)$/, `${m.id}: quant label`);
      }
      if (f.sha256) assert.match(f.sha256, /^[0-9a-f]{64}$/, `${m.id}: sha256 format`);
    }
  }
  const ruModels = CATALOG.filter((m) => m.languages.includes('ru'));
  assert.ok(ruModels.length >= 8, `expected >= 8 models with Russian, got ${ruModels.length}`);
});

test('catalog: lookup by id works and unknown ids return null', () => {
  assert.equal(catalogEntry('qwen2.5-coder-1.5b-abliterated').repo, 'bartowski/Qwen2.5-Coder-1.5B-Instruct-abliterated-GGUF');
  assert.equal(catalogEntry('no-such-model'), null);
});

// ---------------------------------------------------------------- compat

function fakeHw({ totalRamMb = 16384, freeRamMb = 8192, avx = false } = {}) {
  return {
    totalRamMb,
    freeRamMb,
    cpu: { model: 'Intel Celeron N5095A', cores: 4, avx, avx2: avx, avxMethod: 'test' },
    recommendation: { windowsReserveMb: 2048, maxContextTokens: 4096, cpuThreads: 3 }
  };
}

test('compat: green for a small model with plenty of RAM', () => {
  const r = rateFile({ fileBytes: 700 * 1024 * 1024, contextTokens: 2048, totalRamMb: 16384, reserveMb: 2048 });
  assert.equal(r.status, STATUS.GREEN);
});

test('compat: red when the model cannot fit', () => {
  const r = rateFile({ fileBytes: 4 * 1024 ** 3, contextTokens: 8192, availableRamMb: 2048, totalRamMb: 16384, reserveMb: 2048 });
  assert.equal(r.status, STATUS.RED);
  assert.match(r.reason, /не влез|Требуется/);
});

test('compat: yellow when it barely fits', () => {
  // 2.5 GB model on 4 GB budget: fits but with little headroom
  const r = rateFile({ fileBytes: 2.5 * 1024 ** 3, contextTokens: 2048, availableRamMb: 4096, totalRamMb: 16384, reserveMb: 2048 });
  assert.equal(r.status, STATUS.YELLOW);
});

test('compat: model rating picks the largest quant that is still green', () => {
  const model = catalogEntry('qwen2.5-coder-1.5b');
  const rating = rateCatalogModel(model, fakeHw());
  assert.equal(rating.status, STATUS.GREEN);
  assert.ok(rating.recommended.name.includes('Q4_K_M'), '16GB machine should afford Q4_K_M');
});

test('compat: 7B model on 8GB machine is red or yellow with a small quant', () => {
  const model = catalogEntry('qwen2.5-coder-7b');
  const rating = rateCatalogModel(model, fakeHw({ totalRamMb: 8192, freeRamMb: 2048 }));
  assert.ok([STATUS.RED, STATUS.YELLOW].includes(rating.status));
  if (rating.status === STATUS.YELLOW) assert.ok(rating.recommended.name.includes('Q2_K'));
});

// ---------------------------------------------------------------- download

async function startRangeServer(body, { chunkSize = 256 * 1024, chunkDelayMs = 40 } = {}) {
  const server = http.createServer((req, res) => {
    const range = req.headers.range;
    let start = 0;
    if (range) {
      const m = /bytes=(\d+)-/.exec(range);
      start = m ? Number(m[1]) : 0;
    }
    res.writeHead(206, {
      'content-length': String(body.length - start),
      'content-type': 'application/octet-stream',
      'accept-ranges': 'bytes'
    });
    let pos = start;
    const timer = setInterval(() => {
      if (pos >= body.length) { clearInterval(timer); return res.end(); }
      const end = Math.min(pos + chunkSize, body.length);
      res.write(body.subarray(pos, end));
      pos = end;
    }, chunkDelayMs);
    res.on('close', () => clearInterval(timer));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lm-dl-'));

test('download: full flow with progress, then done and size verified', async () => {
  const body = Buffer.concat([Buffer.from('GGUF'), Buffer.from('A'.repeat(3 * 1024 * 1024 - 4))]); // GGUF-магия: валидатор DownloadManager требует её честно
  const srv = await startRangeServer(body);
  const dir = tmpDir();
  const mgr = new DownloadManager({ allowLoopbackHttp: true });
  try {
    const job = await mgr.start({ id: "m1", url: srv.url + "/model.gguf", name: 'test.gguf', targetDir: dir, sizeBytes: body.length });
    assert.equal(job.state, 'downloading');
    await waitFor(() => mgr.list()[0]?.state === 'done');
    const files = fs.readdirSync(dir);
    assert.deepEqual(files, ['test.gguf']);
    assert.equal(fs.statSync(path.join(dir, 'test.gguf')).size, body.length);
  } finally { srv.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('download: pause keeps .part, resume completes with Range', async () => {
  const body = Buffer.concat([Buffer.from('GGUF'), Buffer.from('B'.repeat(6 * 1024 * 1024 - 4))]); // GGUF-магия
  const srv = await startRangeServer(body);
  const dir = tmpDir();
  const mgr = new DownloadManager({ allowLoopbackHttp: true });
  try {
    const job = await mgr.start({ id: "m2", url: srv.url + "/model.gguf", name: 'model.gguf', targetDir: dir, sizeBytes: body.length });
    // пауза сразу после старта
    await waitFor(() => mgr.list()[0]?.receivedBytes > 0);
    assert.equal(mgr.pause(job.id).paused, true);
    await waitFor(() => mgr.list()[0]?.state === 'paused');
    const partPath = path.join(dir, 'model.gguf.part');
    assert.ok(fs.existsSync(partPath), '.part must survive pause');
    const partSize = fs.statSync(partPath).size;
    assert.ok(partSize > 0 && partSize < body.length, 'partial download expected');

    await mgr.resume(job.id);
    await waitFor(() => mgr.list()[0]?.state === 'done');
    assert.equal(fs.statSync(path.join(dir, 'model.gguf')).size, body.length);
  } finally { srv.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('download: cancel removes .part', async () => {
  const body = Buffer.alloc(10 * 1024 * 1024, 7);
  const srv = await startRangeServer(body);
  const dir = tmpDir();
  const mgr = new DownloadManager({ allowLoopbackHttp: true });
  try {
    const job = await mgr.start({ id: "m3", url: srv.url + "/model.gguf", name: 'x.gguf', targetDir: dir, sizeBytes: body.length });
    await waitFor(() => mgr.list()[0]?.receivedBytes > 0);
    await mgr.cancel(job.id);
    assert.ok(!fs.existsSync(path.join(dir, 'x.gguf.part')));
    assert.equal(mgr.get(job.id), null);
  } finally { srv.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------- installer

test('installer: uploads blob with correct digest and calls create', async () => {
  const dir = tmpDir();
  const gguf = path.join(dir, 'm.gguf');
  const payload = Buffer.from('GGUF-fake-payload-' + 'x'.repeat(1000));
  fs.writeFileSync(gguf, payload);
  const digest = crypto.createHash('sha256').update(payload).digest('hex');
  const seen = { blob: null, create: null };

  const server = http.createServer(async (req, res) => {
    if (req.method === 'POST' && req.url === `/api/blobs/sha256:${digest}`) {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      seen.blob = { digestUrl: req.url, bytes: Buffer.concat(chunks).length };
      res.writeHead(201); return res.end();
    }
    if (req.method === 'POST' && req.url === '/api/create') {
      let raw = '';
      for await (const c of req) raw += c;
      seen.create = JSON.parse(raw);
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      res.write(JSON.stringify({ status: 'parsing model file' }) + '\n');
      return res.end(JSON.stringify({ status: 'success' }) + '\n');
    }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));

  try {
    const inst = new OllamaInstaller({ baseUrl: `http://127.0.0.1:${server.address().port}` });
    const stages = [];
    const result = await inst.installFromGguf({
      ggufPath: gguf,
      modelName: 'litemind-test',
      onStage: (s) => stages.push(s.stage)
    });
    assert.equal(result.digest, digest);
    assert.equal(seen.blob.bytes, payload.length);
    assert.equal(seen.create.model, 'litemind-test');
    assert.equal(seen.create.files['m.gguf'], `sha256:${digest}`);
    assert.deepEqual(stages.slice(0, 3), ['hash', 'blob', 'create']);
    assert.equal(stages[stages.length - 1], 'done');
  } finally { server.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('sha256File matches reference hash', async () => {
  const dir = tmpDir();
  const p = path.join(dir, 'h.bin');
  fs.writeFileSync(p, Buffer.from('hello litemind'));
  const expect = crypto.createHash('sha256').update(Buffer.from('hello litemind')).digest('hex');
  assert.equal(await sha256File(p), expect);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------- hardware

test('hardware: analysis returns structured report with recommendation', async () => {
  const hw = await analyzeHardware();
  assert.ok(hw.cpu.cores >= 1);
  assert.ok(hw.totalRamMb > 256);
  assert.ok(['boolean', 'object'].includes(typeof hw.cpu.avx) || hw.cpu.avx === null);
  assert.ok(hw.disks.length >= 1);
  assert.ok(['low', 'balanced'].includes(hw.recommendation.profile));
  assert.ok(hw.recommendation.usableModelRamMb < hw.totalRamMb, 'windows reserve must shrink the budget');
});

// ---------------------------------------------------------------- API

async function startApi({ configMutator = null } = {}) {
  const { engine, config } = makeEngine({ baseUrl: 'http://127.0.0.1:1', configMutator, sampler: { latest: fakeMetrics(), history: [], async sample() { return this.latest; }, stop() {} } });
  await engine.start();
  const server = createServer({ config, engine, logger: null });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`, config,
    close: async () => { server.close(); server.closeAllConnections?.(); engine.shutdown(); }
  };
}

test('API: /api/catalog returns categories, ratings and recommended quant', async () => {
  const api = await startApi();
  try {
    const res = await fetch(`${api.url}/api/catalog`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(data.models.length >= 10);
    const m = data.models.find((x) => x.id === 'qwen2.5-coder-1.5b');
    assert.equal(m.compatibility.status, 'green');
    assert.ok(m.compatibility.recommended.name.endsWith('.gguf'));
    assert.equal(m.installed, false);
    assert.ok(data.modelsRootDir);
  } finally { await api.close(); }
});

test('API: /api/hardware returns avx info and ggufFiles list', async () => {
  const api = await startApi();
  try {
    const res = await fetch(`${api.url}/api/hardware`);
    const data = await res.json();
    assert.deepEqual(data.ggufFiles, []);
    assert.ok(data.recommendation.windowsReserveMb > 0);
  } finally { await api.close(); }
});

test('API: unknown catalog model rejected with 404', async () => {
  const api = await startApi();
  try {
    const res = await fetch(`${api.url}/api/downloads`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ modelId: 'does-not-exist' })
    });
    assert.equal(res.status, 404);
  } finally { await api.close(); }
});

test('API: settings round-trip persists modelsRootDir and profile', async () => {
  const tmp = path.join(os.tmpdir(), `lm-cfg-${Date.now()}.json`);
  const api = await startApi({ configMutator: (c) => { c.paths = { configPath: tmp, existed: false }; } });
  try {
    const res = await fetch(`${api.url}/api/settings`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ modelsRootDir: os.tmpdir(), profile: 'balanced' })
    });
    assert.equal(res.status, 200);
    const saved = JSON.parse(fs.readFileSync(tmp, 'utf8'));
    assert.equal(saved.models.rootDir, os.tmpdir());
    assert.equal(saved.profile, 'balanced');
  } finally {
    await api.close();
    fs.rmSync(tmp, { force: true });
  }
});

function waitFor(fn, timeoutMs = 20000) {
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      let v;
      try { v = fn(); } catch (e) { return reject(e); }
      if (v) return resolve(v);
      if (Date.now() - t0 > timeoutMs) return reject(new Error('waitFor timeout'));
      setTimeout(tick, 60);
    };
    tick();
  });
}
