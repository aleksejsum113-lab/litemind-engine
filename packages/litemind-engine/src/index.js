// Programmatic entry point — используется LiteMind Desktop (Electron main),
// чтобы поднимать движок внутри приложения без отдельного терминала (ТЗ §5:
// «запуск приложения без необходимости открывать терминал»).
import { loadConfig, defaultConfigPath } from './config.js';
import { createBackend } from './backends/registry.js';
import { Engine } from './core/engine.js';
import { MetricsSampler } from './resource/metrics.js';
import { Logger, PerfRecorder } from './diagnostics/log.js';
import { createServer } from './api/server.js';
import { DownloadManager } from './download/manager.js';
import { rememberModelsRoot } from './install/registry.js';

/**
 * Запустить движок (API 127.0.0.1:8399 + адаптивный контроллер + менеджер моделей).
 * @param {{ host?: string|null, port?: number|null, console?: boolean }} [opts]
 * @returns {Promise<{ config: object, engine: object, logger: object, sampler: object, server: object, downloads: object, stop: () => Promise<object> }>}
 */
export async function startLiteMindEngine({ host = null, port = null, console: logToConsole = false } = {}) {
  const config = loadConfig(defaultConfigPath());
  if (host) config.api.host = host;
  if (port) config.api.port = port;

  // Windows: сообщаем деинсталлятору, где лежат модели (HKCU\Software\LiteMind).
  rememberModelsRoot(config.models.rootDir);

  const logger = new Logger({ dir: config.diagnostics.dir, level: config.diagnostics.level, console: logToConsole });
  const sampler = new MetricsSampler({ intervalMs: config.resource.pollIntervalMs });
  const perf = new PerfRecorder();
  const backend = createBackend(config);
  const engine = new Engine({ config, backend, sampler, logger, perf });
  const downloads = new DownloadManager({ onEvent: (e) => logger.info('download', { ...e }) });

  const server = createServer({ config, engine, logger, downloads });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.api.port, config.api.host, () => resolve());
  });
  await engine.start();
  logger.info('engine started', { url: `http://${config.api.host}:${config.api.port}` });

  let stopped = false;
  return {
    config,
    engine,
    logger,
    sampler,
    server,
    downloads,
    /**
     * Полная остановка (ТЗ §16.3/§16.4): отменяет генерации и загрузки,
     * выгружает модели из RAM/VRAM, закрывает сервер. Идемпотентна.
     */
    stop: async () => {
      if (stopped) return engine.lifecycle;
      stopped = true;
      try {
        engine.beginStop();
        await downloads.cancelAll();
        await engine.stopAllModels();
      } catch (err) {
        logger.warn('stop sequence error', { error: err.message });
      }
      await engine.shutdownFull();
      await new Promise((r) => server.close(r));
      server.closeAllConnections?.();
      logger.stop?.();
      return engine.lifecycle;
    }
  };
}

export { defaultConfigPath, loadConfig };
