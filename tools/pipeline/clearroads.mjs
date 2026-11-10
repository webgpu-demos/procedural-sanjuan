// The buildings of an area compiled before, taken out of its roads without compiling it again (a compile would take
// the simulated runs with it: they are made on the area's road graph, and stand in its folder). The rule is the
// compiler's own, tools/pipeline/roadclear.mjs: every building a drawn street-level centreline enters by half a
// metre or more is either removed (a canopy, a toll booth, a gate house; a building the road leaves too little of)
// or notched (an open slot for the road through a mall, a car park, a station).
//
// In each tile (t_x_z.bin) and in the distant blocks that repeat its buildings (k_x_z.bin):
//   removed   the record stays where it is, flagged BFLAG.NO_SOLID (src/shared/tileformat.js): not drawn, not run
//             into, and every building after it keeps its index in the tile (its line of t_x_z.ids, its colour)
//   notched   the same record, its footprint the pieces the road left
// And, because the compiled road surface stops at the walls that stood there:
//   paving    the slot as carriageway (AREA.CARRIAGEWAY), in the tile each piece lies in, running on a little past
//             the old wall line into the paving that stopped at it
//   signs     those that hung on a wall no longer there (on a removed building, or across a slot) go, and with
//             them a parapet the compiler ran along such a wall on a street-level bridge (it took the cut for the
//             bridge's open side), across what is now the road
// A passage through a building (OSM's tunnel=building_passage, read from the raw download if it is still there: the
// compiled graph files it with the tunnels, which are not drawn) is a road at street level: the buildings over it
// are notched and its whole length paved, and the manifest lists it (roadsCleared.passages: indices into roads.json).
// Real tunnels, bridges and flyovers are left alone, as are the forts and the landmarks drawn as models.
//
// Nothing else changes: not the number or the order of the buildings, not roads.json, not the simulated runs. Every
// file is copied to data/tiles-backup/before-clearroads-<area>/ before it is first written (a copy already there is
// kept: it is the file as compiled), with a list of what was done. A second run finds nothing to do.
//   node tools/pipeline/clearroads.mjs --area=sanjuan [--dir=public/tiles/sanjuan] [--backup=<directory>] [--dry-run] [--list]
import fs from 'node:fs';
import path from 'node:path';
import { resolveArea, ROOT } from './config.mjs';
import { decodeTile, encodeTile, AREA, BFLAG } from '../../src/shared/tileformat.js';
import { TILE, makeProjection } from '../../src/shared/geo.js';
import { roadIndex, resolve, slotPaving, clipBox, roadStrip, inCorridor, inPolygons, pairs, drawn, corridorHalf } from './roadclear.mjs';
import { PolyIndex } from './landscape.mjs';

const area = resolveArea();
const arg = (k, d) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const DRY = process.argv.includes('--dry-run'), LIST = process.argv.includes('--list');
const dir = path.resolve(arg('dir', area.outDir)), backup = path.resolve(arg('backup', path.join(ROOT, 'data/tiles-backup', `before-clearroads-${area.id}`)));
const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
const roads = JSON.parse(fs.readFileSync(path.join(dir, manifest.roads ?? 'roads.json'), 'utf8'));
const proj = makeProjection(manifest.origin.lon, manifest.origin.lat);
const heritage = area.heritage ? [[area.heritage.map(([lon, lat]) => proj.project(lon, lat))]] : null;
const read = (f) => { const b = fs.readFileSync(path.join(dir, f)); return new Uint8Array(b.buffer, b.byteOffset, b.byteLength); };
const decode = (u8) => decodeTile(u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength));
const same = (a, b) => a.length === b.length && Buffer.compare(Buffer.from(a.buffer, a.byteOffset, a.length), Buffer.from(b.buffer, b.byteOffset, b.length)) === 0;
const key = (x, z) => `${x}_${z}`;

// ---------------------------------------------------------------- the roads drawn at street level
// OSM's tags of the ways, where the raw download is still there: the passages through buildings among the tunnels
// (and what the report says of a road: covered or not)
const rawFile = path.join(area.rawDir, 'osm.json'), tags = new Map();
if (fs.existsSync(rawFile)) for (const e of JSON.parse(fs.readFileSync(rawFile, 'utf8')).elements) if (e.type === 'way' && e.tags?.highway) tags.set(e.id, e.tags);
const passagesBefore = new Set(manifest.roadsCleared?.passages ?? []);
roads.edges.forEach((e, i) => { if (e.tunnel && (e.passage || passagesBefore.has(i) || tags.get(e.way)?.tunnel === 'building_passage')) e.passage = 1; });
const index = roadIndex(roads.edges);

// ---------------------------------------------------------------- what the rule finds
const tileAt = new Map(manifest.tiles.map((t) => [key(t.x, t.z), t]));
const found = []; // { tile, i, r (resolve()'s), was (the footprint), box, base, top, paving, osm }
let failed = 0, buildings = 0;
// (and the paving and the footprints standing once the rule is done: for the centreline still bare, below)
const PAVED = new Set([AREA.ROAD, AREA.CARRIAGEWAY, AREA.SIDEWALK]), paving = new PolyIndex(16), solid = new PolyIndex(16);
for (const t of manifest.tiles) {
  const tile = decode(read(t.file));
  for (const a of tile.areas) if (PAVED.has(a.kind)) for (const rings of pairs(a.polygons)) paving.add(rings);
  if (!t.buildings) continue;
  const ids = t.ids && fs.existsSync(path.join(dir, t.ids)) ? fs.readFileSync(path.join(dir, t.ids), 'utf8').split('\n') : null;
  tile.buildings.forEach((b, i) => {
    buildings++;
    // (already taken out; a fort or a landmark, which is drawn as a model built on its outline)
    if (b.flags & BFLAG.NO_SOLID) return;
    const was = pairs(b.polygons), r = b.flags & BFLAG.MASONRY ? null : resolve(index, was, b.height);
    for (const rings of r?.action === 'remove' ? [] : r?.action === 'notch' ? r.polygons : was) solid.add(rings);
    if (!r) return;
    if (r.action === 'failed') { failed++; console.log(`  could not cut building ${i} of ${t.file} (left as it is)`); return; }
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const rings of was) for (const [x, z] of rings[0]) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
    found.push({ tile: key(t.x, t.z), i, r, was, box: [x0, z0, x1, z1], base: b.base, top: b.base + b.height, height: b.height, usage: b.usage,
      paving: slotPaving(r, was), osm: ids ? (ids[i] ?? '').split(',')[1] || null : undefined });
  });
}
// the passages the rule used: paved from end to end (those of an earlier run already are)
const passages = new Set(passagesBefore), strips = [];
for (const f of found) for (const road of f.r.roads) if (roads.edges[road.ei].passage && !passages.has(road.ei)) { passages.add(road.ei); strips.push(...roadStrip(roads.edges[road.ei])); }

// the paving, by the tile each piece lies in (a piece in a tile the area has no file for stays with its building's)
const changes = new Map(); // tile key -> { buildings: [found], paving: [polygon], signs: true }
const change = (k) => { if (!changes.has(k)) changes.set(k, { buildings: [], paving: [] }); return changes.get(k); };
const file = (polygons, home) => {
  for (const poly of polygons) {
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const [x, z] of poly[0]) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
    for (let tx = Math.floor(x0 / TILE); tx <= Math.floor(x1 / TILE); tx++) for (let tz = Math.floor(z0 / TILE); tz <= Math.floor(z1 / TILE); tz++)
      { const k = tileAt.has(key(tx, tz)) ? key(tx, tz) : home; if (tileAt.has(k)) change(k).paving.push(...clipBox([poly], tx * TILE, tz * TILE, (tx + 1) * TILE, (tz + 1) * TILE)); }
  }
};
for (const f of found) { change(f.tile).buildings.push(f); file(f.paving, f.tile); }
for (const poly of strips) file([poly], key(Math.floor(poly[0][0][0] / TILE), Math.floor(poly[0][0][1] / TILE)));

// ---------------------------------------------------------------- the centreline still bare
// A drawn street-level centreline with neither paving nor a building under it (a hole an older compile left in the
// paving, at a junction): its carriageway laid there, the stretch of it around the bare points. The test
// (roads-clear.test.mjs) walks the centrelines the same way, a point every STEP metres.
for (const f of found) for (const rings of f.paving) paving.add(rings);
for (const rings of strips) paving.add(rings);
const STEP = 2, bounds = manifest.bounds, gaps = []; // { ei, points }
roads.edges.forEach((e, ei) => {
  if (!drawn(e.passage && !passages.has(ei) ? { ...e, passage: 0 } : e)) return;
  const p = e.pts;
  let run = null;
  for (let k = 3; k < p.length; k += 3) {
    const ax = p[k - 3], az = p[k - 1], bx = p[k], bz = p[k + 2], n = Math.max(1, Math.round(Math.hypot(bx - ax, bz - az) / STEP));
    for (let s = 0; s < n; s++) {
      const x = ax + (bx - ax) * (s + 0.5) / n, z = az + (bz - az) * (s + 0.5) / n;
      const bare = x >= bounds.minX && x <= bounds.maxX && z >= bounds.minZ && z <= bounds.maxZ && !paving.has(x, z) && !solid.has(x, z);
      if (bare) { if (!run) gaps.push(run = { ei, points: [] }); run.points.push([x, z]); } else run = null;
    }
  }
});
let gapMetres = 0;
for (const g of gaps) {
  const e = roads.edges[g.ei], pad = corridorHalf(e) + STEP;
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const [x, z] of g.points) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
  gapMetres += g.points.length * STEP;
  const [x, z] = g.points[0];
  const box = [x0 - pad, z0 - pad, x1 + pad, z1 + pad];
  file(clipBox(roadStrip(e, box), ...box), key(Math.floor(x / TILE), Math.floor(z / TILE)));
}
if (gaps.length) console.log(`  about ${gapMetres} m of drawn centreline had neither paving nor a building under it, on ${new Set(gaps.map((g) => g.ei)).size} roads: paved`);

// ---------------------------------------------------------------- the signs on walls no longer there
// A sign hangs a hand's breadth off its wall, facing out (signs.mjs): it is this building's if the nearest stretch
// of its outline is within reach and faces the same way. On a removed building it goes; on a notched one, if it
// reaches into the slot.
function nearestWall(x, z, polygons) {
  let best = { d: Infinity, nx: 0, nz: 0 };
  for (const rings of polygons) for (const r of rings) for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const ax = r[j][0], az = r[j][1], dx = r[i][0] - ax, dz = r[i][1] - az, l2 = dx * dx + dz * dz, l = Math.sqrt(l2) || 1;
    const t = l2 ? Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2)) : 0, d = Math.hypot(x - ax - dx * t, z - az - dz * t);
    if (d < best.d) best = { d, nx: -dz / l, nz: dx / l }; // (outward for a counter-clockwise outline)
  }
  return best;
}
const gone = (s) => found.some((f) => {
  if (s.x < f.box[0] - 1 || s.x > f.box[2] + 1 || s.z < f.box[1] - 1 || s.z > f.box[3] + 1 || s.y < f.base - 1 || s.y > f.top + 8) return false;
  const w = nearestWall(s.x, s.z, f.was);
  if (w.d > 0.7 || w.nx * s.nx + w.nz * s.nz < 0.85) return false;
  // (across the slot: its middle or either end, along the wall)
  return f.r.action === 'remove' || [0, -0.5, 0.5].some((k) => inCorridor(f.r, s.x - s.nz * s.w * k, s.z + s.nx * s.w * k));
});
// (a deck's parapet, [x1, z1, x2, z2, deck], along the old wall where the road now runs)
const parapetGone = (w, i) => {
  if (w[i + 4] < 0) return false; // (a fence, a wall, a hedge that OSM maps: not the compiler's)
  const x = (w[i] + w[i + 2]) / 2, z = (w[i + 1] + w[i + 3]) / 2;
  return found.some((f) => x >= f.box[0] - 1 && x <= f.box[2] + 1 && z >= f.box[1] - 1 && z <= f.box[3] + 1 && inCorridor(f.r, x, z) && (inPolygons(x, z, f.was) || nearestWall(x, z, f.was).d < 0.8));
};
// the tiles next to a changed building's: a sign or a parapet of its may be filed there
for (const t of manifest.tiles) {
  if (changes.has(key(t.x, t.z))) continue;
  const x0 = t.x * TILE, z0 = t.z * TILE;
  if (found.some((f) => f.box[2] + 1 >= x0 && f.box[0] - 1 <= x0 + TILE && f.box[3] + 1 >= z0 && f.box[1] - 1 <= z0 + TILE)) change(key(t.x, t.z));
}

// ---------------------------------------------------------------- the report
const klass = (e) => (e.highway === 'service' ? 'service way' : 'public road');
const worst = (f) => f.r.roads.map((r) => roads.edges[r.ei]).sort((a, b) => (a.highway === 'service') - (b.highway === 'service'))[0];
const group = (f) => {
  const e = worst(f), t = tags.get(e.way) ?? {};
  const how = e.passage ? 'passage (tunnel=building_passage)' : t.covered && t.covered !== 'no' ? 'covered road' : `uncovered ${klass(e)}`;
  return `${f.osm === undefined ? 'building' : f.osm ? 'OSM' : 'FEMA-only'} | ${how}${e.passage || (t.covered && t.covered !== 'no') ? `, ${klass(e)}` : ''}`;
};
const removed = found.filter((f) => f.r.action === 'remove'), notched = found.filter((f) => f.r.action === 'notch');
console.log(`clearroads ${area.id}: ${buildings} buildings in ${manifest.tiles.length} tiles, ${roads.edges.length} road edges${tags.size ? '' : ' (no raw OSM here: passages through buildings stay with the tunnels)'}`);
console.log(`  a drawn street-level centreline enters ${found.length} by 0.5 m or more: ${removed.length} to remove, ${notched.length} to notch${failed ? `, ${failed} the clipper could not cut` : ''}`);
{
  const rows = new Map();
  for (const f of found) { const g = group(f); if (!rows.has(g)) rows.set(g, [0, 0, 0]); const r = rows.get(g); r[f.r.action === 'remove' ? 0 : 1]++; r[2] += f.r.roads.reduce((s, x) => s + x.inside, 0); }
  for (const [g, [a, b, m]] of [...rows].sort()) console.log(`    ${g.padEnd(58)} removed ${String(a).padStart(3)}  notched ${String(b).padStart(3)}  ${m.toFixed(0).padStart(5)} m of centreline inside`);
}
if (LIST) for (const f of found) {
  const e = worst(f), r = f.r.roads.reduce((a, b) => (b.inside > a.inside ? b : a));
  console.log(`    ${f.r.action.padEnd(6)} t_${f.tile} #${String(f.i).padEnd(4)} ${String(f.osm ?? '').padEnd(12)} ${f.r.area.toFixed(0).padStart(6)} m2 ${f.height.toFixed(1).padStart(5)} m  keeps ${(f.r.left * 100).toFixed(0).padStart(3)}% in ${f.r.pieces}  ` +
    `${e.highway}${e.name ? ` "${e.name}"` : ''} ${r.inside.toFixed(1)} m${f.r.through ? '' : ' (ends inside)'}  at ${r.x.toFixed(1)}, ${r.z.toFixed(1)}`);
}

// ---------------------------------------------------------------- the tiles and the blocks, changed
const NEW = (f) => (f.r.action === 'remove' ? null : f.r.polygons);
function apply(tile, c, embedded = false) {
  for (const f of c.buildings) {
    const b = tile.buildings[f.i], ring = b?.polygons[0]?.[0], [x, z] = f.was[0][0][0];
    // (the same record in the tile and in the block chunk that repeats it)
    if (!ring || Math.abs(ring[0] - x) > 0.005 || Math.abs(ring[1] - z) > 0.005) throw new Error(`building ${f.i} of tile ${f.tile} is not the one the rule looked at${embedded ? ' (in its block chunk)' : ''}`);
    if (NEW(f)) b.polygons = NEW(f); else b.flags |= BFLAG.NO_SOLID;
  }
  if (embedded) return 0;
  for (const poly of c.paving) {
    const n = poly[0].length, cx = poly[0].reduce((s, p) => s + p[0], 0) / n, cz = poly[0].reduce((s, p) => s + p[1], 0) / n;
    // (the old city's streets are paved with adoquines, carriageway code 1: compile.mjs)
    tile.areas.push({ kind: AREA.CARRIAGEWAY, code: heritage && inPolygons(cx, cz, heritage) ? 1 : 0, polygons: [poly] });
  }
  const before = tile.signs.length + tile.walls.length / 5, walls = [];
  tile.signs = tile.signs.filter((s) => !gone(s));
  for (let i = 0; i < tile.walls.length; i += 5) if (!parapetGone(tile.walls, i)) walls.push(...tile.walls.subarray(i, i + 5));
  if (walls.length !== tile.walls.length) tile.walls = Float32Array.from(walls);
  return before - tile.signs.length - tile.walls.length / 5;
}
// every file to be written, as it will be: nothing is written until all of them came through
const out = new Map(); // file -> bytes
const stats = { tiles: 0, chunks: 0, paved: 0, signs: 0 }; // (signs: and parapets)
const roundTrip = (u8, name) => {
  const again = encodeTile(decode(u8));
  if (same(u8, again)) return;
  let i = 0; while (i < Math.min(u8.length, again.length) && u8[i] === again[i]) i++;
  throw new Error(`${name} does not come back the same from decode -> encode (${u8.length} bytes -> ${again.length}, first difference at byte ${i}): nothing written`);
};
// (a few tiles the rule leaves alone, as well: the format's round trip itself)
manifest.tiles.filter((t) => !changes.has(key(t.x, t.z))).filter((_, i, a) => i % Math.max(1, Math.floor(a.length / 24)) === 0).forEach((t) => roundTrip(read(t.file), t.file));
for (const [k, c] of changes) {
  const t = tileAt.get(k), u8 = read(t.file);
  roundTrip(u8, t.file);
  const tile = decode(u8), signs = apply(tile, c), bytes = encodeTile(tile);
  if (same(u8, bytes)) continue;
  out.set(t.file, bytes);
  stats.tiles++; stats.paved += c.paving.length; stats.signs += signs;
  Object.assign(t, { areas: tile.areas.length, signs: tile.signs.length, bytes: bytes.length });
}
// the distant blocks: k_<cx>_<cz>.bin, u32 'BLK1' | u32 nTiles | per tile: i32 tx | i32 tz | u32 byteLength | a tile of buildings only (compile.mjs)
for (const [, , f] of manifest.blocks?.chunks ?? []) {
  const u8 = read(f), dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength), parts = [];
  let o = 8, changed = false;
  for (let n = dv.getUint32(4, true); n > 0; n--) {
    const tx = dv.getInt32(o, true), tz = dv.getInt32(o + 4, true), len = dv.getUint32(o + 8, true), part = u8.subarray(o + 12, o + 12 + len), c = changes.get(key(tx, tz));
    o += 12 + len;
    if (!c?.buildings.length) { parts.push([tx, tz, part]); continue; }
    roundTrip(part, `${f} (tile ${tx}_${tz})`);
    const tile = decode(part);
    apply(tile, c, true);
    parts.push([tx, tz, encodeTile(tile)]); changed = true;
  }
  if (!changed) continue;
  const buf = Buffer.alloc(8 + parts.reduce((n, p) => n + 12 + p[2].length, 0));
  buf.writeUInt32LE(0x314b4c42, 0); buf.writeUInt32LE(parts.length, 4);
  let w = 8;
  for (const [tx, tz, part] of parts) { buf.writeInt32LE(tx, w); buf.writeInt32LE(tz, w + 4); buf.writeUInt32LE(part.length, w + 8); buf.set(part, w + 12); w += 12 + part.length; }
  out.set(f, buf); stats.chunks++;
}
console.log(`  ${stats.tiles} tiles and ${stats.chunks} block chunks change; ${stats.paved} pieces of paving laid in the slots${strips.length ? ` and along ${passages.size - passagesBefore.size} passages` : ''}; ${stats.signs} signs and parapets on walls no longer there`);
if (!out.size) { console.log('  nothing to do'); process.exit(0); }
if (DRY) { console.log('  --dry-run: nothing written'); process.exit(0); }

// ---------------------------------------------------------------- write, each file's copy first
const was = manifest.roadsCleared;
manifest.roadsCleared = {
  date: new Date().toISOString(), by: 'tools/pipeline/clearroads.mjs',
  buildings: (was?.buildings ?? 0) + found.length, removed: (was?.removed ?? 0) + removed.length, notched: (was?.notched ?? 0) + notched.length,
  paved: (was?.paved ?? 0) + stats.paved, signs: (was?.signs ?? 0) + stats.signs, gaps: (was?.gaps ?? 0) + gaps.length,
  // the tunnel=building_passage edges of roads.json (tunnels there) that are now drawn, at street level
  passages: [...passages].sort((a, b) => a - b),
};
out.set('manifest.json', Buffer.from(JSON.stringify(manifest, null, 1)));
fs.mkdirSync(backup, { recursive: true });
let copied = 0;
for (const f of out.keys()) if (!fs.existsSync(path.join(backup, f))) { fs.copyFileSync(path.join(dir, f), path.join(backup, f)); copied++; }
// what was done, beside the copies (each run's list after the last)
const logFile = path.join(backup, 'cleared.json'), log = fs.existsSync(logFile) ? JSON.parse(fs.readFileSync(logFile, 'utf8')) : [];
log.push({ date: manifest.roadsCleared.date, dir: path.relative(ROOT, dir), buildings: found.map((f) => {
  const r = f.r.roads.reduce((a, b) => (b.inside > a.inside ? b : a)), e = roads.edges[r.ei];
  return { tile: f.tile, index: f.i, osm: f.osm ?? null, action: f.r.action, area: Math.round(f.r.area), height: +f.height.toFixed(1), keeps: +f.r.left.toFixed(2), pieces: f.r.pieces, through: f.r.through,
    group: group(f), road: { edge: r.ei, way: e.way, highway: e.highway, name: e.name ?? null, inside: +r.inside.toFixed(1) }, at: [+r.x.toFixed(1), +r.z.toFixed(1)] };
}) });
fs.writeFileSync(logFile, JSON.stringify(log, null, 1));
// each file whole or not at all (a running dev server never serves half a tile): beside it, then renamed over it
for (const [f, bytes] of out) { const p = path.join(dir, f); fs.writeFileSync(`${p}.clearing`, bytes); fs.renameSync(`${p}.clearing`, p); }
console.log(`  written: ${out.size - 1} files and manifest.json (roadsCleared); ${copied} copied first to ${path.relative(ROOT, backup)}/ (the list of what was done: cleared.json there)`);
