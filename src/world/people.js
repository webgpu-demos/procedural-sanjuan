// People on foot: the city's sidewalks, crossings, footways and plazas walked by the people who would be there at
// that hour (tools/pipeline/walkways.mjs: where, and how many, from what stands along each street), each one of
// Microsoft's Rocketbox avatars (MIT; tools/assets/crowd.py: the library's people in everyday clothes, at work in
// an office or a clinic, running, on the beach; public/models/people/README.md), with another skin tone than the
// library's where the avatar allows (most of the library is fair; San Juan is not).
//
// Drawn as two batches (THREE.BatchedMesh: one draw each, whatever the number of people): the bodies, and the hair
// and lashes (cutout). Each person is skinned on the GPU: the skeleton's pose at every frame of every clip is a
// texture (22 bones, 3 texels a bone), the clips of a person and how far into them it is are a few texels of
// another, and the vertex shader blends the two frames either side and the clip it leaves for the one it takes.
//
// What they do: walk the network, keeping right, slowing behind the one in front; at a crossing, wait for the lights
// (the simulation's, src/world/simsignals.js) and for a gap in the cars; stand at a bus stop or a shop's door, talk
// in twos and threes, sit on a bench; run along the promenades at dawn. Families walk together.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { shared } from './materials.js';
import { lampUniforms, HERO_RIM } from './lamplight.js';
import { streetAt } from '../shared/decks.js';

// ---------------------------------------------------------------- constants
const BONES = ['Bip01_Pelvis', 'Bip01_Spine', 'Bip01_Spine1', 'Bip01_Spine2', 'Bip01_Neck', 'Bip01_Head',
  ...['L', 'R'].flatMap((s) => ['Clavicle', 'UpperArm', 'Forearm', 'Hand', 'Thigh', 'Calf', 'Foot', 'Toe0'].map((b) => `Bip01_${s}_${b}`))];
const NB = BONES.length;
const MOVE = ['walk', 'walk2', 'stroll', 'brisk', 'jog'], STILL = ['idle', 'wait', 'text', 'look', 'talk', 'sit', 'call'];
const CLIPS = [...MOVE, ...STILL];
const FPS = { move: 30, still: 10 };
const POOL = 1600;                  // people at once, at most
const LOD = [24, 95];               // metres: the full body nearer than this, the plain one beyond the second
const FAR = 360;                    // nobody is drawn beyond this (a few pixels)
const W_BONES = 2048;               // the pose texture's width (texels)
// the profiles of walkways.mjs (shops, offices, sights, bars, schools, buses, homes, clinics, the beach and the
// parks): the share of its busiest hour each has at each hour of the day (0..23 h, San Juan time)
const DAY = [
  [.03, .02, .01, .01, .01, .03, .08, .2, .35, .55, .75, .9, 1, .95, .85, .85, .9, .95, .9, .75, .55, .35, .15, .06],
  [.01, .01, .01, .01, .01, .03, .15, .6, .9, .55, .45, .6, 1, .9, .5, .45, .6, .8, .45, .2, .08, .04, .02, .01],
  [.05, .03, .02, .01, .01, .02, .05, .12, .3, .55, .8, .95, 1, 1, .95, .9, .85, .8, .75, .7, .6, .45, .25, .1],
  [.6, .45, .25, .1, .03, .01, .01, .01, .01, .02, .03, .05, .1, .1, .08, .08, .1, .2, .35, .55, .75, .9, 1, .85],
  [0, 0, 0, 0, 0, 0, .1, .8, .5, .1, .1, .15, .3, .2, .2, 1, .6, .2, .05, .02, 0, 0, 0, 0],
  [.03, .01, .01, .02, .1, .35, .8, 1, .8, .45, .4, .45, .5, .5, .55, .7, .9, 1, .75, .45, .3, .2, .1, .05],
  [.05, .02, .01, .01, .03, .25, .6, .8, .5, .35, .35, .4, .45, .4, .35, .45, .7, .9, 1, .85, .6, .35, .15, .08],
  [.05, .04, .03, .03, .05, .15, .5, .9, 1, .95, .9, .85, .8, .8, .75, .7, .6, .4, .25, .15, .1, .08, .06, .05],
  [.02, .01, .01, .01, .05, .4, .9, 1, .8, .6, .6, .7, .7, .75, .75, .8, .9, 1, .9, .6, .3, .15, .06, .03],
];
const P = { SHOP: 0, OFFICE: 1, SIGHTS: 2, NIGHT: 3, SCHOOL: 4, TRANSIT: 5, HOME: 6, HEALTH: 7, LEISURE: 8 };
const KIND = { SIDEWALK: 0, CORNER: 1, CROSSING: 2, FOOTWAY: 3, PATH: 4, STEPS: 5, PEDESTRIAN: 6, ROADSIDE: 7, LINK: 8, MEDIAN: 9 };
const SPOT = { BUS: 0, BENCH: 1, FRONT: 2, BAR: 3, PLAZA: 4, SHELTER: 5 };
const dayShare = (p, h) => { const a = Math.floor(h) % 24, t = h - Math.floor(h); return DAY[p][a] * (1 - t) + DAY[p][(a + 1) % 24] * t; };
const dec = (q) => (q / 255) ** 2 * 40; // (people per 100 m, as walkways.mjs encodes them)
// the item whose running total first reaches r ([[item, total], ...])
const bisect = (cum, r) => { let lo = 0, hi = cum.length - 1; if (hi < 0) return null; while (lo < hi) { const m = (lo + hi) >> 1; if (cum[m][1] < r) lo = m + 1; else hi = m; } return cum[lo][0]; };

// skin: the tone a person is drawn with, as a CIE lightness (San Juan: most people between fair and brown)
const TONES = [[72, 0.12], [66, 0.24], [60, 0.26], [54, 0.2], [48, 0.12], [42, 0.06]];
let seed = 12345;
const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
const pick = (list) => list[Math.floor(rnd() * list.length)];
const weighted = (pairs) => { let t = 0; for (const [, w] of pairs) t += w; let r = rnd() * t; for (const [v, w] of pairs) { r -= w; if (r <= 0) return v; } return pairs[pairs.length - 1][0]; };

// ---------------------------------------------------------------- the shaders
const VERT_PARS = /* glsl */`
uniform highp sampler2D uBones;
uniform highp sampler2D uPeople;
attribute vec4 skinIndex;
attribute vec4 skinWeight;
varying vec4 vLook;
flat varying float vLayer;
vec4 personData(float id, int k) { int i = int(id) * 4 + k; int w = textureSize(uPeople, 0).x; return texelFetch(uPeople, ivec2(i % w, i / w), 0); }
mat4 poseBone(float row, float b) {
  int i = (int(row) * ${NB} + int(b)) * 3, w = textureSize(uBones, 0).x;
  vec4 r0 = texelFetch(uBones, ivec2(i % w, i / w), 0); i++;
  vec4 r1 = texelFetch(uBones, ivec2(i % w, i / w), 0); i++;
  vec4 r2 = texelFetch(uBones, ivec2(i % w, i / w), 0);
  return mat4(r0.x, r1.x, r2.x, 0.0, r0.y, r1.y, r2.y, 0.0, r0.z, r1.z, r2.z, 0.0, r0.w, r1.w, r2.w, 1.0);
}
// a clip (x: its first row, y: its frames, z: how far into it, 0..1): the bone between the frames either side
mat4 clipBone(vec4 c, float b) {
  float f = c.z * c.y, f0 = floor(f), t = f - f0, f1 = mod(f0 + 1.0, c.y);
  return poseBone(c.x + f0, b) * (1.0 - t) + poseBone(c.x + f1, b) * t;
}
mat4 personBone(vec4 a, vec4 b, float b_, float i) {
  mat4 m = clipBone(a, i);
  if (b_ > 0.002) m = m * (1.0 - b_) + clipBone(b, i) * b_;
  return m;
}`;
const VERT_SKIN = /* glsl */`
float personId = getIndirectIndex(gl_DrawID);
vec4 clipA = personData(personId, 0), clipB = personData(personId, 1);
vLook = personData(personId, 2); vLayer = clipB.w;
mat4 skinM = personBone(clipA, clipB, clipA.w, skinIndex.x) * skinWeight.x + personBone(clipA, clipB, clipA.w, skinIndex.y) * skinWeight.y
  + personBone(clipA, clipB, clipA.w, skinIndex.z) * skinWeight.z + personBone(clipA, clipB, clipA.w, skinIndex.w) * skinWeight.w;`;
const FRAG_PARS = /* glsl */`
uniform highp sampler2DArray uAtlas;
varying vec4 vLook;
flat varying float vLayer;`;
// (a person fading in or out: a dither, as the cars do)
const FADE = 'if (vLook.a < 0.999 && fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715)))) > vLook.a) discard;';

function personMaterial(cutout, textures) {
  const m = new THREE.MeshStandardMaterial({ roughness: 0.82, metalness: 0, side: cutout ? THREE.DoubleSide : THREE.FrontSide });
  m.defines = { USE_UV: '', LAMP_SIDES: '' };
  m.onBeforeCompile = (shader) => {
    lampUniforms(shader); shader.uniforms.uNight = shared.uNight;
    Object.assign(shader.uniforms, textures);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${VERT_PARS}`)
      .replace('#include <skinbase_vertex>', VERT_SKIN)
      .replace('#include <skinnormal_vertex>', 'objectNormal = (skinM * vec4(objectNormal, 0.0)).xyz;')
      .replace('#include <skinning_vertex>', 'transformed = (skinM * vec4(transformed, 1.0)).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${FRAG_PARS}\nuniform float uNight;`)
      .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>\n${FADE}`)
      // (at night a little of the city's glow along their edges, as the one you are has: a figure reads against the dark street)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>\ntotalEmissiveRadiance += 0.5 * ${HERO_RIM} + diffuseColor.rgb * 0.035 * uNight;`)
      // the atlas: skin marked in alpha (0.75) takes the person's tone; the cutout keeps its own alpha (coverage)
      .replace('#include <map_fragment>', cutout
        ? 'vec4 texel = texture(uAtlas, vec3(vUv, vLayer)); if (texel.a < 0.5) discard; diffuseColor.rgb *= texel.rgb;'
        : 'vec4 texel = texture(uAtlas, vec3(vUv, vLayer)); float skin = step(0.6, texel.a) * (1.0 - smoothstep(0.8, 0.95, texel.a));\ndiffuseColor.rgb *= texel.rgb * mix(vec3(1.0), vLook.rgb, skin);')
      // (opaque: the alpha channel marks mirrors for the reflections, src/world/reflections.js)
      .replace('#include <opaque_fragment>', '#include <opaque_fragment>\ngl_FragColor.a = 1.0;');
  };
  m.customProgramCacheKey = () => (cutout ? 'people-cut-v1' : 'people-v1');
  return m;
}
function personDepth(cutout, textures) {
  const m = new THREE.MeshDepthMaterial();
  m.defines = { USE_UV: '' };
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, textures);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${VERT_PARS}`)
      .replace('#include <skinbase_vertex>', VERT_SKIN)
      .replace('#include <skinnormal_vertex>', '')
      .replace('#include <skinning_vertex>', 'transformed = (skinM * vec4(transformed, 1.0)).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${FRAG_PARS}`)
      .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>\n${FADE}\n${cutout ? 'if (texture(uAtlas, vec3(vUv, vLayer)).a < 0.5) discard;' : ''}`);
  };
  m.customProgramCacheKey = () => (cutout ? 'people-depth-cut-v1' : 'people-depth-v1');
  return m;
}

// ---------------------------------------------------------------- the avatars
// The clips of the library's women and of its men (crowd_pack.mjs: <sex>-move.glb, <sex>-still.glb): the same
// rotations for every avatar of either; only the bones' lengths are each avatar's own (and the child's hips lower).
// Only the rotations are kept, and the pelvis's track, its travel over a walk's cycle taken out (the person is carried
// along at the clip's own pace instead) and that pace measured.
function prepareClips(move, still) {
  const V = () => new THREE.Vector3(), clips = {};
  for (const [g, moving] of [[move, true], [still, false]]) {
    g.scene.updateMatrixWorld(true);
    let pelvis = null; g.scene.traverse((o) => { if (o.name === 'Bip01_Pelvis') pelvis = o; });
    const mixer = new THREE.AnimationMixer(g.scene);
    for (const clip of g.animations) {
      clip.tracks = clip.tracks.filter((t) => t.name.endsWith('.quaternion') || t.name === 'Bip01_Pelvis.position');
      let speed = 0;
      const track = clip.tracks.find((t) => t.name === 'Bip01_Pelvis.position');
      if (moving && track && pelvis) {
        const a = mixer.clipAction(clip); a.play();
        const at = (t) => { mixer.setTime(t); g.scene.updateMatrixWorld(true); return pelvis.getWorldPosition(V()); };
        const p0 = at(0), p1 = at(clip.duration - 1e-4);
        speed = Math.hypot(p1.x - p0.x, p1.z - p0.z) / clip.duration;
        a.stop(); mixer.uncacheClip(clip);
        // (the travel, in the track's own frame: the vertical bob stays)
        const n = track.times.length, v = track.values, t0 = track.times[0], span = track.times[n - 1] - t0 || 1;
        const up = new THREE.Vector3(0, 1, 0).applyQuaternion(pelvis.parent.getWorldQuaternion(new THREE.Quaternion()).invert());
        const d = new THREE.Vector3(v[(n - 1) * 3] - v[0], v[(n - 1) * 3 + 1] - v[1], v[(n - 1) * 3 + 2] - v[2]);
        d.addScaledVector(up, -d.dot(up));
        for (let i = 0; i < n; i++) { const f = (track.times[i] - t0) / span; v[i * 3] -= d.x * f; v[i * 3 + 1] -= d.y * f; v[i * 3 + 2] -= d.z * f; }
      }
      clips[clip.name] = { clip, speed, moving };
    }
  }
  return clips;
}
// Every frame of every clip, as an avatar's 22 bones' skinning matrices (its bone's pose times its bind pose inverted),
// turned so that it faces +z: rows of 22 x 3 texels. The walks at 30 a second; standing, talking and sitting at 8, and
// a long one cut to 14 s, its last 1.5 s turning into its first (it loops without a jump).
const STILL_FPS = 8, STILL_MAX = 14, LOOP_FADE = 1.5;
function bakeAvatar(gltf, clips) {
  const scene = gltf.scene, V = () => new THREE.Vector3();
  let skinned = null; scene.traverse((o) => { if (!skinned && o.isSkinnedMesh) skinned = o; });
  const sk = skinned.skeleton, idx = BONES.map((n) => sk.bones.findIndex((b) => b.name === n));
  if (idx.some((i) => i < 0)) throw new Error('a crowd avatar without its bones');
  scene.updateMatrixWorld(true);
  const bone = (n) => sk.bones[idx[BONES.indexOf(n)]];
  const ahead = V();
  for (const s of ['L', 'R']) ahead.add(bone(`Bip01_${s}_Toe0`).getWorldPosition(V()).sub(bone(`Bip01_${s}_Foot`).getWorldPosition(V())));
  const turn = new THREE.Matrix4().makeRotationY(-Math.atan2(ahead.x, ahead.z));
  // (as three skins: the mesh's world, its bind matrix's inverse, the bone's pose times its inverse bind matrix, the
  // bind matrix; avatarGeometries puts every level's geometry in the first mesh's bind space)
  const K = new THREE.Matrix4().multiplyMatrices(skinned.matrixWorld, skinned.bindMatrixInverse).premultiply(turn), Bm = skinned.bindMatrix.clone();
  const mixer = new THREE.AnimationMixer(scene), m = new THREE.Matrix4(), rows = [], out = {};
  const pose = (t, into) => {
    mixer.setTime(t); scene.updateMatrixWorld(true);
    for (let b = 0; b < NB; b++) {
      m.multiplyMatrices(sk.bones[idx[b]].matrixWorld, sk.boneInverses[idx[b]]).premultiply(K).multiply(Bm);
      into.set(m.elements, b * 16);
    }
    return into;
  };
  const A = new Float32Array(NB * 16), B = new Float32Array(NB * 16);
  for (const name of CLIPS) {
    const c = clips[name];
    if (!c) continue;
    const fps = c.moving ? FPS.move : STILL_FPS, cut = !c.moving && c.clip.duration > STILL_MAX + LOOP_FADE;
    const T = cut ? STILL_MAX : c.clip.duration, frames = Math.max(2, Math.round(T * fps)), start = rows.length / (NB * 12);
    const action = mixer.clipAction(c.clip); action.play();
    for (let f = 0; f < frames; f++) {
      const t = (f / frames) * T + (cut ? LOOP_FADE : 0);
      pose(t, A);
      if (cut && t >= T) { pose(t - T, B); const w = (t - T) / LOOP_FADE; for (let i = 0; i < A.length; i++) A[i] = A[i] * (1 - w) + B[i] * w; }
      for (let b = 0; b < NB; b++) { const e = A.subarray(b * 16, b * 16 + 16); rows.push(e[0], e[4], e[8], e[12], e[1], e[5], e[9], e[13], e[2], e[6], e[10], e[14]); }
    }
    action.stop();
    out[name] = { start, frames, duration: T, speed: c.speed };
  }
  return { rows: Float32Array.from(rows), clips: out };
}

const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
const loadImage = (url) => fetch(url).then((r) => (r.ok ? r.blob() : Promise.reject(new Error(url)))).then((b) => createImageBitmap(b, { imageOrientation: 'none' }));

// An avatar's levels of detail as plain geometries for the batches: bind pose, the skin's joints in BONES' order.
function avatarGeometries(gltf) {
  const out = [];
  gltf.scene.updateMatrixWorld(true);
  let first = null; gltf.scene.traverse((o) => { if (!first && o.isSkinnedMesh) first = o; });
  const K0 = new THREE.Matrix4().multiplyMatrices(first.matrixWorld, first.bindMatrixInverse), B0i = first.bindMatrix.clone().invert();
  gltf.scene.traverse((o) => {
    if (!o.isSkinnedMesh) return;
    // (every level in the first mesh's bind space: the same skinning matrices serve them all)
    const K = new THREE.Matrix4().multiplyMatrices(o.matrixWorld, o.bindMatrixInverse);
    if (K.elements.some((v, i) => Math.abs(v - K0.elements[i]) > 1e-4)) console.warn('a crowd avatar whose meshes are bound apart');
    let lod = null; for (let p = o; p && lod == null; p = p.parent) { const m = /^LOD(\d)/.exec(p.name); if (m) lod = Number(m[1]); }
    if (lod == null) return;
    const map = o.skeleton.bones.map((b) => BONES.indexOf(b.name));
    if (map.some((i) => i < 0)) throw new Error(`a crowd avatar with other bones: ${o.skeleton.bones.map((b) => b.name)}`);
    const src = o.geometry, n = src.attributes.position.count, g = new THREE.BufferGeometry();
    const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3), uv = new Float32Array(n * 2), si = new Uint8Array(n * 4), sw = new Float32Array(n * 4);
    const v = new THREE.Vector3(), mat = B0i.clone().multiply(o.bindMatrix), nm = new THREE.Matrix3().getNormalMatrix(mat);
    const A = src.attributes;
    for (let i = 0; i < n; i++) {
      v.fromBufferAttribute(A.position, i).applyMatrix4(mat); pos.set([v.x, v.y, v.z], i * 3);
      v.fromBufferAttribute(A.normal, i).applyMatrix3(nm).normalize(); nor.set([v.x, v.y, v.z], i * 3);
      uv[i * 2] = A.uv.getX(i); uv[i * 2 + 1] = A.uv.getY(i);
      let t = 0; for (let c = 0; c < 4; c++) { si[i * 4 + c] = Math.max(0, map[A.skinIndex.getComponent(i, c)] ?? 0); t += (sw[i * 4 + c] = A.skinWeight.getComponent(i, c)); }
      if (t > 0) for (let c = 0; c < 4; c++) sw[i * 4 + c] /= t;
    }
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setAttribute('skinIndex', new THREE.BufferAttribute(si, 4));
    g.setAttribute('skinWeight', new THREE.BufferAttribute(sw, 4));
    const index = src.index ? Array.from(src.index.array) : Array.from({ length: n }, (_, i) => i);
    g.setIndex(new THREE.BufferAttribute(new Uint32Array(index), 1));
    // (its bounds as it stands in the street: the bind space is not metres; and an arm swung out)
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0.9, 0), 1.25);
    out.push({ lod, cutout: /cutout/.test(o.material.name), geometry: g });
  });
  return out;
}

// ---------------------------------------------------------------- the walks
// The network in blocks (walkways.mjs: walks.json, walks/<cx>_<cz>.bin), loaded round the view.
class Walks {
  constructor(base) { this.base = base; this.nodes = new Map(); this.blocks = new Map(); this.links = []; this.spots = []; this.cells = new Map(); this.meta = null; }
  async init() {
    this.meta = await fetch(`${this.base}/walks.json`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    if (!this.meta) return false;
    this.have = new Set(this.meta.blocks.map(([x, z]) => `${x}_${z}`));
    return true;
  }
  // the blocks within `r` of (x, z): loaded (as they arrive); those beyond `drop` let go
  update(x, z, r = 900, drop = 2600) {
    const C = this.meta.chunk;
    for (let i = Math.floor((x - r) / C); i <= Math.floor((x + r) / C); i++) for (let j = Math.floor((z - r) / C); j <= Math.floor((z + r) / C); j++) {
      const k = `${i}_${j}`;
      if (!this.have.has(k) || this.blocks.has(k)) continue;
      this.blocks.set(k, 'loading');
      fetch(`${this.base}/walks/${k}.bin`).then((r) => r.arrayBuffer()).then((b) => this.add(k, b)).catch(() => this.blocks.delete(k));
    }
    for (const [k, b] of this.blocks) {
      if (b === 'loading') continue;
      const [i, j] = k.split('_').map(Number);
      if (Math.hypot((i + 0.5) * C - x, (j + 0.5) * C - z) > drop) this.remove(k);
    }
  }
  add(key, buf) {
    if (this.blocks.get(key) !== 'loading') return;
    let o = 24;
    const h = new Uint32Array(buf, 0, 6), [, nN, nL, nI, nC, nS] = h;
    const take = (T, n) => { const a = new T(buf, o, n); o += a.byteLength; o += (4 - (o % 4)) % 4; return a; };
    const ids = take(Uint32Array, nN), xz = take(Float32Array, nN * 2);
    const la = take(Uint32Array, nL), lb = take(Uint32Array, nL), inner = take(Uint8Array, nL), kind = take(Uint8Array, nL), width = take(Uint8Array, nL), w = take(Uint8Array, nL * 9);
    const pts = take(Float32Array, nI * 2), cl = take(Uint32Array, nC), ce = take(Int32Array, nC), cn = take(Int32Array, nC), cf = take(Uint8Array, nC);
    const sxz = take(Float32Array, nS * 2), sk = take(Uint8Array, nS), sh = take(Uint8Array, nS), sl = take(Uint32Array, nS), sw = take(Uint8Array, nS * 9);
    const block = { links: [], spots: [] };
    for (let i = 0; i < nN; i++) {
      let n = this.nodes.get(ids[i]);
      if (!n) this.nodes.set(ids[i], n = { id: ids[i], x: xz[i * 2], z: xz[i * 2 + 1], links: [], refs: 0 });
      n.refs++;
    }
    let pc = 0;
    for (let i = 0; i < nL; i++) {
      const a = this.nodes.get(la[i]), b = this.nodes.get(lb[i]), line = [a.x, a.z];
      for (let q = 0; q < inner[i]; q++) line.push(pts[(pc + q) * 2], pts[(pc + q) * 2 + 1]);
      pc += inner[i];
      line.push(b.x, b.z);
      const cum = [0];
      for (let q = 2; q < line.length; q += 2) cum.push(cum[cum.length - 1] + Math.hypot(line[q] - line[q - 2], line[q + 1] - line[q - 1]));
      const l = { a, b, pts: line, cum, len: cum[cum.length - 1], kind: kind[i], width: width[i] / 10, w: Array.from(w.subarray(i * 9, i * 9 + 9), dec), cross: null, block: key, rate: 0, people: [] };
      a.links.push(l); b.links.push(l); block.links.push(l);
    }
    for (let c = 0; c < nC; c++) block.links[cl[c]].cross = { edge: ce[c], node: cn[c], lights: cf[c] & 1 };
    for (let s = 0; s < nS; s++) block.spots.push({ x: sxz[s * 2], z: sxz[s * 2 + 1], kind: sk[s], heading: (sh[s] / 256) * Math.PI * 2, link: block.links[sl[s]], w: Array.from(sw.subarray(s * 9, s * 9 + 9), dec), busy: 0 });
    block.nodeIds = ids;
    this.blocks.set(key, block);
    this.rebuild();
  }
  remove(key) {
    const block = this.blocks.get(key);
    this.blocks.delete(key);
    for (const l of block.links) { l.dead = true; l.a.links = l.a.links.filter((q) => q !== l); l.b.links = l.b.links.filter((q) => q !== l); }
    for (const id of block.nodeIds) { const n = this.nodes.get(id); if (n && --n.refs <= 0) this.nodes.delete(id); }
    this.rebuild();
  }
  rebuild() {
    this.links = []; this.spots = []; this.cells.clear();
    for (const b of this.blocks.values()) if (b !== 'loading') { this.links.push(...b.links); this.spots.push(...b.spots); }
    for (const l of this.links) { const m = Math.floor(l.pts.length / 4) * 2, k = Math.floor(l.pts[m] / 64) + ',' + Math.floor(l.pts[m + 1] / 64); if (!this.cells.has(k)) this.cells.set(k, []); this.cells.get(k).push(l); }
    this.version = (this.version ?? 0) + 1;
  }
  // links with their middle within r of (x, z)
  near(x, z, r) {
    const out = [];
    for (let i = Math.floor((x - r) / 64); i <= Math.floor((x + r) / 64); i++) for (let j = Math.floor((z - r) / 64); j <= Math.floor((z + r) / 64); j++)
      for (const l of this.cells.get(i + ',' + j) ?? []) { const m = Math.floor(l.pts.length / 4) * 2; if (Math.hypot(l.pts[m] - x, l.pts[m + 1] - z) <= r) out.push(l); }
    return out;
  }
}
// a point along a link at distance u from its start: [x, z, dx, dz]
function pointOn(l, u, out) {
  const c = l.cum, p = l.pts;
  let k = 1;
  while (k < c.length - 1 && c[k] < u) k++;
  const seg = c[k] - c[k - 1] || 1, t = Math.max(0, Math.min(1, (u - c[k - 1]) / seg));
  const ax = p[(k - 1) * 2], az = p[(k - 1) * 2 + 1], bx = p[k * 2], bz = p[k * 2 + 1];
  out[0] = ax + (bx - ax) * t; out[1] = az + (bz - az) * t; out[2] = (bx - ax) / seg; out[3] = (bz - az) / seg;
  return out;
}

// ---------------------------------------------------------------- the crowd
export class People {
  // base: the area's tiles; surface, lift: the streets' heights (streamer); models: the avatars' folder
  static async load({ base, models = 'models/people/crowd', surface, lift, renderer }) {
    const walks = new Walks(base);
    const [ok, manifest] = await Promise.all([walks.init(), fetch(`${models}/people.json`).then((r) => (r.ok ? r.json() : null)).catch(() => null)]);
    if (!ok || !manifest) return null;
    const p = new People(walks, manifest, models, surface, lift, renderer);
    await p.loadAssets();
    return p;
  }
  constructor(walks, manifest, models, surface, lift, renderer) {
    Object.assign(this, { walks, manifest, models, surface, lift, renderer });
    this.group = new THREE.Group(); this.group.name = 'people';
    this.people = []; this.free = Array.from({ length: POOL }, (_, i) => POOL - 1 - i);
    this.density = 1; this.enabled = true; this.ready = false;
    this.stats = { people: 0, drawn: 0, target: 0 };
    this.cars = []; this.signals = null; this.T = 0;
    this.v = [0, 0, 0, 0];
  }
  async loadAssets() {
    const M = this.manifest, base = this.models;
    // the clips of each sex
    const sexes = new Map(await Promise.all(M.groups.map(async (g) => {
      const [move, still] = await Promise.all([loader.loadAsync(`${base}/${g.move}`), loader.loadAsync(`${base}/${g.still}`)]);
      return [g.id, prepareClips(move, still)];
    })));
    // each person's clips and look (4 texels a person)
    const rowsOf = Math.ceil((POOL * 4) / 1024);
    this.data = new Float32Array(1024 * rowsOf * 4);
    const people = new THREE.DataTexture(this.data, 1024, rowsOf, THREE.RGBAFormat, THREE.FloatType);
    people.needsUpdate = true; this.dataTexture = people;
    // the atlases, one layer each
    const avatars = M.avatars, images = await Promise.all(avatars.map((a) => loadImage(`${base}/${a.id}.webp`).catch(() => null)));
    const AW = 768, AH = 512, layers = new Uint8Array(AW * AH * 4 * avatars.length);
    const canvas = new OffscreenCanvas(AW, AH), ctx = canvas.getContext('2d', { willReadFrequently: true });
    // (drawn through a canvas: where alpha is below 1, the skin's mark, the colour loses a little precision)
    images.forEach((im, i) => { if (!im) return; ctx.clearRect(0, 0, AW, AH); ctx.drawImage(im, 0, 0, AW, AH); layers.set(ctx.getImageData(0, 0, AW, AH).data, i * AW * AH * 4); });
    const atlas = new THREE.DataArrayTexture(layers, AW, AH, avatars.length);
    Object.assign(atlas, { colorSpace: THREE.SRGBColorSpace, generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter, anisotropy: 4, flipY: false });
    atlas.needsUpdate = true;
    const textures = { uBones: { value: null }, uPeople: { value: people }, uAtlas: { value: atlas } };
    // the two batches
    const tris = avatars.reduce((s, a) => s + a.triangles.LOD0 + a.triangles.LOD1 + a.triangles.LOD2, 0);
    this.body = new THREE.BatchedMesh(POOL, Math.ceil(tris * 1.3), tris * 3 + 3000, personMaterial(false, textures));
    this.hair = new THREE.BatchedMesh(POOL, Math.ceil(tris * 0.5), Math.ceil(tris * 1.2), personMaterial(true, textures));
    for (const [bm, cut] of [[this.body, false], [this.hair, true]]) {
      bm.customDepthMaterial = personDepth(cut, textures);
      bm.castShadow = true; bm.receiveShadow = true; bm.frustumCulled = false; bm.sortObjects = !cut;
      bm.name = cut ? 'people hair' : 'people';
      this.group.add(bm);
    }
    // the avatars: their bodies into the batches, their clips into the pose texture
    this.avatars = avatars.map((a, i) => ({ ...a, layer: i, geo: null, base: a.skin?.[0] ?? 66 }));
    const chunks = [];
    let rowsSoFar = 0;
    await Promise.all(this.avatars.map(async (a) => {
      const gltf = await loader.loadAsync(`${base}/${a.id}.glb`).catch((e) => { console.warn('crowd avatar', a.id, e); return null; });
      if (!gltf) return;
      a.gltf = gltf;
    }));
    for (const a of this.avatars) {
      if (!a.gltf) continue;
      try {
        const baked = bakeAvatar(a.gltf, sexes.get(a.group)), offset = rowsSoFar / (NB * 12);
        for (const c of Object.values(baked.clips)) c.start += offset;
        chunks.push(baked.rows); rowsSoFar += baked.rows.length;
        a.clips = baked.clips;
        a.geo = [0, 1, 2].map((lod) => ({ body: null, hair: null, lod }));
        for (const { lod, cutout, geometry } of avatarGeometries(a.gltf)) a.geo[lod][cutout ? 'hair' : 'body'] = (cutout ? this.hair : this.body).addGeometry(geometry);
        if (a.geo.some((g) => g.body == null)) a.geo = null;
      } catch (e) { console.warn('crowd avatar', a.id, e.message); a.geo = null; }
      a.gltf = null;
    }
    this.avatars = this.avatars.filter((a) => a.geo);
    const H = Math.ceil(rowsSoFar / 4 / W_BONES), data = new Uint16Array(W_BONES * H * 4);
    let at = 0;
    for (const c of chunks) for (let i = 0; i < c.length; i++) data[at++] = THREE.DataUtils.toHalfFloat(c[i]);
    const bones = new THREE.DataTexture(data, W_BONES, H, THREE.RGBAFormat, THREE.HalfFloatType);
    bones.needsUpdate = true;
    textures.uBones.value = bones;
    if (!this.avatars.length) return;
    // the pool: every slot an instance in both batches, hidden until someone takes it
    const g0 = this.avatars[0].geo, h0 = this.avatars.find((a) => a.geo[1].hair != null)?.geo[1].hair;
    for (let i = 0; i < POOL; i++) {
      this.body.addInstance(g0[2].body); this.body.setVisibleAt(i, false);
      if (h0 != null) { this.hair.addInstance(h0); this.hair.setVisibleAt(i, false); }
    }
    this.hasHair = h0 != null;
    this.byRole = new Map();
    for (const a of this.avatars) for (const r of a.roles) { if (!this.byRole.has(r)) this.byRole.set(r, []); this.byRole.get(r).push(a); }
    this.ready = true;
  }

  // ---------------------------------------------------------------- who, where
  rateOf(l, h) { let r = 0; for (let p = 0; p < 9; p++) if (l.w[p]) r += l.w[p] * dayShare(p, h); return r; }
  spotRate(s, h) { let r = 0; for (let p = 0; p < 9; p++) if (s.w[p]) r += s.w[p] * dayShare(p, h); return r; }
  // the kind of person for a place at an hour (from what brings people there)
  roleFor(w, h) {
    const share = (p) => w[p] * dayShare(p, h), all = w.reduce((s, _, p) => s + share(p), 0) || 1;
    const dawnOrDusk = (h >= 5 && h < 8.5) || (h >= 16.5 && h < 19.5), day = h >= 9 && h < 17.5;
    return weighted([
      ['everyday', 1],
      ['office', 1.6 * share(P.OFFICE) / all],
      ['clinic', share(P.HEALTH) / all > 0.25 ? 0.8 * share(P.HEALTH) / all : 0], // (near a hospital or a clinic, not across town)
      ['work', 0.03],
      ['running', (dawnOrDusk ? 0.3 : 0.03) * (0.05 + share(P.LEISURE) / all) + (dawnOrDusk ? 0.01 : 0)],
      ['beach', day && share(P.LEISURE) / all > 0.5 ? 0.5 : 0],
    ]);
  }
  // (each by its weight: dressed for the heat more often than for an air-conditioned office)
  avatarFor(role) { const list = this.byRole.get(role) ?? this.byRole.get('everyday'); return weighted(list.map((a) => [a, a.weight ?? 1])); }
  toneFor(a, w, h) {
    // fair-skinned avatars take a tone of San Juan's (tourists in the old city and the Condado more often stay fair)
    if (!a.tint) return [1, 1, 1];
    const sights = w ? (w[P.SIGHTS] * dayShare(P.SIGHTS, h)) / (this.rateOf({ w }, h) || 1) : 0;
    let L = weighted(TONES.map(([l, p], i) => [l, i === 0 ? p + sights * 0.5 : p]));
    if (a.fairHair) L = Math.max(L, 58); // (fair hair over a much darker face reads as a dye job on every head)
    if (L >= a.base) return [1, 1, 1];
    // (linear light: the same factor on the three keeps the skin's own warm hue; a touch warmer as it darkens)
    const k = ((L + 16) / (a.base + 16)) ** 3;
    return [k, k, k ** 1.06];
  }

  spawnWalker(l, u, now, fill) {
    const h = this.hour, dawnOrDusk = (h >= 5 && h < 8.5) || (h >= 16.5 && h < 19.5);
    const role = (l.kind === KIND.PATH || l.kind === KIND.FOOTWAY) && dawnOrDusk && rnd() < 0.12 ? 'running' : this.roleFor(l.w, h);
    // with company: a couple, friends, a grown-up and a child (in the morning to school, and later)
    // (school days: children with a grown-up on the way to school and back, few while school is in, more where
    // visitors are, families)
    const inSchool = h >= 8.3 && h < 14.2, sightsShare = (l.w[P.SIGHTS] * dayShare(P.SIGHTS, h)) / (this.rateOf(l, h) || 1);
    const kids = this.byRole.get('child') && role === 'everyday' && rnd() < (inSchool ? 0.01 + 0.04 * sightsShare : 0.04 + 0.12 * dayShare(P.SCHOOL, h));
    const company = role === 'running' || role === 'work' ? 0 : kids ? 1 : rnd() < 0.18 ? (rnd() < 0.8 ? 1 : 2) : 0;
    const dir = rnd() < 0.5 ? 1 : -1, leader = this.person(role, l.w);
    if (!leader) return 0;
    const pace = role === 'running' ? 'jog' : role === 'office' ? weighted([['brisk', 2], ['walk', 1], ['walk2', 1]]) : l.w[P.SIGHTS] > 4 ? weighted([['stroll', 2], ['walk', 1], ['walk2', 1]]) : weighted([['walk', 2], ['walk2', 2], ['stroll', 1], ['brisk', 1]]);
    Object.assign(leader, { state: 'walk', link: l, dir, u: dir > 0 ? u : l.len - u, pace, goal: rnd() * Math.PI * 2, born: now, fade: fill ? 1 : 0, lane: 0.25 + rnd() * 0.7 });
    leader.lanePref = leader.lane;
    this.setPace(leader);
    leader.v = leader.speed;
    this.place(leader, 0);
    leader.heading = leader.headingTo;
    let n = 1;
    for (let k = 0; k < company; k++) {
      const f = this.person(kids && k === 0 ? 'child' : role, l.w);
      if (!f) break;
      Object.assign(f, { state: 'follow', leader, rank: k + 1, link: l, dir, u: leader.u, pace: leader.pace, born: now, fade: leader.fade, x: leader.x, z: leader.z, heading: leader.heading, clipA: leader.clipA, cycle: leader.cycle, phase: (leader.phase + 0.5) % 1 });
      leader.followers = (leader.followers ?? []).concat(f);
      n++;
    }
    return n;
  }
  person(role, w) {
    if (!this.free.length) return null;
    const a = this.avatarFor(role === 'child' ? 'child' : role);
    if (!a) return null;
    const p = { slot: this.free.pop(), avatar: a, role, clips: a.clips, tone: this.toneFor(a, w, this.hour), scale: role === 'child' ? 1 : 0.95 + rnd() * 0.09,
      x: 0, y: null, z: 0, heading: 0, lat: 0, speed: 0, v: 0, phase: rnd(), clipA: 'idle', clipB: null, phaseB: 0, blend: 0, fade: 0, out: false, lod: -1 };
    this.people.push(p);
    return p;
  }
  setPace(p) {
    const c = p.clips[p.pace] ?? p.clips.walk;
    p.clipA = c === p.clips[p.pace] ? p.pace : 'walk';
    // (the clip's own pace, a little either side; in the heat of the day a little slower)
    p.speed = (c.speed || 1.3) * (0.92 + rnd() * 0.14) * (p.role === 'running' ? 1 : this.hour > 11 && this.hour < 16 ? 0.94 : 1);
    p.cycle = (c.speed || 1.3) * c.duration; // (metres the clip covers in one play)
  }
  spawnStill(s, now, fill) {
    const h = this.hour, kind = s.kind;
    const n = kind === SPOT.BUS ? 1 + Math.floor(rnd() * 3) : kind === SPOT.SHELTER ? 1 + Math.floor(rnd() * 2) : kind === SPOT.BENCH ? 1 + (rnd() < 0.3 ? 1 : 0) : 2 + (rnd() < 0.35 ? 1 : 0);
    const role = kind === SPOT.FRONT && rnd() < 0.08 ? 'security' : this.roleFor(s.w, h);
    let made = 0;
    for (let k = 0; k < n; k++) {
      const p = this.person(k === 0 && role === 'security' ? 'security' : role === 'running' || role === 'beach' ? 'everyday' : role, s.w);
      if (!p) break;
      let ox = 0, oz = 0, heading = s.heading, clip;
      if (kind === SPOT.BENCH || kind === SPOT.SHELTER) {
        // along the seat, facing out
        const along = (k - (n - 1) / 2) * 0.65, c = Math.cos(s.heading), si = Math.sin(s.heading);
        ox = c * along + si * 0.12; oz = -si * along + c * 0.12; clip = 'sit';
      } else if (kind === SPOT.BUS) {
        const along = (k - (n - 1) / 2) * 1.1 + (rnd() - 0.5) * 0.4, c = Math.cos(s.heading), si = Math.sin(s.heading);
        ox = c * along; oz = -si * along; heading += (rnd() - 0.5) * 1.2; clip = weighted([['wait', 3], ['text', 2], ['idle', 2], ['look', 1], ['call', 1]]);
      } else {
        // a few standing round, facing in, talking
        const a = (k / n) * Math.PI * 2 + rnd() * 0.5, r = 0.55 + rnd() * 0.15;
        ox = Math.sin(a) * r; oz = Math.cos(a) * r; heading = a + Math.PI; clip = role === 'security' && k === 0 ? 'wait' : weighted([['talk', 3], ['idle', 1], ['text', 1], ['call', 0.5]]);
        if (role === 'security' && k === 0) { ox = oz = 0; heading = s.heading; }
      }
      if (!p.clips[clip]) clip = 'idle';
      Object.assign(p, { state: 'still', spot: s, x: s.x + ox, z: s.z + oz, heading, clipA: clip, phase: rnd(), until: now + 40 + rnd() * 240, born: now, fade: fill ? 1 : 0, link: s.link });
      made++;
    }
    if (made) s.busy++;
    return made;
  }

  // ---------------------------------------------------------------- the crossings
  // safe to step out: the crossing's lights (where the simulation has them) and no car coming within the time it
  // takes to cross
  canCross(p, l) {
    const c = l.cross;
    if (c && c.lights && this.signals && c.node >= 0) {
      const st = this.signals.approach(c.edge, c.node, this.T);
      if (st === 'g' || st === 'y') return false;
    }
    const ax = l.pts[0], az = l.pts[1], bx = l.pts[l.pts.length - 2], bz = l.pts[l.pts.length - 1], mx = (ax + bx) / 2, mz = (az + bz) / 2;
    const time = l.len / Math.max(0.8, p.speed) + 1.5;
    const C = this.cars;
    for (let i = 0; i < C.length; i += 4) {
      const dx = C[i] - mx, dz = C[i + 1] - mz, v = C[i + 3];
      if (dx * dx + dz * dz > (15 + v * time) ** 2) continue;
      const vx = Math.sin(C[i + 2]) * v, vz = Math.cos(C[i + 2]) * v;
      for (let t = 0; t <= time; t += 0.5) {
        const x = C[i] + vx * t, z = C[i + 1] + vz * t;
        // (distance from the crossing's line)
        const ex = bx - ax, ez = bz - az, L2 = ex * ex + ez * ez || 1, s = Math.max(0, Math.min(1, ((x - ax) * ex + (z - az) * ez) / L2));
        if (Math.hypot(ax + ex * s - x, az + ez * s - z) < 3.2) return false;
      }
    }
    return true;
  }

  // the next link from a node: away from where it came, the way it was heading more likely, busier ways more
  // likely, a crossing now and then
  nextLink(p, node, from) {
    const opts = [];
    let dx = 0, dz = 0;
    if (from) { const e = pointOn(from, p.dir > 0 ? from.len : 0, this.v); dx = e[2] * p.dir; dz = e[3] * p.dir; }
    const gx = Math.sin(p.goal), gz = Math.cos(p.goal);
    for (const l of node.links) {
      if (l === from || l.dead) continue;
      const out = l.a === node ? 1 : -1, e = pointOn(l, out > 0 ? Math.min(3, l.len) : Math.max(0, l.len - 3), this.v);
      const ox = (e[0] - node.x), oz = (e[1] - node.z), ol = Math.hypot(ox, oz) || 1;
      const straight = from ? (ox * dx + oz * dz) / ol : 0, toward = (ox * gx + oz * gz) / ol;
      let w = (0.15 + Math.min(6, this.rateOf(l, this.hour))) * Math.exp(1.4 * toward + 0.8 * straight);
      if (l.kind === KIND.CROSSING) w *= from?.kind === KIND.MEDIAN ? 4 : p.role === 'running' ? 0.15 : 0.45;
      if (l.kind === KIND.MEDIAN) w *= from?.kind === KIND.CROSSING ? 0.5 : 0.02;
      if (p.role === 'running' && (l.kind === KIND.STEPS)) w *= 0.05;
      opts.push([[l, out], w]);
    }
    if (!opts.length) return from && !from.dead ? [from, from.a === node ? 1 : -1] : null;
    return weighted(opts);
  }

  // ---------------------------------------------------------------- each frame
  // view: { camera, focus (what is looked at), hour, T (seconds of the day), cars: [x, z, heading, speed, ...],
  // signals (SimSignals or null), detail (the governor's share), player: { x, z } or null }
  update(dt, view) {
    if (!this.ready) return;
    const { camera } = view, now = (this.now = (this.now ?? 0) + dt);
    this.hour = view.hour; this.T = view.T; this.cars = view.cars ?? []; this.signals = view.signals ?? null; this.player = view.player ?? null;
    const eye = camera.position, ground = this.surface(eye.x, eye.z), up = Math.max(0, eye.y - ground);
    // where people are kept: round what the view looks at, from street level out to a few hundred metres up
    const on = this.enabled && up < 320; // (from higher a person is a pixel or less)
    if (this.frozen) { this.draw(dt, camera, eye, new THREE.Vector3()); return; }
    // (what is looked at: the controls' target, or in a directed shot where the view meets the ground)
    let fx, fz;
    if (view.focus) { fx = view.focus.x; fz = view.focus.z; }
    else { const d = camera.getWorldDirection(new THREE.Vector3()), t = Math.min(600, Math.max(20, up / Math.max(0.05, -d.y))); fx = eye.x + d.x * t; fz = eye.z + d.z * t; }
    const cx = up < 60 ? eye.x * 0.6 + fx * 0.4 : fx, cz = up < 60 ? eye.z * 0.6 + fz * 0.4 : fz;
    const R = Math.min(FAR, 170 + up * 0.9) * (0.6 + 0.4 * (view.detail ?? 1));
    if (on) this.walks.update(cx, cz, R + 600);
    const jumped = this.last && Math.hypot(this.last[0] - cx, this.last[1] - cz) > 120; // (a cut, a teleport)
    this.last = [cx, cz];

    // how many there should be: every 1 s (or after a jump), the links round about and their people at this hour
    if (on && (jumped || !this.census || now - this.census.at > 1 || this.census.version !== this.walks.version)) {
      const links = this.walks.near(cx, cz, R), spots = this.walks.spots.filter((s) => Math.hypot(s.x - cx, s.z - cz) < R);
      let total = 0;
      const cum = [];
      for (const l of links) { if (l.kind === KIND.CROSSING) continue; l.rate = this.rateOf(l, this.hour); const n = (l.rate * l.len) / 100; total += n; cum.push([l, total]); }
      let stills = 0;
      const scum = [];
      for (const s of spots) { const n = Math.min(1.5, this.spotRate(s, this.hour) * 0.15); stills += n; scum.push([s, stills]); }
      this.census = { at: now, links, cum, total, spots, scum, stills, version: this.walks.version };
    }
    const scale = this.density * (0.5 + 0.5 * (view.detail ?? 1));
    const want = on && this.census ? Math.min(POOL - 40, (this.census.total + this.census.stills * 2) * scale) : 0;
    this.stats.target = Math.round(want);
    // fewer than wanted: some come (all at once after a cut: the street is full when the picture comes)
    // (after a cut, at the start, and while the walks round about arrive: the street is full when it is first seen)
    if (this.walks.version !== this.seenVersion) { this.seenVersion = this.walks.version; this.fillUntil = now + 1.5; }
    if (on && this.census?.total > 0) {
      const fill = jumped || !this.filled || now < this.fillUntil;
      let budget = fill ? 400 : 6;
      while (this.people.length < want && budget-- > 0 && this.free.length > 3) {
        const stillShare = this.census.stills * 2 / ((this.census.total + this.census.stills * 2) || 1);
        if (rnd() < stillShare && this.census.scum.length) {
          const s = bisect(this.census.scum, rnd() * this.census.stills);
          if (s && s.busy < 1 && this.spawnOk(s.x, s.z, eye, fill)) this.spawnStill(s, now, fill);
        } else {
          const l = bisect(this.census.cum, rnd() * this.census.total);
          if (!l) break;
          const u = rnd() * l.len, e = pointOn(l, u, this.v);
          if (this.spawnOk(e[0], e[1], eye, fill)) this.spawnWalker(l, u, now, fill);
        }
      }
      this.filled = true;
    }
    if (!on) this.filled = false;

    // each one: on, faded out, gone
    const camDir = new THREE.Vector3(); camera.getWorldDirection(camDir);
    for (let i = this.people.length - 1; i >= 0; i--) {
      const p = this.people[i], d = Math.hypot(p.x - cx, p.z - cz);
      const leave = !on || d > R * 1.25 || p.link?.dead || (p.leader && p.leader.gone) || (this.people.length > want * 1.15 + 20 && d > R * 0.8 && !p.leader);
      if (leave) p.out = true;
      p.fade = Math.max(0, Math.min(1, p.fade + (p.out ? -dt : dt) / 0.6));
      if (p.out && (p.fade <= 0 || !on)) { this.release(p); this.people.splice(i, 1); continue; }
      if (p.state === 'walk' || p.state === 'wait' || p.state === 'cross') this.walk(p, dt, now);
      else if (p.state === 'still' && now > p.until) this.leaveSpot(p, now);
    }
    for (const p of this.people) if (p.state === 'follow') this.follow(p, dt);
    // the ones in each lane: who is in front of whom (each 1/4 s), and a slower one ahead slows those behind
    this.queues(dt);
    this.draw(dt, camera, eye, camDir);
    this.stats.people = this.people.length;
  }
  spawnOk(x, z, eye, fill) {
    if (fill) return true;
    // (not out of nothing in plain view, close by)
    const d = Math.hypot(x - eye.x, z - eye.z);
    return d > 70 || !this.inView(x, z);
  }
  inView(x, z) {
    const cam = this.camera; if (!cam) return false;
    const v = new THREE.Vector3(x, this.surface(x, z) + 1, z).project(cam);
    return v.z < 1 && Math.abs(v.x) < 1.1 && Math.abs(v.y) < 1.1;
  }
  release(p) {
    p.gone = true;
    this.free.push(p.slot);
    this.body.setVisibleAt(p.slot, false);
    if (this.hasHair) this.hair.setVisibleAt(p.slot, false);
    if (p.spot) p.spot.busy = Math.max(0, p.spot.busy - 0.34);
    if (p.followers) for (const f of p.followers) f.out = true;
  }
  leaveSpot(p, now) {
    // off along the sidewalk the spot is on, or (out of sight) gone
    const l = p.spot?.link;
    if (!l || l.dead || p.clipA === 'sit' && rnd() < 0.5) { p.until = now + 30 + rnd() * 120; return; }
    let best = 0, bu = 0;
    for (let k = 0; k <= 20; k++) { const u = (k / 20) * l.len, e = pointOn(l, u, this.v), d = Math.hypot(e[0] - p.x, e[1] - p.z); if (k === 0 || d < best) { best = d; bu = u; } }
    p.spot.busy = Math.max(0, p.spot.busy - 0.34); p.spot = null;
    p.dir = rnd() < 0.5 ? 1 : -1; p.link = l; p.u = p.dir > 0 ? bu : l.len - bu; p.state = 'walk'; p.goal = rnd() * Math.PI * 2;
    p.pace = weighted([['walk', 2], ['walk2', 2], ['stroll', 1]]); this.switchClip(p, null); this.setPace(p);
  }
  switchClip(p, clip) {
    const next = clip ?? p.pace;
    if (next === p.clipA) return;
    p.clipB = p.clipA; p.phaseB = p.phase; p.blend = 1; p.clipA = next; p.phase = rnd() * (STILL.includes(next) ? 1 : 0) || p.phase;
  }
  walk(p, dt, now) {
    let l = p.link;
    if (!l || l.dead) { p.out = true; return; }
    if (p.state === 'wait') {
      p.v = 0;
      if ((now - (p.check ?? 0)) > 0.25) {
        p.check = now;
        const go = this.canCross(p, p.next[0]) || now - p.waitFrom > 75;
        if (go) { this.enter(p, p.next[0], p.next[1]); p.state = 'cross'; this.switchClip(p, null); }
      }
    } else {
      // pace: its own, or the one in front's when close
      let target = p.speed;
      if (p.ahead) { const gap = p.ahead.gap - 0.9; target = Math.min(target, Math.max(0, gap) * 1.2, gap < 1.6 ? p.ahead.p.v + 0.1 : target); }
      // the one you are (walking, cycling): stepped round, not walked through
      const pl = this.player;
      if (pl) {
        const dx = pl.x - p.x, dz = pl.z - p.z, d = Math.hypot(dx, dz), hs = Math.sin(p.heading), hc = Math.cos(p.heading);
        if (d < 2.4 && dx * hs + dz * hc > 0) { p.lane = -dx * hc + dz * hs > 0 ? -0.8 : 1; target = Math.min(target, Math.max(0.25, (d - 0.7) * 0.8)); }
      }
      p.v += (target - p.v) * Math.min(1, dt * 3);
      p.u += p.v * dt;
      if (p.u >= l.len) {
        // at a node: on to the next link (and at a crossing, first wait)
        const node = p.dir > 0 ? l.b : l.a, next = this.nextLink(p, node, l);
        if (!next) { p.dir = -p.dir; p.u = 0; }
        else if (next[0].kind === KIND.CROSSING && p.state !== 'cross') { p.u = l.len; p.state = 'wait'; p.next = next; p.waitFrom = now; p.v = 0; this.switchClip(p, weighted([['wait', 2], ['idle', 2], ['look', 1], ['text', 1]])); }
        else { const over = p.u - l.len; this.enter(p, next[0], next[1]); p.u = Math.min(over, p.link.len); p.state = 'walk'; }
      }
    }
    this.place(p, dt);
  }
  // where: along the link, keeping to the right of the way it walks (dt 0: there at once)
  place(p, dt) {
    const l = p.link, e = pointOn(l, p.dir > 0 ? Math.min(p.u, l.len) : Math.max(0, l.len - p.u), this.v), dx = e[2] * p.dir, dz = e[3] * p.dir;
    const half = Math.max(0, l.width / 2 - 0.35), want = l.kind === KIND.CROSSING ? p.lane * 0.5 : Math.min(half, p.lane * half);
    p.lat = dt ? p.lat + (want - p.lat) * Math.min(1, dt * 1.5) : want;
    p.x = e[0] - dz * p.lat; p.z = e[1] + dx * p.lat;
    if (p.v > 0.05 || !dt) p.headingTo = Math.atan2(dx, dz);
  }
  enter(p, l, dir) {
    p.link = l; p.dir = dir; p.u = 0;
    // its place across the way: right of centre (people keep right), some further out than others
    p.lane = p.lanePref = 0.25 + rnd() * 0.7;
  }
  follow(f, dt) {
    const L = f.leader;
    if (!L || L.gone) { f.out = true; return; }
    // beside the one it walks with, or behind on a narrow sidewalk
    const l = L.link, narrow = !l || l.width < 1.7 || L.state === 'cross';
    const side = f.rank === 1 ? -1 : 1, back = narrow ? 0.9 * f.rank : 0.15;
    const e = pointOn(l, L.dir > 0 ? Math.max(0, Math.min(l.len, L.u - back)) : Math.max(0, Math.min(l.len, l.len - L.u + back)), this.v);
    const dx = e[2] * L.dir, dz = e[3] * L.dir, lat = L.lat + (narrow ? 0 : side * 0.62);
    const tx = e[0] - dz * lat, tz = e[1] + dx * lat;
    const k = Math.min(1, dt * 6);
    f.x += (tx - f.x) * k; f.z += (tz - f.z) * k;
    f.v = L.v; f.state = 'follow';
    const still = L.state === 'wait';
    if (still && f.clipA !== 'idle') this.switchClip(f, 'idle');
    if (!still && f.clipA !== L.clipA && !STILL.includes(L.clipA)) { this.switchClip(f, L.clipA); f.cycle = L.cycle; }
    if (L.v > 0.05) f.headingTo = Math.atan2(dx, dz);
  }
  queues(dt) {
    this.qt = (this.qt ?? 0) + dt;
    if (this.qt < 0.25) return;
    this.qt = 0;
    const lanes = new Map();
    for (const p of this.people) {
      p.ahead = null;
      if (p.lanePref != null) p.lane += (p.lanePref - p.lane) * 0.12; // (back to its own side, once past)
      if ((p.state !== 'walk' && p.state !== 'cross') || !p.link) continue;
      const k = p.link; if (!lanes.has(k)) lanes.set(k, []); lanes.get(k).push(p);
    }
    for (const list of lanes.values()) {
      if (list.length < 2) continue;
      for (const p of list) {
        let best = null;
        for (const q of list) {
          if (q === p || q.dir !== p.dir || Math.abs(q.lat - p.lat) > 0.55) continue;
          const gap = q.u - p.u;
          if (gap > 0 && gap < 6 && (!best || gap < best.gap)) best = { p: q, gap };
        }
        // overtaking: a slower one close ahead, room further out: step out to pass
        if (best && best.p.v < p.speed - 0.15 && best.gap < 3) p.lane = Math.min(1, p.lane + 0.35);
        p.ahead = best;
        // and side by side with another (either way): a step apart
        for (const q of list) {
          if (q === p || Math.abs((q.dir === p.dir ? q.u : q.link.len - q.u) - p.u) > 0.9) continue;
          const lq = q.dir === p.dir ? q.lat : -q.lat; // (its offset, from this one's side)
          if (Math.abs(lq - p.lat) < 0.55) p.lane = Math.max(-1, Math.min(1, p.lane + (p.lat >= lq ? 0.3 : -0.3)));
        }
      }
    }
  }

  // ---------------------------------------------------------------- drawing
  draw(dt, camera, eye, camDir) {
    this.camera = camera;
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), pos = new THREE.Vector3(), Y = new THREE.Vector3(0, 1, 0);
    const D = this.data;
    let drawn = 0, seen = 0;
    this.frame = (this.frame ?? 0) + 1;
    const frustum = new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)), at = new THREE.Vector3();
    for (const p of this.people) {
      const c = p.clips[p.clipA] ?? p.clips.idle;
      // the clip runs on: a walk at the pace it is carried, standing still in its own time
      if (MOVE.includes(p.clipA)) p.phase = (p.phase + (p.v * dt) / (p.cycle || c.speed * c.duration || 1)) % 1;
      else p.phase = (p.phase + dt / c.duration) % 1;
      if (p.blend > 0) {
        const b = p.clips[p.clipB];
        if (b) p.phaseB = (p.phaseB + (MOVE.includes(p.clipB) ? (p.v * dt) / (b.speed * b.duration || 1) : dt / b.duration)) % 1;
        p.blend = Math.max(0, p.blend - dt / 0.35);
      }
      // the heading eases round
      if (p.headingTo != null) { const d = Math.atan2(Math.sin(p.headingTo - p.heading), Math.cos(p.headingTo - p.heading)); p.heading += d * Math.min(1, dt * 7); }
      const dist = Math.hypot(p.x - eye.x, p.z - eye.z, (p.y ?? eye.y) - eye.y);
      const lod = this.forceLod ?? (dist < LOD[0] ? 0 : dist < LOD[1] ? 1 : 2);
      // its height: on the street as drawn, looked up again when it has moved a little (or now and then)
      if (p.y == null || Math.abs(p.x - p.hx) + Math.abs(p.z - p.hz) > (lod < 2 ? 0.35 : 1.5) || (this.frame + p.slot) % 15 === 0) {
        p.hy = streetAt(this.surface, p.x, p.z, p.y ?? this.surface(p.x, p.z)) + ((p.leader ?? p).link?.kind === KIND.CROSSING ? 0 : this.lift(p.x, p.z));
        p.hx = p.x; p.hz = p.z;
      }
      p.y = p.y == null || Math.abs(p.hy - p.y) > 2 ? p.hy : p.y + (p.hy - p.y) * Math.min(1, dt * 12);
      const visible = dist < FAR && p.fade > 0;
      const a = p.avatar, g = a.geo[lod];
      if (!visible) { if (p.lod !== -1) { this.body.setVisibleAt(p.slot, false); if (this.hasHair) this.hair.setVisibleAt(p.slot, false); p.lod = -1; } continue; }
      if (p.lod !== lod) {
        this.body.setGeometryIdAt(p.slot, g.body); this.body.setVisibleAt(p.slot, true);
        if (this.hasHair) { if (g.hair != null) { this.hair.setGeometryIdAt(p.slot, g.hair); this.hair.setVisibleAt(p.slot, true); } else this.hair.setVisibleAt(p.slot, false); }
        p.lod = lod;
      }
      q.setFromAxisAngle(Y, p.heading); s.setScalar(p.scale); pos.set(p.x, p.y, p.z);
      m.compose(pos, q, s);
      this.body.setMatrixAt(p.slot, m);
      if (this.hasHair && g.hair != null) this.hair.setMatrixAt(p.slot, m);
      const o = p.slot * 16, B = p.blend > 0 ? p.clips[p.clipB] : null;
      D[o] = c.start; D[o + 1] = c.frames; D[o + 2] = p.phase; D[o + 3] = B ? p.blend : 0;
      D[o + 4] = B ? B.start : 0; D[o + 5] = B ? B.frames : 1; D[o + 6] = B ? p.phaseB : 0; D[o + 7] = a.layer;
      D[o + 8] = p.tone[0]; D[o + 9] = p.tone[1]; D[o + 10] = p.tone[2]; D[o + 11] = p.fade;
      drawn++;
      if (dist < 120 && frustum.containsPoint(at.set(p.x, p.y + 1, p.z))) seen++;
    }
    this.dataTexture.needsUpdate = true;
    this.stats.drawn = drawn; this.stats.seen = seen;
  }
  // (for looking at them: every avatar in a row at (x, z), facing `heading`, each twice: as drawn, and with the
  // darkest tone it may take; the crowd stands aside meanwhile, until lineup(null))
  lineup(x, z, heading = 0, clip = 'idle', ids = null) {
    for (const p of this.people) this.release(p);
    this.people.length = 0;
    this.frozen = x != null;
    if (!this.frozen) return;
    const ax = Math.cos(heading), az = -Math.sin(heading), list = this.avatars.filter((a) => !ids || ids.includes(a.id)).flatMap((a) => (a.tint ? [[a, false], [a, true]] : [[a, false]]));
    list.forEach(([a, dark], i) => {
      const p = this.person('everyday', null);
      if (!p) return;
      const k = (((a.fairHair ? 58 : 42) + 16) / (a.base + 16)) ** 3, o = (i - (list.length - 1) / 2) * 0.9;
      Object.assign(p, { avatar: a, clips: a.clips, tone: dark && k < 1 ? [k, k, k ** 1.06] : [1, 1, 1], scale: 1, state: 'still', x: x + ax * o, z: z + az * o, heading, clipA: a.clips[clip] ? clip : 'idle', fade: 1, until: Infinity, label: `${a.id}${dark ? ' dark' : ''}` });
    });
  }
  dispose() { this.body?.dispose(); this.hair?.dispose(); }
}
