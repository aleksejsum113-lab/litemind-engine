import { $ } from "bun"
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { resolveChannel } from "./utils"

const arg = process.argv[2]

const channel = arg === "dev" || arg === "beta" || arg === "prod" ? arg : resolveChannel()

const src = `./icons/${channel}`

const dest = "resources/icons"

// ТЗ v0.6.1 §2: ресурсы/icons также содержит committed-набор брендинга LiteMind (icon.ico +
// размеры .png) — единственный источник иконки установщика/exe/окна на Windows. Канальный набор
// ниже — это иконки апстрима OpenCode, поэтому перед затирающей копией сохраняем committed-файлы
// и возвращаем их поверх. Логика macOS/Linux (icns, Icon Composer, dock) не меняется.
const litemindBranding = ["icon.ico", "256x256.png", "128x128.png", "64x64.png", "32x32.png", "16x16.png"]

const staging = path.join(os.tmpdir(), `litemind-icons-${process.pid}`)

rmSync(staging, { force: true, recursive: true })
mkdirSync(staging, { recursive: true })

for (const file of litemindBranding) {
  const committed = path.join(dest, file)

  if (existsSync(committed)) cpSync(committed, path.join(staging, file))
}

await $`rm -rf ${dest}`

await $`cp -R ${src} ${dest}`

const restored = readdirSync(staging)

for (const file of restored) cpSync(path.join(staging, file), path.join(dest, file))

rmSync(staging, { force: true, recursive: true })

// Без committed-набора LiteMind (свежий клон: resources/icons в .gitignore — см. ТЗ v0.6.1 §2)
// установщик/exe/окно на Windows получит апстрим-иконку OpenCode вместо иконки LiteMind.
console.log(
  `Copied ${channel} icons from ${src} to ${dest}` +
    (restored.length ? ` (kept LiteMind branding: ${restored.join(", ")})` : ""),
)

if (!restored.length)
  console.warn(
    "WARNING: no committed LiteMind branding found in resources/icons — Windows builds will fall back to the upstream OpenCode icon",
  )
