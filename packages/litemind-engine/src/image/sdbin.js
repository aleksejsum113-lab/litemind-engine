// Image Backend locator — где лежит stable-diffusion.cpp (sd / sd.exe).
//
// Порядок поиска (как у llama-server в backends/lmlama.js):
//   1. env LITEMIND_SD_BIN (полный путь к бинарнику);
//   2. config.image.sdPath (Настройки);
//   3. <установка>\resources\sd\sd(.exe) — extraResources установщика
//      (внутри Electron process.resourcesPath = <установка>\resources);
//   4. каталог пакета: …/src/image/../../resources/sd — монорепо/дистрибутивы;
//   5. PATH.
//
// Никаких сторонних сервисов и портов: sd запускается как CLI-процесс
// на одну генерацию, порт не занимает (ТЗ v0.6.1 §3).

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const IS_WIN = process.platform === 'win32';
const EXE = IS_WIN ? 'sd.exe' : 'sd';
// Каталог resources/ в запущенном приложении (…/resources/sd/sd.exe).
const RESOURCES_SD = path.join(
  path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'resources', 'sd'
);

export function sdCandidates(configImage = null) {
  const list = [];
  if (process.env.LITEMIND_SD_BIN) list.push(process.env.LITEMIND_SD_BIN);
  if (configImage?.sdPath) list.push(configImage.sdPath);
  // Внутри Electron process.resourcesPath = <установка>\resources — именно там
  // NSIS кладёт extraResources\sd (smoke v0.6.2: без этого кандидата
  // /api/image/status отвечал found=false, хотя sd.exe установлен).
  if (process.resourcesPath) list.push(path.join(process.resourcesPath, 'sd', EXE));
  list.push(path.join(RESOURCES_SD, EXE));
  list.push(EXE); // PATH
  return list;
}

/** Найденный бинарник или null. */
export function findSdBinary(configImage = null) {
  for (const cand of sdCandidates(configImage)) {
    if (!cand) continue;
    if (cand === EXE) {
      // Поиск в PATH без внешних процессов.
      for (const dir of (process.env.PATH || '').split(path.delimiter)) {
        if (!dir) continue;
        const p = path.join(dir, EXE);
        try { if (fs.existsSync(p)) return p; } catch { /* пропускаем */ }
      }
      continue;
    }
    try { if (fs.existsSync(cand)) return cand; } catch { /* пропускаем */ }
  }
  return null;
}

/**
 * Короткая проба бинарника: `sd --version` (до 5 с). Возвращает строку версии
 * или null — честный признак «бинарник не запускается» (например, собран
 * под AVX на машине без AVX).
 */
export async function sdVersion(bin) {
  if (!bin) return null;
  return await new Promise((resolve) => {
    let out = '';
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; clearTimeout(t); resolve(v); } };
    let proc;
    try {
      proc = spawn(bin, ['--version'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch { return done(null); }
    const t = setTimeout(() => { try { proc.kill('SIGKILL'); } catch { } done(null); }, 5000);
    proc.stdout?.on('data', (d) => { out += d.toString(); });
    proc.stderr?.on('data', (d) => { out += d.toString(); });
    proc.on('error', () => done(null));
    proc.on('close', (code) => done(code === 0 && out.trim() ? out.trim().split('\n')[0].slice(0, 120) : null));
  });
}
