// LiteMind Engine — веб-поиск без платных ключей (ТЗ v0.6.4 §5.2).
//
// Источник по умолчанию — открытый HTML-поиск DuckDuckGo (html.duckduckgo.com,
// резерв — lite.duckduckgo.com). Никакой регистрации, никаких API-ключей.
// Страницы результатов парсятся без внешних зависимостей; затем содержимое
// найденных страниц читается через управляемый fetcher (SSRF-защита, лимиты).
//
// Правило честности (ТЗ §5.3): модуль возвращает только то, что реально
// получил — заголовки, ссылки, сниппеты и время получения. Если источник
// недоступен — бросает ошибку, а не придумывает результаты.

import { assertPublicHost } from './fetcher.js';

const UA = 'LiteMind-Engine/0.6 (+local; user-controlled web search)';
const SEARCH_TIMEOUT_MS = 15_000;
const MAX_RESULTS = 8;

/** Декодировать HTML-сущности, встречающиеся в выдаче DDG. */
function decodeEntities(s) {
  return String(s ?? '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (m, d) => (Number(d) > 31 && Number(d) < 65536 ? String.fromCharCode(Number(d)) : ' '));
}

function stripTags(s) {
  return decodeEntities(String(s ?? '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/**
 * DuckDuckGo заворачивает URL результатов в свой трекер:
 * //duckduckgo.com/l/?uddg=https%3A%2F%2F...&rut=... — достаём настоящий адрес.
 */
export function unwrapDdgUrl(href) {
  let u = String(href ?? '').trim();
  if (!u) return null;
  if (u.startsWith('//')) u = 'https:' + u;
  try {
    const parsed = new URL(u);
    if (/(^|\.)duckduckgo\.com$/i.test(parsed.hostname) && parsed.pathname.startsWith('/l/')) {
      const target = parsed.searchParams.get('uddg');
      if (target) return decodeURIComponent(target);
    }
  } catch {
    return null;
  }
  if (/^https?:\/\//i.test(u)) return u;
  return null;
}

/** Извлечь результаты из HTML выдачи html.duckduckgo.com. */
export function parseDdgHtml(html) {
  const s = String(html ?? '');
  const out = [];
  // result__a — заголовок/ссылка; result__snippet — описание. Блоки идут парами.
  const linkRe = /<a[^>]+class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippetRe = /<a[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/i;
  let m;
  const titles = [];
  while ((m = linkRe.exec(s)) !== null) {
    const url = unwrapDdgUrl(m[1]);
    const title = stripTags(m[2]);
    if (url && title) titles.push({ title, url });
  }
  const snippets = [...s.matchAll(/<a[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gi)]
    .map((x) => stripTags(x[1]));
  for (let i = 0; i < titles.length; i++) {
    out.push({ title: titles[i].title, url: titles[i].url, snippet: snippets[i] ?? '' });
  }
  return out;
}

/** Извлечь результаты из упрощённой выдачи lite.duckduckgo.com (резерв). */
export function parseDdgLite(html) {
  const s = String(html ?? '');
  const out = [];
  const rows = [...s.matchAll(/<a[^>]+rel="nofollow"[^>]*href="([^"]+)"[^>]*class="result-link"[^>]*>([\s\S]*?)<\/a>/gi)];
  const snippets = [...s.matchAll(/class="result-snippet"[^>]*>([\s\S]*?)<\/td>/gi)].map((x) => stripTags(x[1]));
  rows.forEach((m, i) => {
    const url = unwrapDdgUrl(m[1]);
    const title = stripTags(m[2]);
    if (url && title) out.push({ title, url, snippet: snippets[i] ?? '' });
  });
  return out;
}

/** Хост публичный? (локальные/приватные адреса запрещены — как в fetcher.js) */
function isAllowedResultHost(u) {
  try {
    const parsed = new URL(u);
    if (!/^https?:$/.test(parsed.protocol)) return false;
    // Синтаксическая отсечка локальных имён; полная DNS-проверка — при чтении страницы.
    const h = parsed.hostname.toLowerCase();
    if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * Выполнить веб-поиск. Возвращает { results: [{title,url,snippet}], engine, fetchedAt }.
 * Бросает ошибку с понятным текстом, если поиск не удался (честность §5.3).
 */
export async function webSearch(query, { fetchImpl = fetch, limit = MAX_RESULTS, timeoutMs = SEARCH_TIMEOUT_MS } = {}) {
  const q = String(query ?? '').trim();
  if (!q) throw new Error('пустой поисковый запрос');
  if (q.length > 300) throw new Error('поисковый запрос слишком длинный (макс. 300 символов)');

  const attempts = [
    { name: 'duckduckgo', url: `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`, parser: parseDdgHtml },
    { name: 'duckduckgo-lite', url: `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(q)}`, parser: parseDdgLite }
  ];

  let lastError = null;
  for (const attempt of attempts) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(new Error('таймаут поиска')), timeoutMs);
    try {
      await assertPublicHost('html.duckduckgo.com');
      const res = await fetchImpl(attempt.url, {
        redirect: 'follow',
        signal: ctrl.signal,
        headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8' }
      });
      if (!res.ok) throw new Error(`${attempt.name}: HTTP ${res.status}`);
      const html = await res.text();
      const results = attempt.parser(html)
        .filter((r) => isAllowedResultHost(r.url))
        .slice(0, limit);
      // DDG при сетевых блокировках отдаёт страницу без результатов — честная ошибка.
      if (!results.length) {
        lastError = new Error(`поисковик ${attempt.name} не вернул результатов (страница получена, но совпадений нет — возможно, запрос слишком редкий или сеть ограничена)`);
        continue;
      }
      return { results, engine: attempt.name, query: q, fetchedAt: new Date().toISOString() };
    } catch (err) {
      lastError = err;
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(`Веб-поиск не удался: ${lastError?.message ?? 'неизвестная ошибка'}`);
}

/**
 * Прочитать содержимое найденных страниц (через управляемый fetcher движка
 * с его SSRF-защитой и лимитами). Ошибка одной страницы не отменяет остальные —
 * честная пометка "источник недоступен".
 */
export async function fetchSearchPages(results, { fetchText, maxPages = 3, perPageChars = 4000, signal = null } = {}) {
  const pages = [];
  for (const r of (results ?? []).slice(0, maxPages)) {
    try {
      const page = await fetchText(r.url, { signal });
      const text = String(page?.text ?? '').slice(0, perPageChars);
      pages.push({
        url: r.url,
        title: r.title,
        ok: text.trim().length > 0,
        chars: text.length,
        text
      });
    } catch (err) {
      pages.push({ url: r.url, title: r.title, ok: false, chars: 0, text: '', error: String(err?.message ?? err).slice(0, 200) });
    }
  }
  return pages;
}
