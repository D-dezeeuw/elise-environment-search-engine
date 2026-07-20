/*
  ELISE — shared constants.

  Everything tunable lives here: effective speeds per transport mode,
  radius bounds, API endpoints, and presentation caps.
*/

// Effective speeds in km/h. Deliberately conservative: driving is an
// urban/suburban average (not highway), transit includes waiting and
// transfers. Transit is the crudest — a circle is a rough model for a
// network that moves fast along lines and not at all between them; the
// isochrone upgrade (see search-area.js) is the real fix.
export const SPEEDS = {
  walking: 4.5,
  cycling: 15,
  driving: 40,
  transit: 20,
};

export const TRANSPORT_LABELS = {
  walking: 'walk',
  cycling: 'bike',
  driving: 'drive',
  transit: 'transit',
};

// Google Maps directions travelmode per our transport ids.
export const GMAPS_MODES = {
  walking: 'walking',
  cycling: 'bicycling',
  driving: 'driving',
  transit: 'transit',
};

export const TIER_LABELS = {
  free: 'Free',
  freeplus: 'Free+',
  paid: 'Paid',
  open: 'Any budget',
};

// Radius bounds: the cap keeps Overpass queries polite (a 3 h drive would
// otherwise ask for a 60 km circle), the floor keeps a 5-minute stroll
// from returning an empty circle.
export const RADIUS_CAP_M = 30000;
export const RADIUS_FLOOR_M = 250;

export const MAX_RESULTS = 30;

// Planet-wide, CORS-open public instances, tried in order. One user action
// = one request per endpoint per pass (max two passes), no polling, no
// auto-refresh. private.coffee and kumi.systems share an operator but are
// separate deployments; both exist because overpass-api.de rate-limits
// aggressively under load.
export const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];
export const OVERPASS_TIMEOUT_S = 15; // server-side
export const CLIENT_TIMEOUT_MS = 18000; // abort a hung connection just after
export const OVERPASS_RETRY_DELAY_MS = 2000; // second pass, after limits clear

export const WIKI_TIMEOUT_MS = 8000;
export const GEOCODE_TIMEOUT_MS = 6000;

// Absolute ceiling for one search: whatever is still pending gets cut off
// and the user sees a message instead of an eternal spinner.
export const SEARCH_DEADLINE_MS = 35000;

export const WIKI_ENDPOINT = 'https://en.wikipedia.org/w/api.php';
export const WIKI_MAX_RADIUS_M = 10000; // hard API limit on ggsradius

export const TIME_PRESETS = [15, 30, 60, 120, 180];

// 1×1 transparent GIF — img src fallback so hidden thumbnails never hit
// the network.
export const BLANK_IMG =
  'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==';
