// Where a car stands: on a deck the flyovers draw, or on the street the tiles draw, never at a height nothing is drawn
// at. The decks are indexed here exactly as flyovers.js draws them (the same roads, structureEdges' stretches of them,
// the same sections every 3 m, a deck wherever the road stands RAMP_ABOVE off the ground or the tiles leave the road
// out, as wide as the tiles pave it); traffic.js and simtraffic.js both put their cars on what this finds.
//
// A car whose road is known (the free traffic's lane; the simulated car's, matched by simtraffic.js fixAt) is on its
// road's deck where one is drawn under it; any other, on whichever of the street and the decks under it is nearest
// the level it was given. Then up onto any deck drawn just over that: where a ramp merges, its deck runs under
// the edge of the expressway's, a metre or so lower, and a car on it was hidden inside the other; nothing drives
// under a deck so low. A deck counts only under the car, across its width: the old lookup took any deck within 14 m
// whose level was near, and lifted cars on the street beside a ramp onto the ramp's level, metres up in the air.
import { RAMP_ABOVE, structureEdges, leftOut, pavedHalf, roadLanes } from './flyovers.js';
import { sections } from './rails.js';
import { streetAt } from '../shared/decks.js';

const CELL = 24;
const key = (x, z) => Math.floor(x / CELL) * 65536 + Math.floor(z / CELL);
// a deck this little over where a car is, it is on the deck, whichever way it crosses (a ramp come down to the street);
// one up to CLEAR over it, along its way: a car is 1.5 to 2 m tall, and a deck's girder 1.5 m deep
const LOW = 1.5, CLEAR = 3.0;

export class DrawnDecks {
  // roads: roads.json after correctProfiles and landDecks (main.js): the levels the decks are drawn at
  constructor(roads, ground) {
    this.cells = new Map();
    this.count = 0;
    this.found = [];
    const built = structureEdges(roads.edges, ground), lanesOf = roadLanes(roads.edges);
    for (const e of roads.edges) {
      if (e.tunnel || e.span || !built.has(e)) continue;
      const cs = sections(e.pts, ground), [from, to] = built.get(e);
      const mapped = lanesOf(e), w = pavedHalf(e, mapped).half + 0.25, grade = leftOut(e);
      // (a bridge at grade: its deck flush with the roads at its ends, never under the ground between)
      if (e.grade) for (const c of cs) if (c.h < 0.02) { c.p = [c.p[0], c.p[1] + 0.02 - c.h, c.p[2]]; c.h = 0.02; }
      for (let i = 0; i + 1 < cs.length; i++) {
        const a = cs[i], b = cs[i + 1], h = Math.max(a.h, b.h);
        if ((h <= RAMP_ABOVE && !grade) || b.s < from || a.s > to) continue;
        const seg = [a.p[0], a.p[1], a.p[2], b.p[0], b.p[1], b.p[2], w, e];
        // filed in every cell its footprint reaches, and the 3 m beyond its edges (a car there is moved onto it)
        const r = w + 3, i0 = Math.floor((Math.min(a.p[0], b.p[0]) - r) / CELL), i1 = Math.floor((Math.max(a.p[0], b.p[0]) + r) / CELL);
        const j0 = Math.floor((Math.min(a.p[2], b.p[2]) - r) / CELL), j1 = Math.floor((Math.max(a.p[2], b.p[2]) + r) / CELL);
        for (let ci = i0; ci <= i1; ci++) for (let cj = j0; cj <= j1; cj++) {
          const k = ci * 65536 + cj;
          let cell = this.cells.get(k);
          if (!cell) this.cells.set(k, (cell = []));
          cell.push(seg);
        }
        this.count++;
      }
    }
  }

  // The decks drawn under (x, z), into this.found as [level, on the car's own road, along its heading]; this.push
  // ([dx, dz], its level this.pushY): onto the nearest deck of its own road (or, its road not known, any at about its
  // level y) when the car is just beyond that deck's edge (a simulated car in an outer lane, a little wider than the
  // deck drawn)
  under(x, z, y, heading = null, edge = null) {
    const found = this.found, hx = heading == null ? 0 : Math.sin(heading), hz = heading == null ? 0 : Math.cos(heading);
    found.length = 0; this.push = null; this.pushY = null;
    let nearD = Infinity;
    for (const seg of this.cells.get(key(x, z)) ?? []) {
      const [x0, y0, z0, x1, y1, z1, w, e] = seg;
      const dx = x1 - x0, dz = z1 - z0, l2 = dx * dx + dz * dz || 1, t = ((x - x0) * dx + (z - z0) * dz) / l2;
      if (t < -0.15 || t > 1.15) continue;
      const f = Math.max(0, Math.min(1, t)), cx = x0 + dx * f, cz = z0 + dz * f, d = Math.hypot(cx - x, cz - z);
      const h = y0 + (y1 - y0) * f, own = edge != null && e === edge;
      if (d <= w) { found.push(h, own, heading == null || Math.abs(hx * dx + hz * dz) / Math.sqrt(l2) > 0.7); continue; }
      // (just beyond its edge)
      if (d < w + 3 && d < nearD && (edge == null ? Math.abs(h - y) < 1 : own)) {
        nearD = d; this.pushY = h; this.push = [(cx - x) * (d - w + 1.1) / d, (cz - z) * (d - w + 1.1) / d];
      }
    }
    return found;
  }

  // Is (x, z) on the paving of a deck of another road than `edge` running the same way (ux, uz), at about level y?
  // (a merge or a fork; flyovers.js draws no parapet there. Of a dual carriageway's two decks, each the other way,
  // the parapets stay.)
  paved(x, z, y, edge, ux, uz, tol = 0.5) {
    for (const [x0, y0, z0, x1, y1, z1, w, e] of this.cells.get(key(x, z)) ?? []) {
      if (e === edge) continue;
      const dx = x1 - x0, dz = z1 - z0, l2 = dx * dx + dz * dz || 1, t = ((x - x0) * dx + (z - z0) * dz) / l2;
      if (t < 0 || t > 1 || (ux * dx + uz * dz) / Math.sqrt(l2) < 0.3) continue;
      const d = Math.hypot(x0 + dx * t - x, z0 + dz * t - z);
      if (d <= w - 0.4 && Math.abs(y0 + (y1 - y0) * t - y) < tol) return true;
    }
    return false;
  }

  // The level of the deck drawn under (x, z) for one at about level y, or null: of the decks under it whose level is
  // within `within` m below it or 2 m above, the topmost (the visitor's car, bike and walk: drive.js, player.js)
  at(x, z, y, within = 3) {
    const found = this.under(x, z, y);
    let best = null;
    for (let i = 0; i < found.length; i += 3) {
      const dh = found[i] - y;
      if (dh <= 2 && dh >= -within && (best == null || found[i] > best)) best = found[i];
    }
    if (best == null && this.pushY != null) best = this.pushY; else this.push = null;
    return best;
  }

  // Where a car stands at (x, z): { y, deck: on a deck, push: as under() } (the street: the terrain as drawn, and the
  // paving on it, this.lift: main.js). y: the level of its road there; heading, edge: its way and its road, if known.
  stand(surface, x, z, y, heading = null, edge = null) {
    const street = streetAt(surface, x, z, y) + (this.lift?.(x, z) ?? 0), found = this.under(x, z, y, heading, edge);
    let at = null, deck = false, push = null;
    // on its own road's deck, the one nearest its level
    for (let i = 0; i < found.length; i += 3) if (found[i + 1] && (at == null || Math.abs(found[i] - y) < Math.abs(at - y))) at = found[i];
    if (at != null) deck = true;
    else if (edge != null && this.push) { at = this.pushY; deck = true; push = this.push; } // (just off its deck's edge, onto it)
    else {
      // (its road not known, or no deck of its road here: the street or the deck nearest its level, and not one more
      // than 3 m under it or 2 over; a car just past the end of its road, at a junction, is on the next one's)
      at = street;
      for (let i = 0; i < found.length; i += 3) {
        const dh = found[i] - y;
        if (dh <= 2 && dh >= -3 && Math.abs(dh) < Math.abs(at - y)) { at = found[i]; deck = true; }
      }
      if (!deck && this.push && Math.abs(this.pushY - y) < Math.abs(street - y)) { at = this.pushY; deck = true; push = this.push; }
    }
    // up onto a deck drawn just over that: one too low to drive under
    for (let up = true; up;) {
      up = false;
      let top = at;
      for (let i = 0; i < found.length; i += 3) {
        const dh = found[i] - at;
        if (dh > 0.02 && (dh <= LOW || (dh <= CLEAR && found[i + 2])) && found[i] > top) top = found[i];
      }
      if (top > at) { at = top; deck = true; up = true; }
    }
    if (!deck) push = null;
    return { y: at, deck, push };
  }
}

// ---------------------------------------------------------------- merges
// Where two decks run the same way and their paving overlaps (a ramp merging into the expressway, or leaving it), the
// one is drawn over the other's edge, and the levels the compiler gave them can differ there by a metre or two (each
// road's own profile, measured on its own): the cars on the lower were hidden inside the higher, or stepped up onto it
// (DrawnDecks.stand). Here the lesser of the two (a ramp before the expressway; fewer lanes; the lower, if alike)
// takes the greater's level over the overlap, easing back to its own either side at a grade of at most `grade`, so
// that the two meet as one carriageway. Run after landDecks, before anything uses the levels (DrawnDecks, the flyovers, the
// traffic); the simulation's levels stay in pts0. Returns { roads, metres } moved.
export function mergeDecks(roads, ground, { grade = 0.04, passes = 2 } = {}) {
  const lanesOf = roadLanes(roads.edges);
  const half = (e) => pavedHalf(e, lanesOf(e)).half;
  const rank = (e) => (e.highway === 'motorway' ? 2000 : e.highway === 'trunk' ? 1000 : 0) + Math.max(1, lanesOf(e) || e.lanes || 1) * 10 + half(e);
  const moved = new Set();
  let metres = 0;
  for (let pass = 0; pass < passes; pass++) {
    const decks = new DrawnDecks(roads, ground), built = structureEdges(roads.edges, ground), plans = [];
    for (const e of roads.edges) {
      if (e.tunnel || e.span || !built.has(e)) continue;
      const cs = sections(e.pts, ground), [from, to] = built.get(e), he = half(e), re = rank(e), sign = e.oneway === -1 ? -1 : 1;
      const off = new Array(cs.length).fill(null);
      let any = false;
      for (let i = 0; i < cs.length; i++) {
        const c = cs[i];
        if (c.s < from || c.s > to || (c.h <= RAMP_ABOVE && !leftOut(e))) continue; // (its deck drawn there)
        const y = c.p[1];
        let best = null, bestRank = -1;
        for (const [x0, y0, z0, x1, y1, z1, w, o] of decks.cells.get(key(c.p[0], c.p[2])) ?? []) {
          if (o === e) continue;
          const dx = x1 - x0, dz = z1 - z0, l2 = dx * dx + dz * dz || 1, t = ((c.p[0] - x0) * dx + (c.p[2] - z0) * dz) / l2;
          if (t < -0.15 || t > 1.15) continue;
          // (the same way: a dual carriageway's two decks, each the other way, are left as they are)
          const al = (dx * c.t[0] + dz * c.t[2]) / Math.sqrt(l2) * sign;
          if ((o.oneway ? al * (o.oneway === -1 ? -1 : 1) : Math.abs(al)) < 0.7) continue;
          const f = Math.max(0, Math.min(1, t)), d = Math.hypot(x0 + dx * f - c.p[0], z0 + dz * f - c.p[2]), h = y0 + (y1 - y0) * f;
          if (he + (w - 0.25) - d < 0.5 || Math.abs(h - y) < 0.05 || Math.abs(h - y) > 3) continue; // (pavings overlapping)
          const ro = rank(o);
          if (ro < re || (ro === re && h < y)) continue; // (the greater keeps its level)
          if (ro > bestRank) { bestRank = ro; best = h; }
        }
        if (best != null) { off[i] = best - y; any = true; }
      }
      if (any) plans.push([e, cs, off]);
    }
    if (!plans.length) break;
    // the offset at every section of each road: over its overlaps, the greater's level less its own; from there no
    // faster than `grade` a metre (on top of its own grade) down to nothing
    const vals = new Map();
    for (const [e, cs, off] of plans) {
      const n = cs.length, up = new Float64Array(n), down = new Float64Array(n);
      for (let i = 0; i < n; i++) if (off[i] != null) { if (off[i] > 0) up[i] = off[i]; else down[i] = -off[i]; }
      for (const a of [up, down]) {
        for (let i = 1; i < n; i++) a[i] = Math.max(a[i], a[i - 1] - grade * (cs[i].s - cs[i - 1].s));
        for (let i = n - 2; i >= 0; i--) a[i] = Math.max(a[i], a[i + 1] - grade * (cs[i + 1].s - cs[i].s));
      }
      vals.set(e, Float64Array.from(up, (u, i) => u - down[i]));
    }
    // at either end, a road beyond that keeps its level holds the road there; where every road at the node moves,
    // they move alike there (by their mean)
    const ends = new Map();
    for (const e of roads.edges) for (const [node, last] of [[e.a, false], [e.b, true]]) {
      const v = vals.get(e);
      let r = ends.get(node);
      if (!r) ends.set(node, (r = { sum: 0, n: 0, fixed: false }));
      if (!v) r.fixed = true; else { r.sum += last ? v[v.length - 1] : v[0]; r.n++; }
    }
    const nodeVal = (node) => { const r = ends.get(node); return r.fixed ? 0 : r.sum / r.n; };
    for (const [e, cs] of plans) {
      const v = vals.get(e), L = cs.at(-1).s, a = nodeVal(e.a), b = nodeVal(e.b);
      for (let i = 0; i < v.length; i++) {
        // (within the grade of both ends' values; where a short road cannot be, straight from the one to the other)
        const s = cs[i].s, lo = Math.max(a - grade * s, b - grade * (L - s)), hi = Math.min(a + grade * s, b + grade * (L - s));
        v[i] = lo <= hi ? Math.min(Math.max(v[i], lo), hi) : a + (b - a) * (L ? s / L : 0);
      }
    }
    for (const [e, cs, off] of plans) {
      const n = cs.length, val = vals.get(e);
      // the road's points: one at every section where its level changes (its line as it was), each moved
      const p = e.pts, m = p.length / 3, cum = [0];
      for (let k = 1; k < m; k++) cum.push(cum[k - 1] + Math.hypot(p[k * 3] - p[k * 3 - 3], p[k * 3 + 2] - p[k * 3 - 1]));
      const old0 = e.pts0 ?? Array.from({ length: m }, (_, k) => p[k * 3 + 1]);
      const offAt = (s) => {
        let j = Math.min(n - 1, Math.max(0, Math.round(s / 3)));
        while (j > 0 && cs[j].s > s) j--;
        while (j < n - 1 && cs[j + 1].s <= s) j++;
        if (j >= n - 1) return val[n - 1];
        const t = (s - cs[j].s) / Math.max(1e-6, cs[j + 1].s - cs[j].s);
        return val[j] + (val[j + 1] - val[j]) * t;
      };
      const pts = [], pts0 = [];
      let k = 0;
      for (let i = 0; i <= n; i++) {
        // (the road's own points up to this section, then the section's, where it moves)
        const s = i < n ? cs[i].s : Infinity;
        while (k < m && cum[k] <= s + 1e-6) {
          pts.push(p[k * 3], p[k * 3 + 1] + offAt(cum[k]), p[k * 3 + 2]); pts0.push(old0[k]);
          k++;
        }
        if (i >= n) break;
        if (Math.abs(val[i]) < 1e-4 && (i === 0 || Math.abs(val[i - 1]) < 1e-4) && (i === n - 1 || Math.abs(val[i + 1]) < 1e-4)) continue;
        if (k > 0 && Math.abs(cum[k - 1] - s) < 0.05) continue;
        if (k >= m || Math.abs(cum[k] - s) < 0.05) continue;
        const f = (s - cum[k - 1]) / Math.max(1e-6, cum[k] - cum[k - 1]);
        pts.push(cs[i].p[0], cs[i].p[1] + val[i], cs[i].p[2]); pts0.push(old0[k - 1] + (old0[k] - old0[k - 1]) * f);
      }
      e.pts = pts; e.pts0 = pts0;
      moved.add(e);
      metres += off.filter((v) => v != null).length * 3;
    }
  }
  return { roads: moved.size, metres };
}
