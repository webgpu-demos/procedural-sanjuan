// Garita's building tiles read in Node (tools/pipeline/garita.mjs): a GBL1 tile and its ids file, written here by
// the encoding Garita's tiles/bld/index.json describes, decode to the same rings, heights and ids.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { decodeTile, readGarita, tileRange, lonToTileX, latToTileY, BLD_Z } from '../pipeline/garita.mjs';

const enc = (x, y, recs) => {
  const size = 8 + recs.reduce((n, r) => n + 8 + 4 * r.ring.length, 0), b = Buffer.alloc(size);
  b.write('GBL1', 0, 'ascii'); b.writeUInt32LE(recs.length, 4);
  let o = 8;
  for (const r of recs) {
    b.writeUInt16LE(r.ring.length, o); b.writeUInt8(Math.round(r.height * 2), o + 2); b.writeUInt8(r.added ? 0x80 : 1, o + 3); b.writeInt16LE(-32768, o + 4);
    o += 8;
    for (const [lon, lat] of r.ring) {
      b.writeUInt16LE(Math.round((lonToTileX(lon, BLD_Z) - x + 0.25) / 1.5 * 65535), o);
      b.writeUInt16LE(Math.round((latToTileY(lat, BLD_Z) - y + 0.25) / 1.5 * 65535), o + 2);
      o += 4;
    }
  }
  return b;
};
const sq = (lon, lat, d) => [[lon, lat], [lon + d, lat], [lon + d, lat + d], [lon, lat + d]];
const lon = -66.0705, lat = 18.4563, x = Math.floor(lonToTileX(lon, BLD_Z)), y = Math.floor(latToTileY(lat, BLD_Z));
const recs = [
  { ring: sq(lon, lat, 0.0002), height: 31.5 },
  { ring: sq(lon + 0.001, lat, 0.0001), height: 0, added: true },
];
const ids = 'cf29c0cc-f255-4f2f-8453-d43beb5c1961,w113348553,lidar\n2f756e7d-ff8f-4058-a1e6-0b4f0109d909,,\n';
const out = decodeTile(enc(x, y, recs), x, y, ids);
assert.equal(out.length, 2);
assert.equal(out[0].height, 31.5);
assert.equal(out[0].gers, 'cf29c0cc-f255-4f2f-8453-d43beb5c1961');
assert.equal(out[0].osm, 'w113348553');
assert.equal(out[0].hsrc, 'lidar');
assert.equal(out[1].osm, null);
assert.equal(out[1].added, true);
assert.ok(Math.abs(out[0].ring[2][0] - (lon + 0.0002)) < 1e-6 && Math.abs(out[0].ring[2][1] - (lat + 0.0002)) < 1e-6, 'ring to about 10 cm');
assert.equal(decodeTile(enc(x, y, recs), x, y, null)[0].gers, null, 'a tile without ids');

// on disk: by OSM id, and the building under a point
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'garita-'));
fs.mkdirSync(path.join(dir, '14', String(x)), { recursive: true });
fs.writeFileSync(path.join(dir, '14', String(x), `${y}.bin`), enc(x, y, recs));
fs.writeFileSync(path.join(dir, '14', String(x), `${y}.ids`), ids);
const g = readGarita(dir);
assert.equal(g.stats.records, 2);
assert.equal(g.stats.lidar, 1);
assert.equal(g.byOsm.get('w113348553').height, 31.5);
assert.equal(g.at(lon + 0.0001, lat + 0.0001)?.gers, 'cf29c0cc-f255-4f2f-8453-d43beb5c1961');
assert.equal(g.at(lon + 0.0005, lat + 0.0005), null);
assert.equal(readGarita(path.join(dir, 'none')), null);
fs.rmSync(dir, { recursive: true });

// the tiles over Condado
const r = tileRange({ west: -66.0890, south: 18.4440, east: -66.0560, north: 18.4655 });
assert.ok(r.x0 <= x && x <= r.x1 && r.y0 <= y && y <= r.y1);
assert.deepEqual([r.x1 - r.x0, r.y1 - r.y0], [1, 1]);

console.log('garita tiles: ok');
