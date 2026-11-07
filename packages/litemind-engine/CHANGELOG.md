# Changelog

All notable changes to LiteMind Engine are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/); versions follow [SemVer](https://semver.org/).

## [0.1.0] — unreleased

Первая версия (в разработке, не опубликована).

### Added

- **LiteMind Core** — очередь запросов (1 активный запрос в профиле Low Resource),
  отмена, общие и «простойные» тайм-ауты, автовыгрузка модели по таймеру,
  предстартовая проверка памяти (`MEMORY_BUDGET`).
- **Resource Manager** — метрики RAM/CPU/VRAM (PowerShell/CIM на Windows, `/proc` в dev),
  допуск к запуску по памяти (веса + KV-кэш + резерв Windows, потолок 70–75% RAM).
- **Inference Backend** — контракт адаптера, реестр, адаптер Ollama
  (detect, список моделей, потоковая генерация, отмена, выгрузка `keep_alive: 0`).
- **API Server** — OpenAI-совместимый локальный API: `/health`, `/v1/models`,
  `/v1/chat/completions` (SSE), `/api/status`, `/api/cancel`, `/api/stop`,
  `/api/unload`, `/api/profile`, `/api/shutdown`. Доступ только с loopback по умолчанию.
- **Desktop UI** — лёгкая панель (HTML/CSS/JS без сборки): выбор модели, нагрузка,
  контекст, кнопки «Запустить / Остановить / Выгрузить», режим экономии ресурсов.
- **Diagnostics** — JSONL-журнал и метрики производительности (TTFT, токенов/сек).
- Профили `low` и `balanced`, конфигурация для слабого ПК
  (`config/litemind.low-spec.json`).
- Скрипты Windows: `scripts/start.ps1`, `stop.ps1`, `doctor.ps1`, `test.ps1`.
- Автотесты: 61 тест на mock-сервере Ollama (очередь, отмена, тайм-ауты, бюджет памяти,
  восстановление после сбоя, HTTP API, панель, политика доступа).
- Документация: архитектура, режим Low Resource, установка на Windows, OpenCode,
  безопасность, метрики, инструкция реального теста, план установщика.

### Known limitations

- Реальные измерения на целевом ПК (Windows 11, Celeron N5095A, 16 ГБ) **не выполнялись**:
  Ollama и модели на момент написания не установлены. См. `docs/BENCHMARKS.md`.
- Установщик Windows: скрипт подготовлен (`installer/litemind.nsi`), сборка и проверка
  установки/удаления — после реального теста движка.
- VRAM показывается приблизительно (`AdapterRAM` не сообщает фактическое занятие).
