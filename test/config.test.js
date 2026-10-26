import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_CONFIG, DEFAULT_PROFILES, loadConfig, mergeDeep, validateConfig, activeProfile, saveConfig } from '../src/config.js';

test('Low Resource profile is conservative by default', () => {
  const low = DEFAULT_PROFILES.low;
  assert.equal(low.maxConcurrentRequests, 1, 'one active request');
  assert.equal(low.contextTokens, 2048, 'small context');
  assert.ok(low.maxOutputTokens > 0 && low.maxOutputTokens <= 1024, 'limited generation length');
  assert.equal(low.autoLoadAtStartup, false, 'no heavy model load at startup');
  assert.equal(low.allowAutoDownload, false, 'no automatic downloads');
  assert.ok(low.idleUnloadSeconds > 0, 'idle unload timer active');
  assert.ok(low.memoryReserveMb >= 1024, 'Windows memory reserve kept');
  assert.ok(low.cpuThreads > 0, 'CPU thread cap set');
});

test('defaults bind API to loopback with LAN exposure off', () => {
  assert.equal(DEFAULT_CONFIG.api.host, '127.0.0.1');
  assert.equal(DEFAULT_CONFIG.api.allowLan, false);
  assert.equal(DEFAULT_CONFIG.api.auth.enabled, false);
});

test('validateConfig refuses allowLan without auth', () => {
  const cfg = mergeDeep(DEFAULT_CONFIG, { api: { allowLan: true } });
  assert.throws(() => validateConfig(cfg), /allowLan requires api.auth.enabled/);
});

test('validateConfig accepts allowLan with auth token', () => {
  const cfg = mergeDeep(DEFAULT_CONFIG, { api: { allowLan: true, auth: { enabled: true, token: 'secret' } } });
  assert.doesNotThrow(() => validateConfig(cfg));
});

test('validateConfig rejects bad port and unknown backend', () => {
  assert.throws(() => validateConfig(mergeDeep(DEFAULT_CONFIG, { api: { port: 99999 } })), /port/);
  assert.throws(() => validateConfig(mergeDeep(DEFAULT_CONFIG, { backend: { type: 'mystery' } })), /unsupported backend/);
  assert.throws(() => validateConfig(mergeDeep(DEFAULT_CONFIG, { profile: 'turbo' })), /profile/);
});

test('mergeDeep overrides nested keys without dropping siblings', () => {
  const merged = mergeDeep(DEFAULT_CONFIG, { api: { port: 9000 } });
  assert.equal(merged.api.port, 9000);
  assert.equal(merged.api.host, '127.0.0.1');
});

test('loadConfig merges file over defaults and saveConfig round-trips', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'litemind-cfg-'));
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, JSON.stringify({ api: { port: 9100 }, profile: 'low' }));
  const cfg = loadConfig(file);
  assert.equal(cfg.api.port, 9100);
  assert.equal(cfg.api.host, '127.0.0.1');
  assert.ok(activeProfile(cfg).maxConcurrentRequests === 1);

  cfg.api.port = 9200;
  saveConfig(cfg, file);
  const reloaded = loadConfig(file);
  assert.equal(reloaded.api.port, 9200);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('loadConfig reports broken JSON instead of silently defaulting', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'litemind-cfg-'));
  const file = path.join(dir, 'bad.json');
  fs.writeFileSync(file, '{ not json');
  assert.throws(() => loadConfig(file), /not valid JSON/);
  fs.rmSync(dir, { recursive: true, force: true });
});
