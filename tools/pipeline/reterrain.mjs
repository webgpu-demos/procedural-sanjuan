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
// Lines meet: a road's edges at the graph's nodes, a railway's or a footbridge's pieces end to end. Each point of a
// network takes one change, so that where pieces met they still meet. A point on the ground takes the change of the
// ground under it. A point up on a structure (a bridge, a flyover, a viaduct: more than 1.5 m off the old ground, or
// inside a bridge's or a tunnel's way) takes the change at the ground round it, carried along the network: each such
// point the distance-weighted mean of its neighbours' (a harmonic fill), so a deck keeps its line from bank to bank
// and a ramp still meets the bridge it climbs to.
// lines: [{ pts, a, b, inner }]: a, b the keys of the line's ends (lines sharing a key meet there; null: its own),
// inner: the inside of the line is a structure whatever its height. Returns the changes, per line.
function shiftNetwork(lines) {
  const id = new Map(), X = [], Z = [], up = [], nb = [];
  const point = (key, x, z, raised) => {
    let i = key != null ? id.get(key) : undefined;
    if (i === undefined) { i = X.length; X.push(x); Z.push(z); up.push(raised); nb.push([]); if (key != null) id.set(key, i); }
    return i;
  };
  const idx = lines.map(({ pts, a, b, inner }) => {
    const n = pts.length / 3, out = [];
    for (let k = 0; k < n; k++) {
      const x = pts[k * 3], z = pts[k * 3 + 2], raised = (inner && k > 0 && k < n - 1) || Math.abs(pts[k * 3 + 1] - g0(x, z)) > RAISED;
      out.push(point(k === 0 ? a : k === n - 1 ? b : null, x, z, raised));
    }
    for (let k = 1; k < n; k++) {
      const w = 1 / Math.max(0.5, Math.hypot(X[out[k]] - X[out[k - 1]], Z[out[k]] - Z[out[k - 1]]));
      nb[out[k]].push(out[k - 1], w); nb[out[k - 1]].push(out[k], w);
    }
    return out;
  });
  const d = Float64Array.from(X, (x, i) => dz(x, Z[i]));
  const free = [...up.keys()].filter((i) => up[i] && nb[i].length);
  for (let it = 0; it < 4000; it++) {
    let moved = 0;
    for (const i of free) {
      let sw = 0, sd = 0;
      for (let k = 0; k < nb[i].length; k += 2) { sw += nb[i][k + 1]; sd += nb[i][k + 1] * d[nb[i][k]]; }
      const v = sd / sw; moved = Math.max(moved, Math.abs(v - d[i])); d[i] = v;
    }
    if (moved < 0.002) break;
  }
  stats.raisedPoints += free.length;
  return { per: idx.map((out) => out.map((i) => d[i])), at: (key) => (id.has(key) ? d[id.get(key)] : null) };
}
const apply = (pts, ds) => { for (let k = 0; k < ds.length; k++) pts[k * 3 + 1] = Math.round((pts[k * 3 + 1] + ds[k]) * 100) / 100; };
const end = (pts, k) => `${pts[k * 3].toFixed(1)},${pts[k * 3 + 2].toFixed(1)}`; // (pieces of a railway or a footbridge meet end to end)

const roads = JSON.parse(fs.readFileSync(path.join(dir, manifest.roads), 'utf8'));
{
  // (a bridge, a flyover or a street-level span is a structure from end to end; a tunnel's whole length too)
  const net = shiftNetwork(roads.edges.map((e) => ({ pts: e.pts, a: 'n' + e.a, b: 'n' + e.b, inner: !!(e.bridge || e.flyover || e.span || e.tunnel) })));
  roads.edges.forEach((e, i) => {
    const before = [];
    for (let k = 1; k < e.pts.length; k += 3) before.push(e.pts[k]);
    apply(e.pts, net.per[i]); stats.roadPoints += before.length;
    if (net.per[i].some((v) => Math.abs(v) > 0.5)) { e.pts0 ??= before; stats.edgesWithPts0++; }
  });
  roads.nodes.forEach((nd, i) => { nd[1] = Math.round((nd[1] + (net.at('n' + i) ?? dz(nd[0], nd[2]))) * 100) / 100; });
}
fs.writeFileSync(path.join(dir, manifest.roads), JSON.stringify(roads));

if (manifest.rails) {
  const rails = JSON.parse(fs.readFileSync(path.join(dir, manifest.rails), 'utf8')), lines = rails.lines ?? rails;
  const net = shiftNetwork(lines.map((l) => ({ pts: l.pts, a: end(l.pts, 0), b: end(l.pts, l.pts.length / 3 - 1), inner: false })));
  lines.forEach((line, i) => {
    const p = line.pts, ds = net.per[i];
    // a portal (a tunnel's mouth) moves with the line's point nearest it
    for (const q of line.portals ?? []) {
      let best = 0, bd = Infinity;
      for (let k = 0; k < p.length / 3; k++) { const dd = Math.hypot(p[k * 3] - q[0], p[k * 3 + 2] - q[2]); if (dd < bd) { bd = dd; best = k; } }
      q[1] = Math.round((q[1] + ds[best]) * 100) / 100;
    }
    apply(p, ds); stats.railPoints += p.length / 3;
  });
  fs.writeFileSync(path.join(dir, manifest.rails), JSON.stringify(rails));
}
if (manifest.structures) {
  const st = JSON.parse(fs.readFileSync(path.join(dir, manifest.structures), 'utf8')), fb = st.footbridges ?? [];
  const net = shiftNetwork(fb.map((f) => ({ pts: f.pts, a: end(f.pts, 0), b: end(f.pts, f.pts.length / 3 - 1), inner: !f.steps })));
  fb.forEach((f, i) => apply(f.pts, net.per[i]));
  const mid = (ring) => ring.reduce((s, q) => [s[0] + q[0] / ring.length, s[1] + q[1] / ring.length], [0, 0]);
  for (const p of st.platforms ?? []) p.y = Math.round((p.y + dz(...mid(p.ring))) * 100) / 100;
  for (const c of st.canopies ?? []) c.y = Math.round((c.y + dz(...mid(c.ring))) * 100) / 100;
  fs.writeFileSync(path.join(dir, manifest.structures), JSON.stringify(st));
}
// the bridges at street level: from bank to bank
{
  const decks = manifest.decks ?? [], net = shiftNetwork(decks.map((d) => ({ pts: d.pts, a: null, b: null, inner: true })));
  decks.forEach((d, i) => { apply(d.pts, net.per[i]); stats.decks++; });
}

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
