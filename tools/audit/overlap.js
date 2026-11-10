// Run in the page by tools/audit/probe.mjs: node tools/audit/probe.mjs --sim=1 --q='time=7.5&cam=4940,6475,300,0,25' --js=tools/audit/overlap.js
// Bodies inside one another in a jam: as drawn, and as SUMO has the cars (track point = front bumper, the body behind
// it along the track), at the same frames: is it the data or the drawing?
const S = A.sim, dt = 1 / 30, Sim = S.constructor;
let cur = [];
S.trace = (vid, x, y, z, band, simY, sy, raised, shown, heading, spec) => { if (band === 'near' && shown > 0.9) cur.push({ vid, x, y, z, h: heading, L: spec.L }); };
const test = (cars) => {
  let n = 0, depth = 0, worst = 0; const ex = [];
  for (const a of cars) for (const b of cars) {
    if (a === b) continue;
    let dh = a.h - b.h; dh = Math.atan2(Math.sin(dh), Math.cos(dh)); if (Math.abs(dh) > 0.3) continue;
    const hx = Math.sin(a.h), hz = Math.cos(a.h), fx = b.x - a.x, fz = b.z - a.z, along = fx * hx + fz * hz, side = Math.abs(fx * hz - fz * hx);
    if (along <= 0 || side > 1.0 || Math.abs(a.y - b.y) > 1.5) continue;
    const gap = along - (a.L + b.L) / 2;
    if (gap < -0.15) { n++; depth += -gap; worst = Math.max(worst, -gap); if (ex.length < 5) ex.push({ a: a.vid, b: b.vid, gap: +gap.toFixed(2), x: Math.round(a.x), z: Math.round(a.z) }); }
  }
  return { n, depth: +depth.toFixed(1), worst: +worst.toFixed(2), ex };
};
const out = [];
for (let f = 0; f < 300; f++) {
  cur = []; step(dt);
  if (f % 30 !== 15) continue;
  const T = A.clockTime.hour * 3600, W = S.windows.get(S.windowStart(T)), drawn = cur, want = new Map(drawn.map((c) => [c.vid, c]));
  const raw = [], p = [0, 0, 0], q = [0, 0, 0];
  for (let i = 0; i < W.n; i++) {
    const c = want.get(W.vid[i]); if (!c) continue;
    if (!Sim.at(W, i, T, p)) continue;
    let h = c.h;
    if (Sim.at(W, i, T + 0.6, q) && Math.hypot(q[0] - p[0], q[2] - p[2]) > 0.2) h = Math.atan2(q[0] - p[0], q[2] - p[2]);
    else if (Sim.at(W, i, T - 0.6, q) && Math.hypot(q[0] - p[0], q[2] - p[2]) > 0.2) h = Math.atan2(p[0] - q[0], p[2] - q[2]);
    raw.push({ vid: c.vid, x: p[0] - Math.sin(h) * c.L / 2, y: p[1], z: p[2] - Math.cos(h) * c.L / 2, h, L: c.L });
  }
  out.push({ f, cars: drawn.length, drawn: test(drawn), raw: test(raw) });
}
S.trace = null;
const sum = (k) => out.reduce((s, o) => s + o[k].n, 0);
return { checks: out.length, drawnOverlaps: sum('drawn'), rawOverlaps: sum('raw'), first: out.slice(0, 3) };
