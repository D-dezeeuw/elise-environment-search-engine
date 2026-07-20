/*
  ELISE — Overpass API client.

  Builds one union query from the active category fragments and POSTs it
  to the primary endpoint, falling back to the mirror on any failure.
  Keyless and CORS-open; be polite: exactly one query per user search.
*/

import {
  OVERPASS_ENDPOINTS, OVERPASS_TIMEOUT_S, CLIENT_TIMEOUT_MS, OVERPASS_RETRY_DELAY_MS,
} from './config.js';
import { toQl } from './categories.js';
import { logEvent } from './log.js';

const host = (url) => new URL(url).host;

// Bounding box around the circle. A global [bbox:...] filter rides the
// spatial index — the native fast path — where N × (around:...) filters
// each cost a full scan and were timing out real searches. The circle is
// enforced client-side afterwards (results.js drops bbox-corner extras).
const bboxFor = (lat, lon, radiusM) => {
  const dLat = radiusM / 111320;
  const dLon = radiusM / (111320 * Math.max(0.05, Math.cos((lat * Math.PI) / 180)));
  const s = Math.max(-90, lat - dLat).toFixed(6);
  const n = Math.min(90, lat + dLat).toFixed(6);
  return `${s},${(lon - dLon).toFixed(6)},${n},${(lon + dLon).toFixed(6)}`;
};

export function buildQuery(groups, area) {
  const lat = Number(area.lat);
  const lon = Number(area.lon);
  const radius = Math.round(Number(area.radiusM));
  // Numbers only ever reach the query text — never raw strings.
  if (![lat, lon, radius].every(Number.isFinite)) throw new Error('Invalid search area');
  const members = groups.map((g) => `  ${toQl(g)};`).join('\n');
  // `out center qt 200` caps the payload server-side (qt = quadtile order,
  // cheaper than the default id sort); the client re-ranks and trims to
  // MAX_RESULTS anyway.
  return `[out:json][timeout:${OVERPASS_TIMEOUT_S}][bbox:${bboxFor(lat, lon, radius)}];\n(\n${members}\n);\nout center qt 200;`;
}

// Classify a failure so the UI can say what actually happened.
// kinds: 'busy' (rate limited / overloaded), 'timeout', 'query' (bad
// request — retrying is pointless), 'network' (unreachable/CORS/offline).
const classify = (err, status) => {
  if (status === 429 || status === 502 || status === 503) return 'busy';
  if (status === 504 || err?.name === 'AbortError') return 'timeout';
  if (status === 400) return 'query';
  return 'network';
};

async function requestOnce(endpoint, query, outerSignal) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), CLIENT_TIMEOUT_MS);
  const signal = outerSignal && typeof AbortSignal.any === 'function'
    ? AbortSignal.any([ctrl.signal, outerSignal])
    : ctrl.signal;
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'data=' + encodeURIComponent(query),
      signal,
    });
    if (!res.ok) {
      const err = new Error(`Overpass responded ${res.status}`);
      err.kind = classify(null, res.status);
      throw err;
    }
    const json = await res.json();
    return json.elements ?? [];
  } catch (err) {
    err.kind = err.kind ?? classify(err, 0);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Walk the endpoint list; if the whole list fails, wait for rate-limit
// windows to clear and walk it once more. A 400 aborts immediately —
// that's a broken query, not a busy server.
export async function overpassSearch(groups, area, outerSignal) {
  const query = buildQuery(groups, area);
  logEvent(`Overpass: query started (${groups.length} selectors, radius ${Math.round(area.radiusM)} m)`);
  let lastError = null;
  for (let pass = 0; pass < 2; pass++) {
    if (outerSignal?.aborted) break; // deadline hit — stop, don't spawn zombies
    if (pass > 0) {
      logEvent(`Overpass: all endpoints failed, retrying in ${OVERPASS_RETRY_DELAY_MS / 1000} s`, 'warn');
      await sleep(OVERPASS_RETRY_DELAY_MS);
    }
    for (const endpoint of OVERPASS_ENDPOINTS) {
      if (outerSignal?.aborted) break;
      const t0 = performance.now();
      try {
        const elements = await requestOnce(endpoint, query, outerSignal);
        const count = Array.isArray(elements) ? elements.length : '?';
        logEvent(`Overpass: ${host(endpoint)} answered ${count} elements in ${Math.round(performance.now() - t0)} ms`);
        return elements;
      } catch (err) {
        if (err.kind === 'query') throw err;
        logEvent(`Overpass: ${host(endpoint)} failed after ${Math.round(performance.now() - t0)} ms (${err.kind})`, 'warn');
        lastError = err;
      }
    }
  }
  throw lastError ?? new Error('Overpass unavailable');
}
