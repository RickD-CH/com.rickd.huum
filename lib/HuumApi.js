'use strict';

const https = require('https');

/**
 * Minimal, dependency-free client for the HUUM Cloud API used by the official
 * HUUM app (sauna.huum.eu). Reverse-engineered from the publicly documented,
 * Huum-sanctioned third-party client "pyhuum" (MIT licensed):
 * https://github.com/frwickst/pyhuum
 *
 * Auth: HTTP Basic Auth using the same email/password as the HUUM app.
 *
 * Endpoints:
 *   GET  /action/home/status               -> current sauna status
 *   POST /action/home/start {targetTemperature, humidity?} -> start heating
 *   POST /action/home/stop                  -> stop heating
 *   GET  /action/home/light                 -> toggles the light/fan relay
 *
 * The crucial bit for this app: /start accepts an optional "humidity" field
 * (the steamer's target humidity duty cycle) which the official Homey app
 * never exposes as a settable capability.
 */

const API_HOST = 'sauna.huum.eu';
const API_BASE_PATH = '/action/home';

// Maximum target humidity (%) allowed per target temperature (°C), as
// documented in the UKU 4.2 manual. The steamer can't keep up with high
// humidity at high temperatures, so the API rejects out-of-range combos.
const HUMIDITY_THRESHOLDS = [
  { maxTemp: 45, maxHumidity: 90 },
  { maxTemp: 50, maxHumidity: 55 },
  { maxTemp: 55, maxHumidity: 45 },
  { maxTemp: 60, maxHumidity: 40 },
  { maxTemp: 65, maxHumidity: 35 },
  { maxTemp: 70, maxHumidity: 30 },
  { maxTemp: 75, maxHumidity: 25 },
  { maxTemp: 80, maxHumidity: 20 },
  { maxTemp: 85, maxHumidity: 15 },
  { maxTemp: 90, maxHumidity: 10 },
];

const MIN_TEMP = 40;
const MAX_TEMP = 110;

const STATUS_CODES = {
  OFFLINE: 230,
  ONLINE_HEATING: 231,
  ONLINE_NOT_HEATING: 232,
  LOCKED: 233,
  EMERGENCY_STOP: 400,
};

const STATUS_TEXTS = {
  [STATUS_CODES.OFFLINE]: 'offline',
  [STATUS_CODES.ONLINE_HEATING]: 'online and heating',
  [STATUS_CODES.ONLINE_NOT_HEATING]: 'online but not heating',
  [STATUS_CODES.LOCKED]: 'in use by another user / locked',
  [STATUS_CODES.EMERGENCY_STOP]: 'emergency stop',
};

class HuumApiError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.name = 'HuumApiError';
    this.statusCode = statusCode;
  }
}

class HuumAuthError extends HuumApiError {
  constructor(message = 'Invalid HUUM email or password', statusCode) {
    super(message, statusCode);
    this.name = 'HuumAuthError';
  }
}

class HuumSafetyError extends HuumApiError {
  constructor(message = 'Cannot start the sauna while the door is open') {
    super(message);
    this.name = 'HuumSafetyError';
  }
}

class HuumApi {
  constructor({ username, password }) {
    if (!username || !password) {
      throw new HuumApiError('HUUM username and password are required');
    }
    this.username = username;
    this.password = password;
  }

  /**
   * Highest target humidity (%) the steamer accepts at a given temperature.
   */
  getMaxHumidity(temperature) {
    for (const { maxTemp, maxHumidity } of HUMIDITY_THRESHOLDS) {
      if (temperature <= maxTemp) return maxHumidity;
    }
    return 0;
  }

  async getStatus() {
    return this._request('GET', '/status');
  }

  /**
   * Turn the sauna on (or update the running target temperature/humidity —
   * HUUM has no separate "set" endpoint, /start doubles as both).
   */
  async turnOn({ temperature, humidity, safetyOverride = false } = {}) {
    if (typeof temperature !== 'number' || Number.isNaN(temperature)) {
      throw new HuumApiError('A target temperature is required');
    }
    const roundedTemp = Math.round(temperature);
    if (roundedTemp < MIN_TEMP || roundedTemp > MAX_TEMP) {
      throw new HuumApiError(`Temperature must be between ${MIN_TEMP} and ${MAX_TEMP}°C`);
    }

    const body = { targetTemperature: roundedTemp };

    if (typeof humidity === 'number' && !Number.isNaN(humidity)) {
      const roundedHumidity = Math.round(humidity);
      const maxHumidity = this.getMaxHumidity(roundedTemp);
      if (roundedHumidity > maxHumidity) {
        throw new HuumApiError(
          `Target humidity ${roundedHumidity}% exceeds the maximum of ${maxHumidity}% at ${roundedTemp}°C`,
        );
      }
      if (roundedHumidity > 0) {
        body.humidity = roundedHumidity;
      }
    }

    if (!safetyOverride) {
      const status = await this.getStatus();
      if (!status.doorClosed) {
        throw new HuumSafetyError();
      }
    }

    return this._request('POST', '/start', body);
  }

  async turnOff() {
    return this._request('POST', '/stop');
  }

  /**
   * The API only exposes a *toggle* for the light/fan relay, there is no
   * explicit "set on/off" endpoint.
   */
  async toggleLight() {
    return this._request('GET', '/light');
  }

  _request(method, path, body) {
    return new Promise((resolve, reject) => {
      const payload = body ? JSON.stringify(body) : null;
      const auth = Buffer.from(`${this.username}:${this.password}`).toString('base64');

      const req = https.request(
        {
          host: API_HOST,
          path: `${API_BASE_PATH}${path}`,
          method,
          headers: {
            Authorization: `Basic ${auth}`,
            'Content-Type': 'application/json',
            Accept: 'application/json',
            ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
          },
          timeout: 15000,
        },
        (res) => {
          const chunks = [];
          res.on('data', (chunk) => chunks.push(chunk));
          res.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf8');
            let json = null;
            if (raw) {
              try {
                json = JSON.parse(raw);
              } catch (err) {
                // Non-JSON body, handled by the status checks below.
              }
            }

            if (res.statusCode === 401 || res.statusCode === 403) {
              return reject(new HuumAuthError(undefined, res.statusCode));
            }
            if (res.statusCode < 200 || res.statusCode >= 300) {
              return reject(
                new HuumApiError(`HUUM API request to ${path} failed (HTTP ${res.statusCode})`, res.statusCode),
              );
            }
            if (!json) {
              return reject(new HuumApiError(`HUUM API returned an unexpected response for ${path}`));
            }

            resolve(HuumApi._parseStatus(json));
          });
        },
      );

      req.on('timeout', () => req.destroy(new HuumApiError(`HUUM API request to ${path} timed out`)));
      req.on('error', (err) => reject(new HuumApiError(`HUUM API request to ${path} failed: ${err.message}`)));

      if (payload) req.write(payload);
      req.end();
    });
  }

  static _parseStatus(json) {
    return {
      statusCode: json.statusCode,
      statusText: STATUS_TEXTS[json.statusCode] || 'unknown',
      isHeating: json.statusCode === STATUS_CODES.ONLINE_HEATING,
      isOnline: json.statusCode !== STATUS_CODES.OFFLINE,
      doorClosed: !!json.door,
      temperature: typeof json.temperature === 'number' ? json.temperature : null,
      targetTemperature: typeof json.targetTemperature === 'number' ? json.targetTemperature : null,
      humidity: typeof json.humidity === 'number' ? json.humidity : null,
      targetHumidity: typeof json.targetHumidity === 'number' ? json.targetHumidity : null,
      light: typeof json.light === 'number' ? json.light : null,
      config: typeof json.config === 'number' ? json.config : null,
      saunaName: json.saunaName || null,
      steamerError: typeof json.steamerError === 'number' ? json.steamerError : null,
      raw: json,
    };
  }
}

module.exports = {
  HuumApi,
  HuumApiError,
  HuumAuthError,
  HuumSafetyError,
  STATUS_CODES,
  MIN_TEMP,
  MAX_TEMP,
};
