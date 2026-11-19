// The expressway's cuttings (src/shared/cuttings.js) on a ground made for it: a trench 6 m deep with sides 15 m
// long, as a 10 m grid has one, an expressway along its floor and a street along its top.
//   node tools/tests/cuttings.test.mjs
import assert from 'node:assert/strict';
import { findCuttings, cutField } from '../../src/shared/cuttings.js';
import { meshHeight, latticeHeight } from '../../src/shared/terrain.js';

const step = 10, w = 60, h = 30, data = new Float32Array(w * h);
// (the floor 4 m either side of z = 150, the top 16 m out: the paving, 8 m to a side, runs up the sides)
for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) { const d = Math.abs(j * step - 150); data[j * w + i] = 4 + 6 * Math.max(0, Math.min(1, (d - 4) / 12)); }
const grid = { x0: 0, z0: 0, step, w, h, data }, ground = (x, z) => meshHeight(grid, x, z);
const road = (highway, z, y, more = {}) => ({ a: highway + 'a', b: highway + 'b', highway, oneway: 1, lanes: 4, pts: [60, y, z, 300, y, z, 540, y, z], ...more });
const street = road('residential', 185, 10, { lanes: 2, oneway: 0 });
const roads = { edges: [road('motorway', 150, 4), street] };

const strips = findCuttings(roads, ground, new Map());
assert.equal(strips.length, 1, 'the trench is one cutting');
assert.ok(strips[0].lines.length >= 4, 'with its lane lines');
assert.equal(findCuttings({ edges: [roads.edges[0]] }, ground, new Map()).length, 0, 'no street over it: a cut through a hill, left as it is');
assert.equal(findCuttings(roads, ground, new Map([[roads.edges[0], [0, Infinity]]])).length, 0, 'a road drawn as a structure is not cut');

const field = cutField(strips, grid);
grid.cuts = field.level;
// the floor: level across the paving where the terrain's sides stood metres over it, the ground beyond untouched
let worst = 0, before = 0;
for (let x = 120; x <= 480; x += 7) for (let l = -8; l <= 8; l += 1) { worst = Math.max(worst, Math.abs(ground(x, 150 + l) - 4)); before = Math.max(before, latticeHeight(grid, x, 150 + l) - 4); }
assert.ok(before > 0.3 && worst < 0.01, `the paving lies flat (${worst.toFixed(3)} m off, ${before.toFixed(2)} m before)`);
assert.equal(ground(300, 165), latticeHeight(grid, 300, 165), 'the ground beside the cutting is the terrain');
assert.ok(Math.abs(ground(60.3, 150) - latticeHeight(grid, 60.3, 150)) < 0.1, 'and the floor meets it at the stretch\'s end');

// a tile's share: a polygon apart along the outline keeps its area; walls stand along both sides
const t = field.forTile(1, 0), area = (p) => Math.abs(p.reduce((s, a, i) => { const b = p[(i + 1) % p.length]; return s + a[0] * b[1] - b[0] * a[1]; }, 0)) / 2;
const tri = [[300, 130], [340, 130], [300, 175]], s = t.split(tri);
assert.ok(s && s.ins.length && s.out.length, 'a triangle across the outline is split');
assert.ok(Math.abs(s.ins.reduce((a, p) => a + area(p), 0) + s.out.reduce((a, p) => a + area(p), 0) - area(tri)) < 1e-6, 'into pieces of the same area');
assert.equal(t.split([[300, 180], [320, 180], [300, 200]]), null, 'one clear of it is left whole');
const sides = new Set(); for (let k = 0; k < t.walls.length; k += 4) sides.add(t.walls[k + 1] < 150 ? 'north' : 'south');
assert.equal(sides.size, 2, 'walls on both sides');
const paint = t.paint(() => false);
assert.ok(paint.white.length > 20 && paint.yellow.length > 0 && t.paint(() => true).white.length === 0, 'lane lines where the tile has none of its own');
console.log(`cuttings: ok (1 stretch, ${(strips[0].pts.length / 7 - 1) * 4} m; the paving ${before.toFixed(2)} m up its sides before, ${worst.toFixed(3)} m after)`);
