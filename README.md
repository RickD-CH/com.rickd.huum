# HUUM UKU Sauna — Homey App

A [Homey](https://homey.app) app for HUUM sauna heaters with the UKU WiFi
controller. It does the things the official HUUM Homey app doesn't: set the
**target humidity**, a **no-water** and **safety cut-out** alarm, a
**finishing-soon** timer, per-session **energy & cost**, a **scheduled start**,
**profiles**, a **dashboard widget**, and remote-start **Flow cards**.

## Why this app exists

HUUM's own mobile app can set target humidity and a few other things the
official Homey app never exposed. I reported that gap to Athom in June 2025;
it still hadn't been picked up, so this app talks to HUUM's cloud API
directly instead.

## What it does

**Controls** — on/off, target temperature (dial), current temperature,
target/current humidity (only when the UKU reports a steamer), light/fan relay
(only when wired up), a "start with" profile picker, and a "refresh now" button.

**Alarms** — door open (`alarm_contact`), no water in the steamer
(`alarm_water`, from `steamerError`), safety cut-out (`alarm_generic`, from
`isEmergencyStop`), and a **remote start blocked** sensor (`huum_remote_blocked`)
for the UKU's separate remote-safety confirmation.

**Profiles** — 3 named presets (name / temperature / humidity), edited on the
app settings page. Picking one on the device fills the target sliders; the
device switch and the widget can start straight from a profile.

**Scheduled start** — pick a time, a profile (or temperature + humidity), and an
optional auto-off after N hours. HUUM's API has no booking endpoint, so this
runs on Homey; it survives a restart and a start missed by >30 min is dropped
rather than fired late.

**Energy** — the HUUM API never reports wattage, so the Energy tab is fed by one
of: a kW estimate (full power heating up, then a duty cycle), a linked
`measure_power` device (e.g. a Shelly — mirrored onto the sauna, and each
session's kWh taken from the meter's own counter), or a value pushed by a Flow
(`set_measured_power`). The Statistics tab keeps totals, a per-session history,
and a per-kWh cost.

**Flow** — actions *start at [temp] °C and [humidity] %*, *start with profile
[1-3]*, *save current settings as profile [1-3]*, *set the measured power*;
conditions *time remaining below [min]*, *remote start is (not) blocked*;
triggers *the current temperature changed* (Homey's own `measure_temperature`
defaults only offer threshold cards, no plain "changed" one), *remote start
became blocked / available*, *a sauna session ended* (with `duration`,
`temperature`, `humidity`, `kwh`, `cost` tokens).

**Adaptive polling** — fast while heating, or while the door is open / a remote
start is blocked; slow while idle. Any command refreshes immediately regardless.

## How it talks to your sauna

Entirely through HUUM's cloud API (`sauna.huum.eu`) with HTTP Basic Auth — the
same email/password as the HUUM mobile app. There is no local/LAN protocol. A
HUUM account maps to exactly one sauna (your login *is* the sauna), so it's one
Homey device per account; add a second sauna by pairing again with its own
account. `lib/HuumApi.js` is a small dependency-free client (`/status`,
`/start`, `/stop`, `/light`).

Max target humidity depends on target temperature (steamer duty-cycle limits
from the UKU manual); the app enforces this and errors on an impossible combo.

The app is `platforms: ["local"]` and uses the `homey:manager:api` permission
(for the in-app power-meter picker) — fine for `homey app install` and the App
Store **test** channel; a Live submission would need that permission dropped and
the brand name reconsidered.

## Settings

**App settings page** (*Apps → HUUM UKU Sauna → Configure*) — tabs:

- **Overview** — everything the API reports, a "refresh" button with a
  timestamp, and the scheduled start.
- **Settings** — the two poll intervals + finishing-soon threshold, then the
  3 profiles.
- **Statistics** — session/energy/cost totals, average per session, a recent-
  sessions list, the heater-power source, and the electricity price.
- **Support** — donate / report an issue.

**Device settings** (the gear on the device) — sauna info (read-only), the
water-alarm push toggle, and **Sensors / hardware**: whether this sauna has a
water-level and a door sensor (`auto` / `present` / `absent`) + a "check the
water before heating" reminder. `absent` hides that alarm and, for the door,
skips the "don't start with the door open" check (a heater with no door contact
reports the door as permanently open).

Moved config lives in the device **store** (`app.json` can't hold free-form
settings); `_migrateLegacySettings()` copies values from older versions once.

## Develop / test

```bash
npm install -g homey
homey login
npm test                 # unit tests — no Homey, no HUUM account needed
homey app validate --level publish
homey app run            # or: homey app install
```

`npm test` covers `lib/HuumApi.js`, `drivers/uku/{device,driver}.js` (against a
stub Homey runtime in `test/homey-stub/`), `api.js`, the widget api,
en/de locale parity, and the mechanically-checkable App Store guidelines.

```
app.json                 manifest (drivers, capabilities, flow, api, widgets)
app.js                   HomeyAPI client, overview/config/power-meter helpers
api.js                   web API for the settings page
lib/HuumApi.js            HUUM cloud client
drivers/uku/              driver.js (pairing), device.js (polling + logic)
settings/index.html      app settings page (single file, inline JS)
widgets/sauna/           dashboard widget
locales/                  en / de
test/                     npm test
```

## Trademark / affiliation

Independent, unofficial app by a HUUM owner — **not affiliated with, endorsed by
or supported by HUUM OÜ**. "HUUM" and "UKU" are used only to describe
compatibility.

**For private home use only** — not tested or certified for commercial or
public sauna installations. Use at your own risk; follow your sauna's and
heater's own safety instructions. The same disclaimer is in `README.txt` /
`README.de.txt` (the App Store description).

## Credits

API behaviour taken from the publicly documented, HUUM-sanctioned third-party
client [pyhuum](https://github.com/frwickst/pyhuum) (MIT) — field/endpoint
shapes only, no code copied.
