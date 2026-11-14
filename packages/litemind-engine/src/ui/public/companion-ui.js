// LiteMind Companion UI — панель компаньона (ТЗ v0.6.4, Roamies-дополнение §8).
//
// Разделы: Главная, Память, Мои задачи, Голос, Внешность персонажа,
// Управление Windows, Разрешения, История действий. Всё работает через API
// движка (127.0.0.1:8399) — данные локальны, перезапуск безопасен.
// Оверлей персонажа рисует LiteMind Desktop; отсюда им управляют настройки.
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const ENGINE_BASE = location.protocol.startsWith('http') && location.port === '8399' ? '' : 'http://127.0.0.1:8399';

  async function api(path, opts) {
    const res = await fetch(ENGINE_BASE + path, opts);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error?.message || data?.message || `HTTP ${res.status}`);
    return data;
  }
  const bridge = () => (typeof window !== 'undefined' && window.electron?.litemindEngine) || null;
  const event = (m) => (typeof window.__litemindEvent === 'function' ? window.__litemindEvent(m) : undefined);

  let activeTab = 'main';
  let es = null; // SSE компаньона
  let lastStatus = null;

  /* ─────────────────────────── каркас ─────────────────────────── */

  function card(title, inner, cls = '') {
    return `<div class="card ${cls}"><h2>${esc(title)}</h2>${inner}</div>`;
  }

  function render() {
    const box = $('comp-content');
    if (!box) return;
    switch (activeTab) {
      case 'memory': renderMemory(box); break;
      case 'tasks': renderTasks(box); break;
      case 'voice': renderVoice(box); break;
      case 'appearance': renderAppearance(box); break;
      case 'windows': renderWindows(box); break;
      case 'permissions': renderPermissions(box); break;
      case 'history': renderHistory(box); break;
      default: renderMain(box); break;
    }
  }

  function switchTab(tab) {
    activeTab = tab;
    document.querySelectorAll('#comp-tabs button').forEach((b) => b.classList.toggle('active', b.dataset.compTab === tab));
    if (tab === 'history' || tab === 'main') subscribeEvents();
    else stopEvents();
    render();
  }

  document.querySelectorAll('#comp-tabs button').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.compTab)));

  /* ─────────────────────────── Главная ─────────────────────────── */

  async function renderMain(box) {
    box.innerHTML = card('Состояние', '<p class="muted">загрузка…</p>');
    let st = null;
    let tasks = null;
    let voice = null;
    try { st = await api('/api/companion/status'); } catch { /* офлайн */ }
    try { tasks = await api('/api/tasks'); } catch { /* */ }
    try { voice = await api('/api/voice/status'); } catch { /* */ }
    lastStatus = st ?? lastStatus;
    const s = st ?? { settings: {}, state: 'idle', stateLabel: 'Ждёт' };
    const dueToday = (tasks?.tasks ?? []).filter((t) => !t.done && t.dueAt && new Date(t.dueAt).toDateString() === new Date().toDateString());
    const rows = [
      ['Персонаж', s.settings?.enabled ? `включён (${s.settings.character ?? 'lumi'})` : 'выключен (обычный интерфейс)'],
      ['Состояние', esc(s.stateLabel ?? '—')],
      ['Задачи активные', String(tasks?.stats?.active ?? '—')],
      ['Напоминания сегодня', String(dueToday.length)],
      ['Голос TTS', voice?.tts?.installed ? `установлен (${esc(voice.tts.voice)})` : 'не установлен'],
      ['Голос ASR (распознавание)', voice?.asr?.installed ? 'установлен' : 'не установлен'],
      ['Режим интеллекта', esc(s.settings?.mode ?? '') || '—']
    ];
    const list = rows.map(([k, v]) => `<div class="comp-row"><span>${esc(k)}</span><b>${v}</b></div>`).join('');
    const soon = dueToday.slice(0, 5).map((t) => `<li>☐ ${esc(t.text)} — ${esc(String(t.dueAt).slice(11, 16))}</li>`).join('');
    box.innerHTML =
      card('Состояние компаньона', `<div class="comp-list">${list}</div>
        <div class="btns">
          <button id="comp-open-appearance">Внешность</button>
          <button id="comp-open-voice">Голос</button>
          ${bridge() ? '<button id="comp-toggle-overlay">Показать/скрыть персонажа</button>' : '<span class="muted small">Персонаж-оверлей работает в LiteMind Desktop</span>'}
        </div>`) +
      card('На сегодня', soon ? `<ul class="comp-due">${soon}</ul>` : '<p class="muted">Напоминаний на сегодня нет.</p>') +
      card('Что умеет компаньон', `
        <ul class="comp-features">
          <li><b>Помнит:</b> попросите «запомни, что…» — факт сохранится в долговременной памяти (раздел «Память»).</li>
          <li><b>Напоминает:</b> «напомни завтра в 10:00 позвонить» — задача появится в «Моих задачах», напоминание сработает даже после перезапуска LiteMind.</li>
          <li><b>Разговаривает:</b> голосовой ввод (кнопка 🎙 или Ctrl+Пробел) и озвучивание ответов локальными движками — без облака.</li>
          <li><b>Смотрит на экран:</b> «что открыто на экране?» — текст с экрана читается локально (OCR Windows), только по вашему разрешению.</li>
          <li><b>Помогает с Windows:</b> «открой проводник», «открой сайт…» — с настройкой разрешений.</li>
        </ul>`);
    $('comp-open-appearance')?.addEventListener('click', () => switchTab('appearance'));
    $('comp-open-voice')?.addEventListener('click', () => switchTab('voice'));
    $('comp-toggle-overlay')?.addEventListener('click', () => {
      bridge()?.companionToggle?.();
    });
  }

  /* ─────────────────────────── Память ─────────────────────────── */

  async function renderMemory(box) {
    box.innerHTML = card('Память', '<p class="muted">загрузка…</p>');
    let data;
    try { data = await api('/api/memory'); } catch (err) { box.innerHTML = card('Память', `<p class="muted">Недоступно: ${esc(err.message)}</p>`); return; }
    const blocked = (data.stats?.blocked ?? []).map((b) =>
      `<span class="attach-chip">${esc(b)} <button data-unblock="${esc(b)}" title="Разрешить тему снова">×</button></span>`).join('');
    const entries = (data.entries ?? []).map((e) => `
      <li class="comp-mem-item ${e.pinned ? 'pinned' : ''}">
        <div class="comp-mem-text">${esc(e.text)}</div>
        <div class="comp-mem-meta">${e.source === 'auto' ? 'автоматически' : e.source === 'assistant' ? 'из разговора' : 'от пользователя'} · ${esc(String(e.updatedAt ?? '').slice(0, 10))}</div>
        <div class="btns">
          <button data-pin="${esc(e.id)}">${e.pinned ? 'Открепить' : 'Закрепить'}</button>
          <button data-edit="${esc(e.id)}">Изменить</button>
          <button data-del="${esc(e.id)}" class="danger">Удалить</button>
        </div>
      </li>`).join('');
    box.innerHTML =
      card('Память помощника', `
        <p class="muted">Компаньон помнит эти сведения между разговорами. Всё хранится только на вашем компьютере. «Запрещённые темы» никогда не сохраняются — ни вручную, ни автоматически.</p>
        <div class="btns">
          <input id="mem-new" type="text" class="dir-input" placeholder="Новый факт, например: мой проект называется…" />
          <button id="mem-add" class="primary">Запомнить</button>
        </div>
        <p class="muted" id="mem-note"></p>
        <ul id="mem-list" class="model-list comp-mem-list">${entries || '<li class="muted">Память пуста — попросите в чате: «запомни, что…»</li>'}</ul>`) +
      card('Запрещённые темы (приватность)', `
        <div class="btns">
          <input id="mem-block" type="text" class="dir-input" placeholder="Тема, которую нельзя запоминать: пароли,health…" />
          <button id="mem-block-add">Запретить</button>
        </div>
        <div class="attach-bar" ${blocked ? '' : 'hidden'}>${blocked}</div>
        <div class="btns" style="margin-top:8px">
          <button id="mem-clear">Очистить всю память</button>
          <label class="switch"><input type="checkbox" id="mem-keeppin" checked /> Оставить закреплённые</label>
        </div>`);
    $('mem-add')?.addEventListener('click', async () => {
      const text = $('mem-new').value.trim();
      if (!text) return;
      try {
        await api('/api/memory', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) });
        event('память: факт добавлен вручную');
        renderMemory(box);
      } catch (err) { $('mem-note').textContent = err.message; }
    });
    $('mem-block-add')?.addEventListener('click', async () => {
      const topic = $('mem-block').value.trim();
      if (!topic) return;
      await api('/api/memory/block', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ topic }) });
      renderMemory(box);
    });
    box.querySelectorAll('[data-unblock]').forEach((b) => b.addEventListener('click', async () => {
      await api('/api/memory/unblock', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ topic: b.dataset.unblock }) });
      renderMemory(box);
    }));
    $('mem-clear')?.addEventListener('click', async () => {
      if (!confirm('Удалить все записи памяти? Закреплённые можно сохранить.')) return;
      await api('/api/memory/clear', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ keepPinned: $('mem-keeppin').checked }) });
      event('память очищена');
      renderMemory(box);
    });
    box.querySelectorAll('[data-pin]').forEach((b) => b.addEventListener('click', async () => {
      const e = (data.entries ?? []).find((x) => x.id === b.dataset.pin);
      await api(`/api/memory/${b.dataset.pin}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pinned: !e?.pinned }) });
      renderMemory(box);
    }));
    box.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', async () => {
      const e = (data.entries ?? []).find((x) => x.id === b.dataset.edit);
      const name = (typeof window.__litemindModalPrompt === 'function') ? await window.__litemindModalPrompt('Изменить запись памяти:', e?.text ?? '') : prompt('Изменить запись памяти:', e?.text ?? '');
      if (name === null || !String(name).trim()) return;
      await api(`/api/memory/${b.dataset.edit}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: name }) });
      renderMemory(box);
    }));
    box.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async () => {
      if (!confirm('Удалить эту запись из памяти?')) return;
      await api(`/api/memory/${b.dataset.del}`, { method: 'DELETE' });
      renderMemory(box);
    }));
  }

  /* ─────────────────────────── Задачи ─────────────────────────── */

  async function renderTasks(box) {
    box.innerHTML = card('Мои задачи', '<p class="muted">загрузка…</p>');
    let data;
    try { data = await api('/api/tasks'); } catch (err) { box.innerHTML = card('Мои задачи', `<p class="muted">Недоступно: ${esc(err.message)}</p>`); return; }
    const fmtDue = (t) => t.dueAt
      ? new Date(t.dueAt).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) + (t.repeat !== 'none' ? ` · ${t.repeat === 'daily' ? 'ежедневно' : t.repeat === 'weekdays' ? 'по будням' : 'еженедельно'}` : '')
      : 'без напоминания';
    const active = (data.tasks ?? []).filter((t) => !t.done);
    const done = (data.tasks ?? []).filter((t) => t.done);
    const row = (t) => `
      <li class="comp-task ${t.done ? 'done' : ''}">
        <div class="comp-task-main">
          <span class="comp-task-check">${t.done ? '☑' : '☐'}</span>
          <span class="comp-task-text">${esc(t.text)}</span>
          <span class="comp-task-when">${esc(fmtDue(t))}</span>
        </div>
        <div class="btns">
          ${t.done ? `<button data-reopen="${esc(t.id)}">Вернуть</button>` : `<button data-complete="${esc(t.id)}">Выполнено</button>`}
          <button data-del="${esc(t.id)}" class="danger">Удалить</button>
        </div>
      </li>`;
    box.innerHTML =
      card('Мои задачи и напоминания', `
        <p class="muted">Создавайте здесь или голосом/текстом в чате: «напомни завтра в 10:00 позвонить», «каждый будний день в 9:00 проверяй задачу». Напоминания срабатывают даже после перезапуска LiteMind.</p>
        <div class="btns">
          <input id="task-new" type="text" class="dir-input grow" placeholder="Что сделать…" />
          <input id="task-due" type="datetime-local" title="Когда напомнить (необязательно)" />
          <select id="task-repeat" title="Повтор">
            <option value="none">без повтора</option>
            <option value="daily">ежедневно</option>
            <option value="weekdays">по будням</option>
            <option value="weekly">еженедельно</option>
          </select>
          <button id="task-add" class="primary">Добавить</button>
        </div>
        <ul id="task-list" class="model-list">${active.map(row).join('') || '<li class="muted">Активных задач нет</li>'}</ul>
        <h3>Выполненные</h3>
        <ul class="model-list">${done.map(row).join('') || '<li class="muted">Пока ничего не завершено</li>'}</ul>
        <div class="btns"><button id="task-cleardone">Убрать выполненные</button></div>`);
    $('task-add')?.addEventListener('click', async () => {
      const text = $('task-new').value.trim();
      if (!text) return;
      const dueRaw = $('task-due').value;
      const dueAt = dueRaw ? new Date(dueRaw).toISOString() : null;
      await api('/api/tasks', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text, dueAt, repeat: $('task-repeat').value }) });
      event('компаньон: задача добавлена');
      renderTasks(box);
    });
    $('task-cleardone')?.addEventListener('click', async () => {
      await api('/api/tasks/clear-done', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      renderTasks(box);
    });
    box.querySelectorAll('[data-complete]').forEach((b) => b.addEventListener('click', async () => {
      await api(`/api/tasks/${b.dataset.complete}/complete`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      renderTasks(box);
    }));
    box.querySelectorAll('[data-reopen]').forEach((b) => b.addEventListener('click', async () => {
      await api(`/api/tasks/${b.dataset.reopen}/reopen`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      renderTasks(box);
    }));
    box.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async () => {
      await api(`/api/tasks/${b.dataset.del}`, { method: 'DELETE' });
      renderTasks(box);
    }));
  }

  /* ─────────────────────────── Голос ─────────────────────────── */

  async function renderVoice(box) {
    box.innerHTML = card('Голос', '<p class="muted">загрузка…</p>');
    let st;
    try { st = await api('/api/voice/status'); } catch (err) { box.innerHTML = card('Голос', `<p class="muted">Недоступно: ${esc(err.message)}</p>`); return; }
    const comp = (id, label) => {
      const c = (st.components ?? []).find((x) => x.id === id);
      if (!c) return '';
      const size = c.sizeBytes ? ' · ' + Math.round(c.sizeBytes / 1024 / 1024) + ' МБ' : '';
      const state = c.installed
        ? '<span class="tag ok-tag">установлен</span>'
        : '<span class="tag">' + (c.installed === null ? '—' : 'не установлен') + '</span>';
      const btn = c.installed
        ? '<button disabled>Готово</button>'
        : '<button data-install="' + esc(c.id) + '">Скачать</button>';
      return '<li><b>' + esc(label) + '</b> — ' + state + size + ' ' + btn + '</li>';
    };
    const busy = st.busy ? `<p class="muted">Идёт работа: ${esc(st.busy.component)} — ${esc(st.busy.phase)}${st.busy.receivedBytes ? ` (${Math.round(st.busy.receivedBytes / 1024 / 1024)} МБ)` : ''}</p>` : '';
    box.innerHTML =
      card('Голос компаньона', `
        <p class="muted">Локальные бесплатные движки: распознавание — whisper.cpp (работает на CPU без AVX), озвучивание — piper с русским голосом. Файлы скачиваются с проверкой SHA-256 и устанавливаются только по вашей кнопке; в фоне ничего не слушается.</p>
        ${busy}
        <ul class="comp-voice-list">
          ${comp('piper-windows', 'Piper TTS (синтез речи)')}
          ${comp('voice-ru-irina', 'Русский голос Irina')}
          ${comp('voice-ru-irina-config', 'Конфигурация голоса')}
          ${comp('whisper-windows', 'whisper.cpp (распознавание)')}
          ${comp('whisper-model-tiny', 'Модель whisper tiny')}
        </ul>
        <p class="muted" id="voice-note">TTS установлен: ${st.tts?.installed ? 'да' : 'нет'} · ASR установлен: ${st.asr?.installed ? 'да' : 'нет'}. Поддержка платформы: ${st.supported ? 'да' : 'нет (нужен Windows Desktop)'}.</p>
        <div class="btns">
          <button id="voice-test">Проверить озвучивание</button>
          <span class="muted" id="voice-test-note"></span>
        </div>`) +
      card('Настройки речи', `
        <label class="switch"><input type="checkbox" id="voice-enabled" ${st.settings?.enabled ? 'checked' : ''} /> Голосовые функции включены</label>
        <label class="switch"><input type="checkbox" id="voice-speak" ${st.settings?.speakReplies ? 'checked' : ''} /> Озвучивать ответы чата (после установки TTS)</label>
        <label class="switch"><input type="checkbox" id="voice-reminders" ${st.settings?.speakReminders !== false ? 'checked' : ''} /> Произносить напоминания голосом</label>
        <label class="field">Скорость речи: <span id="voice-rate-val">${st.settings?.ttsRate ?? 1}</span>
          <input id="voice-rate" type="range" min="0.5" max="1.5" step="0.05" value="${st.settings?.ttsRate ?? 1}" />
        </label>
        <p class="muted">В чате: кнопка 🎙 или Ctrl+Пробел — удерживайте и говорите, отпустите — речь распознается в поле ввода (Push-to-Talk, микрофон включается только на время записи).</p>`);
    box.querySelectorAll('[data-install]').forEach((b) => b.addEventListener('click', async () => {
      b.disabled = true;
      $('voice-note').textContent = 'Устанавливаю ' + b.dataset.install + '… (зависит от скорости сети)';
      try {
        await api('/api/voice/install', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ component: b.dataset.install }) });
        event('голос: компонент установлен — ' + b.dataset.install);
      } catch (err) {
        $('voice-note').textContent = 'Ошибка установки: ' + err.message;
      }
      renderVoice(box);
    }));
    $('voice-test')?.addEventListener('click', async () => {
      $('voice-test-note').textContent = 'синтезирую…';
      try {
        const r = await api('/api/voice/tts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'Привет! Я голосовой помощник LiteMind, работаю локально на вашем компьютере.' }) });
        if (r.ok) {
          const audio = new Audio(`${ENGINE_BASE}/api/voice/wav?name=${encodeURIComponent(r.wav)}`);
          audio.play().catch(() => {});
          $('voice-test-note').textContent = `готово за ${Math.round(r.ms / 100) / 10} с`;
        } else {
          $('voice-test-note').textContent = 'ошибка: ' + (r.error?.message ?? 'неизвестно');
        }
      } catch (err) {
        $('voice-test-note').textContent = 'ошибка: ' + err.message;
      }
    });
    const save = () => {
      api('/api/voice/settings', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          enabled: $('voice-enabled').checked,
          speakReplies: $('voice-speak').checked,
          speakReminders: $('voice-reminders').checked,
          ttsRate: Number($('voice-rate').value)
        })
      }).catch(() => {});
    };
    ['voice-enabled', 'voice-speak', 'voice-reminders'].forEach((id) => $(id)?.addEventListener('change', save));
    $('voice-rate')?.addEventListener('input', () => { $('voice-rate-val').textContent = $('voice-rate').value; });
    $('voice-rate')?.addEventListener('change', save);
  }

  /* ─────────────────────────── Внешность ─────────────────────────── */

  async function renderAppearance(box) {
    box.innerHTML = card('Внешность', '<p class="muted">загрузка…</p>');
    let st;
    try { st = await api('/api/companion/status'); } catch (err) { box.innerHTML = card('Внешность', `<p class="muted">Недоступно: ${esc(err.message)}</p>`); return; }
    const s = st.settings ?? {};
    box.innerHTML =
      card('Персонаж на рабочем столе', `
        <p class="muted">Живой персонаж LiteMind живёт поверх окон (в LiteMind Desktop), его можно перетаскивать мышью. Анимации меняются, когда компаньон слушает, думает, говорит или выполняет задачу. Собственные персонажи LiteMind:</p>
        <label class="switch"><input type="checkbox" id="char-enabled" ${s.enabled ? 'checked' : ''} /> Персонаж включён (выключите — останется обычный интерфейс LiteMind)</label>
        <div class="comp-chars">
          <label><input type="radio" name="comp-char" value="lumi" ${s.character === 'lumi' ? 'checked' : ''} /> <span class="comp-char-preview cp-lumi">◉</span> Люми — спокойный огонёк</label>
          <label><input type="radio" name="comp-char" value="spark" ${s.character === 'spark' ? 'checked' : ''} /> <span class="comp-char-preview cp-spark">✦</span> Искра — живая и быстрая</label>
          <label><input type="radio" name="comp-char" value="orb" ${s.character === 'orb' ? 'checked' : ''} /> <span class="comp-char-preview cp-orb">◍</span> Орб — мягкая сфера</label>
        </div>
        <label class="field">Размер: <span id="char-size-val">${s.size ?? 140}</span> px
          <input id="char-size" type="range" min="80" max="280" step="10" value="${s.size ?? 140}" />
        </label>
        <label class="field">Прозрачность: <span id="char-opacity-val">${Math.round((s.opacity ?? 0.95) * 100)}%</span>
          <input id="char-opacity" type="range" min="40" max="100" step="5" value="${Math.round((s.opacity ?? 0.95) * 100)}" />
        </label>
        <label class="switch"><input type="checkbox" id="char-ontop" ${s.alwaysOnTop !== false ? 'checked' : ''} /> Поверх всех окон</label>
        <label class="switch"><input type="checkbox" id="char-autoshow" ${s.autoShowOnStart !== false ? 'checked' : ''} /> Показывать при запуске</label>
        <div class="btns">
          ${bridge() ? '<button id="char-show">Показать персонажа</button><button id="char-hide">Скрыть персонажа</button>' : '<span class="muted">Оверлей доступен в LiteMind Desktop — здесь сохраняются настройки.</span>'}
        </div>
        <p class="muted small">Горячие клавиши Desktop: Ctrl+Alt+L — показать/скрыть персонажа, Ctrl+Alt+V — голосовой разговор, Ctrl+Alt+P — панель компаньона. Их можно изменить в настройках Desktop.</p>`);
    const save = async (extra = {}) => {
      const payload = {
        enabled: $('char-enabled').checked,
        character: document.querySelector('input[name="comp-char"]:checked')?.value ?? 'lumi',
        size: Number($('char-size').value),
        opacity: Number($('char-opacity').value) / 100,
        alwaysOnTop: $('char-ontop').checked,
        autoShowOnStart: $('char-autoshow').checked,
        ...extra
      };
      await api('/api/companion/settings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
      bridge()?.companionApply?.(payload);
      event('компаньон: настройки внешности сохранены');
    };
    ['char-enabled', 'char-ontop', 'char-autoshow'].forEach((id) => $(id)?.addEventListener('change', () => void save()));
    document.querySelectorAll('input[name="comp-char"]').forEach((r) => r.addEventListener('change', () => void save()));
    $('char-size')?.addEventListener('input', () => { $('char-size-val').textContent = $('char-size').value; });
    $('char-size')?.addEventListener('change', () => void save());
    $('char-opacity')?.addEventListener('input', () => { $('char-opacity-val').textContent = $('char-opacity').value + '%'; });
    $('char-opacity')?.addEventListener('change', () => void save());
    $('char-show')?.addEventListener('click', () => bridge()?.companionShow?.(true));
    $('char-hide')?.addEventListener('click', () => bridge()?.companionShow?.(false));
  }

  /* ─────────────────────────── Windows ─────────────────────────── */

  async function renderWindows(box) {
    box.innerHTML = card('Управление Windows', '<p class="muted">загрузка…</p>');
    let host = { connected: false, features: [] };
    try { host = await api('/api/host/status'); } catch { /* */ }
    box.innerHTML =
      card('Открыть приложение / сайт / папку', `
        <p class="muted">Компаньон умеет открывать приложения, папки и сайты. Опасные действия (удаление файлов, изменение системных настроек, нажатия в чужих окнах) — только с подтверждением и при включённых разрешениях.</p>
        <div class="btns">
          <input id="win-target" type="text" class="dir-input grow" placeholder="Куда: mspaint, C:\\Папка, https://example.com…" />
          <button id="win-open" class="primary">Открыть</button>
        </div>
        <p class="muted" id="win-note">${host.connected ? 'Мост Desktop подключён (' + esc(host.features.join(', ')) + ')' : 'Управление работает в LiteMind Desktop (движок в браузере не имеет доступа к Windows).'}</p>`) +
      card('Помощь в программах («Посмотри на экран»)', `
        <p class="muted">В чате спросите: «что открыто на экране?», «где кнопка Сохранить?» — компаньон прочитает текст с активного окна локальным OCR Windows (без отправки скриншотов в интернет) и объяснит, куда нажать, шаг за шагом.</p>
        <p class="muted">Пошаговые подсказки с подсветкой кнопок и статус «жду вашего действия» выполняет агент в LiteMind Desktop; в браузерной версии эта функция честно сообщит о недоступности.</p>`);
    $('win-open')?.addEventListener('click', async () => {
      const target = $('win-target').value.trim();
      if (!target) return;
      const kind = /^https?:\/\//i.test(target) ? 'url' : /^[a-z]:[\\/]/i.test(target) ? 'path' : 'app';
      try {
        const r = await api('/api/windows/open', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ target, kind }) });
        $('win-note').textContent = r.ok ? 'Открыто.' : 'Не удалось: ' + (r.error ?? 'неизвестно');
      } catch (err) {
        $('win-note').textContent = 'Ошибка: ' + err.message;
      }
    });
  }

  /* ─────────────────────────── Разрешения ─────────────────────────── */

  async function renderPermissions(box) {
    box.innerHTML = card('Разрешения', '<p class="muted">загрузка…</p>');
    let cfg;
    try { cfg = await api('/api/intelligence'); } catch (err) { box.innerHTML = card('Разрешения', `<p class="muted">Недоступно: ${esc(err.message)}</p>`); return; }
    const p = cfg.permissions ?? {};
    box.innerHTML =
      card('Разрешения компаньона', `
        <p class="muted">Вы сами решаете, что разрешено помощнику. Всё работает локально; скриншоты и данные памяти никуда не отправляются.</p>
        <label class="switch"><input type="checkbox" id="perm-screen" ${p.screenLook ? 'checked' : ''} /> «Посмотри на экран» — чтение текста с экрана (локальный OCR Windows)</label>
        <label class="switch"><input type="checkbox" id="perm-open" ${p.openApps ? 'checked' : ''} /> Открывать приложения, папки и сайты</label>
        <label class="switch"><input type="checkbox" id="perm-windows" ${p.windowsControl ? 'checked' : ''} /> Управление окнами (нажатия и ввод — каждое действие с подтверждением)</label>
        <label class="switch"><input type="checkbox" id="perm-automem" ${cfg.autoMemory ? 'checked' : ''} /> Автоматически запоминать факты из моих сообщений (имя, проект, предпочтения)</label>
        <p class="muted" id="perm-note">Режим интеллекта: ${esc(cfg.mode ?? 'smart')} (${esc(cfg.modes?.[cfg.mode] ?? '')}).</p>`);
    const save = () => {
      api('/api/intelligence', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          permissions: {
            screenLook: $('perm-screen').checked,
            openApps: $('perm-open').checked,
            windowsControl: $('perm-windows').checked
          },
          autoMemory: $('perm-automem').checked
        })
      }).then(() => event('разрешения компаньона обновлены')).catch(() => {});
    };
    ['perm-screen', 'perm-open', 'perm-windows', 'perm-automem'].forEach((id) => $(id)?.addEventListener('change', save));
  }

  /* ─────────────────────────── История ─────────────────────────── */

  async function renderHistory(box) {
    box.innerHTML = card('История действий', '<p class="muted">загрузка…</p>');
    let data;
    try { data = await api('/api/companion/events?limit=100'); } catch (err) { box.innerHTML = card('История действий', `<p class="muted">Недоступно: ${esc(err.message)}</p>`); return; }
    const items = (data.events ?? []).map((e) => `<li><b>${esc(String(e.at).slice(11, 19))}</b> <span class="tag">${esc(e.type)}</span> ${esc(e.text)}</li>`).join('');
    box.innerHTML = card('Что делал компаньон', `<ul class="events">${items || '<li class="muted">Пока пусто</li>'}</ul>
      <p class="muted">Журнал хранится в памяти сессии и обновляется в реальном времени, пока этот раздел открыт.</p>`);
    subscribeEvents(() => { if (activeTab === 'history') void renderHistory($('comp-content')); });
  }

  /* ─────────────────────────── SSE и уведомления ─────────────────────────── */

  function stopEvents() { if (es) { try { es.close(); } catch { /* */ } es = null; } }
  function subscribeEvents(onEvent) {
    stopEvents();
    try {
      es = new EventSource(`${ENGINE_BASE}/api/companion/events/stream`);
      es.onmessage = (ev) => {
        let m;
        try { m = JSON.parse(ev.data); } catch { return; }
        if (m.type === 'event' && m.event?.type === 'reminder') {
          showReminderNotification(m.event.text);
        }
        onEvent?.(m);
      };
    } catch { /* SSE недоступен */ }
  }

  const seenReminders = new Set();
  function showReminderNotification(text) {
    try {
      if (window.Notification && Notification.permission === 'granted') {
        new Notification('Напоминание LiteMind', { body: text });
      } else if (window.Notification && Notification.permission !== 'denied') {
        Notification.requestPermission().then((p) => { if (p === 'granted') new Notification('Напоминание LiteMind', { body: text }); });
      }
    } catch { /* */ }
    if (typeof window.__litemindShowError === 'function') window.__litemindShowError('⏰ ' + text);
    event('напоминание сработало: ' + text);
    // Озвучивание, если включено и установлен TTS.
    api('/api/voice/status').then(async (st) => {
      if (st?.tts?.installed && st?.settings?.speakReminders !== false && st?.settings?.enabled !== false) {
        try {
          const r = await api('/api/voice/tts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'Напоминание: ' + text }) });
          if (r.ok) new Audio(`${ENGINE_BASE}/api/voice/wav?name=${encodeURIComponent(r.wav)}`).play().catch(() => {});
        } catch { /* */ }
      }
    }).catch(() => {});
  }

  /* Опрос задач: уведомление о сработавших напоминаниях даже без SSE (браузер). */
  setInterval(async () => {
    try {
      const data = await api('/api/tasks');
      const now = Date.now();
      for (const t of (data.tasks ?? [])) {
        if (!t.done && t.notifiedAt && now - Date.parse(t.notifiedAt) < 120_000 && !seenReminders.has(t.id + t.notifiedAt)) {
          seenReminders.add(t.id + t.notifiedAt);
          showReminderNotification(t.text);
        }
      }
    } catch { /* движок недоступен */ }
  }, 30_000);

  /* ─────────────────────────── запуск ─────────────────────────── */

  window.__litemindLoadCompanion = () => {
    render();
    if (activeTab === 'main' || activeTab === 'history') subscribeEvents();
  };
})();
