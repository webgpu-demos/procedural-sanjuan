// Fetches, decodes and meshes tiles off the main thread.
import { decodeTile } from '../shared/tileformat.js';
import { buildTile, blockMesh } from './meshing.js';
import { makeSurface } from '../shared/decks.js';
import { padField } from '../shared/terrain.js';
import { mergeArrows, accelTile, accelLookup } from '../shared/roadway.js';
import { prepareChannels } from './channels.js';

let grid = null, surface = null, merging = null, channels = null; // merging: the turn arrows painted where nothing turns (roadway.js)
let accel = null; // the acceleration lanes' quads (roadway.js accelLanes): paved in the tiles they cross

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
  let v = 0, k = 0;
  for (const { tx, tz, mesh } of parts) {
    const n = mesh.position.length / 3;
    position.set(mesh.position, v * 3); normal.set(mesh.normal, v * 3); color.set(mesh.color, v * 3);
    for (let i = 0; i < n; i++) { aTile[(v + i) * 2] = tx; aTile[(v + i) * 2 + 1] = tz; }
    for (let i = 0; i < mesh.index.length; i++) index[k + i] = mesh.index[i] + v;
    v += n; k += mesh.index.length;
  }
  return { position, normal, color, aTile, index };
}

self.onmessage = async ({ data: m }) => {
  if (m.type === 'init') {
    grid = { ...m.grid, data: new Float32Array(m.grid.data) };
    surface = makeSurface(grid, m.decks);
    channels = m.channels ? prepareChannels(m.channels, m.tileSize, grid) : null; // (channels.json: src/world/channels.js)
    return;
  }
  if (m.type === 'merges') { merging = mergeArrows(new Float32Array(m.segs)); return; }
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
      const mesh = buildTile(paved, grid, m.tileSize, surface, channels);
      if (m.meshUrl) mesh.models = await models(m.meshUrl);
      bound(mesh);
      self.postMessage({ type: 'tile', key: m.key, mesh }, buffers(mesh));
    } catch (e) {
      self.postMessage({ type: m.type === 'blocks' ? 'blocks-error' : 'error', key: m.key, message: e.message });
    }
  }
};
