// Cars on the road graph (roads.json), kept around the camera only: a car that falls too far behind is
// put back on a road near the focus.
//
// Rules of the road, as far as this goes:
//   - keep right; one-way streets one way only; speed from the limit of the road
//   - follow the vehicle ahead with a time gap, including the one just past the next junction
//   - stop at red and yellow lights (the same cycle as the signal heads in props.js)
//   - a junction is crossed by one approach at a time (opposing traffic going straight on may cross
//     together); without lights, a side street gives way to the bigger road and slows right down first (PARE)
//   - where lanes merge, vehicles queue instead of entering side by side
//   - never enter a junction without room on the far side
import * as THREE from 'three';
import { segDist } from './collide.js';
import { shared } from './materials.js';
import { lampMaterial } from './lamplight.js';
import { Fleet, BODY_OF, SCALE_OF, lookOf, wheelBlur } from './fleet.js';
import { BODY_SPECS, buildCarProxyGeometry } from './carbodies.js';
import { loftedCarMaterial } from './carmaterial.js';

const LANE = 3.0;
const CAR_RADIUS = 330, CARS = 260; // the default number of cars, and the distance from the focus they keep within
export const MAX_CARS = 1500;
const CYCLE = 64, GREEN = 27; // seconds: must match the lens shader in props.js
const LANE_CELL = 256;         // metres: the cells lanes are bucketed in, to pick one near the focus
const NEAR_LOD = 160;          // metres from the camera: within, a car's full model; beyond, its stand-in

// ---------------------------------------------------------------- the cars (fleet.js: the lofted bodies)
// What the lamps throw on the road: a long pool ahead of the car and a short red one behind it, as one
// instanced mesh per vehicle type that shares the cars' own matrices. Like the street lamps' pools
// (props.js), it multiplies the road under it.
export function beamTexture() {
  const W = 128, H = 128, data = new Uint8Array(W * H * 4), step = THREE.MathUtils.smoothstep;
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    // Dipped headlamps: a pool the width of the car at its nose, widening to about three lanes' worth at the far
    // end, every edge soft, brightest near the car. (A fan from a point, 35 degrees wide with hard sides, had
    // drawn long straight lines of light across the lanes from every car alongside the one being followed.)
    const u = ((i + 0.5) / W) * 2 - 1, v = (j + 0.5) / H;
    const side = 1 - step(Math.abs(u) / (0.2 + 0.8 * v), 0.55, 1.3);
    const reach = 1 - step(v, 0.55, 1.0);
    const value = side * reach * step(v, 0, 0.05) * (0.12 + 0.88 * Math.exp(-v * 2.6));
    data.set([value * 255, value * 255, value * 255, 255], (j * W + i) * 4);
  }
  const t = new THREE.DataTexture(data, W, H);
  t.magFilter = t.minFilter = THREE.LinearFilter;
  t.needsUpdate = true;
  return t;
}
export function beamGeometry(L) {
  const g = new THREE.BufferGeometry(), y = 0.14, pos = [], uv = [], col = []; // (held clear of the road: it must never dip under it)
  const quad = (x, zNear, zFar, rgb) => {
    pos.push(-x, y, zNear, x, y, zNear, x, y, zFar, -x, y, zNear, x, y, zFar, -x, y, zFar);
    uv.push(0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1);
    for (let i = 0; i < 6; i++) col.push(...rgb);
  };
  quad(4.5, L / 2 - 0.3, L / 2 + 30, [1, 0.95, 0.84]);       // headlamps, dipped: a pool 30 m long, 9 m wide at its end
  quad(-3.2, -L / 2 + 0.3, -L / 2 - 6, [0.34, 0.02, 0.012]);  // tail lamps
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  return g;
}
// What drives in San Juan: compact cars and sedans, a great many SUVs and pickups, delivery trucks, and the
// AMA's city buses.
export const TYPES = [
  // (L and W: the lofted bodies' own, fleet.js; spec.W the width, the rest the proportions of the models before them)
  { name: 'compact', share: 0.26, L: 4.15, spec: { L: 4.2, W: 1.78, belt: 0.92, roof: 1.46, z0: 0.18, z1: 0.8, rake: 0.7 } },
  { name: 'sedan', share: 0.22, L: 4.5, spec: { L: 4.8, W: 1.86, belt: 0.92, roof: 1.44, z0: 0.2, z1: 0.72, rake: 0.75 } },
  { name: 'suv', share: 0.26, L: 4.7, spec: { L: 4.7, W: 1.94, belt: 1.08, roof: 1.76, z0: 0.12, z1: 0.86, rake: 0.55, tyre: 0.36 } },
  { name: 'pickup', share: 0.12, L: 5.7, spec: { L: 5.6, W: 2.05, belt: 1.12, roof: 1.84, z0: 0.3, z1: 0.62, rake: 0.5, tyre: 0.38 } },
  { name: 'truck', share: 0.08, L: 5.9, spec: { L: 7.0, W: 2.0, belt: 1.05, roof: 2.4, z0: 0.76, z1: 0.97, rake: 0.18, tyre: 0.45, box: { h: 2.3, len: 0.7, z: 0.36 } } },
  { name: 'bus', share: 0.06, L: 12.3, spec: { L: 12.0, W: 2.6, belt: 1.25, roof: 3.1, z0: 0.02, z1: 0.98, rake: 0.14, tyre: 0.48 } },
];

// Cars parked in car parks (props.js): the lofted bodies' stand-ins (fleet.js), a compact, a sedan, an SUV, a pickup by
// the prop's variant; per car its paint and style, from its own number
let parkedKit = null;
export function parkedVehicles() {
  if (parkedKit) return parkedKit;
  const kinds = ['compact', 'sedan', 'suv', 'pickup'], geos = {}, mats = {};
  parkedKit = {
    kind: (variant) => kinds[variant % kinds.length],
    // the geometry for `n` cars of a variant, with their looks (n numbers: their seeds), and its material
    model(variant, seeds) {
      const kind = kinds[variant % kinds.length], looks = seeds.map((sd) => lookOf(kind, sd));
      const body = looks[0]?.body ?? BODY_OF[kind];
      geos[body] ??= buildCarProxyGeometry(BODY_SPECS[body]);
      mats[body] ??= loftedCarMaterial(BODY_SPECS[body]);
      // (an SUV's look may be a minivan's: parked, it keeps the SUV's body)
      const g = geos[body].clone(), n = looks.length, paint = new Float32Array(n * 3), state = new Float32Array(n * 4);
      looks.forEach((l, k) => { paint.set(l.paint, k * 3); state[k * 4 + 3] = l.style; });
      g.setAttribute('paintColor', new THREE.InstancedBufferAttribute(paint, 3));
      g.setAttribute('carState', new THREE.InstancedBufferAttribute(state, 4));
      g.setAttribute('aWheel', new THREE.InstancedBufferAttribute(new Float32Array(n * 2), 2));
      g.setAttribute('aHide', new THREE.InstancedBufferAttribute(new Float32Array(n), 1));
      return { geometry: g, material: mats[body], scale: SCALE_OF[kind] ?? null };
    },
  };
  return parkedKit;
}

// A per-car dissolve (aHide 0 shown .. 1 gone; 0 where a mesh has none): pixels drop out in a fine, steady
// pattern, so a car appearing, leaving or handing over to its box at a distance fades instead of popping
export const DISSOLVE = {
  vertex: ['#include <common>', '#include <common>\nattribute float aHide;\nvarying float vHide;', '#include <begin_vertex>', '#include <begin_vertex>\nvHide = aHide;'],
  fragment: ['#include <common>', '#include <common>\nvarying float vHide;', '#include <clipping_planes_fragment>',
    '#include <clipping_planes_fragment>\nif (vHide > 0.0 && fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715)))) < vHide) discard;'],
};
export function dissolve(shader) {
  const [a, b, c, d] = DISSOLVE.vertex, [e, f, g, h] = DISSOLVE.fragment;
  shader.vertexShader = shader.vertexShader.replace(a, b).replace(c, d);
  shader.fragmentShader = shader.fragmentShader.replace(e, f).replace(g, h);
}

// ---------------------------------------------------------------- the graph, as directed lanes
function buildGraph({ nodes, edges, signals }, surface) {
  const signalled = new Set(signals), out = nodes.map(() => []), into = nodes.map(() => []), lanes = [];
  for (const e of edges) {
    if (e.highway === 'service' && e.lanes <= 1) continue; // driveways and yards: not through traffic
    const pts = [];
    for (let i = 0; i < e.pts.length; i += 3) pts.push(new THREE.Vector3(e.pts[i], e.pts[i + 1], e.pts[i + 2]));
    const minor = ['residential', 'unclassified', 'living_street', 'service'].includes(e.highway);
    const speed = Math.min(15, Math.max(4.5, (e.maxspeed * (minor ? 0.6 : 0.8)) / 3.6));
    const weight = e.highway.startsWith('motorway') ? 5 : ['trunk', 'primary'].includes(e.highway) ? 4 : ['secondary', 'tertiary'].includes(e.highway) ? 2.5 : 1;
    for (const fwd of [true, false]) {
      if (fwd ? e.oneway === -1 : e.oneway === 1) continue;
      const p = fwd ? pts : [...pts].reverse(), cum = [0];
      for (let i = 1; i < p.length; i++) cum.push(cum[i - 1] + Math.hypot(p[i].x - p[i - 1].x, p[i].z - p[i - 1].z));
      if (cum.at(-1) < 1) continue;
      const n = e.oneway ? Math.max(1, e.lanes) : Math.max(1, Math.floor(e.lanes / 2));
      // lateral offset of lane k, to the right of travel: one-way roads centred on the line; two-way ones
      // on its right half (right-hand traffic). A two-way single-lane street is shared down the middle.
      const offset = (k) => (e.oneway ? (k - (n - 1) / 2) * LANE : e.lanes >= 2 ? (k + 0.5) * LANE : 1.15);
      const lane = {
        pts: p, cum, length: cum.at(-1), from: fwd ? e.a : e.b, to: fwd ? e.b : e.a, n, offset, speed, weight, motorway: e.highway.startsWith('motorway'),
        raised: !!e.flyover, hidden: !!e.tunnel, signal: signalled.has(fwd ? e.b : e.a), edge: e, cars: [],
      };
      // which way the signal for this approach is phased (see lensMaterial in props.js)
      const a = p.at(-2), b = p.at(-1);
      const facing = (Math.atan2(-(b.x - a.x), -(b.z - a.z)) + Math.PI * 2) % (Math.PI * 2); // the signal head faces the traffic
      lane.phase = Math.round(facing / (Math.PI / 2)) % 2;
      lane.hx = (b.x - a.x) / (Math.hypot(b.x - a.x, b.z - a.z) || 1); lane.hz = (b.z - a.z) / (Math.hypot(b.x - a.x, b.z - a.z) || 1);
      lanes.push(lane); out[lane.from].push(lane); into[lane.to].push(lane);
    }
  }
  // a junction: where a driver meets traffic from another road (three or more road ends)
  const junction = nodes.map((_, i) => new Set([...out[i], ...into[i]].map((l) => l.edge)).size >= 3);
  // OSM draws a big crossing as several nodes a few metres apart (one per carriageway that meets there).
  // Junction nodes joined by a short road form one junction: `group` is its id, shared by its nodes.
  const group = nodes.map((_, i) => i);
  const find = (i) => { while (group[i] !== i) { group[i] = group[group[i]]; i = group[i]; } return i; };
  for (const l of lanes) if (l.length < 26 && junction[l.from] && junction[l.to]) group[find(l.from)] = find(l.to);
  nodes.forEach((_, i) => { group[i] = find(i); });
  for (const l of lanes) {
    l.inside = group[l.from] === group[l.to] && junction[l.to]; // a link within one junction: no stopping on it
    if (l.inside) l.signal = false;
  }
  // The stop line: the junction node is the centre of the crossing, so a waiting vehicle stands back from
  // it by half the width of the widest road that meets there (plus the pedestrian crossing).
  const reach = nodes.map(() => 0);
  for (const l of lanes) {
    const half = (l.edge.oneway ? l.n : Math.max(1, l.edge.lanes)) * LANE / 2;
    reach[l.to] = Math.max(reach[l.to], half); reach[l.from] = Math.max(reach[l.from], half);
  }
  for (const l of lanes) l.stop = Math.min(reach[l.to] + 5.5, l.length * 0.45);
  return { lanes, out, into, junction, group };
}

const tmp = new THREE.Vector3(), tmp2 = new THREE.Vector3();
// Position and unit heading at distance s along a lane.
function along(lane, s, pos, dir) {
  const { pts, cum } = lane;
  let lo = 0, hi = cum.length - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (cum[mid] <= s) lo = mid; else hi = mid; }
  const t = Math.min(1, Math.max(0, (s - cum[lo]) / (cum[hi] - cum[lo] || 1)));
  pos.lerpVectors(pts[lo], pts[hi], t);
  dir.subVectors(pts[hi], pts[lo]);
  const l = Math.hypot(dir.x, dir.z) || 1;
  dir.multiplyScalar(1 / l);
}

export class Traffic {
  // roads: parsed roads.json; surface(x, z): height of the road surface there; drawn: the decks the flyovers draw
  // (roadlevel.js), for the cars on them
  constructor(roads, surface, drawn = null) {
    this.surface = surface;
    this.drawn = drawn;
    this.graph = buildGraph(roads, surface);
    // lanes by the 256 m cell of their middle point: a large area has tens of thousands
    this.cells = new Map();
    for (const l of this.graph.lanes) {
      const m = l.pts[l.pts.length >> 1], k = Math.floor(m.x / LANE_CELL) + ',' + Math.floor(m.z / LANE_CELL);
      if (!this.cells.has(k)) this.cells.set(k, []);
      this.cells.get(k).push(l);
    }
    // which approach holds each junction: { lane, until, straight (everyone crossing is going straight on) }
    this.crossing = roads.nodes.map(() => ({ lane: null, until: 0, straight: false }));
    this.group = new THREE.Group();
    this.group.name = 'traffic';
    this.time = 0;
    this.seed = 12345;

    // what the lamps throw on the road, for the light map (lamplight.js)
    this.beam = lampMaterial(beamTexture(), { vertexColors: true });
    // the cars and the buses: the lofted bodies (fleet.js)
    const caps = {};
    for (const t of TYPES) {
      if (!BODY_OF[t.name]) continue;
      for (const body of t.name === 'suv' ? ['suv', 'minivan'] : [BODY_OF[t.name]]) {
        const n = Math.ceil(MAX_CARS * t.share * (t.name === 'suv' ? (body === 'suv' ? 1 : 0.4) : 1) * 1.25) + 8;
        caps[body] = [(caps[body]?.[0] ?? 0) + Math.ceil(n * 0.6) + 8, (caps[body]?.[1] ?? 0) + n];
      }
    }
    this.fleet = new Fleet(caps, { beam: beamGeometry, beamMaterial: this.beam });
    this.group.add(this.fleet.group);
    this.eye = null; // (the camera's position, for the level of detail: main.js)
    this.cars = [];
    this.count = CARS;   // how many cars there are (the panel changes it)
    this.highway = 5;    // how much busier the expressway is than its class alone would make it
    this.headlights = 5; // strength of the light the lamps throw on the road at night
    // what is not traffic but stands in its way: you (on foot, on a bike, in your car) and the car you left,
    // as capsules [ax, az, bx, bz, r] (collide.js), given each frame; met in the lane ahead, a car stops for it
    this.blockers = [];
    this.dummy = new THREE.Object3D();
    this.dummy.rotation.order = 'YXZ'; // heading first, then pitch about the car's own axle
    this.color = new THREE.Color();
  }

  rnd() { this.seed = (this.seed * 1664525 + 1013904223) >>> 0; return this.seed / 4294967296; }

  // The cars within `r` of (x, z), as drawn last: [{ x, y, z, heading, L, W, speed }]
  near(x, z, r) {
    const out = [];
    for (const car of this.cars) {
      if (!car.lane || car.lane.hidden || car.px == null || (car.px - x) ** 2 + (car.pz - z) ** 2 > r * r) continue;
      const t = TYPES[car.type];
      out.push({ x: car.px, y: car.py, z: car.pz, heading: Math.atan2(car.hx, car.hz), L: t.L, W: t.spec.W, speed: car.v });
    }
    return out;
  }

  // A lane with some part within `radius` of the focus, picked by weight; null if the area has none.
  pick(focus, radius, filter) {
    let best = null, bestKey = -1;
    for (let i = Math.floor((focus.x - radius) / LANE_CELL); i <= Math.floor((focus.x + radius) / LANE_CELL); i++)
      for (let j = Math.floor((focus.z - radius) / LANE_CELL); j <= Math.floor((focus.z + radius) / LANE_CELL); j++)
        for (const l of this.cells.get(i + ',' + j) ?? []) {
          if (!filter(l)) continue;
          const m = l.pts[l.pts.length >> 1];
          if (Math.hypot(m.x - focus.x, m.z - focus.z) > radius) continue;
          // weighted reservoir sampling: by the importance of the road, its length and its lanes; the expressway busier still
          const key = Math.pow(this.rnd(), 1 / (l.weight * Math.min(l.length, 120) * l.n * (l.motorway ? this.highway : 1)));
          if (key > bestKey) { bestKey = key; best = l; }
        }
    return best;
  }

  spawnCar(car, focus) {
    for (let attempt = 0; attempt < 6; attempt++) {
      const lane = this.pick(focus, this.radius ?? CAR_RADIUS, (l) => !l.hidden && l.length > 20);
      if (!lane) return false;
      // a clear stretch, away from the ends of the road
      const s = 8 + this.rnd() * (lane.length - 16);
      if (lane.cars.some((o) => o !== car && Math.abs(o.s - s) < 16)) continue;
      along(lane, s, tmp, tmp2); // (nor on you, nor on the car you left)
      if (this.blockers.some((b) => Math.hypot((b[0] + b[2]) / 2 - tmp.x, (b[1] + b[3]) / 2 - tmp.z) < 14)) continue;
      if (car.lane) car.lane.cars.splice(car.lane.cars.indexOf(car), 1);
      Object.assign(car, { lane, s, k: Math.floor(this.rnd() * lane.n), v: lane.speed * 0.5, next: undefined, waited: 0 });
      lane.cars.push(car);
      return true;
    }
    return false;
  }

  // The road a car will take after `lane`: not straight back; straighter and bigger roads preferred.
  chooseNext(lane) {
    const a = lane.pts.at(-2), b = lane.pts.at(-1), hx = b.x - a.x, hz = b.z - a.z, hl = Math.hypot(hx, hz) || 1;
    let next = null, key = -1;
    for (const o of this.graph.out[lane.to]) {
      if (o.edge === lane.edge) continue;
      const ox = o.pts[1].x - o.pts[0].x, oz = o.pts[1].z - o.pts[0].z, ol = Math.hypot(ox, oz) || 1;
      const straight = (hx * ox + hz * oz) / (hl * ol);
      if (straight < -0.6) continue;
      const k = Math.pow(this.rnd(), 1 / (o.weight * (0.4 + Math.max(0, straight) * 1.6)));
      if (k > key) { key = k; next = o; }
    }
    return next;
  }

  // May `car` cross the junction at the end of `lane` now? Claims the junction if so. The junction belongs
  // to one approach at a time; a vehicle going straight on may share it with oncoming traffic doing the same.
  mayCross(car, lane, toEnd) {
    const node = lane.to, x = this.crossing[this.graph.group[node]], now = shared.uTime.value, next = car.next;
    const straight = !!next && lane.hx * (next.pts[1].x - next.pts[0].x) + lane.hz * (next.pts[1].z - next.pts[0].z) > 0.8 * (next.cum[1] || 1);
    if (x.lane && x.lane !== lane && now < x.until) {
      const oncoming = lane.hx * x.lane.hx + lane.hz * x.lane.hz < -0.8;
      if (!(oncoming && straight && x.straight)) return false;
    }
    // without lights, give way to anyone arriving soon on a bigger road
    if (!lane.signal) for (const o of this.graph.into[node]) {
      if (o === lane || o.edge === lane.edge || o.weight <= lane.weight) continue;
      for (const c of o.cars) if (c.v > 0.5 && (o.length - c.s) / Math.max(c.v, 2) < 4.5) return false;
    }
    const until = now + toEnd / Math.max(car.v, 2) + 3.5; // time to get there and across
    if (x.lane === lane && now < x.until) { x.until = Math.max(x.until, until); x.straight = x.straight && straight; }
    else { x.lane = lane; x.until = until; x.straight = straight; }
    return true;
  }

  // red or yellow for a lane's approach? (27 s green, 3 s yellow, the rest red; the cross street 32 s later)
  stopLight(lane) { return lane.signal && (shared.uTime.value + lane.phase * 32) % CYCLE > GREEN; }

  update(dt, focus) {
    this.time += dt;
    const d = this.dummy;

    // ---- cars
    // more cars are spread over a wider circle, so the streets do not simply jam
    this.radius = CAR_RADIUS * Math.min(2.4, Math.max(1, Math.sqrt(this.count / CARS)));
    while (this.cars.length > this.count) { const gone = this.cars.pop(); if (gone.lane) gone.lane.cars.splice(gone.lane.cars.indexOf(gone), 1); }
    while (this.cars.length < this.count) {
      const r = this.rnd(); let acc = 0, type = 0;
      for (let i = 0; i < TYPES.length; i++) { acc += TYPES[i].share; if (r < acc) { type = i; break; } }
      const car = { type, id: Math.floor(this.rnd() * 1e9), lane: null }; // (its look: fleet.js lookOf, from its id)
      if (!this.spawnCar(car, focus)) break;
      this.cars.push(car);
    }
    this.fleet.begin();
    const eye = this.eye ?? focus, now = this.time;
    const { junction, into } = this.graph;
    for (const car of this.cars) {
      if (!car.lane && !this.spawnCar(car, focus)) continue; // nowhere to drive near the focus right now
      const lane = car.lane, L = TYPES[car.type].L;
      if (car.next === undefined) car.next = this.chooseNext(lane); // null at a dead end
      const next = car.next, toEnd = lane.length - car.s - L / 2; // front bumper to the end of this road

      // 1. the vehicle ahead: in this lane, or the last one on the road it is about to join
      let gap = Infinity, lead = 0;
      const kNext = next ? Math.min(car.k, next.n - 1) : car.k;
      for (const o of lane.cars) {
        if (o === car) continue;
        // same lane, or merging into the same lane at the end of this road (ties go to the left lane)
        const merging = next && toEnd < 35 && o.k !== car.k && Math.min(o.k, next.n - 1) === kNext && o.next === next;
        if (o.k === car.k ? o.s <= car.s : !(merging && (o.s > car.s + 0.5 || (Math.abs(o.s - car.s) <= 0.5 && o.k < car.k)))) continue;
        const g = o.s - car.s - (TYPES[o.type].L + L) / 2;
        if (g < gap) { gap = Math.max(g, 0); lead = o.v; }
      }
      // (and you, or your car, in the lane ahead: from where the car was drawn last)
      if (this.blockers.length && car.px != null) {
        const W = TYPES[car.type].spec.W;
        for (const b of this.blockers) for (let q = 0; q <= 2; q++) {
          const qx = b[0] + ((b[2] - b[0]) * q) / 2, qz = b[1] + ((b[3] - b[1]) * q) / 2, rx = qx - car.px, rz = qz - car.pz;
          const ahead = rx * car.hx + rz * car.hz, aside = Math.abs(rx * car.hz - rz * car.hx);
          if (ahead > 0 && ahead < 45 && aside < W / 2 + b[4] + 0.35 && ahead - L / 2 - b[4] < gap) { gap = Math.max(0, ahead - L / 2 - b[4]); lead = 0; }
        }
      }
      let roomAhead = true;
      if (next) {
        for (const o of next.cars) {
          if (o.k !== kNext) continue;
          const g = toEnd + o.s - TYPES[o.type].L / 2;
          if (g < gap) { gap = g; lead = o.v; }
          if (o.s < TYPES[o.type].L / 2 + L + 3) roomAhead = false; // the far side is still occupied
        }
      }
      // 2. the junction: a red light, no room beyond it, or the turn of another vehicle
      const stopAt = toEnd - lane.stop, braking = (car.v * car.v) / 7 + 5;
      const past = stopAt < -1; // already over the stop line: committed to crossing
      // (on a link inside a junction the car is already crossing: it only keeps clear of the vehicle ahead)
      let hold = !lane.inside && !past && (this.stopLight(lane) || (junction[lane.to] && !roomAhead));
      const giveWay = junction[lane.to] && !lane.signal && into[lane.to].some((o) => o.edge !== lane.edge && o.weight > lane.weight);
      if (!hold && !lane.inside && junction[lane.to] && stopAt < braking + 8) hold = !this.mayCross(car, lane, toEnd) && !past;
      if (hold && stopAt < gap) { gap = Math.max(0, stopAt); lead = 0; }

      // 3. speed: the limit, slower into a junction, a crawl up to a give-way line, a time gap behind the leader
      let want = lane.speed * (toEnd < 14 ? 0.55 : 1);
      if (giveWay && toEnd < 14) want = Math.min(want, 1.2 + toEnd * 0.35);
      if (gap < Infinity) want = Math.min(want, Math.max(0, lead + (gap - 2.5) / 1.4));
      if (gap < 0.6) want = 0;
      const was = car.v;
      car.v = Math.max(0, car.v + THREE.MathUtils.clamp(want - car.v, -6 * dt, 2.2 * dt));
      car.braking = car.v < was - 1.2 * dt || (car.v < 0.3 && want < 0.3);
      car.s += car.v * dt;
      // stuck for a long time (a jam that cannot clear): start again somewhere else
      car.waited = car.v < 0.2 ? (car.waited ?? 0) + dt : 0;
      if ((car.waited > 45 && !this.stopLight(lane)) || car.elsewhere) { car.elsewhere = false; if (!this.spawnCar(car, focus)) continue; }

      if (car.lane === lane && car.s >= lane.length) {
        lane.cars.splice(lane.cars.indexOf(car), 1);
        const x = this.crossing[this.graph.group[lane.to]];
        // still clearing the junction; longer if the way on is another link inside it
        if (x.lane === lane) x.until = Math.max(x.until, shared.uTime.value + 2.2 + (next?.inside ? next.length / Math.max(car.v, 3) : 0));
        if (next) { car.lane = next; car.s -= lane.length; car.k = Math.min(car.k, next.n - 1); car.next = undefined; next.cars.push(car); }
        else { car.lane = null; if (!this.spawnCar(car, focus)) continue; }
      }
      // left behind by the camera: start again nearby
      along(car.lane, car.s, tmp, tmp2);
      if (Math.hypot(tmp.x - focus.x, tmp.z - focus.z) > (this.radius ?? CAR_RADIUS) + 90) { if (!this.spawnCar(car, focus)) continue; along(car.lane, car.s, tmp, tmp2); }
      if (car.lane.hidden) continue;

      const off = car.lane.offset(car.k);
      let px = tmp.x - tmp2.z * off, pz = tmp.z + tmp2.x * off;
      const name = TYPES[car.type].name;
      // on its road's deck the flyovers draw under it, or the street the tiles draw (roadlevel.js): never at the road's
      // level where nothing is drawn at it
      const stood = this.drawn ? this.drawn.stand(this.surface, px, pz, tmp.y, Math.atan2(tmp2.x, tmp2.z), car.lane.edge) : { y: this.surface(px, pz), deck: false };
      if (stood.push) { px += stood.push[0]; pz += stood.push[1]; } // (onto it, from just beyond its edge)
      d.position.set(px, stood.y + 0.03, pz);
      // nose up or down with the road (and with it the light the lamps throw on it): the slope over the car's length
      const slope = stood.deck ? tmp2.y : (this.surface(px + tmp2.x * 5, pz + tmp2.z * 5) - this.surface(px - tmp2.x * 5, pz - tmp2.z * 5)) / 10;
      d.rotation.set(-Math.atan(slope), Math.atan2(tmp2.x, tmp2.z), 0);
      d.updateMatrix();
      Object.assign(car, { px, pz, py: d.position.y, hx: tmp2.x, hz: tmp2.z }); // (where it is: for what it stops for, and what runs into it)
      // on top of you (you were set down where it was): it starts again somewhere else, next frame
      if (this.blockers.length) {
        const h = Math.max(0, TYPES[car.type].L / 2 - TYPES[car.type].spec.W / 2), sx = tmp2.x * h, sz = tmp2.z * h, r = TYPES[car.type].spec.W / 2;
        if (this.blockers.some((b) => segDist(px - sx, pz - sz, px + sx, pz + sz, b[0], b[1], b[2], b[3]) < r + b[4] - 0.05)) { car.elsewhere = true; continue; }
      }
      // a lofted body: the full model near the camera, the stand-in further off; its wheels turning as it goes, its
      // brake lights, its turn signal blinking before a turn
      car.look ??= lookOf(name, car.id);
      const r = this.fleet.wheelRadius(car.look.body), far = (px - eye.x) ** 2 + (pz - eye.z) ** 2 + (d.position.y - eye.y) ** 2 > NEAR_LOD * NEAR_LOD;
      car.dist = (car.dist ?? 0) + car.v * dt;
      let left = 0, right = 0;
      if (next && car.lane === lane && toEnd < 35 && !lane.inside) {
        const a = next.pts[0], b = next.pts[Math.min(1, next.pts.length - 1)], turn = Math.atan2(b.x - a.x, b.z - a.z) - Math.atan2(lane.hx, lane.hz);
        const t = Math.atan2(Math.sin(turn), Math.cos(turn)), on = (now * 1.4 + (car.id % 997) / 997) % 1 < 0.5 ? 1 : 0;
        if (t > 0.5) left = on; else if (t < -0.5) right = on;
      }
      this.fleet.add(far ? 1 : 0, d.matrix, car.look, car.braking ? 1 : 0, left, right, car.dist / r, wheelBlur(car.v, r));
    }
    const night = shared.uNight.value;
    this.beam.color.setScalar(0.36 * this.headlights * night); // the light on the road just ahead of a car
    this.beam.visible = night > 0.02;
    this.fleet.end();
  }
}
