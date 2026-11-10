// Ramps alongside before they merge (src/shared/roadway.js accelLanes, approach): over each compiled area, every
// acceleration lane whose ramp is moved alongside the expressway has its ramp leave its own line where that line is a
// lane's centre out from the painted lanes, without a step (tools/sim/network.mjs joins the two there), and the
// ramp's new line keeps that lane's centre out from the expressway's all the way to the node. The paving that clears
// the sidewalks under the lane (accelCarriage) is finite and has width.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { accelLanes, accelCarriage } from '../../src/shared/roadway.js';
import { ROOT, AREAS } from '../pipeline/config.mjs';

const TILES = process.env.TILES_ROOT ?? path.join(ROOT, 'public/tiles');
let checked = 0;
for (const id of Object.keys(AREAS)) {
  const dir = path.join(TILES, id);
  if (!fs.existsSync(path.join(dir, 'manifest.json')) || !fs.existsSync(path.join(dir, 'lanes.json'))) { console.log(`ramps: skip ${id} (no compiled tiles or lanes)`); continue; }
  const m = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')), roads = JSON.parse(fs.readFileSync(path.join(dir, m.roads), 'utf8'));
  const painted = JSON.parse(fs.readFileSync(path.join(dir, 'lanes.json'), 'utf8')).edges, E = roads.edges;
  const lanes = accelLanes(roads, painted);
  let moved = 0, within = 0;
  for (const l of lanes) {
    if (!l.rampTail) continue;
    moved++;
    const where = `${id}: the ramp into node ${l.node} (edge ${l.ramp})`;
    assert.ok(l.cutBack >= 5 && l.rampTail.length >= 2 && l.line[0][3] < 0, `${where}: no approach to move`);
    // (the ramp's own line, back from the node, as network.mjs walks it: where it leaves that line, if within its edge)
    const e = E[l.ramp], P = [];
    for (let k = 0; k < e.pts.length; k += 3) P.push([e.pts[k], e.pts[k + 2]]);
    if (e.oneway !== -1) P.reverse();
    let t = 0;
    for (let k = 1; k < P.length; k++) {
      const d = Math.hypot(P[k][0] - P[k - 1][0], P[k][1] - P[k - 1][1]);
      if (t + d >= l.cutBack) {
        const f = (l.cutBack - t) / d, x = P[k - 1][0] + (P[k][0] - P[k - 1][0]) * f, z = P[k - 1][1] + (P[k][1] - P[k - 1][1]) * f;
        const step = Math.hypot(x - l.rampTail[0][0], z - l.rampTail[0][2]);
        assert.ok(step < 0.5, `${where}: the ramp steps ${step.toFixed(2)} m where it leaves its line`);
        within++;
        break;
      }
      t += d;
    }
    // (every point of the new line a lane's centre out from the expressway's: the expressway's line before the node)
    const off = (l.n / 2 + 0.5) * l.apSw, M = l.line.filter((p) => p[3] <= 0);
    for (const p of l.rampTail) {
      let best = Infinity;
      for (let k = 1; k < M.length; k++) {
        const a = M[k - 1], b = M[k], dx = b[0] - a[0], dz = b[2] - a[2], l2 = dx * dx + dz * dz || 1;
        const u = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[2] - a[2]) * dz) / l2));
        best = Math.min(best, Math.hypot(p[0] - a[0] - dx * u, p[2] - a[2] - dz * u));
      }
      assert.ok(best > off - 0.3, `${where}: its new line comes ${(off - best).toFixed(2)} m inside the outer lane`);
    }
  }
  const segs = accelCarriage(lanes);
  assert.equal(segs.length % 5, 0);
  for (let o = 0; o < segs.length; o += 5) {
    for (let k = 0; k < 5; k++) assert.ok(Number.isFinite(segs[o + k]), `${id}: acceleration paving's clearing not finite`);
    assert.ok(segs[o + 4] > 0, `${id}: acceleration paving's clearing has no width`);
  }
  console.log(`ramps: ${id}: ${lanes.length} acceleration lanes, ${moved} ramps alongside before them (${within} within the ramp's own edge, as the simulation moves them); ${segs.length / 5} sidewalk clearings`);
  checked++;
}
assert.ok(checked > 0, 'no compiled area to check');
