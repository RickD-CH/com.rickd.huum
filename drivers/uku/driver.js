'use strict';

const Homey = require('homey');
const { HuumApi, HuumAuthError } = require('../../lib/HuumApi');

// Bit flags for HuumStatusResponse.config, per the HUUM API / UKU manual.
const CONFIG_HAS_LIGHT = 2;

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

      const hasLight = typeof status.config === 'number' ? (status.config & CONFIG_HAS_LIGHT) !== 0 : true;
      const capabilities = [
        'onoff',
        'target_temperature',
        'measure_temperature',
        'target_humidity',
        'measure_humidity',
        'alarm_contact',
      ];
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
