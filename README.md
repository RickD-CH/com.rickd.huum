# HUUM Sauna – Homey App

Homey app (SDK v3) to control a HUUM sauna heater with a UKU WiFi controller:
start/stop heating, set target temperature, read current temperature, door
status, light, and (if present) steamer target/measured humidity.

## Why this uses HUUM's cloud API, not a local/LAN API

There is **no official local API** for the UKU WiFi controller. Two options
were researched:

1. **HUUM's cloud API** (`https://sauna.huum.eu/action/home/...`, also
   reachable as `api.huum.eu`) — HTTPS + HTTP Basic Auth with the same
   credentials as the HUUM app. This is what HUUM sanctions for third-party
   use, and what `pyhuum` / Home Assistant's official HUUM integration is
   built on.
2. A community reverse-engineered **true local** protocol
   ([`kpalang/huum-controller`](https://github.com/kpalang/huum-controller)),
   which impersonates HUUM's cloud on TCP port 6969 so the heater talks to a
   server on your own network instead of the internet. This requires
   redirecting the heater's DNS at the router/Pi-hole level, is unofficial,
   and its author states it does **not** work on firmware `4.4.18.0-4` and
   newer.

Since the sauna's firmware was just updated and the unit is under 2 years
old, it almost certainly runs firmware that's incompatible with the
reverse-engineered local protocol. This app therefore uses the cloud API.
The Homey app itself still runs entirely locally on the Homey hub — only the
sauna control calls go out to HUUM's servers, same as the official app.

## Sources

- Cloud API docs (endpoints, status codes): https://github.com/horemansp/HUUM
- Actively maintained client (base URL, field names, safety checks): https://github.com/frwickst/pyhuum
- Local (LAN) reverse-engineering, incl. firmware limitation: https://github.com/kpalang/huum-controller and https://kaurpalang.com/posts/invading-the-sauna/

## Known caveats / things to verify against your real device

HUUM's official docs (as shared with third-party devs) only cover
`statusCode`, `door`, `temperature`, `targetTemperature`, `config`,
`steamerError`. The humidity/light/name fields (`humidity`, `targetHumidity`,
`light`, `saunaName`) are inferred from `pyhuum`'s field aliases, not from
primary documentation, since this project has no live device to test
against. The app is defensive about this:

- `drivers/sauna/device.js` logs the raw `/status` JSON once per device on
  first poll (`this.log('Raw HUUM status payload:', ...)`, visible in
  `homey app run` or the Homey developer tools' app log).
- After pairing your real sauna, check that log line. If any of the
  humidity/light field names differ from what's used in
  `lib/util.js`/`device.js`, they're easy to adjust in one place (the
  `pick(status, [...])` calls in `_applyStatus`).

## Capabilities

Always present: `onoff` (heating on/off), `target_temperature` (40–110 °C),
`measure_temperature`, `alarm_generic` (door open).

Added automatically at pairing time based on the sauna's reported `config`:
- `config` 2 or 3 → `onoff.light` (light on/off)
- `config` 1 or 3 → `measure_humidity`, `target_humidity` (custom capability,
  0–100 %), `alarm_steamer_error` (custom capability, steamer needs water)

Since you have a steamer attached, pairing should pick up all of the above.

## Flow cards

- Triggers: *Sauna started heating*, *Sauna stopped heating*, *Steamer needs
  water*
- Conditions: *Door is (not) closed*, *Steamer has(n't) an error*
- Action: *Start sauna with temperature and humidity* (humidity argument is
  ignored on saunas without a steamer)

Standard on/off, target temperature and measure temperature flow cards are
also available automatically (Homey generates those for standard
capabilities).

## Project layout

```
app.js                    App entry point
app.json                  Manifest: drivers, capabilities, flow cards, pairing
lib/HuumApi.js             Thin HUUM cloud API client
lib/util.js                 Small helpers (defensive field lookup)
drivers/sauna/driver.js    Pairing (login + list_devices) and flow listeners
drivers/sauna/device.js    Polling, capability listeners, flow triggers
locales/{en,de}.json       UI strings
assets/, drivers/sauna/assets/  Icons (placeholder - see below)
```

## Try it against a real Homey

```bash
npm install
npx homey app validate
npx homey app run      # installs on a Homey on your network for live testing
```

`homey app run`/`install` need you to be logged in (`npx homey login`) and a
Homey reachable on the same network.

## Placeholder assets

`assets/icon.svg` and the `images/*.png` files (app + driver) are
programmatically generated placeholders (flat colour + simple flame shape),
not HUUM's branding. Replace them with a real icon before publishing to the
Homey App Store — see [Homey's app image
guidelines](https://apps.developer.homey.app/app-store/guidelines/images).

## Repo / app id

This repo and the Homey app id are both currently `com.rickd.huumlocal`. If
the repo gets renamed, let me know if you also want the app `id` in
`app.json`/`package.json` changed to match — it's free to change pre-release,
but becomes a breaking change for existing installs once published.
