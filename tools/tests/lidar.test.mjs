// The lidar terrain (tools/pipeline/lidar.mjs): the projection against GDAL, the tile names and the tiles an area needs.
import assert from 'node:assert/strict';
import { utm, parseTileName, tilesFor } from '../pipeline/lidar.mjs';

// NAD83 / UTM 19N from GDAL 3.8 (Garita's lidar probe, 2026-10-11): within a centimetre
for (const [lon, lat, E, N] of [[-66.105, 18.455, 805781.43, 2042973.11], [-66.1165, 18.4655, 804547.38, 2044116.61], [-66.13, 18.44, 803165.4, 2041269.7]]) {
  const [e, n] = utm(lon, lat, 19);
  assert.ok(Math.abs(e - E) < 0.01 && Math.abs(n - N) < 0.01, `${lon},${lat}: ${e},${n} vs ${E},${N}`);
}

// a tile is named by its west edge and its TOP edge, in 10 km
assert.deepEqual(parseTileName('StagedProducts/x/USGS_1M_19_x80y205_PR_PuertoRicoUSVI_D24.tif'),
  { name: 'USGS_1M_19_x80y205_PR_PuertoRicoUSVI_D24.tif', zone: 19, project: 'PR_PuertoRicoUSVI_D24', e0: 800000, e1: 810000, n0: 2040000, n1: 2050000 });
assert.equal(parseTileName('USGS_1M_19_x80y205_PR_PuertoRicoUSVI_D24.xml'), null);

// the tiles under Condado and under the municipality
const names = [];
for (let x = 61; x <= 85; x++) for (let y = 198; y <= 205; y++) names.push(`USGS_1M_19_x${x}y${y}_PR_PuertoRicoUSVI_D24.tif`);
const pick = (b) => tilesFor(names, b).map((t) => `x${t.e0 / 1e4}y${t.n1 / 1e4}`).sort();
assert.deepEqual(pick({ west: -66.089, south: 18.444, east: -66.056, north: 18.4655 }), ['x80y205', 'x81y205']);
assert.deepEqual(pick({ west: -66.129, south: 18.296, east: -65.991, north: 18.476 }), ['x80y203', 'x80y204', 'x80y205', 'x81y203', 'x81y204', 'x81y205']);

console.log('lidar: ok');
