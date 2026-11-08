import type { StorageSnapshot, WindowSnapshot } from "../shared/ipc-transport"
import type { WindowBootstrap } from "../shared/window-bootstrap"

export type LiteMindEngineControlAction = "status" | "start" | "stop" | "quit"

export type ElectronNative = {
  windowID: string
  bootstrap: WindowBootstrap
  storageSnapshot: Promise<StorageSnapshot>
  plugins: Promise<WindowSnapshot["plugins"]>
  getPathForFile(file: File): string
  litemindEngine: {
    control(action: LiteMindEngineControlAction): Promise<unknown>
  }
}
