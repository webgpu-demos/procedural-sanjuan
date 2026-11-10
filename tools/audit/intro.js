// Run in the page by tools/audit/probe.mjs, with the opening on:
//   node tools/audit/probe.mjs --sim=1 --xp=1 --js=tools/audit/intro.js
// Each shot of the opening played frame by frame as it is seen (30 a second): per shot, the cars' pops (a step in the
// distance moved a frame), snaps (in heading), hops (in height), blinks (shown to hidden in a frame), bodies drawn inside
// one another, frames the clock waited for cars (stalls), and GL errors.
const S = A.sim, X = A.xp, dt = 1 / 30, gl = A.renderer.getContext();
if (!X) return { error: 'no opening (?xp=1)' };
const shots = X.reel ?? X.shots, out = [];
X.directing = true; X.reel = X.shots; X.reelName = 'intro';
let cur = [];
S.trace = (vid, x, y, z, band, simY, sy, raised, shown, heading, spec) => { if (band !== 'far') cur.push([vid, x, y, z, band === 'near' ? 0 : 1, shown, heading, spec.L]); };
for (let k = 0; k < shots.length; k++) {
  const s = shots[k];
  const cutting = X.cut(k);
  for (let i = 0; i < 1200 && (X.shot !== k || X.fading); i++) { step(dt); await sleep(25); }
  await cutting;
  const st = { shot: k, hour: s.hour, ride: !!s.ride, frames: 0, cars: 0, pops: 0, bigPops: 0, snaps: 0, hops: 0, blinks: 0, overlaps: 0, stalls: 0, gl: 0, ex: [] };
  const prev = new Map(), n = Math.floor((s.dur - 0.1) / dt);
  for (let f = 0; f < n; f++) {
    cur = []; step(dt); st.frames++;
    if (!S.ready(A.clockTime.hour * 3600)) st.stalls++;
    if (f % 30 === 0) for (let e = gl.getError(), m = 0; e && m < 8; e = gl.getError(), m++) st.gl++;
    for (const c of cur) {
      const [vid, x, y, z, , shown, h] = c, p = prev.get(vid);
      st.cars++;
      const d = p ? Math.hypot(x - p.x, z - p.z) : null;
      if (p && p.f === f - 1 && p.d != null && Math.min(shown, p.shown) > 0.3) {
        const dd = Math.abs(d - p.d);
        if (dd > 0.25) { st.pops++; if (dd > 1) { st.bigPops++; if (st.ex.length < 4) st.ex.push({ f, vid, d: +d.toFixed(2), was: +p.d.toFixed(2), x: Math.round(x), z: Math.round(z) }); } }
        let dh = h - p.h; dh = Math.atan2(Math.sin(dh), Math.cos(dh));
        if (Math.abs(dh) > 0.1) st.snaps++;
        if (Math.abs(y - p.y) > 0.12 + 0.25 * d) st.hops++;
      }
      if (p && p.f === f - 1 && p.shown > 0.95 && shown < 0.6) st.blinks++;
      prev.set(vid, { x, y, z, h, shown, d: p && p.f === f - 1 ? d : null, f });
    }
    if (f % 30 === 15) {
      const near = cur.filter((c) => c[4] === 0 && c[5] > 0.9);
      for (const a of near) for (const b of near) {
        if (a === b) continue;
        let dh = a[6] - b[6]; dh = Math.atan2(Math.sin(dh), Math.cos(dh)); if (Math.abs(dh) > 0.3) continue;
        const hx = Math.sin(a[6]), hz = Math.cos(a[6]), fx = b[1] - a[1], fz = b[3] - a[3], along = fx * hx + fz * hz, side = Math.abs(fx * hz - fz * hx);
        if (along > 0 && side <= 1.0 && Math.abs(a[2] - b[2]) <= 1.5 && along - (a[7] + b[7]) / 2 < -0.15) st.overlaps++;
      }
    }
    if (f % 10 === 0) await sleep(1);
  }
  out.push(st);
}
S.trace = null; X.directing = false;
return out;
