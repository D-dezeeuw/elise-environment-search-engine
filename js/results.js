/*
  ELISE — result pipeline: normalize → dedupe → enrich → score → present.

  Overpass elements and Wikipedia pages come in raw; presentation-ready
  card objects come out, sorted by a simple interest score and capped.
*/

import {
  MAX_RESULTS, SPEEDS, TRANSPORT_LABELS, GMAPS_MODES, TIER_LABELS,
} from './config.js';
import { categorize, allowedTiers } from './categories.js';

const EARTH_R = 6371000;

export function haversineM(aLat, aLon, bLat, bLon) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLon = toRad(bLon - aLon);
  const s = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.sqrt(s));
}

// "Café Ríjk!" and "cafe rijk" should collide.
const normName = (s) => (s ?? '')
  .toLowerCase()
  .normalize('NFD')
  .replace(/[̀-ͯ]/g, '')
  .replace(/[^\p{L}\p{N}]+/gu, ' ')
  .trim();

export function mergeAndRank(elements, wikiPages, ctx) {
  const { lat, lon, radiusM, transport, budget } = ctx;
  const tiers = allowedTiers(budget);

  // --- normalize Overpass ---
  const places = [];
  for (const el of elements ?? []) {
    const tags = el.tags ?? {};
    const cat = categorize(tags);
    // Unclassifiable or outside the chosen budget — keep the filter honest
    // even if the server returns more than asked.
    if (!cat || !tiers.includes(cat.tier)) continue;
    const pLat = el.lat ?? el.center?.lat;
    const pLon = el.lon ?? el.center?.lon;
    if (pLat == null || pLon == null) continue;
    places.push({
      id: `${el.type}/${el.id}`,
      osmType: el.type,
      name: tags.name || cat.label,
      cat,
      tier: cat.tier,
      lat: pLat,
      lon: pLon,
      distanceM: haversineM(lat, lon, pLat, pLon),
      description: null,
      thumbnail: null,
      wikiUrl: null,
      hasWiki: false,
    });
  }

  // --- dedupe within Overpass (node + way mapping the same feature) ---
  // Nearest-first so the survivor is the closest instance; prefer a
  // way/relation body over a node when merging (its center is truer).
  places.sort((a, b) => a.distanceM - b.distanceM);
  const kept = [];
  for (const p of places) {
    const dup = kept.find((k) => normName(k.name) === normName(p.name)
      && haversineM(k.lat, k.lon, p.lat, p.lon) < 150);
    if (!dup) {
      kept.push(p);
    } else if (dup.osmType === 'node' && p.osmType !== 'node') {
      Object.assign(dup, {
        id: p.id, osmType: p.osmType, lat: p.lat, lon: p.lon, distanceM: p.distanceM,
      });
    }
  }

  // --- normalize Wikipedia ---
  const wikis = (wikiPages ?? []).map((pg) => {
    const c = pg.coordinates?.[0];
    if (!c || pg.pageid == null) return null;
    return {
      pageid: pg.pageid,
      title: pg.title ?? '',
      lat: c.lat,
      lon: c.lon,
      extract: (pg.extract || '').trim() || null,
      thumb: pg.thumbnail?.source ?? null,
      url: `https://en.wikipedia.org/?curid=${pg.pageid}`,
      matched: false,
    };
  }).filter(Boolean);

  // --- enrich Overpass results with Wikipedia matches ---
  for (const w of wikis) {
    const nw = normName(w.title);
    if (!nw) continue;
    const hit = kept.find((p) => {
      if (haversineM(w.lat, w.lon, p.lat, p.lon) >= 300) return false;
      const np = normName(p.name);
      return np && (np.includes(nw) || nw.includes(np));
    });
    if (hit) {
      w.matched = true;
      hit.hasWiki = true;
      hit.description = hit.description ?? w.extract;
      hit.thumbnail = hit.thumbnail ?? w.thumb;
      hit.wikiUrl = w.url;
    }
  }

  // --- unmatched Wikipedia landmarks become their own (free) results ---
  // Only when the budget shows free places; in Paid they'd break the filter.
  if (budget !== 'paid') {
    for (const w of wikis) {
      if (w.matched) continue;
      const d = haversineM(lat, lon, w.lat, w.lon);
      if (d > radiusM) continue;
      kept.push({
        id: `wiki/${w.pageid}`,
        osmType: 'wiki',
        name: w.title,
        cat: { label: 'Landmark', icon: '🏛️', boost: 0 },
        tier: 'free',
        lat: w.lat,
        lon: w.lon,
        distanceM: d,
        description: w.extract,
        thumbnail: w.thumb,
        wikiUrl: w.url,
        hasWiki: true,
      });
    }
  }

  // --- score, sort, cap, present ---
  const speed = SPEEDS[transport] ?? SPEEDS.walking;
  return kept
    .map((p) => ({
      ...p,
      score: (p.hasWiki ? 100 : 0) + (p.cat.boost ?? 0) - (p.distanceM / radiusM) * 50,
    }))
    .sort((a, b) => b.score - a.score || a.distanceM - b.distanceM)
    .slice(0, MAX_RESULTS)
    .map((p) => present(p, transport, speed));
}

function present(p, transport, speedKmh) {
  const km = p.distanceM / 1000;
  const mins = Math.max(1, Math.round((km / speedKmh) * 60));
  const lat = p.lat.toFixed(6);
  const lon = p.lon.toFixed(6);
  return {
    id: p.id,
    name: p.name,
    categoryLabel: p.cat.label,
    icon: p.cat.icon,
    tier: p.tier,
    tierLabel: TIER_LABELS[p.tier] ?? p.tier,
    lat: p.lat,
    lon: p.lon,
    distanceM: Math.round(p.distanceM),
    distanceLabel: p.distanceM < 1000 ? `${Math.round(p.distanceM)} m` : `${km.toFixed(1)} km`,
    travelLabel: `~${mins} min ${TRANSPORT_LABELS[transport] ?? transport}`,
    description: p.description,
    thumbnail: p.thumbnail,
    wikiUrl: p.wikiUrl,
    directionsUrl: `https://www.google.com/maps/dir/?api=1&destination=${lat},${lon}&travelmode=${GMAPS_MODES[transport] ?? 'walking'}`,
    osmUrl: `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=17/${lat}/${lon}`,
  };
}
