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
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { shared } from './materials.js';
import { LAMP_LAYER, lampMaterial, lampUniforms, HERO_RIM } from './lamplight.js';

const LANE = 3.0;
const CAR_RADIUS = 330, CARS = 260; // the default number of cars, and the distance from the focus they keep within
export const MAX_CARS = 1500;
const CYCLE = 64, GREEN = 27; // seconds: must match the lens shader in props.js
const LANE_CELL = 256;         // metres: the cells lanes are bucketed in, to pick one near the focus

// ---------------------------------------------------------------- models
// Parts carry a colour and a code per vertex (aGlow): 0 paint, 1 headlamp, 2 tail lamp, 3 glass, 4 rubber and
// trim. Paint of colour 1,1,1 is tinted per car by the instance colour; glass and trim are dark, so the tint
// barely shows on them.
function finish(g, rgb, code) {
  g = g.index ? g.toNonIndexed() : g;
  const n = g.attributes.position.count, c = new Float32Array(n * 3), e = new Float32Array(n);
  for (let i = 0; i < n; i++) { c.set(rgb, i * 3); e[i] = code; }
  g.setAttribute('color', new THREE.BufferAttribute(c, 3));
  g.setAttribute('aGlow', new THREE.BufferAttribute(e, 1));
  g.deleteAttribute('uv');
  return g;
}
const part = (w, h, d, x, y, z, rgb, code = 0) => finish(new THREE.BoxGeometry(w, h, d).translate(x, y, z), rgb, code);
// A block that narrows and shortens towards its top: width w0 and length zA0..zB0 at y0, w1 and zA1..zB1 at y1.
function taper(w0, w1, y0, y1, zA0, zB0, zA1, zB1, rgb, code = 0) {
  const g = new THREE.BoxGeometry(1, 1, 1), p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const top = p.getY(i) > 0, front = p.getZ(i) > 0;
    p.setXYZ(i, p.getX(i) * (top ? w1 : w0), top ? y1 : y0, top ? (front ? zB1 : zA1) : (front ? zB0 : zA0));
  }
  const flat = g.toNonIndexed();
  flat.computeVertexNormals();
  return finish(flat, rgb, code);
}
// a wheel: the tyre, its rim set in a little, five spokes; the driven car's: an alloy, its lip a bright ring and
// the dark of the brake between the spokes (in the traffic: a grey wheel face, which reads at a distance)
const wheel = (r, x, z, hi = false, lo = false) => {
  const out = Math.sign(x), seg = hi ? 28 : lo ? 8 : 14, alloy = hi ? [0.6, 0.61, 0.64] : [0.5, 0.51, 0.54];
  if (lo) return [finish(new THREE.CylinderGeometry(r, r, 0.23, seg).rotateZ(Math.PI / 2).translate(x, r, z), TYRE, 4)]; // (far off: a tyre)
  const parts = [
    finish(new THREE.CylinderGeometry(r, r, 0.23, seg).rotateZ(Math.PI / 2).translate(x, r, z), TYRE, 4),
    finish(new THREE.CylinderGeometry(r * 0.66, r * 0.66, 0.02, seg).rotateZ(Math.PI / 2).translate(x + out * 0.1, r, z), hi ? [0.05, 0.05, 0.055] : [0.26, 0.26, 0.28], 4),
    finish(new THREE.CylinderGeometry(r * 0.16, r * 0.16, 0.05, 8).rotateZ(Math.PI / 2).translate(x + out * 0.12, r, z), alloy, 4),
  ];
  if (hi) parts.push(finish(new THREE.TorusGeometry(r * 0.64, 0.022, 6, seg).rotateY(Math.PI / 2).translate(x + out * 0.11, r, z), alloy, 4));
  for (let k = 0; k < 5; k++) {
    const a = (k / 5) * Math.PI * 2;
    parts.push(finish(new THREE.BoxGeometry(0.03, r * 0.5, hi ? 0.075 : 0.06).translate(0, r * 0.38, 0).rotateX(a).translate(x + out * 0.115, r, z), alloy, 4));
  }
  return parts;
};
const PAINT = [1, 1, 1], GLASS = [0.03, 0.04, 0.05], TYRE = [0.015, 0.015, 0.015], TRIM = [0.05, 0.05, 0.055], LAMP = [1, 1, 1];
// A vehicle along +z: length L, width W, body up to `belt`, cabin from z0 to z1 (fractions of L) up to `roof`,
// its windscreen leaning back by `rake` metres. Sculpted rather than boxed: the body is lofted through rounded
// sections (rounded corners in plan, the bonnet and boot falling away to the ends, the sides tucked in at the
// bottom, wheel arches cut out of the sill), the glasshouse through narrower ones that lean in towards the roof,
// with its pillars and roof in paint. detail 0: a car of the traffic seen from afar (about 450 triangles);
// 1: near (about 1,700); 2: the one driven.
export function vehicle({ L, W, belt, roof, z0, z1, box, rake = 0.5, tyre = 0.31 }, detail = 1) {
  const parts = [], zr = -L / 2, zf = L / 2, sill = 0.2, hi = detail > 1, lo = detail < 1;
  const wheelZ = (L > 8 ? 0.34 : 0.31) * L;
  const plan = (z) => { const zn = Math.min(1, Math.abs(z) / (L / 2)); return Math.pow(Math.max(0, 1 - Math.pow(zn, 7)), 1 / 7); };
  const halfW = (z) => (W / 2) * (0.9 + 0.1 * plan(z)) * Math.pow(plan(z), 0.35);
  // the top of the body: the bonnet falls towards the nose, the boot a little towards the tail
  const deck = (z) => {
    const zn = z / (L / 2);
    return belt + 0.02 - (zn > 0 ? 0.2 * Math.pow(Math.max(0, (zn - 0.45) / 0.55), 1.6) : 0.12 * Math.pow(Math.max(0, (-zn - 0.6) / 0.4), 1.6));
  };
  // the bottom edge: the sill, cut up round each wheel
  const bottom = (z) => {
    let y = sill;
    for (const wz of [wheelZ, -wheelZ]) { const d = Math.abs(z - wz), r = tyre * 1.18; if (d < r) y = Math.max(y, tyre + Math.sqrt(r * r - d * d) * 0.92); }
    return y;
  };
  // ---- the body: rings of M points round a rounded box, from the tail to the nose
  // (a box truck's body is its cab: behind it the cargo box stands on a bare chassis. Lofted the whole length, a
  // car's rounded tail and its wrap-round lamps showed under the box, a sedan carrying a crate)
  const boxFront = box ? (box.z - 0.5) * L + (box.len * L) / 2 : zr, boxRear = box ? (box.z - 0.5) * L - (box.len * L) / 2 : zr;
  const bodyFrom = box ? boxFront - 0.25 : zr;
  const N = hi ? 44 : lo ? 10 : 18, M = hi ? 28 : lo ? 10 : 14, ring = [];
  for (let i = 0; i <= N; i++) {
    const t = i / N, z = bodyFrom + (zf - bodyFrom) * (box ? t : 0.5 - 0.5 * Math.cos(Math.PI * t)); // (closer together at the ends, where it curves)
    const w = halfW(z), top = deck(z), bot = Math.min(bottom(z), top - 0.05), mid = (top + bot) / 2, hh = (top - bot) / 2, pts = [];
    for (let j = 0; j < M; j++) {
      const a = (j / M) * Math.PI * 2, c = Math.cos(a), s = Math.sin(a), n = 4.2;
      const x = Math.sign(c) * Math.pow(Math.abs(c), 2 / n) * w * (s < 0 ? 0.94 + 0.06 * (1 + s) : 1); // (tucked in below)
      const y = mid + Math.sign(s) * Math.pow(Math.abs(s), 2 / n) * hh;
      pts.push([x, y, z]);
    }
    ring.push(pts);
  }
  parts.push(loft(ring, true, false, (i, j, [x, y, z]) => (y < sill + 0.13 || y < bottom(z) + 0.06 ? [TRIM, 4] : [PAINT, 0])));
  // ---- the glasshouse: from the foot of the back window to the foot of the windscreen, leaning in to the roof
  const c0 = zr + z0 * L, c1 = zr + z1 * L, back = Math.max(0.25, rake * 0.6);
  const roofAt = (z) => belt + (roof - belt) * Math.max(0, Math.min(1, (c1 - z) / rake, (z - c0) / back));
  const G = hi ? 20 : lo ? 4 : 8, gring = [], K = hi ? 9 : lo ? 3 : 5;
  for (let i = 0; i <= G; i++) {
    const z = c0 + (c1 - c0) * (i / G), yt = Math.max(belt + 0.01, roofAt(z)), wb = halfW(z) * 0.93, wt = wb * 0.8, pts = [];
    // up one side, over the top (rounded), down the other
    for (let j = 0; j <= K; j++) { const f = j / K; pts.push([-(wb + (wt - wb) * Math.pow(f, 0.8)), belt - 0.01 + (yt - belt) * f, z]); }
    for (let j = 1; j < K; j++) { const f = j / K; pts.push([-wt + 2 * wt * f, yt + 0.025 * Math.sin(Math.PI * f), z]); }
    for (let j = K; j >= 0; j--) { const f = j / K; pts.push([wb + (wt - wb) * Math.pow(f, 0.8), belt - 0.01 + (yt - belt) * f, z]); }
    gring.push(pts);
  }
  // the sides are glass, and so is the top over the windscreen and the back window; the flat of the roof is
  // paint (rings run up one side, K - 1 points over the top, down the other: they turn the other way round from
  // the body's, hence the flip); the pillars after
  // The pillars are part of that surface, in paint: the A pillars a strip down each side of the windscreen,
  // the C pillars the broad panels behind the rear side windows (as separate bars they stood off the glass like
  // the rails of a cage); the B pillar between the doors is a dark strip in the glass.
  const side = (j) => j < K || j >= 2 * K, top = (j) => j >= K && j < 2 * K;
  const cPillar = Math.min(back + 0.12, (c1 - c0) * 0.3), aPillar = rake * 0.12;
  parts.push(loft(gring, false, true, (i, j, [x, y, z]) => (
    (top(j) && roofAt(z) > roof - 0.03) || (side(j) && (z < c0 + cPillar || z > c1 - aPillar)) ? [PAINT, 0] : [GLASS, 3])));
  if (c1 - c0 > 2.2) {
    const z = (c0 + c1) / 2 + 0.1;
    for (const sx of [-1, 1]) parts.push(bar([sx * halfW(z) * 0.925, belt, z], [sx * halfW(z) * 0.93 * 0.81, roof - 0.02, z], 0.06, TRIM, 4, 0.03));
  }
  if (box) {
    parts.push(part(W, box.h, box.len * L, 0, belt + box.h / 2, (box.z - 0.5) * L, [0.92, 0.92, 0.9])); // cargo body
    parts.push(part(W * 0.62, 0.26, boxFront - boxRear, 0, belt - 0.32, (boxFront + boxRear) / 2, TRIM, 4)); // the chassis under it
    parts.push(part(W * 0.97, belt - sill, 0.05, 0, (belt + sill) / 2, bodyFrom + 0.03, PAINT, 0));         // the back of the cab
    parts.push(part(W * 0.9, 0.1, 0.08, 0, 0.52, boxRear + 0.06, TRIM, 4));                                // the underride bar
    for (const sx of [-1, 1]) parts.push(part(0.2, 0.16, 0.04, sx * (W / 2 - 0.18), belt + 0.12, boxRear - 0.025, LAMP, 2)); // tail lamps, low on the doors
  }
  if (!box && z0 >= 0.28 && L > 5.2) parts.push(part(W * 0.86, 0.04, c0 - zr - 0.25, 0, deck(c0 - 0.6) + 0.005, (zr + c0) / 2, TRIM, 4)); // a pickup's bed
  // ---- the face and the tail: grille, lamps wrapping the corners, plates
  const yl = deck(zf - 0.15) - 0.14, yt = deck(zr + 0.15) - 0.1;
  parts.push(part(W * 0.42, 0.13, 0.05, 0, yl - 0.06, zf - 0.03, TRIM, 4));                                // grille
  parts.push(part(W * 0.6, 0.1, 0.05, 0, sill + 0.12, zf - 0.02, TRIM, 4));                                // lower intake
  for (const z of [zf - 0.005, box ? boxRear - 0.03 : zr + 0.005]) parts.push(part(0.34, 0.12, 0.02, 0, z < 0 && box ? 0.72 : sill + 0.24, z, [0.9, 0.9, 0.86], 4)); // plates
  // Lamps and trim that hug the rounded nose and tail: strips of short bars laid along the body's own outline at
  // their height, from near the middle round the corner onto the flank (flat boxes stood out at the corners).
  // (at the lamps' height and down at the bumper the rounded section is some 6 per cent narrower than its widest)
  const outline = (x, tail) => {
    for (let k = 0; k <= 160; k++) { const z = tail ? zr + k * 0.005 : zf - k * 0.005; if (halfW(z) * 0.94 >= Math.abs(x) + 0.004) return z; }
    return tail ? zr + 0.8 : zf - 0.8;
  };
  const strips = hi ? 6 : lo ? 2 : 4; // (bars per strip: a car far off has thousands of others round it)
  const hug = (xa, xb, y, h, rgb, code, tail, out = 0.012) => {
    let prev = null;
    for (let k = 0; k <= strips; k++) {
      const x = xa + (xb - xa) * (k / strips), p = [x, y, outline(x, tail) + (tail ? -out : out)];
      if (prev) parts.push(bar(prev, p, 0.04, rgb, code, h));
      prev = p;
    }
  };
  if (!lo && !box) {
    hug(-W * 0.2, W * 0.2, yt, 0.08, TRIM, 4, true);               // the band between the tail lamps
    hug(-W * 0.42, W * 0.42, sill + 0.09, 0.07, TRIM, 4, true);    // the bumper's lower edge
  }
  for (const sx of [-1, 1]) {
    for (const wz of [wheelZ, -wheelZ]) parts.push(...wheel(tyre, sx * (W / 2 - 0.12), wz, hi, lo));
    hug(sx * W * 0.19, sx * W * 0.45, yl, 0.1, LAMP, 1, false);     // headlamps, round the front corners
    if (!box) hug(sx * W * 0.2, sx * W * 0.455, yt, 0.15, LAMP, 2, true); // tail lamps, across the tail and round onto the flank
    // the mirror on its stalk
    parts.push(part(0.13, 0.11, 0.2, sx * (halfW(c1) * 0.93 + 0.08), belt + 0.08, c1 - rake * 0.35, PAINT));
  }
  return mergeGeometries(parts);
}
// Quads between consecutive rings of points (closed round, or open), facing out: rings turning
// anticlockwise seen from ahead (+z) as they run towards the front, or clockwise with `flip`. paint(i, j, mid)
// gives the quad from ring i, point j its [colour, code]. Smooth normals across the parts of one colour.
function loft(rings, closed, flip, paint) {
  const pos = [], tag = [], M = rings[0].length;
  for (let i = 0; i < rings.length - 1; i++) {
    for (let j = 0; j < (closed ? M : M - 1); j++) {
      const a = rings[i][j], b = rings[i][(j + 1) % M], c = rings[i + 1][(j + 1) % M], d = rings[i + 1][j];
      if (flip) pos.push(...a, ...c, ...b, ...a, ...d, ...c); else pos.push(...a, ...b, ...c, ...a, ...c, ...d);
      const mid = [0, 1, 2].map((k) => (a[k] + b[k] + c[k] + d[k]) / 4), pt = paint(i, j, mid);
      tag.push(pt, pt);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals(); // (flat, to start: smoothed below, across shared corners)
  const n = pos.length / 3, nor = g.attributes.normal.array, sum = new Map(), key = (v) => `${Math.round(pos[v * 3] * 1e3)},${Math.round(pos[v * 3 + 1] * 1e3)},${Math.round(pos[v * 3 + 2] * 1e3)},${tag[Math.floor(v / 3)][1]}`;
  for (let v = 0; v < n; v++) { const k = key(v), s = sum.get(k) ?? [0, 0, 0]; s[0] += nor[v * 3]; s[1] += nor[v * 3 + 1]; s[2] += nor[v * 3 + 2]; sum.set(k, s); }
  for (let v = 0; v < n; v++) { const s = sum.get(key(v)), l = Math.hypot(...s) || 1; nor[v * 3] = s[0] / l; nor[v * 3 + 1] = s[1] / l; nor[v * 3 + 2] = s[2] / l; }
  const col = new Float32Array(n * 3), code = new Float32Array(n);
  for (let v = 0; v < n; v++) { const [rgb, k] = tag[Math.floor(v / 3)]; col.set(rgb, v * 3); code[v] = k; }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setAttribute('aGlow', new THREE.BufferAttribute(code, 1));
  return g;
}
// a slim bar from a to b (a pillar, a lamp's lens): thickness t, depth d
function bar(a, b, t, rgb, code = 0, d = t) {
  const A = new THREE.Vector3(...a), B = new THREE.Vector3(...b), len = A.distanceTo(B);
  const g = new THREE.BoxGeometry(t, d, len);
  g.lookAt(new THREE.Vector3().subVectors(B, A));
  g.translate((A.x + B.x) / 2, (A.y + B.y) / 2, (A.z + B.z) / 2);
  return finish(g, rgb, code);
}
// What the lamps throw on the road: a long pool ahead of the car and a short red one behind it, as one
// instanced mesh per vehicle type that shares the cars' own matrices. Like the street lamps' pools
// (props.js), it multiplies the road under it.
export function beamTexture() {
  const W = 128, H = 128, data = new Uint8Array(W * H * 4), step = THREE.MathUtils.smoothstep;
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    // A fan opening from the lamps (the middle of the near edge) to the full width of the quad at its far
    // end: straight sides that fade softly, a rounded far edge, brightest near the car.
    const u = ((i + 0.5) / W) * 2 - 1, v = (j + 0.5) / H;
    const side = 1 - step(Math.abs(u) / Math.max(v, 0.03), 0.3, 0.98);   // inside the two straight edges, which fade out widely
    const reach = 1 - step(Math.hypot(u * 0.55, v), 0.55, 0.99);          // the arc at the far end
    const value = side * reach * step(v, 0, 0.06) * (0.1 + 0.9 * Math.exp(-v * 3.4));
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
  quad(7.5, L / 2 - 0.3, L / 2 + 24, [1, 0.95, 0.84]);       // headlamps, dipped: a fan 24 m long, 35 degrees wide
  quad(-3.2, -L / 2 + 0.3, -L / 2 - 6, [0.34, 0.02, 0.012]);  // tail lamps
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  return g;
}
// What drives in San Juan: compact cars and sedans, a great many SUVs and pickups, delivery trucks, and the
// AMA's city buses.
export const TYPES = [
  { name: 'compact', share: 0.26, L: 4.2, spec: { L: 4.2, W: 1.74, belt: 0.92, roof: 1.46, z0: 0.18, z1: 0.8, rake: 0.7 } },
  { name: 'sedan', share: 0.22, L: 4.8, spec: { L: 4.8, W: 1.82, belt: 0.92, roof: 1.44, z0: 0.2, z1: 0.72, rake: 0.75 } },
  { name: 'suv', share: 0.26, L: 4.7, spec: { L: 4.7, W: 1.9, belt: 1.08, roof: 1.76, z0: 0.12, z1: 0.86, rake: 0.55, tyre: 0.36 } },
  { name: 'pickup', share: 0.12, L: 5.6, spec: { L: 5.6, W: 1.95, belt: 1.12, roof: 1.84, z0: 0.3, z1: 0.62, rake: 0.5, tyre: 0.38 } },
  { name: 'truck', share: 0.08, L: 7.0, spec: { L: 7.0, W: 2.3, belt: 1.05, roof: 2.4, z0: 0.76, z1: 0.97, rake: 0.18, tyre: 0.45, box: { h: 2.3, len: 0.7, z: 0.36 } } },
  { name: 'bus', share: 0.06, L: 12.0, spec: { L: 12.0, W: 2.55, belt: 1.25, roof: 3.1, z0: 0.02, z1: 0.98, rake: 0.14, tyre: 0.48 } },
];
export const CAR_COLORS = [0xd4d4d0, 0xd4d4d0, 0xd4d4d0, 0x111214, 0x111214, 0xa4a7ab, 0xa4a7ab, 0x6d7278, 0x1f3a6e, 0x8c1c1c, 0x2f6fb0, 0xc4b68f]; // (white kept off full brightness: it blooms)
export const BUS_COLORS = [0xe8e4d8, 0xe8e4d8, 0x1d5fa8];

// Vehicle models for cars parked in car parks (props.js): geometries by type, the paint material, colours.
let parkedKit = null;
export function parkedVehicles() {
  parkedKit ??= { models: TYPES.slice(0, 4).map((t) => vehicle(t.spec)), material: carMaterial(false), colors: [0xd4d4d0, 0x111214, 0xa4a7ab, 0x1f3a6e] };
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

// hero: the car driven, in a clear-coated paint (a lacquer over the colour that mirrors the sky)
export function carMaterial(lit = true, { hero = false } = {}) {
  const m = hero
    ? new THREE.MeshPhysicalMaterial({ vertexColors: true, roughness: 0.38, metalness: 0.35, clearcoat: 1, clearcoatRoughness: 0.05 })
    : new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.28, metalness: 0.5 });
  m.onBeforeCompile = (shader) => {
    // (no lamp light on the traffic: a car is lit by its own lamps; the sampler still needs its texture.) The car
    // driven takes it: the pools of the street lamps slide over its roof and bonnet as it passes under them
    if (hero) lampUniforms(shader); else { shader.uniforms.uLampOn = { value: 0 }; shader.uniforms.uLampMap = shared.uLampMap; }
    shader.uniforms.uNight = shared.uNight;
    shader.vertexShader = shader.vertexShader
      // aBrake (per car, from simtraffic.js; 0 where a mesh has none): the tail lamps flare when it brakes
      .replace('#include <common>', '#include <common>\nattribute float aGlow;\nattribute float aBrake;\nvarying float vGlow;\nvarying float vBrake;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvGlow = aGlow;\nvBrake = aBrake;')
      // the car's colour is its paint's: lamps, glass, tyres and wheels keep their own
      .replace('#include <color_vertex>', '#include <color_vertex>\n#ifdef USE_COLOR\nif (aGlow > 0.5) vColor.rgb = color.rgb;\n#endif');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uNight;\nvarying float vGlow;\nvarying float vBrake;')
      // lamps keep their own colour instead of the body paint, and shine at night
      .replace('#include <color_fragment>', `#include <color_fragment>
        vec3 lamp = vGlow > 1.5 ? vec3(0.9, 0.03, 0.02) : vec3(1.0, 0.96, 0.85);
        if (vGlow > 0.5 && vGlow < 2.5) diffuseColor.rgb = lamp * 0.6;`)
      // glass is a dark mirror, rubber and trim are matt, the paint has a hard shine
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = vGlow > 3.5 ? 0.85 : vGlow > 2.5 ? 0.06 : roughnessFactor;')
      .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\nmetalnessFactor = vGlow > 3.5 ? 0.0 : vGlow > 2.5 ? 0.9 : metalnessFactor;')
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        ${hero ? `// (and at night the glow of the city along its edges, so its shape reads against the dark street)
        if (vGlow < 0.5) totalEmissiveRadiance += ${HERO_RIM};` : ''}
        if (vGlow > 0.5 && vGlow < 2.5) totalEmissiveRadiance += lamp * (0.15 + uNight * ${lit ? '(vGlow > 1.5 ? 2.0 : 3.6)' : '0.0'}
          + (vGlow > 1.5 ? vBrake * (1.4 + uNight * 3.0) : 0.0));`)
      // (the windows are marked in alpha for the reflection pass, like those of the buildings)
      .replace('#include <opaque_fragment>', '#include <opaque_fragment>\nif (vGlow > 2.5 && vGlow < 3.5) gl_FragColor.a = 0.1;');
    dissolve(shader);
  };
  if (hero) m.defines = { ...m.defines, LAMP_SIDES: '' };
  m.customProgramCacheKey = () => (hero ? 'car-hero-v3' : lit ? 'car-v7' : 'car-parked-v7');
  return m;
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
      // An expressway ramp climbing to its flyover is a structure of its own (flyovers.js builds it where the
      // road's level stands 1.5 m above the ground somewhere): cars follow the road's level there too.
      let ramp = false;
      if (!e.flyover && !e.span && !e.tunnel && e.highway.startsWith('motorway')) {
        for (let i = 1; i < p.length && !ramp; i++) for (let s = 0; s <= 1; s += Math.min(1, 3 / (cum[i] - cum[i - 1] || 1))) {
          if (p[i - 1].y + (p[i].y - p[i - 1].y) * s - surface(p[i - 1].x + (p[i].x - p[i - 1].x) * s, p[i - 1].z + (p[i].z - p[i - 1].z) * s) > 1.5) { ramp = true; break; }
        }
      }
      const lane = {
        ramp, pts: p, cum, length: cum.at(-1), from: fwd ? e.a : e.b, to: fwd ? e.b : e.a, n, offset, speed, weight, motorway: e.highway.startsWith('motorway'),
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
  // roads: parsed roads.json; surface(x, z): height of the road surface there.
  constructor(roads, surface) {
    this.surface = surface;
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

    const material = carMaterial();
    // what the lamps throw on the road, for the light map (lamplight.js)
    this.beam = lampMaterial(beamTexture(), { vertexColors: true });
    this.fleets = TYPES.map((t) => {
      const mesh = new THREE.InstancedMesh(vehicle(t.spec), material, Math.ceil(MAX_CARS * t.share * 1.25) + 8);
      mesh.castShadow = true; mesh.frustumCulled = false; mesh.count = 0;
      const beams = new THREE.InstancedMesh(beamGeometry(t.L), this.beam, mesh.instanceMatrix.count);
      beams.instanceMatrix = mesh.instanceMatrix; // the lamps go where the cars go
      beams.frustumCulled = false; beams.count = 0;
      beams.layers.set(LAMP_LAYER);
      this.group.add(mesh, beams);
      return { ...t, mesh, beams };
    });
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
      const palette = TYPES[type].name === 'bus' ? BUS_COLORS : CAR_COLORS;
      const car = { type, color: palette[Math.floor(this.rnd() * palette.length)], lane: null };
      if (!this.spawnCar(car, focus)) break;
      this.cars.push(car);
    }
    const counts = this.fleets.map(() => 0);
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
      car.v = Math.max(0, car.v + THREE.MathUtils.clamp(want - car.v, -6 * dt, 2.2 * dt));
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

      const off = car.lane.offset(car.k), px = tmp.x - tmp2.z * off, pz = tmp.z + tmp2.x * off;
      const fleet = this.fleets[car.type];
      if (counts[car.type] >= fleet.mesh.instanceMatrix.count) continue; // (more of this type than there are instances for)
      const i = counts[car.type]++;
      // (a ramp comes down to the ground: the higher of its level and the ground)
      const onRamp = car.lane.ramp && tmp.y > this.surface(px, pz) + 0.03;
      d.position.set(px, car.lane.raised || onRamp ? tmp.y + 0.04 : this.surface(px, pz) + 0.07, pz);
      // nose up or down with the road (and with it the light the lamps throw on it): the slope over the car's length
      const slope = car.lane.raised || onRamp ? tmp2.y : (this.surface(px + tmp2.x * 5, pz + tmp2.z * 5) - this.surface(px - tmp2.x * 5, pz - tmp2.z * 5)) / 10;
      d.rotation.set(-Math.atan(slope), Math.atan2(tmp2.x, tmp2.z), 0);
      d.updateMatrix();
      Object.assign(car, { px, pz, py: d.position.y, hx: tmp2.x, hz: tmp2.z }); // (where it is: for what it stops for, and what runs into it)
      // on top of you (you were set down where it was): it starts again somewhere else, next frame
      if (this.blockers.length) {
        const h = Math.max(0, TYPES[car.type].L / 2 - TYPES[car.type].spec.W / 2), sx = tmp2.x * h, sz = tmp2.z * h, r = TYPES[car.type].spec.W / 2;
        if (this.blockers.some((b) => segDist(px - sx, pz - sz, px + sx, pz + sz, b[0], b[1], b[2], b[3]) < r + b[4] - 0.05)) { counts[car.type]--; car.elsewhere = true; continue; }
      }
      fleet.mesh.setMatrixAt(i, d.matrix);
      fleet.mesh.setColorAt(i, this.color.setHex(car.color));
    }
    const night = shared.uNight.value;
    this.beam.color.setScalar(0.36 * this.headlights * night); // the light on the road just ahead of a car
    this.beam.visible = night > 0.02;
    this.fleets.forEach((f, i) => {
      f.mesh.count = f.beams.count = counts[i];
      f.mesh.instanceMatrix.needsUpdate = true;
      if (f.mesh.instanceColor) f.mesh.instanceColor.needsUpdate = true;
    });
  }
}
