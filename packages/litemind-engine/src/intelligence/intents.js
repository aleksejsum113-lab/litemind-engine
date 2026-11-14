// LiteMind Intelligence Layer — детерминированная классификация запросов (ТЗ v0.6.4, дополнение §1).
//
// На слабом ПК классификация должна стоить 0 мс и 0 токенов: эвристики на
// регулярных выражениях, БЕЗ вызова модели. Модель затем получает готовые
// факты (погоду, результаты поиска, вычисление) и формулирует ответ —
// «инструменты вместо слабого рассуждения».
//
// Интенты: weather | search | clock | math | remember | task | screen | windows
//          | open | image | code | chat (по умолчанию).

const PLACE_AFTER = /(?:в|во|для|по)\s+([A-ZА-ЯЁ][\wёЁ-]*(?:\s+[A-ZА-ЯЁ][\wёЁ-]*)?)/u;

const WEATHER_RE = /погод[аыуое]|температур[аыеу]|на улице (сейчас|тепло|холодно)|сколько градусов|прогноз погоды|сейчас (на дворе|снаружи)|weather|forecast|дожд|снегопад|ветер(но)?\s+(сейчас|будет)|облачность/i;
const CLOCK_RE = /котор(ый|ое)\s+(час|время)|какое (сегодня )?(время|число|дата)|какой (сегодня )?день|время сейчас|дата сегодня|что (за )?день недели/i;
const SEARCH_RE = /найд[иите]|поищи|поиск[а-я]*|погугли|search|найди в интернете|новости|что нового про|последние (новости|версии|события)|актуальн[аыеоу]* (данные|сведения|информация|новости)|курс (валют|доллара|евро|биткоина)|цена на|сколько стоит|кто такой|что такое — не\s|\bгугл\b/i;
const MATH_RE = /вычисли|посчитай|сколько будет|calculate|compute|\d+\s*[+\-*/^%]\s*\d+/i;
const REMEMBER_RE = /^\s*(запомни(?:ть)?|запиши|помни|не забудь)/i;
const TASK_RE = /напомни(?:ть)?(?: мне)?(?: завтра| сегодня| в \d| через \d| каждый| по (понедельникам|вторникам|средам|четвергам|пятницам|выходным))|напоминание|поставь (задач|напомин)|создай (задач|напомин)|м(?:ои)? задач|задачи на (сегодня|завтра)|what.*(?:remind|todo)/i;
const SCREEN_RE = /посмотри на экран|что (у меня |сейчас )?на экране|что открыто (на экране|у меня)|объясни,? что на экране|видишь (мой )?экран|помоги (найти|нажать) (кнопку|пункт)|где (на экране|здесь) (кнопка|настройк|пункт)|какая (кнопка|клавиша)/i;
const OPEN_RE = /^\s*(открой|открыть|запусти|запустить|включи)\s+/i;
const WINDOWS_RE = /переключись на|закрой (окно|программ|прилож)|нажми (кнопк|пункт)|введи текст|напечатай|впиши в|кликн(и|у) на/i;
const IMAGE_RE = /нарисуй|сгенерируй (картин|изображ)|создай изображение|нарисуйте|generate (an? )?image|draw (a|an)\b.*picture/i;
const CODE_RE = /```|напиши (функци|код|скрипт|класс)|исправь (код|ошибку|баг)|ошибка (в |при )?(компиля|запуск|скрипт)|traceback|stack ?trace|undefin(ed|ed variable)|TypeError|function |class |import |const |def /i;

/** Извлечь название места из запроса о погоде. */
export function extractWeatherPlace(text) {
  const s = String(text ?? '');
  let m = s.match(/(?:погод[аыуое]|температур[аыеу]|прогноз[^,.!?]*|сколько градусов|weather|forecast)\s+(?:сейчас\s+)?(?:в|во|для|по|над)\s+([^,.!?!?]+?)(?:\s*(?:сейчас|сегодня|завтра|поточнее|\?|$))/i);
  if (!m) {
    // «Какая погода в Иркутске» — падежный хвост после предлога «в».
    m = s.match(PLACE_AFTER);
  }
  if (m && m[1]) {
    let place = m[1].trim()
      // «в Иркутске прямо сейчас» — наречия времени не часть названия места
      // (smoke comp064: геокодеры не нашли «Иркутске прямо» → честный отказ
      // вместо данных сервиса).
      .replace(/\s+(прямо\s+)?(сейчас|сегодня|завтра)$/i, '')
      .replace(/\s+прямо$/i, '')
      .trim();
    // «городе Москве» → «Москве»; приводить падежи не будем — геокодер Open-Meteo
    // устойчив к ним, но срежем явно лишние слова.
    place = place.replace(/^(город[аеу]?|г\.?|городе)\s+/i, '');
    if (place && place.length <= 64) return place;
  }
  // Погодный запрос без места: пусть геокодер получит null → UI попросит город,
  // а НЕЛЬЗЯ выдумывать «погоду по умолчанию» (ТЗ §5.3).
  return null;
}

/**
 * Классифицировать запрос пользователя.
 * @returns {{intent: string, reason: string, web: boolean, slots: object}}
 */
export function classifyIntent(text, { webEnabled = false, forceWeb = false } = {}) {
  const s = String(text ?? '');
  const slots = {};

  if (WEATHER_RE.test(s)) {
    slots.place = extractWeatherPlace(s);
    return { intent: 'weather', reason: 'запрос о погоде', web: true, slots };
  }
  if (CLOCK_RE.test(s)) {
    return { intent: 'clock', reason: 'время/дата — знает сам компьютер', web: false, slots };
  }
  if (REMEMBER_RE.test(s)) {
    slots.content = s.replace(REMEMBER_RE, '').trim();
    return { intent: 'remember', reason: 'просьба запомнить', web: false, slots };
  }
  if (TASK_RE.test(s)) {
    return { intent: 'task', reason: 'задача/напоминание', web: false, slots };
  }
  if (SCREEN_RE.test(s)) {
    return { intent: 'screen', reason: 'просьба посмотреть на экран', web: false, slots };
  }
  if (OPEN_RE.test(s) || WINDOWS_RE.test(s)) {
    return { intent: 'windows', reason: 'управление Windows/приложениями', web: false, slots };
  }
  if (IMAGE_RE.test(s)) {
    return { intent: 'image', reason: 'просьба создать изображение', web: false, slots };
  }
  const hasMathSignals = MATH_RE.test(s) && /\d/.test(s);
  const bareExpression = /^[\d\s+\-*/^%().,]+$/.test(s.trim()) && /\d/.test(s) && /[+\-*/^%]/.test(s);
  if (hasMathSignals || bareExpression) {
    return { intent: 'math', reason: 'вычисление — сделает калькулятор точно', web: false, slots };
  }
  // Поиск: явные маркеры ИЛИ включённый глобус + вопрос об актуальных данных.
  const currentAffairs = /сейчас|сегодня|последн|актуальн|новост|сколько (стоит|стоит сейчас)|цена|курс/i.test(s);
  if (webEnabled && (SEARCH_RE.test(s) || (forceWeb && currentAffairs))) {
    return { intent: 'search', reason: 'нужны актуальные сведения из интернета', web: true, slots };
  }
  if (CODE_RE.test(s)) {
    return { intent: 'code', reason: 'программирование', web: false, slots };
  }
  return { intent: 'chat', reason: 'обычный разговор', web: false, slots };
}
