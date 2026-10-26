// Synthetic training labels (src/synth): a label image decodes to the right instances and boxes, and a tarp packs
// into aSynth so the shaders read back what was packed.
import assert from 'node:assert/strict';
import { decodeLabels, A } from '../../src/synth/labels.js';
import { packTarp } from '../../src/synth/tarp.js';

const W = 40, H = 30, px = new Uint8Array(W * H * 4);
for (let i = 0; i < W * H; i++) px[i * 4 + 3] = A.NONE;
const put = (x0, y0, x1, y1, a, r = 0, g = 0, b = 0) => {
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const i = (y * W + x) * 4; px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = a; }
};
put(2, 2, 12, 10, A.BUILDING, 3, 1, 7);      // building: slot 3, index 263
put(5, 4, 9, 8, A.TARP, 3, 1, 7);            //   its tarp
put(20, 2, 30, 12, A.BUILDING, 4, 0, 1);     // another building
put(2, 20, 5, 22, A.VEHICLE, 1, 0, 0);       // two cars (mesh slot 1, instances 0 and 1), touching
put(5, 20, 8, 22, A.VEHICLE, 1, 0, 1);
put(30, 20, 34, 24, A.DEBRIS, 0, 0, 9);      // a pile
put(36, 0, 40, 4, A.BLOCK);                  // a distant block
const { instances, ids, share } = decodeLabels(px, W, H);
const by = (k) => instances.find((r) => r.key === k);
assert.deepEqual([by('b' + ((3 << 16) | 263)).x0, by('b' + ((3 << 16) | 263)).y0, by('b' + ((3 << 16) | 263)).x1, by('b' + ((3 << 16) | 263)).y1], [2, 2, 11, 9], 'a building box covers its tarp too');
assert.equal(by('b' + ((3 << 16) | 263)).n, 80);
assert.deepEqual([by('t' + ((3 << 16) | 263)).x0, by('t' + ((3 << 16) | 263)).x1, by('t' + ((3 << 16) | 263)).n], [5, 8, 16]);
assert.equal(instances.filter((r) => r.cls === 3).length, 2, 'two vehicles, though they touch');
assert.deepEqual([by('v' + ((1 << 16) | 1)).x0, by('v' + ((1 << 16) | 1)).x1], [5, 7]);
assert.equal(by('d9').n, 16);
assert.equal(share.block, 16 / (W * H));
// the id image: class + 1 in R, the instance number in G, B
const at = (x, y) => [ids[(y * W + x) * 4], ids[(y * W + x) * 4 + 1] * 256 + ids[(y * W + x) * 4 + 2]];
assert.equal(at(3, 3)[0], 1); assert.equal(at(6, 5)[0], 2); assert.equal(at(6, 21)[0], 4); assert.equal(at(31, 21)[0], 3); assert.equal(at(0, 29)[0], 0);
assert.notEqual(at(3, 21)[1], at(6, 21)[1], 'the two cars are two instances');

// tarp packing, read back as tarp.js's GLSL does
const [cx, cz, packed, w] = packTarp(12.5, -40.25, 3.46, 1.2, 2.0);
const hx = Math.floor(packed / 1000 + 0.0001) / 10, hz = (packed - Math.floor(packed / 1000 + 0.0001) * 1000) / 10;
assert.deepEqual([cx, cz, hx, hz], [12.5, -40.25, 3.5, 1.2]);
assert.ok(Math.abs(w - 4 - 2.0) < 1e-9 && w > 3.5);
assert.ok(Math.abs(packTarp(0, 0, 1, 1, -0.5)[3] - 4 - (Math.PI - 0.5)) < 1e-9, 'angles folded into 0..pi');

console.log('synth labels: ok');
