// LiteMind Adaptive Controller — центральное сердце движка (ТЗ Adaptive Engine).
//
// Решения ПЕРЕД генерацией (детерминированные, без лишних вызовов моделей —
// на слабом ПК каждый лишний запрос замедляет ответ):
//   1. Классификация сложности запроса (simple/file/project/hard).
//   2. Уплотнение контекста: система и первая задача пользователя сохраняются
//      полностью, середина истории сокращается до компактной сводки-заглушки,
//      недавние сообщения остаются. Повторяющиеся сообщения пользователя схлопываются.
//   3. Бюджет генерации: простые задачи получают уменьшенный лимит токенов,
//      сложные — полный (экономия не должна ухудшать качество).
//   4. Профиль производительности модели (config.optimizations): потоки, t/s,
//      TTFT, стабильность — измеряется автооптимизацией и реальными запросами.
//
// Prompt caching: Ollama/llama.cpp кэширует KV общего префикса автоматически.
// Контроллер сохраняет СТАБИЛЬНЫЙ префикс (системный промпт не переписывается,
// история дополняется с конца) — так кэш реально переиспользуется. Если runtime
// кэш не поддерживает — claims не делаем (strategy: 'none').
//
// Вспомогательная модель: по умолчанию ВЫКЛЮЧЕНА. На слабом ПК классификация
// выполняется эвристикой (0 мс), а не второй моделью. auxModel включается
// пользователем вручную (config.adaptive.auxModel) и после простой задачи
// выгружается, если основная модель не в памяти.

export const COMPLEXITY_LEVELS = ['simple', 'file', 'project', 'hard'];

// Политика по сложности. maxOutputFactor — доля от maxOutputTokens профиля.
export const COMPLEXITY_POLICY = {
  simple:  { maxOutputFactor: 0.5, minOutputTokens: 192, historyShare: 0.45, keepRecent: 4 },
  file:    { maxOutputFactor: 1.0, minOutputTokens: 384, historyShare: 0.7,  keepRecent: 6 },
  project: { maxOutputFactor: 1.25, minOutputTokens: 512, historyShare: 0.85, keepRecent: 8 },
  hard:    { maxOutputFactor: 1.5,  minOutputTokens: 640, historyShare: 1.0,  keepRecent: 10 }
};

const CODE_SIGNALS = /```|\b(function|class|def|const|let|var|import|export|return|await)\b|=>|\b(bug|error|exception|traceback|stack ?trace|fix|refactor|compile|test)\b/i;
const FILE_RE = /[\w.-]+\.(js|ts|tsx|jsx|py|java|kt|c|h|cpp|cs|go|rs|rb|php|json|ya?ml|toml|md|html|css|sql|sh|bat)\b/g;

/** Оценка числа токенов (быстрая, без токенизатора: ~3.6 символа/токен). */
export function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(String(text).length / 3.6);
}

/**
 * Переваривание длинного входа (ТЗ §4): разбивает большой текст на блоки,
 * сохраняет первый абзац (постановка задачи), блоки с цифрами/кодом/требованиями
 * и последние блоки; исключает повторы. Это extractive-дайджест: факты
 * сохраняются дословно, поверхностный пересказ не подменяет анализ.
 */
export function digestLongInput(text, maxTokens = 1500) {
  const src = String(text ?? '');
  if (estimateTokens(src) <= maxTokens) return src;
  const blocks = src.split(/\n{2,}/).map((b) => b.trim()).filter(Boolean);
  const kept = [];
  const seen = new Set();
  const push = (b, why) => {
    const key = b.slice(0, 120).toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    kept.push({ block: b, why });
  };
  if (blocks.length > 0) push(blocks[0], 'head');
  const interesting = /\d|```|TODO|FIXME|error|ошибк|требуется|необходимо|обязательн|import|function|def |class /i;
  for (let i = 1; i < blocks.length - 1; i++) {
    if (interesting.test(blocks[i]) && blocks[i].length > 40) push(blocks[i], 'facts');
  }
  if (blocks.length > 1) push(blocks[blocks.length - 1], 'tail');
  // Вписываемся в бюджет, приоритет: head → tail → facts (по порядку).
  const ordered = [kept.find((k) => k.why === 'head'), kept.find((k) => k.why === 'tail'), ...kept.filter((k) => k.why === 'facts')].filter(Boolean);
  const out = [];
  let used = 0;
  for (const k of ordered) {
    const t = estimateTokens(k.block);
    if (used + t > maxTokens) {
      // Последний ресурс: обрезаем блок по границе предложения.
      const remain = maxTokens - used;
      if (remain > 100) {
        const cut = k.block.slice(0, Math.floor(remain * 3.6));
        const lastDot = cut.lastIndexOf('. ');
        out.push(lastDot > 0 ? cut.slice(0, lastDot + 1) : cut);
      }
      break;
    }
    out.push(k.block);
    used += t;
  }
  return out.join('\n\n') + (out.length < kept.length ? '\n\n[... вход сокращён адаптивным контроллером: сохранены постановка задачи, факты и требования ...]' : '');
}

/**
 * Классификация сложности запроса по последнему сообщению пользователя.
 * Эвристика (не вторая модель) — нулевая нагрузка, честно помечена как heuristic.
 */
export function classifyTask(messages = []) {
  const lastUser = [...messages].reverse().find((m) => m.role === 'user');
  const text = typeof lastUser?.content === 'string' ? lastUser.content : '';
  const files = text.match(FILE_RE)?.length ?? 0;
  const code = CODE_SIGNALS.test(text);
  const chars = text.length;

  if (chars > 6000 || files >= 3 || (files >= 1 && chars > 2500)) {
    return { complexity: 'project', method: 'heuristic', reason: `большой объём (${chars} симв., файлов: ${files})` };
  }
  if (files >= 1) {
    return { complexity: 'file', method: 'heuristic', reason: `упомянуты файлы: ${files}` };
  }
  if (code && chars > 400) {
    return { complexity: 'hard', method: 'heuristic', reason: 'код/ошибка в запросе' };
  }
  if (code) {
    return { complexity: 'file', method: 'heuristic', reason: 'короткий код-фрагмент' };
  }
  return { complexity: 'simple', method: 'heuristic', reason: 'обычный вопрос' };
}

function dedupeUserMessages(messages) {
  // Повторные одинаковые сообщения пользователя (повторы/ретраи) схлопываем:
  // оставляем последнее вхождение, промежуточные дубликаты удаляем.
  const lastIdx = new Map();
  messages.forEach((m, i) => {
    if (m.role === 'user') lastIdx.set(m.content, i);
  });
  return messages.filter((m, i) => m.role !== 'user' || lastIdx.get(m.content) === i);
}

/**
 * Умное управление контекстом: вписывает историю в бюджет токенов,
 * НЕ трогая: 1) системные сообщения (стабильный префикс → работает prompt cache),
 * 2) первое сообщение пользователя (исходная постановка задачи),
 * 3) последние keepRecent сообщений.
 * Вытесненная середина заменяется компактной сводкой-заглушкой.
 */
export function compactMessages({ messages, contextTokens, policy = COMPLEXITY_POLICY.file }) {
  const system = messages.filter((m) => m.role === 'system');
  const rest = dedupeUserMessages(messages.filter((m) => m.role !== 'system'));
  if (rest.length === 0) return { messages, dropped: 0, summaryAdded: false };

  const firstUserIdx = rest.findIndex((m) => m.role === 'user');
  const budget = Math.max(256, Math.floor(contextTokens * policy.historyShare));
  const sysTokens = system.reduce((s, m) => s + estimateTokens(m.content), 0);

  const tailIdx = Math.max(0, rest.length - policy.keepRecent);
  let used = sysTokens;
  const keep = new Set();
  if (firstUserIdx >= 0 && firstUserIdx < tailIdx) keep.add(firstUserIdx);
  for (let i = tailIdx; i < rest.length; i++) keep.add(i);
  for (const i of keep) used += estimateTokens(rest[i]?.content ?? 0);

  for (let i = tailIdx - 1; i >= 0; i--) {
    if (keep.has(i)) continue;
    const t = estimateTokens(rest[i].content);
    if (used + t > budget) continue;
    keep.add(i);
    used += t;
  }

  const kept = rest.filter((_, i) => keep.has(i));
  const droppedFinal = rest.filter((_, i) => !keep.has(i));
  if (droppedFinal.length === 0) {
    return { messages: [...system, ...rest], dropped: 0, summaryAdded: false };
  }

  const droppedTokens = droppedFinal.reduce((s, m) => s + estimateTokens(m.content), 0);
  const summaryLines = droppedFinal.slice(-3).map((m) => {
    const preview = String(m.content).replace(/\s+/g, ' ').slice(0, 160);
    return `- ${m.role}: ${preview}${String(m.content).length > 160 ? '…' : ''}`;
  });
  const summary = {
    role: 'system',
    content:
      `[Сжатая история: ${droppedFinal.length} сообщений (~${droppedTokens} ток.) скрыто для экономии контекста. ` +
      'Последние скрытые сообщения кратко:\n' + summaryLines.join('\n') + ']'
  };
  return { messages: [...system, summary, ...kept], dropped: droppedFinal.length, summaryAdded: true };
}

/**
 * Подготовка запроса контроллером. Вызывается движком перед каждой генерацией.
 * Возвращает { messages, contextTokens, maxOutputTokens, complexity, meta }.
 *
 * Контракт max_tokens (Этап 2, исправление регрессии «пустой ответ»):
 * ЯВНЫЙ лимит клиента — жёсткий потолок (OpenAI-совместимость). Контроллер
 * может его только УМЕНЬШАТЬ (адаптация под сложность), но никогда не повышать:
 * у reasoning-моделей (Qwen3 и т.п.) «размышления» <think> съедают небольшой
 * вынужденный бюджет целиком — клиент получал пустой ответ без объяснений.
 * Пол minOutputTokens применяется ТОЛЬКО к внутреннему дефолту (когда клиент
 * лимит не указал) — там он защищает от поверхностных ответов.
 */
export function prepareRequest({ messages, contextTokens, maxOutputTokens, defaultMaxOutputTokens = null, optimizations = null, adaptive = {}, policyOverride = null }) {
  if (adaptive.enabled === false) {
    return { messages, contextTokens, maxOutputTokens: Number(maxOutputTokens) > 0 ? Number(maxOutputTokens) : Number(defaultMaxOutputTokens) > 0 ? Number(defaultMaxOutputTokens) : maxOutputTokens, complexity: null, meta: { adaptive: 'off' } };
  }
  const cls = classifyTask(messages);
  const policy = policyOverride ?? COMPLEXITY_POLICY[cls.complexity] ?? COMPLEXITY_POLICY.file;

  // Бюджет генерации: адаптируется к сложности, но не ниже minOutputTokens
  // (поверхностные ответы на сложные задачи недопустимы) — ТОЛЬКО для
  // внутреннего дефолта. Явный лимит клиента — потолок, не поднимаем.
  const requested = Number(maxOutputTokens) > 0 ? Number(maxOutputTokens) : null;
  const internalDefault = Number(defaultMaxOutputTokens) > 0
    ? Number(defaultMaxOutputTokens)
    : (requested ?? 1024);
  const adaptedMax = requested != null
    ? Math.min(requested, Math.max(policy.minOutputTokens, Math.round(requested * policy.maxOutputFactor)))
    : Math.max(policy.minOutputTokens, Math.round(internalDefault * policy.maxOutputFactor));

  let out = { messages, dropped: 0, summaryAdded: false };
  if (adaptive.contextCompaction !== false) {
    // Копируем сообщения: контроллер не мутирует данные вызывающего кода.
    const copied = messages.map((m) => ({ ...m }));
    // Длинный одиночный вход сжимаем до 60% бюджета контекста.
    const lastUser = [...copied].reverse().find((m) => m.role === 'user');
    if (lastUser && estimateTokens(lastUser.content) > contextTokens * 0.6) {
      lastUser.content = digestLongInput(lastUser.content, Math.floor(contextTokens * 0.6));
    }
    out = compactMessages({ messages: copied, contextTokens, policy });
  }

  return {
    messages: out.messages,
    contextTokens,
    maxOutputTokens: adaptedMax,
    complexity: cls.complexity,
    meta: {
      adaptive: 'on',
      complexity: cls,
      compaction: out.dropped > 0 ? { dropped: out.dropped, summaryAdded: out.summaryAdded } : null
    }
  };
}
