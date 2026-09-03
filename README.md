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
  minutes-before-shutoff threshold, app settings page)
- Flow condition: *"Remaining time is/is not below `[minutes]` minutes"*
- Flow triggers/conditions for `alarm_water` and `alarm_generic` come for
  free from Homey (any standard alarm capability gets them automatically)
- Safety check: refuses to start the sauna while the door is open (same
  behaviour as the reference client library)
- Optional **push notification** when the steamer reports it needs water
  (device setting, on by default) — in addition to the `alarm_water`
  capability/Flow triggers
- **Energy tab** usage: either an estimate from a heater power (kW) you
  enter, or a real measurement mirrored from a power meter you link on the
  app settings page (the HUUM API itself never reports wattage)
- Device settings show read-only info reported by the heater itself: the
  **full raw status** (including "in use by another user", which was
  otherwise invisible), **whether a steamer and a light/fan are actually
  connected**, child lock state, remote safety state, subscription
  (`paymentEndDate`) end date, and its reported temperature/timer limits
- **Adaptive polling**: refreshes often while heating (default 30s,
  configurable), much less often while idle (default every 5 min,
  configurable) — any capability change (turning on, changing temperature,
  ...) still refreshes immediately regardless of this schedule. Goes
  easier on the HUUM cloud than polling at a fixed rate 24/7.

### Statistics & profiles

The HUUM cloud has no session history at all — the status endpoint is only
ever "right now" (see the "Confirmed NOT possible" note above). This app
tracks it itself, by watching the heater's on/off transitions while it's
running, and persists it in the device store so it survives restarts:

- `huum_session_count` capability — number of completed sessions since
  pairing, with a Homey Insights trend
- App settings page (*Statistics*, read-only): **total heating time**, and a
  **last session** summary (when, how long, at what temperature/humidity)
- Flow trigger *"A sauna session ended"* with `duration` (minutes),
  `temperature`, and `humidity` tokens — for logging, notifications, etc.

A session that was already running when the app started is timed from
"whenever the app first noticed", not the real start — HUUM's API doesn't
tell you when a session actually began, only whether it's heating right
now. A session that both started *and* ended while the app wasn't running
(e.g. Homey was rebooting) isn't counted at all rather than guessed at.

Profiles are 3 named presets (app settings page, e.g. "Familie" 80°C/30%,
"Kurz" 90°C/10%, "Lang" 70°C/40% by default — rename/retune them however
you like) with two Flow actions:

- *"Save the current settings as profile `[1/2/3]`"* — writes the
  device's current target temperature/humidity into that slot
- *"Start the sauna with profile `[1/2/3]`"* — starts it with whatever
  that slot has saved

Useful pattern: a wall switch or Flow button that saves "whatever I just
dialled in" as a profile once you've found a setting you like, then a
one-tap Flow to start the sauna the same way next time.

## Feature comparison

Researched against the **official HUUM Homey app** and the **Home
Assistant `huum` integration** (a mature, actively maintained reference —
part of Home Assistant core) to see what's realistically possible and
what's already been done well elsewhere:

| | Official Homey app | HA integration | This app |
|---|---|---|---|
| Set target humidity | ❌ | ✅ (fixed 0–40%, ignores temperature) | ✅ 0–90%, temperature-aware max |
| "No water" alarm | ❌ | ❌ (doesn't exist there either) | ✅ `alarm_water` |
| Emergency stop alarm | ❌ | ❌ | ✅ `alarm_generic` |
| Time remaining / finishing-soon | ❌ | ❌ | ✅ |
| Steamer/light hardware detection | ❌ | ✅ (used internally, not shown) | ✅ shown in settings |
| Energy tab estimate | ❌ | ❌ | ✅ |
| Full status incl. "locked by another user" | ❌ | ❌ | ✅ (settings label) |

**Confirmed NOT possible** (checked against Home Assistant's own
`diagnostics.py`, which dumps every field the API ever returns): the API
exposes **no firmware version, no WiFi signal strength, and no other
device diagnostics** beyond what's listed above — HUUM's cloud API simply
doesn't have that data, regardless of which client asks for it. It also
has no endpoint to set a custom heating *duration* — `/start` always runs
for a fixed period set by HUUM (documented as 3 hours); only temperature
and humidity are controllable.

### Steamer/light detection

The API's `config` field tells you what hardware this UKU is actually wired
up to (`1` = steamer only, `2` = light only, `3` = both — it's a bitmask).
The app reads this once at pairing and again on every poll:

- **No steamer detected** → `target_humidity`, `measure_humidity` and the
  `alarm_water` ("no water") alarm are never added to the device (or are
  removed if they were, e.g. after upgrading from an older version of this
  app) — no point offering humidity controls for hardware that isn't there.
- **No light/fan detected** → `onoff.light` is left off the device.
- Either way, the result is shown as plain "Yes/No" in the device settings
  under *Sauna info*, so you can see what the app detected without
  guessing from which capabilities happen to be visible.
- If `config` isn't returned by the API at all (older firmware?), the app
  assumes both are present rather than silently hiding something you do
  have.

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
assets/, drivers/uku/assets/   Icons & images
test/                  Unit tests (npm test) — see "Running the tests"
README.md              This file (developer docs, not read by the App Store)
README.txt/.de.txt     App Store readme (plain text, required by guideline 1.3)
```

## Multiple HUUM controllers

Yes — this already works today, no changes needed. A HUUM account maps to
exactly one sauna (the cloud API has no per-sauna ID — your login *is* the
sauna), so **one Homey device per HUUM account**. To add a second sauna,
just run "Add device" again and log in with that sauna's own HUUM account;
you end up with two independent Homey devices, each with its own stored
credentials, its own polling loop, its own detected capabilities (steamer/
light), and its own settings. Nothing in this app is a shared singleton —
`test/driver.test.js`'s `testMultipleSaunasPairAsIndependentDevices` pairs
two accounts back-to-back and asserts they come out as two distinct
devices with independently-detected hardware.

### Where the settings live

There is an **app settings page** (`settings/index.html`, reachable from
*More → Apps → HUUM Sauna → Configure*) that holds, per sauna:

- a live read-out of everything the API reports (status, steamer/light,
  child lock, remote safety, subscription end, limits, door, temp/humidity,
  time remaining),
- the **3 profiles** (name / temperature / humidity),
- **Advanced**: the two poll intervals and the "finishing soon" threshold,
- **Heater power** for the Energy estimate — either a manual kW value, or
  *link a real power meter* (any device exposing `measure_power`, e.g. a
  Shelly): its live wattage is mirrored onto the sauna's own `measure_power`
  and that is what the Energy tab uses. Linking a meter needs the
  `homey:manager:api` permission, which is why the app is `platforms:
  ["local"]` and shouldn't be submitted to the App Store as-is.

These settings are stored in the **device store**, not as Homey device
settings (Homey requires settings to be declared in `app.json`; the store
is free-form). `_migrateLegacySettings()` in `drivers/uku/device.js` copies
values written by an older version (when they *were* device settings) into
the store once.

The **device settings page** (the gear on the device) keeps only:

- **Sauna info** (read-only) — deliberately duplicated here and on the app page,
- **Notifications** — the water-alarm push toggle,
- **Sensors / hardware** — whether this sauna actually has a water-level
  sensor and a door sensor (`auto` / `present` / `absent`), plus a
  "remind me to check the water before heating" push. `absent` hides the
  corresponding alarm capability and, for the door, overrides the
  "don't start with the door open" safety check — a heater with no door
  contact reports the door as permanently open and could otherwise never
  be started.

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

### Running the tests

No Homey and no HUUM account needed — everything is mocked/stubbed:

```bash
npm test
```

- `test/huum-api.test.js` — `lib/HuumApi.js` business logic (temperature/
  humidity validation, door safety check, request payload shape, status
  parsing). Pure Node, no dependencies.
- `test/device.test.js` — `drivers/uku/device.js` against a stub Homey
  runtime (`test/homey-stub/`, standing in for the `Device`/`Driver`/`App`
  base classes the real Homey firmware injects at runtime, which don't
  exist in the `homey` CLI npm package). Covers the exception-handling
  behaviour described below, capability reconciliation, adaptive polling,
  session-statistics tracking (a full on/off cycle counts as one session;
  an end with no recorded start doesn't fabricate one), and saving/starting
  profiles.
- `test/driver.test.js` — `drivers/uku/driver.js` pairing and repair
  against the same stub, including the "multiple HUUM controllers"
  scenario above and steamer/light detection at pairing time.
- `test/locales.test.js` — asserts `locales/en.json` and `locales/de.json`
  declare exactly the same keys with the same `{{placeholders}}`, and that
  every en/de text object inline in `app.json` has a non-empty German
  translation. Catches sporadic/missing translations automatically instead
  of relying on someone noticing.
- `test/manifest.test.js` — regression guard for the mechanically-checkable
  Homey App Store Guidelines (see below): app/driver icon and image
  presence, exact pixel dimensions, the app icon not being identical to a
  driver icon, no parentheses/When-And-Then in Flow titles, README.txt
  existing with no Markdown/URLs, and a few more.

None of the test suites touch the network or a real Homey — they're the
fast, repeatable substitute for that until this app has actually run on
real hardware.

## Error handling

Every HUUM API call a capability listener or Flow action makes is caught
and, where it maps to something a user can act on, translated (de/en):
door open, wrong/expired login (also marks the device unavailable so
Homey prompts a repair), and asking for more humidity than the steamer
allows at the current temperature. Everything else (network errors, etc.)
still surfaces as an error, just untranslated.

Importantly, a **successful** command is never reported as failed just
because the immediate status refresh that follows it hits a hiccup — e.g.
turning the heater off always succeeds or fails on its own merits; if the
follow-up `getStatus()` call then times out, that's logged, not thrown, so
Homey doesn't show "action failed" for something that actually worked.
This is covered by `test/device.test.js`, which runs `drivers/uku/device.js`
against a stub Homey runtime and specifically simulates a successful
action whose immediate refresh fails (see "Running the tests" below).

## Trademark / affiliation

Independent, unofficial app by a HUUM owner — **not affiliated with, endorsed by
or supported by HUUM OÜ**. "HUUM" and "UKU" are used only to describe
compatibility. The disclaimer is in `README.txt` / `README.de.txt` (the App
Store description), modelled on the community Geberit AquaClean app.

## Author & support info

Matches the same developer's other Homey app ([Device
Watchdog](https://github.com/RickD-CH/com.rickd.devicewatchdog)):
`author.name` set, no public email in `app.json`, same PayPal donate
handle under `contributing.donate`. No `support` URL yet — Device
Watchdog's points at its Homey Community forum topic, which doesn't exist
for this app yet since it isn't published; add one the same way once it
does.

## App Store guideline audit

Checked against the actual [Homey App Store Guidelines](https://apps.developer.homey.app/app-store/guidelines)
— specifically the machine-checkable subset used by Homey's own review AI
(`homey-lib`'s bundled `guidelines.md`/`checklist.md`, installed with the
CLI). Found and fixed real violations, not just theoretical ones:

- **App icon was a filled illustration** (two solid black shapes) — guideline
  1.5 requires line-work only, no fills/gradients/background. Redrawn as an
  outline icon of the actual HUUM UKU wall control panel — square bezel,
  rotary dial with tick marks, digital display — stroke-only, front view.
- **App icon and driver icon were byte-identical** — an explicit reject
  trigger ("App icon cannot be the same as a driver icon"). Driver icon
  redrawn as the same UKU panel from an angled/side view instead (per
  guideline: prefer an angle over front-facing for driver icons), so the
  two are related but genuinely different compositions.
- **Driver images had a colored background** — guideline requires white (or
  transparent). Regenerated on white, now depicting the panel itself
  (dial, indicator, digital-readout strip) rather than an abstract shape.
- **App images were a big two-tone unicolored shape on a monochrome
  background** — the exact anti-pattern guideline 1.4 calls out. Regenerated
  as a (still simple, still not photographic — see limitations below)
  scene: the panel in a dim sauna room with rising steam.
- **No `README.txt`/`README.de.txt` existed at all** — Homey's App Store
  reads *those* files, in plain text, not `README.md` (which is GitHub-only
  documentation and is never shown to a Homey user). Added both, short,
  no Markdown, no URLs, distinct wording from the description.
- Description shortened and reworded so it doesn't just restate the readme.

`test/manifest.test.js` now guards the mechanical parts of this list so
they can't silently regress. What it *can't* check (and what nobody could,
mechanically): whether the icon reads as recognisable, whether the images
look genuinely professional — that's still a human/design judgment call.

Icons and images were redone after the owner tested the app:

- **Icons** (`assets/icon.svg`, `drivers/uku/assets/icon.svg`) — line art per
  guideline 1.5/1.6: a rock-topped sauna heater with steam (app), the UKU wall
  panel with its dial (driver).
- **App image** — a real photo (AI-generated, licensed to the owner): a matte
  black stone-topped heater in a cedar sauna, warm glow, steam, negative space
  left. Guideline 1.4.2 wants "lively, visually appealing… lifestyle images".
- **Driver image** — a studio product shot of the HUUM UKU controller (glossy
  black panel, teal display "80° / 1:30 40%", knurled knob with a teal ring) on
  a **white background**, as guideline 1.4.3 requires.

Homey image files are produced from the source images with `sharp` (headless
Chrome/Edge screenshotting is blocked by an OS policy on this machine, and
`@resvg/resvg-js` only rasterises SVG): centre/aspect-crop → resize → `flatten`
onto a solid background so there is no accidental alpha.

## Known limitations / TODO

- Only tested structurally (schema validation) and against a stub Homey
  runtime (device logic), **not against real hardware yet** — please
  verify carefully, especially:
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
- Icons and images were redrawn (`scratchpad` SVGs rasterised with
  `@resvg/resvg-js` — headless Chrome/Edge screenshotting is blocked on this
  machine by an OS policy) as vector illustrations: a rock-topped heater
  with steam (app) and the UKU panel in brand orange (driver). Still
  illustrative, not photographic — fine for a private install, worth
  replacing with real artwork before any App Store submission.
- Not published to the Homey App Store; run it via `homey app run` (or
  `homey app install`) on your own Homey.

## Credits

API behaviour reverse-engineered from the publicly documented, HUUM-sanctioned
third-party client [pyhuum](https://github.com/frwickst/pyhuum) (MIT
licensed) — no code from that project was copied, only the documented
endpoint/field shapes.
