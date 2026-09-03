'use strict';

const Homey = require('homey');

class HuumApp extends Homey.App {

  async onInit() {
    this.log('HUUM (custom) app has been initialized');

    this.homey.flow.getActionCard('start_with_temperature_and_humidity')
      .registerRunListener(async (args) => {
        await args.device.startWithTemperatureAndHumidity(args.temperature, args.humidity);
      });
  }

}

module.exports = HuumApp;
