// The painted lanes of the one-way expressway, for the simulated cars to drive in (src/world/simtraffic.js relane).
//
// The tiles paint lane lines from the measured carriageway (markings.mjs): at each sample along a road the
// distance to the kerb on both sides gives its true centre and width, and the lanes divide that width evenly.
// SUMO drove 3 m lanes about the OSM centreline (tools/sim/network.mjs). Where the paved carriageway sits off the
// centreline, or is wider than its lanes need, the two disagree by up to half a lane, and a simulated car rode
// down a painted line. This measures the carriageway again from the compiled tiles, by markings.mjs's own rules,
// and writes, for each edge it paints, its lanes and their width and the painted centre's offset from the OSM
// line along it, as markings.mjs laid them: lanes.json, next to roads.json.
//
// Usage: node tools/pipeline/lanetable.mjs <area tiles dir>     (e.g. public/tiles/sanjuan)
import fs from 'node:fs';
import path from 'node:path';
import { decodeTile, AREA } from '../../src/shared/tileformat.js';
import { PolyIndex, forEachAlong } from './landscape.mjs';

const STEP = 2.5;                                          // (as markings.mjs)
const dir = process.argv[2];
if (!dir) { console.error('usage: node tools/pipeline/lanetable.mjs <area tiles dir>'); process.exit(1); }
const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json')));
const roads = JSON.parse(fs.readFileSync(path.join(dir, manifest.roads ?? 'roads.json')));

// the carriageways of every tile
const carriageway = new PolyIndex(16);
let polys = 0;
for (const t of manifest.tiles) {
  const buf = fs.readFileSync(path.join(dir, t.file));
  const tile = decodeTile(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  for (const a of tile.areas) {
    if (a.kind !== AREA.CARRIAGEWAY) continue;
    for (const rings of a.polygons) {
      carriageway.add(rings.map((r) => Array.from({ length: r.length / 2 }, (_, i) => [r[i * 2], r[i * 2 + 1]])));
      polys++;
    }
  }
}
const reach = (x, z, nx, nz, side, max = 18) => {
  for (let d = 0.5; d <= max; d += 0.25) if (!carriageway.has(x + nx * d * side, z + nz * d * side)) return d;
  return null;
};

// junctions (as markings.mjs: three or more edge ends)
const degree = new Map();
for (const e of roads.edges) for (const n of [e.a, e.b]) degree.set(n, (degree.get(n) ?? 0) + 1);
const junctions = [...degree].filter(([, n]) => n >= 3).map(([id]) => roads.nodes[id]);
const JCELL = 64, jgrid = new Map();
for (const p of junctions) { const k = Math.floor(p[0] / JCELL) + ',' + Math.floor(p[2] / JCELL); if (!jgrid.has(k)) jgrid.set(k, []); jgrid.get(k).push(p); }
const nearJunction = (x, z, max) => {
  for (let i = Math.floor((x - max) / JCELL); i <= Math.floor((x + max) / JCELL); i++)
    for (let k = Math.floor((z - max) / JCELL); k <= Math.floor((z + max) / JCELL); k++)
      for (const p of jgrid.get(i + ',' + k) ?? []) if (Math.hypot(p[0] - x, p[2] - z) < max) return true;
  return false;
};

const out = { step: STEP, edges: {} };
let painted = 0;
roads.edges.forEach((e, i) => {
  // the one-way expressway that markings.mjs paints (no bridges, flyovers or links: those it leaves unpainted)
  if (!e.oneway || !/^(motorway|trunk)$/.test(e.highway) || (e.bridge && !e.span) || e.tunnel || e.flyover) return;
  const pts = [];
  for (let k = 0; k < e.pts.length; k += 3) pts.push([e.pts[k], e.pts[k + 2]]);
  const nominal = Math.max(1, e.lanes) * 3.0 + 0.8;
  const samples = [];
  forEachAlong(pts, STEP, (x, z, dx, dz) => {
    const nx = -dz, nz = dx;
    let s = null;
    if (carriageway.has(x, z)) {
      const R = reach(x, z, nx, nz, 1), L = reach(x, z, nx, nz, -1);
      if (R != null && L != null && R + L <= nominal * 1.6 + 3) s = { c: (R - L) / 2, w: R + L };
      else if (!nearJunction(x, z, 16 + Math.max(1, e.lanes) * 2)) s = { c: 0, w: nominal, open: true };
    }
    samples.push(s);
  }, STEP / 2);
  const widths = samples.filter(Boolean).map((s) => s.w).sort((a, b) => a - b);
  if (widths.length < 4) return;
  const median = widths[widths.length >> 1];
  const lanes = Math.max(1, Math.min(e.lanes, Math.floor(median / 2.6)));
  // the painted centre's offset at each sample (null where markings.mjs painted nothing: a junction, a bay)
  const offsets = samples.map((s) => (s && s.w > median * 0.8 && s.w < median * 1.25 ? Math.round(s.c * 100) / 100 : null));
  // and why not, sample by sample: '.' painted, 'w' wider than its lanes (a ramp joining or leaving, a bay),
  // 'n' narrower, 'x' off the carriageway or not measured (a junction, a bridge's gap)
  const why = samples.map((s) => (!s ? 'x' : s.w >= median * 1.25 ? 'w' : s.w <= median * 0.8 ? 'n' : '.')).join('');
  out.edges[i] = { lanes, lw: Math.round((median / lanes) * 1000) / 1000, c: offsets, why };
  painted++;
});
fs.writeFileSync(path.join(dir, 'lanes.json'), JSON.stringify(out));
console.log(`lanes.json: ${painted} one-way expressway edges, from ${polys} carriageway polygons`);
