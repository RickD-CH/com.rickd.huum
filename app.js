'use strict';

const Homey = require('homey');

class HuumLocalApp extends Homey.App {

  async onInit() {
    this.log('HUUM Sauna app has been initialized');
  }

}

module.exports = HuumLocalApp;
