// Links between this city and Garita (https://webgpu-demos.github.io/garita/), the island-wide twin it is the street
// view of. Garita opens a place here with ?ll=lat,lon (and its scenario's ?sea=, and ?bld=<GERS id> for the building
// it had selected); a building clicked here opens in Garita with ?pick=lon,lat and, where the compiler had it from
// Garita, ?bld=<GERS id>: both twins name a building by its Overture GERS id, the point is the fallback. Plain
// functions: the client and the tests.

export const GARITA = 'https://webgpu-demos.github.io/garita/';

const num = (v) => (v == null || v === '' ? NaN : Number(v));
const round = (v, d) => Number(v.toFixed(d));

// ?ll=lat,lon[,distance,azimuth,elevation] -> { lat, lon, view? } or null. Latitude first, as people write a place.
export function parseLatLon(s) {
  if (!s) return null;
  const v = String(s).split(',').map(num);
  const [lat, lon] = v;
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  const view = v.length >= 5 && v.slice(2, 5).every(Number.isFinite) ? v.slice(2, 5) : null;
  return { lat, lon, view };
}

// ?sea=<metres above mean sea level> -> number, or null when absent, not a number, or not above the present sea.
export function parseSeaLevel(s, present = 0) {
  const v = num(s);
  return Number.isFinite(v) && v > present + 0.005 && v < 100 ? v : null;
}

// ?bld=<GERS id> -> the id (lower case), or null when it is not one (a UUID; Garita reads it the same way).
export function parseGers(s) {
  const v = String(s ?? '').trim().toLowerCase();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v) ? v : null;
}

// Garita, looking down on (lon, lat) with the building there selected (by its GERS id when known); the sea level goes
// along when raised.
export function garitaLink(lon, lat, { sea = null, lang = 'es', range = 650, gers = null } = {}) {
  const u = new URL(GARITA);
  u.searchParams.set('pick', `${round(lon, 6)},${round(lat, 6)}`);
  if (parseGers(gers)) u.searchParams.set('bld', parseGers(gers));
  u.searchParams.set('cam', `${round(lon, 6)},${round(lat, 6)},${range},0,55`);
  if (sea != null) u.searchParams.set('sea', String(round(sea, 2)));
  if (lang) u.searchParams.set('lang', lang);
  return u.href.replace(/%2C/g, ',');
}
