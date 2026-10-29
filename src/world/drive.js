// Driving: the visitor's own car, out in the simulated morning. W / S (or ↑ / ↓) throttle and brake (reverse
// from a stop), A / D steer, Space the handbrake (the tail steps out), Shift a push; E gets in and out.
//
// Arcade physics on a bicycle model: the engine pulls less as the speed rises, the steering lock closes with
// speed, the car's course follows where it points with grip (little under the handbrake: a slide). It rides
// the ground, or a deck it drove onto (a flyover, a ramp: it stays up there; driving under one, it stays under).
// It stops against the walls of the buildings (their wall faces, rasterized into a grid as the tiles come near)
// and against the simulated cars, which cannot swerve (they keep to their recorded way): one that would drive
// through it fades out instead (simtraffic.js, probe).
import * as THREE from 'three';
import { vehicleCapsule } from './collide.js';
import { TYPES, beamGeometry, beamTexture } from './traffic.js';
import { BODY_SPECS, buildCarGeometry, carStyleCode } from './carbodies.js';
import { loftedCarMaterial, carDepth } from './carmaterial.js';
import { wheelBlur } from './fleet.js';
import { LAMP_LAYER, lampMaterial } from './lamplight.js';
import { streetAt } from '../shared/decks.js';

const CELL = 1.5;              // wall grid (m)
const WHEELBASE = 2.8, TOP = 44, BOOST = 58, REVERSE = 9;
const smooth = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

// The walls of the buildings near a point: their faces that stand up, each laid down as the cells of a grid
// it runs through, built per tile as the tiles come near (tiles(): the scene's tile groups).
export class Walls {
  constructor(tiles) { this.tiles = tiles; this.cells = new Map(); }
  of(tile) {
    let cells = this.cells.get(tile.name);
    if (cells) return cells;
    cells = new Set();
    tile.traverse((o) => {
      if (!o.isMesh || !o.userData.facade) return;
      const pos = o.geometry.attributes.position.array, nor = o.geometry.attributes.normal.array, idx = o.geometry.index?.array;
      const n = idx ? idx.length : pos.length / 3;
      for (let t = 0; t < n; t += 3) {
        const a = idx ? idx[t] : t, b = idx ? idx[t + 1] : t + 1, c = idx ? idx[t + 2] : t + 2;
        if (Math.abs(nor[a * 3 + 1]) > 0.3) continue; // (a roof)
        // the wall's footprint: the two corners farthest apart on the ground
        const P = [a, b, c].map((v) => [pos[v * 3], pos[v * 3 + 2]]);
        let i = 0, j = 1, best = -1;
        for (const [u, w] of [[0, 1], [1, 2], [0, 2]]) { const d = (P[u][0] - P[w][0]) ** 2 + (P[u][1] - P[w][1]) ** 2; if (d > best) { best = d; i = u; j = w; } }
        const len = Math.sqrt(best), steps = Math.max(1, Math.ceil(len / (CELL * 0.5)));
        for (let s = 0; s <= steps; s++) {
          const f = s / steps, x = P[i][0] + (P[j][0] - P[i][0]) * f, z = P[i][1] + (P[j][1] - P[i][1]) * f;
          cells.add(Math.floor(x / CELL) + ',' + Math.floor(z / CELL));
        }
      }
    });
    this.cells.set(tile.name, cells);
    if (this.cells.size > 60) this.cells.delete(this.cells.keys().next().value); // (the oldest)
    return cells;
  }
  blocked(x, z) {
    const key = Math.floor(x / CELL) + ',' + Math.floor(z / CELL);
    for (const tile of this.tiles()) {
      const b = tile.userData.box ??= new THREE.Box3().setFromObject(tile);
      if (x < b.min.x - 2 || x > b.max.x + 2 || z < b.min.z - 2 || z > b.max.z + 2) continue;
      if (this.of(tile).has(key)) return true;
    }
    return false;
  }
}

// The tops of the buildings, for the helicopter: in each 4 m cell, the height of the roof over it (sampled over
// the roofs' triangles), worked out for a tile the first time something flies over it.
const ROOF = 4;
export class Roofs {
  constructor(tiles) { this.tiles = tiles; this.cells = new Map(); }
  of(tile) {
    let cells = this.cells.get(tile.name);
    if (cells) return cells;
    cells = new Map();
    const put = (x, z, y) => { const k = Math.floor(x / ROOF) + ',' + Math.floor(z / ROOF); if (!(cells.get(k) >= y)) cells.set(k, y); };
    tile.traverse((o) => {
      if (!o.isMesh || !o.userData.facade) return;
      const pos = o.geometry.attributes.position.array, nor = o.geometry.attributes.normal.array, idx = o.geometry.index?.array;
      const n = idx ? idx.length : pos.length / 3;
      for (let t = 0; t < n; t += 3) {
        const a = idx ? idx[t] : t, b = idx ? idx[t + 1] : t + 1, c = idx ? idx[t + 2] : t + 2;
        if (nor[a * 3 + 1] < 0.3) continue; // (a wall: the roofs cover the footprint)
        const ax = pos[a * 3], ay = pos[a * 3 + 1], az = pos[a * 3 + 2];
        const ux = pos[b * 3] - ax, uy = pos[b * 3 + 1] - ay, uz = pos[b * 3 + 2] - az, vx = pos[c * 3] - ax, vy = pos[c * 3 + 1] - ay, vz = pos[c * 3 + 2] - az;
        const nu = Math.max(1, Math.ceil(Math.hypot(ux, uz) / (ROOF * 0.7))), nv = Math.max(1, Math.ceil(Math.hypot(vx, vz) / (ROOF * 0.7)));
        for (let i = 0; i <= nu; i++) for (let j = 0; j <= nv; j++) {
          const f = i / nu, g = j / nv;
          if (f + g <= 1) put(ax + ux * f + vx * g, az + uz * f + vz * g, ay + uy * f + vy * g);
        }
      }
    });
    this.cells.set(tile.name, cells);
    if (this.cells.size > 40) this.cells.delete(this.cells.keys().next().value); // (the oldest)
    return cells;
  }
  // the roof over (x, z) itself, or -Infinity
  at(x, z) {
    const key = Math.floor(x / ROOF) + ',' + Math.floor(z / ROOF);
    for (const tile of this.tiles()) {
      const b = tile.userData.box ??= new THREE.Box3().setFromObject(tile);
      if (x < b.min.x || x > b.max.x || z < b.min.z || z > b.max.z) continue;
      const h = this.of(tile).get(key); if (h != null) return h;
    }
    return -Infinity;
  }
  // the highest roof within a cell of (x, z), or -Infinity
  top(x, z) {
    const i = Math.floor(x / ROOF), j = Math.floor(z / ROOF);
    let y = -Infinity;
    for (const tile of this.tiles()) {
      const b = tile.userData.box ??= new THREE.Box3().setFromObject(tile);
      if (x < b.min.x - ROOF || x > b.max.x + ROOF || z < b.min.z - ROOF || z > b.max.z + ROOF) continue;
      const cells = this.of(tile);
      for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) { const h = cells.get(i + di + ',' + (j + dj)); if (h > y) y = h; }
    }
    return y;
  }
}

export class Driver {
  // scene; surface(x, z, -2): the terrain; sim(): the simulated traffic (decks, the cars round about), or null;
  // tiles(): the scene's tile groups (for the walls)
  constructor({ scene, surface, sim, tiles, lift = () => 0, decks = null }) {
    this.decks = decks; // (the decks the flyovers draw: roadlevel.js)
    this.surface = surface; this.sim = sim; this.tiles = tiles; this.lift = lift; // (lift: the paving's height over the terrain)
    this.on = false; this.label = 'Sedán';
    this.spec = TYPES[1]; // a sedan: the lofted body (carbodies.js), in a clear-coated paint
    const body = BODY_SPECS.sedan, geo = buildCarGeometry(body, true);
    this.wheelR = body.wheelRadius; this.turned = 0;
    const red = new THREE.Color(0x8c1c1c); // (a red that reads against the asphalt by day and by night)
    geo.setAttribute('paintColor', new THREE.InstancedBufferAttribute(new Float32Array([red.r, red.g, red.b]), 3));
    this.state = new THREE.InstancedBufferAttribute(new Float32Array([0, 0, 0, carStyleCode({ metallic: 1, trim: 1, wheel: 1 })]), 4);
    this.wheel = new THREE.InstancedBufferAttribute(new Float32Array(2), 2);
    geo.setAttribute('carState', this.state); geo.setAttribute('aWheel', this.wheel);
    geo.setAttribute('aHide', new THREE.InstancedBufferAttribute(new Float32Array(1), 1));
    this.mesh = new THREE.InstancedMesh(geo, loftedCarMaterial(body, { hero: true }), 1);
    this.mesh.castShadow = true; this.mesh.frustumCulled = false; this.mesh.visible = false;
    this.mesh.customDepthMaterial = carDepth();
    this.beams = new THREE.InstancedMesh(beamGeometry(this.spec.L), lampMaterial(beamTexture(), { vertexColors: true }), 1);
    this.beams.instanceMatrix = this.mesh.instanceMatrix; this.beams.layers.set(LAMP_LAYER); this.beams.frustumCulled = false; this.beams.visible = false;
    scene.add(this.mesh, this.beams);
    this.m = new THREE.Matrix4();
    this.walls = new Walls(tiles);
    this.view = null;
  }

  // Into a car at (x, z), facing `heading` (radians, 0 = +z): on the ground there, or at height y if given (a
  // car set down on a bridge starts on its deck).
  start(x, z, heading, y = null) {
    this.x = x; this.z = z; this.heading = heading; this.course = heading;
    this.speed = 0; this.steer = 0; this.y = y ?? streetAt(this.surface, x, z, this.surface(x, z, -2)) + this.lift(x, z); this.pitch = 0; this.roll = 0;
    this.bump = 0; this.on = true; this.mesh.visible = this.beams.visible = true; this.parked = null;
    this.ghost = 2; // (seconds: set down in a queue of traffic, it drives out of it before anything stops it)
  }
  // Out of it: gone, or (park) left where it stopped, lamps off, to get back into (parked: its place)
  stop({ park = false } = {}) {
    this.on = false; this.view = null; this.beams.visible = false; this.state.array[0] = 0; this.state.needsUpdate = true; this.mesh.material.userData.reverse.value = 0;
    this.parked = park ? { x: this.x, z: this.z, y: this.y, heading: this.heading } : null;
    this.mesh.visible = park;
    if (this.sim()) this.sim().probe = null;
  }
  unpark() { if (!this.on) { this.parked = null; this.mesh.visible = false; } }

  // ---------------------------------------------------------------- each frame
  update(dt, keys) {
    if (!this.on) return;
    dt = Math.min(dt, 0.05);
    const k = (...c) => c.some((x) => keys.has(x));
    const gas = k('KeyW', 'ArrowUp') ? 1 : 0, brake = k('KeyS', 'ArrowDown') ? 1 : 0, hand = k('Space');
    const steerIn = (k('KeyA', 'ArrowLeft') ? 1 : 0) - (k('KeyD', 'ArrowRight') ? 1 : 0), boost = k('ShiftLeft', 'ShiftRight');
    const top = boost ? BOOST : TOP;
    let v = this.speed;
    // engine, brakes, reverse; rolling resistance and air
    if (gas) v += (v < 0 ? 14 : 5.6 * (1 - (v / top) ** 2) * (boost ? 1.6 : 1)) * dt; // (0-100 km/h in about 6 s)
    if (brake) v -= (v > 0.5 ? 16 : 5 * (1 - Math.min(1, -v / REVERSE))) * dt;
    if (!gas && !brake) v -= Math.sign(v) * Math.min(Math.abs(v), (0.5 + 0.06 * Math.abs(v)) * dt);
    if (hand) v -= Math.sign(v) * Math.min(Math.abs(v), 7 * dt);
    v = THREE.MathUtils.clamp(v, -REVERSE, top + 2);
    // steering: the lock closes as the speed rises; the wheel comes back by itself
    const lock = 0.6 / (1 + Math.abs(v) / 11);
    this.steer += (steerIn * lock - this.steer) * (1 - Math.exp(-dt * (steerIn ? 5 : 7)));
    const yaw = (v / WHEELBASE) * Math.tan(this.steer) * (hand ? 1.7 : 1);
    this.heading += yaw * dt;
    // the course follows the heading with grip (the handbrake lets go of it: a slide)
    const grip = hand ? 1.6 : 9;
    let dc = this.heading - this.course; dc = Math.atan2(Math.sin(dc), Math.cos(dc));
    this.course += dc * (1 - Math.exp(-dt * grip));
    const nx = this.x + Math.sin(this.course) * v * dt, nz = this.z + Math.cos(this.course) * v * dt;
    // walls: the nose (or the tail, backing up) and its corners
    const half = this.spec.L * 0.5, side = this.spec.spec.W * 0.5, s = Math.sin(this.heading), c = Math.cos(this.heading), dir = v >= 0 ? 1 : -1;
    const probes = [[0, half * dir], [side, half * dir * 0.85], [-side, half * dir * 0.85]];
    let hitWall = Math.abs(v) > 0.05 && probes.some(([a, b]) => this.walls.blocked(nx + c * a + s * b, nz - s * a + c * b));
    // the street's things and the vehicles round about (collide.js: the simulated cars, the traffic, the car
    // parked): one met from outside stops it; one it is already inside of it drives out of (set down in a queue,
    // the first seconds it may drive through the cars at all: ghost)
    let hitCar = null;
    this.ghost = Math.max(0, this.ghost - dt);
    const sim = this.sim();
    if (sim) sim.probe = [this.x, this.z];
    if (this.collider && Math.abs(v) > 0.05) {
      const W = this.spec.spec.W, from = vehicleCapsule(this.x, this.z, this.heading, this.spec.L, W).slice(0, 4), to = vehicleCapsule(nx, nz, this.heading, this.spec.L, W).slice(0, 4);
      const hit = this.collider.blocked(from, to, W / 2, this.y);
      if (hit && !hit.vehicle) hitWall = true;
      else if (hit && !this.ghost) hitCar = hit.vehicle;
    }
    if (hitWall || hitCar) {
      this.bump = Math.min(1, Math.abs(v) / 15); // (the camera feels it)
      v = -v * (hitWall ? 0.25 : 0.15);
      if (hitCar) v += hitCar.speed * Math.cos(hitCar.heading - this.course) * 0.4; // (pushed along by it)
    } else { this.x = nx; this.z = nz; }
    this.speed = v;
    // the ground, or the deck it is on: a deck near its height (a ramp grows out of the road a step at a time,
    // so the car climbs onto it; driving under a flyover, the deck is far above and the ground is the way)
    // (the asphalt as drawn, a bridge's deck at street level included; the kerb up onto a sidewalk)
    const ground = streetAt(this.surface, this.x, this.z, this.y) + this.lift(this.x, this.z), deck = this.decks?.at(this.x, this.z, this.y + 0.5, 2.4) ?? null;
    const want = deck != null && Math.abs(deck - this.y) < 2.4 ? deck : ground;
    // (no steeper than a road climbs: the elevation model has the odd bridge embankment in it, a wall to drive into)
    const moved = Math.hypot(nx - this.x, nz - this.z) + Math.abs(v) * dt, climb = 0.35 * moved + 0.02;
    this.y += THREE.MathUtils.clamp((want - this.y) * (1 - Math.exp(-dt * 12)), -climb * 2, climb);
    // pitch and roll from the ground under the wheels (on a deck: level)
    if (want === ground) {
      const f = this.surface(this.x + s * 1.4, this.z + c * 1.4, -2) - this.surface(this.x - s * 1.4, this.z - c * 1.4, -2);
      const r = this.surface(this.x + c * 0.9, this.z - s * 0.9, -2) - this.surface(this.x - c * 0.9, this.z + s * 0.9, -2);
      this.pitch += (-Math.atan(f / 2.8) - this.pitch) * (1 - Math.exp(-dt * 8));
      this.roll += (Math.atan(r / 1.8) - this.roll) * (1 - Math.exp(-dt * 8));
    } else { this.pitch *= Math.exp(-dt * 8); this.roll *= Math.exp(-dt * 8); }
    // the body leans out of a turn and dips under the brakes
    const lean = THREE.MathUtils.clamp(yaw * v * 0.012, -0.06, 0.06), dive = brake && v > 1 ? 0.025 : gas ? -0.012 : 0;
    this.bump *= Math.exp(-dt * 6);
    const m = this.m;
    m.makeRotationY(this.heading).multiply(new THREE.Matrix4().makeRotationX(-this.pitch + dive)).multiply(new THREE.Matrix4().makeRotationZ(this.roll + lean));
    m.setPosition(this.x, this.y + 0.01, this.z);
    this.mesh.setMatrixAt(0, m); this.mesh.instanceMatrix.needsUpdate = true;
    this.state.array[0] = brake && v > 0.3 ? 1 : 0; this.state.needsUpdate = true;
    // its wheels turn as it goes; its reversing lamps light going backwards
    this.turned += (v * dt) / this.wheelR;
    this.wheel.array[0] = this.turned; this.wheel.array[1] = wheelBlur(Math.abs(v), this.wheelR); this.wheel.needsUpdate = true;
    this.mesh.material.userData.reverse.value = v < -0.3 ? 1 : 0;
    this.view = { x: this.x, y: this.y, z: this.z, heading: this.heading, speed: Math.abs(v), kmh: Math.abs(v) * 3.6, bump: this.bump, reversing: v < -0.3 };
  }
}

// A road to set off on: the nearest point of a road a car may drive (not a footway, not a service lane) to
// (x, z), in the lane on its right, facing along it (of the two ways, the one nearer `look`).
export function placeOnRoad(roads, x, z, look) {
  let best = null, bd = 400;
  for (const e of roads.edges) {
    if (!/^(motorway|trunk|primary|secondary|tertiary|unclassified|residential)/.test(e.highway) || e.tunnel) continue;
    const p = e.pts;
    for (let i = 3; i < p.length; i += 3) {
      const x0 = p[i - 3], z0 = p[i - 1], x1 = p[i], z1 = p[i + 2], dx = x1 - x0, dz = z1 - z0, l2 = dx * dx + dz * dz;
      if (l2 < 1) continue;
      const f = Math.max(0, Math.min(1, ((x - x0) * dx + (z - z0) * dz) / l2)), px = x0 + dx * f, pz = z0 + dz * f, d = Math.hypot(px - x, pz - z);
      if (d < bd) { bd = d; best = { e, px, pz, py: p[i - 2] + (p[i + 1] - p[i - 2]) * f, dx, dz }; }
    }
  }
  if (!best) return null;
  const { e, px, pz, py, dx, dz } = best, l = Math.hypot(dx, dz);
  let hx = dx / l, hz = dz / l;
  if (e.oneway === -1) { hx = -hx; hz = -hz; }
  if (!e.oneway && hx * Math.sin(look) + hz * Math.cos(look) < 0) { hx = -hx; hz = -hz; }
  // in a lane, not on a line: a two-way road's right-hand half; a one-way road of an even number of lanes has a
  // line down its middle, so half a lane over (right of the way (hx, hz) is (-hz, hx), y up)
  const lanes = e.lanes || (e.oneway ? 1 : 2);
  const off = e.oneway ? (lanes % 2 ? 0 : 1.5) : Math.min(3, Math.max(1.4, lanes * 0.75));
  return { x: px - hz * off, z: pz + hx * off, y: py, heading: Math.atan2(hx, hz), raised: !!(e.bridge || e.flyover) };
}
