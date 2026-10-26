// The label pass for synthetic training images: the same scene from the same camera, drawn once more into a render
// target with every material swapped for one that writes what the pixel is instead of its colour, then read back.
//   alpha  the class: 254 building, 253 building under a blue tarp, 252 debris, 251 vehicle, 250 a distant building
//          drawn as a plain block (not labelled; the frame says how much of it there is), 255 anything else
//   rgb    the instance: a building is (tile slot, index in the tile: 16 bits); a pile of debris its 24-bit id; a
//          vehicle (mesh slot, instance: 16 bits), each car being one instance of an instanced mesh
// Everything that is not labelled still hides what is behind it (ground, trees, props, water), so a label is
// exactly the visible part. Lines, points, sprites, the sky and transparent effects are left out of this pass.
import * as THREE from 'three';
import { TARP_GLSL } from './tarp.js';
import { shared } from '../world/materials.js';
import { TILE } from '../shared/geo.js';

export const NAMES = ['building', 'blue_tarp', 'debris', 'vehicle'];
export const A = { NONE: 255, BUILDING: 254, TARP: 253, DEBRIS: 252, VEHICLE: 251, BLOCK: 250 };

const INSTANCED_VERT = /* glsl */ `
  vec4 p = vec4(position, 1.0);
  #ifdef USE_INSTANCING
    p = instanceMatrix * p;
  #endif
  vec4 w = modelMatrix * p;`;

function facadeLabel(slot, side) {
  return new THREE.ShaderMaterial({
    uniforms: { uSlot: { value: slot } }, side, toneMapped: false, fog: false, lights: false,
    vertexShader: /* glsl */ `
      attribute vec4 aBldg; attribute vec4 aSynth; attribute float aId;
      flat varying vec4 vSynth; flat varying float vId; flat varying float vKind; varying vec3 vWPos;
      void main() {
        vSynth = aSynth; vId = aId; vKind = aBldg.z;
        vec4 w = modelMatrix * vec4(position, 1.0); vWPos = w.xyz;
        gl_Position = projectionMatrix * viewMatrix * w;
      }`,
    fragmentShader: /* glsl */ `
      uniform float uSlot;
      flat varying vec4 vSynth; flat varying float vId; flat varying float vKind; varying vec3 vWPos;
      ${TARP_GLSL}
      void main() {
        float id = floor(vId + 0.5), t = synthTarp(vWPos, vSynth, vKind);
        gl_FragColor = vec4(uSlot / 255.0, floor(id / 256.0) / 255.0, mod(id, 256.0) / 255.0, (t > 0.5 ? 253.0 : 254.0) / 255.0);
      }`,
  });
}

const debrisLabel = new THREE.ShaderMaterial({
  toneMapped: false, fog: false,
  vertexShader: /* glsl */ `
    attribute float aPile; flat varying float vPile;
    void main() { vPile = aPile; ${INSTANCED_VERT} gl_Position = projectionMatrix * viewMatrix * w; }`,
  fragmentShader: /* glsl */ `
    flat varying float vPile;
    void main() {
      float id = floor(vPile + 0.5);
      gl_FragColor = vec4(floor(id / 65536.0) / 255.0, mod(floor(id / 256.0), 256.0) / 255.0, mod(id, 256.0) / 255.0, 252.0 / 255.0);
    }`,
});

function vehicleLabel(slot) {
  return new THREE.ShaderMaterial({
    uniforms: { uSlot: { value: slot } }, toneMapped: false, fog: false, side: THREE.DoubleSide,
    vertexShader: `flat varying float vInst; void main() { vInst = float(gl_InstanceID); ${INSTANCED_VERT} gl_Position = projectionMatrix * viewMatrix * w; }`,
    fragmentShader: `uniform float uSlot; flat varying float vInst;
      void main() { float id = floor(vInst + 0.5); gl_FragColor = vec4(uSlot / 255.0, floor(id / 256.0) / 255.0, mod(id, 256.0) / 255.0, ${A.VEHICLE}.0 / 255.0); }`,
  });
}

// distant blocks (meshing.js blockMesh): as their own material draws them, hidden under the tiles loaded in full
const blockLabel = new THREE.ShaderMaterial({
  toneMapped: false, fog: false,
  uniforms: { uLoaded: shared.uLoaded, uLoadedRect: shared.uLoadedRect },
  vertexShader: `attribute vec2 aTile; varying vec2 vTile; void main() { vTile = aTile; gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(position, 1.0); }`,
  fragmentShader: `uniform sampler2D uLoaded; uniform vec4 uLoadedRect; varying vec2 vTile;
    void main() {
      if (texture2D(uLoaded, ((vTile + 0.5) * ${TILE}.0 - uLoadedRect.xy) / uLoadedRect.zw).r > 0.5) discard;
      gl_FragColor = vec4(0.0, 0.0, 0.0, ${A.BLOCK}.0 / 255.0);
    }`,
});

// the coarse ground of the surroundings (far.js): drawn only where no tile is loaded, as it is in colour
const farLabel = new THREE.ShaderMaterial({
  toneMapped: false, fog: false,
  uniforms: { uLoaded: shared.uLoaded, uLoadedRect: shared.uLoadedRect },
  vertexShader: `varying vec2 vW; void main() { vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xz; gl_Position = projectionMatrix * viewMatrix * w; }`,
  fragmentShader: `uniform sampler2D uLoaded; uniform vec4 uLoadedRect; varying vec2 vW;
    void main() {
      vec2 e = (vW - uLoadedRect.xy) / uLoadedRect.zw;
      if (e.x > 0.0 && e.x < 1.0 && e.y > 0.0 && e.y < 1.0 && texture2D(uLoaded, e).r > 0.5) discard;
      gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
    }`,
});

// anything else: black, opaque, class "none"; leaves and other cut-outs keep their cut (alphaTest and its map)
const occluders = new Map();
function occluder(m) {
  const cut = m.alphaTest > 0 && m.map ? m.map : null, side = m.side ?? THREE.FrontSide, k = `${cut?.uuid ?? ''}|${m.alphaTest}|${side}`;
  if (!occluders.has(k)) {
    const o = new THREE.MeshBasicMaterial({ color: 0x000000, map: cut, alphaTest: cut ? m.alphaTest : 0, side, fog: false, toneMapped: false });
    o.onBeforeCompile = (s) => { s.fragmentShader = s.fragmentShader.replace('#include <dithering_fragment>', 'gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);'); };
    o.customProgramCacheKey = () => 'synth-occluder';
    occluders.set(k, o);
  }
  return occluders.get(k);
}

/**
 * Draws the label pass into `rt` and reads it back. `vehicles`: the roots whose meshes are vehicles; `facades`:
 * Map(mesh -> slot) for the building meshes to label. Returns the RGBA bytes, rows from the top.
 */
export function renderLabels({ renderer, scene, camera, rt, facades, vehicles, debris }) {
  const isVehicle = new Set();
  for (const r of vehicles) r?.traverse((o) => isVehicle.add(o));
  const swaps = [], hidden = [], facadeMats = [];
  let vslot = 0;
  scene.traverseVisible((o) => {
    if (o.isLine || o.isPoints || o.isSprite || o.isSkinnedMesh || o.name === 'sky') { hidden.push(o); return; }
    if (!o.isMesh) return;
    const m = Array.isArray(o.material) ? o.material[0] : o.material;
    if (!m || m.visible === false || m.colorWrite === false) return; // (drawn as before: nothing, or depth only)
    let label;
    if (facades.has(o)) { label = facadeLabel(facades.get(o), m.side); facadeMats.push(label); }
    else if (o === debris) label = debrisLabel;
    else if (o.geometry.attributes.aTile) label = blockLabel;
    else if (o.name === 'surroundings') label = farLabel;
    else if (m.transparent && (m.blending === THREE.AdditiveBlending || m.opacity < 0.5 || m.depthWrite === false)) { hidden.push(o); return; }
    else if ((isVehicle.has(o) || o.userData.vehicle) && vslot < 255) { label = vehicleLabel(++vslot); facadeMats.push(label); } // (traffic, and parked cars: props.js)
    else label = occluder(m);
    swaps.push([o, o.material]);
    o.material = label;
  });
  for (const o of hidden) o.visible = false;
  const keep = { bg: scene.background, fog: scene.fog, target: renderer.getRenderTarget(), shadow: renderer.shadowMap.needsUpdate, color: renderer.getClearColor(new THREE.Color()), alpha: renderer.getClearAlpha(), autoClear: renderer.autoClear };
  scene.background = null; scene.fog = null;
  renderer.shadowMap.needsUpdate = false;
  renderer.setRenderTarget(rt);
  renderer.setClearColor(0x000000, 1); renderer.autoClear = true;
  renderer.clear();
  renderer.render(scene, camera);
  const W = rt.width, H = rt.height, px = new Uint8Array(W * H * 4);
  renderer.readRenderTargetPixels(rt, 0, 0, W, H, px);
  // put everything back
  renderer.setRenderTarget(keep.target);
  renderer.setClearColor(keep.color, keep.alpha); renderer.autoClear = keep.autoClear;
  renderer.shadowMap.needsUpdate = keep.shadow;
  scene.background = keep.bg; scene.fog = keep.fog;
  for (const [o, m] of swaps) o.material = m;
  for (const o of hidden) o.visible = true;
  for (const m of facadeMats) m.dispose();
  // rows from the top
  const row = W * 4, out = new Uint8Array(px.length);
  for (let y = 0; y < H; y++) out.set(px.subarray((H - 1 - y) * row, (H - y) * row), y * row);
  return out;
}

/**
 * Instances in a label image (rows from the top): boxes in pixels, pixel counts, and an id image (R = class + 1,
 * G/B = the instance's number in this frame, 1-based; 0 = nothing) for masks.
 */
export function decodeLabels(px, W, H) {
  const inst = new Map(), ids = new Uint8Array(W * H * 4);
  let block = 0, none = 0;
  const add = (key, cls, x, y) => {
    let r = inst.get(key);
    if (!r) inst.set(key, (r = { key, cls, x0: x, y0: y, x1: x, y1: y, n: 0, no: 0 }));
    if (x < r.x0) r.x0 = x; if (x > r.x1) r.x1 = x; if (y < r.y0) r.y0 = y; if (y > r.y1) r.y1 = y;
    r.n++;
    return r;
  };
  for (let y = 0, i = 0; y < H; y++) for (let x = 0; x < W; x++, i++) {
    const a = px[i * 4 + 3];
    if (a === A.NONE) { none++; continue; }
    const key = (px[i * 4] << 16) | (px[i * 4 + 1] << 8) | px[i * 4 + 2];
    if (a === A.BUILDING || a === A.TARP) {
      add('b' + key, 0, x, y);
      if (a === A.TARP) add('t' + key, 1, x, y);
    } else if (a === A.DEBRIS) add('d' + key, 2, x, y);
    else if (a === A.VEHICLE) add('v' + key, 3, x, y);
    else if (a === A.BLOCK) block++;
  }
  // number the instances; the id image (a tarp's pixels are its building's in the image: the class says tarp)
  const list = [...inst.values()];
  list.forEach((r, k) => { r.no = k + 1; });
  const byKey = new Map(list.map((r) => [r.key, r]));
  let v = 0;
  for (let i = 0; i < W * H; i++) {
    const a = px[i * 4 + 3], key = (px[i * 4] << 16) | (px[i * 4 + 1] << 8) | px[i * 4 + 2];
    const r = a === A.BUILDING ? byKey.get('b' + key) : a === A.TARP ? byKey.get('t' + key) : a === A.DEBRIS ? byKey.get('d' + key)
      : a === A.VEHICLE ? (v++, byKey.get('v' + key)) : null;
    if (r) { ids[i * 4] = r.cls + 1; ids[i * 4 + 1] = r.no >> 8; ids[i * 4 + 2] = r.no & 255; }
    ids[i * 4 + 3] = 255;
  }
  return { instances: list, ids, share: { block: block / (W * H), none: none / (W * H), vehicle: v / (W * H) } };
}
