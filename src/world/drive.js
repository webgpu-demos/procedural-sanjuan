// Driving: the visitor's own car, out in the simulated morning. W / S (or ↑ / ↓) throttle and brake (reverse
// from a stop), A / D steer, Space the handbrake (the tail steps out), Shift a push; E gets in and out.
//
// Arcade physics on a bicycle model: the engine pulls less as the speed rises, the steering lock closes with
// speed, the car's course follows where it points with grip (little under the handbrake: a slide). It rides
// the ground, or a deck it drove onto (a flyover, a ramp: it stays up there; driving under one, it stays under).
// It slides along the walls of the buildings, met at a slant, and stops against them met square on (their wall faces, rasterized into a grid as the tiles come near), at
// the water's edge (no driving out to sea), and against the simulated cars, which cannot swerve (they keep to their recorded way): one that would drive
// through it fades out instead (simtraffic.js, probe).
import * as THREE from 'three';
import { vehicleCapsule } from './collide.js';
import { TYPES, beamGeometry, beamTexture } from './traffic.js';
import { BODY_SPECS, buildCarGeometry, carStyleCode } from './carbodies.js';
import { loftedCarMaterial, carDepth } from './carmaterial.js';
import { wheelBlur } from './fleet.js';
import { LAMP_LAYER, lampMaterial } from './lamplight.js';
import { streetAt } from '../shared/decks.js';
import { PASS } from '../shared/tileformat.js';

const CELL = 1.5;              // wall grid (m)
const WHEELBASE = 2.8, TOP = 44, BOOST = 58, REVERSE = 9;
const TYRES = 25; // what the tyres hold across (m/s²): twice a road car's, as a game's do
// the ways off its course a car that has met something tries, to slide along it (radians, the nearest first)
const SLIDE = [0.07, 0.14, 0.21, 0.31, 0.44, 0.58, 0.73, 0.9, 1.08, 1.26];
const smooth = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

// The walls of the buildings near a point: their faces that stand up, each laid down as the cells of a grid
// it runs through, built per tile as the tiles come near (tiles(): the scene's tile groups).
// ground(x, z): the street's level; a wall whose foot stands PASS metres or more over it (a skywalk's, a raised
// part's: BFLAG.RAISED) is passed under.
export class Walls {
  constructor(tiles, ground = null) { this.tiles = tiles; this.ground = ground; this.cells = new Map(); }
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
        if (this.ground && Math.min(pos[a * 3 + 1], pos[b * 3 + 1], pos[c * 3 + 1]) - this.ground((P[0][0] + P[1][0] + P[2][0]) / 3, (P[0][1] + P[1][1] + P[2][1]) / 3) >= PASS) continue;
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

// Under a building: in each metre of a tile, the height of the roof drawn over it (its roofs' triangles laid down
// cell by cell, NaN where there is none), worked out for a tile the first time a simulated car near the view asks.
// (A street the simulation drives where the city draws a building: Avenida Roosevelt at Hato Rey runs through one,
// the data of the two not agreeing; its cars went through the walls. Under a roof now they fade out.)
const COVER = 1;
export class Overhead {
  constructor(tiles, size = 256) { this.tiles = tiles; this.size = size; this.grids = new Map(); this.byKey = new Map(); this.budget = 2; }
  of(tile) {
    let g = this.grids.get(tile);
    if (g !== undefined) return g;
    if (this.budget-- <= 0) return null; // (two tiles a frame: a tile with towers on it takes milliseconds)
    const b = new THREE.Box3().setFromObject(tile), x0 = Math.floor(b.min.x), z0 = Math.floor(b.min.z);
    const w = Math.max(1, Math.ceil(b.max.x - x0)), h = Math.max(1, Math.ceil(b.max.z - z0));
    // (first the undersides of what is raised over the street, a skywalk: a car passing beneath one is in the open,
    // seen from the side, and the raised building's own roof over it is not a roof over the street; then the roofs)
    let roof = null, under = null;
    for (const up of [false, true]) tile.traverse((o) => {
      if (!o.isMesh || !o.userData.facade) return;
      const pos = o.geometry.attributes.position.array, nor = o.geometry.attributes.normal.array, idx = o.geometry.index?.array;
      const n = idx ? idx.length : pos.length / 3;
      for (let t = 0; t < n; t += 3) {
        const a = idx ? idx[t] : t, bb = idx ? idx[t + 1] : t + 1, c = idx ? idx[t + 2] : t + 2;
        if (up ? nor[a * 3 + 1] < 0.3 : nor[a * 3 + 1] > -0.9) continue; // (a wall; on the first pass, all but undersides)
        const ax = pos[a * 3], az = pos[a * 3 + 2], bx = pos[bb * 3], bz = pos[bb * 3 + 2], cx = pos[c * 3], cz = pos[c * 3 + 2];
        const d = (bx - ax) * (cz - az) - (cx - ax) * (bz - az);
        if (Math.abs(d) < 1e-6) continue;
        const i0 = Math.max(0, Math.floor((Math.min(ax, bx, cx) - x0) / COVER)), i1 = Math.min(w - 1, Math.floor((Math.max(ax, bx, cx) - x0) / COVER));
        const j0 = Math.max(0, Math.floor((Math.min(az, bz, cz) - z0) / COVER)), j1 = Math.min(h - 1, Math.floor((Math.max(az, bz, cz) - z0) / COVER));
        for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
          const px = x0 + (i + 0.5) * COVER, pz = z0 + (j + 0.5) * COVER;
          const u = ((bx - px) * (cz - pz) - (cx - px) * (bz - pz)) / d, v = ((cx - px) * (az - pz) - (ax - px) * (cz - pz)) / d;
          if (u < -1e-4 || v < -1e-4 || u + v > 1 + 1e-4) continue;
          const y = u * pos[a * 3 + 1] + v * pos[bb * 3 + 1] + (1 - u - v) * pos[c * 3 + 1], k = j * w + i;
          if (!up) { under ??= new Float32Array(w * h).fill(NaN); if (!(under[k] <= y)) under[k] = y; continue; }
          if (under && y >= under[k] - 0.5) continue; // (the raised building's own roof)
          roof ??= new Float32Array(w * h).fill(NaN);
          if (!(roof[k] >= y)) roof[k] = y;
        }
      }
    });
    g = roof ? { x0, z0, w, h, roof } : null;
    this.grids.set(tile, g);
    if (this.grids.size > 80) this.grids.delete(this.grids.keys().next().value); // (the oldest)
    return g;
  }
  // the tiles in the scene now (once a frame, by the caller: refresh())
  // (the budget each frame; the tiles every 30th: they come and go with the view, slowly)
  refresh() {
    this.budget = 2;
    if ((this.frame = (this.frame ?? 0) + 1) % 30 !== 1) return;
    this.byKey.clear();
    for (const t of this.tiles()) { const [a, c] = t.name.slice(5).split('_').map(Number); this.byKey.set((a + 32768) * 65536 + c + 32768, t); }
    for (const t of [...this.grids.keys()]) if (!t.parent) this.grids.delete(t);
  }
  // the roof drawn over (x, z), or -Infinity (of the tile there and those round it: a building of one may stand over
  // its edge)
  at(x, z) {
    let top = -Infinity;
    const tx = Math.floor(x / this.size), tz = Math.floor(z / this.size);
    for (let a = -1; a <= 1; a++) for (let c = -1; c <= 1; c++) {
      const tile = this.byKey.get((tx + a + 32768) * 65536 + tz + c + 32768);
      if (!tile) continue;
      const b = tile.userData.box ??= new THREE.Box3().setFromObject(tile);
      if (x < b.min.x || x > b.max.x || z < b.min.z || z > b.max.z) continue;
      const g = this.of(tile);
      if (!g) continue;
      const i = Math.floor((x - g.x0) / COVER), j = Math.floor((z - g.z0) / COVER);
      if (i < 0 || j < 0 || i >= g.w || j >= g.h) continue;
      const y = g.roof[j * g.w + i];
      if (y > top) top = y;
    }
    return top;
  }
}

export class Driver {
  // scene; surface(x, z, -2): the terrain; sim(): the simulated traffic (decks, the cars round about), or null;
  // tiles(): the scene's tile groups (for the walls)
  constructor({ scene, surface, sim, tiles, lift = () => 0, decks = null, wet = () => false }) {
    this.decks = decks; // (the decks the flyovers draw: roadlevel.js)
    this.wet = wet; // (water no road crosses, and beyond the city: streamer.wet)
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
    this.walls = new Walls(tiles, (x, z) => surface(x, z));
    this.view = null;
  }

  // Into a car at (x, z), facing `heading` (radians, 0 = +z): on the ground there, or at height y if given (a
  // car set down on a bridge starts on its deck).
  start(x, z, heading, y = null) {
    this.x = x; this.z = z; this.heading = heading; this.course = heading;
    this.speed = 0; this.steer = 0; this.y = y ?? streetAt(this.surface, x, z, this.surface(x, z, -2)) + this.lift(x, z); this.pitch = 0; this.roll = 0;
    this.gas = 0; this.brk = 0; this.gripNow = 9; this.lean = 0; this.dive = 0; // (the pedals as the foot has them, the tyres' hold, the body on its springs)
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
    const v0 = v;
    // The pedals go down and come up as a foot does, not as a key does: the engine's pull and the brakes' bite came
    // on whole in one frame, and the car lurched at every touch.
    this.gas += (gas - this.gas) * (1 - Math.exp(-dt * (gas ? 6 : 10)));
    this.brk += (brake - this.brk) * (1 - Math.exp(-dt * (brake ? 12 : 14)));
    // engine, brakes, reverse; rolling resistance and air
    v += this.gas * (v < 0 ? 14 : 5.6 * (1 - (v / top) ** 2) * (boost ? 1.6 : 1)) * dt; // (0-100 km/h in about 6 s)
    if (v > 0.5) v -= this.brk * 9.5 * (0.3 + 0.7 * smooth(0.3, 2.5, v)) * dt; // (as hard as tyres hold on dry asphalt, eased over the last metre: it stopped with a jolt)
    else if (brake) v -= this.brk * 5 * (1 - Math.min(1, -v / REVERSE)) * dt; // (stopped, the same pedal backs it up)
    if (!gas && !brake) v -= Math.sign(v) * Math.min(Math.abs(v), (0.5 + 0.06 * Math.abs(v)) * dt);
    if (hand) v -= Math.sign(v) * Math.min(Math.abs(v), 7 * dt);
    // (held to the push's top speed whether Shift is down or not: let go at 58 m/s, the car was at 46 the next frame.
    // Over its top speed the engine's share above is negative: it comes down on its own.)
    v = THREE.MathUtils.clamp(v, -REVERSE, BOOST + 2);
    // Steering: the lock closes as the speed rises; the wheel comes over in a tenth of a second and back by itself.
    const lock = 0.62 / (1 + Math.abs(v) / 20);
    this.steer += (steerIn * lock - this.steer) * (1 - Math.exp(-dt * (steerIn ? 8 : 9)));
    // The car points where the wheel turns it and goes where its tyres can take it, and the two are not the same
    // thing. (They were: the nose was held to what the tyres could do, 30 m/s² across, and the course followed it
    // at once, so the car cornered on rails at 3 g and then simply would not turn any more.)
    //   - the nose comes round with the wheel, up to half again faster than the tyres can bend the car's path
    //     (more with the handbrake), and at a crawl as if it rolled a little faster than it does;
    //   - the path bends towards the nose no faster than the tyres hold: TYRES across, half with the rear wheels
    //     locked; the hold comes back over half a second when the handbrake is let go, not in one frame;
    //   - the angle between the two, the slide, pulls the nose back into line (the tyres' own righting), so held
    //     hard into a bend the car settles a few degrees sideways and no further, and let go it straightens by
    //     itself; and what slides sideways loses speed.
    const av = Math.abs(v);
    const hold = hand ? 2 : 9;
    this.gripNow += (hold - this.gripNow) * (1 - Math.exp(-dt * (hold < this.gripNow ? 10 : 2.5)));
    const tyres = TYRES * (0.5 + 0.5 * (this.gripNow - 2) / 7);
    const vy = Math.sign(v) * (av + 2.5 * smooth(0.3, 2, av) * (1 - smooth(5, 12, av)));
    const most = (hand ? 2.6 : 1.5) * TYRES / Math.max(av, 3);
    let slip = this.heading - this.course; slip = Math.atan2(Math.sin(slip), Math.cos(slip));
    const yaw = THREE.MathUtils.clamp((vy / WHEELBASE) * Math.tan(this.steer) * (hand ? 1.5 : 1), -most, most) - slip * (hand ? 1.8 : 3.2) * smooth(2, 8, av);
    this.heading += yaw * dt;
    let dc = this.heading - this.course; dc = Math.atan2(Math.sin(dc), Math.cos(dc));
    // (at a walk the path is the nose's: nothing slides at 10 km/h)
    const bend = THREE.MathUtils.clamp(dc * (1 - Math.exp(-dt * this.gripNow * (1 + 2 * (1 - smooth(3, 12, av))))), -(tyres / Math.max(av, 1)) * dt, (tyres / Math.max(av, 1)) * dt);
    this.course += bend;
    v -= Math.sign(v) * Math.min(av, av * (1 - Math.cos(dc)) * 3 * dt);
    // (what the body feels, for its springs below: across, and along)
    const idt = dt > 1e-5 ? 1 / dt : 0, across = bend * idt * v, along = (v - v0) * idt;
    const nx = this.x + Math.sin(this.course) * v * dt, nz = this.z + Math.cos(this.course) * v * dt;
    // walls: the nose (or the tail, backing up) and its corners
    const half = this.spec.L * 0.5, side = this.spec.spec.W * 0.5, s = Math.sin(this.heading), c = Math.cos(this.heading), dir = v >= 0 ? 1 : -1;
    const probes = [[0, half * dir], [side, half * dir * 0.85], [-side, half * dir * 0.85]];
    // (and the water's edge: the sea, a lagoon, a river, unless a deck crosses it there at the car's height; set
    // down in the water, it drives out of it)
    const water = (x, z) => this.wet(x, z) && !this.wet(this.x, this.z) && this.decks?.at(x, z, this.y + 0.5, 2.4) == null;
    // (and on a flyover, its parapets: a probe neither on a deck's paving at the car's level nor on the street at
    // about that level, past the deck's end, is a wall, as for the simulated cars, roadlevel.js offCorners. Nothing
    // held the car up there: through the parapet it hung in the air for three metres and glided down. Only where
    // the car itself stands on what it may: somewhere the decks do not cover as drawn, it can still drive out.)
    const paved = (x, z) => this.decks.cornerOn(x, z, this.y) || (this.decks.ground.on(x, z) && Math.abs(streetAt(this.surface, x, z, this.y) + this.lift(x, z) - this.y) < 0.4);
    const parapet = this.onDeck && paved(this.x, this.z) ? (x, z) => !paved(x, z) : () => false;
    // the street's things and the vehicles round about (collide.js: the simulated cars, the traffic, the car
    // parked): one met from outside stops it; one it is already inside of it drives out of (set down in a queue,
    // the first seconds it may drive through the cars at all: ghost)
    this.ghost = Math.max(0, this.ghost - dt);
    const sim = this.sim();
    if (sim) sim.probe = [this.x, this.z];
    const W = this.spec.spec.W, from = this.collider ? vehicleCapsule(this.x, this.z, this.heading, this.spec.L, W).slice(0, 4) : null;
    // what the car, moved to (x, z) and pointing h, would run into: 'wall' (a wall, the water, a parapet, a thing of
    // the street), a vehicle, or null
    const meets = (x, z, h = this.heading) => {
      const hs = Math.sin(h), hc = Math.cos(h);
      if (probes.some(([a, b]) => { const px = x + hc * a + hs * b, pz = z - hs * a + hc * b; return this.walls.blocked(px, pz) || water(px, pz) || parapet(px, pz); })) return 'wall';
      const hit = from && this.collider.blocked(from, vehicleCapsule(x, z, h, this.spec.L, W).slice(0, 4), W / 2, this.y);
      return !hit ? null : !hit.vehicle ? 'wall' : this.ghost ? null : hit.vehicle;
    };
    const hit = Math.abs(v) > 0.05 ? meets(nx, nz) : null;
    this.hit = 0; // (how hard it met something this frame, 0..1: heard, sound.js)
    if (!hit) { this.x = nx; this.z = nz; }
    else {
      // It slides along what it met: the way nearest its own that is clear (the side it steers to first), keeping
      // the share of its speed that goes that way, its nose coming round to it. (Any touch stopped it dead and threw
      // it back: against a pole or a wall met at a slant it stood at 0 km/h with the throttle down, and only
      // backing out freed it.) Met square on, nothing is clear: it stops and is thrown back, as before.
      const first = this.steer < 0 ? -1 : 1;
      let slid = false;
      for (let i = 0; i < SLIDE.length * 2 && !slid; i++) {
        const a = SLIDE[i >> 1], co = this.course + a * (i & 1 ? -first : first), k = Math.cos(a);
        const x = this.x + Math.sin(co) * v * k * dt, z = this.z + Math.cos(co) * v * k * dt;
        if (meets(x, z)) continue;
        slid = true;
        this.hit = Math.min(1, Math.abs(v) * Math.sin(a) / 15);
        this.bump = Math.max(this.bump, this.hit); // (the camera feels what it lost)
        this.x = x; this.z = z; this.course = co;
        // (no slower than a crawl: nose on to a trunk the only clear way is far round, a third of its speed a frame,
        // and it wore down to a stand against the tree with the throttle down)
        v = Math.sign(v) * Math.max(Math.abs(v) * k, Math.min(Math.abs(v), 2));
        // (the nose round to the way it goes, if it has the room to swing there)
        const dh = Math.atan2(Math.sin(co - this.heading), Math.cos(co - this.heading)) * (1 - Math.exp(-dt * 8));
        if (!meets(x, z, this.heading + dh)) this.heading += dh;
      }
      if (!slid) {
        this.bump = this.hit = Math.min(1, Math.abs(v) / 15); // (the camera feels it)
        v = -v * (hit === 'wall' ? 0.25 : 0.15);
        if (hit !== 'wall') v += hit.speed * Math.cos(hit.heading - this.course) * 0.4; // (pushed along by it)
      }
    }
    this.speed = v;
    // the ground, or the deck it is on: a deck near its height (a ramp grows out of the road a step at a time,
    // so the car climbs onto it; driving under a flyover, the deck is far above and the ground is the way)
    // (the asphalt as drawn, a bridge's deck at street level included; the kerb up onto a sidewalk)
    const ground = streetAt(this.surface, this.x, this.z, this.y) + this.lift(this.x, this.z), deck = this.decks?.at(this.x, this.z, this.y + 0.5, 2.4) ?? null;
    const want = deck != null && Math.abs(deck - this.y) < 2.4 ? deck : ground;
    this.onDeck = want !== ground && want - ground > 1; // (up on a flyover, not a deck at street level)
    // (no steeper than a road climbs: the elevation model has the odd bridge embankment in it, a wall to drive into)
    const moved = Math.hypot(nx - this.x, nz - this.z) + Math.abs(v) * dt, climb = 0.35 * moved + 1.2 * dt; // (by the time gone, not the frame: it settled twice as fast at 120 Hz)
    this.y += THREE.MathUtils.clamp((want - this.y) * (1 - Math.exp(-dt * 12)), -climb * 2, climb);
    // pitch and roll from what is under the wheels: the street as drawn (a bridge at street level is its deck, not the
    // river bed under it, which is what the bare terrain gave: the car tilted to it), or the deck it is on, fore and
    // aft (level across). On a flyover's ramp it was drawn level, its nose in the deck.
    {
      const at = want === ground ? (x, z) => streetAt(this.surface, x, z, this.y) : (x, z) => this.decks.at(x, z, this.y + 0.5, 2.4) ?? want;
      const f = at(this.x + s * 1.4, this.z + c * 1.4) - at(this.x - s * 1.4, this.z - c * 1.4);
      const r = want === ground ? at(this.x + c * 0.9, this.z - s * 0.9) - at(this.x - c * 0.9, this.z + s * 0.9) : 0;
      this.pitch += (-Math.atan(THREE.MathUtils.clamp(f, -0.6, 0.6) / 2.8) - this.pitch) * (1 - Math.exp(-dt * 8));
      this.roll += (Math.atan(THREE.MathUtils.clamp(r, -0.4, 0.4) / 1.8) - this.roll) * (1 - Math.exp(-dt * 8));
    }
    // the body leans out of a turn and dips under the brakes
    // (on its springs: it rolls with what pushes it sideways and pitches with the brakes and the engine, and takes a
    // moment to do it. It was set from the keys: a step of the nose at every touch of the brake.)
    this.lean += (THREE.MathUtils.clamp(across * 0.0035, -0.075, 0.075) - this.lean) * (1 - Math.exp(-dt * 6));
    this.dive += (THREE.MathUtils.clamp(-along * 0.004, -0.022, 0.04) - this.dive) * (1 - Math.exp(-dt * 7));
    const lean = this.lean, dive = this.dive;
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
    this.view = { x: this.x, y: this.y, z: this.z, heading: this.heading, course: this.course, speed: Math.abs(v), kmh: Math.abs(v) * 3.6, bump: this.bump, reversing: v < -0.3,
      // (for the ear, sound.js: the throttle; how far the tyres slide, the angle between where it points and where it goes by its speed; a knock)
      throttle: this.gas, slip: Math.abs(Math.atan2(Math.sin(this.heading - this.course), Math.cos(this.heading - this.course))) * Math.abs(v), hit: this.hit };
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
