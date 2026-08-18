export const OPEN_METEO_ENDPOINT = 'https://api.open-meteo.com/v1/forecast';
export const RAINFALL_POINT_COUNT = 25;
export const WEATHER_REFRESH_INTERVAL_MS = 10 * 60 * 1000;

export function buildOpenMeteoUrl({ latitude, longitude }) {
  const url = new URL(OPEN_METEO_ENDPOINT);
  url.search = new URLSearchParams({
    latitude: String(latitude),
    longitude: String(longitude),
    current: 'precipitation',
    hourly: 'precipitation',
    past_days: '1',
    forecast_days: '2',
    timezone: 'auto'
  });
  return url.toString();
}

function normalizePrecipitation(value, label) {
  const normalized = Number(value);
  if (!Number.isFinite(normalized) || normalized < 0) {
    throw new TypeError(`${label} must be a finite non-negative number`);
  }
  return normalized;
}

function localHourKey(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value)) {
    throw new TypeError('Open-Meteo returned an invalid local time');
  }
  return value.slice(0, 13);
}

function addDays(dateKey, days) {
  const date = new Date(`${dateKey}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) throw new TypeError('Open-Meteo returned an invalid date');
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function curveHourKey(dateKey, hour) {
  if (hour === 24) return `${addDays(dateKey, 1)}T00`;
  return `${dateKey}T${String(hour).padStart(2, '0')}`;
}

export function extractRainfallCurve(payload) {
  const current = payload?.current;
  const hourly = payload?.hourly;
  if (!current || !hourly || !Array.isArray(hourly.time) || !Array.isArray(hourly.precipitation)) {
    throw new TypeError('Open-Meteo response is missing current or hourly precipitation data');
  }
  if (hourly.time.length !== hourly.precipitation.length) {
    throw new TypeError('Open-Meteo hourly time and precipitation data must have matching lengths');
  }

  const currentTime = String(current.time);
  const currentHourKey = localHourKey(currentTime);
  const dateKey = currentHourKey.slice(0, 10);
  const hourlyValues = new Map();

  hourly.time.forEach((time, index) => {
    const key = localHourKey(time);
    hourlyValues.set(key, normalizePrecipitation(
      hourly.precipitation[index],
      `Precipitation at ${time}`
    ));
  });

  const values = Array.from({ length: RAINFALL_POINT_COUNT }, (_, hour) => {
    const key = curveHourKey(dateKey, hour);
    if (!hourlyValues.has(key)) {
      throw new TypeError(`Open-Meteo response cannot provide 25 rainfall points; missing ${key}`);
    }
    return hourlyValues.get(key);
  });

  const currentPrecipitation = normalizePrecipitation(
    current.precipitation,
    'Current precipitation'
  );
  const currentHour = Number(currentHourKey.slice(11, 13));
  if (currentHour >= 0 && currentHour < 24) values[currentHour] = currentPrecipitation;

  return {
    values,
    currentPrecipitation,
    currentTime,
    timezone: payload.timezone || 'auto',
    timezoneAbbreviation: payload.timezone_abbreviation || ''
  };
}

export async function fetchLiveRainfall({ latitude, longitude, fetchImpl = globalThis.fetch }) {
  if (typeof fetchImpl !== 'function') throw new TypeError('A fetch implementation is required');

  const response = await fetchImpl(buildOpenMeteoUrl({ latitude, longitude }), {
    headers: { Accept: 'application/json' }
  });
  if (!response?.ok) {
    throw new Error(`Open-Meteo request failed: ${response?.status ?? 'unknown'}`);
  }

  return extractRainfallCurve(await response.json());
}

export function requestBrowserLocation(
  geolocation = globalThis.navigator?.geolocation
) {
  return new Promise((resolve, reject) => {
    if (!geolocation || typeof geolocation.getCurrentPosition !== 'function') {
      reject(new Error('Browser geolocation is unavailable'));
      return;
    }

    geolocation.getCurrentPosition(
      ({ coords }) => {
        const latitude = Number(coords?.latitude);
        const longitude = Number(coords?.longitude);
        if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
          reject(new Error('Browser geolocation returned invalid coordinates'));
          return;
        }
        resolve({ latitude, longitude });
      },
      (error) => {
        const detail = error?.message || error?.code || 'unknown error';
        const wrapped = new Error(`Browser geolocation failed: ${detail}`);
        wrapped.code = error?.code;
        reject(wrapped);
      },
      {
        enableHighAccuracy: false,
        timeout: 10000,
        maximumAge: 10 * 60 * 1000
      }
    );
  });
}

export function createLiveWeatherController({
  requestLocation = () => requestBrowserLocation(),
  fetchWeather = coordinates => fetchLiveRainfall(coordinates),
  onData = () => {},
  onStatus = () => {},
  setIntervalImpl = globalThis.setInterval,
  clearIntervalImpl = globalThis.clearInterval,
  refreshIntervalMs = WEATHER_REFRESH_INTERVAL_MS
} = {}) {
  let coordinates = null;
  let refreshTimer = null;
  let inFlight = null;
  let stopped = false;

  function ensureRefreshTimer() {
    if (
      refreshTimer !== null
      || !coordinates
      || typeof setIntervalImpl !== 'function'
      || stopped
    ) return;
    refreshTimer = setIntervalImpl(() => {
      refresh();
    }, refreshIntervalMs);
  }

  async function runRefresh() {
    if (stopped) return null;
    onStatus({ state: 'loading' });

    try {
      if (!coordinates) coordinates = await requestLocation();
      if (stopped) return null;
      ensureRefreshTimer();
      const data = await fetchWeather(coordinates);
      if (stopped) return null;
      onData(data, coordinates);
      onStatus({ state: 'ready', data, coordinates });
      return data;
    } catch (error) {
      if (stopped) return null;
      const state = error?.code === 1
        ? 'denied'
        : /unavailable/i.test(error?.message || '') ? 'unavailable' : 'error';
      onStatus({ state, error });
      return null;
    }
  }

  function refresh() {
    if (stopped) return Promise.resolve(null);
    if (inFlight) return inFlight;
    const request = runRefresh();
    const tracked = request.finally(() => {
      if (inFlight === tracked) inFlight = null;
    });
    inFlight = tracked;
    return tracked;
  }

  function start() {
    stopped = false;
    return refresh();
  }

  function stop() {
    stopped = true;
    if (refreshTimer !== null && typeof clearIntervalImpl === 'function') {
      clearIntervalImpl(refreshTimer);
    }
    refreshTimer = null;
  }

  return { start, refresh, stop };
}
