// ТЗ v0.6.4 (компаньон §1/§8): оверлей персонажа LiteMind на рабочем столе.
//
// Отдельное окно Electron: без рамки, прозрачное, поверх окон, не в панели
// задач. Персонаж — собственный дизайн LiteMind (SVG+CSS): Люми, Искра, Орб.
// Анимации по состоянию движка (идёт/думает/говорит/ищет/выполняет), которые
// оверлей читает через SSE движка /api/companion/events/stream (loopback).
//
// Персонаж можно перетаскивать мышью; позиция сохраняется в настройках движка
// (companion.position), размер/прозрачность/персонаж приходят оттуда же.
// Полное отключение — настройка companion.enabled=false: окно вообще не создаётся.
import fs from "node:fs"
import path from "node:path"

import { BrowserWindow, app, screen as electronScreen } from "electron"
import log from "electron-log"

const ENGINE = "http://127.0.0.1:8399"

let overlay: BrowserWindow | null = null

/** HTML оверлея: единый файл, без сборки. Персонажи LiteMind, не Roamies. */
function overlayHtml(): string {
  const svgBody = (inner: string) => `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">${inner}</svg>`
  const lumi = svgBody(`<defs><radialGradient id="g" cx="35%" cy="35%"><stop offset="0%" stop-color="#b9ccff"/><stop offset="55%" stop-color="#6c8cff"/><stop offset="100%" stop-color="#3d53d8"/></radialGradient></defs>
    <circle class="body" cx="50" cy="50" r="34" fill="url(#g)"/>
    <circle class="eye e1" cx="40" cy="46" r="5" fill="#0e1014"/>
    <circle class="eye e2" cx="60" cy="46" r="5" fill="#0e1014"/>
    <path class="mouth" d="M43 60 Q50 66 57 60" stroke="#0e1014" stroke-width="3" fill="none" stroke-linecap="round"/>`)
  const spark = svgBody(`<defs><radialGradient id="g" cx="38%" cy="32%"><stop offset="0%" stop-color="#ffe9a8"/><stop offset="55%" stop-color="#ffb454"/><stop offset="100%" stop-color="#e8842a"/></radialGradient></defs>
    <path class="body" d="M50 12 L60 42 L92 50 L60 58 L50 88 L40 58 L8 50 L40 42 Z" fill="url(#g)"/>
    <circle class="eye e1" cx="44" cy="48" r="3.6" fill="#0e1014"/>
    <circle class="eye e2" cx="56" cy="48" r="3.6" fill="#0e1014"/>`)
  const orb = svgBody(`<defs><radialGradient id="g" cx="38%" cy="30%"><stop offset="0%" stop-color="#c4f2e2"/><stop offset="55%" stop-color="#3fae83"/><stop offset="100%" stop-color="#1f7d5c"/></radialGradient></defs>
    <circle class="body" cx="50" cy="50" r="36" fill="url(#g)"/>
    <ellipse class="eye e1" cx="41" cy="47" rx="4.5" ry="6" fill="#0e1014"/>
    <ellipse class="eye e2" cx="59" cy="47" rx="4.5" ry="6" fill="#0e1014"/>
    <path class="mouth" d="M44 61 Q50 65 56 61" stroke="#0e1014" stroke-width="3" fill="none" stroke-linecap="round"/>`)
  const bodies = { lumi, spark, orb }
  return `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><style>
  html, body { margin: 0; height: 100%; background: transparent; overflow: hidden; user-select: none; cursor: grab; }
  #stage { width: 100vw; height: 100vh; display: flex; align-items: center; justify-content: center;
           -webkit-app-region: drag; }
  svg { width: 100%; height: 100%; }
  .body { transform-origin: 50% 60%; animation: idle 4.2s ease-in-out infinite; }
  .eye { transform-origin: center; }
  @keyframes idle { 0%,100% { transform: translateY(0) scale(1); } 50% { transform: translateY(-4%) scale(1.02); } }
  @keyframes thinking { 0%,100% { transform: translateY(0) rotate(-4deg) scale(.98); } 50% { transform: translateY(-10%) rotate(5deg) scale(1.04); } }
  @keyframes speaking { 0%,100% { transform: scale(1); } 25% { transform: scale(1.06,.94); } 50% { transform: scale(.96,1.06); } 75% { transform: scale(1.05,.97); } }
  @keyframes listening { 0%,100% { transform: scale(1); opacity: 1; } 50% { transform: scale(1.1); opacity: .85; } }
  @keyframes working { 0% { transform: rotate(0); } 100% { transform: rotate(360deg); } }
  #stage[data-state="thinking"] .body { animation: thinking 1.6s ease-in-out infinite; }
  #stage[data-state="speaking"] .body { animation: speaking 1.1s ease-in-out infinite; }
  #stage[data-state="listening"] .body { animation: listening 1.2s ease-in-out infinite; }
  #stage[data-state="working"] .body, #stage[data-state="searching"] .body { animation: working 2.6s linear infinite; }
  #bubble { position: absolute; left: 50%; transform: translateX(-50%); bottom: 4%;
    max-width: 92%; background: rgba(14,16,20,.85); color: #e8eaf0; font: 12px/1.4 'Segoe UI', sans-serif;
    padding: 6px 10px; border-radius: 10px; display: none; -webkit-app-region: no-drag; }
  #stage.has-bubble #bubble { display: block; }
</style></head>
<body><div id="stage" data-state="idle">
  ${bodies.lumi}
  <div id="bubble"></div>
</div>
<script>
  // Состояние персонажа — из движка (SSE, только loopback). Данные приватности:
  // оверлей читает только state/label/detail, никакие чаты не проходят через него.
  let char = 'lumi'
  const BODIES = { lumi: ${JSON.stringify(lumi)}, spark: ${JSON.stringify(spark)}, orb: ${JSON.stringify(orb)} }
  const stage = document.getElementById('stage')
  const bubble = document.getElementById('bubble')
  function setChar(name) { if (BODIES[name]) { const b = document.createElement('div'); stage.innerHTML = ''; stage.insertAdjacentHTML('afterbegin', BODIES[name]); stage.appendChild(bubble); } }
  function setState(s, detail) {
    stage.dataset.state = ['idle','listening','thinking','speaking','working','searching'].includes(s) ? s : 'idle'
    if (detail && s !== 'idle') { bubble.textContent = String(detail).slice(0, 120); stage.classList.add('has-bubble') }
    else { bubble.textContent = ''; stage.classList.remove('has-bubble') }
  }
  // Настройки: персонаж/размер/прозрачность/позиция.
  async function loadSettings() {
    try {
      const r = await fetch('${ENGINE}/api/companion/status')
      const st = await r.json()
      setChar(st.settings?.character ?? 'lumi')
      const px = Math.max(80, Math.min(280, Number(st.settings?.size) || 140))
      document.getElementById('stage').style.width = px + 'px'
      document.getElementById('stage').style.height = px + 'px'
      document.body.style.opacity = String(Math.max(.4, Math.min(1, Number(st.settings?.opacity) || .95)))
    } catch {}
  }
  loadSettings()
  setInterval(loadSettings, 15000)
  const es = new EventSource('${ENGINE}/api/companion/events/stream')
  es.onmessage = (ev) => {
    try {
      const m = JSON.parse(ev.data)
      if (m.type === 'state') setState(m.state, m.detail)
      else if (m.type === 'hello' && m.status) setState(m.status.state, m.status.stateDetail)
      else if (m.type === 'settings') setChar(m.settings?.character ?? 'lumi')
    } catch {}
  }
  // Сохранение позиции при перетаскивании (после отпускания мыши).
  let saveTimer = null
  window.addEventListener('mouseup', () => {
    clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
      // Позицию окна знает main-процесс — сообщаем через уникальный хеш-флаг:
      // main читает window bounds по таймеру и сохраняет сам (см. overlay.ts).
    }, 400)
  })
</script></body></html>`
}

/** Создать/показать оверлей персонажа. Идемпотентно. */
export function showCompanionOverlay(settings: { size?: number; position?: { x: number; y: number } | null } = {}): BrowserWindow {
  if (overlay && !overlay.isDestroyed()) {
    overlay.show()
    overlay.moveTop()
    return overlay
  }
  const size = Math.max(80, Math.min(280, Number(settings.size) || 140))
  const primary = electronScreen.getPrimaryDisplay().workArea
  const x = Number.isFinite(settings.position?.x) ? Number(settings.position!.x) : primary.width - size - 40
  const y = Number.isFinite(settings.position?.y) ? Number(settings.position!.y) : primary.height - size - 60
  overlay = new BrowserWindow({
    width: size,
    height: size,
    x: Math.round(x),
    y: Math.round(y),
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    hasShadow: false,
    focusable: false, // персонаж не ворует фокус у приложений
    webPreferences: { offscreen: false },
  })
  overlay.setAlwaysOnTop(true, "screen-saver")
  overlay.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(overlayHtml())}`).catch(() => {})
  // Пересохраняем позицию после перетаскивания (компаньон §1: положение настраивается).
  let saveTimer: NodeJS.Timeout | null = null
  const onMove = () => {
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
      if (!overlay || overlay.isDestroyed()) return
      const [bx, by] = overlay.getPosition()
      void fetch(`${ENGINE}/api/companion/settings`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ position: { x: bx, y: by } }),
      }).catch(() => {})
    }, 600)
  }
  overlay.on("move", onMove)
  overlay.on("closed", () => { overlay = null })
  log.info("[companion] overlay shown", { size, x, y })
  return overlay
}

export function hideCompanionOverlay(): void {
  if (overlay && !overlay.isDestroyed()) overlay.hide()
}

export function toggleCompanionOverlay(): void {
  if (overlay && !overlay.isDestroyed() && overlay.isVisible()) hideCompanionOverlay()
  else void ensureCompanionOverlay()
}

export function isCompanionOverlayVisible(): boolean {
  return Boolean(overlay && !overlay.isDestroyed() && overlay.isVisible())
}

export function destroyCompanionOverlay(): void {
  if (overlay && !overlay.isDestroyed()) overlay.destroy()
  overlay = null
}

/** Показать оверлей, если компаньон включён и не скрыт пользователем. */
export async function ensureCompanionOverlay(): Promise<void> {
  try {
    const res = await fetch(`${ENGINE}/api/companion/status`, { signal: AbortSignal.timeout(1500) })
    if (!res.ok) return
    const st = (await res.json()) as { settings?: { enabled?: boolean; size?: number; position?: { x: number; y: number } | null } }
    if (st.settings?.enabled) showCompanionOverlay(st.settings ?? {})
  } catch {
    // движок ещё поднимается — оверлей появится позже (syncCompanion)
  }
}

/**
 * Периодическая синхронизация компаньона: оверлей появляется/исчезает по
 * настройке enabled, позиция сохраняется, автозапуск Windows (напоминания
 * переживают перезагрузку, ТЗ §4).
 */
export function startCompanionSync(onAutostartChange: (enabled: boolean) => void): void {
  let lastAutostart: boolean | null = null
  setInterval(async () => {
    try {
      const res = await fetch(`${ENGINE}/api/companion/status`, { signal: AbortSignal.timeout(1500) })
      if (!res.ok) return
      const st = (await res.json()) as { settings?: { enabled?: boolean; size?: number; autostart?: boolean; autoShowOnStart?: boolean } }
      const enabled = st.settings?.enabled === true
      if (enabled && !isCompanionOverlayVisible()) showCompanionOverlay(st.settings ?? {})
      else if (!enabled && isCompanionOverlayVisible()) destroyCompanionOverlay()
      const auto = st.settings?.autostart === true
      if (auto !== lastAutostart) {
        lastAutostart = auto
        onAutostartChange(auto)
      }
    } catch {
      // движок недоступен — ничего не делаем
    }
  }, 10_000)
  void ensureCompanionOverlay()
}

/** Файл-флаг для тестов: оверлей работает (используется smoke-проверкой). */
export function overlayStateFile(): string {
  return path.join(app.getPath("userData"), "companion-overlay.active")
}

export function writeOverlayState(active: boolean): void {
  try {
    if (active) fs.writeFileSync(overlayStateFile(), new Date().toISOString())
    else fs.rmSync(overlayStateFile(), { force: true })
  } catch { /* некритично */ }
}
