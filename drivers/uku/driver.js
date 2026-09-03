'use strict';

const Homey = require('homey');
const {
  HuumApi, HuumAuthError, CONFIG_FLAGS, configHasFlag,
} = require('../../lib/HuumApi');

class HuumDriver extends Homey.Driver {

  async onInit() {
    this.log('HUUM UKU driver initialized');
  }

  async onPair(session) {
    let credentials = null;
    let status = null;

    session.setHandler('login', async ({ username, password }) => {
      const api = new HuumApi({ username, password });

      try {
        status = await api.getStatus();
      } catch (err) {
        if (err instanceof HuumAuthError) {
          return false;
        }
        throw err;
      }

      credentials = { username, password };
      return true;
    });

    session.setHandler('list_devices', async () => {
      if (!credentials || !status) {
        throw new Error(this.homey.__('pair.not_logged_in'));
      }

      const hasSteamer = configHasFlag(status.config, CONFIG_FLAGS.STEAMER);
      const hasLight = configHasFlag(status.config, CONFIG_FLAGS.LIGHT);

      const capabilities = [
        'onoff',
        'target_temperature',
        'measure_temperature',
        'huum_time_remaining',
        'alarm_contact',
        'alarm_generic',
      ];
      if (hasSteamer) {
        // Only add humidity control/reading and the "no water" alarm for
        // saunas that actually have a steamer module — this is the
        // detection the app now does for you.
        capabilities.push('target_humidity', 'measure_humidity', 'alarm_water');
      }
      if (hasLight) {
        capabilities.push('onoff.light');
      }

      return [
        {
          name: status.saunaName || 'HUUM Sauna',
          data: {
            id: credentials.username.toLowerCase(),
          },
          store: {
            username: credentials.username,
            password: credentials.password,
          },
          capabilities,
        },
      ];
    });
  }

  async onRepair(session, device) {
    session.setHandler('login', async ({ username, password }) => {
      const api = new HuumApi({ username, password });

      try {
        await api.getStatus();
      } catch (err) {
        if (err instanceof HuumAuthError) {
          return false;
        }
        throw err;
      }

      await device.setStoreValue('username', username);
      await device.setStoreValue('password', password);
      await device.onCredentialsUpdated();

      return true;
    });
  }

}

module.exports = HuumDriver;
