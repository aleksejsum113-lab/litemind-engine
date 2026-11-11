// Тесты управляемого интернета (ТЗ §7): выключен по умолчанию, SSRF-защита,
// html→текст, GitHub-операции на мок-fetch. Сеть не используется.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  createWebContext, htmlToText, isPublicIp, assertPublicHost, DEFAULT_WEB_CONFIG
} from '../src/web/fetcher.js';
import { loadConfig } from '../src/config.js';

function cfgWithWeb(web) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-web-test-'));
  const cfgPath = path.join(dir, 'config.json');
  fs.writeFileSync(cfgPath, JSON.stringify({ web }));
  return { config: loadConfig(cfgPath), dir };
}

test('по умолчанию интернет ВЫКЛЮЧЕН: fetchText/github отказывают', async () => {
  const { config, dir } = cfgWithWeb(undefined);
  assert.equal(config.web.enabled, false, 'дефолт из DEFAULT_CONFIG — выключен');
  const web = createWebContext(config);
  assert.equal(web.enabled(), false);
  await assert.rejects(() => web.fetchText('https://example.com/'), /выключен/);
  await assert.rejects(() => web.github({ op: 'repo', repo: 'a/b' }), /выключен/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('SSRF: приватные и локальные адреса запрещены', async () => {
  const { config, dir } = cfgWithWeb({ enabled: true });
  const web = createWebContext(config, { fetchImpl: async () => { throw new Error('не должен вызываться'); } });
  await assert.rejects(() => web.fetchText('http://127.0.0.1:8399/'), /приватн|публичн/i);
  await assert.rejects(() => web.fetchText('http://localhost/x'), /не является публичным/);
  await assert.rejects(() => web.fetchText('http://10.0.0.5/x'), /приватн|публичн/i);
  await assert.rejects(() => web.fetchText('http://192.168.1.1/x'), /приватн|публичн/i);
  await assert.rejects(() => web.fetchText('http://169.254.169.254/latest/meta-data/'), /приватн|публичн/i);
  await assert.rejects(() => web.fetchText('file:///etc/passwd'), /http\(s\)/);
  await assert.rejects(() => web.fetchText('http://[::1]/x'), /приватн|публичн/i);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('htmlToText вычищает скрипты, стили и теги', () => {
  const html = `<!doctype html><html><head><style>body{color:red}</style><script>alert(1)</script></head>
  <body><h1>Заголовок</h1><p>Первый&nbsp;абзац &amp; символы</p><ul><li>пункт 1</li><li>пункт 2</li></ul>
  <script>var x = "</p>хитрый</script>"</body></html>`;
  const text = htmlToText(html);
  assert.ok(text.includes('Заголовок'));
  assert.ok(text.includes('Первый абзац & символы'));
  assert.ok(text.includes('• пункт 1'));
  assert.ok(!text.includes('alert'), 'скрипты удалены');
  assert.ok(!text.includes('color:red'), 'стили удалены');
  assert.ok(!/<[a-z]/i.test(text), 'тегов не осталось');
});

test('fetchText: публичный URL работает, HTML превращается в текст (мок-fetch)', async () => {
  const { config, dir } = cfgWithWeb({ enabled: true });
  const calls = [];
  const fakeRes = { ok: true, headers: new Map([['content-type', 'text/html']]), arrayBuffer: async () => Buffer.from('<html><body><p>привет</p></body></html>') };
  fakeRes.headers.get = (k) => (k === 'content-type' ? 'text/html' : null);
  const web = createWebContext(config, {
    fetchImpl: async (url, opts) => { calls.push({ url: String(url), opts }); return fakeRes; }
  });
  const r = await web.fetchText('https://example.com/page');
  assert.ok(r.text.includes('привет'));
  assert.equal(calls[0].url, 'https://example.com/page');
  assert.ok(calls[0].opts.headers['user-agent'].includes('LiteMind'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('github op=repo/search формируют корректные запросы к api.github.com', async () => {
  const { config, dir } = cfgWithWeb({ enabled: true, githubToken: 'ghp_test' });
  const calls = [];
  const mkRes = (body) => ({
    ok: true,
    headers: new Map(),
    arrayBuffer: async () => Buffer.from(JSON.stringify(body)),
    json: async () => body
  });
  const web = createWebContext(config, {
    fetchImpl: async (url, opts) => {
      calls.push({ url: String(url), headers: opts.headers });
      if (String(url).includes('/search/')) return mkRes({ items: [{ full_name: 'ggml-org/llama.cpp', stargazers_count: 1, description: 'LLM' }] });
      return mkRes({ full_name: 'ggml-org/llama.cpp', description: 'LLM inference', language: 'C++', stargazers_count: 1, license: { spdx_id: 'MIT' }, default_branch: 'master', html_url: 'x' });
    }
  });
  const r1 = await web.github({ op: 'repo', repo: 'https://github.com/ggml-org/llama.cpp' });
  assert.ok(r1.text.includes('ggml-org/llama.cpp'));
  assert.equal(calls[0].url, 'https://api.github.com/repos/ggml-org/llama.cpp');
  assert.equal(calls[0].headers.authorization, 'Bearer ghp_test', 'токен передаётся, но не логируется');
  const r2 = await web.github({ op: 'search', query: 'llama' });
  assert.ok(r2.text.includes('llama.cpp'));
  await assert.rejects(() => web.github({ op: 'repo', repo: 'not-a-repo' }), /owner\/repo/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('isPublicIp: юнит-проверки', () => {
  assert.equal(isPublicIp('8.8.8.8'), true);
  assert.equal(isPublicIp('127.0.0.1'), false);
  assert.equal(isPublicIp('10.1.2.3'), false);
  assert.equal(isPublicIp('172.16.0.1'), false);
  assert.equal(isPublicIp('172.32.0.1'), true);
  assert.equal(isPublicIp('192.168.0.1'), false);
  assert.equal(isPublicIp('169.254.1.1'), false);
  assert.equal(isPublicIp('::1'), false);
  assert.equal(isPublicIp('::ffff:127.0.0.1'), false);
  assert.equal(isPublicIp('2606:4700::1111'), true);
});

test('assertPublicHost: DNS-имя с приватным адресом блокируется', async () => {
  await assert.rejects(() => assertPublicHost('localhost'), /не является публичным/);
  await assert.rejects(() => assertPublicHost(''), /пустой/);
  // публичный литерал проходит
  await assertPublicHost('1.1.1.1');
});
