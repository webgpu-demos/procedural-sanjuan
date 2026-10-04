// The surroundings beyond the area, out to the horizon: the rest of the island as a coarse mesh of its
// terrain (manifest.far, tools/pipeline/compile.mjs) under a low-resolution aerial photo. The sea stays the
// sea plane's: cells below it are left out, and the coast is where the land dips under that plane. The
// area's own extent is left open for the tiles; along its edge the mesh takes the tiles' terrain height.
import * as THREE from 'three';
import { gradePhoto } from './ortho.js';
import { shared } from './materials.js';

const PHOTO = 2048; // texture pixels along the longer side

const tileLon = (x, z) => (x / 2 ** z) * 360 - 180;
const tileLat = (y, z) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / 2 ** z))) * 180) / Math.PI;

// The photo tiles stitched into one canvas covering the rectangle (minX, minZ, sizeX, sizeZ); null without them.
async function photo(base, proj, rect) {
  const index = await fetch(`${base}/index.json`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  if (!index) return null;
  const { z, x0, x1, y0, y1 } = index, k = PHOTO / Math.max(rect.sizeX, rect.sizeZ);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(rect.sizeX * k); canvas.height = Math.round(rect.sizeZ * k);
  const g = canvas.getContext('2d');
  g.fillStyle = '#5d6b4c'; g.fillRect(0, 0, canvas.width, canvas.height);
  const jobs = [];
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++)
    jobs.push(fetch(`${base}/${z}_${x}_${y}.jpg`).then((r) => (r.ok ? r.blob() : null)).then((b) => b && createImageBitmap(b)).then((img) => {
      if (!img) return;
      const [ax, az] = proj.project(tileLon(x, z), tileLat(y, z)), [bx, bz] = proj.project(tileLon(x + 1, z), tileLat(y + 1, z));
      g.drawImage(img, (ax - rect.minX) * k, (az - rect.minZ) * k, (bx - ax) * k + 0.5, (bz - az) * k + 0.5);
    }).catch(() => {}));
  await Promise.all(jobs);
  gradePhoto(canvas);
  const t = new THREE.CanvasTexture(canvas);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// manifest: the area's; ground(x, z): the tiles' terrain height, for the seam. Resolves to a mesh, or null.
export async function buildSurroundings(base, orthoBase, manifest, proj, ground) {
  const f = manifest.far;
  if (!f) return null;
  const res = await fetch(`${base}/${f.file}`);
  if (!res.ok) return null;
  const h = new Float32Array(await res.arrayBuffer()), sea = manifest.sea ?? 0, ext = manifest.extent ?? manifest.bounds;
  const rect = { minX: f.x0, minZ: f.z0, sizeX: (f.w - 1) * f.step, sizeZ: (f.h - 1) * f.step };
  const pos = new Float32Array(f.w * f.h * 3), uv = new Float32Array(f.w * f.h * 2);
  const inside = (x, z) => x > ext.minX + 1 && x < ext.maxX - 1 && z > ext.minZ + 1 && z < ext.maxZ - 1;
  const onEdge = (x, z) => x >= ext.minX - 1 && x <= ext.maxX + 1 && z >= ext.minZ - 1 && z <= ext.maxZ + 1;
  for (let j = 0; j < f.h; j++) for (let i = 0; i < f.w; i++) {
    const k = j * f.w + i, x = f.x0 + i * f.step, z = f.z0 + j * f.step;
    // along the edge of the extent, the tiles' own height (a little below it, so the tiles always win)
    const y = onEdge(x, z) && !inside(x, z) ? ground(x, z) - 0.3 : h[k];
    pos.set([x, y, z], k * 3);
    uv.set([(x - rect.minX) / rect.sizeX, 1 - (z - rect.minZ) / rect.sizeZ], k * 2);
  }
  const index = [];
  for (let j = 0; j + 1 < f.h; j++) for (let i = 0; i + 1 < f.w; i++) {
    const a = j * f.w + i, b = a + 1, c = a + f.w, d = c + 1;
    const cx = f.x0 + (i + 0.5) * f.step, cz = f.z0 + (j + 0.5) * f.step;
    if (inside(cx, cz)) continue;                                                        // the tiles are there
    if (Math.max(pos[a * 3 + 1], pos[b * 3 + 1], pos[c * 3 + 1], pos[d * 3 + 1]) < sea) continue; // open sea
    index.push(a, c, b, b, c, d);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex(index);
  g.computeVertexNormals();
  g.computeBoundingSphere();
  const map = await photo(orthoBase, proj, rect);
  const material = new THREE.MeshStandardMaterial({ map, color: map ? 0xffffff : 0x6b7a58, roughness: 1, metalness: 0 });
  // At night the built-up land glows: the brighter the photo (roofs and pavement, not woods), the more lights.
  if (map) material.onBeforeCompile = (shader) => {
    shader.uniforms.uNight = shared.uNight;
    shader.uniforms.uLampOn = { value: 0 }; shader.uniforms.uLampMap = shared.uLampMap; // (no lamp light here; the sampler still needs its texture)
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uNight;')
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        float built = smoothstep(0.42, 0.72, dot(diffuseColor.rgb, vec3(0.3, 0.59, 0.11)));
        diffuseColor.rgb *= 1.0 - 0.6 * uNight;
        totalEmissiveRadiance += built * uNight * vec3(1.0, 0.72, 0.42) * 0.22;`);
  };
  material.customProgramCacheKey = () => 'surroundings-v1';
  const mesh = new THREE.Mesh(g, material);
  mesh.name = 'surroundings';
  mesh.receiveShadow = false;
  return mesh;
}
