// Управление приоритетом процесса инференса (ТЗ §4: «управлять приоритетом процесса»).
//
// Профиль «Бережный» (low) понижает приоритет процессов Ollama — Windows остаётся
// отзывчивой даже во время генерации. «Сбалансированный»/«Производительный»
// возвращают обычный приоритет. Вызов best-effort: любая ошибка игнорируется.
import { execFile } from 'node:child_process';

const WIN_PRIORITY = { low: 'BelowNormal', balanced: 'Normal', high: 'Normal' };

function winCommand(priority) {
  const ps =
    `Get-Process -Name ollama,ollama_llama_server -ErrorAction SilentlyContinue | ` +
    `ForEach-Object { try { $_.PriorityClass = '${priority}' } catch {} }`;
  return process.platform === 'win32' ? ps : null;
}

export function applyBackendPriority({ profile, log = null } = {}) {
  const priority = WIN_PRIORITY[profile];
  if (!priority) return;
  try {
    if (process.platform === 'win32') {
      const cmd = winCommand(priority);
      execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', cmd], { timeout: 8000, windowsHide: true },
        (err) => { if (err) log?.debug?.('priority apply failed', { error: err.message }); });
    } else {
      const nice = profile === 'low' ? 10 : 0;
      execFile('sh', ['-c', `pgrep -f 'ollama' | xargs -r renice -n ${nice} -p`], { timeout: 5000 },
        () => {});
    }
    log?.info?.('backend priority applied', { profile, priority });
  } catch {
    /* приоритет — необязательная оптимизация */
  }
}
