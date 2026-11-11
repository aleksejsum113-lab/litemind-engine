// Model Discovery — эвристики распознавания модели по названию репозитория
// и GGUF-файла (ТЗ v0.6.2 «Model Discovery & Auto Catalog»).
//
// Все функции чистые и детерминированные — легко тестируются. Никакой сети.
// Правило честности: если что-то распознать не удалось — возвращаем null /
// помечаем «неизвестно», а не выдумываем данные. Непонятное семейство
// позднее честно показывается как «совместимость не проверена» (compat.js).

// Семейства, у которых публикуются GGUF-кванты (порядок важен: более
// специфичные паттерны идут раньше — qwen3-coder до qwen3 и т.п.).
const FAMILY_PATTERNS = [
  [/qwen[ _-]?3\.5/i, 'qwen3.5'],
  [/qwen[ _-]?3[ _-]?coder/i, 'qwen3-coder'],
  [/qwen[ _-]?3[ _-]?vl/i, 'qwen3-vl'],
  [/qwen[ _-]?3/i, 'qwen3'],
  [/qwen[ _-]?2\.5[ _-]?coder/i, 'qwen2.5-coder'],
  [/qwen[ _-]?2\.5/i, 'qwen2.5'],
  [/qwen[ _-]?2/i, 'qwen2'],
  [/qwen/i, 'qwen'],
  [/deepseek[ _-]?r1/i, 'deepseek-r1'],
  [/deepseek[ _-]?v3/i, 'deepseek-v3'],
  [/deepseek[ _-]?coder/i, 'deepseek-coder'],
  [/deepseek/i, 'deepseek'],
  [/gemma[ _-]?3n/i, 'gemma3n'],
  [/gemma[ _-]?3/i, 'gemma3'],
  [/gemma[ _-]?2/i, 'gemma2'],
  [/gemma/i, 'gemma'],
  [/llama[ _-]?3\.5/i, 'llama3.5'],
  [/llama[ _-]?3\.3/i, 'llama3.3'],
  [/llama[ _-]?3\.2/i, 'llama3.2'],
  [/llama[ _-]?3\.1/i, 'llama3.1'],
  [/llama[ _-]?3/i, 'llama3'],
  [/llama[ _-]?2/i, 'llama2'],
  [/ministral/i, 'ministral'],
  [/mistral[ _-]?nemo/i, 'mistral-nemo'],
  [/mistral/i, 'mistral'],
  [/mixtral/i, 'mixtral'],
  [/phi[ _-]?4/i, 'phi4'],
  [/phi[ _-]?3\.5/i, 'phi3.5'],
  [/phi[ _-]?3/i, 'phi3'],
  [/phi[ _-]?2/i, 'phi2'],
  [/smollm3/i, 'smollm3'],
  [/smollm2/i, 'smollm2'],
  [/smollm/i, 'smollm'],
  [/tinyllama/i, 'tinyllama'],
  [/starcoder2/i, 'starcoder2'],
  [/starcoder/i, 'starcoder'],
  [/granite[ _-]?code/i, 'granite-code'],
  [/granite/i, 'granite'],
  [/vikhr/i, 'vikhr'],
  [/saiga/i, 'saiga'],
  [/minicpm[ _-]?v/i, 'minicpm-v'],
  [/minicpm/i, 'minicpm'],
  [/internlm/i, 'internlm'],
  [/glm[ _-]?4/i, 'glm4'],
  [/nemotron/i, 'nemotron'],
  [/olmo2/i, 'olmo2'],
  [/olmoe/i, 'olmoe'],
  [/olmo/i, 'olmo'],
  [/yandexgpt/i, 'yandexgpt'],
  [/t[ _-]?pro/i, 't-pro'],
  [/t[ _-]?lite/i, 't-lite'],
  [/gpt-?oss/i, 'gpt-oss'],
  [/bielik/i, 'bielik']
];

// «Ароматы» (flavor) — варианты моделей с особыми свойствами, важны для
// фильтров UI («Dolphin / Huihui») и пометки об ослабленных ограничениях.
export function detectFlavor(name) {
  const s = String(name || '');
  if (/huihui/i.test(s)) return 'huihui';
  if (/dolphin/i.test(s)) return 'dolphin';
  if (/abliterated/i.test(s)) return 'abliterated';
  if (/uncensored/i.test(s)) return 'uncensored';
  return null;
}

/**
 * Семейство модели по названию репозитория/файла.
 * «Huihui-Qwen3-8B-abliterated-v2» → qwen3 (flavor huihui),
 * «Dolphin3.0-Qwen3-8B» → qwen3 (flavor dolphin), неизвестное → null.
 */
export function familyFromName(name) {
  let s = String(name || '');
  const flavor = detectFlavor(s);
  if (flavor === 'dolphin') s = s.replace(/dolphin[\d.]*[-_ ]?/ig, ' ');
  // Авторский префикс HF: «bartowski/Meta-Llama-3.2-…» → «Meta-Llama-3.2-…».
  const slash = s.indexOf('/');
  if (slash > 0 && slash < s.length - 1) s = s.slice(slash + 1);
  // Вендорский префикс из имён вида «Qwen_Qwen3-0.6B», «google_gemma-3-4b».
  s = s.replace(/^[a-z][a-z0-9.]+[_ ]+(?=qwen|deepseek|gemma|llama|mistral|phi|smollm|tinyllama|starcoder|granite|dolphin|huihui|vikhr|saiga|minicpm|internlm|glm|nemotron|olmo|yandex|bielik|t[_ -]?pro|t[_ -]?lite)/i, ' ');
  for (const [re, fam] of FAMILY_PATTERNS) {
    if (re.test(s)) return fam;
  }
  return null;
}

/** Квантование из имени GGUF-файла: «…Q4_K_M.gguf» → «Q4_K_M», иначе null. */
export function quantFromFileName(fileName) {
  const base = String(fileName || '').replace(/\.gguf$/i, '');
  const m = /(?:^|[^A-Za-z0-9])(IQ[1-4]_[A-Z0-9]{1,4}|Q[1-8]_[0-9A-Z]{1,4}|F16|BF16|FP16|F32)(?:[^A-Za-z0-9]|$)/.exec(base);
  return m ? m[1].toUpperCase() : null;
}

/** Объём параметров из названия: «0.6B», «7B», «360M», «8x7B» → «0.6B»… */
export function paramsFromName(name) {
  const s = String(name || '');
  // MoE: 8x7B, 30x3.5B
  let m = /(\d+)\s*x\s*(\d+(?:[.,]\d+)?)\s*b(?![a-z])/i.exec(s);
  if (m) return `${m[1]}x${m[2].replace(',', '.')}B`;
  m = /(\d+(?:[.,]\d+)?)\s*b(?![a-z])/i.exec(s);
  if (m) return `${m[1].replace(',', '.')}B`;
  m = /(\d+(?:[.,]\d+)?)\s*m(?![a-z])/i.exec(s);
  if (m) {
    const mb = Math.round((parseFloat(m[1].replace(',', '.')) / 1000) * 100) / 100;
    return `${mb}B`;
  }
  return null;
}

/**
 * Назначения модели для фильтров (ТЗ §6): общение / программирование / тексты.
 * Кодинг — по признакам coder/code; общение — instruct/chat/thinking;
 * остальное — работа с текстом. Возвращается массив ключей.
 */
export function purposesFromName(name) {
  const s = String(name || '').toLowerCase();
  if (/coder|code[-_ ]?(llama|gemma|qwen)|starcoder|deepseek[-_ ]?coder/.test(s)) return ['coding'];
  if (/instruct|chat|thinking|assistant|reasoning|math/.test(s)) return ['chat'];
  return ['text'];
}

/** Класс скорости по объёму параметров (та же шкала, что в compat.js). */
export function speedClassOf(params) {
  const v = parseFloat(String(params ?? '0'));
  if (!Number.isFinite(v) || v <= 0) return 'fast';
  if (v >= 7) return 'slow';
  if (v >= 1) return 'medium';
  return 'fast';
}

/** Многочастный GGUF (-00001-of-00003) наш загрузчик не поддерживает. */
export function isMultiPart(name) {
  return /-\d{4,}-of-\d{4,}\.gguf$/i.test(String(name || ''));
}

/** Файлы-проекторы (mmproj) и служебные файлы не являются GGUF-моделью. */
export function isModelGgufFile(name) {
  const s = String(name || '');
  return /\.gguf$/i.test(s) && !/mmproj/i.test(s) && !isMultiPart(s);
}

/**
 * Описание модели на русском — честный шаблон без выдуманных фактов.
 * Всё, что не распознано, помечено «неизвестно».
 */
export function describeEntry({ family, params, quant, flavor, author }) {
  const fam = family ? `семейства ${family}` : 'новое семейство';
  const par = params ? ` (${params} параметров)` : '';
  const q = quant ? ` Квантование ${quant} — сжатая версия для запуска на CPU.` : ' GGUF-файл для локального запуска на CPU.';
  const fl = flavor === 'dolphin'
    ? ' Вариант Dolphin — ослабленные ограничения (uncensored).'
    : (flavor === 'huihui' || flavor === 'abliterated' || flavor === 'uncensored')
      ? ' Вариант с ослабленными ограничениями (uncensored).'
      : '';
  const who = author ? ` Автор квантования: ${author}.` : '';
  return `Модель ${fam}${par} из открытых источников, формат GGUF.${q}${fl}${who} Совместимость с вашим ПК рассчитана по реальному железу — см. оценку ниже.`;
}

/** Русские лейблы вкусов для UI. */
export const FLAVOR_LABEL = {
  dolphin: 'Dolphin',
  huihui: 'Huihui',
  abliterated: 'Abliterated',
  uncensored: 'Uncensored'
};
