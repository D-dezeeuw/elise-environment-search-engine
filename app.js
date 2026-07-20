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
import { queryGroupsForTier } from './js/categories.js';
import { overpassSearch } from './js/overpass.js';
import { wikipediaSearch } from './js/wikipedia.js';
import { reverseGeocode } from './js/geocode.js';
import { mergeAndRank } from './js/results.js';
import { buildMapModel } from './js/staticmap.js';
import { logEvent, onLog } from './js/log.js';

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
setValue('toasts', []);
setValue('logs', []);
setValue('logOpen', false);
// Map state stays flat — data-each paths reference top-level keys only.
setValue('mapTiles', []);
setValue('mapPins', []);
setValue('mapFrameStyle', '');
setValue('mapOriginStyle', '');
setValue('mapCircleStyle', '');

// --- toasts + activity log ---
let toastSeq = 0;
const toast = (text) => {
  const id = ++toastSeq;
  setValue('toasts', [...(appState.toasts ?? []), { id, text }]);
  setTimeout(() => {
    setValue('toasts', (appState.toasts ?? []).filter((t) => t.id !== id));
  }, 2600);
};

onLog((entries) => setValue('logs', entries));

// Newest first in the modal.
computed('logsView', ['logs'], (s) => [...(s.logs ?? [])].reverse());
computed('logHasWarn', ['logs'], (s) => (s.logs ?? []).some((l) => l.level !== 'info'));

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
  setValue('mapTiles', []);
  setValue('mapPins', []);
  setValue('error', ERROR_MESSAGES[kind] ?? ERROR_MESSAGES.unknown);
  setValue('screen', 'results');
};


// Every exit path of a search lands on a screen with a message — the
// try/catch plus the hard deadline guarantee the spinner can't be the
// final state, no matter what fails or hangs underneath.
const runSearch = async () => {
  const { lat, lon } = appState;
  if (lat == null || lon == null) return;
  setValue('error', '');
  setValue('screen', 'loading');
  // The deadline aborts the in-flight Overpass work too — no zombie
  // fetches piling onto rate limits after the user already saw an error.
  const ctrl = new AbortController();
  let deadlineTimer = null;
  const deadlinePromise = new Promise((_, reject) => {
    deadlineTimer = setTimeout(() => {
      ctrl.abort();
      const err = new Error('search deadline exceeded');
      err.kind = 'timeout';
      reject(err);
    }, SEARCH_DEADLINE_MS);
  });
  deadlinePromise.catch(() => {}); // settled race leaves this rejection orphaned
  try {
    const area = await computeSearchArea({
      timeMinutes: appState.timeMinutes, transport: appState.transport, lat, lon,
    });
    logEvent(`Search: started (${appState.searchSummary})`);
    setValue('loadingMessage', `Scanning ≈${formatDistance(area.radiusM)} around ${appState.locationLabel || 'you'}…`);

    const [op, wiki] = await Promise.race([
      Promise.allSettled([
        overpassSearch(queryGroupsForTier(appState.budget), area, ctrl.signal),
        wikipediaSearch(lat, lon, area.radiusM),
      ]),
      deadlinePromise,
    ]);

    if (op.status === 'rejected') {
      console.error('[elise] overpass failed:', op.reason);
      logEvent(`Search: failed (${op.reason?.kind ?? 'unknown'})`, 'error');
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
    const mapW = Math.min(600, Math.max(280, Math.round((window.innerWidth || 600) - 40)));
    const model = merged.length
      ? buildMapModel({ lat, lon, radiusM: area.radiusM, results: merged, width: mapW, height: 300 })
      : null;
    setValue('mapTiles', model?.tiles ?? []);
    setValue('mapPins', model?.pins ?? []);
    setValue('mapFrameStyle', model?.frameStyle ?? '');
    setValue('mapOriginStyle', model?.originStyle ?? '');
    setValue('mapCircleStyle', model?.circleStyle ?? '');
    setValue('screen', 'results');
    logEvent(`Search: finished — ${merged.length} places shown`);
    if (merged.length) toast(`✨ ${merged.length} places loaded`);
  } catch (err) {
    console.error('[elise] search failed:', err);
    logEvent(`Search: failed (${err?.kind ?? 'unexpected error'})`, 'error');
    finishWithError(err?.kind ?? 'unknown');
  } finally {
    clearTimeout(deadlineTimer);
  }
};

// --- origin handling: locate up front, show the city, search on demand ---
let pendingSearch = false;

// Decorative label refinement — failures pass silently, coords stay valid.
const refineLabel = async (lat, lon) => {
  const city = await reverseGeocode(lat, lon);
  if (city && appState.lat === lat) {
    const isNew = appState.locationLabel !== city;
    setValue('locationLabel', city);
    if (isNew) toast(`📍 ${city}`);
  }
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
  logEvent(`Location: unavailable (${why ?? 'unknown'})`, 'warn');
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
  logEvent('Location: requesting position started');
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      logEvent(`Location: fix at ${pos.coords.latitude.toFixed(4)}, ${pos.coords.longitude.toFixed(4)}`);
      applyOrigin(pos.coords.latitude, pos.coords.longitude, 'ready', 'your area');
    },
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

defineFn('toggleLog', () => setValue('logOpen', !appState.logOpen));

// The print dialog is every phone's native "Save as PDF" — the print
// stylesheet turns the results into a clean document.
defineFn('savePdf', () => {
  logEvent('Export: print/PDF dialog opened');
  window.print();
});

bindDOM();
run();

logEvent('App: booted');

// The new flow: locate immediately on load so the params screen can show
// where "around you" actually is before the first search.
locate();
