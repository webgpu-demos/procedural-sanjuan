// Rivers and streams in their channels (tools/pipeline/channels.mjs lays them out, src/world/channels.js cuts them
// into the ground and draws them): the water level across and never rising downstream, and the ground the tile
// takes out from over a channel drawn again by the channel, all of it facing up, nothing left open.
import assert from 'node:assert/strict';
import { sampleGrid } from '../../src/shared/terrain.js';
import { buildChannels } from '../pipeline/channels.mjs';
import { prepareChannels } from '../../src/world/channels.js';
import { buildTile } from '../../src/world/meshing.js';
import { AREA } from '../../src/shared/tileformat.js';

// a hillside falling to the east and across to the south, rough, on a 10 m grid
let seed = 11;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const w = 60, h = 60, data = new Float32Array(w * h);
for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) data[j * w + i] = 40 - i * 0.4 - j * 0.15 + rnd() * 1.5;
const grid = { x0: -50, z0: -50, step: 10, w, h, data };
const ground = (x, z) => sampleGrid(grid, x, z);

// a stream winding down it, drawn in two ways that meet; a road crossing it at street level near the end
const line = [];
for (let x = 10; x <= 500; x += 12) line.push([x, 200 + 40 * Math.sin(x / 60)]);
const half = Math.floor(line.length / 2);
const ways = [
  { id: 1, tags: { waterway: 'stream' }, ids: line.slice(0, half + 1).map((_, i) => i), pts: line.slice(0, half + 1) },
  { id: 2, tags: { waterway: 'stream' }, ids: line.slice(half).map((_, i) => i + half), pts: line.slice(half) },
];
const road = (x) => x > 430 && x < 445;
const { channels, rings, stats } = buildChannels(ways, { ground, inBounds: () => true, wet: () => false, blocked: (x) => road(x) });
assert.equal(stats.ways, 1, 'the two ways of the stream are one waterway');
assert.equal(channels.length, 2, 'the road cuts the stream in two');
assert.equal(rings.length, channels.length);
for (const c of channels) {
  for (let i = 3; i < c.p.length; i += 3) assert.ok(c.p[i + 2] <= c.p[i - 1] + 1e-9, 'the water never rises downstream');
  for (let i = 0; i < c.p.length; i += 3) assert.ok(c.p[i + 2] < ground(c.p[i], c.p[i + 1]), 'the water lies under the ground');
}
assert.ok(channels[0].e & 4, 'where the stream begins, a bank slopes across');
assert.ok(!(channels[0].e & 10), 'where it stops at the road, a wall');

// cut and drawn: over a tile with a park on it, the terrain left standing and the channel's water and banks cover
// the whole tile (in plan), and every triangle of the terrain faces up
const prepared = prepareChannels({ channels }, 256, grid);
const park = { kind: AREA.PARK, code: 0, polygons: [[Float32Array.from([0, 0, 256, 0, 256, 256, 0, 256])]] };
const mesh = buildTile({ tx: 0, tz: 0, buildings: [], areas: [park], props: [], wires: [], walls: [], signs: [] }, grid, 256, ground, prepared);
const RES = 0.5, N = 256 / RES, cover = new Uint8Array(N * N);
const raster = (ax, az, bx, bz, cx, cz) => {
  const cr = (px, pz, qx, qz, rx, rz) => (qx - px) * (rz - pz) - (qz - pz) * (rx - px), A = cr(ax, az, bx, bz, cx, cz);
  if (Math.abs(A) < 1e-9) return;
  for (let i = Math.max(0, Math.floor(Math.min(ax, bx, cx) / RES)); i <= Math.min(N - 1, Math.floor(Math.max(ax, bx, cx) / RES)); i++)
    for (let j = Math.max(0, Math.floor(Math.min(az, bz, cz) / RES)); j <= Math.min(N - 1, Math.floor(Math.max(az, bz, cz) / RES)); j++) {
      const px = (i + 0.5) * RES, pz = (j + 0.5) * RES;
      if (cr(ax, az, bx, bz, px, pz) / A >= -1e-6 && cr(bx, bz, cx, cz, px, pz) / A >= -1e-6 && cr(cx, cz, ax, az, px, pz) / A >= -1e-6) cover[j * N + i] = 1;
    }
};
const { position: tp, index: ti } = mesh.terrain;
let down = 0, downArea = 0;
for (let k = 0; k < ti.length; k += 3) {
  const [a, b, c] = [ti[k], ti[k + 1], ti[k + 2]].map((v) => [tp[v * 3], tp[v * 3 + 1], tp[v * 3 + 2]]);
  const ny = (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]);
  if (ny < -1e-6) { down++; downArea -= ny / 2; }
  raster(a[0], a[2], b[0], b[2], c[0], c[2]);
}
assert.ok(downArea < 0.01, `${down} terrain triangles face down (${downArea.toFixed(2)} m2)`);
assert.ok(ti.length / 3 > 26 * 26 * 2, 'the terrain is cut over the channel');
// (a stretch is drawn by the tile its middle is in: the next tile's too)
const next = buildTile({ tx: 1, tz: 0, buildings: [], areas: [], props: [], wires: [], walls: [], signs: [] }, grid, 256, ground, prepared);
let water = 0;
for (const m of [mesh, next]) {
  const r = m.roads.position, layer = m.roads.aLayer;
  for (let k = 0; k < r.length; k += 9) {
    if (layer[k / 3] === 6) water++;
    raster(r[k], r[k + 2], r[k + 3], r[k + 5], r[k + 6], r[k + 8]);
  }
}
assert.ok(water > 20, 'the channel draws its water');
let open = 0;
const where = [];
for (let k = 0; k < cover.length; k++) if (!cover[k]) { open++; if (where.length < 5) where.push(`${(k % N) * RES},${Math.floor(k / N) * RES}`); }
assert.equal(open, 0, `${open * RES * RES} m2 of the tile left open: ${where.join(' ')}`);
console.log(`channels: ok (${channels.length} stretches, ${stats.km} km; terrain ${ti.length / 3} triangles)`);
