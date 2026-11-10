// Fetches, inflates and decodes the simulated morning's track windows (tools/sim/run.py) off the main thread:
// a window of the rush hour holds tens of thousands of tracks. Replies with transferable typed arrays.
const SJT1 = 0x31544a53, SJT2 = 0x32544a53; // 'SJT1' (rows), 'SJT2' (columns; see window() in run.py)

const cancelled = new Set(); // requests called off before they were unpacked (the clock has gone elsewhere)
async function load(url, id) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  let buf = await res.arrayBuffer();
  if (cancelled.has(id)) return null;
  const b = new Uint8Array(buf, 0, 2);
  // gzip (unless the server already inflated it on the way)
  if (b[0] === 0x1f && b[1] === 0x8b) buf = await new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
  return cancelled.has(id) ? null : unlunge(undip(decode(buf)));
}

// The SUMO net (tools/sim/network.mjs, built with netconvert's --ramps.guess) has junction links whose lane starts
// up to 9 m behind where the lane into it ends: at PR-18 by Las Américas (world 4940, 6475) and on PR-1 (3460,
// 11150). A car crossing one is set back that far, and its track reads 22 -> 6 -> 22 m/s in a second: every car on
// the expressway there braked to 20 km/h and went on, 139 times in a window. No car halves its speed from over 8 m/s
// and regains it within a second, so where a step of a second at most is under half the speed of both the step before
// and the step after (each over 8 m/s), the two knots bounding it are dropped: the car takes the lost metres over the
// three seconds round it instead (22 -> 17 -> 22). The fix proper is a rebuilt net (README: review list).
export function undip(W) {
  const { n, K } = W, sp = (a, b) => Math.hypot(K[b + 1] - K[a + 1], K[b + 3] - K[a + 3]) / Math.max(0.05, K[b] - K[a]);
  let drop = null;
  for (let i = 0; i < n; i++) {
    const s = W.start[i], c = W.count[i];
    for (let j = 1; j < c - 2; j++) {
      const a = (s + j) * 4;
      if (K[a + 4] - K[a] > 1.05) continue;
      const v = sp(a, a + 4), before = sp(a - 4, a), after = sp(a + 4, a + 8);
      if (before > 8 && after > 8 && v < 0.5 * before && v < 0.5 * after) { (drop ??= new Uint8Array(K.length / 4))[s + j] = 1; drop[s + j + 1] = 1; }
    }
  }
  if (!drop) return W;
  // (in place: the knots move only towards the start)
  let o = 0;
  for (let i = 0; i < n; i++) {
    const s = W.start[i], c = W.count[i];
    W.start[i] = o;
    for (let j = 0; j < c; j++) {
      if (drop[s + j]) continue;
      if (o !== s + j) K.copyWithin(o * 4, (s + j) * 4, (s + j) * 4 + 4);
      o++;
    }
    W.count[i] = o - W.start[i];
  }
  W.K = K.subarray(0, o * 4);
  return W;
}

// SUMO clears a jam by setting a car down further along its way (a teleport). run.py parts a track where the jump is
// over 60 m; a shorter one stayed in the track as a step of one second 9 to 50 m long, taken by a car that stood before
// it and stood after: in a jam, a car that had not moved for two minutes shot 20 to 50 m forward in a second (34 of
// the cars on the road at 7:30, 47 at 8:30). The track is parted there instead (a step of a second at most, over
// 9 m, and 8 m/s faster than both the step before it and the step after): the car fades out where it stood and in
// where it was set down, as at the longer jumps. The knots are not moved; the pieces are tracks of their own.
function unlunge(W) {
  const { n, K } = W, cuts = [];
  for (let i = 0; i < n; i++) {
    const s = W.start[i], c = W.count[i];
    for (let j = 1; j < c - 2; j++) {
      const a = (s + j) * 4, dt = K[a + 4] - K[a];
      if (dt > 1.05 || dt <= 0) continue;
      const d = Math.hypot(K[a + 5] - K[a + 1], K[a + 7] - K[a + 3]);
      if (d < 9) continue;
      const v = d / dt, before = Math.hypot(K[a + 1] - K[a - 3], K[a + 3] - K[a - 1]) / Math.max(0.1, K[a] - K[a - 4]);
      const after = Math.hypot(K[a + 9] - K[a + 5], K[a + 11] - K[a + 7]) / Math.max(0.1, K[a + 8] - K[a + 4]);
      if (v - before > 8 && v - after > 8) cuts.push(i, j);
    }
  }
  if (!cuts.length) return W;
  const m = n + cuts.length / 2, vid = new Uint32Array(m), type = new Uint8Array(m), start = new Uint32Array(m), count = new Uint16Array(m);
  let o = 0, q = 0;
  for (let i = 0; i < n; i++) {
    let from = 0;
    const piece = (to) => { // knots from..to of track i, if at least two
      if (to - from >= 1) { vid[o] = W.vid[i]; type[o] = W.type[i]; start[o] = W.start[i] + from; count[o] = to - from + 1; o++; }
      from = to + 1;
    };
    while (q < cuts.length && cuts[q] === i) { piece(cuts[q + 1]); q += 2; }
    piece(W.count[i] - 1);
  }
  return { n: o, t0: W.t0, t1: W.t1, vid: vid.slice(0, o), type: type.slice(0, o), start: start.slice(0, o), count: count.slice(0, o), K };
}

// a window file -> typed arrays (world frame: x east, y up, z south)
export function decode(buf) {
  const dv = new DataView(buf), magic = dv.getUint32(0, true);
  if (magic === SJT2) return decode2(buf, dv);
  if (magic !== SJT1) throw new Error('not a track window');
  const n = dv.getUint32(4, true), t0 = dv.getFloat32(8, true), t1 = dv.getFloat32(12, true);
  const maxKnots = Math.ceil((buf.byteLength - 16) / 8) + n;
  const vid = new Uint32Array(n), type = new Uint8Array(n), start = new Uint32Array(n), count = new Uint16Array(n);
  const K = new Float32Array(maxKnots * 4); // t, x, y, z per knot
  let o = 16, k = 0;
  for (let i = 0; i < n; i++) {
    vid[i] = dv.getUint32(o, true); type[i] = dv.getUint8(o + 4); const c = dv.getUint16(o + 6, true); o += 8;
    let x = dv.getFloat32(o, true), y = dv.getFloat32(o + 4, true), z = dv.getFloat32(o + 8, true), t = dv.getFloat32(o + 12, true); o += 16;
    start[i] = k; count[i] = c;
    K[k * 4] = t; K[k * 4 + 1] = x; K[k * 4 + 2] = z; K[k * 4 + 3] = -y; k++;
    for (let j = 1; j < c; j++) {
      t += dv.getUint16(o, true) / 10; x += dv.getInt16(o + 2, true) / 20; y += dv.getInt16(o + 4, true) / 20; z += dv.getInt16(o + 6, true) / 100; o += 8;
      K[k * 4] = t; K[k * 4 + 1] = x; K[k * 4 + 2] = z; K[k * 4 + 3] = -y; k++;
    }
  }
  return { n, t0, t1, vid, type, start, count, K: K.slice(0, k * 4) };
}

// SJT2: the track columns, then each step as byte planes of what is left after guessing it from the step before
function decode2(buf, dv) {
  const n = dv.getUint32(4, true), t0 = dv.getFloat32(8, true), t1 = dv.getFloat32(12, true), m = dv.getUint32(16, true);
  const u8 = new Uint8Array(buf), o = 20;
  const vid = new Uint32Array(n), type = new Uint8Array(n), start = new Uint32Array(n), count = new Uint16Array(n);
  const K = new Float32Array((n + m) * 4); // t, x, y, z per knot
  const P = o + 23 * n, dt0 = P, dt1 = P + m, X = P + 2 * m, Y = P + 5 * m, Z = P + 8 * m;
  const zz = (base, s) => { const v = u8[base + s] | (u8[base + m + s] << 8) | (u8[base + 2 * m + s] << 16); return (v >>> 1) ^ -(v & 1); };
  let k = 0, s = 0;
  for (let i = 0; i < n; i++) {
    vid[i] = dv.getUint32(o + 4 * i, true); type[i] = u8[o + 4 * n + i]; const c = dv.getUint16(o + 5 * n + 2 * i, true);
    let x = dv.getInt32(o + 7 * n + 4 * i, true), y = dv.getInt32(o + 11 * n + 4 * i, true), z = dv.getInt32(o + 15 * n + 4 * i, true), t = dv.getInt32(o + 19 * n + 4 * i, true);
    start[i] = k; count[i] = c;
    K[k * 4] = t / 10; K[k * 4 + 1] = x / 20; K[k * 4 + 2] = z / 100; K[k * 4 + 3] = -y / 20; k++;
    let px = 0, py = 0, pz = 0, pdt = 1;
    for (let j = 1; j < c; j++, s++) {
      const dt = u8[dt0 + s] | (u8[dt1 + s] << 8);
      let dx = zz(X, s), dy = zz(Y, s), dz = zz(Z, s);
      if (j > 1) { // (the guess: the step before's velocity over this dt, as run.py rounds it)
        const h = pdt >> 1;
        dx += Math.floor((px * dt + h) / pdt); dy += Math.floor((py * dt + h) / pdt); dz += Math.floor((pz * dt + h) / pdt);
      }
      t += dt; x += dx; y += dy; z += dz; px = dx; py = dy; pz = dz; pdt = dt;
      K[k * 4] = t / 10; K[k * 4 + 1] = x / 20; K[k * 4 + 2] = z / 100; K[k * 4 + 3] = -y / 20; k++;
    }
  }
  return { n, t0, t1, vid, type, start, count, K };
}

self.onmessage = async ({ data: { id, url, cancel } }) => {
  if (cancel != null) { cancelled.add(cancel); return; }
  try {
    const W = await load(url, id);
    if (!W) { cancelled.delete(id); return; } // (called off: simtraffic.js has forgotten it)
    self.postMessage({ id, W }, [W.vid.buffer, W.type.buffer, W.start.buffer, W.count.buffer, W.K.buffer]);
  } catch (e) { self.postMessage({ id, error: e.message }); }
};
