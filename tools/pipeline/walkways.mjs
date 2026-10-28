// Where people walk (src/world/people.js): the sidewalks of the streets as the tiles draw them, the corners where
// they meet, the crossings at the junctions (the zebra where OSM maps one), OSM's footways, paths, steps and
// pedestrian streets, and the places people stop: bus stops, benches, shop fronts, plazas. With each stretch, how
// many walk it at the busiest hour of each kind of day it has (shops, offices, sights, bars, schools, buses, homes,
// clinics, the beach and the parks), from what stands along it: OSM's shops, cafés, offices and stops, the floor
// area of the buildings by their use (the tiles' FEMA usage), the beach, the historic district.
//
// The counts are an estimate, scaled to a few places (calibrate() below): people per 100 m of sidewalk at the
// busiest hour, about 25 on Calle Fortaleza in Old San Juan, 10 on Ashford in the Condado, 5 on the Milla de Oro, a
// handful on a residential street of an urbanización. Not a count of anyone.
//
// Writes walks.bin next to roads.json (format: readWalks in src/world/people.js).
// Usage: node tools/pipeline/walkways.mjs [--area=sanjuan]
import fs from 'node:fs';
import path from 'node:path';
import { decodeTile, AREA, PROP } from '../../src/shared/tileformat.js';
import { pavedHalf, roadLanes } from '../../src/shared/roadway.js';
import { makeProjection } from '../../src/shared/geo.js';
import { PolyIndex, inRings } from './landscape.mjs';
import { resolveArea } from './config.mjs';

const area = resolveArea();
const dir = area.outDir, raw = area.rawDir;
const log = (...a) => console.log(`[walkways ${area.id}]`, ...a);
const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json')));
const roads = JSON.parse(fs.readFileSync(path.join(dir, manifest.roads ?? 'roads.json')));
const proj = makeProjection(manifest.origin.lon, manifest.origin.lat);
const xz = ([lon, lat]) => proj.project(lon, lat);
// (Condado and Hato Rey were fetched on their own, without these: they lie inside the municipality's extract)
const readOsm = (f) => { for (const d of [raw, path.join(raw, '..', 'sanjuan')]) { const p = path.join(d, f); if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8')).elements; } return []; };

// ---------------------------------------------------------------- the profiles: what brings people out, and when
export const PROFILE = { SHOP: 0, OFFICE: 1, SIGHTS: 2, NIGHT: 3, SCHOOL: 4, TRANSIT: 5, HOME: 6, HEALTH: 7, LEISURE: 8 };
const NP = 9;
export const KIND = { SIDEWALK: 0, CORNER: 1, CROSSING: 2, FOOTWAY: 3, PATH: 4, STEPS: 5, PEDESTRIAN: 6, ROADSIDE: 7, LINK: 8, MEDIAN: 9 };
export const SPOT = { BUS: 0, BENCH: 1, FRONT: 2, BAR: 3, PLAZA: 4, SHELTER: 5 };

// ---------------------------------------------------------------- the tiles: surfaces, buildings, furniture
const idx = { carriageway: new PolyIndex(16), sidewalk: new PolyIndex(16), plaza: new PolyIndex(24), beach: new PolyIndex(32), building: new PolyIndex(24) };
const ext = manifest.extent ?? manifest.bounds;
const GRID = 20, gx0 = ext.minX, gz0 = ext.minZ, GW = Math.ceil((ext.maxX - ext.minX) / GRID) + 1, GH = Math.ceil((ext.maxZ - ext.minZ) / GRID) + 1;
const grids = Array.from({ length: NP }, () => new Float32Array(GW * GH));
const deposit = (p, x, z, v) => {
  const i = Math.floor((x - gx0) / GRID), j = Math.floor((z - gz0) / GRID);
  if (i >= 0 && j >= 0 && i < GW && j < GH) grids[p][j * GW + i] += v;
};
// floor area (m2) by use -> the profiles it feeds, with their share
const USE = {
  401: [[PROFILE.OFFICE, 1]], 402: [[PROFILE.SHOP, 1]], 403: [[PROFILE.SIGHTS, 0.6], [PROFILE.NIGHT, 0.2]], 404: [[PROFILE.SHOP, 1]],
  411: [[PROFILE.HOME, 1]], 412: [[PROFILE.HOME, 1]], 413: [[PROFILE.HOME, 0.7], [PROFILE.SHOP, 0.3]], 414: [[PROFILE.SHOP, 0.5], [PROFILE.HOME, 0.5]],
  415: [[PROFILE.HOME, 0.8]], 421: [[PROFILE.OFFICE, 1]], 422: [[PROFILE.SCHOOL, 0.5], [PROFILE.HEALTH, 0.5]], 441: [[PROFILE.OFFICE, 0.15]],
  454: [[PROFILE.SIGHTS, 0.5]], 461: [[PROFILE.HOME, 0.3]],
};
const ringArea = (r) => { let a = 0; for (let i = 0, j = r.length / 2 - 1; i < r.length / 2; j = i++) a += r[j * 2] * r[i * 2 + 1] - r[i * 2] * r[j * 2 + 1]; return a / 2; };
const ringPts = (r) => Array.from({ length: r.length / 2 }, (_, i) => [r[i * 2], r[i * 2 + 1]]);
const props = [];
let tiles = 0;
for (const t of manifest.tiles) {
  const buf = fs.readFileSync(path.join(dir, t.file));
  const tile = decodeTile(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  for (const a of tile.areas) {
    const target = a.kind === AREA.CARRIAGEWAY ? idx.carriageway : a.kind === AREA.SIDEWALK ? idx.sidewalk : a.kind === AREA.PLAZA ? idx.plaza : a.kind === AREA.BEACH ? idx.beach : null;
    if (!target) continue;
    for (const rings of a.polygons) {
      target.add(rings.map(ringPts));
    }
  }
  for (const b of tile.buildings) {
    const ring = b.polygons[0]?.[0];
    if (!ring) continue;
    const fp = Math.abs(ringArea(ring)), floors = b.storeys || Math.max(1, Math.round(b.height / 3.2));
    let cx = 0, cz = 0; for (let k = 0; k < ring.length; k += 2) { cx += ring[k]; cz += ring[k + 1]; }
    cx /= ring.length / 2; cz /= ring.length / 2;
    // (an unknown use in a tower is offices: FEMA files the Milla de Oro's as unclassified)
    const use = b.usage === 461 && floors >= 5 ? [[PROFILE.OFFICE, 0.8]] : USE[b.usage] ?? [];
    for (const [p, s] of use) deposit(p, cx, cz, fp * Math.min(floors, 12) * s);
    idx.building.add(b.polygons[0].map(ringPts));
  }
  for (const p of tile.props) if (p.kind === PROP.BUS_STOP || p.kind === PROP.BENCH) props.push(p);
  tiles++;
}
log(`${tiles} tiles; ${props.length} bus stops and benches`);
// the beach: leisure over the sand (and along it: the promenade, the street behind)
for (let j = 0; j < GH; j++) for (let i = 0; i < GW; i++) {
  const x = gx0 + (i + 0.5) * GRID, z = gz0 + (j + 0.5) * GRID;
  if (idx.beach.has(x, z)) deposit(PROFILE.LEISURE, x, z, 400);
}

// ---------------------------------------------------------------- OSM: what is along the streets
const poiProfile = (t) => {
  const out = [];
  if (t.shop) out.push([PROFILE.SHOP, ['supermarket', 'mall', 'department_store'].includes(t.shop) ? 4 : 1]);
  if (['restaurant', 'fast_food', 'cafe', 'ice_cream', 'food_court', 'bakery'].includes(t.amenity)) out.push([PROFILE.SHOP, 1.2], [PROFILE.OFFICE, 0.3]);
  if (['bar', 'pub', 'nightclub', 'biergarten'].includes(t.amenity)) out.push([PROFILE.NIGHT, 2]);
  if (t.office || ['bank', 'post_office', 'townhall', 'courthouse', 'public_building', 'money_transfer'].includes(t.amenity)) out.push([PROFILE.OFFICE, 1]);
  if (['attraction', 'museum', 'gallery', 'viewpoint'].includes(t.tourism)) out.push([PROFILE.SIGHTS, 2]);
  else if (t.historic || t.tourism === 'artwork') out.push([PROFILE.SIGHTS, 0.6]); // (a plaque, a memorial: many, and few come to see them)
  if (['hotel', 'guest_house', 'hostel', 'apartment'].includes(t.tourism)) out.push([PROFILE.SIGHTS, 1.5], [PROFILE.NIGHT, 0.5]);
  if (['school', 'kindergarten'].includes(t.amenity)) out.push([PROFILE.SCHOOL, 4]);
  if (['college', 'university'].includes(t.amenity)) out.push([PROFILE.SCHOOL, 8]);
  if (t.highway === 'bus_stop') out.push([PROFILE.TRANSIT, 1.2]);
  if (t.railway === 'station' || t.railway === 'subway_entrance') out.push([PROFILE.TRANSIT, 8]);
  if (['hospital'].includes(t.amenity)) out.push([PROFILE.HEALTH, 8]);
  if (['clinic', 'doctors', 'dentist', 'pharmacy'].includes(t.amenity)) out.push([PROFILE.HEALTH, 1]);
  if (t.leisure && t.leisure !== 'park') out.push([PROFILE.LEISURE, 0.5]);
  return out;
};
const pois = [];
for (const e of readOsm('osm_poi.json')) {
  const t = e.tags ?? {}, lon = e.lon ?? e.center?.lon, lat = e.lat ?? e.center?.lat;
  if (lon == null) continue;
  const [x, z] = xz([lon, lat]), prof = poiProfile(t);
  for (const [p, v] of prof) deposit(p, x, z, v * 1000); // (a shop ~ 1000 m2 of floor area's worth)
  if (prof.length) pois.push({ x, z, t, prof });
}
log(`${pois.length} places along the streets`);
// the historic district: the sights everywhere in it
const heritage = area.heritage?.map(xz) ?? null;
if (heritage) for (let j = 0; j < GH; j++) for (let i = 0; i < GW; i++) {
  const x = gx0 + (i + 0.5) * GRID, z = gz0 + (j + 0.5) * GRID;
  if (inRings(x, z, [heritage])) deposit(PROFILE.SIGHTS, x, z, 150);
}
// spread: a few passes of a box blur (about a Gaussian of 45 m): what is round the corner counts too
function blur(g, r) {
  const tmp = new Float32Array(g.length);
  for (let pass = 0; pass < 3; pass++) {
    for (let j = 0; j < GH; j++) { let s = 0; const row = j * GW; for (let i = -r; i < GW; i++) { if (i + r < GW) s += g[row + i + r]; if (i - r - 1 >= 0) s -= g[row + i - r - 1]; if (i >= 0) tmp[row + i] = s / (2 * r + 1); } }
    for (let i = 0; i < GW; i++) { let s = 0; for (let j = -r; j < GH; j++) { if (j + r < GH) s += tmp[(j + r) * GW + i]; if (j - r - 1 >= 0) s -= tmp[(j - r - 1) * GW + i]; if (j >= 0) g[j * GW + i] = s / (2 * r + 1); } }
  }
}
for (const g of grids) blur(g, 1);
const sample = (x, z, out) => {
  const fi = (x - gx0) / GRID - 0.5, fj = (z - gz0) / GRID - 0.5, i = Math.max(0, Math.min(GW - 2, Math.floor(fi))), j = Math.max(0, Math.min(GH - 2, Math.floor(fj)));
  const u = Math.max(0, Math.min(1, fi - i)), v = Math.max(0, Math.min(1, fj - j));
  for (let p = 0; p < NP; p++) {
    const g = grids[p], k = j * GW + i;
    out[p] += (g[k] * (1 - u) + g[k + 1] * u) * (1 - v) + (g[k + GW] * (1 - u) + g[k + GW + 1] * u) * v;
  }
  return out;
};

// ---------------------------------------------------------------- the graph
const nodes = [];      // [x, z]
const links = [];      // { a, b, pts: [[x, z], ...], kind, width, edge, rnode, signal }
const node = (x, z) => { nodes.push([x, z]); return nodes.length - 1; };
const link = (a, b, pts, kind, width, extra = {}) => { const l = { a, b, pts, kind, width, edge: -1, rnode: -1, signal: 0, ...extra }; links.push(l); return l; };

// the streets people walk along: not the expressway, its ramps or the links, not service ways (car parks, drives),
// not in a tunnel or up on a flyover
const lanesOf = roadLanes(roads.edges);
const WALKED = new Set(['trunk', 'primary', 'secondary', 'tertiary', 'unclassified', 'residential', 'living_street']);
const walked = (e) => WALKED.has(e.highway) && !e.tunnel && !e.flyover;
const P = (e) => { const p = e.pts, out = []; for (let k = 0; k < p.length; k += 3) out.push([p[k], p[k + 2]]); return out; };
const lengthOf = (pts) => { let s = 0; for (let k = 1; k < pts.length; k++) s += Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]); return s; };
// a point along a polyline at distance u, and the direction there
function along(pts, u) {
  let s = 0;
  for (let k = 1; k < pts.length; k++) {
    const [ax, az] = pts[k - 1], [bx, bz] = pts[k], l = Math.hypot(bx - ax, bz - az);
    if (s + l >= u || k === pts.length - 1) { const t = l > 0 ? Math.max(0, Math.min(1, (u - s) / l)) : 0; return [ax + (bx - ax) * t, az + (bz - az) * t, (bx - ax) / (l || 1), (bz - az) / (l || 1), k]; }
    s += l;
  }
  return [pts[0][0], pts[0][1], 1, 0, 1];
}
// the side line of a polyline: `o` metres out on side s (0: the normal (-dz, dx) of its direction; 1: the other), from
// u0 to u1 along it, its corners mitred
function sideLine(pts, cum, s, o, u0, u1) {
  const sign = s === 0 ? 1 : -1, out = [];
  const at = (u) => { const [x, z, dx, dz] = along(pts, u); return [x - dz * o * sign, z + dx * o * sign]; };
  out.push(at(u0));
  for (let k = 1; k < pts.length - 1; k++) {
    if (cum[k] <= u0 + 0.5 || cum[k] >= u1 - 0.5) continue;
    const [ax, az] = pts[k - 1], [bx, bz] = pts[k], [cx, cz] = pts[k + 1];
    const l1 = Math.hypot(bx - ax, bz - az) || 1, l2 = Math.hypot(cx - bx, cz - bz) || 1;
    let nx = -((bz - az) / l1 + (cz - bz) / l2), nz = (bx - ax) / l1 + (cx - bx) / l2;
    const nl = Math.hypot(nx, nz) || 1; nx /= nl; nz /= nl;
    const cos = Math.max(0.5, nx * -(bz - az) / l1 + nz * (bx - ax) / l1);
    out.push([bx + nx * o * sign / cos, bz + nz * o * sign / cos]);
  }
  out.push(at(u1));
  return out;
}

// 1. each street's sidewalks, measured on the tiles: from the centreline out to the kerb (the carriageway's edge),
// then across the paving to its far edge; where a side has none, a street of houses is walked at its edge
const sides = new Map(); // edge index -> [{ o, w, kind } | null, same]
let measured = 0, roadside = 0, none = 0, medians = 0, bridges = 0;
roads.edges.forEach((e, i) => {
  if (!walked(e)) return;
  const pts = P(e), L = lengthOf(pts);
  if (L < 1) return;
  const { carriage } = pavedHalf(e, lanesOf(e) ?? e.lanes);
  const res = [];
  for (const s of [0, 1]) {
    const sign = s === 0 ? 1 : -1, k1s = [], k2s = [];
    const from = Math.min(8, L / 3), to = Math.max(from, L - Math.min(8, L / 3));
    for (let u = from; u <= to; u += Math.max(3, (to - from) / 12)) {
      const [x, z, dx, dz] = along(pts, u), nx = -dz * sign, nz = dx * sign;
      let k1 = null;
      if (!idx.carriageway.has(x, z)) k1 = carriage / 2;
      else for (let d = 0.5; d <= 18; d += 0.25) if (!idx.carriageway.has(x + nx * d, z + nz * d)) { k1 = d; break; }
      if (k1 == null) continue;
      let k2 = k1;
      for (let d = k1 + 0.15; d <= k1 + 7; d += 0.2) { if (idx.sidewalk.has(x + nx * d, z + nz * d) || idx.plaza.has(x + nx * d, z + nz * d)) k2 = d; else if (d > k1 + 0.8) break; }
      k1s.push(k1); k2s.push(k2);
    }
    const med = (a) => a.sort((p, q) => p - q)[a.length >> 1];
    // a bridge's deck has no paving drawn on the tiles (flyovers.js draws it, as wide as the street it carries): its
    // sidewalks where the street's would be
    if (e.bridge && (!k1s.length || med(k2s) - med(k1s) < 0.45)) {
      const { half } = pavedHalf(e, lanesOf(e) ?? e.lanes), sw = Math.max(1, half - carriage / 2);
      res.push({ o: half - sw / 2, w: sw, kind: KIND.SIDEWALK }); bridges++; continue;
    }
    if (!k1s.length) { res.push(null); none++; continue; }
    const k1 = med(k1s), k2 = med(k2s);
    // the inner side of one carriageway of a divided road: another carriageway just beyond it (a median, not a
    // sidewalk; people only cross it)
    let median = false;
    if (e.oneway) {
      let hits = 0, tries = 0;
      for (let u = from; u <= to; u += Math.max(4, (to - from) / 6)) {
        const [x, z, dx, dz] = along(pts, u), nx = -dz * sign, nz = dx * sign;
        tries++; if ([1, 3, 6, 9].some((d) => idx.carriageway.has(x + nx * (k2 + d), z + nz * (k2 + d)))) hits++;
      }
      median = hits > tries / 2 && k2 - k1 < 4;
    }
    if (median) { res.push({ o: k1 + Math.max(0.6, (k2 - k1) / 2), w: Math.max(1, k2 - k1), kind: KIND.MEDIAN }); medians++; }
    // (a narrow one, Old San Juan's, is still walked: in single file)
    else if (k2 - k1 >= 0.45) { res.push({ o: (k1 + k2) / 2, w: Math.max(0.7, k2 - k1), kind: KIND.SIDEWALK }); measured++; }
    else if (['residential', 'living_street', 'unclassified'].includes(e.highway)) { res.push({ o: Math.max(1, k1 - 0.3), w: 0.8, kind: KIND.ROADSIDE }); roadside++; }
    else { res.push(null); none++; }
  }
  sides.set(i, res);
});
log(`sidewalks: ${measured} measured, ${bridges} on bridges, ${roadside} street edges walked, ${medians} medians, ${none} without`);

// 2. the junctions: the corners between neighbouring streets, and a crossing across the mouth of each street
const incident = new Map(); // road node -> [{ i, end, theta, dx, dz }]
for (const [i] of sides) {
  const e = roads.edges[i], pts = P(e);
  for (const end of ['a', 'b']) {
    const n = e[end], here = end === 'a' ? pts[0] : pts.at(-1);
    // (the way out of the junction, over its first few metres)
    const [fx, fz] = end === 'a' ? along(pts, Math.min(5, lengthOf(pts) / 2)) : along(pts, Math.max(0, lengthOf(pts) - 5));
    let dx = fx - here[0], dz = fz - here[1]; const l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l;
    if (!incident.has(n)) incident.set(n, []);
    incident.get(n).push({ i, end, theta: Math.atan2(dz, dx), dx, dz });
  }
}
// OSM's crossings: the zebra paths and crossing nodes, as points (with whether they have lights)
const crossings = [];
for (const e of readOsm('osm_land.json')) {
  const t = e.tags ?? {};
  if (e.type === 'node' && t.highway === 'crossing') crossings.push({ x: xz([e.lon, e.lat])[0], z: xz([e.lon, e.lat])[1], lights: /traffic_signals/.test(t.crossing ?? '') });
}
{
  const nodeAt = new Map(readOsm('osm_land.json').filter((e) => e.type === 'node').map((e) => [e.id, e]));
  for (const e of readOsm('osm_land.json')) if (e.type === 'way' && e.tags?.footway === 'crossing') {
    const ps = e.nodes.map((id) => nodeAt.get(id)).filter(Boolean).map((n) => xz([n.lon, n.lat]));
    if (ps.length < 2) continue;
    const m = ps[ps.length >> 1], m0 = ps[(ps.length - 1) >> 1];
    crossings.push({ x: (m[0] + m0[0]) / 2, z: (m[1] + m0[1]) / 2, lights: /traffic_signals/.test(e.tags.crossing ?? '') });
  }
}
const crossCells = new Map();
for (const c of crossings) { const k = Math.floor(c.x / 40) + ',' + Math.floor(c.z / 40); if (!crossCells.has(k)) crossCells.set(k, []); crossCells.get(k).push(c); }
const crossingsNear = (x, z, r) => {
  const out = [];
  for (let i = Math.floor((x - r) / 40); i <= Math.floor((x + r) / 40); i++) for (let j = Math.floor((z - r) / 40); j <= Math.floor((z + r) / 40); j++)
    for (const c of crossCells.get(i + ',' + j) ?? []) if (Math.hypot(c.x - x, c.z - z) <= r) out.push(c);
  return out;
};
const signalled = new Set(roads.signals);

// cuts[i][s]: points along side s of edge i where the sidewalk is split: { u, node }
const cuts = new Map();
const cutAt = (i, s, u, n) => { if (!cuts.has(i)) cuts.set(i, [[], []]); cuts.get(i)[s].push({ u, node: n }); };
const sidePoint = (i, s, u) => {
  const e = roads.edges[i], pts = P(e), [x, z, dx, dz] = along(pts, u), o = sides.get(i)[s].o, sign = s === 0 ? 1 : -1;
  return [x - dz * o * sign, z + dx * o * sign];
};
const plusSide = (inc) => (inc.end === 'a' ? 0 : 1); // the side towards the next street round (anticlockwise as sorted)
const minusSide = (inc) => 1 - plusSide(inc);
const uFrom = (inc, d) => (inc.end === 'a' ? d : lengthOf(P(roads.edges[inc.i])) - d); // distance d from this junction, as u
let corners = 0, mouths = 0;
const trims = new Map(); // `${i},${end},${side}` -> distance from the junction the sidewalk starts at
for (const [n, inc] of incident) {
  inc.sort((p, q) => p.theta - q.theta);
  const [Nx, , Nz] = roads.nodes[n];
  const k = inc.length;
  for (let a = 0; a < k; a++) {
    const A = inc[a], B = inc[(a + 1) % k];
    if (k === 1) break;
    const sa = plusSide(A), sb = minusSide(B), SA = sides.get(A.i)[sa], SB = sides.get(B.i)[sb];
    if (!SA || !SB) continue;
    let sector = B.theta - A.theta; if (sector <= 0) sector += Math.PI * 2;
    // the side lines: N + d u + n o (A on its plus side, B on its minus side)
    const pa = [-A.dz, A.dx], mb = [B.dz, -B.dx];
    let ua = 0, ub = 0, arc = null;
    if (sector < Math.PI * 0.9) {
      // they meet: solve N + dA ua + pA oA = N + dB ub + mB oB
      const rx = mb[0] * SB.o - pa[0] * SA.o, rz = mb[1] * SB.o - pa[1] * SA.o;
      const det = A.dx * -B.dz - A.dz * -B.dx;
      if (Math.abs(det) > 1e-6) { ua = (rx * -B.dz - rz * -B.dx) / det; ub = (A.dx * rz - A.dz * rx) / det; }
      const maxA = lengthOf(P(roads.edges[A.i])) * 0.45, maxB = lengthOf(P(roads.edges[B.i])) * 0.45;
      ua = Math.max(0, Math.min(ua, 30, maxA)); ub = Math.max(0, Math.min(ub, 30, maxB));
    } else {
      // round the outside of a bend (or straight on past a street on the other side): an arc about the junction
      const o = (SA.o + SB.o) / 2, from = Math.atan2(pa[1], pa[0]); let span = Math.atan2(mb[1], mb[0]) - from;
      while (span < 0) span += Math.PI * 2;
      if (span > Math.PI * 1.5) span -= Math.PI * 2;
      const steps = Math.max(1, Math.ceil(Math.abs(span) / 0.35));
      arc = Array.from({ length: steps + 1 }, (_, s) => [Nx + Math.cos(from + (span * s) / steps) * o, Nz + Math.sin(from + (span * s) / steps) * o]);
    }
    trims.set(`${A.i},${A.end},${sa}`, ua); trims.set(`${B.i},${B.end},${sb}`, ub);
    const qa = sidePoint(A.i, sa, uFrom(A, ua)), qb = sidePoint(B.i, sb, uFrom(B, ub));
    if (arc) {
      const na = node(...qa), nb = node(...qb);
      cutAt(A.i, sa, uFrom(A, ua), na); cutAt(B.i, sb, uFrom(B, ub), nb);
      if (Math.hypot(qa[0] - qb[0], qa[1] - qb[1]) > 0.3) link(na, nb, [qa, ...arc.slice(1, -1), qb], KIND.CORNER, Math.min(SA.w, SB.w));
    } else {
      const c = node((qa[0] + qb[0]) / 2, (qa[1] + qb[1]) / 2);
      cutAt(A.i, sa, uFrom(A, ua), c); cutAt(B.i, sb, uFrom(B, ub), c);
    }
    corners++;
  }
  // a crossing across each street's mouth, a little beyond its corners (where OSM has a crossing near, there)
  if (k < 3 && !(k === 2 && crossingsNear(Nx, Nz, 12).length)) continue;
  for (const A of inc) {
    const S = sides.get(A.i), L = lengthOf(P(roads.edges[A.i]));
    if (!S[0] || !S[1]) continue;
    let d = Math.max(trims.get(`${A.i},${A.end},0`) ?? 0, trims.get(`${A.i},${A.end},1`) ?? 0) + 1.2;
    let lights = signalled.has(n);
    for (const c of crossingsNear(Nx + A.dx * 12, Nz + A.dz * 12, 14)) {
      const along_ = (c.x - Nx) * A.dx + (c.z - Nz) * A.dz, across = Math.abs((c.x - Nx) * -A.dz + (c.z - Nz) * A.dx);
      if (along_ > d - 1 && along_ < 22 && across < S[0].o + S[1].o) { d = along_; lights ||= c.lights; break; }
    }
    if (d > L * 0.45) continue;
    const u = uFrom(A, d), p0 = sidePoint(A.i, 0, u), p1 = sidePoint(A.i, 1, u), n0 = node(...p0), n1 = node(...p1);
    cutAt(A.i, 0, u, n0); cutAt(A.i, 1, u, n1);
    link(n0, n1, [p0, p1], KIND.CROSSING, 2.4, { edge: A.i, rnode: n, signal: lights ? 1 : 0 });
    mouths++;
  }
}
// dead ends: round the turning circle
for (const [n, inc] of incident) if (inc.length === 1) {
  const A = inc[0], S = sides.get(A.i);
  if (!S[0] || !S[1]) continue;
  const u = uFrom(A, 0), p0 = sidePoint(A.i, 0, u), p1 = sidePoint(A.i, 1, u), n0 = node(...p0), n1 = node(...p1);
  cutAt(A.i, 0, u, n0); cutAt(A.i, 1, u, n1);
  link(n0, n1, [p0, p1], KIND.CORNER, 1.5);
}
log(`${corners} corners, ${mouths} crossings at junctions`);

// 3. crossings in the middle of a block, where OSM maps one
let midblock = 0;
{
  const ends = new Map(); // cell -> edges (for finding the street a crossing is on)
  for (const [i] of sides) {
    const pts = P(roads.edges[i]);
    for (const [x, z] of pts) { const k = Math.floor(x / 40) + ',' + Math.floor(z / 40); if (!ends.has(k)) ends.set(k, new Set()); ends.get(k).add(i); }
  }
  for (const c of crossings) {
    let best = null;
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (const i of ends.get((Math.floor(c.x / 40) + a) + ',' + (Math.floor(c.z / 40) + b)) ?? []) {
      const pts = P(roads.edges[i]); let s = 0;
      for (let k = 1; k < pts.length; k++) {
        const [ax, az] = pts[k - 1], [bx, bz] = pts[k], l = Math.hypot(bx - ax, bz - az) || 1, t = Math.max(0, Math.min(1, ((c.x - ax) * (bx - ax) + (c.z - az) * (bz - az)) / (l * l)));
        const d = Math.hypot(ax + (bx - ax) * t - c.x, az + (bz - az) * t - c.z);
        if (!best || d < best.d) best = { i, u: s + t * l, d, L: lengthOf(pts) };
        s += l;
      }
    }
    if (!best || best.d > 8) continue;
    const S = sides.get(best.i);
    if (!S[0] || !S[1] || best.u < 20 || best.u > best.L - 20) continue; // (by a junction: its own crossing has moved here)
    const p0 = sidePoint(best.i, 0, best.u), p1 = sidePoint(best.i, 1, best.u), n0 = node(...p0), n1 = node(...p1);
    cutAt(best.i, 0, best.u, n0); cutAt(best.i, 1, best.u, n1);
    link(n0, n1, [p0, p1], KIND.CROSSING, 2.4, { edge: best.i, rnode: -1, signal: c.lights ? 1 : 0 });
    midblock++;
  }
}
log(`${midblock} crossings in the middle of a block`);

// 4. the sidewalks themselves, from cut to cut
for (const [i, S] of sides) {
  const e = roads.edges[i], pts = P(e), L = lengthOf(pts), cum = [0];
  for (let k = 1; k < pts.length; k++) cum.push(cum[k - 1] + Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]));
  for (const s of [0, 1]) {
    if (!S[s]) continue;
    const list = cuts.get(i)?.[s] ?? [];
    // (an end with no corner, where the street round it has no sidewalk on that side: it ends there)
    const u0 = trims.get(`${i},a,${s}`) ?? 0, u1 = L - (trims.get(`${i},b,${s}`) ?? 0);
    if (!list.some((c) => c.u <= u0 + 0.5)) list.push({ u: u0, node: node(...sidePoint(i, s, u0)) });
    if (!list.some((c) => c.u >= u1 - 0.5)) list.push({ u: u1, node: node(...sidePoint(i, s, u1)) });
    list.sort((p, q) => p.u - q.u);
    for (let k = 1; k < list.length; k++) {
      const p = list[k - 1], q = list[k];
      if (q.u - p.u < 0.2) { if (p.node !== q.node) link(p.node, q.node, [nodes[p.node], nodes[q.node]], KIND.LINK, S[s].w); continue; }
      const line = sideLine(pts, cum, s, S[s].o, p.u, q.u);
      line[0] = nodes[p.node]; line[line.length - 1] = nodes[q.node];
      link(p.node, q.node, line, S[s].kind, S[s].w, { edge: i, side: s });
    }
  }
}
log(`${links.length} links after the streets`);

// 5. OSM's footways, paths, steps and pedestrian streets; their loose ends joined to the nearest walk within 8 m
const WIDTH = { pedestrian: 5, footway: 2.2, path: 1.6, steps: 2.2, cycleway: 2 };
{
  const elements = readOsm('osm_extra.json'), osmNode = new Map();
  for (const e of elements) if (e.type === 'node') osmNode.set(e.id, e);
  const ways = elements.filter((e) => e.type === 'way' && ['footway', 'path', 'pedestrian', 'steps'].includes(e.tags?.highway)
    && !['sidewalk', 'crossing', 'link', 'access_aisle', 'traffic_island'].includes(e.tags.footway) && !e.tags.bridge && !e.tags.tunnel
    && e.tags.indoor !== 'yes' && e.tags.access !== 'private' && e.tags.area !== 'yes' && e.tags.layer == null);
  const uses = new Map();
  for (const w of ways) for (const id of w.nodes) uses.set(id, (uses.get(id) ?? 0) + 1);
  const at = new Map(); // OSM node -> walk node
  const walkNode = (id) => { if (!at.has(id)) { const n = osmNode.get(id); at.set(id, node(...xz([n.lon, n.lat]))); } return at.get(id); };
  let n0 = links.length;
  for (const w of ways) {
    const ids = w.nodes.filter((id) => osmNode.has(id));
    if (ids.length < 2) continue;
    // (only within the area: Condado and Hato Rey read the municipality's footways)
    if (!ids.some((id) => { const [x, z] = xz([osmNode.get(id).lon, osmNode.get(id).lat]); return x >= ext.minX && x <= ext.maxX && z >= ext.minZ && z <= ext.maxZ; })) continue;
    const kind = w.tags.highway === 'steps' ? KIND.STEPS : w.tags.highway === 'pedestrian' ? KIND.PEDESTRIAN : w.tags.highway === 'path' ? KIND.PATH : KIND.FOOTWAY;
    const width = Number(w.tags.width) > 0.5 && Number(w.tags.width) < 30 ? Number(w.tags.width) : WIDTH[w.tags.highway];
    let start = 0;
    for (let k = 1; k < ids.length; k++) {
      if (k < ids.length - 1 && (uses.get(ids[k]) ?? 0) < 2) continue;
      const seg = ids.slice(start, k + 1).map((id) => xz([osmNode.get(id).lon, osmNode.get(id).lat]));
      if (lengthOf(seg) > 0.5) link(walkNode(ids[start]), walkNode(ids[k]), seg, kind, width);
      start = k;
    }
  }
  log(`${links.length - n0} footway links`);
  // the loose ends (and every end where a footway meets a street) to the nearest sidewalk or footway
  const degree = new Map();
  for (const l of links) { degree.set(l.a, (degree.get(l.a) ?? 0) + 1); degree.set(l.b, (degree.get(l.b) ?? 0) + 1); }
  const cell = 24, grid = new Map();
  const index = (li) => { for (const [x, z] of links[li].pts) { const k = Math.floor(x / cell) + ',' + Math.floor(z / cell); if (!grid.has(k)) grid.set(k, new Set()); grid.get(k).add(li); } };
  for (let li = 0; li < n0; li++) index(li);
  let joined = 0;
  for (const [, n] of at) {
    if ((degree.get(n) ?? 0) > 1) continue;
    const [x, z] = nodes[n];
    let best = null;
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (const li of grid.get((Math.floor(x / cell) + a) + ',' + (Math.floor(z / cell) + b)) ?? []) {
      const l = links[li];
      if (l.kind === KIND.CROSSING) continue;
      for (let k = 1; k < l.pts.length; k++) {
        const [ax, az] = l.pts[k - 1], [bx, bz] = l.pts[k], ll = Math.hypot(bx - ax, bz - az) || 1;
        const t = Math.max(0, Math.min(1, ((x - ax) * (bx - ax) + (z - az) * (bz - az)) / (ll * ll))), px = ax + (bx - ax) * t, pz = az + (bz - az) * t, d = Math.hypot(px - x, pz - z);
        if (d < 8 && (!best || d < best.d)) best = { li, k, px, pz, d };
      }
    }
    if (!best) continue;
    // split that link where the footway meets it
    const l = links[best.li], m = node(best.px, best.pz);
    const tail = [[best.px, best.pz], ...l.pts.slice(best.k)], head = [...l.pts.slice(0, best.k), [best.px, best.pz]];
    const b = l.b; l.b = m; l.pts = head;
    const l2 = link(m, b, tail, l.kind, l.width, { edge: l.edge, side: l.side });
    index(links.length - 1);
    if (best.d > 0.3) link(n, m, [nodes[n], [best.px, best.pz]], KIND.LINK, 2);
    else { // (the same place: let the footway end there)
      for (const q of links) { if (q.a === n) { q.a = m; q.pts[0] = [best.px, best.pz]; } if (q.b === n) { q.b = m; q.pts[q.pts.length - 1] = [best.px, best.pz]; } }
    }
    joined++;
    void l2;
  }
  log(`${joined} footway ends joined to the walks`);
}

// ---------------------------------------------------------------- how many: calibrated to a few places
const raw_ = (l) => {
  const acc = new Float64Array(NP), L = lengthOf(l.pts);
  const n = Math.max(1, Math.ceil(L / 15));
  for (let k = 0; k < n; k++) { const [x, z] = along(l.pts, ((k + 0.5) / n) * L); sample(x, z, acc); }
  for (let p = 0; p < NP; p++) acc[p] /= n;
  return acc;
};
// people per 100 m of sidewalk at the profile's busiest hour, from what stands along it, saturating (the tenth shop on
// a block brings fewer people than the first): MAX (1 - exp(-raw / R)). Old San Juan's Calle Fortaleza comes to
// some 20 at its busiest, Ashford in the Condado about 10, Ponce de León in the Milla de Oro about 6, a street of
// houses well under one.
const MAX = [12, 10, 22, 10, 10, 4, 1, 6, 8], R = [900, 250, 600, 300, 400, 200, 400, 300, 200];
const KIND_FACTOR = { [KIND.SIDEWALK]: 1, [KIND.CORNER]: 1, [KIND.CROSSING]: 0, [KIND.FOOTWAY]: 0.8, [KIND.PATH]: 0.5, [KIND.STEPS]: 0.6, [KIND.PEDESTRIAN]: 2.2, [KIND.ROADSIDE]: 1, [KIND.LINK]: 0.5, [KIND.MEDIAN]: 0 };
for (const l of links) {
  const r = raw_(l), f = KIND_FACTOR[l.kind] ?? 1;
  l.raw = r;
  l.w = Array.from(r, (v, p) => f * MAX[p] * (1 - Math.exp(-Math.max(0, v) / R[p])));
}
if (process.env.WALK_RAW) {
  // the distribution of what stands along the sidewalks, by profile (for calibrating COEF)
  const side = links.filter((l) => l.kind === KIND.SIDEWALK);
  for (let p = 0; p < NP; p++) { const v = side.map((l) => l.raw[p]).sort((a, b) => a - b); log(`profile ${p}: p50 ${v[v.length >> 1].toFixed(0)} p90 ${v[Math.floor(v.length * 0.9)].toFixed(0)} p99 ${v[Math.floor(v.length * 0.99)].toFixed(0)} max ${v.at(-1).toFixed(0)}`); }
}
// (the reference places, for the record: what the estimate gives there)
const PLACES = [
  ['Calle Fortaleza, Old San Juan', -66.1155, 18.4651], ['Avenida Ashford, Condado', -66.0745, 18.4572], ['Ponce de León, Milla de Oro', -66.0628, 18.4236],
  ['Paseo de Diego, Río Piedras', -66.0505, 18.3997], ['Calle Loíza, Santurce', -66.0535, 18.4502], ['a street of houses, Caimito', -66.0870, 18.3420],
];
for (const [name, lon, lat] of PLACES) {
  const [x, z] = proj.project(lon, lat);
  let best = null;
  for (const l of links) { if (l.kind !== KIND.SIDEWALK && l.kind !== KIND.PEDESTRIAN && l.kind !== KIND.ROADSIDE) continue; const [px, pz] = l.pts[l.pts.length >> 1]; const d = Math.hypot(px - x, pz - z); if (!best || d < best.d) best = { d, l }; }
  if (process.env.WALK_RAW) { const mx = new Array(NP).fill(0); let kinds = {}; for (const l of links) { const [px, pz] = l.pts[l.pts.length >> 1]; if (Math.hypot(px - x, pz - z) > 150) continue; kinds[l.kind] = (kinds[l.kind] ?? 0) + 1; l.raw.forEach((v, p) => { mx[p] = Math.max(mx[p], v); }); } log(`  within 150 m: max raw ${mx.map((v) => v.toFixed(0)).join(' ')}; kinds ${JSON.stringify(kinds)}; nearest kind ${best?.l.kind}`); }
  if (best && best.d < 120) log(`${name}: ${best.l.w.map((v) => v.toFixed(1)).join(' ')} per 100 m${process.env.WALK_RAW ? ` (raw ${Array.from(best.l.raw, (v) => v.toFixed(0)).join(' ')})` : ''}`);
}

// ---------------------------------------------------------------- the places people stop
const spots = [];
const nearestWalk = (() => {
  const cell = 24, grid = new Map();
  links.forEach((l, li) => { if (l.kind === KIND.CROSSING) return; for (const [x, z] of l.pts) { const k = Math.floor(x / cell) + ',' + Math.floor(z / cell); if (!grid.has(k)) grid.set(k, new Set()); grid.get(k).add(li); } });
  return (x, z, r) => {
    let best = null;
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (const li of grid.get((Math.floor(x / cell) + a) + ',' + (Math.floor(z / cell) + b)) ?? []) {
      const l = links[li];
      for (let k = 1; k < l.pts.length; k++) {
        const [ax, az] = l.pts[k - 1], [bx, bz] = l.pts[k], ll = Math.hypot(bx - ax, bz - az) || 1;
        const t = Math.max(0, Math.min(1, ((x - ax) * (bx - ax) + (z - az) * (bz - az)) / (ll * ll))), px = ax + (bx - ax) * t, pz = az + (bz - az) * t, d = Math.hypot(px - x, pz - z);
        if (d < r && (!best || d < best.d)) best = { li, px, pz, d, dx: (bx - ax) / ll, dz: (bz - az) / ll };
      }
    }
    return best;
  };
})();
const angle = (dx, dz) => Math.atan2(dx, dz); // (a heading: 0 faces +z)
// furniture: a bench's sitters face away from its back (+z of the prop), a shelter's bench is at (1.2, -1.3)
for (const p of props) {
  const w = nearestWalk(p.x, p.z, 25);
  if (!w) continue;
  const s = Math.sin(p.rot), c = Math.cos(p.rot);
  if (p.kind === PROP.BENCH) spots.push({ x: p.x, z: p.z, kind: SPOT.BENCH, heading: p.rot, link: w.li, w: links[w.li].w.map((v) => v * 0.5) });
  else if (p.variant === 1) spots.push({ x: p.x + c * 1.2 + s * -1.3, z: p.z - s * 1.2 + c * -1.3, kind: SPOT.SHELTER, heading: p.rot, link: w.li, w: links[w.li].w });
}
// bus stops (OSM's, also those without a shelter): people wait on the sidewalk, facing the street
for (const e of readOsm('osm_poi.json')) {
  const t = e.tags ?? {};
  if (t.highway !== 'bus_stop' || e.lon == null) continue;
  const [x, z] = xz([e.lon, e.lat]), w = nearestWalk(x, z, 15);
  if (!w || links[w.li].kind === KIND.FOOTWAY) continue;
  const l = links[w.li], road = l.edge >= 0 ? roads.edges[l.edge] : null;
  // facing the street: the side's normal pointing back towards the centreline
  const toward = l.side === 0 ? angle(w.dz, -w.dx) : angle(-w.dz, w.dx);
  spots.push({ x: w.px, z: w.pz, kind: SPOT.BUS, heading: road ? toward : 0, link: w.li, w: Array.from({ length: NP }, (_, p) => (p === PROFILE.TRANSIT ? 3 : 0)) });
}
// shop fronts, cafés and bars: a few standing at the door (on the building's side of the sidewalk)
for (const { x, z, t, prof } of pois) {
  if (!(t.shop || ['restaurant', 'fast_food', 'cafe', 'bar', 'pub', 'bakery', 'ice_cream', 'pharmacy', 'bank'].includes(t.amenity))) continue;
  const w = nearestWalk(x, z, 30);
  if (!w) continue;
  const l = links[w.li];
  if (l.kind !== KIND.SIDEWALK && l.kind !== KIND.PEDESTRIAN) continue;
  const sign = (x - w.px) * -w.dz + (z - w.pz) * w.dx > 0 ? 1 : -1; // (the side the shop is on)
  const o = Math.min(0.8, l.width / 2 - 0.4);
  const bar = ['bar', 'pub'].includes(t.amenity);
  spots.push({ x: w.px - w.dz * o * sign, z: w.pz + w.dx * o * sign, kind: bar ? SPOT.BAR : SPOT.FRONT, heading: angle(-w.dz * sign, w.dx * sign), link: w.li,
    w: Array.from({ length: NP }, (_, p) => (prof.find(([q]) => q === p)?.[1] ?? 0) * (bar ? 1.6 : 0.6)) });
}
// plazas: the middle of each paved square
log(`${spots.length} places people stop`);

// ---------------------------------------------------------------- write
// In blocks of CHUNK metres (walks/<cx>_<cz>.bin, listed in walks.json): the client loads those round the view. A
// link is in the block of its middle; the nodes it joins keep their numbers across blocks (the walks of
// neighbouring blocks join there). Per block:
//   u32 magic 'WLK2' | u32 nNodes | u32 nLinks | u32 nInner | u32 nCross | u32 nSpots
//   nodes    u32 id[] | f32 [x, z][]
//   links    u32 a[] | u32 b[] (node ids) | u8 inner[] (points between its ends) | u8 kind[] | u8 width[] (dm)
//            | u8 w[9 per link] (people per 100 m at each profile's busiest hour, 40 * (w / 255)^2)
//   inner    f32 [x, z][] (the links' points between their ends, in order)
//   cross    u32 link[] | i32 edge[] (roads.json) | i32 node[] (roads.json; -1 in mid-block) | u8 flags[] (1: lights)
//   spots    f32 [x, z][] | u8 kind[] | u8 heading[] (256 = a turn) | u32 link[] | u8 w[9 per spot]
const CHUNK = 1024;
const enc = (v) => Math.max(0, Math.min(255, Math.round(Math.sqrt(Math.max(0, v) / 40) * 255)));
const chunkOf = (x, z) => [Math.floor(x / CHUNK), Math.floor(z / CHUNK)];
const blocks = new Map();
const blockAt = (cx, cz) => { const k = `${cx}_${cz}`; if (!blocks.has(k)) blocks.set(k, { cx, cz, links: [], spots: [] }); return blocks.get(k); };
links.forEach((l, i) => { const [x, z] = l.pts[l.pts.length >> 1]; blockAt(...chunkOf(x, z)).links.push(i); });
const local = new Map(); // link -> [block key, index in its block]
for (const [k, b] of blocks) b.links.forEach((li, j) => local.set(li, [k, j]));
for (const s of spots) { const [k, j] = local.get(s.link); blocks.get(k).spots.push({ ...s, local: j }); }
const pad = (a) => { const extra = (4 - (a.byteLength % 4)) % 4; return extra ? [a, new Uint8Array(extra)] : [a]; };
const wdir = path.join(dir, 'walks');
fs.rmSync(wdir, { recursive: true, force: true }); fs.mkdirSync(wdir, { recursive: true });
const index = [];
let bytes = 0;
for (const [k, b] of blocks) {
  const L = b.links.map((i) => links[i]), ids = [...new Set(L.flatMap((l) => [l.a, l.b]))];
  const nN = ids.length, nL = L.length, nI = L.reduce((n, l) => n + Math.min(255, l.pts.length - 2), 0), C = L.map((l, j) => [l, j]).filter(([l]) => l.kind === KIND.CROSSING), nS = b.spots.length;
  const nodeId = new Uint32Array(ids), nodeXZ = new Float32Array(nN * 2);
  ids.forEach((id, j) => { nodeXZ[j * 2] = nodes[id][0]; nodeXZ[j * 2 + 1] = nodes[id][1]; });
  const la = new Uint32Array(L.map((l) => l.a)), lb = new Uint32Array(L.map((l) => l.b)), inner = new Uint8Array(nL), kind = new Uint8Array(nL), width = new Uint8Array(nL), w = new Uint8Array(nL * NP), pts = new Float32Array(nI * 2);
  let pc = 0;
  L.forEach((l, j) => {
    const n = Math.min(255, l.pts.length - 2), step = (l.pts.length - 2) / Math.max(1, n);
    inner[j] = n; kind[j] = l.kind; width[j] = Math.min(255, Math.round(l.width * 10));
    for (let p = 0; p < NP; p++) w[j * NP + p] = enc(l.w?.[p] ?? 0);
    for (let q = 0; q < n; q++) { const [x, z] = l.pts[1 + Math.floor(q * step)]; pts[pc * 2] = x; pts[pc * 2 + 1] = z; pc++; }
  });
  const cl = new Uint32Array(C.map(([, j]) => j)), ce = new Int32Array(C.map(([l]) => l.edge)), cn = new Int32Array(C.map(([l]) => l.rnode)), cf = new Uint8Array(C.map(([l]) => l.signal));
  const sxz = new Float32Array(nS * 2), sk = new Uint8Array(nS), sh = new Uint8Array(nS), sl = new Uint32Array(nS), sw = new Uint8Array(nS * NP);
  b.spots.forEach((s, j) => {
    sxz[j * 2] = s.x; sxz[j * 2 + 1] = s.z; sk[j] = s.kind; sl[j] = s.local;
    sh[j] = Math.round((((s.heading % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) / (2 * Math.PI) * 256) & 255;
    for (let p = 0; p < NP; p++) sw[j * NP + p] = enc(s.w[p]);
  });
  const parts = [new Uint32Array([0x324b4c57, nN, nL, pc, C.length, nS]), nodeId, nodeXZ, la, lb, ...pad(inner), ...pad(kind), ...pad(width), ...pad(w), pts,
    cl, ce, cn, ...pad(cf), sxz, ...pad(sk), ...pad(sh), sl, ...pad(sw)];
  const out = Buffer.concat(parts.map((a) => Buffer.from(a.buffer, a.byteOffset, a.byteLength)));
  fs.writeFileSync(path.join(wdir, `${k}.bin`), out);
  index.push([b.cx, b.cz, out.length]); bytes += out.length;
}
fs.writeFileSync(path.join(dir, 'walks.json'), JSON.stringify({ version: 2, chunk: CHUNK, profiles: Object.keys(PROFILE), kinds: Object.keys(KIND), spots: Object.keys(SPOT), blocks: index }));
log(`walks: ${nodes.length} nodes, ${links.length} links, ${spots.length} stops in ${blocks.size} blocks of ${CHUNK} m, ${(bytes / 1e6).toFixed(1)} MB`);
