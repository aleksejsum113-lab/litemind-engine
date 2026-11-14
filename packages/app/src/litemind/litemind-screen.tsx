/**
 * LiteMind Engine — нативный экран внутри OpenCode Desktop (ТЗ §5:
 * «каталог, загрузки, железо, настройки, мониторинг — часть одного приложения»).
 *
 * Все разделы живут в одном окне: Мои модели, Каталог моделей, Загрузки,
 * Железо, Мониторинг, Настройки. Данные берутся с локального движка
 * (127.0.0.1:8399), который поднимается вместе с Desktop. Никакого браузера.
 */
import { createResource, createSignal, onCleanup, onMount, Show, For, Switch, Match } from "solid-js"
import { useSearchParams } from "@solidjs/router"

const ENGINE = "http://127.0.0.1:8399"

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(ENGINE + path, { headers: { "content-type": "application/json" }, ...init })
  if (!res.ok) {
    let message = `HTTP ${res.status}`
    try {
      const data = await res.json()
      message = data.error?.message ?? message
    } catch {}
    throw new Error(message)
  }
  return res.json() as Promise<T>
}

const fmtBytes = (n: number | null | undefined) => {
  if (n == null) return "—"
  const units = ["Б", "КБ", "МБ", "ГБ", "ТБ"]
  let i = 0
  let v = n
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++ }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units[i]}`
}
const fmtSpeed = (n: number | null | undefined) => (n ? `${fmtBytes(n)}/с` : "—")
const fmtEta = (s: number | null | undefined) => {
  if (s == null) return ""
  if (s < 60) return `${s} с`
  if (s < 3600) return `${Math.floor(s / 60)} мин ${s % 60} с`
  return `${Math.floor(s / 3600)} ч ${Math.floor((s % 3600) / 60)} мин`
}

export type Section = "control" | "models" | "catalog" | "downloads" | "hardware" | "monitor" | "settings"

const SECTIONS: { id: Section; title: string }[] = [
  { id: "control", title: "Управление" },
  { id: "models", title: "Мои модели" },
  { id: "catalog", title: "Каталог моделей" },
  { id: "downloads", title: "Загрузки" },
  { id: "hardware", title: "Железо" },
  { id: "monitor", title: "Мониторинг" },
  { id: "settings", title: "Настройки" },
]

function Card(props: { title?: string; children: any; class?: string }) {
  return (
    <div class={`rounded-lg border border-v2-stroke-stroke-soft bg-v2-bg-bg-raised p-4 ${props.class ?? ""}`}>
      <Show when={props.title}>
        <div class="mb-3 text-[13px] font-semibold text-v2-text-text-primary">{props.title}</div>
      </Show>
      {props.children}
    </div>
  )
}

function Btn(props: { onClick: () => void; children: any; disabled?: boolean; danger?: boolean }) {
  return (
    <button
      type="button"
      disabled={props.disabled}
      onClick={props.onClick}
      class={`rounded-md border border-v2-stroke-stroke-soft px-2.5 py-1 text-xs font-medium transition-colors disabled:opacity-40 ${
        props.danger
          ? "text-red-400 hover:bg-red-500/10"
          : "text-v2-text-text-primary hover:bg-v2-fill-fill-hover"
      }`}
    >
      {props.children}
    </button>
  )
}

function Row(props: { label: string; value: any }) {
  return (
    <div class="flex items-center justify-between gap-4 py-1 text-[13px]">
      <span class="text-v2-text-text-faint">{props.label}</span>
      <span class="text-right font-medium text-v2-text-text-primary">{props.value}</span>
    </div>
  )
}

function ErrorBanner(props: { error: unknown }) {
  return (
    <div class="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[13px] text-amber-500">
      Движок недоступен: {(props.error as Error)?.message ?? "неизвестная ошибка"}. LiteMind Desktop
      запускает движок автоматически — если он не поднялся, проверьте, не занят ли порт 8399.
    </div>
  )
}

// ------------------------------------------------- Управление движком (ТЗ §16)

/**
 * Мост к Electron main-процессу (запуск/остановка движка, выход). В браузерной
 * dev-версии моста нет — остаются только HTTP-команды движку.
 */
const engineBridge = (): { control: (action: "status" | "start" | "stop" | "quit") => Promise<any> } | null =>
  typeof window !== "undefined" ? ((window as any).electron?.litemindEngine ?? null) : null

const ENGINE_STATE_LABEL: Record<string, string> = {
  running: "Движок запущен",
  stopping: "Движок останавливается…",
  stopped: "Движок полностью остановлен",
}

const MODEL_STATE_LABEL: Record<string, string> = {
  loading: "Модель загружается…",
  running: "Модель работает",
  stopping: "Модель останавливается…",
  stopped: "Модель остановлена",
}

const MODEL_STATE_COLOR: Record<string, string> = {
  loading: "text-blue-400",
  running: "text-green-500",
  stopping: "text-amber-500",
  stopped: "text-v2-text-text-faint",
}

type EngineState = {
  engine: string
  since: number
  models: { id: string; state: string }[]
  backend: { type: string; healthy: boolean; error: string | null }
  queue: { active: number; waiting: number }
  downloads: number
  metrics: { availableRamMb?: number | null; totalRamMb?: number | null; cpuPercent?: number | null } | null
}

type StopReport = {
  verified?: boolean
  cancelledRequests?: number
  unloaded?: string[]
  ram?: { availableRamMbBefore: number | null; availableRamMbAfter: number | null; freedMb: number | null }
}

const fmtRam = (mb: number | null | undefined) => (mb != null ? fmtBytes(mb * 1024 * 1024) : "—")

function FreedRamLine(props: { ram: StopReport["ram"] }) {
  return (
    <Show
      when={props.ram?.freedMb != null}
      fallback={<div class="text-xs text-v2-text-text-faint">RAM до: {fmtRam(props.ram?.availableRamMbBefore)} доступно · после: {fmtRam(props.ram?.availableRamMbAfter)} доступно</div>}
    >
      <div class="text-xs text-green-500">
        Освобождено ≈ {fmtRam(props.ram!.freedMb)} RAM (было доступно {fmtRam(props.ram!.availableRamMbBefore)}, стало {fmtRam(props.ram!.availableRamMbAfter)}).
      </div>
    </Show>
  )
}

function ControlSection() {
  const [state, setState] = createSignal<EngineState | null>(null)
  const [offline, setOffline] = createSignal(false)
  const [busy, setBusy] = createSignal<string | null>(null)
  const [report, setReport] = createSignal<{ kind: "stopAll" | "stopEngine" | "error"; text: string; ram?: StopReport["ram"] } | null>(null)
  const [hostInfo, setHostInfo] = createSignal<any>(null)
  let timer: ReturnType<typeof setInterval> | undefined

  const bridge = engineBridge()

  const refresh = async () => {
    try {
      const s = await api<EngineState>("/api/engine/state")
      setState(s)
      setOffline(false)
    } catch {
      setOffline(true)
      setState(null)
    }
    if (bridge) setHostInfo(await bridge.control("status").catch(() => null))
  }

  onMount(() => {
    refresh()
    timer = setInterval(refresh, 1500)
  })
  onCleanup(() => clearInterval(timer))

  const stopAllModels = async () => {
    setBusy("stop-all")
    setReport(null)
    try {
      const r = await api<StopReport>("/api/models/stop-all", { method: "POST", body: JSON.stringify({}) })
      setReport({
        kind: "stopAll",
        text: r.verified
          ? `Все модели остановлены и выгружены из RAM/VRAM${r.unloaded?.length ? ` (${r.unloaded.join(", ")})` : ""}. Выгрузка подтверждена опросом бэкенда.`
          : "Модели остановлены, но бэкенд не подтвердил выгрузку — проверьте Мониторинг.",
        ram: r.ram,
      })
      refresh()
    } catch (e) {
      setReport({ kind: "error", text: (e as Error).message })
    } finally {
      setBusy(null)
    }
  }

  const stopEngine = async () => {
    setBusy("stop-engine")
    setReport(null)
    try {
      await api("/api/engine/stop", { method: "POST", body: JSON.stringify({}) })
      setReport({ kind: "stopEngine", text: "Движок останавливается: генерации отменены, загрузки остановлены, модели выгружаются из RAM/VRAM, сервер закрывается." })
      // Ждём фактической остановки и обновляем карточку состояний.
      setTimeout(refresh, 800)
      setTimeout(refresh, 2500)
    } catch (e) {
      // Соединение рвётся при закрытии сервера — это и есть успешная остановка.
      if (String((e as Error).message).includes("Failed to fetch") || String((e as Error).message).includes("fetch failed")) {
        setReport({ kind: "stopEngine", text: "Движок полностью остановлен: сервер закрыт, модели выгружены." })
        refresh()
      } else {
        setReport({ kind: "error", text: (e as Error).message })
      }
    } finally {
      setBusy(null)
    }
  }

  const startEngine = async () => {
    if (!bridge) {
      setReport({ kind: "error", text: "Запуск доступен в LiteMind Desktop (мост Electron недоступен в браузере). Запустите приложение — движок стартует автоматически." })
      return
    }
    setBusy("start-engine")
    setReport(null)
    try {
      const r = await bridge.control("start")
      setReport({ kind: "stopEngine", text: r?.ok ? "Движок запущен." : `Не удалось запустить: ${r?.error ?? "неизвестная ошибка"}` })
      refresh()
    } finally {
      setBusy(null)
    }
  }

  const quitApp = async () => {
    if (!bridge) {
      setReport({ kind: "error", text: "Выход доступен в LiteMind Desktop: закройте окно приложения — движок будет остановлен корректно." })
      return
    }
    setBusy("quit")
    await bridge.control("quit").catch(() => {})
  }

  const engineLabel = () => {
    if (offline()) return ENGINE_STATE_LABEL.stopped
    const s = state()
    if (!s) return "Уточняю состояние…"
    return ENGINE_STATE_LABEL[s.engine] ?? s.engine
  }
  const engineColor = () => {
    if (offline()) return "text-v2-text-text-faint"
    const s = state()?.engine
    return s === "running" ? "text-green-500" : s === "stopping" ? "text-amber-500" : "text-v2-text-text-faint"
  }

  return (
    <div class="flex flex-col gap-4">
      <Card title="Состояние">
        <div class="flex flex-wrap items-center gap-x-8 gap-y-2">
          <div>
            <div class={`text-[15px] font-semibold ${engineColor()}`}>{engineLabel()}</div>
            <Show when={!offline() && state()?.backend?.healthy === false}>
              <div class="mt-1 text-xs text-amber-500">Runtime (Ollama) не отвечает: {state()?.backend?.error ?? "—"}. Модели не запущены — CPU и память не заняты.</div>
            </Show>
          </div>
          <div class="text-[13px] text-v2-text-text-faint">
            <div>Активных генераций / в очереди: {offline() ? "0 / 0" : `${state()?.queue?.active ?? 0} / ${state()?.queue?.waiting ?? 0}`}</div>
            <div>Активных загрузок: {offline() ? "0" : (state()?.downloads ?? 0)}</div>
            <Show when={!offline() && state()?.metrics}>
              <div>RAM доступно: {fmtRam(state()?.metrics?.availableRamMb)} из {fmtRam(state()?.metrics?.totalRamMb)}</div>
            </Show>
          </div>
        </div>
        <Show when={!offline() && (state()?.models ?? []).length > 0}>
          <div class="mt-3 flex flex-col gap-1">
            <For each={state()!.models}>
              {(m) => (
                <div class="flex items-center justify-between text-[13px]">
                  <span class="text-v2-text-text-primary">{m.id}</span>
                  <span class={MODEL_STATE_COLOR[m.state] ?? ""}>{MODEL_STATE_LABEL[m.state] ?? m.state}</span>
                </div>
              )}
            </For>
          </div>
        </Show>
        <Show when={offline()}>
          <div class="mt-2 text-xs text-v2-text-text-faint">
            Сервер движка не отвечает — LiteMind не использует ресурсы компьютера для работы моделей.
            {bridge ? " Нажмите «Запустить движок», чтобы продолжить работу." : ""}
          </div>
        </Show>
      </Card>

      <Card title="Управление">
        <div class="flex flex-wrap gap-2">
          <Show when={offline() || state()?.engine === "stopped"}>
            <Btn disabled={busy() != null} onClick={startEngine}>Запустить движок</Btn>
          </Show>
          <Btn disabled={busy() != null || offline()} onClick={stopAllModels}>
            {busy() === "stop-all" ? "Останавливаю модели…" : "Остановить все модели"}
          </Btn>
          <Btn danger disabled={busy() != null || offline()} onClick={stopEngine}>
            {busy() === "stop-engine" ? "Останавливаю движок…" : "Остановить движок"}
          </Btn>
          <Btn danger disabled={busy() != null} onClick={quitApp}>Выход</Btn>
        </div>
        <div class="mt-2 text-xs text-v2-text-text-faint">
          «Остановить все модели» — генерации отменяются, модели выгружаются из RAM/VRAM, приложение продолжает работать.
          «Остановить движок» — дополнительно останавливаются загрузки и сервер движка; приложение остаётся открытым, движок можно запустить заново.
          «Выход» — сначала останавливает все процессы LiteMind, затем закрывает приложение.
        </div>
      </Card>

      <Show when={report()}>
        <div
          class={`rounded-md border px-3 py-2 text-[13px] ${
            report()!.kind === "error"
              ? "border-red-500/40 bg-red-500/10 text-red-400"
              : "border-v2-stroke-stroke-soft bg-v2-bg-bg-subtle text-v2-text-text-secondary"
          }`}
        >
          {report()!.text}
          <Show when={report()!.ram && report()!.kind === "stopAll"}>
            <div class="mt-1"><FreedRamLine ram={report()!.ram} /></div>
          </Show>
        </div>
      </Show>

      <Show when={hostInfo()?.host}>
        <Card title="Хост (LiteMind Desktop)">
          <Row label="Процесс движка в приложении" value={hostInfo().host.owned ? "запущен приложением" : "сторонний/усыновлён"} />
          <Row label="Состояние хоста" value={hostInfo().host.state} />
          <Row label="Движок отвечает по HTTP" value={hostInfo().reachable ? "да" : "нет"} />
        </Card>
      </Show>
    </div>
  )
}

// ---------------------------------------------------------------- Мои модели

type OptimizeInfo = { threads?: number; tokensPerSecond?: number; ttftMs?: number; measuredAt?: string; advice?: string }

function ModelsSection() {
  const [status, { refetch }] = createResource(() => api<any>("/api/status"))
  const [opt, { refetch: refetchOpt }] = createResource(() => api<any>("/api/optimize"))
  const [busy, setBusy] = createSignal<string | null>(null)
  const [report, setReport] = createSignal<OptimizeInfo | null>(null)
  const [stopInfo, setStopInfo] = createSignal<{ model: string; verified: boolean; ram?: StopReport["ram"] } | null>(null)

  const optimize = async (model: string) => {
    setBusy(model)
    setReport(null)
    try {
      const r = await api<OptimizeInfo>("/api/optimize", { method: "POST", body: JSON.stringify({ model }) })
      setReport(r)
      refetchOpt()
    } catch (e) {
      setReport({ advice: (e as Error).message })
    } finally {
      setBusy(null)
    }
  }

  const stopModel = async (model: string) => {
    setBusy(model)
    setStopInfo(null)
    try {
      const r = await api<StopReport>("/api/models/stop", { method: "POST", body: JSON.stringify({ model }) })
      setStopInfo({ model, verified: r.verified ?? false, ram: r.ram })
      refetch()
    } catch (e) {
      setStopInfo({ model, verified: false })
    } finally {
      setBusy(null)
    }
  }

  return (
    <div class="flex flex-col gap-4">
      <For each={status()?.models ?? []}>
        {(m: any) => {
          const o = () => opt()?.optimizations?.[m.id] as OptimizeInfo | undefined
          return (
            <Card>
              <div class="flex flex-wrap items-center justify-between gap-2">
                <div class="text-[14px] font-semibold text-v2-text-text-primary">{m.id}</div>
                <div class="flex gap-2">
                  <Btn disabled={busy() === m.id} onClick={() => optimize(m.id)}>
                    {busy() === m.id ? "Измеряю…" : "Автооптимизация"}
                  </Btn>
                  <Btn disabled={busy() === m.id} onClick={() => stopModel(m.id)}>
                    {busy() === m.id ? "Останавливаю…" : "Остановить модель"}
                  </Btn>
                </div>
                <Show when={stopInfo()?.model === m.id}>
                  <div class="mt-2 rounded-md border border-v2-stroke-stroke-soft bg-v2-bg-bg-subtle px-3 py-2 text-xs text-v2-text-text-secondary">
                    {stopInfo()!.verified
                      ? "Генерации отменены, модель выгружена из RAM/VRAM (подтверждено опросом бэкенда)."
                      : "Команда отправлена, но выгрузка не подтверждена — проверьте «Управление»."}
                    <Show when={stopInfo()!.ram}><div class="mt-1"><FreedRamLine ram={stopInfo()!.ram} /></div></Show>
                  </div>
                </Show>
              </div>
              <div class="mt-2 grid grid-cols-2 gap-x-6 md:grid-cols-4">
                <Row label="Размер" value={fmtBytes(m.sizeBytes)} />
                <Row label="Квант" value={m.quantization ?? "—"} />
                <Row label="Потоки" value={o()?.threads ?? "авто"} />
                <Row label="tokens/sec" value={o()?.tokensPerSecond ?? "—"} />
                <Row label="TTFT" value={o()?.ttftMs != null ? `${Math.round(o()!.ttftMs!)} мс` : "—"} />
                <Row label="Контекст" value={status()?.limits?.contextTokens ?? "—"} />
              </div>
            </Card>
          )
        }}
      </For>
      <Show when={report()}>
        <div class="rounded-md border border-v2-stroke-stroke-soft bg-v2-bg-bg-subtle px-3 py-2 text-[13px] text-v2-text-text-secondary">
          {report()!.advice}
        </div>
      </Show>
      <Show when={status() && (status().models ?? []).length === 0}>
        <Card>
          <div class="text-[13px] text-v2-text-text-faint">
            Моделей пока нет. Откройте «Каталог моделей» и скачайте подходящую — движок сам выберет квантование под ваше железо.
          </div>
        </Card>
      </Show>
    </div>
  )
}

// ---------------------------------------------------------------- Каталог

type CatalogFilters = {
  purpose: "all" | "coding" | "chat" | "russian" | "reasoning"
  restrictions: "all" | "standard" | "reduced"
  fit: "all" | "fit" | "great"
  size: "all" | "lt1" | "b1to4" | "gt4"
  quant: string
}

const QUANT_FILTERS = ["all", "Q2_K", "Q3_K_M", "Q4_K_M", "Q5_K_M", "Q6_K", "Q8_0"]

const FIT_BADGE: Record<string, string> = {
  great: "bg-green-500/15 text-green-500",
  ok: "bg-yellow-500/15 text-yellow-600",
  slow: "bg-amber-500/15 text-amber-500",
  avoid: "bg-red-500/15 text-red-400",
}

function FilterChip<T extends string>(props: { active: boolean; onClick: () => void; children: any }) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      class={`rounded-full border px-3 py-1 text-xs transition-colors ${
        props.active
          ? "border-v2-accent-accent bg-v2-accent-accent/15 text-v2-accent-accent"
          : "border-v2-fill-fill-hover text-v2-text-text-faint hover:text-v2-text-text-primary"
      }`}
    >
      {props.children}
    </button>
  )
}

function CatalogSection() {
  const [catalog, { refetch }] = createResource(() => api<any>("/api/catalog"))
  const [busy, setBusy] = createSignal<string | null>(null)
  const [error, setError] = createSignal<string | null>(null)
  const [notice, setNotice] = createSignal<{ id: string; text: string; ok: boolean } | null>(null)
  const [filters, setFilters] = createSignal<CatalogFilters>({
    purpose: "all",
    restrictions: "all",
    fit: "all",
    size: "all",
    quant: "all",
  })
  const setF = (k: keyof CatalogFilters, v: string) => setFilters((f) => ({ ...f, [k]: v }) as CatalogFilters)

  const download = async (m: any) => {
    setBusy(m.id)
    setError(null)
    setNotice(null)
    try {
      await api("/api/downloads", { method: "POST", body: JSON.stringify({ modelId: m.id, fileName: m.compatibility?.recommended?.name }) })
      refetch()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const verify = async (m: any) => {
    setBusy(m.id)
    setNotice(null)
    setError(null)
    try {
      const r = await api<any>("/api/models/verify", { method: "POST", body: JSON.stringify({ modelId: m.id }) })
      setNotice({ id: m.id, ok: r.verified, text: r.message })
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const run = async (m: any) => {
    setBusy(m.id)
    setNotice(null)
    setError(null)
    try {
      const r = await api<any>("/api/models/run", { method: "POST", body: JSON.stringify({ modelId: m.id }) })
      setNotice({
        id: m.id,
        ok: r.ok,
        text: r.ok
          ? `Модель запущена (${r.quant ?? r.file}). Откройте AI Chat и спросите что-нибудь.`
          : r.message,
      })
      refetch()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const stop = async (m: any) => {
    setBusy(m.id)
    setNotice(null)
    try {
      await api("/api/models/stop", { method: "POST", body: JSON.stringify({ model: m.ollamaName }) })
      setNotice({ id: m.id, ok: true, text: "Модель остановлена и выгружена из RAM." })
      refetch()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const remove = async (m: any) => {
    const file = m.compatibility?.recommended?.name
    if (!file) return
    if (!confirm(`Удалить ${m.displayName} (${file}) с диска? Модель можно скачать заново.`)) return
    setBusy(m.id)
    setNotice(null)
    try {
      await api(`/api/models/delete/${encodeURIComponent(file.replace(/\.gguf$/, ""))}`, { method: "DELETE" })
      setNotice({ id: m.id, ok: true, text: "Модель удалена с диска." })
      refetch()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const openInChat = (m: any) => {
    window.open(`${ENGINE}/?model=${encodeURIComponent(m.ollamaName)}`, "_blank")
  }

  const filtered = () =>
    (catalog()?.models ?? []).filter((m: any) => {
      const f = filters()
      if (f.purpose !== "all" && !m.tags?.includes(f.purpose)) return false
      if (f.restrictions !== "all" && m.restrictions !== f.restrictions) return false
      if (f.fit === "great" && m.compatibility?.fit !== "great") return false
      if (f.fit === "fit" && (m.compatibility?.status === "red")) return false
      if (f.size === "lt1" && parseFloat(m.params) >= 1) return false
      if (f.size === "b1to4" && !(parseFloat(m.params) >= 1 && parseFloat(m.params) <= 4.5)) return false
      if (f.size === "gt4" && parseFloat(m.params) <= 4.5) return false
      if (f.quant !== "all" && !m.files?.some((x: any) => x.quant === f.quant)) return false
      return true
    })

  const grouped = () => {
    const groups: Record<string, any[]> = {}
    for (const m of filtered()) (groups[m.category] ??= []).push(m)
    return groups
  }

  const chip = (k: keyof CatalogFilters, v: string, label: string) => (
    <FilterChip active={filters()[k] === v} onClick={() => setF(k, v)}>{label}</FilterChip>
  )

  return (
    <div class="flex flex-col gap-4">
      <Show when={catalog()}>
        <div class="text-[13px] text-v2-text-text-faint">
          Железо: {catalog().hardware?.cpu?.model} · RAM {fmtBytes((catalog().hardware?.totalRamMb ?? 0) * 1024 * 1024)} ·{" "}
          <span class={catalog().hardware?.cpu?.avx === false ? "text-amber-500" : ""}>
            {catalog().hardware?.cpu?.avx === false ? "без AVX/AVX2 — выбраны совместимые сборки" : "AVX доступен"}
          </span>
        </div>
      </Show>

      {/* Фильтры */}
      <div class="flex flex-col gap-2 rounded-lg border border-v2-fill-fill-hover/40 p-3">
        <div class="flex flex-wrap items-center gap-1.5">
          <span class="mr-1 text-[11px] uppercase text-v2-text-text-faint">Задача:</span>
          {chip("purpose", "all", "Все")}
          {chip("purpose", "chat", "Общение")}
          {chip("purpose", "coding", "Программирование")}
          {chip("purpose", "russian", "Русский язык")}
          {chip("purpose", "reasoning", "Логика и анализ")}
        </div>
        <div class="flex flex-wrap items-center gap-1.5">
          <span class="mr-1 text-[11px] uppercase text-v2-text-text-faint">Ограничения:</span>
          {chip("restrictions", "all", "Все")}
          {chip("restrictions", "standard", "Обычные")}
          {chip("restrictions", "reduced", "Ослабленные")}
        </div>
        <div class="flex flex-wrap items-center gap-1.5">
          <span class="mr-1 text-[11px] uppercase text-v2-text-text-faint">Совместимость:</span>
          {chip("fit", "all", "Все")}
          {chip("fit", "fit", "Для моего ПК")}
          {chip("fit", "great", "Только отличные")}
        </div>
        <div class="flex flex-wrap items-center gap-1.5">
          <span class="mr-1 text-[11px] uppercase text-v2-text-text-faint">Размер:</span>
          {chip("size", "all", "Любой")}
          {chip("size", "lt1", "до 1B")}
          {chip("size", "b1to4", "1–4B")}
          {chip("size", "gt4", "5B+")}
        </div>
        <div class="flex flex-wrap items-center gap-1.5">
          <span class="mr-1 text-[11px] uppercase text-v2-text-text-faint">Квант:</span>
          <For each={QUANT_FILTERS}>{(q) => chip("quant", q, q === "all" ? "Любой" : q)}</For>
        </div>
      </div>

      <Show when={error()}>
        <div class="rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-[13px] text-red-400">{error()}</div>
      </Show>

      <For each={Object.entries(grouped())}>
        {([cat, models]) => (
          <div>
            <div class="mb-2 mt-4 text-[11px] font-semibold uppercase tracking-wider text-v2-text-text-faint">
              {catalog()?.categories?.[cat] ?? cat}
            </div>
            <div class="flex flex-col gap-3">
              <For each={models}>
                {(m: any) => (
                  <Card>
                    <div class="flex flex-wrap items-start justify-between gap-2">
                      <div class="min-w-0 flex-1">
                        <div class="flex flex-wrap items-center gap-1.5">
                          <span class="text-[14px] font-semibold text-v2-text-text-primary">{m.displayName}</span>
                          <Show when={m.restrictions === "reduced"}>
                            <span class="rounded bg-v2-fill-fill-hover px-1.5 py-0.5 text-[10px] font-medium text-amber-500">
                              {m.uncensoredLabel ?? "ослабленные ограничения"}
                            </span>
                          </Show>
                          <span class={`rounded px-1.5 py-0.5 text-[10px] font-medium ${FIT_BADGE[m.compatibility?.fit] ?? ""}`}>
                            {m.compatibility?.fitLabel ?? "не рекомендуется"}
                          </span>
                        </div>
                        <div class="mt-1 text-xs text-v2-text-text-faint">{m.purpose}</div>
                        <div class="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-v2-text-text-faint">
                          <span>{m.params}</span>
                          <span>Контекст: {(m.contextTokens / 1024).toFixed(0)}k</span>
                          <span>Языки: {(m.languages ?? []).join(", ")}</span>
                          <span>Кванты: {(m.files ?? []).map((f: any) => f.quant).join(", ")}</span>
                          <span>Лицензия: {m.license}</span>
                          <span>Квантовал: {m.quantAuthor}</span>
                        </div>
                        <div class="mt-0.5 text-[11px] text-v2-text-text-faint">{m.quality}</div>
                      </div>
                      <div class="flex flex-wrap items-center gap-2">
                        <Show when={m.compatibility?.recommended}>
                          <span class="text-xs text-v2-text-text-faint">
                            {m.compatibility.recommended.quant ? `${m.compatibility.recommended.quant} · ` : ""}
                            {fmtBytes(m.compatibility.recommended.sizeBytes)}
                          </span>
                        </Show>
                        <Show when={m.downloaded}>
                          <span class="text-xs text-green-500">скачана</span>
                        </Show>
                        <Show when={!m.downloaded}>
                          <Btn disabled={busy() === m.id || m.compatibility?.status === "red"} onClick={() => download(m)}>
                            {busy() === m.id ? "Скачиваю…" : "Скачать"}
                          </Btn>
                        </Show>
                        <Btn disabled={busy() === m.id || !m.downloaded} onClick={() => verify(m)}>Проверить файл</Btn>
                        <Btn disabled={busy() === m.id || !m.downloaded || m.compatibility?.status === "red"} onClick={() => run(m)}>
                          Запустить
                        </Btn>
                        <Btn disabled={busy() === m.id || !m.downloaded} onClick={() => openInChat(m)}>Открыть в AI Chat</Btn>
                        <Btn disabled={busy() === m.id || !m.downloaded} onClick={() => stop(m)}>Остановить</Btn>
                        <Btn disabled={busy() === m.id || !m.downloaded} onClick={() => remove(m)}>Удалить</Btn>
                      </div>
                    </div>
                    <Show when={m.compatibility?.speedNote}>
                      <div class="mt-2 text-[11px] text-amber-500">{m.compatibility.speedNote}</div>
                    </Show>
                    <Show when={notice()}>
                      {(n) => (
                        <Show when={n().id === m.id}>
                          <div class={`mt-2 rounded-md border px-3 py-2 text-[12px] ${n().ok ? "border-green-500/40 bg-green-500/10 text-green-500" : "border-amber-500/40 bg-amber-500/10 text-amber-500"}`}>
                            {n().text}
                          </div>
                        </Show>
                      )}
                    </Show>
                    <Show when={m.compatibility?.recommended}>
                      <div class="mt-2 text-[11px] text-v2-text-text-faint">
                        Рекомендуемый квант: {m.compatibility.recommended.name} ({fmtBytes(m.compatibility.recommended.sizeBytes)})
                        {m.compatibility?.reason ? ` · ${m.compatibility.reason}` : ""}
                      </div>
                    </Show>
                  </Card>
                )}
              </For>
            </div>
          </div>
        )}
      </For>
      <Show when={catalog() && filtered().length === 0}>
        <Card>
          <div class="text-[13px] text-v2-text-text-faint">Ничего не найдено — ослабьте фильтры.</div>
        </Card>
      </Show>
    </div>
  )
}

// ---------------------------------------------------------------- Загрузки

function DownloadsSection() {
  const [dl, { refetch }] = createResource(() => api<any>("/api/downloads"))
  let timer: ReturnType<typeof setInterval> | undefined
  onMount(() => { timer = setInterval(refetch, 1200) })
  onCleanup(() => clearInterval(timer))

  const act = (id: string, action: string) => api(`/api/downloads/${id}/${action}`, { method: "POST" }).then(refetch)

  return (
    <div class="flex flex-col gap-3">
      <Show when={(dl()?.downloads ?? []).length > 0} fallback={<div class="text-[13px] text-v2-text-text-faint">Активных загрузок нет.</div>}>
        <For each={dl()?.downloads ?? []}>
          {(d: any) => (
            <Card>
              <div class="flex flex-wrap items-center justify-between gap-2">
                <div class="text-[13px] font-semibold text-v2-text-text-primary">{d.name}</div>
                <div class="flex gap-2">
                  <Switch>
                    <Match when={d.state === "downloading"}>
                      <Btn onClick={() => act(d.id, "pause")}>Пауза</Btn>
                    </Match>
                    <Match when={d.state === "paused" || d.state === "error"}>
                      <Btn onClick={() => act(d.id, "resume")}>Продолжить</Btn>
                    </Match>
                  </Switch>
                  <Btn danger onClick={() => act(d.id, "cancel")}>Отменить</Btn>
                </div>
              </div>
              <div class="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-v2-fill-fill-hover">
                <div class="h-full rounded-full bg-blue-500 transition-all" style={{ width: `${d.percent ?? 0}%` }} />
              </div>
              <div class="mt-1 flex flex-wrap gap-x-4 text-xs text-v2-text-text-faint">
                <span>{d.percent ?? 0}%</span>
                <span>{fmtBytes(d.receivedBytes)} / {fmtBytes(d.sizeBytes)}</span>
                <Show when={d.state === "downloading"}>
                  <span>{fmtSpeed(d.speedBps)}</span>
                  <span>осталось {fmtEta(d.etaSeconds)}</span>
                </Show>
                <Show when={d.error}><span class="text-amber-500">{d.error}</span></Show>
              </div>
              <Show when={d.state === "done"}>
                <div class="mt-2">
                  <Btn onClick={() => api("/api/install", { method: "POST", body: JSON.stringify({ ggufPath: `${d.targetDir}/${d.name}` }) }).then(refetch)}>
                    Установить в движок
                  </Btn>
                </div>
              </Show>
            </Card>
          )}
        </For>
      </Show>
    </div>
  )
}

// ---------------------------------------------------------------- Железо

function HardwareSection() {
  const [hw, { refetch }] = createResource(() => api<any>("/api/hardware"))
  return (
    <div class="flex flex-col gap-4">
      <Show when={hw()} fallback={<div class="text-[13px] text-v2-text-text-faint">Анализ…</div>}>
        <Card title="Процессор">
          <Row label="Модель" value={hw().cpu?.model} />
          <Row label="Ядер" value={hw().cpu?.cores} />
          <Row label="AVX / AVX2" value={
            hw().cpu?.avx === false ? <span class="text-amber-500">нет (учтено при выборе моделей)</span> : hw().cpu?.avx ? "есть" : "неизвестно"
          } />
          <Row label="Метод определения" value={hw().cpu?.avxMethod} />
        </Card>
        <Card title="Память">
          <Row label="Всего RAM" value={fmtBytes((hw().totalRamMb ?? 0) * 1024 * 1024)} />
          <Row label="Свободно" value={fmtBytes((hw().freeRamMb ?? 0) * 1024 * 1024)} />
          <Row label="Резерв Windows" value={fmtBytes((hw().recommendation?.windowsReserveMb ?? 0) * 1024 * 1024)} />
          <Row label="Доступно моделям" value={fmtBytes((hw().recommendation?.usableModelRamMb ?? 0) * 1024 * 1024)} />
        </Card>
        <Show when={hw().gpu}>
          <Card title="GPU">
            <Row label="Модель" value={hw().gpu?.model} />
            <Row label="VRAM" value={fmtBytes((hw().gpu?.vramMb ?? 0) * 1024 * 1024)} />
            <div class="mt-1 text-xs text-v2-text-text-faint">{hw().gpu?.note}</div>
          </Card>
        </Show>
        <Card title="Диски">
          <For each={hw().disks ?? []}>
            {(d: any) => (
              <Show when={d.exists}>
                <Row label={d.root} value={`${fmtBytes(d.freeBytes)} свободно из ${fmtBytes(d.totalBytes)}`} />
              </Show>
            )}
          </For>
        </Card>
        <Card title="Рекомендация движка">
          <Row label="Профиль" value={hw().recommendation?.profile === "balanced" ? "Сбалансированный" : hw().recommendation?.profile} />
          <Row label="Потоков CPU для ИИ" value={hw().recommendation?.cpuThreads} />
          <Row label="Макс. контекст" value={`${hw().recommendation?.maxContextTokens} ток.`} />
          <div class="mt-2 text-xs text-v2-text-text-faint">{hw().recommendation?.avxNote}</div>
        </Card>
        <div class="pb-2">
          <Btn onClick={refetch}>Обновить анализ</Btn>
        </div>
      </Show>
    </div>
  )
}

// ---------------------------------------------------------------- Мониторинг

function MonitorSection() {
  const [status, { refetch: refetchStatus }] = createResource(() => api<any>("/api/status"))
  const [metrics, { refetch: refetchMetrics }] = createResource(() => api<any>("/api/metrics"))
  let timer: ReturnType<typeof setInterval> | undefined
  onMount(() => { timer = setInterval(() => { refetchStatus(); refetchMetrics() }, 2000) })
  onCleanup(() => clearInterval(timer))

  const m = () => metrics()?.perf?.last ?? metrics()?.history?.slice(-1)?.[0]
  const profileTitle = (p: string) => (p === "low" ? "Бережный" : p === "balanced" ? "Сбалансированный" : p === "high" ? "Производительный" : p)

  return (
    <div class="flex flex-col gap-4">
      <Card title="Профиль производительности">
        <div class="flex flex-wrap gap-2">
          <For each={["low", "balanced", "high"]}>
            {(p) => (
              <Btn onClick={() => api("/api/profile", { method: "POST", body: JSON.stringify({ profile: p }) }).then(() => refetchStatus())}>
                {profileTitle(p)}
              </Btn>
            )}
          </For>
        </div>
      </Card>
      <div class="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Card title="Система">
          <Row label="CPU" value={status()?.metrics?.cpuPercent != null ? `${Math.round(status().metrics.cpuPercent)} %` : "—"} />
          <Row label="RAM" value={status()?.metrics ? `${fmtBytes((status().metrics.usedRamMb ?? 0) * 1024 * 1024)} / ${fmtBytes((status().metrics.totalRamMb ?? 0) * 1024 * 1024)}` : "—"} />
          <Row label="Доступно" value={status()?.metrics ? fmtBytes((status().metrics.availableRamMb ?? 0) * 1024 * 1024) : "—"} />
        </Card>
        <Card title="Генерация (последний запрос)">
          <Row label="tokens/sec" value={m()?.tokensPerSecond ?? "—"} />
          <Row label="TTFT" value={m()?.ttftMs != null ? `${Math.round(m().ttftMs)} мс` : "—"} />
          <Row label="Сложность" value={m()?.complexity ?? "—"} />
          <Row label="Активных / в очереди" value={`${status()?.queue?.active ?? 0} / ${status()?.queue?.waiting ?? 0}`} />
        </Card>
      </div>
      <Card title="Adaptive Engine">
        <Row label="Уплотнений контекста" value={status()?.adaptive?.compacted ?? 0} />
        <Row label="Сообщений сэкономлено" value={status()?.adaptive?.tokensSaved ?? 0} />
        <Row label="Сохранённых профилей моделей" value={Object.keys(status()?.optimizations ?? {}).length} />
        <div class="mt-3 flex gap-2">
          <Btn danger onClick={() => api("/api/stop", { method: "POST" }).then(refetchStatus)}>Остановить генерацию</Btn>
          <Btn onClick={() => api("/api/unload", { method: "POST", body: "{}" }).then(refetchStatus)}>Выгрузить все модели</Btn>
        </div>
      </Card>
    </div>
  )
}

// ---------------------------------------------------------------- Настройки

function SettingsSection() {
  const [settings, { refetch }] = createResource(() => api<any>("/api/settings"))
  const [adaptive, { refetch: refetchAdaptive }] = createResource(() => api<any>("/api/adaptive"))
  const [saved, setSaved] = createSignal(false)

  const saveDir = (dir: string) =>
    api("/api/settings", { method: "POST", body: JSON.stringify({ modelsRootDir: dir }) })
      .then(() => { setSaved(true); refetch() })

  return (
    <div class="flex flex-col gap-4">
      <Card title="Хранение моделей">
        <label class="text-[13px] text-v2-text-text-faint">Папка для GGUF-моделей (по умолчанию E:\LiteMind\models)</label>
        <div class="mt-2 flex gap-2">
          <input
            data-litemind-models-dir
            class="min-w-0 flex-1 rounded-md border border-v2-stroke-stroke-soft bg-v2-bg-bg-subtle px-2.5 py-1.5 text-[13px] text-v2-text-text-primary outline-none focus:border-blue-500"
            value={settings()?.modelsRootDir ?? ""}
            onChange={(e) => saveDir(e.currentTarget.value)}
            onBlur={(e) => { if (e.currentTarget.value !== settings()?.modelsRootDir) saveDir(e.currentTarget.value) }}
          />
        </div>
        <Show when={saved()}>
          <div class="mt-2 text-xs text-green-500">Сохранено. Новые загрузки пойдут в эту папку.</div>
        </Show>
      </Card>
      <Card title="Adaptive Engine">
        <div class="flex flex-col gap-2 text-[13px]">
          <label class="flex items-center gap-2">
            <input
              type="checkbox"
              checked={adaptive()?.config?.enabled !== false}
              onChange={(e) => api("/api/adaptive", { method: "POST", body: JSON.stringify({ enabled: e.currentTarget.checked }) }).then(refetchAdaptive)}
            />
            Адаптивное управление (классификация задач, бюджет генерации)
          </label>
          <label class="flex items-center gap-2">
            <input
              type="checkbox"
              checked={adaptive()?.config?.contextCompaction !== false}
              onChange={(e) => api("/api/adaptive", { method: "POST", body: JSON.stringify({ contextCompaction: e.currentTarget.checked }) }).then(refetchAdaptive)}
            />
            Уплотнение контекста (экономия RAM, стабильный префикс для prompt-cache)
          </label>
          <div class="text-xs text-v2-text-text-faint">
            Вспомогательная модель по умолчанию выключена: классификация выполняется эвристикой без нагрузки на CPU.
          </div>
        </div>
      </Card>
    </div>
  )
}

// ---------------------------------------------------------------- Экран

export default function LiteMindScreen() {
  const [params, setParams] = useSearchParams()
  const section = () => (SECTIONS.some((s) => s.id === params.section) ? (params.section as Section) : "models")
  const [offline] = createResource(() =>
    api("/health").then(() => false).catch((e) => e),
  )

  return (
    <div class="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div class="flex items-center gap-1 border-b border-v2-stroke-stroke-soft px-4 py-2">
        <For each={SECTIONS}>
          {(s) => (
            <button
              type="button"
              data-selected={section() === s.id ? "" : undefined}
              onClick={() => setParams({ section: s.id })}
              class="rounded-md px-3 py-1.5 text-[13px] font-medium text-v2-text-text-faint transition-colors hover:bg-v2-fill-fill-hover hover:text-v2-text-text-primary data-[selected]:bg-v2-fill-fill-hover data-[selected]:text-v2-text-text-primary"
            >
              {s.title}
            </button>
          )}
        </For>
      </div>
      <div class="min-h-0 flex-1 overflow-y-auto p-4">
        <Show when={!offline.error} fallback={<ErrorBanner error={offline.error} />}>
          <Switch>
            <Match when={section() === "control"}><ControlSection /></Match>
            <Match when={section() === "models"}><ModelsSection /></Match>
            <Match when={section() === "catalog"}><CatalogSection /></Match>
            <Match when={section() === "downloads"}><DownloadsSection /></Match>
            <Match when={section() === "hardware"}><HardwareSection /></Match>
            <Match when={section() === "monitor"}><MonitorSection /></Match>
            <Match when={section() === "settings"}><SettingsSection /></Match>
          </Switch>
        </Show>
      </div>
    </div>
  )
}
