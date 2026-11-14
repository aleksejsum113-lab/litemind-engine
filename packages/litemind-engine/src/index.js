// Programmatic entry point — используется LiteMind Desktop (Electron main),
// чтобы поднимать движок внутри приложения без отдельного терминала (ТЗ §5:
// «запуск приложения без необходимости открывать терминал»).
import path from 'node:path';
import { loadConfig, defaultConfigPath, saveConfig } from './config.js';
import { createBackend } from './backends/registry.js';
import { Engine } from './core/engine.js';
import { MetricsSampler } from './resource/metrics.js';
import { Logger, PerfRecorder } from './diagnostics/log.js';
import { createServer } from './api/server.js';
import { DownloadManager } from './download/manager.js';
import { rememberModelsRoot } from './install/registry.js';
import { MemoryStore } from './memory/store.js';
import { TaskStore } from './tasks/store.js';
import { CompanionHub } from './companion/companion.js';
import { createVoiceManager } from './voice/voice.js';
import { createIntelligenceLayer } from './intelligence/layer.js';
import { createWebContext } from './web/fetcher.js';

/**
 * Запустить движок (API 127.0.0.1:8399 + адаптивный контроллер + менеджер моделей
 * + память + задачи + компаньон + голос + Intelligence Layer).
 * @param {{ host?: string|null, port?: number|null, console?: boolean }} [opts]
 * @returns {Promise<{ config: object, engine: object, logger: object, sampler: object, server: object, downloads: object,
 *   memory: object, tasks: object, companion: object, voice: object, intelligence: object,
 *   stop: () => Promise<object> }>}
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

  // ── v0.6.4: службы компаньона (все данные — рядом с config.json, локально) ──
  const dataDir = path.dirname(config.paths.configPath);
  const memory = new MemoryStore(path.join(dataDir, 'memory'), { logger });
  const companion = new CompanionHub({ config, logger });
  const tasks = new TaskStore(path.join(dataDir, 'tasks'), {
    logger,
    onDue: async (task) => {
      // Срабатывание напоминания: журнал компаньона + честный текст.
      companion.event('reminder', `Напоминание: ${task.text}`);
      companion.setState('speaking', `напоминание: ${task.text.slice(0, 80)}`);
      setTimeout(() => { if (companion.state === 'speaking') companion.setState('idle'); }, 8000);
      // Озвучивание — если голос установлен и разрешён (см. voice/tts-эндпоинт,
      // сам wav проигрывает Desktop через /api/voice/tts при получении события).
    }
  });
  const voice = createVoiceManager({ config, logger, companion });
  const webCtx = createWebContext(config);
  const intelligence = createIntelligenceLayer({ config, engine, logger, memory, tasks, web: { enabled: () => config.web?.enabled === true, fetchText: (u) => webCtx.fetchText(u), fetchImpl: fetch }, host: null });

  const server = createServer({ config, engine, logger, downloads, memory, tasks, companion, voice, intelligence });
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
    memory,
    tasks,
    companion,
    voice,
    intelligence,
    /** Подключить мост к Desktop (скриншот, UIA, открытие приложений, уведомления). */
    setHostBridge: (bridge) => {
      intelligence.setHost(bridge);
      logger.info('host bridge connected', { features: bridge ? Object.keys(bridge) : [] });
    },
    /** Сохранить конфиг (Desktop вызывает при смене настроек компаньона/голоса). */
    saveConfig: () => saveConfig(config, config.paths.configPath),
    /**
     * Полная остановка (ТЗ §16.3/§16.4): отменяет генерации и загрузки,
     * выгружает модели из RAM/VRAM, закрывает сервер. Идемпотентна.
     */
    stop: async () => {
      if (stopped) return engine.lifecycle;
      stopped = true;
      tasks.stop();
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
