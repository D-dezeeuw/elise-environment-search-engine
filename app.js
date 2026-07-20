/*
  ELISE — Environment Local Interest Search Engine.

  App wiring: spektrum state, registered actions, geolocation flow, and
  the search orchestration. The data pipeline lives in js/ modules.
*/

import spektrum, {
  setValue, defineFn, computed, watch, bindDOM, run, appState,
} from 'spektrum';
import {
  SPEEDS, TRANSPORT_LABELS, TIER_LABELS, TIME_PRESETS, BLANK_IMG, SEARCH_DEADLINE_MS,
} from './js/config.js';
import { radiusForParams, computeSearchArea } from './js/search-area.js';
import { fragmentsForTier } from './js/categories.js';
import { overpassSearch } from './js/overpass.js';
import { wikipediaSearch } from './js/wikipedia.js';
import { reverseGeocode } from './js/geocode.js';
import { mergeAndRank } from './js/results.js';

const PARAMS_KEY = 'elise.params';

const formatDistance = (m) => (m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`);
const formatTime = (mins) => {
  if (mins < 60) return `${mins} min`;
  return mins % 60 === 0 ? `${mins / 60} h` : `${(mins / 60).toFixed(1)} h`;
};

// --- restore persisted params (never coordinates — stale location is
// worse than none) ---
let saved = {};
try { saved = JSON.parse(localStorage.getItem(PARAMS_KEY) || '{}') ?? {}; } catch { saved = {}; }

// Light is the default; dark only when explicitly chosen via the toggle.
setValue('theme', saved.theme === 'dark' ? 'dark' : 'light');
setValue('timeMinutes', TIME_PRESETS.includes(saved.timeMinutes) ? saved.timeMinutes : 60);
setValue('transport', saved.transport in SPEEDS ? saved.transport : 'walking');
setValue('budget', saved.budget in TIER_LABELS ? saved.budget : 'free');

// --- rest of the state ---
setValue('screen', 'params'); // 'params' | 'loading' | 'results'
setValue('lat', null);
setValue('lon', null);
setValue('locationStatus', 'idle'); // 'idle' | 'locating' | 'ready' | 'denied' | 'manual'
setValue('locationLabel', '');
setValue('manualCoords', '');
setValue('results', []);
setValue('resultCount', 0);
setValue('error', '');
setValue('loadingMessage', '');
setValue('blankImg', BLANK_IMG);

computed('radiusPreview', ['timeMinutes', 'transport'], (s) => {
  const { radiusM, capped } = radiusForParams(s.timeMinutes, s.transport);
  return formatDistance(radiusM) + (capped ? ' (capped)' : '');
});

computed('searchSummary', ['budget', 'transport', 'timeMinutes'], (s) => {
  const { radiusM } = radiusForParams(s.timeMinutes, s.transport);
  return `${TIER_LABELS[s.budget]} · ${TRANSPORT_LABELS[s.transport]} · ${formatTime(s.timeMinutes)} · ≈${formatDistance(radiusM)}`;
});

// --- persistence + theme reflection ---
watch(['theme'], () => {
  document.documentElement.dataset.theme = appState.theme;
  document.querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', appState.theme === 'dark' ? '#0d0724' : '#faf3e7');
});
watch(['timeMinutes', 'transport', 'budget', 'theme'], () => {
  try {
    localStorage.setItem(PARAMS_KEY, JSON.stringify({
      timeMinutes: appState.timeMinutes,
      transport: appState.transport,
      budget: appState.budget,
      theme: appState.theme,
    }));
  } catch { /* private mode — params just won't stick */ }
});

// --- search orchestration ---
const ERROR_MESSAGES = {
  busy: 'The places service is busy right now (rate limited). Give it a few seconds and retry.',
  timeout: 'The search timed out — the area may be too big. Try less time, or retry.',
  query: 'This search confused the places service — please report it.',
  network: 'Could not reach the places service — check your connection and retry.',
  unknown: 'Something unexpected went wrong during the search — please retry.',
};

const finishWithError = (kind) => {
  setValue('results', []);
  setValue('resultCount', 0);
  setValue('error', ERROR_MESSAGES[kind] ?? ERROR_MESSAGES.unknown);
  setValue('screen', 'results');
};

const deadline = (ms) => new Promise((_, reject) => {
  setTimeout(() => {
    const err = new Error('search deadline exceeded');
    err.kind = 'timeout';
    reject(err);
  }, ms);
});

// Every exit path of a search lands on a screen with a message — the
// try/catch plus the hard deadline guarantee the spinner can't be the
// final state, no matter what fails or hangs underneath.
const runSearch = async () => {
  const { lat, lon } = appState;
  if (lat == null || lon == null) return;
  setValue('error', '');
  setValue('screen', 'loading');
  try {
    const area = await computeSearchArea({
      timeMinutes: appState.timeMinutes, transport: appState.transport, lat, lon,
    });
    setValue('loadingMessage', `Scanning ≈${formatDistance(area.radiusM)} around ${appState.locationLabel || 'you'}…`);

    const [op, wiki] = await Promise.race([
      Promise.allSettled([
        overpassSearch(fragmentsForTier(appState.budget), area),
        wikipediaSearch(lat, lon, area.radiusM),
      ]),
      deadline(SEARCH_DEADLINE_MS),
    ]);

    if (op.status === 'rejected') {
      console.error('[elise] overpass failed:', op.reason);
      finishWithError(op.reason?.kind);
      return;
    }

    const merged = mergeAndRank(
      op.value,
      wiki.status === 'fulfilled' ? wiki.value : [],
      { lat, lon, radiusM: area.radiusM, transport: appState.transport, budget: appState.budget },
    );
    setValue('results', merged);
    setValue('resultCount', merged.length);
    setValue('screen', 'results');
  } catch (err) {
    console.error('[elise] search failed:', err);
    finishWithError(err?.kind ?? 'unknown');
  }
};

// --- origin handling: locate up front, show the city, search on demand ---
let pendingSearch = false;

// Decorative label refinement — failures pass silently, coords stay valid.
const refineLabel = async (lat, lon) => {
  const city = await reverseGeocode(lat, lon);
  if (city && appState.lat === lat) setValue('locationLabel', city);
};

const applyOrigin = (lat, lon, status, label) => {
  setValue('lat', lat);
  setValue('lon', lon);
  setValue('locationStatus', status);
  setValue('locationLabel', label);
  // Commit the delta synchronously so runSearch reads the fresh origin.
  spektrum.tick();
  refineLabel(lat, lon);
  if (pendingSearch) {
    pendingSearch = false;
    runSearch();
  }
};

const geoFailed = (why) => {
  console.warn('[elise] geolocation unavailable:', why);
  setValue('locationStatus', 'denied');
  if (pendingSearch || appState.screen === 'loading') {
    pendingSearch = false;
    setValue('screen', 'params');
  }
};

const locate = () => {
  if (!('geolocation' in navigator)) {
    geoFailed('no geolocation API');
    return;
  }
  setValue('locationStatus', 'locating');
  navigator.geolocation.getCurrentPosition(
    (pos) => applyOrigin(pos.coords.latitude, pos.coords.longitude, 'ready', 'your area'),
    (err) => geoFailed(err?.message),
    { enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 },
  );
};

// --- registered actions ---
defineFn('setTime', (_el, _state, _delta, value) => setValue('timeMinutes', value));
defineFn('setTransport', (_el, _state, _delta, value) => setValue('transport', value));
defineFn('setBudget', (_el, _state, _delta, value) => setValue('budget', value));
defineFn('toggleTheme', () => setValue('theme', appState.theme === 'dark' ? 'light' : 'dark'));

defineFn('startSearch', () => {
  setValue('error', '');
  // Origin already known (located on load, or chosen) — straight to search.
  if (appState.lat != null) {
    runSearch();
    return;
  }
  // Still resolving, or worth another try — queue the search behind it.
  pendingSearch = true;
  setValue('screen', 'loading');
  setValue('loadingMessage', 'Finding your location…');
  if (appState.locationStatus !== 'locating') locate();
});

defineFn('useManualCoords', () => {
  const m = (appState.manualCoords || '').trim()
    .match(/^(-?\d+(?:\.\d+)?)\s*[,;\s]\s*(-?\d+(?:\.\d+)?)$/);
  const lat = m && Number(m[1]);
  const lon = m && Number(m[2]);
  if (!m || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    setValue('error', 'Enter coordinates like “52.37, 4.89”.');
    return;
  }
  pendingSearch = true;
  applyOrigin(lat, lon, 'manual', 'your point');
});

defineFn('usePresetPlace', (el) => {
  const lat = Number(el.dataset.lat);
  const lon = Number(el.dataset.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
  pendingSearch = true;
  applyOrigin(lat, lon, 'manual', el.dataset.label || 'the city centre');
});

defineFn('retrySearch', () => {
  if (appState.lat != null) runSearch();
});

defineFn('newSearch', () => {
  setValue('error', '');
  setValue('screen', 'params');
});

bindDOM();
run();

// The new flow: locate immediately on load so the params screen can show
// where "around you" actually is before the first search.
locate();
