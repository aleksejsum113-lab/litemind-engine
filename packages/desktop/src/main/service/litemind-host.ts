// LiteMind Engine host (ТЗ §16) — управление жизненным циклом движка внутри
// Electron. Движок (API 127.0.0.1:8399) поднимается в процессе приложения,
// останавливается по команде пользователя («Остановить движок») или при выходе,
// и НИКОГДА не перезапускается автоматически после остановки: повторный запуск
// — только явной командой пользователя («Запустить движок»).
//
// Состояния хоста: starting | running | stopping | stopped.
// Если порт уже занят (standalone-установка), движок «усыновляется»: старт не
// выполняется, но остановка через API (/api/engine/stop) тоже работает.
import log from "electron-log"
import { app, ipcMain } from "electron"
import { isRendererUrl } from "../windows/scheme"

const ENGINE_PORT = 8399
const ENGINE_URL = `http://127.0.0.1:${ENGINE_PORT}`

type EngineHandle = {
  stop: () => Promise<{ state?: string }>
  server: { on: (event: string, cb: () => void) => void }
}

type HostState = "starting" | "running" | "stopping" | "stopped"

const host = {
  state: "stopped" as HostState,
  handle: null as EngineHandle | null,
  owned: false, // движок запущен этим окном (а не усыновлён standalone-процесс)
  lastError: null as string | null,
}

async function engineAlive(): Promise<boolean> {
  try {
    const res = await fetch(`${ENGINE_URL}/health`, { signal: AbortSignal.timeout(800) })
    return res.ok || res.status === 503 // движок отвечает — значит жив (503 = backend ещё не готов)
  } catch {
    return false
  }
}

/**
 * Запускается один раз при старте приложения; никогда не бросает исключения.
 * Автозапуск выполняется только при старте приложения — после явной остановки
 * движка хост не включается повторно сам (ТЗ §16).
 */
export async function startLiteMindEngineHost(): Promise<void> {
  registerEngineIpc()
  // Выход приложения (ТЗ §16.4): корректно завершаем принадлежащие ему
  // процессы — генерации, загрузки, модели в RAM/VRAM — ДО фактического
  // завершения процесса. Гарантируется preventDefault + повторный app.exit().
  let engineStoppedForQuit = false
  app.on("will-quit", (event) => {
    if (engineStoppedForQuit) return
    event.preventDefault()
    const finish = () => {
      engineStoppedForQuit = true
      app.exit(0)
    }
    void stopEngine("quit")
      .catch(() => {})
      .then(() => setTimeout(finish, 50))
    // Страховка: не держим процесс дольше 6 секунд.
    setTimeout(finish, 6000)
  })

  try {
    if (await engineAlive()) {
      log.info("[litemind] engine already running on port", ENGINE_PORT)
      host.state = "running"
      host.owned = false
      return
    }
    host.state = "starting"
    const { startLiteMindEngine } = await import("litemind-engine/src/index.js")
    const handle = (await startLiteMindEngine({ port: ENGINE_PORT })) as unknown as EngineHandle
    host.handle = handle
    host.owned = true
    host.state = "running"
    host.lastError = null
    // Если движок остановили через HTTP API (раздел «Управление») — фиксируем
    // состояние и не трогаем его: автоперезапуска нет.
    handle.server.on("close", () => {
      if (host.state !== "stopping") host.state = "stopped"
      host.handle = null
      log.info("[litemind] engine server closed, host state:", host.state)
    })
    log.info("[litemind] engine started on port", ENGINE_PORT)
  } catch (err) {
    host.state = "stopped"
    host.lastError = err instanceof Error ? err.message : String(err)
    // Не валим приложение: чат и OpenCode-функциональность работают и без движка,
    // а разделы LiteMind покажут понятную ошибку «движок недоступен».
    log.error("[litemind] engine failed to start:", err)
  }
}

/** Полная остановка движка: генерации → загрузки → выгрузка моделей → сервер закрыт. */
export async function stopEngine(_reason = "user"): Promise<void> {
  if (host.state === "stopping") return
  const handle = host.handle
  if (handle) {
    host.state = "stopping"
    try {
      await Promise.race([
        handle.stop(),
        new Promise((resolve) => setTimeout(resolve, 5000)), // не блокируем выход навсегда
      ])
      log.info("[litemind] engine stopped gracefully")
    } catch (err) {
      log.warn("[litemind] engine stop error:", err)
    }
    host.handle = null
  }
  host.state = "stopped"
}

/** Явный запуск по команде пользователя из раздела «Управление». */
export async function startEngine(): Promise<{ ok: boolean; state: HostState; error?: string }> {
  if (host.state === "running" || host.state === "starting") return { ok: true, state: host.state }
  if (await engineAlive()) {
    host.state = "running"
    host.owned = false
    return { ok: true, state: "running" }
  }
  try {
    host.state = "starting"
    const { startLiteMindEngine } = await import("litemind-engine/src/index.js")
    const handle = (await startLiteMindEngine({ port: ENGINE_PORT })) as unknown as EngineHandle
    host.handle = handle
    host.owned = true
    host.state = "running"
    host.lastError = null
    handle.server.on("close", () => {
      if (host.state !== "stopping") host.state = "stopped"
      host.handle = null
    })
    log.info("[litemind] engine started by user request")
    return { ok: true, state: "running" }
  } catch (err) {
    host.state = "stopped"
    host.lastError = err instanceof Error ? err.message : String(err)
    log.error("[litemind] engine manual start failed:", err)
    return { ok: false, state: "stopped", error: host.lastError }
  }
}

/** Состояние для раздела «Управление»: хост + HTTP-состояние движка (если отвечает). */
async function engineStatus() {
  let http: {
    engine?: string
    models?: { id: string; state: string }[]
    queue?: { active: number; waiting: number }
    downloads?: number
    metrics?: { availableRamMb?: number | null; totalRamMb?: number | null; cpuPercent?: number | null }
  } | null = null
  try {
    const res = await fetch(`${ENGINE_URL}/api/engine/state`, { signal: AbortSignal.timeout(1200) })
    if (res.ok) http = await res.json()
  } catch {
    http = null
  }
  return {
    host: { state: host.state, owned: host.owned, lastError: host.lastError },
    engine: http ?? null,
    // Если HTTP не отвечает, а хост не owns процесс — движок остановлен (или чужой процесс умер).
    reachable: http !== null,
  }
}

let ipcRegistered = false

function registerEngineIpc(): void {
  if (ipcRegistered) return
  ipcRegistered = true
  // ТЗ §16: единая точка управления движком для UI. Принимаем команды только
  // от фреймов рендерера приложения (как WindowSnapshotChannel).
  ipcMain.handle("litemind:engine-control", (event, action: unknown) => {
    if (!isRendererUrl(event.senderFrame?.url)) return { ok: false, error: "forbidden" }
    switch (action) {
      case "status":
        return engineStatus()
      case "start":
        return startEngine()
      case "stop":
        return stopEngine("user").then(() => ({ ok: true, state: host.state }))
      case "quit":
        // «Выход»: корректная остановка принадлежащих приложению процессов, затем закрытие.
        return stopEngine("quit").then(() => {
          app.quit()
          return { ok: true, state: host.state }
        })
      default:
        return { ok: false, error: `unknown action: ${String(action)}` }
    }
  })
}
