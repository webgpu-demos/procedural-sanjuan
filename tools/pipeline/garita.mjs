// Garita's island-wide building tiles (https://github.com/webgpu-demos/garita), read in Node: tiles/bld/14/{x}/{y}.bin
// (GBL1) and the ids file beside each (one line per record: "<gers>,<osm>,<height source>"). The format is
// described in Garita's tiles/bld/index.json. The compiler takes two things from them, per OSM building:
//   gers    the Overture GERS id Garita carries for it: the key both twins name a building by (?bld= in a link)
//   height  Garita's height where it was measured from the lidar point cloud (source 'lidar'), which beats
//           building:levels and the FEMA footprint average here (an OSM height tag still wins)
// FEMA-only buildings take the GERS id of the Garita building holding their middle.
import fs from 'node:fs';
import path from 'node:path';

export const GARITA = 'https://webgpu-demos.github.io/garita/';
export const BLD_Z = 14;
const PAD = 0.25, SPAN = 1 + 2 * PAD;

const n = (z) => 2 ** z;
export const lonToTileX = (lon, z) => (lon + 180) / 360 * n(z);
export const latToTileY = (lat, z) => { const s = Math.sin(lat * Math.PI / 180); return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n(z); };
export const tileLon = (x, z) => x / n(z) * 360 - 180;
export const tileLat = (y, z) => Math.atan(Math.sinh(Math.PI * (1 - 2 * y / n(z)))) * 180 / Math.PI;

/** The z14 tiles covering a bounding box: { x0, x1, y0, y1 } (inclusive). */
export function tileRange({ west, south, east, north }) {
  return { x0: Math.floor(lonToTileX(west, BLD_Z)), x1: Math.floor(lonToTileX(east, BLD_Z)),
    y0: Math.floor(latToTileY(north, BLD_Z)), y1: Math.floor(latToTileY(south, BLD_Z)) };
}

/** Decodes a GBL1 tile; `ids` is its ids text or null. Records: { ring [[lon, lat]], lon, lat, height, added, gers, osm, hsrc }. */
export function decodeTile(buf, x, y, ids) {
  const dv = new DataView(buf.buffer ?? buf, buf.byteOffset ?? 0, buf.byteLength);
  if (dv.byteLength < 8 || String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3)) !== 'GBL1') throw new Error('not a GBL1 tile');
  const count = dv.getUint32(4, true), lines = ids ? ids.split('\n') : [], out = [];
  let o = 8;
  for (let i = 0; i < count; i++) {
    const nv = dv.getUint16(o, true), h = dv.getUint8(o + 2), kind = dv.getUint8(o + 3);
    o += 8;
    const ring = [];
    let sx = 0, sy = 0;
    for (let k = 0; k < nv; k++, o += 4) {
      const lon = tileLon(x + dv.getUint16(o, true) / 65535 * SPAN - PAD, BLD_Z), lat = tileLat(y + dv.getUint16(o + 2, true) / 65535 * SPAN - PAD, BLD_Z);
      ring.push([lon, lat]); sx += lon; sy += lat;
    }
    const [gers, osm, hsrc] = (lines[i] ?? '').split(',');
    out.push({ ring, lon: sx / Math.max(1, nv), lat: sy / Math.max(1, nv), height: h / 2, added: (kind & 0x80) !== 0, gers: gers || null, osm: osm || null, hsrc: hsrc || null });
  }
  return out;
}

function inRing(ring, lon, lat) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > lat) !== (yj > lat) && lon < (xj - xi) * (lat - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * Reads the tiles fetched into `dir` (dir/14/{x}/{y}.bin and .ids). Returns null when there are none, else
 * { byOsm: Map('w123' -> record), at(lon, lat) -> record holding the point or null, stats }.
 */
export function readGarita(dir) {
  const root = path.join(dir, String(BLD_Z));
  if (!fs.existsSync(root)) return null;
  const byOsm = new Map(), cells = new Map(), stats = { tiles: 0, records: 0, withIds: 0, withGers: 0, lidar: 0 };
  const CELL = 0.0005; // about 50 m: records by the cell of their middle, for at()
  for (const xs of fs.readdirSync(root)) {
    for (const f of fs.readdirSync(path.join(root, xs))) {
      if (!f.endsWith('.bin')) continue;
      const y = Number(f.slice(0, -4)), x = Number(xs), idsFile = path.join(root, xs, `${y}.ids`);
      const ids = fs.existsSync(idsFile) ? fs.readFileSync(idsFile, 'utf8') : null;
      const recs = decodeTile(fs.readFileSync(path.join(root, xs, f)), x, y, ids);
      stats.tiles++; stats.records += recs.length;
      if (ids) stats.withIds += recs.length;
      for (const r of recs) {
        if (r.gers) stats.withGers++;
        if (r.hsrc === 'lidar') stats.lidar++;
        if (r.osm) byOsm.set(r.osm, r);
        const k = Math.floor(r.lon / CELL) + ',' + Math.floor(r.lat / CELL);
        if (!cells.has(k)) cells.set(k, []);
        cells.get(k).push(r);
      }
    }
  }
  if (!stats.tiles) return null;
  const at = (lon, lat) => {
    const ci = Math.floor(lon / CELL), cj = Math.floor(lat / CELL);
    for (let i = ci - 1; i <= ci + 1; i++) for (let j = cj - 1; j <= cj + 1; j++)
      for (const r of cells.get(i + ',' + j) ?? []) if (inRing(r.ring, lon, lat)) return r;
    return null;
  };
  return { byOsm, at, stats };
}
