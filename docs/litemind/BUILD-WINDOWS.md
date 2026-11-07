# Сборка LiteMind Engine Desktop для Windows x64

Требования: Node 20+, [Bun](https://bun.sh) 1.2+, Windows 10/11 x64 (сборка
выполняется на Windows; кросс-сборка NSIS с Linux возможна через `--win --x64`,
но node-pty prebuild берётся по целевой платформе автоматически).

## Шаги

```powershell
# 1. Зависимости монорепозитория
bun install

# 2. CLI sidecar (нужен пакету desktop для чат-бэкенда OpenCode)
bun run --cwd packages/cli build

# 3. Сборка UI и Desktop (electron-vite → out/)
set OPENCODE_CHANNEL=prod
set OPENCODE_VERSION=0.3.0
bun run --cwd packages/desktop build

# 4. Пакетирование: NSIS-установщик + portable → packages/desktop/dist/
bun run --cwd packages/desktop pack -- --win --x64 --publish never
```

Артефакты:

- `litemind-desktop-win-x64.exe` — NSIS-установщик (выбор папки, ярлык на
  рабочем столе и в меню «Пуск», имя «LiteMind Engine»);
- `litemind-desktop-win-x64-portable.exe` — portable-версия без установки.

## Что внутри пакета

- Electron + собранный рендерер `packages/app` (чат OpenCode + нативные экраны LiteMind);
- main-процесс с чанком `litemind-host` — движок `packages/litemind-engine`
  бандлится внутрь и стартует на `127.0.0.1:8399` при запуске приложения;
- OpenCode CLI sidecar (`resources/opencode-cli.exe`) — чат-агент, файлы, терминал.

## Пути на машине пользователя

| Данные | Путь |
| --- | --- |
| Конфиг движка | `%APPDATA%\LiteMind\config.json` |
| GGUF-модели | `E:\LiteMind\models` (по умолчанию, меняется в «Настройках») |
| Установленные модели | внутри существующей установки Ollama (~/.ollama), не удаляются |

## Проверка сборки

1. Установить, запустить ярлык «LiteMind Engine».
2. «Железо» — показан CPU/AVX/RAM/диски.
3. «Каталог моделей» → «Скачать» у зелёной модели → прогресс в «Загрузках» →
   «Установить в движок».
4. Модель появилась в переключателе чата → отправить сообщение → получить ответ.
5. «Мониторинг» — CPU/RAM и tokens/sec последней генерации; профиль «Бережный»
   снижает приоритет Ollama.
6. Закрыть и снова открыть приложение — настройки, модели и история сохранены.

## Известные ограничения

- Спекулятивный decoding и квантование KV-cache недоступны через Ollama API
  (см. `docs/litemind/ADAPTIVE-ENGINE.md`); для них запланирован прямой
  llama.cpp-адаптер.
- Сборка не подписана сертификатом — SmartScreen предупредит при первом запуске.
- Автообновление отключено в пользу ручных релизов GitHub.
