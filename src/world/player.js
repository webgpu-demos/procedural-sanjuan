// On foot and in the air: the other ways round the city besides the car (drive.js), with the same face to the
// rest of the page: start(x, z, heading, y), stop(), update(dt, keys), view { x, y, z, heading, speed, kmh }.
//   walking    W / S walk on and back, A / D turn, Shift run, Space jump, F sit on the seat beside him (and get up);
//              he sets off, stops from the foot he is on and turns on the spot as the crowd does (MotionBricks: MOVES);
//              stopped by the buildings' walls and the water's edge, on the ground or the deck walked onto
//   cycling    a bicycle: W pedal, S brake (and back a little), A / D steer, Shift a sprint, Space the brakes; it
//              leans into its turns; stopped by the walls like the walker
//   flying     a helicopter: W / S pitch forward and back, A / D yaw, Space / E climb, C / Q come down, Shift a
//              push; it banks into its turns, leans into its speed, its rotors turn; it does not go under the ground
// (the motion after the controllers of mrdoob's Slop New York, MIT: github.com/mrdoob/slop-newyork)
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneRig } from 'three/addons/utils/SkeletonUtils.js';
import { Walls, Roofs } from './drive.js';
import { heroLit, lampMaterial, LAMP_LAYER } from './lamplight.js';
import { shared } from './materials.js';
import { streetAt } from '../shared/decks.js';

const keyOf = (keys) => (...c) => c.some((x) => keys.has(x));
const mat = (color, roughness = 0.7, metalness = 0) => heroLit(new THREE.MeshStandardMaterial({ color, roughness, metalness }));

// ---------------------------------------------------------------- a person of the Rocketbox library
// Male_Adult_01 of Microsoft's Rocketbox avatars (MIT: public/models/people/README.md), a man in a striped polo,
// shorts and sneakers, with his own idle, walk and run (in place) and a seated pose. Loaded once; the walker and the
// rider each get a copy. Till he has come (or if he cannot), the figure of shapes below stands in.
const V = () => new THREE.Vector3();
let PERSON = null;
function loadPerson() {
  return (PERSON ??= new GLTFLoader().loadAsync('models/people/m01.glb').then((g) => {
    g.scene.traverse((o) => {
      if (!o.isMesh) return;
      o.castShadow = true; o.frustumCulled = false; // (skinned: its bounds are the bind pose's)
      const m = o.material;
      if (m.name.includes('opacity')) Object.assign(m, { transparent: false, alphaTest: 0.45, depthWrite: true, side: THREE.DoubleSide }); // (hair, lashes)
      heroLit(m);
    });
    g.speeds = { walk: strideSpeed(g, 'walk'), run: strideSpeed(g, 'run') };
    return g;
  }).catch((e) => { console.warn('the walker stays a figure of shapes:', e); return null; }));
}
// How fast a clip walks, and the clip put in place: the walk and the run carry him forward (the pelvis travels
// through the cycle, the planted foot stays put); that travel over the cycle is the clip's speed, and taken out of
// the pelvis's track, step by step, the clip loops on the spot for the walker to carry along at the speed it goes
function strideSpeed(g, name) {
  const clip = g.animations.find((c) => c.name === name), track = clip?.tracks.find((t) => t.name === 'Bip01_Pelvis.position');
  if (!track) return 1.4;
  const root = cloneRig(g.scene), mixer = new THREE.AnimationMixer(root), pelvis = root.getObjectByName('Bip01_Pelvis');
  mixer.clipAction(clip).play();
  const at = (t) => { mixer.setTime(t); root.updateMatrixWorld(true); return pelvis.getWorldPosition(V()); };
  const T = clip.duration, a = at(0), b = at(T - 1e-4), speed = Math.hypot(b.x - a.x, b.z - a.z) / T;
  const n = track.times.length, v = track.values, t0 = track.times[0], span = track.times[n - 1] - t0;
  const d = [0, 1, 2].map((c) => v[(n - 1) * 3 + c] - v[c]);
  for (let k = 0; k < n; k++) { const f = (track.times[k] - t0) / span; for (let c = 0; c < 3; c++) v[k * 3 + c] -= d[c] * f; }
  return speed;
}
// His moves, made by NVIDIA's MotionBricks (tools/motion: transitions.py the crowd's, walker.py his own) on the rig of
// the crowd's man, whose bones rest as his do: setting off (start), stopping from either foot (stopL, stopR),
// standing up from a seat (standup), sitting down on one behind him (sitdown), turning where he stands (turnL,
// turnR, turnB). Each carries him as it goes: the pelvis's travel and turn, key by key, taken out of its track and
// kept (travel: metres forward of where it began; yaw: radians turned, about the vertical as the walker's heading
// counts), for the walker to be carried along and round by.
let MOVES = null;
function loadMoves() {
  const loader = new GLTFLoader();
  return (MOVES ??= Promise.all(['models/people/crowd/m-moves.glb', 'models/people/crowd/m-turns.glb'].map((u) => loader.loadAsync(u)))
    .then((gs) => Object.assign({}, ...gs.map(prepareMoves)))
    .catch((e) => { console.warn('the walker keeps to his blends:', e); return null; }));
}
function prepareMoves(g) {
  const Q = () => new THREE.Quaternion(), out = {};
  g.scene.updateMatrixWorld(true);
  const pelvis = g.scene.getObjectByName('Bip01_Pelvis'), ahead = V();
  for (const s of ['L', 'R']) {
    const f = g.scene.getObjectByName(`Bip01_${s}_Foot`), t = g.scene.getObjectByName(`Bip01_${s}_Toe0`);
    if (f && t) ahead.add(t.getWorldPosition(V()).sub(f.getWorldPosition(V())));
  }
  ahead.y = 0; ahead.normalize();
  const parentQ = pelvis.parent.getWorldQuaternion(Q()), toParent = parentQ.clone().invert(), m3 = new THREE.Matrix3().setFromMatrix4(pelvis.parent.matrixWorld).invert();
  const up = new THREE.Vector3(0, 1, 0).applyQuaternion(toParent); // (the vertical, in the pelvis's parent's frame)
  const mixer = new THREE.AnimationMixer(g.scene);
  for (const clip of g.animations) {
    clip.tracks = clip.tracks.filter((t) => t.name.endsWith('.quaternion') || t.name === 'Bip01_Pelvis.position');
    const pos = clip.tracks.find((t) => t.name === 'Bip01_Pelvis.position'), rot = clip.tracks.find((t) => t.name === 'Bip01_Pelvis.quaternion');
    if (!pos || !rot || pos.times.length !== rot.times.length) continue;
    const a = mixer.clipAction(clip); a.play();
    const end = clip.duration - 1e-4, at = (t) => { mixer.setTime(Math.min(t, end)); g.scene.updateMatrixWorld(true); return [pelvis.getWorldPosition(V()), pelvis.getWorldQuaternion(Q())]; };
    const n = pos.times.length, [p0, q0] = at(pos.times[0]), q0i = q0.clone().invert(), travel = new Float32Array(n), yaw = new Float32Array(n), shifts = [];
    for (let i = 0; i < n; i++) {
      const [p, q] = at(pos.times[i]), d = p.sub(p0); d.y = 0;
      travel[i] = d.dot(ahead); shifts.push(d.applyMatrix3(m3));
      const f = ahead.clone().applyQuaternion(q.multiply(q0i)); yaw[i] = Math.atan2(f.x * ahead.z - f.z * ahead.x, f.x * ahead.x + f.z * ahead.z);
    }
    a.stop(); mixer.uncacheClip(clip);
    // (out of the tracks: the travel, and the turn, about the vertical in the pelvis's parent's frame)
    const v = pos.values, r = rot.values, k = Q(), yq = Q();
    for (let i = 0; i < n; i++) {
      v[i * 3] -= shifts[i].x; v[i * 3 + 1] -= shifts[i].y; v[i * 3 + 2] -= shifts[i].z;
      yq.setFromAxisAngle(up, -yaw[i]); k.fromArray(r, i * 4).premultiply(yq).toArray(r, i * 4);
    }
    out[clip.name] = { clip, times: Float32Array.from(pos.times), travel, yaw, duration: clip.duration, reach: travel[n - 1], turn: yaw[n - 1] };
  }
  return out;
}
// (a move's travel and turn at time t)
const moveAt = (c, t) => {
  const T = c.times, n = T.length;
  let i = 0; while (i < n - 2 && T[i + 1] < t) i++;
  const w = Math.max(0, Math.min(1, (t - T[i]) / ((T[i + 1] - T[i]) || 1)));
  return [c.travel[i] + (c.travel[i + 1] - c.travel[i]) * w, c.yaw[i] + (c.yaw[i + 1] - c.yaw[i]) * w];
};

// A copy of him: his skeleton, his clips; turned to face +z (the way the walker goes)
class Rig {
  constructor(g) {
    this.root = cloneRig(g.scene); this.speeds = g.speeds;
    this.mixer = new THREE.AnimationMixer(this.root);
    this.clip = Object.fromEntries(g.animations.map((c) => [c.name, this.mixer.clipAction(c)]));
    this.bone = (n) => this.root.getObjectByName(n);
    this.root.updateMatrixWorld(true);
    // (the way the feet point, the two of them: each turns out a little)
    const ahead = V();
    for (const s of ['L', 'R']) ahead.add(this.bone(`Bip01_${s}_Toe0`).getWorldPosition(V()).sub(this.bone(`Bip01_${s}_Foot`).getWorldPosition(V())));
    this.turn = new THREE.Group(); this.turn.rotation.y = -Math.atan2(ahead.x, ahead.z); this.turn.add(this.root);
  }
  play(weights) { for (const [n, w] of Object.entries(weights)) { const a = this.clip[n]; if (!a || (!w && !a.isRunning())) continue; if (!a.isRunning()) a.play(); a.setEffectiveWeight(w); } }
}
// Bones turned in the world: so that the bone points from itself through its child at `target` (aim), or about an axis
const _q = new THREE.Quaternion(), _p = new THREE.Quaternion(), _a = V(), _b = V(), _c = V();
function aim(bone, child, target) {
  bone.getWorldPosition(_a); child.getWorldPosition(_b);
  _q.setFromUnitVectors(_b.sub(_a).normalize(), _c.copy(target).sub(_a).normalize());
  turnWorld(bone, _q);
}
function turnWorld(bone, q) {
  bone.parent.getWorldQuaternion(_p);
  bone.quaternion.premultiply(_p.clone().invert().multiply(q).multiply(_p));
  bone.updateMatrixWorld(true);
}
// Two bones (thigh and calf, upper arm and forearm) reaching `target`, the joint between them bent towards `pole`
function reach(upper, lower, end, target, pole) {
  const H = upper.getWorldPosition(V()), a = H.distanceTo(lower.getWorldPosition(V())), b = lower.getWorldPosition(V()).distanceTo(end.getWorldPosition(V()));
  const to = target.clone().sub(H), d = THREE.MathUtils.clamp(to.length(), Math.abs(a - b) + 0.01, a + b - 0.005), dir = to.normalize();
  const x = (a * a - b * b + d * d) / (2 * d), h = Math.sqrt(Math.max(0, a * a - x * x));
  const side = pole.clone().sub(H); side.sub(dir.clone().multiplyScalar(side.dot(dir))).normalize();
  const joint = H.clone().addScaledVector(dir, x).addScaledVector(side, h);
  aim(upper, lower, joint);
  aim(lower, end, H.clone().addScaledVector(dir, d));
}

// ---------------------------------------------------------------- a person of shapes (till he has come)
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

// The water's edge for one on foot or on a bike at p (the sea, a lagoon, a river: streamer.wet), unless a deck
// crosses it there at their height; set down in the water, they come out of it
const water = (p, x, z) => p.wet(x, z) && !p.wet(p.x, p.z) && p.decks?.at(x, z, p.y + 0.3, 2.4) == null;

export class Walker {
  // seats(x, z): the seat nearest (x, z) within reach, { x, z, heading } (facing out), or null (main.js: the crowd's)
  constructor({ scene, surface, sim, tiles, lift = () => 0, decks = null, wet = () => false, seats = () => null }) {
    this.decks = decks; // (the decks the flyovers draw: roadlevel.js)
    this.surface = surface; this.sim = sim; this.walls = new Walls(tiles); this.lift = lift; // (lift: the paving's height over the terrain)
    this.wet = wet; // (water no road crosses, and beyond the city: streamer.wet)
    this.seats = seats;
    this.on = false; this.label = 'A pie'; this.unit = 'km/h';
    this.model = new THREE.Group(); this.figure = person(); this.model.add(this.figure); this.model.visible = false; scene.add(this.model);
    loadPerson().then((g) => {
      if (!g) return;
      this.rig = new Rig(g); this.model.remove(this.figure); this.model.add(this.rig.turn);
      loadMoves().then((m) => { if (!m || !this.rig) return; this.moves = m; for (const [n, c] of Object.entries(m)) this.rig.clip[n] = this.rig.mixer.clipAction(c.clip); });
    });
    this.view = null;
  }
  start(x, z, heading, y = null) {
    Object.assign(this, { x, z, heading, speed: 0, vy: 0, phase: 0, y: y ?? streetAt(this.surface, x, z, this.surface(x, z, -2)) + this.lift(x, z), on: true, move: null, seated: false, fWas: false, base: { idle: 1 } });
    this.model.visible = true;
  }
  // A move begun (MOVES): from where he stands, the way he faces; `then`: what he is doing at its end (idle, walk,
  // sit), blended out of the move into it
  begin(name, then, k = 1) {
    const c = this.moves?.[name];
    if (!c) return false;
    this.move = { name, c, t: 0, x0: this.x, z0: this.z, h0: this.heading, then, k };
    const a = this.rig.clip[name]; a.reset(); a.timeScale = 0; a.play();
    return true;
  }
  // a turn on the spot the way asked (+1: the heading growing, A), whichever of the clips turns that way
  turnClip(sign) { for (const n of ['turnL', 'turnR']) if (this.moves?.[n] && Math.sign(this.moves[n].turn) === sign) return n; return null; }
  // the stop that starts nearest the walk's step (its clips begin at 30% and 78% of the walk's cycle)
  stopClip() {
    const w = this.rig.clip.walk, f = w.isRunning() ? (w.time / w.getClip().duration) % 1 : 0, d = (x) => Math.min(Math.abs(f - x), 1 - Math.abs(f - x));
    return d(0.3) <= d(0.78) ? 'stopL' : 'stopR';
  }
  stop() { this.on = false; this.model.visible = false; this.view = null; this.move = null; this.seated = false; }
  // The rig's weights: the base blend (this.base: idle, walk, run, sit) under a move weighing m (0 to 1), any other clip
  // let go
  pose(dt, m, move = null) {
    const r = this.rig, w = {};
    for (const n of Object.keys(r.clip)) w[n] = 0;
    for (const [n, b] of Object.entries(this.base)) w[n] = b * (1 - m);
    if (move) w[move] = m;
    r.play(w);
  }
  // A move's frame: carried along and round by its travel and turn (stopped short by a wall or the water's edge),
  // blended in over its first fifth of a second and out into what comes after over its last; at its end, that.
  // seated: held in the seat, nothing moving
  moving(dt, k, seated = false) {
    const r = this.rig, mv = this.move;
    // (a stop or a turn let go of, W pressed again: walking on, or setting off, from where he is)
    if (mv && k('KeyW', 'ArrowUp') && (mv.name.startsWith('stop') || mv.name.startsWith('turn'))) {
      this.move = null; r.clip[mv.name].stop();
      if (mv.name.startsWith('stop')) { this.speed = r.speeds.walk; this.base = { walk: 1 }; } else this.base = { idle: 1 };
      return this.moving(dt, k);
    }
    if (mv) {
      const c = mv.c, B = 0.18;
      mv.t = Math.min(c.duration, mv.t + dt);
      const [d, yaw] = moveAt(c, mv.t), x = mv.x0 + Math.sin(mv.h0) * d * mv.k, z = mv.z0 + Math.cos(mv.h0) * d * mv.k;
      const free = (x, z) => !this.walls.blocked(x, z) && !water(this, x, z) && !this.collider?.blocked([this.x, this.z, this.x, this.z], [x, z, x, z], 0.28, this.y);
      if (mv.then === 'sit' || free(x, z)) { this.x = x; this.z = z; } else mv.t = c.duration; // (into a wall: done)
      this.heading = mv.h0 + yaw;
      const W = r.speeds.walk;
      // (blending out into what comes after: walking on at the walk's pace, standing, seated)
      if (mv.then === 'walk') { this.base = { walk: 1 }; r.clip.walk.timeScale = 1; } else if (mv.then === 'sit') this.base = { sit: 1 }; else this.base = { idle: 1 };
      const m = Math.min(1, mv.t / B, (c.duration - mv.t) / B + (mv.t >= c.duration ? 0 : 0.0001));
      r.clip[mv.name].time = mv.t;
      this.pose(dt, Math.max(0, m), mv.name);
      if (mv.t >= c.duration) {
        this.move = null;
        this.speed = mv.then === 'walk' ? W : 0; this.seated = mv.then === 'sit';
        if (mv.then === 'walk') r.clip.walk.time = 0;
      } else this.speed = 0;
    }
    const floor = this.floor(this.x, this.z);
    this.y += (floor - this.y) * Math.min(1, dt * 12); this.vy = 0;
    this.model.rotation.y = this.heading;
    r.mixer.update(dt);
    this.model.position.set(this.x, this.y, this.z);
    const v = mv && !seated ? Math.abs(moveAt(mv.c, Math.min(mv.c.duration, mv.t + 0.05))[0] - moveAt(mv.c, mv.t)[0]) / 0.05 : 0;
    this.view = { x: this.x, y: this.y, z: this.z, heading: this.heading, speed: v, kmh: v * 3.6, bump: 0, reversing: false, height: this.seated ? 1.25 : 1.7 };
  }
  // the ground under (x, z), or the deck at about this height (a walkway, a flyover)
  floor(x, z) {
    // (the street as drawn, a bridge's deck at street level included; on the sidewalk, not in it)
    const ground = streetAt(this.surface, x, z, this.y) + this.lift(x, z), deck = this.decks?.at(x, z, this.y + 0.3, 2.4) ?? null;
    return deck != null && Math.abs(deck - this.y) < 1.2 ? deck : ground;
  }
  update(dt, keys) {
    if (!this.on) return;
    dt = Math.min(dt, 0.05);
    const k = keyOf(keys), run = k('ShiftLeft', 'ShiftRight'), top = run ? 4.2 : 1.4;
    const fwd = (k('KeyW', 'ArrowUp') ? 1 : 0) - (k('KeyS', 'ArrowDown') ? 0.65 : 0), turn = (k('KeyA', 'ArrowLeft') ? 1 : 0) - (k('KeyD', 'ArrowRight') ? 1 : 0);
    const sit = k('KeyF') && !this.fWas; this.fWas = k('KeyF');
    // his moves (MOVES), where he has them: setting off and stopping at a walk, turning where he stands, sitting on a
    // seat (F, beside one) and getting up (F or W); running, backing up and jumping as before
    if (this.moves && this.rig && this.y <= this.floor(this.x, this.z) + 0.03) {
      const W = this.rig.speeds.walk, still = Math.abs(this.speed) < 0.15;
      if (this.move) return this.moving(dt, k);
      if (this.seated) {
        if (sit || fwd > 0) this.begin('standup', 'idle');
        else { this.base = { sit: 1 }; this.pose(dt, 0); }
        return this.moving(dt, k, true);
      }
      if (sit && still) {
        const s = this.seats(this.x, this.z), c = this.moves.sitdown;
        if (s && c) {
          // stood where the sitting down ends on the seat, facing out, then down
          this.x = s.x - Math.sin(s.heading) * c.reach; this.z = s.z - Math.cos(s.heading) * c.reach; this.heading = s.heading;
          if (this.begin('sitdown', 'sit')) return this.moving(dt, k);
        }
      }
      if (still && fwd > 0 && !run && this.begin('start', 'walk')) return this.moving(dt, k);
      if (still && !fwd && turn) { const n = this.turnClip(turn); if (n && this.begin(n, 'idle')) return this.moving(dt, k); }
      if (fwd === 0 && !run && this.speed > W * 0.6 && this.speed < W * 1.3 && this.begin(this.stopClip(), 'idle')) return this.moving(dt, k);
    }
    this.heading += turn * 2.6 * dt;
    this.speed += (fwd * top - this.speed) * Math.min(1, dt * 10);
    const nx = this.x + Math.sin(this.heading) * this.speed * dt, nz = this.z + Math.cos(this.heading) * this.speed * dt;
    // a wall, a pole, a tree, a car (collide.js) in the way: slide along it (one axis at a time), or stop
    const free = (x, z) => !this.walls.blocked(x, z) && !water(this, x, z) && !this.collider?.blocked([this.x, this.z, this.x, this.z], [x, z, x, z], 0.28, this.y);
    if (free(nx, nz)) { this.x = nx; this.z = nz; }
    else if (free(nx, this.z)) this.x = nx;
    else if (free(this.x, nz)) this.z = nz;
    else this.speed = 0;
    // up and down: a jump, and gravity
    const floor = this.floor(this.x, this.z), grounded = this.y <= floor + 0.03;
    if (k('Space') && grounded) this.vy = 5.2;
    this.vy -= 14.5 * dt;
    this.y += this.vy * dt;
    if (this.y < floor) { this.y = floor; this.vy = 0; }
    if (grounded && this.y > floor + 0.5 && this.vy <= 0) this.y = floor; // (stepping down a kerb, not falling)
    const v = Math.abs(this.speed);
    this.model.rotation.y = this.heading;
    this.view = { x: this.x, y: this.y, z: this.z, heading: this.heading, speed: v, kmh: v * 3.6, bump: 0, reversing: this.speed < -0.1, height: 1.7 };
    if (this.rig) {
      // his own steps: standing, walking, running by the speed, each clip played at the pace that keeps the
      // planted foot where it is (backing up, the walk played backwards)
      const r = this.rig, W = r.speeds.walk, R = r.speeds.run, still = 1 - THREE.MathUtils.smoothstep(v, 0.05, 0.45), ran = THREE.MathUtils.smoothstep(v, W * 1.3, R * 0.85);
      this.base = { idle: still, walk: (1 - still) * (1 - ran), run: (1 - still) * ran };
      this.pose(dt, 0);
      r.clip.walk.timeScale = (this.speed < -0.05 ? -1 : 1) * Math.max(0.5, v / W); r.clip.run.timeScale = Math.max(0.7, v / R);
      r.mixer.update(dt);
      this.model.position.set(this.x, this.y, this.z);
      return;
    }
    // the figure of shapes: legs and arms swing with the speed, the body bobs
    this.phase += v * dt * (run ? 1.9 : 3.4);
    const swing = Math.min(0.8, v * 0.35) * Math.sin(this.phase), u = this.figure.userData;
    u.legL.rotation.x = swing; u.legR.rotation.x = -swing; u.armL.rotation.x = -swing * 0.8; u.armR.rotation.x = swing * 0.8;
    // the knee bends as the leg comes through, the elbows a little more running
    const bend = Math.min(1, v * 0.4);
    u.legL.lower.rotation.x = bend * Math.max(0, -Math.cos(this.phase)) * 0.9; u.legR.lower.rotation.x = bend * Math.max(0, Math.cos(this.phase)) * 0.9; // (+: the foot back)
    u.armL.lower.rotation.x = u.armR.lower.rotation.x = -0.25 - bend * (run ? 0.9 : 0.25);
    this.model.position.set(this.x, this.y + Math.abs(Math.sin(this.phase)) * Math.min(0.06, v * 0.02), this.z);
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
  const crank = new THREE.Group(), pedals = []; crank.position.set(0, ...bb.slice(1));
  for (const sx of [1, -1]) { const arm = bar([sx * 0.07, 0, 0], [sx * 0.07, -0.17, 0], 0.01, steel); const pedal = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.02, 0.06), black); pedal.position.set(sx * 0.11, -0.17, 0); const p = new THREE.Group(); p.rotation.x = sx > 0 ? 0 : Math.PI; p.add(arm, pedal); crank.add(p); pedals.push(pedal); }
  g.add(crank);
  // the rider: the walker, seated (hips on the saddle), leaning to the bars
  const rider = person(), seatAt = new THREE.Group();
  seatAt.position.set(0, 0.97, -0.2); rider.position.y = -0.9; seatAt.add(rider); g.add(seatAt);
  seatAt.rotation.x = 0.42;
  const u = rider.userData;
  u.armL.rotation.x = u.armR.rotation.x = -1.05; u.armL.lower.rotation.x = u.armR.lower.rotation.x = -0.25;
  u.armL.rotation.z = -0.12; u.armR.rotation.z = 0.12;
  g.userData = { wheels: [wr, wf], crank, rider: u, seatAt, pedals }; // (pedals: the left one (+x), the right)
  return g;
}

export class Cyclist {
  constructor({ scene, surface, sim, tiles, lift = () => 0, decks = null, wet = () => false }) {
    this.decks = decks; // (the decks the flyovers draw: roadlevel.js)
    this.surface = surface; this.sim = sim; this.walls = new Walls(tiles); this.lift = lift; // (lift: the paving's height over the terrain)
    this.wet = wet; // (water no road crosses, and beyond the city: streamer.wet)
    this.on = false; this.label = 'Bicicleta'; this.unit = 'km/h';
    this.model = bicycle(); this.model.visible = false; scene.add(this.model);
    // the Rocketbox man in the saddle, when he has come (seated, his feet and hands put on the pedals and the bars)
    loadPerson().then((g) => {
      if (!g) return;
      this.rig = new Rig(g); this.model.remove(this.model.userData.seatAt); this.model.add(this.rig.turn);
      // the seated pose, kept: put back each frame before the reaching (a mixer leaves a pose that does not change
      // alone, so what was done to it the frame before would pile up)
      this.rig.play({ sit: 1 }); this.rig.mixer.update(0);
      this.seated = []; this.rig.root.traverse((o) => { if (o.isBone) this.seated.push([o, o.quaternion.clone(), o.position.clone()]); });
    });
    this.view = null;
  }
  // The rider: the seated pose, the pelvis on the saddle, leaning over the bars; the legs reach for the pedals
  // (knees forward), the arms for the grips (elbows out)
  pose() {
    const r = this.rig, B = r.bone, m = this.model, u = m.userData;
    for (const [bone, q, p] of this.seated) { bone.quaternion.copy(q); bone.position.copy(p); }
    m.updateMatrixWorld(true);
    const want = m.localToWorld(V().set(0, 1.0, -0.26)), at = B('Bip01_Pelvis').getWorldPosition(V());
    r.turn.position.add(m.worldToLocal(want).sub(m.worldToLocal(at)));
    r.turn.updateMatrixWorld(true);
    const fwd = V().set(0, 0, 1).transformDirection(m.matrixWorld), up = V().set(0, 1, 0).transformDirection(m.matrixWorld), left = V().set(1, 0, 0).transformDirection(m.matrixWorld);
    turnWorld(B('Bip01_Spine'), _q.setFromAxisAngle(left, 0.18));
    for (const [s, side, pedal] of [['L', 1, u.pedals[0]], ['R', -1, u.pedals[1]]]) {
      const foot = pedal.getWorldPosition(V()).addScaledVector(up, 0.07).addScaledVector(fwd, -0.04), hip = B(`Bip01_${s}_Thigh`).getWorldPosition(V());
      reach(B(`Bip01_${s}_Thigh`), B(`Bip01_${s}_Calf`), B(`Bip01_${s}_Foot`), foot, hip.addScaledVector(fwd, 1).addScaledVector(up, 0.4));
      const grip = m.localToWorld(V().set(side * 0.24, 1.0, 0.3)), shoulder = B(`Bip01_${s}_UpperArm`).getWorldPosition(V());
      reach(B(`Bip01_${s}_UpperArm`), B(`Bip01_${s}_Forearm`), B(`Bip01_${s}_Hand`), grip, shoulder.addScaledVector(fwd, -0.4).addScaledVector(left, side * 0.6).addScaledVector(up, -0.4));
    }
  }
  start(x, z, heading, y = null) {
    Object.assign(this, { x, z, heading, speed: 0, lean: 0, crank: 0, roll: 0, y: y ?? streetAt(this.surface, x, z, this.surface(x, z, -2)) + this.lift(x, z), on: true });
    this.model.visible = true;
  }
  stop() { this.on = false; this.model.visible = false; this.view = null; }
  floor(x, z) {
    // (the street as drawn, a bridge's deck at street level included; on the sidewalk, not in it)
    const ground = streetAt(this.surface, x, z, this.y) + this.lift(x, z), deck = this.decks?.at(x, z, this.y + 0.3, 2.4) ?? null;
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
    // the walls, and the street's things and the vehicles (collide.js: the bike a capsule its length): slide or stop
    const hs = Math.sin(this.heading) * 0.55, hc = Math.cos(this.heading) * 0.55, from = [this.x - hs, this.z - hc, this.x + hs, this.z + hc];
    const free = (x, z) => !this.walls.blocked(x + hs, z + hc) && !water(this, x + hs, z + hc) && !this.collider?.blocked(from, [x - hs, z - hc, x + hs, z + hc], 0.3, this.y);
    if (free(nx, nz)) { this.x = nx; this.z = nz; }
    else if (free(nx, this.z)) this.x = nx;
    else if (free(this.x, nz)) this.z = nz;
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
    this.model.position.set(this.x, this.y, this.z);
    this.model.rotation.set(0, this.heading, 0); this.model.rotateZ(this.lean);
    if (this.rig) this.pose();
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
