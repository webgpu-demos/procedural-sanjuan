// Elevation tiles -> a regular height grid in world metres.
// The AWS Terrain Tiles (Mapzen / Tilezen, "terrarium" encoding) are PNG-encoded DEMs on the Web Mercator
// XYZ grid: h = R * 256 + G + B / 256 - 32768 metres. In Puerto Rico they carry USGS 3DEP elevations on land
// and NOAA / ETOPO bathymetry offshore (the sea floor, which the compiler later replaces by the sea surface).
import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';
export { sampleGrid } from '../../src/shared/terrain.js';

const TERRARIUM = (z, x, y) => `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;
export const DEM_SOURCES = [{ id: 'terrarium', zoom: 15, url: TERRARIUM }];
// the coarse terrain of the surroundings, out to the horizon (see FAR in tools/pipeline/compile.mjs)
export const FAR_DEM = { id: 'far', zoom: 12, url: TERRARIUM };

const worldPx = (lon, lat, z) => {
  const s = 256 * 2 ** z, phi = (lat * Math.PI) / 180;
  return [((lon + 180) / 360) * s, ((1 - Math.log(Math.tan(phi) + 1 / Math.cos(phi)) / Math.PI) / 2) * s];
};

export function demTileRange({ south, west, north, east }, z) {
  const [ax, ay] = worldPx(west, north, z), [bx, by] = worldPx(east, south, z);
  return { z, x0: Math.floor(ax / 256), x1: Math.floor(bx / 256), y0: Math.floor(ay / 256), y1: Math.floor(by / 256) };
}

// A sampler over one DEM source: bilinear inside a tile, NaN where there is no data. (lon, lat) -> metres
export function demSource(dir, src) {
  const cache = new Map();
  const tile = (x, y) => {
    const key = x + '_' + y;
    if (cache.has(key)) return cache.get(key);
    const f = path.join(dir, src.id, `${src.zoom}_${x}_${y}.png`);
    let h = null;
    if (fs.existsSync(f)) {
      const png = PNG.sync.read(fs.readFileSync(f));
      h = new Float32Array(256 * 256);
      for (let i = 0; i < h.length; i++) h[i] = png.data[i * 4] * 256 + png.data[i * 4 + 1] + png.data[i * 4 + 2] / 256 - 32768;
    }
    cache.set(key, h);
    return h;
  };
  const px = (gx, gy) => {
    const t = tile(Math.floor(gx / 256), Math.floor(gy / 256));
    return t ? t[(gy & 255) * 256 + (gx & 255)] : NaN;
  };
  return (lon, lat) => {
    // pixel centres sit at +0.5
    const [fx, fy] = worldPx(lon, lat, src.zoom).map((v) => v - 0.5);
    const x = Math.floor(fx), y = Math.floor(fy), tx = fx - x, ty = fy - y;
    const a = px(x, y), b = px(x + 1, y), c = px(x, y + 1), d = px(x + 1, y + 1);
    return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
  };
}

// Builds a height grid covering [minX, maxX] x [minZ, maxZ] at `step` metres.
// Missing tiles are filled by diffusion from their neighbours.
export function buildHeightGrid(dir, proj, { minX, maxX, minZ, maxZ }, step) {
  const sample = demSource(dir, DEM_SOURCES[0]);
  const w = Math.floor((maxX - minX) / step) + 1, h = Math.floor((maxZ - minZ) / step) + 1;
  const data = new Float32Array(w * h);
  let holes = 0;
  for (let j = 0; j < h; j++)
    for (let i = 0; i < w; i++) {
      const [lon, lat] = proj.unproject(minX + i * step, minZ + j * step);
      const v = sample(lon, lat);
      if (Number.isNaN(v)) holes++;
      data[j * w + i] = v;
    }
  if (holes) fillHoles(data, w, h);
  return { x0: minX, z0: minZ, step, w, h, data, stats: { holes } };
}

function fillHoles(data, w, h) {
  const missing = [];
  for (let i = 0; i < data.length; i++) if (Number.isNaN(data[i])) missing.push(i);
  if (missing.length === data.length) { data.fill(0); return; }
  // Grow known values into the gaps, one ring of cells per pass.
  let todo = missing;
  while (todo.length) {
    const next = [], updates = [];
    for (const i of todo) {
      const x = i % w, y = (i - x) / w;
      let s = 0, n = 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        const v = data[yy * w + xx];
        if (!Number.isNaN(v)) { s += v; n++; }
      }
      if (n) updates.push([i, s / n]); else next.push(i);
    }
    for (const [i, v] of updates) data[i] = v;
    todo = next;
  }
}
