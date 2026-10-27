// A new ground for an area compiled before, without compiling it again: San Juan was compiled on the terrain tiles'
// 10 m surface, and its simulated mornings were driven on its roads, so it is not compiled again for the lidar
// ground (tools/pipeline/lidar.mjs). Here its height grid takes the 1 m lidar DEM, and everything compiled at a
// height over the old ground is put back on the new one, as compile.mjs would have put it:
//   buildings (tiles and the distant blocks)   the walls on the lowest ground under the outline, the roof where its
//                                              height puts it over the middle of the building (compile.mjs's rule)
//   signs, the landmarks' meshes, platforms     moved by the change of the ground under them
//   roads, railways, footbridges, the decks    on the ground: moved by the change under them; up on a structure (a
//                                              bridge, a flyover, a viaduct, more than 1.5 m off the old ground):
//                                              moved by the change at the ground on either side, so a deck keeps its
//                                              line from bank to bank
// The roads keep the levels the simulation drove in `pts0` where they moved by more than half a metre (simtraffic.js
// puts its cars on the new ones: fixAt). Nothing moves sideways: the tiles' outlines, the roads' lines, the
// simulated tracks stay as they are.
//   node tools/pipeline/reterrain.mjs --area=sanjuan [--dir=public/tiles/sanjuan] [--grid=<new terrain .bin>]
// Without --grid, the lidar tiles in data/raw/<area>/dem/lidar (npm run fetch) are applied to the area's grid here.
import fs from 'node:fs';
import path from 'node:path';
import { resolveArea } from './config.mjs';
import { applyLidar, LIDAR } from './lidar.mjs';
import { sampleGrid } from '../../src/shared/terrain.js';
import { decodeTile } from '../../src/shared/tileformat.js';
import { makeProjection } from '../../src/shared/geo.js';

const SEA = 0, LAND_MIN = 0.3, RAISED = 1.5; // (as compile.mjs; a point this far off the old ground is on a structure)
const area = resolveArea();
const arg = (k, d) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const dir = path.resolve(arg('dir', area.outDir));
const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
const t = manifest.terrain, proj = makeProjection(manifest.origin.lon, manifest.origin.lat);
const read = (f) => new Float32Array(fs.readFileSync(f).buffer.slice(0));
const G0 = { x0: t.x0, z0: t.z0, step: t.step, w: t.w, h: t.h, data: read(path.join(dir, t.file)) };
const G1 = { ...G0, data: Float32Array.from(G0.data) };
let lidarStats = null;
if (arg('grid')) {
  const g = read(path.resolve(arg('grid')));
  if (g.length !== G1.data.length) throw new Error(`--grid holds ${g.length} cells, the area's grid ${G1.data.length}`);
  G1.data.set(g);
} else {
  lidarStats = await applyLidar(G1, path.join(area.rawDir, 'dem', 'lidar'), proj, console.log);
  if (!lidarStats.tiles) throw new Error(`no lidar tiles in ${path.join(area.rawDir, 'dem', 'lidar')} (npm run fetch -- --area=${area.id})`);
}
// as compile.mjs leaves the grid: the sea flat at its surface (cells the compiler put there stay), dry land above it
let covered = 0;
for (let k = 0; k < G1.data.length; k++) {
  if (Math.abs(G0.data[k] - (SEA - 0.08)) < 1e-4) { G1.data[k] = G0.data[k]; continue; }
  G1.data[k] = Math.max(G1.data[k], SEA + LAND_MIN);
  if (Math.abs(G1.data[k] - G0.data[k]) > 1e-3) covered++;
}
const g0 = (x, z) => sampleGrid(G0, x, z), g1 = (x, z) => sampleGrid(G1, x, z), dz = (x, z) => g1(x, z) - g0(x, z);
const stats = { cellsChanged: covered, buildings: 0, signs: 0, meshes: 0, roadPoints: 0, raisedPoints: 0, edgesWithPts0: 0, railPoints: 0, decks: 0 };

// ---------------------------------------------------------------- buildings (compile.mjs's rule, on each ground)
// The tiles are patched where they hold a height (src/shared/tileformat.js: a building's base, height and measured
// height, its LOD2 surfaces' heights, a sign's height); every other byte stays as it was.
const areaEN = (r) => { let a = 0; for (let i = 0, n = r.length / 2; i < n; i++) { const j = (i + 1) % n; a += r[i * 2] * r[j * 2 + 1] - r[j * 2] * r[i * 2 + 1]; } return a / 2; };
const r2 = (v) => Math.round(v * 100) / 100;
// the new base and height of a decoded building, and the change of the ground under its middle
function rebase(b) {
  let sx = 0, sz = 0, sa = 0;
  for (const [outer] of b.polygons) {
    const a = Math.abs(areaEN(outer)), n = outer.length / 2;
    let cx = 0, cz = 0;
    for (let i = 0; i < n; i++) { cx += outer[i * 2]; cz += outer[i * 2 + 1]; }
    sx += (cx / n) * a; sz += (cz / n) * a; sa += a;
  }
  if (!sa) return null;
  const cx = sx / sa, cz = sz / sa, ring = b.polygons[0][0];
  const foot = (g) => { const gc = g(cx, cz); let lo = gc; for (let i = 0; i < ring.length; i += 2) lo = Math.min(lo, g(ring[i], ring[i + 1])); return { gc, wall: Math.max(lo, gc - 6) }; };
  const a = foot(g0), c = foot(g1);
  const minHeight = Math.max(0, b.base - a.wall), own = b.height - (a.gc - a.wall); // (its own height over the middle)
  stats.buildings++;
  return { base: r2(c.wall + minHeight), height: r2(own + (c.gc - c.wall)), up: c.gc - a.gc };
}
// Walks a tile's bytes as decodeTile reads them, patching each building and sign in place.
function patchTile(buf) {
  const tile = decodeTile(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  let o = 4 + 2 + 2 + 4 + 4;
  const nB = buf.readUInt32LE(o), nA = buf.readUInt32LE(o + 4), nP = buf.readUInt32LE(o + 8), nW = buf.readUInt32LE(o + 12), nWalls = buf.readUInt32LE(o + 16), nS = buf.readUInt32LE(o + 20);
  o += 24;
  const skipPolys = () => { const np = buf.readUInt16LE(o); o += 2; for (let p = 0; p < np; p++) { const nr = buf.readUInt16LE(o); o += 2; for (let r = 0; r < nr; r++) { const n = buf.readUInt32LE(o); o += 4 + n * 8; } } };
  for (let i = 0; i < nB; i++) {
    const at = o + 4, r = rebase(tile.buildings[i]);
    if (r) {
      buf.writeFloatLE(r.base, at); buf.writeFloatLE(r.height, at + 4);
      if (buf.readFloatLE(at + 8) >= 0) buf.writeFloatLE(r.height, at + 8);
    }
    o += 4 + 12 + 4; skipPolys();
    const ns = buf.readUInt16LE(o); o += 2;
    for (let s = 0; s < ns; s++) {
      const bits = buf.readUInt8(o), nr = buf.readUInt8(o + 1); o += 2;
      for (let k = 0; k < nr; k++) {
        const n = buf.readUInt16LE(o); o += 2;
        for (let v = 0; v < n; v++) { if (r) buf.writeFloatLE(buf.readFloatLE(o + 4) + r.up, o + 4); o += 12; }
        if (bits & 2) o += n * 4;
      }
    }
  }
  for (let i = 0; i < nA; i++) { o += 4; skipPolys(); }
  o += nP * 16 + nW * 16 + nWalls * 20;
  for (let i = 0; i < nS; i++) {
    const s = tile.signs[i];
    buf.writeFloatLE(s.y + dz(s.x, s.z), o + 4 + 4); stats.signs++;
    o += 4 + 28; o += 2 + buf.readUInt16LE(o);
  }
  if (o !== buf.length) throw new Error(`tile walk ended at ${o} of ${buf.length} bytes`);
  return buf;
}
for (const tl of manifest.tiles) {
  const file = path.join(dir, tl.file);
  fs.writeFileSync(file, patchTile(fs.readFileSync(file)));
}
// the distant blocks: tiles of buildings alone, several to a file (compile.mjs)
for (const [, , f] of manifest.blocks?.chunks ?? []) {
  const file = path.join(dir, f), buf = fs.readFileSync(file), n = buf.readUInt32LE(4);
  let o = 8;
  for (let i = 0; i < n; i++) { const len = buf.readUInt32LE(o + 8); patchTile(buf.subarray(o + 12, o + 12 + len)); o += 12 + len; }
  fs.writeFileSync(file, buf);
}
// the landmarks' meshes (x_*.bin, landmarks.mjs encodeMesh: u32 n, n x [x, y, z] f32, n x rgb u8): each vertex with
// the ground under it, as they were built on it
for (const f of fs.readdirSync(dir).filter((f) => /^x_-?\d+_-?\d+\.bin$/.test(f))) {
  const buf = fs.readFileSync(path.join(dir, f)), n = buf.readUInt32LE(0);
  for (let i = 0; i < n; i++) {
    const o = 4 + i * 12, x = buf.readFloatLE(o), z = buf.readFloatLE(o + 8);
    buf.writeFloatLE(buf.readFloatLE(o + 4) + dz(x, z), o + 4);
  }
  fs.writeFileSync(path.join(dir, f), buf); stats.meshes++;
}

// ---------------------------------------------------------------- lines: roads, railways, footbridges, decks
// The change for each point of a line [x, y, z, ...]: the ground's under a point on the ground; along a stretch up
// on a structure, the change at the ground points either side of it, interpolated by distance (one end alone at a
// line's end; none on the ground at all: the change under the line's ends, interpolated).
function shiftLine(p, raised = (i) => Math.abs(p[i * 3 + 1] - g0(p[i * 3], p[i * 3 + 2])) > RAISED) {
  const n = p.length / 3, d = new Float64Array(n), up = Array.from({ length: n }, (_, i) => raised(i)), s = [0];
  for (let i = 1; i < n; i++) s.push(s[i - 1] + Math.hypot(p[i * 3] - p[i * 3 - 3], p[i * 3 + 2] - p[i * 3 - 1]));
  for (let i = 0; i < n; i++) if (!up[i]) d[i] = dz(p[i * 3], p[i * 3 + 2]);
  const ground = [...Array(n).keys()].filter((i) => !up[i]);
  if (!ground.length) { const a = dz(p[0], p[2]), b = dz(p[n * 3 - 3], p[n * 3 - 1]); for (let i = 0; i < n; i++) d[i] = a + (b - a) * (s[i] / (s[n - 1] || 1)); }
  else for (let i = 0; i < n; i++) {
    if (!up[i]) continue;
    const L = ground.filter((k) => k < i).at(-1), R = ground.find((k) => k > i);
    d[i] = L == null ? d[R] : R == null ? d[L] : d[L] + (d[R] - d[L]) * ((s[i] - s[L]) / (s[R] - s[L] || 1));
  }
  for (let i = 0; i < n; i++) p[i * 3 + 1] = Math.round((p[i * 3 + 1] + d[i]) * 100) / 100;
  return up.filter(Boolean).length;
}

const roads = JSON.parse(fs.readFileSync(path.join(dir, manifest.roads), 'utf8'));
for (const e of roads.edges) {
  const before = [];
  for (let i = 1; i < e.pts.length; i += 3) before.push(e.pts[i]);
  // (a bridge, a flyover or a street-level span is a structure from end to end; a tunnel's whole length too)
  const whole = e.bridge || e.flyover || e.span || e.tunnel;
  stats.raisedPoints += shiftLine(e.pts, whole ? (i) => i > 0 && i < e.pts.length / 3 - 1 : undefined);
  stats.roadPoints += before.length;
  let moved = 0;
  for (let i = 0; i < before.length; i++) moved = Math.max(moved, Math.abs(e.pts[i * 3 + 1] - before[i]));
  if (moved > 0.5) { e.pts0 ??= before; stats.edgesWithPts0++; }
}
// the nodes: the level of the edges' ends at them
const nodeY = new Map();
for (const e of roads.edges) { nodeY.set(e.a, e.pts[1]); nodeY.set(e.b, e.pts[e.pts.length - 2]); }
roads.nodes.forEach((nd, i) => { if (nodeY.has(i)) nd[1] = nodeY.get(i); else nd[1] = Math.round((nd[1] + dz(nd[0], nd[2])) * 100) / 100; });
fs.writeFileSync(path.join(dir, manifest.roads), JSON.stringify(roads));

if (manifest.rails) {
  const rails = JSON.parse(fs.readFileSync(path.join(dir, manifest.rails), 'utf8'));
  for (const line of rails.lines ?? rails) {
    const p = line.pts, before = Float64Array.from({ length: p.length / 3 }, (_, i) => p[i * 3 + 1]);
    shiftLine(p); stats.railPoints += p.length / 3;
    // a portal (a tunnel's mouth) moves with the line's point nearest it
    for (const q of line.portals ?? []) {
      let best = 0, bd = Infinity;
      for (let i = 0; i < p.length / 3; i++) { const d = Math.hypot(p[i * 3] - q[0], p[i * 3 + 2] - q[2]); if (d < bd) { bd = d; best = i; } }
      q[1] = Math.round((q[1] + p[best * 3 + 1] - before[best]) * 100) / 100;
    }
  }
  fs.writeFileSync(path.join(dir, manifest.rails), JSON.stringify(rails));
}
if (manifest.structures) {
  const st = JSON.parse(fs.readFileSync(path.join(dir, manifest.structures), 'utf8'));
  for (const f of st.footbridges ?? []) shiftLine(f.pts, f.steps ? undefined : (i) => i > 0 && i < f.pts.length / 3 - 1);
  const mid = (ring) => ring.reduce((s, q) => [s[0] + q[0] / ring.length, s[1] + q[1] / ring.length], [0, 0]);
  for (const p of st.platforms ?? []) p.y = Math.round((p.y + dz(...mid(p.ring))) * 100) / 100;
  for (const c of st.canopies ?? []) c.y = Math.round((c.y + dz(...mid(c.ring))) * 100) / 100;
  fs.writeFileSync(path.join(dir, manifest.structures), JSON.stringify(st));
}
// the bridges at street level: from bank to bank
for (const d of manifest.decks ?? []) { shiftLine(d.pts, (i) => i > 0 && i < d.pts.length / 3 - 1); stats.decks++; }

// ---------------------------------------------------------------- the grid and the manifest
fs.writeFileSync(path.join(dir, t.file), Buffer.from(G1.data.buffer));
let lo = Infinity, hi = -Infinity;
for (const v of G1.data) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
t.min = +lo.toFixed(2); t.max = +hi.toFixed(2);
t.lidar = { cells: covered, share: +(covered / G1.data.length).toFixed(3), project: LIDAR.projects[0], applied: 'after compiling (tools/pipeline/reterrain.mjs)' };
if (!manifest.attribution.includes(LIDAR.attribution)) manifest.attribution.push(LIDAR.attribution);
manifest.reterrained = new Date().toISOString();
fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 1));
console.log(`reterrain ${area.id}: ${covered} grid cells changed; ${stats.buildings} buildings rebased, ${stats.signs} signs, ${stats.meshes} landmark meshes; ` +
  `${stats.roadPoints} road points (${stats.raisedPoints} on structures), ${stats.edgesWithPts0} edges keep the simulation's levels in pts0; ` +
  `${stats.railPoints} rail points, ${stats.decks} street-level decks${lidarStats ? `; lidar: ${JSON.stringify(lidarStats)}` : ''}`);
