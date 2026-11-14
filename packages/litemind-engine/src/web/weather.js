// LiteMind Engine — погода из открытого источника Open-Meteo (ТЗ v0.6.4 §5.2–5.3).
//
// Open-Meteo: бесплатно, без ключей и регистрации (open-meteo.com).
// Геокодирование — geocoding-api.open-meteo.com (поиск «Иркутск» → координаты),
// погода — api.open-meteo.com/v1/forecast (текущие наблюдения + суточный прогноз).
//
// Правило честности: модуль возвращает только фактические данные сервиса и
// время их получения. Если геокодирование не нашло город или сервис недоступен —
// честная ошибка. Никаких «выдуманных температур».

const GEOCODE_URL = 'https://geocoding-api.open-meteo.com/v1/search';
const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
const TIMEOUT_MS = 12_000;
const UA = 'LiteMind-Engine/0.6 (+local; user-controlled weather lookup)';

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
 * Геокодирование города: название → координаты и официальное имя.
 * @returns {null|{latitude, longitude, name, admin1, country, countryCode}}
 */
export async function geocodePlace(place, { fetchImpl = fetch, timeoutMs = TIMEOUT_MS } = {}) {
  const name = String(place ?? '').trim();
  if (!name) throw new Error('не указано место для поиска погоды');
  if (name.length > 100) throw new Error('название места слишком длинное');
  const url = `${GEOCODE_URL}?name=${encodeURIComponent(name)}&count=1&language=ru&format=json`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error('таймаут геокодирования')), timeoutMs);
  try {
    const res = await fetchImpl(url, { signal: ctrl.signal, headers: { 'user-agent': UA, accept: 'application/json' } });
    if (!res.ok) throw new Error(`сервис геокодирования: HTTP ${res.status}`);
    const j = await res.json();
    const hit = (j.results ?? [])[0];
    if (!hit) return null;
    return {
      latitude: msToNumber(hit.latitude),
      longitude: msToNumber(hit.longitude),
      name: String(hit.name ?? name),
      admin1: hit.admin1 ? String(hit.admin1) : null,
      country: hit.country ? String(hit.country) : null,
      countryCode: hit.country_code ? String(hit.country_code) : null
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Текущая погода для координат. Возвращает структуру с готовым текстовым
 * резюме на русском и метаданными источника (для отображения в чате):
 * { place, observedAt (локальное время сервиса), retrievedAt (UTC), temperatureC,
 *   apparentC, humidityPct, windKph, description, source, summary }
 */
export async function currentWeather(place, { fetchImpl = fetch, timeoutMs = TIMEOUT_MS } = {}) {
  const geo = await geocodePlace(place, { fetchImpl, timeoutMs });
  if (!geo) {
    throw new Error(`место «${place}» не найдено в геокодере Open-Meteo — уточните название города`);
  }
  const params = new URLSearchParams({
    latitude: String(geo.latitude),
    longitude: String(geo.longitude),
    current: 'temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m,is_day',
    timezone: 'auto',
    forecast_days: '1'
  });
  const url = `${FORECAST_URL}?${params}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error('таймаут запроса погоды')), timeoutMs);
  try {
    const res = await fetchImpl(url, { signal: ctrl.signal, headers: { 'user-agent': UA, accept: 'application/json' } });
    if (!res.ok) throw new Error(`сервис погоды: HTTP ${res.status}`);
    const j = await res.json();
    const cur = j.current ?? {};
    const temperatureC = msToNumber(cur.temperature_2m);
    if (temperatureC == null) throw new Error('сервис погоды не вернул текущую температуру');
    const description = describeWeatherCode(cur.weather_code);
    const placeName = [geo.name, geo.admin1, geo.country].filter(Boolean).join(', ');
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
  } finally {
    clearTimeout(timer);
  }
}
