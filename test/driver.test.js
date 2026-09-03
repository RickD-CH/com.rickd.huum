'use strict';
// Exercises drivers/uku/driver.js (pairing + repair) against a stub Homey
// runtime, and specifically demonstrates that multiple HUUM controllers
// can be paired as independent devices (see README "Multiple HUUM
// controllers").
const assert = require('assert');
const path = require('path');
const Module = require('module');

process.env.NODE_PATH = path.join(__dirname, 'homey-stub');
Module._initPaths();

const APP_DIR = path.join(__dirname, '..');
const enLocale = require(path.join(APP_DIR, 'locales', 'en.json'));

const HuumDriver = require(path.join(APP_DIR, 'drivers', 'uku', 'driver.js'));
const HuumApiModule = require(path.join(APP_DIR, 'lib', 'HuumApi.js'));
const { HuumAuthError } = HuumApiModule;

function makeHomeyApi() {
  return {
    __(key) {
      const value = key.split('.').reduce((o, k) => (o ? o[k] : undefined), enLocale);
      return typeof value === 'string' ? value : key;
    },
  };
}

function makeSession() {
  const handlers = {};
  return {
    setHandler(event, fn) { handlers[event] = fn; },
    handlers,
  };
}

function makeDriver() {
  const driver = new HuumDriver();
  driver.homey = makeHomeyApi();
  return driver;
}

/** Temporarily stubs HuumApi.prototype.getStatus for the duration of `fn`. */
async function withStubbedStatus(statusByUser, fn) {
  const original = HuumApiModule.HuumApi.prototype.getStatus;
  HuumApiModule.HuumApi.prototype.getStatus = async function stubbedGetStatus() {
    if (this.password === 'wrong') throw new HuumAuthError();
    const status = statusByUser[this.username];
    if (!status) throw new Error(`no stubbed status for ${this.username}`);
    return status;
  };
  try {
    return await fn();
  } finally {
    HuumApiModule.HuumApi.prototype.getStatus = original;
  }
}

async function testLoginRejectsWrongPassword() {
  const driver = makeDriver();
  const session = makeSession();
  await driver.onPair(session);

  await withStubbedStatus({}, async () => {
    const ok = await session.handlers.login({ username: 'user@example.com', password: 'wrong' });
    assert.strictEqual(ok, false, 'wrong credentials must resolve to false, not throw');
  });
  console.log('OK: onPair "login" resolves false (not throws) on wrong credentials');
}

async function testPairingDetectsSteamerAndLight() {
  const driver = makeDriver();
  const session = makeSession();
  await driver.onPair(session);

  await withStubbedStatus({
    'both@example.com': { saunaName: 'Garden Sauna', config: 3, doorClosed: true },
  }, async () => {
    const ok = await session.handlers.login({ username: 'both@example.com', password: 'right' });
    assert.strictEqual(ok, true);

    const devices = await session.handlers.list_devices();
    assert.strictEqual(devices.length, 1);
    const [device] = devices;
    assert.strictEqual(device.name, 'Garden Sauna');
    assert.strictEqual(device.data.id, 'both@example.com');
    assert.ok(device.capabilities.includes('target_humidity'), 'steamer detected -> target_humidity present');
    assert.ok(device.capabilities.includes('onoff.light'), 'light detected -> onoff.light present');
  });
  console.log('OK: pairing detects steamer+light (config=3) and includes the right capabilities');
}

async function testPairingWithoutSteamerOmitsHumidityCapabilities() {
  const driver = makeDriver();
  const session = makeSession();
  await driver.onPair(session);

  await withStubbedStatus({
    'lightonly@example.com': { saunaName: 'Cabin Sauna', config: 2, doorClosed: true },
  }, async () => {
    await session.handlers.login({ username: 'lightonly@example.com', password: 'right' });
    const [device] = await session.handlers.list_devices();
    assert.ok(!device.capabilities.includes('target_humidity'), 'no steamer -> no target_humidity');
    assert.ok(!device.capabilities.includes('alarm_water'), 'no steamer -> no alarm_water');
    assert.ok(device.capabilities.includes('onoff.light'), 'light still detected');
  });
  console.log('OK: pairing without a steamer (config=2) omits the humidity-only capabilities');
}

async function testMultipleSaunasPairAsIndependentDevices() {
  // The whole point: two different HUUM accounts (e.g. two physical
  // saunas) pair as two separate Homey devices with distinct ids and
  // independent stored credentials — nothing in this app is a singleton.
  const statuses = {
    'home@example.com': { saunaName: 'Home Sauna', config: 3, doorClosed: true }, // steamer + light
    'cabin@example.com': { saunaName: 'Cabin Sauna', config: 2, doorClosed: true }, // light only, no steamer
  };

  const devices = [];
  await withStubbedStatus(statuses, async () => {
    for (const [username] of Object.entries(statuses)) {
      const driver = makeDriver();
      const session = makeSession();
      // eslint-disable-next-line no-await-in-loop
      await driver.onPair(session);
      // eslint-disable-next-line no-await-in-loop
      await session.handlers.login({ username, password: 'right' });
      // eslint-disable-next-line no-await-in-loop
      const [device] = await session.handlers.list_devices();
      devices.push(device);
    }
  });

  assert.strictEqual(devices.length, 2);
  assert.notStrictEqual(devices[0].data.id, devices[1].data.id, 'each paired sauna gets a distinct device id');
  assert.notStrictEqual(devices[0].store.password, undefined);
  assert.notStrictEqual(devices[1].store.password, undefined);
  assert.deepStrictEqual(
    devices.map((d) => d.name).sort(),
    ['Cabin Sauna', 'Home Sauna'],
    'each device keeps its own sauna name from its own account',
  );
  // Home has a steamer (config=3), Cabin doesn't (config=2, light only) —
  // proves each device's capability set is independently detected, not
  // shared state.
  const home = devices.find((d) => d.name === 'Home Sauna');
  const cabin = devices.find((d) => d.name === 'Cabin Sauna');
  assert.ok(home.capabilities.includes('target_humidity'));
  assert.ok(!cabin.capabilities.includes('target_humidity'));
  console.log('OK: two different HUUM accounts pair as two fully independent devices (multi-sauna support)');
}

async function testRepairUpdatesStoreAndNotifiesDevice() {
  const driver = makeDriver();
  const session = makeSession();

  let storedUsername = 'old@example.com';
  let storedPassword = 'old-pw';
  let credentialsUpdatedCalled = false;
  const fakeDevice = {
    async setStoreValue(key, value) {
      if (key === 'username') storedUsername = value;
      if (key === 'password') storedPassword = value;
    },
    async onCredentialsUpdated() { credentialsUpdatedCalled = true; },
  };

  await driver.onRepair(session, fakeDevice);

  await withStubbedStatus({
    'new@example.com': { saunaName: 'x', config: 3, doorClosed: true },
  }, async () => {
    const ok = await session.handlers.login({ username: 'new@example.com', password: 'new-pw' });
    assert.strictEqual(ok, true);
  });

  assert.strictEqual(storedUsername, 'new@example.com');
  assert.strictEqual(storedPassword, 'new-pw');
  assert.strictEqual(credentialsUpdatedCalled, true);
  console.log('OK: onRepair saves the new credentials to the device store and notifies the device');
}

(async () => {
  await testLoginRejectsWrongPassword();
  await testPairingDetectsSteamerAndLight();
  await testPairingWithoutSteamerOmitsHumidityCapabilities();
  await testMultipleSaunasPairAsIndependentDevices();
  await testRepairUpdatesStoreAndNotifiesDevice();
  console.log('\nAll driver.js pairing tests passed.');
})().catch((err) => {
  console.error('TEST FAILED:', err);
  process.exit(1);
});
