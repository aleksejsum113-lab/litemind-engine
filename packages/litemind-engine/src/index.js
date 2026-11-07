// Programmatic entry point — используется LiteMind Desktop (Electron main),
// чтобы поднимать движок внутри приложения без отдельного терминала (ТЗ §5:
// «запуск приложения без необходимости открывать терминал»).
import { loadConfig, defaultConfigPath } from './config.js';
import { createBackend } from './backends/registry.js';
import { Engine } from './core/engine.js';
import { MetricsSampler } from './resource/metrics.js';
import { Logger, PerfRecorder } from './diagnostics/log.js';
import { createServer } from './api/server.js';

/**
 * Запустить движок (API 127.0.0.1:8399 + адаптивный контроллер + менеджер моделей).
 * @returns {{ config, engine, logger, sampler, server, stop: () => Promise<void> }}
 */
export async function startLiteMindEngine({ host = null, port = null, console: logToConsole = false } = {}) {
  const config = loadConfig(defaultConfigPath());
  if (host) config.api.host = host;
  if (port) config.api.port = port;

  const logger = new Logger({ dir: config.diagnostics.dir, level: config.diagnostics.level, console: logToConsole });
  const sampler = new MetricsSampler({ intervalMs: config.resource.pollIntervalMs });
  const perf = new PerfRecorder();
  const backend = createBackend(config);
  const engine = new Engine({ config, backend, sampler, logger, perf });

  const server = createServer({ config, engine, logger });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.api.port, config.api.host, () => resolve());
  });
  await engine.start();
  logger.info('engine started', { url: `http://${config.api.host}:${config.api.port}` });

  return {
    config,
    engine,
    logger,
    sampler,
    server,
    stop: async () => {
      engine.shutdown();
      await new Promise((r) => server.close(r));
      sampler.stop?.();
      logger.stop?.();
    }
  };
}

export { defaultConfigPath, loadConfig };
