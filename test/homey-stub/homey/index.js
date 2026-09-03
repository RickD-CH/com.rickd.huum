'use strict';
// Minimal stand-in for the `homey` npm module's Device/Driver/App base
// classes, for testing our own app code outside the real Homey runtime
// (which normally injects these — the actual classes only exist inside a
// running Homey, not in the `homey` CLI npm package). Only implements
// what drivers/uku/*.js actually calls.

class Device {
  constructor() {
    this.__store = {};
    this.__capabilities = new Map(); // id -> value
    this.__listeners = {}; // id -> fn
    this.__settings = {};
    this.__available = true;
    this.__unavailableReason = null;
    this.__name = 'Test Sauna';
  }

  getStore() { return this.__store; }

  getData() { return this.__data || { id: 'test-sauna' }; }

  getStoreValue(key) { return this.__store[key]; }

  async setStoreValue(key, value) { this.__store[key] = value; }

  hasCapability(id) { return this.__capabilities.has(id); }

  getCapabilityValue(id) { return this.__capabilities.get(id); }

  async setCapabilityValue(id, value) {
    if (!this.hasCapability(id)) throw new Error(`Unknown capability ${id}`);
    this.__capabilities.set(id, value);
  }

  async addCapability(id) { this.__capabilities.set(id, null); }

  async removeCapability(id) { this.__capabilities.delete(id); }

  registerCapabilityListener(id, fn) { this.__listeners[id] = fn; }

  async triggerCapabilityListener(id, value) { return this.__listeners[id](value); }

  getSetting(id) { return this.__settings[id]; }

  getSettings() { return { ...this.__settings }; }

  async setSettings(patch) { Object.assign(this.__settings, patch); }

  async setAvailable() { this.__available = true; this.__unavailableReason = null; }

  async setUnavailable(reason) { this.__available = false; this.__unavailableReason = reason; }

  async setWarning(message) { this.__warning = message; }

  async unsetWarning() { this.__warning = null; }

  getAvailable() { return this.__available; }

  async setCapabilityOptions() {}

  async setEnergy() {}

  getName() { return this.__name; }

  error(...args) { (this.__errors ||= []).push(args.map(String).join(' ')); }

  log() {}
}

class Driver {
  log() {}

  error() {}
}

class App {}

module.exports = { Device, Driver, App };
