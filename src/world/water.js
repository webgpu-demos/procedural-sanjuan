// The shore, for the water shader (materials.js): how far each point of the sea lies from land (red) and how
// open it is to the ocean swell (green), as a texture. The shallows take their turquoise from the first, the surf
// breaks along it where the second says the Atlantic reaches. Land is wherever the ground stands above the sea:
// the area's terrain grid (where the compiler flattened the sea to just under 0 m) and, beyond it, the coarse
// grid of the surroundings (far.bin). The distance is a two-pass chamfer transform.
import * as THREE from 'three';
import { shared } from './materials.js';

const STEP = 20;  // metres per texel
const MAX = 510;  // metres: the farthest distance the texture tells apart (open water beyond)

// grid: the streamer's terrain grid; manifest: the area's; base: where its files are.
export async function buildShore(grid, manifest, base) {
  const sea = manifest.sea ?? 0, f = manifest.far;
  const far = f ? await fetch(`${base}/${f.file}`).then((r) => (r.ok ? r.arrayBuffer() : null)).then((b) => b && new Float32Array(b)).catch(() => null) : null;
  // the rectangle covered: the surroundings if there are any, else the terrain grid
  const r = far
    ? { x0: f.x0, z0: f.z0, x1: f.x0 + (f.w - 1) * f.step, z1: f.z0 + (f.h - 1) * f.step }
    : { x0: grid.x0, z0: grid.z0, x1: grid.x0 + (grid.w - 1) * grid.step, z1: grid.z0 + (grid.h - 1) * grid.step };
  const W = Math.ceil((r.x1 - r.x0) / STEP), H = Math.ceil((r.z1 - r.z0) / STEP);
  const d = new Float32Array(W * H), BIG = 1e6;
  const gx1 = grid.x0 + (grid.w - 1) * grid.step, gz1 = grid.z0 + (grid.h - 1) * grid.step;
  let water = 0;
  for (let j = 0; j < H; j++) {
    const z = r.z0 + (j + 0.5) * STEP;
    for (let i = 0; i < W; i++) {
      const x = r.x0 + (i + 0.5) * STEP;
      let h;
      if (x >= grid.x0 && x <= gx1 && z >= grid.z0 && z <= gz1) h = grid.data[Math.round((z - grid.z0) / grid.step) * grid.w + Math.round((x - grid.x0) / grid.step)];
      else if (far) h = far[Math.min(f.h - 1, Math.round((z - f.z0) / f.step)) * f.w + Math.min(f.w - 1, Math.round((x - f.x0) / f.step))];
      else h = sea - 1;
      const wet = h < sea - 0.02;
      d[j * W + i] = wet ? BIG : 0;
      water += wet;
    }
  }
  if (!water) return null;
  // chamfer: forwards, then backwards (1 and the square root of 2, in texels)
  const S = Math.SQRT2;
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    const k = j * W + i;
    let v = d[k];
    if (!v) continue;
    if (i > 0) v = Math.min(v, d[k - 1] + 1);
    if (j > 0) {
      v = Math.min(v, d[k - W] + 1);
      if (i > 0) v = Math.min(v, d[k - W - 1] + S);
      if (i < W - 1) v = Math.min(v, d[k - W + 1] + S);
    }
    d[k] = v;
  }
  for (let j = H - 1; j >= 0; j--) for (let i = W - 1; i >= 0; i--) {
    const k = j * W + i;
    let v = d[k];
    if (!v) continue;
    if (i < W - 1) v = Math.min(v, d[k + 1] + 1);
    if (j < H - 1) {
      v = Math.min(v, d[k + W] + 1);
      if (i < W - 1) v = Math.min(v, d[k + W + 1] + S);
      if (i > 0) v = Math.min(v, d[k + W - 1] + S);
    }
    d[k] = v;
  }
  // Exposure: how much open water lies upwind and out to sea, north and north-east of each point (the trade-wind
  // swell comes from the Atlantic). A beach on the north shore faces the ocean; the lagoons and the bay, closed
  // off to the north by the land, lie still. Water runs on beyond the map's northern and eastern edges.
  const reach = new Float32Array(W * H), ne = new Float32Array(W * H), FAR = 4000 / STEP;
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    const k = j * W + i;
    if (!d[k]) continue;
    reach[k] = j ? reach[k - W] + 1 : FAR;
    ne[k] = j && i < W - 1 ? ne[k - W + 1] + Math.SQRT2 : FAR;
  }
  const px = new Uint8Array(W * H * 2);
  for (let k = 0; k < W * H; k++) {
    // (land is 0; the water's first texel starts half a texel out, so the coast falls between texels)
    px[k * 2] = d[k] ? Math.min(255, Math.round(((d[k] - 0.5) * STEP * 255) / MAX)) : 0;
    px[k * 2 + 1] = Math.round(255 * Math.min(1, Math.max(reach[k], ne[k]) / FAR));
  }
  const t = new THREE.DataTexture(px, W, H, THREE.RGFormat);
  t.magFilter = t.minFilter = THREE.LinearFilter;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.unpackAlignment = 1;
  t.needsUpdate = true;
  shared.uShore.value = t;
  shared.uShoreRect.value.set(r.x0, r.z0, W * STEP, H * STEP);
  return t;
}

export const SHORE_MAX = MAX;
