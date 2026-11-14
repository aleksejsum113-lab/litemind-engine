// LiteMind Engine — разбор дат/времени на русском для напоминаний
// (ТЗ v0.6.4, компаньон §4: «Напомни завтра в 10:00 позвонить»,
// «Каждый будний день в 9:00», «через 5 минут»).
//
// Чистая функция без зависимостей; возвращает { dueAt: Date|null, repeat, text }
// где text — остаток поручения без временной части. Никогда не придумывает
// дату: если время не распознано — dueAt = null (задача без напоминания).

const WEEKDAYS = ['воскресенье', 'понедельник', 'вторник', 'среду', 'четверг', 'пятницу', 'субботу'];
const WEEKDAYS_ACC = { понедельник: 1, вторник: 2, среду: 3, четверг: 4, пятницу: 5, субботу: 6, воскресенье: 0 };

function todayAt(hours, minutes) {
  const d = new Date();
  d.setSeconds(0, 0);
  d.setHours(hours, minutes, 0, 0);
  return d;
}

function addDays(d, n) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

/** «10:00», «в 9», «в 9:30 утра», «в 14:00» → { h, m } | null */
function parseClockTime(text) {
  const m = String(text).match(/(?:^|[\s(])(?:в|во\s+)?(\d{1,2})[:.](\d{2})\s*(?:утра|дня|вечера|ночи)?/i);
  if (m) {
    const h = Number(m[1]);
    const mm = Number(m[2]);
    if (h >= 0 && h <= 23 && mm >= 0 && mm <= 59) return { h, m: mm };
  }
  const m2 = String(text).match(/(?:^|\s)(?:в|во)\s+(\d{1,2})\s+(?:утра|дня|вечера|ночи)/i);
  if (m2) {
    let h = Number(m2[1]);
    const part = m2[2].toLowerCase();
    if (part === 'вечера' && h < 12) h += 12;
    if (part === 'дня' && h < 12) h += 12;
    if (part === 'ночи' && h === 12) h = 0;
    if (h >= 0 && h <= 23) return { h, m: 0 };
  }
  return null;
}

/**
 * Разбор поручения с датой/временем.
 * Поддержано: «сегодня/завтра/послезавтра в HH:MM», «через N мин|минут|час|часов|дней»,
 * «каждый день|ежедневно в HH:MM», «каждый будний день в HH:MM», «каждую неделю|по X в HH:MM»,
 * «в HH:MM» (сегодня или завтра, если время уже прошло — pragmatic: сегодня).
 */
export function parseReminder(rawText, { now = new Date() } = {}) {
  const text = String(rawText ?? '').trim();
  let repeat = 'none';
  let dayOffset = null;
  let weekday = null;

  if (/кажд(ый|ую|ые)?\s*(будни[хйм]*\s*день|будни|рабочий день)|по будням/i.test(text)) repeat = 'weekdays';
  else if (/кажд(ый|ую)?\s*день|ежедневно|каждодневно/i.test(text)) repeat = 'daily';
  else if (/кажд(ую)?\s*недел|еженедельно|по\s+(понедельникам|вторникам|средам|четвергам|пятницам|субботам|выходным)/i.test(text)) repeat = 'weekly';

  if (/послезавтра/i.test(text)) dayOffset = 2;
  else if (/завтра/i.test(text)) dayOffset = 1;
  else if (/сегодня/i.test(text)) dayOffset = 0;

  if (repeat === 'weekly') {
    for (const [name, idx] of Object.entries(WEEKDAYS_ACC)) {
      if (new RegExp(`\\b${name}\\b`, 'i').test(text)) { weekday = idx; break; }
      // родительный: «по средам» — форма во мн.ч.; приведём основу
      if (new RegExp(`по\\s+${name.slice(0, Math.max(4, name.length - 2))}`, 'i').test(text)) { weekday = idx; break; }
    }
  }

  // «через N минут/часов/дней»
  const rel = text.match(/через\s+(\d{1,4})\s*(мин(?:ут[уы]?|ута)?|мин|сек(?:унд[уы]?|да)?|час[аов]*|дн[ейя]+|день)/i);
  let dueAt = null;
  const time = parseClockTime(text);

  if (rel) {
    const n = Number(rel[1]);
    const unit = rel[2].toLowerCase();
    dueAt = new Date(now.getTime());
    if (/сек/.test(unit)) dueAt.setSeconds(dueAt.getSeconds() + n);
    else if (/мин/.test(unit)) dueAt.setMinutes(dueAt.getMinutes() + n);
    else if (/час/.test(unit)) dueAt.setHours(dueAt.getHours() + n);
    else dueAt.setDate(dueAt.getDate() + n);
  } else if (time) {
    dueAt = todayAt(time.h, time.m);
    if (dayOffset != null) dueAt = addDays(dueAt, dayOffset);
    if (weekday != null && repeat === 'weekly') {
      // ближайший указанный день недели
      const delta = (weekday - dueAt.getDay() + 7) % 7;
      dueAt = addDays(dueAt, delta || 7);
    }
    if (!dayOffset && weekday == null && dueAt <= now) {
      // «в 18:30» без дня: если время уже прошло — завтра (разумное поведение будильника)
      dueAt = addDays(dueAt, 1);
    }
  } else if (dayOffset != null) {
    dueAt = addDays(todayAt(9, 0), dayOffset); // без времени — 9 утра как честный дефолт
  } else if (repeat !== 'none') {
    // повтор без времени — в 9:00
    dueAt = todayAt(9, 0);
    if (dueAt <= now) dueAt = addDays(dueAt, 1);
  } else if (/(?:^|\s)напомн/i.test(text)) {
    // «напомни …» без времени — завтра к 9:00 (разумный дефолт будильника)
    dueAt = addDays(todayAt(9, 0), 1);
  }
  if (dueAt && repeat === 'weekdays') {
    // будний день: сб 0? нет — 6 и вс 0 сдвигаем к понедельнику
    while (dueAt.getDay() === 0 || dueAt.getDay() === 6) dueAt = addDays(dueAt, 1);
  }

  // Очистка текста от временной конструкции (для показа пользователю).
  let clean = text
    .replace(/^напомни(?:ть)?(?: мне)?[,\s]*/i, '')
    .replace(/^(создай|поставь)\s+(задач[уаи]*|напоминани[ея])\s*/i, '')
    .replace(/(кажд(ый|ую|ые)?\s*(будни[хйм]*\s*день|будни|рабочий день|день|недел[юу]))|ежедневно|еженедельно|по будням|по\s+(понедельникам|вторникам|средам|четвергам|пятницам|субботам|выходным)/gi, '')
    .replace(/(сегодня|завтра|послезавтра)/gi, '')
    .replace(/через\s+\d{1,4}\s*(мин(?:ут[уы]?|ута)?|мин|сек(?:унд[уы]?|да)?|час[аов]*|дн[ейя]+|день)/gi, '')
    .replace(/(?:^|[\s(])(?:в|во|at)\s*\d{1,2}[:.]\d{2}\s*(?:утра|дня|вечера|ночи)?/gi, '')
    .replace(/(?:^|\s)(?:в|во)\s+\d{1,2}\s+(?:утра|дня|вечера|ночи)/gi, '')
    .replace(/,\s*\.|\.\s*,/g, '.')
    .replace(/\s{2,}/g, ' ')
    .replace(/^[\s,.:;-]+|[\s,.:;-]+$/g, '')
    .trim();

  return { dueAt, repeat, text: clean };
}

/** Человекочитаемое время напоминания (для уведомлений и UI). */
export function formatWhen(dueAt, repeat) {
  if (!dueAt) return 'без напоминания';
  const d = new Date(dueAt);
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const day = d.toDateString() === new Date().toDateString() ? 'сегодня' : d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
  const rep = { none: '', daily: ' ежедневно', weekdays: ' по будням', weekly: ' еженедельно' }[repeat] ?? '';
  return `${day} в ${hm}${rep}`;
}
