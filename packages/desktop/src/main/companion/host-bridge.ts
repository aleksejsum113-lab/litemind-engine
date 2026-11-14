// ТЗ v0.6.4 (компаньон §5/§6): мост LiteMind Desktop → движок.
// Движок живёт в процессе приложения, поэтому Desktop может безопасно дать ему
// возможности ОС: чтение текста с экрана (локальный OCR Windows), открытие
// приложений/ссылок/папок, автоматизация UI (UIA, только с подтверждением),
// уведомления Windows. Приватность: скриншоты не покидают компьютер.
import { spawn } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { BrowserWindow, Notification, desktopCapturer, dialog, screen, shell } from "electron"
import log from "electron-log"

/** Выполнить PowerShell-скрипт с таймаутом. Возвращает stdout/код. */
function runPowerShell(script: string, timeoutMs = 20_000): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const proc = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], {
      windowsHide: true,
    })
    let stdout = ""
    let stderr = ""
    proc.stdout.on("data", (d) => (stdout += String(d)))
    proc.stderr.on("data", (d) => (stderr += String(d)))
    const timer = setTimeout(() => {
      try { proc.kill("SIGKILL") } catch { /* уже мёртв */ }
    }, timeoutMs)
    proc.on("error", (e) => {
      clearTimeout(timer)
      resolve({ code: -1, stdout: "", stderr: e.message })
    })
    proc.on("close", (code) => {
      clearTimeout(timer)
      resolve({ code: code ?? -1, stdout, stderr })
    })
  })
}

/**
 * Локальный OCR Windows (Windows.Media.Ocr — WinRT): PNG → текст.
 * Скрипт целиком передаётся аргументом, путь к файлу экранируется.
 */
const OCR_SCRIPT = (pngPath: string) => `
$ErrorActionPreference = 'Stop'
$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Storage.StorageFile, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Globalization.Language, Windows.Foundation, ContentType = WindowsRuntime]
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1' })[0]
function Await($WinRtTask, $ResultType) {
  $asTask = $asTaskGeneric.MakeGenericMethod($ResultType)
  $netTask = $asTask.Invoke($null, @($WinRtTask))
  $netTask.Wait(-1) | Out-Null
  $netTask.Result
}
$file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync('${pngPath.replace(/'/g, "''")}')) ([Windows.Storage.StorageFile])
$stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
$decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
$bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
if (-not $engine) { Write-Output 'OCR_ENGINE_UNAVAILABLE'; exit 2 }
$result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
Write-Output $result.Text
`

/** UIA: найти окно по фрагменту заголовка и нажать кнопку с заданным именем. */
const UIA_CLICK_SCRIPT = (windowTitle: string, buttonName: string) => `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$root = [System.Windows.Automation.AutomationElement]::RootElement
$cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Window)
$windows = $root.FindAll([System.Windows.Automation.TreeScope]::Children, $cond)
$target = $null
foreach ($w in $windows) {
  if ($w.Current.Name -like '*${windowTitle.replace(/'/g, "''")}*') { $target = $w; break }
}
if (-not $target) { Write-Output 'WINDOW_NOT_FOUND'; exit 3 }
$btnCond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, '${buttonName.replace(/'/g, "''")}')
$btn = $target.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $btnCond)
if (-not $btn) { Write-Output 'BUTTON_NOT_FOUND'; exit 4 }
$invoke = $btn.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
$invoke.Invoke()
Write-Output 'CLICKED'
`

/** UIA: сфокусировать окно по фрагменту заголовка. */
const UIA_FOCUS_SCRIPT = (windowTitle: string) => `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$root = [System.Windows.Automation.AutomationElement]::RootElement
$cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Window)
$windows = $root.FindAll([System.Windows.Automation.TreeScope]::Children, $cond)
foreach ($w in $windows) {
  if ($w.Current.Name -like '*${windowTitle.replace(/'/g, "''")}*') {
    $w.SetFocus()
    Write-Output 'FOCUSED'
    exit 0
  }
}
Write-Output 'WINDOW_NOT_FOUND'
exit 3
`

function tmpPng(): string {
  return path.join(os.tmpdir(), `litemind-screen-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`)
}

/**
 * Мост возможностей ОС для движка (inject через handle.setHostBridge).
 * Каждый метод возвращает { ok, ... } и НИКОГДА не бросает — движок
 * превращает результат в честный текст для модели.
 */
export function createHostBridge(): Record<string, (...args: any[]) => Promise<unknown>> {
  return {
    /** «Посмотри на экран»: скриншот активного монитора → локальный OCR → текст. */
    async captureScreenText(_opts: { signal?: AbortSignal } = {}): Promise<{ ok: boolean; text?: string; error?: string; retrievedAt: string }> {
      const retrievedAt = new Date().toISOString()
      if (process.platform !== "win32") {
        return { ok: false, error: "просмотр экрана реализован для Windows", retrievedAt }
      }
      try {
        const primary = screenPrimarySize()
        const sources = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: primary })
        const source = sources[0]
        if (!source) return { ok: false, error: "экран не найден", retrievedAt }
        const png = source.thumbnail.toPNG()
        const file = tmpPng()
        fs.writeFileSync(file, png)
        try {
          const r = await runPowerShell(OCR_SCRIPT(file), 30_000)
          const text = (r.stdout ?? "").trim()
          if (!text || r.code !== 0) {
            const reason = text === "OCR_ENGINE_UNAVAILABLE"
              ? "OCR-движок Windows недоступен для языков системы (Параметры → Время и язык → добавить русский язык с распознаванием)"
              : `OCR не сработал (код ${r.code})${r.stderr ? `: ${r.stderr.slice(0, 200)}` : ""}`
            return { ok: false, error: reason, retrievedAt }
          }
          log.info("[companion] screen OCR ok", { chars: text.length })
          return { ok: true, text: text.slice(0, 6000), retrievedAt }
        } finally {
          try { fs.rmSync(file, { force: true }) } catch { /* временный файл */ }
        }
      } catch (err) {
        return { ok: false, error: `скриншот/OCR не удались: ${String((err as Error).message ?? err).slice(0, 200)}`, retrievedAt }
      }
    },

    /** Открыть приложение/папку/сайт. kind: app | path | url | auto. */
    async openTarget({ kind, target }: { kind?: string; target: string }): Promise<{ ok: boolean; error?: string }> {
      const t = String(target ?? "").trim()
      if (!t) return { ok: false, error: "пустая цель" }
      try {
        const k = kind === "auto" || !kind
          ? (/^https?:\/\//i.test(t) ? "url" : /^[a-z]:[\\/]/i.test(t) ? "path" : "app")
          : kind
        if (k === "url") {
          await shell.openExternal(t)
        } else if (k === "path") {
          const err = await shell.openPath(t)
          if (err) return { ok: false, error: err }
        } else {
          // Приложение: через shell стартуем как пользователь, а не как служба.
          const r = process.platform === "win32"
            ? await runPowerShell(`Start-Process -FilePath '${t.replace(/'/g, "''")}'`, 15_000)
            : { code: 0, stdout: "", stderr: "" }
          if (r.code !== 0) return { ok: false, error: r.stderr?.slice(0, 200) || `приложение «${t}» не найдено` }
        }
        log.info("[companion] openTarget", { kind: k, target: t.slice(0, 100) })
        return { ok: true }
      } catch (err) {
        return { ok: false, error: String((err as Error).message ?? err).slice(0, 200) }
      }
    },

    /**
     * Действия в чужих окнах (UIA): focus_window | click_button | type_text.
     * ТЗ §6: потенциально разрушительные/влияющие на чужие окна действия —
     * ТОЛЬКО после подтверждения пользователя (диалог здесь, в Desktop).
     */
    async uiAction({ action, target, text, confirm }: { action: string; target?: string | null; text?: string | null; confirm?: boolean }): Promise<{ ok: boolean; result?: string; error?: string }> {
      if (process.platform !== "win32") return { ok: false, error: "автоматизация окон реализована для Windows" }
      const title = String(target ?? "").trim()
      if (!title) return { ok: false, error: "не указано окно (фрагмент заголовка)" }
      const description =
        action === "click_button" ? `нажать кнопку «${text ?? ""}» в окне «${title}»`
          : action === "type_text" ? `ввести текст в окно «${title}»`
            : action === "focus_window" ? `переключиться на окно «${title}»`
              : null
      if (!description) return { ok: false, error: `неизвестное действие: ${action}` }
      if (confirm !== true) {
        // Подтверждение запрашивает Desktop: движок присылает confirm=false →
        // показываем диалог. Отказ — честный результат, ничего не выполняется.
        const focused = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.isVisible())
        const win = focused ?? undefined
        const { response } = await (win
          ? dialog.showMessageBox(win, {
              type: "question",
              buttons: ["Разрешить", "Отменить"],
              defaultId: 1,
              cancelId: 1,
              title: "LiteMind компаньон",
              message: "Компаньон просит разрешение на действие",
              detail: `Компаньон хочет ${description}. Разрешить?`,
            })
          : dialog.showMessageBox({
              type: "question",
              buttons: ["Разрешить", "Отменить"],
              defaultId: 1,
              cancelId: 1,
              title: "LiteMind компаньон",
              message: "Компаньон просит разрешение на действие",
              detail: `Компаньон хочет ${description}. Разрешить?`,
            }))
        if (response !== 0) {
          log.info("[companion] uiAction declined by user", { action, target: title.slice(0, 60) })
          return { ok: false, error: "действие отклонено пользователем" }
        }
      }
      const script =
        action === "click_button" ? UIA_CLICK_SCRIPT(title, String(text ?? ""))
          : action === "focus_window" ? UIA_FOCUS_SCRIPT(title)
            : // type_text: сфокусировать окно и отправить текст через SendKeys
              `${UIA_FOCUS_SCRIPT(title)}\nAdd-Type -AssemblyName System.Windows.Forms\n[System.Windows.Forms.SendKeys]::SendWait('${String(text ?? "").replace(/'/g, "''")}')\nWrite-Output 'TYPED'\n`
      const r = await runPowerShell(script, 20_000)
      const out = (r.stdout ?? "").trim()
      const failed = r.code !== 0
      const human = out === "WINDOW_NOT_FOUND" ? `окно «${title}» не найдено`
        : out === "BUTTON_NOT_FOUND" ? `кнопка «${text}» не найдена в окне «${title}»`
          : out === "CLICKED" ? "кнопка нажата"
            : out === "FOCUSED" ? "окно на переднем плане"
              : out === "TYPED" ? "текст введён"
                : failed ? `действие не удалось (код ${r.code})${r.stderr ? `: ${r.stderr.slice(0, 160)}` : ""}` : out
      log.info("[companion] uiAction", { action, ok: !failed, target: title.slice(0, 60) })
      return failed ? { ok: false, error: human } : { ok: true, result: human }
    },

    /** Уведомление Windows (напоминания, события компаньона). */
    async notify({ title, body }: { title?: string; body?: string }): Promise<{ ok: boolean }> {
      try {
        if (Notification.isSupported()) {
          new Notification({ title: String(title ?? "LiteMind"), body: String(body ?? "") }).show()
        }
        return { ok: true }
      } catch {
        return { ok: false }
      }
    },
  }
}

/** Размер основного монитора в физических пикселях (для полного скриншота). */
function screenPrimarySize(): { width: number; height: number } {
  try {
    const d = screen.getPrimaryDisplay()
    const sf = d.scaleFactor || 1
    return { width: Math.round(d.size.width * sf), height: Math.round(d.size.height * sf) }
  } catch {
    return { width: 1920, height: 1080 }
  }
}
