# Подключение OpenCode к LiteMind Engine

LiteMind предоставляет **локальный OpenAI-совместимый API**, поэтому любой инструмент,
умеющий работать с `OPENAI_BASE_URL` / `baseURL`, может использовать его как провайдера.
OpenCode входит в число таких инструментов.

> Важно: этот документ — инструкция. **Сам OpenCode здесь не устанавливается и не
> настраивается**; выполняйте шаги в том окружении, где вы им пользуетесь.

## 1. Запустите LiteMind

```powershell
cd "/путь/к/litemind-engine"
npm start
# LiteMind Engine: http://127.0.0.1:8399
```

Проверьте, что API жив и видит модели:

```powershell
curl.exe http://127.0.0.1:8399/health
curl.exe http://127.0.0.1:8399/v1/models
```

Ожидаемо: `{"status":"ok", ...}` и список вида
`{"object":"list","data":[{"id":"qwen2.5:0.5b", ...}]}`.

Если `status` — `degraded`, сначала запустите Ollama (см. [WINDOWS_INSTALL.md](WINDOWS_INSTALL.md)).

## 2. Параметры подключения

| Параметр | Значение |
|---|---|
| Base URL | `http://127.0.0.1:8399/v1` |
| API-ключ | любая непустая строка (локальный доступ без аутентификации; ключ обязателен полю OpenAI-совместимости, но LiteMind его не проверяет для loopback) |
| Модель | имя из `/v1/models`, например `qwen2.5:0.5b` |

## 3. Настройка OpenCode

В конфигурации OpenCode (например, `~/.config/opencode/opencode.json` либо
`%USERPROFILE%\.config\opencode\opencode.json`) добавьте провайдера с открытым базовым URL:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "litemind": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "LiteMind Engine (local)",
      "options": {
        "baseURL": "http://127.0.0.1:8399/v1",
        "apiKey": "litemind-local"
      },
      "models": {
        "qwen2.5:0.5b": { "name": "Qwen2.5 0.5B (LiteMind)" }
      }
    }
  },
  "model": "litemind/qwen2.5:0.5b"
}
```

Имя модели в `models` должно совпадать с тем, что вернул `/v1/models`.

Альтернатива, если ваша версия OpenCode поддерживает переменные окружения:

```powershell
$env:OPENAI_BASE_URL = "http://127.0.0.1:8399/v1"
$env:OPENAI_API_KEY  = "litemind-local"
$env:OPENAI_MODEL    = "qwen2.5:0.5b"
```

## 4. Проверка подключения

Быстрая проверка без OpenCode (та же точка входа, что он использует):

```powershell
curl.exe -X POST http://127.0.0.1:8399/v1/chat/completions `
  -H "Content-type: application/json" `
  -d "{\"model\":\"qwen2.5:0.5b\",\"messages\":[{\"role\":\"user\",\"content\":\"Привет\"}]}"
```

Должен вернуться JSON с `choices[0].message.content`.

Потоковый режим (OpenCode использует его по умолчанию):

```powershell
curl.exe -N -X POST http://127.0.0.1:8399/v1/chat/completions `
  -H "Content-type: application/json" `
  -d "{\"model\":\"qwen2.5:0.5b\",\"stream\":true,\"messages\":[{\"role\":\"user\",\"content\":\"Привет\"}]}"
```

## 5. Что поддерживает API

| Возможность | Как |
|---|---|
| Состояние | `GET /health` (200 — ок, 503 — backend недоступен) |
| Список моделей | `GET /v1/models` |
| Генерация | `POST /v1/chat/completions` (`stream: false`) |
| Потоковая генерация | `POST /v1/chat/completions` (`stream: true`, SSE, финал `data: [DONE]`) |
| Отмена | обрыв соединения клиентом, `POST /api/cancel {"request_id": ...}`, `POST /api/stop` |
| Понятные ошибки | JSON вида `{"error":{"message","type","code"}}`: `MODEL_NOT_FOUND`, `QUEUE_FULL`, `MEMORY_BUDGET`, `TIMEOUT`, `BACKEND_UNAVAILABLE` |

Полезные опции запроса: `max_tokens`, `context_tokens` (размер контекста),
`num_threads` (потоки CPU) — все они ограничены значениями активного профиля.

## 6. Ограничения и правила доступа

- По умолчанию сервер слушает **только `127.0.0.1`**. Для других машин нужны явные
  `api.allowLan: true` **и** включённая аутентификация (см. [SECURITY.md](SECURITY.md)).
- При включённой очереди Low Resource параллельные запросы от OpenCode могут получить
  `429 QUEUE_FULL` — это нормально: дождитесь конца текущей генерации.
- Ответы приходят медленнее, чем у облачных API: считает локальная модель на слабом ПК.
