#!/usr/bin/env node
// LiteMind Engine CLI: serve (default) | status | models | doctor | help
import { loadConfig, defaultConfigPath, saveConfig } from '../src/config.js';
import { createBackend } from '../src/backends/registry.js';
import { Engine } from '../src/core/engine.js';
import { MetricsSampler } from '../src/resource/metrics.js';
import { Logger, PerfRecorder } from '../src/diagnostics/log.js';
import { createServer } from '../src/api/server.js';

const HELP = `LiteMind Engine — лёгкий локальный движок управления ИИ-моделями

Использование:
  litemind serve [--port N] [--host H]   запустить сервер и панель управления
  litemind stop [--port N]               полная остановка запущенного движка (модели выгружаются из RAM/VRAM)
  litemind status                        состояние backend, очередь, память
  litemind models                        список локальных моделей
  litemind doctor                        диагностика установки
  litemind config                        показать путь к конфигурации

Конфигурация: ${defaultConfigPath()}
Бэкенд по умолчанию: Ollama (http://127.0.0.1:11434). Модели никогда не скачиваются автоматически.
`;

function build({ withServer = false } = {}) {
  const config = loadConfig();
  const logger = new Logger({ dir: config.diagnostics.dir, level: config.diagnostics.level, console: withServer });
  const sampler = new MetricsSampler({ intervalMs: config.resource.pollIntervalMs });
  const perf = new PerfRecorder();
  const backend = createBackend(config, { log: logger }); // v0.6.1: логи llama-server (spawn/health/exit) больше не теряются — в CI журнал был пуст именно из-за этого
  const engine = new Engine({ config, backend, sampler, logger, perf });
  return { config, logger, sampler, perf, backend, engine };
}

const [, , cmd = 'serve', ...args] = process.argv;
const flags = {};
for (let i = 0; i < args.length; i++) {
  if (args[i].startsWith('--')) {
    const key = args[i].slice(2);
    if (args[i + 1] && !args[i + 1].startsWith('--')) { flags[key] = args[++i]; }
    else flags[key] = true;
  }
}

async function main() {
  switch (cmd) {
    case 'help':
    case '--help':
    case '-h':
      process.stdout.write(HELP);
      return;

    case 'config':
      process.stdout.write(`config: ${defaultConfigPath()}\n`);
      return;

    case 'doctor': {
      const { config, engine, sampler, logger } = build();
      logger.stop?.();
      const health = await engine.start();
      const metrics = await sampler.sample();
      const lines = [
        `Node.js:        ${process.version} (${process.platform})`,
        `Конфиг:         ${config.paths.existed ? config.paths.configPath : `${config.paths.configPath} (файл ещё не создан, используются значения по умолчанию)`}`,
        `Профиль:        ${config.profile} (${engine.profile.label})`,
        `Backend:        ${config.backend.type} @ ${config.backend.baseUrl}`,
        `Состояние:      ${health.ok ? `онлайн (версия ${health.version})` : `НЕДОСТУПЕН — ${health.error}`}`,
        `RAM:            ${metrics?.usedRamMb ?? '?'} / ${metrics?.totalRamMb ?? '?'} MB (доступно ${metrics?.availableRamMb ?? '?'} MB)`,
        `CPU:            ${metrics?.cpuPercent ?? '?'} %`,
        `VRAM:           ${metrics?.vramTotalMb ? `≈ ${metrics.vramTotalMb} MB` : 'не определена'}`,
        `Модели:         ${health.ok ? (await engine.listModels()).map((m) => m.id).join(', ') || 'нет установленных' : '—'}`
      ];
      process.stdout.write(lines.join('\n') + '\n');
      process.exitCode = health.ok ? 0 : 1;
      engine.shutdown();
      return;
    }

    case 'status': {
      const { engine, sampler } = build();
      await engine.start();
      const s = await engine.status();
      await sampler.sample();
      process.stdout.write(JSON.stringify({ ...s, metrics: sampler.latest }, null, 2) + '\n');
      engine.shutdown();
      return;
    }

    case 'models': {
      const { engine } = build();
      await engine.start();
      if (!engine.health.ok) {
        process.stderr.write(`Backend недоступен: ${engine.health.error}\n`);
        process.exitCode = 1;
      } else {
        const models = await engine.listModels();
        process.stdout.write(models.length ? models.map((m) => `${m.id}${m.sizeBytes ? `  ${Math.round(m.sizeBytes / 1048576)} MB` : ''}`).join('\n') + '\n' : 'Модели не установлены.\n');
      }
      engine.shutdown();
      return;
    }

    case 'stop': {
      // ТЗ §16: команда полной остановки движка из терминала/скриптов.
      const port = flags.port ? Number(flags.port) : 8399;
      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/engine/stop`, { method: 'POST' });
        if (!res.ok && res.status !== 200) throw new Error(`HTTP ${res.status}`);
        process.stdout.write(`Команда остановки принята. Модели выгружаются из RAM/VRAM, сервер на порту ${port} закрывается.\n`);
        // Дождаться фактического закрытия сервера — значит, все модели выгружены.
        const deadline = Date.now() + 15000;
        for (;;) {
          let alive = false;
          try {
            const h = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(600) });
            alive = h.ok || h.status === 503;
          } catch {
            alive = false;
          }
          if (!alive) {
            process.stdout.write('Движок полностью остановлен.\n');
            return;
          }
          if (Date.now() > deadline) {
            process.stderr.write('Движок не закрылся за 15 с — проверьте процессы вручную.\n');
            process.exitCode = 1;
            return;
          }
          await new Promise((r) => setTimeout(r, 400));
        }
      } catch (err) {
        process.stderr.write(`Не удалось остановить движок на порту ${port}: ${err.message}\nСкорее всего, он и не запущен.\n`);
        process.exitCode = 1;
      }
      return;
    }

    case 'serve': {
      const { config, engine, sampler, logger } = build({ withServer: true });
      if (flags.port) config.api.port = Number(flags.port);
      if (flags.host) config.api.host = String(flags.host);
      sampler.start();
      await engine.start();

      const server = createServer({ config, engine, logger });
      server.on('close', () => {
        logger.info('server closed');
        process.exit(0);
      });
      server.on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
          logger.error(`Порт ${config.api.port} занят — укажите другой: litemind serve --port 8400`);
          process.exit(1);
        }
        throw err;
      });
      server.listen(config.api.port, config.api.host, () => {
        logger.info('LiteMind Engine started', {
          url: `http://${config.api.host}:${config.api.port}`,
          profile: config.profile,
          backend: config.backend.type,
          backendHealthy: engine.health.ok
        });
        if (!engine.health.ok) {
          logger.warn('Backend не обнаружен — панель и API работают, генерация вернёт понятную ошибку.', { detail: engine.health.error });
        }
        process.stdout.write(`\nLiteMind Engine: http://${config.api.host}:${config.api.port}\n`);
      });

      const shutdown = async () => {
        logger.info('shutting down');
        try {
          engine.beginStop();
          await engine.stopAllModels(); // модели не должны остаться в RAM/VRAM после Ctrl+C
        } catch (err) {
          logger.warn('stopAllModels on shutdown failed', { error: err.message });
        }
        await engine.shutdownFull();
        server.close();
        server.closeAllConnections?.();
        process.exit(0);
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
      return;
    }

    default:
      process.stderr.write(`Неизвестная команда: ${cmd}\n\n${HELP}`);
      process.exitCode = 1;
  }
}

main().catch((err) => {
  process.stderr.write(`Ошибка: ${err.message}\n`);
  process.exit(1);
});
