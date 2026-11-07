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

export type Section = "models" | "catalog" | "downloads" | "hardware" | "monitor" | "settings"

const SECTIONS: { id: Section; title: string }[] = [
  { id: "models", title: "Мои модели" },
  { id: "catalog", title: "Каталог моделей" },
  { id: "downloads", title: "Загрузки" },
  { id: "hardware", title: "Железо" },
  { id: "monitor", title: "Мониторинг" },
  { id: "settings", title: "Настройки" },
]

const COMPAT_COLOR: Record<string, string> = {
  green: "text-green-500",
  yellow: "text-amber-500",
  red: "text-red-500",
}

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

// ---------------------------------------------------------------- Мои модели

type OptimizeInfo = { threads?: number; tokensPerSecond?: number; ttftMs?: number; measuredAt?: string; advice?: string }

function ModelsSection() {
  const [status, { refetch }] = createResource(() => api<any>("/api/status"))
  const [opt, { refetch: refetchOpt }] = createResource(() => api<any>("/api/optimize"))
  const [busy, setBusy] = createSignal<string | null>(null)
  const [report, setReport] = createSignal<OptimizeInfo | null>(null)

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
                  <Btn onClick={() => api("/api/unload", { method: "POST", body: JSON.stringify({ model: m.id }) }).then(refetch)}>
                    Выгрузить
                  </Btn>
                </div>
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

function CatalogSection() {
  const [catalog, { refetch }] = createResource(() => api<any>("/api/catalog"))
  const [busy, setBusy] = createSignal<string | null>(null)
  const [error, setError] = createSignal<string | null>(null)

  const download = async (m: any) => {
    setBusy(m.id)
    setError(null)
    try {
      await api("/api/downloads", { method: "POST", body: JSON.stringify({ modelId: m.id, fileName: m.compatibility?.recommended?.name }) })
      refetch()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const install = async (m: any) => {
    setBusy(m.id)
    setError(null)
    try {
      await api("/api/install", { method: "POST", body: JSON.stringify({ modelId: m.id }) })
      refetch()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const categories = () => {
    const groups: Record<string, any[]> = {}
    for (const m of catalog()?.models ?? []) {
      ;(groups[m.category] ??= []).push(m)
    }
    return groups
  }

  const categoryTitle = (cat: string) =>
    cat === "uncensored-coding"
      ? "Uncensored / Abliterated coding"
      : cat === "small-coding"
        ? "Компактные coding-модели"
        : "Продвинутые coding-модели"

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
      <Show when={error()}>
        <div class="rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-[13px] text-red-400">{error()}</div>
      </Show>
      <For each={Object.entries(categories())}>
        {([cat, models]) => (
          <div>
            <div class="mb-2 mt-4 text-[11px] font-semibold uppercase tracking-wider text-v2-text-text-faint">
              {categoryTitle(cat)}
            </div>
            <div class="flex flex-col gap-3">
              <For each={models}>
                {(m: any) => (
                  <Card>
                    <div class="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <div class="text-[14px] font-semibold text-v2-text-text-primary">
                          {m.displayName}{" "}
                          <Show when={m.uncensored}>
                            <span class="ml-1 rounded bg-v2-fill-fill-hover px-1.5 py-0.5 text-[10px] font-medium text-amber-500">
                              {m.uncensoredLabel ?? "uncensored"}
                            </span>
                          </Show>
                        </div>
                        <div class="mt-0.5 text-xs text-v2-text-text-faint">{m.purpose}</div>
                      </div>
                      <div class="flex items-center gap-2">
                        <span class={`text-xs font-semibold ${COMPAT_COLOR[m.compatibility?.status] ?? ""}`}>
                          {m.compatibility?.status === "green" ? "подходит" : m.compatibility?.status === "yellow" ? "на пределе" : "не рекомендуется"}
                        </span>
                        <Show when={m.installed}>
                          <span class="text-xs text-green-500">установлена</span>
                        </Show>
                        <Show when={!m.installed && m.downloaded}>
                          <Btn disabled={busy() === m.id} onClick={() => install(m)}>Установить</Btn>
                        </Show>
                        <Show when={!m.installed && !m.downloaded}>
                          <Btn disabled={busy() === m.id || m.compatibility?.status === "red"} onClick={() => download(m)}>
                            {busy() === m.id ? "Скачиваю…" : "Скачать"}
                          </Btn>
                        </Show>
                      </div>
                    </div>
                    <Show when={m.compatibility?.recommended}>
                      <div class="mt-2 text-xs text-v2-text-text-faint">
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
