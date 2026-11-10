// LiteMind UI — собственный интерфейс движка. Vanilla JS, без сборки.
// Работает в двух режимах: панель движка (http://127.0.0.1:8399) и
// собственный интерфейс LiteMind Desktop. API движка — единственный backend;
// в Desktop добавляется IPC-мост Electron.
// AI Chat — главный экран: сессии, Markdown, вложения, стриминг, стоп.
const $ = (id) => document.getElementById(id);
const ENGINE_BASE = location.protocol.startsWith('http') && location.port === '8399' ? '' : 'http://127.0.0.1:8399';
const bridge = () => (typeof window !== 'undefined' && window.electron?.litemindEngine) || null;

const state = { streaming: false, engineOnline: null, catalog: null, wsDir: null, wsFile: null, projDir: null, stickBottom: true, chatSearch: '' };

/* ============================ title bar окна ============================ */
// В Desktop (frame:false + titleBarOverlay) резервируем справа место под
// системные кнопки окна и обновляем имя раздела; активная модель — в updateWelcomeHint.
if (bridge()) document.body.classList.add('in-electron');
const TAB_TITLES = {
  chat: 'Чат', models: 'Мои модели', catalog: 'Каталог моделей', downloads: 'Загрузки',
  projects: 'Проекты', workspace: 'Workspace', terminal: 'AI Terminal', home: 'Состояние',
  hardware: 'Железо', monitor: 'Мониторинг', control: 'Управление', settings: 'Настройки'
};
function setTitlebarPage(name) {
  const el = $('tb-page');
  if (el) el.textContent = TAB_TITLES[name] || 'LiteMind';
}
function setTitlebarModel(name) {
  const el = $('tb-model');
  if (!el) return;
  el.textContent = name || '';
  el.hidden = !name;
}

/* ============================ утилиты ============================ */
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmtSize = (b) => (b == null ? '—' : b >= 1024 ** 3 ? (b / 1024 ** 3).toFixed(2) + ' ГБ' : b >= 1024 ** 2 ? (b / 1024 ** 2).toFixed(1) + ' МБ' : Math.round(b / 1024) + ' КБ');

async function api(path, opts) {
  const res = await fetch(ENGINE_BASE + path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message || data?.message || `HTTP ${res.status}`);
  return data;
}

let errTimer;
function showError(msg) {
  const old = document.querySelector('.error-banner');
  if (old) old.remove();
  if (!msg) return;
  const el = document.createElement('div');
  el.className = 'error-banner';
  el.textContent = msg;
  document.body.appendChild(el);
  clearTimeout(errTimer);
  errTimer = setTimeout(() => el.remove(), 6000);
}

function event(msg) {
  const ul = $('events');
  if (!ul) return;
  const li = document.createElement('li');
  li.innerHTML = `<b>${new Date().toLocaleTimeString()}</b> ${esc(msg)}`;
  ul.prepend(li);
  while (ul.children.length > 40) ul.removeChild(ul.lastChild);
}

function bar(id, pct, text) {
  const el = $(id + '-bar');
  if (!el) return;
  const v = Math.max(0, Math.min(100, pct || 0));
  el.style.width = v + '%';
  el.className = v > 85 ? 'bad' : v > 65 ? 'warn' : '';
  const t = $(id);
  if (t) t.textContent = text;
}

/* ============================ тема ============================ */
function applyTheme(mode) {
  const resolved = mode === 'system'
    ? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark')
    : mode;
  document.documentElement.dataset.theme = resolved;
  localStorage.setItem('litemind-theme', mode);
  document.querySelectorAll('[data-theme-btn]').forEach((b) => b.classList.toggle('active', b.dataset.themeBtn === mode));
}
document.querySelectorAll('[data-theme-btn]').forEach((b) =>
  b.addEventListener('click', () => applyTheme(b.dataset.themeBtn)));
matchMedia('(prefers-color-scheme: light)').addEventListener?.('change', () => {
  if (localStorage.getItem('litemind-theme') === 'system') applyTheme('system');
});
applyTheme(localStorage.getItem('litemind-theme') || 'dark');

/* ============================ боковая панель ============================ */
$('sidebar-toggle').addEventListener('click', () => {
  document.getElementById('app').classList.toggle('sidebar-collapsed');
});
$('chat-menu-btn').addEventListener('click', () => document.getElementById('app').classList.toggle('sidebar-open'));
$('sidebar-overlay').addEventListener('click', () => document.getElementById('app').classList.remove('sidebar-open'));

/* ============================ навигация ============================ */
function switchTab(name) {
  name = name || 'chat';
  const btn = document.querySelector(`.nav-item[data-tab="${name}"]`);
  if (!btn) name = 'chat';
  document.querySelectorAll('.nav-item').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  document.querySelectorAll('[data-page]').forEach((p) => { p.hidden = p.id !== `tab-${name}`; });
  ({ catalog: loadCatalog, downloads: refreshDownloads, hardware: loadHardware, settings: loadSettings,
     models: loadMyModels, monitor: loadMonitor, control: refreshControl, home: refreshStatus,
     chat: loadChat, projects: loadProjects, workspace: loadWorkspace, terminal: loadTerminal })[name]?.();
  const hash = '#' + name;
  if (location.hash !== hash) history.replaceState(null, '', hash);
  document.getElementById('app').classList.remove('sidebar-open');
  setTitlebarPage(name);
  $('main').scrollTop = 0;
}
document.querySelectorAll('.nav-item').forEach((t) => t.addEventListener('click', () => switchTab(t.dataset.tab)));
window.addEventListener('hashchange', () => switchTab(location.hash.slice(1)));
const openTab = (name) => switchTab(name);
$('home-open-chat').addEventListener('click', () => openTab('chat'));
$('home-open-catalog').addEventListener('click', () => openTab('catalog'));

/* ============================ статус ============================ */
let statusCache = null;

function setEngineDot(online, healthy, backendType) {
  const dot = $('engine-dot');
  const txt = $('engine-state-text');
  if (!dot) return;
  if (!online) {
    dot.className = 'dot bad';
    txt.textContent = 'движок не отвечает';
  } else if (healthy) {
    dot.className = 'dot ok';
    txt.textContent = `${backendType ?? 'runtime'} готов`;
  } else {
    dot.className = 'dot warn';
    txt.textContent = 'модель не запущена';
  }
}

async function refreshStatus() {
  let online = true;
  try {
    const s = await api('/api/status');
    statusCache = s;
    online = true;
    const healthy = s.backend.health.ok;
    $('home-engine').textContent = 'Запущен';
    $('home-engine').className = 'state-value ok';
    $('home-backend').textContent = healthy ? 'онлайн' : 'не обнаружен';
    $('home-backend').className = 'state-value ' + (healthy ? 'ok' : 'bad');
    const models = s.models || [];
    $('home-models').textContent = `${models.length} доступно`;
    $('home-queue').textContent = `${s.queue.active} активных / ${s.queue.waiting} в очереди`;
    $('queue').textContent = `${s.queue.active} активных / ${s.queue.waiting} в очереди (лимит ${s.queue.limit})`;
    $('profile').textContent = s.engine.profileLabel;
    $('saver').checked = s.engine.profile === 'low';
    $('home-note').textContent = healthy
      ? `Runtime: ${s.backend.type} ${s.backend.health.version || ''}. Параметры подобраны под ваше железо.`
      : `Модель не запущена: ${s.backend.health.error || '—'} CPU и память не заняты.`;
    const m = s.metrics;
    if (m) {
      const ramPct = m.totalRamMb ? (m.usedRamMb / m.totalRamMb) * 100 : 0;
      bar('cpu', m.cpuPercent, `${Math.round(m.cpuPercent)} %`);
      bar('ram', ramPct, `${Math.round(m.usedRamMb)} / ${Math.round(m.totalRamMb)} МБ`);
      if (m.vramTotalMb) bar('vram', 0, `≈ ${Math.round(m.vramTotalMb)} МБ всего`);
      else { $('vram').textContent = 'недоступно'; const b = $('vram-bar'); if (b) b.style.width = '0'; }
      $('gpu-name').textContent = (m.gpuNames && m.gpuNames.length) ? m.gpuNames.join(', ') : 'видеокарта не определена';
    }
    fillModels(models);
    setEngineDot(true, healthy, s.backend.type);
    updateWelcomeHint(models, healthy);
    monFill(s);
  } catch (err) {
    online = false;
    $('home-engine').textContent = 'Не отвечает';
    $('home-engine').className = 'state-value bad';
    $('home-backend').textContent = '—';
    $('home-models').textContent = '—';
    $('home-queue').textContent = '—';
    $('home-note').textContent = 'Сервер движка не отвечает. В LiteMind Desktop нажмите «Запустить движок» в разделе «Управление».';
    monOffline();
    setEngineDot(false, false, null);
  }
  setConn(online);
  if ($('ctl-engine')) refreshControl(online);
  refreshDlBadge();
}

function updateWelcomeHint(models, healthy) {
  const el = $('welcome-model-hint');
  const active = $('model')?.value || (models && models.length ? models[0].id : '');
  setTitlebarModel(active);
  if (!el) return;
  if (!models || !models.length) {
    el.innerHTML = 'Модель не установлена — <a href="#catalog" onclick="openTab(\'catalog\');return false">откройте каталог</a> и скачайте GGUF.';
  } else if (!healthy) {
    el.textContent = 'Модели найдены, но runtime не готов. Проверьте вкладку «Мои модели».';
  } else {
    el.textContent = `Активная модель: ${active}`;
  }
}

function setConn(ok) {
  if (state.engineOnline === ok) return;
  state.engineOnline = ok;
  const c = $('conn-badge');
  c.textContent = ok ? 'движок: подключён' : 'движок: не отвечает';
  c.className = 'conn ' + (ok ? 'ok' : 'bad');
  if (!ok) event('связь с движком потеряна');
}

const STAGE_LABELS = {
  request_received: 'Запрос получен от UI',
  queued: 'Ожидание в очереди',
  memory_gate: 'Проверка памяти',
  server_start: 'Запуск/переиспользование runtime',
  prompt_submit: 'Отправка промпта',
  first_token: 'Первый токен (без загрузки)',
  generation: 'Генерация токенов',
  total: 'Весь запрос'
};
const STAGE_ORDER = ['request_received', 'queued', 'memory_gate', 'server_start', 'prompt_submit', 'first_token', 'generation', 'total'];

const fmtMs = (v) => (v != null && Number.isFinite(v) ? `${Math.round(v)} мс` : 'недоступно');

function kvRow(dt, dd) {
  return `<dt>${dt}</dt><dd>${dd}</dd>`;
}

/** Runtime-карточка: фактические параметры llama-server (Этап 2 §8/§12). */
function fillRuntimePanel(rt, limits) {
  const el = $('mon-runtime');
  if (!el) return;
  if (!rt || !rt.params) {
    el.innerHTML = kvRow('Модель', 'не запущена') + kvRow('Бинарник', rt?.binary ? 'найден' : 'не найден');
    const note = $('mon-runtime-note');
    if (note) note.textContent = 'Модель не запущена: параметры будут применены при первом запросе.';
    return;
  }
  const p = rt.params;
  const rows = [
    kvRow('Модель', p.file || rt.modelId || '—'),
    kvRow('Потоков генерации', `${p.threads} (prefill: ${p.threadsBatch})`),
    kvRow('Batch / ubatch', `${p.batchSize} / ${p.ubatchSize}`),
    kvRow('Контекст (KV)', `${p.contextTokens} ток.`),
    kvRow('mmap', p.useMmap ? 'включён' : 'выключен (веса в RAM)'),
    kvRow('cache-reuse', p.cacheReuse > 0 ? `${p.cacheReuse} ток.` : 'выключен'),
    kvRow('Приоритет процесса', p.priority === 'below_normal' ? 'ниже обычного' : 'обычный'),
    kvRow('Загрузка модели', rt.loadMs != null ? fmtMs(rt.loadMs) : 'недоступно'),
    kvRow('Перезапусков параметров', String(rt.restarts ?? 0))
  ];
  if (rt.gpu?.probed) {
    rows.push(kvRow('GPU-устройства runtime', rt.gpu.devices.length ? rt.gpu.devices.join('; ') : 'нет (CPU-only сборка)'));
  }
  el.innerHTML = rows.join('');
  const note = $('mon-runtime-note');
  if (note) {
    const reason = rt.lastRestartReason?.changed;
    note.textContent = reason
      ? `Последний перезапуск: ${Object.entries(reason).map(([k, v]) => `${k}: ${v.was}→${v.became}`).join(', ')}.`
      : 'Параметры применены при запуске модели; смена профиля перестроит runtime при следующем запросе.';
  }
}

/** Карточка стадий: сводка по последним запросам (Этап 2 §2/§12). */
function fillStagesPanel(stages) {
  const el = $('mon-stages');
  if (!el) return;
  if (!stages || !Object.keys(stages).length) {
    el.innerHTML = '<dt>Данных пока нет</dt><dd>отправьте сообщение в чате</dd>';
    return;
  }
  el.innerHTML = STAGE_ORDER
    .filter((k) => stages[k])
    .map((k) => kvRow(STAGE_LABELS[k] ?? k, fmtMs(stages[k].avgMs) + (stages[k].count > 1 ? ` (n=${stages[k].count})` : '')))
    .join('');
}

/** Карточка профиля: параметры активного профиля + пометка активной кнопки. */
function fillProfilePanel(s) {
  const l = s.limits ?? {};
  const rows = [
    kvRow('Потоков CPU (генерация)', l.cpuThreads > 0 ? String(l.cpuThreads) : 'авто (по ядрам)'),
    kvRow('Контекст / лимит ответа', `${l.contextTokens} / ${l.maxOutputTokens} ток.`),
    kvRow('Batch', l.numBatch > 0 ? String(l.numBatch) : 'авто'),
    kvRow('Резерв RAM для Windows', `${l.memoryReserveMb} МБ (динамический)`),
    kvRow('Таймаут запроса', `${Math.round((l.requestTimeoutMs ?? 0) / 1000)} с`),
    kvRow('Автовыгрузка модели', l.idleUnloadSeconds > 0 ? `после ${Math.round(l.idleUnloadSeconds / 60)} мин простоя` : 'выключена'),
    kvRow('cache-reuse', l.cacheReuse > 0 ? `${l.cacheReuse} ток.` : 'выключен')
  ];
  const el = $('mon-profile-params');
  if (el) el.innerHTML = rows.join('');
  document.querySelectorAll('[data-profile]').forEach((b) => {
    b.classList.toggle('active', b.dataset.profile === s.engine.profile);
  });
}

function monFill(s) {
  const m = s.metrics;
  if (m) {
    const ramPct = m.totalRamMb ? (m.usedRamMb / m.totalRamMb) * 100 : 0;
    bar('mon-cpu', m.cpuPercent ?? 0, m.cpuPercent != null ? `${Math.round(m.cpuPercent)} %` : 'замер…');
    bar('mon-ram', ramPct, `${Math.round(m.usedRamMb)} / ${Math.round(m.totalRamMb)} МБ`);
    $('mon-avail').textContent = fmtSize((m.availableRamMb ?? 0) * 1024 * 1024);
    $('mon-gpu').textContent = (m.gpuNames && m.gpuNames.length) ? m.gpuNames.join(', ') : 'не определена';
  }
  const perf = s.perf;
  $('mon-tps').textContent = perf?.tokensPerSecond?.avg != null ? Number(perf.tokensPerSecond.avg).toFixed(1) : '—';
  $('mon-ttft').textContent = perf?.ttftMs?.avg != null ? `${Math.round(perf.ttftMs.avg)} мс` : '—';
  // Этап 2: TTFT без загрузки модели — честная скорость готового runtime.
  $('mon-ttft-pure').textContent = perf?.ttftAfterServerMs?.avg != null ? `${Math.round(perf.ttftAfterServerMs.avg)} мс` : '—';
  $('mon-load').textContent = perf?.modelLoadMs?.avg != null ? `${Math.round(perf.modelLoadMs.avg)} мс` : '—';
  $('mon-queue').textContent = `${s.queue.active} / ${s.queue.waiting}`;
  $('mon-compact').textContent = s.adaptive?.compacted ?? 0;
  $('mon-saved').textContent = s.adaptive?.tokensSaved ?? 0;
  $('mon-opts').textContent = Object.keys(s.optimizations ?? {}).length;
  $('mon-profile-note').textContent = `Текущий профиль: ${s.engine.profileLabel}`;
  fillRuntimePanel(s.runtime, s.limits);
  fillStagesPanel(s.stages);
  fillProfilePanel(s);
}

function monOffline() {
  bar('mon-cpu', 0, '—');
  bar('mon-ram', 0, '—');
  for (const id of ['mon-avail', 'mon-gpu', 'mon-tps', 'mon-ttft', 'mon-ttft-pure', 'mon-load', 'mon-queue', 'mon-compact', 'mon-saved', 'mon-opts']) {
    const el = $(id); if (el) el.textContent = '—';
  }
  $('mon-profile-note').textContent = 'Движок не отвечает.';
  fillRuntimePanel(null, null);
  fillStagesPanel(null);
}

$('saver').addEventListener('change', async (e) => {
  try {
    await api('/api/profile', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ profile: e.target.checked ? 'low' : 'balanced' }) });
    event(e.target.checked ? 'включён режим экономии ресурсов' : 'выключен режим экономии ресурсов');
  } catch (err) { showError(err.message); }
  refreshStatus();
});

document.querySelectorAll('[data-profile]').forEach((b) => b.addEventListener('click', async () => {
  try {
    await api('/api/profile', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ profile: b.dataset.profile }) });
    event(`профиль: ${b.textContent}`);
  } catch (err) { showError(err.message); }
  refreshStatus();
}));

$('btn-stop-gen').addEventListener('click', async () => {
  try { const r = await api('/api/stop', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }); event(`остановлено генераций: ${r.cancelled}`); }
  catch (err) { showError(err.message); }
});
$('btn-unload-all').addEventListener('click', async () => {
  try { const r = await api('/api/unload', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }); event(`выгружено: ${(r.unloaded || []).join(', ') || 'нет загруженных моделей'}`); }
  catch (err) { showError(err.message); }
  refreshStatus();
});

/* ============================ Мониторинг ============================ */
function loadMonitor() { refreshStatus(); }

/* ============================ Markdown рендер ============================ */
// Минимальный безопасный Markdown: код-блоки с языком и копированием,
// таблицы, списки, заголовки, цитаты, inline-форматирование.
function mdToHtml(src) {
  const lines = String(src ?? '').split('\n');
  const out = [];
  let i = 0;
  let inCode = false, codeLang = '', codeBuf = [];
  for (; i < lines.length; i++) {
    const line = lines[i];
    const fence = line.match(/^\s*```(\w*)/);
    if (fence && !inCode) { inCode = true; codeLang = fence[1] || ''; codeBuf = []; continue; }
    if (inCode) {
      if (/^\s*```/.test(line)) { out.push(codeBlockHtml(codeBuf.join('\n'), codeLang)); inCode = false; }
      else codeBuf.push(line);
      continue;
    }
    if (/^\s*$/.test(line)) { out.push(''); continue; }
    const h = line.match(/^(#{1,6})\s+(.*)/);
    if (h) { out.push(`<h${h[1].length}>${mdInline(h[2])}</h${h[1].length}>`); continue; }
    if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) { out.push('<hr>'); continue; }
    if (/^\s*&gt;\s?/.test(line) || /^\s*>\s?/.test(line)) {
      const q = [];
      while (i < lines.length && /^\s*&gt;?\s?|^\s*>\s?/.test(lines[i])) { q.push(lines[i].replace(/^\s*(&gt;|>)\s?/, '')); i++; }
      i--;
      out.push(`<blockquote>${mdInline(q.join(' '))}</blockquote>`);
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line)) {
      const rows = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) { rows.push(lines[i]); i++; }
      i--;
      out.push(mdTable(rows));
      continue;
    }
    if (/^\s*[-*+]\s+/.test(line) || /^\s*\d+[.)]\s+/.test(line)) {
      const ordered = /^\s*\d+[.)]\s+/.test(line);
      const items = [];
      while (i < lines.length && (ordered ? /^\s*\d+[.)]\s+/.test(lines[i]) : /^\s*[-*+]\s+/.test(lines[i]))) {
        items.push(lines[i].replace(/^\s*(?:[-*+]|\d+[.)])\s+/, ''));
        i++;
      }
      i--;
      const tag = ordered ? 'ol' : 'ul';
      out.push(`<${tag}>${items.map((it) => `<li>${mdInline(it)}</li>`).join('')}</${tag}>`);
      continue;
    }
    // Абзац: собираем до пустой строки.
    const para = [line];
    while (i + 1 < lines.length && !/^\s*$/.test(lines[i + 1]) && !/^\s*(```|#{1,6}\s|>|\||[-*+]\s|\d+[.)]\s)/.test(lines[i + 1])) {
      para.push(lines[++i]);
    }
    out.push(`<p>${mdInline(para.join('\n')).replace(/\n/g, '<br>')}</p>`);
  }
  if (inCode && codeBuf.length) out.push(codeBlockHtml(codeBuf.join('\n'), codeLang));
  return out.filter((s) => s !== '').join('\n');
}

function codeBlockHtml(code, lang) {
  return `<div class="code-block"><div class="code-head"><span>${esc(lang || 'code')}</span><button class="code-copy" type="button">копировать</button></div><pre><code>${esc(code)}</code></pre></div>`;
}

function mdTable(rows) {
  const parse = (r) => r.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
  const head = parse(rows[0]);
  const bodyRows = rows.slice(1).filter((r) => !/^\s*\|?[\s:|-]+\|?\s*$/.test(r));
  const th = head.map((c) => `<th>${mdInline(c)}</th>`).join('');
  const body = bodyRows.map((r) => `<tr>${parse(r).map((c) => `<td>${mdInline(c)}</td>`).join('')}</tr>`).join('');
  return `<div class="md-table-wrap"><table><thead><tr>${th}</tr></thead><tbody>${body}</tbody></table></div>`;
}

function mdInline(s) {
  let x = esc(s);
  x = x.replace(/`([^`]+)`/g, '<code>$1</code>');
  x = x.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
  x = x.replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,!?:;]|$)/g, '$1<i>$2</i>');
  x = x.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  return x;
}

/* ============================ модели (выбор в чате) ============================ */
function fillModels(models, _current) {
  const sel = $('model');
  if (!sel) return;
  // Пре-выбор модели из каталога: /?model=litemind-... (кнопка «Открыть в AI Chat»).
  try {
    const fromUrl = new URLSearchParams(location.search).get('model');
    if (fromUrl) {
      localStorage.setItem('litemind-selected-model', fromUrl);
      history.replaceState(null, '', location.pathname);
    }
  } catch { /* ignore */ }
  const wanted = localStorage.getItem('litemind-selected-model') || sel.value;
  const ids = models.map((m) => m.id);
  if (sel.dataset.ids !== ids.join('|')) {
    sel.innerHTML = '';
    for (const m of models) {
      const o = document.createElement('option');
      o.value = m.id;
      o.textContent = m.id + (m.sizeBytes ? ` · ${fmtSize(m.sizeBytes)}` : '');
      sel.appendChild(o);
    }
    sel.dataset.ids = ids.join('|');
  }
  if (wanted && ids.includes(wanted)) sel.value = wanted;
  if (!ids.length && !sel.options.length) {
    const o = document.createElement('option');
    o.value = '';
    o.textContent = 'модели не установлены';
    sel.appendChild(o);
  }
}
$('model')?.addEventListener('change', () => {
  localStorage.setItem('litemind-selected-model', $('model').value);
  setTitlebarModel($('model').value);
  const c = activeChat();
  if (c) { c.model = $('model').value; saveChats(); }
});

/* ============================ AI Chat — сессии ============================ */
const CHATS_KEY = 'litemind-chats-v2';
const ACTIVE_CHAT_KEY = 'litemind-active-chat-v2';
let chats = [];
try { chats = JSON.parse(localStorage.getItem(CHATS_KEY) || '[]'); } catch { chats = []; }
let activeChatId = localStorage.getItem(ACTIVE_CHAT_KEY) || null;
let pendingAttachments = []; // [{name, kind, chars, text, warning}]
let currentAbort = null;
const WELCOME_HTML = document.getElementById('chat-welcome')?.outerHTML ?? '';

function saveChats() {
  try { localStorage.setItem(CHATS_KEY, JSON.stringify(chats.slice(0, 60))); }
  catch { // переполнение localStorage — оставляем только последние чаты
    chats = chats.slice(0, 10);
    localStorage.setItem(CHATS_KEY, JSON.stringify(chats));
  }
  localStorage.setItem(ACTIVE_CHAT_KEY, activeChatId ?? '');
}

const activeChat = () => chats.find((c) => c.id === activeChatId) ?? null;

function newChat(silent) {
  // Пустую заготовку не дублируем: если активный чат пуст и ещё не
  // переименован — повторное нажатие «Новый чат» просто возвращается к нему.
  const cur = activeChat();
  if (cur && !cur.messages.length && cur.title === 'Новый чат') {
    if (!silent) $('prompt').focus();
    return cur;
  }
  const c = { id: 'c' + Date.now() + Math.random().toString(36).slice(2, 6), title: 'Новый чат', createdAt: Date.now(), updatedAt: Date.now(), messages: [], model: null };
  chats.unshift(c);
  activeChatId = c.id;
  saveChats();
  renderChatList();
  renderMessages();
  if (!silent) $('prompt').focus();
  return c;
}

function deleteChat(id) {
  const c = chats.find((x) => x.id === id);
  const label = c?.title && c.title !== 'Новый чат' ? `«${c.title}»` : 'этот чат';
  if (!confirm(`Удалить ${label}? Восстановить диалог будет невозможно.`)) return;
  chats = chats.filter((x) => x.id !== id);
  if (activeChatId === id) activeChatId = chats[0]?.id ?? null;
  if (!activeChatId && !chats.length) { saveChats(); newChat(true); return; }
  saveChats();
  renderChatList();
  renderMessages();
}

/* Дата/время последней активности чата: сегодня — время, вчера — «вчера»,
   дальше — дата. Относительные подписи делают историю читаемой без дат в несколько строк. */
function chatWhen(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1).toDateString() === d.toDateString();
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  if (sameDay) return hm;
  if (yesterday) return `вчера ${hm}`;
  return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getFullYear()).slice(2)}`;
}

function renderChatList() {
  const wrap = $('chat-list');
  wrap.innerHTML = '';
  if (!chats.length) { newChat(true); return; }
  const q = (state.chatSearch || '').trim().toLowerCase();
  // Сортировка по последней активности — свежие сверху, независимо от порядка создания.
  const ordered = chats.slice().sort((a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0));
  const visible = q
    ? ordered.filter((c) => c.title?.toLowerCase().includes(q) || c.messages.some((m) => m.content?.toLowerCase().includes(q)))
    : ordered;
  if (!visible.length) {
    const empty = document.createElement('div');
    empty.className = 'chat-list-empty';
    empty.textContent = `Ничего не найдено: «${state.chatSearch.trim()}»`;
    wrap.appendChild(empty);
    return;
  }
  for (const c of visible) {
    const item = document.createElement('div');
    item.className = 'chat-list-item' + (c.id === activeChatId ? ' active' : '');
    item.title = c.messages.length ? c.messages.map((m) => m.content).join('\n').slice(0, 600) : 'Пустой чат';
    const main = document.createElement('div');
    main.className = 'chat-list-main';
    const title = document.createElement('span');
    title.className = 'chat-list-title';
    title.textContent = c.title || 'Новый чат';
    const meta = document.createElement('span');
    meta.className = 'chat-list-meta';
    meta.textContent = chatWhen(c.updatedAt || c.createdAt);
    main.append(title, meta);
    const actions = document.createElement('div');
    actions.className = 'chat-list-actions';
    const ren = document.createElement('button');
    ren.className = 'rename';
    ren.title = 'Переименовать';
    ren.textContent = '✎';
    ren.addEventListener('click', (e) => { e.stopPropagation(); renameChat(c.id); });
    const del = document.createElement('button');
    del.className = 'danger';
    del.title = 'Удалить чат';
    del.textContent = '×';
    del.addEventListener('click', (e) => { e.stopPropagation(); deleteChat(c.id); });
    actions.append(ren, del);
    item.append(main, actions);
    item.addEventListener('click', () => { activeChatId = c.id; saveChats(); renderChatList(); renderMessages(); restoreChatModel(c); });
    wrap.appendChild(item);
  }
}

/* Выбранная модель сохраняется для каждого диалога: при переключении чата
   возвращаем его модель в селектор (если такая модель ещё установлена). */
function restoreChatModel(c) {
  const sel = $('model');
  if (!sel || !c?.model) return;
  const has = [...sel.options].some((o) => o.value === c.model);
  if (has && sel.value !== c.model) {
    sel.value = c.model;
    setTitlebarModel(c.model);
    localStorage.setItem('litemind-selected-model', c.model);
  }
}

function renameChat(id) {
  const c = chats.find((x) => x.id === id);
  if (!c) return;
  const name = prompt('Название чата:', c.title || 'Новый чат');
  if (name === null) return; // отмена
  const trimmed = name.trim();
  if (!trimmed) { showError('Название чата не может быть пустым.'); return; }
  c.title = trimmed.slice(0, 80);
  c.updatedAt = Date.now();
  saveChats();
  renderChatList();
  if (id === activeChatId) $('chat-title').textContent = c.title;
  event(`чат переименован: ${c.title}`);
}

function msgBubble(m, { streaming = false, last = false } = {}) {
  const wrap = document.createElement('div');
  wrap.className = `msg ${m.role === 'user' ? 'msg-user' : 'msg-bot'}`;
  const avatar = document.createElement('div');
  avatar.className = 'msg-avatar';
  avatar.textContent = m.role === 'user' ? 'Вы' : 'LM';
  const body = document.createElement('div');
  body.className = 'msg-body';
  if (m.role === 'user') {
    if (m.attachments?.length) {
      const bar = document.createElement('div');
      bar.className = 'msg-attachments';
      for (const a of m.attachments) {
        const chip = document.createElement('span');
        chip.className = 'attach-chip';
        chip.textContent = `📄 ${a.name} (${a.kind}${a.chars ? ', ' + a.chars + ' симв.' : ''})`;
        bar.appendChild(chip);
      }
      body.appendChild(bar);
    }
    const p = document.createElement('div');
    p.className = 'msg-text';
    p.textContent = m.content;
    body.appendChild(p);
  } else {
    const md = document.createElement('div');
    md.className = 'msg-md';
    md.innerHTML = m.content ? mdToHtml(m.content) : '<span class="thinking">…</span>';
    body.appendChild(md);
    if (m.stopped) {
      const note = document.createElement('div');
      note.className = 'muted small';
      note.textContent = '⏹ генерация остановлена';
      body.appendChild(note);
    }
    if (streaming) body.insertAdjacentHTML('beforeend', '<span class="cursor-blink"></span>');
    // Действия под готовым ответом: копировать целиком; переспросить —
    // только у последнего ответа чата (регенерация переотправляет историю).
    if (!streaming && m.content) {
      const actions = document.createElement('div');
      actions.className = 'msg-actions';
      const copy = document.createElement('button');
      copy.type = 'button';
      copy.textContent = 'копировать';
      copy.addEventListener('click', () => {
        navigator.clipboard?.writeText(m.content).then(() => {
          copy.textContent = 'скопировано';
          setTimeout(() => { copy.textContent = 'копировать'; }, 1200);
        }).catch(() => {});
      });
      actions.appendChild(copy);
      if (last) {
        const regen = document.createElement('button');
        regen.type = 'button';
        regen.textContent = 'переспросить';
        regen.title = 'Сгенерировать ответ заново';
        regen.addEventListener('click', () => regenerateLast());
        actions.appendChild(regen);
      }
      body.appendChild(actions);
    }
  }
  wrap.append(avatar, body);
  return wrap;
}

function errorBubble(text) {
  const div = document.createElement('div');
  div.className = 'msg msg-error';
  div.innerHTML = `<div class="msg-avatar">!</div><div class="msg-body"><b>Ошибка.</b> ${esc(text)}</div>`;
  return div;
}

function scrollChat(force) {
  const log = $('chat-log');
  if (force || state.stickBottom) log.scrollTop = log.scrollHeight;
}

function renderMessages() {
  const c = activeChat();
  const log = $('chat-log');
  log.innerHTML = '';
  $('chat-title').textContent = c?.title ?? 'Новый чат';
  if (!c || !c.messages.length) {
    log.appendChild(welcomeBlock());
    return;
  }
  for (let mi = 0; mi < c.messages.length; mi++) {
    const m = c.messages[mi];
    log.appendChild(msgBubble(m, { last: m.role === 'assistant' && mi === c.messages.length - 1 }));
  }
  log.querySelectorAll('.code-copy').forEach(bindCopy);
  scrollChat(true);
}

function welcomeBlock() {
  // Шаблон хранится строкой: renderMessages очищает #chat-log вместе с исходником.
  const div = document.createElement('div');
  div.innerHTML = WELCOME_HTML;
  return div.firstElementChild ?? div;
}

function bindCopy(btn) {
  btn.addEventListener('click', () => {
    const code = btn.closest('.code-block')?.querySelector('code')?.textContent ?? '';
    navigator.clipboard?.writeText(code).then(() => {
      btn.textContent = 'скопировано';
      setTimeout(() => { btn.textContent = 'копировать'; }, 1200);
    }).catch(() => {});
  });
}

// Копирование кода — делегирование (кнопки создаются динамически при рендере)
$('chat-log').addEventListener('click', (e) => {
  const btn = e.target.closest('.code-copy');
  if (!btn) return;
  const code = btn.closest('.code-block')?.querySelector('code')?.textContent ?? '';
  navigator.clipboard?.writeText(code).then(() => {
    btn.textContent = 'скопировано';
    setTimeout(() => { btn.textContent = 'копировать'; }, 1200);
  }).catch(() => {});
});

// Автоскролл: прилипаем к низу, пока пользователь не проскроллил вверх
$('chat-log').addEventListener('scroll', () => {
  const log = $('chat-log');
  state.stickBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 80;
});

function loadChat() {
  if (!chats.length && !activeChatId) newChat(true);
  if (!activeChat()) activeChatId = chats[0]?.id ?? null;
  renderChatList();
  renderMessages();
  restoreChatModel(activeChat());
}

$('btn-newchat').addEventListener('click', () => newChat());
$('chat-search').addEventListener('input', () => { state.chatSearch = $('chat-search').value; renderChatList(); });
$('btn-clear-chats').addEventListener('click', () => {
  if (!confirm('Удалить все чаты? Это действие необратимо.')) return;
  chats = [];
  activeChatId = null;
  saveChats();
  newChat();
});

// Подсказки на экране приветствия
$('chat-log').addEventListener('click', (e) => {
  const hint = e.target.closest('[data-hint]');
  if (hint) {
    $('prompt').value = hint.dataset.hint;
    $('prompt').focus();
    autoGrow();
  }
});

/* ============================ AI Chat — вложения ============================ */
$('btn-attach').addEventListener('click', () => $('file-input').click());

$('file-input').addEventListener('change', async (e) => {
  const files = [...e.target.files];
  e.target.value = '';
  for (const f of files) await addAttachment(f);
  renderAttachBar();
});

async function addAttachment(file) {
  if (file.size > 10 * 1024 * 1024) { showError(`«${file.name}» больше 10 МБ`); return; }
  const chip = { name: file.name, kind: '…', chars: 0, text: '', warning: null, loading: true };
  pendingAttachments.push(chip);
  renderAttachBar();
  try {
    const buf = await file.arrayBuffer();
    const b64 = arrayBufferToBase64(buf);
    const r = await api('/api/attachments', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: file.name, dataBase64: b64 })
    });
    Object.assign(chip, { kind: r.kind, chars: r.chars, text: r.text, warning: r.warning, loading: false });
    if (r.warning) showError(`«${file.name}»: ${r.warning}`);
    event(`вложение прочитано: ${file.name} (${r.chars} симв.)`);
  } catch (err) {
    pendingAttachments = pendingAttachments.filter((a) => a !== chip);
    showError(`вложение «${file.name}»: ${err.message}`);
  }
  renderAttachBar();
}

function arrayBufferToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

function renderAttachBar() {
  const barEl = $('attach-bar');
  barEl.innerHTML = '';
  barEl.hidden = pendingAttachments.length === 0;
  pendingAttachments.forEach((a, idx) => {
    const chip = document.createElement('span');
    chip.className = 'attach-chip' + (a.loading ? ' loading' : '');
    // Чип показывает и имя, и путь в проекте (Этап 1В §2: видно, что уйдёт модели).
    const title = a.path ? `${a.path}${a.warning ? ' — ' + a.warning : ''}` : (a.warning ?? '');
    chip.title = title;
    chip.innerHTML = `📄 ${esc(a.name)}${a.path && a.path !== a.name ? ` <i class="attach-path">${esc(a.path)}</i>` : ''} <button title="Убрать">×</button>`;
    chip.querySelector('button').addEventListener('click', () => {
      pendingAttachments.splice(idx, 1);
      renderAttachBar();
    });
    barEl.appendChild(chip);
  });
  updateCtxWarn();
}

/* Предупреждение о размере контекста (Этап 1В §2): не режем молча —
   честно считаем и объясняем, что не поместится. */
function updateCtxWarn() {
  const el = $('ctx-warn');
  if (!el) return;
  const total = pendingAttachments.reduce((acc, a) => acc + (a.chars ?? 0), 0);
  if (!pendingAttachments.length || total === 0) { el.hidden = true; el.textContent = ''; return; }
  const ctxTokens = Number($('ctx')?.value) || 4096;
  // Оценка честная, но приблизительная: 1 токен ≈ 3.5 символа для смешанного
  // русско-английского текста (кириллица дороже). Точные числа знает только токенизатор модели.
  const estTokens = Math.ceil(total / 3.5);
  const pct = estTokens / ctxTokens;
  el.hidden = false;
  if (pct > 1) {
    el.className = 'ctx-warn bad';
    el.textContent = `Вложений: ${pendingAttachments.length} · ≈${estTokens.toLocaleString('ru')} токенов при контексте ${ctxTokens} — НЕ ПОМЕСТИТСЯ. Модель получит урезанную историю; уберите лишние файлы или увеличьте «Контекст».`;
  } else if (pct > 0.7) {
    el.className = 'ctx-warn warn';
    el.textContent = `Вложений: ${pendingAttachments.length} · ≈${estTokens.toLocaleString('ru')} из ${ctxTokens} токенов контекста (${Math.round(pct * 100)}%). Оценка приблизительная — часть истории может быть урезана.`;
  } else {
    el.className = 'ctx-warn ok';
    el.textContent = `Вложений: ${pendingAttachments.length} · ≈${estTokens.toLocaleString('ru')} из ${ctxTokens} токенов контекста.`;
  }
}

/* ============================ AI Chat — отправка ============================ */
function autoGrow() {
  const ta = $('prompt');
  ta.style.height = 'auto';
  ta.style.height = Math.min(ta.scrollHeight, 200) + 'px';
}
$('prompt').addEventListener('input', autoGrow);

function composerBusy(busy) {
  state.streaming = busy;
  $('btn-send').hidden = busy;
  $('btn-stop').hidden = !busy;
  $('run-state').textContent = busy ? 'генерация…' : '';
}

async function sendChat() {
  const ta = $('prompt');
  const promptText = ta.value.trim();
  if (!promptText && !pendingAttachments.length) return;
  if (state.streaming) return;
  const model = $('model').value;
  if (!model) { showError('Модели не установлены — скачайте модель в «Каталоге моделей».'); return; }

  let chat = activeChat();
  if (!chat) chat = newChat(true);
  chat.model = model; // модель фиксируется за диалогом — переключение чата вернёт её

  // Текст пользователя + содержимое вложений (реальные данные для модели).
  let content = promptText;
  const attachMeta = [];
  for (const a of pendingAttachments) {
    attachMeta.push({ name: a.name, kind: a.kind, chars: a.chars });
    const clipped = (a.text ?? '').slice(0, 12000);
    content += `\n\n---\nФайл: ${a.name} (${a.kind})\n\`\`\`\n${clipped}${(a.text ?? '').length > 12000 ? '\n[…файл обрезан до 12000 символов…]' : ''}\n\`\`\``;
  }
  pendingAttachments = [];
  renderAttachBar();

  const userMsg = { role: 'user', content, attachments: attachMeta.length ? attachMeta : undefined };
  chat.messages.push(userMsg);
  if (chat.title === 'Новый чат' && promptText) {
    chat.title = promptText.slice(0, 48) + (promptText.length > 48 ? '…' : '');
    $('chat-title').textContent = chat.title;
  }
  chat.updatedAt = Date.now();
  ta.value = '';
  autoGrow();
  saveChats();
  renderChatList();

  // Рисуем пользователя + пустой ответ модели
  const log = $('chat-log');
  const welcome = log.querySelector('.chat-welcome');
  if (welcome) welcome.remove();
  log.appendChild(msgBubble(userMsg));
  await runCompletion(chat);
}

/* Регенерация последнего ответа: убираем хвостовые ответы ассистента и
   переотправляем ту же историю — модель ответит заново. */
function regenerateLast() {
  const c = activeChat();
  if (!c || state.streaming) return;
  let removed = false;
  while (c.messages.length && c.messages[c.messages.length - 1].role === 'assistant') {
    c.messages.pop();
    removed = true;
  }
  if (!c.messages.length || !removed) return;
  saveChats();
  renderMessages();
  event('чат: перегенерация ответа');
  void runCompletion(c);
}

/* Запрос к модели и стрим ответа: используется и после отправки сообщения,
   и при регенерации (история уже в chat.messages). */
async function runCompletion(chat) {
  const log = $('chat-log');
  const reply = { role: 'assistant', content: '' };
  const botBubble = msgBubble(reply, { streaming: true });
  log.appendChild(botBubble);
  scrollChat(true);

  composerBusy(true);
  const mdEl = botBubble.querySelector('.msg-md');
  const t0 = performance.now();
  let ttft = null;
  let lastRender = 0;
  let lastTimings = null;
  let serverTimingLine = null;
  currentAbort = new AbortController();

  const renderMd = (final = false) => {
    const now = performance.now();
    if (!final && now - lastRender < 80) return;
    lastRender = now;
    mdEl.innerHTML = reply.content ? mdToHtml(reply.content) : '<span class="thinking">…</span>';
    mdEl.querySelectorAll('.code-copy').forEach(bindCopy);
    scrollChat();
  };

  try {
    // История: последние 24 сообщения (уплотнение середины выполняет движок).
    // Последний элемент chat.messages — текущий запрос пользователя.
    const send = chat.messages.slice(-24).map((m) => ({ role: m.role, content: m.content }));
    const res = await fetch(ENGINE_BASE + '/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: currentAbort.signal,
      body: JSON.stringify({
        model,
        stream: true,
        context_tokens: Number($('ctx').value),
        max_tokens: 1024,
        messages: send
      })
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data?.error?.message || `HTTP ${res.status}`);
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    stream: for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) !== -1) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        for (const line of block.split('\n')) {
          if (!line.startsWith('data: ')) continue;
          const payload = line.slice(6);
          if (payload === '[DONE]') break stream;
          let obj;
          try { obj = JSON.parse(payload); } catch { continue; }
          if (obj.error) throw new Error(obj.error.message);
          // Этап 2 §7/§12: финальный чанк несёт честные замеры движка.
          if (obj.litemind?.timings) {
            lastTimings = obj.litemind.timings;
            const t = lastTimings;
            const load = t.modelLoadMs != null ? ` · загрузка модели: ${(t.modelLoadMs / 1000).toFixed(1)} с` : '';
            const gen = t.tokensPerSecond ? ` · генерация: ${t.tokensPerSecond} т/с` : '';
            const prompt = t.usage?.promptTokens != null ? ` · промпт: ${t.usage.promptTokens} ток.` : '';
            serverTimingLine = `первый токен: ${ttft ?? '—'} мс (UI)${load}${gen}${prompt}`;
          }
          const delta = obj.choices?.[0]?.delta?.content;
          if (delta) {
            if (ttft === null) {
              ttft = Math.round(performance.now() - t0);
              $('timings').textContent = `первый токен: ${ttft} мс`;
            }
            reply.content += delta;
            renderMd();
          }
        }
      }
    }
    renderMd(true);
    const total = Math.round(performance.now() - t0);
    // Этап 2: если движок прислал замеры — показываем их (загрузка/генерация/промпт),
    // иначе честное UI-время без выдуманных цифр.
    $('timings').textContent = serverTimingLine || `первый токен: ${ttft ?? '—'} мс · всего: ${total} мс`;
    event(`чат: ответ получен (${total} мс)`);
  } catch (err) {
    if (err.name === 'AbortError') {
      reply.stopped = true;
      event('генерация остановлена пользователем');
    } else {
      // Честная ошибка прямо в потоке диалога
      log.appendChild(errorBubble(err.message));
      event('ошибка чата: ' + err.message);
    }
    renderMd(true);
  } finally {
    if (reply.content || reply.stopped) {
      chat.messages.push({ role: 'assistant', content: reply.content, stopped: reply.stopped });
    } else {
      botBubble.remove(); // ошибка до первого токена — пустой пузырь не нужен
    }
    // Этап 1В §3: если модель вернула ```file:... блоки — показываем панель
    // применения изменений (diff + подтверждение). Без подтверждения ничего не пишется.
    scanReplyForFileChanges(chat, reply);
    chat.updatedAt = Date.now();
    saveChats();
    composerBusy(false);
    currentAbort = null;
    scrollChat();
    refreshStatus();
  }
}

$('btn-send').addEventListener('click', sendChat);
$('btn-stop').addEventListener('click', () => currentAbort?.abort(new Error('user stop')));
$('prompt').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); }
});

/* ============================ Управление (ТЗ §16) ============================ */
const ENGINE_STATE_LABEL = { running: 'Движок запущен', stopping: 'Движок останавливается…', stopped: 'Движок полностью остановлен' };
const MODEL_STATE_LABEL = { loading: 'Модель загружается…', running: 'Модель работает', stopping: 'Модель останавливается…', stopped: 'Модель остановлена' };
const fmtRam = (mb) => (mb != null ? fmtSize(mb * 1024 * 1024) : '—');

async function refreshControl(onlineHint) {
  const online = onlineHint ?? state.engineOnline;
  let s = null;
  try { s = await api('/api/engine/state'); } catch { s = null; }
  const offline = !s;
  $('ctl-offline').hidden = !offline;
  $('ctl-engine').textContent = offline
    ? (state.engineOnline === false ? 'Не отвечает' : 'Уточняю состояние…')
    : (ENGINE_STATE_LABEL[s.engine] ?? s.engine);
  $('ctl-engine').className = 'state-value ' + (offline ? 'bad' : s.engine === 'running' ? 'ok' : 'warn');
  $('ctl-queue').textContent = offline ? '—' : `${s.queue?.active ?? 0} / ${s.queue?.waiting ?? 0}`;
  $('ctl-downloads').textContent = offline ? '—' : String(s.downloads ?? 0);
  const wrap = $('ctl-models');
  wrap.innerHTML = '';
  if (!offline && (s.models ?? []).length) {
    for (const m of s.models) {
      const li = document.createElement('li');
      li.innerHTML = `<div class="model-item-main"><div class="model-item-title">${esc(m.id)}</div>
        <div class="model-item-sub">${esc(MODEL_STATE_LABEL[m.state] ?? m.state)}</div></div>
        <div class="model-item-actions"><button data-stop-model="${esc(m.id)}">Остановить модель</button></div>`;
      li.querySelector('[data-stop-model]').addEventListener('click', () => stopModel(m.id));
      wrap.appendChild(li);
    }
  }
  const b = bridge();
  if (b) {
    try {
      const h = await b.control('status');
      if (h?.host) {
        $('ctl-host-card').hidden = false;
        $('ctl-host').innerHTML = `
          <dt>Процесс движка</dt><dd>${h.host.owned ? 'запущен приложением' : 'сторонний / усыновлён'}</dd>
          <dt>Состояние хоста</dt><dd>${esc(h.host.state)}</dd>
          <dt>Движок отвечает</dt><dd>${h.reachable ? 'да' : 'нет'}</dd>`;
        if (offline) $('ctl-start').disabled = false;
      }
    } catch { /* мост недоступен */ }
  }
}

function ctlReport(ok, text, ram) {
  const el = $('ctl-report');
  el.hidden = false;
  el.className = 'report ' + (ok ? 'ok' : 'bad');
  let html = esc(text);
  if (ram?.freedMb != null && ok) {
    html += `\nОсвобождено ≈ ${fmtRam(ram.freedMb)} RAM (было доступно ${fmtRam(ram.availableRamMbBefore)}, стало ${fmtRam(ram.availableRamMbAfter)}).`;
  }
  el.textContent = html;
}

async function stopAllModels() {
  try {
    const r = await api('/api/models/stop-all', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    ctlReport(r.verified, r.verified
      ? `Все модели остановлены и выгружены из RAM/VRAM${r.unloaded?.length ? ` (${r.unloaded.join(', ')})` : ''}. Выгрузка подтверждена опросом бэкенда.`
      : 'Модели остановлены, но бэкенд не подтвердил выгрузку — проверьте Мониторинг.', r.ram);
    event('остановлены все модели');
  } catch (err) { ctlReport(false, err.message); }
  refreshStatus();
}

async function stopModel(id) {
  try {
    const r = await api('/api/models/stop', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: id }) });
    ctlReport(r.verified, `Модель «${id}»: генерации отменены (${r.cancelledRequests ?? 0}), выгрузка ${r.verified ? 'подтверждена' : 'не подтверждена'}.`, r.ram);
    event(`модель остановлена: ${id}`);
  } catch (err) { ctlReport(false, err.message); }
  refreshStatus();
}

async function stopEngine() {
  try {
    await api('/api/engine/stop', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    ctlReport(true, 'Движок останавливается: генерации отменены, загрузки остановлены, модели выгружаются из RAM/VRAM, сервер закрывается.');
    setTimeout(refreshStatus, 900);
    setTimeout(refreshStatus, 2500);
  } catch (err) {
    if (/Failed to fetch|fetch failed|NetworkError/i.test(String(err.message))) {
      ctlReport(true, 'Движок полностью остановлен: сервер закрыт, модели выгружены.');
      refreshStatus();
    } else ctlReport(false, err.message);
  }
}

async function startEngine() {
  const b = bridge();
  if (!b) {
    ctlReport(false, 'Запуск доступен в LiteMind Desktop. В браузере запустите движок: litemind serve');
    return;
  }
  try {
    const r = await b.control('start');
    ctlReport(!!r?.ok, r?.ok ? 'Движок запущен.' : `Не удалось запустить: ${r?.error ?? 'неизвестная ошибка'}`);
  } catch (err) { ctlReport(false, err.message); }
  setTimeout(refreshStatus, 700);
}

async function quitApp() {
  const b = bridge();
  if (!b) { ctlReport(false, 'Выход доступен в LiteMind Desktop: закройте окно — движок будет остановлен корректно.'); return; }
  try { await b.control('quit'); } catch { /* приложение закрывается */ }
}

$('ctl-start').addEventListener('click', startEngine);
$('ctl-stop-models').addEventListener('click', stopAllModels);
$('ctl-stop-engine').addEventListener('click', stopEngine);
$('ctl-quit').addEventListener('click', quitApp);

/* ============================ Менеджер моделей (Этап 1Б §4) ============================ */
/* Статусы отражают действительное состояние: «запущена» — только если runtime
   реально держит модель в памяти; «загружается» — есть активная загрузка этого
   файла; «проверяется» — идёт проверка SHA-256; «повреждена» — проверка не
   пройдена; «несовместима» — не поместится в память. SHA-256 показывается
   после проверки (или из реестра пользовательских моделей). */
const VERIFY_CACHE = new Map(); // id -> { sha256, verified, at }
const VERIFYING = new Set();    // id моделей, которые проверяются прямо сейчас
const STOPPED_NOW = new Set();  // остановлены в этой сессии (для статуса «остановлена»)
let myModelsCache = [];

function myModelStatus(m, loadedIds, downloadNames) {
  if (VERIFYING.has(m.id)) return { text: 'проверяется', cls: 'warn-tag' };
  if (downloadNames.has((m.file ?? '').split(/[\\/]/).pop())) return { text: 'загружается', cls: 'warn-tag' };
  if (loadedIds.has(m.id)) return { text: 'запущена', cls: 'ok-tag' };
  if (STOPPED_NOW.has(m.id)) return { text: 'остановлена', cls: 'muted-tag' };
  if (!m.ok) return { text: 'повреждена', cls: 'bad-tag' };
  if (m.sizeBytes === 0) return { text: 'отсутствует файл', cls: 'bad-tag' };
  if (!m.compatible) return { text: 'несовместима', cls: 'warn-tag' };
  return { text: 'готова', cls: 'ok-tag' };
}

async function loadMyModels() {
  // Какие модели прямо сейчас в памяти (llama-server запущен) — для честного
  // статуса «запущена» и кнопки «Остановить» вместо «Запустить».
  const loadedIds = new Set();
  try {
    const st = await api('/api/engine/state');
    for (const x of (st.models || [])) {
      if (['loaded', 'running'].includes(x.state)) { loadedIds.add(x.id); STOPPED_NOW.delete(x.id); }
      else if (x.state === 'stopped' || x.state === 'unloaded') STOPPED_NOW.add(x.id);
    }
  } catch { /* движок может быть offline */ }
  // Активные загрузки — статус «загружается» по имени файла.
  const downloadNames = new Set();
  try {
    const d = await api('/api/downloads');
    for (const j of d.downloads || []) if (['downloading', 'paused'].includes(j.state)) downloadNames.add(j.name);
  } catch { /* — */ }

  try {
    const s = await api('/api/models/scan');
    $('scan-rootdir').textContent = `Папка моделей: ${s.rootDir} · runtime: ${s.runtimeBinary ?? 'llama-server не найден'}`;
    const ul = $('my-models');
    ul.innerHTML = '';
    const query = ($('mym-search')?.value || '').toLowerCase();
    let models = s.models || [];
    if (query) models = models.filter((m) => (m.id + ' ' + (m.file ?? '')).toLowerCase().includes(query));
    myModelsCache = models;
    if (!models.length) {
      ul.innerHTML = '<li class="muted">' + (query
        ? 'По запросу ничего не найдено.'
        : 'В папке пока нет GGUF. Скачайте модель из каталога или добавьте свою модель — они появятся здесь.') + '</li>';
    } else {
      const canShell = !!bridge();
      for (const m of models) {
        const li = document.createElement('li');
        const status = myModelStatus(m, loadedIds, downloadNames);
        const sha = VERIFY_CACHE.get(m.id)?.sha256 ?? m.sha256 ?? null;
        const shaNote = sha
          ? `<div class="model-item-sub muted" title="${esc(sha)}">SHA-256: ${esc(String(sha).slice(0, 24))}… · вычислен локально (проверка целостности, не подтверждение источника)</div>`
          : '';
        const registeredNote = m.registered ? '<span class="tag">своя модель</span>' : '';
        li.innerHTML = `<div class="model-item-main"><div class="model-item-title">${esc(m.id)} <span class="tag ${status.cls}">${status.text}</span> ${registeredNote}</div>
          <div class="model-item-sub">${fmtSize(m.sizeBytes)} · ${esc(m.architecture ?? '?')} · ${esc(m.quant ?? 'квант не определён')} · контекст ${m.contextLength ?? 'неизвестен'} · ≈${m.memoryEstimateMb} МБ RAM</div>
          <div class="model-item-sub muted" title="${esc(m.file ?? '')}">файл: ${esc(m.file ?? '—')}</div>
          ${shaNote}
          ${m.error ? `<div class="model-item-sub" style="color:var(--bad)">${esc(m.error)}</div>` : ''}
          <div class="model-item-result" hidden></div></div>
          <div class="model-item-actions">
            <button data-use="${esc(m.id)}" ${m.ok ? '' : 'disabled'}>Открыть в чате</button>
            ${loadedIds.has(m.id)
              ? `<button data-stop="${esc(m.id)}">Остановить</button>`
              : `<button data-run="${esc(m.id)}" ${m.ok && s.runtimeBinary ? '' : 'disabled'} title="${s.runtimeBinary ? 'Запустить llama-server с этой моделью' : 'runtime llama-server не найден'}">Запустить</button>`}
            <button data-verify="${esc(m.id)}">Проверить файл</button>
            ${canShell ? `<button data-folder="${esc(m.file ?? '')}">Открыть папку</button>` : ''}
            <button data-info="${esc(m.id)}">Сведения</button>
            ${m.registered
              ? `<button data-unreg="${esc(m.id)}" title="Убрать из списка; файл на диске останется">Убрать из списка</button>`
              : `<button data-del="${esc(m.id)}" class="danger">Удалить файл</button>`}
          </div>`;
        const resultEl = li.querySelector('.model-item-result');
        const showResult = (text, ok) => { resultEl.hidden = false; resultEl.textContent = text; resultEl.className = `model-item-result ${ok ? 'res-ok' : 'res-bad'}`; };
        li.querySelector('[data-use]')?.addEventListener('click', () => {
          const sel = $('model');
          if ([...sel.options].some((o) => o.value === m.id)) {
            sel.value = m.id;
            localStorage.setItem('litemind-selected-model', m.id);
            setTitlebarModel(m.id);
            openTab('chat');
          } else {
            showError('Модель ещё не видна движку — подождите пару секунд или обновите вкладку.');
          }
        });
        li.querySelector('[data-run]')?.addEventListener('click', async (e) => {
          e.target.disabled = true;
          try {
            const r = await api('/api/models/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ file: m.file }) });
            if (r.ok) {
              showResult(`Модель запущена (${r.contextTokens ?? '—'} токенов контекста). Открыта в чате — можно писать.`, true);
              event(`модель запущена из менеджера: ${m.id}`);
              STOPPED_NOW.delete(m.id);
              loadMyModels();
              refreshStatus();
            } else {
              showResult(r.message || 'Не удалось запустить модель.', false);
              e.target.disabled = false;
            }
          } catch (err) {
            showResult('Запуск: ' + err.message, false);
            e.target.disabled = false;
          }
        });
        li.querySelector('[data-stop]')?.addEventListener('click', async () => {
          try {
            await api('/api/unload', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}) });
            STOPPED_NOW.add(m.id);
            event(`модель остановлена: ${m.id}`);
            loadMyModels();
            refreshStatus();
          } catch (err) { showError('остановка: ' + err.message); }
        });
        li.querySelector('[data-verify]').addEventListener('click', async (e) => {
          e.target.disabled = true;
          VERIFYING.add(m.id);
          loadMyModels();
          showResult('Проверяю файл (считаю SHA-256)…', true);
          try {
            const r = await api('/api/models/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ file: m.file }) });
            VERIFY_CACHE.set(m.id, { sha256: r.sha256, verified: r.verified, at: Date.now() });
            if (r.verified) showResult(`Файл цел: ${fmtSize(r.sizeBytes)} · SHA-256 (локально вычисленный): ${String(r.sha256).slice(0, 16)}…`, true);
            else showResult(r.message || 'Файл повреждён — скачайте модель заново.', false);
          } catch (err) { showResult('Проверка: ' + err.message, false); }
          VERIFYING.delete(m.id);
          e.target.disabled = false;
          loadMyModels();
        });
        li.querySelector('[data-folder]')?.addEventListener('click', async () => {
          const b = bridge();
          if (!b) return;
          const r = await b.shellShowItemInFolder(m.file).catch(() => ({ ok: false }));
          if (r && r.ok === false) showError('Не удалось открыть папку в проводнике.');
        });
        li.querySelector('[data-info]').addEventListener('click', () => {
          const c = VERIFY_CACHE.get(m.id);
          alert([
            `Модель: ${m.id}`,
            m.registered ? 'Тип: пользовательская модель (вне папки моделей)' : null,
            m.file ? `Файл: ${m.file}` : null,
            `Размер файла: ${fmtSize(m.sizeBytes)}`,
            `Архитектура: ${m.architecture ?? 'неизвестно'}`,
            `Квантование: ${m.quant ?? 'неизвестно'}`,
            `Контекст: ${m.contextLength ?? 'неизвестно'}`,
            `Оценка RAM: ≈${m.memoryEstimateMb} МБ`,
            sha ? `SHA-256: ${sha}` : 'SHA-256: не вычислялся — нажмите «Проверить файл»',
            c && !c.verified ? '⚠ Последняя проверка не пройдена' : null,
            `Статус: ${status.text}`
          ].filter(Boolean).join('\n'));
        });
        li.querySelector('[data-del]').addEventListener('click', async () => {
          if (!confirm(`Удалить файл «${m.id}.gguf» с диска безвозвратно? Файл нельзя будет восстановить — для повторного использования придётся скачивать модель заново.`)) return;
          try {
            await api(`/api/models/${encodeURIComponent(m.id)}`, { method: 'DELETE' });
            event(`модель удалена: ${m.id}`);
            loadMyModels();
            refreshStatus();
          } catch (err) { showError('удаление: ' + err.message); }
        });
        li.querySelector('[data-unreg]')?.addEventListener('click', async () => {
          if (!confirm(`Убрать «${m.id}» из списка моделей? Сам файл на диске останется на месте.`)) return;
          try {
            await api(`/api/models/registered/${encodeURIComponent(m.id)}`, { method: 'DELETE' });
            event(`модель убрана из списка (файл сохранён): ${m.id}`);
            loadMyModels();
          } catch (err) { showError('убрать из списка: ' + err.message); }
        });
        ul.appendChild(li);
      }
    }
  } catch { /* backend offline */ }
  try {
    const hw = await api('/api/hardware');
    const files = (hw.ggufFiles || []);
    const ul = $('gguf-files');
    ul.innerHTML = files.length ? '' : '<li class="muted">в папке моделей пока нет скачанных GGUF</li>';
    for (const f of files) {
      const li = document.createElement('li');
      li.innerHTML = `<label class="model-item-main"><input type="radio" name="gguf" value="${esc(f.path)}" ${files[0].path === f.path ? 'checked' : ''} />
        ${esc(f.name)} · ${fmtSize(f.sizeBytes)}</label>`;
      ul.appendChild(li);
    }
  } catch { /* — */ }
}

/* §6: «Добавить свою модель» — выбор GGUF через проводник Windows (Desktop)
   или ввод пути вручную. Проверка формата и SHA-256 выполняются движком;
   метаданные — только из заголовка GGUF, ничего не придумывается. */
$('mym-search')?.addEventListener('input', () => loadMyModels());
$('btn-add-own').addEventListener('click', async () => {
  let file = null;
  const b = bridge();
  if (b?.pickGgufFile) {
    const r = await b.pickGgufFile('Выберите GGUF-модель').catch(() => null);
    if (r?.ok && r.path) file = r.path;
    else if (r?.canceled) return;
  }
  if (!file) {
    file = prompt('Полный путь к GGUF-файлу (например D:\\models\\my-model.gguf):');
    if (!file) return;
  }
  event('регистрирую модель: ' + file);
  try {
    const r = await api('/api/models/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ file }) });
    event(r.message || `модель добавлена: ${r.model?.id}`);
    loadMyModels();
    refreshStatus();
  } catch (err) {
    showError('добавление модели: ' + err.message);
  }
});

async function optimizeModel(id, reportEl) {
  reportEl.textContent = 'измеряю… (короткая генерация, занимает несколько секунд)';
  try {
    const r = await api('/api/optimize', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: id }) });
    reportEl.textContent = r.advice || '';
    event(`${id}: ${r.tokensPerSecond ?? '—'} ток/с, потоки ${r.threads ?? 'авто'}`);
  } catch (err) { reportEl.textContent = 'ошибка: ' + err.message; }
}

$('btn-install-gguf').addEventListener('click', async () => {
  const sel = document.querySelector('input[name="gguf"]:checked');
  if (!sel) { showError('Выберите GGUF-файл.'); return; }
  $('install-note').textContent = 'применяю…';
  try {
    const r = await api('/api/install', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ggufPath: sel.value }) });
    $('install-note').textContent = r.skipped ? 'готово (runtime читает GGUF напрямую)' : '';
    event(`применено: ${r.model}`);
    loadMyModels();
  } catch (err) {
    $('install-note').textContent = '';
    showError('ошибка: ' + err.message);
  }
});

/* ============================ Каталог ============================ */
/* ============================ Каталог v3 (Этап 1Б §2/§3/§7) ============================ */
/* Поиск, фильтры (назначение/размер/квант/язык/контекст/RAM/CPU/тип/разработчик),
   сортировка (название/размер/специализация/дата проверки), выбор по задаче
   (quick-picks), подробная карточка с честными пометками «неизвестно». */

const catFilters = { search: '', task: '', purpose: '', dev: '', type: '', size: '', quant: '', lang: '', ctx: '', ram: '', cpuok: false, sort: 'name' };

// Быстрый выбор по задаче (§3): какие purposes ищем и как объясняем.
const TASKS = {
  coding: {
    purposes: ['coding'],
    why: 'Это модели, обученные для кода: Qwen Coder, DeepSeek Coder, StarCoder и их ослабленные варианты. Они понимают запросы на естественном языке и пишут/объясняют код.'
  },
  chat: {
    purposes: ['chat'],
    why: 'Универсальные собеседники: диалоги, вопросы, объяснения. Для свободного стиля ответов смотрите модели с пометкой «ослабленные ограничения».'
  },
  writing: {
    purposes: ['writing'],
    why: 'Модели с сильным русским/английским языком для писем, текстов и черновиков. Универсальные чат-модели тоже подходят.'
  },
  analysis: {
    purposes: ['analysis'],
    why: 'Модели, которые уверенно работают с длинными текстами (вставьте документ или выдержку в чат). Учитывайте контекст: чем он больше, тем больше текст поместится.'
  },
  universal: {
    purposes: ['chat', 'writing', 'analysis'],
    all: true,
    why: 'Универсальные модели: общение, тексты и анализ документов в одной. Компромисс по скорости — выбирайте размер по своей памяти (подсказка в карточке).'
  }
};

const LEVEL_CLASS = { ok: 'lv-ok', limited: 'lv-limited', not_recommended: 'lv-warn', incompatible: 'lv-bad' };

const purposeLabel = (c, key) => (c?.purposes && c.purposes[key]) || key;

function minFileSize(m) { return Math.min(...m.files.map((f) => f.sizeBytes)); }

function catalogMatches(m, c) {
  const F = catFilters;
  if (F.search) {
    const q = F.search.toLowerCase();
    const hay = `${m.displayName} ${m.developer ?? ''} ${m.purpose ?? ''} ${m.quality ?? ''} ${m.params ?? ''}`.toLowerCase();
    if (!hay.includes(q)) return false;
  }
  if (F.task) {
    const t = TASKS[F.task];
    if (!m.purposes?.length) return false;
    if (t.all) { if (!t.purposes.every((p) => m.purposes.includes(p))) return false; }
    else if (!m.purposes.includes(t.purposes[0])) return false;
  }
  if (F.purpose && !(m.purposes || []).includes(F.purpose)) return false;
  if (F.dev && m.developer !== F.dev) return false;
  if (F.type && m.restrictions !== F.type) return false;
  const minSize = minFileSize(m);
  if (F.size === '500' && !(minSize <= 500 * 1024 * 1024)) return false;
  if (F.size === '1500' && !(minSize > 500 * 1024 * 1024 && minSize <= 1500 * 1024 * 1024)) return false;
  if (F.size === '3000' && !(minSize > 1500 * 1024 * 1024 && minSize <= 3000 * 1024 * 1024)) return false;
  if (F.size === '6000' && !(minSize > 3000 * 1024 * 1024 && minSize <= 6000 * 1024 * 1024)) return false;
  if (F.size === 'big' && !(minSize > 6000 * 1024 * 1024)) return false;
  if (F.quant && !m.files.some((f) => f.quant === F.quant)) return false;
  if (F.lang && !(m.languages || []).includes(F.lang)) return false;
  if (F.ctx) {
    // Неизвестный контекст при фильтре скрываем — не обещаем того, чего не знаем.
    if (m.contextTokens == null || m.contextTokens < Number(F.ctx)) return false;
  }
  if (F.ram) {
    const smallest = m.compatibility?.files?.[0];
    if (!smallest || smallest.estimatedMb > Number(F.ram)) return false;
  }
  if (F.cpuok && !['ok', 'limited'].includes(m.compatibility?.level)) return false;
  return true;
}

function catalogSort(models, c) {
  const arr = [...models];
  switch (catFilters.sort) {
    case 'size': arr.sort((a, b) => minFileSize(a) - minFileSize(b) || a.displayName.localeCompare(b.displayName, 'ru')); break;
    case 'purpose': arr.sort((a, b) => String(c.categories[a.category] ?? a.category).localeCompare(String(c.categories[b.category] ?? b.category), 'ru') || a.displayName.localeCompare(b.displayName, 'ru')); break;
    case 'verified': arr.sort((a, b) => String(b.verifiedAt ?? '').localeCompare(String(a.verifiedAt ?? '')) || a.displayName.localeCompare(b.displayName, 'ru')); break;
    default: arr.sort((a, b) => a.displayName.localeCompare(b.displayName, 'ru'));
  }
  return arr;
}

function fillCatalogControls(c) {
  // Назначения — из данных каталога (Этап 1Б §2.1).
  const purposeSel = $('f-purpose');
  if (purposeSel.dataset.filled !== '1') {
    purposeSel.innerHTML = '<option value="">любое</option>' +
      Object.entries(c.purposes || {}).map(([k, v]) => `<option value="${esc(k)}">${esc(v)}</option>`).join('');
    purposeSel.dataset.filled = '1';
  }
  const devSel = $('f-dev');
  if (devSel.dataset.filled !== '1') {
    const devs = [...new Set(c.models.map((m) => m.developer).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ru'));
    devSel.innerHTML = '<option value="">любой</option>' + devs.map((d) => `<option value="${esc(d)}">${esc(d)}</option>`).join('');
    devSel.dataset.filled = '1';
  }
  const quantSel = $('f-quant');
  if (quantSel.dataset.filled !== '1') {
    const quants = [...new Set(c.models.flatMap((m) => m.files.map((f) => f.quant).filter(Boolean)))].sort();
    quantSel.innerHTML = '<option value="">любое</option>' + quants.map((q) => `<option value="${esc(q)}">${esc(q)}</option>`).join('');
    quantSel.dataset.filled = '1';
  }
  const langSel = $('f-lang');
  if (langSel.dataset.filled !== '1') {
    const names = { ru: 'русский', en: 'английский', multi: 'мультиязычные', zh: 'китайский' };
    const langs = [...new Set(c.models.flatMap((m) => m.languages || []))].sort();
    langSel.innerHTML = '<option value="">любой</option>' + langs.map((l) => `<option value="${esc(l)}">${esc(names[l] ?? l)}</option>`).join('');
    langSel.dataset.filled = '1';
  }
}

async function loadCatalog() {
  if (!state.catalog) {
    try { state.catalog = await api('/api/catalog'); } catch (err) { event('каталог: ' + err.message); return; }
  }
  const c = state.catalog;
  $('hw-hint').textContent =
    `Ваш компьютер: CPU: ${c.hardware.cpu.model || '—'} · AVX/AVX2: ${c.hardware.cpu.avx === null ? 'неизвестно' : `${c.hardware.cpu.avx}/${c.hardware.cpu.avx2}`} · ` +
    `RAM: ${(c.hardware.totalRamMb / 1024).toFixed(1)} ГБ (свободно ${(c.hardware.freeRamMb / 1024).toFixed(1)}) · ` +
    `доступно для моделей ≈ ${(c.hardware.recommendation.usableModelRamMb / 1024).toFixed(1)} ГБ · контекст по умолчанию ≤ ${c.hardware.recommendation.maxContextTokens} ток.` +
    (c.hardware.cpu.avx === false ? ' · CPU без AVX/AVX2 — сборка LiteMind совместима, пометки «не рекомендуется» учитывают скорость.' : '') +
    (c.overrideSource ? ` · каталог дополнен (${c.overrideSource === 'remote' ? 'удалённый источник' : 'локальный файл-оверрайд'})` : '');

  fillCatalogControls(c);
  renderCatalog();
}

function renderCatalog() {
  const c = state.catalog;
  const list = $('catalog-list');
  list.innerHTML = '';
  const matched = catalogSort(c.models.filter((m) => catalogMatches(m, c)), c);
  $('cat-count').textContent = `показано ${matched.length} из ${c.models.length} моделей`;
  if (!matched.length) {
    list.innerHTML = '<div class="muted" style="padding:12px">Ничего не найдено — ослабьте фильтры или измените запрос поиска.</div>';
    return;
  }
  for (const m of matched) list.appendChild(catalogCard(m, c));
}

function levelBadge(m) {
  const lvl = m.compatibility?.level ?? 'not_recommended';
  const label = m.compatibility?.levelLabel ?? '—';
  return `<span class="tag ${LEVEL_CLASS[lvl]}">${esc(label)}</span>`;
}

function fmtCtx(m) {
  if (m.contextTokens == null) return 'контекст: неизвестно';
  return `контекст ${m.contextTokens >= 1024 ? Math.round(m.contextTokens / 1024) + 'К' : m.contextTokens} ток.`;
}

function catalogCard(m, c) {
  const div = document.createElement('div');
  div.className = 'catalog-item';
  const rec = m.compatibility.recommended;
  const smallest = m.compatibility?.files?.[0];
  const installed = m.installed || m.downloaded ? '<span class="tag ok-tag">скачана</span>' : '';
  const unc = m.restrictions === 'reduced' ? `<span class="tag">${esc(m.uncensoredLabel || 'ослабленные ограничения')}</span>` : '';
  const purposes = (m.purposes || []).map((p) => purposeLabel(c, p)).join(' · ');
  const reason = (m.compatibility?.levelReasons || [])[0] ? esc(m.compatibility.levelReasons[0]) : '';
  div.innerHTML = `
    <div class="model-item-main">
      <div class="model-item-title"><span class="dot ${m.compatibility.status}"></span>${esc(m.displayName)} ${unc} ${levelBadge(m)} ${installed}</div>
      <div class="model-item-sub">${esc(m.developer ?? 'разработчик неизвестен')} · ${esc(m.params)} · ${esc(c.categories[m.category])} · ${fmtCtx(m)} · лицензия: ${esc(m.license || 'не указана')}<br>
        Назначение: ${esc(purposes || '—')}<br>
        ${esc(m.purpose || '')}
        ${reason ? `<br>${m.compatibility.level === 'ok' ? '' : '⚠ '}${reason}` : ''}
      </div>
      <div class="model-item-sub muted">Файл от ${fmtSize(minFileSize(m))}, займёт в памяти ≈ ${smallest ? fmtSize(smallest.estimatedMb * 1024 * 1024) : '—'} (при контексте ${m.compatibility?.contextTokens ?? '—'} ток.) · проверено каталогом: ${esc(m.verifiedAt ?? 'дата неизвестна')}</div>
    </div>
    <div class="model-item-actions">
      <select class="quant-select" aria-label="Квантование" title="Квантование — степень сжатия модели (см. подсказку терминов выше)">
        ${m.files.map((f) => `<option value="${esc(f.name)}" ${rec && f.name === rec.name ? 'selected' : ''}>
          ${esc(f.quant ?? f.name)} · файл ${fmtSize(f.sizeBytes)} · RAM ≈ ${fmtSize((f.estimatedMb ?? 0) * 1024 * 1024)}</option>`).join('')}
      </select>
      <button class="btn-details">Подробнее</button>
      <button class="btn-download">${m.downloaded ? 'Перекачать' : 'Скачать'}</button>
    </div>`;
  div.querySelector('.btn-download')?.addEventListener('click', () => openDownloadDialog(m, div.querySelector('.quant-select').value));
  div.querySelector('.btn-details')?.addEventListener('click', () => openModelDetails(m, c));
  return div;
}

/* Подробная страница модели (§7): все подтверждённые сведения; чего нет —
   честно «неизвестно». Открывается по кнопке «Подробнее». */
function openModelDetails(m, c) {
  const comp = m.compatibility ?? {};
  const fileRows = (comp.files || []).map((f) =>
    `<tr><td>${esc(f.quant ?? '—')}</td><td>${fmtSize(f.sizeBytes)}</td><td>≈ ${fmtSize((f.estimatedMb ?? 0) * 1024 * 1024)}</td><td>${f.status === 'green' ? 'зелёная' : f.status === 'yellow' ? 'жёлтая' : 'красная'}</td></tr>`
  ).join('');
  const na = 'неизвестно';
  const rows = [
    ['Разработчик', esc(m.developer ?? na)],
    ['Описание', esc(m.purpose ?? na)],
    ['Качество', esc(m.quality ?? na)],
    ['Назначение', esc((m.purposes || []).map((p) => purposeLabel(c, p)).join(' · ') || na)],
    ['Языки', esc((m.languages || []).join(', ') || na)],
    ['Лицензия', esc(m.license ?? na) + (m.licenseNote ? ` — ${esc(m.licenseNote)}` : '')],
    ['Формат', 'GGUF' + (m.files.length ? ` · доступно вариантов квантования: ${m.files.length}` : '')],
    ['Контекст', m.contextTokens == null ? 'неизвестно (оценка памяти дана для контекста по умолчанию)' : `${m.contextTokens} токенов`],
    ['Источник', `<a href="${esc(m.source)}" target="_blank" rel="noopener noreferrer">${esc(m.repo ?? m.source)}</a>`],
    ['Автор квантования', esc(m.quantAuthor ?? na)],
    ['Требования CPU', esc(comp.hwRequirements?.cpu ?? na)],
    ['Требования GPU', esc(comp.hwRequirements?.gpu ?? na)],
    ['Требования RAM', esc(comp.hwRequirements?.ram ?? na)],
    ['Windows', esc(comp.hwRequirements?.windows ?? 'Windows 10/11 x64')],
    ['Совместимость', `${esc(comp.levelLabel ?? '—')}${(comp.levelReasons || []).length ? '<br>' + comp.levelReasons.map((r) => '• ' + esc(r)).join('<br>') : ''}`],
    ['Проверено каталогом', esc(m.verifiedAt ?? na)]
  ];
  if (m.notes) rows.push(['Примечание', esc(m.notes)]);
  const html = `
    ${rows.map(([k, v]) => `<b>${k}</b><span>${v}</span>`).join('')}
    <b>Файлы GGUF</b>
    <table class="quant-table"><thead><tr><th>Квант</th><th>Файл</th><th>В RAM</th><th>Совместимость</th></tr></thead><tbody>${fileRows}</tbody></table>
    <p class="muted small">«В RAM» — оценка памяти при запуске с контекстом ${comp.contextTokens ?? '—'} ток. (веса × 1,15 + KV-кэш); размер файла и память — разные величины. Инструменты (tool-calling) и работа с интернетом не обещаются: runtime LiteMind не предоставляет их для GGUF.</p>`;
  $('model-dialog-title').textContent = `О модели: ${m.displayName}`;
  $('model-dialog-body').innerHTML = html;
  $('model-dialog').hidden = false;
}
$('model-dialog-close').addEventListener('click', () => { $('model-dialog').hidden = true; });
$('model-dialog').addEventListener('click', (e) => { if (e.target === $('model-dialog')) $('model-dialog').hidden = true; });

/* Выбор модели по задаче (§3): фильтрует каталог и объясняет, почему
   модели подходят. Автопереключение активной модели чата не выполняется. */
document.querySelectorAll('#task-picks button[data-task]').forEach((b) =>
  b.addEventListener('click', () => {
    const task = b.dataset.task;
    catFilters.task = task;
    const explain = $('task-explain');
    if (task) {
      explain.hidden = false;
      explain.textContent = TASKS[task].why + ' Модель в чате не переключается автоматически: после скачивания выберите её во вкладке «Установленные модели» или в списке под полем ввода чата.';
    } else {
      explain.hidden = true;
    }
    renderCatalog();
  }));

const bindCatFilter = (id, key, ev = 'change') => {
  const el = $(id);
  el.addEventListener(ev, () => {
    catFilters[key] = el.type === 'checkbox' ? el.checked : el.value;
    renderCatalog();
  });
};
bindCatFilter('cat-search', 'search', 'input');
bindCatFilter('f-purpose', 'purpose');
bindCatFilter('f-dev', 'dev');
bindCatFilter('f-type', 'type');
bindCatFilter('f-size', 'size');
bindCatFilter('f-quant', 'quant');
bindCatFilter('f-lang', 'lang');
bindCatFilter('f-ctx', 'ctx');
bindCatFilter('f-ram', 'ram');
bindCatFilter('f-cpuok', 'cpuok');
bindCatFilter('f-sort', 'sort');

/* ============================ диалог загрузки модели ============================ */
/* ТЗ §5.1–§5.3: перед загрузкой — название, файл+квант, размер, источник,
   лицензия, полный путь сохранения, свободное место и оценка RAM; при первой
   загрузке — нативный диалог выбора папки с рекомендацией диска E:; выбранная
   папка сохраняется как папка по умолчанию. */
let dlPending = null; // { model, fileName }
const AUTO_VERIFIED = new Set(); // «modelId/имя файла» — автопроверка уже сделана

const pathSep = () => (navigator.platform?.toLowerCase().includes('win') ? '\\' : '/');

function openDownloadDialog(m, fileName) {
  dlPending = { model: m, fileName };
  const file = m.files.find((f) => f.name === fileName) ?? m.files[0];
  const comp = m.compatibility ?? {};
  let dir = $('dl-dir').value.trim() || localStorage.getItem('litemind-dl-last-dir') || (state.catalog?.modelsRootDir ?? '');
  // §5.1: при первой загрузке рекомендуем диск E:, если он доступен.
  const firstTime = !localStorage.getItem('litemind-dl-dir-chosen');
  if (firstTime) {
    const disks = state.catalog?.hardware?.disks || [];
    const eDisk = disks.find((d) => d.root?.toUpperCase().startsWith('E') && d.exists);
    if (eDisk) dir = eDisk.root + (dir.includes('\\') ? 'LiteMind\\models' : 'LiteMind/models');
  }
  $('dl-title').textContent = `Загрузка: ${m.displayName}`;
  const lvl = comp.level ?? comp.status;
  const levelText = { ok: 'подходит', limited: 'подходит с ограничениями', not_recommended: 'не рекомендуется', incompatible: 'несовместима' }[lvl]
    ?? (comp.status === 'green' ? 'зелёная — подходит' : comp.status === 'yellow' ? 'жёлтая — с ограничениями' : 'красная — не рекомендуется');
  const kvMb = (comp.contextTokens ?? 4096) * 64 / 1024;
  const ramAfter = Math.round((file.sizeBytes / 1048576) * 1.15 + kvMb + 256);
  const rows = [
    ['Разработчик', esc(m.developer ?? 'неизвестно')],
    ['Файл', `${esc(fileName)} · квантование ${esc(file.quant ?? '—')}`],
    ['Размер файла', fmtSize(file.sizeBytes)],
    ['Займёт в памяти после загрузки', `≈ ${fmtSize(ramAfter * 1024 * 1024)} (веса + KV-кэш при контексте ${comp.contextTokens ?? 4096} ток.) — размер файла ≠ память`],
    ['Лицензия', esc(m.license ?? 'неизвестно') + (m.licenseNote ? ` — ${esc(m.licenseNote)}` : '')],
    ['Источник', `<a href="${esc(m.source)}" target="_blank" rel="noopener noreferrer">${esc(m.repo ?? m.source)}</a>`],
    ['Совместимость', esc(levelText) + (comp.speedNote ? ` — ${esc(comp.speedNote)}` : '')],
    ['Сохранить в', `<span id="dl-fullpath">${esc(joinPath(dir, fileName))}</span>`]
  ];
  $('dl-info').innerHTML = rows.map(([k, v]) => `<b>${k}</b><span>${v}</span>`).join('');
  $('dl-dir').value = dir;
  updateDlSpace();
  $('dl-dialog').hidden = false;
  $('dl-go').focus();
  // §5.1: при первой загрузке сразу открываем нативный диалог выбора папки —
  // пользователь сразу видит и может изменить место хранения.
  if (firstTime && bridge()?.pickFolder && !$('dl-pick').dataset.autoOpened) {
    $('dl-pick').dataset.autoOpened = '1';
    $('dl-pick').click();
  }
}

function joinPath(dir, name) {
  if (!dir) return name;
  return dir.replace(/[\\/]+$/, '') + pathSep() + name;
}

function closeDownloadDialog() { dlPending = null; $('dl-dialog').hidden = true; }

/* Свободное место под выбранной папкой: /api/hardware отдаёт диски (root, freeBytes).
   Место — по диску, на котором лежит папка; предупреждение — честное, по фактическому размеру файла. */
async function updateDlSpace() {
  const el = $('dl-space');
  if (!dlPending) return;
  const file = dlPending.model.files.find((f) => f.name === dlPending.fileName) ?? dlPending.model.files[0];
  const dir = $('dl-dir').value.trim();
  const full = joinPath(dir, dlPending.fileName);
  const fp = $('dl-fullpath');
  if (fp) fp.textContent = full;
  let disk = null;
  try {
    const hw = await api('/api/hardware');
    const d = (dir || '').replace(/[\\/]+$/, '').toLowerCase();
    disk = (hw.disks || []).filter((x) => x.exists && x.freeBytes != null)
      .find((x) => d.startsWith(String(x.root).toLowerCase())) ?? null;
  } catch { /* движок offline */ }
  if (!disk) {
    el.className = 'dl-space';
    el.textContent = `Полный путь: ${full}. Свободное место на диске определить не удалось — проверьте вручную.`;
    return;
  }
  const free = disk.freeBytes;
  const enough = file.sizeBytes && free > file.sizeBytes;
  el.className = 'dl-space ' + (enough ? '' : 'bad');
  el.textContent = enough
    ? `Диск ${disk.root}: свободно ${fmtSize(free)} — достаточно для ${fmtSize(file.sizeBytes)}.`
    : `Диск ${disk.root}: свободно только ${fmtSize(free)} — НЕ ХВАТИТ на ${fmtSize(file.sizeBytes)}. Выберите другой диск.`;
  $('dl-go').disabled = !enough;
}

$('dl-dir').addEventListener('input', () => updateDlSpace());
$('dl-cancel').addEventListener('click', closeDownloadDialog);
$('dl-dialog').addEventListener('click', (e) => { if (e.target === $('dl-dialog')) closeDownloadDialog(); });
$('dl-pick').addEventListener('click', async () => {
  const b = bridge();
  if (!b?.pickFolder) { showError('Стандартный диалог выбора папки доступен в LiteMind Desktop. В браузере введите путь вручную.'); return; }
  const r = await b.pickFolder('Папка для моделей', $('dl-dir').value.trim() || undefined).catch(() => null);
  if (r?.ok && r.path) {
    $('dl-dir').value = r.path;
    localStorage.setItem('litemind-dl-last-dir', r.path); // §5.1: папка по умолчанию для следующих загрузок
    localStorage.setItem('litemind-dl-dir-chosen', '1'); // §5.1: больше не подсказываем
    updateDlSpace();
  }
});
$('dl-go').addEventListener('click', async (e) => {
  if (!dlPending) return;
  const { model: m, fileName } = dlPending;
  const targetDir = $('dl-dir').value.trim();
  if (!targetDir) { showError('Укажите папку сохранения.'); return; }
  $('dl-go').disabled = true;
  const overwrite = e.detail?.overwrite === true;
  try {
    // §5.1: выбранная папка становится папкой по умолчанию для следующих загрузок.
    await api('/api/settings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ modelsRootDir: targetDir }) }).catch(() => {});
    localStorage.setItem('litemind-dl-dir-chosen', '1');
    const r = await api('/api/downloads', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ modelId: m.id, fileName, targetDir, overwrite }) });
    if (r.alreadyDownloaded) {
      // §5.5: проверенный файл уже существует — повторная загрузка не нужна.
      event(`${m.displayName}: ${r.message}`);
      showError(r.message);
      closeDownloadDialog();
      return;
    }
    event(`загрузка начата: ${m.displayName} · ${fileName} → ${targetDir}`);
    closeDownloadDialog();
    openTab('downloads');
  } catch (err) {
    if (err.message.includes('Подтвердите замену') && !overwrite) {
      // §5.5: существующий файл не перезаписываем без явного подтверждения.
      closeDownloadDialog();
      if (confirm(`В выбранной папке уже есть файл «${fileName}» с другим размером. Перезаписать его?`)) {
        openDownloadDialog(m, fileName);
        $('dl-go').dispatchEvent(new CustomEvent('click', { detail: { overwrite: true } }));
      }
      return;
    }
    showError('ошибка загрузки: ' + err.message); // 507 (нет места) остаётся в диалоге
    $('dl-go').disabled = false;
    updateDlSpace();
  }
});


/* ============================ Загрузки ============================ */
const AUTO_INSTALLED = new Set();

async function refreshDlBadge() {
  try {
    const data = await api('/api/downloads');
    const active = data.downloads.filter((d) => ['downloading', 'paused'].includes(d.state)).length;
    const b = $('dl-count');
    b.hidden = !active;
    b.textContent = active;
  } catch { /* — */ }
}

async function refreshDownloads() {
  let data;
  try { data = await api('/api/downloads'); } catch { return; }
  const ul = $('download-list');
  $('guf-dir').textContent = 'Папка: ' + (data.rootDir || '—');
  ul.innerHTML = '';
  if (!data.downloads.length) {
    ul.innerHTML = '<li class="muted">нет активных загрузок</li>';
    refreshDlBadge();
    return;
  }
  for (const d of data.downloads) {
    const li = document.createElement('li');
    const pct = d.percent ?? 0;
    const speed = d.speedBps ? ` · ${(d.speedBps / 1024 / 1024).toFixed(1)} МБ/с` : '';
    const eta = d.etaSeconds ? ` · осталось ~${Math.ceil(d.etaSeconds / 60)} мин` : '';
    li.innerHTML = `
      <div class="model-item-main">
        <div class="model-item-title">${esc(d.name)}</div>
        <div class="model-item-sub">${esc(d.state)} · ${fmtSize(d.receivedBytes)} / ${fmtSize(d.sizeBytes)}${speed}${eta}
          ${d.error ? '<br><span style="color:var(--bad)">' + esc(d.error) + '</span>' : ''}</div>
        <div class="progress"><i style="width:${pct}%"></i></div>
        ${d.state === 'done' ? `<div class="dl-verify" data-key="${esc(d.modelId ?? '')}/${esc(d.name)}">проверяю целостность файла…</div>` : ''}
      </div>
      <div class="model-item-actions">
        ${d.state === 'downloading' ? '<button class="act-pause">Пауза</button>' : ''}
        ${['paused', 'error'].includes(d.state) ? '<button class="act-resume">Продолжить</button>' : ''}
        ${['downloading', 'paused', 'error'].includes(d.state) ? '<button class="act-cancel danger">Отменить</button>' : ''}
        ${d.state === 'done' ? '<button class="act-install">Применить</button>' : ''}
      </div>`;
    const act = (action) => async () => {
      try { await api(`/api/downloads/${d.id}/${action}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }); }
      catch (err) { showError(err.message); }
      refreshDownloads();
    };
    li.querySelector('.act-pause')?.addEventListener('click', act('pause'));
    li.querySelector('.act-resume')?.addEventListener('click', act('resume'));
    li.querySelector('.act-cancel')?.addEventListener('click', act('cancel'));
    li.querySelector('.act-install')?.addEventListener('click', () =>
      api('/api/install', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ggufPath: `${d.targetDir}/${d.name}` }) })
        .then((r) => { event(`${r.skipped ? 'модель готова' : 'установлено'}: ${r.model}`); refreshDownloads(); refreshStatus(); })
        .catch((err) => showError('установка: ' + err.message)));
    ul.appendChild(li);

    if (d.state === 'done' && d.modelId && !AUTO_INSTALLED.has(d.id)) {
      AUTO_INSTALLED.add(d.id);
      // При lmlama «установка» не нужна — модель видна сразу. Просто обновим списки.
      api('/api/install', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ modelId: d.modelId, fileName: d.name, targetDir: d.targetDir }) })
        .then((r) => event(`${r.skipped ? 'модель готова к чату' : 'автоустановка завершена'}: ${r.model}`))
        .catch((err) => event(`(${d.name}): ${err.message}`));
    }
    // Автопроверка целостности после скачивания (ТЗ Этап 1 §7): сверка с
    // эталоном HF по размеру и SHA-256 — результат прямо в списке загрузок.
    const vKey = `${d.modelId ?? ''}/${d.name}`;
    if (d.state === 'done' && d.modelId && !AUTO_VERIFIED.has(vKey)) {
      AUTO_VERIFIED.add(vKey);
      api('/api/models/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ modelId: d.modelId, fileName: d.name }) })
        .then((r) => {
          const el = ul.querySelector(`.dl-verify[data-key="${CSS.escape(vKey)}"]`);
          const shaNote = r.shaOk
            ? `✓ целостность подтверждена: размер и SHA-256 совпадают с эталоном Hugging Face`
            : r.verified
              ? `✓ размер совпадает; SHA-256 ${esc(String(r.sha256).slice(0, 12))}… вычислен локально — это проверка целостности, а не подтверждение источника`
              : `⚠ ${r.message ?? 'файл повреждён'}`;
          if (el) { el.textContent = shaNote; el.className = 'dl-verify ' + (r.verified ? 'ok' : 'bad'); }
          event(`проверка ${d.name}: ${r.verified ? 'цел' : 'повреждён'}`);
        })
        .catch(() => {});
    }
  }
  refreshDlBadge();
}

/* ============================ Проекты (Этап 1В §2) ============================ */
const PROJ_KEY = 'litemind-project-dir';
const PROJ_RECENT_KEY = 'litemind-projects-recent'; // массив недавних папок (до 8)
const PROJ_EXCLUDES_KEY = 'litemind-proj-excludes';

const proj = { active: null }; // активный проект: {dir, name} | null
const recentUnavailable = new Map(); // dir -> reason (в памяти, до перезагрузки UI)

function projExcludes() {
  return (localStorage.getItem(PROJ_EXCLUDES_KEY) || '')
    .split(',').map((s) => s.trim()).filter(Boolean).slice(0, 32);
}

function recentProjects() {
  try { return JSON.parse(localStorage.getItem(PROJ_RECENT_KEY) || '[]').filter((p) => typeof p === 'string'); } catch { return []; }
}

function rememberProject(dir) {
  const list = recentProjects().filter((p) => p !== dir);
  list.unshift(dir);
  localStorage.setItem(PROJ_RECENT_KEY, JSON.stringify(list.slice(0, 8)));
  localStorage.setItem(PROJ_KEY, dir);
  renderRecentProjects();
}

function forgetProject(dir) {
  const list = recentProjects().filter((p) => p !== dir);
  localStorage.setItem(PROJ_RECENT_KEY, JSON.stringify(list));
  renderRecentProjects();
  event(`проект убран из списка недавних (файлы не тронуты): ${dir}`);
}

function markRecentUnavailable(dir, reason) {
  recentUnavailable.set(dir, reason || 'недоступна');
  renderRecentProjects();
}

function baseName(p) { return String(p || '').split(/[\\/]/).filter(Boolean).pop() || String(p || ''); }

function renderRecentProjects() {
  const wrap = $('proj-recent');
  if (!wrap) return;
  const list = recentProjects();
  $('proj-recent-card').hidden = !list.length;
  wrap.innerHTML = '';
  if (!list.length) return;
  for (const p of list) {
    const bad = recentUnavailable.get(p);
    const row = document.createElement('div');
    row.className = 'proj-recent-row' + (bad ? ' unavailable' : '');
    const info = document.createElement('div');
    info.className = 'proj-recent-info';
    info.innerHTML = `<div class="proj-recent-name">${esc(baseName(p))}</div>
      <div class="mono muted proj-recent-path">${esc(p)}</div>
      ${bad ? `<div class="proj-recent-bad">папка недоступна: ${esc(bad)}</div>` : ''}`;
    const actions = document.createElement('div');
    actions.className = 'proj-recent-actions';
    const open = document.createElement('button');
    open.textContent = 'Открыть';
    open.disabled = !!bad;
    open.title = bad ? 'Папка недоступна — проверьте, не перемещена ли она' : `Открыть ${p}`;
    open.addEventListener('click', () => { $('proj-dir').value = p; openProjectDir(p); });
    const del = document.createElement('button');
    del.textContent = 'Убрать из списка';
    del.title = 'Удалить только из списка недавних — файлы на диске не затрагиваются';
    del.addEventListener('click', () => forgetProject(p));
    actions.append(open, del);
    row.append(info, actions);
    wrap.appendChild(row);
  }
}

function renderActiveProject() {
  const card = $('proj-active-card');
  if (!card) return;
  if (!proj.active) { card.hidden = true; return; }
  card.hidden = false;
  $('proj-active-name').textContent = proj.active.name;
  $('proj-active-path').textContent = proj.active.dir;
  $('proj-active-state').textContent = 'открыт';
  $('proj-active-state').className = 'state-value ok';
}

async function copyToClipboard(text) {
  try { await navigator.clipboard.writeText(text); return true; }
  catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove();
    return ok;
  }
}

function openProjectFolder(dir) {
  const b = bridge();
  if (!b?.shellOpenPath) { showError('Открытие папки в проводнике доступно в LiteMind Desktop.'); return; }
  b.shellOpenPath(dir).then((r) => {
    if (r?.ok === false) showError('Не удалось открыть папку: ' + (r.error ?? '—'));
  }).catch(() => showError('Не удалось открыть папку.'));
}

/* Открытие проекта: сначала честная проверка папки (§2 — недоступная папка
   не становится активной), затем сканирование и синхронизация Workspace и
   Terminal (§5). */
async function openProjectDir(dirRaw) {
  const dir = String(dirRaw || $('proj-dir').value || '').trim();
  if (!dir) { showError('Укажите папку проекта.'); return false; }
  if (ws.dirty && !confirm('В редакторе есть несохранённые изменения. Открыть другой проект и потерять их?')) return false;
  $('proj-summary').textContent = 'проверяю папку…';
  let r;
  try {
    r = await api('/api/project/open', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: dir }) });
  } catch (err) {
    $('proj-summary').textContent = '';
    showError('папка недоступна: ' + err.message);
    return false;
  }
  if (!r.ok) {
    $('proj-summary').textContent = '';
    showError(`Папка недоступна: ${r.reason}. Проект НЕ открыт.`);
    markRecentUnavailable(r.path ?? dir, r.reason);
    return false;
  }
  recentUnavailable.delete(r.path);
  const previousDir = state.projDir;
  proj.active = { dir: r.path, name: r.name };
  state.projDir = r.path;
  $('proj-dir').value = r.path;
  rememberProject(r.path);
  renderActiveProject();
  renderRecentProjects();
  $('proj-summary').textContent = `Проект открыт: ${r.name} — сканирую…`;
  // Workspace переключается на новый проект; контекст чата сбрасывается —
  // он собран из файлов старого проекта.
  if (previousDir !== r.path) wsResetForNewProject();
  state.wsDir = r.path;
  $('ws-dir').textContent = r.path;
  $('ws-proj-name').textContent = r.name;
  wsCtx.clear();
  renderWsCtx();
  // Terminal: рабочая папка следует за проектом (§5).
  $('term-cwd').value = r.path;
  syncTermCwdLabel();
  $('proj-report-card').hidden = true;
  scanProject(false, { silent: true });
  event(`проект открыт: ${r.path}`);
  return true;
}

function closeProject() {
  if (!proj.active) return;
  if (ws.dirty && !confirm('В редакторе остались несохранённые изменения. Закрыть проект и потерять их?')) return;
  const closedDir = state.projDir;
  proj.active = null;
  state.projDir = null;
  localStorage.removeItem(PROJ_KEY);
  wsResetForNewProject();
  state.wsDir = null;
  $('ws-dir').textContent = '—';
  $('ws-proj-name').textContent = '—';
  $('proj-summary').textContent = 'Проект закрыт. Файлы на диске не изменялись.';
  $('proj-report-card').hidden = true;
  if (closedDir && $('term-cwd').value.trim() === closedDir) {
    $('term-cwd').value = '';
    syncTermCwdLabel();
  }
  renderActiveProject();
  event('проект закрыт — файлы на диске не тронуты');
}

/* Карта проекта: индексация (для умного поиска) + отчёт. */
async function scanProject(force, { silent = false } = {}) {
  const dir = state.projDir || $('proj-dir').value.trim();
  if (!dir) { if (!silent) showError('Укажите папку проекта.'); return; }
  $('proj-summary').textContent = silent ? 'сканирование…' : $('proj-summary').textContent || 'сканирование…';
  try {
    const s = await api('/api/project/scan', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: dir, force: force === true }) });
    $('proj-summary').textContent = `Проект открыт: ${proj.active?.name ?? dir}`;
    const exts = Object.entries(s.byExt ?? {})
      .sort((a, b) => b[1] - a[1])
      .map(([ext, n]) => `${ext} ×${n}`);
    const lines = [
      ['Папка', dir],
      ['Файлов просканировано', s.fileCount ?? s.filesCount ?? s.files ?? '—'],
      ['Типы файлов', exts.length ? exts.join(', ') : null]
    ].filter(([, v]) => v !== null && v !== undefined);
    const dl = $('proj-report');
    dl.innerHTML = '';
    for (const [k, v] of lines) {
      const dt = document.createElement('dt'); dt.textContent = k;
      const dd = document.createElement('dd'); dd.textContent = String(v);
      dl.append(dt, dd);
    }
    $('proj-report-card').hidden = false;
    state.wsDir = dir;
    wsReloadTree();
    if (!silent) event(`проект просканирован: ${dir}`);
  } catch (err) {
    if (!silent) showError('сканирование: ' + err.message);
  }
}

/* Структура проекта в чат (§2: передать структуру) — только по кнопке. */
async function sendProjectStructureToChat() {
  const dir = state.projDir;
  if (!dir) { showError('Сначала откройте проект.'); return; }
  try {
    await api('/api/project/scan', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: dir, force: false }) });
    const m = await api(`/api/project/map?path=${encodeURIComponent(dir)}`);
    if (m.error || !(m.files ?? []).length) { showError('Карта пуста — в проекте не найдено текстовых файлов.'); return; }
    const lines = [`Структура проекта ${baseName(m.root)} (путь: ${m.root}):`];
    for (const f of (m.files ?? []).slice(0, 150)) {
      const syms = (f.symbols ?? []).map((s) => String(s).split(':')[0]).slice(0, 5).join(', ');
      lines.push(`- ${f.file} (${f.lines} стр.)${syms ? ' — ' + syms : ''}`);
    }
    if ((m.files ?? []).length > 150) lines.push(`… и ещё ${m.files.length - 150} файлов`);
    const text = lines.join('\n');
    pendingAttachments.push({ name: 'project-structure.txt', kind: 'txt', chars: text.length, text, warning: null });
    renderAttachBar();
    event(`структура проекта передана в чат (${m.files.length} файлов)`);
    openTab('chat');
  } catch (err) {
    showError('структура проекта: ' + err.message);
  }
}

$('btn-proj-scan').addEventListener('click', () => openProjectDir());
$('btn-proj-rescan').addEventListener('click', () => scanProject(true));
$('btn-proj-pick').addEventListener('click', async () => {
  const b = bridge();
  if (!b?.pickFolder) { showError('Стандартный диалог выбора папки доступен в LiteMind Desktop. В браузере введите путь вручную.'); return; }
  const r = await b.pickFolder('Папка проекта', $('proj-dir').value.trim() || undefined).catch(() => null);
  if (r?.ok && r.path) {
    $('proj-dir').value = r.path;
    openProjectDir(r.path);
  }
});
/* Создание папки проекта: пользователь выбирает/создаёт её в нативном
   диалоге Windows, движок делает mkdir -p и открывает проект. */
$('btn-proj-create').addEventListener('click', async () => {
  let dir = $('proj-dir').value.trim();
  const b = bridge();
  if (b?.pickFolder) {
    const r = await b.pickFolder('Выберите или создайте папку проекта', dir || undefined).catch(() => null);
    if (r?.ok && r.path) dir = r.path;
    else if (!r?.ok) return;
  }
  if (!dir) { showError('Укажите путь к новой папке проекта.'); return; }
  try {
    const r = await api('/api/project/create', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: dir }) });
    if (!r.ok) { showError('Не удалось создать папку: ' + (r.reason ?? 'ошибка')); return; }
    event(`создана папка проекта: ${r.path}`);
    $('proj-dir').value = r.path;
    openProjectDir(r.path);
  } catch (err) {
    showError('создание папки: ' + err.message);
  }
});
$('btn-proj-close').addEventListener('click', closeProject);
$('btn-proj-openfolder').addEventListener('click', () => { if (proj.active) openProjectFolder(proj.active.dir); });
$('btn-proj-copypath').addEventListener('click', async () => {
  if (!proj.active) return;
  const ok = await copyToClipboard(proj.active.dir);
  if (ok) event('путь проекта скопирован в буфер');
});
$('btn-proj-structure-chat').addEventListener('click', sendProjectStructureToChat);
$('btn-proj-structure-chat2').addEventListener('click', sendProjectStructureToChat);
$('proj-excludes').addEventListener('change', (e) => {
  localStorage.setItem(PROJ_EXCLUDES_KEY, e.target.value.trim());
  event('исключения сканирования сохранены');
  if (state.wsDir) wsReloadTree();
});

$('btn-proj-search').addEventListener('click', async () => {
  const dir = state.projDir || $('proj-dir').value.trim();
  const q = $('proj-query').value.trim();
  if (!dir || !q) { showError('Откройте проект и введите запрос.'); return; }
  const out = $('proj-results');
  out.innerHTML = '<li class="muted">поиск…</li>';
  try {
    const r = await api(`/api/project/search?path=${encodeURIComponent(dir)}&q=${encodeURIComponent(q)}&limit=10`);
    out.innerHTML = '';
    if (!r.results?.length) { out.innerHTML = '<li class="muted">совпадений нет</li>'; return; }
    for (const hit of r.results) {
      const li = document.createElement('li');
      li.innerHTML = `<div class="model-item-title mono">${esc(hit.file)}</div>
        <div class="model-item-sub"><pre style="margin:4px 0 0;white-space:pre-wrap;font-family:inherit">${esc((hit.snippet || hit.line || '').slice(0, 400))}</pre></div>`;
      out.appendChild(li);
    }
    event(`поиск «${q}»: ${r.results.length} совпадений`);
  } catch (err) {
    out.innerHTML = '';
    showError('поиск: ' + err.message);
  }
});

function loadProjects() {
  $('proj-excludes').value = localStorage.getItem(PROJ_EXCLUDES_KEY) || '';
  const saved = localStorage.getItem(PROJ_KEY);
  if (saved && !$('proj-dir').value) $('proj-dir').value = saved;
  renderRecentProjects();
  renderActiveProject();
  // Проверяем сохранённый проект в фоне: папку могли переместить/переименовать.
  if (saved && !proj.active) {
    api('/api/project/open', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: saved }) })
      .then((r) => {
        if (r.ok) {
          proj.active = { dir: r.path, name: r.name };
          state.projDir = r.path;
          renderActiveProject();
          state.wsDir = r.path;
          $('ws-dir').textContent = r.path;
          $('ws-proj-name').textContent = r.name;
          scanProject(false, { silent: true });
        } else {
          markRecentUnavailable(r.path ?? saved, r.reason);
          $('proj-summary').textContent = `Сохранённая папка недоступна (${r.reason}). Выберите её заново или откройте другую.`;
        }
      })
      .catch(() => { /* движок ещё поднимается — при следующем входе проверим */ });
  }
}

/* ============================ Workspace (Этап 1В §3) ============================ */
const ws = { file: null, mtime: null, dirty: false, expanded: new Set(), treeCache: new Map(), findSeq: 0 };
const wsCtx = {
  items: new Set(), // относительные пути файлов и папок (папка — со слешем)
  add(p) { this.items.add(p); },
  remove(p) { this.items.delete(p); },
  clear() { this.items.clear(); },
  has(p) { return this.items.has(p); }
};

function loadWorkspace() {
  if (state.wsDir) {
    $('ws-dir').textContent = state.wsDir;
    if (proj.active) $('ws-proj-name').textContent = proj.active.name;
    else $('ws-proj-name').textContent = baseName(state.wsDir);
    if (!$('ws-tree').dataset.loaded) wsReloadTree();
  }
}

function wsResetForNewProject() {
  // Подтверждение о несохранённых правках делают вызывающие
  // (openProjectDir/closeProject) — здесь только очистка состояния.
  ws.file = null;
  ws.mtime = null;
  ws.dirty = false;
  ws.expanded = new Set();
  ws.treeCache = new Map();
  $('ws-editor').value = '';
  $('ws-editor').placeholder = 'Выберите файл слева…';
  $('ws-file-label').textContent = 'файл не выбран';
  $('ws-dirty').hidden = true;
  $('ws-note').textContent = '';
  $('ws-aipanel').hidden = true;
  aiChange = null;
  $('ws-tree').dataset.loaded = '';
  $('ws-find').value = '';
  const tree = $('ws-tree');
  tree.innerHTML = '<span class="muted">Проект открыт — строю дерево файлов…</span>';
}

function wsReloadTree() {
  if (!state.wsDir) return;
  ws.treeCache = new Map();
  ws.treeSeq = (ws.treeSeq ?? 0) + 1;
  $('ws-tree').dataset.loaded = '1';
  wsRenderLevel('');
}

/* Один уровень дерева: /api/project/tree отдаёт детей одного каталога. */
async function wsRenderLevel(relDir) {
  const seq = ws.treeSeq ?? 0;
  let data = ws.treeCache.get(relDir || '.');
  if (!data) {
    try {
      const params = new URLSearchParams({ path: state.wsDir, dir: relDir, exclude: projExcludes().join(',') });
      data = await api(`/api/project/tree?${params}`);
      ws.treeCache.set(relDir || '.', data);
    } catch (err) {
      if (seq !== (ws.treeSeq ?? 0)) return;
      if (relDir === '') $('ws-tree').innerHTML = `<span class="muted">дерево недоступно: ${esc(err.message)}</span>`;
      else showError('дерево файлов: ' + err.message);
      return;
    }
  }
  if (seq !== (ws.treeSeq ?? 0)) return; // проект уже переключили
  const container = relDir === '' ? $('ws-tree') : document.querySelector(`[data-ws-dir="${CSS.escape(relDir)}"] .ws-children`);
  if (!container) return;
  container.innerHTML = '';
  if (data.truncated) {
    const note = document.createElement('div');
    note.className = 'muted ws-note-row';
    note.textContent = `показаны первые ${data.dirs.length + data.files.length} из ${data.totalEntries} записей — сузьте исключениями`;
    container.appendChild(note);
  }
  for (const d of data.dirs) {
    const row = document.createElement('div');
    row.className = 'ws-node ws-dir-row';
    row.dataset.wsDir = d.rel;
    const open = ws.expanded.has(d.rel);
    const toggle = document.createElement('button');
    toggle.className = 'ws-toggle';
    toggle.textContent = d.hasChildren === false ? '·' : (open ? '▾' : '▸');
    toggle.disabled = d.hasChildren === false;
    toggle.title = open ? 'Свернуть' : 'Развернуть';
    const name = document.createElement('button');
    name.className = 'ws-dir-name';
    name.textContent = d.name;
    name.title = d.rel;
    const ctxBtn = document.createElement('button');
    ctxBtn.className = 'ws-ctx-add';
    ctxBtn.textContent = '＋ чат';
    ctxBtn.title = `Добавить папку ${d.rel}/ в контекст чата (первые 30 текстовых файлов)`;
    ctxBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      wsCtx.add(d.rel + '/');
      renderWsCtx();
      event(`в контекст чата добавлена папка: ${d.rel}/`);
    });
    row.append(toggle, name, ctxBtn);
    const kids = document.createElement('div');
    kids.className = 'ws-children';
    kids.hidden = !open;
    row.appendChild(kids);
    const expand = () => {
      ws.expanded.add(d.rel);
      kids.hidden = false;
      toggle.textContent = '▾';
      if (!kids.dataset.loaded) { kids.dataset.loaded = '1'; wsRenderLevel(d.rel); }
    };
    const collapse = () => {
      ws.expanded.delete(d.rel);
      kids.hidden = true;
      toggle.textContent = '▸';
    };
    toggle.addEventListener('click', (e) => { e.stopPropagation(); kids.hidden ? expand() : collapse(); });
    name.addEventListener('click', () => { kids.hidden ? expand() : collapse(); });
    container.appendChild(row);
  }
  for (const f of data.files) {
    const row = document.createElement('div');
    row.className = 'ws-node ws-file-row';
    const btn = document.createElement('button');
    btn.className = 'ws-file' + (f.binary ? ' ws-file-binary' : '');
    btn.textContent = f.name;
    btn.title = `${f.rel}${f.sizeBytes != null ? ` · ${fmtSize(f.sizeBytes)}` : ''}${f.binary ? ' · бинарный (только в чат не передаётся)' : ''}`;
    btn.dataset.wsFile = f.rel;
    btn.addEventListener('click', () => openWsFile(f.rel, btn));
    const ctxBtn = document.createElement('button');
    ctxBtn.className = 'ws-ctx-add';
    ctxBtn.textContent = wsCtx.has(f.rel) ? '✓ чат' : '＋ чат';
    ctxBtn.title = `Добавить ${f.rel} в контекст чата`;
    ctxBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (wsCtx.has(f.rel)) wsCtx.remove(f.rel);
      else wsCtx.add(f.rel);
      renderWsCtx();
    });
    row.append(btn, ctxBtn);
    container.appendChild(row);
  }
  if (!data.dirs.length && !data.files.length) {
    container.innerHTML = '<div class="muted ws-note-row">пустой каталог</div>';
  }
}

/* Поиск файлов по имени (замещает дерево на время набора). */
let wsFindTimer = null;
$('ws-find').addEventListener('input', () => {
  clearTimeout(wsFindTimer);
  wsFindTimer = setTimeout(wsRunFind, 300);
});

async function wsRunFind() {
  const q = $('ws-find').value.trim();
  const tree = $('ws-tree');
  if (!state.wsDir) return;
  if (!q) { wsRenderLevel(''); return; }
  const seq = ++ws.findSeq;
  tree.innerHTML = '<span class="muted">поиск файлов…</span>';
  try {
    const params = new URLSearchParams({ path: state.wsDir, q, exclude: projExcludes().join(','), limit: '100' });
    const r = await api(`/api/project/find?${params}`);
    if (seq !== ws.findSeq) return;
    tree.innerHTML = '';
    if (!r.files.length) { tree.innerHTML = '<span class="muted">файлы с таким именем не найдены</span>'; return; }
    const note = document.createElement('div');
    note.className = 'muted ws-note-row';
    note.textContent = `найдено: ${r.files.length}${r.truncated ? '+ (показаны первые)' : ''} — очистите поле, чтобы вернуться к дереву`;
    tree.appendChild(note);
    for (const f of r.files) {
      const row = document.createElement('div');
      row.className = 'ws-node ws-file-row';
      const btn = document.createElement('button');
      btn.className = 'ws-file';
      btn.textContent = f.rel;
      btn.title = `${f.rel}${f.sizeBytes != null ? ` · ${fmtSize(f.sizeBytes)}` : ''}`;
      btn.addEventListener('click', () => openWsFile(f.rel, btn));
      const ctxBtn = document.createElement('button');
      ctxBtn.className = 'ws-ctx-add';
      ctxBtn.textContent = wsCtx.has(f.rel) ? '✓ чат' : '＋ чат';
      ctxBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (wsCtx.has(f.rel)) wsCtx.remove(f.rel);
        else wsCtx.add(f.rel);
        renderWsCtx();
      });
      row.append(btn, ctxBtn);
      tree.appendChild(row);
    }
  } catch (err) {
    if (seq === ws.findSeq) { tree.innerHTML = ''; showError('поиск файлов: ' + err.message); }
  }
}

/* Панель «Контекст для чата»: видно ровно то, что уйдёт модели. */
function renderWsCtx() {
  const bar = $('ws-ctx-bar');
  const chips = $('ws-ctx-chips');
  const list = [...wsCtx.items];
  bar.hidden = list.length === 0;
  $('ws-ctx-count').textContent = String(list.length);
  chips.innerHTML = '';
  for (const rel of list) {
    const chip = document.createElement('span');
    chip.className = 'ws-ctx-chip';
    const isDir = rel.endsWith('/');
    chip.innerHTML = `${isDir ? '📁' : '📄'} ${esc(rel)} <button title="Убрать из контекста">×</button>`;
    chip.querySelector('button').addEventListener('click', () => {
      wsCtx.remove(rel);
      renderWsCtx();
    });
    chips.appendChild(chip);
  }
  document.querySelectorAll('.ws-ctx-add').forEach((b) => {
    // подписи чипов обновятся при следующей отрисовке уровня
  });
}

/* Передача выбранных файлов/папок в чат: контент читает движок, ограничения
   честные — бинарники и огромные файлы уходят с предупреждением, без молчаливой
   порчи (§2). */
$('btn-ws-ctx-chat').addEventListener('click', async () => {
  if (!state.wsDir) { showError('Откройте проект.'); return; }
  const items = [...wsCtx.items];
  if (!items.length) { showError('Отметьте файлы или папки кнопкой «＋ чат».'); return; }
  $('btn-ws-ctx-chat').disabled = true;
  try {
    const r = await api('/api/project/context', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: state.wsDir, files: items })
    });
    let okCount = 0;
    const warnings = [];
    for (const f of r.files ?? []) {
      if (f.ok) {
        pendingAttachments.push({
          name: f.file.split('/').pop(),
          path: `${baseName(state.wsDir)}/${f.file}`,
          kind: (f.file.split('.').pop() || 'txt').toLowerCase(),
          chars: f.chars,
          text: f.content,
          warning: f.truncated ? 'обрезан до лимита контекста' : null
        });
        okCount++;
      } else {
        warnings.push(`${f.file}: ${f.warning}`);
      }
    }
    for (const w of r.files?.folderWarnings ?? []) warnings.push(w);
    if (r.skippedTooMany > 0) warnings.push(`ещё ${r.skippedTooMany} выбранных позиций не переданы — лимит 50 файлов`);
    renderAttachBar();
    if (okCount) {
      event(`в чат передано файлов из проекта: ${okCount}`);
      wsCtx.clear();
      renderWsCtx();
      openTab('chat');
    }
    if (warnings.length) showError('Не всё удалось передать: ' + warnings.slice(0, 3).join('; ') + (warnings.length > 3 ? ` (и ещё ${warnings.length - 3})` : ''));
    else if (!okCount) showError('Ни один выбранный элемент нельзя передать (бинарные или недоступные).');
  } catch (err) {
    showError('контекст проекта: ' + err.message);
  } finally {
    $('btn-ws-ctx-chat').disabled = false;
  }
});
$('btn-ws-ctx-clear').addEventListener('click', () => { wsCtx.clear(); renderWsCtx(); });

/* Открытие файла: содержимое + mtime для защиты от внешних изменений. */
async function openWsFile(rel, btn) {
  if (ws.dirty && !confirm('В открытом файле есть несохранённые изменения. Открыть другой файл и потерять их?')) return;
  document.querySelectorAll('.ws-file.selected').forEach((b) => b.classList.remove('selected'));
  btn?.classList.add('selected');
  $('ws-file-label').textContent = rel + ' — загрузка…';
  try {
    const params = new URLSearchParams({ path: state.wsDir, file: rel });
    const r = await api(`/api/project/file?${params}`);
    ws.file = r.file;
    ws.mtime = r.mtimeMs;
    ws.dirty = false;
    $('ws-editor').value = r.content;
    $('ws-editor').placeholder = '';
    $('ws-file-label').textContent = `${r.file} · ${fmtSize(r.sizeBytes)}`;
    $('ws-dirty').hidden = true;
    $('ws-note').textContent = '';
    $('ws-aipanel').hidden = true;
    aiChange = null;
  } catch (err) {
    ws.file = null;
    ws.mtime = null;
    ws.dirty = false;
    $('ws-editor').value = '';
    $('ws-file-label').textContent = rel + ' — не открыт';
    $('ws-dirty').hidden = true;
    $('ws-note').textContent = err.message;
  }
}

/* Сохранение с проверкой mtime: если файл изменили извне — 409 и выбор:
   перезагрузить с диска или перезаписать поверх (осознанно). */
async function saveWsFile({ force = false } = {}) {
  if (!state.wsDir || !ws.file) { showError('Сначала откройте файл.'); return false; }
  const content = $('ws-editor').value;
  try {
    const r = await api('/api/project/file', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: state.wsDir, file: ws.file, content, expectedMtimeMs: ws.mtime, force })
    });
    ws.mtime = r.mtimeMs;
    ws.dirty = false;
    $('ws-dirty').hidden = true;
    $('ws-note').textContent = `сохранено ${fmtSize(r.sizeBytes)}`;
    event(`workspace: сохранён ${ws.file}`);
    return true;
  } catch (err) {
    const conflict = err.conflict === true || /FILE_CHANGED_EXTERNALLY/.test(err.message);
    if (conflict) {
      const reload = confirm('Файл изменён другой программой после загрузки в редактор.\n\n«ОК» — перезагрузить файл с диска (ваши правки будут потеряны).\n«Отмена» — всё равно перезаписать моими правками.');
      if (reload) { await openWsFile(ws.file, document.querySelector(`[data-ws-file="${CSS.escape(ws.file)}"]`)); }
      else if (confirm('Точно перезаписать поверх внешних изменений? Текущее содержимое на диске будет утрачено.')) {
        return saveWsFile({ force: true });
      }
    } else {
      showError('сохранение: ' + err.message);
    }
    return false;
  }
}
$('btn-ws-save').addEventListener('click', () => saveWsFile());

/* Индикатор несохранённых изменений. */
$('ws-editor').addEventListener('input', () => {
  if (!ws.dirty) {
    ws.dirty = true;
    $('ws-dirty').hidden = false;
    $('ws-note').textContent = '';
  }
});
$('ws-editor').addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
    e.preventDefault();
    saveWsFile();
  }
});
window.addEventListener('beforeunload', (e) => {
  if (ws.dirty) { e.preventDefault(); e.returnValue = ''; }
});

/* Файл/выделенный фрагмент → чат как вложение (§5). */
function wsSendSelectionToChat(selectedOnly) {
  if (!ws.file) { showError('Сначала откройте файл.'); return; }
  const whole = $('ws-editor').value;
  const sel = selectedOnly ? whole.slice($('ws-editor').selectionStart ?? 0, $('ws-editor').selectionEnd ?? 0) : '';
  const content = selectedOnly ? sel : whole;
  if (!content.trim()) { showError(selectedOnly ? 'Выделите фрагмент текста в редакторе.' : 'Файл пуст — передавать нечего.'); return; }
  const name = ws.file.split(/[\\/]/).pop();
  pendingAttachments.push({
    name: selectedOnly ? `${name} (фрагмент)` : name,
    path: `${baseName(state.wsDir)}/${ws.file}`,
    kind: (ws.file.split('.').pop() || 'txt').toLowerCase(),
    chars: content.length,
    text: content,
    warning: null
  });
  renderAttachBar();
  event(`workspace → чат: ${ws.file}${selectedOnly ? ' (выделенный фрагмент' : ''} (${content.length} симв.))`);
  $('ws-note').textContent = 'передано в чат как вложение';
  openTab('chat');
}
$('btn-ws-tochat').addEventListener('click', () => wsSendSelectionToChat(false));
$('btn-ws-sel-tochat').addEventListener('click', () => wsSendSelectionToChat(true));

$('btn-ws-refresh').addEventListener('click', () => {
  if (ws.dirty && !confirm('Есть несохранённые изменения. Обновить дерево проекта? (Редактор не тронется, но файл могли изменить на диске.)')) return;
  wsReloadTree();
  event('дерево проекта обновлено');
});
$('btn-ws-openfolder').addEventListener('click', () => { if (state.wsDir) openProjectFolder(state.wsDir); });
$('btn-ws-copypath').addEventListener('click', async () => {
  if (!state.wsDir) return;
  const target = ws.file ? `${state.wsDir}${state.wsDir.endsWith('\\') || state.wsDir.endsWith('/') ? '' : state.wsDir.includes('\\') ? '\\' : '/'}${ws.file}` : state.wsDir;
  if (await copyToClipboard(target)) event('путь скопирован: ' + target);
});
$('btn-ws-gotochat').addEventListener('click', () => openTab('chat'));

/* Поиск текста внутри файлов — с номерами строк. */
$('btn-ws-grep').addEventListener('click', async () => {
  const dir = state.wsDir;
  const q = $('ws-grep-q').value.trim();
  if (!dir || !q) { showError('Откройте проект и введите текст для поиска.'); return; }
  const wrap = $('ws-grep-results');
  const out = $('ws-grep-list');
  wrap.hidden = false;
  out.innerHTML = '<li class="muted">поиск текста…</li>';
  try {
    const params = new URLSearchParams({ path: dir, q, exclude: projExcludes().join(','), limit: '60' });
    const r = await api(`/api/project/grep?${params}`);
    out.innerHTML = '';
    if (!r.results.length) { out.innerHTML = '<li class="muted">совпадений нет</li>'; return; }
    let lastFile = null;
    for (const hit of r.results) {
      const li = document.createElement('li');
      li.className = 'ws-grep-hit';
      const head = document.createElement('div');
      head.className = 'model-item-title mono';
      head.textContent = hit.file === lastFile ? `  стр. ${hit.lineNo}` : `${hit.file} · стр. ${hit.lineNo}`;
      lastFile = hit.file;
      const pre = document.createElement('pre');
      pre.textContent = hit.line;
      li.append(head, pre);
      li.addEventListener('click', () => openWsFile(hit.file));
      out.appendChild(li);
    }
    const foot = document.createElement('li');
    foot.className = 'muted';
    foot.textContent = `просмотрено файлов: ${r.scannedFiles}${r.truncated ? ', показаны первые совпадения — уточните запрос' : ''}`;
    out.appendChild(foot);
    event(`поиск текста «${q}»: ${r.results.length} совпадений`);
  } catch (err) {
    out.innerHTML = '';
    showError('поиск текста: ' + err.message);
  }
});
$('btn-ws-grep-close').addEventListener('click', () => { $('ws-grep-results').hidden = true; });

/* ============================ AI Terminal (Этап 1В §4) ============================ */
/* Реальный shell, живой потоковый вывод (SSE), кодировки Windows (UTF-8 →
   CP866 → windows-1251, честно сообщается), история ↑/↓, повтор, очистка
   экрана, «Остановить» с защитой от двойного нажатия и гонок, вывод в чат. */
const TERM_HIST_KEY = 'litemind-term-history';
let termHistory = [];
try { termHistory = JSON.parse(localStorage.getItem(TERM_HIST_KEY) || '[]').filter((c) => typeof c === 'string'); } catch { termHistory = []; }
let termHistPos = -1;   // позиция навигации по истории
let termDraft = '';     // недобитый ввод до ухода в историю
let termJobId = null;   // id выполняющейся команды
let termRunning = false;
let termStopping = false;
let termLastOutput = null; // { command, text, exitCode } — для «Вывод → чат»

/* Опасные команды: удаляющие/затирающие/системные. Только предупреждение
   с подтверждением — терминал пользователя, блокировать не вправе.
   Обычные команды (dir, git status, node -v…) проходят без вопросов. */
const DANGEROUS_RE = /(^|[\s"'(&;])((rm|erase|rd|deltree)\s+\S|del\s+\S|rmdir|remove-item|format\s+[a-z]:|mkfs|dd\s+if=|diskpart|bcdedit|shutdown|reboot|cipher\s+\/w|vssadmin|robocopy\s+[^&|]*\/mir|reg\s+(add|delete)|move\s+[^&|]*[*?]|chmod\s+777|:(){:\|:&};:)/i;

function termSetState(mode, detail) {
  const el = $('term-state');
  if (!el) return;
  const labels = {
    ready: 'готов',
    running: 'выполняется…',
    stopping: 'останавливаю…',
    stopped: 'остановлено пользователем',
    done: detail ?? 'завершено',
    fail: detail ?? 'завершено с ошибкой'
  };
  el.textContent = labels[mode] ?? mode;
  el.className = 'term-state ' + mode;
}

function syncTermCwdLabel() {
  const v = $('term-cwd').value.trim();
  $('term-cwd-label').textContent = v || '—';
}
$('term-cwd').addEventListener('input', syncTermCwdLabel);

function loadTerminal() {
  if (!state.projDir && !$('term-cwd').value) {
    const saved = localStorage.getItem(PROJ_KEY);
    if (saved) $('term-cwd').value = saved;
  }
  syncTermCwdLabel();
  termSetState(termRunning ? 'running' : 'ready');
}

$('btn-term-useproj').addEventListener('click', () => {
  if (!state.projDir) { showError('Сначала откройте проект на вкладке «Проекты».'); return; }
  $('term-cwd').value = state.projDir;
  syncTermCwdLabel();
  event('терминал: рабочая папка = активный проект');
});
$('btn-term-pick').addEventListener('click', async () => {
  const b = bridge();
  if (!b?.pickFolder) { showError('Стандартный диалог выбора папки доступен в LiteMind Desktop. В браузере введите путь вручную.'); return; }
  const r = await b.pickFolder('Рабочая папка терминала', $('term-cwd').value.trim() || undefined).catch(() => null);
  if (r?.ok && r.path) { $('term-cwd').value = r.path; syncTermCwdLabel(); }
});
$('btn-term-openfolder').addEventListener('click', () => {
  const dir = $('term-cwd').value.trim();
  if (!dir) { showError('Укажите рабочую папку.'); return; }
  openProjectFolder(dir);
});

function termRemember(command) {
  termHistory = termHistory.filter((c) => c !== command);
  termHistory.unshift(command);
  if (termHistory.length > 100) termHistory.length = 100;
  localStorage.setItem(TERM_HIST_KEY, JSON.stringify(termHistory));
  termHistPos = -1;
  termDraft = '';
}

/* Прибитый вывод: экран ограничен 512 КиБ, чтобы интерфейс не замедлялся на
   длинных выводах; полная версия уходит в чат по кнопке. */
const TERM_VIEW_CAP = 512 * 1024;
function termAppend(text) {
  const out = $('term-out');
  if (out.textContent.length + text.length > TERM_VIEW_CAP) {
    const keep = out.textContent.slice(Math.max(0, text.length - (TERM_VIEW_CAP - 2000)));
    out.textContent = '…(начало вывода убрано с экрана — лимит отображения; «Вывод → чат» отправит полный текст последней команды)\n' + keep;
  }
  out.textContent += text;
  out.scrollTop = out.scrollHeight;
}

async function termRun(commandRaw) {
  const command = String(commandRaw ?? $('term-cmd').value ?? '').trim();
  const cwd = $('term-cwd').value.trim();
  if (!cwd || !command) { showError('Укажите папку и команду.'); return; }
  if (termRunning) { showError('Команда уже выполняется — сначала остановите её или дождитесь завершения.'); return; }
  if (DANGEROUS_RE.test(command) && !confirm(`Команда выглядит опасной:\n\n${command}\n\nВыполнить её?`)) {
    event('терминал: выполнение опасной команды отменено пользователем');
    return;
  }
  termRunning = true;
  termStopping = false;
  termJobId = `term-${Date.now().toString(36)}`;
  termRemember(command);
  $('btn-term-run').disabled = true;
  $('btn-term-stop').hidden = false;
  $('btn-term-stop').disabled = false;
  $('btn-term-tochat').hidden = true;
  $('btn-term-rerun').hidden = true;
  const out = $('term-out');
  out.hidden = false;
  out.className = 'term-out';
  out.textContent = `$ ${command}\n`;
  termSetState('running');
  const t0 = performance.now();

  const finish = (info) => {
    const total = Math.round(performance.now() - t0);
    const exitCode = info.exitCode;
    let tail = `\n\nкод выхода: ${exitCode}`;
    if (info.timedOut) tail += ' (ТАЙМАУТ — процесс завершён принудительно)';
    else if (info.stopped) tail += ' (ОСТАНОВЛЕНО ПОЛЬЗОВАТЕЛЕМ)';
    if (info.truncated) tail += '\n(вывод обрезан: лимит 2 МиБ)';
    tail += ` · время: ${info.durationMs ?? total} мс`;
    if (info.encoding && info.encoding !== 'utf8') tail += `\n(консоль отвечала в кодировке ${info.encoding} — русский текст восстановлен)`;
    if (info.error) tail += `\nошибка: ${info.error}`;
    termAppend(tail);
    out.className = 'term-out' + (exitCode === 0 ? '' : ' rc-bad');
    termLastOutput = { command, text: out.textContent, exitCode };
    $('btn-term-tochat').hidden = false;
    $('btn-term-rerun').hidden = false;
    termRunning = false;
    termStopping = false;
    termJobId = null;
    $('btn-term-run').disabled = false;
    $('btn-term-stop').hidden = true;
    $('btn-term-stop').disabled = false;
    termSetState(
      info.stopped ? 'stopped'
        : info.timedOut || (exitCode !== 0) ? 'fail'
          : 'done',
      info.timedOut ? 'таймаут' : info.stopped ? undefined : `завершено, код ${exitCode}`
    );
    event(`терминал: ${command} → код ${exitCode}${info.stopped ? ' (остановлено)' : ''}`);
  };

  // Потоковое выполнение: POST + SSE-ответ (§4 — вывод по мере появления).
  try {
    const res = await fetch(ENGINE_BASE + '/api/terminal/exec', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cwd, command, timeoutMs: 30000, jobId: termJobId, stream: true })
    });
    if (!res.ok || !res.body) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data?.error?.message || `HTTP ${res.status}`);
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let done = false;
    while (!done) {
      const { done: rdDone, value } = await reader.read();
      if (rdDone) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) !== -1) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        let evName = 'message';
        const dataLines = [];
        for (const line of block.split('\n')) {
          if (line.startsWith('event: ')) evName = line.slice(7).trim();
          else if (line.startsWith('data: ')) dataLines.push(line.slice(6));
        }
        if (!dataLines.length) continue;
        let obj;
        try { obj = JSON.parse(dataLines.join('\n')); } catch { continue; }
        if (evName === 'start') {
          termAppend(`(запущено в ${obj.cwd})\n`);
        } else if (evName === 'stdout') {
          termAppend(obj.text ?? '');
        } else if (evName === 'stderr') {
          termAppend(obj.text ?? '');
        } else if (evName === 'error') {
          termAppend(`\n[ошибка запуска] ${obj.message}\n`);
        } else if (evName === 'exit') {
          done = true;
          finish(obj);
          break;
        }
      }
    }
    if (!done && !termStopping) {
      // Соединение кончилось без exit — на всякий случай честное состояние.
      finish({ exitCode: 1, durationMs: Math.round(performance.now() - t0) });
    }
  } catch (err) {
    termRunning = false;
    termStopping = false;
    termJobId = null;
    $('btn-term-run').disabled = false;
    $('btn-term-stop').hidden = true;
    $('btn-term-stop').disabled = false;
    termAppend(`\nошибка: ${err.message}\n`);
    out.className = 'term-out rc-bad';
    termLastOutput = { command, text: out.textContent, exitCode: 1 };
    $('btn-term-tochat').hidden = false;
    $('btn-term-rerun').hidden = false;
    termSetState('fail', 'ошибка');
    showError('терминал: ' + err.message);
  }
}

$('btn-term-run').addEventListener('click', () => termRun());
$('btn-term-rerun').addEventListener('click', () => {
  const last = termHistory[0];
  if (!last) { showError('История пуста.'); return; }
  $('term-cmd').value = last;
  termRun(last);
});

/* Остановка: защита от повторного нажатия (disabled до события exit) и от
   гонок (после exit кнопки сбрасываются только один раз). */
$('btn-term-stop').addEventListener('click', async () => {
  if (!termRunning || termStopping || !termJobId) return;
  termStopping = true;
  $('btn-term-stop').disabled = true;
  termSetState('stopping');
  try {
    const r = await api('/api/terminal/stop', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jobId: termJobId }) });
    if (!r.ok && termRunning) showError(r.error || 'команда уже завершена');
    // Итог придёт событием exit в потоке — он обновит вывод и кнопки.
  } catch (err) {
    if (termRunning) { showError('остановка: ' + err.message); termStopping = false; $('btn-term-stop').disabled = false; termSetState('running'); }
  }
});

/* Очистка экрана: история команд и termLastOutput сохраняются. */
$('btn-term-clear').addEventListener('click', () => {
  const out = $('term-out');
  out.textContent = '(экран очищен; история команд сохранена — ↑/↓)\n';
});

$('btn-term-tochat').addEventListener('click', () => {
  if (!termLastOutput) return;
  pendingAttachments.push({
    name: 'terminal-output.txt',
    kind: 'txt',
    chars: termLastOutput.text.length,
    text: `$ ${termLastOutput.command}\nкод выхода: ${termLastOutput.exitCode}\n\n${termLastOutput.text}`,
    warning: null
  });
  renderAttachBar();
  event('терминал → чат: вывод передан вложением');
  openTab('chat');
});

/* История команд: ↑ — назад, ↓ — вперёд; недобитый ввод сохраняется. */
$('term-cmd').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { termRun(); return; }
  if (!termHistory.length) return;
  if (e.key === 'ArrowUp') {
    e.preventDefault();
    if (termHistPos === -1) { termDraft = $('term-cmd').value; termHistPos = 0; }
    else if (termHistPos < termHistory.length - 1) termHistPos++;
    $('term-cmd').value = termHistory[termHistPos] ?? termDraft;
  } else if (e.key === 'ArrowDown') {
    e.preventDefault();
    if (termHistPos === -1) return;
    termHistPos--;
    $('term-cmd').value = termHistPos === -1 ? termDraft : termHistory[termHistPos];
  }
});

/* ============================ Изменения файлов через ИИ (Этап 1В §3) ========= */
/* Безопасный цикл подготовки: модель возвращает полное новое содержимое файла
   в блоке ```file:<путь>, UI показывает diff, пользователь явно подтверждает.
   Перед записью — резервная копия (вне проекта); после — можно восстановить.
   Автономного агента здесь нет и не требуется (§3). */
let aiChange = null; // { file, proposed, current, mtimeMs, backupId }

function lineDiff(aText, bText) {
  const a = String(aText ?? '').split('\n');
  const b = String(bText ?? '').split('\n');
  const cap = 2000;
  if (a.length > cap || b.length > cap) return null; // слишком большой diff — покажем замену целиком
  // LCS-таблица (ограничена по размеру: 2000×2000 = 4М ячеек — приемлемо).
  const n = a.length;
  const m = b.length;
  const dp = new Uint32Array((n + 1) * (m + 1));
  const W = m + 1;
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * W + j] = a[i] === b[j]
        ? dp[(i + 1) * W + j + 1] + 1
        : Math.max(dp[(i + 1) * W + j], dp[i * W + j + 1]);
    }
  }
  const rows = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { rows.push({ t: '=', s: a[i] }); i++; j++; }
    else if (dp[(i + 1) * W + j] >= dp[i * W + j + 1]) { rows.push({ t: '-', s: a[i] }); i++; }
    else { rows.push({ t: '+', s: b[j] }); j++; }
  }
  while (i < n) { rows.push({ t: '-', s: a[i] }); i++; }
  while (j < m) { rows.push({ t: '+', s: b[j] }); j++; }
  return rows;
}

function renderDiff(rows, wrapEl) {
  if (!rows) {
    wrapEl.textContent = '(файл слишком большой для построчного diff — показывается замена целиком)';
    return;
  }
  const parts = [];
  let ctxRun = 0;
  const flushCtx = () => { if (ctxRun) { parts.push(`<span class="d-ctx">  … ещё ${ctxRun} совпадающих строк …</span>`); ctxRun = 0; } };
  rows.forEach((r) => {
    if (r.t === '=') { ctxRun++; return; }
    flushCtx();
    const cls = r.t === '+' ? 'd-add' : 'd-del';
    parts.push(`<span class="${cls}">${r.t === '+' ? '+' : '-'} ${esc(r.s)}</span>`);
  });
  flushCtx();
  if (!parts.length) { wrapEl.innerHTML = '<span class="d-ctx">(изменений нет)</span>'; return; }
  wrapEl.innerHTML = parts.join('\n');
}

/* Запрос ИИ на изменение открытого файла: файл прикладывается вложением,
   в поле ввода — готовая инструкция с жёстким форматом ответа. */
$('btn-ws-aichange').addEventListener('click', () => {
  if (!ws.file) { showError('Сначала откройте файл, который нужно изменить.'); return; }
  const content = $('ws-editor').value;
  if (!content.trim()) { showError('Файл пуст — ИИ не с чем работать.'); return; }
  const name = ws.file.split(/[\\/]/).pop();
  pendingAttachments.push({
    name,
    path: `${baseName(state.wsDir)}/${ws.file}`,
    kind: (ws.file.split('.').pop() || 'txt').toLowerCase(),
    chars: content.length,
    text: content,
    warning: null
  });
  $('prompt').value = `Приложен файл ${ws.file} из проекта. Внеси запрошенные изменения и верни ПОЛНОЕ новое содержимое файла — ровно один блок:\n\n\`\`\`file:${ws.file}\n(весь новый файл)\n\`\`\`\n\nНичего кроме этого блока в ответ не пиши. Что изменить, я напишу дальше: `;
  autoGrow();
  renderAttachBar();
  event(`workspace: файл ${ws.file} передан ИИ для изменения`);
  openTab('chat');
});

/* Ищем ```file:<путь> блоки в ответе модели и показываем панель применения.
   Только по явному нажатию «Применить» файл меняется на диске. */
function scanReplyForFileChanges(chat, reply) {
  if (!state.wsDir || !reply?.content) return;
  const RE = /```file:([^\n`]+)\n([\s\S]*?)```/g;
  let m;
  const found = [];
  while ((m = RE.exec(reply.content)) !== null) {
    found.push({ file: m[1].trim(), content: m[2].replace(/\n$/, '') });
  }
  if (!found.length) return;
  const log = $('chat-log');
  const bubbles = log.querySelectorAll('.msg.assistant, .msg-bot, [class*="assistant"]');
  const host = bubbles.length ? bubbles[bubbles.length - 1] : log;
  for (const f of found.slice(0, 3)) {
    const bar = document.createElement('div');
    bar.className = 'chat-file-bar';
    bar.innerHTML = `<span>📄 Модель предложила новое содержимое файла <b class="mono">${esc(f.file)}</b>. Применение — только по вашему подтверждению, перед записью будет сделана резервная копия.</span>`;
    const actions = document.createElement('div');
    actions.className = 'btns';
    const btnReview = document.createElement('button');
    btnReview.className = 'primary';
    btnReview.textContent = 'Показать изменения';
    const btnApply = document.createElement('button');
    btnApply.textContent = 'Применить сразу';
    const btnDismiss = document.createElement('button');
    btnDismiss.textContent = 'Не применять';
    actions.append(btnReview, btnApply, btnDismiss);
    bar.appendChild(actions);
    host.appendChild(bar);
    const startFlow = async (showDiff) => {
      try {
        const params = new URLSearchParams({ path: state.wsDir, file: f.file });
        const cur = await api(`/api/project/file?${params}`);
        aiChange = { file: f.file, proposed: f.content, current: cur.content, mtimeMs: cur.mtimeMs, backupId: null };
        openTab('workspace');
        if (showDiff) showAiPanel();
        else void applyAiChange();
      } catch (err) {
        showError(`Файл ${f.file} недоступен в открытом проекте: ${err.message}. Изменение не применено.`);
        bar.remove();
      }
    };
    btnReview.addEventListener('click', () => startFlow(true));
    btnApply.addEventListener('click', () => startFlow(false));
    btnDismiss.addEventListener('click', () => { bar.remove(); event('предложенное изменение отклонено'); });
  }
}

function showAiPanel() {
  if (!aiChange) return;
  $('ws-aipanel').hidden = false;
  const add = (aiChange.proposed.match(/\n/g) ?? []).length + 1;
  const del = (aiChange.current.match(/\n/g) ?? []).length + 1;
  $('ws-aiinfo').textContent = `Файл: ${aiChange.file}. В файле сейчас ${del} строк, предложено ${add}.`;
  renderDiff(lineDiff(aiChange.current, aiChange.proposed), $('ws-diff'));
  $('ws-ainote').textContent = '';
}

async function applyAiChange({ force = false } = {}) {
  if (!aiChange) return;
  $('btn-ws-apply').disabled = true;
  try {
    const r = await api('/api/project/apply-change', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        path: state.wsDir, file: aiChange.file, content: aiChange.proposed,
        expectedMtimeMs: aiChange.mtimeMs, force
      })
    });
    aiChange.backupId = r.backupId;
    $('ws-ainote').textContent = `Применено. Резервная копия: ${r.backupId}. Можно восстановить исходное содержимое.`;
    $('btn-ws-restore').hidden = false;
    $('btn-ws-apply').hidden = true;
    event(`изменение ИИ применено: ${r.file} (копия: ${r.backupId})`);
    // Если этот файл открыт в редакторе — обновим его содержимое и дерево.
    if (ws.file === r.file) {
      ws.mtime = r.mtimeMs;
      ws.dirty = false;
      $('ws-editor').value = aiChange.proposed;
      $('ws-dirty').hidden = true;
    }
    wsReloadTree();
  } catch (err) {
    if (err.message.includes('FILE_CHANGED_EXTERNALLY')) {
      if (confirm('Файл на диске изменился после чтения. Всё равно применить предложение ИИ поверх?')) return applyAiChange({ force: true });
    } else {
      showError('применение изменения: ' + err.message);
    }
  } finally {
    $('btn-ws-apply').disabled = false;
  }
}
$('btn-ws-apply').addEventListener('click', () => applyAiChange());
$('btn-ws-ai-cancel').addEventListener('click', () => {
  $('ws-aipanel').hidden = true;
  aiChange = null;
  $('btn-ws-apply').hidden = false;
  $('btn-ws-restore').hidden = true;
});

/* Восстановление из резервной копии — тоже обратимо (текущее содержимое
   перед восстановлением уходит в новую копию на сервере). */
$('btn-ws-restore').addEventListener('click', async () => {
  if (!aiChange?.backupId) { showError('Нет резервной копии для этого изменения.'); return; }
  if (!confirm(`Восстановить исходное содержимое файла ${aiChange.file} из резервной копии?`)) return;
  try {
    const r = await api('/api/project/restore-backup', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: state.wsDir, backupId: aiChange.backupId, force: true })
    });
    event(`файл восстановлен из копии: ${r.file}`);
    $('ws-ainote').textContent = `Восстановлено из копии. Содержимое на момент восстановления тоже сохранено в копию ${r.safetyBackupId}.`;
    if (ws.file === r.file) {
      await openWsFile(r.file, document.querySelector(`[data-ws-file="${CSS.escape(r.file)}"]`));
    }
    wsReloadTree();
  } catch (err) {
    showError('восстановление: ' + err.message);
  }
});

/* ============================ Железо ============================ */
async function loadHardware() {
  try {
    const hw = await api('/api/hardware');
    const avx = (v) => (v === null ? 'неизвестно' : v ? 'есть' : 'нет');
    const rows = [
      ['CPU', `${hw.cpu.model || '—'} · ядер: ${hw.cpu.cores}`],
      ['AVX / AVX2', `${avx(hw.cpu.avx)} / ${avx(hw.cpu.avx2)} (${esc(hw.cpu.avxMethod)})`],
      ['RAM всего', `${(hw.totalRamMb / 1024).toFixed(1)} ГБ`],
      ['RAM свободно', `${(hw.freeRamMb / 1024).toFixed(1)} ГБ`],
      ['GPU', hw.gpu ? `${hw.gpu.model || '—'} · VRAM ${hw.gpu.vramMb ? fmtSize(hw.gpu.vramMb * 1024 * 1024) : '—'}` : 'не обнаружена (CPU-only режим)'],
      ['Рекомендуемый профиль', hw.recommendation.profile === 'low' ? 'Умеренный' : hw.recommendation.profile === 'high' ? 'Производительный' : 'Сбалансированный'],
      ['Резерв под Windows', `${hw.recommendation.windowsReserveMb} МБ`],
      ['Доступно для моделей', `≈ ${(hw.recommendation.usableModelRamMb / 1024).toFixed(1)} ГБ`],
      ['Потоков CPU для генерации', hw.recommendation.cpuThreads],
      ['Контекст по умолчанию', `${hw.recommendation.maxContextTokens} токенов`],
      ['AVX-заключение', hw.recommendation.avxNote]
    ];
    const dl = $('hw-report');
    dl.innerHTML = '';
    for (const [k, v] of rows) {
      const dt = document.createElement('dt'); dt.textContent = k;
      const dd = document.createElement('dd'); dd.innerHTML = v;
      dl.append(dt, dd);
    }
    const disks = (hw.disks || []).filter((d) => d.exists);
    if (disks.length) {
      dl.append(Object.assign(document.createElement('dt'), { textContent: 'Диски' }));
      const dd = document.createElement('dd');
      dd.innerHTML = disks.map((d) => `${esc(d.root)} свободно ${fmtSize(d.freeBytes)} из ${fmtSize(d.totalBytes)}`).join('<br>');
      dl.append(dd);
    }
  } catch (err) { event('железо: ' + err.message); }
}

/* ============================ Настройки ============================ */
async function loadSettings() {
  try {
    const s = await api('/api/settings');
    $('set-rootdir').value = s.modelsRootDir || '';
    if (s.profile) $('set-profile').value = s.profile;
  } catch { /* — */ }
  try {
    const a = await api('/api/adaptive');
    $('set-adaptive').checked = a.config?.enabled !== false;
    $('set-compaction').checked = a.config?.contextCompaction !== false;
  } catch { /* — */ }
  loadAboutApp();
  loadStorage();
}

/* Хранение моделей (Этап 1Б §5.2): текущая папка, свободное место, общий
   размер установленных моделей, изменение папки с безопасным переносом,
   открытие папки и проверка существующих путей. */
let storePickDir = null;

async function loadStorage() {
  const kv = $('storage-kv');
  if (!kv) return;
  try {
    const s = await api('/api/storage');
    const rows = [
      ['Текущая папка', s.rootDir + (s.exists ? '' : ' (папка ещё не создана)')],
      ['Свободно на диске', s.disk?.freeBytes != null ? `${fmtSize(s.disk.freeBytes)} из ${fmtSize(s.disk.totalBytes)}` : 'неизвестно'],
      ['Установленные модели', `${s.models.length} шт. · всего ${fmtSize(s.totalBytes)}`],
      ['Недокачанные файлы (.part)', s.partBytes ? fmtSize(s.partBytes) : 'нет'],
      ['Пользовательские модели (вне папки)', s.registered.length ? `${s.registered.length} шт.` : 'нет'],
      ['Активные загрузки', s.activeDownloads ? `${s.activeDownloads} шт. — перенос недоступен` : 'нет']
    ];
    kv.innerHTML = '';
    for (const [k, v] of rows) {
      const dt = document.createElement('dt'); dt.textContent = k;
      const dd = document.createElement('dd'); dd.textContent = v; dd.className = 'mono';
      kv.append(dt, dd);
    }
    $('store-note').textContent = storePickDir
      ? `Выбрана новая папка: ${storePickDir}. Нажмите «Перенести модели и переключиться».`
      : `Перенос — это копирование со сверкой SHA-256. Старые файлы не удаляются (кроме случая, когда вы сняли галочку ниже), при ошибке всё остаётся на месте.`;
  } catch (err) {
    kv.innerHTML = '<dt>Хранилище</dt><dd>—</dd>';
  }
}

$('btn-store-pick')?.addEventListener('click', async () => {
  const b = bridge();
  if (!b?.pickFolder) { showError('Нативный выбор папки доступен в LiteMind Desktop.'); return; }
  const s = await api('/api/storage').catch(() => null);
  const r = await b.pickFolder('Новая папка для моделей', s?.rootDir || undefined).catch(() => null);
  if (r?.ok && r.path) {
    storePickDir = r.path;
    loadStorage();
  }
});

$('btn-store-move')?.addEventListener('click', async () => {
  if (!storePickDir) { showError('Сначала выберите новую папку («Выбрать новую папку…»).'); return; }
  const s = await api('/api/storage').catch(() => null);
  const keep = $('store-keepsrc').checked;
  const n = s?.models?.length ?? 0;
  if (!confirm(`Перенести ${n} моделей из\n${s?.rootDir}\nв\n${storePickDir}\n\n${keep ? 'Старые копии ОСТАНУТСЯ на месте (рекомендуется).' : 'Старые файлы будут удалены после проверки SHA-256.'}`)) return;
  const note = $('store-note');
  note.textContent = 'Переношу и проверяю SHA-256… это может занять несколько минут при больших моделях.';
  try {
    const r = await api('/api/storage/move', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ toDir: storePickDir, keepSource: keep }) });
    const moved = r.results.filter((x) => x.status === 'moved').length;
    const failed = r.results.filter((x) => x.status === 'failed').length;
    const part = r.results.filter((x) => x.status === 'moved_part').length;
    note.textContent = `Готово: перенесено ${moved} моделей${part ? `, недокачанных файлов ${part}` : ''}${failed ? `, ошибок ${failed} (файлы остались в старой папке)` : ''}. Новая папка: ${r.rootDir}.`;
    event(`папка моделей изменена: ${r.rootDir} (перенесено ${moved})`);
    storePickDir = null;
    state.catalog = null; // перечитать каталог с новой папкой
    loadStorage();
    loadSettings();
  } catch (err) {
    note.textContent = '';
    showError('перенос: ' + err.message);
    loadStorage();
  }
});

$('btn-store-check')?.addEventListener('click', async () => {
  const note = $('store-note');
  note.textContent = 'Проверяю пути…';
  try {
    const r = await api('/api/storage/check', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    note.textContent = r.ok
      ? `Проверено ${r.checked} моделей — проблем не найдено.`
      : `Проблемы (${r.problems.length} из ${r.checked}): ` + r.problems.map((p) => `${p.file} — ${p.issue}`).join('; ');   
  } catch (err) {
    note.textContent = '';
    showError('проверка путей: ' + err.message);
  }
});

$('btn-store-open')?.addEventListener('click', async () => {
  const b = bridge();
  try {
    const s = await api('/api/storage');
    if (!b?.shellOpenPath) { showError(`Папка моделей: ${s.rootDir}. Открытие папки доступно в LiteMind Desktop.`); return; }
    const r = await b.shellOpenPath(s.rootDir).catch(() => ({ ok: false }));
    if (r?.ok === false) showError('Не удалось открыть папку: ' + (r.error ?? '— возможно, папка ещё не создана.'));
  } catch (err) { showError('хранилище: ' + err.message); }
});

/* «О приложении» (ТЗ Этап 1 §12): версии и пути из Electron appInfo,
   диагностика состояния — из /api/engine/state; в браузере показываем,
   что доступно только через движок. */
async function loadAboutApp() {
  const dl = $('about-app');
  if (!dl) return;
  const rows = [];
  const b = bridge();
  if (b?.appInfo) {
    try {
      const a = await b.appInfo();
      rows.push(
        ['Версия LiteMind Desktop', a.version],
        ['Electron / Chrome / Node', `${a.electron} / ${a.chrome} / ${a.node}`],
        ['Платформа', `${a.platform} · ${a.arch} · ${a.packaged ? 'установленная сборка' : 'dev-режим'}`],
        ['Данные приложения', a.userDataPath],
        ['Журналы', a.logsPath],
        ['Исполняемый файл', a.exePath]
      );
    } catch { /* мост недоступен */ }
  } else {
    rows.push(['Режим', 'панель движка (браузер). Версии приложения — в LiteMind Desktop']);
  }
  try {
    const st = await api('/api/engine/state');
    rows.push(
      ['Движок', `${st.engine}${st.reachable ? ' (отвечает)' : ''}`],
      ['Runtime', st.backend?.type ?? '—'],
      ['Модели в памяти', (st.models || []).length ? st.models.map((m) => `${m.id}: ${m.state}`).join(', ') : 'нет'],
      ['Очередь', `${st.queue?.active ?? 0} активных / ${st.queue?.waiting ?? 0} ожидающих`]
    );
  } catch {
    rows.push(['Движок', 'не отвечает']);
  }
  dl.innerHTML = '';
  for (const [k, v] of rows.filter(([, v]) => v != null)) {
    const dt = document.createElement('dt'); dt.textContent = k;
    const dd = document.createElement('dd'); dd.textContent = String(v); dd.className = 'mono';
    dl.append(dt, dd);
  }
}

$('btn-open-logs').addEventListener('click', async () => {
  const b = bridge();
  if (!b?.appInfo) { showError('Открытие журналов доступно в LiteMind Desktop.'); return; }
  const a = await b.appInfo().catch(() => null);
  if (!a?.logsPath) { showError('Путь к журналам недоступен.'); return; }
  const r = await b.shellOpenPath(a.logsPath).catch(() => ({ ok: false }));
  if (r?.ok === false) showError('Не удалось открыть папку журналов: ' + (r.error ?? ''));
});

$('btn-open-models').addEventListener('click', async () => {
  const dir = $('set-rootdir').value.trim();
  if (!dir) { showError('Папка моделей не задана.'); return; }
  const b = bridge();
  if (!b?.shellOpenPath) { showError('Открытие папок доступно в LiteMind Desktop.'); return; }
  const r = await b.shellOpenPath(dir).catch(() => ({ ok: false }));
  if (r?.ok === false) showError('Не удалось открыть папку: ' + (r.error ?? '— возможно, папка ещё не создана.'));
});

/* Нативный выбор папки моделей (ТЗ Этап 1 §12). */
$('btn-set-pick').addEventListener('click', async () => {
  const b = bridge();
  if (!b?.pickFolder) { showError('Стандартный диалог выбора папки доступен в LiteMind Desktop. В браузере введите путь вручную.'); return; }
  const r = await b.pickFolder('Папка для моделей', $('set-rootdir').value.trim() || undefined).catch(() => null);
  if (r?.ok && r.path) $('set-rootdir').value = r.path;
});

$('btn-save-settings').addEventListener('click', async () => {
  const rootDir = $('set-rootdir').value.trim();
  const profile = $('set-profile').value;
  try {
    await api('/api/settings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ modelsRootDir: rootDir || undefined, profile }) });
    $('settings-note').textContent = 'сохранено';
    state.catalog = null;
    event(`настройки сохранены (профиль: ${profile})`);
    refreshStatus();
  } catch (err) {
    $('settings-note').textContent = '';
    showError('настройки: ' + err.message);
  }
});
$('set-adaptive').addEventListener('change', (e) =>
  api('/api/adaptive', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: e.target.checked }) }).catch((err) => showError(err.message)));
$('set-compaction').addEventListener('change', (e) =>
  api('/api/adaptive', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ contextCompaction: e.target.checked }) }).catch((err) => showError(err.message)));

/* ============================ запуск ============================ */
loadChat();
switchTab(location.hash.slice(1) || 'chat');
refreshStatus();
setInterval(refreshStatus, 2500);
setInterval(() => {
  if (document.querySelector('.nav-item.active')?.dataset.tab === 'downloads') refreshDownloads();
}, 1500);
