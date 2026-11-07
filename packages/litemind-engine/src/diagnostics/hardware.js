// Hardware Analysis — CPU, RAM, AVX/AVX2, диски, итоговый рейтинг совместимости.
//
// Методы определения AVX/AVX2 (по убыванию точности):
//  1. Linux: флаги из /proc/cpuinfo — точное значение.
//  2. Windows: PowerShell 7 (pwsh) [System.Runtime.Intrinsics.X86...] — точное,
//     если pwsh установлен (у большинства пользователей его нет).
//  3. Windows fallback: таблица известных CPU-моделей без AVX
//     (Tremont/Goldmont/Gracemont-ядра: Jasper Lake, Alder Lake-N, Gemini Lake и т.п.).
//     Для Intel N5095A даёт правильный ответ «без AVX».
//  4. Неизвестно → `null` (не выдумываем ответ).
//
// Рейтинг используется каталогом и движком для зелёного/жёлтого/красного статуса.
import os from 'node:os';
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import path from 'node:path';

/** Известные Intel-модели на ядрах без AVX (семейство Tremont и старше). */
const INTEL_NO_AVX_MARKERS = [
  'n5095', 'n5105', 'n5095a', 'n4500', 'n4020', 'n4120', 'n6000', 'n97', 'n100', 'n150', 'n95',
  'j4125', 'j4105', 'j3455', 'n3060', 'n3350', 'n4200', 'x5-z8350', 'x7-z8700', 'z3735', 'z8350'
];

const AVX_CAPABLE_PREFIXES = ['ryzen', 'core i3', 'core i5', 'core i7', 'core i9', 'xeon', 'threadripper'];

function cpuModel() {
  try {
    const cpus = os.cpus();
    return cpus[0]?.model?.trim() ?? '';
  } catch {
    return '';
  }
}

function cores() {
  try { return os.cpus().length; } catch { return 0; }
}

function totalRamMb() {
  return Math.round(os.totalmem() / (1024 * 1024));
}

/** AVX-флаги. Возвращает { avx: boolean|null, avx2: boolean|null, method: string }. */
export async function detectAvx() {
  if (process.platform === 'linux') {
    try {
      const info = fs.readFileSync('/proc/cpuinfo', 'utf8');
      const flags = info.split('\n').find((l) => l.startsWith('flags')) ?? '';
      return {
        avx: flags.includes(' avx ') || flags.includes('avx '),
        avx2: flags.includes(' avx2'),
        method: '/proc/cpuinfo'
      };
    } catch {
      /* fallthrough */
    }
  }

  // Windows с PowerShell 7: точное определение через .NET intrinsics.
  if (process.platform === 'win32') {
    const pwsh = await detectAvxViaPwsh();
    if (pwsh) return pwsh;
  }

  // Эвристика по модели CPU.
  const model = cpuModel().toLowerCase();
  if (INTEL_NO_AVX_MARKERS.some((m) => model.includes(m))) {
    return { avx: false, avx2: false, method: 'cpu-model-heuristic' };
  }
  if (AVX_CAPABLE_PREFIXES.some((p) => model.includes(p))) {
    return { avx: true, avx2: true, method: 'cpu-model-heuristic' };
  }
  return { avx: null, avx2: null, method: 'unknown' };
}

function detectAvxViaPwsh() {
  return new Promise((resolve) => {
    // pwsh (PowerShell 7, .NET Core) умеет Runtime Intrinsics; Windows PowerShell 5.1 — нет.
    execFile(
      'pwsh',
      ['-NoProfile', '-NonInteractive', '-Command',
        '"AVX=" + [System.Runtime.Intrinsics.X86.Avx]::IsSupported + ";AVX2=" + [System.Runtime.Intrinsics.X86.Avx2]::IsSupported'],
      { timeout: 5000, windowsHide: true },
      (err, stdout) => {
        if (err || !stdout) return resolve(null);
        const avx = /AVX=(True|False)/i.exec(stdout)?.[1]?.toLowerCase() === 'true' || null;
        const avx2 = /AVX2=(True|False)/i.exec(stdout)?.[1]?.toLowerCase() === 'true' || null;
        if (avx === null && avx2 === null) return resolve(null);
        resolve({ avx, avx2, method: 'pwsh-runtime-intrinsics' });
      }
    );
  });
}

/** Свободное место на дисках-кандидатах (Windows: C:, D:, E:, F:; иначе /). */
export async function diskReport(candidateRoots) {
  const roots = candidateRoots ?? (process.platform === 'win32' ? ['C:\\', 'D:\\', 'E:\\', 'F:\\'] : ['/']);
  const out = [];
  for (const root of roots) {
    try {
      const st = fs.statfsSync(root);
      out.push({
        root: path.parse(root).root || root,
        exists: true,
        freeBytes: st.bsize * st.bfree,
        totalBytes: st.bsize * st.blocks
      });
    } catch {
      out.push({ root: path.parse(root).root || root, exists: false, freeBytes: null, totalBytes: null });
    }
  }
  return out;
}

/**
 * Рекомендация профиля и лимитов под железо.
 * Главная целевая конфигурация: Celeron N5095A (без AVX/AVX2), 16 ГБ RAM, UHD Graphics.
 */
export function recommend(hardware) {
  const { totalRamMb, avx } = hardware;
  const gb = totalRamMb / 1024;

  const profile = gb >= 15 ? 'balanced' : 'low';

  // Windows резервируем минимум 2 ГБ; чем меньше RAM, тем больше запас.
  const windowsReserveMb = gb >= 15 ? 2048 : 1536;
  const usableMb = Math.max(0, totalRamMb - windowsReserveMb);

  return {
    profile,
    windowsReserveMb,
    usableModelRamMb: usableMb,
    cpuThreads: Math.max(2, Math.min(4, cores() - 1)), // N5095A: 4C → 3 потока (1 ядро системе)
    maxContextTokens: gb >= 15 ? 4096 : 2048,
    avxNote: avx === false
      ? 'CPU без AVX/AVX2: работает, но медленнее; каталог выбирает только совместимые сборки.'
      : avx === true
        ? 'AVX/AVX2 доступны — генерация быстрее.'
        : 'Не удалось точно определить AVX; используется консервативный выбор.'
  };
}

/** GPU (best-effort). Windows: Win32_VideoController через PowerShell. */
export function detectGpu() {
  if (process.platform !== 'win32') return null;
  return new Promise((resolve) => {
    execFile(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command',
        'Get-CimInstance Win32_VideoController | Select-Object -First 1 Name,AdapterRAM | ConvertTo-Json -Compress'],
      { timeout: 6000, windowsHide: true },
      (err, stdout) => {
        if (err || !stdout) return resolve(null);
        try {
          const d = JSON.parse(stdout);
          const vram = Number(d.AdapterRAM);
          resolve({
            model: d.Name ?? null,
            // AdapterRAM — uint32 в старых системах: >4 ГБ может показать неверно.
            vramMb: Number.isFinite(vram) && vram > 0 ? Math.round(vram / (1024 * 1024)) : null,
            note: 'CPU-инференс без AVX: GPU используется только для вывода, не для вычислений.'
          });
        } catch {
          resolve(null);
        }
      }
    );
  });
}

/** Температура CPU (best-effort). Linux: /sys/class/hwmon. Windows: обычно недоступна без драйверов. */
export function readCpuTemperature() {
  if (process.platform !== 'linux') return Promise.resolve({ cpuC: null, source: 'unavailable' });
  return (async () => {
    try {
      const zones = fs.readdirSync('/sys/class/hwmon');
      for (const z of zones) {
        const base = `/sys/class/hwmon/${z}`;
        const name = fs.readFileSync(`${base}/name`, 'utf8').trim();
        if (!/coretemp|k10temp|cpu_thermal/.test(name)) continue;
        const t0 = fs.readFileSync(`${base}/temp1_input`, 'utf8').trim();
        const c = Number(t0) / 1000;
        if (Number.isFinite(c) && c > 0 && c < 150) return { cpuC: Math.round(c * 10) / 10, source: `hwmon/${name}` };
      }
    } catch {
      /* нет датчиков */
    }
    return { cpuC: null, source: 'unavailable' };
  })();
}

export async function analyzeHardware({ candidateRoots = null } = {}) {
  const avxInfo = await detectAvx();
  const totalRam = totalRamMb();
  const hardware = {
    platform: process.platform,
    cpu: {
      model: cpuModel(),
      cores: cores(),
      avx: avxInfo.avx,
      avx2: avxInfo.avx2,
      avxMethod: avxInfo.method
    },
    totalRamMb: totalRam,
    freeRamMb: Math.round(os.freemem() / (1024 * 1024)),
    node: process.version,
    disks: await diskReport(candidateRoots),
    generatedAt: new Date().toISOString()
  };
  hardware.recommendation = recommend(hardware);
  hardware.gpu = await detectGpu();
  hardware.temperature = await readCpuTemperature();
  return hardware;
}
