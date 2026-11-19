// The expressway in a cutting: a flat floor at the road's level between upright walls, where the terrain has a bowl.
//
// The ground is a 10 m grid. A walled trench 35 m wide and 6 m deep (the Baldorioty de Castro under the streets of
// Santurce) comes out of it as a bowl with a floor 20 m wide and sides that run 10 to 15 m out: the outer lanes of
// both carriageways lay on the sides, tilted, and the slope ran on up through the streets alongside. No grid of that
// step can hold it, so, as the channels do for the rivers (src/world/channels.js), each tile takes the ground and
// everything draped on it apart along the cutting's outline: outside it they stay as they were, inside it they lie
// on the floor, and a wall stands along the outline from the floor up to the ground beside it.
//
//   findCuttings   (main thread, once) the stretches of expressway and ramp whose paving has the ground standing a
//                  metre or more over the road's level at either edge: strips of cross-sections every STEP metres
//   cutField       (main thread and every tile worker) from the strips: the floor's height, which is what
//                  src/shared/terrain.js meshHeight answers inside the outline (grid.cuts), so whatever stands or
//                  drives on the ground stands on the floor; and, tile by tile, the outline to split polygons by and
//                  the walls to draw
//
// The floor is the road's level at its middle (roads.json after correctProfiles), carried across the paving; where
// carriageways lie side by side each has its own, blended between them. It is laid on a lattice of its own, FINE
// metres, and everything inside the outline is split along that lattice as everything outside is along the
// terrain's (src/world/drape.js), so the paint lies flat on the paving and the paving on the floor. At either end of
// a stretch the floor eases back into the terrain over EASE metres, and no wall stands where they agree.
import { latticeHeight } from './terrain.js';
import { projectOnDeck } from './decks.js';
import { pavedHalf, roadLanes, paintOf } from './roadway.js';

const STEP = 4;       // metres between a strip's cross-sections
const DEEP = 1.0;     // the ground at the paving's edge this far over the road: a cutting
const MIN_RUN = 28;   // metres: shorter, the terrain's bowl is left as it is
const EASE = 12;      // metres over which the floor eases into the terrain at a stretch's end
const MARGIN = 0.3;   // the floor reaches this far beyond the paving
const WALLED_UP = 1.5, WALLED_NEAR = 45; // a street this far over the road, this near it: the cutting is a walled one
const HIGHEST = 10;   // metres of wall: more, the hillside is not a wall
const REACH = 30;     // a cross-section counts toward the floor's level this far from it
const CELL = 32;
export const FINE = 4;
const BANK = 1.0, BANK_MIN = 2, BANK_MAX = 10; // a graded cut's bank: metres out for each metre up, and its limits
const VERGE = 5.7;    // level ground between the paving and the bank's foot (a cell of the floor's lattice, corner to corner)
const STRAY = 2.5;    // paint this far beyond a walled cutting's paving, on no road: the tiles' edge line of a sheet of paving
// numbers per cross-section: x, z, level, half width, ease (0 at a stretch's end, 1 inside), tx, tz, and how far the
// verge and the bank run out beyond the paving to the right and to the left (0: a wall)
const PER = 9;

// roads: roads.json, its levels final; ground(x, z): the terrain as drawn; built: structureEdges() (world/flyovers.js),
// the stretches drawn as decks and walled ramps; decks: the manifest's street-level bridges (their corridors hold
// what is under them at the deck's level, src/shared/decks.js: a cutting stops short of them).
// Returns the strips, each { pts: PER numbers per cross-section, lines: the road's paint as [offset to the right,
// dashed, yellow] (roadway.js paintOf; none for a ramp, as in the tiles) }.
export function findCuttings(roads, ground, built, decks = []) {
  const lanesOf = roadLanes(roads.edges), runs = [], ends = new Map();
  // The streets alongside, a level up: what makes a cutting a walled one. Out in the hills the expressway runs through
  // graded cuts, the hillside coming down to its shoulder, and an upright concrete wall 10 m high there is no better
  // than the bowl: there the road lies flat and a bank rises from its shoulder to the ground as it is, BANK metres out
// for each metre up (`graded`), no further than the next road.
  const beside = new Map(), bk = (x, z) => Math.floor(x / 48) * 65536 + Math.floor(z / 48);
  for (const e of roads.edges) {
    if (e.tunnel || e.highway.startsWith('motorway') || !/^(trunk|primary|secondary|tertiary|unclassified|residential|living_street)/.test(e.highway)) continue;
    const p = e.pts;
    for (let k = 3; k < p.length; k += 3) {
      const len = Math.hypot(p[k] - p[k - 3], p[k + 2] - p[k - 1]), n = Math.max(1, Math.ceil(len / 10));
      for (let i = 0; i <= n; i++) { const t = i / n, x = p[k - 3] + (p[k] - p[k - 3]) * t, z = p[k - 1] + (p[k + 2] - p[k - 1]) * t, key = bk(x, z); let l = beside.get(key); if (!l) beside.set(key, (l = [])); l.push(x, z, p[k - 2] + (p[k + 1] - p[k - 2]) * t); }
    }
  }
  const streetOver = (x, y, z) => {
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
      const l = beside.get(bk(x + i * 48, z + j * 48));
      if (l) for (let k = 0; k < l.length; k += 3) if (l[k + 2] - y >= WALLED_UP && (l[k] - x) ** 2 + (l[k + 1] - z) ** 2 <= WALLED_NEAR * WALLED_NEAR) return true;
    }
    return false;
  };
  // every road's paving, for where a bank must stop and for the paint that lies on none (cutField's stray)
  const paved = new Map(), pk = (x, z) => Math.floor(x / 64) * 65536 + Math.floor(z / 64);
  for (const e of roads.edges) {
    if (e.tunnel || !/^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|service)/.test(e.highway)) continue;
    const p = e.pts, h = pavedHalf(e, lanesOf(e)).half;
    for (let k = 3; k < p.length; k += 3) {
      const seg = [p[k - 3], p[k - 1], p[k], p[k + 2], h, e];
      for (let i = Math.floor((Math.min(seg[0], seg[2]) - h) / 64); i <= Math.floor((Math.max(seg[0], seg[2]) + h) / 64); i++)
        for (let j = Math.floor((Math.min(seg[1], seg[3]) - h) / 64); j <= Math.floor((Math.max(seg[1], seg[3]) + h) / 64); j++) { const key = i * 65536 + j; let l = paved.get(key); if (!l) paved.set(key, (l = [])); l.push(seg); }
    }
  }
  const onRoad = (x, z, pad, but) => {
    const l = paved.get(pk(x, z));
    if (l) for (const g of l) {
      if (g[5] === but) continue;
      const dx = g[2] - g[0], dz = g[3] - g[1], t = Math.max(0, Math.min(1, ((x - g[0]) * dx + (z - g[1]) * dz) / (dx * dx + dz * dz || 1)));
      if ((x - g[0] - dx * t) ** 2 + (z - g[1] - dz * t) ** 2 <= (g[4] + pad) ** 2) return true;
    }
    return false;
  };
  const underDeck = (x, z) => decks.some((d) => { const p = projectOnDeck(d, x, z); return p.inside && p.dist <= d.half + 8; });
  for (const e of roads.edges) {
    if (!e.highway.startsWith('motorway') || e.tunnel || e.bridge || e.flyover || e.grade || e.span) continue;
    const p = e.pts, n = p.length / 3, cum = [0];
    for (let k = 1; k < n; k++) cum.push(cum[k - 1] + Math.hypot(p[k * 3] - p[k * 3 - 3], p[k * 3 + 2] - p[k * 3 - 1]));
    const total = cum[n - 1];
    if (total < MIN_RUN / 2) continue;
    const m = Math.max(1, Math.round(total / STEP)), half = pavedHalf(e, lanesOf(e)).half + MARGIN, [from, to] = built.get(e) ?? [1, 0];
    const S = [];
    for (let i = 0, k = 1; i <= m; i++) {
      const s = (total * i) / m;
      while (k < n - 1 && cum[k] < s) k++;
      const t = (s - cum[k - 1]) / (cum[k] - cum[k - 1] || 1), a = (k - 1) * 3, b = k * 3;
      S.push({ s, x: p[a] + (p[b] - p[a]) * t, y: p[a + 1] + (p[b + 1] - p[a + 1]) * t, z: p[a + 2] + (p[b + 2] - p[a + 2]) * t });
    }
    for (let i = 0; i <= m; i++) {
      const a = S[Math.max(0, i - 1)], b = S[Math.min(m, i + 1)], l = Math.hypot(b.x - a.x, b.z - a.z) || 1, c = S[i];
      c.tx = (b.x - a.x) / l; c.tz = (b.z - a.z) / l;
      // (never where a deck or a walled ramp is drawn, nor where the road stands over the ground, nor under a bridge
      // whose corridor holds the surface up)
      c.no = (c.s >= from - 0.01 && c.s <= to + 0.01) || c.y - ground(c.x, c.z) > 0.35 || underDeck(c.x, c.z);
      c.up = c.no ? 0 : Math.max(ground(c.x - c.tz * half, c.z + c.tx * half), ground(c.x + c.tz * half, c.z - c.tx * half)) - c.y;
      c.deep = c.up >= DEEP;
      c.walled = c.deep && streetOver(c.x, c.y, c.z);
    }
    // the deep sections, the gaps of a few between them, and EASE on either side
    const on = S.map((c) => c.deep), reach = Math.round(EASE / STEP);
    for (let i = 0, last = -Infinity; i <= m; i++) if (S[i].deep) { if (i - last <= 6) for (let k = last + 1; k < i; k++) on[k] = true; last = i; }
    const wide = on.map((v, i) => { for (let k = Math.max(0, i - reach); k <= Math.min(m, i + reach); k++) if (on[k]) return true; return false; });
    for (let i = 0; i <= m; i++) if (S[i].no) wide[i] = false;
    for (let i = 0; i <= m; i++) {
      if (!wide[i]) continue;
      let j = i;
      while (j < m && wide[j + 1]) j++;
      let deep = 0, walled = 0, most = 0;
      for (let k = i; k <= j; k++) { if (S[k].deep) { deep++; if (S[k].walled) walled++; } most = Math.max(most, S[k].up); }
      if (S[j].s - S[i].s >= MIN_RUN) {
        const lanes = Math.max(1, lanesOf(e) || e.lanes || 1), graded = !(walled >= deep * 0.5 && most <= HIGHEST);
        const lines = e.highway.endsWith('_link') ? [] : paintOf(e, lanes).map((l) => [l.o, l.dashed ? 1 : 0, l.yellow ? 1 : 0]);
        const run = { e, half, lines, graded, S: S.slice(i, j + 1), open: [i === 0, j === m] };
        if (graded) {
          // (its level: the ground under its middle, evened over 40 m. The road's own level is a low share of the ground
          // round it, src/shared/profile.js, and along a hillside that is metres under its middle: a bench cut far too deep)
          const mid = run.S.map((c) => ground(c.x, c.z));
          run.S = run.S.map((c, k) => { let sum = 0, cnt = 0; for (let q = Math.max(0, k - 5); q <= Math.min(mid.length - 1, k + 5); q++) { sum += mid[q]; cnt++; } return { ...c, y: sum / cnt }; });
          // each side's bank: as far out as the ground 6 m beyond the paving stands over the road, short of the next
          // road's paving; evened along the stretch
          for (const side of [1, -1]) {
            const raw = run.S.map((c) => {
              const nx = -c.tz * side, nz = c.tx * side, up = ground(c.x + nx * (half + 6), c.z + nz * (half + 6)) - c.y;
              let r = VERGE + Math.max(BANK_MIN, Math.min(BANK_MAX, Math.abs(up) * BANK));
              for (let d = 1; d <= r + 1; d++) if (onRoad(c.x + nx * (half + d), c.z + nz * (half + d), 1, e)) { r = Math.max(0.5, d - 1.5); break; }
              return r;
            });
            run.S.forEach((c, k) => { let lo = Infinity, sum = 0, cnt = 0; for (let q = Math.max(0, k - 3); q <= Math.min(raw.length - 1, k + 3); q++) { sum += raw[q]; cnt++; lo = Math.min(lo, raw[q]); } c[side > 0 ? 'runR' : 'runL'] = Math.min(sum / cnt, lo + 2); });
          }
        } else {
          // the roads round it, for the paint that lies on none of them: [x0, z0, x1, z1, half] each
          const seen = new Set(); run.near = [];
          for (const c of run.S) for (let u = -1; u <= 1; u++) for (let v = -1; v <= 1; v++) for (const g of paved.get(pk(c.x + u * 64, c.z + v * 64)) ?? []) if (!seen.has(g)) { seen.add(g); run.near.push(g[0], g[1], g[2], g[3], g[4]); }
        }
        runs.push(run);
        if (i === 0) ends.set(e.a, (ends.get(e.a) ?? 0) + 1);
        if (j === m) ends.set(e.b, (ends.get(e.b) ?? 0) + 1);
      }
      i = j;
    }
  }
  // (a stretch that runs on into another at a junction of the graph does not ease there)
  return runs.map(({ e, half, lines, graded, near, S, open }) => {
    const out = [], s0 = S[0].s, s1 = S.at(-1).s, joinA = open[0] && ends.get(e.a) > 1, joinB = open[1] && ends.get(e.b) > 1;
    const ease = (d) => { const t = Math.max(0, Math.min(1, d / EASE)); return t * t * (3 - 2 * t); };
    for (const c of S) out.push(c.x, c.z, c.y, half, Math.min(joinA ? 1 : ease(c.s - s0), joinB ? 1 : ease(s1 - c.s)), c.tx, c.tz, c.runR ?? 0, c.runL ?? 0);
    return { pts: out, lines, graded: !!graded, near: near ?? [] };
  });
}

const cross = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
function clip(poly, f) {
  const out = [];
  let a = poly[poly.length - 1], fa = f(a);
  for (const b of poly) {
    const fb = f(b);
    if ((fa >= 0) !== (fb >= 0)) { const t = fa / (fa - fb); out.push(a.map((v, i) => v + (b[i] - v) * t)); } // (whatever else a corner carries, a decal's place in its picture, goes with it)
    if (fb >= 0) out.push(b);
    a = b; fa = fb;
  }
  return out;
}
const area2 = (p) => { let s = 0; for (let i = 0; i < p.length; i++) { const a = p[i], b = p[(i + 1) % p.length]; s += a[0] * b[1] - b[0] * a[1]; } return s; };
// the convex polygon `poly` apart along the triangle `tri` (its corners in the order cross() > 0): [inside, outside pieces]
function apart(poly, tri) {
  const out = [];
  let rest = poly;
  for (let k = 0; k < 3 && rest.length >= 3; k++) {
    const a = tri[k], b = tri[(k + 1) % 3], side = (p) => cross(a, b, p);
    const outside = clip(rest, (p) => -side(p));
    if (outside.length >= 3 && Math.abs(area2(outside)) > 1e-6) out.push(outside);
    rest = clip(rest, side);
  }
  return [rest.length >= 3 && Math.abs(area2(rest)) > 1e-6 ? rest : null, out];
}

// strips: findCuttings(); grid: the terrain (its lattice is what the floor eases into).
export function cutField(strips, grid, tileSize = 256) {
  const fine = tileSize / Math.round(tileSize / FINE);
  // the cross-sections, and the outline's triangles, by CELL
  const secs = new Map(), tris = new Map(), byTile = new Map();
  const file = (map, k, v) => { let l = map.get(k); if (!l) map.set(k, (l = [])); l.push(v); };
  const ck = (i, j) => i * 65536 + j;
  const all = [];
  strips = strips.map((st) => ({ ...st }));
  strips.forEach((st, si) => {
    const s = st.pts, n = s.length / PER, L = [], R = [];
    for (let i = 0; i < n; i++) {
      const o = i * PER, x = s[o], z = s[o + 1], h = s[o + 3], tx = s[o + 5], tz = s[o + 6];
      // (L: the side to the right of the way, where the right bank is; R: the left)
      L.push([x - tz * (h + s[o + 7]), z + tx * (h + s[o + 7])]); R.push([x + tz * (h + s[o + 8]), z - tx * (h + s[o + 8])]);
      file(secs, ck(Math.floor(x / CELL), Math.floor(z / CELL)), [x, z, s[o + 2], s[o + 4], tx, tz, h, s[o + 7], s[o + 8], st.graded ? 1 : 0]);
    }
    for (let i = 0; i + 1 < n; i++)
      for (const t of [[L[i], L[i + 1], R[i + 1]], [L[i], R[i + 1], R[i]]]) {
        if (Math.abs(cross(...t)) < 1e-8) continue;
        const tri = cross(...t) > 0 ? t : [t[0], t[2], t[1]];
        const box = [Math.min(tri[0][0], tri[1][0], tri[2][0]), Math.min(tri[0][1], tri[1][1], tri[2][1]), Math.max(tri[0][0], tri[1][0], tri[2][0]), Math.max(tri[0][1], tri[1][1], tri[2][1])];
        const item = { tri, box, si };
        all.push(item);
        for (let i2 = Math.floor(box[0] / CELL); i2 <= Math.floor(box[2] / CELL); i2++) for (let j = Math.floor(box[1] / CELL); j <= Math.floor(box[3] / CELL); j++) file(tris, ck(i2, j), item);
        for (let tx = Math.floor(box[0] / tileSize); tx <= Math.floor(box[2] / tileSize); tx++) for (let tz = Math.floor(box[1] / tileSize); tz <= Math.floor(box[3] / tileSize); tz++) file(byTile, `${tx},${tz}`, item);
      }
    st.L = L; st.R = R;
  });
  const within = (t, x, z, by = 0) => cross(t[0], t[1], [x, z]) >= by && cross(t[1], t[2], [x, z]) >= by && cross(t[2], t[0], [x, z]) >= by;
  const inside = (x, z) => {
    const list = tris.get(ck(Math.floor(x / CELL), Math.floor(z / CELL)));
    if (!list) return false;
    for (let k = 0; k < list.length; k++) { const b = list[k].box; if (x >= b[0] && x <= b[2] && z >= b[1] && z <= b[3] && within(list[k].tri, x, z)) return true; }
    return false;
  };
  // how far up a cross-section's bank (x, z) is: 0 on its paving, 1 at the bank's top and beyond, and beside a wall
  const up = (c, x, z) => {
    const dx = x - c[0], dz = z - c[1];
    if (Math.abs(dx * c[4] + dz * c[5]) > STEP) return 1;
    const l = dx * -c[5] + dz * c[4], run = l >= 0 ? c[7] : c[8], out = Math.abs(l) - c[6];
    if (out <= 0.05) return 0;
    if (!(run > 0)) return out <= 2 * FINE ? 0 : 1; // (beside a wall: the floor's level on past it, for the lattice's corners there)
    // (a verge first, level with the road: the floor's lattice is FINE metres, and a bank rising from the paving's very
    // edge had tilted its last lane)
    const verge = Math.min(VERGE, run * 0.6);
    return out <= verge ? 0 : Math.min(1, (out - verge) / (run - verge));
  };
  const near = (x, z, f) => { const ci = Math.floor(x / CELL), cj = Math.floor(z / CELL); for (let i = ci - 1; i <= ci + 1; i++) for (let j = cj - 1; j <= cj + 1; j++) for (const c of secs.get(ck(i, j)) ?? []) f(c); };
  // 0 on the paving of a cutting, up to 1 at the top of its bank (what the floor is drawn as: asphalt, or the ground)
  const bankAt = (x, z) => { let b = 1; near(x, z, (c) => { if ((c[0] - x) ** 2 + (c[1] - z) ** 2 <= REACH * REACH) b = Math.min(b, up(c, x, z)); }); return b; };
  // paint beside a walled cutting that lies on no road: beyond its paving by STRAY or more, within 25 m, off every
  // road's own paving (the tiles' edge line of a sheet of paving, left on the slope over the wall)
  const roadsNear = strips.flatMap((st) => st.near ?? []);
  const stray = (x, z) => {
    let beside = false;
    near(x, z, (c) => {
      if (c[9] || c[3] < 0.999) return;
      const dx = x - c[0], dz = z - c[1], out = Math.abs(dx * -c[5] + dz * c[4]) - c[6];
      if (Math.abs(dx * c[4] + dz * c[5]) <= STEP && out >= STRAY && out <= 25) beside = true;
    });
    if (!beside || inside(x, z)) return false;
    for (let k = 0; k < roadsNear.length; k += 5) {
      const x0 = roadsNear[k], z0 = roadsNear[k + 1], dx = roadsNear[k + 2] - x0, dz = roadsNear[k + 3] - z0, t = Math.max(0, Math.min(1, ((x - x0) * dx + (z - z0) * dz) / (dx * dx + dz * dz || 1)));
      if ((x - x0 - dx * t) ** 2 + (z - z0 - dz * t) ** 2 <= (roadsNear[k + 4] + 1) ** 2) return false;
    }
    return true;
  };
  // the floor at a corner of its lattice: the levels of the cross-sections round it, the nearest counting most, eased
  // into the terrain as they are
  const corners = new Map();
  const corner = (x, z) => {
    const key = ck(Math.round(x / fine), Math.round(z / fine));
    let y = corners.get(key);
    if (y !== undefined) return y;
    const terrain = latticeHeight(grid, x, z, tileSize), ci = Math.floor(x / CELL), cj = Math.floor(z / CELL);
    let sum = 0, level = 0, ease = 0, bank = 1;
    for (let i = ci - 1; i <= ci + 1; i++) for (let j = cj - 1; j <= cj + 1; j++) {
      const list = secs.get(ck(i, j));
      if (!list) continue;
      for (const c of list) {
        const d2 = (c[0] - x) ** 2 + (c[1] - z) ** 2;
        if (d2 > REACH * REACH) continue;
        const k = 1 / (d2 + 4) ** 2;
        sum += k; level += k * c[2]; ease += k * c[3];
        bank = Math.min(bank, up(c, x, z));
      }
    }
    // (on a bank the floor rises to the ground as it is: all of the way at the bank's top)
    y = sum > 0 ? terrain + (level / sum - terrain) * (ease / sum) * (1 - bank * bank * (3 - 2 * bank)) : terrain;
    corners.set(key, y);
    return y;
  };
  const floor = (x, z) => latticeHeight({ step: fine }, x, z, tileSize, corner);
  return {
    fine, corner, inside, floor, bankAt, stray, count: strips.length, graded: strips.filter((st) => st.graded).length,
    // for grid.cuts: the floor inside the outline, undefined outside it
    level: (x, z) => (inside(x, z) ? floor(x, z) : undefined),
    // what a tile needs, or null where no cutting reaches it:
    //   split(poly)   a convex polygon [[x, z], ...] apart along the outline: { ins, out } (pieces, wound as it is; an
    //                 inside piece is `graded` where its stretch is), or
    //                 null where none of it is inside
    //   walls         [x0, z0, x1, z1, graded, ...]: the outline in pieces of a metre or less, those in this tile
    //                 (graded: a bank's top, where the floor has come up to the ground, not a wall)
    //   paint(has)    the lane lines of the stretches the tiles left bare, as rings [x, z, ...] of white and of yellow:
    //                 { white, yellow }. has(x, z): the tile has paint of its own within a few metres of there
    forTile(tx, tz) {
      const list = byTile.get(`${tx},${tz}`);
      if (!list) return null;
      const split = (poly) => {
        let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
        for (const [x, z] of poly) { x0 = Math.min(x0, x); z0 = Math.min(z0, z); x1 = Math.max(x1, x); z1 = Math.max(z1, z); }
        let out = [poly], ins = null;
        for (const { tri, box, si } of list) {
          if (box[0] > x1 || box[2] < x0 || box[1] > z1 || box[3] < z0) continue;
          const next = [];
          for (const piece of out) { const [i, o] = apart(piece, tri); if (i) { i.graded = strips[si].graded; (ins ??= []).push(i); } next.push(...o); }
          out = next;
          if (!out.length) break;
        }
        return ins ? { ins, out } : null;
      };
      const walls = [];
      let graded = 0;
      const side = (a, b) => {
        const len = Math.hypot(b[0] - a[0], b[1] - a[1]), n = Math.max(1, Math.ceil(len));
        for (let k = 0; k < n; k++) {
          const p = [a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n], q = [a[0] + ((b[0] - a[0]) * (k + 1)) / n, a[1] + ((b[1] - a[1]) * (k + 1)) / n];
          const mx = (p[0] + q[0]) / 2, mz = (p[1] + q[1]) / 2;
          if (Math.floor(mx / tileSize) !== tx || Math.floor(mz / tileSize) !== tz) continue;
          walls.push(p[0], p[1], q[0], q[1], graded);
        }
      };
      const seen = new Set();
      for (const { si } of list) {
        if (seen.has(si)) continue;
        seen.add(si);
        const s = strips[si], n = s.L.length;
        graded = s.graded ? 1 : 0;
        // (a = the side further along first on the left, so every piece has the cutting on its left hand)
        for (let i = 0; i + 1 < n; i++) { side(s.L[i + 1], s.L[i]); side(s.R[i], s.R[i + 1]); }
        side(s.L[0], s.R[0]); side(s.R[n - 1], s.L[n - 1]);
      }
      // (not where another stretch's floor lies on the other side: two carriageways side by side, a ramp joining)
      const kept = [];
      for (let k = 0; k < walls.length; k += 5) {
        const dx = walls[k + 2] - walls[k], dz = walls[k + 3] - walls[k + 1], l = Math.hypot(dx, dz) || 1;
        const mx = (walls[k] + walls[k + 2]) / 2 + (dz / l) * 0.12, mz = (walls[k + 1] + walls[k + 3]) / 2 - (dx / l) * 0.12;
        if (!inside(mx, mz)) kept.push(walls[k], walls[k + 1], walls[k + 2], walls[k + 3], walls[k + 4]);
      }
      // The tiles paint a road from its carriageway as measured, kerb to kerb (tools/pipeline/markings.mjs), and where
      // two carriageways and their ramps are paved as one sheet they found no kerbs and painted nothing: the
      // expressway ran through its cutting without a line on it. Dashes 5 m on, 5 m off, as theirs.
      const paint = (has) => {
        const white = [], yellow = [], W = 0.075;
        for (const si of seen) {
          const st = strips[si], s = st.pts, n = s.length / PER;
          let along = 0;
          for (let i = 0; i + 1 < n; i++) {
            const a = i * PER, b = a + PER, len = Math.hypot(s[b] - s[a], s[b + 1] - s[a + 1]), from = along;
            along += len;
            const mx = (s[a] + s[b]) / 2, mz = (s[a + 1] + s[b + 1]) / 2;
            if (Math.floor(mx / tileSize) !== tx || Math.floor(mz / tileSize) !== tz || s[a + 4] < 0.999 || s[b + 4] < 0.999 || has(mx, mz)) continue;
            const at = (t, o) => [s[a] + (s[b] - s[a]) * t - (s[a + 6] + (s[b + 6] - s[a + 6]) * t) * o, s[a + 1] + (s[b + 1] - s[a + 1]) * t + (s[a + 5] + (s[b + 5] - s[a + 5]) * t) * o]; // (o to the right)
            for (const [o, dashed, yel] of st.lines) {
              // the stretches of this piece that are painted: all of it, or what the dashes cover
              const spans = [];
              if (!dashed) spans.push([0, 1]);
              else for (let k = Math.floor(from / 10); k * 10 < along; k++) { const t0 = Math.max(0, (k * 10 - from) / len), t1 = Math.min(1, (k * 10 + 5 - from) / len); if (t1 - t0 > 1e-3) spans.push([t0, t1]); }
              for (const [t0, t1] of spans) (yel ? yellow : white).push([...at(t0, o - W), ...at(t1, o - W), ...at(t1, o + W), ...at(t0, o + W)]);
            }
          }
        }
        return { white, yellow };
      };
      return { split, walls: kept, paint };
    },
  };
}
