// The ground everywhere a full tile is not loaded: the rest of the island out to the horizon as a coarse mesh
// of its terrain (manifest.far, tools/pipeline/compile.mjs) under a low-resolution aerial photo, and the area
// itself under its own photo. The sea stays the sea plane's: cells below it are left out, and the coast is
// where the land dips under that plane.
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

// manifest: the area's; ground(x, z): the area's terrain height. Resolves to { mesh, setLoaded(tx, tz, on) },
// or null. Inside the area the mesh follows the area's own terrain, coarsely, under the area's aerial photo:
// it is the ground of every tile that is not loaded, and setLoaded hides it under each tile that is.
export async function buildSurroundings(base, orthoBase, manifest, proj, ground) {
  const f = manifest.far;
  if (!f) return null;
  const res = await fetch(`${base}/${f.file}`);
  if (!res.ok) return null;
  const h = new Float32Array(await res.arrayBuffer()), sea = manifest.sea ?? 0, ext = manifest.extent ?? manifest.bounds;
  const rect = { minX: f.x0, minZ: f.z0, sizeX: (f.w - 1) * f.step, sizeZ: (f.h - 1) * f.step };
  const pos = new Float32Array(f.w * f.h * 3), uv = new Float32Array(f.w * f.h * 2);
  const within = (x, z) => x >= ext.minX - 1 && x <= ext.maxX + 1 && z >= ext.minZ - 1 && z <= ext.maxZ + 1;
  for (let j = 0; j < f.h; j++) for (let i = 0; i < f.w; i++) {
    const k = j * f.w + i, x = f.x0 + i * f.step, z = f.z0 + j * f.step;
    // (inside the area, the sea cells of its terrain sink below the sea plane, as the surroundings' do)
    const y = within(x, z) ? ground(x, z) : h[k];
    pos.set([x, y < sea + 0.02 ? Math.min(y, sea - 3) : y, z], k * 3);
    uv.set([(x - rect.minX) / rect.sizeX, 1 - (z - rect.minZ) / rect.sizeZ], k * 2);
  }
  const index = [];
  for (let j = 0; j + 1 < f.h; j++) for (let i = 0; i + 1 < f.w; i++) {
    const a = j * f.w + i, b = a + 1, c = a + f.w, d = c + 1;
    if (Math.max(pos[a * 3 + 1], pos[b * 3 + 1], pos[c * 3 + 1], pos[d * 3 + 1]) < sea) continue; // open sea
    index.push(a, c, b, b, c, d);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex(index);
  g.computeVertexNormals();
  g.computeBoundingSphere();
  // one texel per tile of the area: 255 where the full tile is loaded (its own ground is drawn there)
  const tw = Math.round((ext.maxX - ext.minX) / manifest.tileSize), th = Math.round((ext.maxZ - ext.minZ) / manifest.tileSize);
  const loaded = new THREE.DataTexture(new Uint8Array(tw * th), tw, th, THREE.RedFormat);
  loaded.magFilter = loaded.minFilter = THREE.NearestFilter;
  loaded.needsUpdate = true;
  const map = await photo(orthoBase, proj, rect);
  const material = new THREE.MeshStandardMaterial({ map, color: map ? 0xffffff : 0x6b7a58, roughness: 1, metalness: 0 });
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, {
      uNight: shared.uNight, uOrtho: shared.uOrtho, uOrthoRect: shared.uOrthoRect, uOrthoOn: shared.uOrthoOn,
      uLoaded: { value: loaded }, uExtent: { value: new THREE.Vector4(ext.minX, ext.minZ, ext.maxX - ext.minX, ext.maxZ - ext.minZ) },
      uLampOn: { value: 0 }, uLampMap: shared.uLampMap, // (no lamp light here; the sampler still needs its texture)
    });
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vFarPos;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvFarPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform float uNight, uOrthoOn; uniform sampler2D uOrtho, uLoaded; uniform vec4 uOrthoRect, uExtent; varying vec3 vFarPos;`)
      .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>
        vec2 ext = (vFarPos.xz - uExtent.xy) / uExtent.zw;
        if (ext.x > 0.0 && ext.x < 1.0 && ext.y > 0.0 && ext.y < 1.0 && texture2D(uLoaded, ext).r > 0.5) discard; // a loaded tile`)
      .replace('#include <map_fragment>', `#include <map_fragment>
        vec2 ouv = (vFarPos.xz - uOrthoRect.xy) / uOrthoRect.zw;
        if (uOrthoOn > 0.5 && ouv.x > 0.0 && ouv.x < 1.0 && ouv.y > 0.0 && ouv.y < 1.0) diffuseColor.rgb = texture2D(uOrtho, vec2(ouv.x, 1.0 - ouv.y)).rgb;`)
      // at night the built-up land glows: the brighter the photo (roofs and pavement, not woods), the more lights
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        float built = smoothstep(0.42, 0.72, dot(diffuseColor.rgb, vec3(0.3, 0.59, 0.11)));
        diffuseColor.rgb *= 1.0 - 0.6 * uNight;
        totalEmissiveRadiance += built * uNight * vec3(1.0, 0.72, 0.42) * 0.22;`);
  };
  material.customProgramCacheKey = () => 'surroundings-v2';
  const mesh = new THREE.Mesh(g, material);
  mesh.name = 'surroundings';
  mesh.receiveShadow = false;
  const x0 = Math.round(ext.minX / manifest.tileSize), z0 = Math.round(ext.minZ / manifest.tileSize);
  return {
    mesh,
    setLoaded(tx, tz, on) {
      const i = tx - x0, j = tz - z0;
      if (i < 0 || j < 0 || i >= tw || j >= th) return;
      loaded.image.data[j * tw + i] = on ? 255 : 0;
      loaded.needsUpdate = true;
    },
  };
}
