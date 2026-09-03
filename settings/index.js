/* global Homey */
'use strict';

const DE = (navigator.language || 'en').toLowerCase().startsWith('de');
const T = DE ? {
  title: 'HUUM Sauna', picker: 'Sauna',
  info: 'Sauna', profiles: 'Profile', advanced: 'Erweitert',
  power: 'Ofenleistung (Energieschätzung)', stats: 'Statistik',
  poll: 'Statusabruf beim Heizen (Sek.)', idle: 'Statusabruf im Standby (Sek.)',
  finish: 'Schwelle „bald fertig" (Min.)',
  psEstimate: 'Aus kW-Wert schätzen', psMeter: 'Mit einem Gerät messen',
  kw: 'Ofenleistung (kW)',
  meterHint: 'Wähle ein Gerät, das Leistung meldet (z. B. deinen Shelly). Seine Live-Wattzahl wird auf die Sauna gespiegelt und vom Energie-Tab genutzt.',
  meterNone: 'Kein Messgerät gefunden.',
  meterNoPerm: 'Geräteliste nicht verfügbar (fehlende Berechtigung). Nutze die kW-Schätzung.',
  save: 'Speichern', saved: 'Gespeichert', loading: 'Lädt…',
  resetProfiles: 'Auf Standard zurücksetzen',
  themeAuto: 'Automatisch', themeLight: 'Hell', themeDark: 'Dunkel',
  empty: 'Noch keine Sauna gekoppelt. Füge zuerst eine unter „Geräte" hinzu.',
  name: 'Name', temp: 'Temperatur (°C)', hum: 'Feuchte (%)',
  fStatus: 'Status', fHeating: 'Heizt', fCurTemp: 'Aktuelle Temperatur',
  fTgtTemp: 'Zieltemperatur', fCurHum: 'Aktuelle Feuchte', fTgtHum: 'Zielfeuchte',
  fRemaining: 'Restzeit (Min.)', fDoor: 'Tür offen', fPower: 'Leistung (W)',
  fSteamer: 'Verdampfer angeschlossen', fLight: 'Licht/Lüfter angeschlossen',
  fChildLock: 'Kindersicherung', fRemote: 'Fernsicherheitsstatus',
  fPayment: 'Abo gültig bis', fLimits: 'Gemeldete Grenzen', fAvailable: 'Verfügbar',
  sSessions: 'Sitzungen', sTotal: 'Gesamte Heizzeit', sLast: 'Letzte Sitzung',
  yes: 'Ja', no: 'Nein', none: '–',
} : {
  title: 'HUUM Sauna', picker: 'Sauna',
  info: 'Sauna', profiles: 'Profiles', advanced: 'Advanced',
  power: 'Heater power (Energy estimate)', stats: 'Statistics',
  poll: 'Status refresh while heating (sec)', idle: 'Status refresh while idle (sec)',
  finish: '"Finishing soon" threshold (min)',
  psEstimate: 'Estimate from a kW value', psMeter: 'Measure with a device',
  kw: 'Heater power (kW)',
  meterHint: 'Pick a device that reports power (e.g. your Shelly). Its live wattage is mirrored onto the sauna and used by the Energy tab.',
  meterNone: 'No power-measuring device found.',
  meterNoPerm: 'Device list unavailable (missing permission). Use the kW estimate.',
  save: 'Save', saved: 'Saved', loading: 'Loading…',
  resetProfiles: 'Reset to defaults',
  themeAuto: 'Automatic', themeLight: 'Light', themeDark: 'Dark',
  empty: 'No sauna paired yet. Add one from Devices first.',
  name: 'Name', temp: 'Temperature (°C)', hum: 'Humidity (%)',
  fStatus: 'Status', fHeating: 'Heating', fCurTemp: 'Current temperature',
  fTgtTemp: 'Target temperature', fCurHum: 'Current humidity', fTgtHum: 'Target humidity',
  fRemaining: 'Time remaining (min)', fDoor: 'Door open', fPower: 'Power (W)',
  fSteamer: 'Steamer connected', fLight: 'Light/fan connected',
  fChildLock: 'Child lock', fRemote: 'Remote safety state',
  fPayment: 'Subscription valid until', fLimits: 'Reported limits', fAvailable: 'Available',
  sSessions: 'Sessions', sTotal: 'Total heating time', sLast: 'Last session',
  yes: 'Yes', no: 'No', none: '–',
};

let Homey = null;
let homeyApi = null;
let saunas = [];
let currentId = null;
let refreshTimer = null;

function applyTheme(value) {
  const v = value === 'light' || value === 'dark' ? value : 'auto';
  if (v === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', v);
  const sel = $('theme');
  if (sel) sel.value = v;
}

const $ = (id) => document.getElementById(id);

function call(method, path, body) {
  return new Promise((resolve, reject) => {
    let done = false;
    const to = setTimeout(() => {
      if (done) return;
      done = true;
      reject(new Error(`Timed out: ${method} ${path}`));
    }, 12000);
    try {
      homeyApi(method, path, body || null, (err, result) => {
        if (done) return;
        done = true;
        clearTimeout(to);
        if (err) reject(err instanceof Error ? err : new Error(typeof err === 'string' ? err : JSON.stringify(err)));
        else resolve(result);
      });
    } catch (e) {
      if (done) return;
      done = true;
      clearTimeout(to);
      reject(e);
    }
  });
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function applyStaticText() {
  const set = (id, txt) => { const el = $(id); if (el) el.textContent = txt; };
  document.title = T.title;
  set('title', T.title);
  set('picker-label', T.picker);
  set('h-info', T.info);
  set('h-profiles', T.profiles);
  set('h-advanced', T.advanced);
  set('h-power', T.power);
  set('h-stats', T.stats);
  set('l-poll', T.poll);
  set('l-idle', T.idle);
  set('l-finish', T.finish);
  set('l-ps-estimate', T.psEstimate);
  set('l-ps-meter', T.psMeter);
  set('l-kw', T.kw);
  set('meter-hint', T.meterHint);
  set('empty-text', T.empty);
  set('reset-profiles', T.resetProfiles);
  for (const b of ['save-profiles', 'save-advanced', 'save-power']) set(b, T.save);
  for (const s of ['saved-profiles', 'saved-advanced', 'saved-power']) set(s, T.saved);
  const themeSel = $('theme');
  if (themeSel && themeSel.options.length === 3) {
    themeSel.options[0].textContent = T.themeAuto;
    themeSel.options[1].textContent = T.themeLight;
    themeSel.options[2].textContent = T.themeDark;
  }
}

function fmtDuration(min) {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function rowsHtml(rows) {
  return rows.map(([k, v]) => `<div class="row"><span class="k">${esc(k)}</span><span class="v">${esc(String(v))}</span></div>`).join('');
}

function renderInfo(s) {
  const i = s.info || {};
  $('info').innerHTML = rowsHtml([
    [T.fAvailable, s.available ? T.yes : T.no],
    [T.fStatus, i.currentStatus || s.statusText || T.none],
    [T.fHeating, s.heating ? T.yes : T.no],
    [T.fCurTemp, s.measureTemperature == null ? T.none : `${s.measureTemperature} °C`],
    [T.fTgtTemp, s.targetTemperature == null ? T.none : `${s.targetTemperature} °C`],
    [T.fCurHum, s.measureHumidity == null ? T.none : `${Math.round(s.measureHumidity * 100)} %`],
    [T.fTgtHum, s.targetHumidity == null ? T.none : `${Math.round(s.targetHumidity * 100)} %`],
    [T.fRemaining, s.timeRemaining == null ? T.none : s.timeRemaining],
    [T.fDoor, s.doorOpen == null ? T.none : (s.doorOpen ? T.yes : T.no)],
    [T.fPower, s.measurePower == null ? T.none : `${Math.round(s.measurePower)} W`],
    [T.fSteamer, i.steamerInstalled || T.none],
    [T.fLight, i.lightInstalled || T.none],
    [T.fChildLock, i.childLock || T.none],
    [T.fRemote, i.remoteSafetyState || T.none],
    [T.fPayment, i.paymentEndDate || T.none],
    [T.fLimits, i.deviceLimits || T.none],
  ]);
}

function renderStats(s) {
  const st = s.stats || {};
  const last = st.lastSession;
  const lastText = last
    ? `${new Date(last.startedAt).toLocaleString()} (${fmtDuration(last.durationMinutes)}), ${last.temperature ?? '?'}°C${last.humidity > 0 ? `, ${last.humidity}%` : ''}`
    : T.none;
  $('stats').innerHTML = rowsHtml([
    [T.sSessions, st.sessionCount || 0],
    [T.sTotal, fmtDuration(st.totalHeatingMinutes || 0)],
    [T.sLast, lastText],
  ]);
}

function renderProfiles(cfg) {
  const hasSteamer = cfg.hasSteamer;
  $('profiles').innerHTML = cfg.profiles.map((p, idx) => `
    <div class="profile">
      <label>${T.name}</label>
      <input type="text" data-p="${idx}" data-f="name" value="${esc(p.name || '')}" maxlength="40" />
      <div class="grid3">
        <div><label>${T.temp}</label><input type="number" data-p="${idx}" data-f="temperature" min="40" max="110" step="1" value="${p.temperature ?? ''}" /></div>
        <div${hasSteamer ? '' : ' style="opacity:.4"'}><label>${T.hum}</label><input type="number" data-p="${idx}" data-f="humidity" min="0" max="90" step="5" value="${p.humidity ?? ''}" ${hasSteamer ? '' : 'disabled'} /></div>
      </div>
    </div>`).join('');
}

function renderAdvanced(cfg) {
  $('pollInterval').value = cfg.advanced.pollInterval;
  $('idlePollInterval').value = cfg.advanced.idlePollInterval;
  $('finishingSoonThresholdMinutes').value = cfg.advanced.finishingSoonThresholdMinutes;
}

function renderPower(cfg) {
  const src = cfg.power.source === 'meter' ? 'meter' : 'estimate';
  $('ps-estimate').checked = src === 'estimate';
  $('ps-meter').checked = src === 'meter';
  $('heaterPowerKw').value = cfg.power.heaterPowerKw;
  updatePowerBoxes();
}

function updatePowerBoxes() {
  const meter = $('ps-meter').checked;
  $('estimate-box').hidden = meter;
  $('meter-box').hidden = !meter;
}

async function loadPowerMeters(selectedId) {
  const sel = $('powerMeterId');
  sel.innerHTML = '';
  try {
    const res = await call('GET', '/power-meters');
    if (!res || !res.available) {
      $('meter-err').textContent = T.meterNoPerm;
      $('meter-err').hidden = false;
      return;
    }
    $('meter-err').hidden = true;
    if (!res.devices.length) {
      $('meter-err').textContent = T.meterNone;
      $('meter-err').hidden = false;
    }
    for (const d of res.devices) {
      const o = document.createElement('option');
      o.value = d.id;
      o.textContent = d.power == null ? d.name : `${d.name} — ${Math.round(d.power)} W`;
      if (d.id === selectedId) o.selected = true;
      sel.appendChild(o);
    }
  } catch (err) {
    $('meter-err').textContent = String(err.message || err);
    $('meter-err').hidden = false;
  }
}

function flashSaved(id) {
  const el = $(id);
  el.hidden = false;
  setTimeout(() => { el.hidden = true; }, 2000);
}

function showFatal(err) {
  const el = $('fatal');
  el.textContent = String((err && err.message) || err);
  el.hidden = false;
}

async function selectSauna(id) {
  currentId = id;
  const s = saunas.find((x) => x.id === id);
  if (!s) return;
  renderInfo(s);
  renderStats(s);
  let cfg = s.config;
  if (!cfg) cfg = await call('GET', `/device/${encodeURIComponent(id)}/config`);
  renderProfiles(cfg);
  renderAdvanced(cfg);
  renderPower(cfg);
  await loadPowerMeters(cfg.power.meterId);
}

async function refresh() {
  let list;
  try {
    list = await call('GET', '/overview');
  } catch (err) {
    return;
  }
  saunas = Array.isArray(list) ? list : [];
  if (!saunas.length) {
    $('content').hidden = true;
    $('empty').hidden = false;
    return;
  }
  $('empty').hidden = true;
  $('content').hidden = false;

  const picker = $('picker');
  if (saunas.length > 1) {
    $('picker-wrap').hidden = false;
    picker.innerHTML = saunas.map((s) => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('');
    if (currentId) picker.value = currentId;
  } else {
    $('picker-wrap').hidden = true;
  }

  const s = saunas.find((x) => x.id === currentId) || saunas[0];
  renderInfo(s);
  renderStats(s);
  if (currentId !== s.id) await selectSauna(s.id);
}

function wire() {
  $('picker').addEventListener('change', (e) => selectSauna(e.target.value).catch(showFatal));
  $('ps-estimate').addEventListener('change', updatePowerBoxes);
  $('ps-meter').addEventListener('change', updatePowerBoxes);

  $('theme').addEventListener('change', (e) => {
    applyTheme(e.target.value);
    try { Homey.set('uiTheme', e.target.value, () => {}); } catch (err) { /* ignore */ }
  });

  $('reset-profiles').addEventListener('click', async () => {
    const btn = $('reset-profiles');
    btn.disabled = true;
    try {
      const cfg = await call('PUT', `/device/${encodeURIComponent(currentId)}/config`, { resetProfiles: true });
      renderProfiles(cfg);
      flashSaved('saved-profiles');
    } catch (err) { showFatal(err); }
    btn.disabled = false;
  });

  $('save-profiles').addEventListener('click', async () => {
    const btn = $('save-profiles');
    btn.disabled = true;
    const profiles = [0, 1, 2].map((idx) => {
      const get = (f) => document.querySelector(`[data-p="${idx}"][data-f="${f}"]`);
      return {
        name: get('name').value,
        temperature: get('temperature').value === '' ? null : Number(get('temperature').value),
        humidity: get('humidity').value === '' ? null : Number(get('humidity').value),
      };
    });
    try {
      const cfg = await call('PUT', `/device/${encodeURIComponent(currentId)}/config`, { profiles });
      renderProfiles(cfg);
      flashSaved('saved-profiles');
    } catch (err) { showFatal(err); }
    btn.disabled = false;
  });

  $('save-advanced').addEventListener('click', async () => {
    const btn = $('save-advanced');
    btn.disabled = true;
    const advanced = {
      pollInterval: Number($('pollInterval').value),
      idlePollInterval: Number($('idlePollInterval').value),
      finishingSoonThresholdMinutes: Number($('finishingSoonThresholdMinutes').value),
    };
    try {
      await call('PUT', `/device/${encodeURIComponent(currentId)}/config`, { advanced });
      flashSaved('saved-advanced');
    } catch (err) { showFatal(err); }
    btn.disabled = false;
  });

  $('save-power').addEventListener('click', async () => {
    const btn = $('save-power');
    btn.disabled = true;
    const power = {
      source: $('ps-meter').checked ? 'meter' : 'estimate',
      meterId: $('ps-meter').checked ? ($('powerMeterId').value || null) : null,
      heaterPowerKw: Number($('heaterPowerKw').value),
    };
    try {
      const cfg = await call('PUT', `/device/${encodeURIComponent(currentId)}/config`, { power });
      renderPower(cfg);
      flashSaved('saved-power');
    } catch (err) { showFatal(err); }
    btn.disabled = false;
  });
}

function onHomeyReady(homey) {
  Homey = homey;
  // Tell Homey the page is up FIRST, so the container never spins forever.
  try { Homey.ready(); } catch (e) { /* ignore */ }

  try {
    homeyApi = Homey.api.bind(Homey);
    applyStaticText();
    wire();
  } catch (e) {
    showFatal(e);
    return;
  }

  try {
    Homey.get('uiTheme', (err, val) => applyTheme(err ? 'auto' : val));
  } catch (e) { /* ignore */ }

  refresh()
    .then(() => (saunas.length ? selectSauna(saunas[0].id) : null))
    .catch(showFatal);

  refreshTimer = setInterval(() => { refresh().catch(() => {}); }, 10000);
  window.addEventListener('unload', () => clearInterval(refreshTimer));
}

window.onHomeyReady = onHomeyReady;
