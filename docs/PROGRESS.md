# PROGRESS — ход работ LiteMind Engine

Последнее обновление: 26.10.2026 (вечер). Лимит времени: ~2 часа — работаю по приоритетам.

---

## 1. Что сделано

| Этап | Статус |
|---|---|
| Движок v0.1 (Core, Resource Manager, Ollama-адаптер, API, панель, диагностика) | ✅ готов |
| Автотесты (mock, без моделей) | ✅ **61/61**, ~3 с |
| Скрипты Windows: start / stop / doctor / test | ✅ написаны и **реально прогнаны** (запуск → сервер поднялся → стоп → порт свободен) |
| Конфигурация слабого ПК `config/litemind.low-spec.json` | ✅ проверена через `doctor` |
| Установщик NSIS `installer/litemind.nsi` | ✅ собран `installer/Output/LiteMind-Setup-0.1.0.exe` (131 КБ); **установка не тестировалась** |
| Документация (8 файлов в `docs/`, README, README.en, CHANGELOG, CONTRIBUTING, SECURITY) | ✅ |
| Аудит секретов и личных данных | ✅ чисто: `.gitignore` отсекает логи, Output с .exe, .freebuff, веса моделей; по текстам совпадений нет |
| `git init` локально | ✅ (ветка `master`) |

## 2. Что осталось

| Задача | Блокер |
|---|---|
| Приватный репозиторий `litemind-engine` + публикация кода | нужна **авторизация GitHub** (OAuth в браузере) — без неё я не могу ни создать репозиторий, ни запушить |
| Тест установщика (установка / обновление / удаление) | по плану — **после** реального теста движка (Этап 5) |
| Реальный тест: Ollama + `qwen2.5:0.5b`, замеры RAM/скорость | ждёт **отдельного разрешения** — см. `REAL_MODEL_TEST.md` |
| Заполнить BENCHMARKS реальными цифрами | то же |

Чего я **не** делал и не буду без разрешения: ставил Ollama/модели, запускал генерацию,
ставил программы (в т.ч. gh CLI), менял настройки Windows, публиковал что-либо наружу.

---

## 3. План хранения: диск C: почти полон (12.0 ГБ свободно), модели — на диск E:

Факт на 26.10.2026: **C: — 12.06 ГБ свободно**, **E: — 80.8 ГБ свободно**.
Ollama по умолчанию пишет модели в `%USERPROFILE%\.ollama\models` (на C:) — этого допускать нельзя.

### Порядок действий (выполняет пользователь, 2 минуты)

```powershell
# 1) Папка под модели на диске E: (один раз)
New-Item -ItemType Directory -Force "E:\ollama-models" | Out-Null

# 2) Направить туда модели Ollama (один раз, пользовательская переменная — НЕ системная)
[Environment]::SetEnvironmentVariable("OLLAMA_MODELS", "E:\ollama-models", "User")

# 3) Проверка (в НОВОМ окне терминала, чтобы переменная подхватилась)
ollama pull qwen2.5:0.5b
Get-ChildItem "E:\ollama-models" -Recurse | Measure-Object Length -Sum   # размер должен быть ~0.4 ГБ
(Get-ChildItem "$env:USERPROFILE\.ollama" -Recurse -ErrorAction SilentlyContinue).Count  # должно быть 0
```

### Бюджет места

| Куда | Что | Сколько | На каком диске |
|---|---|---|---|
| Программа Ollama | `AppData\Local\Ollama` | ~1.5 ГБ | C: (необходимый минимум, на 12 ГБ свободных — хватает) |
| Модели | `E:\ollama-models` | 0.4 ГБ (qwen2.5:0.5b) | **E:** |
| LiteMind Engine | папка проекта | ~1 МБ | E: (уже там) |
| Конфиг и журналы LiteMind | `%APPDATA%\LiteMind` | < 10 МБ | C: (мелочь) |

Если и на C: станет тесно: `ollama rm <имя>` удаляет модель, кэш чистится,
Ollama деинсталлируется через «Приложения» (модели на E: при этом остаются).

### Если что-то пойдёт не так

- `ollama` не видит переменную → закрыть и открыть терминал заново (или перезайти в Windows).
- Модель всё равно пишется на C: → убедиться, что переменная именно **пользовательская** OLLAMA_MODELS и что после неё перезапускали терминал: `Get-ChildItem Env:OLLAMA_MODELS`.

---

## 4. Команды, которые нужно выполнить дальше

### A. Авторизация GitHub и создание приватного репозитория

```powershell
# 1) Официальная авторизация GitHub через браузер (Git Credential Manager, уже установлен)
cd "E:\проект малых весов моделей"
git credential-manager github login

# 2) Создать приватный репозиторий litemind-engine в вебе (одна кнопка):
#    https://github.com/new?name=litemind-engine&private=true

# 3) Подключить и опубликовать (я могу выполнить этот шаг сам после авторизации)
git remote add origin git@github.com:ВАШ_ЛОГИН/litemind-engine.git
git branch -M main
git push -u origin main
```

(Альтернатива HTTPS: `git remote add origin https://github.com/ВАШ_ЛОГИН/litemind-engine.git` —
GCM попросит авторизацию в браузере при первом push.)

### B. Когда дадите разрешение — реальный тест (по шагам)

`docs/REAL_MODEL_TEST.md` → установка Ollama, `ollama pull qwen2.5:0.5b`,
`scripts\start.ps1`, один короткий запрос, замеры, `scripts\stop.ps1`.

### C. Позже — проверка установщика (Этап 5)

Запуск `installer\Output\LiteMind-Setup-0.1.0.exe` в тестовой папке + чек-лист
в `docs/INSTALLER_PLAN.md`.

---

## 5. Как продолжить после окончания лимита

1. `git log --oneline` — что уже закоммичено.
2. `npm test` — должно быть 61/61.
3. `powershell -File scripts\doctor.ps1` — состояние системы.
4. Эта страница (`docs/PROGRESS.md`) — актуальный список остатков.
