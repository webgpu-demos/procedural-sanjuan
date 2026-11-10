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
// And how they move: each follows its lane round the corners, not from one straight piece of road to the next (its
// way through a junction is an arc from its lane to the lane it takes, place()), turns as a car does, its rear axle
// following its front (never sideways, never on the spot), slows for the turn ahead by how sharp it is, and comes
// and goes out of sight, or fades.
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
// (other: the pixels left out are the ones the pattern keeps the other way, so that of two things dissolved one into
// the other, a car's model and its box, each pixel is drawn by one of them and only one)
export function dissolve(shader, other = false) {
  const [a, b, c, d] = DISSOLVE.vertex, [e, f, g, h] = DISSOLVE.fragment;
  shader.vertexShader = shader.vertexShader.replace(a, b).replace(c, d);
  shader.fragmentShader = shader.fragmentShader.replace(e, f).replace(g, other ? h.replace(' < vHide) discard;', ' >= 1.0 - vHide) discard;') : h);
}

// ---------------------------------------------------------------- the graph, as directed lanes
function buildGraph({ nodes, edges, signals }, surface) {
  const signalled = new Set(signals), out = nodes.map(() => []), into = nodes.map(() => []), lanes = [];
  for (const e of edges) {
    if (e.highway === 'service' && e.lanes <= 1) continue; // driveways and yards: not through traffic
    const pts = [];
    for (let i = 0; i < e.pts.length; i += 3) pts.push(new THREE.Vector3(e.pts[i], e.pts[i + 1], e.pts[i + 2]));
    const minor = ['residential', 'unclassified', 'living_street', 'service'].includes(e.highway);
    // (the expressway at its own speed, 55 mph on PR-22: held to the streets' 54 km/h it crawled; its ramps between the two)
    const fast = e.highway === 'motorway' ? 24 : e.highway === 'motorway_link' || e.highway === 'trunk' ? 18 : 15;
    const speed = Math.min(fast, Math.max(4.5, (e.maxspeed * (minor ? 0.6 : 0.8)) / 3.6));
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
      // (and the way it sets off, for its join with the road before)
      lane.sx = (p[1].x - p[0].x) / (cum[1] || 1); lane.sz = (p[1].z - p[0].z) / (cum[1] || 1);
      roundBends(lane);
      lanes.push(lane); out[lane.from].push(lane); into[lane.to].push(lane);
    }
  }
  // a junction: where a driver meets traffic from another road (three or more road ends)
  // (not where they all run the same way: a ramp joining the expressway, the expressway parting in two. Those are
  // merges, taken in turn by who is ahead (update: the zipper), and forks, taken without a thought. Held to be
  // junctions, crossed by one approach at a time, the expressway's cars braked to a stop line for a car on its ramp.)
  const sameWay = (i) => {
    const ways = [...into[i].map((l) => [l.hx, l.hz]), ...out[i].map((l) => [l.sx, l.sz])];
    for (let a = 0; a < ways.length; a++) for (let b = a + 1; b < ways.length; b++) if (ways[a][0] * ways[b][0] + ways[a][1] * ways[b][1] < 0.7) return false;
    return true;
  };
  const junction = nodes.map((_, i) => new Set([...out[i], ...into[i]].map((l) => l.edge)).size >= 3 && !sameWay(i));
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
  // The join from one road onto the next (place()): a car leaves its lane this far before the road's end (tin) and is
  // in the next one's this far along it (tout): the junction's half width and a little more, and never half a road.
  // (No more: the kerbs are drawn square at a corner, and a right turn begun further back, on a car's own turning
  // circle, runs over the corner of the sidewalk. It is tight instead, and taken at the speed of a turn that tight.)
  for (const l of lanes) { l.tin = Math.min(reach[l.to] + 3, l.length * 0.45); l.tout = Math.min(reach[l.from] + 3, l.length * 0.45); }
  return { lanes, out, into, junction, group };
}

const tmp = new THREE.Vector3(), tmp2 = new THREE.Vector3();
const NO_FIT = [0, 0];
// what a driver takes a turn at: this much across (m/s²: an unhurried driver's), and no slower than a crawl (m/s)
const ACROSS = 2.2, SLOWEST = 2;
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

// A car's way: its road's line, moved `off` metres across to the right (o: { x, y, z, dx, dz, slope, rate }, the way it
// runs there), and rounded where the line bends: within lane.round of a bend (roundBends), an arc from the lane as it runs before it to
// the lane as it runs after. (The line moved across piece by piece breaks at every bend: on the outside of one the two
// pieces' lanes stand apart, on the inside they overlap, and a car a metre off the line jumped a metre along it at a
// street's 50° corner.)
function lanePoint(lane, s, off, o) {
  const { pts, cum, round } = lane, last = cum.length - 1;
  o.rate = 1;
  let lo = 0, hi = last;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (cum[mid] <= s) lo = mid; else hi = mid; }
  const a = pts[lo], b = pts[hi], len = cum[hi] - cum[lo] || 1, t = Math.min(1, Math.max(0, (s - cum[lo]) / len));
  o.y = a.y + (b.y - a.y) * t; o.slope = (b.y - a.y) / len;
  const v = lo > 0 && s - cum[lo] < round[lo] ? lo : hi < last && cum[hi] - s < round[hi] ? hi : -1;
  if (v < 0) {
    const dx = (b.x - a.x) / len, dz = (b.z - a.z) / len;
    o.x = a.x + (b.x - a.x) * t - dz * off; o.z = a.z + (b.z - a.z) * t + dx * off; o.dx = dx; o.dz = dz;
    return o;
  }
  const p = pts[v - 1], q = pts[v], n = pts[v + 1], r = round[v], l1 = cum[v] - cum[v - 1] || 1, l2 = cum[v + 1] - cum[v] || 1;
  const d1x = (q.x - p.x) / l1, d1z = (q.z - p.z) / l1, d2x = (n.x - q.x) / l2, d2z = (n.z - q.z) / l2;
  // from the lane r before the bend to the lane r after it, by way of where the two meet (the mitre); on the inside of
  // a bend tighter than the lane is far from the line, where they meet lies behind both: straight across instead
  const ax = q.x - d1x * r - d1z * off, az = q.z - d1z * r + d1x * off, bx = q.x + d2x * r - d2z * off, bz = q.z + d2z * r + d2x * off;
  const m = off / Math.max(0.3, 1 + d1x * d2x + d1z * d2z), reach = r - off * (d1x * d2z - d1z * d2x) / Math.max(0.3, 1 + d1x * d2x + d1z * d2z);
  const cx = reach > 0.2 ? q.x - (d1z + d2z) * m : (ax + bx) / 2, cz = reach > 0.2 ? q.z + (d1x + d2x) * m : (az + bz) / 2;
  const u = Math.min(1, Math.max(0, (s - (cum[v] - r)) / (2 * r))), w0 = (1 - u) * (1 - u), w1 = 2 * u * (1 - u), w2 = u * u;
  o.x = w0 * ax + w1 * cx + w2 * bx; o.z = w0 * az + w1 * cz + w2 * bz;
  const tx = (1 - u) * (cx - ax) + u * (bx - cx), tz = (1 - u) * (cz - az) + u * (bz - cz), tl = Math.hypot(tx, tz);
  if (tl > 1e-6) { o.dx = tx / tl; o.dz = tz / tl; } else { o.dx = d2x; o.dz = d2z; }
  o.rate = Math.max(0.25, tl / r); // (the curve's length for a metre of the line's: shorter inside the bend, longer outside)
  return o;
}
// How far either side of each inner point of a road's line its bend is rounded (lanePoint): as far as cuts the corner
// by no more than 0.7 m (2 m either side of a right angle, 16 m of a bend of 10°: the expressway's line, a bend of a
// few degrees every thirty metres, is driven as the curve it stands for, and no car crosses a street corner's
// sidewalk), never half a piece; 0 where the line runs straight on. And the bends a car slows for (lane.bends:
// [{ s, r, v }]: the speed it takes the tightest of that arc at, ACROSS m/s² across), where under the road's own.
function roundBends(lane) {
  const { pts, cum } = lane, n = pts.length, round = new Float32Array(n), bends = [];
  for (let v = 1; v < n - 1; v++) {
    const l1 = cum[v] - cum[v - 1], l2 = cum[v + 1] - cum[v];
    if (l1 < 0.05 || l2 < 0.05) continue;
    const cos = ((pts[v].x - pts[v - 1].x) * (pts[v + 1].x - pts[v].x) + (pts[v].z - pts[v - 1].z) * (pts[v + 1].z - pts[v].z)) / (l1 * l2);
    const bend = Math.acos(Math.max(-1, Math.min(1, cos)));
    if (bend < 0.03) continue;
    const half = Math.min(bend, 2.8) / 2, r = Math.min(40, l1 * 0.45, l2 * 0.45, 1.4 / Math.sin(half));
    round[v] = r;
    const speed = Math.sqrt(ACROSS * r * Math.cos(half) ** 2 / Math.tan(half));
    if (speed < lane.speed) bends.push({ s: cum[v], r, v: Math.max(SLOWEST, speed) });
  }
  lane.round = round; lane.bends = bends;
}
const P0 = { x: 0, y: 0, z: 0, dx: 0, dz: 1, slope: 0, rate: 1 }, P2 = { x: 0, y: 0, z: 0, dx: 0, dz: 1, slope: 0, rate: 1 };
// The join of road A onto road B: how far before A's end a car leaves A's line (zA) and how far along B it is on B's
// (zB). At a junction, the roads' own (tin, tout: the junction's half width and a little). Where the road only carries
// on, a bend of a few degrees between two of OSM's ways, as long as a bend of that angle within one way is rounded
// (roundBends: the same 0.7 m of corner cut), so that a ramp drawn as five ways is driven as one curve, not kinked
// 10° in nine metres at each of their joins (at 60 km/h, a swerve).
function joinOf(A, B) {
  let j = A.joins?.get(B);
  if (j) return j;
  const bend = Math.acos(Math.max(-1, Math.min(1, A.hx * B.sx + A.hz * B.sz)));
  let zA = A.tin, zB = B.tout;
  if (bend < 0.4) {
    const z = Math.min(40, 1.4 / Math.sin(Math.max(bend, 0.01) / 2));
    zA = Math.max(zA, Math.min(z, A.length * 0.45)); zB = Math.max(zB, Math.min(z, B.length * 0.45));
  }
  (A.joins ??= new Map()).set(B, (j = { zA, zB }));
  return j;
}
// The join from road A (offA across it) onto road B (offB), a share u of the way through it: a curve that leaves A
// along A's way and joins B along B's (a cubic through both ends, its slope at each the road's own: an arc round a
// corner, an S where the road carries on a little to one side, straight where it simply carries on). o.rate: how far
// the curve runs there for a metre of the roads' own lengths (a car goes along it at its own speed, not the lines').
function turnPoint(A, offA, B, offB, u, o) {
  const J = joinOf(A, B);
  lanePoint(A, A.length - J.zA, offA, P0); lanePoint(B, J.zB, offB, P2);
  const ex = P2.x - P0.x, ez = P2.z - P0.z, m = Math.hypot(ex, ez), u2 = u * u, u3 = u2 * u;
  const h10 = u3 - 2 * u2 + u, h01 = 3 * u2 - 2 * u3, h11 = u3 - u2;
  o.x = P0.x + h01 * ex + m * (h10 * P0.dx + h11 * P2.dx); o.z = P0.z + h01 * ez + m * (h10 * P0.dz + h11 * P2.dz);
  const g01 = 6 * (u - u2), g10 = 3 * u2 - 4 * u + 1, g11 = 3 * u2 - 2 * u;
  const tx = g01 * ex + m * (g10 * P0.dx + g11 * P2.dx), tz = g01 * ez + m * (g10 * P0.dz + g11 * P2.dz), tl = Math.hypot(tx, tz);
  if (tl > 1e-6) { o.dx = tx / tl; o.dz = tz / tl; } else { o.dx = P2.dx; o.dz = P2.dz; }
  o.y = P0.y + (P2.y - P0.y) * u; o.slope = P0.slope + (P2.slope - P0.slope) * u;
  o.rate = tl / (J.zA + J.zB || 1);
  return o;
}
// The radius (m) of the turn from `offA` across A onto B at offB: of the arc through where the join leaves A and where
// it meets B, turning through the angle between them (Infinity where they run the same way)
function turnRadius(A, offA, B, offB) {
  const J = joinOf(A, B);
  lanePoint(A, A.length - J.zA, offA, P0); lanePoint(B, J.zB, offB, P2);
  const bend = Math.acos(Math.max(-1, Math.min(1, P0.dx * P2.dx + P0.dz * P2.dz)));
  return bend < 0.02 ? Infinity : Math.hypot(P2.x - P0.x, P2.z - P0.z) / (2 * Math.sin(bend / 2));
}
// How far across B a car going straight on from `offA` across A comes onto it, or null where the two do not run the
// same way (a turn of more than 20°). OSM draws one road as many ways, each with its own count of lanes and its own
// line: four lanes into two and a ramp, the three lines meeting in the middle of the four.
const STRAIGHT_ON = 0.94;
function straightOn(A, offA, B) {
  const J = joinOf(A, B);
  lanePoint(A, A.length - J.zA, offA, P0); lanePoint(B, J.zB, 0, P2);
  if (P0.dx * P2.dx + P0.dz * P2.dz < STRAIGHT_ON) return null;
  const fwd = (P2.x - P0.x) * P0.dx + (P2.z - P0.z) * P0.dz;
  return (P0.x + P0.dx * fwd - P2.x) * -P2.dz + (P0.z + P0.dz * fwd - P2.z) * P2.dx;
}
// The lane of B a car in lane k of A takes: where the road carries on, the one nearest where it is; round a corner to
// the left, the same one counted from the middle of the road, to the right, from the kerb (a right turn from a street
// of one lane into an avenue of three took the middle lane, across the other two).
function laneInto(A, k, B) {
  const lat = straightOn(A, A.offset(k), B);
  // (a right turn into the same lane counted from the kerb, a left turn from the middle: P0 and P2 are straightOn's)
  if (lat == null) return P0.dx * P2.dz - P0.dz * P2.dx > 0 ? B.n - 1 - Math.min(A.n - 1 - k, B.n - 1) : Math.min(k, B.n - 1);
  let best = 0, bd = Infinity;
  for (let j = 0; j < B.n; j++) { const d = Math.abs(B.offset(j) - lat); if (d < bd) { bd = d; best = j; } }
  return best;
}
// Where across B a car `offA` across A comes onto it: round a corner, in its lane there (kb); where the road carries
// on, where going straight on puts it, which is not always in a lane of B's (a ramp leaves from the expressway's
// line, and is driven onto from its outer lane, where the paving of the two is one): from there it
// moves across into its lane as a driver changes lanes (update), not within the length of the join. (Put straight into
// the lane with the same number, every car on the expressway stepped a lane's width sideways in ten metres wherever
// OSM's ways change their count of lanes: 35 m/s² across, at every join of an interchange.)
function entryOffset(A, offA, B, kb) {
  const lat = straightOn(A, offA, B), target = B.offset(kb);
  if (lat == null) return target;
  return Math.max(B.offset(0) - 9, Math.min(B.offset(B.n - 1) + 9, lat));
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
    this.sees = null; // sees(x, y, z): is that place in the picture? (main.js: the camera's view) A car starting again does so out of it
    this.front = { x: 0, y: 0, z: 0, dx: 0, dz: 1, slope: 0, rate: 1 };
  }

  // Where a car's way is at distance s along its road, as far across it as the car is (car.off): round the corner from
  // the road it came off (within that road's join, lane.tout) and onto the one it takes next (lane.tin before the end,
  // and on along it past the end; and past the end of that, a link of a metre or two inside a junction, onto the one
  // after: car.after, chosen here)
  place(car, s, o) {
    let lane = car.lane, off = car.off, k = car.k, from = car.from ?? null, offFrom = car.offFrom ?? 0, next = car.next ?? null, kNext = car.kNext ?? 0;
    for (let hop = 0; hop < 2 && s > lane.length && next; hop++) {
      const into = entryOffset(lane, off, next, kNext);
      from = lane; offFrom = off; s -= lane.length; lane = next; off = into; k = kNext;
      if (hop) next = null;
      else {
        if (car.after === undefined) { car.after = this.chooseNext(lane, k); car.kAfter = car.after ? laneInto(lane, k, car.after) : 0; }
        next = car.after; kNext = car.kAfter;
      }
    }
    if (s > lane.length) s = lane.length;
    if (from) { const J = joinOf(from, lane); if (s < J.zB) return turnPoint(from, offFrom, lane, off, (J.zA + s) / (J.zA + J.zB), o); }
    if (next) { const J = joinOf(lane, next); if (s > lane.length - J.zA) return turnPoint(lane, off, next, entryOffset(lane, off, next, kNext), (s - (lane.length - J.zA)) / (J.zA + J.zB), o); }
    return lanePoint(lane, s, off, o);
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

  // anywhere: in the picture too (the first cars, and after a cut to another place: they are there, not arriving)
  spawnCar(car, focus, anywhere = false) {
    for (let attempt = 0; attempt < 6; attempt++) {
      const lane = this.pick(focus, this.radius ?? CAR_RADIUS, (l) => !l.hidden && l.length > 20);
      if (!lane) return false;
      // a clear stretch, away from the ends of the road
      const s = 8 + this.rnd() * (lane.length - 16);
      if (lane.cars.some((o) => o !== car && Math.abs(o.s - s) < 16)) continue;
      along(lane, s, tmp, tmp2);
      // (within reach: a long road's middle is, its far end may not be, and a car put there started again every frame)
      if (Math.hypot(tmp.x - focus.x, tmp.z - focus.z) > (this.radius ?? CAR_RADIUS) + 60) continue;
      // (nor on you, nor on the car you left)
      if (this.blockers.some((b) => Math.hypot((b[0] + b[2]) / 2 - tmp.x, (b[1] + b[3]) / 2 - tmp.z) < 14)) continue;
      // (out of the picture, if there is such a place among the tries: a car that appears in the middle of the street
      // looked at is seen to; the last try is taken wherever it is, and the car fades in)
      if (!anywhere && attempt < 5 && this.sees?.(tmp.x, tmp.y, tmp.z)) continue;
      if (car.lane) car.lane.cars.splice(car.lane.cars.indexOf(car), 1);
      const k = Math.floor(this.rnd() * lane.n);
      Object.assign(car, { lane, s, k, off: lane.offset(k), offV: 0, rate: 1, v: lane.speed * 0.5, next: undefined, after: undefined, waited: 0, from: null, shown: anywhere ? 1 : 0, leaving: false, rx: null, fx: 0, fz: 0 });
      lane.cars.push(car);
      return true;
    }
    return false;
  }

  // What the way on (car.next) asks of a car on car.lane: its lane there (kNext, or one already settled), the radius of
  // the turn onto it, and, where the road only carries on into fewer lanes or other ones, how far across it must move
  // before the end so as to come onto its lane there going straight on (shift: a lane that ends is left before it
  // ends. Left after, the car rode 3 m and more outside the narrower road for a hundred metres.)
  plan(car, kNext = null) {
    const lane = car.lane, next = car.next;
    if (!next) { car.kNext = 0; car.radius = 0; car.shift = 0; return; }
    car.kNext = kNext ?? laneInto(lane, car.k, next);
    car.radius = turnRadius(lane, lane.offset(car.k), next, next.offset(car.kNext));
    const lat = straightOn(lane, lane.offset(car.k), next);
    car.shift = lat == null ? 0 : Math.max(-6, Math.min(6, next.offset(car.kNext) - lat));
  }

  // The road a car in lane k of `lane` will take after it: not straight back; straighter and bigger roads preferred, and
  // where the road forks (the expressway and its ramp), the one its lane runs into rather than one across the others.
  chooseNext(lane, k = 0) {
    const a = lane.pts.at(-2), b = lane.pts.at(-1), hx = b.x - a.x, hz = b.z - a.z, hl = Math.hypot(hx, hz) || 1;
    let next = null, key = -1;
    for (const o of this.graph.out[lane.to]) {
      if (o.edge === lane.edge) continue;
      const ox = o.pts[1].x - o.pts[0].x, oz = o.pts[1].z - o.pts[0].z, ol = Math.hypot(ox, oz) || 1;
      const straight = (hx * ox + hz * oz) / (hl * ol);
      if (straight < -0.6) continue;
      let w = o.weight * (0.4 + Math.max(0, straight) * 1.6);
      const lat = straightOn(lane, lane.offset(k), o);
      if (lat != null) { const miss = Math.max(0, o.offset(0) - lat, lat - o.offset(o.n - 1)) / 2.5; w /= 1 + miss * miss * miss; }
      const pick = Math.pow(this.rnd(), 1 / w);
      if (pick > key) { key = pick; next = o; }
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
  // (and is it yellow: the 3 s after the green)
  yellow(lane) { const t = (shared.uTime.value + lane.phase * 32) % CYCLE; return lane.signal && t > GREEN && t <= GREEN + 3; }

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
      if (!this.spawnCar(car, focus, true)) break;
      this.cars.push(car);
    }
    this.fleet.begin();
    const eye = this.eye ?? focus, now = this.time;
    const { junction, into } = this.graph;
    // (a cut to another place, the view gone further in a frame than a car is kept within: the cars round the new one
    // are simply there, in the picture too)
    const at = this.focusAt ??= { x: focus.x, z: focus.z }, cut = Math.hypot(focus.x - at.x, focus.z - at.z) > 150;
    at.x = focus.x; at.z = focus.z;
    for (const car of this.cars) {
      if (!car.lane && !this.spawnCar(car, focus, cut)) continue; // nowhere to drive near the focus right now
      // Starting again somewhere else (left behind by the view, stuck, at a dead end), a car fades out where it is and in
      // where it starts, and starts out of the picture where it can (spawnCar): it was gone from one frame to the next,
      // and there in the middle of the street looked at.
      if (car.leaving) {
        if ((car.shown -= dt / 0.5) <= 0 || cut) { if (!this.spawnCar(car, focus, cut)) { car.shown = 0; continue; } }
      } else if (car.shown < 1) car.shown = Math.min(1, car.shown + dt / 0.7);
      const lane = car.lane, L = TYPES[car.type].L;
      if (car.next === undefined) { // (null at a dead end)
        car.next = this.chooseNext(lane, car.k); this.plan(car);
      }
      const next = car.next, toEnd = lane.length - car.s - L / 2; // front bumper to the end of this road
      // (and the one after a short road, an interchange's links of ten or forty metres: its turn is slowed for from here)
      if (next && next.length < 80 && car.after === undefined) {
        car.after = this.chooseNext(next, car.kNext); car.kAfter = car.after ? laneInto(next, car.kNext, car.after) : 0;
      }

      // 1. the vehicle ahead: in this lane, or the last one on the road it is about to join
      let gap = Infinity, lead = 0;
      const kNext = next ? car.kNext : car.k, ahead = Math.max(35, 4 * car.v); // (ahead: how far before a road's end a driver sorts out the merge)
      for (const o of lane.cars) {
        if (o === car) continue;
        // same lane, or merging into the same lane at the end of this road (ties go to the left lane)
        const merging = next && toEnd < ahead && o.k !== car.k && o.next === next && o.kNext === kNext;
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
        // (and on the road after a short one: an interchange's links are ten to forty metres, a queue is longer)
        if (car.after && next.length < 80) for (const o of car.after.cars) {
          if (o.k !== car.kAfter) continue;
          const g = toEnd + next.length + o.s - TYPES[o.type].L / 2;
          if (g < gap) { gap = g; lead = o.v; }
        }
        // A merge (roads running the same way into one: no junction, buildGraph): the cars of the other roads bound
        // for the same lane are taken in turn, whoever is nearer the end first: the one behind follows the one ahead
        // as if it were in its own lane (a zipper).
        if (!junction[lane.to] && toEnd < ahead && into[lane.to].length > 1) for (const m of into[lane.to]) {
          if (m === lane || m.edge === lane.edge) continue;
          for (const o of m.cars) {
            if (o.next !== next || o.kNext !== kNext) continue;
            const mine = lane.length - car.s, its = m.length - o.s;
            if (its > mine || (its === mine && o.id > car.id)) continue; // (behind: it follows this one)
            const g = mine - its - (TYPES[o.type].L + L) / 2;
            if (g < gap) { gap = Math.max(g, 0); lead = o.v; }
          }
        }
      }
      // 2. the junction: a red light, no room beyond it, or the turn of another vehicle
      const stopAt = toEnd - lane.stop, braking = (car.v * car.v) / 7 + 5;
      const past = stopAt < -1; // already over the stop line: committed to crossing
      // (on a link inside a junction the car is already crossing: it only keeps clear of the vehicle ahead)
      // (a light gone yellow too late to stop for, at 3.5 m/s², is run, as a driver would: held for whatever the
      // distance, a car ten metres from the line braked hard, crossed anyway and set off again)
      const red = this.stopLight(lane) && !(this.yellow(lane) && stopAt < (car.v * car.v) / 7);
      let hold = !lane.inside && !past && (red || (junction[lane.to] && !roomAhead));
      const giveWay = junction[lane.to] && !lane.signal && into[lane.to].some((o) => o.edge !== lane.edge && o.weight > lane.weight);
      if (!hold && !lane.inside && junction[lane.to] && stopAt < braking + 8) hold = !this.mayCross(car, lane, toEnd) && !past;
      if (hold && stopAt < gap) { gap = Math.max(0, stopAt); lead = 0; }

      // 3. speed: the limit, slower into a turn, a crawl up to a give-way line, a time gap behind the leader
      // Into the turn ahead at the speed a car takes one that sharp, braking for it from as far back as that takes (a
      // gentle 2.5 m/s²); a junction crossed straight on, a little slower; and where the road only carries on, not at
      // all. (Every road's last 14 m at 55% of its speed, whatever came next: OSM draws one road as many ways, a new
      // one at every bridge and change of name, and the expressway's cars braked and set off again at each.)
      let want = lane.speed;
      // (the speed of a turn: ACROSS m/s² across on the arc it makes, car.radius; a dead end is come to at a crawl)
      const turn = !next ? 3 : Math.max(SLOWEST, Math.sqrt(ACROSS * car.radius));
      if (turn < want) want = Math.min(want, Math.sqrt(turn * turn + 5 * Math.max(0, toEnd - (next ? joinOf(lane, next).zA : 0))));
      // (a junction crossed straight on: a little slower, eased off from 30 m back)
      else if (toEnd < 30 && junction[lane.to] && !lane.inside && !lane.motorway) want *= 0.85 + 0.15 * Math.max(0, (toEnd - 14) / 16);
      // (and down to the next road's speed by its start, not braked for once on it)
      if (next && next.speed < want) want = Math.min(want, Math.sqrt(next.speed * next.speed + 5 * Math.max(0, toEnd)));
      if (next && next.length < 80 && car.after) {
        const after = Math.max(SLOWEST, Math.sqrt(ACROSS * turnRadius(next, next.offset(car.kNext), car.after, car.after.offset(car.kAfter))));
        if (after < want) want = Math.min(want, Math.sqrt(after * after + 5 * Math.max(0, toEnd + next.length - joinOf(next, car.after).zA)));
      }
      // (still coming out of the turn onto this road: no faster until it is round it)
      if (car.from && car.turned < want && car.s < joinOf(car.from, lane).zB + L * 0.3) want = car.turned;
      // (and for a bend in the road itself, a street's corner: lane.bends)
      for (const b of lane.bends) if (car.s < b.s + b.r && b.v < want) want = Math.min(want, Math.sqrt(b.v * b.v + 5 * Math.max(0, b.s - b.r - car.s - L / 2)));
      if (giveWay && toEnd < 14) want = Math.min(want, 1.2 + toEnd * 0.35);
      // Behind the one ahead: its speed and a time gap, and no faster than can be shed at 3 m/s² in the room there is
      // (the time gap alone starts to brake 1.4 s short of whatever stands ahead: from 23 m at a street's speed, at the
      // most a car can brake, and from the expressway's 24 m/s it ended ten metres inside the queue's last car)
      if (gap < Infinity) want = Math.min(want, Math.max(0, lead + (gap - 2.5) / 1.4), Math.sqrt(lead * lead + 6 * Math.max(0, gap - 2.5)));
      if (gap < 0.6) want = 0;
      const was = car.v;
      // (it brakes as a driver does, at 3.5 m/s² at the most, and harder, up to 6.5, only when the room ahead asks it:
      // every drop in the speed wanted, a light gone red far ahead, was taken at 6)
      const hard = gap < Infinity ? (car.v * car.v - lead * lead) / (2 * Math.max(0.5, gap - 2)) : 0;
      car.v = Math.max(0, car.v + THREE.MathUtils.clamp(want - car.v, -Math.min(6.5, Math.max(3.5, hard)) * dt, 2.2 * dt));
      car.braking = car.v < was - 1.2 * dt || (car.v < 0.3 && want < 0.3);
      // (along a join's curve at its own speed: the curve is a little shorter or longer than the roads' lines, car.rate)
      car.s += car.v * dt / Math.min(1.8, Math.max(0.6, car.rate ?? 1));
      // Across its road into its lane as a driver changes lanes: a spring, critically damped (3 m in four or five
      // seconds), and no faster across than a third of its speed (standing, not at all).
      {
        const w = 0.9, cap = Math.min(1.4, 0.35 * car.v);
        const to = lane.offset(car.k) + (next && toEnd < Math.max(60, 4 * car.v) ? car.shift : 0);
        const ov = Math.max(-cap, Math.min(cap, car.offV + (w * w * (to - car.off) - 2 * w * car.offV) * dt));
        car.off += ov * dt; car.offV = ov;
      }
      // stuck for a long time (a jam that cannot clear), or coming to a dead end: start again somewhere else
      car.waited = car.v < 0.2 ? (car.waited ?? 0) + dt : 0;
      if ((car.waited > 45 && !this.stopLight(lane)) || (!next && toEnd < 10)) car.leaving = true;
      // (on top of you: gone at once)
      if (car.elsewhere) { car.elsewhere = false; if (!this.spawnCar(car, focus)) continue; }

      if (car.lane === lane && car.s >= lane.length) {
        if (!next) car.s = lane.length; // (the dead end: it stands there, fading)
        else {
          lane.cars.splice(lane.cars.indexOf(car), 1);
          const x = this.crossing[this.graph.group[lane.to]];
          // still clearing the junction; longer if the way on is another link inside it
          if (x.lane === lane) x.until = Math.max(x.until, shared.uTime.value + 2.2 + (next.inside ? next.length / Math.max(car.v, 3) : 0));
          // (the road it came off, and its lane there: its way round the corner, place())
          const entry = entryOffset(lane, car.off, next, car.kNext);
          car.from = lane; car.offFrom = car.off; car.turned = turn;
          car.lane = next; car.s -= lane.length; car.k = car.kNext; car.off = entry; next.cars.push(car);
          if (car.after !== undefined) { car.next = car.after; car.kNext = car.kAfter; }
          else car.next = this.chooseNext(next, car.k);
          const kAfter = car.after !== undefined ? car.kNext : null;
          car.after = undefined;
          this.plan(car, kAfter);
        }
      }
      // left behind by the camera: start again nearby
      along(car.lane, car.s, tmp, tmp2);
      if (Math.hypot(tmp.x - focus.x, tmp.z - focus.z) > (this.radius ?? CAR_RADIUS) + 90) {
        if (!cut) car.leaving = true;
        else { if (!this.spawnCar(car, focus, true)) continue; along(car.lane, car.s, tmp, tmp2); }
      }
      if (car.lane.hidden) { car.rx = null; continue; } // (in a tunnel: it comes out placed afresh)

      // Where it is drawn: its front axle on its way (round the corners: place()), its rear axle following a wheelbase
      // behind (dragged, a tractrix: where the front has been, cut a little inside), the car between the two and
      // facing along them. It turns through a corner, and through a bend drawn as two straight pieces of road, as a
      // car does: no step in where it is or the way it faces, and nothing sideways. (It stood on its road's line and
      // faced along the piece under it: at every corner it jumped across to the next road's lane, up to 6 m, and
      // turned 90° in a frame.)
      const T = TYPES[car.type], name = T.name, wb = L * 0.58, roadY = tmp.y, grade = tmp2.y;
      const F = this.place(car, car.s + wb / 2, this.front);
      car.rate = F.rate;
      if (car.rx == null || (F.x - car.rx) ** 2 + (F.z - car.rz) ** 2 > (wb + 3) ** 2) { car.rx = F.x - F.dx * wb; car.rz = F.z - F.dz * wb; }
      else { const bx = F.x - car.rx, bz = F.z - car.rz, bl = Math.hypot(bx, bz) || 1; car.rx = F.x - (bx / bl) * wb; car.rz = F.z - (bz / bl) * wb; }
      const hx = (F.x - car.rx) / wb, hz = (F.z - car.rz) / wb;
      let px = (F.x + car.rx) / 2, pz = (F.z + car.rz) / 2;
      // on its road's deck the flyovers draw under it, or the street the tiles draw (roadlevel.js): never at the road's
      // level where nothing is drawn at it
      const hd = Math.atan2(hx, hz);
      let stood = this.drawn ? this.drawn.stand(this.surface, px, pz, roadY, hd, car.lane.edge) : { y: this.surface(px, pz), deck: false };
      // (onto the deck, from just beyond its edge, and its whole body on what is drawn, roadlevel.js fit: one move
      // across, eased. The first was made at once: a car in an outer lane stepped a metre sideways where a deck began.)
      if (this.drawn) {
        let cx = 0, cz = 0;
        if (stood.push) { cx = stood.push[0]; cz = stood.push[1]; }
        const f = this.drawn.fit(this.surface, px + cx, pz + cz, stood.y, hd, stood.deck, T.spec.W, T.L, car.lane.edge) ?? NO_FIT;
        cx += f[0]; cz += f[1];
        const k = 1 - Math.exp(-dt / (cx * cx + cz * cz > car.fx ** 2 + car.fz ** 2 ? 0.25 : 0.6)); // (out of a parapet sooner than back)
        // (and no faster than 1.5 m/s: where a deck begins the move wanted can be metres one way for a frame and gone the next)
        let mx = (cx - car.fx) * k, mz = (cz - car.fz) * k; const m = Math.hypot(mx, mz), most = 1.5 * dt;
        if (m > most) { mx *= most / m; mz *= most / m; }
        car.fx += mx; car.fz += mz;
        if (Math.abs(car.fx) + Math.abs(car.fz) > 0.01) { px += car.fx; pz += car.fz; stood = this.drawn.stand(this.surface, px, pz, roadY, hd, car.lane.edge); }
      }
      d.position.set(px, stood.y + 0.03, pz);
      // nose up or down with the road (and with it the light the lamps throw on it): the slope over the car's length
      const slope = stood.deck ? grade : (this.surface(px + hx * 5, pz + hz * 5) - this.surface(px - hx * 5, pz - hz * 5)) / 10;
      d.rotation.set(-Math.atan(slope), hd, 0);
      d.updateMatrix();
      car.px = px; car.pz = pz; car.py = d.position.y; car.hx = hx; car.hz = hz; // (where it is: for what it stops for, and what runs into it)
      // on top of you (you were set down where it was): it starts again somewhere else, next frame
      if (this.blockers.length) {
        const h = Math.max(0, L / 2 - T.spec.W / 2), sx = hx * h, sz = hz * h, r = T.spec.W / 2;
        if (this.blockers.some((b) => segDist(px - sx, pz - sz, px + sx, pz + sz, b[0], b[1], b[2], b[3]) < r + b[4] - 0.05)) { car.elsewhere = true; continue; }
      }
      // a lofted body: the full model near the camera, the stand-in further off; its wheels turning as it goes, its
      // brake lights, its turn signal blinking before a turn
      car.look ??= lookOf(name, car.id);
      const r = this.fleet.wheelRadius(car.look.body), far = (px - eye.x) ** 2 + (pz - eye.z) ** 2 + (d.position.y - eye.y) ** 2 > NEAR_LOD * NEAR_LOD;
      car.dist = (car.dist ?? 0) + car.v * dt;
      // (its signal: from 35 m before a turn until it is round it. It went out at the junction, half way through.)
      if (next && car.lane === lane && toEnd < 35 && !lane.inside) {
        const a = next.pts[0], b = next.pts[Math.min(1, next.pts.length - 1)], turning = Math.atan2(b.x - a.x, b.z - a.z) - Math.atan2(lane.hx, lane.hz);
        const t = Math.atan2(Math.sin(turning), Math.cos(turning));
        car.sig = t > 0.5 ? 1 : t < -0.5 ? -1 : 0;
      } else if (!(car.from && car.s < joinOf(car.from, car.lane).zB)) car.sig = 0;
      const blink = car.sig && (now * 1.4 + (car.id % 997) / 997) % 1 < 0.5 ? 1 : 0, left = car.sig > 0 ? blink : 0, right = car.sig < 0 ? blink : 0;
      this.fleet.add(far ? 1 : 0, d.matrix, car.look, car.braking ? 1 : 0, left, right, car.dist / r, wheelBlur(car.v, r), 1 - car.shown * car.shown * (3 - 2 * car.shown));
    }
    const night = shared.uNight.value;
    this.beam.color.setScalar(0.36 * this.headlights * night); // the light on the road just ahead of a car
    this.beam.visible = night > 0.02;
    this.fleet.end();
  }
}
