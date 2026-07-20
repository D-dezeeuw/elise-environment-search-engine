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

// Classify a failure so the UI can say what actually happened.
// kinds: 'busy' (rate limited / overloaded), 'timeout', 'query' (bad
// request — retrying is pointless), 'network' (unreachable/CORS/offline).
const classify = (err, status) => {
  if (status === 429 || status === 502 || status === 503) return 'busy';
  if (status === 504 || err?.name === 'AbortError') return 'timeout';
  if (status === 400) return 'query';
  return 'network';
};

async function requestOnce(endpoint, query) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), CLIENT_TIMEOUT_MS);
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'data=' + encodeURIComponent(query),
      signal: ctrl.signal,
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
export async function overpassSearch(fragments, area) {
  const query = buildQuery(fragments, area);
  logEvent(`Overpass: query started (${fragments.length} categories, radius ${Math.round(area.radiusM)} m)`);
  let lastError = null;
  for (let pass = 0; pass < 2; pass++) {
    if (pass > 0) {
      logEvent(`Overpass: all endpoints failed, retrying in ${OVERPASS_RETRY_DELAY_MS / 1000} s`, 'warn');
      await sleep(OVERPASS_RETRY_DELAY_MS);
    }
    for (const endpoint of OVERPASS_ENDPOINTS) {
      const t0 = performance.now();
      try {
        const elements = await requestOnce(endpoint, query);
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
