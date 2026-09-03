'use strict';

/**
 * Returns the first defined, non-null value found in `obj` for the given
 * list of possible key names. HUUM's /status response is not fully
 * documented for every field (see README.md), so several plausible key
 * spellings are tried defensively where we're not 100% sure.
 */
function pick(obj, keys) {
  for (const key of keys) {
    if (obj && obj[key] !== undefined && obj[key] !== null) return obj[key];
  }
  return undefined;
}

/** HUUM returns some numeric fields (temperature, targetTemperature) as strings. */
function toNumber(value) {
  if (value === undefined || value === null || value === '') return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

module.exports = { pick, toNumber };
