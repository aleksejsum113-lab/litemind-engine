// Model Discovery — источники моделей (ТЗ v0.6.2 §2/§10).
//
// Первичный источник — открытый Hugging Face Hub API: бесплатный, без
// регистрации и ключей, отдаёт метаданные GGUF-репозиториев (для LFS-файлов —
// эталонный SHA-256, используемый загрузчиком для проверки после скачивания).
//
// Архитектура допускает добавление новых источников: каждый источник —
// асинхронная функция, возвращающая массив репозиториев / файлов. GitHub
// Releases описан как источник «на будущее» и по умолчанию выключен
// (config.discovery.sources.github.enabled), чтобы не создавать нагрузку
// без нужды и не зависеть от жёстких лимитов api.github.com.

export const HF_BASE = 'https://huggingface.co';

// АвторGGUF-квантов с активными публикациями (ТЗ §3: Qwen, DeepSeek, Llama,
// Gemma, Mistral, Dolphin, Huihui и новые семейства — их публикуют эти авторы).
export const DEFAULT_GGUF_AUTHORS = [
  'bartowski',
  'mradermacher',
  'QuantFactory',
  'unsloth',
  'lmstudio-community',
  'Huihui-ai',
  'cognitivecomputations'
];

/** fetch с таймаутом (сеть «зависла» → ошибка, а не вечное ожидание). */
async function timedFetch(fetchImpl, url, { timeoutMs = 15000, headers = {} } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error(`таймаут ${Math.round(timeoutMs / 1000)} с`)), timeoutMs);
  try {
    return await fetchImpl(url, { signal: ctrl.signal, headers: { 'user-agent': 'LiteMind-Engine/0.6 (model discovery)' }, ...{ headers } });
  } finally {
    clearTimeout(timer);
  }
}

function toNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Поиск GGUF-репозиториев на Hugging Face.
 * 3 группы запросов: свежие обновления, новые публикации, последние модели
 * известных авторов квантов. Объединение без дубликатов.
 * @returns {Array<{repo:string, author:string, lastModified:string|null, createdAt:string|null, tags:string[], downloads:number, likes:number, license:string|null}>}
 */
export async function searchHuggingFaceGguf({
  fetchImpl = fetch,
  authors = DEFAULT_GGUF_AUTHORS,
  perPage = 60,
  timeoutMs = 15000,
  logger = null
} = {}) {
  const urls = [
    `${HF_BASE}/api/models?filter=gguf&sort=lastModified&direction=-1&limit=${perPage}&full=false`,
    `${HF_BASE}/api/models?filter=gguf&sort=createdAt&direction=-1&limit=${perPage}&full=false`
  ];
  for (const a of authors) {
    urls.push(`${HF_BASE}/api/models?author=${encodeURIComponent(a)}&filter=gguf&sort=lastModified&direction=-1&limit=30&full=false`);
  }

  const byRepo = new Map();
  for (const url of urls) {
    let list = null;
    try {
      const res = await timedFetch(fetchImpl, url, { timeoutMs });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      list = await res.json();
    } catch (err) {
      // Один неудачный запрос не отменяет проверку: пропускаем и продолжаем.
      logger?.warn?.('discovery: источник не ответил', { url: url.replace(HF_BASE, 'HF'), error: err.message });
      continue;
    }
    if (!Array.isArray(list)) continue;
    for (const m of list) {
      const repo = String(m?.id || m?.modelId || '').trim();
      if (!repo || !repo.includes('/')) continue;
      // Формат GGUF — обязательный признак (тег или суффикс репозитория).
      const tags = Array.isArray(m?.tags) ? m.tags.map(String) : [];
      const looksGguf = tags.includes('gguf') || /[-_]gguf$/i.test(repo);
      if (!looksGguf) continue;
      if (byRepo.has(repo)) continue;
      const licenseTag = tags.find((t) => t.startsWith('license:'));
      byRepo.set(repo, {
        repo,
        author: repo.split('/')[0],
        lastModified: m.lastModified ?? null,
        createdAt: m.createdAt ?? null,
        tags,
        downloads: toNumber(m.downloads) ?? 0,
        likes: toNumber(m.likes) ?? 0,
        license: licenseTag ? licenseTag.slice('license:'.length) : null,
        pipelineTag: m.pipeline_tag ?? null
      });
    }
  }
  return [...byRepo.values()];
}

/**
 * Список GGUF-файлов репозитория (ветка main) с размерами и SHA-256 LFS.
 * @returns {Array<{name:string, sizeBytes:number, sha256:string|null, url:string}>}
 */
export async function listRepoGgufFiles({ repo, fetchImpl = fetch, timeoutMs = 15000 } = {}) {
  // ВАЖНО: слэш в «author/name» НЕ кодируем — HF API отвечает 400 на
  // «author%2Fname» в пути (проверено на живом API 2026-11-11); кодируем
  // только каждый сегмент отдельно (спецсимволы в именах авторов/репо).
  const repoPath = String(repo || '').split('/').map(encodeURIComponent).join('/');
  const url = `${HF_BASE}/api/models/${repoPath}/tree/main`;
  const res = await timedFetch(fetchImpl, url, { timeoutMs });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const tree = await res.json();
  if (!Array.isArray(tree)) return [];
  const out = [];
  for (const item of tree) {
    if (item?.type !== 'file' || !/\.gguf$/i.test(String(item.path || ''))) continue;
    const size = toNumber(item.lfs?.size) ?? toNumber(item.size);
    if (!size || size <= 0) continue;
    out.push({
      name: item.path,
      sizeBytes: size,
      sha256: item.lfs?.oid ? String(item.lfs.oid).toLowerCase() : null,
      url: `${HF_BASE}/${repo}/resolve/main/${item.path.split('/').map(encodeURIComponent).join('/')}`
    });
  }
  return out;
}
