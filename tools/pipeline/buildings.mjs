// Buildings from OpenStreetMap, with the heights and uses it lacks taken from FEMA's USA Structures.
//
// OSM has the better outlines (row houses one by one, where FEMA's LiDAR-derived outlines often merge a
// whole block) and often the number of floors; USA Structures has a measured height and an occupancy class
// for almost every building. Per OSM building, the height is, in order of preference:
//   1. OSM height
//   2. OSM building:levels times a floor height, the floor height taken from the FEMA building around it
//      (clamped: one FEMA outline may cover several OSM buildings of different heights)
//   3. the FEMA height
//   4. a default for the kind of building
// FEMA buildings that no OSM building overlaps are added as they are.
//
// Uses are written as PLATEAU usage codes, which the client's facade styles are keyed by:
//   401 office  402 commercial  403 hotel  411 house  412 apartments  413 house + shop  414 apartments + shop
//   421 government  422 school / hospital / culture / church  431 transport / warehouse  441 factory
//   452 utility  454 other  461 unknown
import fs from 'node:fs';
import { PolyIndex, inRings, hash } from './landscape.mjs';

const num = (v) => {
  if (v == null) return null;
  const n = Number.parseFloat(String(v).replace(',', '.'));
  if (!Number.isFinite(n)) return null;
  return /'|ft|feet/.test(String(v)) ? n * 0.3048 : n;
};

const HOUSE = new Set(['house', 'detached', 'semidetached_house', 'terrace', 'bungalow', 'residential', 'farm', 'cabin', 'static_caravan', 'hut']);
const SMALL = new Set(['garage', 'garages', 'shed', 'hut', 'kiosk', 'carport', 'toilets', 'service', 'container', 'cabin', 'transformer_tower']);
const CIVIC = new Set(['public', 'civic', 'government', 'townhall', 'courthouse', 'fire_station', 'police', 'military', 'barracks', 'castle', 'fort']);
const CULTURE = new Set(['school', 'university', 'college', 'kindergarten', 'hospital', 'church', 'cathedral', 'chapel', 'religious', 'museum', 'library', 'theatre', 'stadium', 'sports_hall', 'sports_centre', 'grandstand', 'pavilion', 'temple', 'synagogue', 'mosque', 'monastery', 'convent']);
const WORK = new Set(['industrial', 'warehouse', 'factory', 'manufacture', 'hangar', 'storage_tank']);
const TRANSPORT = new Set(['train_station', 'transportation', 'parking', 'garages', 'garage', 'carport', 'bus_station']);

// OSM building tags (plus FEMA's occupancy, and whether it stands in the historic district) -> usage code
function usageOf(t, fema, heritage) {
  const b = t.building ?? t['building:part'] ?? 'yes';
  if (/^(church|cathedral|chapel|religious|temple|basilica|convent|monastery)$/.test(b) || t.amenity === 'place_of_worship') return 422;
  if (b === 'hotel' || t.tourism === 'hotel') return 403;
  if (b === 'apartments' || b === 'dormitory') return heritage ? 414 : 412;
  if (HOUSE.has(b)) return heritage ? 413 : 411;
  if (b === 'office') return 401;
  if (b === 'commercial' || b === 'retail' || b === 'supermarket' || b === 'mall' || b === 'kiosk') return heritage ? 414 : 402;
  if (CIVIC.has(b) || /^(townhall|courthouse|fire_station|police)$/.test(t.amenity ?? '')) return 421;
  if (CULTURE.has(b) || /^(school|university|college|hospital|library|museum|theatre)$/.test(t.amenity ?? '')) return 422;
  if (TRANSPORT.has(b)) return 431;
  if (WORK.has(b)) return 441;
  if (b === 'construction' || b === 'ruins') return 461;
  // building=yes: FEMA's occupancy class, if it has the building
  const occ = fema?.occ ?? '', prim = fema?.prim ?? '';
  // (in the old city FEMA files whole blocks of row houses as government or commercial: they are shops below, homes above)
  if (heritage) return /Education/.test(occ) && fema?.area < 4000 ? 422 : 414;
  if (/Residential/.test(occ)) return /Single/.test(prim) ? 411 : /Multi/.test(prim) ? 412 : 411;
  if (/Commercial/.test(occ)) return /Hotel|Lodging/i.test(prim) ? 403 : /Professional|Bank|Office|Technical/i.test(prim) ? 401 : 402;
  if (/Government/.test(occ)) return 421;
  if (/Education|Assembly/.test(occ)) return 422;
  if (/Industrial/.test(occ)) return 441;
  if (/Utility/.test(occ)) return 452;
  if (/Agriculture/.test(occ)) return 454;
  return 461;
}

// Weathered sandstone and the ochre wash of the Spanish forts (sRGB)
const STONE = [0xc8b48c, 0xbfa77f, 0xd2c09a, 0xb59c78];

// Floor height by use (m); colonial buildings have tall rooms
const floorHeight = (usage, heritage) => (heritage ? 4.3 : usage === 411 || usage === 412 || usage === 413 ? 3.1 : usage === 401 || usage === 403 ? 3.6 : 3.8);

// A height for a building nothing is known about, by kind, in floors (or metres where given)
function defaultHeight(t, usage, heritage, seed) {
  const b = t.building ?? 'yes';
  if (SMALL.has(b)) return 3;
  if (/church|cathedral|basilica/.test(b)) return 16;
  if (WORK.has(b)) return 8;
  if (b === 'construction') return 6;
  if (b === 'ruins') return 4;
  const floors = heritage ? 2 + (seed < 0.35 ? 1 : 0) : usage === 412 ? 4 : usage === 411 ? (seed < 0.6 ? 1 : 2) : usage === 461 ? (seed < 0.5 ? 1 : 2) : 2;
  return floors * floorHeight(usage, heritage) + 0.6;
}

// Joins member ways (arrays of node ids) into closed rings.
function stitch(ways) {
  const rings = [], pool = ways.map((w) => [...w]);
  while (pool.length) {
    let ring = pool.pop();
    for (let grew = true; grew && ring[0] !== ring.at(-1);) {
      grew = false;
      for (let i = 0; i < pool.length; i++) {
        const w = pool[i];
        if (w[0] === ring.at(-1)) ring = ring.concat(w.slice(1));
        else if (w.at(-1) === ring.at(-1)) ring = ring.concat(w.slice(0, -1).reverse());
        else if (w.at(-1) === ring[0]) ring = w.slice(0, -1).concat(ring);
        else if (w[0] === ring[0]) ring = [...w].reverse().slice(0, -1).concat(ring);
        else continue;
        pool.splice(i, 1); grew = true; break;
      }
    }
    if (ring.length >= 4 && ring[0] === ring.at(-1)) rings.push(ring);
  }
  return rings;
}

const ringAreaLL = (r, proj) => {
  let s = 0;
  const p = r.map(([lon, lat]) => proj.project(lon, lat));
  for (let i = 0; i < p.length; i++) { const [x1, z1] = p[i], [x2, z2] = p[(i + 1) % p.length]; s += x2 * z1 - x1 * z2; }
  return Math.abs(s / 2);
};
const centroidLL = (r) => [r.reduce((s, p) => s + p[0], 0) / r.length, r.reduce((s, p) => s + p[1], 0) / r.length];

// OSM buildings: [{ id, tags, polygons: [[outer, ...holes]] (lon/lat rings), part }]
function readOsmBuildings(file) {
  const { elements } = JSON.parse(fs.readFileSync(file, 'utf8'));
  const nodes = new Map(), ways = new Map(), out = [], inRelation = new Set();
  for (const e of elements) { if (e.type === 'node') nodes.set(e.id, [e.lon, e.lat]); else if (e.type === 'way') ways.set(e.id, e); }
  const ll = (ids) => ids.map((id) => nodes.get(id)).filter(Boolean);
  for (const e of elements) {
    if (e.type !== 'relation' || !e.tags?.building) continue;
    const members = (role) => e.members.filter((m) => m.type === 'way' && (role === 'inner' ? m.role === 'inner' : m.role !== 'inner') && ways.has(m.ref)).map((m) => ways.get(m.ref).nodes);
    e.members.forEach((m) => { if (m.type === 'way') inRelation.add(m.ref); });
    const outers = stitch(members('outer')).map(ll), inners = stitch(members('inner')).map(ll);
    const polygons = outers.map((o) => [o, ...inners.filter((h) => inRings(...centroidLL(h), [o]))]);
    if (polygons.length) out.push({ id: `r${e.id}`, tags: e.tags, polygons, part: false });
  }
  for (const w of ways.values()) {
    const t = w.tags ?? {};
    if (!t.building && !t['building:part']) continue;
    if (t.building === 'roof' || t.building === 'no' || t['building:part'] === 'roof') continue; // canopies: tools/pipeline/extras.mjs
    if (inRelation.has(w.id) && !t.building && !t['building:part']) continue;
    if (w.nodes.length < 4 || w.nodes[0] !== w.nodes.at(-1)) continue;
    out.push({ id: `w${w.id}`, tags: t, polygons: [[ll(w.nodes)]], part: !t.building && !!t['building:part'] });
  }
  return out;
}

// FEMA USA Structures: [{ rings: [[x, z]] (world), area, height, occ, prim }]
function readFema(file, proj) {
  if (!fs.existsSync(file)) return [];
  const { features } = JSON.parse(fs.readFileSync(file, 'utf8'));
  const out = [];
  for (const f of features) {
    const g = f.geometry;
    if (!g) continue;
    const polys = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
    const p = f.properties ?? {};
    for (const poly of polys) {
      const rings = poly.map((r) => r.map(([lon, lat]) => proj.project(lon, lat)));
      out.push({ ll: poly, rings, area: ringAreaLL(poly[0], proj), height: p.HEIGHT > 1.5 ? p.HEIGHT : null, occ: p.OCC_CLS ?? '', prim: p.PRIM_OCC ?? '' });
    }
  }
  return out;
}

// Returns { buildings: [{ id, polygons (lon/lat), usage, storeys, height, measured, hint }], stats }.
// proj: makeProjection(); heritage: [[lon, lat], ...] or null.
export function readBuildingSources({ osmFile, femaFile, proj, heritage, colonial }) {
  const osm = readOsmBuildings(osmFile), fema = readFema(femaFile, proj);
  const femaIndex = new PolyIndex(32);
  fema.forEach((f, i) => { f.i = i; f.rings.fema = f; femaIndex.add(f.rings); });
  const femaAt = (x, z) => {
    let best = null;
    const items = femaIndex.grid.get(Math.floor(x / 32) + ',' + Math.floor(z / 32)) ?? [];
    for (const it of items) if (x >= it.x0 && x <= it.x1 && z >= it.z0 && z <= it.z1 && inRings(x, z, it.rings)) {
      const f = it.rings.fema;
      if (!best || f.area < best.area) best = f;
    }
    return best;
  };
  const heritageRing = heritage ? [heritage.map(([lon, lat]) => proj.project(lon, lat))] : null;
  const stats = { osm: osm.length, parts: 0, outlinesWithParts: 0, fromHeight: 0, fromLevels: 0, fromFema: 0, fromDefault: 0, femaOnly: 0, femaTotal: fema.length };

  // building:part pieces replace the outline they stand in
  const parts = osm.filter((b) => b.part), whole = osm.filter((b) => !b.part);
  const usedFema = new Set();
  const out = [];
  const add = (b, isPart) => {
    const t = b.tags, outer = b.polygons[0][0];
    const [cx, cz] = proj.project(...centroidLL(outer));
    const f = femaAt(cx, cz);
    if (f) usedFema.add(f.i);
    const inHeritage = !!heritageRing && inRings(cx, cz, heritageRing);
    const usage = usageOf(t, f, inHeritage);
    const seed = hash(Math.round(cx * 10), Math.round(cz * 10), 17);
    const levels = num(t['building:levels']), roofLevels = num(t['roof:levels']) ?? 0, tagged = num(t.height);
    const fh = floorHeight(usage, inHeritage);
    let height, measured = false, source;
    if (tagged > 0) { height = tagged; measured = true; source = 'fromHeight'; }
    else if (levels > 0) {
      const k = f?.height ? Math.min(4.8, Math.max(2.9, f.height / (levels + roofLevels * 0.5))) : fh;
      height = (levels + roofLevels * 0.5) * k + (f?.height ? 0 : 0.6); source = 'fromLevels';
    } else if (f?.height) { height = f.height; measured = true; source = 'fromFema'; }
    else { height = defaultHeight(t, usage, inHeritage, seed); source = 'fromDefault'; }
    stats[source]++;
    let minHeight = num(t.min_height) ?? (num(t['building:min_level']) != null ? num(t['building:min_level']) * fh : 0);
    if (!isPart) minHeight = 0;
    if (minHeight >= height) minHeight = 0;
    const storeys = levels > 0 ? Math.round(levels) : Math.max(1, Math.round(height / fh));
    // the colonial city: painted plaster in its own colours (a mapped colour wins, see compile.mjs)
    let hint = 0;
    if (inHeritage && colonial?.length && ![421, 422, 431, 441, 452].includes(usage)) {
      const c = colonial[Math.floor(hash(Math.round(cx * 7), Math.round(cz * 7), 23) * colonial.length)];
      hint = (0x80000000 | c | (3 << 24)) >>> 0; // painted, plaster
    }
    // fortifications: the stonework of El Morro, San Cristóbal and their bastions
    const masonry = /^(castle|fort|fortress|bunker)$/.test(t.building) || /^(castle|fort|citywalls|fortress)$/.test(t.historic ?? '') || t.castle_type === 'fortress';
    if (masonry) hint = (0x80000000 | STONE[Math.floor(seed * STONE.length)] | (3 << 24)) >>> 0;
    out.push({ id: b.id, polygons: b.polygons, usage: masonry ? 454 : usage, storeys: masonry ? 0 : storeys, height: height - minHeight, minHeight, measured, hint, heritage: inHeritage, masonry });
  };
  for (const b of whole) {
    const ring = b.polygons[0][0].map(([lon, lat]) => proj.project(lon, lat));
    // parts whose middle lies inside this outline stand for it
    const mine = parts.filter((p) => { if (p.used) return false; const [x, z] = proj.project(...centroidLL(p.polygons[0][0])); return inRings(x, z, [ring]); });
    if (mine.length) { stats.outlinesWithParts++; for (const p of mine) { p.used = true; add(p, true); stats.parts++; } continue; }
    add(b, false);
  }
  for (const p of parts) if (!p.used) add(p, true); // a part without an outline around it

  // FEMA buildings that OSM does not have: no OSM building in or over them
  const osmIndex = new PolyIndex(32);
  for (const b of out) osmIndex.add([b.polygons[0][0].map(([lon, lat]) => proj.project(lon, lat))]);
  for (const f of fema) {
    if (usedFema.has(f.i) || !f.height || f.area < 12) continue;
    const ring = f.rings[0], [cx, cz] = [ring.reduce((s, p) => s + p[0], 0) / ring.length, ring.reduce((s, p) => s + p[1], 0) / ring.length];
    if (osmIndex.has(cx, cz) || ring.some(([x, z]) => osmIndex.has(x, z))) continue;
    const inHeritage = !!heritageRing && inRings(cx, cz, heritageRing);
    const usage = usageOf({ building: 'yes' }, f, inHeritage);
    out.push({ id: `f${f.i}`, polygons: [f.ll], usage, storeys: Math.max(1, Math.round(f.height / floorHeight(usage, inHeritage))), height: f.height, minHeight: 0, measured: true, hint: 0, heritage: inHeritage });
    stats.femaOnly++;
  }
  return { buildings: out, stats };
}
