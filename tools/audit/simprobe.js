// Run in the page by tools/audit/probe.mjs: node tools/audit/probe.mjs --sim=1 --q='time=7.5&cam=...' --js=tools/audit/simprobe.js
// How the simulated cars are drawn, frame by frame (sim.trace): steps in the distance moved a frame (pops), in heading
// (snaps), in height (hops), cars that go from shown to hidden in a frame (blinks), bodies drawn inside one another.
const S = A.sim, dt = 1 / 30, N = Number(new URLSearchParams(location.search).get('n') ?? 600);
const prev = new Map(); let cur = [];
S.trace = (vid, x, y, z, band, simY, sy, raised, shown, heading, spec) => { if (band !== 'far') cur.push([vid, x, y, z, band === 'near' ? 0 : 1, shown, heading, spec.L, spec.spec.W]); };
const st = { frames: N, near: { cars: 0, pops: 0, bigPops: 0, snaps: 0, hops: 0, blinks: 0, fadeIns: 0 }, mid: { cars: 0, pops: 0, bigPops: 0, snaps: 0, hops: 0, blinks: 0, fadeIns: 0 }, overlapChecks: 0, overlaps: 0, overlapDepth: 0, worstOverlap: 0, noseGap: [] };
const T0 = A.clockTime.hour * 3600, ex = [];
for (let f = 0; f < N; f++) {
  cur = []; step(dt);
  const seen = new Set();
  for (const c of cur) {
    const [vid, x, y, z, band, shown, h] = c, p = prev.get(vid), b = band ? st.mid : st.near;
    seen.add(vid); b.cars++;
    const d = p ? Math.hypot(x - p.x, z - p.z) : null;
    if (p && p.f === f - 1) {
      if (p.d != null && Math.min(shown, p.shown) > 0.3) {
        const dd = Math.abs(d - p.d);
        if (dd > 0.25) { b.pops++; if (dd > 1) { b.bigPops++; if (ex.length < 6 && !band) ex.push({ f, T: +(A.clockTime.hour * 3600).toFixed(1), vid, kind: 'pop', d: +d.toFixed(2), was: +p.d.toFixed(2), x: Math.round(x), z: Math.round(z) }); } }
        let dh = h - p.h; dh = Math.atan2(Math.sin(dh), Math.cos(dh));
        if (Math.abs(dh) > 0.1) b.snaps++;
        if (Math.abs(y - p.y) > 0.12 + 0.25 * d) b.hops++;
      }
      if (p.shown > 0.95 && shown < 0.6) { b.blinks++; if (ex.length < 6 && !band) ex.push({ f, T: +(A.clockTime.hour * 3600).toFixed(1), vid, kind: 'blink', shown: +shown.toFixed(2) }); }
      if (p.shown < 0.05 && shown >= 0.05) b.fadeIns++;
    }
    prev.set(vid, { x, y, z, h, shown, d: p && p.f === f - 1 ? d : null, f });
  }
  if (f % 20 === 10) {
    const near = cur.filter((c) => c[4] === 0 && c[5] > 0.9); st.overlapChecks++;
    for (let i = 0; i < near.length; i++) for (let j = 0; j < near.length; j++) {
      if (i === j) continue;
      const a = near[i], b = near[j]; let dh = a[6] - b[6]; dh = Math.atan2(Math.sin(dh), Math.cos(dh));
      if (Math.abs(dh) > 0.3) continue;
      const hx = Math.sin(a[6]), hz = Math.cos(a[6]), fx = b[1] - a[1], fz = b[3] - a[3], along = fx * hx + fz * hz, side = Math.abs(fx * hz - fz * hx);
      if (along <= 0 || side > 1.0 || Math.abs(a[2] - b[2]) > 1.5) continue; // b ahead of a, in its lane
      const gap = along - (a[7] + b[7]) / 2;
      if (gap < 12 && st.noseGap.length < 4000) st.noseGap.push(gap);
      if (gap < -0.15) { st.overlaps++; st.overlapDepth += -gap; st.worstOverlap = Math.max(st.worstOverlap, -gap); }
    }
  }
}
S.trace = null;
const g = st.noseGap.sort((a, b) => a - b); st.noseGap = { n: g.length, p10: +(g[Math.floor(g.length * 0.1)] ?? 0).toFixed(2), median: +(g[g.length >> 1] ?? 0).toFixed(2) };
st.worstOverlap = +st.worstOverlap.toFixed(2); st.overlapDepth = +st.overlapDepth.toFixed(1);
return { T0, T1: A.clockTime.hour * 3600, rate: A.clockTime.rate, sim: S.stats, st, ex };
