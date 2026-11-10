// No building in a road, no road into a wall (tools/pipeline/roadclear.mjs), over each compiled area: no building
// that is drawn has a drawn street-level centreline running into its footprint by half a metre or more, and every
// such centreline has paving under it wherever it is not inside a building (the corner of one it brushes by less).
// The exclusions are the rule's own: tunnels (but for the passages through buildings the manifest lists as drawn),
// bridges that are not spans, flyovers; the forts and the landmarks drawn as models.
// An area compiled before the rule fails here until it has been cleared: node tools/pipeline/clearroads.mjs --area=<id>
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { decodeTile, AREA, BFLAG } from '../../src/shared/tileformat.js';
import { roadIndex, entering, drawn, pairs, ENTER } from '../pipeline/roadclear.mjs';
import { PolyIndex } from '../pipeline/landscape.mjs';
import { ROOT, AREAS } from '../pipeline/config.mjs';

const TILES = process.env.TILES_ROOT ?? path.join(ROOT, 'public/tiles'); // (TILES_ROOT: a copy of the tiles elsewhere)
const STEP = 2;    // metres between the points checked along a centreline
const PAVED = new Set([AREA.ROAD, AREA.CARRIAGEWAY, AREA.SIDEWALK]);
let checked = 0;
for (const id of Object.keys(AREAS)) {
  const dir = path.join(TILES, id);
  if (!fs.existsSync(path.join(dir, 'manifest.json'))) { console.log(`roads clear: skip ${id} (no compiled tiles)`); continue; }
  const m = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')), roads = JSON.parse(fs.readFileSync(path.join(dir, m.roads), 'utf8'));
  for (const i of m.roadsCleared?.passages ?? []) roads.edges[i].passage = 1;
  const index = roadIndex(roads.edges), paving = new PolyIndex(16), solid = new PolyIndex(16);
  const inside = []; // the buildings a road runs into
  let buildings = 0, hidden = 0;
  for (const t of m.tiles) {
    const buf = fs.readFileSync(path.join(dir, t.file)), tile = decodeTile(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    for (const a of tile.areas) if (PAVED.has(a.kind)) for (const rings of pairs(a.polygons)) paving.add(rings);
    tile.buildings.forEach((b, i) => {
      buildings++;
      if (b.flags & BFLAG.NO_SOLID) { hidden++; return; } // (taken out of a road: not drawn)
      const polygons = pairs(b.polygons);
      for (const rings of polygons) solid.add(rings);
      if (b.flags & BFLAG.MASONRY) return;
      const roadsIn = entering(index, polygons);
      if (roadsIn.length) { const r = roadsIn.reduce((p, q) => (q.inside > p.inside ? q : p)), e = roads.edges[r.ei]; inside.push(`${t.file} #${i}: ${e.highway}${e.name ? ` "${e.name}"` : ''} ${r.inside.toFixed(1)} m inside, at x ${r.x.toFixed(1)} z ${r.z.toFixed(1)}`); }
    });
  }
  // the centrelines: paving under every point that is not inside a building
  const b = m.bounds, bare = [];
  let metres = 0, unpaved = 0;
  roads.edges.forEach((e, ei) => {
    if (!drawn(e)) return;
    const p = e.pts;
    for (let k = 3; k < p.length; k += 3) {
      const ax = p[k - 3], az = p[k - 1], bx = p[k], bz = p[k + 2], len = Math.hypot(bx - ax, bz - az), n = Math.max(1, Math.round(len / STEP));
      for (let s = 0; s < n; s++) {
        const x = ax + (bx - ax) * (s + 0.5) / n, z = az + (bz - az) * (s + 0.5) / n;
        if (x < b.minX || x > b.maxX || z < b.minZ || z > b.maxZ) continue;
        metres += len / n;
        if (paving.has(x, z) || solid.has(x, z)) continue;
        unpaved += len / n;
        if (bare.at(-1)?.ei !== ei) bare.push({ ei, text: `${e.highway}${e.name ? ` "${e.name}"` : ''} (edge ${ei}) at x ${x.toFixed(1)} z ${z.toFixed(1)}` });
      }
    }
  });
  const more = (list) => list.slice(0, 12).map((s) => `\n    ${s}`).join('') + (list.length > 12 ? `\n    … and ${list.length - 12} more` : '');
  const fix = `\n  (an area compiled before the rule: node tools/pipeline/clearroads.mjs --area=${id})`;
  assert.equal(inside.length, 0, `${id}: a drawn street-level centreline runs ${ENTER} m or more into ${inside.length} of ${buildings} buildings:${more(inside)}${fix}`);
  assert.equal(bare.length, 0, `${id}: ${unpaved.toFixed(0)} m of drawn street-level centreline with no paving under it, on ${bare.length} roads:${more(bare.map((s) => s.text))}${fix}`);
  console.log(`ok   ${id}: ${buildings} buildings (${hidden} taken out of roads) clear of ${(metres / 1000).toFixed(0)} km of street-level centreline, paved all along`);
  checked++;
}
console.log(checked ? 'roads clear: ok' : 'roads clear: no compiled area; skipped');
