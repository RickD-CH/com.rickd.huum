'use strict';
// Exercises widgets/sauna/api.js against a stub homey.app. No Homey runtime.

const assert = require('assert');
const path = require('path');

const api = require(path.join(__dirname, '..', 'widgets', 'sauna', 'api.js'));

async function run() {
  const calls = [];
  const sauna = {
    getData: () => ({ id: 'a' }),
    getWidgetState: () => ({ heating: false, targetTemperature: 80 }),
    widgetSetPower: async (on) => { calls.push(['power', on]); return { heating: on }; },
    widgetStartProfile: async (p) => { calls.push(['profile', p]); return { heating: true, startProfile: p }; },
  };
  const homey = {
    app: { getWidgetDevice: (id) => (id == null || id === 'a' ? sauna : null) },
  };

  assert.deepStrictEqual(await api.getState({ homey, query: {} }), { heating: false, targetTemperature: 80 });

  const on = await api.setPower({ homey, query: {}, body: { on: true } });
  assert.strictEqual(on.heating, true);
  assert.deepStrictEqual(calls.pop(), ['power', true]);

  const started = await api.startProfile({ homey, query: {}, body: { profile: 'profile2' } });
  assert.strictEqual(started.startProfile, 'profile2');
  assert.deepStrictEqual(calls.pop(), ['profile', 'profile2']);

  await assert.rejects(
    () => api.getState({ homey: { app: { getWidgetDevice: () => null } }, query: {} }),
    /no_sauna_paired/,
    'no sauna paired -> 404-ish error',
  );

  console.log('OK: widget api.js state / power / profile handlers');
  console.log('\nAll widget.js tests passed.');
}

run().catch((err) => {
  console.error('TEST FAILED:', err);
  process.exit(1);
});
