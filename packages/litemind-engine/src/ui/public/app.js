// LiteMind UI — собственный интерфейс движка. Vanilla JS, без сборки.
// Работает в двух режимах: панель движка (http://127.0.0.1:8399) и
// собственный интерфейс LiteMind Desktop (oc://renderer/litemind/index.html).
// API движка — единственный backend; в Desktop добавляется IPC-мост Electron.
const $ = (id) => document.getElementById(id);
const ENGINE_BASE = location.protocol.startsWith('http') && location.port === '8399' ? '' : 'http://127.0.0.1:8399';
const bridge = () => (typeof window !== 'undefined' && window.electron?.litemindEngine) || null;

const state = { streaming: false, engineOnline: null, catalog: null, wsDir: null, wsFile: null, projDir: null };

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

/* ============================ навигация ============================ */
function switchTab(name) {
  name = name || 'home';
  const btn = document.querySelector(`.nav-item[data-tab="${name}"]`);
  if (!btn) name = 'home';
  document.querySelectorAll('.nav-item').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  document.querySelectorAll('[data-page]').forEach((p) => { p.hidden = p.id !== `tab-${name}`; });
  ({ catalog: loadCatalog, downloads: refreshDownloads, hardware: loadHardware, settings: loadSettings,
     models: loadMyModels, monitor: loadMonitor, control: refreshControl, home: refreshStatus,
     chat: loadChat, projects: loadProjects, workspace: loadWorkspace, terminal: loadTerminal })[name]?.();
  const hash = '#' + name;
  if (location.hash !== hash) history.replaceState(null, '', hash);
  $('main').scrollTop = 0;
}
document.querySelectorAll('.nav-item').forEach((t) => t.addEventListener('click', () => switchTab(t.dataset.tab)));
window.addEventListener('hashchange', () => switchTab(location.hash.slice(1)));
const openTab = (name) => switchTab(name);
$('home-open-chat').addEventListener('click', () => openTab('chat'));
$('home-open-catalog').addEventListener('click', () => openTab('catalog'));

/* ============================ статус / главная ============================ */
let statusCache = null;

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
    $('home-models').textContent = `${models.length} установлено`;
    $('home-queue').textContent = `${s.queue.active} активных / ${s.queue.waiting} в очереди`;
    $('queue').textContent = `${s.queue.active} активных / ${s.queue.waiting} в очереди (лимит ${s.queue.limit})`;
    $('profile').textContent = s.engine.profileLabel;
    $('saver').checked = s.engine.profile === 'low';
    $('home-note').textContent = healthy
      ? `Backend: ${s.backend.type} ${s.backend.health.version || ''}. Движок подобрал параметры под ваше железо автоматически.`
      : `Runtime (Ollama) не отвечает: ${s.backend.health.error || '—'}. Модели не запущены — CPU и память не заняты.`;
    const m = s.metrics;
    if (m) {
      const ramPct = m.totalRamMb ? (m.usedRamMb / m.totalRamMb) * 100 : 0;
      bar('cpu', m.cpuPercent, `${Math.round(m.cpuPercent)} %`);
      bar('ram', ramPct, `${Math.round(m.usedRamMb)} / ${Math.round(m.totalRamMb)} МБ`);
      if (m.vramTotalMb) bar('vram', 0, `≈ ${Math.round(m.vramTotalMb)} МБ всего`);
      else { $('vram').textContent = 'недоступно'; const b = $('vram-bar'); if (b) b.style.width = '0'; }
      $('gpu-name').textContent = (m.gpuNames && m.gpuNames.length) ? m.gpuNames.join(', ') : 'видеокарта не определена';
    }
    fillModels(models, s.limits?.contextTokens ? String(s.limits.contextTokens) : undefined);
    if (!$('maxtok').dataset.touched && s.limits?.maxOutputTokens) $('maxtok').value = String(s.limits.maxOutputTokens);
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
  }
  setConn(online);
  if ($('ctl-engine')) refreshControl(online);
  refreshDlBadge();
}

function setConn(ok) {
  if (state.engineOnline === ok) return;
  state.engineOnline = ok;
  const c = $('conn-badge');
  c.textContent = ok ? 'движок: подключён' : 'движок: не отвечает';
  c.className = 'conn ' + (ok ? 'ok' : 'bad');
  if (!ok) event('связь с движком потеряна');
  else if (state.engineOnline !== null) event('движок подключён');
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

/* ============================ модели (выбор в чате) ============================ */
function fillModels(models, _current) {
  const sel = $('model');
  if (!sel) return;
  const wanted = sel.value;
  const ids = models.map((m) => m.id);
  if (sel.dataset.ids !== ids.join('|')) {
    sel.innerHTML = '';
    for (const m of models) {
      const o = document.createElement('option');
      o.value = m.id;
      o.textContent = m.id + (m.sizeBytes ? ` (${fmtSize(m.sizeBytes)})` : '');
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

/* ============================ AI Chat ============================ */
const CHAT_KEY = 'litemind-chat-history';
let chatHistory = [];
try { chatHistory = JSON.parse(localStorage.getItem(CHAT_KEY) || '[]'); } catch { chatHistory = []; }

function renderChat() {
  const log = $('chat-log');
  log.innerHTML = '';
  for (const m of chatHistory) {
    const div = document.createElement('div');
    div.className = 'chat-msg ' + (m.role === 'user' ? 'user' : 'assistant');
    div.textContent = m.content;
    log.appendChild(div);
  }
  log.scrollTop = log.scrollHeight;
}
function loadChat() { renderChat(); }

$('btn-newchat').addEventListener('click', () => {
  chatHistory = [];
  localStorage.setItem(CHAT_KEY, '[]');
  renderChat();
  $('timings').textContent = '';
  event('начат новый чат');
});

async function sendChat() {
  const model = $('model').value;
  const prompt = $('prompt').value.trim();
  if (!model) { showError('Модели не установлены — скачайте модель в «Каталоге моделей».'); return; }
  if (!prompt || state.streaming) return;
  $('prompt').value = '';
  chatHistory.push({ role: 'user', content: prompt });
  renderChat();
  const reply = { role: 'assistant', content: '' };
  chatHistory.push(reply);
  const holder = document.createElement('div');
  holder.className = 'chat-msg assistant';
  $('chat-log').appendChild(holder);
  $('chat-log').scrollTop = $('chat-log').scrollHeight;
  state.streaming = true;
  $('btn-send').disabled = true;
  $('run-state').textContent = 'генерация…';
  const t0 = performance.now();
  let ttft = null;
  try {
    // Контекст: последние сообщения (уплотнение середины выполняет движок).
    const send = chatHistory.slice(0, -1).slice(-20);
    const res = await fetch(ENGINE_BASE + '/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, stream: true, context_tokens: Number($('ctx').value), max_tokens: Number($('maxtok').value), messages: send })
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data?.error?.message || `HTTP ${res.status}`);
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
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
          if (payload === '[DONE]') continue;
          let obj;
          try { obj = JSON.parse(payload); } catch { continue; }
          if (obj.error) throw new Error(obj.error.message);
          const delta = obj.choices?.[0]?.delta?.content;
          if (delta) {
            if (ttft === null) ttft = Math.round(performance.now() - t0);
            reply.content += delta;
            holder.textContent = reply.content;
            $('chat-log').scrollTop = $('chat-log').scrollHeight;
          }
        }
      }
    }
    const total = Math.round(performance.now() - t0);
    $('timings').textContent = `время до первого токена: ${ttft ?? '—'} мс · общее время: ${total} мс`;
    event(`чат: ответ получен (${total} мс)`);
  } catch (err) {
    reply.content = reply.content || '';
    const e = document.createElement('div');
    e.className = 'chat-msg error';
    e.textContent = 'Ошибка: ' + err.message;
    $('chat-log').appendChild(e);
    event('ошибка чата: ' + err.message);
  } finally {
    localStorage.setItem(CHAT_KEY, JSON.stringify(chatHistory.slice(-40)));
    state.streaming = false;
    $('btn-send').disabled = false;
    $('run-state').textContent = '';
    holder.textContent = reply.content || '— пустой ответ —';
    refreshStatus();
  }
}
$('btn-send').addEventListener('click', sendChat);
$('prompt').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); }
});
$('btn-stop').addEventListener('click', async () => {
  try { const r = await api('/api/stop', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }); event(`генерация остановлена (${r.cancelled})`); }
  catch (err) { showError(err.message); }
});
$('maxtok').addEventListener('input', () => { $('maxtok').dataset.touched = '1'; });

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
  // Мост хоста (Desktop)
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
    // Соединение рвётся при закрытии сервера — это и есть успешная остановка.
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
  try {
    const s = await api('/api/status');
    const ul = $('my-models');
    ul.innerHTML = '';
    if (!(s.models || []).length) {
      ul.innerHTML = '<li class="muted">Модели не установлены. Скачайте из каталога — после установки они появятся здесь.</li>';
    } else {
      for (const m of s.models) {
        const li = document.createElement('li');
        li.innerHTML = `<div class="model-item-main"><div class="model-item-title">${esc(m.id)}</div>
          <div class="model-item-sub">${fmtSize(m.sizeBytes)} · ${esc(m.detail || '')}</div></div>
          <div class="model-item-actions"><button data-opt="${esc(m.id)}">Автооптимизация</button>
          <button data-stop="${esc(m.id)}">Остановить модель</button></div>
          <div class="model-item-sub" data-report="${esc(m.id)}"></div>`;
        li.querySelector('[data-opt]').addEventListener('click', () => optimizeModel(m.id, li.querySelector('[data-report]')));
        li.querySelector('[data-stop]').addEventListener('click', () => stopModel(m.id));
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
  $('install-note').textContent = 'установка… (загрузка blob в backend, может занять несколько минут)';
  try {
    const r = await api('/api/install', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ggufPath: sel.value }) });
    $('install-note').textContent = '';
    event(`установлено: ${r.model}`);
    loadMyModels();
  } catch (err) {
    $('install-note').textContent = '';
    showError('ошибка установки: ' + err.message);
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

  const show = { 'uncensored-coding': $('f-uncensored').checked, 'small-coding': $('f-small').checked, 'advanced-coding': $('f-advanced').checked };
  const list = $('catalog-list');
  list.innerHTML = '';
  for (const m of c.models) {
    if (!show[m.category]) continue;
    list.appendChild(catalogCard(m, c));
  }
}

function catalogCard(m, c) {
  const div = document.createElement('div');
  div.className = 'catalog-item';
  const st = m.compatibility.status;
  const rec = m.compatibility.recommended;
  const installed = m.installed ? '<span class="tag ok-tag">установлена</span>' : '';
  const unc = m.uncensored ? `<span class="tag">${esc(m.uncensoredLabel || 'Uncensored')}</span>` : '';
  const lic = m.license === 'not specified' ? '<span class="tag muted-tag">лицензия не указана</span>' : '';
  div.innerHTML = `
    <div class="model-item-main">
      <div class="model-item-title"><span class="dot ${st}"></span>${esc(m.displayName)} ${unc} ${installed} ${lic}</div>
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
      ${m.installed ? '' : `<button class="btn-download">${m.downloaded ? 'Перекачать' : 'Скачать и установить'}</button>`}
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

['f-uncensored', 'f-small', 'f-advanced'].forEach((id) => $(id).addEventListener('change', loadCatalog));

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
        ${d.state === 'done' ? '<button class="act-install">Установить в движок</button>' : ''}
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
        .then((r) => { event(`установлено: ${r.model}`); refreshDownloads(); })
        .catch((err) => showError('установка: ' + err.message)));
    ul.appendChild(li);

    if (d.state === 'done' && d.modelId && !AUTO_INSTALLED.has(d.id)) {
      AUTO_INSTALLED.add(d.id);
      api('/api/install', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ modelId: d.modelId, fileName: d.name, targetDir: d.targetDir }) })
        .then((r) => event(`автоустановка завершена: ${r.model}`))
        .catch((err) => event(`автоустановка (${d.name}): ${err.message} — установите вручную`));
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
    // API отдаёт: { root, fileCount, scannedAt, byExt } — показываем только
    // реально вычисленные поля, без вымышленных «—»-строк.
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
switchTab(location.hash.slice(1) || 'home');
refreshStatus();
setInterval(refreshStatus, 2500);
setInterval(() => {
  if (document.querySelector('.nav-item.active')?.dataset.tab === 'downloads') refreshDownloads();
}, 1500);
