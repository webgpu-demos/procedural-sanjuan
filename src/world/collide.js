// Running into things. Everything solid is a capsule: a segment on the ground and a radius round it. A pole, a
// trunk, a hydrant is a segment of no length; a car is its length less its width, its half-width the radius; a
// bench, a bike rack, a bus shelter, a parked car lies along its own axis. The streets' things come with their
// tiles (solidsOf, kept on the tile's group); the vehicles round about are given each frame (dynamic: the
// simulated cars, the procedural traffic, the car parked). The buildings' walls are drive.js's Walls.
import { PROP } from '../shared/tileformat.js';
import { FOOT } from '../shared/roadway.js';

const CELL = 8;

// Closest distance between segments AB and CD (after Ericson, Real-Time Collision Detection 5.1.9)
export function segDist(ax, az, bx, bz, cx, cz, dx, dz) {
  const ux = bx - ax, uz = bz - az, vx = dx - cx, vz = dz - cz, wx = ax - cx, wz = az - cz;
  const a = ux * ux + uz * uz, b = ux * vx + uz * vz, c = vx * vx + vz * vz, d = ux * wx + uz * wz, e = vx * wx + vz * wz;
  const clamp = (t) => (t < 0 ? 0 : t > 1 ? 1 : t);
  let s, t;
  if (a < 1e-9 && c < 1e-9) return Math.hypot(wx, wz);
  if (a < 1e-9) { s = 0; t = clamp(e / c); }
  else if (c < 1e-9) { t = 0; s = clamp(-d / a); }
  else {
    const D = a * c - b * b;
    s = D > 1e-9 ? clamp((b * e - c * d) / D) : 0;
    t = (b * s + e) / c;
    if (t < 0) { t = 0; s = clamp(-d / a); } else if (t > 1) { t = 1; s = clamp((b - d) / a); }
  }
  return Math.hypot(wx + s * ux - t * vx, wz + s * uz - t * vz);
}
// The capsule of a vehicle at (x, z) facing `heading` (0 = +z): [ax, az, bx, bz, r]
export function vehicleCapsule(x, z, heading, L, W, out = []) {
  const h = Math.max(0, L / 2 - W / 2), s = Math.sin(heading) * h, c = Math.cos(heading) * h;
  out[0] = x - s; out[1] = z - c; out[2] = x + s; out[3] = z + c; out[4] = W / 2;
  return out;
}

// A tile's solid props (props: [kind, variant, rot, x, z, scale] flat) in a grid of 8 m cells: Map(key -> [ax, az,
// bx, bz, r, ...]); the long things lie across the way they face (along the street), parked cars along their own
export function solidsOf(props) {
  const cells = new Map();
  const put = (ax, az, bx, bz, r) => {
    const x0 = Math.floor((Math.min(ax, bx) - r) / CELL), x1 = Math.floor((Math.max(ax, bx) + r) / CELL);
    const z0 = Math.floor((Math.min(az, bz) - r) / CELL), z1 = Math.floor((Math.max(az, bz) + r) / CELL);
    for (let i = x0; i <= x1; i++) for (let j = z0; j <= z1; j++) { const k = i + ',' + j; let c = cells.get(k); if (!c) cells.set(k, (c = [])); c.push(ax, az, bx, bz, r); }
  };
  for (let i = 0; i < props.length; i += 6) {
    const kind = props[i], variant = props[i + 1], rot = props[i + 2], x = props[i + 3], z = props[i + 4], scale = props[i + 5];
    if (FOOT[kind] == null) continue;
    const fx = Math.sin(rot), fz = Math.cos(rot), ax = fz, az = -fx; // (facing; across it)
    let r = FOOT[kind] * (kind === PROP.TREE || kind === PROP.STATUE ? scale : 1), h = 0, lx = ax, lz = az;
    if (kind === PROP.PARKED) { h = 1.35; lx = fx; lz = fz; }
    else if (kind === PROP.BUS_STOP && variant === 1) { h = 1.1; r = 0.7; } // (a shelter)
    else if (kind === PROP.BENCH) h = 0.6;
    else if (kind === PROP.BIKES) h = 0.8;
    else if (kind === PROP.TABLE || kind === PROP.PLAY) h = 0.4;
    put(x - lx * h, z - lz * h, x + lx * h, z + lz * h, r);
  }
  return cells;
}

export class Collider {
  // tiles(): the scene's tile groups (their userData.solids)
  constructor(tiles) {
    this.tiles = tiles;
    // the vehicles round about, given each frame: { c: [ax, az, bx, bz, r], y, heading, speed, id }
    this.dynamic = [];
  }
  // Each solid thing near the box (x0, z0)-(x1, z1): fn(ax, az, bx, bz, r, thing) (thing: a vehicle, or null)
  near(x0, z0, x1, z1, y, fn) {
    for (const tile of this.tiles()) {
      const cells = tile.userData.solids;
      if (!cells) continue;
      const b = tile.userData.box;
      if (b && (x1 < b.min.x - CELL || x0 > b.max.x + CELL || z1 < b.min.z - CELL || z0 > b.max.z + CELL)) continue;
      const seen = new Set();
      for (let i = Math.floor(x0 / CELL); i <= Math.floor(x1 / CELL); i++) for (let j = Math.floor(z0 / CELL); j <= Math.floor(z1 / CELL); j++) {
        const c = cells.get(i + ',' + j);
        if (!c) continue;
        for (let k = 0; k < c.length; k += 5) {
          const key = c[k] * 7919 + c[k + 1]; // (a long one spans cells: once)
          if (seen.has(key)) continue; seen.add(key);
          fn(c[k], c[k + 1], c[k + 2], c[k + 3], c[k + 4], null);
        }
      }
    }
    for (const v of this.dynamic) {
      if (y != null && v.y != null && Math.abs(v.y - y) > 3) continue; // (on another level: a deck above, a street below)
      const [ax, az, bx, bz, r] = v.c;
      if (Math.max(ax, bx) + r < x0 || Math.min(ax, bx) - r > x1 || Math.max(az, bz) + r < z0 || Math.min(az, bz) - r > z1) continue;
      fn(ax, az, bx, bz, r, v);
    }
  }
  // Would a capsule of radius r, moving from `from` to `to` ([ax, az, bx, bz] each), run into something? The
  // first thing it would: { vehicle (or null for a fixed thing), depth } or null. A thing it is already inside
  // of does not stop it moving out (set down in a queue, under a tree: it gets free of it).
  blocked(from, to, r, y = null, skip = null) {
    const x0 = Math.min(to[0], to[2]) - r - 3, x1 = Math.max(to[0], to[2]) + r + 3, z0 = Math.min(to[1], to[3]) - r - 3, z1 = Math.max(to[1], to[3]) + r + 3;
    let hit = null;
    this.near(x0, z0, x1, z1, y, (ax, az, bx, bz, R, v) => {
      if (hit || (v && v === skip)) return;
      const dNew = segDist(to[0], to[1], to[2], to[3], ax, az, bx, bz) - r - R;
      if (dNew >= 0) return;
      const dOld = segDist(from[0], from[1], from[2], from[3], ax, az, bx, bz) - r - R;
      if (dOld < 0 && dNew >= dOld - 1e-4) return; // (getting out of it)
      hit = { vehicle: v, depth: -dNew };
    });
    return hit;
  }
}
