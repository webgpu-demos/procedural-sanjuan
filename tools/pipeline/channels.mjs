// Rivers, canals, streams and ditches as channels: water lying level from bank to bank, falling the way it flows,
// in a channel cut into the ground. OSM draws a waterway as a line in the direction of the flow; the tiles had laid
// it on the terrain as a ribbon, which on a hillside tilted with the slope across it, and on the 10 m grid no
// channel narrower than a cell can be cut into the terrain itself. So the channel is its own geometry: the client
// takes the ground out from under it and draws the water and its two banks (src/world/channels.js).
//
// Along each waterway, every few metres: the bed, the lowest ground across the channel and a couple of metres
// either side (the grid has blurred the gully the lidar saw); the water a depth below it, and never higher than
// upstream. Where that would leave the water more than MAXCUT below the bed (a pit in the ground upstream, the line
// drawn across a rise: an embankment over a culvert), the channel stops and starts again past it. It stops where a
// road crosses at street level (the water goes under it), under a building, and where it reaches the sea or a
// lagoon (which carries it on); a bridge passes over it.
//
// The ways of one waterway (OSM cuts a river into many) are joined end to end first. A channel's end runs on, without
// a wall across, into open water or another channel; where the waterway itself begins or ends, a bank slopes across.
//
// channels.json: { channels: [{ k, w, e, p: [x, z, level, ...] }] }, k: CHANNEL, w: the width (m), e: the end
// flags (src/shared/channelshape.js END).
import { bankRun, END } from '../../src/shared/channelshape.js';

export const CHANNEL = { river: 0, canal: 1, stream: 2, ditch: 3 };
const WIDTH = [9, 6, 2.5, 1];            // OSM's default widths (a width tag wins)
const DEPTH = [1.6, 1.4, 0.9, 0.5];     // water below the bed's edge
const MAXCUT = 3.5;                      // water deeper than this below the bed (beyond its depth): no channel
const STEP = 4;                          // metres between samples along the line
const SMOOTH = 8;                        // samples either side, smoothing the level
const SEA = 0;
const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };
const hidden = (t) => (t.tunnel && t.tunnel !== 'no') || t.covered === 'yes' || t.location === 'underground' || (num(t.layer) ?? 0) < 0 || (num(t.level) ?? 0) < 0;
const r2 = (v) => Math.round(v * 100) / 100;

// ways: readExtra()'s; ground(x, z); inBounds(x, z); wet(x, z): the sea or a lagoon; blocked(x, z): a road at
// street level or a building there. Returns { channels, rings, stats } (rings: each channel's outline, for what
// stands in it to be cleared).
export function buildChannels(ways, { ground, inBounds, wet, blocked }) {
  const channels = [], stats = { ways: 0, km: 0, runs: 0, cut: 0, blocked: 0, wet: 0, deep: 0, out: 0, byKind: {} };
  // where a culvert or a tunnel takes a waterway under (the line's nodes there): its ends are a wall, not a source
  const under = new Set();
  for (const w of ways) if (CHANNEL[w.tags.waterway] !== undefined && hidden(w.tags)) { under.add(w.ids[0]); under.add(w.ids.at(-1)); }
  for (const w of chain(ways.filter((w) => CHANNEL[w.tags.waterway] !== undefined && !hidden(w.tags) && !w.closed))) {
    const t = w.tags, k = CHANNEL[t.waterway];
    const width = Math.min(40, Math.max(0.8, num(t.width) ?? WIDTH[k]));
    // the line, its corners rounded (OSM draws a stream in straight pieces), every STEP metres at most
    const pts = round(w.pts), S = [];
    for (let i = 0; i < pts.length; i++) {
      const [x, z] = pts[i];
      if (i) {
        const [px, pz] = pts[i - 1], n = Math.ceil(Math.hypot(x - px, z - pz) / STEP);
        for (let s = 1; s < n; s++) S.push({ x: px + (x - px) * s / n, z: pz + (z - pz) * s / n });
      }
      if (!S.length || Math.hypot(x - S.at(-1).x, z - S.at(-1).z) > 0.2) S.push({ x, z });
    }
    if (S.length < 2) continue;
    stats.ways++;
    // the bed: the lowest ground across, a couple of metres beyond the banks
    const reach = width / 2 + 2;
    for (let i = 0; i < S.length; i++) {
      const a = S[Math.max(0, i - 1)], b = S[Math.min(S.length - 1, i + 1)], l = Math.hypot(b.x - a.x, b.z - a.z) || 1;
      const nx = -(b.z - a.z) / l, nz = (b.x - a.x) / l, s = S[i];
      let bed = Infinity;
      for (let o = -reach; o <= reach + 1e-6; o += Math.max(0.5, reach / 6)) bed = Math.min(bed, ground(s.x + nx * o, s.z + nz * o));
      s.bed = bed;
      s.state = !inBounds(s.x, s.z) ? 'out' : wet(s.x, s.z) ? 'wet' : blocked(s.x, s.z) ? 'blocked' : 'open';
    }
    // the water: a depth below the bed, never above the water upstream (as OSM draws it, or the other way if that
    // cuts less: a line drawn against the flow)
    const level = (order) => {
      const L = new Float64Array(S.length), deep = new Uint8Array(S.length);
      let prev = Infinity, cut = 0;
      for (const i of order) {
        const want = Math.max(SEA, S[i].bed - DEPTH[k]);
        let l = Math.min(want, prev);
        if (want - l > MAXCUT) { deep[i] = 1; l = want; } // (and the level starts again from here)
        else cut += want - l;
        if (S[i].state === 'open') prev = l;
        L[i] = l;
      }
      return { L, deep, cut: cut + deep.reduce((s, v) => s + v * MAXCUT * 4, 0) };
    };
    const fwd = level([...S.keys()]), back = level([...S.keys()].reverse());
    const down = back.cut < fwd.cut ? [...S.keys()].reverse() : [...S.keys()];
    const { L, deep } = back.cut < fwd.cut ? back : fwd;
    // The level held until the bed falls below it comes in steps (a weir every few hundred metres): smoothed into a
    // slope, still under the bed and still falling (within each stretch between two deep places).
    for (let pass = 0; pass < 4; pass++) {
      const M = Float64Array.from(L);
      for (let i = 0; i < S.length; i++) {
        let s = 0, n = 0;
        for (let j = Math.max(0, i - SMOOTH); j <= Math.min(S.length - 1, i + SMOOTH); j++) { s += L[j]; n++; }
        M[i] = Math.min(s / n, Math.max(SEA, S[i].bed - DEPTH[k]));
      }
      let prev = Infinity;
      for (const i of down) {
        if (deep[i]) { prev = Infinity; continue; }
        L[i] = Math.max(SEA, Math.min(M[i], prev));
        if (S[i].state === 'open') prev = L[i];
      }
    }
    // runs of open samples; one sample of open water carried on at either end, so the two meet
    let run = [];
    const flush = () => {
      if (run.length >= 2) {
        let len = 0;
        for (let i = 1; i < run.length; i++) len += Math.hypot(S[run[i]].x - S[run[i - 1]].x, S[run[i]].z - S[run[i - 1]].z);
        if (len >= 6) {
          const first = run[0], last = run.at(-1);
          const e = (S[first].state === 'wet' ? END.OPEN_START : first === 0 && !under.has(w.first) ? END.SOURCE_START : 0)
            | (S[last].state === 'wet' ? END.OPEN_END : last === S.length - 1 && !under.has(w.last) ? END.SOURCE_END : 0);
          const p = [];
          for (const i of run) p.push(r2(S[i].x), r2(S[i].z), r2(L[i]));
          channels.push({ k, w: width, e, p });
          stats.runs++; stats.km += len / 1000;
          stats.byKind[t.waterway] = (stats.byKind[t.waterway] ?? 0) + len / 1000;
        }
      }
      run = [];
    };
    for (let i = 0; i < S.length; i++) {
      const s = S[i], ok = s.state === 'open' && !deep[i];
      if (ok) {
        if (!run.length && i > 0 && S[i - 1].state === 'wet') run.push(i - 1);
        run.push(i);
        stats.cut += s.bed - L[i];
      } else {
        if (s.state === 'wet' && run.length) run.push(i);
        const key = s.state === 'open' ? 'deep' : s.state;
        stats[key] = (stats[key] ?? 0) + 1;
        flush();
      }
    }
    flush();
  }
  // An end in another channel (a stream into a river, a waterway OSM draws as two that meet side by side) runs on
  // into it: no bank across.
  const C = 24, cells = new Map();
  channels.forEach((c, ci) => {
    for (let i = 3; i < c.p.length; i += 3) {
      const k = Math.floor((c.p[i - 3] + c.p[i]) / 2 / C) + ',' + Math.floor((c.p[i - 2] + c.p[i + 1]) / 2 / C);
      if (!cells.has(k)) cells.set(k, []);
      cells.get(k).push([ci, i]);
    }
  });
  const inAnother = (ci, x, z) => {
    for (let a = Math.floor(x / C) - 1; a <= Math.floor(x / C) + 1; a++) for (let b = Math.floor(z / C) - 1; b <= Math.floor(z / C) + 1; b++)
      for (const [cj, i] of cells.get(a + ',' + b) ?? []) {
        if (cj === ci) continue;
        const c = channels[cj], ax = c.p[i - 3], az = c.p[i - 2], dx = c.p[i] - ax, dz = c.p[i + 1] - az;
        const u = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz || 1)));
        if (Math.hypot(x - ax - dx * u, z - az - dz * u) < c.w / 2 + 2) return true;
      }
    return false;
  };
  for (const [ci, c] of channels.entries()) {
    const n = c.p.length;
    if (!(c.e & END.OPEN_START) && inAnother(ci, c.p[0], c.p[1])) c.e = (c.e & ~END.SOURCE_START) | END.OPEN_START;
    if (!(c.e & END.OPEN_END) && inAnother(ci, c.p[n - 3], c.p[n - 2])) c.e = (c.e & ~END.SOURCE_END) | END.OPEN_END;
  }
  // each channel's outline out to its banks' tops (as the client lays them), for what stands in it to be cleared
  const rings = channels.map((c) => {
    const pts = [], sides = [[], []];
    for (let i = 0; i < c.p.length; i += 3) pts.push([c.p[i], c.p[i + 1], c.p[i + 2]]);
    for (let i = 0; i < pts.length; i++) {
      const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)], l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
      const nx = -(b[1] - a[1]) / l, nz = (b[0] - a[0]) / l, [x, z, level] = pts[i];
      [1, -1].forEach((side, s) => {
        const h = ground(x + nx * side * (c.w / 2 + 1.5), z + nz * side * (c.w / 2 + 1.5)) - level, d = c.w / 2 + bankRun(c.k, h) + 0.5;
        sides[s].push([x + nx * side * d, z + nz * side * d]);
      });
    }
    return [...sides[0], ...sides[1].reverse()];
  });
  stats.km = Math.round(stats.km * 10) / 10;
  for (const kk in stats.byKind) stats.byKind[kk] = Math.round(stats.byKind[kk] * 10) / 10;
  return { channels, rings, stats };
}

// A line's corners rounded: each cut back along both its pieces by a quarter of the shorter, at most 6 m, twice
// (Chaikin's corner cutting, its ends kept)
function round(pts) {
  let p = pts;
  for (let pass = 0; pass < 2; pass++) {
    const out = [p[0]];
    for (let i = 1; i + 1 < p.length; i++) {
      const [ax, az] = p[i - 1], [bx, bz] = p[i], [cx, cz] = p[i + 1];
      const l1 = Math.hypot(bx - ax, bz - az), l2 = Math.hypot(cx - bx, cz - bz);
      if (l1 < 1e-6 || l2 < 1e-6) continue;
      const turn = Math.abs(Math.atan2((bx - ax) * (cz - bz) - (bz - az) * (cx - bx), (bx - ax) * (cx - bx) + (bz - az) * (cz - bz)));
      if (turn < 0.08) { out.push(p[i]); continue; }
      const d = Math.min(6, Math.min(l1, l2) / 4);
      out.push([bx - (bx - ax) / l1 * d, bz - (bz - az) / l1 * d], [bx + (cx - bx) / l2 * d, bz + (cz - bz) / l2 * d]);
    }
    out.push(p.at(-1));
    p = out;
  }
  return p;
}

// The ways of one waterway joined end to end: a way whose last node is where exactly one other way of the same kind
// begins (and nothing else of that kind begins or ends) runs on into it. -> [{ tags, pts, first, last }] (first,
// last: the end nodes)
function chain(ways) {
  const starts = new Map(), ends = new Map(), key = (w, id) => `${w.tags.waterway}:${id}`;
  for (const w of ways) {
    const a = key(w, w.ids[0]), b = key(w, w.ids.at(-1));
    if (!starts.has(a)) starts.set(a, []); starts.get(a).push(w);
    if (!ends.has(b)) ends.set(b, []); ends.get(b).push(w);
  }
  const next = (w) => { const k = key(w, w.ids.at(-1)), s = starts.get(k); return s?.length === 1 && ends.get(k).length === 1 && s[0] !== w ? s[0] : null; };
  const prev = (w) => { const k = key(w, w.ids[0]), e = ends.get(k); return e?.length === 1 && starts.get(k).length === 1 && e[0] !== w ? e[0] : null; };
  const used = new Set(), out = [];
  for (const w0 of ways) {
    if (used.has(w0)) continue;
    let head = w0;
    for (let guard = 0; prev(head) && !used.has(prev(head)) && prev(head) !== w0 && guard < 10000; guard++) head = prev(head);
    const pts = [], width = [];
    let ids = null;
    for (let w = head; w && !used.has(w); w = next(w)) {
      used.add(w);
      ids = w.ids.at(-1);
      pts.push(...(pts.length ? w.pts.slice(1) : w.pts));
      if (num(w.tags.width) != null) width.push(num(w.tags.width));
    }
    out.push({ tags: { ...head.tags, width: width.length ? String(Math.max(...width)) : undefined }, pts, first: head.ids[0], last: ids });
  }
  return out;
}
