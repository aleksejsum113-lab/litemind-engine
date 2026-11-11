// LiteMind Engine — управляемый доступ к интернету (ТЗ §7).
// По умолчанию ВЫКЛЮЧЕН (config.web.enabled = false). Включается пользователем
// в настройках. Внешние запросы идут только на публичные хосты: loopback и
// приватные адреса запрещены (SSRF), лимиты по размеру и времени, секреты
// не попадают в логи. GitHub — публичный REST API без обязательной авторизации;
// опциональный токен хранится в конфиге и нигде не печатается.

import net from 'node:net';
import dns from 'node:dns/promises';

const UA = 'LiteMind-Engine/0.6 (+local; user-controlled internet access)';
const FETCH_TIMEOUT_MS = 20_000;
const MAX_PAGE_BYTES = 512 * 1024;
const MAX_TEXT_CHARS = 60_000;

export const DEFAULT_WEB_CONFIG = {
  enabled: false,          // главный выключатель — по умолчанию интернет закрыт
  allowGithub: true,       // просмотр публичных репозиториев
  githubToken: null        // опционально: PAT для лимитов API (не логируется)
};

/** true, если хост разрешён (публичный). loopback/приватные/link-local — нет. */
export function isPublicHost(hostname) {
  const host = String(hostname ?? '').trim().toLowerCase().replace(/\.$/, '');
  if (!host) return false;
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return false;
  // IPv6/IPv4 литералы
  const probe = net.isIPv6(host) ? host : host;
  if (net.isIP(probe)) return isPublicIp(probe);
  // DNS-имена: резолвим и проверяем все адреса (DNS-rebinding защита)
  return true; // фактическая проверка IP — в assertPublicHost (async)
}

export function isPublicIp(ip) {
  const v = net.isIPv4(ip) ? 'v4' : net.isIPv6(ip) ? 'v6' : null;
  if (!v) return false;
  if (v === 'v4') {
    const [a, b] = ip.split('.').map(Number);
    if (a === 10 || a === 127 || a === 0) return false;
    if (a === 169 && b === 254) return false;           // link-local
    if (a === 172 && b >= 16 && b <= 31) return false;  // private
    if (a === 192 && b === 168) return false;           // private
    if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT
    if (a >= 224) return false;                          // multicast/reserved
    return true;
  }
  const low = ip.toLowerCase();
  if (low === '::1' || low === '::' || low.startsWith('fe80') || low.startsWith('fc') || low.startsWith('fd')) return false;
  if (low.startsWith('::ffff:')) return isPublicIp(low.slice(7));
  return true;
}

/** Асинхронная проверка: DNS-имя → все IP должны быть публичными. */
export async function assertPublicHost(hostname) {
  let host = String(hostname ?? '').trim().toLowerCase().replace(/\.$/, '');
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1); // IPv6-литерал из URL
  if (!host) throw new Error('пустой хост');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new Error(`хост «${host}» не является публичным — доступ запрещён`);
  }
  if (net.isIP(host)) {
    if (!isPublicIp(host)) throw new Error('доступ к приватным адресам запрещён');
    return;
  }
  let addrs = [];
  try { addrs = await dns.lookup(host, { all: true, verbatim: true }); } catch {
    throw new Error(`не удалось разрешить адрес «${host}»`);
  }
  if (!addrs.length) throw new Error(`адрес «${host}» не разрешается`);
  for (const a of addrs) {
    if (!isPublicIp(a.address)) throw new Error(`хост «${host}» указывает на приватный адрес — доступ запрещён`);
  }
}

/** HTML → читаемый текст (без внешних зависимостей). */
export function htmlToText(html) {
  let s = String(html ?? '');
  s = s.replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
       .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
       .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, ' ')
       .replace(/<!--[\s\S]*?-->/g, ' ');
  // блочные теги → переводы строк
  s = s.replace(/<\/(p|div|section|article|header|footer|h[1-6]|li|tr|table|pre|blockquote)>/gi, '\n')
       .replace(/<(br|hr)\s*\/?>/gi, '\n')
       .replace(/<li[^>]*>/gi, '• ');
  s = s.replace(/<[^>]+>/g, ' ');
  // базовые сущности
  const ents = { '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&apos;': "'", '&mdash;': '—', '&laquo;': '«', '&raquo;': '»', '&hellip;': '…' };
  s = s.replace(/&(nbsp|amp|lt|gt|quot|#39|apos|mdash|laquo|raquo|hellip);/g, (m) => ents[m] ?? ' ');
  s = s.replace(/&#(\d+);/g, (m, d) => {
    const code = Number(d);
    return code > 31 && code < 65536 ? String.fromCharCode(code) : ' ';
  });
  s = s.replace(/[ \t]+/g, ' ')
       .replace(/\n\s*\n\s*/g, '\n\n')
       .replace(/^\s+|\s+$/g, '');
  if (s.length > MAX_TEXT_CHARS) s = s.slice(0, MAX_TEXT_CHARS) + '\n… (страница сокращена)';
  return s;
}

/** Создать контекст веба для движка и инструментов агента. */
export function createWebContext(config, { fetchImpl = fetch } = {}) {
  const webCfg = { ...DEFAULT_WEB_CONFIG, ...(config.web ?? {}) };
  const enabled = () => config.web?.enabled === true;

  async function guardedFetch(url, opts = {}) {
    let u;
    try { u = new URL(url); } catch { throw new Error(`неверный URL: ${url}`); }
    if (!/^https?:$/.test(u.protocol)) throw new Error('разрешены только http(s)-адреса');
    await assertPublicHost(u.hostname);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(new Error('таймаут запроса')), opts.timeoutMs ?? FETCH_TIMEOUT_MS);
    try {
      return await fetchImpl(u, {
        redirect: 'follow',
        signal: ctrl.signal,
        headers: {
          'user-agent': UA,
          accept: opts.accept ?? 'text/html,application/json;q=0.9,*/*;q=0.8',
          ...(opts.headers ?? {})
        },
        ...opts.init
      });
    } finally {
      clearTimeout(timer);
    }
  }

  /** Прочитать страницу/файл → текст. */
  async function fetchText(url) {
    if (!enabled()) throw new Error('доступ к интернету выключен (Настройки → Интернет)');
    const res = await guardedFetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status} для ${url}`);
    const ct = String(res.headers.get('content-type') ?? '');
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_PAGE_BYTES) throw new Error(`страница слишком велика (${buf.length} байт)`);
    const asText = buf.toString('utf8');
    const text = /html/i.test(ct) || /^\s*<(!doctype|html)/i.test(asText) ? htmlToText(asText) : asText;
    return { url, contentType: ct, bytes: buf.length, text: text.slice(0, MAX_TEXT_CHARS) };
  }

  /** GitHub публичный API. op = repo | readme | contents | commits | search */
  async function github(args = {}) {
    if (!enabled()) throw new Error('доступ к интернету выключен (Настройки → Интернет)');
    if (webCfg.allowGithub === false) throw new Error('работа с GitHub отключена в настройках');
    const op = String(args.op ?? 'repo');
    if (op === 'search') {
      const q = encodeURIComponent(String(args.query ?? '').slice(0, 200));
      const headers = { accept: 'application/vnd.github+json' };
      if (webCfg.githubToken) headers.authorization = `Bearer ${webCfg.githubToken}`;
      const res = await guardedFetch(`https://api.github.com/search/repositories?q=${q}&per_page=10`, { headers });
      if (!res.ok) throw new Error(`GitHub API: HTTP ${res.status}`);
      const j = await res.json();
      return { text: (j.items ?? []).map((r) => `${r.full_name} ★${r.stargazers_count} — ${(r.description ?? '').slice(0, 100)}`).join('\n') || 'ничего не найдено' };
    }
    const repo = String(args.repo ?? '').replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/i, '').replace(/^\/+|\/+$/g, '');
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('укажите репозиторий вида owner/repo');
    const headers = { accept: 'application/vnd.github+json' };
    if (webCfg.githubToken) headers.authorization = `Bearer ${webCfg.githubToken}`;
    const api = `https://api.github.com/repos/${repo}`;

    if (op === 'repo') {
      const res = await guardedFetch(api, { headers, accept: 'application/vnd.github+json' });
      if (!res.ok) throw new Error(`GitHub API: HTTP ${res.status}`);
      const j = await res.json();
      return { text: `${j.full_name} — ${j.description ?? 'без описания'}\nязык: ${j.language ?? '—'}; звёзды: ${j.stargazers_count}; лицензия: ${j.license?.spdx_id ?? '—'}\nветка по умолчанию: ${j.default_branch}\nURL: ${j.html_url}` };
    }
    if (op === 'readme') {
      const res = await guardedFetch(`${api}/readme`, { headers });
      if (!res.ok) throw new Error(`GitHub API: HTTP ${res.status}`);
      const j = await res.json();
      const md = Buffer.from(j.content ?? '', 'base64').toString('utf8');
      return { text: md.slice(0, MAX_TEXT_CHARS) };
    }
    if (op === 'contents') {
      const p = String(args.path ?? '').replace(/^\/+/, '');
      const ref = args.ref ? `?ref=${encodeURIComponent(args.ref)}` : '';
      const res = await guardedFetch(`${api}/contents/${encodeURI(p)}${ref}`, { headers });
      if (!res.ok) throw new Error(`GitHub API: HTTP ${res.status}`);
      const j = await res.json();
      if (Array.isArray(j)) {
        return { text: j.map((e) => `${e.type === 'dir' ? '📁' : '📄'} ${e.path} (${e.size ?? 0} б)`).join('\n') || '(пусто)' };
      }
      if (j.type === 'file') {
        if (j.encoding === 'base64' && (j.content ?? '').length <= 400_000) {
          return { text: Buffer.from(j.content, 'base64').toString('utf8').slice(0, MAX_TEXT_CHARS) };
        }
        return { text: `файл ${j.path} (${j.size} б) слишком велик — откройте: ${j.html_url}` };
      }
      return { text: JSON.stringify(j).slice(0, 4000) };
    }
    if (op === 'commits') {
      const res = await guardedFetch(`${api}/commits?per_page=${Math.min(20, Number(args.count) || 10)}`, { headers });
      if (!res.ok) throw new Error(`GitHub API: HTTP ${res.status}`);
      const j = await res.json();
      return { text: j.map((c) => `${c.sha.slice(0, 8)} ${String(c.commit.message).split('\n')[0].slice(0, 100)} (${c.commit.author?.name ?? '?'}, ${String(c.commit.author?.date ?? '').slice(0, 10)})`).join('\n') };
    }
    throw new Error(`неизвестная операция GitHub: ${op}`);
  }

  return {
    enabled,
    config: webCfg,
    fetchText,
    github,
    htmlToText,
    assertPublicHost
  };
}
