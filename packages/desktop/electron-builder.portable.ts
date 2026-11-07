import path from "node:path"
import { fileURLToPath } from "node:url"

import type { Configuration } from "electron-builder"
import { getConfig } from "./electron-builder.config"

const packageDir = path.dirname(fileURLToPath(import.meta.url))

// Отдельный конфиг для portable-версии LiteMind (ТЗ §7): один exe без установки.
// Основной конфиг подключает resources/windows/installer.nsh (staged updates,
// общий каталог каналов) — эти макросы рассчитаны на assisted-установщик и
// ломают portable-шаблон NSIS, поэтому здесь чистые настройки oneClick.
const base = getConfig()

const config: Configuration = {
  ...base,
  win: {
    ...base.win,
    target: [{ target: "portable", arch: ["x64"] }],
  },
  nsis: {
    ...base.nsis,
    // Заглушка ${DirState}: патч app-builder-lib использует его в extractUsing7za,
    // но в portable-шаблоне NSIS макрос не определён.
    include: path.join(packageDir, "resources", "windows", "portable.nsh"),
    oneClick: true,
    perMachine: false,
    allowToChangeInstallationDirectory: false,
    createDesktopShortcut: false,
    createStartMenuShortcut: false,
    artifactName: "litemind-desktop-win-x64-portable.${ext}",
  },
  portable: {
    artifactName: "litemind-desktop-win-x64-portable.${ext}",
  },
}

export default config
