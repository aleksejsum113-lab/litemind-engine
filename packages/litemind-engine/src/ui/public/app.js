// LiteMind dashboard — plain JS, no framework, ~1 poll/2s. Total footprint: this tab only.
const $ = (id) => document.getElementById(id);

const state = { streaming: false, polling: true };

function showError(msg) {
  const el = $('error');
  if (!msg) { el.hidden = true; el.textContent = ''; return; }
  el.hidden = false;
  el.textContent = msg;
}

function event(msg) {
  const ul = $('events');
  const li = document.createElement('li');
  li.innerHTML = `<b>${new Date().toLocaleTimeString()}</b> ${msg}`;
  ul.prepend(li);
  while (ul.children.length > 40) ul.removeChild(ul.lastChild);
}

function bar(id, pct, text) {
  const el = $(id + '-bar');
  const v = Math.max(0, Math.min(100, pct || 0));
  el.style.width = v + '%';
  el.className = v > 85 ? 'bad' : v > 65 ? 'warn' : '';
  $(id).textContent = text;
}

async function api(path, opts) {
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message || data?.message || `HTTP ${res.status}`);
  return data;
}

function fillModels(models, current) {
  const sel = $('model');
  const wanted = current || sel.value;
  const ids = models.map((m) => m.id);
  if (sel.dataset.ids !== ids.join('|')) {
    sel.innerHTML = '';
    for (const m of models) {
      const o = document.createElement('option');
      o.value = m.id;
      const mb = m.sizeBytes ? ` (${Math.round(m.sizeBytes / 1048576)} MB)` : '';
      o.textContent = m.id + mb;
      sel.appendChild(o);
    }
    sel.dataset.ids = ids.join('|');
  }
  if (wanted && ids.includes(wanted)) sel.value = wanted;
  if (!ids.length) {
    const o = document.createElement('option');
    o.value = '';
    o.textContent = 'модели не установлены (ollama pull <имя>)';
    sel.appendChild(o);
  }
}

async function refresh() {
  try {
    const s = await api('/api/status');
    const healthy = s.backend.health.ok;
    const badge = $('backend-badge');
    badge.textContent = healthy ? 'backend: online' : 'backend: offline';
    badge.className = 'badge ' + (healthy ? 'ok' : 'bad');

    $('backend-type').textContent = s.backend.type;
    $('backend-state').textContent = healthy ? 'готов' : (s.backend.health.error || 'не обнаружен');
    $('backend-state').style.color = healthy ? 'var(--ok)' : 'var(--bad)';
    $('backend-version').textContent = s.backend.health.version || '—';
    $('queue').textContent = `${s.queue.active} активных / ${s.queue.waiting} в очереди (лимит ${s.queue.limit})`;
    $('profile').textContent = s.engine.profileLabel;
    $('saver').checked = s.engine.profile === 'low';

    const m = s.metrics;
    if (m) {
      const ramPct = m.totalRamMb ? (m.usedRamMb / m.totalRamMb) * 100 : 0;
      bar('cpu', m.cpuPercent, `${Math.round(m.cpuPercent)} %`);
      bar('ram', ramPct, `${Math.round(m.usedRamMb)} / ${Math.round(m.totalRamMb)} MB`);
      if (m.vramTotalMb) {
        bar('vram', 0, `≈ ${Math.round(m.vramTotalMb)} MB всего`);
        $('vram').textContent = `≈ ${Math.round(m.vramTotalMb)} MB (всего)`;
      } else {
        $('vram').textContent = 'недоступно';
        $('vram-bar').style.width = '0';
      }
      $('gpu-name').textContent = (m.gpuNames && m.gpuNames.length) ? m.gpuNames.join(', ') : 'видеокарта не определена';
    }
    fillModels(s.models || []);
    $('ctx').value = String(s.limits.contextTokens);
    if (!$('maxtok').dataset.touched) $('maxtok').value = String(s.limits.maxOutputTokens);
    if (s.modelsError && !state.streaming) showError(s.modelsError);
    state.polling = true;
  } catch (err) {
    const badge = $('backend-badge');
    badge.textContent = 'server: offline';
    badge.className = 'badge bad';
  }
}

async function run() {
  const model = $('model').value;
  const prompt = $('prompt').value.trim();
  if (!model) { showError('Выберите установленную модель.'); return; }
  if (!prompt) { showError('Введите текст запроса.'); return; }
  showError(null);
  $('output').textContent = '';
  $('timings').textContent = '';
  state.streaming = true;
  $('btn-send').disabled = true;
  $('btn-run').disabled = true;
  $('run-state').textContent = 'генерация…';
  const t0 = performance.now();
  let ttft = null;
  try {
    const res = await fetch('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        stream: true,
        context_tokens: Number($('ctx').value),
        max_tokens: Number($('maxtok').value),
        messages: [{ role: 'user', content: prompt }]
      })
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
            $('output').textContent += delta;
            $('output').scrollTop = $('output').scrollHeight;
          }
        }
      }
    }
    const total = Math.round(performance.now() - t0);
    $('timings').textContent = `время до первого токена: ${ttft ?? '—'} мс · общее время: ${total} мс`;
    event(`запрос завершён (${total} мс)`);
  } catch (err) {
    if (String(err.message).includes('cancel')) event('запрос остановлен');
    else showError(err.message);
  } finally {
    state.streaming = false;
    $('btn-send').disabled = false;
    $('btn-run').disabled = false;
    $('run-state').textContent = '';
    refresh();
  }
}

async function stop() {
  try {
    const r = await api('/api/stop', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    event(`остановлено запросов: ${r.cancelled}`);
    $('run-state').textContent = 'остановлено';
  } catch (err) { showError(err.message); }
}

async function unload() {
  try {
    const r = await api('/api/unload', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: $('model').value || null })
    });
    event(`выгружено: ${r.unloaded.join(', ') || 'нет загруженных моделей'}`);
    showError(null);
  } catch (err) { showError(err.message); }
  refresh();
}

$('saver').addEventListener('change', async (e) => {
  try {
    await api('/api/profile', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ profile: e.target.checked ? 'low' : 'balanced' })
    });
    event(e.target.checked ? 'включён режим экономии ресурсов' : 'выключен режим экономии ресурсов');
  } catch (err) { showError(err.message); }
  refresh();
});

$('maxtok').addEventListener('input', () => { $('maxtok').dataset.touched = '1'; });
$('btn-send').addEventListener('click', run);
$('btn-run').addEventListener('click', run);
$('btn-stop').addEventListener('click', stop);
$('btn-unload').addEventListener('click', unload);

refresh();
setInterval(refresh, 2000);

/* ======================================================================
   v0.2 — вкладки, каталог, загрузки, установка, железо, настройки
   ====================================================================== */

// ---- Табы + deep-link (#catalog, #models, #hardware, #settings, #monitor) ----
const TAB_ALIASES = { monitor: 'status' };

function switchTab(name) {
  name = TAB_ALIASES[name] || name;
  const tab = document.querySelector(`.tab[data-tab="${name}"]`);
  if (!tab) return false;
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === tab));
  document.querySelectorAll('[data-page]').forEach((p) => {
    p.hidden = p.id !== `tab-${name}`;
    p.classList.toggle('active', p.id === `tab-${name}`);
  });
  if (name === 'catalog') loadCatalog();
  if (name === 'downloads') refreshDownloads();
  if (name === 'hardware') loadHardware();
  if (name === 'settings') loadSettings();
  if (name === 'models') loadMyModels();
  return true;
}

document.querySelectorAll('.tab').forEach((t) =>
  t.addEventListener('click', () => {
    location.hash = t.dataset.tab;
  })
);
window.addEventListener('hashchange', () => switchTab(location.hash.slice(1)));
switchTab(location.hash.slice(1) || 'status');

// ---- Каталог ----
const CAT = { data: null };
const fmtSize = (b) => (b ? (b / 1024 ** 3).toFixed(2) + ' ГБ' : '—');
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

async function loadCatalog() {
  if (!CAT.data) {
    try { CAT.data = await api('/api/catalog'); } catch (err) { event('каталог: ' + err.message); return; }
  }
  const c = CAT.data;
  $('hw-hint').textContent =
    `CPU: ${c.hardware.cpu.model || '—'} · AVX/AVX2: ${c.hardware.cpu.avx === null ? 'неизвестно' : `${c.hardware.cpu.avx}/${c.hardware.cpu.avx2}`} · ` +
    `RAM: ${(c.hardware.totalRamMb / 1024).toFixed(1)} ГБ (свободно ${(c.hardware.freeRamMb / 1024).toFixed(1)}) · ` +
    `рекомендация движка: профиль «${c.hardware.recommendation.profile === 'low' ? 'Умеренный' : 'Сбалансированный'}», ` +
    `контекст ≤ ${c.hardware.recommendation.maxContextTokens} ток., резерва Windows ${c.hardware.recommendation.windowsReserveMb} МБ`;

  // Выбор диска/папки
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

  const show = {
    'uncensored-coding': $('f-uncensored').checked,
    'small-coding': $('f-small').checked,
    'advanced-coding': $('f-advanced').checked
  };
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
        ${m.compatibility.speedNote ? esc(m.compatibility.speedNote) : ''}</div>
    </div>
    <div class="model-item-actions">
      <select class="quant-select" aria-label="Квантование">
        ${m.files.map((f) => `<option value="${esc(f.name)}" ${rec && f.name === rec.name ? 'selected' : ''}>
          ${esc(f.name.replace(/\.gguf$/i, '').split('.').pop())} · ${fmtSize(f.sizeBytes)}</option>`).join('')}
      </select>
      <button class="btn-download">${m.downloaded ? 'Перекачать' : 'Скачать и установить'}</button>
    </div>`;
  div.querySelector('.btn-download').addEventListener('click', async () => {
    const fileName = div.querySelector('.quant-select').value;
    const targetDir = $('f-dir').value.trim();
    try {
      await api('/api/downloads', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ modelId: m.id, fileName, targetDir: targetDir || undefined })
      });
      event(`загрузка начата: ${m.displayName} · ${fileName}`);
      location.hash = 'downloads';
    } catch (err) { event('ошибка загрузки: ' + err.message); }
  });
  return div;
}

['f-uncensored', 'f-small', 'f-advanced'].forEach((id) => $(id).addEventListener('change', loadCatalog));

// ---- Загрузки ----
const AUTO_INSTALLED = new Set();

async function refreshDownloads() {
  let data;
  try { data = await api('/api/downloads'); } catch { return; }
  const ul = $('download-list');
  $('guf-dir').textContent = 'Папка: ' + (data.rootDir || '—');
  ul.innerHTML = '';
  if (!data.downloads.length) {
    ul.innerHTML = '<li class="muted">нет активных загрузок</li>';
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
      </div>`;
    const act = (action) => async () => {
      try { await api(`/api/downloads/${d.id}/${action}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }); }
      catch (err) { event('ошибка: ' + err.message); }
      refreshDownloads();
    };
    li.querySelector('.act-pause')?.addEventListener('click', act('pause'));
    li.querySelector('.act-resume')?.addEventListener('click', act('resume'));
    li.querySelector('.act-cancel')?.addEventListener('click', act('cancel'));
    ul.appendChild(li);

    // Автоустановка: как только загрузка завершена — импортируем в backend.
    if (d.state === 'done' && d.modelId && !AUTO_INSTALLED.has(d.id)) {
      AUTO_INSTALLED.add(d.id);
      api('/api/install', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ modelId: d.modelId, fileName: d.name, targetDir: d.targetDir })
      })
        .then((r) => event(`установлено в backend: ${r.model}`))
        .catch((err) => event(`автоустановка (${d.name}): ${err.message} — установите вручную на вкладке «Мои модели»`));
    }
  }
}

// ---- Мои модели ----
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
          <div class="model-item-sub">${fmtSize(m.sizeBytes)} · ${esc(m.detail || '')}</div></div>`;
        ul.appendChild(li);
      }
    }
  } catch (err) { /* backend offline — покажем в статусе */ }
  // GGUF-файлы в папке моделей
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
  } catch { /* игнорируем */ }
}

$('btn-install-gguf').addEventListener('click', async () => {
  const sel = document.querySelector('input[name="gguf"]:checked');
  if (!sel) { event('выберите GGUF-файл'); return; }
  $('install-note').textContent = 'установка… (загрузка blob в backend, может занять несколько минут)';
  try {
    const r = await api('/api/install', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ggufPath: sel.value })
    });
    $('install-note').textContent = '';
    event(`установлено: ${r.model}`);
    loadMyModels();
  } catch (err) {
    $('install-note').textContent = '';
    event('ошибка установки: ' + err.message);
  }
});

// ---- Железо ----
async function loadHardware() {
  try {
    const hw = await api('/api/hardware');
    const avx = (v) => v === null ? 'неизвестно' : (v ? 'есть' : 'нет');
    const rows = [
      ['CPU', `${hw.cpu.model || '—'} · ядер: ${hw.cpu.cores}`],
      ['AVX / AVX2', `${avx(hw.cpu.avx)} / ${avx(hw.cpu.avx2)} (${esc(hw.cpu.avxMethod)})`],
      ['RAM всего', `${(hw.totalRamMb / 1024).toFixed(1)} ГБ`],
      ['RAM свободно', `${(hw.freeRamMb / 1024).toFixed(1)} ГБ`],
      ['Рекомендуемый профиль', hw.recommendation.profile === 'low' ? 'Умеренный' : 'Сбалансированный'],
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

// ---- Настройки ----
async function loadSettings() {
  try {
    const s = await api('/api/settings');
    $('set-rootdir').value = s.modelsRootDir || '';
    if (s.profile) $('set-profile').value = s.profile;
  } catch { /* — */ }
}

$('btn-save-settings').addEventListener('click', async () => {
  const rootDir = $('set-rootdir').value.trim();
  const profile = $('set-profile').value;
  try {
    await api('/api/settings', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ modelsRootDir: rootDir || undefined, profile })
    });
    $('settings-note').textContent = 'сохранено';
    CAT.data = null;
    event(`настройки сохранены (профиль: ${profile})`);
    refresh();
  } catch (err) {
    $('settings-note').textContent = '';
    event('настройки: ' + err.message);
  }
});

// Периодическое обновление активных вкладок
setInterval(() => {
  const active = document.querySelector('.tab.active')?.dataset.tab;
  if (active === 'downloads') refreshDownloads();
}, 1500);
