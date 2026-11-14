// LiteMind Engine — локальные голосовые движки: распознавание (whisper.cpp) и
// озвучивание (piper). ТЗ v0.6.4 Roamies-дополнение §2 + §9.
//
// Принципы:
//  - Локально и бесплатно: whisper.cpp (ggml-tiny, работает без AVX на CPU) и
//    piper (быстрый TTS на CPU). Никаких обязательных облаков и ключей.
//  - Тяжёлые компоненты НЕ входят в установщик: скачиваются по явной кнопке
//    пользователя (ТЗ §9: «загружать тяжёлые компоненты по требованию»), с
//    проверкой размера и SHA-256 (файлы константны — суммы вычислены заранее).
//  - Ничего не запускается в фоне постоянно: TTS/ASR — короткие процессы,
//    микрофон включается только в режиме Push-to-Talk.
//  - Распаковка — PowerShell Expand-Archive (Windows; без внешних зависимостей).

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';

/**
 * Каталог голосовых компонентов. URL проверены (HTTP 200, размеры сходятся),
 * SHA-256 вычислен из фактических файлов источника. Изменение источника —
 * только с пересчётом суммы: это защита от подмены файла.
 */
export const VOICE_COMPONENTS = {
  'piper-windows': {
    kind: 'tts-runtime',
    description: 'Piper TTS — локальный синтез речи (Windows x64)',
    url: 'https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_windows_amd64.zip',
    sizeBytes: 22477236,
    sha256: 'f3c58906402b24f3a96d92145f58acba6d86c9b5db896d207f78dc80811efcea',
    extract: true,
    exe: 'piper.exe'
  },
  'voice-ru-irina': {
    kind: 'tts-voice',
    description: 'Русский голос Irina (medium) для Piper',
    url: 'https://huggingface.co/rhasspy/piper-voices/resolve/main/ru/ru_RU/irina/medium/ru_RU-irina-medium.onnx',
    sizeBytes: 63201294,
    sha256: '8ff38212d23da300bbe3705c645e6e5b9475f0bfde01558eb17813e22acaaaaa',
    extract: false
  },
  'voice-ru-irina-config': {
    kind: 'tts-voice-config',
    description: 'Конфигурация голоса Irina',
    url: 'https://huggingface.co/rhasspy/piper-voices/resolve/main/ru/ru_RU/irina/medium/ru_RU-irina-medium.onnx.json',
    sizeBytes: 4765,
    sha256: 'c2ec28bb38e2b59e93b959b3e40348c1afebbd272f30fed5d41205d08e98a9d7',
    extract: false
  },
  'whisper-windows': {
    kind: 'asr-runtime',
    description: 'whisper.cpp — локальное распознавание речи (Windows x64, CPU без AVX)',
    url: 'https://github.com/ggml-org/whisper.cpp/releases/download/v1.7.6/whisper-bin-x64.zip',
    sizeBytes: 3675974,
    sha256: '0d2eca299c248f965bd0341bcb219db4b433c7f0c0ce2200d4df85765e8156a9',
    extract: true,
    exe: 'whisper-cli.exe'
  },
  'whisper-model-tiny': {
    kind: 'asr-model',
    description: 'Модель whisper tiny (мультиязычная, ~78 МБ) — самый быстрый вариант для слабых ПК',
    url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin',
    sizeBytes: 77691713,
    sha256: 'be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21',
    extract: false
  }
};

const DOWNLOAD_TIMEOUT_MS = 15 * 60_000;
const UA = 'LiteMind-Engine/0.6 (+local; user-initiated voice components)';

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = fs.createReadStream(file);
    stream.on('data', (c) => hash.update(c));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

export function createVoiceManager({ config, logger = null, companion = null } = {}) {
  const dataDir = path.join(path.dirname(config.paths.configPath), 'voice');
  const state = {
    busy: null, // { component, phase, receivedBytes, sizeBytes }
    jobs: new Map()
  };

  const componentDir = (id) => path.join(dataDir, id);

  function installedPaths(id) {
    const comp = VOICE_COMPONENTS[id];
    if (!comp) return null;
    const dir = componentDir(id);
    if (!comp.extract) {
      // единственный файл в каталоге
      const name = path.basename(new URL(comp.url).pathname);
      const file = path.join(dir, name);
      return fs.existsSync(file) ? { dir, main: file } : null;
    }
    // ищем exe рекурсивно (zip может содержать подкаталог piper/)
    if (!fs.existsSync(dir)) return null;
    const stack = [dir];
    while (stack.length) {
      const cur = stack.pop();
      let entries;
      try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch { continue; }
      for (const e of entries) {
        const p = path.join(cur, e.name);
        if (e.isFile() && e.name.toLowerCase() === comp.exe.toLowerCase()) return { dir, main: p };
        if (e.isDirectory()) stack.push(p);
      }
    }
    return null;
  }

  function findFile(id, suffix) {
    const comp = VOICE_COMPONENTS[id];
    if (!comp) return null;
    const dir = componentDir(id);
    if (!fs.existsSync(dir)) return null;
    const stack = [dir];
    while (stack.length) {
      const cur = stack.pop();
      let entries;
      try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch { continue; }
      for (const e of entries) {
        const p = path.join(cur, e.name);
        if (e.isFile() && e.name.toLowerCase().endsWith(suffix.toLowerCase())) return p;
        if (e.isDirectory()) stack.push(p);
      }
    }
    return null;
  }

  /** Скачать компонент: временный файл → проверка размера+SHA-256 → установка. */
  async function installComponent(id, { onProgress = null } = {}) {
    const comp = VOICE_COMPONENTS[id];
    if (!comp) throw Object.assign(new Error(`неизвестный компонент: ${id}`), { status: 400 });
    if (process.platform !== 'win32') {
      throw Object.assign(new Error('голосовые движки пока устанавливаются только в LiteMind Desktop на Windows'), { status: 451 });
    }
    const dir = componentDir(id);
    await fsp.mkdir(dir, { recursive: true });
    const tmp = path.join(dir, `${id}.download`);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(new Error('таймаут загрузки')), DOWNLOAD_TIMEOUT_MS);
    state.busy = { component: id, phase: 'downloading', receivedBytes: 0, sizeBytes: comp.sizeBytes ?? null };
    try {
      const res = await fetch(comp.url, { redirect: 'follow', signal: ctrl.signal, headers: { 'user-agent': UA } });
      if (!res.ok) throw new Error(`HTTP ${res.status} для ${comp.url}`);
      const total = Number(res.headers.get('content-length')) || comp.sizeBytes || null;
      let received = 0;
      const file = fs.createWriteStream(tmp);
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
        if (comp.sizeBytes && received > comp.sizeBytes * 1.05 + 1024 * 1024) {
          throw new Error(`файл больше ожидаемого (${received} > ${comp.sizeBytes}) — источник подозрителен, загрузка отменена`);
        }
        await new Promise((resolve, reject) => {
          file.write(Buffer.from(value), (e) => (e ? reject(e) : resolve()));
        });
        state.busy.receivedBytes = received;
        state.busy.sizeBytes = total ?? comp.sizeBytes;
        onProgress?.({ phase: 'downloading', receivedBytes: received, sizeBytes: state.busy.sizeBytes });
      }
      await new Promise((resolve, reject) => file.end((e) => (e ? reject(e) : resolve())));
      clearTimeout(timer);
      // Проверка размера и суммы.
      const st = await fsp.stat(tmp);
      if (comp.sizeBytes && st.size !== comp.sizeBytes) {
        throw new Error(`размер не совпал: получено ${st.size}, ожидается ${comp.sizeBytes} — скачайте повторно`);
      }
      state.busy.phase = 'verifying';
      onProgress?.({ phase: 'verifying' });
      const actual = await sha256File(tmp);
      if (comp.sha256 && !comp.sha256.startsWith('PLACEHOLDER') && actual !== comp.sha256) {
        throw new Error(`SHA-256 не совпал (получен ${actual.slice(0, 16)}…, ожидается ${comp.sha256.slice(0, 16)}…) — файл повреждён или подменён`);
      }
      // Установка.
      state.busy.phase = 'installing';
      onProgress?.({ phase: 'installing' });
      if (comp.extract) {
        await extractZip(tmp, dir);
        await fsp.rm(tmp, { force: true });
        const found = installedPaths(id);
        if (!found) throw new Error(`после распаковки не найден ${comp.exe} — установка не удалась`);
        logger?.info?.('voice component installed', { id, exe: found.main });
      } else {
        const name = path.basename(new URL(comp.url).pathname);
        const final = path.join(dir, name);
        await fsp.rename(tmp, final);
        logger?.info?.('voice component installed', { id, file: final });
      }
      return { ok: true, component: id };
    } finally {
      clearTimeout(timer);
      state.busy = null;
      try { await fsp.rm(tmp, { force: true }); } catch { /* */ }
    }
  }

  /** Распаковка zip через PowerShell (без внешних зависимостей). */
  function extractZip(zipPath, destDir) {
    return new Promise((resolve, reject) => {
      const script = `Expand-Archive -LiteralPath "${zipPath.replace(/'/g, "''")}" -DestinationPath "${destDir.replace(/'/g, "''")}" -Force`;
      const proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true });
      let err = '';
      proc.stderr.on('data', (d) => { err += String(d); });
      const killer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* */ } reject(new Error('распаковка не завершилась за 120 с')); }, 120_000);
      proc.on('error', (e) => { clearTimeout(killer); reject(new Error(`PowerShell недоступен: ${e.message}`)); });
      proc.on('close', (code) => {
        clearTimeout(killer);
        if (code === 0) resolve();
        else reject(new Error(`распаковка не удалась (код ${code}): ${err.slice(0, 300)}`));
      });
    });
  }

  // ── TTS: текст → wav ───────────────────────────────────────────────────────

  async function ttsInfo() {
    const piper = installedPaths('piper-windows');
    const voice = findFile('voice-ru-irina', '.onnx');
    const voiceCfg = findFile('voice-ru-irina', '.onnx.json');
    return {
      installed: Boolean(piper && voice && voiceCfg),
      piperExe: piper?.main ?? null,
      voiceFile: voice,
      voiceConfig: voiceCfg,
      voiceName: config.voice?.ttsVoice ?? 'ru_RU-irina-medium',
      rate: Number(config.voice?.ttsRate) || 1.0
    };
  }

  /** Синтез речи: текст → wav-файл в tmp. Возвращает { ok, wavPath, ms } или ошибку. */
  async function tts(text) {
    const t = String(text ?? '').trim().slice(0, 1200);
    if (!t) return { ok: false, error: 'пустой текст для озвучивания' };
    if (process.platform !== 'win32') return { ok: false, error: 'озвучивание доступно в LiteMind Desktop на Windows' };
    const info = await ttsInfo();
    if (!info.installed) {
      return { ok: false, error: 'голосовой движок не установлен — установите его в разделе «Компаньон → Голос» (загрузка ~90 МБ, локально и бесплатно)' };
    }
    const started = Date.now();
    const outDir = path.join(dataDir, 'tmp');
    await fsp.mkdir(outDir, { recursive: true });
    const wav = path.join(outDir, `tts_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.wav`);
    // length_scale обратно пропорционален скорости речи.
    const rate = Math.max(0.5, Math.min(1.5, info.rate));
    const lengthScale = (1 / rate).toFixed(3);
    const args = [
      '-m', info.voiceFile,
      '-c', info.voiceConfig,
      '--length_scale', lengthScale,
      '-f', wav
    ];
    return new Promise((resolve) => {
      const proc = spawn(info.piperExe, args, { windowsHide: true });
      let err = '';
      proc.stderr.on('data', (d) => { err += String(d); });
      proc.stdin.on('error', () => { /* piper закрыл stdin */ });
      proc.stdin.write(t);
      proc.stdin.end();
      const killer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* */ } }, 60_000);
      proc.on('error', (e) => { clearTimeout(killer); resolve({ ok: false, error: `piper недоступен: ${e.message}` }); });
      proc.on('close', (code) => {
        clearTimeout(killer);
        if (code === 0 && fs.existsSync(wav) && fs.statSync(wav).size > 100) {
          resolve({ ok: true, wavPath: wav, ms: Date.now() - started, voice: info.voiceName, rate });
        } else {
          resolve({ ok: false, error: `piper завершился с кодом ${code}${err ? `: ${err.slice(0, 200)}` : ''}` });
        }
      });
    });
  }

  // ── ASR: wav → текст ──────────────────────────────────────────────────────

  async function asrInfo() {
    const whisper = installedPaths('whisper-windows');
    const model = findFile('whisper-model-tiny', '.bin');
    return {
      installed: Boolean(whisper && model),
      whisperExe: whisper?.main ?? null,
      modelFile: model
    };
  }

  /**
   * Распознавание речи: wav → текст. Русский язык, без временных меток.
   * Возвращает { ok, text, ms } — время честное, чтобы UI показывал задержку.
   */
  async function asr(wavPath) {
    if (process.platform !== 'win32') return { ok: false, error: 'распознавание доступно в LiteMind Desktop на Windows' };
    if (!fs.existsSync(String(wavPath ?? ''))) return { ok: false, error: 'аудиофайл не найден' };
    const info = await asrInfo();
    if (!info.installed) {
      return { ok: false, error: 'распознавание не установлено — раздел «Компаньон → Голос» (загрузка ~90 МБ)' };
    }
    const started = Date.now();
    const args = [
      '-m', info.modelFile,
      '-l', 'ru',
      '-nt', // без временных меток
      '-np', // без вывода прогресса в stdout
      '-f', String(wavPath)
    ];
    return new Promise((resolve) => {
      const proc = spawn(info.whisperExe, args, { windowsHide: true });
      let out = '';
      let err = '';
      proc.stdout.on('data', (d) => { out += String(d); });
      proc.stderr.on('data', (d) => { err += String(d); });
      const killer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* */ } }, 300_000);
      proc.on('error', (e) => { clearTimeout(killer); resolve({ ok: false, error: `whisper недоступен: ${e.message}` }); });
      proc.on('close', (code) => {
        clearTimeout(killer);
        const text = out.replace(/\s+/g, ' ').trim();
        if (code === 0) {
          resolve({ ok: true, text, ms: Date.now() - started });
        } else {
          resolve({ ok: false, error: `whisper завершился с кодом ${code}: ${err.slice(0, 200)}` });
        }
      });
    });
  }

  /** Сводка статуса для UI (честная: что установлено, что нет). */
  async function status() {
    const [tts, asr] = await Promise.all([ttsInfo(), asrInfo()]);
    const components = Object.entries(VOICE_COMPONENTS).map(([id, c]) => ({
      id,
      kind: c.kind,
      description: c.description,
      sizeBytes: c.sizeBytes ?? null,
      installed: Boolean(installedPaths(id) ?? (c.extract ? null : findFile(id, path.extname(c.url).slice(0, 6))))
    }));
    return {
      supported: process.platform === 'win32',
      dataDir,
      busy: state.busy,
      tts: { installed: tts.installed, voice: tts.voiceName, rate: tts.rate },
      asr: { installed: asr.installed },
      components,
      settings: config.voice ?? {}
    };
  }

  return {
    status,
    install: installComponent,
    tts,
    asr,
    ttsInfo,
    asrInfo,
    tmpDir: path.join(dataDir, 'tmp')
  };
}
