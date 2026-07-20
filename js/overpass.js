/*
  ELISE — Overpass API client.

  Builds one union query from the active category fragments and POSTs it
  to the primary endpoint, falling back to the mirror on any failure.
  Keyless and CORS-open; be polite: exactly one query per user search.
*/

import { OVERPASS_ENDPOINTS, OVERPASS_TIMEOUT_S, CLIENT_TIMEOUT_MS } from './config.js';
import { toQl } from './categories.js';

export function buildQuery(fragments, area) {
  const lat = Number(area.lat);
  const lon = Number(area.lon);
  const radius = Math.round(Number(area.radiusM));
  // Numbers only ever reach the query text — never raw strings.
  if (![lat, lon, radius].every(Number.isFinite)) throw new Error('Invalid search area');
  const around = `(around:${radius},${lat.toFixed(6)},${lon.toFixed(6)})`;
  const members = fragments.map((c) => `  ${toQl(c)}${around};`).join('\n');
  // `out center 200` caps the payload server-side; the cut is by element
  // id, not relevance — acceptable because the radius already bounds the
  // area, and the client re-ranks and trims to MAX_RESULTS anyway.
  return `[out:json][timeout:${OVERPASS_TIMEOUT_S}];\n(\n${members}\n);\nout center 200;`;
}

export async function overpassSearch(fragments, area) {
  const query = buildQuery(fragments, area);
  let lastError = null;
  for (const endpoint of OVERPASS_ENDPOINTS) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), CLIENT_TIMEOUT_MS);
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'data=' + encodeURIComponent(query),
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`Overpass responded ${res.status}`);
      const json = await res.json();
      return json.elements ?? [];
    } catch (err) {
      lastError = err;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError ?? new Error('Overpass unavailable');
}
