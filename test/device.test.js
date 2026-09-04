'use strict';
// Exercises drivers/uku/device.js against a stub Homey runtime (see
// homey-stub/), to verify the exception-handling behaviour: a successful
// command followed by a failed status refresh must NOT make the
// capability action look like it failed to the user, translated error
// messages, and a few other behaviours that only make sense with a
// (fake) device instance around.
//
// Run with: node test/device.test.js (or `npm test`, which runs this and
// huum-api.test.js together).

const assert = require('assert');
const path = require('path');
const Module = require('module');

// drivers/uku/device.js does `require('homey')`, which only resolves
// inside a running Homey — there's no such package to install as a real
// dependency (the actual Device/Driver/App classes are injected by the
// Homey firmware at runtime, not shipped via npm). Point Node's module
// resolution at our local stub instead, for this process only.
process.env.NODE_PATH = path.join(__dirname, 'homey-stub');
Module._initPaths();

const APP_DIR = path.join(__dirname, '..');
const enLocale = require(path.join(APP_DIR, 'locales', 'en.json'));

const HuumDevice = require(path.join(APP_DIR, 'drivers', 'uku', 'device.js'));
const { HuumAuthError, HuumSafetyError } = require(path.join(APP_DIR, 'lib', 'HuumApi.js'));

function makeHomeyApi() {
  const timers = [];
  const triggeredCards = [];
  const notifications = [];
  return {
    __(key, vars) {
      const value = key.split('.').reduce((o, k) => (o ? o[k] : undefined), enLocale);
      if (typeof value !== 'string') return key;
      return vars
        ? value.replace(/\{\{(\w+)\}\}/g, (_, name) => String(vars[name]))
        : value;
    },
    flow: {
      getDeviceTriggerCard: (id) => ({
        trigger: async (device, tokens) => { triggeredCards.push({ id, tokens }); },
      }),
    },
    clock: { getTimezone: () => 'Europe/Zurich' },
    __triggeredCards: triggeredCards,
    __notifications: notifications,
    notifications: {
      createNotification: async (n) => { notifications.push(n); },
    },
    setTimeout(fn, ms) {
      const id = { fn, ms };
      timers.push(id);
      return id;
    },
    clearTimeout(id) {
      const i = timers.indexOf(id);
      if (i >= 0) timers.splice(i, 1);
    },
    __timers: timers,
  };
}

function makeDevice({ capabilities }) {
  const device = new HuumDevice();
  device.homey = makeHomeyApi();
  device.__store = { username: 'user@example.com', password: 'secret' };
  for (const [id, value] of Object.entries(capabilities)) {
    device.__capabilities.set(id, value);
  }
  return device;
}

async function testPostActionRefreshFailureDoesNotRejectListener() {
  const device = makeDevice({
    capabilities: {
      onoff: false,
      target_temperature: 80,
      target_humidity: 0.3,
      'measure_temperature.room': 40,
      measure_humidity: 20,
      alarm_contact: false,
      alarm_water: false,
      alarm_generic: false,
      huum_time_remaining: 0,
    },
  });

  let turnOffCalled = false;
  device.api = {
    // The refresh that follows a successful turnOff() must not surface this.
    getStatus: async () => { throw new Error('simulated network blip'); },
    turnOff: async () => { turnOffCalled = true; return {}; },
  };

  device._registerCapabilityListeners();

  // Should resolve (not throw), even though the post-action _syncStatus()
  // call fails — that's the exact bug that was fixed.
  await device.triggerCapabilityListener('onoff', false);

  assert.strictEqual(turnOffCalled, true, 'turnOff() must actually have been called');
  assert.ok(
    device.__errors.some((e) => e.includes('Post-action status refresh failed')),
    'the refresh failure must be logged, not thrown',
  );
  console.log('OK: successful turnOff() + failed refresh does not reject the onoff listener');
}

async function testDoorOpenErrorStillRejectsWithTranslatedMessage() {
  const device = makeDevice({
    capabilities: { onoff: false, target_temperature: 80, target_humidity: 0.3 },
  });
  device.api = {
    turnOn: async () => { throw new HuumSafetyError(); },
  };
  device._registerCapabilityListeners();

  await assert.rejects(
    () => device.triggerCapabilityListener('onoff', true),
    (err) => err.message === enLocale.errors.door_open,
  );
  console.log('OK: door-open safety error still rejects the listener with the translated message');
}

async function testHumidityExceedsMaxIsTranslated() {
  const device = makeDevice({ capabilities: {} });
  const err = new Error('raw');
  err.code = 'humidity_exceeds_max';
  err.data = { humidity: 50, maxHumidity: 10, temperature: 90 };
  device.api = { turnOn: async () => { throw err; } };

  const expected = enLocale.errors.humidity_exceeds_max
    .replace('{{humidity}}', '50').replace('{{maxHumidity}}', '10').replace('{{temperature}}', '90');

  await assert.rejects(() => device._start(90, 50), (e) => e.message === expected);
  console.log('OK: humidity_exceeds_max is translated using the structured err.data');
}

async function testAuthErrorMarksUnavailable() {
  const device = makeDevice({ capabilities: {} });
  device.api = { turnOff: async () => { throw new HuumAuthError(); } };
  device._registerCapabilityListeners();

  await assert.rejects(() => device.triggerCapabilityListener('onoff', false));
  assert.strictEqual(device.getAvailable(), false);
  assert.strictEqual(device.__unavailableReason, enLocale.errors.auth_failed);
  console.log('OK: an auth error on turnOff() also marks the device unavailable (not just on turnOn)');
}

async function testReconcileCapabilitiesAddsAndRemoves() {
  // Paired without a steamer (config=2, light only): target_humidity etc.
  // must not be present, then get added once config later reports a
  // steamer (e.g. after upgrading from an older version of this app).
  const device = makeDevice({ capabilities: { onoff: false } });
  await device._reconcileCapabilities({ config: 2 });
  assert.strictEqual(device.hasCapability('target_humidity'), false);
  assert.strictEqual(device.hasCapability('onoff.light'), true);
  assert.strictEqual(device.hasCapability('huum_remote_blocked'), true, 'the remote-blocked indicator is always added, even on old pairings');

  await device._reconcileCapabilities({ config: 3 });
  assert.strictEqual(device.hasCapability('target_humidity'), true);
  assert.strictEqual(device.hasCapability('measure_humidity'), true);
  assert.strictEqual(device.hasCapability('alarm_water'), true);
  console.log('OK: _reconcileCapabilities adds steamer capabilities once config reports a steamer');
}

async function testAdaptivePollIntervalPicksActiveVsIdle() {
  const device = makeDevice({ capabilities: {} });
  // poll intervals live in the device store now (moved to the app settings page)
  device.__store.pollInterval = 30;
  device.__store.idlePollInterval = 300;

  device._lastStatus = { isHeating: true };
  device._scheduleNextPoll();
  assert.strictEqual(device.homey.__timers[0].ms, 30 * 1000);

  device._lastStatus = { isHeating: false };
  device._scheduleNextPoll();
  assert.strictEqual(device.homey.__timers[0].ms, 300 * 1000);
  console.log('OK: adaptive polling picks the active interval while heating, idle interval otherwise');
}

async function testSessionTrackingCountsACompleteSession() {
  const device = makeDevice({
    capabilities: { huum_session_count: 0, onoff: false },
  });

  // Session starts: onoff false -> true.
  device._lastStatus = { isHeating: false };
  await device._trackSessionStats({
    isHeating: true, targetTemperature: 82, targetHumidity: 35,
  });
  assert.strictEqual(device.getStoreValue('sessionStartedAt') > 0, true, 'session start time recorded');
  assert.strictEqual(device.getCapabilityValue('huum_session_count'), 0, 'count unchanged while still heating');

  // Pretend some time passed, then the session ends: true -> false.
  device.__store.sessionStartedAt -= 45 * 60 * 1000; // backdate by 45 minutes
  device._lastStatus = { isHeating: true };
  await device._trackSessionStats({ isHeating: false });

  assert.strictEqual(device.getCapabilityValue('huum_session_count'), 1);
  assert.strictEqual(device.getStoreValue('sessionCount'), 1);
  assert.strictEqual(device.getStoreValue('totalHeatingMinutes'), 45);
  const lastSession = device.getStoreValue('lastSession');
  assert.strictEqual(lastSession.durationMinutes, 45);
  assert.strictEqual(lastSession.temperature, 82);
  assert.strictEqual(lastSession.humidity, 35);
  assert.strictEqual(device.getStoreValue('sessionStartedAt'), null, 'cleared after the session ends');

  const trigger = device.homey.__triggeredCards.find((t) => t.id === 'sauna_session_ended');
  assert.ok(trigger, 'sauna_session_ended Flow trigger fired');
  assert.strictEqual(trigger.tokens.duration, 45);
  assert.strictEqual(trigger.tokens.temperature, 82);
  assert.strictEqual(trigger.tokens.humidity, 35);
  console.log('OK: a full on->off cycle counts one session, records it, and fires sauna_session_ended');
}

async function testSessionTrackingIgnoresEndWithNoKnownStart() {
  // E.g. the app restarted while already off, or store got cleared —
  // ending a session we never saw start must not fabricate a count.
  const device = makeDevice({ capabilities: { huum_session_count: 0 } });
  device._lastStatus = { isHeating: true };
  await device._trackSessionStats({ isHeating: false });

  assert.ok(!device.getStoreValue('sessionCount'), 'no session was counted');
  assert.strictEqual(device.homey.__triggeredCards.length, 0);
  console.log('OK: an end-transition with no recorded start does not fabricate a session');
}

async function testSaveAndStartWithProfile() {
  const device = makeDevice({
    capabilities: { target_temperature: 88, target_humidity: 0.2, onoff: true },
  });

  await device.saveProfile('profile1');
  // profiles are stored in the device store now (edited from the app settings page)
  assert.strictEqual(device.getStoreValue('profile1Temperature'), 88);
  assert.strictEqual(device.getStoreValue('profile1Humidity'), 20);
  console.log('OK: saveProfile() stores the device\'s current temperature/humidity into that profile');

  let capturedTurnOn = null;
  device.api = { turnOn: async (args) => { capturedTurnOn = args; return {}; } };
  await device.startWithProfile('profile1');
  assert.deepStrictEqual(capturedTurnOn, { temperature: 88, humidity: 20 });
  console.log('OK: startWithProfile() starts the sauna with the saved profile\'s temperature/humidity');
}

async function testStartWithUnconfiguredProfileThrows() {
  const device = makeDevice({ capabilities: {} }); // profile2Temperature never set

  let apiCalled = false;
  device.api = { turnOn: async () => { apiCalled = true; return {}; } };

  await assert.rejects(
    () => device.startWithProfile('profile2'),
    (err) => err.message === enLocale.errors.profile_not_configured,
  );
  assert.strictEqual(apiCalled, false, 'must not call the API with an undefined temperature');
  console.log('OK: starting an unconfigured profile is rejected with a translated message, no API call made');
}

async function testWaterSensorAbsentHidesAlarm() {
  // Owner declared "no water sensor" — alarm_water must be removed even
  // though the sauna has a steamer (config=3), and stay gone.
  const device = makeDevice({ capabilities: { onoff: false, alarm_water: false } });
  device.__settings = { waterSensorMode: 'absent' };

  await device._reconcileCapabilities({ config: 3 });
  assert.strictEqual(device.hasCapability('alarm_water'), false, 'no water sensor -> alarm_water removed');
  assert.strictEqual(device.hasCapability('target_humidity'), true, 'humidity control still added (steamer present)');
  console.log('OK: declaring "no water sensor" hides alarm_water even with a steamer');
}

async function testDoorSensorAbsentOverridesSafetyCheck() {
  const device = makeDevice({ capabilities: { onoff: false, target_temperature: 80 } });
  device.__settings = { doorSensorMode: 'absent' };

  let captured = null;
  device.api = { turnOn: async (args) => { captured = args; return {}; } };
  await device._start(80, undefined);

  assert.strictEqual(captured.safetyOverride, true, 'no door sensor -> the HUUM door-open check is overridden');
  console.log('OK: declaring "no door sensor" overrides the door-open safety block so the sauna can start');
}

async function testRemoteSafetyBlocksStartAndWarns() {
  const device = makeDevice({
    capabilities: {
      onoff: false, target_temperature: 80, alarm_contact: false, alarm_generic: false,
    },
  });
  device.api = { turnOn: async () => ({}) };

  device._lastStatus = { remoteSafetyState: 'notSafe' };
  await assert.rejects(
    () => device._start(80, undefined),
    (err) => err.message === enLocale.errors.remote_disabled,
    'a start is blocked while the UKU remote-safety lock is engaged',
  );

  await device._syncWarnings({ remoteSafetyState: 'notSafe', doorClosed: true });
  assert.ok(/UKU/.test(device.__warning), 'device shows the remote-disabled warning');

  await device._syncWarnings({ remoteSafetyState: 'safe', doorClosed: true });
  assert.strictEqual(device.__warning, null, 'warning clears once remote control is safe again');
  console.log('OK: remote-safety lock blocks a start and surfaces a device warning');
}

async function testRemoteStateTriggersOnEdge() {
  const device = makeDevice({ capabilities: { huum_remote_blocked: false } });

  // First observation just primes the edge detector.
  await device._syncRemoteState({ remoteSafetyState: 'safe' });
  assert.strictEqual(device.homey.__triggeredCards.length, 0);
  assert.strictEqual(device.getCapabilityValue('huum_remote_blocked'), false);

  await device._syncRemoteState({ remoteSafetyState: 'notSafe' });
  assert.strictEqual(device.homey.__triggeredCards.pop().id, 'remote_control_blocked');
  assert.strictEqual(device.getCapabilityValue('huum_remote_blocked'), true, 'the device tile shows the block directly, not just settings text');

  await device._syncRemoteState({ remoteSafetyState: 'notSafe' }); // no change
  assert.strictEqual(device.homey.__triggeredCards.length, 0);
  assert.strictEqual(device.getCapabilityValue('huum_remote_blocked'), true);

  await device._syncRemoteState({ remoteSafetyState: 'safe' });
  assert.strictEqual(device.homey.__triggeredCards.pop().id, 'remote_control_available');
  assert.strictEqual(device.getCapabilityValue('huum_remote_blocked'), false);
  console.log('OK: remote_control_blocked / _available fire only on the state edge');
}

async function testFormatDeviceDateTimeUsesTheHomeyTimezone() {
  const device = makeDevice({ capabilities: {} });
  // A fixed instant, well clear of any DST edge case: 2026-06-15 10:30 UTC.
  const ms = Date.UTC(2026, 5, 15, 10, 30);

  device.homey.clock = { getTimezone: () => 'Europe/Zurich' }; // UTC+2 in June (CEST)
  assert.strictEqual(device._formatDeviceDateTime(ms), '15.06.2026 12:30', '24h, day-first, shifted into the Homey\'s real timezone');

  device.homey.clock = { getTimezone: () => 'America/New_York' }; // UTC-4 in June (EDT)
  assert.strictEqual(device._formatDeviceDateTime(ms), '15.06.2026 06:30');

  // No clock manager (or it throws) — must not crash, degrades gracefully.
  device.homey.clock = undefined;
  assert.strictEqual(typeof device._formatDeviceDateTime(ms), 'string');
  console.log('OK: _formatDeviceDateTime renders in the Homey\'s configured timezone, not the Node runtime default (was UTC/en-US)');
}

async function testGetConfigExposesRemoteBlocked() {
  const device = makeDevice({ capabilities: {} });
  device._lastStatus = { remoteSafetyState: 'safe' };
  assert.strictEqual(device.getConfig().remoteBlocked, false, 'settings page can warn before the block, not just after');

  device._lastStatus = { remoteSafetyState: 'notSafe' };
  assert.strictEqual(device.getConfig().remoteBlocked, true);
  console.log('OK: getConfig() exposes the live remote-blocked state for the scheduling hint');
}

async function testCurrentTemperatureChangedFiresOnEveryChange() {
  const device = makeDevice({ capabilities: { 'measure_temperature.room': 40 } });

  // First observation just primes the edge detector — no prior value to
  // compare against, so it must not fire.
  await device._syncCurrentTemperature({ temperature: 40 });
  assert.strictEqual(device.homey.__triggeredCards.length, 0);

  await device._syncCurrentTemperature({ temperature: 41 });
  const fired = device.homey.__triggeredCards.pop();
  assert.strictEqual(fired.id, 'current_temperature_changed');
  assert.deepStrictEqual(fired.tokens, { temperature: 41 });
  assert.strictEqual(device.getCapabilityValue('measure_temperature.room'), 41);

  await device._syncCurrentTemperature({ temperature: 41 }); // no change
  assert.strictEqual(device.homey.__triggeredCards.length, 0);
  console.log('OK: current_temperature_changed fires on every real change, not on the priming read or a repeat');
}

async function testDutyCycleLowersTheEstimateAtTemp() {
  const device = makeDevice({
    capabilities: { 'measure_temperature.room': 88, target_temperature: 90 },
  });
  device.__store.heaterPowerKw = 6;
  device.__store.heaterDutyCycle = 50;

  // measure (88) >= target (90) - 5 -> "at temperature" -> duty applies
  assert.strictEqual(device._currentPowerW(), 3000, 'at temp: 6 kW * 50%');

  device.__capabilities.set('measure_temperature.room', 40); // heating up
  assert.strictEqual(device._currentPowerW(), 6000, 'heating up: full power');
  console.log('OK: the kW estimate is duty-cycled once the sauna is at temperature');
}

async function testSetMeasuredPowerFeedsCapability() {
  const device = makeDevice({ capabilities: { measure_power: null } });
  device.__store.powerSource = 'flow';
  await device.setMeasuredPower(4200);
  assert.strictEqual(device.getCapabilityValue('measure_power'), 4200);
  console.log('OK: the set_measured_power Flow action writes measure_power');
}

async function testProfileDefaultsSeededOverNull() {
  // Regression: real Homey getStoreValue() returns null for unset keys, and
  // _migrateLegacySettings used a `=== undefined` check, so the 3 default
  // profiles were never seeded and getConfig() only ever showed fallbacks.
  const device = makeDevice({ capabilities: {} });
  device.__store.cfgMigrated = true; // simulate an already-"migrated" device
  await device._migrateLegacySettings();

  const cfg = device.getConfig();
  assert.strictEqual(cfg.profiles[0].name, 'Finnisch');
  assert.strictEqual(cfg.profiles[0].temperature, 90);
  assert.strictEqual(cfg.profiles[1].name, 'Feucht');
  assert.strictEqual(cfg.profiles[1].humidity, 55);
  assert.strictEqual(cfg.profiles[2].name, 'Family');
  console.log('OK: the 3 default profiles are seeded even when getStoreValue() returns null');
}

async function testSessionEnergyAndCost() {
  const device = makeDevice({ capabilities: { huum_session_count: 0, onoff: false } });
  device.__store.electricityPrice = 0.30;
  device.__store.heaterPowerKw = 6; // no meter -> estimate: 6 kW

  // Session starts.
  device._lastStatus = { isHeating: false };
  await device._trackSessionStats({ isHeating: true, targetTemperature: 80, targetHumidity: 0 });

  // Pretend one hour passed at 6 kW, then it stops.
  device.__store.sessionEnergyAt -= 60 * 60 * 1000;
  device._lastStatus = { isHeating: true };
  await device._trackSessionStats({ isHeating: false });

  const last = device.getStoreValue('lastSession');
  assert.strictEqual(last.kwh, 6, '6 kW for 1 h -> 6 kWh');
  assert.strictEqual(last.cost, 1.8, '6 kWh * 0.30 -> 1.80');
  assert.strictEqual(device.getStoreValue('totalKwh'), 6);
  assert.strictEqual(device.getStoreValue('totalCost'), 1.8);

  const trigger = device.homey.__triggeredCards.find((t) => t.id === 'sauna_session_ended');
  assert.strictEqual(trigger.tokens.kwh, 6);
  assert.strictEqual(trigger.tokens.cost, 1.8);
  console.log('OK: a session records kWh (from the estimate) and a cost from the electricity price');
}

async function testWaterAlarmIgnoresZeroSteamerError() {
  const device = makeDevice({ capabilities: { alarm_water: false, alarm_generic: false } });
  await device._syncSafetyAlarms({ steamerError: 0, isEmergencyStop: false });
  assert.strictEqual(device.getCapabilityValue('alarm_water'), false, 'steamerError 0 is not a water alarm');
  await device._syncSafetyAlarms({ steamerError: 1, isEmergencyStop: false });
  assert.strictEqual(device.getCapabilityValue('alarm_water'), true, 'steamerError 1 is a water alarm');
  console.log('OK: water alarm only fires on a positive steamerError code, not 0');
}

async function testWaterCheckReminderFiresOnStart() {
  const device = makeDevice({
    capabilities: { onoff: false, target_temperature: 80, target_humidity: 0.3 },
  });
  device.__settings = { waterCheckReminder: true };
  device.api = { turnOn: async () => ({}), getStatus: async () => { throw new Error('no refresh in test'); } };
  device._registerCapabilityListeners();

  await device.triggerCapabilityListener('onoff', true);

  const note = device.homey.__notifications.find((n) => /check the steamer water/i.test(n.excerpt));
  assert.ok(note, 'turning the sauna on posts the water-check reminder notification');
  console.log('OK: the water-check reminder fires once when the sauna is switched on');
}

async function testStartProfilePickerStartsWithThatProfile() {
  const device = makeDevice({
    capabilities: { onoff: false, huum_start_profile: 'profile2', target_humidity: 0 },
  });
  device.__store.profile2Temperature = 60;
  device.__store.profile2Humidity = 45;

  let captured = null;
  device.api = { turnOn: async (a) => { captured = a; return {}; }, getStatus: async () => { throw new Error('no refresh'); } };
  device._registerCapabilityListeners();

  await device.triggerCapabilityListener('onoff', true);
  assert.deepStrictEqual(captured, { temperature: 60, humidity: 45 }, 'onoff uses the picked start profile');

  // "manual" (or an unconfigured profile) falls back to the current setpoint.
  device.__capabilities.set('huum_start_profile', 'manual');
  device.__capabilities.set('target_temperature', 95);
  device.__capabilities.set('onoff', false);
  captured = null;
  await device.triggerCapabilityListener('onoff', true);
  assert.strictEqual(captured.temperature, 95, 'manual -> current target temperature');
  console.log('OK: the device start-profile picker decides what switching on starts with');
}

async function testHumidityCapabilityScales() {
  // Homey quirk: measure_humidity is a plain 0-100 reading, but
  // target_humidity is a 0-1 fraction rendered as a percentage.
  const device = makeDevice({ capabilities: { target_humidity: 0, measure_humidity: 0, onoff: true } });
  await device._applyStatus({
    isHeating: true, temperature: 40, targetTemperature: 80,
    humidity: 38, targetHumidity: 45, doorClosed: true,
  });
  assert.strictEqual(device.getCapabilityValue('target_humidity'), 0.45, 'target: 45% -> 0.45');
  assert.strictEqual(device.getCapabilityValue('measure_humidity'), 38, 'measure: 38% -> 38');
  device.__capabilities.set('target_humidity', 0.6);
  assert.strictEqual(device._getTargetHumidityPercent(), 60, '0.6 -> 60% for the API');
  console.log('OK: measure_humidity is 0-100, target_humidity is the 0-1 fraction Homey expects');
}

async function testTargetsNotOverwrittenWhileOff() {
  const device = makeDevice({
    capabilities: { onoff: false, target_temperature: 55, target_humidity: 0.4, measure_humidity: 0 },
  });
  // A poll while the sauna is off must not clobber the owner's intended
  // next-start values with whatever HUUM still reports.
  await device._applyStatus({
    isHeating: false, temperature: 22, targetTemperature: 90, targetHumidity: 10, doorClosed: true,
  });
  assert.strictEqual(device.getCapabilityValue('target_temperature'), 55, 'kept while off');
  assert.strictEqual(device.getCapabilityValue('target_humidity'), 0.4, 'kept while off');

  // While heating, HUUM's values do win.
  device.__capabilities.set('onoff', true);
  await device._applyStatus({
    isHeating: true, temperature: 60, targetTemperature: 90, targetHumidity: 10, doorClosed: true,
  });
  assert.strictEqual(device.getCapabilityValue('target_temperature'), 90, 'synced while heating');
  console.log('OK: target temp/humidity hold the owner\'s intent while off, sync from HUUM while heating');
}

async function testScheduledStartFires() {
  const device = makeDevice({
    capabilities: {
      onoff: false, target_temperature: 80, huum_start_profile: 'manual', huum_booking_status: null,
    },
  });
  let started = null;
  device.api = { turnOn: async (a) => { started = a; return {}; }, getStatus: async () => { throw new Error('no refresh'); } };
  device._registerCapabilityListeners();

  const at = Date.now() + 60000;
  await device.setBooking({ at, temperature: 70, humidity: 20 });
  assert.strictEqual(device.getBooking().at, at, 'booking stored');
  // Independently computed, not via the device's own formatter — a real
  // check that it renders in the Homey's timezone (Europe/Zurich, mocked
  // above), 24h day-first, not the Node default (which is UTC/en-US on
  // Homey and was the actual bug: a Zurich time showed up 2h early in
  // m/d/y AM/PM).
  const wanted = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Zurich', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date(at)).reduce((o, p) => { o[p.type] = p.value; return o; }, {});
  assert.strictEqual(
    device.getCapabilityValue('huum_booking_status'),
    `${wanted.day}.${wanted.month}.${wanted.year} ${wanted.hour}:${wanted.minute}`,
    'the device tile shows when the scheduled start will fire, in the Homey\'s own timezone and 24h format',
  );

  await assert.rejects(() => device.setBooking({ at: Date.now() - 1000 }), /future/i, 'past start times are rejected');

  const timer = device.homey.__timers.find((t) => t.ms > 0 && t.ms <= 60000);
  assert.ok(timer, 'a booking timer was armed');
  await device._fireBooking();

  assert.deepStrictEqual(started, { temperature: 70, humidity: 20 }, 'scheduled start used the booked values');
  assert.strictEqual(device.getBooking(), null, 'booking cleared once it fired');
  assert.strictEqual(device.getCapabilityValue('onoff'), true);
  assert.strictEqual(
    device.getCapabilityValue('huum_booking_status'),
    enLocale.labels.not_scheduled,
    'the tile goes back to "not scheduled" once the booking is consumed',
  );
  console.log('OK: a scheduled start fires at its time with the booked temperature/humidity, then clears, updating the tile');
}

async function testClearBookingResetsTheTile() {
  const device = makeDevice({ capabilities: { huum_booking_status: null } });
  const at = Date.now() + 3600000;
  await device.setBooking({ at, temperature: 70 });
  assert.notStrictEqual(device.getCapabilityValue('huum_booking_status'), enLocale.labels.not_scheduled);

  await device.clearBooking();
  assert.strictEqual(device.getBooking(), null);
  assert.strictEqual(device.getCapabilityValue('huum_booking_status'), enLocale.labels.not_scheduled, 'cancelling a booking resets the tile too');
  console.log('OK: cancelling a scheduled start resets the device tile to "not scheduled"');
}

async function testStaleBookingIsDroppedNotFired() {
  const device = makeDevice({ capabilities: { onoff: false, target_temperature: 80 } });
  let called = false;
  device.api = { turnOn: async () => { called = true; return {}; }, getStatus: async () => { throw new Error('x'); } };
  // Simulate a booking whose time passed 45 min ago while the app was down.
  device.__store.booking = { at: Date.now() - 45 * 60 * 1000, profile: null, temperature: 70 };
  await device._fireBooking();
  assert.strictEqual(called, false, 'a long-missed booking must not start the sauna');
  assert.strictEqual(device.getBooking(), null, 'and is discarded');

  const recorded = device.getStoreValue('sessionHistory')[0];
  assert.deepStrictEqual(
    { failed: recorded.failed, reason: recorded.reason },
    { failed: true, reason: 'missed' },
    'the miss is recorded in the history so it does not go unnoticed',
  );
  console.log('OK: a scheduled start missed by >30 min is dropped, not fired late, and recorded as missed');
}

async function testFailedScheduledStartIsRecordedWithReason() {
  // Remote-safety blocked: _start() rejects before ever calling the API.
  const remoteBlockedDevice = makeDevice({ capabilities: { onoff: false, target_temperature: 80 } });
  remoteBlockedDevice.api = { turnOn: async () => ({}), getStatus: async () => { throw new Error('offline'); } };
  remoteBlockedDevice._lastStatus = { remoteSafetyState: 'notSafe' };
  remoteBlockedDevice.__store.booking = { at: Date.now() - 1000, profile: null, temperature: 70 };
  await remoteBlockedDevice._fireBooking();
  let rec = remoteBlockedDevice.getStoreValue('sessionHistory')[0];
  assert.strictEqual(rec.failed, true);
  assert.strictEqual(rec.reason, 'remote_disabled', 'remote-safety block is recorded with its own reason');

  // Door open: the HUUM API itself rejects the start.
  const doorOpenDevice = makeDevice({ capabilities: { onoff: false, target_temperature: 80 } });
  doorOpenDevice.api = {
    turnOn: async () => { throw new HuumSafetyError(); },
    getStatus: async () => { throw new Error('offline'); },
  };
  doorOpenDevice.__store.booking = { at: Date.now() - 1000, profile: null, temperature: 70 };
  await doorOpenDevice._fireBooking();
  rec = doorOpenDevice.getStoreValue('sessionHistory')[0];
  assert.strictEqual(rec.failed, true);
  assert.strictEqual(rec.reason, 'door_open', 'a door-open rejection is recorded with its own reason');

  // Anything else falls back to a generic reason, still recorded.
  const otherDevice = makeDevice({ capabilities: { onoff: false, target_temperature: 80 } });
  otherDevice.api = {
    turnOn: async () => { throw new Error('network blip'); },
    getStatus: async () => { throw new Error('offline'); },
  };
  otherDevice.__store.booking = { at: Date.now() - 1000, profile: null, temperature: 70 };
  await otherDevice._fireBooking();
  rec = otherDevice.getStoreValue('sessionHistory')[0];
  assert.strictEqual(rec.failed, true);
  assert.strictEqual(rec.reason, 'other', 'an unclassified failure still lands in the history');
  assert.strictEqual(rec.message, 'network blip');

  console.log('OK: a scheduled start that fails on the day is recorded in the history with its reason (remote/door/other)');
}

async function testAutoOffSurvivesRestartAndClearsWhenOff() {
  const device = makeDevice({ capabilities: { onoff: true } });
  device.api = { turnOff: async () => ({}), getStatus: async () => { throw new Error('x'); } };
  device._registerCapabilityListeners();

  // A booking's auto-off armed for +1h; then the app restarted.
  device.__store.autoStopAt = Date.now() + 3600000;
  device._scheduleAutoStop();
  assert.ok(
    device.homey.__timers.some((t) => t.ms > 0 && t.ms <= 3600000),
    'the auto-off timer is re-armed from the stored time',
  );

  // The sauna being found off (any reason) drops the pending auto-off so it
  // can't hit a later session.
  device.__store.autoStopAt = Date.now() + 3600000;
  await device._applyStatus({ isHeating: false, temperature: 22, targetTemperature: 80, doorClosed: true });
  assert.strictEqual(device.getStoreValue('autoStopAt'), null, 'a stopped sauna clears the pending auto-off');
  console.log('OK: the booking auto-off re-arms across a restart and clears once the sauna stops');
}

async function testSessionEnergyFromMeterDelta() {
  const device = makeDevice({ capabilities: { huum_session_count: 0, onoff: false } });
  device.__store.electricityPrice = 0.30;
  device.__store.powerSource = 'meter';
  device.__store.powerMeterId = 'm1';
  device.__store.meterTotalKwh = 100;

  device._lastStatus = { isHeating: false };
  await device._trackSessionStats({ isHeating: true, targetTemperature: 80, targetHumidity: 0 });
  assert.strictEqual(device.getStoreValue('sessionMeterStartKwh'), 100, 'meter snapshot taken at session start');

  device.__store.meterTotalKwh = 105.4; // the Shelly counted 5.4 kWh
  device.__store.sessionEnergyAt -= 90 * 60 * 1000;
  device._lastStatus = { isHeating: true };
  await device._trackSessionStats({ isHeating: false });

  const last = device.getStoreValue('lastSession');
  assert.strictEqual(last.kwh, 5.4, 'session kWh is the meter counter delta, not the estimate');
  assert.strictEqual(last.cost, 1.62, '5.4 kWh * 0.30');
  assert.strictEqual(last.energySource, 'meter');
  const hist = device.getStoreValue('sessionHistory');
  assert.strictEqual(hist.length, 1, 'the session lands in the history');
  assert.strictEqual(hist[0].kwh, 5.4);
  console.log('OK: with a linked meter, session energy is the meter counter delta and is kept in the history');
}

async function testStartProfilePickerFillsTheSliders() {
  const device = makeDevice({
    capabilities: { onoff: false, huum_start_profile: 'manual', target_temperature: 80, target_humidity: 0.2 },
  });
  device.__store.profile2Temperature = 50;
  device.__store.profile2Humidity = 55;
  device._registerCapabilityListeners();

  await device.triggerCapabilityListener('huum_start_profile', 'profile2');
  assert.strictEqual(device.getCapabilityValue('target_temperature'), 50, 'slider jumps to the profile temp');
  assert.strictEqual(device.getCapabilityValue('target_humidity'), 0.55, 'slider jumps to the profile humidity');
  assert.strictEqual(device.getCapabilityValue('huum_start_profile'), 'profile2');

  // A manual slider nudge afterwards drops back to "manual".
  await device.triggerCapabilityListener('target_temperature', 62);
  assert.strictEqual(device.getCapabilityValue('huum_start_profile'), 'manual', 'manual tweak clears the profile');
  console.log('OK: picking a profile fills the target sliders; a manual tweak clears the pick');
}

(async () => {
  await testPostActionRefreshFailureDoesNotRejectListener();
  await testDoorOpenErrorStillRejectsWithTranslatedMessage();
  await testHumidityExceedsMaxIsTranslated();
  await testAuthErrorMarksUnavailable();
  await testReconcileCapabilitiesAddsAndRemoves();
  await testAdaptivePollIntervalPicksActiveVsIdle();
  await testSessionTrackingCountsACompleteSession();
  await testSessionTrackingIgnoresEndWithNoKnownStart();
  await testSaveAndStartWithProfile();
  await testStartWithUnconfiguredProfileThrows();
  await testWaterSensorAbsentHidesAlarm();
  await testDoorSensorAbsentOverridesSafetyCheck();
  await testRemoteSafetyBlocksStartAndWarns();
  await testRemoteStateTriggersOnEdge();
  await testFormatDeviceDateTimeUsesTheHomeyTimezone();
  await testGetConfigExposesRemoteBlocked();
  await testCurrentTemperatureChangedFiresOnEveryChange();
  await testDutyCycleLowersTheEstimateAtTemp();
  await testSetMeasuredPowerFeedsCapability();
  await testProfileDefaultsSeededOverNull();
  await testSessionEnergyAndCost();
  await testSessionEnergyFromMeterDelta();
  await testWaterAlarmIgnoresZeroSteamerError();
  await testWaterCheckReminderFiresOnStart();
  await testTargetsNotOverwrittenWhileOff();
  await testStartProfilePickerFillsTheSliders();
  await testScheduledStartFires();
  await testClearBookingResetsTheTile();
  await testStaleBookingIsDroppedNotFired();
  await testFailedScheduledStartIsRecordedWithReason();
  await testAutoOffSurvivesRestartAndClearsWhenOff();
  await testStartProfilePickerStartsWithThatProfile();
  await testHumidityCapabilityScales();
  console.log('\nAll device.js exception-handling tests passed.');
})().catch((err) => {
  console.error('TEST FAILED:', err);
  process.exit(1);
});
