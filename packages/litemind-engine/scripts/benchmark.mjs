#!/usr/bin/env node
// Воспроизводимые замеры LiteMind Engine на реальной модели.
// Запуск:  node scripts/benchmark.mjs [--url http://127.0.0.1:8399] [--model ИМЯ] [--n 3]
//
// Что измеряется:
//   1) RAM до запуска генерации
//   2) время до первого токена (TTFT)
//   3) общее время и скорость (токены/сек)
//   4) пиковая RAM и CPU во время генерации
//   5) RAM после выгрузки модели и время освобождения памяти
// Результат дописывается в docs/BENCHMARKS.md (вручную или копипастой).
import { collectMetrics } from '../src/resource/metrics.js';

const args = process.argv.slice(2);
const getFlag = (name, def) => {
  const i = args.indexOf(name);
  return i !== -1 && args[i + 1] ? args[i + 1] : def;
};
const BASE = getFlag('--url', 'http://127.0.0.1:8399');
const N = Number(getFlag('--n', '3'));
const PROMPT = getFlag('--prompt', 'Объясни разницу между массивом и связным списком в двух абзацах.');

const round = (v) => (v == null ? null : Math.round(v * 10) / 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(path, opts) {
  const res = await fetch(BASE + path, opts);
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { data = text; }
  if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}: ${typeof data === 'string' ? data : JSON.stringify(data)}`);
  return data;
}

async function oneRun(model) {
  const t0 = performance.now();
  let ttft = null;
  let chars = 0;
  const res = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, stream: true, messages: [{ role: 'user', content: PROMPT }] })
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) !== -1) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      for (const line of block.split('\n')) {
        if (!line.startsWith('data: ')) continue;
        const payload = line.slice(6);
        if (payload === '[DONE]') continue;
        let obj;
        try { obj = JSON.parse(payload); } catch { continue; }
        const delta = obj.choices?.[0]?.delta?.content;
        if (delta) {
          if (ttft === null) ttft = performance.now() - t0;
          chars += delta.length;
        }
      }
    }
  }
  const total = performance.now() - t0;
  const approxTokens = Math.ceil(chars / 4); // приблизительно: ~4 символа на токен
  return { ttftMs: round(ttft), totalMs: round(total), chars, approxTokens, tokensPerSecond: round((approxTokens / total) * 1000) };
}

async function sampleDuring(durationMs, intervalMs = 250) {
  const samples = [];
  const started = Date.now();
  while (Date.now() - started < durationMs) {
    const m = await collectMetrics();
    samples.push(m);
    await sleep(intervalMs);
  }
  return samples;
}

async function main() {
  console.log(`LiteMind benchmark -> ${BASE}`);
  const before = await collectMetrics();
  console.log(`RAM до: total=${before.totalRamMb}MB used=${before.usedRamMb}MB available=${before.availableRamMb}MB cpu=${before.cpuPercent}%`);

  const status = await api('/api/status');
  console.log(`профиль=${status.engine.profile} backend=${status.backend.type} healthy=${status.backend.health.ok}`);
  if (!status.backend.health.ok) {
    console.error(`Backend недоступен: ${status.backend.health.error}`);
    process.exit(1);
  }
  const model = getFlag('--model', status.models[0]?.id);
  if (!model) {
    console.error('Нет установленных моделей. Установите одну вручную: ollama pull qwen2.5:0.5b');
    process.exit(1);
  }
  console.log(`модель=${model}, запусков=${N}`);

  const runs = [];
  let peak = before;
  for (let i = 0; i < N; i++) {
    const t0 = Date.now();
    const run = await oneRun(model);
    const during = await sampleDuring(0); // мгновенный снимок сразу после запуска
    runs.push(run);
    console.log(` запуск ${i + 1}: TTFT=${run.ttftMs}мс всего=${run.totalMs}мс ~токенов=${run.approxTokens} скорость≈${run.tokensPerSecond} ток/с`);
    const now = await collectMetrics();
    if (now.usedRamMb > peak.usedRamMb) peak = now;
    void t0;
  }

  // Пиковая память — в непрерывном потоке замеров во время генерации
  const t0 = Date.now();
  const background = (async () => {
    let p = peak;
    while (Date.now() - t0 < 3000) {
      const m = await collectMetrics();
      if (m.usedRamMb > p.usedRamMb) p = m;
      await sleep(200);
    }
    return p;
  })();
  await oneRun(model);
  peak = await background;

  console.log(`Пиковая RAM: used=${peak.usedRamMb}MB available=${peak.availableRamMb}MB cpu=${peak.cpuPercent}%`);

  const beforeUnload = await collectMetrics();
  const tu = Date.now();
  await api('/api/unload', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: null }) });
  let freedAt = null;
  let after = beforeUnload;
  while (Date.now() - tu < 60000) {
    await sleep(1000);
    after = await collectMetrics();
    if (beforeUnload.usedRamMb - after.usedRamMb > 100) { freedAt = Date.now() - tu; break; }
  }
  console.log(`Выгрузка: RAM было=${beforeUnload.usedRamMb}MB стало=${after.usedRamMb}MB освобождено=${beforeUnload.usedRamMb - after.usedRamMb}MB за ${freedAt ?? '>60000'}мс`);

  const avg = (k) => round(runs.reduce((s, r) => s + r[k], 0) / runs.length);
  console.log('\nСВОДКА (скопируйте в docs/BENCHMARKS.md):');
  console.log(`| ${model} | ${avg('ttftMs')} | ${avg('totalMs')} | ${avg('tokensPerSecond')} | ${before.usedRamMb} | ${peak.usedRamMb} | ${after.usedRamMb} | ${freedAt ?? 'n/a'} |`);
  console.log(`RAM: ${before.usedRamMb} → пик ${peak.usedRamMb} → после выгрузки ${after.usedRamMb} (total ${before.totalRamMb} MB), CPU пик ${peak.cpuPercent}%`);
}

main().catch((err) => {
  console.error(`Ошибка замера: ${err.message}`);
  process.exit(1);
});
