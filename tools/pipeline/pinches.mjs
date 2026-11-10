// Pinches: where two expressways (or a ramp of two lanes) join, OSM sometimes has the stretch after the join narrower
// than what joins it and than what goes on after it (PR-22 at Kennedy, 4 lanes and a ramp's 2 into 4 for 62 m, then
// 5; PR-18 into PR-22 at Hato Rey, 2 and 2 into 2 for 300 m, then 4). Such a stretch (under MAX m) is given as many
// lanes as come into it, up to as many as go on beyond it: paved and painted so (roadsplit.mjs, markings.mjs), and
// driven so (tools/sim/network.mjs, which widened them on its own before: SUMO drove four lanes where the tiles
// paved two, and the client drew the four in the two, the cars one inside the other).
// edges: the road graph's ({ a, b, ids, highway, oneway, lanes }); pos(id) -> [x, z]. Changes `lanes`; returns
// [{ edge, from, to }] for each widened.
const MAX = 400;
const FAST = /^(motorway|trunk)(_link)?$/;

export function widenPinches(edges, pos) {
  const dir = [], into = new Map(), outOf = new Map();
  const add = (m, k, v) => { if (!m.has(k)) m.set(k, []); m.get(k).push(v); };
  for (const e of edges) {
    if (!FAST.test(e.highway) || !e.oneway) continue;
    const d = { e, from: e.oneway === -1 ? e.b : e.a, to: e.oneway === -1 ? e.a : e.b, link: e.highway.endsWith('_link') };
    dir.push(d); add(into, d.to, d); add(outOf, d.from, d);
  }
  const length = (e) => { let s = 0; for (let k = 1; k < e.ids.length; k++) { const [ax, az] = pos(e.ids[k - 1]), [bx, bz] = pos(e.ids[k]); s += Math.hypot(bx - ax, bz - az); } return s; };
  const was = new Map();
  // (again until nothing changes: a stretch widened can be what goes on beyond another, PR-18's join into PR-22)
  for (let pass = 0, changed = true; changed && pass < 8; pass++) {
    changed = false;
    for (const d of dir) {
      if (d.link || length(d.e) > MAX) continue;
      // (a ramp of one lane joins by its acceleration lane: not counted; src/shared/roadway.js accelLanes)
      const ins = (into.get(d.from) ?? []).filter((o) => o.e !== d.e && (!o.link || o.e.lanes >= 2));
      const outs = (outOf.get(d.to) ?? []).filter((o) => o.e !== d.e && !o.link);
      if (ins.length < 2 || !outs.length) continue; // (a join, and a road going on)
      const want = Math.min(ins.reduce((s, o) => s + o.e.lanes, 0), Math.max(...outs.map((o) => o.e.lanes)));
      if (want > d.e.lanes) { if (!was.has(d.e)) was.set(d.e, d.e.lanes); d.e.lanes = want; changed = true; }
    }
  }
  return [...was].map(([edge, from]) => ({ edge, from, to: edge.lanes }));
}
