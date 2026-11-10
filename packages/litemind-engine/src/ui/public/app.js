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

function monFill(s) {
  const m = s.metrics;
  if (m) {
    const ramPct = m.totalRamMb ? (m.usedRamMb / m.totalRamMb) * 100 : 0;
    bar('mon-cpu', m.cpuPercent, `${Math.round(m.cpuPercent)} %`);
    bar('mon-ram', ramPct, `${Math.round(m.usedRamMb)} / ${Math.round(m.totalRamMb)} МБ`);
    $('mon-avail').textContent = fmtSize((m.availableRamMb ?? 0) * 1024 * 1024);
    $('mon-gpu').textContent = (m.gpuNames && m.gpuNames.length) ? m.gpuNames.join(', ') : 'не определена';
  }
  const perf = s.perf;
  $('mon-tps').textContent = perf?.tokensPerSecond?.avg != null ? Number(perf.tokensPerSecond.avg).toFixed(1) : '—';
  $('mon-ttft').textContent = perf?.ttftMs?.avg != null ? `${Math.round(perf.ttftMs.avg)} мс` : '—';
  $('mon-queue').textContent = `${s.queue.active} / ${s.queue.waiting}`;
  $('mon-compact').textContent = s.adaptive?.compacted ?? 0;
  $('mon-saved').textContent = s.adaptive?.tokensSaved ?? 0;
  $('mon-opts').textContent = Object.keys(s.optimizations ?? {}).length;
  $('mon-profile-note').textContent = `Текущий профиль: ${s.engine.profileLabel}`;
}

function monOffline() {
  bar('mon-cpu', 0, '—');
  bar('mon-ram', 0, '—');
  for (const id of ['mon-avail', 'mon-gpu', 'mon-tps', 'mon-ttft', 'mon-queue', 'mon-compact', 'mon-saved', 'mon-opts']) {
    const el = $(id); if (el) el.textContent = '—';
  }
  $('mon-profile-note').textContent = 'Движок не отвечает.';
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
    chip.innerHTML = `📄 ${esc(a.name)} <button title="Убрать">×</button>`;
    chip.querySelector('button').addEventListener('click', () => {
      pendingAttachments.splice(idx, 1);
      renderAttachBar();
    });
    barEl.appendChild(chip);
  });
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
    $('timings').textContent = `первый токен: ${ttft ?? '—'} мс · всего: ${total} мс`;
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

/* ============================ Мои модели ============================ */
async function loadMyModels() {
  // Какие модели прямо сейчас в памяти (llama-server запущен) — для честного
  // статуса «в памяти» и кнопки «Остановить» вместо «Запустить».
  const loadedIds = new Set();
  try {
    const st = await api('/api/engine/state');
    for (const x of (st.models || [])) if (['loaded', 'running'].includes(x.state)) loadedIds.add(x.id);
  } catch { /* движок может быть offline */ }
  try {
    const s = await api('/api/models/scan');
    $('scan-rootdir').textContent = `Папка моделей: ${s.rootDir} · runtime: ${s.runtimeBinary ?? 'llama-server не найден'}`;
    const ul = $('my-models');
    ul.innerHTML = '';
    if (!(s.models || []).length) {
      ul.innerHTML = '<li class="muted">В папке пока нет GGUF. Скачайте модель из каталога — она появится здесь автоматически.</li>';
    } else {
      const canShell = !!bridge();
      for (const m of s.models) {
        const li = document.createElement('li');
        const loaded = loadedIds.has(m.id);
        const status = !m.ok
          ? '<span class="tag bad-tag">повреждён</span>'
          : loaded
            ? '<span class="tag ok-tag">в памяти</span>'
            : (m.compatible ? '<span class="tag ok-tag">готова</span>' : '<span class="tag warn-tag">может не хватить RAM</span>');
        li.innerHTML = `<div class="model-item-main"><div class="model-item-title">${esc(m.id)} ${status}</div>
          <div class="model-item-sub">${fmtSize(m.sizeBytes)} · ${esc(m.architecture ?? '?')} · ${esc(m.quant ?? 'квант не определён')} · контекст ${m.contextLength ?? '—'} · ≈${m.memoryEstimateMb} МБ RAM</div>
          <div class="model-item-sub muted" title="${esc(m.file ?? '')}">файл: ${esc(m.file ?? '—')}</div>
          ${m.error ? `<div class="model-item-sub" style="color:var(--bad)">${esc(m.error)}</div>` : ''}
          <div class="model-item-result" hidden></div></div>
          <div class="model-item-actions">
            <button data-use="${esc(m.id)}" ${m.ok ? '' : 'disabled'}>Открыть в чате</button>
            ${loaded
              ? `<button data-stop="${esc(m.id)}">Остановить</button>`
              : `<button data-run="${esc(m.id)}" ${m.ok && s.runtimeBinary ? '' : 'disabled'} title="${s.runtimeBinary ? 'Запустить llama-server с этой моделью' : 'runtime llama-server не найден'}">Запустить</button>`}
            <button data-verify="${esc(m.id)}">Проверить файл</button>
            ${canShell ? `<button data-folder="${esc(m.file ?? '')}">Открыть папку</button>` : ''}
            <button data-info="${esc(m.id)}">Сведения</button>
            <button data-del="${esc(m.id)}" class="danger">Удалить файл</button>
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
            event(`модель выгружена из памяти: ${m.id}`);
            loadMyModels();
            refreshStatus();
          } catch (err) { showError('остановка: ' + err.message); }
        });
        li.querySelector('[data-verify]').addEventListener('click', async (e) => {
          e.target.disabled = true;
          showResult('Проверяю файл (считаю SHA-256)…', true);
          try {
            const r = await api('/api/models/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ file: m.file }) });
            if (r.verified) showResult(`Файл цел: ${fmtSize(r.sizeBytes)} · SHA-256: ${String(r.sha256).slice(0, 16)}…`, true);
            else showResult(r.message || 'Файл повреждён — скачайте модель заново.', false);
          } catch (err) { showResult('Проверка: ' + err.message, false); }
          e.target.disabled = false;
        });
        li.querySelector('[data-folder]')?.addEventListener('click', async () => {
          const b = bridge();
          if (!b) return;
          const r = await b.shellShowItemInFolder(m.file).catch(() => ({ ok: false }));
          if (r && r.ok === false) showError('Не удалось открыть папку в проводнике.');
        });
        li.querySelector('[data-info]').addEventListener('click', () => {
          alert([
            `Модель: ${m.id}`,
            m.file ? `Файл: ${m.file}` : null,
            `Размер: ${fmtSize(m.sizeBytes)}`,
            `Архитектура: ${m.architecture ?? '—'}`,
            `Квантование: ${m.quant ?? '—'}`,
            `Контекст: ${m.contextLength ?? '—'}`,
            `Оценка RAM: ≈${m.memoryEstimateMb} МБ`,
            loadedIds.has(m.id) ? 'Статус: в памяти (llama-server запущен)' : (m.ok ? 'Статус: готова к запуску' : `Статус: повреждён${m.error ? ' — ' + m.error : ''}`)
          ].filter(Boolean).join('\n'));
        });
        li.querySelector('[data-del]').addEventListener('click', async () => {
          if (!confirm(`Удалить файл «${m.id}.gguf» с диска безвозвратно?`)) return;
          try {
            await api(`/api/models/${encodeURIComponent(m.id)}`, { method: 'DELETE' });
            event(`модель удалена: ${m.id}`);
            loadMyModels();
            refreshStatus();
          } catch (err) { showError('удаление: ' + err.message); }
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
async function loadCatalog() {
  if (!state.catalog) {
    try { state.catalog = await api('/api/catalog'); } catch (err) { event('каталог: ' + err.message); return; }
  }
  const c = state.catalog;
  $('hw-hint').textContent =
    `CPU: ${c.hardware.cpu.model || '—'} · AVX/AVX2: ${c.hardware.cpu.avx === null ? 'неизвестно' : `${c.hardware.cpu.avx}/${c.hardware.cpu.avx2}`} · ` +
    `RAM: ${(c.hardware.totalRamMb / 1024).toFixed(1)} ГБ (свободно ${(c.hardware.freeRamMb / 1024).toFixed(1)}) · ` +
    `рекомендация: профиль «${c.hardware.recommendation.profile === 'low' ? 'Умеренный' : 'Сбалансированный'}», контекст ≤ ${c.hardware.recommendation.maxContextTokens} ток.` +
    (c.hardware.cpu.avx === false ? ' · CPU без AVX/AVX2 — выбраны совместимые сборки' : '');

  const driveSel = $('f-drive');
  if (!driveSel.dataset.filled) {
    driveSel.innerHTML = '';
    for (const d of c.hardware.disks || []) {
      const o = document.createElement('option');
      o.value = d.root;
      o.textContent = d.exists ? `${d.root} (свободно ${fmtSize(d.freeBytes)})` : `${d.root} — недоступен`;
      o.disabled = !d.exists;
      driveSel.appendChild(o);
    }
    driveSel.dataset.filled = '1';
    $('f-dir').value = c.modelsRootDir || $('f-dir').value;
    driveSel.addEventListener('change', () => {
      const dir = $('f-dir').value;
      const cur = dir.split(/[\\/]/).pop() || '';
      $('f-dir').value = driveSel.value + (dir.includes('\\') ? `LiteMind\\models\\${cur}` : `LiteMind/models/${cur}`);
    });
  }

  // Динамические чекбоксы категорий — каталог v2 приходит с сервера.
  const wrap = $('catalog-filters');
  if (wrap && wrap.dataset.filled !== '1') {
    wrap.innerHTML = '';
    for (const [key, title] of Object.entries(c.categories || {})) {
      const label = document.createElement('label');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = true;
      cb.dataset.cat = key;
      cb.addEventListener('change', loadCatalog);
      label.appendChild(cb);
      label.appendChild(document.createTextNode(' ' + title));
      wrap.appendChild(label);
    }
    wrap.dataset.filled = '1';
  }
  const show = {};
  document.querySelectorAll('#catalog-filters input[data-cat]').forEach((cb) => { show[cb.dataset.cat] = cb.checked; });
  const list = $('catalog-list');
  list.innerHTML = '';
  for (const m of c.models) {
    if (show[m.category] === false) continue;
    list.appendChild(catalogCard(m, c));
  }
}

function catalogCard(m, c) {
  const div = document.createElement('div');
  div.className = 'catalog-item';
  const st = m.compatibility.status;
  const rec = m.compatibility.recommended;
  const installed = m.installed ? '<span class="tag ok-tag">скачана</span>' : '';
  const unc = m.restrictions === 'reduced' ? `<span class="tag">${esc(m.uncensoredLabel || 'ослабленные ограничения')}</span>` : '';
  const fit = m.compatibility?.fitLabel ? `<span class="tag muted-tag">${esc(m.compatibility.fitLabel)}</span>` : '';
  const lic = m.license === 'not specified' ? '<span class="tag muted-tag">лицензия не указана</span>' : '';
  div.innerHTML = `
    <div class="model-item-main">
      <div class="model-item-title"><span class="dot ${st}"></span>${esc(m.displayName)} ${unc} ${fit} ${installed} ${lic}</div>
      <div class="model-item-sub">${esc(m.params)} · ${esc(c.categories[m.category])} · лицензия: ${esc(m.license)} ·
        контекст ${m.compatibility.contextTokens} ток.<br>
        ${esc(m.purpose || '')}${m.notes ? '<br>⚠ ' + esc(m.notes) : ''}<br>
        <a href="${esc(m.source)}" target="_blank" rel="noopener noreferrer" style="color:var(--accent)">${esc(m.source)}</a>
      </div>
      <div class="model-item-sub">Совместимость: ${st === 'green' ? 'зелёная — подходит' : st === 'yellow' ? 'жёлтая — с ограничениями' : 'красная — не рекомендуется'}.
        ${m.compatibility.speedNote ? esc(m.compatibility.speedNote) : ''}
        ${rec ? `<br>Рекомендуемый квант: <b>${esc(rec.name.replace(/\.gguf$/i, ''))}</b> (${fmtSize(rec.sizeBytes)})` : ''}
      </div>
    </div>
    <div class="model-item-actions">
      <select class="quant-select" aria-label="Квантование">
        ${m.files.map((f) => `<option value="${esc(f.name)}" ${rec && f.name === rec.name ? 'selected' : ''}>
          ${esc(f.name.replace(/\.gguf$/i, '').split('.').pop())} · ${fmtSize(f.sizeBytes)}</option>`).join('')}
      </select>
      ${m.installed ? '' : `<button class="btn-download">${m.downloaded ? 'Перекачать' : 'Скачать'}</button>`}
    </div>`;
  div.querySelector('.btn-download')?.addEventListener('click', async () => {
    const fileName = div.querySelector('.quant-select').value;
    const targetDir = $('f-dir').value.trim();
    try {
      await api('/api/downloads', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ modelId: m.id, fileName, targetDir: targetDir || undefined }) });
      event(`загрузка начата: ${m.displayName} · ${fileName}`);
      openTab('downloads');
    } catch (err) { showError('ошибка загрузки: ' + err.message); }
  });
  return div;
}


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
  }
  refreshDlBadge();
}

/* ============================ Проекты ============================ */
const PROJ_KEY = 'litemind-project-dir';

function loadProjects() {
  const saved = localStorage.getItem(PROJ_KEY);
  if (saved && !$('proj-dir').value) { $('proj-dir').value = saved; state.projDir = saved; }
  if (state.projDir) $('ws-dir').textContent = state.projDir;
}

async function scanProject(force) {
  const dir = $('proj-dir').value.trim();
  if (!dir) { showError('Укажите папку проекта.'); return; }
  state.projDir = dir;
  localStorage.setItem(PROJ_KEY, dir);
  $('ws-dir').textContent = dir;
  $('proj-summary').textContent = 'сканирование…';
  try {
    const s = await api('/api/project/scan', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: dir, force: force === true }) });
    $('proj-summary').textContent = `Проект открыт: ${dir}`;
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
    buildWsTree();
    event(`проект просканирован: ${dir}`);
  } catch (err) {
    $('proj-summary').textContent = '';
    showError('сканирование: ' + err.message);
  }
}
$('btn-proj-scan').addEventListener('click', () => scanProject(false));
$('btn-proj-rescan').addEventListener('click', () => scanProject(true));

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

/* ============================ Workspace ============================ */
function loadWorkspace() {
  if (state.wsDir) { $('ws-dir').textContent = state.wsDir; buildWsTree(); }
}

async function buildWsTree() {
  const tree = $('ws-tree');
  if (!state.wsDir) { tree.innerHTML = '<span class="muted">Откройте проект на вкладке «Проекты».</span>'; return; }
  tree.innerHTML = '<span class="muted">загрузка карты файлов…</span>';
  try {
    const m = await api(`/api/project/map?path=${encodeURIComponent(state.wsDir)}`);
    const files = m.files ?? [];
    if (!files.length) { tree.innerHTML = '<span class="muted">карта пуста — выполните сканирование проекта</span>'; return; }
    tree.innerHTML = '';
    for (const f of files.slice(0, 400)) {
      const name = typeof f === 'string' ? f : f.path ?? f.file;
      if (!name) continue;
      const btn = document.createElement('button');
      btn.className = 'ws-file';
      btn.textContent = name;
      btn.addEventListener('click', () => openWsFile(name, btn));
      tree.appendChild(btn);
    }
  } catch (err) {
    tree.innerHTML = '';
    showError('карта файлов: ' + err.message);
  }
}

async function openWsFile(name, btn) {
  document.querySelectorAll('.ws-file.selected').forEach((b) => b.classList.remove('selected'));
  btn?.classList.add('selected');
  $('ws-file-label').textContent = name + ' — загрузка…';
  try {
    const r = await api(`/api/project/file?path=${encodeURIComponent(state.wsDir)}&file=${encodeURIComponent(name)}`);
    $('ws-editor').value = r.content;
    $('ws-file-label').textContent = `${name} · ${fmtSize(r.sizeBytes)}`;
    state.wsFile = name;
    $('ws-note').textContent = '';
  } catch (err) {
    $('ws-editor').value = '';
    $('ws-file-label').textContent = name + ' — не открыт';
    $('ws-note').textContent = err.message;
  }
}

$('btn-ws-save').addEventListener('click', async () => {
  if (!state.wsDir || !state.wsFile) { showError('Сначала откройте проект и файл.'); return; }
  try {
    const r = await api('/api/project/file', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: state.wsDir, file: state.wsFile, content: $('ws-editor').value }) });
    $('ws-note').textContent = `сохранено ${fmtSize(r.sizeBytes)}`;
    event(`workspace: сохранён ${state.wsFile}`);
  } catch (err) { showError('сохранение: ' + err.message); }
});

/* ============================ AI Terminal ============================ */
function loadTerminal() {
  if (!state.projDir && !$('term-cwd').value) {
    const saved = localStorage.getItem(PROJ_KEY);
    if (saved) $('term-cwd').value = saved;
  }
}

$('btn-term-run').addEventListener('click', async () => {
  const cwd = $('term-cwd').value.trim();
  const command = $('term-cmd').value.trim();
  if (!cwd || !command) { showError('Укажите папку и команду.'); return; }
  const out = $('term-out');
  out.hidden = false;
  out.textContent = `$ ${command}\nвыполняется…`;
  $('btn-term-run').disabled = true;
  try {
    const r = await api('/api/terminal/exec', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cwd, command, timeoutMs: 30000 }) });
    let text = `$ ${command}\n`;
    if (r.stdout) text += r.stdout;
    if (r.stderr) text += (r.stdout ? '\n[stderr]\n' : '') + r.stderr;
    if (!r.stdout && !r.stderr) text += '(без вывода)';
    text += `\n\nкод выхода: ${r.exitCode}${r.timedOut ? ' (ТАЙМАУТ — процесс завершён принудительно)' : ''} · время: ${r.durationMs} мс`;
    if (r.error) text += `\nошибка: ${r.error}`;
    out.textContent = text;
    out.className = 'term-out' + (r.exitCode === 0 ? '' : ' rc-bad');
    event(`терминал: ${command} → код ${r.exitCode}`);
  } catch (err) {
    out.textContent = `$ ${command}\nошибка: ${err.message}`;
    showError(err.message);
  } finally {
    $('btn-term-run').disabled = false;
  }
});
$('term-cmd').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('btn-term-run').click(); });

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
}

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
