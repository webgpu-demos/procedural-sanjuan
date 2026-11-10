// Buildings clear of the streets: no road running into a wall, no building standing in a road.
//
// The outlines and the centrelines come from different hands (OSM's mappers, the imports behind them, FEMA's
// outlines read off imagery), and nothing made them agree. The tiles cut every building out of the widened roads
// (roadsurface.mjs), so where a centreline ran into a footprint the paving stopped at a wall, and the centreline
// with its paint, its walkers and its traffic went on through. Measured over San Juan: 249 of 164,027 buildings
// crossed, 236 of them by a road drawn at street level, 5.2 km of centreline inside them; a FEMA-only outline 25
// times as likely as an OSM one (2.28% against 0.089%). What they are: a road OSM itself says passes under the
// building (covered=*, a car park, a mall, a Tren Urbano station over its avenue: 87), a low roof astride the road
// (a toll plaza's canopy, the gate house of an urbanización, a carport: most of the 93 FEMA ones, 87 of them under
// 8 m), a house an imported outline put on its street (some 30).
//
// The rule, for every building a drawn street-level centreline enters by ENTER metres or more:
//   corridor   the entering roads widened to their carriageway (roadsplit.mjs carriageWidth) and CLEARANCE beside
//              it; the expressway, to its paved half (its shoulders)
//   remainder  the footprint without the corridor, pieces under SLIVER m2 left out
//   removed    if less than LEAST of its area remains; or if it is low and the road takes half of it or more, or
//              small and low and the road cuts it in two (a canopy, a toll booth, a gate house: a roof over the
//              road, not a building in it)
//   notched    otherwise: the remainder is the building, in as many pieces as the road left (an open slot through
//              a mall, a car park, a station)
// A road that only ends inside (a driveway into a garage, a cul-de-sac's last metres) is given its slot as any
// other, but it never takes a large building away.
//
// Used by the compiler before the buildings are cut out of the roads (compile.mjs: the surface then comes out
// continuous by construction), and by clearroads.mjs on an area compiled before, which also paves the slot.
//
// Not done here, and what it would take: a roofed passage (the upper floors carried over the slot). The tile format
// has no building raised off the ground with a drawn underside: a building's walls run SINK metres below its base
// and it has no floor (src/world/meshing.js). It would take a flag on the record (raised: no sink, the footprint
// drawn again facing down at its base), the slot's piece of the footprint kept as a second record at base + 4.5 m,
// and `covered` on the road (osm.mjs now writes it) to tell a passage from a street an outline was dropped on.
import polygonClipping from 'polygon-clipping';
import { carriageWidth } from './roadsplit.mjs';

export const ENTER = 0.5;       // metres of centreline inside a footprint: less is a corner brushed, not a road through it
export const CLEARANCE = 0.75;  // metres kept clear beside the carriageway, each side
const SHOULDER = 1.4;           // (roadsurface.mjs: the expressway is paved to its shoulders)
export const SLIVER = 12;       // m2: a piece of a cut footprint smaller than this is not left standing
export const LEAST = 0.35;      // the share of its area a building must keep
export const HALF = 0.5;        // and a low one, with a road through it
export const SMALL = { height: 8, area: 500 }; // a canopy, a toll booth, a gate house: no taller, no larger (m, m2)
const OVERLAP = 0.4;            // metres the slot's paving runs on past the old wall line, into the paving that stopped there

// The roads the tiles draw at street level (roadsurface.mjs): not a tunnel, unless it is a passage through a
// building (tunnel=building_passage: at street level, under the floors above); not a bridge, unless it is a span
// from bank to bank. Flyovers are bridges.
export const drawn = (e) => !(e.bridge && !e.span) && (!e.tunnel || !!e.passage);
// half the width cleared for a road
export const corridorHalf = (e) => carriageWidth(e) / 2 + (e.highway.startsWith('motorway') ? SHOULDER : CLEARANCE);

const r2 = (v) => Math.round(v * 100) / 100;
const close = (r) => [...r, r[0]];
// Signed area seen from above, positive = counter-clockwise (x east, z south): as compile.mjs areaEN
const ringArea = (r) => { let s = 0; for (let i = 0, n = r.length; i < n; i++) { const [x1, z1] = r[i], [x2, z2] = r[(i + 1) % n]; s += x2 * z1 - x1 * z2; } return s / 2; };
// polygons: [[outer, ...holes], ...], rings of [x, z]
export const areaOf = (polygons) => polygons.reduce((s, rings) => s + rings.reduce((t, r, i) => t + (i ? -1 : 1) * Math.abs(ringArea(r)), 0), 0);
// a decoded tile's rings (Float32Array [x, z, ...], src/shared/tileformat.js) as rings of [x, z]
export const pairs = (polygons) => polygons.map((rings) => rings.map((r) => (typeof r[0] === 'number' ? Array.from({ length: r.length / 2 }, (_, i) => [r[i * 2], r[i * 2 + 1]]) : r)));
export function inPolygons(x, z, polygons) {
  for (const rings of polygons) {
    let inside = false;
    for (const r of rings) for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const [xi, zi] = r[i], [xj, zj] = r[j];
      if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
    }
    if (inside) return true;
  }
  return false;
}
const bounds = (polygons, grow = 0) => {
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const rings of polygons) for (const [x, z] of rings[0]) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
  return [x0 - grow, z0 - grow, x1 + grow, z1 + grow];
};

// polygon-clipping multipolygon -> our polygons: open rings in centimetres, outline counter-clockwise, holes
// clockwise, pieces under minArea left out, the largest first
function fromClip(multi, minArea) {
  const tidy = (ring) => {
    const r = ring.slice(0, -1).map(([x, z]) => [r2(x), r2(z)]).filter((p, i, a) => { const q = a[(i + a.length - 1) % a.length]; return a.length < 2 || p[0] !== q[0] || p[1] !== q[1]; });
    return r.length >= 3 ? r : null;
  };
  const out = [];
  for (const poly of multi) {
    const outer = tidy(poly[0]);
    if (!outer || Math.abs(ringArea(outer)) < 0.01) continue;
    const rings = [outer, ...poly.slice(1).map(tidy).filter((h) => h && Math.abs(ringArea(h)) >= 0.1)].map((r, i) => ((ringArea(r) > 0) === (i === 0) ? r : [...r].reverse()));
    if (areaOf([rings]) >= minArea) out.push(rings);
  }
  return out.sort((a, b) => areaOf([b]) - areaOf([a]));
}
const toClip = (polygons) => polygons.map((rings) => rings.map(close));
// all at once, or piece by piece if the clipper trips over a degenerate outline (as roadsurface.mjs does)
function union(pieces) {
  if (!pieces.length) return [];
  try { return polygonClipping.union(...pieces); } catch { /* piece by piece */ }
  // (polygon-clipping now and then cannot close a ring where two pieces' edges nearly touch: that piece moved by a few
  // millimetres, and only if it still fails left out)
  let acc = [];
  const moved = (p, d) => p.map((r) => r.map(([x, z]) => [x + d, z + d * 0.7]));
  for (const p of pieces) {
    for (const d of [0, 0.004, -0.004, 0.011]) { try { acc = polygonClipping.union(acc, d ? moved(p, d) : p); break; } catch { /* again, moved */ } }
  }
  return acc;
}

// Convex pieces covering a polyline [x, z] pairs widened by h on each side (a box per segment, an octagon per
// vertex: roadsurface.mjs widen), those that reach the box [x0, z0, x1, z1]
function widened(pts, h, box, closed = false) {
  const out = [], n = pts.length, R = h * 1.08;
  for (let i = 0; i < n + (closed ? 1 : 0); i++) {
    const [x, z] = pts[i % n];
    if (i < n && x + R >= box[0] && x - R <= box[2] && z + R >= box[1] && z - R <= box[3])
      out.push([close(Array.from({ length: 8 }, (_, k) => [r2(x + Math.cos((k + 0.5) * Math.PI / 4) * R), r2(z + Math.sin((k + 0.5) * Math.PI / 4) * R)]))]);
    if (i === 0) continue;
    const [px, pz] = pts[i - 1], len = Math.hypot(x - px, z - pz);
    if (len < 0.01 || Math.max(x, px) + h < box[0] || Math.min(x, px) - h > box[2] || Math.max(z, pz) + h < box[1] || Math.min(z, pz) - h > box[3]) continue;
    const nx = (-(z - pz) / len) * h, nz = ((x - px) / len) * h;
    out.push([close([[r2(px - nx), r2(pz - nz)], [r2(x - nx), r2(z - nz)], [r2(x + nx), r2(z + nz)], [r2(px + nx), r2(pz + nz)]])]);
  }
  return out;
}
const line = (e) => { const p = e.pts, out = []; for (let k = 0; k < p.length; k += 3) out.push([p[k], p[k + 2]]); return out; };

// edges: roads.json's ({ a, b, pts: [x, y, z, ...], highway, lanes, width, oneway, bridge, tunnel, span, passage }).
// The drawn ones' segments in cells of `cell` metres, and how many edges meet at each node (a road's own end at a
// node nothing else meets is a dead end).
export function roadIndex(edges, cell = 64) {
  const cells = new Map(), segs = [], degree = new Map();
  for (const e of edges) for (const n of [e.a, e.b]) degree.set(n, (degree.get(n) ?? 0) + 1);
  edges.forEach((e, ei) => {
    if (!drawn(e)) return;
    const p = e.pts;
    for (let k = 3; k < p.length; k += 3) {
      const si = segs.length / 5;
      segs.push(p[k - 3], p[k - 1], p[k], p[k + 2], ei);
      for (let i = Math.floor(Math.min(p[k - 3], p[k]) / cell); i <= Math.floor(Math.max(p[k - 3], p[k]) / cell); i++)
        for (let j = Math.floor(Math.min(p[k - 1], p[k + 2]) / cell); j <= Math.floor(Math.max(p[k - 1], p[k + 2]) / cell); j++) {
          const key = i * 100003 + j;
          let c = cells.get(key);
          if (!c) cells.set(key, (c = []));
          c.push(si);
        }
    }
  });
  return { edges, cells, segs, cell, degree };
}

// The length of segment a-b inside the polygons (even-odd over each one's rings), and the middle of its longest
// stretch inside as a share of the way from a to b
function insideLength(ax, az, bx, bz, polygons) {
  const dx = bx - ax, dz = bz - az, len = Math.hypot(dx, dz);
  let inside = 0, best = 0, mid = 0.5;
  for (const rings of polygons) {
    const ts = [0, 1];
    for (const r of rings) for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const cx = r[j][0], cz = r[j][1], ex = r[i][0] - cx, ez = r[i][1] - cz, den = dx * ez - dz * ex;
      if (Math.abs(den) < 1e-12) continue;
      const t = ((cx - ax) * ez - (cz - az) * ex) / den, u = ((cx - ax) * dz - (cz - az) * dx) / den;
      if (t > 0 && t < 1 && u >= 0 && u <= 1) ts.push(t);
    }
    ts.sort((a, b) => a - b);
    for (let k = 1; k < ts.length; k++) {
      const t0 = ts[k - 1], t1 = ts[k];
      if (t1 - t0 < 1e-9 || !inPolygons(ax + dx * (t0 + t1) / 2, az + dz * (t0 + t1) / 2, [rings])) continue;
      const l = (t1 - t0) * len;
      inside += l;
      if (l > best) { best = l; mid = (t0 + t1) / 2; }
    }
  }
  return { inside, best, mid };
}

// The drawn roads that enter the polygons by ENTER metres or more: [{ ei, inside (m), x, z (the middle of the
// longest stretch inside), through (false: the road only ends in there, at a dead end) }]
export function entering(index, polygons) {
  const { edges, cells, segs, cell, degree } = index, box = bounds(polygons), seen = new Set(), hits = new Map();
  for (let i = Math.floor(box[0] / cell); i <= Math.floor(box[2] / cell); i++)
    for (let j = Math.floor(box[1] / cell); j <= Math.floor(box[3] / cell); j++)
      for (const si of cells.get(i * 100003 + j) ?? []) {
        if (seen.has(si)) continue;
        seen.add(si);
        const o = si * 5, ax = segs[o], az = segs[o + 1], bx = segs[o + 2], bz = segs[o + 3], ei = segs[o + 4];
        if (Math.max(ax, bx) < box[0] || Math.min(ax, bx) > box[2] || Math.max(az, bz) < box[1] || Math.min(az, bz) > box[3]) continue;
        const r = insideLength(ax, az, bx, bz, polygons);
        if (!r.inside) continue;
        let h = hits.get(ei);
        if (!h) hits.set(ei, (h = { ei, inside: 0, best: 0, x: 0, z: 0 }));
        h.inside += r.inside;
        if (r.best > h.best) { h.best = r.best; h.x = ax + (bx - ax) * r.mid; h.z = az + (bz - az) * r.mid; }
      }
  const out = [];
  for (const h of hits.values()) {
    if (h.inside < ENTER) continue;
    const e = edges[h.ei], p = e.pts;
    const ends = [...(degree.get(e.a) === 1 ? [[p[0], p[2]]] : []), ...(degree.get(e.b) === 1 ? [[p.at(-3), p.at(-1)]] : [])];
    out.push({ ei: h.ei, inside: h.inside, x: h.x, z: h.z, through: !ends.some(([x, z]) => inPolygons(x, z, polygons)) });
  }
  return out;
}

// polygons: a building's footprint ([[outer, ...holes], ...], rings of [x, z], world metres); height: the building's (m).
// Returns null where no drawn road enters it, else
//   { action: 'remove' | 'notch', polygons (the remainder: [] when removed), left (the share of the area that remains),
//     pieces (how many), through, roads: entering()'s, corridor (the cleared strip, as the clipper has it), area }
// or { action: 'failed' } where the clipper could not cut it (the building is left as it is).
export function resolve(index, polygons, height) {
  const roads = entering(index, polygons);
  if (!roads.length) return null;
  const area = areaOf(polygons), box = bounds(polygons), through = roads.some((r) => r.through);
  const strips = roads.flatMap((r) => { const e = index.edges[r.ei]; return widened(line(e), corridorHalf(e), box); });
  const corridor = union(strips);
  let rest;
  try { rest = polygonClipping.difference(toClip(polygons), corridor); } catch {
    try { rest = toClip(polygons); for (const s of strips) rest = polygonClipping.difference(rest, s); } catch { return { action: 'failed', roads, area }; }
  }
  const whole = fromClip(rest, 0.01), kept = whole.filter((p) => areaOf([p]) >= SLIVER), left = area > 0 ? areaOf(kept) / area : 0;
  const low = height <= SMALL.height, small = low && area <= SMALL.area;
  // (a road that only ends in there never takes a large building away)
  const remove = !kept.length || (left < LEAST && (through || area <= SMALL.area)) || (low && through && left < HALF) || (small && through && kept.length >= 2);
  return { action: remove ? 'remove' : 'notch', polygons: remove ? [] : kept, left: remove ? 0 : left, pieces: kept.length, through, roads, corridor, area };
}

// The paving of a slot, for an area compiled before (clearroads.mjs: its road surface stops at the old walls): the
// corridor within the old footprint, and OVERLAP metres on past its outline into the paving that stopped there.
// result: resolve()'s; polygons: the footprint as it was. -> [[outer, ...holes], ...]
export function slotPaving(result, polygons) {
  const box = bounds(polygons, 2);
  // (the footprint grown by OVERLAP: its outline widened, and joined to it)
  const grown = union([toClip(polygons), ...polygons.flatMap((rings) => rings.flatMap((r) => widened(r, OVERLAP, box, true)))]);
  try { return fromClip(polygonClipping.intersection(result.corridor, grown), 0.2); } catch { return []; }
}
// polygons within the box [x0, z0, x1, z1] (a tile's: its paving is filed by tile, as the compiler files it)
export function clipBox(polygons, x0, z0, x1, z1, minArea = 0.2) {
  try { return fromClip(polygonClipping.intersection(toClip(polygons), [[[x0, z0], [x1, z0], [x1, z1], [x0, z1], [x0, z0]]]), minArea); } catch { return []; }
}
// a road's whole carriageway and the clearance beside it (a passage through a building: no paving was laid along it),
// or of the stretch that reaches the box [x0, z0, x1, z1]
export const roadStrip = (e, box) => { const pts = line(e); return fromClip(union(widened(pts, corridorHalf(e), box ?? bounds([[pts]]))), 0.2); };
// whether (x, z) is in the strip cleared for result's roads
export const inCorridor = (result, x, z) => result.corridor.some((poly) => inPolygons(x, z, [poly]));
