/*
  ELISE — params → search area.

  THE isochrone plug-in point. Callers only ever see the returned shape;
  v1 returns a circle computed from effective speed × time. A later
  version can call an isochrone service (OpenRouteService / Geoapify)
  and return { kind: 'polygon', coords: [...] } instead — Overpass
  accepts (poly:"lat lon lat lon ...") as a drop-in for (around:...),
  so no call site changes. That is also why computeSearchArea is async
  today even though the circle math is sync.
*/

import { SPEEDS, RADIUS_CAP_M, RADIUS_FLOOR_M } from './config.js';

// Sync core, shared by the live UI radius preview and the search itself.
export function radiusForParams(timeMinutes, transport) {
  const speedKmh = SPEEDS[transport] ?? SPEEDS.walking;
  const minutes = Number.isFinite(timeMinutes) && timeMinutes > 0 ? timeMinutes : 60;
  // Halve the reachable distance: you have to get back too.
  const oneWayKm = (speedKmh * (minutes / 60)) / 2;
  const raw = Math.round(oneWayKm * 1000);
  return {
    radiusM: Math.min(RADIUS_CAP_M, Math.max(RADIUS_FLOOR_M, raw)),
    capped: raw > RADIUS_CAP_M,
  };
}

export async function computeSearchArea({ timeMinutes, transport, lat, lon }) {
  const { radiusM } = radiusForParams(timeMinutes, transport);
  return { kind: 'circle', lat, lon, radiusM };
}
