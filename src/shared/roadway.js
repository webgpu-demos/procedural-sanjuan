// What stands in the roadway. The compiler sets street lights, utility poles and signal masts at the kerb of the
// road they belong to, and trees and furniture beside it, but where another road crosses there the kerb of one
// can be out in the lanes of the other. Here a tile's props are checked against its own carriageway: a pole, a
// lamp, a mast, a tree or a piece of furniture whose foot is more than a kerb's width inside it is left out (and
// the wires to a pole left out go with it), and a parked car may stand along the kerb, not out in the lanes.
// Used by the tile worker (meshing.js) and by tools/audit/roadway.mjs, which counts what it leaves out.
import { AREA, PROP } from './tileformat.js';

const KERB = 0.4;     // metres inside the carriageway's edge a thing may still stand (its foot on the kerb line)
const PARKING = 2.4;  // and a parked car's middle (a parking lane along the kerb)

// depth(x, z): how far inside the tile's carriageway (x, z) lies, from its nearest edge; -1 outside it
export function roadwayDepth(areas) {
  const polys = [];
  for (const a of areas) {
    if (a.kind !== AREA.CARRIAGEWAY) continue;
    for (const rings of a.polygons) {
      const r = rings[0];
      let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
      for (let i = 0; i < r.length; i += 2) { x0 = Math.min(x0, r[i]); x1 = Math.max(x1, r[i]); z0 = Math.min(z0, r[i + 1]); z1 = Math.max(z1, r[i + 1]); }
      polys.push({ rings, x0, x1, z0, z1 });
    }
  }
  const inside = (r, x, z) => {
    let c = false;
    for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) {
      const xi = r[i], zi = r[i + 1], xj = r[j], zj = r[j + 1];
      if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) c = !c;
    }
    return c;
  };
  const edge = (r, x, z) => {
    let best = Infinity;
    for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) {
      const ax = r[j], az = r[j + 1], dx = r[i] - ax, dz = r[i + 1] - az, l2 = dx * dx + dz * dz;
      const t = l2 ? Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2)) : 0;
      best = Math.min(best, Math.hypot(x - ax - dx * t, z - az - dz * t));
    }
    return best;
  };
  return (x, z) => {
    for (const p of polys) {
      if (x < p.x0 || x > p.x1 || z < p.z0 || z > p.z1 || !inside(p.rings[0], x, z)) continue;
      if (p.rings.some((h, k) => k > 0 && inside(h, x, z))) continue; // (in a hole: an island, a building)
      return Math.min(...p.rings.map((r) => edge(r, x, z)));
    }
    return -1;
  };
}

// The tile's props and wires without what stands in its roadway; `out` (if given) collects what was left out.
export function clearRoadway(tile, out = null) {
  const depth = roadwayDepth(tile.areas), gone = [];
  const props = tile.props.filter((p) => {
    if (p.kind === PROP.DECAL) return true; // (painted on it)
    const d = depth(p.x, p.z);
    if (d < 0 || d <= (p.kind === PROP.PARKED ? PARKING : KERB)) return true;
    gone.push(p); out?.push({ ...p, depth: d });
    return false;
  });
  if (!gone.length) return { props, wires: tile.wires };
  const poles = gone.filter((p) => p.kind === PROP.POLE), at = (x, z) => poles.some((p) => Math.abs(p.x - x) < 0.05 && Math.abs(p.z - z) < 0.05);
  const wires = [];
  for (let i = 0; i < tile.wires.length; i += 4) if (!at(tile.wires[i], tile.wires[i + 1]) && !at(tile.wires[i + 2], tile.wires[i + 3])) wires.push(...tile.wires.subarray(i, i + 4));
  return { props, wires: Float32Array.from(wires) }; // (wires: [x1, z1, x2, z2] flat, as decoded)
}

// ---------------------------------------------------------------- the lanes cars drive
// The paved surface is not always as wide as the lanes the traffic keeps to (the simulated morning's, on SUMO's
// 3.2 m lanes, and the procedural traffic's): what stands within reach of a car in a road's outer lane is in the
// way however it is paved. The corridor of a road: how far from its centreline that car's body reaches.
const LANE_W = 3.2, HALF_CAR = 0.95;
const DRIVEN = /^(motorway|trunk|primary|secondary|tertiary|unclassified|residential)/;
export function corridorOf(e) {
  if (e.oneway) return ((Math.max(1, e.lanes || 1) - 1) / 2) * LANE_W + HALF_CAR;
  return (Math.max(1, Math.floor((e.lanes || 0) / 2)) - 0.5) * LANE_W + HALF_CAR;
}
// roads: roads.json. Returns (x, z, skip) => how far inside the nearest corridor (x, z) is (negative: clear of it),
// leaving out the roads of OSM way `skip` (a deck's own)
export function laneDepth(roads, cell = 32) {
  const grid = new Map();
  for (const e of roads.edges) {
    // (raised, or in a tunnel: not at the props' level; a road with a layer below the street's, mapped under a
    // bridge, is at street level, and a pier must not stand in it either)
    if (!DRIVEN.test(e.highway) || e.bridge || e.tunnel || e.flyover || e.span || e.layer > 0) continue;
    const c = corridorOf(e), p = e.pts;
    for (let i = 3; i < p.length; i += 3) {
      const s = [p[i - 3], p[i - 1], p[i], p[i + 2], c, e.way];
      const x0 = Math.floor((Math.min(s[0], s[2]) - c - 2) / cell), x1 = Math.floor((Math.max(s[0], s[2]) + c + 2) / cell);
      const z0 = Math.floor((Math.min(s[1], s[3]) - c - 2) / cell), z1 = Math.floor((Math.max(s[1], s[3]) + c + 2) / cell);
      for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) { const k = x + ',' + z; if (!grid.has(k)) grid.set(k, []); grid.get(k).push(s); }
    }
  }
  return (x, z, skip = null) => {
    let best = -Infinity;
    for (const [ax, az, bx, bz, c, way] of grid.get(Math.floor(x / cell) + ',' + Math.floor(z / cell)) ?? []) {
      if (skip != null && way === skip) continue;
      const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz, t = l2 ? Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2)) : 0;
      best = Math.max(best, c - Math.hypot(x - ax - dx * t, z - az - dz * t));
    }
    return best;
  };
}
// How big a prop's foot is (m): what a car or a walker runs into (the capsules of collide.js take their size from here)
export const FOOT = {
  [PROP.TREE]: 0.3, [PROP.POLE]: 0.18, [PROP.LIGHT]: 0.15, [PROP.SIGNAL]: 0.18, [PROP.VENDING]: 0.55, [PROP.BUS_STOP]: 0.2, [PROP.BENCH]: 0.3,
  [PROP.BOLLARD]: 0.1, [PROP.POST_BOX]: 0.35, [PROP.PHONE]: 0.45, [PROP.SUBWAY]: 1.2, [PROP.STATUE]: 0.9, [PROP.BIKES]: 0.4, [PROP.SHRINE]: 0.5,
  [PROP.PARKED]: 0.95, [PROP.HYDRANT]: 0.2, [PROP.INFO]: 0.3, [PROP.TABLE]: 0.7, [PROP.PLAY]: 1.0, [PROP.TORII]: 0.25, [PROP.RAIL_CROSSING]: 0.2,
};
// props: [kind, variant, rot, x, z, scale] flat; wires: [x1, z1, x2, z2] flat; depth: laneDepth(). What stands in a
// corridor is left out (with the wires to a pole left out); a signal mast steps back along its approach till it is
// clear (it shows the junction's lights). Returns { props, wires, gone: [[kind, x, z, depth], ...] }.
// over(kind, x, z, scale): true where the prop would stand up through a deck above it (flyovers.js footprints):
// a palm on the avenue under PR-22 grew out of the expressway's lanes
export function clearLanes(props, wires, depth, over = null) {
  const keep = [], gone = [], poles = [];
  for (let i = 0; i < props.length; i += 6) {
    const kind = props[i], rot = props[i + 2];
    let x = props[i + 3], z = props[i + 4];
    if (kind === PROP.DECAL) { keep.push(...props.subarray(i, i + 6)); continue; }
    if (over && over(kind, x, z, props[i + 5])) { gone.push([kind, x, z, 0]); if (kind === PROP.POLE) poles.push([x, z]); continue; }
    const r = (FOOT[kind] ?? 0.3) * (kind === PROP.TREE || kind === PROP.STATUE ? props[i + 5] : 1), d = depth(x, z) + r;
    if (d > 0 && kind === PROP.SIGNAL) {
      const fx = Math.sin(rot), fz = Math.cos(rot); // (it faces the traffic coming: back along the approach is that way)
      for (let s = 0.5; s <= 12 && depth(x, z) + r > 0; s += 0.5) { x = props[i + 3] + fx * s; z = props[i + 4] + fz * s; }
      if (depth(x, z) + r <= 0) { keep.push(kind, props[i + 1], rot, x, z, props[i + 5]); continue; }
    }
    if (d > 0) { gone.push([kind, x, z, d]); if (kind === PROP.POLE) poles.push([x, z]); continue; }
    keep.push(...props.subarray(i, i + 6));
  }
  const at = (x, z) => poles.some(([px, pz]) => Math.abs(px - x) < 0.05 && Math.abs(pz - z) < 0.05), w = [];
  for (let i = 0; i < wires.length; i += 4) if (!poles.length || (!at(wires[i], wires[i + 1]) && !at(wires[i + 2], wires[i + 3]))) w.push(...wires.subarray(i, i + 4));
  return { props: Float32Array.from(keep), wires: Float32Array.from(w), gone };
}

// ---------------------------------------------------------------- no turn arrows where nothing turns
// The compiler paints turn arrows on every approach of two lanes or more to a junction (tools/pipeline/markings.mjs),
// and on the expressway a junction is a ramp leaving or joining it: no one turns there, and the lanes carry no
// arrows. The approaches to a junction of expressway and ramps only (motorway, trunk and their links; a crossing
// street makes it a junction like any other), over the 70 m before it: [x0, z0, x1, z1, half] per segment, in the
// way travelled. roads: roads.json.
const FREE_FLOW = /^(motorway|trunk)(_link)?$/;
export function mergeApproaches(roads, back = 70) {
  const at = new Map();
  for (const e of roads.edges) for (const n of [e.a, e.b]) (at.get(n) ?? at.set(n, []).get(n)).push(e);
  const merge = (n) => { const es = at.get(n) ?? []; return es.length >= 3 && es.every((e) => FREE_FLOW.test(e.highway)); };
  const out = [];
  for (const e of roads.edges) {
    const n = e.pts.length / 3, half = Math.max(1, e.lanes || 1) * 2.2 + 2;
    for (const fwd of [true, false]) {
      if ((fwd ? e.oneway === -1 : e.oneway === 1) || !merge(fwd ? e.b : e.a)) continue;
      let left = back;
      for (let k = n - 1; k > 0 && left > 0; k--) {
        const i1 = fwd ? k : n - 1 - k, i0 = fwd ? k - 1 : n - k;
        const x0 = e.pts[i0 * 3], z0 = e.pts[i0 * 3 + 2], x1 = e.pts[i1 * 3], z1 = e.pts[i1 * 3 + 2];
        out.push(x0, z0, x1, z1, half);
        left -= Math.hypot(x1 - x0, z1 - z0);
      }
    }
  }
  return Float32Array.from(out);
}
// segs: mergeApproaches(). (p) => whether prop p is a turn arrow on one of those approaches, read the way it runs
export function mergeArrows(segs, cell = 64) {
  const grid = new Map();
  for (let i = 0; i < segs.length; i += 5) {
    const [x0, z0, x1, z1, h] = segs.subarray(i, i + 5);
    for (let a = Math.floor((Math.min(x0, x1) - h) / cell); a <= Math.floor((Math.max(x0, x1) + h) / cell); a++)
      for (let b = Math.floor((Math.min(z0, z1) - h) / cell); b <= Math.floor((Math.max(z0, z1) + h) / cell); b++)
        (grid.get(a * 100003 + b) ?? grid.set(a * 100003 + b, []).get(a * 100003 + b)).push(i);
  }
  return (p) => {
    if (p.kind !== PROP.DECAL || p.variant > 4) return false; // (the arrows: DECAL.THROUGH .. THROUGH_RIGHT)
    const hx = Math.sin(p.rot), hz = Math.cos(p.rot);
    for (const i of grid.get(Math.floor(p.x / cell) * 100003 + Math.floor(p.z / cell)) ?? []) {
      const x0 = segs[i], z0 = segs[i + 1], dx = segs[i + 2] - x0, dz = segs[i + 3] - z0, len = Math.hypot(dx, dz);
      if (len < 0.1 || (dx * hx + dz * hz) / len < 0.7) continue;
      const u = ((p.x - x0) * dx + (p.z - z0) * dz) / len, d = Math.abs((p.x - x0) * -dz + (p.z - z0) * dx) / len;
      if (u >= -2 && u <= len + 2 && d <= segs[i + 4]) return true;
    }
    return false;
  };
}

// The width the tiles pave a road at (tools/pipeline/roadsurface.mjs, and roadsplit.mjs carriageWidth): its
// carriageway (OSM's width where mapped, else its lanes) and an expressway's shoulders or a street's sidewalks.
// { carriage, half }: the carriageway's whole width, and half the paved width.
const LANE = 3.0, SHOULDER = 1.4;
const SIDEWALK = { trunk: 2.6, primary: 2.6, secondary: 2.3, tertiary: 2.1, unclassified: 1.7, residential: 1.7, living_street: 1.2, service: 0.4 };
export function pavedHalf(e, lanes = e.lanes) {
  const carriage = e.width >= 3 && e.width <= 30 ? e.width : lanes >= 2 ? lanes * LANE + 1 : e.oneway ? 4.2 : 5;
  const hw = e.highway.replace('_link', '');
  return { carriage, half: carriage / 2 + (hw === 'motorway' ? SHOULDER : SIDEWALK[hw] ?? 1.5) };
}

// A road's lanes; a bridge's as many as the road it carries on. OSM often tags the lanes on the road and not on the
// bridge, which the compiler then gives its class's default, and a five-lane expressway crossed its creek on a
// two-lane deck, the creek showing either side; so a bridge takes the lanes the road has at both its ends, if more.
// edges: roads.json's. Returns (e) => lanes, or null where none are known.
export function roadLanes(edges) {
  const ends = new Map();
  for (const e of edges) for (const n of [e.a, e.b]) { if (!ends.has(n)) ends.set(n, []); ends.get(n).push(e); }
  const kind = (e) => (e.highway.startsWith('motorway') ? 'motorway' : e.highway.replace('_link', ''));
  return (e) => {
    if (!e.bridge) return e.lanes || null;
    const at = [e.a, e.b].map((n) => Math.max(0, ...(ends.get(n) ?? []).filter((o) => o !== e && !o.bridge && kind(o) === kind(e)).map((o) => o.lanes || 0)));
    const road = at[0] && at[1] ? Math.min(...at) : Math.max(...at);
    return Math.max(e.lanes || 0, road) || null;
  };
}

// The lines the tiles paint on a road (markings.mjs), across its measured carriageway: on the expressway the whole
// paved width, shoulders and all, its lanes dividing it evenly (four-metre lanes on PR-22); on a street, the
// carriageway between the kerbs. [{ o: offset to the right, dashed, yellow }]
export function paintOf(e, lanes, width = pavedHalf(e, lanes)) {
  const hw = e.highway.replace('_link', ''), expressway = hw === 'motorway';
  const median = expressway ? 2 * width.half : width.carriage, n = Math.max(1, Math.min(lanes, Math.floor(median / 2.6))), lw = median / n;
  const lines = [];
  if (!e.oneway && n >= 2) for (const o of [-0.12, 0.12]) lines.push({ o, dashed: false, yellow: true });
  for (let k = 1; k < n; k++) { const o = -median / 2 + k * lw; if (e.oneway || Math.abs(o) >= 0.4) lines.push({ o, dashed: true }); }
  if (hw !== 'tertiary' && median > 6) for (const s of [-1, 1]) lines.push({ o: s * (median / 2 - 0.35), dashed: false, yellow: e.oneway && s < 0 && (hw === 'motorway' || hw === 'trunk') });
  return Object.assign(lines, { lanes: n, lw, median });
}

// ---------------------------------------------------------------- acceleration lanes
// Where a ramp joins the expressway in fewer lanes than they bring (OSM draws most so: the expressway goes on in
// its own lanes), the ramp's lane carries on alongside for ACCEL metres before it ends, as it does on the road: the
// simulation drives it (tools/sim/network.mjs, the expressway's first stretch a lane wider, that lane to the
// outside, the main lanes where the tiles paint them) and the client paves it (meshing.js, past the expressway's
// paved edge, narrowing to nothing over TAPER metres after). Only at grade (a deck is drawn as wide as its road),
// and where the ramp brings one lane. Without it a ramp had to give way to the outer lane, or take turns with it.
//   roads: roads.json; painted: lanes.json's edges (or null). SUMO's lanes on a one-way expressway are the painted
//   ones (network.mjs): n of them, sw wide each (WIDEST at most), the main carriageway's paving `half` either side.
// Returns [{ node, edge, n, sw, half, len, line: [[x, y, z, s], ...] }]: the expressway's centreline from the merge
// (s = 0) to the end of the taper, in the way travelled; len: where the lane ends (the taper after it).
export const ACCEL = 140, TAPER = 40;
const WIDEST = 4.5;
export function accelLanes(roads, painted = null) {
  const E = roads.edges, lanesOf = roadLanes(E), signals = new Set(roads.signals ?? []);
  const fast = (e) => /^(motorway|trunk)(_link)?$/.test(e.highway), link = (e) => e.highway.endsWith('_link');
  const sumo = (i) => { const e = E[i], p = painted?.[i] ?? paintOf(e, Math.max(1, lanesOf(e) || e.lanes || 1)); return { n: p.lanes, sw: Math.min(WIDEST, p.lw) }; };
  const ins = new Map(), outs = new Map(), at = new Map();
  E.forEach((e, i) => {
    for (const n of [e.a, e.b]) at.set(n, (at.get(n) ?? 0) + 1);
    if (!e.oneway || !fast(e)) return;
    const [a, b] = e.oneway === -1 ? [e.b, e.a] : [e.a, e.b];
    (ins.get(b) ?? ins.set(b, []).get(b)).push(i); (outs.get(a) ?? outs.set(a, []).get(a)).push(i);
  });
  const grade = (e) => !e.bridge && !e.tunnel && !e.flyover && !e.span;
  // (an edge's centreline in the way travelled, [x, y, z] each)
  const line = (i) => { const e = E[i], p = []; for (let k = 0; k < e.pts.length; k += 3) p.push([e.pts[k], e.pts[k + 1], e.pts[k + 2]]); return e.oneway === -1 ? p.reverse() : p; };
  const out = [];
  for (const [node, I] of ins) {
    const O = outs.get(node) ?? [];
    if (O.length !== 1 || I.length !== 2 || signals.has(node) || at.get(node) !== 3) continue;
    const o = O[0], eo = E[o], mains = I.filter((i) => !link(E[i])), ramps = I.filter((i) => link(E[i]));
    if (link(eo) || mains.length !== 1 || ramps.length !== 1 || !grade(eo)) continue;
    const { n, sw } = sumo(o), m = sumo(mains[0]), r = sumo(ramps[0]);
    if (r.n !== 1 || m.n + r.n !== n + 1) continue;
    // along the expressway from the merge, on through nodes where nothing else meets, at grade, as many lanes
    const pts = [];
    let s = 0, i = o, from = node;
    for (;;) {
      for (const p of line(i)) {
        if (pts.length) { const q = pts.at(-1); s += Math.hypot(p[0] - q[0], p[2] - q[2]); if (Math.hypot(p[0] - q[0], p[2] - q[2]) < 0.01) continue; }
        pts.push([p[0], p[1], p[2], s]);
      }
      if (s >= ACCEL + TAPER) break;
      const end = E[i].oneway === -1 ? E[i].a : E[i].b, next = outs.get(end) ?? [];
      if (signals.has(end) || at.get(end) !== 2 || next.length !== 1 || (ins.get(end) ?? []).length !== 1) break;
      const j = next[0];
      if (!grade(E[j]) || link(E[j]) || sumo(j).n !== n) break;
      from = end; i = j;
    }
    if (s < 70) continue;
    const len = Math.min(ACCEL, s - 10), stop = Math.min(s, len + TAPER);
    const cut = [];
    for (const p of pts) {
      if (p[3] <= stop) { cut.push(p); continue; }
      const q = cut.at(-1), f = (stop - q[3]) / (p[3] - q[3]);
      cut.push([q[0] + (p[0] - q[0]) * f, q[1] + (p[1] - q[1]) * f, q[2] + (p[2] - q[2]) * f, stop]);
      break;
    }
    out.push({ node, edge: o, n, sw, half: pavedHalf(eo, lanesOf(eo)).half, len, line: cut });
  }
  return out;
}
// The paving of an acceleration lane: quads [x0, z0, x1, z1, x2, z2, x3, z3] (in the order round), from the
// expressway's paved edge (a little inside it) out to its outer edge, narrowing over the taper. And its outer
// edge line, as thin quads: { pave, line }
export function accelPaving(lane, step = 4) {
  const { line: L, len, n, sw, half } = lane, inner = Math.min(half, (n / 2) * sw) - 0.15, outer = (n / 2 + 1) * sw;
  // (the lane's outer edge, by how far along: full to len, then narrowing)
  const edge = (s) => (s <= len ? outer : outer - (outer - inner - 0.15) * Math.min(1, (s - len) / TAPER));
  const at = (s) => {
    let k = 1; while (k < L.length - 1 && L[k][3] < s) k++;
    const a = L[k - 1], b = L[k], f = Math.max(0, Math.min(1, (s - a[3]) / ((b[3] - a[3]) || 1)));
    const dx = b[0] - a[0], dz = b[2] - a[2], l = Math.hypot(dx, dz) || 1;
    return [a[0] + dx * f, a[2] + dz * f, -dz / l, dx / l]; // (x, z, and the normal to the right of the way: x east, z south)
  };
  const total = L.at(-1)[3], pave = [], lines = [];
  for (let s = 0; s < total - 0.01; s += step) {
    const t = Math.min(total, s + step), [x0, z0, nx0, nz0] = at(s), [x1, z1, nx1, nz1] = at(t);
    const o0 = edge(s), o1 = edge(t);
    pave.push([x0 + nx0 * inner, z0 + nz0 * inner, x1 + nx1 * inner, z1 + nz1 * inner, x1 + nx1 * o1, z1 + nz1 * o1, x0 + nx0 * o0, z0 + nz0 * o0]);
    if (s < len + TAPER) {
      const a0 = o0 - 0.35, a1 = o1 - 0.35, b0 = a0 - 0.15, b1 = a1 - 0.15;
      if (a0 > inner + 0.3 && a1 > inner + 0.3) lines.push([x0 + nx0 * b0, z0 + nz0 * b0, x1 + nx1 * b1, z1 + nz1 * b1, x1 + nx1 * a1, z1 + nz1 * a1, x0 + nx0 * a0, z0 + nz0 * a0]);
    }
  }
  return { pave, line: lines };
}

// The acceleration lanes' paving and lines as the tiles take them: { pave, line } flat Float32Arrays of quads (8 numbers
// each), for the tile workers (accelTiles), and a test of whether (x, z) lies on one (onAccel: GroundRoads, guard rails).
export function accelQuads(lanes) {
  const pave = [], line = [];
  for (const l of lanes) { const q = accelPaving(l); for (const v of q.pave) pave.push(...v); for (const v of q.line) line.push(...v); }
  return { pave: Float32Array.from(pave), line: Float32Array.from(line) };
}
const inQuad = (q, o, x, z, pad = 0) => {
  // (convex, in either winding: the point on the same side of all four edges, within pad)
  let pos = 0, neg = 0;
  for (let k = 0; k < 4; k++) {
    const ax = q[o + k * 2], az = q[o + k * 2 + 1], bx = q[o + ((k + 1) % 4) * 2], bz = q[o + ((k + 1) % 4) * 2 + 1];
    const l = Math.hypot(bx - ax, bz - az) || 1, c = ((bx - ax) * (z - az) - (bz - az) * (x - ax)) / l;
    if (c > -pad) pos++; if (c < pad) neg++;
  }
  return pos === 4 || neg === 4;
};
// quads: accelQuads().pave. Returns (x, z, pad) => whether (x, z) is on one (within pad metres)
export function accelLookup(quads, cell = 32) {
  const grid = new Map();
  for (let o = 0; o < quads.length; o += 8) {
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (let k = 0; k < 4; k++) { x0 = Math.min(x0, quads[o + k * 2]); x1 = Math.max(x1, quads[o + k * 2]); z0 = Math.min(z0, quads[o + k * 2 + 1]); z1 = Math.max(z1, quads[o + k * 2 + 1]); }
    for (let a = Math.floor((x0 - 1) / cell); a <= Math.floor((x1 + 1) / cell); a++) for (let b = Math.floor((z0 - 1) / cell); b <= Math.floor((z1 + 1) / cell); b++)
      (grid.get(a * 100003 + b) ?? grid.set(a * 100003 + b, []).get(a * 100003 + b)).push(o);
  }
  return (x, z, pad = 0) => (grid.get(Math.floor(x / cell) * 100003 + Math.floor(z / cell)) ?? []).some((o) => inQuad(quads, o, x, z, pad));
}
// A tile's share of them (the quads whose middle is in it) as areas, as decodeTile gives them: the paving a
// carriageway, its line paint; and the tile's guard rails along the expressway's old edge, where the lane runs, gone.
export function accelTile(tile, quads, tileSize, on = null) {
  const x0 = tile.tx * tileSize, z0 = tile.tz * tileSize, mine = (q, o) => {
    const mx = (q[o] + q[o + 2] + q[o + 4] + q[o + 6]) / 4, mz = (q[o + 1] + q[o + 3] + q[o + 5] + q[o + 7]) / 4;
    return mx >= x0 && mx < x0 + tileSize && mz >= z0 && mz < z0 + tileSize;
  };
  // (wound as the compiler winds its rings, or the meshes face down and are not drawn)
  const wound = (r) => { let a = 0; for (let i = 0; i < 4; i++) { const j = (i + 1) % 4; a += r[i * 2] * r[j * 2 + 1] - r[j * 2] * r[i * 2 + 1]; } return a > 0 ? [r[6], r[7], r[4], r[5], r[2], r[3], r[0], r[1]] : r; };
  const rings = (q) => { const out = []; for (let o = 0; o < q.length; o += 8) if (mine(q, o)) out.push([wound(Array.from(q.subarray(o, o + 8)))]); return out; };
  const pave = rings(quads.pave), line = rings(quads.line);
  if (!pave.length && !line.length && !on) return tile;
  const areas = [...tile.areas];
  if (pave.length) areas.push({ kind: AREA.CARRIAGEWAY, code: 0, polygons: pave });
  if (line.length) areas.push({ kind: AREA.MARK_WHITE, code: 0, polygons: line });
  let walls = tile.walls;
  if (on && walls?.length) {
    const keep = [];
    for (let i = 0; i < walls.length; i += 5) {
      if (walls[i + 4] < 0 && on((walls[i] + walls[i + 2]) / 2, (walls[i + 1] + walls[i + 3]) / 2, 0.6)) continue; // (a barrier across the lane)
      for (let k = 0; k < 5; k++) keep.push(walls[i + k]);
    }
    if (keep.length !== walls.length) walls = Float32Array.from(keep);
  }
  return { ...tile, areas, walls };
}
