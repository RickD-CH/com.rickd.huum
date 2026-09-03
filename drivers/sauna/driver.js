'use strict';

const Homey = require('homey');
const { HuumApi } = require('../../lib/HuumApi');

class HuumSaunaDriver extends Homey.Driver {

  async onInit() {
    this.log('HUUM Sauna driver initialized');

    this.homey.flow.getConditionCard('door_is_closed')
      .registerRunListener(async (args) => args.device.getCapabilityValue('alarm_generic') === false);

    this.homey.flow.getConditionCard('steamer_has_error')
      .registerRunListener(async (args) => args.device.getCapabilityValue('alarm_steamer_error') === true);

    this.homey.flow.getActionCard('start_sauna')
      .registerRunListener(async (args) => {
        await args.device.startHeating(args.temperature, args.humidity);
        await args.device.refresh().catch((err) => args.device.error(err));
      });
  }

  async onPair(session) {
    let credentials = null;

    session.setHandler('login', async (data) => {
      const api = new HuumApi({ username: data.username, password: data.password });
      await api.getStatus(); // throws HuumApiError on bad credentials
      credentials = { username: data.username, password: data.password };
      return true;
    });

    session.setHandler('list_devices', async () => {
      if (!credentials) {
        throw new Error(this.homey.__('pair.invalid_credentials'));
      }

      const api = new HuumApi(credentials);
      const status = await api.getStatus();
      this.log('Paired sauna status payload:', JSON.stringify(status));

      const capabilities = ['onoff', 'target_temperature', 'measure_temperature', 'alarm_generic'];

      const config = Number(status.config);
      if (config === 2 || config === 3) {
        capabilities.push('onoff.light');
      }
      if (config === 1 || config === 3) {
        capabilities.push('measure_humidity', 'target_humidity', 'alarm_steamer_error');
      }

      const name = status.saunaName || status.sauna_name || this.homey.__('pair.default_name');

      return [
        {
          name,
          data: {
            id: credentials.username.trim().toLowerCase(),
          },
          settings: {
            username: credentials.username,
            password: credentials.password,
          },
          capabilities,
        },
      ];
    });
  }

  async onRepair(session, device) {
    session.setHandler('login', async (data) => {
      const api = new HuumApi({ username: data.username, password: data.password });
      await api.getStatus(); // throws HuumApiError on bad credentials

      await device.setSettings({
        username: data.username,
        password: data.password,
      });
      return true;
    });
  }

}

module.exports = HuumSaunaDriver;
