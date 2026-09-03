'use strict';

const Homey = require('homey');
const { HuumApi, HuumAuthError, HuumSafetyError } = require('../../lib/HuumApi');

const POLL_INTERVAL_MS = 30 * 1000;

class HuumDevice extends Homey.Device {

  async onInit() {
    await this._createApiClient();
    this._registerCapabilityListeners();

    await this._syncStatus().catch((err) => this.error('Initial status sync failed:', err.message));

    this._pollInterval = this.homey.setInterval(() => {
      this._syncStatus().catch((err) => this.error('Status sync failed:', err.message));
    }, POLL_INTERVAL_MS);
  }

  async onUninit() {
    this._clearPoll();
  }

  async onDeleted() {
    this._clearPoll();
  }

  _clearPoll() {
    if (this._pollInterval) {
      this.homey.clearInterval(this._pollInterval);
      this._pollInterval = null;
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
    // in the official HUUM app.
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
      throw err;
    }

    if (!this.getAvailable()) {
      await this.setAvailable().catch(this.error);
    }

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

    return status;
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
