import { copyFile, readdir, stat } from "node:fs/promises"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { Arch, type Configuration } from "electron-builder"
import { NativeArch } from "../../script/native-arch"
import { DESKTOP_NATIVE_ENGLISH } from "@opencode/app/i18n/desktop-native"
import { CLI_BINARIES, getCurrentCli, nodePtyPackage } from "./script/utils"

const packageDir = path.dirname(fileURLToPath(import.meta.url))

// The Electron 42 packaging update briefly installed Linux launchers/icons under
// "opencode-desktop". Keep that hidden desktop entry around so existing GNOME/KDE
// pins still resolve after the canonical app id changes back to ai.opencode.desktop.
const legacyDesktopEntry = path.join(packageDir, "resources", "linux", "opencode-desktop.desktop")

const legacyDesktopEntryFpm = `${legacyDesktopEntry}=/usr/share/applications/opencode-desktop.desktop`

// rpmbuild adds /usr/lib/.build-id links for every ELF file. The bundled Electron
// binaries are byte-identical across apps on the same Electron version, so those
// links collide with other Electron RPMs (Slack, Unity Hub, ...) and rpm/zypper
// refuse to install or update. They only serve debuginfo lookup, so skip them.
// fpm only accepts flags before the first src=dest mapping, so keep this first.
const rpmNoBuildIdLinksFpm = "--rpm-rpmbuild-define=_build_id_links none"

const metainfoFpm = (appId: string) =>
  `${path.join(packageDir, "resources", `${appId}.metainfo.xml`)}=/usr/share/metainfo/${appId}.metainfo.xml`

// Dev and beta package every commit, so they trade about 5% (deb) and 17% (rpm) larger files for xz -1, which
// compresses the payload about 3x faster than the deb default (-3) and 5x faster than the rpm default (-9).
const previewCompressionFpm = (target: "deb" | "rpm") => [`--${target}-compression-level`, "1"]

function resolveChannel() {
  const raw = process.env.OPENCODE_CHANNEL

  if (raw === "dev" || raw === "beta" || raw === "prod") return raw

  if (raw === "latest") return "prod"

  return "dev"
}

// v0.4: собственные app id — LiteMind больше не делит GUID/записи реестра и
// протокол opencode:// с OpenCode Desktop (конфликт установки устранён).
const APP_IDS = {
  dev: "ai.litemind.desktop.dev",
  beta: "ai.litemind.desktop.beta",
  prod: "ai.litemind.desktop",
} as const

// Собственный runtime llama.cpp: в установленном приложении лежит в
// resources\llamacpp\llama-server.exe (собирается в CI без AVX — см. workflow).
const llamacppResourceDir = path.join(packageDir, "resources", "llamacpp")
const hasLlamaRuntime = fs.existsSync(path.join(llamacppResourceDir, "llama-server.exe"))
// sd.exe — бэкенд Генератора изображений (stable-diffusion.cpp, без AVX; собирается в CI).
const sdResourceDir = path.join(packageDir, "resources", "sd")
const hasSdRuntime = fs.existsSync(path.join(sdResourceDir, "sd.exe"))

// libappimage (used by AppImageLauncher) resolves the .desktop entry inside an
// AppImage by globbing `*.desktop` at the squashfs root. If the main
// executable itself ends in `.desktop` (prod appId `ai.opencode.desktop`), the
// ELF binary matches the glob and is parsed as a desktop entry, so
// integration fails with `Malformed desktop entry: Unexpected char '\x7f' at 0`
// (0x7F is the first byte of the ELF magic).
// https://github.com/anomalyco/opencode/issues/51867
// Strip a trailing `.desktop` so the executable can never collide with the
// desktop-entry glob. Beta/dev appIds end in `.beta`/`.dev` and are unaffected.
function linuxExecutableName(appId: string): string {
  return appId.replace(/\.desktop$/, "")
}

const getBase = (appId: string): Configuration => {
  const target = getCurrentCli()
  const desktopName = `${appId}.desktop`

  return {
    artifactName: "litemind-desktop-${os}-${arch}.${ext}",
    directories: {
      output: "dist",
      buildResources: "resources",
    },
    // Linux launchers are .desktop files, so this is the desktop file name,
    // not just the app id. For prod, app id "ai.opencode.desktop" becomes
    // "ai.opencode.desktop.desktop".
    // https://developer.gnome.org/documentation/guidelines/maintainer/integrating.html
    // https://www.electron.build/docs/linux/
    // Release builds take their version from OPENCODE_VERSION instead of rewriting package.json.
    extraMetadata: process.env.OPENCODE_VERSION
      ? { desktopName, version: process.env.OPENCODE_VERSION }
      : { desktopName },
    files: [
      "out/**/*",
      "resources/**/*",
      // Runtime кладём в extraResources (вне asar) — не дублируем его в архиве.
      "!resources/llamacpp/**",
      "!resources/opencode-cli*",
      // Keep only the target platform's node-pty prebuild when cross-packaging with --cpu=*.
      ...CLI_BINARIES.filter((item) => item.os !== target.os || item.cpu !== target.cpu).map(
        (item) => `!**/node_modules/@lydell/node-pty-${item.os}-${item.cpu}{,/**/*}`,
      ),
      // Log export imports Zip.js as ESM. Keep index.js and lib, including its inline worker.
      "!**/node_modules/@zip.js/zip.js/dist{,/**/*}",
      "!**/node_modules/@zip.js/zip.js/{index.cjs,index.min.js,index-fflate.js,deno.json,eslint.config.mjs}",
      // Nothing executes type declarations or source maps, and every entry costs startup time: the
      // main process parses the whole asar header before it runs any JavaScript.
      "!**/node_modules/**/*.d.{ts,cts,mts}",
      "!**/node_modules/**/*.d.{ts,cts,mts}.map",
      "!**/node_modules/**/*.{js,cjs,mjs}.map",
      // These packages execute compiled JavaScript, not their sources.
      "!**/node_modules/ajv/lib{,/**/*}",
      "!**/node_modules/ajv-formats/src{,/**/*}",
      // Keep js-yaml's CommonJS sources and dist/js-yaml.mjs ESM entry, not browser bundles or its CLI.
      "!**/node_modules/js-yaml/dist/{js-yaml.js,js-yaml.min.js,*.map}",
      "!**/node_modules/js-yaml/bin{,/**/*}",
    ],
    extraResources: [
      {
        from: "resources/",
        to: "",
        filter: ["opencode-cli", "opencode-cli.exe", "opencode-cli.version"],
      },
      ...(hasLlamaRuntime
        ? [{ from: "resources/llamacpp", to: "llamacpp", filter: ["**/*"] }]
        : []),
      ...(hasSdRuntime ? [{ from: "resources/sd", to: "sd", filter: ["**/*"] }] : []),
    ],
    afterPack: async (context) => {
      const arch = Arch[context.arch]

      // The --arm64 flag picks Electron while OPENCODE_TARGET picks the CLI and node-pty, so they can disagree.
      if (arch !== "x64" && arch !== "arm64") throw new Error(`Unsupported desktop architecture: ${arch}`)

      if (arch !== target.cpu) throw new Error(`Packaging ${arch} Electron with the ${target.target} CLI`)
      const resources = context.packager.getResourcesDir(context.appOutDir)
      const cli = path.join(resources, context.electronPlatformName === "win32" ? "opencode-cli.exe" : "opencode-cli")

      const file = await stat(cli)

      if (!file.isFile() || file.size === 0) throw new Error(`Bundled CLI must be a non-empty file: ${cli}`)
      await NativeArch.verify(cli, arch)
      const version = path.join(path.dirname(cli), "opencode-cli.version")

      if ((await stat(version)).size === 0) throw new Error(`Bundled CLI version must be a non-empty file: ${version}`)

      // With an Icon Composer mac.icon, electron-builder bundles the ICNS that actool generates as the pre-macOS 26
      // fallback. That one tops out at 256px and draws a light ring around the squircle, so ship ours instead.
      if (context.electronPlatformName === "darwin")
        await copyFile(path.join(packageDir, "resources/icons/icon.icns"), path.join(resources, "icon.icns"))

      if (context.electronPlatformName !== "win32") return

      // Runtime llama.cpp обязателен в Windows-установке v0.4: без него чат не запустится.
      if (hasLlamaRuntime) {
        const llamaDir = path.join(resources, "llamacpp")
        const llama = path.join(llamaDir, "llama-server.exe")
        const llamaStat = await stat(llama)
        // С осени 2026 upstream llama.cpp разделил сервер: llama-server.exe — тонкий
        // лаунчер (~10 КБ), вся логика — в llama-server-impl.dll. Поэтому проверяем
        // не размер одного exe, а полноту комплекта: exe на месте и суммарный
        // размер runtime-каталога существенный (полный комплект ≈ 30–60 МБ:
        // llama-server-impl.dll, llama.dll, ggml.dll, ggml-cpu-*.dll и т.д.).
        if (!llamaStat.isFile() || llamaStat.size < 1_000) {
          throw new Error(`Bundled llama-server.exe looks wrong: ${llama} (${llamaStat.size} bytes)`)
        }
        let llamacppTotal = 0
        for (const entry of await readdir(llamaDir)) {
          const entryStat = await stat(path.join(llamaDir, entry))
          if (entryStat.isFile()) llamacppTotal += entryStat.size
        }
        if (llamacppTotal < 20_000_000) {
          throw new Error(
            `Bundled llama.cpp runtime looks incomplete: ${llamaDir} (total ${llamacppTotal} bytes, expected >= 20 MB)`,
          )
        }
      }

      // sd.exe (Генератор изображений, ТЗ v0.6.1 §3) обязателен в Windows-установке:
      // без него вкладка «Генератор изображений» честно сообщит об отсутствии бэкенда.
      if (hasSdRuntime) {
        const sdDir = path.join(resources, "sd")
        const sdExe = path.join(sdDir, "sd.exe")
        const sdStat = await stat(sdExe)
        if (!sdStat.isFile() || sdStat.size < 1_000_000) {
          throw new Error(`Bundled sd.exe looks wrong: ${sdExe} (${sdStat.size} bytes)`)
        }
      }

      const prebuilds = path.join(
        resources,
        "app.asar.unpacked/node_modules",
        nodePtyPackage(target.target),
        "prebuilds",
        `${target.os}-${target.cpu}`,
      )

      const addon = path.join(prebuilds, "conpty.node")

      if ((await stat(addon)).size === 0) throw new Error(`Bundled node-pty must be a non-empty file: ${addon}`)
      const entries = await readdir(prebuilds, { recursive: true, withFileTypes: true })

      await Promise.all(
        entries
          .filter((entry) => entry.isFile())
          .map(async (entry) => {
            const file = path.join(entry.parentPath, entry.name)

            if (await NativeArch.isNative(file)) await NativeArch.verify(file, arch)
          }),
      )
    },
    mac: {
      category: "public.app-category.developer-tools",
      icon: `resources/icons/icon.icns`,
      extendInfo: {
        NSMicrophoneUsageDescription: DESKTOP_NATIVE_ENGLISH["desktop.microphoneUsage"],
        // The CLI server and its terminals run as children of the app, so macOS asks for their access to
        // these protected locations in the app's name. The prompt shows the description (#56479).
        NSDocumentsFolderUsageDescription: DESKTOP_NATIVE_ENGLISH["desktop.documentsFolderUsage"],
        NSDesktopFolderUsageDescription: DESKTOP_NATIVE_ENGLISH["desktop.desktopFolderUsage"],
        NSDownloadsFolderUsageDescription: DESKTOP_NATIVE_ENGLISH["desktop.downloadsFolderUsage"],
        NSNetworkVolumesUsageDescription: DESKTOP_NATIVE_ENGLISH["desktop.networkVolumesUsage"],
        NSRemovableVolumesUsageDescription: DESKTOP_NATIVE_ENGLISH["desktop.removableVolumesUsage"],
        NSAutoFillRequiresTextContentTypeForOneTimeCodeOnMac: true,
      },
      target: ["dmg", "zip"],
    },
    protocols: {
      name: "LiteMind",
      schemes: ["litemind"],
    },
    win: {
      icon: `resources/icons/icon.ico`,
      // NSIS-установщик (ТЗ §7). Portable-таргет не собирается: патч апстрима
      // app-builder-lib использует ${DirState}, определённый только в assisted-шаблоне.
      target: [{ target: "nsis", arch: ["x64"] }],
      verifyUpdateCodeSignature: false,
    },
    nsis: {
      // ТЗ §1: один понятный файл установщика — LiteMind-Engine-Setup-x64.exe
      artifactName: "LiteMind-Engine-Setup-x64.${ext}",
      include: path.join(packageDir, "resources", "windows", "installer.nsh"),
      // Своё имя удаления — чтобы в «Установка и удаление программ» LiteMind
      // не смешивался с OpenCode.
      uninstallDisplayName: "LiteMind Engine ${version}",
      // Пошаговый установщик: пользователь выбирает папку, создаются ярлыки.
      oneClick: false,
      perMachine: false,
      allowToChangeInstallationDirectory: true,
      createDesktopShortcut: true,
      createStartMenuShortcut: true,
      shortcutName: "LiteMind Engine",
      installerIcon: `resources/icons/icon.ico`,
      uninstallerIcon: `resources/icons/icon.ico`,
      installerHeaderIcon: `resources/icons/icon.ico`,
    },
    linux: {
      icon: `resources/icons`,
      category: "Development",
      executableName: linuxExecutableName(appId),
      // Derive the installed `.desktop` filename from `desktopName`
      // (`ai.opencode.desktop.desktop` for prod) instead of `executableName`,
      // so window association is unaffected by the executable rename above.
      syncDesktopName: true,
      desktop: {
        entry: {
          // Match the installed .desktop file and hicolor icon basename so
          // Linux shells can associate the running Electron window with its launcher.
          StartupWMClass: appId,
        },
      },
      target: ["AppImage", "deb", "rpm"],
    },
  }
}

export function getConfig() {
  const channel = resolveChannel()
  const appId = APP_IDS[channel]
  const base = getBase(appId)

  switch (channel) {
    case "dev": {
      return {
        ...base,
        appId,
        productName: "LiteMind Dev",
        publish: {
          provider: "github",
          owner: "aleksejsum113-lab",
          repo: "litemind-engine",
          channel: "latest",
        },
        deb: { fpm: [...previewCompressionFpm("deb"), metainfoFpm(appId)] },
        rpm: {
          packageName: "litemind-dev",
          fpm: [rpmNoBuildIdLinksFpm, ...previewCompressionFpm("rpm"), metainfoFpm(appId)],
        },
      }
    }

    case "beta": {
      return {
        ...base,
        appId,
        productName: "LiteMind Beta",
        protocols: { name: "LiteMind Beta", schemes: ["litemind"] },
        publish: {
          provider: "github",
          owner: "aleksejsum113-lab",
          repo: "litemind-engine",
          channel: "latest",
        },
        deb: { fpm: [...previewCompressionFpm("deb"), metainfoFpm(appId)] },
        rpm: {
          packageName: "litemind-beta",
          fpm: [rpmNoBuildIdLinksFpm, ...previewCompressionFpm("rpm"), metainfoFpm(appId)],
        },
      }
    }

    case "prod": {
      return {
        ...base,
        appId,
        productName: "LiteMind",
        protocols: { name: "LiteMind", schemes: ["litemind"] },
        // An Icon Composer package compiles to Assets.car, which macOS 26 and later draw the app icon from
        // (Dock, Finder, system dialogs and the system icon styles). Older macOS keeps using the ICNS.
        mac: { ...base.mac, icon: "resources/icons/icon.icon" },
        // The DMG volume icon would otherwise use the same actool-generated ICNS.
        dmg: { icon: "resources/icons/icon.icns" },
        publish: {
          provider: "github",
          owner: "aleksejsum113-lab",
          repo: "litemind-engine",
          channel: "latest",
        },
        deb: { fpm: [metainfoFpm(appId)] },
        rpm: { packageName: "litemind", fpm: [rpmNoBuildIdLinksFpm, metainfoFpm(appId)] },
      }
    }
  }
}

export default getConfig()
