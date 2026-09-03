# HUUM Sauna (Full Control) — Homey App

A custom [Homey](https://homey.app) app for HUUM sauna heaters with the UKU
WiFi controller. Written because the **official** HUUM Homey app can't set
the **target humidity** — this one can.

## Why this exists

The official `eu.huum` Homey app exposes `measure_humidity` (read-only) but
never lets you *set* a target humidity, even though the [HUUM Cloud
API](https://sauna.huum.eu) supports it (`POST /action/home/start` accepts
an optional `humidity` field alongside `targetTemperature`). This app adds
that missing capability, plus a Flow action to start the sauna with both
temperature and humidity in one call.

## Status

🚧 **Scaffold / work in progress.** Structurally complete and validated with
`homey app validate`, but **not yet tested against a real HUUM device**.
Please test carefully (see below) before relying on it, especially the door
safety check.

## Features

- `onoff` — turn the heater on/off
- `target_temperature` — 40–110 °C (narrowed automatically to your heater's
  own reported min/max once known, see below)
- `measure_temperature` — current sauna temperature
- **`target_humidity`** — 0–90 %, settable (the whole point of this app)
- `measure_humidity` — current humidity
- `huum_time_remaining` — minutes left until the heater auto-shuts-off
- `alarm_contact` — door open/closed
- `alarm_water` — **no water in the steamer** (from the API's
  `steamerError` field)
- `alarm_generic` — emergency stop / problem state
- `onoff.light` — light/fan relay (only added if your sauna config has one)
- Flow action: *"Start the sauna at `[temperature]` °C and `[humidity]` %
  humidity"*
- Flow trigger: *"The sauna will be done heating soon"* (configurable
  minutes-before-shutoff threshold, device setting)
- Flow condition: *"Remaining time is/is not below `[minutes]` minutes"*
- Flow triggers/conditions for `alarm_water` and `alarm_generic` come for
  free from Homey (any standard alarm capability gets them automatically)
- Safety check: refuses to start the sauna while the door is open (same
  behaviour as the reference client library)
- Optional **push notification** when the steamer reports it needs water
  (device setting, on by default) — in addition to the `alarm_water`
  capability/Flow triggers
- Approximate **Energy tab** usage while heating, based on a heater power
  (kW) you enter in the device settings (the API doesn't report real
  wattage, so this is an estimate, not a measurement)
- Device settings show read-only info reported by the heater itself: child
  lock state, remote safety state, subscription (`paymentEndDate`) end
  date, and its reported temperature/timer limits

## How it talks to your sauna

HUUM saunas with a UKU WiFi controller are controlled entirely through
HUUM's cloud API (`sauna.huum.eu`), using HTTP Basic Auth with the same
email/password as the HUUM mobile app. There is no local/LAN protocol
exposed by the controller for this integration. `lib/HuumApi.js` is a
small, dependency-free client for that API (no npm packages needed).

Max allowed target humidity depends on target temperature (steamer duty
cycle limits from the UKU manual) — the app enforces this client-side and
will show an error if you ask for a combination the heater can't do.

## Project layout

```
app.json              Homey app manifest (drivers, capabilities, Flow cards)
app.js                App entry point
lib/HuumApi.js         HUUM Cloud API client
drivers/uku/
  driver.js            Pairing (email/password login) + device discovery
  device.js             Device logic: polling, capability listeners
locales/               en/de translations
assets/, drivers/uku/assets/   Icons & images (placeholders — swap for real art)
```

## Running / testing this app

You'll need the [Homey CLI](https://apps.developer.homey.app/) and a Homey
Pro on the same network (or reachable), plus your HUUM account credentials.

```bash
npm install -g homey
homey login
homey app validate     # static checks
homey app run           # installs & runs on your Homey for live testing
```

During pairing you'll be asked for your HUUM email and password (same ones
as the official app). The app fetches `/action/home/status` once to
validate them and to detect your sauna's name and whether it has a
light/fan relay.

## Known limitations / TODO

- Only tested structurally (schema validation), **not against real
  hardware yet** — please verify carefully, especially:
  - the door-open safety check actually blocking a start
  - that `target_humidity` values round-trip correctly (Homey stores it as
    a 0–1 fraction, the API uses whole percent)
- The API only exposes a *toggle* for the light, not an explicit on/off —
  `onoff.light` compensates by comparing against the last known state, but
  can drift out of sync if the light is toggled from elsewhere (e.g. the
  physical panel) between polls.
- `huum_time_remaining` and the "finishing soon" trigger are derived from
  the API's `endDate` timestamp minus the current time — untested against
  a real running heater, verify the countdown actually matches reality.
- `setCapabilityOptions()` (narrowing `target_temperature` to the heater's
  own reported min/max) and `setEnergy()` (per-device Energy wattage) are
  called defensively (wrapped, errors logged, never thrown) since this
  scaffold couldn't be verified against a real Homey firmware version —
  if your firmware doesn't support one of them, the app still works, it
  just falls back to the static defaults in `app.json`.
- Placeholder icons/images — replace `assets/icon.svg` and the generated
  PNGs with real artwork before publishing anywhere.
- Not published to the Homey App Store; run it via `homey app run` (or
  `homey app install`) on your own Homey.

## Credits

API behaviour reverse-engineered from the publicly documented, HUUM-sanctioned
third-party client [pyhuum](https://github.com/frwickst/pyhuum) (MIT
licensed) — no code from that project was copied, only the documented
endpoint/field shapes.
