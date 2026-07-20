/*
  ELISE — Wikipedia GeoSearch client.

  Surfaces nearby landmarks with a short description and thumbnail, used
  to enrich Overpass results and to add sight-worthy places OSM tags
  alone don't rank. Keyless; CORS via origin=*. A failure here is
  non-fatal — the app degrades to Overpass-only results.
*/

import { WIKI_ENDPOINT, WIKI_MAX_RADIUS_M, WIKI_TIMEOUT_MS } from './config.js';

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
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) return [];
    const json = await res.json();
    return Object.values(json?.query?.pages ?? {});
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}
