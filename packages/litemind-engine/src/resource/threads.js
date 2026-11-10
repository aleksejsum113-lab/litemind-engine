// Этап 2 §4/§8 — разрешение фактических параметров runtime llama-server.
//
// Чистые функции без зависимостей: движок подставляет профиль/железо и получает
// КОНКРЕТНЫЕ аргументы запуска llama-server. Профили обязаны реально менять
// параметры runtime (ТЗ §8): потоки, batch, mmap, кэш, приоритет. Одна и та же
// конфигурация → одинаковый ключ запуска; изменившийся ключ → честный
// перезапуск llama-server с новыми параметрами.
//
// Целевая машина: Intel Celeron N5095A — 4 ядра / 4 потока, без AVX/AVX2.
//   «Бережный»          → 2 потока генерации (1 ядро свободно для Windows)
//   «Сбалансированный»  → 3 потока (4-е остаётся системе и UI)
//   «Производительный»  → 4 потока (все ядра модели; приоритет остаётся Normal)
// Prefill (--threads-batch) всегда может использовать все ядра: это короткая
// вспышка нагрузки, ускоряющая обработку длинных промптов.

/** Число логических ядер или 4 (безопасный минимум для целевой конфигурации). */
export function logicalCores(cores) {
  const n = Number(cores);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 4;
}

/**
 * Потоки генерации по профилю.
 * @param {'low'|'balanced'|'high'} profile
 * @param {number} cores  логические ядра
 * @param {number} explicit  cpuThreads профиля/запроса (0 = авто).
 *   Явное значение не ограничивается ядрами: пользователь/автооптимизатор могут
 *   сознательно запросить oversubscription — llama.cpp это легальный режим.
 */
export function resolveGenThreads({ profile = 'balanced', cores = 4, explicit = 0 } = {}) {
  const n = logicalCores(cores);
  if (Number.isFinite(explicit) && explicit > 0) return Math.floor(explicit);
  if (profile === 'low') return Math.max(1, Math.floor(n / 2));
  if (profile === 'high') return n;
  return Math.max(2, n - 1); // balanced: одно ядро остаётся Windows
}

/**
 * Потоки prefill (prompt processing). Короткая фаза — используем все ядра,
 * кроме «Бережного» (там не больше половины, чтобы не мешать другим приложениям).
 * Явное значение не ограничивается (см. resolveGenThreads).
 */
export function resolvePrefillThreads({ profile = 'balanced', cores = 4, explicit = 0 } = {}) {
  const n = logicalCores(cores);
  if (Number.isFinite(explicit) && explicit > 0) return Math.floor(explicit);
  if (profile === 'low') return Math.max(1, Math.floor(n / 2));
  return n;
}

/**
 * batch/ubatch для prompt processing. ВАЖНО: значения ниже дефолтов llama.cpp
 * (2048/512) замедляют prefill, а не ускоряют — на слабых ПК узкое место -
 * пропускная способность памяти, а не размер вычислительного буфера.
 */
export function resolveBatch({ profile = 'balanced' } = {}) {
  if (profile === 'low') return { batch: 512, ubatch: 256 };
  if (profile === 'high') return { batch: 2048, ubatch: 512 };
  return { batch: 1024, ubatch: 512 }; // balanced
}

/**
 * Политика mmap (ТЗ §3: динамическое и рациональное использование RAM).
 *   true  → --load-mode mmap (явно включить memory-mapping)
 *   false → --load-mode none (файл читается последовательно и целиком в RAM)
 *   'auto'/null → для моделей, которые заведомо помещаются в RAM, mmap ВЫКЛЮЧАЕТСЯ:
 *     последовательное чтение грузит модель заметно быстрее холодного mmap
 *     (страничные сбои) на слабых дисках и ускоряет генерацию (веса уже в RAM).
 *     Большие модели остаются на mmap, чтобы Windows могла вытеснять холодные
 *     страницы вместо исчерпания памяти.
 * Порог: файл ≤ max(1 ГБ, 25% физической RAM) → no-mmap.
 */
export function resolveMmap({ useMmap = 'auto', fileSizeBytes = 0, totalRamBytes = 0 } = {}) {
  if (useMmap === true) return true;
  if (useMmap === false) return false;
  const size = Number(fileSizeBytes) || 0;
  const ram = Number(totalRamBytes) || 0;
  const threshold = Math.max(1024 ** 3, ram * 0.25);
  if (!size || !ram) return true; // данных нет — поведение по умолчанию llama.cpp
  return size > threshold;
}

/**
 * Приоритет процесса llama-server по профилю (ТЗ §4/§11).
 * «Бережный» — ниже обычного: генерация не должна тормозить другие приложения.
 */
export function resolvePriority(profile = 'balanced') {
  if (profile === 'low') return { level: 'below_normal', nice: 10 };
  return { level: 'normal', nice: 0 };
}

/**
 * Полный набор фактических параметров запуска llama-server.
 * Используется и для args-key (решение «перезапускать ли процесс»), и для
 * панели диагностики «применённые параметры».
 */
export function resolveRuntimeParams({
  profile = 'balanced',
  file = '',
  fileSizeBytes = 0,
  totalRamBytes = 0,
  contextTokens = 0,        // запрошенный контекст (0 → минимум 512)
  cpuThreads = 0,           // профиль: 0 = авто
  cpuThreadsBatch = 0,      // профиль: 0 = авто
  numBatch = 0,             // профиль
  useMmap = 'auto',         // true | false | 'auto' | null
  cacheReuse = 0,           // --cache-reuse N (0 = выкл)
  cores = 4
} = {}) {
  const gen = resolveGenThreads({ profile, cores, explicit: cpuThreads });
  const prefill = resolvePrefillThreads({ profile, cores, explicit: cpuThreadsBatch });
  const b = resolveBatch({ profile });
  const batch = Number(numBatch) > 0 ? { batch: Number(numBatch), ubatch: b.ubatch } : b;
  const mmap = resolveMmap({ useMmap, fileSizeBytes, totalRamBytes });
  const ctx = Math.max(512, Math.floor(Number(contextTokens) || 0) || 4096);
  return {
    profile,
    file,
    contextTokens: ctx,
    threads: gen,
    threadsBatch: Math.max(gen, prefill),
    batchSize: batch.batch,
    ubatchSize: batch.ubatch,
    useMmap: mmap,
    cacheReuse: Math.max(0, Math.floor(Number(cacheReuse) || 0)),
    priority: resolvePriority(profile).level
  };
}

/**
 * Ключ запуска: все параметры, от которых зависит КОМАНДНАЯ СТРОКА llama-server.
 * Изменился ключ — процесс перезапускается с новыми аргументами (ТЗ §8).
 * Порт сознательно НЕ входит: он выбирается свободным при каждом старте.
 */
export function runtimeStartKey(p) {
  return JSON.stringify({
    file: p.file,
    ctx: p.contextTokens,
    threads: p.threads,
    threadsBatch: p.threadsBatch,
    batch: p.batchSize,
    ubatch: p.ubatchSize,
    mmap: p.useMmap,
    cacheReuse: p.cacheReuse
  });
}

/**
 * Аргументы командной строки llama-server из разрешённых параметров.
 * Порядок стабилен — упрощает диагностику и тесты.
 *
 * Режим загрузки: в llama.cpp 0.9.x (комплектный runtime) опция --no-mmap
 * удалена — вместо неё --load-mode <auto|none|mmap|mlock|mmap+mlock|dio>
 * (см. common/arg.cpp). 'auto' не передаём: это поведение llama.cpp по умолчанию.
 */
export function runtimeArgs(p) {
  const args = [
    '--model', p.file,
    '--ctx-size', String(p.contextTokens),
    '--parallel', '1',
    '--threads', String(p.threads),
    '--threads-batch', String(p.threadsBatch),
    '--batch-size', String(p.batchSize),
    '--ubatch-size', String(p.ubatchSize)
  ];
  if (p.useMmap === false) args.push('--load-mode', 'none');
  else if (p.useMmap === true) args.push('--load-mode', 'mmap');
  if (p.cacheReuse > 0) args.push('--cache-reuse', String(p.cacheReuse));
  return args;
}
