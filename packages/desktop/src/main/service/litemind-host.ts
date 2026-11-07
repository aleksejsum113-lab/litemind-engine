// LiteMind Engine host — поднимает локальный движок (API 127.0.0.1:8399)
// внутри процесса Electron, чтобы приложению не требовался терминал или
// отдельный сервис. Если порт уже занят (движок запускали раньше или работает
// standalone-установка) — считаем, что движок уже доступен, и не трогаем его:
// существующая Ollama и пользовательские модели не затрагиваются.
import log from "electron-log"

const ENGINE_PORT = 8399
const ENGINE_URL = `http://127.0.0.1:${ENGINE_PORT}/health`

async function engineAlive(): Promise<boolean> {
  try {
    const res = await fetch(ENGINE_URL, { signal: AbortSignal.timeout(800) })
    return res.ok || res.status === 503 // движок отвечает — значит жив (503 = backend ещё не готов)
  } catch {
    return false
  }
}

/** Запускается один раз при старте приложения; никогда не бросает исключения. */
export async function startLiteMindEngineHost(): Promise<void> {
  try {
    if (await engineAlive()) {
      log.info("[litemind] engine already running on port", ENGINE_PORT)
      return
    }
    const { startLiteMindEngine } = await import("litemind-engine/src/index.js")
    await startLiteMindEngine({ port: ENGINE_PORT })
    log.info("[litemind] engine started on port", ENGINE_PORT)
  } catch (err) {
    // Не валим приложение: чат и OpenCode-функциональность работают и без движка,
    // а разделы LiteMind покажут понятную ошибку «движок недоступен».
    log.error("[litemind] engine failed to start:", err)
  }
}
