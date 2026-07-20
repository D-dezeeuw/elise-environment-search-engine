/*
  ELISE — budget tiers → OSM categories.

  Each entry drives BOTH sides of the pipeline from one definition:
  - toQl(entry) renders the Overpass union member that fetches it;
  - matches(entry, tags) classifies a returned element back to it.

  `named: true` restricts to features carrying a name tag — it filters
  out anonymous grass patches and backyard pools. Unnamed-but-still-
  interesting features (viewpoints, beaches, artwork) skip the filter
  and fall back to the category label as a display name.

  Classification is first-match-wins in array order, so keep specific
  categories (historic, landmark) above the catch-all `attraction`.
*/

export const CATEGORIES = [
  // ---- free ----
  { id: 'viewpoint', tier: 'free', label: 'Viewpoint', icon: '🌅', boost: 25,
    key: 'tourism', values: ['viewpoint'], named: false },
  { id: 'waterfall', tier: 'free', label: 'Waterfall', icon: '💦', boost: 25,
    key: 'waterway', values: ['waterfall'], named: false },
  { id: 'historic', tier: 'free', label: 'Historic sight', icon: '🏰', boost: 25,
    key: 'historic', values: ['castle', 'monument', 'memorial', 'ruins', 'archaeological_site', 'fort', 'city_gate'], named: true },
  { id: 'landmark', tier: 'free', label: 'Landmark', icon: '🗼', boost: 25,
    key: 'man_made', values: ['lighthouse', 'windmill'], named: true },
  { id: 'park', tier: 'free', label: 'Park & nature', icon: '🌳', boost: 15,
    key: 'leisure', values: ['park', 'garden', 'nature_reserve'], named: true },
  { id: 'beach', tier: 'free', label: 'Beach', icon: '🏖️', boost: 15,
    key: 'natural', values: ['beach'], named: false },
  { id: 'swim', tier: 'free', label: 'Swimming spot', icon: '🏊', boost: 15,
    key: 'leisure', values: ['swimming_area'], named: false },
  { id: 'artwork', tier: 'free', label: 'Street art', icon: '🎨', boost: 15,
    key: 'tourism', values: ['artwork'], named: false },
  { id: 'attraction', tier: 'free', label: 'Attraction', icon: '✨', boost: 5,
    key: 'tourism', values: ['attraction'], named: true },

  // ---- free+ (free to enter, you'll probably spend something) ----
  { id: 'cafe', tier: 'freeplus', label: 'Café', icon: '☕', boost: 5,
    key: 'amenity', values: ['cafe'], named: true },
  { id: 'ice_cream', tier: 'freeplus', label: 'Ice cream', icon: '🍦', boost: 5,
    key: 'amenity', values: ['ice_cream'], named: true },
  { id: 'market', tier: 'freeplus', label: 'Market', icon: '🧺', boost: 15,
    key: 'amenity', values: ['marketplace'], named: true },
  { id: 'bakery', tier: 'freeplus', label: 'Bakery', icon: '🥐', boost: 5,
    key: 'shop', values: ['bakery'], named: true },
  { id: 'pub', tier: 'freeplus', label: 'Pub & bar', icon: '🍺', boost: 5,
    key: 'amenity', values: ['pub', 'bar'], named: true },

  // ---- paid ----
  { id: 'museum', tier: 'paid', label: 'Museum & gallery', icon: '🖼️', boost: 25,
    key: 'tourism', values: ['museum', 'gallery'], named: true },
  { id: 'animals', tier: 'paid', label: 'Zoo & aquarium', icon: '🦁', boost: 25,
    key: 'tourism', values: ['zoo', 'aquarium'], named: true },
  { id: 'theme_park', tier: 'paid', label: 'Theme park', icon: '🎢', boost: 15,
    key: 'tourism', values: ['theme_park'], named: true },
  { id: 'pool', tier: 'paid', label: 'Pool & water park', icon: '💧', boost: 5,
    key: 'leisure', values: ['water_park', 'swimming_pool'], named: true,
    excludes: { access: 'private' } },
  { id: 'entertainment', tier: 'paid', label: 'Entertainment', icon: '🎭', boost: 5,
    key: 'amenity', values: ['cinema', 'theatre', 'planetarium', 'arts_centre'], named: true },
  { id: 'restaurant', tier: 'paid', label: 'Restaurant', icon: '🍽️', boost: 5,
    key: 'amenity', values: ['restaurant'], named: true },
];

export function toQl(c) {
  const sel = c.values.length === 1
    ? `["${c.key}"="${c.values[0]}"]`
    : `["${c.key}"~"^(${c.values.join('|')})$"]`;
  const named = c.named ? '["name"]' : '';
  const excludes = c.excludes
    ? Object.entries(c.excludes).map(([k, v]) => `["${k}"!~"${v}"]`).join('')
    : '';
  return `nwr${sel}${named}${excludes}`;
}

export function matches(c, tags) {
  if (!c.values.includes(tags[c.key])) return false;
  if (c.named && !tags.name) return false;
  if (c.excludes) {
    for (const [k, v] of Object.entries(c.excludes)) {
      if (tags[k] === v) return false;
    }
  }
  return true;
}

export function categorize(tags) {
  for (const c of CATEGORIES) {
    if (matches(c, tags)) return c;
  }
  return null;
}

// Free+ is a superset of Free ("free, plus places where you might spend").
// Paid is deliberately paid-only — pick Open to see everything at once.
export function allowedTiers(budget) {
  if (budget === 'open') return ['free', 'freeplus', 'paid'];
  if (budget === 'freeplus') return ['free', 'freeplus'];
  return [budget];
}

export function fragmentsForTier(tier) {
  const tiers = allowedTiers(tier);
  return CATEGORIES.filter((c) => tiers.includes(c.tier));
}
