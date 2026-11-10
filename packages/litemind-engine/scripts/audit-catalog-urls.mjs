// Аудит каталога: проверка живости всех URL GGUF (HEAD/GET, следуя редиректам).
import { CATALOG } from '/home/z/my-project/work/repo/packages/litemind-engine/src/catalog/models.js';

const check = async (url) => {
  try {
    const r = await fetch(url, { method: 'HEAD', redirect: 'follow', headers: { 'user-agent': 'litemind-catalog-audit' } });
    if (r.status === 200) return '200';
    // HF иногда не отдаёт HEAD — пробуем GET с Range
    const g = await fetch(url, { redirect: 'follow', headers: { 'user-agent': 'litemind-catalog-audit', range: 'bytes=0-0' } });
    try { await g.body?.cancel(); } catch {}
    return String(g.status);
  } catch (e) {
    return 'ERR:' + e.message.slice(0, 60);
  }
};

const byRepo = new Map();
for (const m of CATALOG) {
  for (const f of m.files) {
    const repo = m.repo;
    if (!byRepo.has(repo)) byRepo.set(repo, { model: m.id, urls: [] });
    byRepo.get(repo).urls.push(f.url);
  }
}
console.log('Уникальных репозиториев:', byRepo.size);
const dead = [];
for (const [repo, info] of byRepo) {
  const st = await check(info.urls[0]); // одна ссылка на репозиторий — статус общий
  if (st !== '200') dead.push({ repo, model: info.model, status: st, urls: info.urls.length });
  process.stdout.write(`${st}  ${repo} (${info.model})\n`);
}
console.log('\n=== МЕРТВЫЕ РЕПОЗИТОРИИ ===');
for (const d of dead) console.log(JSON.stringify(d));
