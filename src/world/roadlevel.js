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
