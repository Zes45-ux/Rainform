import test from 'node:test';
import assert from 'node:assert/strict';

let weather;
try {
  weather = await import('../src/weather.js');
} catch {
  weather = {};
}

test('buildOpenMeteoUrl requests current and hourly precipitation for a location', () => {
  assert.equal(typeof weather.buildOpenMeteoUrl, 'function');

  const url = new URL(weather.buildOpenMeteoUrl({ latitude: 31.2304, longitude: 121.4737 }));

  assert.equal(url.origin, 'https://api.open-meteo.com');
  assert.equal(url.pathname, '/v1/forecast');
  assert.equal(url.searchParams.get('latitude'), '31.2304');
  assert.equal(url.searchParams.get('longitude'), '121.4737');
  assert.equal(url.searchParams.get('current'), 'precipitation');
  assert.equal(url.searchParams.get('hourly'), 'precipitation');
  assert.equal(url.searchParams.get('timezone'), 'auto');
});

const rainfallPayload = {
  latitude: 31.2304,
  longitude: 121.4737,
  timezone: 'Asia/Shanghai',
  current: {
    time: '2026-08-19T15:00',
    precipitation: 6.4
  },
  hourly: {
    time: [
      '2026-08-18T23:00',
      '2026-08-19T00:00',
      '2026-08-19T01:00',
      '2026-08-19T02:00',
      '2026-08-19T03:00',
      '2026-08-19T04:00',
      '2026-08-19T05:00',
      '2026-08-19T06:00',
      '2026-08-19T07:00',
      '2026-08-19T08:00',
      '2026-08-19T09:00',
      '2026-08-19T10:00',
      '2026-08-19T11:00',
      '2026-08-19T12:00',
      '2026-08-19T13:00',
      '2026-08-19T14:00',
      '2026-08-19T15:00',
      '2026-08-19T16:00',
      '2026-08-19T17:00',
      '2026-08-19T18:00',
      '2026-08-19T19:00',
      '2026-08-19T20:00',
      '2026-08-19T21:00',
      '2026-08-19T22:00',
      '2026-08-19T23:00',
      '2026-08-20T00:00'
    ],
    precipitation: [
      9.9, 0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7,
      0.8, 0.9, 1.0, 1.1, 1.2, 1.3, 1.4, 1.5, 1.6,
      1.7, 1.8, 1.9, 2.0, 2.1, 2.2, 2.3, 2.4
    ]
  }
};

test('extractRainfallCurve returns the current local day and keeps current precipitation separate', () => {
  assert.equal(typeof weather.extractRainfallCurve, 'function');

  const result = weather.extractRainfallCurve(rainfallPayload);

  assert.deepEqual(result.values, [
    0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8,
    0.9, 1.0, 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7,
    1.8, 1.9, 2.0, 2.1, 2.2, 2.3, 2.4
  ]);
  assert.equal(result.currentTime, '2026-08-19T15:00');
  assert.equal(result.currentPrecipitation, 6.4);
  assert.equal(result.timezone, 'Asia/Shanghai');
});

test('fetchLiveRainfall passes a complete Open-Meteo response through the curve parser', async () => {
  assert.equal(typeof weather.fetchLiveRainfall, 'function');

  let requestedUrl = '';
  const fetchImpl = async (url) => {
    requestedUrl = url;
    return {
      ok: true,
      status: 200,
      async json() {
        return rainfallPayload;
      }
    };
  };

  const result = await weather.fetchLiveRainfall({
    latitude: 31.2304,
    longitude: 121.4737,
    fetchImpl
  });

  assert.equal(new URL(requestedUrl).searchParams.get('latitude'), '31.2304');
  assert.deepEqual(result.values.slice(0, 3), [0, 0.1, 0.2]);
  assert.equal(result.currentPrecipitation, 6.4);
});

test('fetchLiveRainfall passes an abort signal and clears its request timeout', async () => {
  assert.equal(typeof weather.fetchLiveRainfall, 'function');

  let requestOptions;
  let timeoutDelay;
  let clearedTimer;
  const result = await weather.fetchLiveRainfall({
    latitude: 31.2304,
    longitude: 121.4737,
    timeoutMs: 3210,
    setTimeoutImpl(callback, delay) {
      assert.equal(typeof callback, 'function');
      timeoutDelay = delay;
      return 'timer-token';
    },
    clearTimeoutImpl(timer) {
      clearedTimer = timer;
    },
    fetchImpl: async (_url, options) => {
      requestOptions = options;
      return {
        ok: true,
        status: 200,
        async json() {
          return rainfallPayload;
        }
      };
    }
  });

  assert.ok(requestOptions.signal instanceof AbortSignal);
  assert.equal(requestOptions.signal.aborted, false);
  assert.equal(timeoutDelay, 3210);
  assert.equal(clearedTimer, 'timer-token');
  assert.equal(result.currentPrecipitation, 6.4);
});

test('fetchLiveRainfall aborts the request when its timeout callback runs', async () => {
  let signalWasAborted = false;
  const result = await weather.fetchLiveRainfall({
    latitude: 31.2304,
    longitude: 121.4737,
    setTimeoutImpl(callback) {
      callback();
      return 'timer-token';
    },
    clearTimeoutImpl() {},
    fetchImpl: async (_url, options) => {
      signalWasAborted = Boolean(options?.signal?.aborted);
      return {
        ok: true,
        status: 200,
        async json() {
          return rainfallPayload;
        }
      };
    }
  });

  assert.equal(signalWasAborted, true);
  assert.equal(result.currentPrecipitation, 6.4);
});

test('fetchLiveRainfall clears its timeout when the request fails', async () => {
  let clearCount = 0;

  await assert.rejects(
    weather.fetchLiveRainfall({
      latitude: 31.2304,
      longitude: 121.4737,
      setTimeoutImpl() {
        return 'timer-token';
      },
      clearTimeoutImpl(timer) {
        assert.equal(timer, 'timer-token');
        clearCount += 1;
      },
      fetchImpl: async () => {
        throw new Error('network unavailable');
      }
    }),
    /network unavailable/
  );

  assert.equal(clearCount, 1);
});

test('extractRainfallCurve rejects a response that cannot provide all 25 points', () => {
  assert.equal(typeof weather.extractRainfallCurve, 'function');

  const malformed = structuredClone(rainfallPayload);
  malformed.hourly.time = malformed.hourly.time.slice(0, -1);

  assert.throws(() => weather.extractRainfallCurve(malformed), /25|rainfall|precipitation/i);
});

test('requestBrowserLocation resolves finite latitude and longitude', async () => {
  assert.equal(typeof weather.requestBrowserLocation, 'function');

  const coordinates = await weather.requestBrowserLocation({
    getCurrentPosition(success) {
      success({ coords: { latitude: 31.2304, longitude: 121.4737 } });
    }
  });

  assert.deepEqual(coordinates, { latitude: 31.2304, longitude: 121.4737 });
});

test('requestBrowserLocation rejects when geolocation is unavailable', async () => {
  assert.equal(typeof weather.requestBrowserLocation, 'function');

  await assert.rejects(
    weather.requestBrowserLocation(null),
    /geolocation|location/i
  );
});

test('createLiveWeatherController delivers live data and schedules ten-minute refreshes', async () => {
  assert.equal(typeof weather.createLiveWeatherController, 'function');

  const statuses = [];
  const applied = [];
  const timers = [];
  const expectedCoordinates = { latitude: 31.2304, longitude: 121.4737 };
  const expectedData = {
    values: [0, 0.1, 0.2],
    currentPrecipitation: 6.4,
    currentTime: '2026-08-19T15:00',
    timezone: 'Asia/Shanghai'
  };

  const controller = weather.createLiveWeatherController({
    requestLocation: async () => expectedCoordinates,
    fetchWeather: async (coordinates) => {
      assert.deepEqual(coordinates, expectedCoordinates);
      return expectedData;
    },
    onStatus: ({ state }) => statuses.push(state),
    onData: (data, coordinates) => applied.push({ data, coordinates }),
    setIntervalImpl(callback, delay) {
      timers.push({ callback, delay });
      return 'timer-token';
    },
    clearIntervalImpl() {},
    refreshIntervalMs: 600000
  });

  const result = await controller.start();

  assert.deepEqual(result, expectedData);
  assert.deepEqual(applied, [{ data: expectedData, coordinates: expectedCoordinates }]);
  assert.deepEqual(statuses, ['loading', 'ready']);
  assert.equal(timers.length, 1);
  assert.equal(timers[0].delay, 600000);
});

test('createLiveWeatherController reports denied location without applying fallback data', async () => {
  assert.equal(typeof weather.createLiveWeatherController, 'function');

  const statuses = [];
  const applied = [];
  const error = new Error('permission denied');
  error.code = 1;
  const controller = weather.createLiveWeatherController({
    requestLocation: async () => { throw error; },
    onStatus: ({ state }) => statuses.push(state),
    onData: data => applied.push(data),
    setIntervalImpl() { throw new Error('should not schedule without coordinates'); }
  });

  const result = await controller.start();

  assert.equal(result, null);
  assert.deepEqual(statuses, ['loading', 'denied']);
  assert.deepEqual(applied, []);
});
