// The compiled city's buildings as trip ends for the demand model (tools/sim/demand.py): where each one is,
// how much floor it has and what it is used for. Read from the tiles, so the traffic starts and ends at the
// buildings the renderer draws.
//   data/sim/<area>/buildings.json: { usage: [...], rows: [[x, z, floorArea m², usage code, storeys], ...] }
// Usage: node tools/sim/buildings.mjs [--area=sanjuan]
import fs from 'node:fs';
import path from 'node:path';
import { resolveArea, ROOT } from '../pipeline/config.mjs';
import { decodeTile } from '../../src/shared/tileformat.js';

const area = resolveArea();
const dir = path.join(ROOT, 'public/tiles', area.id), out = path.join(ROOT, 'data/sim', area.id);
fs.mkdirSync(out, { recursive: true });
const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
const ringArea = (r) => { let s = 0; for (let i = 0, n = r.length / 2; i < n; i++) { const j = (i + 1) % n; s += r[j * 2] * r[i * 2 + 1] - r[i * 2] * r[j * 2 + 1]; } return Math.abs(s / 2); };
const rows = [];
for (const t of manifest.tiles) {
  const buf = fs.readFileSync(path.join(dir, t.file));
  const { buildings } = decodeTile(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  for (const b of buildings) {
    let a = 0, sx = 0, sz = 0;
    for (const rings of b.polygons) {
      const r = rings[0], ar = ringArea(r);
      let cx = 0, cz = 0;
      for (let i = 0; i < r.length; i += 2) { cx += r[i]; cz += r[i + 1]; }
      sx += (cx / (r.length / 2)) * ar; sz += (cz / (r.length / 2)) * ar; a += ar;
    }
    if (a < 10) continue;
    // floors: the storeys where known, else the height at 3.2 m a floor
    const storeys = b.storeys > 0 && b.storeys < 255 ? b.storeys : Math.max(1, Math.round(b.height / 3.2));
    rows.push([Math.round(sx / a), Math.round(sz / a), Math.round(a * storeys), b.usage, storeys]);
  }
}
fs.writeFileSync(path.join(out, 'buildings.json'), JSON.stringify({ bounds: manifest.bounds, origin: manifest.origin, rows }));
const byUse = {};
for (const r of rows) byUse[r[3]] = (byUse[r[3]] ?? 0) + r[2];
console.log(`${rows.length} buildings, ${(rows.reduce((s, r) => s + r[2], 0) / 1e6).toFixed(1)} km² of floor; by usage (km²): ` +
  Object.entries(byUse).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${(v / 1e6).toFixed(2)}`).join(', '));
