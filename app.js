'use strict';

const Homey = require('homey');
const { HomeyAPI } = require('homey-api');

class HuumApp extends Homey.App {

  async onInit() {
    this.log('HUUM (custom) app has been initialized');
    this._homeyApi = null;
    this._homeyApiPromise = null;

    this.homey.flow.getActionCard('start_with_temperature_and_humidity')
      .registerRunListener(async (args) => {
        await args.device.startWithTemperatureAndHumidity(args.temperature, args.humidity);
      });

    this.homey.flow.getConditionCard('time_remaining_below')
      .registerRunListener(async (args) => {
        const remaining = args.device.getCapabilityValue('huum_time_remaining');
        return typeof remaining === 'number' && remaining < args.minutes;
      });

    this.homey.flow.getConditionCard('remote_control_is_blocked')
      .registerRunListener(async (args) => args.device.isRemoteBlocked());

    this.homey.flow.getActionCard('set_measured_power')
      .registerRunListener(async (args) => {
        await args.device.setMeasuredPower(args.watts);
      });

    this.homey.flow.getActionCard('start_with_profile')
      .registerRunListener(async (args) => {
        await args.device.startWithProfile(args.profile);
      });

    this.homey.flow.getActionCard('save_profile')
      .registerRunListener(async (args) => {
        await args.device.saveProfile(args.profile);
      });
  }

  /**
   * Lazily create a Homey Web API client (needs the `homey:manager:api`
   * permission). Used to let the user link a real power meter for the
   * Energy estimate. Cached; a failure isn't cached so it can be retried.
   */
  async getHomeyApi() {
    if (this._homeyApi) return this._homeyApi;
    if (!this._homeyApiPromise) {
      this._homeyApiPromise = HomeyAPI.createAppAPI({ homey: this.homey })
        .then((api) => { this._homeyApi = api; return api; })
        .catch((err) => { this._homeyApiPromise = null; throw err; });
    }
    return this._homeyApiPromise;
  }

  /** All paired HUUM UKU devices (this app has exactly one driver). */
  getUkuDevices() {
    try {
      return this.homey.drivers.getDriver('uku').getDevices();
    } catch (err) {
      this.error('getUkuDevices failed:', err.message);
      return [];
    }
  }

  /** Live overview of every paired sauna, for the app settings page. */
  getOverview() {
    return this.getUkuDevices().map((device) => {
      try {
        return device.getPublicState();
      } catch (err) {
        this.error('getPublicState failed for a device:', err.message);
        return { id: device.getData().id, name: device.getName(), error: err.message };
      }
    });
  }

  /** Force a fresh HUUM pull for every sauna, then return the overview. */
  async refreshOverview() {
    await Promise.all(this.getUkuDevices().map((d) => d.refreshNow()));
    return this.getOverview();
  }

  getDeviceById(id) {
    return this.getUkuDevices().find((d) => d.getData().id === id) || null;
  }

  /**
   * The sauna the dashboard widget controls. This app only ever has one
   * (one HUUM account = one sauna); if a `deviceId` widget setting is set,
   * honour it, else just take the first.
   */
  getWidgetDevice(deviceId) {
    const devices = this.getUkuDevices();
    if (deviceId) return devices.find((d) => d.getData().id === deviceId) || null;
    return devices[0] || null;
  }

  /**
   * Candidate devices for the "measure the heater with a real power meter"
   * option — anything on the Homey exposing `measure_power`, minus this
   * app's own saunas.
   */
  async getPowerMeters() {
    const api = await this.getHomeyApi();
    const own = new Set(this.getUkuDevices().map((d) => d.getData().id));
    const devices = await api.devices.getDevices();
    return Object.values(devices)
      .filter((d) => Array.isArray(d.capabilities) && d.capabilities.includes('measure_power'))
      .filter((d) => !own.has(d.id))
      .map((d) => ({
        id: d.id,
        name: d.name,
        power: (d.capabilitiesObj && d.capabilitiesObj.measure_power && d.capabilitiesObj.measure_power.value) ?? null,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

}

module.exports = HuumApp;
