// Fetches, inflates and decodes the simulated morning's track windows (tools/sim/run.py) off the main thread:
// a window of the rush hour holds tens of thousands of tracks. Replies with transferable typed arrays.
const SJT1 = 0x31544a53, SJT2 = 0x32544a53; // 'SJT1' (rows), 'SJT2' (columns; see window() in run.py)

async function load(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  let buf = await res.arrayBuffer();
  const b = new Uint8Array(buf, 0, 2);
  // gzip (unless the server already inflated it on the way)
  if (b[0] === 0x1f && b[1] === 0x8b) buf = await new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
  return decode(buf);
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

self.onmessage = async ({ data: { id, url } }) => {
  try {
    const W = await load(url);
    self.postMessage({ id, W }, [W.vid.buffer, W.type.buffer, W.start.buffer, W.count.buffer, W.K.buffer]);
  } catch (e) { self.postMessage({ id, error: e.message }); }
};
