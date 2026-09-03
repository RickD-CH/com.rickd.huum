'use strict';

const fetch = require('node-fetch');

// Base URL used by the actively maintained pyhuum library (the same client
// Home Assistant's official HUUM integration is built on). HUUM's own docs
// (as shared with third-party developers) point at api.huum.eu, which
// resolves to the same backend. See README.md for sources.
const BASE_URL = 'https://sauna.huum.eu/action/home';

// Raw statusCode values returned by GET /status.
const STATUS = {
  OFFLINE: 230,
  ONLINE_HEATING: 231,
  ONLINE_NOT_HEATING: 232,
  LOCKED_BY_OTHER_USER: 233,
  EMERGENCY_STOP: 400,
};

// Raw "config" value returned by GET /status: which accessories this sauna has.
const CONFIG = {
  STEAMER: 1,
  LIGHT: 2,
  LIGHT_AND_STEAMER: 3,
};

class HuumApiError extends Error {

  constructor(message, statusCode) {
    super(message);
    this.name = 'HuumApiError';
    this.statusCode = statusCode;
  }

}

/**
 * Thin wrapper around HUUM's cloud API (https://sauna.huum.eu).
 * There is no official local/LAN API for the UKU WiFi controller; this is
 * the same account-credential based API used by the official HUUM app and
 * by Home Assistant's integration. See README.md for details and caveats.
 */
class HuumApi {

  constructor({ username, password }) {
    this.username = username;
    this.password = password;
  }

  _authHeader() {
    const token = Buffer.from(`${this.username}:${this.password}`).toString('base64');
    return `Basic ${token}`;
  }

  async _request(path, { method = 'GET', body } = {}) {
    let res;
    try {
      res = await fetch(`${BASE_URL}/${path}`, {
        method,
        headers: {
          Authorization: this._authHeader(),
          'Content-Type': 'application/json',
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      throw new HuumApiError(`Could not reach HUUM cloud: ${err.message}`, null);
    }

    let json = null;
    const text = await res.text();
    if (text) {
      try {
        json = JSON.parse(text);
      } catch (err) {
        // Some endpoints (e.g. /light) may return a non-JSON body; ignore.
      }
    }

    if (!res.ok) {
      if (res.status === 401) throw new HuumApiError('Invalid HUUM username or password', 401);
      if (res.status === 403) throw new HuumApiError('Forbidden by HUUM cloud', 403);
      if (res.status === 400) {
        throw new HuumApiError((json && (json.error || json.message)) || 'Bad request', 400);
      }
      throw new HuumApiError(`HUUM API error (HTTP ${res.status})`, res.status);
    }

    return json;
  }

  /** GET /status - full current state of the sauna. */
  async getStatus() {
    return this._request('status');
  }

  /**
   * POST /start - start heating.
   * @param {number} [targetTemperature] 40-110 (°C)
   * @param {number} [targetHumidity] 0-100 (%), only meaningful with a steamer
   */
  async start({ targetTemperature, targetHumidity } = {}) {
    const body = {};
    if (targetTemperature != null) body.targetTemperature = targetTemperature;
    if (targetHumidity != null) body.humidity = targetHumidity;
    return this._request('start', { method: 'POST', body });
  }

  /** POST /stop - stop heating. */
  async stop() {
    return this._request('stop', { method: 'POST' });
  }

  /**
   * GET /light - toggles the light. HUUM's API has no explicit "set light
   * to on/off" call, only a toggle, so callers must compare against the
   * last known state (from getStatus()) before calling this.
   */
  async toggleLight() {
    return this._request('light');
  }

}

module.exports = {
  HuumApi, HuumApiError, STATUS, CONFIG,
};
