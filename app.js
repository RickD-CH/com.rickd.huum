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

    this.homey.flow.getConditionCard('remote_control_is_blocked')
      .registerRunListener(async (args) => args.device.isRemoteBlocked());

    this.homey.flow.getDeviceTriggerCard('time_remaining_reaches')
      .registerRunListener(async (args, state) => state.previous >= args.minutes && state.current < args.minutes);

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

    this.homey.flow.getActionCard('schedule_start')
      .registerRunListener(async (args) => {
        await args.device.scheduleStartFromFlow(args.day, args.time, args.profile);
      });

    this.homey.flow.getActionCard('cancel_scheduled_start')
      .registerRunListener(async (args) => {
        await args.device.clearBooking();
      });

    this.homey.flow.getConditionCard('scheduled_start_is_set')
      .registerRunListener(async (args) => !!args.device.getBooking());
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

}

module.exports = HuumApp;
