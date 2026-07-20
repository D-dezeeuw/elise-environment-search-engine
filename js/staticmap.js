/*
  ELISE — dependency-free overview map.

  Builds a static tile mosaic (standard OSM raster tiles + Web Mercator
  math) with numbered pins for every result, the search-radius circle,
  and the origin. Plain <img>/<div> output rendered via spektrum
  bindings — no map library, and it prints exactly as it looks.
  Tile usage is light (≈a dozen tiles per search) and attributed.
*/

const TILE = 256;
const tileUrl = (z, x, y) => `https://tile.openstreetmap.org/${z}/${x}/${y}.png`;

const lonToWorldX = (lon, z) => ((lon + 180) / 360) * 2 ** z * TILE;
const latToWorldY = (lat, z) => {
  const rad = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * 2 ** z * TILE;
};
const metersPerPixel = (lat, z) => (156543.03392 * Math.cos((lat * Math.PI) / 180)) / 2 ** z;

export function buildMapModel({ lat, lon, radiusM, results, width = 600, height = 300 }) {
  // Largest zoom where the whole search circle fits comfortably.
  let zoom = 17;
  while (zoom > 3 && (2 * radiusM) / metersPerPixel(lat, zoom) > Math.min(width, height) * 0.9) {
    zoom -= 1;
  }

  const cx = lonToWorldX(lon, zoom);
  const cy = latToWorldY(lat, zoom);
  const left = cx - width / 2;
  const top = cy - height / 2;
  const max = 2 ** zoom;

  const tiles = [];
  for (let tx = Math.floor(left / TILE); tx * TILE < left + width; tx += 1) {
    for (let ty = Math.floor(top / TILE); ty * TILE < top + height; ty += 1) {
      if (ty < 0 || ty >= max) continue; // beyond the poles
      const wx = ((tx % max) + max) % max; // wrap around the antimeridian
      tiles.push({
        id: `${zoom}/${tx}/${ty}`,
        src: tileUrl(zoom, wx, ty),
        style: `left:${Math.round(tx * TILE - left)}px;top:${Math.round(ty * TILE - top)}px`,
      });
    }
  }

  const place = (pLat, pLon) => ({
    x: Math.round(lonToWorldX(pLon, zoom) - left),
    y: Math.round(latToWorldY(pLat, zoom) - top),
  });

  const pins = results.map((r) => {
    const { x, y } = place(r.lat, r.lon);
    return { n: r.n, name: r.name, tier: r.tier, style: `left:${x}px;top:${y}px` };
  });

  const o = place(lat, lon);
  const d = Math.round((2 * radiusM) / metersPerPixel(lat, zoom));

  return {
    frameStyle: `width:${width}px;height:${height}px`,
    tiles,
    pins,
    originStyle: `left:${o.x}px;top:${o.y}px`,
    circleStyle: `left:${o.x - d / 2}px;top:${o.y - d / 2}px;width:${d}px;height:${d}px`,
    zoom,
  };
}
