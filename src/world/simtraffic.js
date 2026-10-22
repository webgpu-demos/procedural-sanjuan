// The simulated morning (tools/sim/run.py): every car on the road is a trip SUMO drove, played back from its
// recorded track: where it was at every moment, within 35 cm, its stops at the lights and in the queues
// included. Nothing here decides where a car goes; it only shows what the simulation did.
//
// Three levels of detail, by distance from the camera:
//   near   the full car models (traffic.js), brake lights from the track's deceleration, lamps on the road
//   mid    a plain box in the car's colour
//   lights every car out to the horizon as its lamps: white ahead, red behind (they show from dusk to dawn)
// Tracks come in windows of the morning (w_<t>.bin, WINDOW s each), fetched ahead of the clock.
import * as THREE from 'three';
import { TYPES, vehicle, carMaterial, beamGeometry, beamTexture, CAR_COLORS, BUS_COLORS } from './traffic.js';
import { shared } from './materials.js';
import { LAMP_LAYER, lampMaterial } from './lamplight.js';

const NEAR = 700, MID = 2800, LIGHTS = 12000;           // metres from the camera
const MAX_NEAR = 4500, MAX_MID = 40000, MAX_LIGHTS = 120000;

const hash = (v) => { v = Math.imul(v ^ (v >>> 16), 0x45d9f3b); v = Math.imul(v ^ (v >>> 16), 0x45d9f3b); return ((v ^ (v >>> 16)) >>> 0) / 4294967296; };

// Light sprites: a soft round glow, brighter at night, scaled by distance.
function lightsMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: { uNight: shared.uNight, uScale: { value: 1 } },
    vertexShader: /* glsl */`
      attribute vec3 color;
      uniform float uScale;
      varying vec3 vColor;
      void main() {
        vColor = color;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mv;
        gl_PointSize = clamp(uScale * 2600.0 / -mv.z, 3.0 * uScale, 16.0 * uScale); // (uScale: device pixels per CSS pixel)
      }`,
    fragmentShader: /* glsl */`
      uniform float uNight;
      varying vec3 vColor;
      void main() {
        vec2 d = gl_PointCoord - 0.5;
        float a = exp(-dot(d, d) * 16.0);
        gl_FragColor = vec4(vColor * a * (0.3 + 5.0 * uNight), 1.0);
      }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
}

export class SimTraffic {
  // base: the scenario's folder (tiles/<area>/sim/<scenario>); surface(x, z): height of the road surface.
  static async load(base, surface, roads = null, ground = surface) {
    const index = await fetch(`${base}/index.json`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    if (!index) return null;
    const sim = new SimTraffic(base, index, surface);
    if (roads) sim.raise(roads, ground);
    // the AMA's buses (tools/sim/gtfs.py): route, headsign, colour by vehicle id
    sim.buses = await fetch(`${base}/../buses.json`).then((r) => (r.ok ? r.json() : {})).catch(() => ({}));
    return sim;
  }

  constructor(base, index, surface) {
    this.base = base; this.index = index; this.surface = surface;
    this.begin = index.begin; this.end = index.end;
    this.windows = new Map(); // window start -> decoded | 'loading'
    // the windows are fetched and decoded in a worker (simworker.js): a rush-hour window holds tens of thousands of tracks
    this.worker = new Worker(new URL('./simworker.js', import.meta.url), { type: 'module' });
    this.requests = new Map();
    this.worker.onmessage = ({ data: { id, W, error } }) => {
      const w0 = this.requests.get(id); this.requests.delete(id);
      if (error || !W) { console.warn('track window', w0, error); this.windows.delete(w0); return; }
      W.cursor = new Uint16Array(W.n); W.heading = new Float32Array(W.n).fill(NaN);
      this.carry(w0, W); this.windows.set(w0, W);
    };
    this.nextRequest = 0;
    this.group = new THREE.Group(); this.group.name = 'simulated traffic';
    this.stats = { active: 0, near: 0, mid: 0, lights: 0 };
    this.headlights = 5;

    const material = carMaterial();
    this.beam = lampMaterial(beamTexture(), { vertexColors: true });
    const share = [0.27, 0.24, 0.29, 0.16, 0.04, 0.01];
    this.fleets = TYPES.map((t, k) => {
      const cap = Math.ceil(MAX_NEAR * share[k] * 1.6) + 16;
      const geo = vehicle(t.spec);
      const brake = new THREE.InstancedBufferAttribute(new Float32Array(cap), 1);
      brake.setUsage(THREE.DynamicDrawUsage);
      geo.setAttribute('aBrake', brake);
      const mesh = new THREE.InstancedMesh(geo, material, cap);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.castShadow = true; mesh.frustumCulled = false; mesh.count = 0;
      mesh.setColorAt(0, new THREE.Color());
      const beams = new THREE.InstancedMesh(beamGeometry(t.L), this.beam, cap);
      beams.instanceMatrix = mesh.instanceMatrix;
      beams.frustumCulled = false; beams.count = 0; beams.layers.set(LAMP_LAYER);
      this.group.add(mesh, beams);
      return { ...t, mesh, beams, brake, cap };
    });
    // mid distance: one box per car, sized to its type
    this.boxes = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0),
      new THREE.MeshStandardMaterial({ roughness: 0.45, metalness: 0.3 }), MAX_MID);
    this.boxes.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.boxes.frustumCulled = false; this.boxes.count = 0;
    this.boxes.setColorAt(0, new THREE.Color());
    this.group.add(this.boxes);
    // lamps as points of light, two per car
    const lg = new THREE.BufferGeometry();
    this.lightPos = new Float32Array(MAX_LIGHTS * 2 * 3); this.lightCol = new Float32Array(MAX_LIGHTS * 2 * 3);
    lg.setAttribute('position', new THREE.BufferAttribute(this.lightPos, 3).setUsage(THREE.DynamicDrawUsage));
    lg.setAttribute('color', new THREE.BufferAttribute(this.lightCol, 3).setUsage(THREE.DynamicDrawUsage));
    lg.setDrawRange(0, 0);
    this.lights = new THREE.Points(lg, lightsMaterial());
    this.lights.frustumCulled = false;
    this.group.add(this.lights);

    this.color = new THREE.Color();
    this.m = new THREE.Matrix4();
    this.back = [0, 0, 0];
    this.followed = null;  // vehicle id the camera rides with
    this.view = null;      // the followed car's place this frame: { x, y, z, heading, speed }
  }

  // The raised roads (flyovers, ramps, bridges: road level well above the ground) as segments by 24 m cell. A car
  // over one, at about its height in the simulation, drives on its deck; any other on the ground.
  raise(roads, ground) {
    this.decks = new Map();
    for (const e of roads.edges) {
      if (e.tunnel) continue;
      const p = e.pts;
      for (let k = 3; k < p.length; k += 3) {
        const x0 = p[k - 3], y0 = p[k - 2], z0 = p[k - 1], x1 = p[k], y1 = p[k + 1], z1 = p[k + 2];
        const mx = (x0 + x1) / 2, mz = (z0 + z1) / 2;
        if ((y0 + y1) / 2 < ground(mx, mz) + 1.2) continue;
        const len = Math.hypot(x1 - x0, z1 - z0); if (len < 0.1) continue;
        for (let s = 0; s <= len; s += 12) {
          const f = s / len, key = Math.floor((x0 + (x1 - x0) * f) / 24) + ',' + Math.floor((z0 + (z1 - z0) * f) / 24);
          if (!this.decks.has(key)) this.decks.set(key, []);
          const cell = this.decks.get(key); if (cell.at(-1)?.[6] !== k + e.pts.length) cell.push([x0, y0, z0, x1, y1, z1, k + e.pts.length]);
        }
      }
    }
  }
  // the deck under (x, z) near height y, or null
  deckAt(x, z, y) {
    const cell = this.decks?.get(Math.floor(x / 24) + ',' + Math.floor(z / 24));
    if (!cell) return null;
    let best = null, bd = 7.5;
    for (const [x0, y0, z0, x1, y1, z1] of cell) {
      const dx = x1 - x0, dz = z1 - z0, l2 = dx * dx + dz * dz, f = Math.max(0, Math.min(1, ((x - x0) * dx + (z - z0) * dz) / l2));
      const d = Math.hypot(x0 + dx * f - x, z0 + dz * f - z), h = y0 + (y1 - y0) * f;
      if (d < bd && Math.abs(h - y) < 4.5) { bd = d; best = h; }
    }
    return best;
  }

  // ---------------------------------------------------------------- windows
  windowStart(T) { return this.begin + Math.floor((T - this.begin) / this.index.window) * this.index.window; }
  ensure(w0) {
    if (w0 < this.begin || w0 >= this.end || this.windows.has(w0)) return;
    const entry = this.index.windows.find((w) => w[0] === w0);
    if (!entry) return;
    this.windows.set(w0, 'loading');
    const id = ++this.nextRequest; this.requests.set(id, w0);
    this.worker.postMessage({ id, url: new URL(`${this.base}/${entry[1]}`, location.href).href });
  }

  // A car keeps the way it faced at the end of the window before (a long wait in a jam can span a whole window).
  carry(w0, W) {
    const prev = this.windows.get(w0 - this.index.window);
    if (!prev || prev === 'loading') return;
    const at = new Map();
    for (let i = 0; i < prev.n; i++) if (!Number.isNaN(prev.heading[i])) at.set(prev.vid[i], prev.heading[i]);
    for (let i = 0; i < W.n; i++) { const h = at.get(W.vid[i]); if (h !== undefined) W.heading[i] = h; }
  }

  // Position at time T along track i of window W, into out[0..2]; false if outside the track.
  static at(W, i, T, out) {
    const s = W.start[i], c = W.count[i], K = W.K;
    if (T < K[s * 4] || T > K[(s + c - 1) * 4]) return false;
    let j = W.cursor[i];
    if (j >= c - 1) j = c - 2;
    while (j < c - 2 && K[(s + j + 1) * 4] <= T) j++;
    while (j > 0 && K[(s + j) * 4] > T) j--;
    W.cursor[i] = j;
    const a = (s + j) * 4, b = a + 4, f = (T - K[a]) / Math.max(1e-6, K[b] - K[a]);
    out[0] = K[a + 1] + (K[b + 1] - K[a + 1]) * f; out[1] = K[a + 2] + (K[b + 2] - K[a + 2]) * f; out[2] = K[a + 3] + (K[b + 3] - K[a + 3]) * f;
    return true;
  }

  // ---------------------------------------------------------------- the frame
  update(T, camera) {
    const W = this.windows.get(this.windowStart(T));
    const span = this.index.window;
    this.ensure(this.windowStart(T)); this.ensure(this.windowStart(T) + span); this.ensure(this.windowStart(T) - span);
    // drop windows far from the clock
    for (const k of this.windows.keys()) if (Math.abs(k - this.windowStart(T)) > span * 2) this.windows.delete(k);
    if (T < this.begin || T >= this.end) { this.hide(); return; }
    if (!W || W === 'loading') return; // (the window is on its way: the cars hold where they were for a frame or two)

    const cx = camera.position.x, cy = camera.position.y, cz = camera.position.z;
    const p = [0, 0, 0], q = [0, 0, 0], r = [0, 0, 0];
    const counts = this.fleets.map(() => 0);
    let mid = 0, lights = 0, active = 0, nearSpeed = 0, nearStopped = 0, nearN = 0;
    const m = this.m.elements, night = shared.uNight.value;
    this.view = null;
    for (let i = 0; i < W.n; i++) {
      if (!SimTraffic.at(W, i, T, p)) continue;
      active++;
      const dx = p[0] - cx, dz = p[2] - cz, d2 = dx * dx + dz * dz + (p[1] - cy) * (p[1] - cy);
      const vid = W.vid[i], followed = vid === this.followed;
      // (beyond the boxes only the lamps show, and only from dusk to dawn)
      if (!followed && (d2 > LIGHTS * LIGHTS || (d2 > MID * MID && night <= 0.02))) continue;
      // heading and speed from where it was half a second ago and will be half a second on
      const hadQ = SimTraffic.at(W, i, T - 0.5, q), hadR = SimTraffic.at(W, i, T + 0.5, r);
      SimTraffic.at(W, i, T, p); // (restore the cursor)
      const hx = (hadR ? r[0] : p[0]) - (hadQ ? q[0] : p[0]), hz = (hadR ? r[2] : p[2]) - (hadQ ? q[2] : p[2]);
      const moved = Math.hypot(hx, hz), speed = moved / ((hadQ ? 0.5 : 0) + (hadR ? 0.5 : 0) || 1);
      let heading = W.heading[i];
      if (moved > 0.02) { heading = Math.atan2(hx, hz); W.heading[i] = heading; }
      else if (Number.isNaN(heading)) heading = W.heading[i] = this.restHeading(W, i, T);
      // braking: slower than half a second ago by more than ~1.2 m/s², or standing in a queue
      let brake = 0;
      if (hadQ && (d2 < NEAR * NEAR || followed || (night > 0.02 && d2 < 2000 * 2000))) { // (only where a brake light can be seen)
        const back = this.back;
        if (SimTraffic.at(W, i, T - 1.0, back)) {
          const before = Math.hypot(q[0] - back[0], q[2] - back[2]) / 0.5;
          brake = before - speed > 0.6 || speed < 0.4 ? 1 : 0;
        }
        SimTraffic.at(W, i, T, p);
      }
      const sin = Math.sin(heading), cos = Math.cos(heading);
      // on the ground, unless on a raised road's deck (a flyover, a ramp, a bridge); for a car seen only as its
      // lamps, the simulation's own height is near enough (and the ground is not looked up for tens of thousands)
      const seen = d2 < MID * MID || followed;
      const ground = seen ? this.surface(p[0], p[2]) : p[1];
      const deck = seen && p[1] > ground + 0.6 ? this.deckAt(p[0], p[2], p[1]) : null;
      const y = deck ?? ground;
      if (followed) this.view = { x: p[0], y, z: p[2], heading, speed, vid, type: W.type[i], brake };
      const t = W.type[i], spec = TYPES[t];
      if (d2 < 250 * 250) { nearN++; nearSpeed += speed; if (speed < 0.5) nearStopped++; }
      if (d2 < NEAR * NEAR || followed) {
        const f = this.fleets[t];
        if (counts[t] < f.cap) {
          const k = counts[t]++;
          // nose up or down with the road
          const ahead = deck != null ? 0 : (this.surface(p[0] + sin * 2.5, p[2] + cos * 2.5) - this.surface(p[0] - sin * 2.5, p[2] - cos * 2.5)) / 5;
          const pitch = -Math.atan(ahead), cp = Math.cos(pitch), sp = Math.sin(pitch);
          // rotation Y(heading) * X(pitch), then translation
          m[0] = cos; m[1] = 0; m[2] = -sin; m[3] = 0;
          m[4] = sin * sp; m[5] = cp; m[6] = cos * sp; m[7] = 0;
          m[8] = sin * cp; m[9] = -sp; m[10] = cos * cp; m[11] = 0;
          m[12] = p[0]; m[13] = y + 0.07; m[14] = p[2]; m[15] = 1;
          f.mesh.setMatrixAt(k, this.m);
          f.mesh.setColorAt(k, this.color.setHex(this.paint(vid, t)));
          f.brake.array[k] = brake;
          continue;
        }
      }
      if (d2 < MID * MID && mid < MAX_MID) {
        const L = spec.L, Wd = spec.spec.W, H = spec.spec.roof;
        m[0] = cos * Wd; m[1] = 0; m[2] = -sin * Wd; m[3] = 0;
        m[4] = 0; m[5] = H; m[6] = 0; m[7] = 0;
        m[8] = sin * L; m[9] = 0; m[10] = cos * L; m[11] = 0;
        m[12] = p[0]; m[13] = y + 0.15; m[14] = p[2]; m[15] = 1;
        this.boxes.setMatrixAt(mid, this.m);
        this.boxes.setColorAt(mid, this.color.setHex(this.paint(vid, t)));
        mid++;
      }
      if (night > 0.02 && lights < MAX_LIGHTS) {
        // the lamps: white at the front, red at the back (red brighter when braking)
        const L = spec.L * 0.48, h = y + 0.75, o = lights * 6;
        this.lightPos[o] = p[0] + sin * L; this.lightPos[o + 1] = h; this.lightPos[o + 2] = p[2] + cos * L;
        this.lightPos[o + 3] = p[0] - sin * L; this.lightPos[o + 4] = h; this.lightPos[o + 5] = p[2] - cos * L;
        this.lightCol[o] = 1.0; this.lightCol[o + 1] = 0.9; this.lightCol[o + 2] = 0.72;
        const red = brake ? 1.0 : 0.45;
        this.lightCol[o + 3] = red; this.lightCol[o + 4] = 0.03 * red; this.lightCol[o + 5] = 0.02 * red;
        lights++;
      }
    }
    this.fleets.forEach((f, k) => {
      f.mesh.count = f.beams.count = counts[k];
      f.mesh.instanceMatrix.needsUpdate = true;
      if (f.mesh.instanceColor) f.mesh.instanceColor.needsUpdate = true;
      f.brake.needsUpdate = true;
    });
    this.boxes.count = mid; this.boxes.instanceMatrix.needsUpdate = true;
    if (this.boxes.instanceColor) this.boxes.instanceColor.needsUpdate = true;
    const g = this.lights.geometry;
    g.setDrawRange(0, lights * 2);
    g.attributes.position.needsUpdate = true; g.attributes.color.needsUpdate = true;
    this.lights.material.uniforms.uScale.value = Math.min(3, devicePixelRatio || 1);
    this.beam.color.setScalar(0.36 * this.headlights * night);
    this.beam.visible = night > 0.02;
    this.stats = { active, near: counts.reduce((a, b) => a + b, 0), mid, lights, nearSpeed: nearN ? nearSpeed / nearN : null, nearStopped, nearCount: nearN };
  }

  dispose() { this.worker.terminate(); this.windows.clear(); }

  hide() {
    for (const f of this.fleets) f.mesh.count = f.beams.count = 0;
    this.boxes.count = 0; this.lights.geometry.setDrawRange(0, 0);
    this.stats = { active: 0, near: 0, mid: 0, lights: 0 };
  }

  // The way a standing car faces: the way it came (the last stretch of its track before T where it moved), or
  // for a car that has not moved yet, the way it will go.
  restHeading(W, i, T) {
    const s = W.start[i], c = W.count[i], K = W.K;
    const dir = (j) => { const a = (s + j) * 4, b = a + 4, dx = K[b + 1] - K[a + 1], dz = K[b + 3] - K[a + 3]; return dx * dx + dz * dz > 0.25 ? Math.atan2(dx, dz) : null; };
    let j = 0;
    while (j < c - 2 && K[(s + j + 1) * 4] <= T) j++;
    for (let k = j; k >= 0; k--) { const h = dir(k); if (h != null) return h; }
    for (let k = j + 1; k < c - 1; k++) { const h = dir(k); if (h != null) return h; }
    return 0;
  }

  paint(vid, type) {
    const bus = this.buses?.[vid];
    if (bus) return parseInt(bus[3].slice(1), 16) || 0xe8e4d8;
    const palette = TYPES[type].name === 'bus' ? BUS_COLORS : CAR_COLORS;
    return palette[Math.floor(hash(vid + 7) * palette.length)];
  }

  // Cars within `radius` of (x, z) at time T that will still be driving `until` seconds on: [{ vid, x, z, heading }].
  carsNear(T, x, z, radius, until = 60) {
    const W = this.windows.get(this.windowStart(T)), out = [];
    if (!W || W === 'loading') return out;
    const p = [0, 0, 0], q = [0, 0, 0];
    for (let i = 0; i < W.n; i++) {
      if (!SimTraffic.at(W, i, T, p) || Math.hypot(p[0] - x, p[2] - z) > radius) continue;
      const K = W.K, last = (W.start[i] + W.count[i] - 1) * 4;
      if (K[last] < T + until && K[last] < this.windowStart(T) + this.index.window - 1) continue; // (arrives too soon)
      if (!SimTraffic.at(W, i, T + 2, q)) continue;
      out.push({ vid: W.vid[i], x: p[0], z: p[2], heading: Math.atan2(q[0] - p[0], q[2] - p[2]), moving: Math.hypot(q[0] - p[0], q[2] - p[2]) > 4 });
    }
    return out;
  }

  // The car nearest to a ray (a click), within `radius` metres of it: its vehicle id, or null.
  pick(ray, T, radius = 6) {
    const W = this.windows.get(this.windowStart(T));
    if (!W || W === 'loading') return null;
    const p = [0, 0, 0], v = new THREE.Vector3();
    let best = null, bestD = radius;
    for (let i = 0; i < W.n; i++) {
      if (!SimTraffic.at(W, i, T, p)) continue;
      v.set(p[0], this.surface(p[0], p[2]) + 0.8, p[2]);
      const d = ray.distanceToPoint(v);
      if (d < bestD) { bestD = d; best = W.vid[i]; }
    }
    return best;
  }
}
