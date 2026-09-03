'use strict';
// Regression guard for the mechanically-checkable subset of the Homey App
// Store Guidelines (the ones the official review AI enforces — see
// node_modules-installed homey-lib's AIReviewer/data/guidelines.md and
// checklist.md for the source of truth). This won't catch subjective
// things like icon "recognisability", but it does catch the concrete
// mistakes that were actually found in this app: an app icon identical to
// the driver icon, wrong icon canvas, missing image files, wrong image
// dimensions, and parentheses/When-And-Then in Flow titles.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const APP_DIR = path.join(__dirname, '..');
const appJson = require(path.join(APP_DIR, 'app.json'));

function readPngDimensions(filePath) {
  const buf = fs.readFileSync(filePath);
  assert.ok(buf.slice(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), `${filePath} is not a valid PNG`);
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function assertImageSet(images, expected, label) {
  assert.ok(images && images.small && images.large, `${label}: "images" must declare at least small and large`);
  for (const [size, dims] of Object.entries(expected)) {
    const rel = images[size];
    if (!rel) continue; // xlarge is optional
    const abs = path.join(APP_DIR, rel);
    assert.ok(fs.existsSync(abs), `${label}: ${size} image "${rel}" does not exist`);
    const actual = readPngDimensions(abs);
    assert.deepStrictEqual(actual, dims, `${label}: ${size} image should be ${dims.width}x${dims.height}, is ${actual.width}x${actual.height}`);
  }
}

// --- 1.1 App Name ---------------------------------------------------------
for (const [locale, name] of Object.entries(appJson.name)) {
  const wordCount = name.trim().split(/\s+/).length;
  assert.ok(wordCount <= 4, `app name (${locale}) "${name}" has ${wordCount} words, guideline 1.1 allows at most 4`);
  assert.ok(!/\b(homey|athom)\b/i.test(name), `app name (${locale}) "${name}" must not contain "Homey"/"Athom" (guideline 1.1)`);
}
assert.ok(!/homey|athom/i.test(appJson.id), `app id "${appJson.id}" must not contain "homey"/"athom" (guideline / checklist "App ID")`);
console.log('OK: app name word count and Homey/Athom naming rules (guideline 1.1)');

// --- Author / donate (mirrors this developer's other Homey app) ----------
assert.ok(appJson.author && appJson.author.name, 'author.name must be set (guideline: account/author info)');
assert.ok(
  !appJson.author.email,
  'author.email should not be published in app.json (matches this developer\'s other apps, which omit it)',
);
assert.ok(
  appJson.contributing?.donate?.paypal?.username,
  'contributing.donate.paypal.username should be set (matches this developer\'s other apps)',
);
console.log('OK: author/donate info present and matches the no-public-email convention');

// --- 1.7 Brand color, SDK, permissions ------------------------------------
assert.match(appJson.brandColor || '', /^#[0-9a-fA-F]{6}$/, 'brandColor must be set as a hex color (guideline 1.7)');
assert.strictEqual(appJson.sdk, 3, 'new apps must be built on SDK v3 (guideline 1.14)');
// `homey:manager:api` is requested so the user can link a real power meter
// (e.g. a Shelly) for the Energy estimate, from the app settings page. This
// permission is Homey-Cloud-incompatible and would be scrutinised at App
// Store review — which is fine: this app is a personal `homey app install`,
// hence `platforms: ["local"]` too.
assert.deepStrictEqual(
  appJson.permissions, ['homey:manager:api'],
  'the only expected permission is homey:manager:api (power-meter linking) — update this test deliberately if that changes',
);
assert.deepStrictEqual(appJson.platforms, ['local'], 'app is local-only (app settings page + manager:api are not supported on Homey Cloud)');
console.log('OK: brandColor present, SDK v3, permissions limited to the justified homey:manager:api');

// --- 1.5/1.6 Icons ---------------------------------------------------------
const appIconPath = path.join(APP_DIR, 'assets', 'icon.svg');
assert.ok(fs.existsSync(appIconPath), 'assets/icon.svg (app icon) must exist (guideline 1.5)');
const appIconSvg = fs.readFileSync(appIconPath, 'utf8');
assert.match(appIconSvg, /viewBox="0 0 960 960"/, 'app icon should use the full 960x960 canvas (guideline 1.5)');

for (const driver of appJson.drivers) {
  const driverIconPath = path.join(APP_DIR, 'drivers', driver.id, 'assets', 'icon.svg');
  assert.ok(fs.existsSync(driverIconPath), `driver "${driver.id}" is missing an icon.svg (guideline 1.6)`);
  const driverIconSvg = fs.readFileSync(driverIconPath, 'utf8');
  assert.match(driverIconSvg, /viewBox="0 0 960 960"/, `driver "${driver.id}" icon should use the full 960x960 canvas (guideline 1.6)`);
  // The concrete bug this guards against: app icon === driver icon, which
  // is an explicit reject trigger ("App icon cannot be the same as a
  // driver icon").
  assert.notStrictEqual(
    driverIconSvg,
    appIconSvg,
    `driver "${driver.id}" icon must not be identical to the app icon (guideline 1.6 / checklist "Icon")`,
  );
}
console.log('OK: app and driver icons exist, use the full canvas, and are not identical to each other');

// --- 1.4 Images -------------------------------------------------------------
assertImageSet(appJson.images, {
  small: { width: 250, height: 175 },
  large: { width: 500, height: 350 },
  xlarge: { width: 1000, height: 700 },
}, 'app image');

for (const driver of appJson.drivers) {
  assertImageSet(driver.images, {
    small: { width: 75, height: 75 },
    large: { width: 500, height: 500 },
    xlarge: { width: 1000, height: 1000 },
  }, `driver "${driver.id}" image`);
}
console.log('OK: app and driver images exist at the guideline-mandated pixel dimensions (1.4)');

// --- 1.9 Flow card titles ---------------------------------------------------
function checkFlowTitles(cards, kind) {
  for (const card of cards || []) {
    for (const [locale, title] of Object.entries(card.title || {})) {
      assert.ok(!/[()]/.test(title), `${kind} "${card.id}" title (${locale}) "${title}" must not contain parentheses (guideline 1.9)`);
      assert.ok(
        !/^(when|and|then)\b/i.test(title.trim()),
        `${kind} "${card.id}" title (${locale}) "${title}" must not start with When/And/Then (guideline 1.9)`,
      );
    }
  }
}
checkFlowTitles(appJson.flow?.triggers, 'trigger');
checkFlowTitles(appJson.flow?.conditions, 'condition');
checkFlowTitles(appJson.flow?.actions, 'action');
console.log('OK: custom Flow card titles have no parentheses and no When/And/Then prefix (guideline 1.9)');

// --- 1.2/1.3 Description vs readme -----------------------------------------
for (const [locale, description] of Object.entries(appJson.description)) {
  assert.notStrictEqual(description.trim(), '', `description (${locale}) must not be empty (guideline 1.2)`);
  assert.ok(
    !new RegExp(`^${appJson.name[locale] ? appJson.name[locale].replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : '$^'}$`).test(description.trim()),
    `description (${locale}) must not just be the app name (guideline 1.2)`,
  );
}
const readmeFiles = { en: 'README.txt', de: 'README.de.txt' };
for (const [locale, file] of Object.entries(readmeFiles)) {
  const p = path.join(APP_DIR, file);
  assert.ok(fs.existsSync(p), `${file} (App Store readme for "${locale}") must exist (guideline 1.3) — note: README.md is NOT read by the App Store`);
  const content = fs.readFileSync(p, 'utf8');
  assert.ok(!/https?:\/\//.test(content), `${file} must not contain URLs (guideline 1.3)`);
  assert.ok(!/^#{1,6}\s|\*\*|\[.*\]\(.*\)/m.test(content), `${file} must not contain Markdown syntax (guideline 1.3)`);
  assert.ok(content.trim() !== appJson.description[locale].trim(), `${file} must not be identical to the description (guideline 1.2/1.3)`);
}
console.log('OK: README.txt/README.de.txt exist, contain no URLs/Markdown, and differ from the description');

console.log('\nAll manifest guideline checks passed.');
