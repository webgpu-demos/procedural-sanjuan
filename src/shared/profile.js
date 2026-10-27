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

// (a flyover: carried clear over a road or a railway, classifyBridges; the compiler's own rule was every
// expressway bridge, and every bridge two layers up)
const flyover = (e) => !!e.flyover && !e.tunnel;
const elevatable = (e) => !e.tunnel && (flyover(e) || e.highway.startsWith('motorway'));

// The bridges carried over a road or a railway are the flyovers. The compiler (roadprofile.mjs) lifted every
// expressway bridge to a flyover's 7 m clearance; most cross something, but a quarter of San Juan's cross a
// creek, a canal or a dip with nothing mapped under them, and stood up as humps between walled ramps: PR-22's
// two short bridges over the Quebrada Margarita at the Expreso Kennedy, one carriageway 4 m up, the other 12.
// A bridge is counted with the bridges it runs on into (a viaduct mapped in pieces, only one of them over the
// road): a run of bridges none of which crosses anything is a bridge at grade (`grade`), flush with the roads at
// its ends and straight from bank to bank, as is every street bridge that is not a span. (A grade bridge is left
// out of the tiles' road surfaces, as every bridge that is not a span is: src/world/flyovers.js draws its deck.)
// rails: rails.json. Returns the number of bridges at grade.
export function classifyBridges(roads, rails = []) {
  const CELL = 64, grid = new Map(), lines = [];
  for (const e of roads.edges) lines.push({ e, pts: e.pts, layer: e.layer || 0, tunnel: e.tunnel });
  for (const r of rails) lines.push({ e: r, pts: r.pts, layer: r.layer || 0, tunnel: r.tunnel });
  const cells = (p, k, each) => {
    const x0 = Math.floor(Math.min(p[k - 3], p[k]) / CELL), x1 = Math.floor(Math.max(p[k - 3], p[k]) / CELL);
    const z0 = Math.floor(Math.min(p[k - 1], p[k + 2]) / CELL), z1 = Math.floor(Math.max(p[k - 1], p[k + 2]) / CELL);
    for (let i = x0; i <= x1; i++) for (let j = z0; j <= z1; j++) each(i + ',' + j);
  };
  lines.forEach((l, li) => {
    for (let k = 3; k < l.pts.length; k += 3) cells(l.pts, k, (key) => { if (!grid.has(key)) grid.set(key, []); grid.get(key).push(li, k); });
  });
  // (segments crossing, not merely meeting at an end)
  const cross = (ax, az, bx, bz, cx, cz, dx, dz) => {
    const r0 = bx - ax, r1 = bz - az, s0 = dx - cx, s1 = dz - cz, den = r0 * s1 - r1 * s0;
    if (Math.abs(den) < 1e-9) return false;
    const t = ((cx - ax) * s1 - (cz - az) * s0) / den, u = ((cx - ax) * r1 - (cz - az) * r0) / den;
    return t > 0.001 && t < 0.999 && u > 0.001 && u < 0.999;
  };
  const over = (e) => {
    const p = e.pts, top = Math.max(1, e.layer || 0);
    for (let k = 3; k < p.length; k += 3) {
      let hit = false;
      cells(p, k, (key) => {
        const c = grid.get(key);
        for (let i = 0; c && !hit && i < c.length; i += 2) {
          const l = lines[c[i]], q = l.pts, m = c[i + 1];
          if (l.e === e || !(l.tunnel || l.layer < top)) continue; // (only what passes beneath)
          hit = cross(p[k - 3], p[k - 1], p[k], p[k + 2], q[m - 3], q[m - 1], q[m], q[m + 2]);
        }
      });
      if (hit) return true;
    }
    return false;
  };
  // runs of bridges, joined end to end
  const bridges = roads.edges.filter((e) => e.bridge && !e.tunnel && !e.span), at = new Map();
  for (const e of bridges) for (const n of [e.a, e.b]) { if (!at.has(n)) at.set(n, []); at.get(n).push(e); }
  const seen = new Set();
  let grade = 0;
  for (const start of bridges) {
    if (seen.has(start)) continue;
    const run = [start];
    seen.add(start);
    for (let i = 0; i < run.length; i++) for (const n of [run[i].a, run[i].b]) for (const o of at.get(n)) if (!seen.has(o)) { seen.add(o); run.push(o); }
    if (run.some((e) => e.flyover) && run.some(over)) continue;
    for (const e of run) { e.flyover = 0; e.grade = 1; grade++; }
  }
  return grade;
}

// A bridge at grade from bank to bank: the points where a run of them meets the other roads at the ground there
// (the tiles drape those roads on it), the points between in a straight line from one to the next along the run
// (a harmonic fill: straight along a single bridge, even across a branching one), and never under the ground.
function gradeLevels(roads, ground) {
  const id = new Map(), X = [], Z = [], nb = [], end = [];
  const point = (key, x, z) => {
    let i = key != null ? id.get(key) : undefined;
    if (i === undefined) { i = X.length; X.push(x); Z.push(z); nb.push([]); end.push(false); if (key != null) id.set(key, i); }
    return i;
  };
  const other = new Set(); // (nodes of the roads that are not bridges at grade)
  for (const e of roads.edges) if (!e.grade) { other.add(e.a); other.add(e.b); }
  const runs = roads.edges.filter((e) => e.grade).map((e) => {
    const p = e.pts, n = p.length / 3, out = [];
    for (let k = 0; k < n; k++) {
      const node = k === 0 ? e.a : k === n - 1 ? e.b : null, i = point(node != null ? 'n' + node : null, p[k * 3], p[k * 3 + 2]);
      if (node != null && other.has(node)) end[i] = true;
      out.push(i);
    }
    for (let k = 1; k < n; k++) {
      const w = 1 / Math.max(0.5, Math.hypot(X[out[k]] - X[out[k - 1]], Z[out[k]] - Z[out[k - 1]]));
      nb[out[k]].push(out[k - 1], w); nb[out[k - 1]].push(out[k], w);
    }
    return [e, out];
  });
  const y = Float64Array.from(X, (x, i) => ground(x, Z[i]));
  const free = [...X.keys()].filter((i) => !end[i] && nb[i].length);
  if (free.length < X.length) { // (a run that meets no other road stays on the ground)
    for (let it = 0; it < 2000; it++) {
      let moved = 0;
      for (const i of free) {
        let sw = 0, sy = 0;
        for (let k = 0; k < nb[i].length; k += 2) { sw += nb[i][k + 1]; sy += nb[i][k + 1] * y[nb[i][k]]; }
        const v = sy / sw; moved = Math.max(moved, Math.abs(v - y[i])); y[i] = v;
      }
      if (moved < 0.002) break;
    }
  }
  for (const [e, out] of runs) {
    const p = e.pts, old = [];
    let moved = 0;
    out.forEach((i, k) => {
      const v = end[i] ? y[i] : Math.max(y[i], ground(X[i], Z[i]) + 0.1);
      old.push(p[k * 3 + 1]); moved = Math.max(moved, Math.abs(p[k * 3 + 1] - v)); p[k * 3 + 1] = v;
    });
    if (moved > 0.5) e.pts0 ??= old;
  }
}

// ground(x, z): the terrain; rails: rails.json (what a bridge may cross). Returns the number of edges corrected.
export function correctProfiles(roads, ground, rails = []) {
  classifyBridges(roads, rails);
  gradeLevels(roads, ground);
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
    if (!elevatable(e) || !(flyover(e) || e.span || e.grade)) return;
    const p = e.pts;
    for (let k = 0; k < p.length; k += 3) {
      const id = key(e, ei, k);
      level.set(id, bridges.has(id) ? Math.max(level.get(id), p[k + 1]) : p[k + 1]); bridges.add(id); fixed.add(id);
    }
  });
  // ...then the expressway on the ground: its points from the ground round them (an ordinary road's node as it was)
  roads.edges.forEach((e, ei) => {
    if (!elevatable(e)) return;
    const p = e.pts, keep = flyover(e) || e.span || e.grade;
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
