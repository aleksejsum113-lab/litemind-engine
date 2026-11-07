// Resource Manager — RAM / CPU / VRAM monitoring.
// Windows: one PowerShell CIM call. Other platforms: /proc (dev/test fallback).
// This module NEVER touches foreign processes: it only observes.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

const PS_SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
$os = Get-CimInstance Win32_OperatingSystem
$cpu = Get-CimInstance Win32_Processor | Select-Object -First 1
$vramTotal = 0
$gpus = @(Get-CimInstance Win32_VideoController)
foreach ($g in $gpus) { if ($g.AdapterRAM) { $vramTotal += [double]$g.AdapterRAM } }
$totalMb = [math]::Round($os.TotalVisibleMemorySize / 1KB, 1)
$freeMb = [math]::Round($os.FreePhysicalMemory / 1KB, 1)
$load = 0
if ($cpu -and $cpu.LoadPercentage -ne $null) { $load = [double]$cpu.LoadPercentage }
@{
  totalRamMb = $totalMb
  usedRamMb = [math]::Round($totalMb - $freeMb, 1)
  availableRamMb = $freeMb
  cpuPercent = $load
  vramTotalMb = [math]::Round($vramTotal / 1MB, 1)
  gpuNames = @($gpus | ForEach-Object { $_.Name })
} | ConvertTo-Json -Compress
`;

function parseProcMeminfo() {
  const text = fs.readFileSync('/proc/meminfo', 'utf8');
  const get = (key) => {
    const m = text.match(new RegExp(`^${key}:\\s+(\\d+)\\s*kB`, 'm'));
    return m ? Number(m[1]) * 1024 : null;
  };
  const total = get('MemTotal');
  const avail = get('MemAvailable') ?? get('MemFree');
  if (total == null || avail == null) return null;
  const totalMb = Math.round((total / 1048576) * 10) / 10;
  const availMb = Math.round((avail / 1048576) * 10) / 10;
  return { totalRamMb: totalMb, availableRamMb: availMb, usedRamMb: Math.round((totalMb - availMb) * 10) / 10 };
}

function parseLoadavg() {
  try {
    const [one] = fs.readFileSync('/proc/loadavg', 'utf8').split(' ');
    const cores = os.cpus().length || 1;
    return Math.min(100, Math.round((Number(one) / cores) * 100));
  } catch {
    return 0;
  }
}

/** Snapshot of machine load. Returns null-safe fields; vram may be unknown. */
export async function collectMetrics() {
  if (process.platform === 'win32') {
    try {
      const { stdout } = await execFileP(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', PS_SCRIPT],
        { timeout: 8000, maxBuffer: 1024 * 1024, windowsHide: true }
      );
      const data = JSON.parse(stdout);
      return {
        totalRamMb: Number(data.totalRamMb) || 0,
        usedRamMb: Number(data.usedRamMb) || 0,
        availableRamMb: Number(data.availableRamMb) || 0,
        cpuPercent: Number(data.cpuPercent) || 0,
        vramTotalMb: data.vramTotalMb > 0 ? Number(data.vramTotalMb) : null,
        gpuNames: Array.isArray(data.gpuNames) ? data.gpuNames : [],
        source: 'windows-cim',
        at: Date.now()
      };
    } catch (err) {
      return {
        ...osFallback(),
        error: `metrics collection failed: ${err.message}`,
        source: 'fallback',
        at: Date.now()
      };
    }
  }
  return { ...osFallback(), source: 'procfs', at: Date.now() };
}

function osFallback() {
  const mem = parseProcMeminfo() || {
    totalRamMb: Math.round(os.totalmem() / 1048576),
    availableRamMb: Math.round(os.freemem() / 1048576),
    usedRamMb: Math.round((os.totalmem() - os.freemem()) / 1048576)
  };
  return {
    ...mem,
    cpuPercent: parseLoadavg(),
    vramTotalMb: null,
    gpuNames: [],
    platform: process.platform
  };
}

/**
 * Periodic sampler used by the dashboard / engine status.
 * stop() resolves; errors are recorded, never thrown.
 */
export class MetricsSampler {
  constructor({ intervalMs = 2000, provider = collectMetrics, onError = null } = {}) {
    this.intervalMs = intervalMs;
    this.provider = provider;
    this.onError = onError;
    this.latest = null;
    this.history = [];
    this.maxHistory = 180;
    this._timer = null;
    this._busy = false;
  }

  async sample() {
    try {
      this.latest = await this.provider();
      this.history.push({ at: this.latest.at, cpu: this.latest.cpuPercent, used: this.latest.usedRamMb, available: this.latest.availableRamMb });
      if (this.history.length > this.maxHistory) this.history.shift();
    } catch (err) {
      this.lastError = err.message;
      this.onError?.(err);
    }
    return this.latest;
  }

  start() {
    if (this._timer) return;
    this._timer = setInterval(() => {
      if (this._busy) return;
      this._busy = true;
      this.sample().finally(() => { this._busy = false; });
    }, this.intervalMs);
    this._timer.unref?.();
    this.sample();
    return this.latest;
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }
}
