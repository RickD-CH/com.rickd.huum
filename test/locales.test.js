'use strict';
// Verifies the en/de locale files stay in lock-step: same keys, same
// __placeholder__ variables per key (Homey's own Homey.__() substitution
// syntax — not {{mustache}}), no empty strings. Directly enforces
// the Homey App Store guideline "avoid sporadic translations throughout
// the app" / "if translated, keep it consistent" (EN und DE sollen
// vollständig und synchron sein).
const assert = require('assert');
const path = require('path');

const en = require(path.join(__dirname, '..', 'locales', 'en.json'));
const de = require(path.join(__dirname, '..', 'locales', 'de.json'));

function flatten(obj, prefix = '') {
  const out = {};
  for (const [key, value] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      Object.assign(out, flatten(value, fullKey));
    } else {
      out[fullKey] = value;
    }
  }
  return out;
}

function placeholders(str) {
  if (typeof str !== 'string') return new Set();
  return new Set([...str.matchAll(/__(\w+)__/g)].map((m) => m[1]));
}

(() => {
  const flatEn = flatten(en);
  const flatDe = flatten(de);
  const enKeys = new Set(Object.keys(flatEn));
  const deKeys = new Set(Object.keys(flatDe));

  const missingInDe = [...enKeys].filter((k) => !deKeys.has(k));
  const missingInEn = [...deKeys].filter((k) => !enKeys.has(k));
  assert.deepStrictEqual(missingInDe, [], `Keys present in en.json but missing in de.json: ${missingInDe.join(', ')}`);
  assert.deepStrictEqual(missingInEn, [], `Keys present in de.json but missing in en.json: ${missingInEn.join(', ')}`);
  console.log(`OK: en.json and de.json declare the exact same ${enKeys.size} keys`);

  for (const key of enKeys) {
    assert.notStrictEqual(String(flatEn[key]).trim(), '', `en.json "${key}" is empty`);
    assert.notStrictEqual(String(flatDe[key]).trim(), '', `de.json "${key}" is empty`);

    const enVars = placeholders(flatEn[key]);
    const deVars = placeholders(flatDe[key]);
    assert.deepStrictEqual(
      [...enVars].sort(),
      [...deVars].sort(),
      `"${key}": __placeholders__ differ between en ("${flatEn[key]}") and de ("${flatDe[key]}")`,
    );
  }
  console.log('OK: no empty strings, and __placeholders__ match between en/de for every key');

  // Same check for the inline en/de objects inside app.json itself
  // (name, description, driver/flow/capability/settings text, ...).
  const appJson = require(path.join(__dirname, '..', 'app.json'));

  function findI18nObjects(node, path_ = '$', out = []) {
    if (!node || typeof node !== 'object') return out;
    if (typeof node.en === 'string') {
      out.push({ path: path_, en: node.en, de: node.de });
    } else if (Array.isArray(node)) {
      node.forEach((item, i) => findI18nObjects(item, `${path_}[${i}]`, out));
    } else {
      for (const [key, value] of Object.entries(node)) {
        findI18nObjects(value, `${path_}.${key}`, out);
      }
    }
    return out;
  }

  const i18nObjects = findI18nObjects(appJson);
  assert.ok(i18nObjects.length > 10, 'sanity check: app.json should contain many en/de text objects');

  const missingDeInAppJson = i18nObjects.filter((o) => typeof o.de !== 'string' || o.de.trim() === '');
  assert.deepStrictEqual(
    missingDeInAppJson.map((o) => o.path),
    [],
    `app.json has English text with no (or empty) German translation at: ${missingDeInAppJson.map((o) => o.path).join(', ')}`,
  );
  console.log(`OK: all ${i18nObjects.length} en/de text objects in app.json have a non-empty German translation too`);
})();
