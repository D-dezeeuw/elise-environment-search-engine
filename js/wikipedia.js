/*
  ELISE — Wikimedia clients: Wikipedia GeoSearch (any language wiki),
  Commons nearby images, and on-demand article details.

  All keyless, CORS via origin=*. Failures are non-fatal everywhere —
  these enrich results, they never block them.
*/

import { WIKI_MAX_RADIUS_M, WIKI_TIMEOUT_MS } from './config.js';
import { logEvent } from './log.js';

const apiUrl = (host, params) => {
  const url = new URL(`https://${host}/w/api.php`);
  url.searchParams.set('action', 'query');
  url.searchParams.set('format', 'json');
  url.searchParams.set('origin', '*');
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return url;
};

const fetchPages = async (url) => {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), WIKI_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) return null;
    const json = await res.json();
    return Object.values(json?.query?.pages ?? {});
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
};

export async function wikipediaSearch(lat, lon, radiusM, lang = 'en') {
  // ggsradius is hard-capped by the API at 10 km.
  const r = Math.min(Math.max(Math.round(radiusM), 10), WIKI_MAX_RADIUS_M);
  const url = apiUrl(`${lang}.wikipedia.org`, {
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
  });
  logEvent(`Wikipedia(${lang}): geosearch started (radius ${r} m)`);
  const pages = await fetchPages(url);
  if (!pages) {
    logEvent(`Wikipedia(${lang}): geosearch failed`, 'warn');
    return [];
  }
  logEvent(`Wikipedia(${lang}): ${pages.length} nearby articles found`);
  return pages.map((pg) => ({ ...pg, lang }));
}

// Nearby freely-licensed photos — used as thumbnail fallback for places
// without an article image.
export async function commonsNearbyImages(lat, lon, radiusM) {
  const r = Math.min(Math.max(Math.round(radiusM), 10), WIKI_MAX_RADIUS_M);
  const url = apiUrl('commons.wikimedia.org', {
    generator: 'geosearch',
    ggscoord: `${lat}|${lon}`,
    ggsradius: String(r),
    ggslimit: '30',
    ggsnamespace: '6', // File:
    prop: 'coordinates|imageinfo',
    iiprop: 'url',
    iiurlwidth: '320',
  });
  logEvent(`Commons: image geosearch started (radius ${r} m)`);
  const pages = await fetchPages(url);
  if (!pages) {
    logEvent('Commons: image geosearch failed', 'warn');
    return [];
  }
  const images = pages
    .map((pg) => ({
      lat: pg.coordinates?.[0]?.lat,
      lon: pg.coordinates?.[0]?.lon,
      thumb: pg.imageinfo?.[0]?.thumburl ?? null,
    }))
    .filter((im) => im.lat != null && im.lon != null
      && im.thumb && /\.(jpe?g|png|webp)$/i.test(im.thumb.split('?')[0]));
  logEvent(`Commons: ${images.length} usable photos found`);
  return images;
}

// Full article intro + a bigger image, fetched only when the user opens a
// detail modal, and cached so repeat taps cost nothing.
const detailCache = new Map();

export async function fetchWikiDetail(lang, pageid) {
  const key = `${lang}/${pageid}`;
  if (detailCache.has(key)) {
    logEvent(`Wikipedia(${lang}): detail for #${pageid} served from cache`);
    return detailCache.get(key);
  }
  const url = apiUrl(`${lang}.wikipedia.org`, {
    pageids: String(pageid),
    prop: 'extracts|pageimages',
    exintro: '1',
    explaintext: '1',
    piprop: 'thumbnail',
    pithumbsize: '640',
  });
  logEvent(`Wikipedia(${lang}): detail fetch started for #${pageid}`);
  const pages = await fetchPages(url);
  const page = pages?.find((pg) => pg.pageid === pageid) ?? pages?.[0];
  if (!page) {
    logEvent(`Wikipedia(${lang}): detail fetch failed for #${pageid}`, 'warn');
    return null;
  }
  const detail = {
    extract: (page.extract || '').trim() || null,
    image: page.thumbnail?.source ?? null,
  };
  detailCache.set(key, detail);
  logEvent(`Wikipedia(${lang}): detail loaded (${detail.extract?.length ?? 0} chars)`);
  return detail;
}
