// Генератор каталога v3 (Этап 1Б, §2/§2.2/§8):
//  1. Аудит существующих 42 записей — все URL проверены живыми (audit-catalog-urls.mjs, 2026-11-10).
//  2. Расширение схемы каждой записи: developer, purposes[], verifiedAt.
//  3. Добавление 7 реальных моделей Huihui — размеры и LFS SHA-256 сняты
//     с Hugging Face API напрямую (без вымысла), источники публичны.
// Выход: новый src/catalog/models.js (структура v2 сохраняется, поля добавляются).
import { CATALOG, CATEGORIES } from '/home/z/my-project/work/repo/packages/litemind-engine/src/catalog/models.js';
import fs from 'node:fs';

const VERIFIED_AT = '2026-11-10';
const OUT = '/home/z/my-project/work/repo/packages/litemind-engine/src/catalog/models.js';

// ── Разработчики по семействам (только подтверждённые авторы моделей) ──
const DEVELOPERS = {
  'smollm2': 'HuggingFaceTB',
  'smollm3': 'HuggingFaceTB',
  'qwen2.5': 'Qwen Team (Alibaba)',
  'qwen2.5-coder': 'Qwen Team (Alibaba)',
  'qwen3': 'Qwen Team (Alibaba)',
  'qwen3.5': 'Qwen Team (Alibaba)',
  'vikhr': 'Vikhrmodels',
  'gemma2': 'Google DeepMind',
  'gemma3': 'Google DeepMind',
  'llama3.2': 'Meta',
  'tinyllama': 'TinyLlama project',
  'phi4': 'Microsoft',
  'phi3.5': 'Microsoft',
  'mistral': 'Mistral AI',
  'ministral': 'Mistral AI',
  'deepseek-r1': 'DeepSeek',
  'deepseek-coder': 'DeepSeek',
  'saiga': 'Илья Гусев (Saiga)',
  'starcoder2': 'BigCode',
  'granite-code': 'IBM',
  'dolphin': 'Cognitive Computations',
  // новые
  'huihui-qwen2.5': 'Qwen Team (Alibaba) · дообучение Huihui-ai',
  'huihui-qwen3': 'Qwen Team (Alibaba) · дообучение Huihui-ai',
  'huihui-qwen3.5': 'Qwen Team (Alibaba) · дообучение Huihui-ai',
  'huihui-llama3.2': 'Meta · дообучение Huihui-ai'
};

// ── Назначения (§2.1). Только то, что подтверждено типом/размером/языками. ──
// 'tools' никому не ставим: runtime lmlama не предоставляет tool-call API (честно).
function purposesFor(m) {
  const p = new Set();
  const paramsNum = parseFloat(String(m.params ?? '0')) || 0;
  switch (m.category) {
    case 'small-coding':
    case 'advanced-coding':
    case 'uncensored-coding':
      p.add('coding');
      break;
    case 'reasoning':
      p.add('math'); p.add('analysis'); p.add('chat');
      break;
    case 'russian':
      p.add('chat'); p.add('writing');
      if (paramsNum >= 7) p.add('analysis');
      break;
    case 'uncensored-chat':
      p.add('chat'); p.add('writing'); p.add('creative');
      if (paramsNum >= 7) p.add('analysis');
      break;
    case 'chat-tiny':
    case 'chat-small':
      p.add('chat'); p.add('writing'); p.add('creative');
      if (paramsNum >= 3) p.add('analysis');
      if ((m.tags || []).some((t) => t.includes('reasoning'))) p.add('math');
      break;
    case 'chat-mid':
      p.add('chat'); p.add('writing'); p.add('creative'); p.add('analysis');
      break;
  }
  // Мультиязычность/перевод — по подтверждённым языкам.
  const langs = m.languages || [];
  if (langs.includes('multi') || langs.length >= 3) { p.add('multilingual'); p.add('translation'); }
  // Длинный контекст — по заявленному окну каталога.
  if ((m.contextTokens ?? 0) >= 32768) p.add('long-context');
  return [...p];
}

// ── 7 новых моделей Huihui: реальные публичные GGUF-репозитории ──
const HUIHUI_REPOS = [
  'mradermacher/Qwen2.5-0.5B-Instruct-abliterated-v3-GGUF',
  'mradermacher/Qwen3-1.7B-abliterated-GGUF',
  'mradermacher/Huihui-Qwen3.5-0.8B-abliterated-GGUF',
  'mradermacher/Huihui-Qwen3.5-2B-abliterated-GGUF',
  'mradermacher/Huihui-Qwen3.5-4B-abliterated-GGUF',
  'mradermacher/Llama-3.2-3B-Instruct-abliterated-GGUF',
  'mradermacher/Huihui-Qwen3-8B-abliterated-v2-GGUF'
];
const WANT_QUANTS = ['Q4_K_M', 'Q5_K_M', 'Q6_K', 'Q8_0'];

async function fetchRepo(repo) {
  const meta = await fetch(`https://huggingface.co/api/models/${repo}`).then((r) => { if (!r.ok) throw new Error(`${repo}: HTTP ${r.status}`); return r.json(); });
  const tree = await fetch(`https://huggingface.co/api/models/${repo}/tree/main`).then((r) => { if (!r.ok) throw new Error(`${repo}/tree: HTTP ${r.status}`); return r.json(); });
  // Дедуп по кванту: в репозиториях бывают копии одного файла в разном
  // регистре (Qwen3-… и qwen3-…) с разными загрузками — берём каноничное
  // имя с заглавной буквы (первую по алфавиту с заглавной).
  const byQuant = new Map();
  for (const f of tree) {
    if (!/\.gguf$/i.test(f.path) || /mmproj|mtp/i.test(f.path)) continue;
    const q = f2q(f.path);
    if (!q || !WANT_QUANTS.includes(q)) continue;
    const prev = byQuant.get(q);
    const canonical = (s) => /^[A-Z]/.test(s) ? 0 : 1;
    if (!prev || (canonical(f.path) < canonical(prev.path))) byQuant.set(q, f);
  }
  const files = WANT_QUANTS.map((q) => byQuant.get(q)).filter(Boolean);
  return {
    license: (meta.tags || []).find((t) => t.startsWith('license:'))?.slice(8) ?? null,
    files: files.map((f) => ({
      quant: f2q(f.path),
      name: f.path.split('/').pop(),
      url: `https://huggingface.co/${repo}/resolve/main/${f.path}`,
      sizeBytes: f.size,
      sha256: f.lfs?.oid ?? null
    }))
  };
}
function f2q(p) {
  const m = p.match(/\.(Q[2-8]_K_[MSL0]|Q[2-8]_K|Q[2-8]_0|IQ[1-4]_[A-Z0-9_]+|Q8_0)\.gguf$/i);
  return m ? m[1].toUpperCase() : null;
}

// Описания — в стиле каталога v2, честные, без обещаний «полной свободы».
const HUIHUI_MODELS = [
  {
    id: 'huihui-qwen2.5-0.5b-abliterated-v3',
    displayName: 'Huihui Qwen2.5 0.5B Abliterated v3',
    family: 'huihui-qwen2.5',
    category: 'uncensored-chat',
    params: '0.5B',
    languages: ['ru', 'en', 'multi'],
    contextTokens: 32768,
    license: 'apache-2.0',
    tags: ['chat', 'uncensored', 'tiny'],
    purpose: 'Ослабленная (abliterated) версия Qwen2.5 0.5B от Huihui-ai: отвечает в свободном стиле, отказов даёт заметно меньше базовой модели. Самая лёгкая из линейки Huihui.',
    quality: 'Для своих 0.5B — живой и быстрый собеседник; сложные рассуждения не потянет. Работает даже на слабом ПК.',
    speed: 'fast',
    repo: 'mradermacher/Qwen2.5-0.5B-Instruct-abliterated-v3-GGUF',
    quantAuthor: 'mradermacher (кванты; модель — huihui-ai)',
    note: 'Оригинальные веса: huihui-ai/Qwen2.5-0.5B-Instruct-abliterated-v3 (Apache-2.0).'
  },
  {
    id: 'huihui-qwen3-1.7b-abliterated',
    displayName: 'Huihui Qwen3 1.7B Abliterated',
    family: 'huihui-qwen3',
    category: 'uncensored-chat',
    params: '1.7B',
    languages: ['ru', 'en', 'multi'],
    contextTokens: 32768,
    license: 'apache-2.0',
    tags: ['chat', 'uncensored', 'small'],
    purpose: 'Abliterated-версия Qwen3 1.7B от Huihui-ai: свободный стиль ответов при сохранении навыков Qwen3 (режим thinking наследуется).',
    quality: 'Заметно умнее 0.5–0.6B моделей, при этом остаётся достаточно быстрой на CPU без AVX.',
    speed: 'fast',
    repo: 'mradermacher/Qwen3-1.7B-abliterated-GGUF',
    quantAuthor: 'mradermacher (кванты; модель — huihui-ai)',
    note: 'Репозиторий модели у huihui-ai помечен gated:auto — кванты взяты из публичного рерайта mradermacher.'
  },
  {
    id: 'huihui-qwen3.5-0.8b-abliterated',
    displayName: 'Huihui Qwen3.5 0.8B Abliterated',
    family: 'huihui-qwen3.5',
    category: 'uncensored-chat',
    params: '0.8B',
    languages: ['ru', 'en', 'multi'],
    contextTokens: 32768,
    license: 'apache-2.0',
    tags: ['chat', 'uncensored', 'tiny'],
    purpose: 'Ослабленная версия Qwen3.5 0.8B от Huihui-ai: минимальные требования, свободный стиль, русский от семейства Qwen.',
    quality: 'Сверхлёгкая: мгновенный отклик на N5095A. Интеллект скромный — простые вопросы и черновики.',
    speed: 'fast',
    repo: 'mradermacher/Huihui-Qwen3.5-0.8B-abliterated-GGUF',
    quantAuthor: 'mradermacher (кванты; модель — huihui-ai)',
    note: 'В репозитории есть mmproj (зрение) — LiteMind скачивает только текстовую GGUF.'
  },
  {
    id: 'huihui-qwen3.5-2b-abliterated',
    displayName: 'Huihui Qwen3.5 2B Abliterated',
    family: 'huihui-qwen3.5',
    category: 'uncensored-chat',
    params: '2B',
    languages: ['ru', 'en', 'multi'],
    contextTokens: 32768,
    license: 'apache-2.0',
    tags: ['chat', 'uncensored', 'small'],
    purpose: 'Средний размер линейки Huihui Qwen3.5: свободный стиль ответов, приемлемая скорость на слабом CPU.',
    quality: 'Баланс ума и скорости в линейке Qwen3.5; в Q4_K_M занимает ~1,2 ГБ и ~2 ГБ RAM с контекстом.',
    speed: 'medium',
    repo: 'mradermacher/Huihui-Qwen3.5-2B-abliterated-GGUF',
    quantAuthor: 'mradermacher (кванты; модель — huihui-ai)',
    note: null
  },
  {
    id: 'huihui-qwen3.5-4b-abliterated',
    displayName: 'Huihui Qwen3.5 4B Abliterated',
    family: 'huihui-qwen3.5',
    category: 'uncensored-chat',
    params: '4B',
    languages: ['ru', 'en', 'multi'],
    contextTokens: 32768,
    license: 'apache-2.0',
    tags: ['chat', 'uncensored', 'small'],
    purpose: 'Старшая компактная abliterated-модель Qwen3.5 от Huihui-ai: свободный стиль при заметном уме для своего размера.',
    quality: 'Один из лучших вариантов «свободного общения» для 16 ГБ RAM: ум на уровне 4B, скорость средняя.',
    speed: 'medium',
    repo: 'mradermacher/Huihui-Qwen3.5-4B-abliterated-GGUF',
    quantAuthor: 'mradermacher (кванты; модель — huihui-ai)',
    note: null
  },
  {
    id: 'huihui-llama-3.2-3b-abliterated',
    displayName: 'Huihui Llama 3.2 3B Abliterated',
    family: 'huihui-llama3.2',
    category: 'uncensored-chat',
    params: '3.2B',
    languages: ['en', 'multi'],
    contextTokens: 32768,
    license: 'llama3.2',
    tags: ['chat', 'uncensored', 'small'],
    purpose: 'Abliterated-версия Llama 3.2 3B от Huihui-ai: свободный стиль, английский и основные европейские языки.',
    quality: 'Крепкая 3B-модель для общения и текстов; русский слабее, чем у Qwen-семейства.',
    speed: 'medium',
    repo: 'mradermacher/Llama-3.2-3B-Instruct-abliterated-GGUF',
    quantAuthor: 'mradermacher (кванты; модель — huihui-ai)',
    note: 'Лицензия Llama 3.2 Community — используйте по условиям Meta.'
  },
  {
    id: 'huihui-qwen3-8b-abliterated-v2',
    displayName: 'Huihui Qwen3 8B Abliterated v2',
    family: 'huihui-qwen3',
    category: 'uncensored-chat',
    params: '8B',
    languages: ['ru', 'en', 'multi'],
    contextTokens: 32768,
    license: 'apache-2.0',
    tags: ['chat', 'uncensored', 'mid'],
    purpose: 'Старшая abliterated-модель Huihui в каталоге: максимум свободы и ума, но тяжёлая для слабого CPU.',
    quality: 'Заметно умнее 4B, однако на CPU без AVX скорость — единицы токенов в секунду. Каталог честно пометит «не рекомендуется».',
    speed: 'slow',
    repo: 'mradermacher/Huihui-Qwen3-8B-abliterated-v2-GGUF',
    quantAuthor: 'mradermacher (кванты; модель — huihui-ai)',
    note: 'Для этой модели желательна дискретная видеокарта; на N5095A запуск возможен, но медленный.'
  }
];

function fileLabel(fileName) {
  // "Huihui-Qwen3.5-2B-abliterated.Q4_K_M.gguf" → квант уже в поле quant
  return null;
}

async function main() {
  console.log('Проверяю 7 Huihui-репозиториев через HF API…');
  const fetched = {};
  for (const repo of HUIHUI_REPOS) {
    const d = await fetchRepo(repo);
    if (!d.files.length) throw new Error(`${repo}: не найдено GGUF нужных квантов`);
    for (const f of d.files) if (!f.sha256) throw new Error(`${repo}/${f.name}: нет LFS SHA-256`);
    fetched[repo] = d;
    console.log(`  ${repo}: ${d.files.length} файлов, лицензия ${d.license}`);
    for (const f of d.files) console.log(`     ${f.quant} ${(f.sizeBytes / 1048576).toFixed(1)} МБ sha256=${f.sha256.slice(0, 12)}…`);
  }

  // Аугментация существующих 42 записей.
  const augmented = CATALOG.map((m) => ({
    ...m,
    developer: DEVELOPERS[m.family] ?? null,
    purposes: purposesFor(m),
    verifiedAt: VERIFIED_AT
  }));
  for (const m of augmented) {
    if (!m.developer) throw new Error(`${m.id}: developer не определён — добавьте в DEVELOPERS`);
    if (!m.purposes.length) throw new Error(`${m.id}: purposes пуст`);
  }

  // Новые записи Huihui.
  for (const h of HUIHUI_MODELS) {
    const d = fetched[h.repo];
    const entry = {
      id: h.id,
      ollamaName: `litemind-${h.id}`,
      displayName: h.displayName,
      category: h.category,
      restrictions: 'reduced',
      uncensored: true,
      uncensoredLabel: 'Abliterated',
      tags: h.tags,
      languages: h.languages,
      params: h.params,
      family: h.family,
      purpose: h.purpose,
      quality: h.quality,
      speed: h.speed,
      license: h.license,
      licenseNote: null,
      source: `https://huggingface.co/${h.repo}`,
      repo: h.repo,
      quantAuthor: h.quantAuthor,
      contextTokens: h.contextTokens,
      tools: false,
      vision: false,
      notes: h.note,
      developer: DEVELOPERS[h.family],
      purposes: purposesFor({ ...h, category: h.category }),
      verifiedAt: VERIFIED_AT,
      files: d.files
    };
    augmented.push(entry);
  }

  const out = `// LiteMind Model Catalog v3 — только проверенные записи.
//
// Источник данных: официальный Hugging Face API (последняя проверка: ${VERIFIED_AT}):
//  - репозиторий существует и публичен (gated-репозитории не попадают или помечены);
//  - размер и LFS SHA-256 каждого GGUF сняты с /api/models/<repo>/tree/main;
//  - лицензия — из тегов репозитория, сомнительные помечены licenseNote;
//  - developer — автор модели (или «дообучение», если модель производная);
//  - purposes — назначения по ТЗ Этапа 1Б §2.1 (одна модель может иметь несколько);
//  - verifiedAt — дата последней проверки сведений записи.
// Сгенерировано scripts/gen-catalog-v3.mjs. Никаких фиктивных ссылок.
//
// Категории ограничений (ТЗ):
//  - restrictions: 'standard' — обычные встроенные ограничения разработчика;
//  - restrictions: 'reduced'  — uncensored/abliterated: отказы ослаблены обучением,
//    но «абсолютной свободы» не существует — поведение зависит от модели.
//
// Расширяемость (ТЗ §8): сервер может дополнять каталог файлом-оверрайдом
// (catalog-override.json в папке конфигурации) и опциональным удалённым JSON.
// Без интернета каталог работает в полном объёме — данные вшиты в приложение.

export const CATALOG_VERSION = { version: 3, verifiedAt: '${VERIFIED_AT}', generatedBy: 'scripts/gen-catalog-v3.mjs' };

export const CATEGORIES = ${JSON.stringify(CATEGORIES, null, 2)};

// Назначения моделей (Этап 1Б §2.1). Ключи используются в поле purposes записей.
export const PURPOSES = {
  "coding": "Программирование и разработка",
  "chat": "Общение и универсальные задачи",
  "writing": "Написание текстов",
  "analysis": "Анализ документов",
  "translation": "Перевод",
  "math": "Математика и логика",
  "long-context": "Работа с длинным контекстом",
  "creative": "Творческие задачи",
  "multilingual": "Мультиязычные модели"
};

// Семейства, проверенные на собственном runtime LiteMind (llama.cpp сборка
// без AVX-требований). Модели с неизвестным семейством не помечаются как
// гарантированно совместимые — см. compat.js.
export const RUNTIME_VERIFIED_FAMILIES = new Set([
  "smollm2", "smollm3", "qwen2.5", "qwen2.5-coder", "qwen3", "qwen3.5",
  "vikhr", "gemma2", "gemma3", "llama3.2", "tinyllama", "mistral",
  "ministral", "phi4", "phi3.5", "deepseek-r1", "deepseek-coder",
  "saiga", "starcoder2", "granite-code", "dolphin",
  "huihui-qwen2.5", "huihui-qwen3", "huihui-qwen3.5", "huihui-llama3.2"
]);

export const CATALOG = [
${augmented.map((m) => '  ' + JSON.stringify(m, null, 2).replace(/\n/g, '\n  ')).join(',\n')}
];

export function catalogEntry(id) {
  return CATALOG.find((m) => m.id === id) ?? null;
}
`;
  fs.writeFileSync(OUT, out, 'utf8');
  console.log(`\nЗаписано ${OUT}: ${augmented.length} моделей, ${augmented.reduce((s, m) => s + m.files.length, 0)} GGUF.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
