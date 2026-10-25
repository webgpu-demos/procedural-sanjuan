// On foot and in the air: the other ways round the city besides the car (drive.js), with the same face to the
// rest of the page: start(x, z, heading, y), stop(), update(dt, keys), view { x, y, z, heading, speed, kmh }.
//   walking    W / S walk on and back, A / D turn, Shift run, Space jump; stopped by the buildings' walls, on the
//              ground or the deck walked onto (a person on a flyover stays on it)
//   cycling    a bicycle: W pedal, S brake (and back a little), A / D steer, Shift a sprint, Space the brakes; it
//              leans into its turns; stopped by the walls like the walker
//   flying     a helicopter: W / S pitch forward and back, A / D yaw, Space / E climb, C / Q come down, Shift a
//              push; it banks into its turns, leans into its speed, its rotors turn; it does not go under the ground
// (the motion after the controllers of mrdoob's Slop New York, MIT: github.com/mrdoob/slop-newyork)
import * as THREE from 'three';
import { Walls, Roofs } from './drive.js';
import { heroLit, lampMaterial, LAMP_LAYER } from './lamplight.js';
import { shared } from './materials.js';

const keyOf = (keys) => (...c) => c.some((x) => keys.has(x));
const mat = (color, roughness = 0.7, metalness = 0) => heroLit(new THREE.MeshStandardMaterial({ color, roughness, metalness }));

// ---------------------------------------------------------------- a person
// A walker of a few rounded shapes: legs and arms that swing from the hip and the shoulder (elbows and knees bend
// with the stride), a guayabera, jeans, sneakers, a cap
function person() {
  const g = new THREE.Group(), skin = mat(0x8d5a3b, 0.55), shirt = mat(0xf2efe6, 0.8), jeans = mat(0x34507a, 0.85), shoe = mat(0xf4f4f4, 0.5), cap = mat(0xc8102e, 0.6), hair = mat(0x1b1410, 0.9);
  const part = (geo, m, x = 0, y = 0, z = 0) => { const p = new THREE.Mesh(geo, m); p.position.set(x, y, z); p.castShadow = true; return p; };
  const pivot = (x, y, ...kids) => { const p = new THREE.Group(); p.position.set(x, y, 0); p.add(...kids); return p; };
  // a limb in two: upper from the pivot, lower from the joint (rotation.x of each: the swing, the bend)
  const limb = (x, y, r, a, b, m, end) => {
    const lower = pivot(0, -a, part(new THREE.CapsuleGeometry(r * 0.88, b - r * 1.76, 4, 10), m, 0, -b / 2), end);
    end.position.y = -b; lower.position.x = 0;
    return Object.assign(pivot(x, y, part(new THREE.CapsuleGeometry(r, a - r * 2, 4, 10), m, 0, -a / 2), lower), { lower });
  };
  const torso = part(new THREE.CylinderGeometry(0.2, 0.165, 0.56, 16), shirt, 0, 1.2); torso.scale.z = 0.62;
  const chest = part(new THREE.SphereGeometry(0.2, 16, 10, 0, Math.PI * 2, 0, Math.PI / 2), shirt, 0, 1.47); chest.scale.set(1, 0.35, 0.62);
  const hips = part(new THREE.CapsuleGeometry(0.1, 0.16, 4, 10), jeans, 0, 0.9); hips.rotation.z = Math.PI / 2; hips.scale.z = 0.95;
  const neck = part(new THREE.CylinderGeometry(0.05, 0.055, 0.1, 10), skin, 0, 1.53);
  const head = part(new THREE.SphereGeometry(0.115, 18, 14), skin, 0, 1.65); head.scale.set(0.92, 1.05, 1);
  const crown = part(new THREE.SphereGeometry(0.122, 18, 10, 0, Math.PI * 2, 0, Math.PI / 2.2), cap, 0, 1.68);
  const peak = part(new THREE.CylinderGeometry(0.09, 0.09, 0.015, 16, 1, false, -Math.PI / 2, Math.PI), cap, 0, 1.69, 0.06); peak.scale.z = 1.4;
  const nape = part(new THREE.SphereGeometry(0.112, 14, 10, 0, Math.PI * 2, Math.PI / 2.6, Math.PI / 3), hair, 0, 1.66, -0.01);
  const foot = () => { const f = part(new THREE.CapsuleGeometry(0.055, 0.15, 4, 8), shoe, 0, -0.03, 0.05); f.rotation.x = Math.PI / 2; return f; };
  const hand = () => part(new THREE.SphereGeometry(0.048, 10, 8), skin);
  const legL = limb(-0.095, 0.935, 0.078, 0.44, 0.44, jeans, foot()), legR = limb(0.095, 0.935, 0.078, 0.44, 0.44, jeans, foot());
  const armL = limb(-0.245, 1.46, 0.052, 0.3, 0.28, shirt, hand()), armR = limb(0.245, 1.46, 0.052, 0.3, 0.28, shirt, hand());
  // (forearms in skin: the guayabera's short sleeves)
  for (const arm of [armL, armR]) arm.lower.children[0].material = skin;
  g.add(torso, chest, hips, neck, head, crown, peak, nape, legL, legR, armL, armR);
  g.userData = { legL, legR, armL, armR, torso, head };
  return g;
}

export class Walker {
  constructor({ scene, surface, sim, tiles }) {
    this.surface = surface; this.sim = sim; this.walls = new Walls(tiles);
    this.on = false; this.label = 'A pie'; this.unit = 'km/h';
    this.model = person(); this.model.visible = false; scene.add(this.model);
    this.view = null;
  }
  start(x, z, heading, y = null) {
    Object.assign(this, { x, z, heading, speed: 0, vy: 0, phase: 0, y: y ?? this.surface(x, z, -2), on: true });
    this.model.visible = true;
  }
  stop() { this.on = false; this.model.visible = false; this.view = null; }
  // the ground under (x, z), or the deck at about this height (a walkway, a flyover)
  floor(x, z) {
    const ground = this.surface(x, z, -2), deck = this.sim()?.deckAt(x, z, this.y + 0.3) ?? null;
    return deck != null && Math.abs(deck - this.y) < 1.2 ? deck : ground;
  }
  update(dt, keys) {
    if (!this.on) return;
    dt = Math.min(dt, 0.05);
    const k = keyOf(keys), run = k('ShiftLeft', 'ShiftRight'), top = run ? 7.5 : 1.8;
    const fwd = (k('KeyW', 'ArrowUp') ? 1 : 0) - (k('KeyS', 'ArrowDown') ? 0.65 : 0), turn = (k('KeyA', 'ArrowLeft') ? 1 : 0) - (k('KeyD', 'ArrowRight') ? 1 : 0);
    this.heading += turn * 2.6 * dt;
    this.speed += (fwd * top - this.speed) * Math.min(1, dt * 10);
    const nx = this.x + Math.sin(this.heading) * this.speed * dt, nz = this.z + Math.cos(this.heading) * this.speed * dt;
    // a wall in the way: slide along it (one axis at a time), or stop
    if (!this.walls.blocked(nx, nz)) { this.x = nx; this.z = nz; }
    else if (!this.walls.blocked(nx, this.z)) this.x = nx;
    else if (!this.walls.blocked(this.x, nz)) this.z = nz;
    else this.speed = 0;
    // up and down: a jump, and gravity
    const floor = this.floor(this.x, this.z), grounded = this.y <= floor + 0.03;
    if (k('Space') && grounded) this.vy = 5.2;
    this.vy -= 14.5 * dt;
    this.y += this.vy * dt;
    if (this.y < floor) { this.y = floor; this.vy = 0; }
    if (grounded && this.y > floor + 0.5 && this.vy <= 0) this.y = floor; // (stepping down a kerb, not falling)
    // the stride: legs and arms swing with the speed, the body bobs
    const v = Math.abs(this.speed);
    this.phase += v * dt * (run ? 1.9 : 3.4);
    const swing = Math.min(0.8, v * 0.35) * Math.sin(this.phase), u = this.model.userData;
    u.legL.rotation.x = swing; u.legR.rotation.x = -swing; u.armL.rotation.x = -swing * 0.8; u.armR.rotation.x = swing * 0.8;
    // the knee bends as the leg comes through, the elbows a little more running
    const bend = Math.min(1, v * 0.4);
    u.legL.lower.rotation.x = bend * Math.max(0, -Math.cos(this.phase)) * 0.9; u.legR.lower.rotation.x = bend * Math.max(0, Math.cos(this.phase)) * 0.9; // (+: the foot back)
    u.armL.lower.rotation.x = u.armR.lower.rotation.x = -0.25 - bend * (run ? 0.9 : 0.25);
    this.model.position.set(this.x, this.y + Math.abs(Math.sin(this.phase)) * Math.min(0.06, v * 0.02), this.z);
    this.model.rotation.y = this.heading;
    this.view = { x: this.x, y: this.y, z: this.z, heading: this.heading, speed: v, kmh: v * 3.6, bump: 0, reversing: this.speed < -0.1, height: 1.7 };
  }
}

// ---------------------------------------------------------------- a bicycle
// A city bike (wheels 0.34 m, a diamond frame in red, black bars and saddle) and its rider, the walker seated:
// leaning over the bars, the legs on the pedals going round
function bicycle() {
  const g = new THREE.Group(), frame = mat(0xb3121d, 0.35, 0.4), black = mat(0x15161a, 0.6, 0.3), steel = mat(0xb9bcc2, 0.3, 0.8), rubber = mat(0x0e0e10, 0.9);
  const R = 0.34, rear = -0.52, front = 0.54, hub = R;
  const bar = (a, b, r, m) => { const A = new THREE.Vector3(...a), B = new THREE.Vector3(...b), mesh = new THREE.Mesh(new THREE.CylinderGeometry(r, r, A.distanceTo(B), 8), m);
    mesh.position.copy(A).add(B).multiplyScalar(0.5); mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), B.sub(A).normalize()); mesh.castShadow = true; return mesh; };
  const wheel = (z) => {
    const w = new THREE.Group(); w.position.set(0, hub, z);
    const tyre = new THREE.Mesh(new THREE.TorusGeometry(R - 0.02, 0.022, 8, 32), rubber); tyre.rotation.y = Math.PI / 2; tyre.castShadow = true;
    const rim = new THREE.Mesh(new THREE.TorusGeometry(R - 0.05, 0.008, 4, 32), steel); rim.rotation.y = Math.PI / 2;
    w.add(tyre, rim);
    for (let k = 0; k < 8; k++) { const s = new THREE.Mesh(new THREE.BoxGeometry(0.004, (R - 0.05) * 2, 0.004), steel); s.rotation.x = (k / 8) * Math.PI; w.add(s); }
    return w;
  };
  const wr = wheel(rear), wf = wheel(front);
  const bb = [0, 0.3, -0.06], seat = [0, 0.86, -0.2], head = [0, 0.84, 0.36];
  g.add(wr, wf,
    bar(bb, seat, 0.018, frame), bar(seat, head, 0.017, frame), bar(bb, head, 0.02, frame),                       // the diamond
    bar(bb, [0, hub, rear], 0.012, frame), bar(seat, [0, hub, rear], 0.011, frame),                              // the stays
    bar(head, [0, hub, front], 0.014, frame), bar([0, 0.84, 0.36], [0, 1.0, 0.33], 0.014, black),                 // fork, stem
    bar([-0.27, 1.0, 0.3], [0.27, 1.0, 0.3], 0.012, black), bar(seat, [0, 0.93, -0.22], 0.012, steel));            // bars, seat post
  const saddle = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.04, 0.26), black); saddle.position.set(0, 0.95, -0.2); g.add(saddle);
  const crank = new THREE.Group(); crank.position.set(0, ...bb.slice(1));
  for (const sx of [-1, 1]) { const arm = bar([sx * 0.07, 0, 0], [sx * 0.07, -0.17, 0], 0.01, steel); const pedal = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.02, 0.06), black); pedal.position.set(sx * 0.11, -0.17, 0); const p = new THREE.Group(); p.rotation.x = sx > 0 ? 0 : Math.PI; p.add(arm, pedal); crank.add(p); }
  g.add(crank);
  // the rider: the walker, seated (hips on the saddle), leaning to the bars
  const rider = person(), seatAt = new THREE.Group();
  seatAt.position.set(0, 0.97, -0.2); rider.position.y = -0.9; seatAt.add(rider); g.add(seatAt);
  seatAt.rotation.x = 0.42;
  const u = rider.userData;
  u.armL.rotation.x = u.armR.rotation.x = -1.05; u.armL.lower.rotation.x = u.armR.lower.rotation.x = -0.25;
  u.armL.rotation.z = -0.12; u.armR.rotation.z = 0.12;
  g.userData = { wheels: [wr, wf], crank, rider: u };
  return g;
}

export class Cyclist {
  constructor({ scene, surface, sim, tiles }) {
    this.surface = surface; this.sim = sim; this.walls = new Walls(tiles);
    this.on = false; this.label = 'Bicicleta'; this.unit = 'km/h';
    this.model = bicycle(); this.model.visible = false; scene.add(this.model);
    this.view = null;
  }
  start(x, z, heading, y = null) {
    Object.assign(this, { x, z, heading, speed: 0, lean: 0, crank: 0, roll: 0, y: y ?? this.surface(x, z, -2), on: true });
    this.model.visible = true;
  }
  stop() { this.on = false; this.model.visible = false; this.view = null; }
  floor(x, z) {
    const ground = this.surface(x, z, -2), deck = this.sim()?.deckAt(x, z, this.y + 0.3) ?? null;
    return deck != null && Math.abs(deck - this.y) < 1.2 ? deck : ground;
  }
  update(dt, keys) {
    if (!this.on) return;
    dt = Math.min(dt, 0.05);
    const k = keyOf(keys), sprint = k('ShiftLeft', 'ShiftRight'), top = sprint ? 11 : 7;
    const pedal = k('KeyW', 'ArrowUp'), brake = k('KeyS', 'ArrowDown') || k('Space'), steer = (k('KeyA', 'ArrowLeft') ? 1 : 0) - (k('KeyD', 'ArrowRight') ? 1 : 0);
    let v = this.speed;
    if (pedal) v += (sprint ? 3.2 : 2.2) * (1 - Math.max(0, v) / top) * dt;
    if (brake) v -= (v > 0.2 ? 6 : k('KeyS', 'ArrowDown') ? 1 : 0) * dt;
    if (!pedal && !brake) v -= Math.sign(v) * Math.min(Math.abs(v), (0.25 + 0.02 * v * v) * dt);
    v = THREE.MathUtils.clamp(v, -1.2, top);
    // it turns tighter slowly; it leans into the turn
    const yaw = steer * (1.9 / (1 + Math.abs(v) / 4)) * Math.min(1, Math.abs(v) / 0.8 + 0.25) * Math.sign(v || 1);
    this.heading += yaw * dt;
    const nx = this.x + Math.sin(this.heading) * v * dt, nz = this.z + Math.cos(this.heading) * v * dt;
    if (!this.walls.blocked(nx, nz)) { this.x = nx; this.z = nz; }
    else if (!this.walls.blocked(nx, this.z)) this.x = nx;
    else if (!this.walls.blocked(this.x, nz)) this.z = nz;
    else v *= -0.2;
    this.speed = v;
    const floor = this.floor(this.x, this.z);
    this.y += THREE.MathUtils.clamp(floor - this.y, -0.4, 0.4) * Math.min(1, dt * 14);
    this.lean += (-yaw * v * 0.05 - this.lean) * Math.min(1, dt * 6);
    this.lean = THREE.MathUtils.clamp(this.lean, -0.35, 0.35);
    // the wheels and the crank go round; the legs go with the pedals
    const u = this.model.userData;
    for (const w of u.wheels) w.rotation.x += (v / 0.34) * dt;
    this.crank += (v / 0.34) * dt * 0.42; u.crank.rotation.x = this.crank;
    const r = u.rider, c = this.crank;
    r.legL.rotation.x = -1.25 + 0.42 * Math.sin(c); r.legL.lower.rotation.x = 1.05 + 0.5 * Math.cos(c);
    r.legR.rotation.x = -1.25 - 0.42 * Math.sin(c); r.legR.lower.rotation.x = 1.05 - 0.5 * Math.cos(c);
    this.model.position.set(this.x, this.y, this.z);
    this.model.rotation.set(0, this.heading, 0); this.model.rotateZ(this.lean);
    this.view = { x: this.x, y: this.y, z: this.z, heading: this.heading, speed: Math.abs(v), kmh: Math.abs(v) * 3.6, bump: 0, reversing: v < -0.1, height: 1.6 };
  }
}

// ---------------------------------------------------------------- a helicopter
function helicopter() {
  const g = new THREE.Group(), body = mat(0xf4f4f2, 0.35, 0.3), stripe = mat(0xc8102e, 0.4, 0.2), glass = mat(0x0b1520, 0.08, 0.9), dark = mat(0x1d2024, 0.6, 0.4);
  const tilt = new THREE.Group(); g.add(tilt);
  const cabin = new THREE.Mesh(new THREE.SphereGeometry(1.25, 24, 16), body); cabin.scale.set(1, 0.95, 1.65); cabin.position.y = 1.55; cabin.castShadow = true;
  const nose = new THREE.Mesh(new THREE.SphereGeometry(1.05, 20, 14, 0, Math.PI * 2, 0, Math.PI / 2), glass); nose.rotation.x = Math.PI / 2; nose.scale.set(1, 1.15, 0.9); nose.position.set(0, 1.6, 1.15);
  const band = new THREE.Mesh(new THREE.CylinderGeometry(1.27, 1.27, 0.22, 24), stripe); band.scale.set(1, 1, 1.65); band.position.y = 1.25;
  const boom = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.34, 5.2, 12), body); boom.rotation.x = Math.PI / 2; boom.position.set(0, 1.9, -4.3); boom.castShadow = true;
  const fin = new THREE.Mesh(new THREE.BoxGeometry(0.08, 1.1, 0.7), stripe); fin.position.set(0, 2.45, -6.7);
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.18, 0.5, 10), dark); mast.position.y = 2.95;
  const rotor = new THREE.Group(); rotor.position.y = 3.2;
  for (let i = 0; i < 4; i++) { const b = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.04, 5.6), dark); b.position.z = 2.8; const arm = new THREE.Group(); arm.rotation.y = (i * Math.PI) / 2; arm.add(b); rotor.add(arm); }
  const tail = new THREE.Group(); tail.position.set(0.18, 2.45, -6.7);
  for (let i = 0; i < 2; i++) { const b = new THREE.Mesh(new THREE.BoxGeometry(0.03, 1.3, 0.12), dark); b.rotation.x = (i * Math.PI) / 2; tail.add(b); }
  for (const sx of [-0.85, 0.85]) {
    const skid = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 3.2, 8), dark); skid.rotation.x = Math.PI / 2; skid.position.set(sx, 0.08, 0.2);
    const strut = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.6, 0.06), dark); strut.position.set(sx, 0.38, 0.7);
    const strut2 = strut.clone(); strut2.position.z = -0.6;
    tilt.add(skid, strut, strut2);
  }
  // the lights it flies by: red to port, green to starboard, a white strobe on the fin, a red beacon on the boom
  const light = (rgb, r, x, y, z) => { const m = new THREE.Mesh(new THREE.SphereGeometry(r, 10, 8), new THREE.MeshBasicMaterial({ color: new THREE.Color(...rgb) })); m.position.set(x, y, z); return m; };
  const strobe = light([6, 6, 6], 0.09, 0, 3.02, -6.95), beacon = light([5, 0.15, 0.1], 0.1, 0, 2.12, -3.2);
  tilt.add(cabin, nose, band, boom, fin, mast, rotor, tail, light([4, 0.12, 0.08], 0.07, 1.28, 1.35, 0.2), light([0.1, 3.5, 0.6], 0.07, -1.28, 1.35, 0.2), strobe, beacon);
  g.userData = { tilt, rotor, tail, strobe, beacon };
  return g;
}

// A soft round footprint of light (the searchlight's), for the light map
function spotTexture() {
  const N = 64, data = new Uint8Array(N * N * 4);
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const d = Math.hypot(i + 0.5 - N / 2, j + 0.5 - N / 2) / (N / 2), v = Math.max(0, 1 - THREE.MathUtils.smoothstep(d, 0.55, 1)) * (0.75 + 0.25 * (1 - d));
    data.set([v * 255, v * 255, v * 255, 255], (j * N + i) * 4);
  }
  const t = new THREE.DataTexture(data, N, N); t.magFilter = t.minFilter = THREE.LinearFilter; t.needsUpdate = true;
  return t;
}
// the beam through the air: an open cone, brighter at the lamp, added onto the picture
function beamCone() {
  const N = 64, data = new Uint8Array(N * 4);
  for (let i = 0; i < N; i++) { const v = 0.2 + 0.8 * (i / (N - 1)) ** 2; data.set([v * 255, v * 255, v * 255, 255], i * 4); }
  const ramp = new THREE.DataTexture(data, 1, N); ramp.magFilter = ramp.minFilter = THREE.LinearFilter; ramp.needsUpdate = true;
  const cone = new THREE.Mesh(new THREE.ConeGeometry(1, 1, 28, 1, true).translate(0, -0.5, 0),
    new THREE.MeshBasicMaterial({ color: 0xfff0d8, alphaMap: ramp, transparent: true, opacity: 0.07, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false }));
  cone.frustumCulled = false; cone.visible = false;
  return cone;
}

export class Flyer {
  constructor({ scene, surface, tiles }) {
    this.surface = surface; this.on = false; this.label = 'Helicóptero'; this.unit = 'km/h';
    this.roofs = new Roofs(tiles);
    this.model = helicopter(); this.model.visible = false; scene.add(this.model);
    // at night, the searchlight: a pool on the street ahead and below (into the light map, lamplight.js), and its
    // beam through the air
    this.spot = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), lampMaterial(spotTexture(), { color: new THREE.Color(1.7, 1.6, 1.45) }));
    this.spot.layers.set(LAMP_LAYER); this.spot.frustumCulled = false; this.spot.visible = false;
    this.beam = beamCone();
    scene.add(this.spot, this.beam);
    this.view = null;
  }
  start(x, z, heading, y = null) {
    Object.assign(this, { x, z, heading, speed: 0, vy: 0, pitch: 0, roll: 0, spin: 0, on: true });
    this.y = Math.max(y ?? 0, this.surface(x, z) + 90);
    this.model.visible = true;
  }
  stop() { this.on = false; this.model.visible = this.spot.visible = this.beam.visible = false; this.view = null; }
  update(dt, keys) {
    if (!this.on) return;
    dt = Math.min(dt, 0.05);
    const k = keyOf(keys), boost = k('ShiftLeft', 'ShiftRight'), top = boost ? 60 : 36;
    const fwd = (k('KeyW', 'ArrowUp') ? 1 : 0) - (k('KeyS', 'ArrowDown') ? 1 : 0), yaw = (k('KeyA', 'ArrowLeft') ? 1 : 0) - (k('KeyD', 'ArrowRight') ? 1 : 0);
    const up = (k('Space', 'KeyE') ? 1 : 0) - (k('KeyC', 'KeyQ') ? 1 : 0);
    if (fwd) this.speed = THREE.MathUtils.clamp(this.speed + fwd * 24 * dt, -top * 0.6, top); else this.speed *= Math.max(0, 1 - dt * 1.8);
    if (up) this.vy = THREE.MathUtils.clamp(this.vy + up * 22 * dt, -16, 16); else this.vy *= Math.max(0, 1 - dt * 3.5);
    this.heading += yaw * 1.45 * dt;
    // a tower in the way stops it (it has to climb over); the roof under it, or the ground, holds it up
    const floorAt = (x, z) => Math.max(this.surface(x, z), this.roofs.top(x, z)) + 2;
    const nx = this.x + Math.sin(this.heading) * this.speed * dt, nz = this.z + Math.cos(this.heading) * this.speed * dt;
    if (floorAt(nx, nz) > this.y + 1) this.speed *= -0.25; else { this.x = nx; this.z = nz; }
    this.y += this.vy * dt;
    const floor = floorAt(this.x, this.z);
    if (this.y < floor) { this.y = floor; this.vy = Math.max(0, this.vy); }
    this.y = Math.min(this.y, 1200);
    // it leans into its speed and banks into its turns; the rotors turn
    this.pitch += ((this.speed / top) * 0.24 - this.pitch) * Math.min(1, dt * 5);
    this.roll += (-yaw * 0.28 - this.roll) * Math.min(1, dt * 5);
    this.spin += dt * 38;
    const u = this.model.userData;
    u.tilt.rotation.set(this.pitch, 0, this.roll); u.rotor.rotation.y = this.spin; u.tail.rotation.x = this.spin * 1.6;
    u.tilt.position.y = Math.sin(this.spin * 0.07) * 0.15;
    this.model.position.set(this.x, this.y, this.z); this.model.rotation.y = this.heading;
    // the lights: the strobe flashes, the beacon pulses
    const t = this.spin / 38;
    u.strobe.visible = t % 1.2 < 0.06; u.beacon.material.color.setRGB(5 * (0.5 + 0.5 * Math.sin(t * 6)) ** 4 + 0.1, 0.15, 0.1);
    // the searchlight, at night: aimed ahead and down, its pool as wide as the cone is at the ground
    const night = shared.uNight.value, on = night > 0.25;
    this.spot.visible = this.beam.visible = on;
    if (on) {
      const ahead = 0.55 + Math.min(1, Math.abs(this.speed) / 30) * 0.5, s = Math.sin(this.heading), c = Math.cos(this.heading);
      const lamp = new THREE.Vector3(this.x + s * 1.6, this.y + 0.9, this.z + c * 1.6);
      let tx = lamp.x, tz = lamp.z, ty = 0;
      // (along the slant, the ground where the beam meets it: a few steps are near enough)
      for (let i = 0; i < 3; i++) { ty = Math.max(this.surface(tx, tz, -2), this.roofs.top(tx, tz)); const drop = Math.max(5, lamp.y - ty); tx = lamp.x + s * drop * ahead; tz = lamp.z + c * drop * ahead; }
      const to = new THREE.Vector3(tx, ty, tz), len = lamp.distanceTo(to), r = Math.max(4, len * 0.13);
      this.spot.position.set(tx, ty + 0.2, tz); this.spot.scale.set(r * 2.4, 1, r * 2.4 * (1 + ahead * 0.6));
      this.spot.rotation.y = this.heading;
      this.spot.material.color.setRGB(1.7, 1.6, 1.45).multiplyScalar(Math.min(1.3, 110 / Math.max(50, len)));
      this.beam.position.copy(lamp); this.beam.scale.set(r, len, r);
      this.beam.quaternion.setFromUnitVectors(new THREE.Vector3(0, -1, 0), to.sub(lamp).normalize());
      this.beam.material.opacity = 0.07 * Math.min(1, (night - 0.25) * 3);
    }
    this.view = { x: this.x, y: this.y, z: this.z, heading: this.heading, speed: Math.abs(this.speed), kmh: Math.abs(this.speed) * 3.6, bump: 0, reversing: false, height: 3, altitude: this.y - floor + 2 };
  }
}
