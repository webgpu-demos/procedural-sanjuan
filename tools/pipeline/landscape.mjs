// Green space, water and street objects: OSM areas -> ground polygons, and the placement of props
// (trees, utility poles and their wires, street lights, mapped vending machines).
import fs from 'node:fs';
import { AREA, PROP, SPORT } from '../../src/shared/tileformat.js';

// ---------------------------------------------------------------- spatial index
// Point-in-polygon queries over many polygons ([outer, ...holes], rings of [x, z]).
// A big polygon (a tile's whole street network in one piece) keeps, per cell, the edges that cross the cell
// and whether the cell's centre is inside: a point then only counts the crossings between itself and that
// centre, against those few edges. (Built lazily, cell by cell, as queries arrive.)
const BIG = 48; // vertices
export class PolyIndex {
  constructor(cell = 24) { this.cell = cell; this.grid = new Map(); }
  add(rings) {
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const [x, z] of rings[0]) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
    const item = { rings, x0, x1, z0, z1, cells: rings.reduce((n, r) => n + r.length, 0) > BIG ? new Map() : null }, c = this.cell;
    for (let i = Math.floor(x0 / c); i <= Math.floor(x1 / c); i++)
      for (let j = Math.floor(z0 / c); j <= Math.floor(z1 / c); j++) {
        const k = i + ',' + j;
        if (!this.grid.has(k)) this.grid.set(k, []);
        this.grid.get(k).push(item);
      }
  }
  has(x, z) {
    const i = Math.floor(x / this.cell), j = Math.floor(z / this.cell), k = i + ',' + j;
    const items = this.grid.get(k);
    if (!items) return false;
    for (const it of items) {
      if (x < it.x0 || x > it.x1 || z < it.z0 || z > it.z1) continue;
      if (it.cells ? this.cellTest(it, i, j, k, x, z) : inRings(x, z, it.rings)) return true;
    }
    return false;
  }
  cellTest(it, i, j, k, x, z) {
    let cell = it.cells.get(k);
    if (!cell) {
      const c = this.cell, ax = i * c, az = j * c, bx = ax + c, bz = az + c, edges = [];
      for (const r of it.rings) for (let n = 0; n < r.length; n++) {
        const [px, pz] = r[n], [qx, qz] = r[(n + 1) % r.length];
        if (Math.max(px, qx) >= ax && Math.min(px, qx) <= bx && Math.max(pz, qz) >= az && Math.min(pz, qz) <= bz) edges.push(px, pz, qx, qz);
      }
      // (the reference point is nudged off the exact centre, away from grid-aligned edges)
      const cx = ax + c * 0.5013, cz = az + c * 0.4987;
      cell = { cx, cz, inside: inRings(cx, cz, it.rings), edges };
      it.cells.set(k, cell);
    }
    let inside = cell.inside;
    const e = cell.edges, dx = cell.cx - x, dz = cell.cz - z;
    for (let n = 0; n < e.length; n += 4) {
      // does the edge cross the segment from the point to the reference point?
      const ex = e[n + 2] - e[n], ez = e[n + 3] - e[n + 1], den = dx * ez - dz * ex;
      if (den === 0) continue;
      const ox = e[n] - x, oz = e[n + 1] - z, t = (ox * ez - oz * ex) / den, u = (ox * dz - oz * dx) / den;
      if (t >= 0 && t < 1 && u >= 0 && u < 1) inside = !inside;
    }
    return inside;
  }
}
export function inRings(x, z, rings) {
  let inside = false;
  for (const r of rings) for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [xi, zi] = r[i], [xj, zj] = r[j];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

export const hash = (a, b, c = 0) => {
  let h = Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul(b | 0, 0x165667b1) ^ Math.imul(c | 0, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b); h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};

// ---------------------------------------------------------------- OSM land cover
function landKind(t) {
  if (t.natural === 'water') return AREA.WATER;
  if (t.natural === 'beach' || t.natural === 'sand') return AREA.BEACH;
  if (t.natural === 'wood' || t.landuse === 'forest' || t.natural === 'scrub' || t.natural === 'wetland') return AREA.WOOD; // (wetland here: mangrove)
  if (t.leisure === 'pitch' || t.leisure === 'playground') return AREA.PITCH;
  if (t.leisure || t.landuse || t.natural === 'grassland') return AREA.PARK;
  return null;
}

const sportOf = (t) => (/tennis/.test(t.sport ?? '') ? SPORT.TENNIS : /soccer|futsal|multi|american_football|rugby/.test(t.sport ?? '') ? SPORT.TURF
  : /baseball|softball/.test(t.sport ?? '') ? SPORT.DIRT : SPORT.OTHER);
// Tree models by genus: 1 coconut palm (and palms in general), 2 flamboyán, 3 royal palm, 0 anything else
// (see TREES in src/world/props.js).
export const GENUS = { ANY: 0, COCONUT: 1, FLAMBOYAN: 2, ROYAL_PALM: 3 };
const genusOf = (t) => {
  const g = `${t.genus ?? ''} ${t.species ?? ''} ${t.taxon ?? ''} ${t['species:es'] ?? ''} ${t['species:en'] ?? ''}`.toLowerCase();
  return /roystonea|royal palm|palma real/.test(g) ? GENUS.ROYAL_PALM : /delonix|flamboy/.test(g) ? GENUS.FLAMBOYAN
    : /cocos|coco|palm|arecaceae|phoenix|washingtonia|veitchia|adonidia|sabal/.test(g) || t.leaf_type === 'palm' ? GENUS.COCONUT : GENUS.ANY;
};

// Joins the outer member ways of a multipolygon relation into closed rings of node ids.
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
        else continue;
        pool.splice(i, 1); grew = true; break;
      }
    }
    if (ring.length >= 4 && ring[0] === ring.at(-1)) rings.push(ring);
  }
  return rings;
}

// -> { areas: [{ kind, ring: [[lon, lat], ...] }], trees: [[lon, lat]], treeRows: [[[lon, lat], ...]], vending: [[lon, lat]],
//      crossings: [[[lon, lat], ...]] (marked crossing paths), crossingNodes: [{ id, lon, lat }], signals: [node id] }
export function readLand(file) {
  const { elements } = JSON.parse(fs.readFileSync(file, 'utf8'));
  const nodes = new Map(), ways = new Map();
  for (const e of elements) { if (e.type === 'node') nodes.set(e.id, e); else if (e.type === 'way') ways.set(e.id, e); }
  const ll = (ids) => ids.map((id) => nodes.get(id)).filter(Boolean).map((n) => [n.lon, n.lat]);
  const out = { areas: [], trees: [], treeRows: [], vending: [], crossings: [], crossingNodes: [], signals: [] };
  const inRelation = new Set();
  for (const e of elements) {
    const t = e.tags ?? {};
    if (e.type === 'relation') {
      const kind = landKind(t);
      if (kind == null) continue;
      const outers = e.members.filter((m) => m.type === 'way' && m.role !== 'inner' && ways.has(m.ref)).map((m) => ways.get(m.ref).nodes);
      e.members.forEach((m) => inRelation.add(m.ref));
      for (const ring of stitch(outers)) out.areas.push({ kind, ring: ll(ring), code: sportOf(t) });
    }
  }
  for (const e of elements) {
    const t = e.tags ?? {};
    if (e.type === 'node') {
      if (t.natural === 'tree') out.trees.push([e.lon, e.lat, genusOf(t)]);
      else if (t.amenity === 'vending_machine') out.vending.push([e.lon, e.lat]);
      else if (t.highway === 'traffic_signals' && t.traffic_signals !== 'no') out.signals.push(e.id);
      else if (t.highway === 'crossing' && t.crossing !== 'unmarked' && t.crossing !== 'no') out.crossingNodes.push({ id: e.id, lon: e.lon, lat: e.lat });
    } else if (e.type === 'way') {
      if (t.natural === 'tree_row') { const row = ll(e.nodes); row.genus = genusOf(t); out.treeRows.push(row); continue; }
      if (t.footway === 'crossing') { if (t.crossing !== 'unmarked' && t.crossing !== 'no') out.crossings.push(ll(e.nodes)); continue; }
      const kind = landKind(t);
      if (kind != null && e.nodes[0] === e.nodes.at(-1) && e.nodes.length >= 4) out.areas.push({ kind, ring: ll(e.nodes), code: sportOf(t) });
    }
  }
  return out;
}

// Sutherland–Hodgman clip of a ring to an axis-aligned box.
export function clipRing(ring, x0, z0, x1, z1) {
  const clip = (pts, inside, cut) => {
    const out = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length], ia = inside(a), ib = inside(b);
      if (ia) out.push(a);
      if (ia !== ib) out.push(cut(a, b));
    }
    return out;
  };
  const atX = (x) => (a, b) => [x, a[1] + ((b[1] - a[1]) * (x - a[0])) / (b[0] - a[0])];
  const atZ = (z) => (a, b) => [a[0] + ((b[0] - a[0]) * (z - a[1])) / (b[1] - a[1]), z];
  let r = clip(ring, (p) => p[0] >= x0, atX(x0));
  r = clip(r, (p) => p[0] <= x1, atX(x1));
  r = clip(r, (p) => p[1] >= z0, atZ(z0));
  r = clip(r, (p) => p[1] <= z1, atZ(z1));
  return r.length >= 3 ? r : null;
}

// ---------------------------------------------------------------- props
const TREE_SPACING = { [AREA.PARK]: [15, 0.5], [AREA.WOOD]: [8.5, 0.85], [AREA.BEACH]: [15, 0.18] }; // grid step (m), fill probability
const AVENUE = new Set(['trunk', 'primary', 'secondary', 'tertiary']);
const BACKSTREET = new Set(['residential', 'unclassified', 'living_street', 'tertiary']);

// land: [{ kind, ring: [[x, z]] }] in world metres; edges: road graph edges with pts [x, y, z, ...];
// idx: { building, road, carriageway, sidewalk, water } PolyIndex. Returns { props, wires }.
export function placeProps({ land, trees, treeRows, vending, edges, idx, inBounds }) {
  const props = [], wires = [];
  const taken = new Set();
  const free = (x, z, cell) => { const k = Math.floor(x / cell) + ',' + Math.floor(z / cell); if (taken.has(k)) return false; taken.add(k); return true; };
  const tree = (x, z, street, genus = 0) => {
    if (!inBounds(x, z) || idx.building.has(x, z) || idx.carriageway.has(x, z) || idx.water.has(x, z) || !free(x, z, 3.5)) return;
    const h = hash(x * 10, z * 10, 1);
    // a tree of unknown kind: San Juan's streets and parks are a mix of palms, flamboyanes and broad shade trees
    if (!genus) {
      const g = hash(x * 10, z * 10, 13);
      genus = g < (street ? 0.28 : 0.18) ? GENUS.COCONUT : g < (street ? 0.4 : 0.26) ? GENUS.ROYAL_PALM : g < (street ? 0.52 : 0.34) ? GENUS.FLAMBOYAN : GENUS.ANY;
    }
    // street trees are smaller, pruned shapes (variants 0-1); park trees use every variant
    const palm = genus === GENUS.COCONUT || genus === GENUS.ROYAL_PALM;
    props.push({ kind: PROP.TREE, variant: genus ? 3 + genus : street ? Math.floor(h * 2) : Math.floor(h * 4), rot: h * 40, x, z,
      scale: palm ? 0.8 + 0.4 * hash(x, z, 2) : street ? 0.6 + 0.3 * hash(x, z, 2) : 0.75 + 0.6 * hash(x, z, 2) });
  };

  // mapped trees and tree rows
  for (const [x, z, genus] of trees) tree(x, z, true, genus);
  for (const row of treeRows) forEachAlong(row, 7, (x, z) => tree(x, z, true, row.genus));

  // parks, woods and beaches: a jittered grid inside each polygon (coconut palms on the sand)
  for (const { kind, ring } of land) {
    const sp = TREE_SPACING[kind];
    if (!sp) continue;
    const [step, fill] = sp;
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const [x, z] of ring) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
    for (let i = Math.floor(x0 / step); i <= Math.floor(x1 / step); i++)
      for (let j = Math.floor(z0 / step); j <= Math.floor(z1 / step); j++) {
        if (hash(i, j, 5) > fill) continue;
        const x = (i + 0.15 + 0.7 * hash(i, j, 6)) * step, z = (j + 0.15 + 0.7 * hash(i, j, 7)) * step;
        if (inRings(x, z, [ring]) && !idx.road.has(x, z)) tree(x, z, false, kind === AREA.BEACH ? GENUS.COCONUT : 0);
      }
  }

  // along the roads
  let lastWay = null, carry = 0, prevPole = null;
  edges.forEach((e, ei) => {
    if ((e.bridge && !e.span) || e.tunnel || e.flyover || e.highway === 'motorway_link') return;
    const hw = e.highway.replace('_link', '');
    const pts = [];
    for (let i = 0; i < e.pts.length; i += 3) pts.push([e.pts[i], e.pts[i + 2]]);
    if (e.way !== lastWay) { lastWay = e.way; carry = 0; prevPole = null; }

    // Distance from the centreline to where `index` ends, walking sideways (side = +1 right, -1 left of travel).
    const reach = (index, x, z, nx, nz, side, max) => {
      if (!index.has(x, z)) return null;
      for (let d = 0.5; d <= max; d += 0.25) if (!index.has(x + nx * d * side, z + nz * d * side)) return d;
      return null;
    };

    if (AVENUE.has(hw) || hw === 'motorway') {
      // street lights at the kerb on both sides, staggered; street trees a little further in
      forEachAlong(pts, 17, (x, z, dx, dz, n) => {
        const side = n % 2 ? 1 : -1, nx = -dz, nz = dx;
        const kerb = reach(idx.carriageway, x, z, nx, nz, side, 16);
        const edge = kerb ?? reach(idx.road, x, z, nx, nz, side, 20);
        if (edge == null) return;
        const off = kerb != null ? kerb + 0.45 : edge - 0.5;
        const lx = x + nx * off * side, lz = z + nz * off * side;
        if (inBounds(lx, lz) && !idx.building.has(lx, lz) && free(lx, lz, 6))
          props.push({ kind: PROP.LIGHT, variant: 0, rot: Math.atan2(-nx * side, -nz * side), x: lx, z: lz, scale: 1 });
      }, 5 + (ei % 7));
      forEachAlong(pts, 11, (x, z, dx, dz, n) => {
        for (const side of [1, -1]) {
          const nx = -dz, nz = dx, kerb = reach(idx.carriageway, x, z, nx, nz, side, 16);
          if (kerb == null) continue;
          const tx = x + nx * (kerb + 1.1) * side, tz = z + nz * (kerb + 1.1) * side;
          if (hw !== 'motorway' && idx.sidewalk.has(tx, tz) && hash(n, ei, side) < 0.75) tree(tx, tz, true);
        }
      }, 3 + (ei % 5));
    }

    if (BACKSTREET.has(hw)) {
      // utility poles along one side of the street, joined by wires
      const side = hash(e.way, 3) < 0.5 ? 1 : -1;
      carry = forEachAlong(pts, 30, (x, z, dx, dz) => {
        const nx = -dz, nz = dx, edge = reach(idx.road, x, z, nx, nz, side, 12);
        if (edge == null) { prevPole = null; return; }
        const px = x + nx * (edge - 0.35) * side, pz = z + nz * (edge - 0.35) * side;
        if (!inBounds(px, pz) || idx.building.has(px, pz) || !free(px, pz, 4)) { prevPole = null; return; }
        props.push({ kind: PROP.POLE, variant: hash(px, pz, 4) < 0.35 ? 1 : 0, rot: Math.atan2(dx, dz), x: px, z: pz, scale: 1 });
        if (prevPole && Math.hypot(px - prevPole[0], pz - prevPole[1]) < 55) wires.push([prevPole[0], prevPole[1], px, pz]);
        prevPole = [px, pz];
      }, carry);
    }
  });

  // mapped vending machines, facing a deterministic direction
  for (const [x, z] of vending) {
    if (inBounds(x, z) && !idx.building.has(x, z) && !idx.carriageway.has(x, z))
      props.push({ kind: PROP.VENDING, variant: Math.floor(hash(x, z, 8) * 4), rot: Math.floor(hash(x, z, 11) * 4) * Math.PI / 2, x, z, scale: 1 });
  }
  return { props, wires };
}

// Calls fn(x, z, dirX, dirZ, n) every `step` metres along a polyline, the first call at `start`.
// Returns the distance already covered towards the next point (to continue on a following polyline).
export function forEachAlong(pts, step, fn, start = step / 2) {
  let next = start, walked = 0, n = 0;
  for (let i = 1; i < pts.length; i++) {
    const [ax, az] = pts[i - 1], [bx, bz] = pts[i], len = Math.hypot(bx - ax, bz - az);
    if (len < 1e-6) continue;
    while (next <= walked + len) {
      const t = (next - walked) / len;
      fn(ax + (bx - ax) * t, az + (bz - az) * t, (bx - ax) / len, (bz - az) / len, n++);
      next += step;
    }
    walked += len;
  }
  return next - walked;
}
