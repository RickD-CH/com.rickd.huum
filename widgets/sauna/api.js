'use strict';

// Web API for the dashboard widget (widgets/sauna/public/index.html).
// Routes are declared in app.json under widgets.sauna.api.

function device(homey, query) {
  const d = homey.app.getWidgetDevice(query && query.deviceId);
  if (!d) {
    const err = new Error('no_sauna_paired');
    err.statusCode = 404;
    throw err;
  }
  return d;
}

module.exports = {

  /** GET /state — compact live state for the widget. */
  async getState({ homey, query }) {
    return device(homey, query).getWidgetState();
  },

  /** POST /power {on} — switch on (last settings) or off. */
  async setPower({ homey, query, body }) {
    return device(homey, query).widgetSetPower(!!(body && body.on));
  },

  /** POST /profile {profile} — start with a named profile. */
  async startProfile({ homey, query, body }) {
    return device(homey, query).widgetStartProfile(body && body.profile);
  },

};
