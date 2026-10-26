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
