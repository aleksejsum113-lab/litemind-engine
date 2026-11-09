// Windows-реестр: деинсталлятор спрашивает, удалить ли загруженные модели.
// Движок сообщает фактическую папку моделей в HKCU\Software\LiteMind
// (best-effort: на других ОС и при отказе реестра — тихо игнорируется).
import { execFile } from 'node:child_process';

export function rememberModelsRoot(rootDir) {
  if (process.platform !== 'win32' || !rootDir) return false;
  try {
    execFile(
      'reg',
      ['add', 'HKCU\\Software\\LiteMind', '/v', 'ModelsRootDir', '/t', 'REG_SZ', '/d', String(rootDir), '/f'],
      { timeout: 5000, windowsHide: true },
      () => {} // необязательная операция
    );
    return true;
  } catch {
    return false;
  }
}
