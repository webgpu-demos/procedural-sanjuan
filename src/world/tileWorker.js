// Fetches, decodes and meshes tiles off the main thread.
import { decodeTile } from '../shared/tileformat.js';
import { buildTile, blockMesh } from './meshing.js';
import { makeSurface } from '../shared/decks.js';
import { padField } from '../shared/terrain.js';
import { mergeArrows, accelTile, accelLookup } from '../shared/roadway.js';
import { prepareChannels } from './channels.js';
import { carriageLookup } from '../shared/carriage.js';

let grid = null, surface = null, merging = null, channels = null; // merging: the turn arrows painted where nothing turns (roadway.js)
let accel = null; // the acceleration lanes' quads (roadway.js accelLanes): paved in the tiles they cross
let carriage = null; // the carriageways no paving stands on (src/shared/carriage.js)

// All typed arrays in a result, so they are transferred rather than copied.
// Every mesh's bounding box and sphere (positions -> [min xyz, max xyz, centre xyz, radius], as three works them out),
// worked out here: on the main thread they were most of a tile's arrival, a hitch in the picture as the city streamed
function bound(o) {
  if (!o || typeof o !== 'object' || ArrayBuffer.isView(o)) return;
  const p = o.position;
  if (p instanceof Float32Array && p.length >= 3) {
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    for (let i = 0; i < p.length; i += 3) {
      const x = p[i], y = p[i + 1], z = p[i + 2];
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; if (z < z0) z0 = z; if (z > z1) z1 = z;
    }
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, cz = (z0 + z1) / 2;
    let r2 = 0;
    for (let i = 0; i < p.length; i += 3) { const dx = p[i] - cx, dy = p[i + 1] - cy, dz = p[i + 2] - cz, d = dx * dx + dy * dy + dz * dz; if (d > r2) r2 = d; }
    o.bounds = new Float32Array([x0, y0, z0, x1, y1, z1, cx, cy, cz, Math.sqrt(r2)]);
  }
  for (const v of Object.values(o)) if (v !== o.bounds) bound(v);
}

// A mesh of separate triangles (the meshing emits each triangle's three corners) welded into shared corners and an
// index. The tiles' roads and paint held four copies of every corner: 5.8 million vertices round the Milla de Oro,
// over 200 MB on the GPU and as much again in the page, for 1.4 million distinct ones. Corners merge only when every
// attribute is the same to the bit, so the picture is the same, corner for corner.
function weld(m) {
  if (!m?.position?.length || m.index) return m;
  const names = Object.keys(m).filter((k) => m[k] instanceof Float32Array), n = m.position.length / 3;
  if (names.some((k) => m[k].length % n)) return m;
  const sizes = names.map((k) => m[k].length / n), words = names.map((k) => new Uint32Array(m[k].buffer, m[k].byteOffset, m[k].length));
  let size = 1; while (size < n * 2) size <<= 1;
  const table = new Int32Array(size).fill(-1), first = new Int32Array(n), index = new Uint32Array(n); // first: each kept corner's source
  const same = (u, v) => {
    for (let a = 0; a < words.length; a++) { const w = words[a], s = sizes[a]; for (let c = 0; c < s; c++) if (w[u * s + c] !== w[v * s + c]) return false; }
    return true;
  };
  let count = 0;
  for (let v = 0; v < n; v++) {
    let h = 0x811c9dc5;
    for (let a = 0; a < words.length; a++) { const w = words[a], s = sizes[a]; for (let c = 0; c < s; c++) h = Math.imul(h ^ w[v * s + c], 0x01000193); }
    for (let slot = (h ^ (h >>> 15)) & (size - 1); ; slot = (slot + 1) & (size - 1)) {
      const t = table[slot];
      if (t < 0) { table[slot] = count; first[count] = v; index[v] = count++; break; }
      if (same(first[t], v)) { index[v] = t; break; }
    }
  }
  const out = { ...m };
  names.forEach((k, a) => {
    const src = m[k], s = sizes[a], dst = new Float32Array(count * s);
    for (let i = 0; i < count; i++) for (let c = 0; c < s; c++) dst[i * s + c] = src[first[i] * s + c];
    out[k] = dst;
  });
  out.index = count < 65536 ? Uint16Array.from(index) : index;
  return out;
}

function buffers(o, out = []) {
  for (const v of Object.values(o)) {
    if (ArrayBuffer.isView(v)) out.push(v.buffer);
    else if (v && typeof v === 'object') buffers(v, out);
  }
  return out;
}

// Static mesh of a tile (x_<x>_<z>.bin: u32 triangle vertex count, f32 positions, u8 sRGB colours) -> flat-shaded arrays.
async function models(url) {
  const res = await fetch(url);
  if (!res.ok) return null;
  const buf = await res.arrayBuffer(), n = new DataView(buf).getUint32(0, true);
  const position = new Float32Array(buf.slice(4, 4 + n * 12)), rgb = new Uint8Array(buf, 4 + n * 12, n * 3);
  const normal = new Float32Array(n * 3), color = new Float32Array(n * 3);
  const lin = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  for (let i = 0; i < n * 3; i++) color[i] = lin(rgb[i] / 255);
  for (let i = 0; i < n * 3; i += 9) {
    const ux = position[i + 3] - position[i], uy = position[i + 4] - position[i + 1], uz = position[i + 5] - position[i + 2];
    const vx = position[i + 6] - position[i], vy = position[i + 7] - position[i + 1], vz = position[i + 8] - position[i + 2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l; ny /= l; nz /= l;
    for (let k = 0; k < 9; k += 3) { normal[i + k] = nx; normal[i + k + 1] = ny; normal[i + k + 2] = nz; }
  }
  return { position, normal, color };
}

// A chunk of distant buildings (k_<x>_<z>.bin, see tools/pipeline/compile.mjs) -> one mesh of plain blocks;
// aTile holds each vertex's tile, so a tile's buildings can be hidden once the tile is in in full.
function blockChunk(buf) {
  const dv = new DataView(buf);
  if (dv.getUint32(0, true) !== 0x314b4c42) throw new Error('not a block chunk');
  const parts = [];
  for (let n = dv.getUint32(4, true), o = 8; n > 0; n--) {
    const tx = dv.getInt32(o, true), tz = dv.getInt32(o + 4, true), len = dv.getUint32(o + 8, true);
    parts.push({ tx, tz, mesh: blockMesh(decodeTile(buf.slice(o + 12, o + 12 + len)).buildings, tx, tz) });
    o += 12 + len;
  }
  const verts = parts.reduce((s, p) => s + p.mesh.position.length / 3, 0), idx = parts.reduce((s, p) => s + p.mesh.index.length, 0);
  const position = new Float32Array(verts * 3), normal = new Float32Array(verts * 3), color = new Float32Array(verts * 3), aTile = new Float32Array(verts * 2);
  const index = verts > 65535 ? new Uint32Array(idx) : new Uint16Array(idx);
  let v = 0;
  for (const { tx, tz, mesh } of parts) {
    const n = mesh.position.length / 3;
    position.set(mesh.position, v * 3); normal.set(mesh.normal, v * 3); color.set(mesh.color, v * 3);
    for (let i = 0; i < n; i++) { aTile[(v + i) * 2] = tx; aTile[(v + i) * 2 + 1] = tz; }
    mesh.first = v; v += n;
  }
  // (the index run by run, each tile's part of a run after the one before's: blockMesh's big buildings of every tile
  // first, then the middling, then the small; `cuts` where the second and third runs begin, for the draw range)
  const cuts = new Uint32Array(2);
  let k = 0;
  for (let r = 0; r < 3; r++) {
    if (r) cuts[r - 1] = k;
    for (const { mesh } of parts) {
      const from = r ? mesh.cuts[r - 1] : 0, to = r < 2 ? mesh.cuts[r] : mesh.index.length;
      for (let i = from; i < to; i++) index[k++] = mesh.index[i] + mesh.first;
    }
  }
  return { position, normal, color, aTile, index, cuts };
}

self.onmessage = async ({ data: m }) => {
  if (m.type === 'init') {
    grid = { ...m.grid, data: new Float32Array(m.grid.data) };
    surface = makeSurface(grid, m.decks);
    channels = m.channels ? prepareChannels(m.channels, m.tileSize, grid) : null; // (channels.json: src/world/channels.js)
    return;
  }
  if (m.type === 'merges') { merging = mergeArrows(new Float32Array(m.segs)); return; }
  if (m.type === 'carriage') { carriage = carriageLookup(new Float32Array(m.segs)); return; }
  if (m.type === 'pads') { grid.pads = padField(m.pads); return; }
  if (m.type === 'accel') { const pave = new Float32Array(m.pave); accel = { pave, line: new Float32Array(m.line), on: accelLookup(pave) }; return; }
  if (m.type === 'tile' || m.type === 'blocks') {
    try {
      const res = await fetch(m.url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      if (m.type === 'blocks') { const mesh = blockChunk(await res.arrayBuffer()); bound(mesh); self.postMessage({ type: 'blocks', key: m.key, mesh }, buffers(mesh)); return; }
      const tile = decodeTile(await res.arrayBuffer());
      if (merging) tile.props = tile.props.filter((p) => !merging(p));
      const paved = accel ? accelTile(tile, accel, m.tileSize, accel.on) : tile;
      const mesh = buildTile(paved, grid, m.tileSize, surface, channels, carriage);
      if (m.meshUrl) mesh.models = await models(m.meshUrl);
      for (const k of ['roads', 'paint', 'decals']) mesh[k] = weld(mesh[k]);
      if (mesh.buildings.details) mesh.buildings.details = weld(mesh.buildings.details);
      bound(mesh);
      self.postMessage({ type: 'tile', key: m.key, mesh }, buffers(mesh));
    } catch (e) {
      self.postMessage({ type: m.type === 'blocks' ? 'blocks-error' : 'error', key: m.key, message: e.message });
    }
  }
};
