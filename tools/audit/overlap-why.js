// Run in the page by tools/audit/probe.mjs, as overlap.js:
//   node tools/audit/probe.mjs --sim=1 --q='time=7.5&cam=4940,6475,300,0,25' --js=tools/audit/overlap-why.js
// Each pair of cars drawn one inside the other (in one line, nose to tail): where SUMO has them, and what the drawing
// did to each (the move from SUMO's place, across and along its way; whether relane put it in a painted lane), so
// that an overlap is put down to its step: two SUMO lanes drawn as one (relane), a move along (the heading the body
// is drawn about, the easing), or SUMO's own.
const S = A.sim, dt = 1 / 30, Sim = S.constructor;
let cur = [];
S.trace = (vid, x, y, z, band, simY, sy, raised, shown, heading, spec, lag) => { if (band === 'near' && shown > 0.9) cur.push({ vid, x, y, z, h: heading, L: spec.L, lag }); };
const rel = (a, b, h) => { const hx = Math.sin(h), hz = Math.cos(h), fx = b.x - a.x, fz = b.z - a.z; return { along: fx * hx + fz * hz, side: fx * hz - fz * hx }; };
const pairs = (cars) => {
  const out = [];
  for (const a of cars) for (const b of cars) {
    if (a === b) continue;
    let dh = a.h - b.h; dh = Math.atan2(Math.sin(dh), Math.cos(dh)); if (Math.abs(dh) > 0.3) continue;
    const r = rel(a, b, a.h);
    if (r.along <= 0 || Math.abs(r.side) > 1.0 || Math.abs(a.y - b.y) > 1.5) continue;
    const gap = r.along - (a.L + b.L) / 2;
    if (gap < -0.15) out.push([a, b, gap]);
  }
  return out;
};
const why = { lanesMerged: 0, along: 0, sumo: 0, other: 0 }, ex = [];
let checks = 0, drawnN = 0;
for (let f = 0; f < 300; f++) {
  cur = []; step(dt);
  if (f % 30 !== 15) continue;
  checks++;
  const T = A.clockTime.hour * 3600, W = S.windows.get(S.windowStart(T));
  const raw = new Map(), p = [0, 0, 0], q = [0, 0, 0], idx = new Map();
  for (let i = 0; i < W.n; i++) idx.set(W.vid[i], i);
  for (const c of cur) {
    const i = idx.get(c.vid); if (i == null || !Sim.at(W, i, T, p)) continue;
    let h = c.h;
    if (Sim.at(W, i, T + 0.6, q) && Math.hypot(q[0] - p[0], q[2] - p[2]) > 0.2) h = Math.atan2(q[0] - p[0], q[2] - p[2]);
    else if (Sim.at(W, i, T - 0.6, q) && Math.hypot(q[0] - p[0], q[2] - p[2]) > 0.2) h = Math.atan2(p[0] - q[0], p[2] - q[2]);
    const mid = [p[0] - Math.sin(h) * c.L / 2, 0, p[2] - Math.cos(h) * c.L / 2];
    raw.set(c.vid, { x: mid[0], z: mid[2], h, relaned: !!S.relane(mid, h) });
  }
  for (const [a, b, gap] of pairs(cur)) {
    drawnN++;
    const ra = raw.get(a.vid), rb = raw.get(b.vid); if (!ra || !rb) { why.other++; continue; }
    const r0 = rel(ra, rb, ra.h), rawGap = r0.along - (a.L + b.L) / 2;
    const ma = rel(ra, a, ra.h), mb = rel(rb, b, rb.h); // (each car's move from SUMO's place: along, side)
    const kind = Math.abs(r0.side) > 1.6 ? 'lanesMerged' : rawGap < -0.15 ? 'sumo' : Math.abs(ma.along - mb.along) > 0.3 || Math.abs(r0.along - rel(a, b, a.h).along) > 0.3 ? 'along' : 'other';
    why[kind]++;
    if (ex.length < 12) ex.push({ kind, at: [Math.round(a.x), Math.round(a.z)], gap: +gap.toFixed(2), rawGap: +rawGap.toFixed(2), rawSide: +r0.side.toFixed(2),
      moveA: [+ma.along.toFixed(2), +ma.side.toFixed(2)], moveB: [+mb.along.toFixed(2), +mb.side.toFixed(2)], relaned: [ra.relaned, rb.relaned], lag: [+a.lag.toFixed(2), +b.lag.toFixed(2)] });
  }
}
S.trace = null;
return { checks, drawnOverlaps: drawnN, why, ex };
