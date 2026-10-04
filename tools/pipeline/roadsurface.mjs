// Road surfaces where there is no survey of them (PLATEAU mapped Tokyo's; San Juan has only centrelines).
// Each OSM road is widened to its right-of-way: the carriageway its lanes need plus a sidewalk on each
// side for its class. The widened roads are merged tile by tile and the buildings cut out of them, so
// streets run from wall to wall in the old city and stop at the kerb line elsewhere. The result is a
// set of road outlines, which tools/pipeline/roadsplit.mjs then divides into carriageway and sidewalk,
// just as it does for PLATEAU's outline-only roads.
// Expressways get no sidewalks: they are laid down as carriageway (with shoulders) directly.
import polygonClipping from 'polygon-clipping';
import { TILE } from '../../src/shared/geo.js';
import { carriageWidth } from './roadsplit.mjs';
import { PolyIndex } from './landscape.mjs';

// sidewalk width (m) on each side, by road class
const SIDEWALK = {
  trunk: 2.6, primary: 2.6, secondary: 2.3, tertiary: 2.1, unclassified: 1.7, residential: 1.7, living_street: 1.2, service: 0.4,
};
const SHOULDER = 1.4; // expressway shoulder, each side

const close = (r) => [...r, r[0]];
const ringArea = (r) => { let s = 0; for (let i = 0; i < r.length; i++) { const [x1, z1] = r[i], [x2, z2] = r[(i + 1) % r.length]; s += x2 * z1 - x1 * z2; } return s / 2; };
// polygon-clipping multipolygon -> open rings, outline counter-clockwise, holes clockwise
function fromClip(multi, minArea) {
  const out = [];
  for (const poly of multi) {
    const rings = poly.map((r) => r.slice(0, -1)).filter((r) => r.length >= 3);
    if (!rings.length || Math.abs(ringArea(rings[0])) < minArea) continue;
    out.push(rings.map((r, i) => ((ringArea(r) > 0) === (i === 0) ? r : [...r].reverse())));
  }
  return out;
}

// Convex pieces covering a polyline widened by h on each side: a box per segment, an octagon per vertex.
const snap = (r) => r.map(([x, z]) => [Math.round(x * 100) / 100, Math.round(z * 100) / 100]);
function widen(pts, h, emit) {
  for (let i = 0; i < pts.length; i++) {
    const [x, z] = pts[i];
    emit(snap(Array.from({ length: 8 }, (_, k) => [x + Math.cos((k + 0.5) * Math.PI / 4) * h * 1.08, z + Math.sin((k + 0.5) * Math.PI / 4) * h * 1.08])));
    if (i === 0) continue;
    const [px, pz] = pts[i - 1], len = Math.hypot(x - px, z - pz);
    if (len < 0.01) continue;
    const nx = (-(z - pz) / len) * h, nz = ((x - px) / len) * h;
    emit(snap([[px - nx, pz - nz], [x - nx, z - nz], [x + nx, z + nz], [px + nx, pz + nz]]));
  }
}

// edges: road graph edges (with .span set: street-level bridges); pos: node id -> [x, z];
// buildings: [{ polygons: [[outer, ...holes]] }] in world metres; bounds: { minX, maxX, minZ, maxZ };
// removable(b): a building that may be dropped if it stands in the middle of a street.
// Returns { outlines: [{ tx, tz, polygon }], motorway: [{ tx, tz, polygon }], removed: Set of buildings, stats }.
export function buildRoadSurfaces({ edges, pos, buildings, bounds, flyover, removable = () => false }) {
  const tiles = new Map(); // "tx_tz" -> { tx, tz, street: [], motorway: [], buildings: [] }
  const tileAt = (tx, tz) => {
    const k = tx + '_' + tz;
    if (!tiles.has(k)) tiles.set(k, { tx, tz, street: [], motorway: [], buildings: [] });
    return tiles.get(k);
  };
  const spread = (ring, list) => {
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const [x, z] of ring) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
    x0 = Math.max(x0, bounds.minX); x1 = Math.min(x1, bounds.maxX); z0 = Math.max(z0, bounds.minZ); z1 = Math.min(z1, bounds.maxZ);
    for (let tx = Math.floor(x0 / TILE); tx <= Math.floor(x1 / TILE); tx++)
      for (let tz = Math.floor(z0 / TILE); tz <= Math.floor(z1 / TILE); tz++) tileAt(tx, tz)[list].push(ring);
  };
  const pieces = [];
  const stats = { edges: 0, motorwayEdges: 0, tiles: 0, failed: 0, skipped: 0, outlines: 0, motorway: 0 };
  for (const e of edges) {
    if (e.tunnel || (e.bridge && !e.span) || flyover(e)) continue;
    const hw = e.highway.replace('_link', ''), pts = e.ids.map(pos), carriage = carriageWidth(e);
    if (hw === 'motorway') {
      stats.motorwayEdges++;
      widen(pts, carriage / 2 + SHOULDER, (r) => spread(r, 'motorway'));
      continue;
    }
    stats.edges++;
    widen(pts, carriage / 2 + (SIDEWALK[hw] ?? 1.5), (r) => { pieces.push(r); spread(r, 'street'); });
  }
  // a removable building (a FEMA outline) lying mostly in the widened streets is a structure over the road
  const streets = new PolyIndex(16);
  for (const r of pieces) streets.add([r]);
  const removed = new Set();
  for (const b of buildings) {
    if (!removable(b)) continue;
    const ring = b.polygons[0][0], inside = ring.filter(([x, z]) => streets.has(x, z)).length / ring.length;
    if (inside > 0.7 && streets.has(b.cx, b.cz)) removed.add(b);
  }
  for (const b of buildings) if (!removed.has(b)) for (const rings of b.polygons) spread(rings[0], 'buildings');

  const outlines = [], motorway = [];
  for (const t of tiles.values()) {
    const box = [[[t.tx * TILE, t.tz * TILE], [(t.tx + 1) * TILE, t.tz * TILE], [(t.tx + 1) * TILE, (t.tz + 1) * TILE], [t.tx * TILE, (t.tz + 1) * TILE], [t.tx * TILE, t.tz * TILE]]];
    const clamp = [[[Math.max(box[0][0][0], bounds.minX), Math.max(box[0][0][1], bounds.minZ)], [Math.min(box[0][1][0], bounds.maxX), Math.max(box[0][1][1], bounds.minZ)],
      [Math.min(box[0][2][0], bounds.maxX), Math.min(box[0][2][1], bounds.maxZ)], [Math.max(box[0][3][0], bounds.minX), Math.min(box[0][3][1], bounds.maxZ)]]];
    clamp[0].push(clamp[0][0]);
    if (clamp[0][1][0] - clamp[0][0][0] < 0.5 || clamp[0][2][1] - clamp[0][1][1] < 0.5) continue;
    stats.tiles++;
    // The buildings come out all at once; if the clipper trips over some degenerate outline, one at a time,
    // leaving out any that it cannot take.
    const cut = (subject) => {
      if (!t.buildings.length || !subject.length) return subject;
      try { return polygonClipping.difference(subject, polygonClipping.union(...t.buildings.map((r) => [close(r)]))); } catch { /* one by one */ }
      for (const r of t.buildings) { try { subject = polygonClipping.difference(subject, [close(r)]); } catch { stats.skipped++; } }
      return subject;
    };
    // likewise the union of the widened roads: piece by piece if all at once fails
    const merge = (rings) => {
      try { return polygonClipping.union(...rings.map((r) => [close(r)])); } catch { /* piece by piece */ }
      let acc = [];
      for (const r of rings) { try { acc = polygonClipping.union(acc, [close(r)]); } catch { stats.skipped++; } }
      return acc;
    };
    try {
      let fast = [];
      if (t.motorway.length) {
        fast = cut(polygonClipping.intersection(clamp, merge(t.motorway)));
        for (const polygon of fromClip(fast, 1)) { motorway.push({ tx: t.tx, tz: t.tz, polygon }); stats.motorway++; }
      }
      if (t.street.length) {
        let street = cut(polygonClipping.intersection(clamp, merge(t.street)));
        if (fast.length) street = polygonClipping.difference(street, fast);
        for (const polygon of fromClip(street, 1)) { outlines.push({ tx: t.tx, tz: t.tz, polygon }); stats.outlines++; }
      }
    } catch { stats.failed++; /* the tile goes without road surfaces */ }
  }
  return { outlines, motorway, removed, stats };
}
