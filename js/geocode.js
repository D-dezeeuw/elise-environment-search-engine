/*
  ELISE — reverse geocoding: coordinates → a human place name.

  Primary: BigDataCloud's client-side reverse geocoder — keyless, CORS-open,
  explicitly built for browser use. Fallback: Nominatim (OSM), used lightly
  (one call per located search origin, well within the usage policy).
  Returns null on failure — the label is decoration, never a blocker.
*/

import { GEOCODE_TIMEOUT_MS } from './config.js';
import { logEvent } from './log.js';

const fetchTimed = async (url) => {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), GEOCODE_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
};

// Resolves { name, countryCode } — the country drives which local-language
// Wikipedia is queried alongside English.
export async function reverseGeocode(lat, lon) {
  logEvent('Geocode: resolving place name started');
  const bdc = await fetchTimed(
    `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lon}&localityLanguage=en`,
  );
  const bdcName = bdc?.city || bdc?.locality || bdc?.principalSubdivision;
  if (bdcName) {
    logEvent(`Geocode: resolved to “${bdcName}” (${bdc.countryCode ?? '??'})`);
    return { name: bdcName, countryCode: bdc.countryCode ?? null };
  }

  const nom = await fetchTimed(
    `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lon}&zoom=10&accept-language=en`,
  );
  const a = nom?.address ?? {};
  const name = a.city || a.town || a.village || a.municipality || nom?.name || null;
  logEvent(name ? `Geocode: resolved to “${name}” (fallback)` : 'Geocode: no place name found', name ? 'info' : 'warn');
  return { name, countryCode: a.country_code ? a.country_code.toUpperCase() : null };
}
