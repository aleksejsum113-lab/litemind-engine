// LiteMind Agent UI (ТЗ v0.6.1) — диалоговое рабочее пространство агента.
// Самодостаточный модуль: не трогает логику Chat, переиспользует общие
// api()/esc()/mdToHtml() из app.js и CSS-классы чата (msg/msg-bot).
// Живёт поверх HTTP API движка: /api/agent/*, SSE /api/agent/events.

/* global api, esc, showError, event, mdToHtml, ENGINE_BASE */
(() => {
  const $ = (id) => document.getElementById(id);
  const BASE = (typeof ENGINE_BASE !== 'undefined') ? ENGINE_BASE : 'http://127.0.0.1:8399';
  const LS_ACTIVE = 'litemind-agent-active';
  const LS_PROJECT = 'litemind-agent-project';

  let sessions = [];
  let activeId = localStorage.getItem(LS_ACTIVE) || null;
  let cursor = 0;
  let es = null;               // EventSource активной сессии
  let attachments = [];        // [{name, dataBase64}]
  let statusTimer = null;
  let streamingEl = null;      // блок потокового ответа
  let WELCOME_HTML = '';

  const STATE_CLASS = {
    idle: 'st-idle', running: 'st-running', awaiting_confirmation: 'st-confirm',
    waiting_user: 'st-confirm', done: 'st-done', error: 'st-error', stopped: 'st-stopped'
  };

  // ── Утилиты ─────────────────────────────────────────────────────────────

  function autoGrowEl(el) {
    el.style.height = 'auto';
    el.style.height = Math.min(180, el.scrollHeight) + 'px';
  }

  function setStateBadge(state, label) {
    const b = $('agent-state');
    if (!b) return;
    const labels = {
      idle: 'Готов', running: 'Выполняет задачу', awaiting_confirmation: 'Ожидает подтверждения',
      waiting_user: 'Ждёт ответа', done: 'Завершено', error: 'Ошибка', stopped: 'Остановлено'
    };
    b.textContent = label ?? labels[state] ?? 'Готов';
    b.className = 'agent-state-badge ' + (STATE_CLASS[state] ?? 'st-idle');
    const busy = ['running', 'awaiting_confirmation', 'waiting_user'].includes(state);
    $('agent-stop').hidden = !busy;
  }

  function renderStage(view) {
    if (!$('agent-stage')) return;
    $('agent-stage').textContent = view.currentStage ? 'Этап: ' + view.currentStage : '';
    $('agent-hint-line').textContent = view.state === 'awaiting_confirmation'
      ? 'агент ждёт подтверждения — проверьте diff ниже'
      : view.state === 'waiting_user'
        ? 'агент задал вопрос — ответьте в поле ввода'
        : 'агент спрашивает подтверждение на изменения файлов и команды';
  }

  // ── Блоки диалога (те же классы, что у чата) ────────────────────────────

  function msgUser(text) {
    const wrap = document.createElement('div');
    wrap.className = 'msg msg-user';
    const av = document.createElement('div');
    av.className = 'msg-avatar';
    av.textContent = 'Вы';
    const body = document.createElement('div');
    body.className = 'msg-body';
    const p = document.createElement('div');
    p.className = 'msg-text';
    p.textContent = text ?? '';
    body.appendChild(p);
    wrap.append(av, body);
    return wrap;
  }

  function msgAssistant(text, streaming = false) {
    const wrap = document.createElement('div');
    wrap.className = 'msg msg-bot' + (streaming ? ' streaming' : '');
    const av = document.createElement('div');
    av.className = 'msg-avatar';
    av.textContent = '✦';
    const body = document.createElement('div');
    body.className = 'msg-body';
    const md = document.createElement('div');
    md.className = 'msg-md';
    md.innerHTML = text ? mdToHtml(text) : '<span class="thinking">…</span>';
    body.appendChild(md);
    if (streaming) body.insertAdjacentHTML('beforeend', '<span class="cursor-blink"></span>');
    wrap.append(av, body);
    return wrap;
  }

  function msgTool(m) {
    const wrap = document.createElement('div');
    wrap.className = 'msg msg-bot';
    const av = document.createElement('div');
    av.className = 'msg-avatar';
    av.textContent = '🔧';
    const body = document.createElement('div');
    body.className = 'msg-body';
    const det = document.createElement('details');
    det.className = 'agent-tool' + (m.ok ? ' ok' : ' fail');
    const summ = document.createElement('summary');
    summ.innerHTML = `<b>${esc(m.tool)}</b> <span class="agent-tag ${m.ok ? 'ok' : 'fail'}">${m.ok ? 'выполнено' : 'ошибка'}</span>`;
    det.appendChild(summ);
    const args = document.createElement('pre');
    args.className = 'agent-tool-args';
    args.textContent = JSON.stringify(m.args ?? {}, null, 1).slice(0, 2000);
    det.appendChild(args);
    const out = document.createElement('pre');
    out.className = 'agent-tool-out';
    out.textContent = String(m.result ?? '').slice(0, 8000);
    det.appendChild(out);
    body.appendChild(det);
    wrap.append(av, body);
    return wrap;
  }

  function msgConfirmation(m) {
    const c = m.change ?? {};
    const wrap = document.createElement('div');
    wrap.className = 'msg msg-bot';
    const av = document.createElement('div');
    av.className = 'msg-avatar';
    av.textContent = '⚠️';
    const body = document.createElement('div');
    body.className = 'msg-body';
    const card = document.createElement('div');
    card.className = 'agent-confirm';
    const title = document.createElement('div');
    title.className = 'agent-confirm-title';
    title.innerHTML = `<b>Запрос действия:</b> ${esc(c.tool ?? '')}${c.path ? ` → <code>${esc(c.path)}</code>` : ''}`;
    card.appendChild(title);
    const pre = document.createElement('pre');
    pre.className = 'agent-diff';
    pre.textContent = c.diff ?? '';
    card.appendChild(pre);
    if (c.backupId) {
      const note = document.createElement('div');
      note.className = 'muted small';
      note.textContent = `резервная копия создана: ${c.backupId} — откат через Workspace`;
      card.appendChild(note);
    }
    const row = document.createElement('div');
    row.className = 'agent-confirm-btns';
    const ok = document.createElement('button');
    ok.className = 'primary'; ok.textContent = '✓ Применить';
    const no = document.createElement('button'); no.textContent = '✕ Отклонить';
    const fb = document.createElement('input');
    fb.type = 'text'; fb.placeholder = 'комментарий агенту (необязательно)'; fb.className = 'agent-feedback';
    ok.addEventListener('click', () => decide(m.approvalId, true, fb.value));
    no.addEventListener('click', () => decide(m.approvalId, false, fb.value));
    row.append(ok, no, fb);
    card.appendChild(row);
    body.appendChild(card);
    wrap.append(av, body);
    return wrap;
  }

  function msgReport(m) {
    const r = m.report ?? {};
    const wrap = document.createElement('div');
    wrap.className = 'msg msg-bot';
    const av = document.createElement('div');
    av.className = 'msg-avatar';
    av.textContent = '✅';
    const body = document.createElement('div');
    body.className = 'msg-body';
    const card = document.createElement('div');
    card.className = 'agent-report';
    const h = document.createElement('div');
    h.className = 'agent-report-title';
    h.textContent = 'Итог: ' + (r.summary ?? '');
    card.appendChild(h);
    const list = (items, cls) => {
      if (!Array.isArray(items) || !items.length) return null;
      const el = document.createElement('div');
      el.className = 'agent-report-list ' + cls;
      el.textContent = items.map((x) => `${cls === 'created' ? '+' : cls === 'modified' ? '~' : '×'} ${x}`).join('\n');
      return el;
    };
    for (const [k, cls] of [['created', 'created'], ['modified', 'modified'], ['failed', 'failed']]) {
      const el = list(r[k], cls);
      if (el) card.appendChild(el);
    }
    body.appendChild(card);
    wrap.append(av, body);
    return wrap;
  }

  function msgNote(m) {
    const wrap = document.createElement('div');
    wrap.className = 'msg msg-bot';
    const av = document.createElement('div');
    av.className = 'msg-avatar';
    av.textContent = m.type === 'error' ? '!' : '…';
    const body = document.createElement('div');
    body.className = 'msg-body';
    const div = document.createElement('div');
    div.className = 'agent-note' + (m.type === 'error' ? ' err' : '');
    div.textContent = m.text ?? '';
    body.appendChild(div);
    wrap.append(av, body);
    return wrap;
  }

  function renderMsg(m) {
    if (m.role === 'user') return msgUser(m.text ?? '');
    if (m.role === 'assistant') return msgAssistant(m.text ?? '');
    if (m.role === 'tool') return msgTool(m);
    if (m.role === 'event') {
      if (m.type === 'confirmation') return msgConfirmation(m);
      if (m.type === 'report') return msgReport(m);
      return msgNote(m);
    }
    return null;
  }

  function appendMsg(m) {
    hideStreaming();
    const log = $('agent-log');
    const welcome = $('agent-welcome');
    if (welcome) welcome.remove();
    const el = renderMsg(m);
    if (el) log.appendChild(el);
    cursor = Math.max(cursor, m.id ?? 0);
    log.scrollTop = log.scrollHeight;
  }

  function hideStreaming() {
    if (streamingEl) { streamingEl.remove(); streamingEl = null; }
  }

  function showStreaming(text) {
    const log = $('agent-log');
    if ($('agent-welcome')) $('agent-welcome').remove();
    if (!streamingEl) {
      streamingEl = msgAssistant('', true);
      log.appendChild(streamingEl);
    }
    const md = streamingEl.querySelector('.msg-md');
    if (md) md.innerHTML = mdToHtml(String(text ?? '').slice(-4000));
    log.scrollTop = log.scrollHeight;
  }

  function renderFull(view) {
    const log = $('agent-log');
    log.innerHTML = WELCOME_HTML;
    hideStreaming();
    cursor = 0;
    for (const m of view.messages) {
      const el = renderMsg(m);
      if (el) log.appendChild(el);
      cursor = Math.max(cursor, m.id ?? 0);
    }
    setStateBadge(view.state, view.stateLabel);
    renderStage(view);
    log.scrollTop = log.scrollHeight;
  }

  // ── Сессии ──────────────────────────────────────────────────────────────

  async function refreshSessions() {
    try {
      const r = await api('/api/agent/sessions');
      sessions = r.sessions ?? [];
      renderSessionList();
    } catch { /* движок может быть недоступен */ }
  }

  function renderSessionList() {
    const box = $('agent-sessions');
    if (!box) return;
    box.innerHTML = '';
    if (!sessions.length) {
      box.innerHTML = '<div class="muted small" style="padding:8px 12px">задач пока нет — нажмите «＋ Новая задача»</div>';
      return;
    }
    for (const s of sessions) {
      const row = document.createElement('div');
      row.className = 'agent-session-row' + (s.id === activeId ? ' active' : '');
      const title = document.createElement('span');
      title.className = 'agent-session-title';
      title.textContent = s.title;
      const st = document.createElement('span');
      st.className = 'agent-state-badge sm ' + (STATE_CLASS[s.state] ?? 'st-idle');
      st.textContent = s.stateLabel;
      const del = document.createElement('button');
      del.className = 'icon-btn'; del.title = 'Удалить задачу'; del.textContent = '✕';
      del.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!confirm(`Удалить задачу «${s.title}» вместе с диалогом?`)) return;
        await api(`/api/agent/sessions/${s.id}`, { method: 'DELETE' });
        if (activeId === s.id) {
          activeId = null;
          localStorage.removeItem(LS_ACTIVE);
          closeStream();
          $('agent-log').innerHTML = WELCOME_HTML;
          setStateBadge('idle', 'Готов');
        }
        refreshSessions();
      });
      row.append(title, st, del);
      row.addEventListener('click', () => openSession(s.id));
      box.appendChild(row);
    }
  }

  function closeStream() {
    if (es) { try { es.close(); } catch { /* */ } es = null; }
    hideStreaming();
  }

  function subscribe(id) {
    closeStream();
    es = new EventSource(`${BASE}/api/agent/sessions/${id}/events?cursor=${cursor}`);
    es.onmessage = (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch { return; }
      if (m.role === 'delta') { showStreaming(m.text); return; }
      if (m.id && m.id <= cursor) return;
      appendMsg(m);
      if (m.type === 'confirmation') setStateBadge('awaiting_confirmation');
      if (m.type === 'report') setStateBadge('done');
      if (m.type === 'error') setStateBadge('error');
      if (m.type === 'stopped') setStateBadge('stopped');
      if (m.role === 'assistant') setStateBadge('idle');
      refreshSessions();
    };
    es.onerror = () => { /* EventSource сам переподключится; реплей с cursor */ };
  }

  async function openSession(id) {
    activeId = id;
    localStorage.setItem(LS_ACTIVE, id);
    try {
      const view = await api(`/api/agent/sessions/${id}`);
      if (view.projectDir) { $('agent-project').value = view.projectDir; localStorage.setItem(LS_PROJECT, view.projectDir); }
      $('agent-auto').checked = !!view.autoApprove;
      renderFull(view);
      subscribe(id);
      renderSessionList();
    } catch (err) {
      showError('агент: ' + err.message);
    }
  }

  async function newSession() {
    const projectDir = $('agent-project').value.trim() || null;
    if (projectDir) localStorage.setItem(LS_PROJECT, projectDir);
    try {
      const s = await api('/api/agent/sessions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ projectDir, model: $('agent-model').value || null, autoApprove: $('agent-auto').checked })
      });
      activeId = s.id;
      localStorage.setItem(LS_ACTIVE, s.id);
      cursor = 0;
      $('agent-log').innerHTML = WELCOME_HTML;
      hideStreaming();
      await refreshSessions();
      subscribe(s.id);
      setStateBadge('idle', 'Готов');
      $('agent-prompt').focus();
      event('создана задача агента');
    } catch (err) {
      showError('не удалось создать задачу: ' + err.message);
    }
  }

  // ── Отправка / решение / стоп ───────────────────────────────────────────

  async function sendAgentMessage() {
    const text = $('agent-prompt').value.trim();
    if (!text && !attachments.length) return;
    if (!activeId) { await newSession(); if (!activeId) return; }
    const body = {
      text,
      attachments: attachments.map((a) => ({ name: a.name, dataBase64: a.dataBase64 })),
      projectDir: $('agent-project').value.trim() || undefined,
      autoApprove: $('agent-auto').checked
    };
    $('agent-prompt').value = '';
    autoGrowEl($('agent-prompt'));
    attachments = [];
    renderAttachBar();
    try {
      const view = await api(`/api/agent/sessions/${activeId}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body)
      });
      setStateBadge(view.state, view.stateLabel);
      renderStage(view);
      if (!es) subscribe(activeId);
    } catch (err) {
      showError('агент: ' + err.message);
    }
  }

  async function decide(approvalId, approved, feedback) {
    if (!activeId) return;
    try {
      const view = await api(`/api/agent/sessions/${activeId}/decision`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ approvalId, approved, feedback: feedback || '' })
      });
      setStateBadge(view.state, view.stateLabel);
      renderStage(view);
    } catch (err) {
      showError('агент: ' + err.message);
    }
  }

  async function stopAgent() {
    if (!activeId) return;
    try {
      const view = await api(`/api/agent/sessions/${activeId}/stop`, { method: 'POST' });
      setStateBadge(view.state, view.stateLabel);
      renderStage(view);
      refreshSessions();
    } catch (err) {
      showError('агент: ' + err.message);
    }
  }

  // ── Вложения ────────────────────────────────────────────────────────────

  function renderAttachBar() {
    const bar = $('agent-attach-bar');
    bar.innerHTML = '';
    bar.hidden = attachments.length === 0;
    attachments.forEach((a, i) => {
      const chip = document.createElement('span');
      chip.className = 'attach-chip';
      chip.innerHTML = `📄 ${esc(a.name)} <button data-del="${i}">✕</button>`;
      chip.querySelector('[data-del]').addEventListener('click', () => {
        attachments.splice(i, 1);
        renderAttachBar();
      });
      bar.appendChild(chip);
    });
  }

  // ── Статус в боковой панели (виден из любого раздела, ТЗ §3) ────────────

  async function pollStatus() {
    try {
      const st = await api('/api/agent/status');
      const badge = $('agent-badge');
      const a = st.active;
      if (a && badge) {
        badge.textContent = a.stateLabel;
        badge.hidden = false;
        badge.className = 'nav-badge agent-badge ' + (STATE_CLASS[a.state] ?? '');
        if (a.id === activeId) {
          setStateBadge(a.state, a.stateLabel);
        }
      } else if (badge) {
        badge.hidden = true;
      }
    } catch { /* движок offline */ }
  }

  // ── Загрузка раздела ────────────────────────────────────────────────────

  async function loadAgent() {
    if (!WELCOME_HTML) WELCOME_HTML = $('agent-log').innerHTML;
    // модель: список из общего селектора чата (общий runtime)
    const chatModel = $('model');
    if (chatModel && chatModel.options.length) {
      const cur = $('agent-model').value || chatModel.value;
      $('agent-model').innerHTML = chatModel.innerHTML;
      $('agent-model').value = cur;
    } else {
      setTimeout(() => { try { loadAgent(); } catch { /* */ } }, 1500);
    }
    // проект по умолчанию: из Workspace (общий ключ) или из памяти агента
    if (!$('agent-project').value) {
      const ws = localStorage.getItem('litemind-project') || localStorage.getItem(LS_PROJECT);
      if (ws) $('agent-project').value = ws;
    }
    await refreshSessions();
    if (activeId && sessions.some((s) => s.id === activeId)) {
      await openSession(activeId);
    } else {
      activeId = null;
      localStorage.removeItem(LS_ACTIVE);
      setStateBadge('idle', 'Готов');
    }
    if (!statusTimer) statusTimer = setInterval(pollStatus, 2500);
    pollStatus();
  }

  // ── Обработчики ─────────────────────────────────────────────────────────

  $('agent-send').addEventListener('click', sendAgentMessage);
  $('agent-stop').addEventListener('click', stopAgent);
  $('agent-new').addEventListener('click', newSession);
  $('agent-sessions-btn').addEventListener('click', () => { $('agent-sessions').hidden = !$('agent-sessions').hidden; refreshSessions(); });
  $('agent-menu-btn').addEventListener('click', () => document.getElementById('app').classList.toggle('sidebar-open'));
  $('agent-prompt').addEventListener('input', () => autoGrowEl($('agent-prompt')));
  $('agent-prompt').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendAgentMessage(); }
  });
  $('agent-attach').addEventListener('click', () => $('agent-file-input').click());
  $('agent-file-input').addEventListener('change', async (e) => {
    const files = [...e.target.files];
    e.target.value = '';
    for (const f of files.slice(0, 6)) {
      if (f.size > 10 * 1024 * 1024) { showError(`«${f.name}» больше 10 МБ`); continue; }
      const buf = await f.arrayBuffer();
      const bytes = new Uint8Array(buf);
      let bin = '';
      const CHUNK = 0x8000;
      for (let i = 0; i < bytes.length; i += CHUNK) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
      attachments.push({ name: f.name, dataBase64: btoa(bin) });
    }
    renderAttachBar();
  });
  $('agent-log').addEventListener('click', (e) => {
    const hint = e.target.closest('[data-agent-hint]');
    if (hint) { $('agent-prompt').value = hint.dataset.agentHint; $('agent-prompt').focus(); autoGrowEl($('agent-prompt')); }
  });
  window.addEventListener('beforeunload', () => closeStream());

  // экспорт в глобальную область для switchTab
  window.__litemindLoadAgent = loadAgent;
})();
