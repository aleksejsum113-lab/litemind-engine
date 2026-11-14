import { desktopZoomLevels } from "@opencode/app/desktop-menu"
import { resolveThemeVariant } from "@opencode/ui/theme/resolve"
import type { DesktopTheme } from "@opencode/ui/theme/types"
import { existsSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { app, nativeTheme, type BrowserWindowConstructorOptions } from "electron"
import { Predicate } from "effect"
import oc2ThemeJson from "../../../../ui/src/theme/themes/oc-2.json"
import { BACKGROUND_COLOR_KEY, ZOOM_LEVEL_KEY } from "../storage/keys"
import { getStore } from "../storage/store"

// Frame defaults shared by the early window (created on ready, before the renderer exists) and the
// full window setup in appearance.ts, so both draw the same frame.

// SAFETY: oc-2.json is the bundled default theme, which the UI package loads as a DesktopTheme too.
const oc2Theme = oc2ThemeJson as DesktopTheme

// Match the renderer's 36px titlebar plus its former 8px content inset.
export const titlebarHeight = 44

export function tone() {
  return nativeTheme.shouldUseDarkColors ? "dark" : "light"
}

// The colour the renderer reported on its last run, or the default theme's for the system tone, so
// a window shown before the renderer paints already has the right background. Resolving a palette
// costs tens of milliseconds before the first window, so it only happens when nothing is stored.
export function storedBackgroundColor() {
  const saved = savedBackgroundColor()

  if (saved !== undefined) return saved
  const dark = tone() === "dark"

  return resolveThemeVariant(dark ? oc2Theme.dark : oc2Theme.light, dark)["background-base"]
}

// The colour the renderer reported on its last run, if it ever did.
export function savedBackgroundColor() {
  const stored = getStore().get(BACKGROUND_COLOR_KEY)

  return Predicate.isString(stored) ? stored : undefined
}

// The zoom level chosen in settings or with Zoom In and Zoom Out, or 100% when none was saved.
export function storedZoomLevel() {
  const stored = getStore().get(ZOOM_LEVEL_KEY)

  return desktopZoomLevels.find((level) => level === stored) ?? 1
}

// ТЗ v0.6.1 §2: полностью прозрачный оверлей (#00000000) делал системные кнопки
// min/max/close невидимыми на тёмном интерфейсе («нет управления окном»), поэтому оверлей
// рисуется сплошным цветом шапки. Высоту (44px, масштабируется зумом) не трогаем: она совпадает
// с высотой шапки рендерера, и updateTitlebar() повторно применяет её при смене зума.
const overlayColors = {
  dark: { color: "#111318", symbolColor: "#E5E7EB" },
  light: { color: "#F3F4F6", symbolColor: "#111318" },
} as const

export function titlebarOverlay(mode: "light" | "dark" = tone(), zoom = 1) {
  return {
    ...overlayColors[mode],
    height: Math.max(titlebarHeight, Math.round(titlebarHeight * zoom)),
  }
}

// ТЗ v0.6.3 §1.2: режим системных кнопок окна должен следовать теме ПРИЛОЖЕНИЯ,
// а не темы Windows. Раньше `tone()` (= nativeTheme) рисовал светлую панель
// min/max/close поверх тёмного интерфейса LiteMind, если у пользователя система
// светлая — «отдельная светлая системная панель, не соответствующая оформлению».
// Приложение тёмное по умолчанию; если рендерер уже сообщал фон — решаем по
// яркости сохранённого фона.
export function appOverlayMode(): "light" | "dark" {
  const background = savedBackgroundColor()

  if (!background) return "dark"

  const hex = background.replace("#", "")
  const full =
    hex.length === 3
      ? hex
          .split("")
          .map((c) => c + c)
          .join("")
      : hex.slice(0, 6)

  if (!/^[0-9a-fA-F]{6}$/.test(full)) return "dark"

  const r = parseInt(full.slice(0, 2), 16)
  const g = parseInt(full.slice(2, 4), 16)
  const b = parseInt(full.slice(4, 6), 16)
  // Воспринимаемая яркость (ITU-R BT.601): фон светлее порога — светлая тема.
  const luma = 0.299 * r + 0.587 * g + 0.114 * b

  return luma > 128 ? "light" : "dark"
}

// ТЗ v0.6.1 §2: иконка окна LiteMind на Windows. В установленном приложении icon.ico лежит рядом
// с app.asar (extraResources) с резервной копией внутри архива (files: "resources/**/*"); в dev —
// в resources/icons репозитория, откуда её копирует script/copy-icons.ts. Файла может не быть
// (dev без копирования иконок), поэтому undefined означает «опцию icon не задавать» — так dev
// не ссылается на несуществующий путь. Для macOS/Linux иконку выбирают appearance.ts и early.ts.
export function windowIconFile(): string | undefined {
  if (process.platform !== "win32") return undefined

  const icon = path.join("icons", "icon.ico")
  const candidates = app.isPackaged
    ? [path.join(process.resourcesPath, icon), path.join(process.resourcesPath, "app.asar", "resources", icon)]
    : [path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "resources", icon)]

  return candidates.find((candidate) => existsSync(candidate))
}

// macOS and Windows hide the titlebar; Windows draws its window controls in an overlay sized to the zoom.
export function platformFrame(mode: "light" | "dark", zoom: number) {
  const frame: BrowserWindowConstructorOptions = {}

  if (process.platform === "darwin") {
    frame.titleBarStyle = "hidden"
    frame.trafficLightPosition = { x: 14, y: 14 }
  }

  if (process.platform === "win32") {
    frame.frame = false
    frame.titleBarStyle = "hidden"
    frame.titleBarOverlay = titlebarOverlay(mode, zoom)
  }

  return frame
}
