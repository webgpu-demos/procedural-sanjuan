// The expressway's height, corrected where the elevation model misleads it. The compiler (tools/pipeline/
// roadprofile.mjs) puts each expressway node at the terrain's height there and raises its neighbours to keep a 6%
// grade; but the elevation model has the decks of the overpasses crossing the expressway in it, narrow ridges up
// to 13 m high, and a node on one became a hump of ramps 200 m long either side, built as walled structure and
// driven by the simulated cars, over an expressway that runs on the ground. Here each expressway point not on a
// bridge takes the ground from a low percentile of the terrain round it (a ridge a few metres wide does not
// count; an embankment does), the bridges and flyovers keep their levels, and the same 6% grade is laid
// over again, so a ramp still climbs to every flyover. And an expressway bridge on its embankment (the banks
// standing well above the street or the creek it crosses) runs level from bank to bank, as the compiler already
// has an ordinary road's bridge do: it does not climb a flyover's clearance over the embankment's top (a 7 m
// hump, 120 m of walled ramp either side, where PR-22 crosses an underpass). roads.json is corrected in place;
// each edge whose levels moved by more than half a metre keeps its old ones in `pts0` (the simulation drove
// those: simtraffic.js), unless roads.json already carries them (an area whose ground was replaced after the
// simulation: tools/pipeline/reterrain.mjs).
const MAX_GRADE = 0.06, REACH = 22, LOW = 0.3; // (as roadprofile.mjs; metres round a point; the percentile)
const SPAN_DIP = 2.5, BANK = 14;                 // (as roadprofile.mjs)

const flyover = (e) => e.bridge && !e.tunnel && (e.highway.startsWith('motorway') || e.layer >= 2);
const elevatable = (e) => !e.tunnel && (flyover(e) || e.highway.startsWith('motorway'));

// ground(x, z): the terrain. Returns the number of edges corrected.
export function correctProfiles(roads, ground) {
  const low = (x, z) => {
    const v = [];
    for (let i = -3; i <= 3; i++) for (let j = -3; j <= 3; j++) if (i * i + j * j <= 10) v.push(ground(x + (i * REACH) / 3, z + (j * REACH) / 3));
    v.sort((a, b) => a - b);
    return v[Math.floor(v.length * LOW)];
  };
  // expressway bridges from bank to bank, where the banks stand above the dip they cross (each bank's level the
  // highest ground along the road's line a little beyond the end, as roadprofile.mjs takes it)
  const banked = new Set();
  for (const e of roads.edges) {
    if (!flyover(e) || !e.highway.startsWith('motorway') || e.layer > 1) continue;
    const p = e.pts, n = p.length / 3;
    if (n < 2) continue;
    const bank = (i, j) => { // end i, its neighbour on the bridge j
      const len = Math.hypot(p[i * 3] - p[j * 3], p[i * 3 + 2] - p[j * 3 + 2]) || 1, dx = (p[i * 3] - p[j * 3]) / len, dz = (p[i * 3 + 2] - p[j * 3 + 2]) / len;
      let top = ground(p[i * 3], p[i * 3 + 2]);
      for (let d = 3.5; d <= BANK; d += 3.5) top = Math.max(top, ground(p[i * 3] + dx * d, p[i * 3 + 2] + dz * d));
      return top;
    };
    const a = bank(0, 1), b = bank(n - 1, n - 2);
    let lowest = Infinity, total = 0;
    const cum = [0];
    for (let i = 1; i < n; i++) {
      const len = Math.hypot(p[i * 3] - p[i * 3 - 3], p[i * 3 + 2] - p[i * 3 - 1]);
      for (let s = 0; s <= len; s += 3) lowest = Math.min(lowest, ground(p[i * 3 - 3] + ((p[i * 3] - p[i * 3 - 3]) * s) / (len || 1), p[i * 3 - 1] + ((p[i * 3 + 2] - p[i * 3 - 1]) * s) / (len || 1)));
      total += len; cum.push(total);
    }
    if (Math.min(a, b) - lowest <= SPAN_DIP || total > 400) continue; // (a flyover over flat ground keeps its clearance)
    if (!e.pts0) { e.pts0 = []; for (let i = 0; i < n; i++) e.pts0.push(p[i * 3 + 1]); } // (levels the simulation drove: kept from roads.json if it has them)
    for (let i = 0; i < n; i++) p[i * 3 + 1] = Math.min(p[i * 3 + 1], a + ((b - a) * cum[i]) / (total || 1)); // (only down)
    banked.add(e);
  }
  // the points of the elevatable roads as nodes of a graph: an edge's ends are the road graph's nodes (shared
  // with the edges meeting there), its inner points its own
  const level = new Map(), fixed = new Set(), segs = [], touched = [];
  const key = (e, ei, k) => (k === 0 ? 'n' + e.a : k === e.pts.length - 3 ? 'n' + e.b : 'e' + ei + '_' + k);
  roads.edges.forEach((e, ei) => {
    if (elevatable(e)) return;
    for (const n of [e.a, e.b]) fixed.add('n' + n); // (an ordinary road's node stays where it is: ramps land)
  });
  // first the bridges and flyovers, at their levels (a node they share with an expressway is theirs)...
  const bridges = new Set();
  roads.edges.forEach((e, ei) => {
    if (!elevatable(e) || !(flyover(e) || e.span)) return;
    const p = e.pts;
    for (let k = 0; k < p.length; k += 3) {
      const id = key(e, ei, k);
      level.set(id, bridges.has(id) ? Math.max(level.get(id), p[k + 1]) : p[k + 1]); bridges.add(id); fixed.add(id);
    }
  });
  // ...then the expressway on the ground: its points from the ground round them (an ordinary road's node as it was)
  roads.edges.forEach((e, ei) => {
    if (!elevatable(e)) return;
    const p = e.pts, keep = flyover(e) || e.span;
    if (!keep) touched.push(ei);
    for (let k = 0; k < p.length; k += 3) {
      const id = key(e, ei, k);
      if (!keep && !bridges.has(id)) {
        const y = fixed.has(id) ? p[k + 1] : Math.min(p[k + 1], low(p[k], p[k + 2]));
        level.set(id, level.has(id) ? Math.max(level.get(id), y) : y);
      }
      if (k) { const d = Math.hypot(p[k] - p[k - 3], p[k + 2] - p[k - 1]); if (d > 0.01) segs.push([key(e, ei, k - 3), id, d]); }
    }
  });
  // raise the lower end of any stretch that is too steep (never a fixed node), until nothing changes
  for (let pass = 0, changed = true; changed && pass < 400; pass++) {
    changed = false;
    for (const [a, b, d] of segs) {
      const ya = level.get(a), yb = level.get(b), max = MAX_GRADE * d;
      if (ya < yb - max - 1e-3 && !fixed.has(a)) { level.set(a, yb - max); changed = true; }
      else if (yb < ya - max - 1e-3 && !fixed.has(b)) { level.set(b, ya - max); changed = true; }
    }
  }
  let corrected = banked.size;
  for (const ei of touched) {
    const e = roads.edges[ei], p = e.pts, old = [];
    let moved = 0;
    for (let k = 0; k < p.length; k += 3) {
      const y = Math.min(p[k + 1], level.get(key(e, ei, k))); // (it only comes down: a hump taken away)
      old.push(p[k + 1]); moved = Math.max(moved, p[k + 1] - y); p[k + 1] = y;
    }
    if (moved > 0.5) { e.pts0 ??= old; corrected++; }
  }
  return corrected;
}
