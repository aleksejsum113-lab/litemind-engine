// LiteMind Model Discovery UI (ТЗ v0.6.2) — раздел «Новые модели».
// Самодостаточный модуль: переиспользует api()/esc()/fmtSize() из app.js,
// живёт поверх HTTP API движка (/api/discovery/*). Не трогает Chat и Agent.

/* global api, esc, fmtSize, showError, event, ENGINE_BASE */
(() => {
  const $ = (id) => document.getElementById(id);
  const BASE = (typeof ENGINE_BASE !== 'undefined') ? ENGINE_BASE : 'http://127.0.0.1:8399';

  let currentFilter = localStorage.getItem('litemind-disco-filter') || 'all';
  let pollTimer = null;
  let loaded = false;

  // ── утилиты ──────────────────────────────────────────────────────────────

  function fmtDate(iso) {
    if (!iso) return 'неизвестно';
    const d = new Date(iso);
    if (isNaN(d)) return 'неизвестно';
    return d.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  function ago(iso) {
    if (!iso) return '';
    const ms = Date.now() - Date.parse(iso);
    if (!isFinite(ms)) return '';
    const m = Math.round(ms / 60000);
    if (m < 1) return 'только что';
    if (m < 60) return `${m} мин назад`;
    const h = Math.round(m / 60);
    if (h < 24) return `${h} ч назад`;
    const d = Math.round(h / 24);
    return `${d} дн назад`;
  }

  // ── статус (время последней проверки, ошибки) ─────────────────────────────

  async function renderStatus() {
    try {
      const st = await api('/api/discovery/status');
      const when = st.lastCheckAt
        ? `${fmtDate(st.lastCheckAt)} (${ago(st.lastCheckAt)})`
        : 'ещё не выполнялась';
      const auto = st.enabled ? `автопроверка вкл (раз в ${st.intervalHours} ч)` : 'автопроверка выключена';
      $('disco-status').textContent = st.checking
        ? 'Проверяю источники…'
        : `Последняя проверка: ${when} · ${auto}`;
      const err = $('disco-error');
      if (st.lastError) {
        err.hidden = false;
        err.textContent = '⚠ ' + st.lastError + ' Ранее найденные модели сохранены.';
      } else {
        err.hidden = true;
      }
      // бейдж в боковой панели: количество новинок
      const badge = $('disco-badge');
      if (badge) {
        badge.hidden = !st.counts?.new;
        badge.textContent = st.counts?.new ? String(st.counts.new) : '';
      }
      $('btn-disco-refresh').disabled = !!st.checking;
      $('btn-disco-refresh').textContent = st.checking ? 'Проверяю…' : 'Проверить новые модели';
      return st;
    } catch { /* движок недоступен — ничего не ломаем */ }
    return null;
  }

  // ── рендер списка ────────────────────────────────────────────────────────

  const LEVEL_CLASS = { ok: 'disco-ok', limited: 'disco-limited', not_recommended: 'disco-warn', incompatible: 'disco-bad' };

  function modelBadges(m) {
    const b = [];
    if (m.state === 'new') b.push('<span class="disco-tag disco-new">НОВИНКА</span>');
    if (m.state === 'updated' || m.updateAvailable) b.push('<span class="disco-tag disco-upd">ОБНОВЛЕНИЕ</span>');
    if (m.installed) b.push('<span class="disco-tag disco-inst">УСТАНОВЛЕНА</span>');
    if (m.flavor) b.push(`<span class="disco-tag">${esc(m.flavor)}</span>`);
    return b.join(' ');
  }

  function modelCard(m) {
    const card = document.createElement('div');
    card.className = 'disco-card';
    const rating = m.rating ?? {};
    const ramGb = rating.estimatedMb ? (rating.estimatedMb / 1024).toFixed(1) : null;
    const reason = rating.levelReasons?.length ? esc(rating.levelReasons[0]) : '';
    card.innerHTML = `
      <div class="disco-head">
        <div class="disco-title">
          <b>${esc(m.name.replace(/\.gguf$/i, ''))}</b>
          ${modelBadges(m)}
        </div>
        <span class="disco-level ${LEVEL_CLASS[rating.level] ?? ''}">${esc(rating.levelLabel ?? '—')}</span>
      </div>
      <div class="disco-meta">
        <span>${m.family ? 'семейство: ' + esc(m.family) : 'семейство: не распознано'}</span>
        ${m.params ? `<span>параметры: ${esc(m.params)}</span>` : ''}
        ${m.quant ? `<span>квантование: ${esc(m.quant)}</span>` : ''}
        <span>размер: ${fmtSize(m.sizeBytes)}</span>
        ${ramGb ? `<span>в памяти: ~${ramGb} ГБ</span>` : ''}
        ${m.license ? `<span>лицензия: ${esc(m.license)}</span>` : '<span>лицензия: не указана</span>'}
        <span>обновлён: ${fmtDate(m.updatedAt)}</span>
      </div>
      <p class="disco-desc">${esc(m.description ?? '')}</p>
      ${m.updateAvailable ? `<p class="disco-note">В источнике файл изменился (скачан: ${fmtSize(m.installedSizeBytes)}, в источнике: ${fmtSize(m.sizeBytes)}). Старая версия сохраняется — решение об обновлении за вами.</p>` : ''}
      <details class="disco-more">
        <summary>Подробнее: совместимость, источник, загрузка</summary>
        <ul class="disco-reasons">${(rating.levelReasons ?? []).map((r) => `<li>${esc(r)}</li>`).join('')}</ul>
        ${rating.speedNote ? `<p class="muted">${esc(rating.speedNote)}</p>` : ''}
        <p class="muted">SHA-256: ${m.sha256 ? esc(m.sha256.slice(0, 24)) + '…' : 'источник не опубликовал — проверим по размеру'}</p>
        <p class="muted">Источник: <a href="${esc(m.repoUrl ?? sourceUrlOf(m))}" target="_blank" rel="noopener noreferrer">${esc(m.repo)}</a> · автор: ${esc(m.author ?? 'неизвестно')}</p>
        <div class="btns">
          <button class="primary" data-dl="${esc(m.key)}" ${rating.level === 'incompatible' ? 'disabled title="Несовместима с этим ПК — см. причины выше"' : ''}>Скачать и установить</button>
          <span class="muted">Файл попадёт в папку моделей (см. Настройки). Загрузка с паузой/докачкой, проверка SHA-256 после скачивания.</span>
        </div>
      </details>`;
    const dlBtn = card.querySelector('[data-dl]');
    dlBtn?.addEventListener('click', () => downloadModel(m, dlBtn));
    return card;
  }

  function sourceUrlOf(m) {
    return `https://huggingface.co/${m.repo}`;
  }

  async function downloadModel(m, btn) {
    btn.disabled = true;
    const orig = btn.textContent;
    btn.textContent = 'Запускаю…';
    try {
      const r = await api('/api/discovery/download', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key: m.key })
      });
      if (r.alreadyDownloaded) {
        event('модель уже скачана: ' + m.name);
        btn.textContent = 'Файл уже на диске';
      } else {
        event('загрузка началась: ' + m.name);
        btn.textContent = 'Загрузка началась — вкладка «Загрузки»';
      }
      loadList();
    } catch (err) {
      btn.disabled = false;
      btn.textContent = orig;
      if (err?.message?.includes('FILE_EXISTS') || err?.message?.includes('уже есть файл')) {
        if (confirm('Файл с таким именем уже есть в папке моделей, но размер не совпадает. Заменить его новой загрузкой? Старый файл будет перезаписан.')) {
          try {
            await api('/api/discovery/download', {
              method: 'POST', headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ key: m.key, overwrite: true })
            });
            btn.textContent = 'Загрузка началась — вкладка «Загрузки»';
            loadList();
          } catch (e2) { showError('discovery: ' + e2.message); }
        }
      } else {
        showError('discovery: ' + err.message);
      }
    }
  }

  async function loadList() {
    const list = $('disco-list');
    if (!list) return;
    try {
      const r = await api(`/api/discovery/models?filter=${encodeURIComponent(currentFilter)}&limit=200`);
      $('disco-count').textContent = r.checking
        ? 'Обновляю каталог…'
        : `показано ${r.models.length} из ${r.counts?.total ?? 0} найденных · новинок: ${r.counts?.new ?? 0} · обновлений: ${r.counts?.updated ?? 0} · совместимых: ${r.counts?.compatible ?? 0}`;
      list.innerHTML = '';
      if (!r.models.length) {
        list.innerHTML = '<p class="muted">По этому фильтру ничего нет. Нажмите «Проверить новые модели» — поиск по открытым источникам занимает около минуты.</p>';
        return;
      }
      const frag = document.createDocumentFragment();
      for (const m of r.models) frag.append(modelCard(m));
      list.append(frag);
    } catch (err) {
      list.innerHTML = `<p class="muted">Раздел недоступен: ${esc(err.message)}</p>`;
    }
  }

  // ── запуск проверки вручную ──────────────────────────────────────────────

  async function manualRefresh() {
    try {
      await api('/api/discovery/refresh', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      event('запущена проверка новых моделей');
    } catch (err) { showError('discovery: ' + err.message); }
    await renderStatus();
    $('disco-count').textContent = 'Обновляю каталог… это займёт около минуты.';
    startPolling();
  }

  function startPolling() {
    stopPolling();
    pollTimer = setInterval(async () => {
      const st = await renderStatus();
      if (st && !st.checking) {
        stopPolling();
        loadList();
      }
    }, 4000);
  }

  function stopPolling() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }

  // ── фильтры ──────────────────────────────────────────────────────────────

  function bindFilters() {
    $('disco-filters')?.querySelectorAll('button[data-filter]').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.filter === currentFilter);
      btn.addEventListener('click', () => {
        currentFilter = btn.dataset.filter;
        localStorage.setItem('litemind-disco-filter', currentFilter);
        $('disco-filters').querySelectorAll('button').forEach((b) => b.classList.toggle('active', b === btn));
        loadList();
      });
    });
  }

  // ── точка входа (вызывается из app.js при переключении вкладки) ──────────

  async function loadDiscovery() {
    if (!$('tab-discovery')) return;
    if (!loaded) {
      loaded = true;
      bindFilters();
      $('btn-disco-refresh').addEventListener('click', manualRefresh);
    }
    await renderStatus();
    loadList();
    const st = await api('/api/discovery/status').catch(() => null);
    if (st?.checking) startPolling();
  }

  window.__litemindLoadDiscovery = loadDiscovery;
})();
