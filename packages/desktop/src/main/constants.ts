import { app } from "electron"

type Channel = "local" | "dev" | "beta" | "prod"

const raw = import.meta.env.OPENCODE_CHANNEL

export const CHANNEL: Channel = raw === "local" || raw === "dev" || raw === "beta" || raw === "prod" ? raw : "dev"

export const VERSION = app.isPackaged ? app.getVersion() : (process.env.OPENCODE_VERSION ?? app.getVersion())

const appNames: Record<string, string> = {
  dev: "LiteMind Dev",
  beta: "LiteMind Beta",
  prod: "LiteMind",
}

/**
 * ТЗ v0.6.4 §2 (значок на панели задач): AppUserModelID окна ДОЛЖЕН совпадать
 * с app id установщика (APP_IDS в electron-builder.config.ts: ai.litemind.desktop*).
 *
 * Раньше в рантайме жил старый id OpenCode (ai.opencode.desktop): у пользователя
 * с установленным OpenCode Windows связывала AUMID «ai.opencode.desktop» с его
 * значком/ярлыком — работающее окно LiteMind группировалось и рисовалось на
 * панели задач значком OpenCode, а закрепление «уезжало» в чужую группу.
 * Ярлыки установщика при этом несли ai.litemind.desktop — рассинхрон идентичностей.
 */
const appIDs: Record<string, string> = {
  dev: "ai.litemind.desktop.dev",
  beta: "ai.litemind.desktop.beta",
  prod: "ai.litemind.desktop",
}

// Local renderer/server mode keeps the dev application identity.
export const APP_NAME = app.isPackaged ? appNames[CHANNEL] : "LiteMind Dev"

export const APP_ID = app.isPackaged ? appIDs[CHANNEL] : appIDs.dev

/**
 * Каталог пользовательских данных (userData = Chromium-профиль: чаты в
 * v0.6.1–v0.6.3 писали данные в %APPDATA%\ai.opencode.desktop*, и смена
 * AppUserModelID не должна переносить/терять чаты и настройки пользователя
 * (ТЗ v0.6.4 §2: «не менять без необходимости, если это может переместить
 * пользовательскую историю и настройки»). Обновление поверх v0.6.3 видит
 * ровно те же данные, что и раньше.
 */
const storageDirs: Record<string, string> = {
  dev: "ai.opencode.desktop.dev",
  beta: "ai.opencode.desktop.beta",
  prod: "ai.opencode.desktop",
}

export const STORAGE_ID = app.isPackaged ? storageDirs[CHANNEL] : storageDirs.dev
