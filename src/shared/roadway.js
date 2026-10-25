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
// roads: roads.json. Returns (x, z) => how far inside the nearest corridor (x, z) is (negative: clear of it)
export function laneDepth(roads, cell = 32) {
  const grid = new Map();
  for (const e of roads.edges) {
    if (!DRIVEN.test(e.highway) || e.bridge || e.tunnel || e.flyover || e.span || e.layer) continue; // (raised, or under: not at the props' level)
    const c = corridorOf(e), p = e.pts;
    for (let i = 3; i < p.length; i += 3) {
      const s = [p[i - 3], p[i - 1], p[i], p[i + 2], c];
      const x0 = Math.floor((Math.min(s[0], s[2]) - c - 2) / cell), x1 = Math.floor((Math.max(s[0], s[2]) + c + 2) / cell);
      const z0 = Math.floor((Math.min(s[1], s[3]) - c - 2) / cell), z1 = Math.floor((Math.max(s[1], s[3]) + c + 2) / cell);
      for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) { const k = x + ',' + z; if (!grid.has(k)) grid.set(k, []); grid.get(k).push(s); }
    }
  }
  return (x, z) => {
    let best = -Infinity;
    for (const [ax, az, bx, bz, c] of grid.get(Math.floor(x / cell) + ',' + Math.floor(z / cell)) ?? []) {
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
export function clearLanes(props, wires, depth) {
  const keep = [], gone = [], poles = [];
  for (let i = 0; i < props.length; i += 6) {
    const kind = props[i], rot = props[i + 2];
    let x = props[i + 3], z = props[i + 4];
    if (kind === PROP.DECAL) { keep.push(...props.subarray(i, i + 6)); continue; }
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
