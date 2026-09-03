'use strict';

const Homey = require('homey');

class HuumApp extends Homey.App {

  async onInit() {
    this.log('HUUM (custom) app has been initialized');

    this.homey.flow.getActionCard('start_with_temperature_and_humidity')
      .registerRunListener(async (args) => {
        await args.device.startWithTemperatureAndHumidity(args.temperature, args.humidity);
      });

    this.homey.flow.getConditionCard('time_remaining_below')
      .registerRunListener(async (args) => {
        const remaining = args.device.getCapabilityValue('huum_time_remaining');
        return typeof remaining === 'number' && remaining < args.minutes;
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

}

module.exports = HuumApp;
