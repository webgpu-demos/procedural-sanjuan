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
const PER = 7;        // numbers per cross-section: x, z, level, half width, ease (0 at a stretch's end, 1 inside), tx, tz

// roads: roads.json, its levels final; ground(x, z): the terrain as drawn; built: structureEdges() (world/flyovers.js),
// the stretches drawn as decks and walled ramps; decks: the manifest's street-level bridges (their corridors hold
// what is under them at the deck's level, src/shared/decks.js: a cutting stops short of them).
// Returns the strips, each { pts: PER numbers per cross-section, lines: the road's paint as [offset to the right,
// dashed, yellow] (roadway.js paintOf; none for a ramp, as in the tiles) }.
export function findCuttings(roads, ground, built, decks = []) {
  const lanesOf = roadLanes(roads.edges), runs = [], ends = new Map();
  // The streets alongside, a level up: what makes a cutting a walled one. Out in the hills the expressway runs through
  // graded cuts, the hillside coming down to its shoulder, and an upright concrete wall 10 m high there is no better
  // than the bowl: those are left as the terrain has them.
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
      if (S[j].s - S[i].s >= MIN_RUN && walled >= deep * 0.5 && most <= HIGHEST) {
        const lanes = Math.max(1, lanesOf(e) || e.lanes || 1);
        const lines = e.highway.endsWith('_link') ? [] : paintOf(e, lanes).map((l) => [l.o, l.dashed ? 1 : 0, l.yellow ? 1 : 0]);
        const run = { e, half, lines, S: S.slice(i, j + 1), open: [i === 0, j === m] };
        runs.push(run);
        if (i === 0) ends.set(e.a, (ends.get(e.a) ?? 0) + 1);
        if (j === m) ends.set(e.b, (ends.get(e.b) ?? 0) + 1);
      }
      i = j;
    }
  }
  // (a stretch that runs on into another at a junction of the graph does not ease there)
  return runs.map(({ e, half, lines, S, open }) => {
    const out = [], s0 = S[0].s, s1 = S.at(-1).s, joinA = open[0] && ends.get(e.a) > 1, joinB = open[1] && ends.get(e.b) > 1;
    const ease = (d) => { const t = Math.max(0, Math.min(1, d / EASE)); return t * t * (3 - 2 * t); };
    for (const c of S) out.push(c.x, c.z, c.y, half, Math.min(joinA ? 1 : ease(c.s - s0), joinB ? 1 : ease(s1 - c.s)), c.tx, c.tz);
    return { pts: out, lines };
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
      L.push([x - tz * h, z + tx * h]); R.push([x + tz * h, z - tx * h]);
      file(secs, ck(Math.floor(x / CELL), Math.floor(z / CELL)), [x, z, s[o + 2], s[o + 4]]);
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
  // the floor at a corner of its lattice: the levels of the cross-sections round it, the nearest counting most, eased
  // into the terrain as they are
  const corners = new Map();
  const corner = (x, z) => {
    const key = ck(Math.round(x / fine), Math.round(z / fine));
    let y = corners.get(key);
    if (y !== undefined) return y;
    const terrain = latticeHeight(grid, x, z, tileSize), ci = Math.floor(x / CELL), cj = Math.floor(z / CELL);
    let sum = 0, level = 0, ease = 0;
    for (let i = ci - 1; i <= ci + 1; i++) for (let j = cj - 1; j <= cj + 1; j++) {
      const list = secs.get(ck(i, j));
      if (!list) continue;
      for (const c of list) {
        const d2 = (c[0] - x) ** 2 + (c[1] - z) ** 2;
        if (d2 > REACH * REACH) continue;
        const k = 1 / (d2 + 4) ** 2;
        sum += k; level += k * c[2]; ease += k * c[3];
      }
    }
    y = sum > 0 ? terrain + (level / sum - terrain) * (ease / sum) : terrain;
    corners.set(key, y);
    return y;
  };
  const floor = (x, z) => latticeHeight({ step: fine }, x, z, tileSize, corner);
  return {
    fine, corner, inside, floor, count: strips.length,
    // for grid.cuts: the floor inside the outline, undefined outside it
    level: (x, z) => (inside(x, z) ? floor(x, z) : undefined),
    // what a tile needs, or null where no cutting reaches it:
    //   split(poly)   a convex polygon [[x, z], ...] apart along the outline: { ins, out } (pieces, wound as it is), or
    //                 null where none of it is inside
    //   walls         [x0, z0, x1, z1, ...]: the outline in pieces of a metre or less, those in this tile
    //   paint(has)    the lane lines of the stretches the tiles left bare, as rings [x, z, ...] of white and of yellow:
    //                 { white, yellow }. has(x, z): the tile has paint of its own within a few metres of there
    forTile(tx, tz) {
      const list = byTile.get(`${tx},${tz}`);
      if (!list) return null;
      const split = (poly) => {
        let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
        for (const [x, z] of poly) { x0 = Math.min(x0, x); z0 = Math.min(z0, z); x1 = Math.max(x1, x); z1 = Math.max(z1, z); }
        let out = [poly], ins = null;
        for (const { tri, box } of list) {
          if (box[0] > x1 || box[2] < x0 || box[1] > z1 || box[3] < z0) continue;
          const next = [];
          for (const piece of out) { const [i, o] = apart(piece, tri); if (i) (ins ??= []).push(i); next.push(...o); }
          out = next;
          if (!out.length) break;
        }
        return ins ? { ins, out } : null;
      };
      const walls = [];
      const side = (a, b) => {
        const len = Math.hypot(b[0] - a[0], b[1] - a[1]), n = Math.max(1, Math.ceil(len));
        for (let k = 0; k < n; k++) {
          const p = [a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n], q = [a[0] + ((b[0] - a[0]) * (k + 1)) / n, a[1] + ((b[1] - a[1]) * (k + 1)) / n];
          const mx = (p[0] + q[0]) / 2, mz = (p[1] + q[1]) / 2;
          if (Math.floor(mx / tileSize) !== tx || Math.floor(mz / tileSize) !== tz) continue;
          walls.push(p[0], p[1], q[0], q[1]);
        }
      };
      const seen = new Set();
      for (const { si } of list) {
        if (seen.has(si)) continue;
        seen.add(si);
        const s = strips[si], n = s.L.length;
        // (a = the side further along first on the left, so every piece has the cutting on its left hand)
        for (let i = 0; i + 1 < n; i++) { side(s.L[i + 1], s.L[i]); side(s.R[i], s.R[i + 1]); }
        side(s.L[0], s.R[0]); side(s.R[n - 1], s.L[n - 1]);
      }
      // (not where another stretch's floor lies on the other side: two carriageways side by side, a ramp joining)
      const kept = [];
      for (let k = 0; k < walls.length; k += 4) {
        const dx = walls[k + 2] - walls[k], dz = walls[k + 3] - walls[k + 1], l = Math.hypot(dx, dz) || 1;
        const mx = (walls[k] + walls[k + 2]) / 2 + (dz / l) * 0.12, mz = (walls[k + 1] + walls[k + 3]) / 2 - (dx / l) * 0.12;
        if (!inside(mx, mz)) kept.push(walls[k], walls[k + 1], walls[k + 2], walls[k + 3]);
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
