import type { StorageSnapshot, WindowSnapshot } from "../shared/ipc-transport"
import type { WindowBootstrap } from "../shared/window-bootstrap"

export type LiteMindEngineControlAction = "status" | "start" | "stop" | "quit"

/** Результат нативного диалога выбора папки (ТЗ Этап 1 §8/§9/§12). */
export type PickFolderResult = { ok: true; path: string } | { ok: false; canceled: true }

/** Результат нативного диалога выбора GGUF-файла (Этап 1Б §6). */
export type PickGgufResult = { ok: true; path: string } | { ok: false; canceled: true }

/** Информация о приложении и системе для раздела «Настройки» (ТЗ §12). */
export type LiteMindAppInfo = {
  version: string
  electron: string
  chrome: string
  node: string
  platform: string
  arch: string
  packaged: boolean
  userDataPath: string
  logsPath: string
  exePath: string
}

export type ElectronNative = {
  windowID: string
  bootstrap: WindowBootstrap
  storageSnapshot: Promise<StorageSnapshot>
  plugins: Promise<WindowSnapshot["plugins"]>
  getPathForFile(file: File): string
  litemindEngine: {
    control(action: LiteMindEngineControlAction): Promise<unknown>
    /** Открыть папку/файл системным проводником (модель, проект, журналы). */
    shellOpenPath(path: string): Promise<{ ok: boolean; error?: string }>
    /** Показать файл в проводнике с выделением. */
    shellShowItemInFolder(path: string): Promise<{ ok: boolean }>
    /** Стандартный диалог Windows «выбрать папку». */
    pickFolder(title: string, defaultPath?: string): Promise<PickFolderResult>
    /** Стандартный диалог Windows «выбрать GGUF-файл» (Этап 1Б §6). */
    pickGgufFile(title: string): Promise<PickGgufResult>
    /** Версии и пути для «Настройки → О приложении». */
    appInfo(): Promise<LiteMindAppInfo>
    /** ТЗ v0.6.3 §1.2: тема интерфейса — для окраски WCO overlay системных кнопок. */
    setWindowTheme(mode: "dark" | "light", background?: string): Promise<unknown>
    /** ТЗ v0.6.4: показать/скрыть персонажа-оверлея (панель «Внешность»). */
    companionToggle(): Promise<{ ok: boolean; error?: string }>
    companionShow(visible: boolean): Promise<{ ok: boolean; error?: string }>
    /** Настройки внешности уже сохранены движком; Desktop перечитывает оверлей. */
    companionApply(patch: Record<string, unknown>): Promise<{ ok: boolean; error?: string }>
  }
}
