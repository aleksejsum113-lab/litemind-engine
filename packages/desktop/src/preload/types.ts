import type { StorageSnapshot, WindowSnapshot } from "../shared/ipc-transport"
import type { WindowBootstrap } from "../shared/window-bootstrap"

export type LiteMindEngineControlAction = "status" | "start" | "stop" | "quit"

/** Результат нативного диалога выбора папки (ТЗ Этап 1 §8/§9/§12). */
export type PickFolderResult = { ok: true; path: string } | { ok: false; canceled: true }

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
    /** Версии и пути для «Настройки → О приложении». */
    appInfo(): Promise<LiteMindAppInfo>
  }
}
