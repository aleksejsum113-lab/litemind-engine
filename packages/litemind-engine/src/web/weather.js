// LiteMind Engine — погода из открытого источника Open-Meteo (ТЗ v0.6.4 §5.2–5.3).
//
// Open-Meteo: бесплатно, без ключей и регистрации (open-meteo.com).
// Геокодирование — geocoding-api.open-meteo.com (поиск «Иркутск» → координаты),
// резервный геокодер — Nominatim (OpenStreetMap, тоже без ключей): разные сети
// блокируют разные хосты, поэтому цепочка обязательна. Погода —
// api.open-meteo.com/v1/forecast (текущие наблюдения + суточный прогноз).
//
// Правило честности: модуль возвращает только фактические данные сервиса и
// время их получения. Если геокодирование не нашло город или сервис недоступен —
// честная ошибка. Никаких «выдуманных температур».

const GEOCODE_URL = 'https://geocoding-api.open-meteo.com/v1/search';
const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';
const TIMEOUT_MS = 12_000;
const RETRY_ATTEMPTS = 3;
const RETRY_DELAY_MS = 600;
const UA = 'LiteMind-Engine/0.6 (+local; user-controlled weather lookup)';
// Nominatim требует опознаваемый User-Agent с контактом (политика OSM).
const NOMINATIM_UA = 'LiteMind-Engine/0.6 (local desktop assistant; user-initiated geocoding)';

/** Коды погоды WMO → человеческое описание (официальная таблица Open-Meteo). */
export const WMO_CODES = {
  0: 'ясно',
  1: 'преимущественно ясно',
  2: 'переменная облачность',
  3: 'пасмурно',
  45: 'туман',
  48: 'туман с изморозью',
  51: 'слабая морось',
  53: 'морось',
  55: 'сильная морось',
  56: 'ледяная морось',
  57: 'сильная ледяная морось',
  61: 'слабый дождь',
  63: 'дождь',
  65: 'сильный дождь',
  66: 'ледяной дождь',
  67: 'сильный ледяной дождь',
  71: 'слабый снег',
  73: 'снег',
  75: 'сильный снег',
  77: 'снежные зёрна',
  80: 'слабый ливень',
  81: 'ливень',
  82: 'сильный ливень',
  85: 'слабый снегопад',
  86: 'сильный снегопад',
  95: 'гроза',
  96: 'гроза с градом',
  99: 'сильная гроза с градом'
};

export function describeWeatherCode(code) {
  return WMO_CODES[Number(code)] ?? `код погоды ${code}`;
}

function msToNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Повторная попытка при сетевых сбоях (ETIMEDOUT/ECONNRESET): отдельные сети
 * роняют соединение нестабильно — один ретрай-цикл спасает запрос, а честная
 * ошибка формируется только когда не сработала вся цепочка источников.
 */
async function withRetry(fn, { attempts = RETRY_ATTEMPTS, delayMs = RETRY_DELAY_MS } = {}) {
  let lastErr = null;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      // HTTP-ответы 4xx (кроме 408/429) повторять бессмысленно — это не сбой сети.
      const m = /HTTP (\d+)/i.exec(String(err?.message ?? ''));
      const status = m ? Number(m[1]) : null;
      if (status && status !== 408 && status !== 429 && status < 500) throw err;
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, delayMs * (i + 1)));
    }
  }
  throw lastErr;
}

/**
 * Геокодирование города: название → координаты и официальное имя.
 * Цепочка бесплатных источников без ключей: Open-Meteo → Nominatim (OSM),
 * для каждой — все падежные варианты названия (placeCandidates).
 * @returns {null|{latitude, longitude, name, admin1, country, countryCode, geocoder}}
 */
export async function geocodePlace(place, { fetchImpl = fetch, timeoutMs = TIMEOUT_MS, retryAttempts = RETRY_ATTEMPTS, retryDelayMs = RETRY_DELAY_MS } = {}) {
  const name = String(place ?? '').trim();
  if (!name) throw new Error('не указано место для поиска погоды');
  if (name.length > 100) throw new Error('название места слишком длинное');

  const candidates = placeCandidates(name);
  let lastErr = null;

  async function fetchJson(url, headers) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(new Error('таймаут геокодирования')), timeoutMs);
    try {
      const res = await fetchImpl(url, { signal: ctrl.signal, headers });
      if (!res.ok) throw new Error(`сервис геокодирования: HTTP ${res.status}`);
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  // Источник 1: геокодер Open-Meteo (по всем падежным вариантам).
  for (const q of candidates) {
    try {
      const url = `${GEOCODE_URL}?name=${encodeURIComponent(q)}&count=1&language=ru&format=json`;
      const hit = await withRetry(async () => (await fetchJson(url, { 'user-agent': UA, accept: 'application/json' })).results?.[0] ?? null,
        { attempts: retryAttempts, delayMs: retryDelayMs });
      if (hit) {
        return {
          latitude: msToNumber(hit.latitude),
          longitude: msToNumber(hit.longitude),
          name: String(hit.name ?? name),
          admin1: hit.admin1 ? String(hit.admin1) : null,
          country: hit.country ? String(hit.country) : null,
          countryCode: hit.country_code ? String(hit.country_code) : null,
          geocoder: 'open-meteo'
        };
      }
    } catch (err) {
      lastErr = err;
    }
  }

  // Источник 2: Nominatim (OpenStreetMap) — независимый индекс. Сначала
  // featuretype=city (только города — без POI вроде «Кирпич в Иркутске»),
  // затем свободный поиск; приоритет у объектов класса place.
  async function osmHit(q, cityOnly) {
    const url = `${NOMINATIM_URL}?q=${encodeURIComponent(q)}&format=jsonv2&limit=${cityOnly ? 3 : 5}&accept-language=ru${cityOnly ? '&featuretype=city' : ''}`;
    const j = await withRetry(() => fetchJson(url, { 'user-agent': NOMINATIM_UA, accept: 'application/json' }),
      { attempts: retryAttempts, delayMs: retryDelayMs });
    const arr = Array.isArray(j) ? j : [];
    if (!arr.length) return null;
    return arr.find((x) => x?.class === 'place') ?? arr[0];
  }

  try {
    // Сначала пробуем все падежные варианты как города — POI вида
    // «Кирпич в Иркутске» не должен перебить настоящий город.
    for (const cityOnly of [true, false]) {
      for (const q of candidates) {
        const hit = await osmHit(q, cityOnly);
        const lat = msToNumber(hit?.lat);
        const lon = msToNumber(hit?.lon);
        if (hit && lat != null && lon != null) {
          return {
            latitude: lat,
            longitude: lon,
            name: String(hit.name || name),
            admin1: null,
            country: null,
            countryCode: null,
            geocoder: 'nominatim'
          };
        }
      }
    }
  } catch (err) {
    lastErr = err;
  }

  if (lastErr) throw lastErr;
  return null; // все геокодеры ответили, но место не нашли
}

/** Место задано готовыми координатами (пропускаем геокодирование). */
export function placeHasCoordinates(place) {
  if (!place || typeof place !== 'object') return false;
  return Number.isFinite(Number(place.latitude)) && Number.isFinite(Number(place.longitude));
}

/**
 * Варианты названия места для геокодеров: пользователь пишет «в Иркутске»
 * (предложный падеж), а геокодеры ищут именительный («Иркутск»). Экономный
 * русский морфологический набор: как есть, основа, основа+«а» (родительный).
 * «Иркутске» → [Иркутске, Иркутск, Иркутска]; «Москве» → [Москве, Москв, Москва].
 */
export function placeCandidates(name) {
  const raw = String(name ?? '').trim();
  const list = [raw];
  const m = raw.match(/^(.+[^ауеиыэюяёъь])е$/u); // согласная + «е» на конце
  if (m) {
    list.push(m[1]);        // Иркутске → Иркутск, Омске → Омск
    list.push(m[1] + 'а');  // Москве → Москва
  }
  return [...new Set(list.filter(Boolean))];
}

/**
 * Текущая погода для места. Место — строка (геокодирование по цепочке
 * Open-Meteo → Nominatim) или объект {name, latitude, longitude} (прямо по
 * координатам). Возвращает структуру с готовым текстовым резюме на русском и
 * метаданными источника (для отображения в чате):
 * { place, observedAt (локальное время сервиса), retrievedAt (UTC), temperatureC,
 *   apparentC, humidityPct, windKph, description, source, summary }
 */
export async function currentWeather(place, { fetchImpl = fetch, timeoutMs = TIMEOUT_MS, retryAttempts = RETRY_ATTEMPTS, retryDelayMs = RETRY_DELAY_MS } = {}) {
  let geo;
  if (placeHasCoordinates(place)) {
    geo = {
      latitude: Number(place.latitude),
      longitude: Number(place.longitude),
      name: String(place.name ?? 'выбранное место'),
      admin1: null,
      country: null,
      countryCode: null,
      geocoder: 'coordinates'
    };
  } else {
    geo = await geocodePlace(place, { fetchImpl, timeoutMs, retryAttempts, retryDelayMs });
    if (!geo) {
      throw new Error(`место «${place}» не найдено в геокодерах Open-Meteo и OSM — уточните название города`);
    }
  }
  const params = new URLSearchParams({
    latitude: String(geo.latitude),
    longitude: String(geo.longitude),
    current: 'temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m,is_day',
    timezone: 'auto',
    forecast_days: '1'
  });
  const url = `${FORECAST_URL}?${params}`;
  const j = await withRetry(async () => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(new Error('таймаут запроса погоды')), timeoutMs);
    try {
      const res = await fetchImpl(url, { signal: ctrl.signal, headers: { 'user-agent': UA, accept: 'application/json' } });
      if (!res.ok) throw new Error(`сервис погоды: HTTP ${res.status}`);
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }, { attempts: retryAttempts, delayMs: retryDelayMs });
  const cur = j.current ?? {};
  const temperatureC = msToNumber(cur.temperature_2m);
  if (temperatureC == null) throw new Error('сервис погоды не вернул текущую температуру');
  const description = describeWeatherCode(cur.weather_code);
  const placeName = [geo.name, geo.admin1, geo.country].filter(Boolean).join(', ') || 'выбранное место';
  const observedAt = String(cur.time ?? '');
  const retrievedAt = new Date().toISOString();
  const bits = [
    `${temperatureC > 0 ? '+' : ''}${Math.round(temperatureC)} °C`,
    description,
    cur.apparent_temperature != null ? `ощущается как ${Math.round(Number(cur.apparent_temperature))} °C` : null,
    cur.wind_speed_10m != null ? `ветер ${Math.round(Number(cur.wind_speed_10m))} км/ч` : null,
    cur.relative_humidity_2m != null ? `влажность ${Math.round(Number(cur.relative_humidity_2m))}%` : null
  ].filter(Boolean);
  return {
    place: placeName,
    latitude: geo.latitude,
    longitude: geo.longitude,
    geocoder: geo.geocoder,
    observedAt,
    retrievedAt,
    temperatureC: Math.round(temperatureC * 10) / 10,
    apparentC: cur.apparent_temperature != null ? Math.round(Number(cur.apparent_temperature) * 10) / 10 : null,
    humidityPct: cur.relative_humidity_2m != null ? Math.round(Number(cur.relative_humidity_2m)) : null,
    windKph: cur.wind_speed_10m != null ? Math.round(Number(cur.wind_speed_10m)) : null,
    weatherCode: cur.weather_code ?? null,
    description,
    source: 'https://open-meteo.com',
    summary: `Погода в ${placeName}: ${bits.join(', ')}.`
  };
}
