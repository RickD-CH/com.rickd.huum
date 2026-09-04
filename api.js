'use strict';

// Web API for the app settings page (settings/index.html). Routes are
// declared in app.json under "api"; each handler name matches a route key.
// (Same pattern as the sibling app com.rickd.devicewatchdog.)

module.exports = {

  /** GET /overview — cached state of every paired sauna. */
  async getOverview({ homey }) {
    return homey.app.getOverview();
  },

  /** POST /overview/refresh — pull a fresh reading from HUUM, then return it. */
  async refreshOverview({ homey }) {
    return homey.app.refreshOverview();
  },

  /** GET /device/:id/config — profiles / advanced / power for one sauna. */
  async getDeviceConfig({ homey, params }) {
    const device = homey.app.getDeviceById(params.id);
    if (!device) throw new Error('Sauna not found');
    return device.getConfig();
  },

  /** PUT /device/:id/config — save edited config, returns the fresh config. */
  async setDeviceConfig({ homey, params, body }) {
    const device = homey.app.getDeviceById(params.id);
    if (!device) throw new Error('Sauna not found');
    return device.setConfig(body || {});
  },

  /** GET /power-meters — devices exposing measure_power, for the picker. */
  async getPowerMeters({ homey }) {
    try {
      return { available: true, devices: await homey.app.getPowerMeters() };
    } catch (err) {
      // Permission not granted / API unavailable — the page falls back to
      // the manual kW field only.
      return { available: false, error: err.message, devices: [] };
    }
  },

};
