'use strict';

const Homey = require('homey');
const {
  HuumApi, HuumAuthError, HuumSafetyError, STEAMER_ERROR_TEXTS, CONFIG_FLAGS, configHasFlag,
} = require('../../lib/HuumApi');

const DEFAULT_POLL_INTERVAL_S = 30;
const DEFAULT_IDLE_POLL_INTERVAL_S = 300;
const DEFAULT_FINISHING_SOON_MINUTES = 10;
const DEFAULT_HEATER_POWER_KW = 6;
// A sauna heater runs at full power heating up, then cycles its element to
// hold the target — so a flat "kW × hours" over-estimates. Applied to the
// kW estimate once the room is within HEATUP_MARGIN of target. Ignored when
// a real power meter / Flow feeds measure_power.
const DEFAULT_DUTY_CYCLE = 60;
const HEATUP_MARGIN_C = 5;

// Seeded on first run / on "reset to defaults". Humidity is ignored on
// saunas without a steamer. The "Feucht" preset sits at the steamer's max
// humidity for its temperature (see HUMIDITY_THRESHOLDS in lib/HuumApi.js).
const DEFAULT_PROFILES = {
  profile1Name: 'Finnisch', profile1Temperature: 90, profile1Humidity: 0,
  profile2Name: 'Feucht', profile2Temperature: 50, profile2Humidity: 55,
  profile3Name: 'Family', profile3Temperature: 75, profile3Humidity: 25,
};

class HuumDevice extends Homey.Device {

  async onInit() {
    try {
      await this._createApiClient();
    } catch (err) {
      // Missing/corrupt store credentials (shouldn't happen via normal
      // pairing, but don't let it crash init if it ever does).
      this.error('Could not create API client:', err.message);
      await this.setUnavailable(this.homey.__('errors.missing_credentials')).catch(this.error);
      return;
    }
    this._wasBelowFinishingSoonThreshold = false;
    this._powerMeterInstance = null;

    await this._migrateLegacySettings();

    // If the app restarted mid-session, don't bill the downtime as energy:
    // restart the integration clock from now.
    if (this.getStoreValue('sessionStartedAt')) {
      await this.setStoreValue('sessionEnergyAt', Date.now()).catch(this.error);
    }

    // Detect which hardware modules (steamer/light) this UKU actually has
    // *before* registering capability listeners, so e.g. target_humidity
    // only gets a listener when it's actually there. Devices paired by an
    // older version of this app, or paired while the API didn't return
    // `config`, get corrected here too.
    let initialStatus = null;
    try {
      initialStatus = await this.api.getStatus();
      await this._reconcileCapabilities(initialStatus);
    } catch (err) {
      this.error('Initial capability detection failed:', err.message);
    }

    if (this.hasCapability('huum_start_profile') && this.getCapabilityValue('huum_start_profile') == null) {
      await this.setCapabilityValue('huum_start_profile', 'manual').catch(this.error);
    }

    this._registerCapabilityListeners();
    await this._applyEnergySetting();
    await this._bindPowerMeter().catch((err) => this.error('Power meter bind failed:', err.message));

    this._lastStatus = initialStatus;
    if (initialStatus) {
      await this._applyStatus(initialStatus).catch((err) => this.error('Applying initial status failed:', err.message));
    } else {
      await this._syncStatus().catch((err) => this.error('Initial status sync failed:', err.message));
    }

    this._scheduleNextPoll();
    this._scheduleBooking();
    this._scheduleAutoStop();
  }

  async onUninit() {
    this._clearPoll();
    this._clearBookingTimer();
    this._clearAutoStopTimer();
    await this._unbindPowerMeter();
  }

  async onDeleted() {
    this._clearPoll();
    await this._unbindPowerMeter();
  }

  /**
   * Profiles, poll intervals, the "finishing soon" threshold and the heater
   * power moved off the device settings page onto the app settings page, and
   * are stored in the device *store* now (settings must be declared in
   * app.json to exist; the store is free-form). Copy any values a previous
   * version of this app wrote as settings into the store, once.
   */
  async _migrateLegacySettings() {
    // getStoreValue() returns null (not undefined) for unset keys on real
    // Homey, so check both.
    const unset = (key) => {
      const v = this.getStoreValue(key);
      return v === undefined || v === null;
    };

    // One-time: copy anything an older version wrote as a real device setting
    // into the store (getSettings() may only expose still-declared settings,
    // so this is best-effort).
    if (!this.getStoreValue('cfgMigrated')) {
      const legacy = this.getSettings() || {};
      const keys = [
        'pollInterval', 'idlePollInterval', 'finishingSoonThresholdMinutes', 'heaterPowerKw',
        ...Object.keys(DEFAULT_PROFILES),
      ];
      for (const key of keys) {
        const value = legacy[key];
        if (value !== undefined && value !== null && unset(key)) {
          // eslint-disable-next-line no-await-in-loop
          await this.setStoreValue(key, value).catch(this.error);
        }
      }
      await this.setStoreValue('cfgMigrated', true).catch(this.error);
    }

    // Every init: make sure each profile holds *something* sensible. Seed a
    // whole profile's defaults only when its temperature is unset (so a user
    // who cleared one field doesn't get it silently repopulated).
    for (const n of [1, 2, 3]) {
      if (unset(`profile${n}Temperature`)) {
        // eslint-disable-next-line no-await-in-loop
        await this.setStoreValue(`profile${n}Name`, DEFAULT_PROFILES[`profile${n}Name`]).catch(this.error);
        // eslint-disable-next-line no-await-in-loop
        await this.setStoreValue(`profile${n}Temperature`, DEFAULT_PROFILES[`profile${n}Temperature`]).catch(this.error);
        // eslint-disable-next-line no-await-in-loop
        await this.setStoreValue(`profile${n}Humidity`, DEFAULT_PROFILES[`profile${n}Humidity`]).catch(this.error);
      }
    }
  }

  async onSettings({ changedKeys }) {
    if (changedKeys.includes('waterSensorMode') || changedKeys.includes('doorSensorMode')) {
      const status = this._lastStatus || {};
      await this._reconcileCapabilities(status).catch((err) => this.error('Reconcile after settings failed:', err.message));
      await this._applyStatus(status).catch((err) => this.error('Apply after settings failed:', err.message));
    }
    if (changedKeys.includes('showWarningBanner')) {
      await this._syncWarnings(this._lastStatus || {}).catch((err) => this.error('Warning sync failed:', err.message));
    }
  }

  // --- config store helpers (app settings page writes these) ----------------

  _cfg(key, fallback) {
    const value = this.getStoreValue(key);
    return (value === undefined || value === null) ? fallback : value;
  }

  async _setCfg(patch) {
    for (const [key, value] of Object.entries(patch)) {
      // eslint-disable-next-line no-await-in-loop
      await this.setStoreValue(key, value);
    }
  }

  /** Everything the app settings page needs for this device. */
  getConfig() {
    return {
      profiles: [1, 2, 3].map((n) => ({
        id: `profile${n}`,
        name: this._cfg(`profile${n}Name`, `Profile ${n}`),
        temperature: this._cfg(`profile${n}Temperature`, null),
        humidity: this._cfg(`profile${n}Humidity`, null),
      })),
      advanced: {
        pollInterval: this._cfg('pollInterval', DEFAULT_POLL_INTERVAL_S),
        idlePollInterval: this._cfg('idlePollInterval', DEFAULT_IDLE_POLL_INTERVAL_S),
        finishingSoonThresholdMinutes: this._cfg('finishingSoonThresholdMinutes', DEFAULT_FINISHING_SOON_MINUTES),
      },
      power: {
        source: this._powerSource(),
        meterId: this._cfg('powerMeterId', null),
        heaterPowerKw: this._cfg('heaterPowerKw', DEFAULT_HEATER_POWER_KW),
        dutyCycle: this._cfg('heaterDutyCycle', DEFAULT_DUTY_CYCLE),
      },
      costs: {
        electricityPrice: this._cfg('electricityPrice', 0),
      },
      booking: this.getBooking(),
      stats: {
        sessionCount: this.getStoreValue('sessionCount') || 0,
        totalHeatingMinutes: this.getStoreValue('totalHeatingMinutes') || 0,
        totalKwh: this.getStoreValue('totalKwh') || 0,
        totalCost: this.getStoreValue('totalCost') || 0,
        lastSession: this.getStoreValue('lastSession') || null,
      },
      hasSteamer: this.hasCapability('target_humidity'),
      hasMeter: this._usingPowerMeter(),
    };
  }

  /** Called by api.js when the app settings page saves. */
  async setConfig({
    profiles, advanced, power, costs, resetProfiles, booking, clearBooking,
  } = {}) {
    if (clearBooking) await this.clearBooking();
    else if (booking) await this.setBooking(booking);
    const patch = {};
    if (resetProfiles) {
      Object.assign(patch, DEFAULT_PROFILES);
    }
    if (Array.isArray(profiles)) {
      profiles.forEach((p, i) => {
        const n = i + 1;
        if (p && p.name != null) patch[`profile${n}Name`] = String(p.name).slice(0, 40);
        if (p && p.temperature != null && !Number.isNaN(Number(p.temperature))) {
          patch[`profile${n}Temperature`] = Math.round(Number(p.temperature));
        }
        if (p && p.humidity != null && !Number.isNaN(Number(p.humidity))) {
          patch[`profile${n}Humidity`] = Math.round(Number(p.humidity));
        }
      });
    }
    if (advanced) {
      for (const key of ['pollInterval', 'idlePollInterval', 'finishingSoonThresholdMinutes']) {
        if (advanced[key] != null && !Number.isNaN(Number(advanced[key]))) {
          patch[key] = Math.round(Number(advanced[key]));
        }
      }
    }
    if (power) {
      if (power.source) {
        patch.powerSource = ['meter', 'flow'].includes(power.source) ? power.source : 'estimate';
      }
      if ('meterId' in power) patch.powerMeterId = power.meterId || null;
      if (power.dutyCycle != null && !Number.isNaN(Number(power.dutyCycle))) {
        patch.heaterDutyCycle = Math.min(100, Math.max(1, Math.round(Number(power.dutyCycle))));
      }
      if (power.heaterPowerKw != null && !Number.isNaN(Number(power.heaterPowerKw))) {
        patch.heaterPowerKw = Number(power.heaterPowerKw);
      }
    }
    if (costs && costs.electricityPrice != null && !Number.isNaN(Number(costs.electricityPrice))) {
      patch.electricityPrice = Math.max(0, Number(costs.electricityPrice));
    }

    await this._setCfg(patch);
    this._scheduleNextPoll();
    await this.applyPowerConfig();
    return this.getConfig();
  }

  async applyPowerConfig() {
    const status = this._lastStatus || {};
    await this._reconcileCapabilities(status).catch((err) => this.error('Reconcile power capability failed:', err.message));
    await this._bindPowerMeter().catch((err) => this.error('Power meter (re)bind failed:', err.message));
    await this._applyEnergySetting();
  }

  // ---- Scheduled start ("Buchung") -----------------------------------------

  /** The single pending scheduled start, or null. */
  getBooking() {
    const b = this.getStoreValue('booking');
    return (b && typeof b.at === 'number') ? b : null;
  }

  /** Save (or with a falsy arg, clear) the scheduled start. */
  async setBooking(booking) {
    if (!booking || !booking.at) {
      await this.clearBooking();
      return null;
    }
    const at = Number(booking.at);
    if (!Number.isFinite(at) || at <= Date.now()) {
      throw new Error(this.homey.__('errors.booking_past'));
    }
    const num = (v) => (v != null && !Number.isNaN(Number(v)) ? Math.round(Number(v)) : null);
    const clean = {
      at,
      profile: /^profile[123]$/.test(booking.profile || '') ? booking.profile : null,
      temperature: num(booking.temperature),
      humidity: num(booking.humidity),
      autoStopMinutes: booking.autoStopMinutes ? Math.max(1, num(booking.autoStopMinutes)) : null,
      createdAt: Date.now(),
    };
    await this.setStoreValue('booking', clean);
    this._scheduleBooking();
    return this.getBooking();
  }

  async clearBooking() {
    this._clearBookingTimer();
    await this.setStoreValue('booking', null).catch(this.error);
  }

  _clearBookingTimer() {
    if (this._bookingTimeout) { this.homey.clearTimeout(this._bookingTimeout); this._bookingTimeout = null; }
  }

  _scheduleBooking() {
    this._clearBookingTimer();
    const b = this.getBooking();
    if (!b) return;
    const delay = b.at - Date.now();
    if (delay <= 0) {
      this._fireBooking().catch((err) => this.error('Booking fire failed:', err.message));
      return;
    }
    // this.homey.setTimeout caps around 24.8 days — re-arm past that.
    const MAX = 20 * 24 * 60 * 60 * 1000;
    const capped = delay > MAX;
    this._bookingTimeout = this.homey.setTimeout(() => {
      if (capped) this._scheduleBooking();
      else this._fireBooking().catch((err) => this.error('Booking fire failed:', err.message));
    }, Math.min(delay, MAX));
  }

  // ---- Auto-off timer (survives an app restart) ---------------------------

  _clearAutoStopTimer() {
    if (this._autoStopTimeout) { this.homey.clearTimeout(this._autoStopTimeout); this._autoStopTimeout = null; }
  }

  /** The app-side "turn off at" timer from a booking's optional auto-off. */
  _scheduleAutoStop() {
    this._clearAutoStopTimer();
    const at = this.getStoreValue('autoStopAt');
    if (typeof at !== 'number') return;
    const delay = at - Date.now();
    if (delay <= 0) {
      this.setStoreValue('autoStopAt', null).catch(this.error);
      this._withAuthHandling(this.api.turnOff())
        .then(() => this._syncStatus())
        .catch((err) => this.error('Auto-off failed:', err.message));
      return;
    }
    const MAX = 20 * 24 * 60 * 60 * 1000;
    const capped = delay > MAX;
    this._autoStopTimeout = this.homey.setTimeout(() => {
      if (capped) { this._scheduleAutoStop(); return; }
      this.setStoreValue('autoStopAt', null).catch(this.error);
      this.triggerCapabilityListener('onoff', false)
        .catch((err) => this.error('Auto-off failed:', err.message));
    }, Math.min(delay, MAX));
  }

  /** Cheap safety net in case a scheduled timer was lost across a restart. */
  _checkBookingDue() {
    const b = this.getBooking();
    if (b && b.at <= Date.now() && !this._firingBooking) {
      this._fireBooking().catch((err) => this.error('Booking fire failed:', err.message));
    }
  }

  async _fireBooking() {
    const b = this.getBooking();
    this._clearBookingTimer();
    if (!b || this._firingBooking) return;
    this._firingBooking = true;
    try {
      await this.setStoreValue('booking', null).catch(this.error);
      // Missed by more than 30 min (app was down) — don't start a sauna
      // nobody is standing next to.
      if (Date.now() - b.at > 30 * 60 * 1000) return;

      if (b.profile && typeof this._cfg(`${b.profile}Temperature`, null) === 'number') {
        await this.startWithProfile(b.profile);
      } else {
        const temp = typeof b.temperature === 'number'
          ? b.temperature : (this.getCapabilityValue('target_temperature') || 80);
        const hum = typeof b.humidity === 'number' ? b.humidity : this._getTargetHumidityPercent();
        await this._start(temp, hum);
        await this._maybeWaterCheckReminder();
      }
      await this._setCapabilitySafe('onoff', true);

      if (b.autoStopMinutes) {
        await this.setStoreValue('autoStopAt', Date.now() + b.autoStopMinutes * 60 * 1000).catch(this.error);
        this._scheduleAutoStop();
      }
      await this.homey.notifications.createNotification({
        excerpt: this.homey.__('notifications.booking_started', { name: this.getName() }),
      }).catch(() => {});
    } catch (err) {
      this.error('Scheduled start failed:', err.message);
      await this.homey.notifications.createNotification({
        excerpt: this.homey.__('notifications.booking_failed', { name: this.getName(), error: err.message }),
      }).catch(() => {});
    } finally {
      this._firingBooking = false;
      await this._syncStatus().catch((err) => this.error('Post-booking status refresh failed:', err.message));
    }
  }

  /**
   * Adaptive polling: check in often while the heater is actually heating,
   * much less often while it's off/idle, to go easy on the HUUM cloud.
   * Any capability change (turning on, changing temperature, ...) still
   * re-syncs immediately regardless of this schedule.
   */
  _scheduleNextPoll() {
    this._clearPoll();
    const activeSeconds = this._cfg('pollInterval', DEFAULT_POLL_INTERVAL_S);
    const idleSeconds = this._cfg('idlePollInterval', DEFAULT_IDLE_POLL_INTERVAL_S);
    const s = this._lastStatus || {};
    // Poll at the active cadence not just while heating, but also while the
    // owner is likely standing at the sauna — door open or a remote-start
    // block they're about to clear at the panel — so "I just shut the door"
    // shows up in seconds, not after the 5-minute idle interval.
    const attentive = s.isHeating || s.doorClosed === false || HuumDevice._isBlocked(s);
    const seconds = attentive ? activeSeconds : idleSeconds;

    this._pollTimeout = this.homey.setTimeout(() => {
      this._syncStatus().catch((err) => this.error('Status sync failed:', err.message));
    }, seconds * 1000);
  }

  _clearPoll() {
    if (this._pollTimeout) {
      this.homey.clearTimeout(this._pollTimeout);
      this._pollTimeout = null;
    }
  }

  async _createApiClient() {
    const { username, password } = this.getStore();
    this.api = new HuumApi({ username, password });
  }

  /** Called by the driver after a successful repair (credentials changed). */
  async onCredentialsUpdated() {
    // The new credentials are already saved to the store at this point —
    // don't let a hiccup here make the repair flow report failure.
    try {
      await this._createApiClient();
      await this.setAvailable().catch(this.error);
      await this._syncStatus();
    } catch (err) {
      this.error('Status sync after repair failed:', err.message);
    }
  }

  /**
   * Homey's Energy tab has no way to know a HUUM heater's real power draw
   * (the API doesn't report it), so we approximate it from the user-entered
   * "heaterPowerKw" value — unless the user linked a real power meter, in
   * which case the mirrored `measure_power` capability is what Energy uses
   * and the approximation is left off.
   */
  async _applyEnergySetting(heaterPowerKw) {
    if (this._hasLiveMeasurePower()) return;
    const kw = heaterPowerKw || this._cfg('heaterPowerKw', DEFAULT_HEATER_POWER_KW);
    if (typeof kw !== 'number' || !(typeof this.setEnergy === 'function')) return;
    try {
      await this.setEnergy({ approximation: { usageOn: Math.round(kw * 1000), usageOff: 0 } });
    } catch (err) {
      this.error('Could not apply per-device energy approximation:', err.message);
    }
  }

  _powerSource() {
    const s = this._cfg('powerSource', 'estimate');
    return (s === 'meter' || s === 'flow') ? s : 'estimate';
  }

  /** True when a linked device drives measure_power (not a Flow-fed value). */
  _usingPowerMeter() {
    return this._powerSource() === 'meter' && !!this._cfg('powerMeterId', null);
  }

  /** True when measure_power is a real value (linked meter or fed by a Flow). */
  _hasLiveMeasurePower() {
    return this._usingPowerMeter() || this._powerSource() === 'flow';
  }

  /** Flow action: feed an external power reading into this device. */
  async setMeasuredPower(watts) {
    const w = Math.max(0, Number(watts) || 0);
    if (!this.hasCapability('measure_power')) {
      await this.addCapability('measure_power').catch((err) => this.error('add measure_power:', err.message));
    }
    await this._setCapabilitySafe('measure_power', w);
  }

  async _bindPowerMeter() {
    await this._unbindPowerMeter();
    if (!this._usingPowerMeter()) return;
    const meterId = this._cfg('powerMeterId', null);
    try {
      const api = await this.homey.app.getHomeyApi();
      const meter = await api.devices.getDevice({ id: meterId });
      const capObj = meter.capabilitiesObj && meter.capabilitiesObj.measure_power;
      if (capObj && typeof capObj.value === 'number') {
        await this._setCapabilitySafe('measure_power', capObj.value);
      }
      this._powerMeterInstance = meter.makeCapabilityInstance('measure_power', (value) => {
        this._setCapabilitySafe('measure_power', typeof value === 'number' ? value : null)
          .catch((err) => this.error('measure_power mirror failed:', err.message));
      });
      this.log('Linked power meter', meterId);
    } catch (err) {
      // Permission missing, meter deleted, older firmware — fall back to the
      // kW estimate rather than break the device.
      this.error('Could not link power meter, using kW estimate instead:', err.message);
      await this._applyEnergySetting();
    }
  }

  async _unbindPowerMeter() {
    if (this._powerMeterInstance) {
      try {
        this._powerMeterInstance.destroy();
      } catch (err) {
        this.error('Power meter unbind failed:', err.message);
      }
      this._powerMeterInstance = null;
    }
  }

  _registerCapabilityListeners() {
    this.registerCapabilityListener('onoff', (value) => this._setPower(value));

    this.registerCapabilityListener('target_temperature', async (value) => {
      // The HUUM API has no separate "set temperature while off" endpoint;
      // it only accepts a temperature as part of /start. If the heater is
      // off we just keep the value locally for the next start.
      if (!this.getCapabilityValue('onoff')) {
        await this._clearStartProfileOnManualChange();
        return;
      }
      const humidity = this._getTargetHumidityPercent();
      await this._start(value, humidity);
      await this._syncStatus().catch((err) => this.error('Post-action status refresh failed:', err.message));
    });

    // The whole point of this app: target_humidity is settable here, unlike
    // in the official HUUM app. Only present on saunas with a steamer.
    if (this.hasCapability('target_humidity')) {
      this.registerCapabilityListener('target_humidity', async (value) => {
        const humidityPercent = Math.round(value * 100);
        if (!this.getCapabilityValue('onoff')) {
          // Keep it locally; it will be sent along with the next start.
          await this.setCapabilityValue('target_humidity', value).catch(this.error);
          await this._clearStartProfileOnManualChange();
          return;
        }
        const temperature = this.getCapabilityValue('target_temperature') || 80;
        await this._start(temperature, humidityPercent);
        await this._syncStatus().catch((err) => this.error('Post-action status refresh failed:', err.message));
      });
    }

    if (this.hasCapability('onoff.light')) {
      this.registerCapabilityListener('onoff.light', async (value) => {
        // The API only exposes a toggle, so we only call it when the
        // requested state actually differs from the last known state.
        const current = this.getCapabilityValue('onoff.light');
        if (current !== value) {
          await this._withAuthHandling(this.api.toggleLight());
        }
        await this._syncStatus().catch((err) => this.error('Post-action status refresh failed:', err.message));
      });
    }

    if (this.hasCapability('huum_refresh')) {
      this.registerCapabilityListener('huum_refresh', async () => { await this.refreshNow(); });
    }

    if (this.hasCapability('huum_start_profile')) {
      this.registerCapabilityListener('huum_start_profile', async (value) => {
        await this.setCapabilityValue('huum_start_profile', value).catch(this.error);
        if (!value || value === 'manual') return;
        const temperature = this._cfg(`${value}Temperature`, null);
        if (typeof temperature !== 'number') return; // profile not configured yet

        if (this.getCapabilityValue('onoff')) {
          // Already heating — actually switch the sauna to this profile now.
          await this.startWithProfile(value);
          return;
        }
        // Off — reflect the profile in the target sliders so it's clear what
        // the next start will use (and _applyStatus won't overwrite it while off).
        await this._setCapabilitySafe('target_temperature', temperature);
        if (this.hasCapability('target_humidity')) {
          const hum = this._cfg(`${value}Humidity`, null);
          if (typeof hum === 'number') await this._setCapabilitySafe('target_humidity', hum / 100);
        }
      });
    }
  }

  /** A manual tweak of the target sliders means "not a canned profile anymore". */
  async _clearStartProfileOnManualChange() {
    if (this.hasCapability('huum_start_profile')
      && this.getCapabilityValue('huum_start_profile') !== 'manual') {
      await this.setCapabilityValue('huum_start_profile', 'manual').catch(this.error);
    }
  }

  /**
   * The profile id the device's onoff toggle should start with, or null for
   * "use the last target temperature/humidity" (the `manual` choice, or a
   * profile that has no temperature configured yet).
   */
  _pendingStartProfile() {
    if (!this.hasCapability('huum_start_profile')) return null;
    const p = this.getCapabilityValue('huum_start_profile');
    if (!p || p === 'manual') return null;
    return typeof this._cfg(`${p}Temperature`, null) === 'number' ? p : null;
  }

  /** Turn the sauna on/off (the onoff capability listener). */
  async _setPower(on) {
    const wasOn = !!this.getCapabilityValue('onoff');
    if (on) {
      const profile = this._pendingStartProfile();
      if (profile) {
        // startWithProfile() runs the water-check reminder + status refresh.
        await this.startWithProfile(profile);
        await this._setCapabilitySafe('onoff', true);
        return;
      }
      const temperature = this.getCapabilityValue('target_temperature') || 80;
      await this._start(temperature, this._getTargetHumidityPercent());
      if (!wasOn) await this._maybeWaterCheckReminder();
    } else {
      await this._withAuthHandling(this.api.turnOff());
    }
    // The command above already succeeded; a follow-up status-refresh hiccup
    // must not make the action look like it failed.
    await this._setCapabilitySafe('onoff', on);
    await this._syncStatus().catch((err) => this.error('Post-action status refresh failed:', err.message));
  }

  /**
   * Wraps a HuumApi call so that an auth failure consistently marks the
   * device unavailable (with a clear, translated reason) no matter which
   * API method it came from, instead of only doing this inside _start().
   */
  async _withAuthHandling(promise) {
    try {
      return await promise;
    } catch (err) {
      if (err instanceof HuumAuthError) {
        await this.setUnavailable(this.homey.__('errors.auth_failed')).catch(this.error);
      }
      throw err;
    }
  }

  _getTargetHumidityPercent() {
    if (!this.hasCapability('target_humidity')) return undefined;
    const value = this.getCapabilityValue('target_humidity');
    return typeof value === 'number' ? Math.round(value * 100) : undefined;
  }

  /**
   * `present`/`absent` from the device settings force the answer; `auto`
   * derives it — the steamer's water sensor from the API's `config` bitmask,
   * the door sensor is assumed present (HUUM's API never reports whether a
   * door contact is wired up).
   */
  _sensorPresent(kind, status) {
    const mode = kind === 'water' ? this.getSetting('waterSensorMode') : this.getSetting('doorSensorMode');
    if (mode === 'present') return true;
    if (mode === 'absent') return false;
    if (kind === 'water') return configHasFlag(status && status.config, CONFIG_FLAGS.STEAMER);
    return true;
  }

  async _maybeWaterCheckReminder() {
    if (!this.getSetting('waterCheckReminder')) return;
    await this.homey.notifications.createNotification({
      excerpt: this.homey.__('notifications.water_check_reminder', { name: this.getName() }),
    }).catch((err) => this.error('Failed to create water-check reminder:', err.message));
  }

  async _start(temperature, humidityPercent) {
    // The UKU can require someone to confirm safety on the physical panel
    // before it accepts a remote start (status.remoteSafetyState). The
    // official app blocks the start with the same message. Re-check with a
    // fresh status first — the cached one can be minutes old, and the user
    // may have just confirmed safety on the panel.
    let last = this._lastStatus;
    if (last && typeof last.remoteSafetyState === 'string'
      && last.remoteSafetyState.toLowerCase() !== 'safe') {
      try {
        last = await this.api.getStatus();
        this._lastStatus = last;
      } catch (err) { /* fall through with the cached status */ }
      if (last && typeof last.remoteSafetyState === 'string'
        && last.remoteSafetyState.toLowerCase() !== 'safe') {
        throw new Error(this.homey.__('errors.remote_disabled'));
      }
    }
    try {
      const args = { temperature, humidity: humidityPercent };
      if (!this._sensorPresent('door', this._lastStatus)) {
        // No door contact wired up → the API would otherwise report the
        // door as permanently open and block every start.
        args.safetyOverride = true;
      }
      await this._withAuthHandling(this.api.turnOn(args));
    } catch (err) {
      if (err instanceof HuumSafetyError) {
        throw new Error(this.homey.__('errors.door_open'));
      }
      if (err.code === 'humidity_exceeds_max') {
        throw new Error(this.homey.__('errors.humidity_exceeds_max', err.data));
      }
      // Anything else (network error, temperature out of range, ...) is
      // re-thrown as-is — Homey shows err.message to the user either way,
      // this is just the subset worth a translated, friendlier message.
      throw err;
    }
  }

  /** Used by the "start_with_temperature_and_humidity" Flow action card. */
  async startWithTemperatureAndHumidity(temperature, humidityPercent) {
    const wasOff = !this.getCapabilityValue('onoff');
    await this._start(temperature, humidityPercent);
    if (wasOff) await this._maybeWaterCheckReminder();
    await this._syncStatus().catch((err) => this.error('Post-action status refresh failed:', err.message));
  }

  async _syncStatus() {
    this._checkBookingDue();
    let status;
    try {
      status = await this.api.getStatus();
    } catch (err) {
      if (err instanceof HuumAuthError) {
        await this.setUnavailable(this.homey.__('errors.auth_failed')).catch(this.error);
      }
      // Keep polling on failure too (e.g. a transient network hiccup),
      // at whatever cadence our last known state warrants.
      this._scheduleNextPoll();
      throw err;
    }

    if (!this.getAvailable()) {
      await this.setAvailable().catch(this.error);
    }

    await this._reconcileCapabilities(status);
    await this._applyStatus(status);

    this._lastStatus = status;
    this._scheduleNextPoll();

    return status;
  }

  /**
   * Adds/removes the steamer-, light-, sensor- and power-meter-dependent
   * capabilities to match what this UKU is actually configured for
   * (HuumStatusResponse.config) and what the owner declared in the
   * Sensors/hardware settings. Detected once at startup and re-checked on
   * every poll.
   */
  async _reconcileCapabilities(status) {
    status = status || {};
    const hasSteamer = configHasFlag(status.config, CONFIG_FLAGS.STEAMER);
    const hasLight = configHasFlag(status.config, CONFIG_FLAGS.LIGHT);
    const waterSensor = this._sensorPresent('water', status);
    const doorSensor = this._sensorPresent('door', status);

    const wanted = new Map([
      ['target_humidity', hasSteamer],
      ['measure_humidity', hasSteamer],
      ['alarm_water', hasSteamer && waterSensor],
      ['onoff.light', hasLight],
      ['alarm_contact', doorSensor],
      ['measure_power', this._hasLiveMeasurePower()],
      ['huum_start_profile', true],
      ['huum_refresh', true],
      // Split from the plain capability so Homey stops pairing it with
      // target_temperature into a "heating to X" thermostat dial.
      ['measure_temperature.room', true],
      ['measure_temperature', false],
      // Retired: drop it from devices paired by the version that briefly had it.
      ['thermostat_mode', false],
    ]);

    for (const [capabilityId, shouldHave] of wanted) {
      const has = this.hasCapability(capabilityId);
      if (shouldHave && !has) {
        // eslint-disable-next-line no-await-in-loop
        await this.addCapability(capabilityId)
          .catch((err) => this.error(`Failed to add capability ${capabilityId}:`, err.message));
      } else if (!shouldHave && has) {
        // eslint-disable-next-line no-await-in-loop
        await this.removeCapability(capabilityId)
          .catch((err) => this.error(`Failed to remove capability ${capabilityId}:`, err.message));
      }
    }
  }

  async _applyStatus(status) {
    await this._setCapabilitySafe('onoff', status.isHeating);
    // A pending auto-off only makes sense while this same session runs — the
    // moment the sauna is off (manually, at the panel, or the UKU's own
    // limit) forget it so it can't clobber a later session.
    if (!status.isHeating && this.getStoreValue('autoStopAt') != null) {
      this._clearAutoStopTimer();
      await this.setStoreValue('autoStopAt', null).catch(this.error);
    }
    await this._setCapabilitySafe('measure_temperature.room', status.temperature);
    await this._setCapabilitySafe('measure_humidity', status.humidity);
    // The target temp/humidity capabilities double as "what the next start
    // uses". Only let HUUM's values win while it's actually heating — when
    // off they hold the owner's intent (a profile pick, a slider nudge).
    if (status.isHeating) {
      await this._setCapabilitySafe('target_temperature', status.targetTemperature);
      if (typeof status.targetHumidity === 'number') {
        // Homey's target_humidity is a 0-1 fraction shown as %, unlike
        // measure_humidity which is a plain 0-100 reading.
        await this._setCapabilitySafe('target_humidity', status.targetHumidity / 100);
      }
    }
    // _setCapabilitySafe is a no-op when the capability was removed (door
    // sensor declared absent), so no extra guard needed here.
    await this._setCapabilitySafe('alarm_contact', !status.doorClosed);
    if (this.hasCapability('onoff.light') && typeof status.light === 'number') {
      await this._setCapabilitySafe('onoff.light', status.light !== 0);
    }

    await this._syncWarnings(status);
    await this._syncRemoteState(status);
    await this._syncSafetyAlarms(status);
    await this._syncTimeRemaining(status);
    await this._trackSessionStats(status);
    await this._applyDeviceLimits(status);
    await this._syncInfoSettings(status);

    return status;
  }

  /** Whether the UKU currently refuses a remote start (safety not confirmed). */
  static _isBlocked(status) {
    return !!status && typeof status.remoteSafetyState === 'string'
      && status.remoteSafetyState.toLowerCase() !== 'safe';
  }

  /** For the "remote start is/is not blocked" Flow condition. */
  isRemoteBlocked() {
    return HuumDevice._isBlocked(this._lastStatus);
  }

  /** Fire the remote_control_blocked / _available Flow triggers on the edge. */
  async _syncRemoteState(status) {
    const blocked = HuumDevice._isBlocked(status);
    if (this._remoteBlocked === undefined) { this._remoteBlocked = blocked; return; }
    if (blocked === this._remoteBlocked) return;
    this._remoteBlocked = blocked;
    const cardId = blocked ? 'remote_control_blocked' : 'remote_control_available';
    this.homey.flow.getDeviceTriggerCard(cardId)
      .trigger(this)
      .catch((err) => this.error(`Failed to trigger ${cardId}:`, err.message));
  }

  /**
   * Mirrors the official HUUM app's banners as a Homey device warning: the
   * two conditions that actually stop a remote start — the UKU's remote
   * safety lock, and an open door.
   */
  async _syncWarnings(status) {
    if (typeof this.setWarning !== 'function') return;
    if (this.getSetting('showWarningBanner') === false) {
      if (this._lastWarning) { this._lastWarning = ''; await this.unsetWarning().catch(this.error); }
      return;
    }
    const parts = [];
    if (typeof status.remoteSafetyState === 'string' && status.remoteSafetyState.toLowerCase() !== 'safe') {
      parts.push(this.homey.__('warnings.remote_disabled'));
    }
    if (this.hasCapability('alarm_contact') && status.doorClosed === false) {
      parts.push(this.homey.__('warnings.door_open'));
    }
    const message = parts.join(' ');
    if (message === this._lastWarning) return;
    this._lastWarning = message;
    try {
      if (message) await this.setWarning(message);
      else await this.unsetWarning();
    } catch (err) {
      this.error('Could not set device warning:', err.message);
    }
  }

  async _syncSafetyAlarms(status) {
    const hasWaterCapability = this.hasCapability('alarm_water');
    const hadWaterAlarm = hasWaterCapability ? this.getCapabilityValue('alarm_water') : false;
    // steamerError 0 (or null) means "no problem"; only a positive code is an
    // actual fault (the UKU manual documents code 1 = no water).
    const hasWaterAlarm = hasWaterCapability && typeof status.steamerError === 'number' && status.steamerError > 0;
    await this._setCapabilitySafe('alarm_water', hasWaterAlarm);
    await this._setCapabilitySafe('alarm_generic', status.isEmergencyStop);

    if (hasWaterAlarm && !hadWaterAlarm && this.getSetting('notifyOnWaterAlarm')) {
      const detail = STEAMER_ERROR_TEXTS[status.steamerError] || this.homey.__('notifications.water_alarm_body');
      this.homey.notifications.createNotification({
        excerpt: `${this.homey.__('notifications.water_alarm_title', { name: this.getName() })} ${detail}`,
      }).catch((err) => this.error('Failed to create water alarm notification:', err.message));
    }
  }

  async _syncTimeRemaining(status) {
    if (!this.hasCapability('huum_time_remaining')) return;

    let minutesRemaining = 0;
    if (status.isHeating && typeof status.endDate === 'number') {
      const secondsRemaining = status.endDate - Math.floor(Date.now() / 1000);
      minutesRemaining = Math.max(0, Math.round(secondsRemaining / 60));
    }
    await this._setCapabilitySafe('huum_time_remaining', minutesRemaining);

    const threshold = this._cfg('finishingSoonThresholdMinutes', DEFAULT_FINISHING_SOON_MINUTES);
    const isBelowThreshold = status.isHeating && minutesRemaining > 0 && minutesRemaining <= threshold;

    if (isBelowThreshold && !this._wasBelowFinishingSoonThreshold) {
      this.homey.flow.getDeviceTriggerCard('huum_finishing_soon')
        .trigger(this, { minutes: minutesRemaining })
        .catch((err) => this.error('Failed to trigger huum_finishing_soon:', err.message));
    }
    // Reset the edge once heating stops or we're comfortably above the
    // threshold again, so the trigger can fire again on the next run.
    this._wasBelowFinishingSoonThreshold = status.isHeating && (isBelowThreshold || minutesRemaining <= threshold);
  }

  /**
   * HUUM's cloud keeps no session history at all (the status endpoint is
   * purely "right now"), so this app tracks it itself by watching
   * isHeating transitions across polls, persisted in the device store so
   * it survives app restarts. Only counts sessions this app was actually
   * running to observe — see the "Total heating time" setting hint.
   */
  async _trackSessionStats(status) {
    await this._setCapabilitySafe('huum_session_count', this.getStoreValue('sessionCount') || 0);
    await this._accrueSessionEnergy();

    const wasHeating = this._lastStatus ? this._lastStatus.isHeating : undefined;
    const isHeating = status.isHeating;

    if (wasHeating === undefined) {
      // First reading since the app started. If we're already heating we
      // don't know the real start time — approximate it as "now" so a
      // duration can still be recorded if we see this session end.
      if (isHeating && !this.getStoreValue('sessionStartedAt')) {
        await this._beginSessionTracking(status);
      }
      return;
    }

    if (!wasHeating && isHeating) {
      await this._beginSessionTracking(status);
    } else if (wasHeating && !isHeating) {
      await this._endSessionTracking();
    }
  }

  async _beginSessionTracking(status) {
    await this.setStoreValue('sessionStartedAt', Date.now());
    await this.setStoreValue('sessionStartTemperature', status.targetTemperature ?? null);
    await this.setStoreValue(
      'sessionStartHumidityPercent',
      typeof status.targetHumidity === 'number' ? status.targetHumidity : 0,
    );
    await this.setStoreValue('sessionWh', 0);
    await this.setStoreValue('sessionEnergyAt', Date.now());
  }

  /** Best guess at the heater's current draw in watts. */
  _currentPowerW() {
    // A real reading (linked meter or Flow-fed) wins.
    if (this._hasLiveMeasurePower() && this.hasCapability('measure_power')) {
      const p = this.getCapabilityValue('measure_power');
      if (typeof p === 'number' && p >= 0) return p;
    }
    // Estimate: full rated power while heating up, duty-cycled once at temp.
    const full = (Number(this._cfg('heaterPowerKw', DEFAULT_HEATER_POWER_KW)) || DEFAULT_HEATER_POWER_KW) * 1000;
    const measure = this.getCapabilityValue('measure_temperature.room');
    const target = this.getCapabilityValue('target_temperature');
    const atTemp = typeof measure === 'number' && typeof target === 'number'
      && measure >= target - HEATUP_MARGIN_C;
    if (!atTemp) return full;
    const duty = Math.min(100, Math.max(0, Number(this._cfg('heaterDutyCycle', DEFAULT_DUTY_CYCLE)) || DEFAULT_DUTY_CYCLE));
    return full * (duty / 100);
  }

  /**
   * Integrate power draw over the current session (poll to poll), so the app
   * can show kWh and a cost per session even though the HUUM API never
   * reports energy. Uses the linked power meter's live reading when there is
   * one, otherwise the entered heater-power estimate.
   */
  async _accrueSessionEnergy() {
    if (!this.getStoreValue('sessionStartedAt')) return;
    const at = this.getStoreValue('sessionEnergyAt') || Date.now();
    const now = Date.now();
    const hours = (now - at) / 3600000;
    const wasHeating = this._lastStatus ? this._lastStatus.isHeating : true;
    if (wasHeating && hours > 0 && hours < 12) {
      const wh = (this.getStoreValue('sessionWh') || 0) + this._currentPowerW() * hours;
      await this.setStoreValue('sessionWh', wh);
    }
    await this.setStoreValue('sessionEnergyAt', now);
  }

  async _endSessionTracking() {
    const startedAt = this.getStoreValue('sessionStartedAt');
    if (!startedAt) return; // App restarted mid-session — no reliable start time to measure from.

    await this._accrueSessionEnergy(); // credit the final poll-to-stop interval

    const endedAt = Date.now();
    const durationMinutes = Math.max(0, Math.round((endedAt - startedAt) / 60000));
    const temperature = this.getStoreValue('sessionStartTemperature') ?? null;
    const humidity = this.getStoreValue('sessionStartHumidityPercent') || 0;

    const round2 = (n) => Math.round(n * 100) / 100;
    const kwh = round2((this.getStoreValue('sessionWh') || 0) / 1000);
    const price = Number(this._cfg('electricityPrice', 0)) || 0;
    const cost = price > 0 ? round2(kwh * price) : 0;

    const sessionCount = (this.getStoreValue('sessionCount') || 0) + 1;
    const totalHeatingMinutes = (this.getStoreValue('totalHeatingMinutes') || 0) + durationMinutes;

    await this.setStoreValue('sessionCount', sessionCount);
    await this.setStoreValue('totalHeatingMinutes', totalHeatingMinutes);
    await this.setStoreValue('totalKwh', round2((this.getStoreValue('totalKwh') || 0) + kwh));
    await this.setStoreValue('totalCost', round2((this.getStoreValue('totalCost') || 0) + cost));
    await this.setStoreValue('lastSession', {
      startedAt, endedAt, durationMinutes, temperature, humidity, kwh, cost,
    });
    await this.setStoreValue('sessionStartedAt', null);
    await this.setStoreValue('sessionWh', 0);
    await this.setStoreValue('sessionEnergyAt', null);

    await this._setCapabilitySafe('huum_session_count', sessionCount);

    this.homey.flow.getDeviceTriggerCard('sauna_session_ended')
      .trigger(this, {
        duration: durationMinutes, temperature: temperature || 0, humidity, kwh, cost,
      })
      .catch((err) => this.error('Failed to trigger sauna_session_ended:', err.message));
  }

  _formatDuration(totalMinutes) {
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
  }

  _buildSessionSummaryText() {
    const lastSession = this.getStoreValue('lastSession');
    if (!lastSession) return this.homey.__('labels.no_sessions_yet');

    const dateStr = new Date(lastSession.startedAt).toLocaleString();
    const durationStr = this._formatDuration(lastSession.durationMinutes);
    const humidityStr = lastSession.humidity > 0 ? `, ${lastSession.humidity}%` : '';
    const temperatureStr = typeof lastSession.temperature === 'number' ? `${lastSession.temperature}°C` : '?';
    const energyStr = lastSession.kwh > 0
      ? `, ${lastSession.kwh} kWh${lastSession.cost > 0 ? ` (${lastSession.cost})` : ''}`
      : '';
    return `${dateStr} (${durationStr}), ${temperatureStr}${humidityStr}${energyStr}`;
  }

  /** Used by the "start_with_profile" Flow action card and the app page. */
  async startWithProfile(profileId) {
    const temperature = this._cfg(`${profileId}Temperature`, null);
    if (typeof temperature !== 'number') {
      throw new Error(this.homey.__('errors.profile_not_configured'));
    }
    const wasOff = !this.getCapabilityValue('onoff');
    // Only pass humidity to a sauna that actually has a steamer.
    const humidity = this.hasCapability('target_humidity')
      ? this._cfg(`${profileId}Humidity`, undefined)
      : undefined;
    await this._start(temperature, humidity);
    if (wasOff) await this._maybeWaterCheckReminder();
    await this._syncStatus().catch((err) => this.error('Post-action status refresh failed:', err.message));
  }

  /** Used by the "save_profile" Flow action card. */
  async saveProfile(profileId) {
    const temperature = this.getCapabilityValue('target_temperature');
    const patch = { [`${profileId}Temperature`]: temperature };
    const humidityPercent = this._getTargetHumidityPercent();
    if (typeof humidityPercent === 'number') {
      patch[`${profileId}Humidity`] = humidityPercent;
    }
    await this._setCfg(patch);
  }

  /**
   * The heater itself reports its real min/max temperature and timer
   * limits (saunaConfig) — use those instead of the hardcoded 40-110°C
   * default whenever they're available and different.
   */
  async _applyDeviceLimits(status) {
    const config = status.saunaConfig;
    if (!config || typeof this.setCapabilityOptions !== 'function') return;
    if (typeof config.minTemp !== 'number' || typeof config.maxTemp !== 'number') return;

    const key = `${config.minTemp}-${config.maxTemp}`;
    // Persisted in the store: setCapabilityOptions() re-initialises the
    // device, and an instance flag resets on every onInit — that would loop
    // forever if the heater's limits differ from the app.json defaults.
    if (this.getStoreValue('appliedTempLimits') === key) return;

    const current = this.getCapabilityOptions ? this.getCapabilityOptions('target_temperature') : null;
    if (current && current.min === config.minTemp && current.max === config.maxTemp) {
      await this.setStoreValue('appliedTempLimits', key).catch(this.error);
      return;
    }

    try {
      await this.setCapabilityOptions('target_temperature', {
        min: config.minTemp,
        max: config.maxTemp,
      });
      await this.setStoreValue('appliedTempLimits', key).catch(this.error);
    } catch (err) {
      this.error('Could not apply device-reported temperature limits:', err.message);
    }
  }

  /** The full read-only picture of the sauna, for settings + the app page. */
  _buildInfoModel(status) {
    const src = status || this._lastStatus || {};
    const config = src.saunaConfig;
    const yesNo = (bool) => this.homey.__(bool ? 'labels.yes' : 'labels.no');
    return {
      currentStatus: this.homey.__(`status.${src.statusCode}`) || src.statusText || '-',
      steamerInstalled: yesNo(configHasFlag(src.config, CONFIG_FLAGS.STEAMER)),
      lightInstalled: yesNo(configHasFlag(src.config, CONFIG_FLAGS.LIGHT)),
      childLock: config ? String(config.childLock) : '-',
      remoteSafetyState: src.remoteSafetyState || '-',
      remoteBlocked: this.homey.__(HuumDevice._isBlocked(src) ? 'labels.yes' : 'labels.no'),
      paymentEndDate: src.paymentEndDate || '-',
      deviceLimits: config
        ? `${config.minTemp}–${config.maxTemp} °C${config.maxTimer ? `, timer ${config.minTimer}–${config.maxTimer} h` : ''}`
        : '-',
      maxHeatingTime: (config && (config.maxHeatingTime || config.maxHeatTime))
        ? `${config.maxHeatingTime || config.maxHeatTime} h`
        : '-',
      totalHeatingTime: this._formatDuration(this.getStoreValue('totalHeatingMinutes') || 0),
      lastSessionSummary: this._buildSessionSummaryText(),
    };
  }

  async _syncInfoSettings(status) {
    const model = this._buildInfoModel(status);
    // Only the three fields still shown in device settings; the rest of the
    // read-out lives on the app settings page (_buildInfoModel feeds both).
    const settings = {
      currentStatus: model.currentStatus,
      steamerInstalled: model.steamerInstalled,
      lightInstalled: model.lightInstalled,
    };

    const current = this.getSettings();
    const changed = Object.keys(settings).some((k) => current[k] !== settings[k]);
    if (!changed) return;

    await this.setSettings(settings).catch((err) => this.error('Failed to update info settings:', err.message));
  }

  /** Everything the app settings page shows for this sauna. */
  getPublicState() {
    const s = this._lastStatus || {};
    return {
      id: this.getData().id,
      name: this.getName(),
      available: this.getAvailable(),
      heating: !!this.getCapabilityValue('onoff'),
      measureTemperature: this.getCapabilityValue('measure_temperature.room') ?? null,
      targetTemperature: this.getCapabilityValue('target_temperature') ?? null,
      measureHumidity: this.hasCapability('measure_humidity') ? (this.getCapabilityValue('measure_humidity') ?? null) : null,
      targetHumidity: this.hasCapability('target_humidity') ? (this.getCapabilityValue('target_humidity') ?? null) : null,
      timeRemaining: this.getCapabilityValue('huum_time_remaining') ?? null,
      doorOpen: this.hasCapability('alarm_contact') ? !!this.getCapabilityValue('alarm_contact') : null,
      measurePower: this.hasCapability('measure_power') ? (this.getCapabilityValue('measure_power') ?? null) : null,
      statusText: s.statusText || null,
      info: this._buildInfoModel(s),
      stats: {
        sessionCount: this.getStoreValue('sessionCount') || 0,
        totalHeatingMinutes: this.getStoreValue('totalHeatingMinutes') || 0,
        totalKwh: this.getStoreValue('totalKwh') || 0,
        totalCost: this.getStoreValue('totalCost') || 0,
        lastSession: this.getStoreValue('lastSession') || null,
      },
      config: this.getConfig(),
    };
  }

  /** App-page "refresh" button: pull a fresh reading from HUUM right now. */
  async refreshNow() {
    try {
      await this._syncStatus();
    } catch (err) {
      this.error('Manual refresh failed:', err.message);
    }
  }

  /** Compact live state for the dashboard widget. */
  getWidgetState() {
    const s = this._lastStatus || {};
    const th = this.hasCapability('target_humidity')
      ? Math.round((this.getCapabilityValue('target_humidity') || 0) * 100)
      : null;
    return {
      name: this.getName(),
      available: this.getAvailable(),
      heating: !!this.getCapabilityValue('onoff'),
      measureTemperature: this.getCapabilityValue('measure_temperature.room') ?? null,
      targetTemperature: this.getCapabilityValue('target_temperature') ?? null,
      hasSteamer: this.hasCapability('target_humidity'),
      targetHumidity: th,
      timeRemaining: this.getCapabilityValue('huum_time_remaining') ?? null,
      doorOpen: this.hasCapability('alarm_contact') ? !!this.getCapabilityValue('alarm_contact') : false,
      remoteBlocked: HuumDevice._isBlocked(s),
      emergencyStop: this.hasCapability('alarm_generic') ? !!this.getCapabilityValue('alarm_generic') : false,
      statusText: s.statusText || null,
      startProfile: this.hasCapability('huum_start_profile') ? this.getCapabilityValue('huum_start_profile') : 'manual',
      profiles: [1, 2, 3].map((n) => ({
        id: `profile${n}`,
        name: this._cfg(`profile${n}Name`, `Profil ${n}`),
        temperature: this._cfg(`profile${n}Temperature`, null),
        humidity: this._cfg(`profile${n}Humidity`, null),
      })),
    };
  }

  /** Widget: turn on with the last settings, or off. */
  async widgetSetPower(on) {
    await this.triggerCapabilityListener('onoff', !!on);
    return this.getWidgetState();
  }

  /** Widget: start (or re-start) with a named profile. */
  async widgetStartProfile(profileId) {
    await this.startWithProfile(profileId);
    if (this.hasCapability('huum_start_profile')) {
      await this.setCapabilityValue('huum_start_profile', profileId).catch(this.error);
    }
    await this._setCapabilitySafe('onoff', true);
    return this.getWidgetState();
  }

  async _setCapabilitySafe(capabilityId, value) {
    if (!this.hasCapability(capabilityId)) return;
    if (value === null || value === undefined) return;
    if (this.getCapabilityValue(capabilityId) === value) return;
    await this.setCapabilityValue(capabilityId, value).catch((err) => {
      this.error(`Failed to set capability ${capabilityId}:`, err.message);
    });
  }

}

module.exports = HuumDevice;
