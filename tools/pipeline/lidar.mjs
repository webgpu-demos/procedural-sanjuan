// The USGS 3DEP 1 m bare-earth DEM from lidar, where it covers the area, in place of the terrain tiles.
//
// The terrain tiles (terrain.mjs) carry the 10 m (1/3 arc-second) 3DEP surface under San Juan: smooth hills, but on
// the coastal plain flat terraces at whole metres (Garita measured most of its ground at exactly 3.0, 7.0, 10.0 and
// 13.0 m there) and the expressway's overpasses as ridges. The 1 m DEM is the lidar ground itself, hydro-flattened,
// buildings and bridges removed. Each cell of the height grid takes the MEAN of the 1 m cells inside it (a 5 m cell:
// 25 of them), if at least half of them hold data; otherwise it keeps the terrain tiles' value. Nothing is filled
// or invented from the lidar.
//
// Source  GeoTIFF tiles of 10 km under https://prd-tnm.s3.amazonaws.com/StagedProducts/Elevation/1m/Projects/,
//         collection PR_PuertoRicoUSVI_D24 (flown 2023-12 to 2025-03; NAD83 / UTM zone 19N, float32 metres; the
//         heights on Puerto Rico's own datum, PRVD02, mean sea level, the datum of the terrain tiles on land too).
//         Named USGS_1M_<zone>_x<E/10 km>y<N/10 km, top edge>_<project>.tif. fetch.mjs lists the bucket and
//         downloads the tiles the area touches into data/raw/<area>/dem/lidar/.
import fs from 'node:fs';
import path from 'node:path';

export const LIDAR = {
  bucket: 'https://prd-tnm.s3.amazonaws.com/',
  prefix: 'StagedProducts/Elevation/1m/Projects/',
  projects: ['PR_PuertoRicoUSVI_D24'],
  attribution: 'Elevation: USGS 3D Elevation Program, 1 m DEM from lidar (PR_PuertoRicoUSVI_D24)',
};

// ---------------------------------------------------------------- UTM (transverse Mercator, GRS 80)
// Snyder's series (USGS Professional Paper 1395, p. 61): well under a centimetre here, against GDAL.
const A = 6378137, F = 1 / 298.257222101, K0 = 0.9996, E2 = F * (2 - F), EP2 = E2 / (1 - E2);
const D2R = Math.PI / 180;
const M = (phi) => A * ((1 - E2 / 4 - 3 * E2 ** 2 / 64 - 5 * E2 ** 3 / 256) * phi
  - (3 * E2 / 8 + 3 * E2 ** 2 / 32 + 45 * E2 ** 3 / 1024) * Math.sin(2 * phi)
  + (15 * E2 ** 2 / 256 + 45 * E2 ** 3 / 1024) * Math.sin(4 * phi)
  - (35 * E2 ** 3 / 3072) * Math.sin(6 * phi));
export function utm(lon, lat, zone) {
  const phi = lat * D2R, lam0 = (zone * 6 - 183) * D2R;
  const s = Math.sin(phi), c = Math.cos(phi), t = Math.tan(phi);
  const N = A / Math.sqrt(1 - E2 * s * s), T = t * t, C = EP2 * c * c, a = c * (lon * D2R - lam0);
  const east = K0 * N * (a + (1 - T + C) * a ** 3 / 6 + (5 - 18 * T + T * T + 72 * C - 58 * EP2) * a ** 5 / 120) + 500000;
  const north = K0 * (M(phi) + N * t * (a * a / 2 + (5 - T + 9 * C + 4 * C * C) * a ** 4 / 24 + (61 - 58 * T + T * T + 600 * C - 330 * EP2) * a ** 6 / 720));
  return [east, north];
}

// ---------------------------------------------------------------- tiles
const NAME = /^USGS_1M_(\d+)_x(\d+)y(\d+)_(.+)\.tif$/;
export function parseTileName(name) {
  const m = NAME.exec(path.basename(name));
  if (!m) return null;
  const zone = +m[1], x = +m[2], y = +m[3];
  // 10 km squares named by their west and their top edge (the files carry a few metres of overlap)
  return { name: path.basename(name), zone, project: m[4], e0: x * 10000, e1: x * 10000 + 10000, n0: y * 10000 - 10000, n1: y * 10000 };
}

// The tiles of `names` (bucket keys or file names) that a lon/lat box touches.
export function tilesFor(names, { west, south, east, north }) {
  const out = [];
  for (const key of names) {
    const t = parseTileName(key);
    if (!t) continue;
    const corners = [[west, south], [west, north], [east, south], [east, north]].map(([lo, la]) => utm(lo, la, t.zone));
    const e0 = Math.min(...corners.map((c) => c[0])), e1 = Math.max(...corners.map((c) => c[0]));
    const n0 = Math.min(...corners.map((c) => c[1])), n1 = Math.max(...corners.map((c) => c[1]));
    if (e1 > t.e0 && e0 < t.e1 && n1 > t.n0 && n0 < t.n1) out.push({ key, ...t });
  }
  return out;
}

// ---------------------------------------------------------------- the height grid
// grid: buildHeightGrid's { x0, z0, step, w, h, data }; proj: the area's projection. Overwrites the cells the lidar
// covers; returns what it did. Reads only the part of each tile under the grid (its blocks), one tile at a time.
export async function applyLidar(grid, dir, proj, log = () => {}) {
  const stats = { tiles: 0, cells: 0, covered: 0, meanAbsChange: 0, plateauShareBefore: 0, plateauShareAfter: 0 };
  if (!fs.existsSync(dir)) return stats;
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.tif')).sort();
  if (!files.length) return stats;
  const { fromFile } = await import('geotiff');
  const { w, h, step, x0, z0, data } = grid;
  stats.cells = w * h;
  const half = Math.max(0.5, step / 2);
  const done = new Uint8Array(w * h);
  const before = Float32Array.from(data);
  // each grid cell's lon/lat, once
  const lon = new Float64Array(w * h), lat = new Float64Array(w * h);
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) { const [lo, la] = proj.unproject(x0 + i * step, z0 + j * step); lon[j * w + i] = lo; lat[j * w + i] = la; }
  for (const f of files) {
    const t = parseTileName(f);
    if (!t) continue;
    const tiff = await fromFile(path.join(dir, f));
    const img = await tiff.getImage();
    const [ox, oy] = img.getOrigin(), [rx, ry] = img.getResolution(), W = img.getWidth(), H = img.getHeight();
    const nodata = img.getGDALNoData();
    // the grid cells inside this tile, and the window of the tile they need
    const cells = [];
    let c0 = Infinity, c1 = -Infinity, r0 = Infinity, r1 = -Infinity;
    for (let k = 0; k < w * h; k++) {
      if (done[k]) continue;
      const [e, n] = utm(lon[k], lat[k], t.zone);
      const col = (e - ox) / rx, row = (n - oy) / ry; // (ry is negative: rows run south)
      if (col - half < 0 || row - half < 0 || col + half > W || row + half > H) continue;
      cells.push(k, col, row);
      c0 = Math.min(c0, col - half); c1 = Math.max(c1, col + half); r0 = Math.min(r0, row - half); r1 = Math.max(r1, row + half);
    }
    if (!cells.length) { await tiff.close?.(); continue; }
    const win = [Math.max(0, Math.floor(c0)), Math.max(0, Math.floor(r0)), Math.min(W, Math.ceil(c1) + 1), Math.min(H, Math.ceil(r1) + 1)];
    const ww = win[2] - win[0];
    const [band] = await img.readRasters({ window: win, samples: [0] });
    let covered = 0;
    for (let q = 0; q < cells.length; q += 3) {
      const k = cells[q], col = cells[q + 1] - win[0], row = cells[q + 2] - win[1];
      const a0 = Math.max(0, Math.round(col - half)), a1 = Math.round(col + half), b0 = Math.max(0, Math.round(row - half)), b1 = Math.round(row + half);
      let s = 0, n = 0, all = 0;
      for (let b = b0; b < b1; b++) for (let a = a0; a < a1; a++) {
        all++;
        const v = band[b * ww + a];
        if (v === nodata || !(v > -100 && v < 2000)) continue; // (nodata, and the -3.4e38 of some files)
        s += v; n++;
      }
      if (all && n * 2 >= all) { data[k] = s / n; done[k] = 1; covered++; }
    }
    stats.tiles++; stats.covered += covered;
    log(`  lidar ${f}: ${covered} grid cells`);
    await tiff.close?.();
  }
  // what changed: the mean move, and the share of land cells sitting on a whole metre (the terrace signature)
  let moved = 0, nMoved = 0, platB = 0, platA = 0, land = 0;
  for (let k = 0; k < w * h; k++) {
    if (!done[k]) continue;
    moved += Math.abs(data[k] - before[k]); nMoved++;
    if (before[k] > 0.5) { land++; if (Math.abs(before[k] - Math.round(before[k])) < 0.02) platB++; if (Math.abs(data[k] - Math.round(data[k])) < 0.02) platA++; }
  }
  stats.meanAbsChange = nMoved ? +(moved / nMoved).toFixed(2) : 0;
  stats.plateauShareBefore = land ? +(platB / land).toFixed(3) : 0;
  stats.plateauShareAfter = land ? +(platA / land).toFixed(3) : 0;
  return stats;
}
