'use strict';
// Exercises api.js (the Web API behind the app settings page) against a
// stub `homey.app`. No Homey runtime needed.

const assert = require('assert');
const path = require('path');

const api = require(path.join(__dirname, '..', 'api.js'));

async function run() {
  let refreshed = false;
  const app = {
    getOverview: () => [{ id: 'a', name: 'Sauna A' }],
    refreshOverview: async () => { refreshed = true; return [{ id: 'a', name: 'Sauna A', fresh: true }]; },
    getDeviceById: (id) => (id === 'a' ? {
      getConfig: () => ({ profiles: [{ id: 'profile1' }], advanced: { pollInterval: 30 }, power: { source: 'estimate' } }),
      setConfig: async (body) => ({ echoed: body }),
    } : null),
    getPowerMeters: async () => [{ id: 'm1', name: 'Shelly Plug', power: 1200 }],
  };
  const homey = { app };

  assert.deepStrictEqual(await api.getOverview({ homey }), [{ id: 'a', name: 'Sauna A' }]);

  const fresh = await api.refreshOverview({ homey });
  assert.strictEqual(refreshed, true, 'refreshOverview forces a fresh HUUM pull');
  assert.strictEqual(fresh[0].fresh, true);

  const cfg = await api.getDeviceConfig({ homey, params: { id: 'a' } });
  assert.strictEqual(cfg.profiles[0].id, 'profile1');
  assert.strictEqual(cfg.advanced.pollInterval, 30);

  await assert.rejects(
    () => api.getDeviceConfig({ homey, params: { id: 'nope' } }),
    /not found/i,
    'unknown device id is rejected',
  );

  const saved = await api.setDeviceConfig({ homey, params: { id: 'a' }, body: { advanced: { pollInterval: 45 } } });
  assert.deepStrictEqual(saved, { echoed: { advanced: { pollInterval: 45 } } });

  const meters = await api.getPowerMeters({ homey });
  assert.strictEqual(meters.available, true);
  assert.strictEqual(meters.devices[0].id, 'm1');

  // Permission missing / Web API unavailable -> graceful, page falls back to kW.
  const degraded = await api.getPowerMeters({ homey: { app: { getPowerMeters: async () => { throw new Error('no permission'); } } } });
  assert.strictEqual(degraded.available, false);
  assert.deepStrictEqual(degraded.devices, []);

  console.log('OK: api.js overview / device config / power-meter handlers');
  console.log('\nAll api.js tests passed.');
}

run().catch((err) => {
  console.error('TEST FAILED:', err);
  process.exit(1);
});
