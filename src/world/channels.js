// Rivers, canals, streams and ditches (channels.json: tools/pipeline/channels.mjs): water lying level from bank to
// bank, falling the way it flows, in a channel cut into the ground. The terrain grid is 10 m: no channel narrower
// than that can be cut into it, so each tile takes the ground out from over the channels (the terrain's triangles
// and the cover draped on it: cut) and draws them itself (channelMesh): the water, the two banks from just under
// it up to the ground on either side, and a wall across where a channel stops (at a road it goes under).
// Pure functions, for the tile worker.
import { sampleGrid } from '../shared/terrain.js';
import { createDraper } from './drape.js';
import { GROUND } from './constants.js';
import { bankRun, END } from '../shared/channelshape.js';

const srgb = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const lin = (rgb) => rgb.map(srgb);
// river, canal, stream, ditch: the banks (grown over along rivers and streams, concrete for canals and ditches)
const BANK = [
  { color: lin([0.37, 0.41, 0.25]), layer: GROUND.GRASS },
  { color: lin([0.6, 0.59, 0.55]), layer: GROUND.CONCRETE },
  { color: lin([0.37, 0.43, 0.25]), layer: GROUND.GRASS },
  { color: lin([0.6, 0.59, 0.55]), layer: GROUND.CONCRETE },
];
const WATER = { color: lin([0.15, 0.24, 0.2]), layer: GROUND.WATER }; // (a river in the city: greener and browner than the sea)
const UNDER = 0.25; // the banks reach this far under the water
const LIP = 0.05;   // and stand this far over the ground (no crack along their top)

const cross = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
function clip(poly, f) {
  const out = [];
  let a = poly[poly.length - 1], fa = f(a);
  for (const b of poly) {
    const fb = f(b);
    if ((fa >= 0) !== (fb >= 0)) { const t = fa / (fa - fb); out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]); }
    if (fb >= 0) out.push(b);
    a = b; fa = fb;
  }
  return out;
}
const area2 = (p) => { let s = 0; for (let i = 0; i < p.length; i++) { const a = p[i], b = p[(i + 1) % p.length]; s += a[0] * b[1] - b[0] * a[1]; } return s; };
// The pieces of the convex polygon `poly` outside the convex polygon `cut` (its corners in the order cross() > 0).
function subtract(poly, cut) {
  const out = [];
  let rest = poly;
  for (let k = 0; k < cut.length && rest.length >= 3; k++) {
    const a = cut[k], b = cut[(k + 1) % cut.length], side = (p) => cross(a, b, p);
    const outside = clip(rest, (p) => -side(p));
    if (outside.length >= 3 && Math.abs(area2(outside)) > 1e-6) out.push(outside);
    rest = clip(rest, side);
  }
  return out;
}

// data: channels.json; grid: the terrain. Each channel's water: the line offset half its width either side, mitred
// at the bends; its banks: from there out to where they meet the ground (sloping: src/shared/channelshape.js).
export function prepareChannels(data, tileSize, grid) {
  const cuts = new Map(), draws = new Map();
  const add = (map, k, v) => { if (!map.has(k)) map.set(k, []); map.get(k).push(v); };
  const ground = (x, z) => sampleGrid(grid, x, z);
  for (const c of data?.channels ?? []) {
    const p = c.p, n = p.length / 3, half = c.w / 2, k = c.k;
    const inner = [new Float64Array(n * 2), new Float64Array(n * 2)], outer = [new Float64Array(n * 2), new Float64Array(n * 2)];
    const normal = (i) => { const dx = p[i * 3 + 3] - p[i * 3], dz = p[i * 3 + 4] - p[i * 3 + 1], l = Math.hypot(dx, dz) || 1; return [-dz / l, dx / l]; };
    for (let i = 0; i < n; i++) {
      const a = normal(Math.max(0, i - 1)), b = normal(Math.min(n - 2, i));
      let mx = a[0] + b[0], mz = a[1] + b[1];
      const ml = Math.hypot(mx, mz) || 1;
      mx /= ml; mz /= ml;
      const scale = 1 / Math.max(0.55, mx * b[0] + mz * b[1]), x = p[i * 3], z = p[i * 3 + 1], level = p[i * 3 + 2];
      [1, -1].forEach((side, s) => {
        const ox = mx * side * scale, oz = mz * side * scale;
        // the bank's height: the ground a little beyond the water's edge, over the water
        const run = bankRun(k, ground(x + ox * (half + 1.5), z + oz * (half + 1.5)) - level);
        inner[s][i * 2] = x + ox * half; inner[s][i * 2 + 1] = z + oz * half;
        outer[s][i * 2] = x + ox * (half + run); outer[s][i * 2 + 1] = z + oz * (half + run);
      });
    }
    const e = c.e ?? 0, [L, R] = outer;
    // where the waterway begins or ends, a bank slopes up across it as far as its sides run out: the outer corners
    // there carried on along the line (caps[0] the start's, caps[1] the end's)
    const caps = [null, null];
    for (const [end, flag, i, j] of [[0, END.SOURCE_START, 0, 1], [1, END.SOURCE_END, n - 1, n - 2]]) {
      if (!(e & flag) || e & (end ? END.OPEN_END : END.OPEN_START)) continue;
      const dx = p[i * 3] - p[j * 3], dz = p[i * 3 + 1] - p[j * 3 + 1], l = Math.hypot(dx, dz) || 1;
      const run = (Math.hypot(L[i * 2] - inner[0][i * 2], L[i * 2 + 1] - inner[0][i * 2 + 1]) + Math.hypot(R[i * 2] - inner[1][i * 2], R[i * 2 + 1] - inner[1][i * 2 + 1])) / 2;
      caps[end] = [[L[i * 2] + dx / l * run, L[i * 2 + 1] + dz / l * run], [R[i * 2] + dx / l * run, R[i * 2 + 1] + dz / l * run]];
    }
    const ch = { k, e, n, p, inner, outer, caps };
    // the ground taken out: as triangles (a quad at a sharp bend can fold), each with its corners in cross() > 0 order
    const cutTri = (t) => {
      if (Math.abs(cross(...t)) < 1e-8) return;
      const tri = cross(...t) > 0 ? t : [t[0], t[2], t[1]];
      const box = [Math.min(tri[0][0], tri[1][0], tri[2][0]), Math.min(tri[0][1], tri[1][1], tri[2][1]),
        Math.max(tri[0][0], tri[1][0], tri[2][0]), Math.max(tri[0][1], tri[1][1], tri[2][1])];
      for (let tx = Math.floor(box[0] / tileSize); tx <= Math.floor(box[2] / tileSize); tx++)
        for (let tz = Math.floor(box[1] / tileSize); tz <= Math.floor(box[3] / tileSize); tz++) add(cuts, `${tx},${tz}`, { tri, box });
    };
    if (caps[0]) { const q = [caps[0][0], [L[0], L[1]], [R[0], R[1]], caps[0][1]]; cutTri([q[0], q[1], q[2]]); cutTri([q[0], q[2], q[3]]); }
    if (caps[1]) { const m = (n - 1) * 2, q = [[L[m], L[m + 1]], caps[1][0], caps[1][1], [R[m], R[m + 1]]]; cutTri([q[0], q[1], q[2]]); cutTri([q[0], q[2], q[3]]); }
    for (let i = 0; i + 1 < n; i++) {
      // the quad from bank top to bank top
      const q = [[L[i * 2], L[i * 2 + 1]], [L[i * 2 + 2], L[i * 2 + 3]], [R[i * 2 + 2], R[i * 2 + 3]], [R[i * 2], R[i * 2 + 1]]];
      cutTri([q[0], q[1], q[2]]); cutTri([q[0], q[2], q[3]]);
      const mx = (p[i * 3] + p[i * 3 + 3]) / 2, mz = (p[i * 3 + 1] + p[i * 3 + 4]) / 2;
      add(draws, `${Math.floor(mx / tileSize)},${Math.floor(mz / tileSize)}`, { ch, i });
    }
  }
  return {
    // what a tile needs: cut(points) -> the pieces of a convex polygon [[x, z], ...] left standing (null: all of
    // it), and the stretches of channel it draws
    forTile(tx, tz) {
      const list = cuts.get(`${tx},${tz}`), segs = draws.get(`${tx},${tz}`) ?? [];
      if (!list && !segs.length) return null;
      const cut = (poly) => {
        if (!list) return null;
        let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
        for (const [x, z] of poly) { x0 = Math.min(x0, x); z0 = Math.min(z0, z); x1 = Math.max(x1, x); z1 = Math.max(z1, z); }
        let pieces = null;
        for (const { tri, box } of list) {
          if (box[0] > x1 || box[2] < x0 || box[1] > z1 || box[3] < z0) continue;
          const next = [];
          for (const piece of pieces ?? [poly]) next.push(...subtract(piece, tri));
          pieces = next;
          if (!pieces.length) break;
        }
        return pieces;
      };
      return { cut, segs };
    },
  };
}

// The channels a tile draws: arrays like roadMesh()'s (position, normal, color, aLayer).
export function channelMesh(segs, grid, tileSize) {
  const pos = [], nor = [], col = [], lay = [];
  if (!segs.length) return { position: new Float32Array(0), normal: new Float32Array(0), color: new Float32Array(0), aLayer: new Float32Array(0) };
  const drape = createDraper(grid, (x, z) => sampleGrid(grid, x, z), tileSize); // the terrain as its mesh draws it
  const top = (q) => drape.height(q[0], q[1]) + LIP;
  // a triangle of 3D points, wound to face `toward` (its normal's dot with it positive)
  const face = (A, B, C, toward, style) => {
    const ux = B[0] - A[0], uy = B[1] - A[1], uz = B[2] - A[2], vx = C[0] - A[0], vy = C[1] - A[1], vz = C[2] - A[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz);
    if (l < 1e-9) return;
    nx /= l; ny /= l; nz /= l;
    const flip = nx * toward[0] + ny * toward[1] + nz * toward[2] < 0;
    if (flip) { nx = -nx; ny = -ny; nz = -nz; }
    for (const v of flip ? [A, C, B] : [A, B, C]) { pos.push(v[0], v[1], v[2]); nor.push(nx, ny, nz); col.push(...style.color); lay.push(style.layer); }
  };
  // a bank along one side of a stretch: from the water's edge (a0 -> a1, levels l0, l1) up to the ground at its
  // top (b0 -> b1), split where the terrain's triangles are so its top follows the ground as drawn; `inward`
  // points from the bank towards the water
  const bank = (a0, a1, b0, b1, l0, l1, inward, style) => {
    const len = Math.hypot(b1[0] - b0[0], b1[1] - b0[1]);
    if (len < 1e-6) return;
    const toward = [inward[0], 1.5, inward[1]];
    drape.segment(b0, b1, (p, q) => {
      const tp = Math.hypot(p[0] - b0[0], p[1] - b0[1]) / len, tq = Math.hypot(q[0] - b0[0], q[1] - b0[1]) / len;
      const ip = [a0[0] + (a1[0] - a0[0]) * tp, l0 + (l1 - l0) * tp - UNDER, a0[1] + (a1[1] - a0[1]) * tp];
      const iq = [a0[0] + (a1[0] - a0[0]) * tq, l0 + (l1 - l0) * tq - UNDER, a0[1] + (a1[1] - a0[1]) * tq];
      const op = [p[0], Math.max(top(p), ip[1] + UNDER), p[1]], oq = [q[0], Math.max(top(q), iq[1] + UNDER), q[1]];
      face(ip, iq, oq, toward, style); face(ip, oq, op, toward, style);
    });
  };
  // a wall across the end of a channel (from bank top to bank top, a -> b), from under the water up to the ground
  const wall = (a, b, level, inward, style) => {
    const toward = [inward[0], 0, inward[1]];
    drape.segment(a, b, (p, q) => {
      const P0 = [p[0], level - UNDER, p[1]], Q0 = [q[0], level - UNDER, q[1]], P1 = [p[0], Math.max(top(p), level), p[1]], Q1 = [q[0], Math.max(top(q), level), q[1]];
      face(P0, Q0, Q1, toward, style); face(P0, Q1, P1, toward, style);
    });
  };
  const at = (arr, i) => [arr[i * 2], arr[i * 2 + 1]];
  for (const { ch, i } of segs) {
    const { p, inner, outer, k, e, n } = ch, style = BANK[k] ?? BANK[2];
    const l0 = p[i * 3 + 2], l1 = p[i * 3 + 5];
    const a = at(inner[0], i), b = at(inner[0], i + 1), c = at(inner[1], i + 1), d = at(inner[1], i);
    // the water: level across (a, d at l0; b, c at l1)
    face([a[0], l0, a[1]], [b[0], l1, b[1]], [c[0], l1, c[1]], [0, 1, 0], WATER);
    face([a[0], l0, a[1]], [c[0], l1, c[1]], [d[0], l0, d[1]], [0, 1, 0], WATER);
    // the banks
    const cx = (p[i * 3] + p[i * 3 + 3]) / 2, cz = (p[i * 3 + 1] + p[i * 3 + 4]) / 2;
    for (let s = 0; s < 2; s++) {
      const o0 = at(outer[s], i), o1 = at(outer[s], i + 1), i0 = at(inner[s], i), i1 = at(inner[s], i + 1);
      const mx = (o0[0] + o1[0]) / 2, mz = (o0[1] + o1[1]) / 2;
      bank(i0, i1, o0, o1, l0, l1, [cx - mx, cz - mz], style);
    }
    // across each end: nothing where it runs on into open water or another channel; a bank sloping up where the
    // waterway begins or ends (from the water's edge out to the cap, the two corners filled); else a wall (where it
    // stops at a street it goes under)
    const dir = [p[i * 3 + 3] - p[i * 3], p[i * 3 + 4] - p[i * 3 + 1]];
    for (const [end, j, toward, level] of [[0, 0, dir, l0], [1, n - 1, [-dir[0], -dir[1]], l1]]) {
      if (i !== (end ? n - 2 : 0) || e & (end ? END.OPEN_END : END.OPEN_START)) continue;
      const cap = ch.caps[end], iL = at(inner[0], j), iR = at(inner[1], j), oL = at(outer[0], j), oR = at(outer[1], j);
      if (!cap) { wall(oL, oR, level, toward, style); continue; }
      bank(iL, iR, cap[0], cap[1], level, level, toward, style);
      bank(iL, iL, oL, cap[0], level, level, [toward[0] + (iR[0] - iL[0]), toward[1] + (iR[1] - iL[1])], style);
      bank(iR, iR, oR, cap[1], level, level, [toward[0] + (iL[0] - iR[0]), toward[1] + (iL[1] - iR[1])], style);
    }
  }
  return { position: Float32Array.from(pos), normal: Float32Array.from(nor), color: Float32Array.from(col), aLayer: Float32Array.from(lay) };
}
