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

const fetchJson = async (url) => {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), WIKI_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
};

const fetchPages = async (url) => {
  const json = await fetchJson(url);
  return json ? Object.values(json?.query?.pages ?? {}) : null;
};

// Local-wiki pages that link an English equivalent get English content:
// title, extract, image, pageid, and detail target all switch to en —
// the local wiki stays purely a discovery layer. One batched request.
async function anglicize(pages, lang) {
  const linked = new Map(); // english title -> local page
  for (const pg of pages) {
    const en = pg.langlinks?.find((l) => l.lang === 'en');
    const title = en?.['*'] ?? en?.title;
    if (title) linked.set(title, pg);
  }
  if (!linked.size) return pages;
  logEvent(`Wikipedia(${lang}): resolving ${linked.size} English equivalents`);
  const url = apiUrl('en.wikipedia.org', {
    titles: [...linked.keys()].join('|'),
    redirects: '1',
    prop: 'extracts|pageimages',
    exintro: '1',
    explaintext: '1',
    exchars: '280',
    exlimit: 'max',
    piprop: 'thumbnail',
    pithumbsize: '240',
  });
  const json = await fetchJson(url);
  if (!json) return pages;
  // The API may rename requested titles (normalization/redirects) — remap.
  for (const r of [...(json.query?.normalized ?? []), ...(json.query?.redirects ?? [])]) {
    if (linked.has(r.from)) linked.set(r.to, linked.get(r.from));
  }
  let resolved = 0;
  for (const epg of Object.values(json.query?.pages ?? {})) {
    const local = linked.get(epg.title);
    if (!local || epg.pageid == null || epg.pageid < 0) continue;
    local.lang = 'en';
    local.pageid = epg.pageid;
    local.title = epg.title;
    if (epg.extract) local.extract = epg.extract;
    if (epg.thumbnail) local.thumbnail = epg.thumbnail;
    resolved += 1;
  }
  logEvent(`Wikipedia(${lang}): ${resolved} article(s) switched to English`);
  return pages;
}

export async function wikipediaSearch(lat, lon, radiusM, lang = 'en') {
  // ggsradius is hard-capped by the API at 10 km.
  const r = Math.min(Math.max(Math.round(radiusM), 10), WIKI_MAX_RADIUS_M);
  const params = {
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
  if (lang !== 'en') {
    params.prop += '|langlinks';
    params.lllang = 'en';
    params.lllimit = 'max';
  }
  const url = apiUrl(`${lang}.wikipedia.org`, params);
  logEvent(`Wikipedia(${lang}): geosearch started (radius ${r} m)`);
  const pages = await fetchPages(url);
  if (!pages) {
    logEvent(`Wikipedia(${lang}): geosearch failed`, 'warn');
    return [];
  }
  logEvent(`Wikipedia(${lang}): ${pages.length} nearby articles found`);
  const tagged = pages.map((pg) => ({ ...pg, lang }));
  return lang === 'en' ? tagged : anglicize(tagged, lang);
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
