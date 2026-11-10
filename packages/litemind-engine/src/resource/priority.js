// Управление приоритетом процесса инференса (Этап 2 §4/§11).
//
// Профиль «Бережный» (low) понижает приоритет llama-server — Windows остаётся
// отзывчивой даже во время генерации. «Сбалансированный»/«Производительный»
// держат обычный приоритет. Вызовы best-effort: любая ошибка игнорируется.
//
// Этап 2: приоритет применяется ПО PID сразу после запуска процесса (раньше —
// по имени процесса после переключения профиля, что затрагивало чужие процессы
// с тем же именем и не срабатывало после рестарта сервера). Поиск по имени
// сохранён только для «усыновлённых» серверов, где PID неизвестен.
import { execFile } from 'node:child_process';

const WIN_PRIORITY = { low: 'BelowNormal', balanced: 'Normal', high: 'Normal' };
const NICE = { low: 10, balanced: 0, high: 0 };

/** Применить приоритет к конкретному PID (наш собственный llama-server). */
export function applyPriorityToPid(pid, profile, log = null) {
  if (!pid || !Number.isFinite(Number(pid))) return;
  try {
    if (process.platform === 'win32') {
      const priority = WIN_PRIORITY[profile] ?? 'Normal';
      const ps =
        `try { (Get-Process -Id ${Number(pid)} -ErrorAction Stop).PriorityClass = '${priority}' } catch {}`;
      execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps],
        { timeout: 8000, windowsHide: true },
        (err) => { if (err) log?.debug?.('priority(pid) apply failed', { pid, error: err.message }); });
    } else {
      const nice = NICE[profile] ?? 0;
      if (!nice) return; // normal — ничего делать не надо
      execFile('renice', ['-n', String(nice), '-p', String(pid)], { timeout: 5000 }, () => {});
    }
    log?.info?.('backend priority applied by pid', { pid, profile });
  } catch {
    /* приоритет — необязательная оптимизация */
  }
}

/** Применить приоритет по имени процесса (усыновлённые серверы, PID неизвестен). */
export function applyBackendPriority({ profile, log = null } = {}) {
  const priority = WIN_PRIORITY[profile];
  if (!priority) return;
  try {
    if (process.platform === 'win32') {
      const ps =
        `Get-Process -Name llama-server,ollama,ollama_llama_server -ErrorAction SilentlyContinue | ` +
        `ForEach-Object { try { $_.PriorityClass = '${priority}' } catch {} }`;
      execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { timeout: 8000, windowsHide: true },
        (err) => { if (err) log?.debug?.('priority apply failed', { error: err.message }); });
    } else {
      const nice = NICE[profile] ?? 0;
      if (!nice) return;
      execFile('sh', ['-c', `pgrep -f 'llama-server|ollama' | xargs -r renice -n ${nice} -p`], { timeout: 5000 },
        () => {});
    }
    log?.info?.('backend priority applied', { profile, priority });
  } catch {
    /* приоритет — необязательная оптимизация */
  }
}
