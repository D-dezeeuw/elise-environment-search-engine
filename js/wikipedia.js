/*
  ELISE — Wikipedia GeoSearch client.

  Surfaces nearby landmarks with a short description and thumbnail, used
  to enrich Overpass results and to add sight-worthy places OSM tags
  alone don't rank. Keyless; CORS via origin=*. A failure here is
  non-fatal — the app degrades to Overpass-only results.
*/

import { WIKI_ENDPOINT, WIKI_MAX_RADIUS_M, WIKI_TIMEOUT_MS } from './config.js';
import { logEvent } from './log.js';

export async function wikipediaSearch(lat, lon, radiusM) {
  // ggsradius is hard-capped by the API at 10 km.
  const r = Math.min(Math.max(Math.round(radiusM), 10), WIKI_MAX_RADIUS_M);
  const url = new URL(WIKI_ENDPOINT);
  const params = {
    action: 'query',
    format: 'json',
    origin: '*',
    generator: 'geosearch',
    ggscoord: `${lat}|${lon}`,
    ggsradius: String(r),
    ggslimit: '20',
    prop: 'coordinates|pageimages|extracts',
    piprop: 'thumbnail',
    pithumbsize: '240',
    pilimit: '20',
    exintro: '1',
    explaintext: '1',
    exchars: '280',
    exlimit: '20',
  };
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  // Hard timeout: a black-holed connection here must never stall the
  // search — enrichment is optional, the spinner is not.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), WIKI_TIMEOUT_MS);
  logEvent(`Wikipedia: geosearch started (radius ${r} m)`);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) {
      logEvent(`Wikipedia: geosearch failed (${res.status})`, 'warn');
      return [];
    }
    const json = await res.json();
    const pages = Object.values(json?.query?.pages ?? {});
    logEvent(`Wikipedia: ${pages.length} nearby articles found`);
    return pages;
  } catch {
    logEvent('Wikipedia: geosearch failed (network/timeout)', 'warn');
    return [];
  } finally {
    clearTimeout(timer);
  }
}
