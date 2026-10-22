// Fetches, inflates and decodes the simulated morning's track windows (tools/sim/run.py) off the main thread:
// a window of the rush hour holds tens of thousands of tracks. Replies with transferable typed arrays.
const MAGIC = 0x31544a53; // 'SJT1'

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
function decode(buf) {
  const dv = new DataView(buf);
  if (dv.getUint32(0, true) !== MAGIC) throw new Error('not a track window');
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

self.onmessage = async ({ data: { id, url } }) => {
  try {
    const W = await load(url);
    self.postMessage({ id, W }, [W.vid.buffer, W.type.buffer, W.start.buffer, W.count.buffer, W.K.buffer]);
  } catch (e) { self.postMessage({ id, error: e.message }); }
};
