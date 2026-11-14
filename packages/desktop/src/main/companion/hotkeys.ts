// ТЗ v0.6.4 (компаньон §8): горячие клавиши Windows.
//   Ctrl+Alt+L — показать/скрыть персонажа
//   Ctrl+Alt+P — открыть панель компаньона (вкладка «Компаньон»)
//   Ctrl+Alt+V — начать/остановить голосовой разговор (Push-to-Talk в чате)
//   Ctrl+Alt+H — остановить прослушивание/озвучивание/генерацию
//   Ctrl+Alt+T — вызвать текстовый ввод (фокус в поле чата)
// Комбинации редкие и не конфликтуют с распространёнными сочетаниями Windows
// и OpenCode. Регистрация идемпотентна: при занятой комбинации честно логируем
// и продолжаем без клавиши (приложение работает и без хоткеев).
import { BrowserWindow, app, globalShortcut } from "electron"
import log from "electron-log"

const DEFAULTS = {
  toggle: "Control+Alt+L",
  panel: "Control+Alt+P",
  voice: "Control+Alt+V",
  stop: "Control+Alt+H",
  input: "Control+Alt+T",
} as const

/** Основное окно чата (загружает UI движка 127.0.0.1:8399). */
function chatWindow(): BrowserWindow | null {
  for (const w of BrowserWindow.getAllWindows()) {
    if (w.isDestroyed()) continue
    const url = w.webContents.getURL() ?? ""
    if (url.includes("127.0.0.1:8399")) return w
  }
  return null
}

function focusChatAndRun(script: string): void {
  const w = chatWindow()
  if (!w) return
  if (!w.isVisible()) w.show()
  w.focus()
  void w.webContents.executeJavaScript(script).catch(() => {})
}

export function registerCompanionHotkeys(actions: {
  toggleOverlay: () => void
  stopEverything: () => void
}): void {
  if (process.platform !== "win32" && process.platform !== "darwin" && process.platform !== "linux") return
  try {
    const okToggle = globalShortcut.register(DEFAULTS.toggle, actions.toggleOverlay)
    const okPanel = globalShortcut.register(DEFAULTS.panel, () => {
      const w = chatWindow()
      if (w) {
        if (!w.isVisible()) w.show()
        w.focus()
        void w.webContents.executeJavaScript(`location.hash = 'companion'; window.dispatchEvent(new Event('hashchange'));`).catch(() => {})
      }
    })
    const okVoice = globalShortcut.register(DEFAULTS.voice, () => {
      // Push-to-Talk: синтезируем Ctrl+Space в чате — обработчик app.js включит
      // запись; повторное нажатие останавливает и распознаёт.
      focusChatAndRun(
        `(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', code: 'Space', ctrlKey: true, bubbles: true })); })()`,
      )
    })
    const okStop = globalShortcut.register(DEFAULTS.stop, actions.stopEverything)
    const okInput = globalShortcut.register(DEFAULTS.input, () => {
      focusChatAndRun(`(() => { const t = document.getElementById('prompt'); if (t) { t.focus(); t.select?.(); } })()`)
    })
    log.info("[companion] hotkeys registered", {
      toggle: okToggle, panel: okPanel, voice: okVoice, stop: okStop, input: okInput,
    })
  } catch (err) {
    log.warn("[companion] hotkey registration failed (продолжаем без них):", err)
  }
}

export function unregisterCompanionHotkeys(): void {
  try {
    globalShortcut.unregisterAll()
  } catch { /* */ }
}

/** Остановить всё, что компаньон мог начать: запись, озвучивание, генерацию. */
export function stopCompanionActivity(): void {
  focusChatAndRun(`(() => {
    try { document.getElementById('btn-stop')?.click(); } catch {}
    try { document.querySelectorAll('audio,video').forEach((a) => { try { a.pause(); } catch {} }); } catch {}
    const t = document.getElementById('prompt'); if (t) t.blur();
  })()`)
}

/** Удобный вызов при выходе приложения. */
export function onQuitUnregister(): void {
  app.on("will-quit", () => unregisterCompanionHotkeys())
}
