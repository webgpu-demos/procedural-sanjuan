// Garita's building ids for an area compiled before the compiler read them, without compiling it again: each
// building of each tile takes the GERS and OSM ids of the Garita building under it (its footprint's middle, else a
// point a little way in from a corner), and t_x_z.ids is written beside the tile, as compile.mjs writes it.
// Nothing else in the area changes: tiles, roads and the simulated runs (made on its roads) stay as they are.
//   node tools/pipeline/ids.mjs --area=sanjuan [--dir=public/tiles/sanjuan] [--garita=<directory of Garita tiles>]
// The Garita tiles are those `npm run fetch` puts in data/raw/<area>/garita (fetch with --garita= for another site).
import fs from 'node:fs';
import path from 'node:path';
import { resolveArea } from './config.mjs';
import { readGarita } from './garita.mjs';
import { decodeTile } from '../../src/shared/tileformat.js';
import { makeProjection } from '../../src/shared/geo.js';

const area = resolveArea();
const arg = (k, d) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const dir = path.resolve(arg('dir', area.outDir)), gdir = path.resolve(arg('garita', path.join(area.rawDir, 'garita')));
const garita = readGarita(gdir);
if (!garita) throw new Error(`no Garita building tiles in ${gdir} (npm run fetch -- --area=${area.id} gets them)`);
if (!garita.stats.withIds) throw new Error(`the Garita tiles in ${gdir} have no ids files (an older Garita build)`);
const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
const proj = makeProjection(manifest.origin.lon, manifest.origin.lat);

// the Garita building under a footprint: its middle, else points a fifth of the way in from each corner
function lookup(ring) {
  const n = ring.length / 2;
  let cx = 0, cz = 0;
  for (let i = 0; i < n; i++) { cx += ring[i * 2]; cz += ring[i * 2 + 1]; }
  cx /= n; cz /= n;
  const tries = [[cx, cz]];
  for (let i = 0; i < n; i++) tries.push([ring[i * 2] + (cx - ring[i * 2]) * 0.2, ring[i * 2 + 1] + (cz - ring[i * 2 + 1]) * 0.2]);
  for (const [x, z] of tries) {
    const r = garita.at(...proj.unproject(x, z));
    if (r) return r;
  }
  return null;
}

const stats = { tiles: 0, buildings: 0, gers: 0, osm: 0 };
for (const t of manifest.tiles) {
  if (!t.buildings) continue;
  const buf = fs.readFileSync(path.join(dir, t.file));
  const tile = decodeTile(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  const lines = tile.buildings.map((b) => {
    const r = b.polygons[0]?.[0] ? lookup(b.polygons[0][0]) : null;
    if (r?.gers) stats.gers++;
    if (r?.osm) stats.osm++;
    return `${r?.gers ?? ''},${r?.osm ?? ''}`;
  });
  t.ids = `t_${t.x}_${t.z}.ids`;
  fs.writeFileSync(path.join(dir, t.ids), lines.join('\n') + '\n');
  stats.tiles++; stats.buildings += lines.length;
}
const line = 'Building ids (Overture GERS): Garita (https://github.com/webgpu-demos/garita), from Overture Maps Foundation';
if (!manifest.attribution.some((a) => a.startsWith('Building ids'))) manifest.attribution.push(line);
manifest.idsFrom = { garita: path.basename(gdir), by: 'point (footprint middle) in Garita tiles', at: new Date().toISOString() };
fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 1));
console.log(`ids: ${stats.buildings} buildings in ${stats.tiles} tiles; GERS for ${stats.gers} (${(stats.gers / stats.buildings * 100).toFixed(1)}%), OSM id for ${stats.osm}`);
