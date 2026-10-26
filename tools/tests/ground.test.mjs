// What stands on the ground stands on what is drawn: the surface the cars, the walker and the props take
// (src/shared/decks.js makeSurface, src/shared/terrain.js meshHeight) against the triangles the tiles draw the
// terrain and the roads with (src/world/meshing.js terrainMesh, src/world/drape.js).
import assert from 'node:assert/strict';
import { meshHeight, sampleGrid } from '../../src/shared/terrain.js';
import { makeSurface, streetAt } from '../../src/shared/decks.js';
import { createDraper } from '../../src/world/drape.js';
import { terrainMesh } from '../../src/world/meshing.js';

// a rough 10 m grid (an embankment's ridge and noise), as the terrain tiles give San Juan
let seed = 7;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const w = 80, h = 80, data = new Float32Array(w * h);
for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) data[j * w + i] = 3 + rnd() * 4 + (Math.abs(i - 40) < 2 ? 9 : 0);
const grid = { x0: -300, z0: -300, step: 10, w, h, data };
const deck = { pts: [-100, 14, -50, 100, 14, -50], half: 6 };
const surface = makeSurface(grid, [deck]), drape = createDraper(grid, surface);

let worstDrape = 0, worstBilinear = 0;
for (let k = 0; k < 4000; k++) {
  const x = -250 + rnd() * 500, z = -250 + rnd() * 500;
  worstDrape = Math.max(worstDrape, Math.abs(surface(x, z) - drape.height(x, z)));
  worstBilinear = Math.max(worstBilinear, Math.abs(sampleGrid(grid, x, z) - meshHeight(grid, x, z)));
}
// (a deck's level blended off its corridor is not linear across a triangle: within a few centimetres there)
assert.ok(worstDrape < 0.05, `surface vs the draped roads: ${worstDrape.toFixed(3)} m apart`);
assert.ok(worstBilinear > 0.3, 'the test grid should be rough enough for the bilinear surface to miss the mesh');

// the terrain mesh's vertices are the lattice's corners, and the surface is flat across its triangles
const tm = terrainMesh(grid, 0, 0, 256);
for (let t = 0; t < tm.index.length; t += 3 * 37) {
  const [a, b, c] = [tm.index[t], tm.index[t + 1], tm.index[t + 2]].map((i) => [tm.position[i * 3], tm.position[i * 3 + 1], tm.position[i * 3 + 2]]);
  for (const [u, v] of [[0.2, 0.3], [0.5, 0.25], [0.1, 0.8]]) {
    const x = a[0] + (b[0] - a[0]) * u + (c[0] - a[0]) * v, z = a[2] + (b[2] - a[2]) * u + (c[2] - a[2]) * v;
    const y = a[1] + (b[1] - a[1]) * u + (c[1] - a[1]) * v;
    assert.ok(Math.abs(surface(x, z, -2) - y) < 1e-3, `terrain mesh at ${x.toFixed(1)},${z.toFixed(1)}: ${y.toFixed(3)} vs ${surface(x, z, -2).toFixed(3)}`);
  }
}

// a bridge at street level: on its deck from up there, under it from the ground
assert.ok(Math.abs(streetAt(surface, 0, -50, 14) - drape.height(0, -50)) < 0.05 && drape.height(0, -50) > 12);
assert.ok(streetAt(surface, 0, -50, surface(0, -50, -2)) < 12);
console.log(`ground: ok (surface vs draped roads ${worstDrape.toFixed(3)} m at worst; the bilinear grid was ${worstBilinear.toFixed(2)} m off the mesh)`);
