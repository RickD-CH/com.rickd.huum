'use strict';

const Homey = require('homey');
const { HuumApi, STATUS } = require('../../lib/HuumApi');
const { pick, toNumber } = require('../../lib/util');

const DEFAULT_POLL_INTERVAL_S = 30;
const MIN_POLL_INTERVAL_S = 10;

class HuumSaunaDevice extends Homey.Device {

  async onInit() {
    this._lastLightState = null;
    this._pollInterval = null;
    this._rawLogged = false;

    this._api = this._createApi();

    this.registerCapabilityListener('onoff', this.onCapabilityOnoff.bind(this));
    this.registerCapabilityListener('target_temperature', this.onCapabilityTargetTemperature.bind(this));
    if (this.hasCapability('onoff.light')) {
      this.registerCapabilityListener('onoff.light', this.onCapabilityLight.bind(this));
    }
    if (this.hasCapability('target_humidity')) {
      this.registerCapabilityListener('target_humidity', this.onCapabilityTargetHumidity.bind(this));
    }

    this._steamerNeedsWaterTrigger = this.homey.flow.getDeviceTriggerCard('steamer_needs_water');

    await this._poll().catch((err) => this.error('Initial poll failed:', err.message));
    this._startPolling();
  }

  _createApi() {
    const { username, password } = this.getSettings();
    return new HuumApi({ username, password });
  }

  _startPolling() {
    this._clearPolling();
    const configured = Number(this.getSetting('poll_interval')) || DEFAULT_POLL_INTERVAL_S;
    const seconds = Math.max(MIN_POLL_INTERVAL_S, configured);
    this._pollInterval = this.homey.setInterval(() => {
      this._poll().catch((err) => this.error('Poll failed:', err.message));
    }, seconds * 1000);
  }

  _clearPolling() {
    if (this._pollInterval) {
      this.homey.clearInterval(this._pollInterval);
      this._pollInterval = null;
    }
  }

  async onSettings({ newSettings, changedKeys }) {
    if (changedKeys.includes('username') || changedKeys.includes('password')) {
      this._api = new HuumApi({ username: newSettings.username, password: newSettings.password });
    }
    if (changedKeys.includes('poll_interval')) {
      this.homey.setTimeout(() => this._startPolling(), 500);
    }
  }

  async onDeleted() {
    this._clearPolling();
  }

  /** Public wrapper so flow action listeners can force an immediate refresh. */
  async refresh() {
    return this._poll();
  }

  async _poll() {
    const status = await this._api.getStatus();

    if (!this._rawLogged) {
      // Logged once so a real device's exact field names can be verified -
      // see README.md "Known caveats" for why this matters for humidity/light.
      this.log('Raw HUUM status payload:', JSON.stringify(status));
      this._rawLogged = true;
    }

    await this._applyStatus(status);
  }

  async _applyStatus(status) {
    const wasHeating = this.getCapabilityValue('onoff');
    const statusCode = Number(status.statusCode);
    const isHeating = statusCode === STATUS.ONLINE_HEATING;
    const isDoorOpen = status.door === false;
    const wasSteamerError = this.getCapabilityValue('alarm_steamer_error');

    await this._safeSet('onoff', isHeating);

    const temperature = toNumber(status.temperature);
    if (temperature !== null) await this._safeSet('measure_temperature', temperature);

    const targetTemperature = toNumber(status.targetTemperature);
    if (targetTemperature !== null) await this._safeSet('target_temperature', targetTemperature);

    if (this.hasCapability('alarm_generic')) {
      await this._safeSet('alarm_generic', isDoorOpen);
    }

    if (this.hasCapability('measure_humidity')) {
      const humidity = toNumber(pick(status, ['humidity']));
      if (humidity !== null) await this._safeSet('measure_humidity', humidity);
    }

    if (this.hasCapability('target_humidity')) {
      const targetHumidity = toNumber(pick(status, ['targetHumidity', 'target_humidity', 'humidityTarget']));
      if (targetHumidity !== null) await this._safeSet('target_humidity', targetHumidity);
    }

    if (this.hasCapability('alarm_steamer_error')) {
      const steamerErrorRaw = pick(status, ['steamerError']);
      const hasSteamerError = Number(steamerErrorRaw) === 1 || steamerErrorRaw === true;
      await this._safeSet('alarm_steamer_error', hasSteamerError);
      if (hasSteamerError && !wasSteamerError) {
        await this._steamerNeedsWaterTrigger.trigger(this).catch((err) => this.error(err));
      }
    }

    if (this.hasCapability('onoff.light')) {
      const lightRaw = pick(status, ['light']);
      if (lightRaw !== undefined) {
        this._lastLightState = !!lightRaw;
        await this._safeSet('onoff.light', this._lastLightState);
      }
    }

    if (!this.getAvailable()) {
      await this.setAvailable().catch((err) => this.error(err));
    }

    if (statusCode === STATUS.EMERGENCY_STOP) {
      await this.setWarning(this.homey.__('warnings.emergency_stop')).catch((err) => this.error(err));
    } else {
      await this.unsetWarning().catch(() => { /* no warning was set, ignore */ });
    }

    if (isHeating && !wasHeating) {
      await this.homey.flow.getDeviceTriggerCard('sauna_started').trigger(this).catch((err) => this.error(err));
    } else if (!isHeating && wasHeating) {
      await this.homey.flow.getDeviceTriggerCard('sauna_stopped').trigger(this).catch((err) => this.error(err));
    }
  }

  async _safeSet(capability, value) {
    if (!this.hasCapability(capability)) return;
    if (this.getCapabilityValue(capability) === value) return;
    try {
      await this.setCapabilityValue(capability, value);
    } catch (err) {
      this.error(`Failed to set capability ${capability}:`, err.message);
    }
  }

  async onCapabilityOnoff(value) {
    if (value) {
      await this.startHeating();
    } else {
      await this._api.stop();
    }
    await this._poll().catch((err) => this.error(err));
  }

  async onCapabilityTargetTemperature(value) {
    if (this.getCapabilityValue('onoff')) {
      await this.startHeating(value);
    }
    // If the sauna is currently off, the value is just remembered locally
    // and used the next time heating is started.
  }

  async onCapabilityTargetHumidity(value) {
    if (this.getCapabilityValue('onoff')) {
      const targetTemperature = this.getCapabilityValue('target_temperature') || 80;
      await this.startHeating(targetTemperature, value);
    }
  }

  async onCapabilityLight(value) {
    if (this._lastLightState === value) return;
    await this._api.toggleLight();
    this._lastLightState = value;
  }

  /** Shared by the onoff/target_temperature/target_humidity listeners and the "start_sauna" flow action. */
  async startHeating(targetTemperature, targetHumidity) {
    const status = await this._api.getStatus();
    if (status.door === false) {
      throw new Error(this.homey.__('errors.door_open'));
    }

    const opts = {
      targetTemperature: Math.round(targetTemperature != null
        ? targetTemperature
        : (this.getCapabilityValue('target_temperature') || 80)),
    };

    if (this.hasCapability('target_humidity')) {
      const humidity = targetHumidity != null ? targetHumidity : this.getCapabilityValue('target_humidity');
      if (humidity != null) opts.targetHumidity = Math.round(humidity);
    }

    await this._api.start(opts);
  }

}

module.exports = HuumSaunaDevice;
