'use strict';

const Homey = require('homey');
const {
  HuumApi, HuumAuthError, HuumSafetyError, STEAMER_ERROR_TEXTS, CONFIG_FLAGS, configHasFlag,
} = require('../../lib/HuumApi');

// Capabilities that only make sense if the corresponding hardware module
// (per HuumStatusResponse.config) is actually present on this UKU.
const STEAMER_CAPABILITIES = ['target_humidity', 'measure_humidity', 'alarm_water'];
const LIGHT_CAPABILITIES = ['onoff.light'];

const DEFAULT_POLL_INTERVAL_S = 30;
const DEFAULT_IDLE_POLL_INTERVAL_S = 300;
const DEFAULT_FINISHING_SOON_MINUTES = 10;

class HuumDevice extends Homey.Device {

  async onInit() {
    await this._createApiClient();
    this._appliedCapabilityLimits = null;
    this._wasBelowFinishingSoonThreshold = false;

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

    this._registerCapabilityListeners();
    await this._applyEnergySetting();

    this._lastStatus = initialStatus;
    if (initialStatus) {
      await this._applyStatus(initialStatus).catch((err) => this.error('Applying initial status failed:', err.message));
    } else {
      await this._syncStatus().catch((err) => this.error('Initial status sync failed:', err.message));
    }

    this._scheduleNextPoll();
  }

  async onUninit() {
    this._clearPoll();
  }

  async onDeleted() {
    this._clearPoll();
  }

  async onSettings({ oldSettings, newSettings, changedKeys }) {
    if (changedKeys.includes('pollInterval') || changedKeys.includes('idlePollInterval')) {
      // Re-schedule immediately with the new interval, using whatever
      // state we last saw, instead of waiting for the old timer to fire.
      this._scheduleNextPoll();
    }
    if (changedKeys.includes('heaterPowerKw')) {
      await this._applyEnergySetting(newSettings.heaterPowerKw);
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
    const activeSeconds = this.getSetting('pollInterval') || DEFAULT_POLL_INTERVAL_S;
    const idleSeconds = this.getSetting('idlePollInterval') || DEFAULT_IDLE_POLL_INTERVAL_S;
    const seconds = (this._lastStatus && this._lastStatus.isHeating) ? activeSeconds : idleSeconds;

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
    await this._createApiClient();
    await this._syncStatus().catch((err) => this.error('Status sync after repair failed:', err.message));
  }

  /**
   * Homey's Energy tab has no way to know a HUUM heater's real power draw
   * (the API doesn't report it), so we approximate it from the user-entered
   * "heaterPowerKw" setting. app.json declares a static 6kW default;
   * this refines it per device if the SDK on this Homey supports it.
   */
  async _applyEnergySetting(heaterPowerKw) {
    const kw = heaterPowerKw || this.getSetting('heaterPowerKw');
    if (typeof kw !== 'number' || !(typeof this.setEnergy === 'function')) return;
    try {
      await this.setEnergy({ approximation: { usageOn: Math.round(kw * 1000), usageOff: 0 } });
    } catch (err) {
      this.error('Could not apply per-device energy approximation:', err.message);
    }
  }

  _registerCapabilityListeners() {
    this.registerCapabilityListener('onoff', async (value) => {
      if (value) {
        const temperature = this.getCapabilityValue('target_temperature') || 80;
        const humidity = this._getTargetHumidityPercent();
        await this._start(temperature, humidity);
      } else {
        await this.api.turnOff();
      }
      await this._syncStatus();
    });

    this.registerCapabilityListener('target_temperature', async (value) => {
      // The HUUM API has no separate "set temperature while off" endpoint;
      // it only accepts a temperature as part of /start. If the heater is
      // off we just remember the value locally for the next start.
      if (!this.getCapabilityValue('onoff')) return;
      const humidity = this._getTargetHumidityPercent();
      await this._start(value, humidity);
      await this._syncStatus();
    });

    // The whole point of this app: target_humidity is settable here, unlike
    // in the official HUUM app. Only present on saunas with a steamer.
    if (this.hasCapability('target_humidity')) {
      this.registerCapabilityListener('target_humidity', async (value) => {
        const humidityPercent = Math.round(value * 100);
        if (!this.getCapabilityValue('onoff')) {
          // Remember it locally; it will be sent along with the next start.
          await this.setCapabilityValue('target_humidity', value).catch(this.error);
          return;
        }
        const temperature = this.getCapabilityValue('target_temperature') || 80;
        await this._start(temperature, humidityPercent);
        await this._syncStatus();
      });
    }

    if (this.hasCapability('onoff.light')) {
      this.registerCapabilityListener('onoff.light', async (value) => {
        // The API only exposes a toggle, so we only call it when the
        // requested state actually differs from the last known state.
        const current = this.getCapabilityValue('onoff.light');
        if (current !== value) {
          await this.api.toggleLight();
        }
        await this._syncStatus();
      });
    }
  }

  _getTargetHumidityPercent() {
    if (!this.hasCapability('target_humidity')) return undefined;
    const value = this.getCapabilityValue('target_humidity');
    return typeof value === 'number' ? Math.round(value * 100) : undefined;
  }

  async _start(temperature, humidityPercent) {
    try {
      await this.api.turnOn({ temperature, humidity: humidityPercent });
    } catch (err) {
      if (err instanceof HuumSafetyError) {
        throw new Error(this.homey.__('errors.door_open'));
      }
      if (err instanceof HuumAuthError) {
        await this.setUnavailable(this.homey.__('errors.auth_failed')).catch(this.error);
      }
      throw err;
    }
  }

  /** Used by the "start_with_temperature_and_humidity" Flow action card. */
  async startWithTemperatureAndHumidity(temperature, humidityPercent) {
    await this._start(temperature, humidityPercent);
    await this._syncStatus();
  }

  async _syncStatus() {
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
   * Adds/removes the steamer- and light-only capabilities to match what
   * this UKU is actually configured for (HuumStatusResponse.config),
   * detected once at startup and re-checked on every poll — see "Kann
   * ermittelt werden, ob ein Verdampfer angeschlossen ist?" in the README.
   */
  async _reconcileCapabilities(status) {
    const wanted = new Map([
      ...STEAMER_CAPABILITIES.map((id) => [id, configHasFlag(status.config, CONFIG_FLAGS.STEAMER)]),
      ...LIGHT_CAPABILITIES.map((id) => [id, configHasFlag(status.config, CONFIG_FLAGS.LIGHT)]),
    ]);

    for (const [capabilityId, shouldHave] of wanted) {
      const has = this.hasCapability(capabilityId);
      if (shouldHave && !has) {
        await this.addCapability(capabilityId)
          .catch((err) => this.error(`Failed to add capability ${capabilityId}:`, err.message));
      } else if (!shouldHave && has) {
        await this.removeCapability(capabilityId)
          .catch((err) => this.error(`Failed to remove capability ${capabilityId}:`, err.message));
      }
    }
  }

  async _applyStatus(status) {
    await this._setCapabilitySafe('onoff', status.isHeating);
    await this._setCapabilitySafe('measure_temperature', status.temperature);
    await this._setCapabilitySafe('target_temperature', status.targetTemperature);
    await this._setCapabilitySafe('measure_humidity', status.humidity);
    if (typeof status.targetHumidity === 'number') {
      await this._setCapabilitySafe('target_humidity', status.targetHumidity / 100);
    }
    await this._setCapabilitySafe('alarm_contact', !status.doorClosed);
    if (this.hasCapability('onoff.light') && typeof status.light === 'number') {
      await this._setCapabilitySafe('onoff.light', status.light !== 0);
    }

    await this._syncSafetyAlarms(status);
    await this._syncTimeRemaining(status);
    await this._applyDeviceLimits(status);
    await this._syncInfoSettings(status);

    return status;
  }

  async _syncSafetyAlarms(status) {
    const hadWaterAlarm = this.hasCapability('alarm_water') ? this.getCapabilityValue('alarm_water') : false;
    const hasWaterAlarm = status.steamerError !== null;
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

    const threshold = this.getSetting('finishingSoonThresholdMinutes') || DEFAULT_FINISHING_SOON_MINUTES;
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
   * The heater itself reports its real min/max temperature and timer
   * limits (saunaConfig) — use those instead of the hardcoded 40-110°C
   * default whenever they're available and different.
   */
  async _applyDeviceLimits(status) {
    const config = status.saunaConfig;
    if (!config || typeof this.setCapabilityOptions !== 'function') return;
    if (typeof config.minTemp !== 'number' || typeof config.maxTemp !== 'number') return;

    const key = `${config.minTemp}-${config.maxTemp}`;
    if (this._appliedCapabilityLimits === key) return;

    try {
      await this.setCapabilityOptions('target_temperature', {
        min: config.minTemp,
        max: config.maxTemp,
      });
      this._appliedCapabilityLimits = key;
    } catch (err) {
      this.error('Could not apply device-reported temperature limits:', err.message);
    }
  }

  async _syncInfoSettings(status) {
    const config = status.saunaConfig;
    const yesNo = (bool) => this.homey.__(bool ? 'labels.yes' : 'labels.no');
    const settings = {
      currentStatus: this.homey.__(`status.${status.statusCode}`) || status.statusText || '-',
      steamerInstalled: yesNo(configHasFlag(status.config, CONFIG_FLAGS.STEAMER)),
      lightInstalled: yesNo(configHasFlag(status.config, CONFIG_FLAGS.LIGHT)),
      childLock: config ? String(config.childLock) : '-',
      remoteSafetyState: status.remoteSafetyState || '-',
      paymentEndDate: status.paymentEndDate || '-',
      deviceLimits: config
        ? `${config.minTemp}–${config.maxTemp} °C, timer ${config.minTimer}–${config.maxTimer} min`
        : '-',
    };

    const current = this.getSettings();
    const changed = Object.keys(settings).some((k) => current[k] !== settings[k]);
    if (!changed) return;

    await this.setSettings(settings).catch((err) => this.error('Failed to update info settings:', err.message));
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
