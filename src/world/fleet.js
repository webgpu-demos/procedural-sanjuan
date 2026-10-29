// San Juan's cars as instanced meshes of the lofted bodies (carbodies.js, carmaterial.js): per body, its full model
// (with its wheels; casts shadows), a ~500-triangle stand-in further off, the soft shadow under it and the light its
// lamps throw on the road, all sharing one set of instance matrices per level. The traffic (traffic.js) and the
// simulated morning (simtraffic.js) fill them a frame at a time: begin(), add() for every car seen, end().
import * as THREE from 'three';
import { BODY_SPECS, buildCarGeometry, buildCarProxyGeometry, carStyleCode } from './carbodies.js';
import { loftedCarMaterial, contactShadowGeometry, contactShadowMaterial, carDepth } from './carmaterial.js';
import { BUS_SPEC, buildBusGeometry } from './busbody.js';
import { busMaterial } from './busmaterial.js';
import { LAMP_LAYER } from './lamplight.js';

// The kinds of vehicle (traffic.js TYPES) as bodies: a compact is the sedan a size smaller; an SUV is now and then a
// minivan; a truck the delivery van; the bus the AMA's (busbody.js)
export const BODY_OF = { compact: 'sedan', sedan: 'sedan', suv: 'suv', pickup: 'pickup', truck: 'van', bus: 'bus' };
const specOf = (body) => (body === 'bus' ? BUS_SPEC : BODY_SPECS[body]);
export const SCALE_OF = { compact: [0.96, 0.97, 0.92] };
export const lengthOf = (body, kind) => (specOf(body).zFront - specOf(body).zRear) * (SCALE_OF[kind]?.[2] ?? 1);

// What San Juan drives, by body: white above all, silver, greys and black, the odd red, blue, a dark green; solid or
// metallic paint, chrome or blacked-out trim, a black roof now and then; four wheel designs
const style = carStyleCode;
export const PALETTES = {
  sedan: [
    [0xf2f4f7, style({ wheel: 0 })], [0xe6eaef, style({ metallic: 1, trim: 1, wheel: 1 })], [0xf0f2f4, style({ wheel: 3 })],
    [0xc8d0d8, style({ metallic: 1, trim: 1 })], [0x9aa2ac, style({ metallic: 1, wheel: 1 })], [0x52575e, style({ metallic: 1, wheel: 2 })],
    [0x1c2026, style({ metallic: 1, trim: 1 })], [0x12151a, style({ trim: 2, wheel: 3 })], [0x741d22, style({ metallic: 1, trim: 1 })],
    [0x8f1a1d, style({ trim: 2, wheel: 2 })], [0x1d3b6c, style({ metallic: 1, trim: 1, wheel: 1 })], [0x285086, style({ livery: 4, metallic: 1, trim: 2, wheel: 2 })],
    [0xe9ecef, style({ livery: 4, metallic: 1, trim: 2, wheel: 2 })], [0xb9c0c7, style({ metallic: 1 })],
  ],
  suv: [
    [0xf0f3f7, style({ metallic: 1, trim: 1 })], [0xe4e8ed, style({ livery: 4, trim: 2, wheel: 2 })], [0xf2f3f5, style({ wheel: 1 })],
    [0xbec6cf, style({ metallic: 1, trim: 1 })], [0x5c636b, style({ metallic: 1, trim: 1, wheel: 1 })], [0x3a434d, style({ metallic: 1, wheel: 2 })],
    [0x181c22, style({ metallic: 1, wheel: 3 })], [0x101318, style({ trim: 1, wheel: 1 })], [0x20385c, style({ metallic: 1, trim: 1, wheel: 1 })],
    [0x682024, style({ livery: 4, metallic: 1, trim: 2, wheel: 2 })], [0x28382e, style({ metallic: 1 })], [0x787670, style({ trim: 2, wheel: 3 })],
  ],
  minivan: [
    [0xf0f2f5, style({ metallic: 1, trim: 1 })], [0xaab2bb, style({ metallic: 1, wheel: 1 })], [0x4a5058, style({ metallic: 1, wheel: 2 })],
    [0x1a1d22, style({ metallic: 1, trim: 2, wheel: 3 })], [0x26354f, style({ metallic: 1, trim: 1 })], [0xe9ecef, style({ wheel: 1 })], [0x5a1f24, style({ metallic: 1, trim: 1 })],
  ],
  pickup: [
    [0xf2f3f5, style({ trim: 1 })], [0x14171b, style({ metallic: 1, trim: 1, wheel: 1 })], [0x9da4ab, style({ metallic: 1, wheel: 2 })],
    [0x3d434a, style({ metallic: 1, trim: 2, wheel: 3 })], [0x1e2f4f, style({ metallic: 1, trim: 1, wheel: 1 })], [0x8f1a1d, style({ trim: 2, wheel: 3 })],
    [0xf2f3f5, style({ trim: 2, wheel: 3 })], [0x2c3a30, style({ metallic: 1 })],
  ],
  van: [
    [0xf4f5f6, style({ trim: 2 })], [0xeef0f2, style({ trim: 2, wheel: 3 })], [0xf4f5f6, style({ wheel: 1 })], [0xb9c0c7, style({ metallic: 1, trim: 2 })],
    [0xf4f5f6, style({ trim: 2 })], [0x8e959c, style({ trim: 2, wheel: 3 })], [0x15181c, style({ metallic: 1, trim: 2, wheel: 3 })], [0x1f3354, style({ trim: 2 })],
  ],
  // (a bus's paint is its route's band, from the GTFS colour where the simulation has it: simtraffic.js)
  bus: [[0x1d5fa8, 0], [0x0e7a5a, 0], [0xc8202a, 0]],
};

// A car's look from a number of its own (a vehicle id, a seed): its body (an SUV is a minivan one time in five), paint
// and style; colours as linear RGB
const hash = (v) => { v = Math.imul(v ^ (v >>> 16), 0x45d9f3b); v = Math.imul(v ^ (v >>> 16), 0x45d9f3b); return ((v ^ (v >>> 16)) >>> 0) / 4294967296; };
const tmpColor = new THREE.Color();
export function lookOf(kind, id) {
  let body = BODY_OF[kind];
  if (kind === 'suv' && hash(id + 31) < 0.2) body = 'minivan';
  const pal = PALETTES[body], [hex, code] = pal[Math.floor(hash(id + 7) * pal.length)];
  tmpColor.setHex(hex);
  return { body, paint: [tmpColor.r, tmpColor.g, tmpColor.b], style: code, scale: SCALE_OF[kind] ?? null };
}

// One body at one level of detail: the instanced mesh, its per-instance attributes, the contact shadows and lamp
// pools that share its matrices
class Level {
  constructor(spec, geometry, material, cap, { shadow, beam, beamMaterial }) {
    const g = geometry;
    this.paint = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.state = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4).setUsage(THREE.DynamicDrawUsage);
    this.wheel = new THREE.InstancedBufferAttribute(new Float32Array(cap * 2), 2).setUsage(THREE.DynamicDrawUsage);
    this.hide = new THREE.InstancedBufferAttribute(new Float32Array(cap), 1).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('paintColor', this.paint); g.setAttribute('carState', this.state); g.setAttribute('aWheel', this.wheel); g.setAttribute('aHide', this.hide);
    this.mesh = new THREE.InstancedMesh(g, material, cap);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.castShadow = shadow; this.mesh.receiveShadow = true; this.mesh.frustumCulled = false; this.mesh.count = 0;
    this.mesh.customDepthMaterial = carDepth(); // (its shadow: carmaterial.js)
    this.mesh.userData.vehicle = true; // (labelled as vehicles in synthetic training images, src/synth/labels.js)
    const sg = contactShadowGeometry(spec);
    sg.setAttribute('aHide', this.hide);
    this.shadow = new THREE.InstancedMesh(sg, contactShadowMaterial(), cap);
    this.shadow.instanceMatrix = this.mesh.instanceMatrix; this.shadow.frustumCulled = false; this.shadow.count = 0; this.shadow.renderOrder = 1;
    this.beams = null;
    if (beam) {
      this.beams = new THREE.InstancedMesh(beam, beamMaterial, cap);
      this.beams.instanceMatrix = this.mesh.instanceMatrix; this.beams.frustumCulled = false; this.beams.count = 0; this.beams.layers.set(LAMP_LAYER);
    }
    this.cap = cap; this.n = 0;
  }
  get objects() { return [this.mesh, this.shadow, ...(this.beams ? [this.beams] : [])]; }
  end() {
    this.mesh.count = this.shadow.count = this.n;
    if (this.beams) this.beams.count = this.n;
    for (const a of [this.mesh.instanceMatrix, this.paint, this.state, this.wheel, this.hide]) {
      a.clearUpdateRanges(); a.addUpdateRange(0, this.n * a.itemSize); a.needsUpdate = true;
    }
  }
}

// The bodies, each at two levels (0: the full model; 1: the stand-in)
export class Fleet {
  // caps: { body: [cap near, cap far] }; beam(L): the lamp pool's geometry for a car of length L, beamMaterial its
  // material (traffic.js), or null for none
  constructor(caps, { beam = null, beamMaterial = null } = {}) {
    this.group = new THREE.Group(); this.group.name = 'cars';
    this.bodies = {};
    for (const [body, [near, far]] of Object.entries(caps)) {
      const spec = specOf(body), L = spec.zFront - spec.zRear, bus = body === 'bus';
      const material = () => (bus ? busMaterial() : loftedCarMaterial(spec));
      const levels = [
        new Level(spec, bus ? buildBusGeometry(1) : buildCarGeometry(spec, true), material(), near, { shadow: true, beam: beam?.(L), beamMaterial }),
        new Level(spec, bus ? buildBusGeometry(0) : buildCarProxyGeometry(spec), material(), far, { shadow: false, beam: beam?.(L), beamMaterial }),
      ];
      for (const l of levels) this.group.add(...l.objects);
      this.bodies[body] = { spec, levels };
    }
    this.m = new THREE.Matrix4(); this.s = new THREE.Vector3();
  }
  begin() { for (const b of Object.values(this.bodies)) for (const l of b.levels) l.n = 0; }
  // matrix: the car's (heading, pitch, position); look: lookOf(); lod 0/1; state: brake, turn signals (left +x, right
  // -x), the wheels' turn (radians), their blur, hide (the dissolve, 0..1). False if the level is full.
  add(lod, matrix, look, brake = 0, left = 0, right = 0, spin = 0, blur = 0, hide = 0) {
    const l = this.bodies[look.body]?.levels[lod];
    if (!l || l.n >= l.cap) return false;
    const k = l.n++;
    if (look.scale) { this.m.copy(matrix).scale(this.s.set(...look.scale)); l.mesh.setMatrixAt(k, this.m); } else l.mesh.setMatrixAt(k, matrix);
    l.paint.array.set(look.paint, k * 3);
    const st = l.state.array; st[k * 4] = brake; st[k * 4 + 1] = left; st[k * 4 + 2] = right; st[k * 4 + 3] = look.style;
    l.wheel.array[k * 2] = spin; l.wheel.array[k * 2 + 1] = blur;
    l.hide.array[k] = hide;
    return true;
  }
  end() { for (const b of Object.values(this.bodies)) for (const l of b.levels) l.end(); }
  hide() { this.begin(); this.end(); }
  get count() { let n = 0; for (const b of Object.values(this.bodies)) for (const l of b.levels) n += l.n; return n; }
  // the wheels' radius of a body (for their turn: distance / radius)
  wheelRadius(body) { return specOf(body).wheelRadius; }
}

// How fast the wheels' pattern may turn before the eye sees it strobe: from 15 rad/s (2.4 turns a second) it blurs
// to the rim's mean, fully by 35
export const wheelBlur = (speed, r) => THREE.MathUtils.smoothstep(speed / r, 15, 35);
