# ELISE 🌴

**E**nvironment · **L**ocal **I**nterest · **S**earch **E**ngine

Tell ELISE how much time, transport and budget you have — it finds parks, sights,
swims and coffee around you. Built for a quick bored moment, a holiday stop, or a
small road-trip.

## How it works

Three questions, all optional (defaults: **1 hour · walking · free**):

| Question | Options |
| --- | --- |
| How much time do you have? | 15 min · 30 min · 1 h · 2 h · 3 h |
| How are you getting around? | Walk · Bike · Drive · Transit |
| What's your budget? | **Free** (parks, views, beaches, sights) · **Free+** (free things, plus free-to-enter places that tempt you to spend, like a café) · **Paid** (museums, pools, shows) · **Open** (no budget filter) |

Time × transport becomes a search radius (halved for the round trip, capped at
30 km). ELISE then asks two keyless open APIs around your geolocation:

- **[Overpass API](https://wiki.openstreetmap.org/wiki/Overpass_API)** (OpenStreetMap)
  for places by category — one bounding-box query (the index fast path; the exact
  circle is filtered client-side) against overpass-api.de, then the private.coffee
  and kumi.systems mirrors, with one delayed retry pass before giving up
- **[Wikipedia GeoSearch](https://www.mediawiki.org/wiki/API:Geosearch)** for landmark
  descriptions and photos, used to enrich and rank results

Results are deduped, scored (Wikipedia-known first, interesting categories boosted,
nearby preferred) and rendered as cards with distance, travel time and a directions
link. If geolocation is unavailable you can start from typed coordinates or a preset
city centre.

Two themes, toggle in the header: pastel beach ☀️ and neon night 🌙.

## Running it

It's a static app — no build, no npm install, no API keys:

```sh
python3 -m http.server 8000   # from the repo root
# → http://localhost:8000/
```

The only dependency, the [spektrum](https://github.com/D-dezeeuw/spektrum) reactive
engine, loads from unpkg via an importmap.

### Deploying to GitHub Pages

Settings → Pages → *Deploy from a branch* → your branch, folder `/ (root)`.
All asset paths are relative, so it works from the project subpath as-is.

## Architecture

```
index.html          all screens, spektrum bindings, importmap
styles.css          both themes via CSS custom properties on [data-theme]
app.js              state, actions, geolocation flow, orchestration
js/config.js        speeds, caps, endpoints
js/search-area.js   params → area (the isochrone plug-in point)
js/categories.js    budget tier → OSM tags, one definition drives query + classify
js/overpass.js      query builder + fetch with mirror fallback
js/wikipedia.js     geosearch fetch (non-fatal on failure)
js/results.js       normalize → dedupe → enrich → score → present
```

Last-used params (and theme) persist in localStorage; coordinates never do.

## Ideas for later

- **Real isochrones** (OpenRouteService/Geoapify) instead of a circle — swap the body
  of `computeSearchArea()`; Overpass accepts `(poly:...)` as a drop-in for `(around:...)`.
  Matters most for transit, where a circle is crudest.
- **Map view** — Leaflet via CDN; results already carry coordinates.
- **"Open now" filter** — parse the `opening_hours` tag that Overpass already returns.

## Credits

Place data © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors,
via the Overpass API. Landmark texts and images from [Wikipedia](https://en.wikipedia.org).
UI powered by [spektrum](https://github.com/D-dezeeuw/spektrum).
