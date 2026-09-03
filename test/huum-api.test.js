'use strict';
// Lightweight sanity check of lib/HuumApi.js business logic (no network,
// no Homey runtime needed). Run with: node test/huum-api.test.js
const assert = require('assert');
const path = require('path');
const {
  HuumApi, HuumApiError, HuumSafetyError, CONFIG_FLAGS, configHasFlag,
} = require(path.join(__dirname, '..', 'lib', 'HuumApi'));

const api = new HuumApi({ username: 'test@example.com', password: 'secret' });

// getMaxHumidity thresholds
assert.strictEqual(api.getMaxHumidity(40), 90);
assert.strictEqual(api.getMaxHumidity(45), 90);
assert.strictEqual(api.getMaxHumidity(50), 55);
assert.strictEqual(api.getMaxHumidity(80), 20);
assert.strictEqual(api.getMaxHumidity(90), 10);
assert.strictEqual(api.getMaxHumidity(110), 0);
console.log('getMaxHumidity thresholds OK');

(async () => {
  // turnOn: temperature out of range
  await assert.rejects(() => api.turnOn({ temperature: 5, safetyOverride: true }), HuumApiError);
  await assert.rejects(() => api.turnOn({ temperature: 200, safetyOverride: true }), HuumApiError);
  console.log('temperature range validation OK');

  // turnOn: humidity exceeding max for given temp (should throw before any network call)
  await assert.rejects(
    () => api.turnOn({ temperature: 90, humidity: 50, safetyOverride: true }),
    (err) => err instanceof HuumApiError
      && /exceeds the maximum/.test(err.message)
      && err.code === 'humidity_exceeds_max'
      && err.data.humidity === 50
      && err.data.maxHumidity === 10
      && err.data.temperature === 90,
  );
  console.log('humidity threshold validation OK (incl. structured code/data for i18n)');

  // Door safety: stub getStatus to report open door, ensure turnOn without
  // safetyOverride refuses and never reaches _request.
  let requestCalled = false;
  api._request = async () => { requestCalled = true; return {}; };
  api.getStatus = async () => ({ doorClosed: false });
  await assert.rejects(() => api.turnOn({ temperature: 80 }), HuumSafetyError);
  assert.strictEqual(requestCalled, false);
  console.log('door safety check OK (start blocked, no request sent)');

  // With door closed, turnOn should proceed and build the right payload.
  api.getStatus = async () => ({ doorClosed: true });
  let capturedBody = null;
  api._request = async (method, path_, body) => {
    capturedBody = { method, path: path_, body };
    return { statusCode: 231 };
  };
  await api.turnOn({ temperature: 70.6, humidity: 25 });
  assert.strictEqual(capturedBody.method, 'POST');
  assert.strictEqual(capturedBody.path, '/start');
  assert.deepStrictEqual(capturedBody.body, { targetTemperature: 71, humidity: 25 });
  console.log('turnOn payload construction OK (rounds temperature, includes humidity)');

  // _parseStatus mapping (static)
  const parsed = HuumApi._parseStatus({
    statusCode: 231,
    door: true,
    temperature: 62,
    targetTemperature: 80,
    humidity: 33,
    targetHumidity: 40,
    light: 1,
    config: 3,
    saunaName: 'Backyard Sauna',
  });
  assert.strictEqual(parsed.isHeating, true);
  assert.strictEqual(parsed.doorClosed, true);
  assert.strictEqual(parsed.targetHumidity, 40);
  assert.strictEqual(parsed.saunaName, 'Backyard Sauna');
  console.log('_parseStatus field mapping OK');

  // New fields: safety alarms, timer, device-reported limits.
  const parsed2 = HuumApi._parseStatus({
    statusCode: 400,
    door: true,
    temperature: 55,
    steamerError: 1,
    endDate: Math.floor(Date.now() / 1000) + 300, // 5 min from now
    saunaConfig: {
      childLock: 'false', minTemp: 40, maxTemp: 100, minTimer: 0, maxTimer: 180,
    },
  });
  assert.strictEqual(parsed2.isEmergencyStop, true);
  assert.strictEqual(parsed2.steamerError, 1);
  assert.strictEqual(parsed2.saunaConfig.maxTemp, 100);
  assert.ok(parsed2.endDate > Date.now() / 1000);
  console.log('_parseStatus safety/timer/limits fields OK');

  // config bitmask: steamer/light detection
  assert.strictEqual(configHasFlag(1, CONFIG_FLAGS.STEAMER), true); // steamer only
  assert.strictEqual(configHasFlag(1, CONFIG_FLAGS.LIGHT), false);
  assert.strictEqual(configHasFlag(2, CONFIG_FLAGS.STEAMER), false); // light only, no steamer
  assert.strictEqual(configHasFlag(2, CONFIG_FLAGS.LIGHT), true);
  assert.strictEqual(configHasFlag(3, CONFIG_FLAGS.STEAMER), true); // both
  assert.strictEqual(configHasFlag(3, CONFIG_FLAGS.LIGHT), true);
  assert.strictEqual(configHasFlag(undefined, CONFIG_FLAGS.STEAMER), true); // unknown -> assume present
  console.log('configHasFlag (steamer/light detection) OK');

  console.log('\nAll HuumApi sanity checks passed.');
})().catch((err) => {
  console.error('TEST FAILED:', err);
  process.exit(1);
});
