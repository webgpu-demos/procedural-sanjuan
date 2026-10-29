// Car bodies lofted from design tables: the geometry of mrdoob's slop-newyork (js/cars.js, js/vehicles.js; MIT,
// github.com/mrdoob/slop-newyork), itself adapted from three.js's CarGenerator, here with WebGLRenderer's three and
// San Juan's fleet. Each body is lofted from ~45 cross-sections generated along the car out of a few smooth side- and
// plan-view curves (monotone cubic splines) plus elliptical roundings into the nose and tail: rounded plan-view corners,
// a hood that rolls down into the fascia, a tucked-in sill, crowned hood and deck, fender flares, circular wheel arches.
// A second, open loft sits on the belt line as the glasshouse (raked windshield and backlight, tumblehome side glass,
// crowned roof with rounded rails). Every piece carries a partId; all the detail (glass, seals, pillars, lamps,
// grilles, plates, door seams) is painted by one material from object-space position and normal (carmaterial.js), so
// each body type stays one instanced draw.
import * as THREE from 'three';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { LoftGeometry } from 'three/addons/geometries/LoftGeometry.js';

// Tags a piece of a merged vehicle mesh with its material part id (indexed, with uvs, so all pieces merge)
function part(geometry, id) {
  const g = geometry.index ? geometry : mergeVertices(geometry);
  if (!g.attributes.uv) {
    g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
  }
  g.setAttribute('partId', new THREE.BufferAttribute(new Float32Array(g.attributes.position.count).fill(id), 1));
  return g;
}

// Section winding used by every vehicle loft: left (-x) bottom, up & over the top, right (+x) bottom
function mirrorSection(right, center, z) {
  const pts = [];
  for (const [x, y] of right) pts.push(new THREE.Vector3(-x, y, z));
  if (center) pts.push(new THREE.Vector3(center[0], center[1], z));
  for (let i = right.length - 1; i >= 0; i--) pts.push(new THREE.Vector3(right[i][0], right[i][1], z));
  return pts;
}

function roundedRectShape(hw, hh, r) {
  const s = new THREE.Shape();
  s.moveTo(-hw + r, -hh);
  s.lineTo(hw - r, -hh);
  s.quadraticCurveTo(hw, -hh, hw, -hh + r);
  s.lineTo(hw, hh - r);
  s.quadraticCurveTo(hw, hh, hw - r, hh);
  s.lineTo(-hw + r, hh);
  s.quadraticCurveTo(-hw, hh, -hw, hh - r);
  s.lineTo(-hw, -hh + r);
  s.quadraticCurveTo(-hw, -hh, -hw + r, -hh);
  return s;
}

// Rounded box extruded along z, centred on the origin
function roundedBox(hw, hh, depth, r, bevel = 0.012) {
  const g = new THREE.ExtrudeGeometry(roundedRectShape(hw - bevel, hh - bevel, Math.max(0.002, r - bevel)), {
    depth: Math.max(0.001, depth - 2 * bevel),
    bevelEnabled: true,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelSegments: 1,
    curveSegments: 2
  });
  return g.translate(0, 0, -(depth - 2 * bevel) / 2);
}

const CAR_PARTS = {
  BODY: 0,
  WINDOW: 1,
  TYRE: 2,
  ALLOY: 3,
  TRIM: 4,
  MIRROR: 5,
  SIGN: 6,
  FRONT: 7,
  REAR: 8
};

// Design tables. Curves are [z, value] control points (z = +front); nose / tail entries are [length, tip value,
// superellipse exponent] roundings of the same quantities into the tips.
const BODY_SPECS = {
  sedan: {
    name: 'sedan',
    zFront: 2.22,
    zRear: -2.28,
    wheelRadius: 0.35,
    wheelZ: 1.4,
    wheelX: 0.8,
    archGap: 0.036, // wheel arch radius = wheelRadius + archGap
    archFlare: 0.022, // extra half-width over the wheels
    tuck: 0.07, // sill tucked in from the widest point
    halfWidth: [[2.22, 0.9], [1.4, 0.918], [0, 0.926], [-1.4, 0.922], [-2.28, 0.908]],
    sill: [[2.22, 0.265], [1.2, 0.245], [-1.2, 0.245], [-2.28, 0.285]],
    shoulder: [[2.22, 0.68], [1.75, 0.76], [1.4, 0.772], [0, 0.782], [-1.4, 0.795], [-2.28, 0.77]],
    edge: [[2.08, 0.81], [1.55, 0.865], [0.82, 0.948], [0.3, 0.97], [-0.4, 0.985], [-1.2, 1.0], [-1.58, 0.995], [-1.88, 0.968], [-2.12, 0.94]],
    crown: [[2.1, 0.04], [0.95, 0.035], [0.68, 0.004], [-1.66, 0.004], [-1.92, 0.018], [-2.28, 0.014]],
    tumble: [[2.22, 0.12], [0.9, 0.1], [-1.6, 0.1], [-2.28, 0.115]],
    nose: { halfWidth: [0.32, 0.68, 2.8], edge: [0.14, 0.74, 2.6], crown: [0.14, 0.012, 2], sill: [0.16, 0.31, 2], shoulder: [0.22, 0.62, 2.6] },
    tail: { halfWidth: [0.3, 0.72, 2.8], edge: [0.1, 0.91, 3], crown: [0.1, 0.008, 2], sill: [0.16, 0.36, 2], shoulder: [0.22, 0.7, 2.6] },
    noseRake: { length: 0.55, y: [[0.25, 0.045], [0.36, 0], [0.54, 0], [0.68, 0.03], [0.78, 0.1], [0.86, 0.14]], plan: 0.085 },
    tailRake: { length: 0.42, y: [[0.27, 0.075], [0.44, 0], [0.56, 0], [0.62, 0.012], [0.76, 0.015], [0.94, 0.03]], plan: 0.065 },
    cabin: {
      cowl: 0.82,
      roofFront: -0.02,
      roofRear: -1.12,
      deck: -1.86,
      roofY: [[-0.02, 1.41], [-0.55, 1.445], [-1.12, 1.405]],
      rail: [0.62, 0.595], // roof rail half-width at the front & rear of the roof
      inset: 0.03, // side glass base inset from the body's top edge
      bulge: 0.014, // side glass outward curvature
      roofEdge: 0.05, // roof rail rounding height
      roofCrown: 0.035,
      roofRound: 4,
      pillars: [-0.36], // B (and C) pillar centres
      glassEnd: -1.56 // where the side glass ends on the belt, ahead of the deck: the C-pillar's base
    },
    doors: [0.79, -0.36, -0.98], // door shut lines
    handles: [-0.2, -0.86],
    headlight: [0.6, 0.68, 0.24, 0.048], // centre |x|, y, half-width, half-height
    taillight: [0.6, 0.815, 0.265, 0.052],
    grille: [0.66, 0.3, 0.042], // upper grille between the headlights: y, half-width, half-height
    intake: [0.4, 0.55, 0.072], // lower grille
    plates: [0.46, 0.665], // front / rear plate centre heights
    bumperLine: [0.75, 0.555], // hood / bumper and trunk / bumper shut lines on the nose & tail
    bumpers: [[0.44, 0.03], [0.48, 0.03]], // front / rear bumper reference lines: centre height, half-height
    chrome: true, // chrome strip along the side windows' sills
    cladding: 0, // height of the unpainted lower body cladding (SUVs)
    sign: false,
    rails: false,
    rearWiper: false
  },
  suv: {
    name: 'suv',
    zFront: 2.32,
    zRear: -2.35,
    wheelRadius: 0.38,
    wheelZ: 1.45,
    wheelX: 0.845,
    archGap: 0.05,
    archFlare: 0.032,
    tuck: 0.065,
    halfWidth: [[2.32, 0.935], [1.45, 0.964], [0, 0.97], [-1.45, 0.966], [-2.35, 0.945]],
    sill: [[2.32, 0.38], [1.2, 0.335], [-1.2, 0.335], [-2.35, 0.415]],
    shoulder: [[2.32, 0.81], [1.75, 0.885], [1.45, 0.9], [0, 0.925], [-1.45, 0.955], [-2.35, 0.94]],
    edge: [[2.16, 0.985], [1.65, 1.068], [1.1, 1.098], [0.82, 1.105], [0, 1.125], [-0.95, 1.15], [-1.55, 1.185], [-1.9, 1.2], [-2.2, 1.195], [-2.35, 1.17]],
    crown: [[2.16, 0.048], [0.95, 0.042], [0.68, 0.004], [-2.35, 0.004]],
    tumble: [[2.32, 0.125], [0.9, 0.105], [-1.6, 0.11], [-2.35, 0.125]],
    nose: { halfWidth: [0.34, 0.72, 2.8], edge: [0.14, 0.91, 2.6], crown: [0.14, 0.015, 2], sill: [0.16, 0.43, 2], shoulder: [0.22, 0.7, 2.6] },
    tail: { halfWidth: [0.28, 0.76, 2.8], edge: [0.06, 1.15, 3], crown: [0.06, 0.004, 2], sill: [0.16, 0.46, 2], shoulder: [0.2, 0.86, 2.6] },
    noseRake: { length: 0.62, y: [[0.35, 0.085], [0.5, 0], [0.76, 0.012], [0.92, 0.075], [1.04, 0.145]], plan: 0.075 },
    tailRake: { length: 0.42, y: [[0.38, 0.085], [0.54, 0], [0.66, 0], [0.76, 0.02], [1.02, 0.028], [1.19, 0.035]], plan: 0.045 },
    cabin: {
      cowl: 0.82,
      roofFront: -0.22,
      roofRear: -1.7,
      deck: -2.2,
      roofY: [[-0.22, 1.71], [-0.85, 1.735], [-1.7, 1.67]],
      rail: [0.665, 0.635],
      inset: 0.035,
      bulge: 0.014,
      roofEdge: 0.055,
      roofCrown: 0.032,
      roofRound: 4,
      pillars: [-0.38, -1.2],
      glassEnd: -1.9
    },
    doors: [0.78, -0.38, -1.04],
    handles: [-0.2, -0.92],
    headlight: [0.63, 0.875, 0.245, 0.05],
    taillight: [0.65, 0.98, 0.25, 0.058],
    grille: [0.835, 0.375, 0.105],
    intake: [0.49, 0.48, 0.058],
    plates: [0.58, 0.82],
    bumperLine: [0.94, 0.66],
    bumpers: [[0.54, 0.04], [0.56, 0.04]],
    chrome: false,
    cladding: 0.46,
    sign: false,
    rails: true,
    rearWiper: true
  }
};
BODY_SPECS.taxi = Object.assign({}, BODY_SPECS.sedan, { name: 'taxi', sign: true });
BODY_SPECS.pickup = {
  name: 'pickup',
  zFront: 2.74,
  zRear: -2.94,
  wheelRadius: 0.435,
  wheelZ: 1.92,
  wheelX: 0.91,
  archGap: 0.058,
  archPower: 3.2,
  archFlare: 0.042,
  tuck: 0.065,
  upperRound: 4.6,
  stationStep: 0.46,
  proxyStep: 1.3,
  halfWidth: [[2.74, 0.99], [1.92, 1.02], [0, 1.025], [-1.92, 1.02], [-2.94, 1.0]],
  sill: [[2.74, 0.51], [1.4, 0.48], [-1.4, 0.48], [-2.94, 0.52]],
  shoulder: [[2.74, 1.12], [2.15, 1.18], [1.92, 1.19], [0, 1.195], [-1.92, 1.195], [-2.94, 1.18]],
  edge: [[2.62, 1.25], [2.15, 1.29], [1.4, 1.305], [1.14, 1.31], [0.1, 1.31], [-0.96, 1.315], [-1.92, 1.315], [-2.82, 1.305]],
  crown: [[2.62, 0.042], [1.35, 0.038], [1.02, 0.005], [-2.94, 0.004]],
  tumble: [[2.74, 0.1], [1.14, 0.085], [-0.96, 0.085], [-2.94, 0.09]],
  nose: { halfWidth: [0.28, 0.82, 3.2], edge: [0.12, 1.22, 3.2], crown: [0.12, 0.015, 2], sill: [0.18, 0.55, 2.2], shoulder: [0.18, 1.04, 2.8] },
  tail: { halfWidth: [0.22, 0.86, 3.2], edge: [0.06, 1.28, 3], crown: [0.06, 0.004, 2], sill: [0.18, 0.56, 2.2], shoulder: [0.16, 1.1, 2.8] },
  noseRake: { length: 0.34, y: [[0.5, 0.045], [0.62, 0], [1.18, 0], [1.26, 0.018], [1.34, 0.045]], plan: 0.038 },
  tailRake: { length: 0.3, y: [[0.52, 0.055], [0.64, 0], [0.8, 0], [0.9, 0.018], [1.3, 0.022]], plan: 0.03 },
  cabin: {
    cowl: 1.14,
    roofFront: 0.34,
    roofRear: -0.68,
    deck: -0.96,
    roofY: [[0.34, 1.965], [-0.16, 1.99], [-0.68, 1.975]],
    rail: [0.75, 0.74],
    inset: 0.035,
    bulge: 0.012,
    roofEdge: 0.055,
    roofCrown: 0.028,
    roofRound: 4.5,
    pillars: [0.1],
    glassEnd: -0.78
  },
  doors: [1.06, 0.1, -0.78],
  handles: [0.26, -0.58],
  headlight: [0.73, 1.09, 0.21, 0.11],
  taillight: [0.8, 1.1, 0.16, 0.14],
  grille: [0.99, 0.48, 0.235],
  intake: [0.61, 0.52, 0.065],
  plates: [0.66, 0.92],
  bumperLine: [1.24, 0.8],
  bumpers: [[0.6, 0.045], [0.6, 0.045]],
  mirrorScale: [1.28, 1.32, 1.12],
  chrome: true,
  cladding: 0.55,
  sign: false,
  rails: false,
  rearWiper: false,
  bedCover: true
};
// High-roof delivery van (~Mercedes Sprinter / Ford Transit 148"): short sloped nose, a tall wide windshield, glass
// only in the cab doors, flat cargo sides & a flat rear (spec.cargo, see buildCargoCabin). spec.cabin describes the cab
// alone, its roof ending at the B-pillar, so the material's windshield & door glass outlines land on the cab.
BODY_SPECS.van = {
  name: 'van',
  zFront: 2.8,
  zRear: -3.08,
  wheelRadius: 0.38,
  wheelZ: 1.8,
  wheelX: 0.86,
  archGap: 0.05,
  archFlare: 0.012,
  tuck: 0.05,
  lowerRound: 4,
  upperRound: 5,
  upperSamples: [1],
  halfWidth: [[2.8, 0.95], [1.8, 0.99], [0.8, 1.0], [-3.08, 1.0]],
  sill: [[2.8, 0.36], [2.1, 0.42], [1.2, 0.45], [-3.08, 0.48]],
  shoulder: [[2.8, 0.66], [2.2, 0.82], [1.6, 0.9], [-3.08, 0.92]],
  edge: [[2.64, 0.97], [2.2, 1.08], [1.75, 1.18], [1.0, 1.21], [0.4, 1.22], [-3.08, 1.22]],
  crown: [[2.64, 0.03], [1.9, 0.025], [1.6, 0.004], [-3.08, 0]],
  tumble: [[2.8, 0.1], [2.0, 0.06], [1.3, 0.015], [-3.08, 0.015]],
  nose: { halfWidth: [0.38, 0.74, 2.6], edge: [0.16, 0.95, 2.4], crown: [0.16, 0.01, 2], sill: [0.18, 0.4, 2], shoulder: [0.24, 0.62, 2.4] },
  tail: { halfWidth: [0.09, 0.93, 3.2], edge: [0.03, 1.2, 3], crown: [0.03, 0, 2], sill: [0.08, 0.5, 2], shoulder: [0.08, 0.9, 3] },
  noseRake: { length: 0.55, y: [[0.32, 0.06], [0.45, 0], [0.7, 0], [0.85, 0.05], [1.0, 0.12]], plan: 0.09 },
  cabin: {
    cowl: 1.75,
    roofFront: 1.22,
    roofRear: 0.48, // B-pillar: the cab's glass ends here, the cargo box (spec.cargo) carries the roof on to the tail
    deck: 0.42,
    roofY: [[1.22, 2.02], [0.48, 2.02]],
    rail: [0.92, 0.94],
    inset: 0,
    bulge: 0.006,
    roofEdge: 0.06,
    roofCrown: 0.03,
    roofRound: 4,
    pillars: [-0.1, -0.9], // behind the door glass: no B / C pillar bars
    glassEnd: 0.44
  },
  cargo: {
    // High roof above the cab roof along z; its first knot is the windshield header (cabin.roofFront)
    rise: [[1.22, 0], [1.08, 0.12], [0.9, 0.29], [0.7, 0.44], [0.5, 0.54], [0.28, 0.6], [0.05, 0.62], [-2.94, 0.62], [-3.08, 0.585]],
    roofEdge: 0.15, // height of the high roof's rounded shoulder
    roofRound: 4,
    bumper: [0.42, 0.62, 0.08] // rear step bumper: bottom, top, protrusion
  },
  doors: [1.32, 0.42, 0.33, -0.97], // front door, sliding door
  handles: [0.55, 0.22],
  headlight: [0.66, 0.84, 0.24, 0.08],
  taillight: [0.9, 0.9, 0.065, 0.28],
  grille: [0.73, 0.42, 0.13],
  intake: [0.46, 0.5, 0.05],
  plates: [0.47, 0.78],
  bumperLine: [0.575, 0.62],
  bumpers: [[0.48, 0.07], [0.52, 0.1]],
  chrome: false,
  cladding: 0.56,
  mirrorScale: [1.3, 2.6, 1.1],
  sign: false,
  rails: false,
  rearWiper: false,
  // Painted van details (optional fields): no light bar between the tail lamps, rear barn doors (half-width, top) and
  // a curb-side (-x) sliding door (front z, rear z, top) running up the cargo side
  tailStrip: false,
  barnDoors: [0.8, 2.34],
  slidingDoor: [0.33, -0.97, 2.28]
};
// Minivan (~Toyota Sienna / Honda Odyssey): low sloping nose, very fast windshield, long roof, sliding side doors,
// long rear quarter glass & a steep hatch.
BODY_SPECS.minivan = {
  name: 'minivan',
  zFront: 2.5,
  zRear: -2.67,
  wheelRadius: 0.37,
  wheelZ: 1.515,
  wheelX: 0.845,
  archGap: 0.045,
  archFlare: 0.02,
  tuck: 0.06,
  halfWidth: [[2.5, 0.93], [1.515, 0.975], [0, 0.985], [-1.515, 0.98], [-2.67, 0.955]],
  sill: [[2.5, 0.33], [1.2, 0.31], [-1.2, 0.31], [-2.67, 0.38]],
  shoulder: [[2.5, 0.72], [1.5, 0.8], [0, 0.82], [-1.5, 0.84], [-2.67, 0.84]],
  edge: [[2.36, 0.88], [1.9, 0.95], [1.55, 1.0], [0.8, 1.04], [-0.5, 1.07], [-1.6, 1.11], [-2.3, 1.13], [-2.6, 1.11]],
  crown: [[2.36, 0.035], [1.6, 0.03], [1.4, 0.004], [-2.67, 0.004]],
  tumble: [[2.5, 0.12], [1.5, 0.1], [-1.5, 0.1], [-2.67, 0.12]],
  nose: { halfWidth: [0.36, 0.7, 2.7], edge: [0.16, 0.86, 2.5], crown: [0.16, 0.012, 2], sill: [0.18, 0.36, 2], shoulder: [0.24, 0.62, 2.5] },
  tail: { halfWidth: [0.26, 0.8, 2.8], edge: [0.07, 1.06, 3], crown: [0.07, 0.004, 2], sill: [0.16, 0.44, 2], shoulder: [0.2, 0.84, 2.6] },
  noseRake: { length: 0.6, y: [[0.3, 0.08], [0.45, 0], [0.62, 0], [0.75, 0.04], [0.9, 0.11]], plan: 0.08 },
  tailRake: { length: 0.42, y: [[0.38, 0.08], [0.52, 0], [0.7, 0], [0.85, 0.02], [1.1, 0.05]], plan: 0.05 },
  cabin: {
    cowl: 1.55,
    roofFront: 0.42,
    roofRear: -2.2,
    deck: -2.55,
    roofY: [[0.42, 1.72], [-0.6, 1.765], [-1.6, 1.755], [-2.2, 1.715]],
    rail: [0.76, 0.72],
    inset: 0.03,
    bulge: 0.012,
    roofEdge: 0.06,
    roofCrown: 0.03,
    roofRound: 4,
    pillars: [0.28, -0.98],
    glassEnd: -1.98
  },
  doors: [1.05, 0.28, -0.98], // front door, sliding door
  handles: [0.42, 0.15],
  headlight: [0.66, 0.775, 0.24, 0.055],
  taillight: [0.7, 1.0, 0.2, 0.07],
  grille: [0.74, 0.3, 0.035],
  intake: [0.49, 0.55, 0.12],
  plates: [0.49, 0.84],
  bumperLine: [0.68, 0.72],
  bumpers: [[0.45, 0.04], [0.55, 0.04]],
  chrome: false,
  cladding: 0,
  sign: false,
  rails: false,
  rearWiper: true
};

for (const spec of Object.values(BODY_SPECS)) {
  // Kept for code that places lamp flares: lamp heights (front, rear) and centres across the car
  spec.lamps = [spec.headlight[1], spec.taillight[1]];
  spec.lampX = [spec.headlight[0], spec.taillight[0]];
}

const lerp = (a, b, t) => a + (b - a) * t;

// Monotone cubic (Fritsch-Carlson) interpolation through [x, y] control points: smooth, never overshoots
function smoothCurve(points) {
  const pts = points.slice().sort((a, b) => a[0] - b[0]);
  const n = pts.length;
  if (n === 1) return () => pts[0][1];
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const h = [];
  const d = [];
  for (let i = 0; i < n - 1; i++) {
    h.push(xs[i + 1] - xs[i]);
    d.push((ys[i + 1] - ys[i]) / h[i]);
  }
  const m = [d[0]];
  for (let i = 1; i < n - 1; i++) {
    if (d[i - 1] * d[i] <= 0) {
      m.push(0);
    } else {
      const w1 = 2 * h[i] + h[i - 1];
      const w2 = h[i] + 2 * h[i - 1];
      m.push((w1 + w2) / (w1 / d[i - 1] + w2 / d[i]));
    }
  }
  m.push(d[n - 2]);
  return (x) => {
    if (x <= xs[0]) return ys[0];
    if (x >= xs[n - 1]) return ys[n - 1];
    let i = 0;
    while (x > xs[i + 1]) i++;
    const t = (x - xs[i]) / h[i];
    const t2 = t * t;
    const t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * ys[i] + (t3 - 2 * t2 + t) * h[i] * m[i] + (-2 * t3 + 3 * t2) * ys[i + 1] + (t3 - t2) * h[i] * m[i + 1];
  };
}

// 1 along the body, falling to 0 at the tip along a superelliptic quarter (vertical tangent at the tip)
function endFactor(z, zTip, length, exponent = 2) {
  const u = zTip > 0 ? (z - (zTip - length)) / length : (zTip + length - z) / length;
  if (u <= 0) return 1;
  if (u >= 1) return 0;
  return Math.pow(1 - Math.pow(u, exponent), 1 / exponent);
}

/**
 * Evaluates a body spec's curves into the cross-section parameters along the vehicle (memoized on the spec):
 *   body(z) -> { W: half-width, yB: sill, yS: shoulder (widest), yE / xE: top edge, yT: crown, xB: sill half-width }
 */
function bodyProfile(spec) {
  if (spec._body) return spec._body;
  const W0 = smoothCurve(spec.halfWidth);
  const B0 = smoothCurve(spec.sill);
  const S0 = smoothCurve(spec.shoulder);
  const E0 = smoothCurve(spec.edge);
  const C0 = smoothCurve(spec.crown);
  const T0 = smoothCurve(spec.tumble);
  const archR = spec.wheelRadius + spec.archGap;
  const axles = [spec.wheelZ, -spec.wheelZ];

  const rounded = (z, value, key) => {
    const nose = spec.nose[key];
    const tail = spec.tail[key];
    if (nose && z > 0) value = nose[1] + (value - nose[1]) * endFactor(z, spec.zFront, nose[0], nose[2]);
    if (tail && z < 0) value = tail[1] + (value - tail[1]) * endFactor(z, spec.zRear, tail[0], tail[2]);
    return value;
  };

  const body = (z) => {
    let flare = 0;
    for (const axle of axles) {
      const d = (z - axle) / (archR + 0.4);
      if (Math.abs(d) < 1) flare = Math.max(flare, (1 - d * d) ** 2);
    }
    const W = rounded(z, W0(z) + spec.archFlare * flare, 'halfWidth');
    const ySill = rounded(z, B0(z), 'sill');
    const archPow = spec.archPower || 2;
    let yB = ySill;
    for (const axle of axles) {
      const d = Math.abs(z - axle);
      if (d < archR) {
        yB = Math.max(yB, ySill + (spec.wheelRadius + archR - ySill) * Math.pow(1 - Math.pow(d / archR, archPow), 1 / archPow));
      }
    }
    const yE = rounded(z, E0(z), 'edge');
    const yT = yE + Math.max(0, rounded(z, C0(z), 'crown'));
    const yS = Math.min(Math.max(rounded(z, S0(z), 'shoulder'), yB + 0.035), yE - 0.035);
    const xE = Math.max(W - T0(z), W * 0.55);
    return { z, W, yB, ySill, yS, yE, yT, xE, xB: W - spec.tuck };
  };
  spec._body = body;
  return body;
}

/**
 * A car's body profile plus its glasshouse (memoized on the spec):
 *   cabin(z) -> { beltX, beltY: side glass base, railX, railY: top of the side glass, h: roof / glass crown height }
 */
function carLayout(spec) {
  if (spec._layout) return spec._layout;
  if (!spec.lamps && spec.headlight && spec.taillight) {
    spec.lamps = [spec.headlight[1], spec.taillight[1]];
    spec.lampX = [spec.headlight[0], spec.taillight[0]];
  }
  const body = bodyProfile(spec);
  const archR = spec.wheelRadius + spec.archGap;
  const cab = spec.cabin;
  const roofY = smoothCurve(cab.roofY);
  const H = cab.roofEdge + cab.roofCrown;
  const belt = (z) => {
    const s = body(z);
    return { x: s.xE - cab.inset, y: s.yE - 0.004 };
  };
  const bc = belt(cab.cowl);
  const bd = belt(cab.deck);
  const railF = { x: cab.rail[0], y: roofY(cab.roofFront) - H };
  const railR = { x: cab.rail[1], y: roofY(cab.roofRear) - H };
  const roofMid = (cab.roofFront + cab.roofRear) / 2;
  const railM = { x: (cab.rail[0] + cab.rail[1]) / 2, y: roofY(roofMid) - H };
  // At the cowl & deck the glass arch stays under the hood / trunk crown, so the glass grows out of the panel
  const hCowl = Math.max(0.006, body(cab.cowl).yT - bc.y - 0.008);
  const hDeck = Math.max(0.006, body(cab.deck).yT - bd.y - 0.008);

  const cabin = (z) => {
    const b = belt(z);
    let railX;
    let railY;
    let h;
    if (z >= cab.roofFront) {
      const t = (cab.cowl - z) / (cab.cowl - cab.roofFront);
      railX = lerp(bc.x, railF.x, t);
      railY = lerp(bc.y, railF.y, t);
      h = lerp(hCowl, H, Math.min(1, t * 1.6));
    } else if (z <= cab.roofRear) {
      const t = (z - cab.deck) / (cab.roofRear - cab.deck);
      railX = lerp(bd.x, railR.x, t);
      railY = lerp(bd.y, railR.y, t);
      h = lerp(hDeck, H, Math.min(1, t * 1.6));
    } else {
      const t = (cab.roofFront - z) / (cab.roofFront - cab.roofRear);
      railX = lerp(railF.x, railR.x, t);
      railY = roofY(z) - H;
      h = H;
    }
    return { z, beltX: Math.max(b.x, railX), beltY: Math.min(b.y, railY), railX, railY, h, bulge: cab.bulge };
  };

  // Height of the glasshouse's top surface (roof / windshield crown) at |x| for a cabin section
  const cabinTop = (c, x) => {
    const n = cab.roofRound;
    const ratio = Math.min(1, Math.abs(x) / Math.max(c.railX, 1e-4));
    const th = Math.acos(Math.pow(ratio, n / 2));
    return c.railY + c.h * Math.pow(Math.sin(th), 2 / n);
  };

  spec._layout = { spec, body, cabin, cabinTop, archR, belt: { cowl: bc, deck: bd }, rail: { front: railF, mid: railM, rear: railR, roofMid } };
  return spec._layout;
}

const BODY_LOWER_ROUND = 2.8;
const BODY_UPPER_ROUND = 3.2;

// Right half of a body cross-section: superelliptic lower corner (sill -> widest point), superelliptic upper corner
// (widest point -> top edge) and a parabolic crown. Specs may sharpen the corners (lowerRound / upperRound) and sample
// the upper corner more densely (upperSamples).
function bodyHalfProfile(s, detail, spec = {}) {
  const n1 = spec.lowerRound || BODY_LOWER_ROUND;
  const n2 = spec.upperRound || BODY_UPPER_ROUND;
  const right = [];
  const low = detail ? [0, 0.32, 0.64, 1] : [0, 1];
  const up = detail ? spec.upperSamples || [0.38, 0.72, 1] : [1];
  const top = detail ? [0.66, 0.33] : [0.5];
  for (const a of low) {
    const th = (a * Math.PI) / 2;
    const y = s.yS - (s.yS - s.yB) * Math.pow(Math.cos(th), 2 / n1);
    if (s.ySill !== undefined) {
      const u = Math.min(1, Math.max(0, (s.yS - y) / Math.max(s.yS - s.ySill, 1e-4)));
      right.push([s.xB + (s.W - s.xB) * Math.pow(Math.max(0, 1 - Math.pow(u, n1)), 1 / n1), y]);
    } else {
      right.push([s.xB + (s.W - s.xB) * Math.pow(Math.sin(th), 2 / n1), y]);
    }
  }
  for (const a of up) {
    const th = (a * Math.PI) / 2;
    right.push([s.xE + (s.W - s.xE) * Math.pow(Math.cos(th), 2 / n2), s.yS + (s.yE - s.yS) * Math.pow(Math.sin(th), 2 / n2)]);
  }
  for (const f of top) right.push([s.xE * f, s.yE + (s.yT - s.yE) * (1 - f * f)]);
  return right;
}

// Cars place their sections at the features (tips, nose & tail roundings, wheel arches, cowl & deck) and fill the gaps
// in between: finely over the hood & deck, coarsely along the doors, where the cabin hides the body's top. Other
// lofts (the bus) keep a regular step plus the feature stations.
function bodyStations(spec, detail) {
  const zs = [];
  const add = (z) => zs.push(Math.min(spec.zFront, Math.max(spec.zRear, z)));
  const cab = spec.cabin;
  const step = detail ? spec.stationStep || 0.28 : 0.75;
  if (!cab) {
    for (let z = spec.zRear; z < spec.zFront; z += step) add(z);
  }
  add(spec.zFront);
  add(spec.zRear);
  const noseLen = Math.max(...Object.values(spec.nose).map((v) => v[0]));
  const tailLen = Math.max(...Object.values(spec.tail).map((v) => v[0]));
  for (const u of detail ? [0, 0.3, 0.52, 0.7, 0.83, 0.92, 0.97, 0.993] : [0, 0.72]) {
    add(spec.zFront - noseLen * (1 - u));
    add(spec.zRear + tailLen * (1 - u));
  }
  const archR = spec.wheelRadius + spec.archGap;
  const k = detail ? 8 : 4;
  for (const axle of [spec.wheelZ, -spec.wheelZ]) {
    for (let i = 0; i <= k; i++) add(axle + archR * Math.cos((i / k) * Math.PI));
    if (!cab) {
      add(axle + archR + 0.006);
      add(axle - archR - 0.006);
    }
  }
  if (detail && cab) {
    add(cab.cowl);
    add(cab.deck);
  }
  zs.sort((a, b) => b - a);
  const eps = detail ? 0.004 : 0.04;
  const out = [];
  for (const z of zs) {
    if (!out.length || out[out.length - 1] - z > eps) out.push(z);
  }
  out[0] = spec.zFront;
  out[out.length - 1] = spec.zRear;
  if (!cab) return out;
  const filled = [out[0]];
  for (let i = 1; i < out.length; i++) {
    const a = out[i - 1];
    const b = out[i];
    const mid = (a + b) / 2;
    const gap = !detail ? (spec.proxyStep || 0.75) : mid < cab.cowl - 0.1 && mid > cab.deck + 0.1 ? 0.5 : (spec.stationStep || 0.27);
    const n = Math.ceil((a - b) / gap - 0.15);
    for (let j = 1; j < n; j++) filled.push(lerp(a, b, j / n));
    filled.push(b);
  }
  return filled;
}

// Optional raked nose & tail, spec.noseRake / tailRake = { length, y: [[height, setback], ...], plan }: every body
// vertex within `length` of the tip moves back by a setback that depends on its height (plus plan * x^2, which rounds
// the fascia in plan view), eased in quadratically, so the fascia slopes back from the bumper up to the hood and the
// tail tucks in under its lip instead of ending in vertical slabs. Returns (x, y, z) => z, or null (memoized).
function bodyRake(spec) {
  if (spec._rake !== undefined) return spec._rake;
  const ends = [[spec.noseRake, spec.zFront, 1], [spec.tailRake, spec.zRear, -1]]
    .filter(([rake]) => rake)
    .map(([rake, tip, dir]) => ({ tip, dir, length: rake.length, plan: rake.plan || 0, setback: smoothCurve(rake.y) }));
  spec._rake = ends.length
    ? (x, y, z) => {
      for (const e of ends) {
        const u = ((z - e.tip) * e.dir + e.length) / e.length;
        if (u > 0) return z - e.dir * (e.setback(y) + e.plan * x * x) * u * u;
      }
      return z;
    }
    : null;
  return spec._rake;
}

// z of a body's nose (front) or tail surface on the centreline at height y, for plates & badges mounted on the tips
function carTipZ(spec, y, front = true) {
  const rake = bodyRake(spec);
  const z = front ? spec.zFront : spec.zRear;
  return rake ? rake(0, y, z) : z;
}

// Closes a raked body tip with a grid that follows the rake (a flat loft cap can't bow out at the bumper): each
// right-half point of the tip section is joined to its mirror image by a row split into `columns`, the crown point
// closes the top. Row 0 (the sill) stays straight so it meets the flat underbody without a gap. front: faces +z.
function buildTipCap(right, top, z, rake, front, columns) {
  const pos = [];
  const index = [];
  const row = columns + 1;
  for (let i = 0; i < right.length; i++) {
    const [x, y] = right[i];
    for (let j = 0; j <= columns; j++) {
      const px = x * ((2 * j) / columns - 1);
      pos.push(px, y, rake(i === 0 ? x : px, y, z));
    }
  }
  const apex = pos.length / 3;
  pos.push(0, top, rake(0, top, z));
  const tri = (a, b, c) => (front ? index.push(a, b, c) : index.push(a, c, b));
  for (let i = 0; i < right.length - 1; i++) {
    for (let j = 0; j < columns; j++) {
      const a = i * row + j;
      tri(a, a + 1, a + row + 1);
      tri(a, a + row + 1, a + row);
    }
  }
  const last = (right.length - 1) * row;
  for (let j = 0; j < columns; j++) tri(last + j, last + j + 1, apex);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array((pos.length / 3) * 2), 2));
  g.setIndex(index);
  g.computeVertexNormals();
  return g;
}

function buildBodyLoft(spec, detail = 1) {
  const body = bodyProfile(spec);
  const rake = bodyRake(spec);
  const stations = bodyStations(spec, detail);
  const sections = stations.map((z) => {
    const s = body(z);
    const section = mirrorSection(bodyHalfProfile(s, detail, spec), [0, s.yT], z);
    if (rake) for (const p of section) p.z = rake(p.x, p.y, z);
    return section;
  });
  if (!rake) return new LoftGeometry(sections, { capStart: true, capEnd: true });
  const loft = new LoftGeometry(sections, { closed: false });
  const under = new LoftGeometry(sections.map((sec) => [sec[sec.length - 1], sec[0]]), { closed: false });
  const cols = detail ? 4 : 1;
  const ring = sections[0].length;
  const row = cols + 1;
  const nRight = (ring - 1) / 2;
  const lNorm = loft.attributes.normal;
  const caps = [0, stations.length - 1].map((si) => {
    const s = body(stations[si]);
    const cap = buildTipCap(bodyHalfProfile(s, detail, spec), s.yT, stations[si], rake, si === 0, cols);
    const cNorm = cap.attributes.normal;
    const base = si * ring;
    const blend = (li, ci) => {
      const nx = lNorm.getX(li) + cNorm.getX(ci);
      const ny = lNorm.getY(li) + cNorm.getY(ci);
      const nz = lNorm.getZ(li) + cNorm.getZ(ci);
      const len = Math.hypot(nx, ny, nz) || 1;
      lNorm.setXYZ(li, nx / len, ny / len, nz / len);
      cNorm.setXYZ(ci, nx / len, ny / len, nz / len);
    };
    for (let i = 1; i < nRight; i++) {
      blend(base + i, i * row);
      blend(base + ring - 1 - i, i * row + cols);
    }
    blend(base + nRight, nRight * row);
    return part(cap, CAR_PARTS.BODY);
  });
  return mergeGeometries([part(loft, CAR_PARTS.BODY), ...caps, part(under, CAR_PARTS.TRIM)]);
}

function buildCarBody(spec, detail = 1) {
  const g = buildBodyLoft(spec, detail);
  return g.getAttribute('partId') ? g : part(g, CAR_PARTS.BODY);
}

function cabinSection(c, detail, roundness) {
  const right = [[c.beltX, c.beltY]];
  if (detail) {
    for (const s of [1 / 3, 2 / 3]) {
      right.push([lerp(c.beltX, c.railX, s) + c.bulge * 4 * s * (1 - s), lerp(c.beltY, c.railY, s)]);
    }
  }
  right.push([c.railX, c.railY]);
  for (const f of detail ? [0.2, 0.42, 0.68] : [0.5]) {
    const th = (f * Math.PI) / 2;
    right.push([c.railX * Math.pow(Math.cos(th), 2 / roundness), c.railY + c.h * Math.pow(Math.sin(th), 2 / roundness)]);
  }
  return mirrorSection(right, [0, c.railY + c.h], c.z);
}

function cabinStations(spec, detail) {
  const cab = spec.cabin;
  const zs = [];
  for (const t of detail ? [0, 0.1, 0.24, 0.42, 0.62, 0.82] : [0, 0.5]) zs.push(lerp(cab.cowl, cab.roofFront, t));
  for (const t of detail ? [0, 0.25, 0.5, 0.75] : [0, 0.5]) zs.push(lerp(cab.roofFront, cab.roofRear, t));
  for (const t of detail ? [1, 0.8, 0.6, 0.4, 0.22, 0.1, 0] : [1, 0.5, 0]) zs.push(lerp(cab.deck, cab.roofRear, t));
  return zs;
}

function buildCarCabin(spec, detail = 1) {
  if (spec.cargo) return buildCargoCabin(spec, detail);
  const L = carLayout(spec);
  const sections = cabinStations(spec, detail).map((z) => cabinSection(L.cabin(z), detail, spec.cabin.roofRound));
  return part(new LoftGeometry(sections, { closed: false }), CAR_PARTS.WINDOW);
}

// Delivery van upper body (spec.cargo), built instead of the glasshouse: one WINDOW loft from the cowl to the tail.
// spec.cabin describes the cab alone (its roof ends at the B-pillar), so up to the windshield header the sections are
// carLayout's and the material's windshield & door glass outlines land on them as on any car. Behind the header the
// roof rises into a high-roof cap (spec.cargo.rise above the cab roof) and runs flat over the cargo box, whose sides
// carry the door glass plane on up to the roof shoulder; the tail closes with a flat rear face on the body's rounded
// plan corners, over a black step bumper.
function buildCargoCabin(spec, detail = 1) {
  const L = carLayout(spec);
  const cab = spec.cabin;
  const cargo = spec.cargo;
  const rise = smoothCurve(cargo.rise);
  const fullRise = Math.max(...cargo.rise.map((p) => p[1]));
  const H = cab.roofEdge + cab.roofCrown;
  const rr = L.rail.rear;
  const bR = L.body(cab.roofRear);
  // Lean (dx / dy) of the door glass at the B-pillar, continued up the cargo sides
  const lean = (bR.xE - cab.inset - rr.x) / (rr.y - (bR.yE - 0.004));
  const n = cargo.roofRound;
  const section = (z) => {
    let c;
    if (z >= cab.roofRear) {
      c = L.cabin(z);
    } else {
      const s = L.body(z);
      const beltX = s.xE - cab.inset;
      const beltY = s.yE - 0.004;
      c = { beltX, beltY, railX: beltX - (rr.y - beltY) * lean, railY: rr.y, h: H, bulge: cab.bulge };
    }
    const up = z < cab.roofFront ? rise(z) : 0;
    // The roof's rounded shoulder grows from the cab roof's edge to the high roof's as the cap rises
    const hR = lerp(c.h, cargo.roofEdge, Math.min(1, up / fullRise));
    const top = c.railY + c.h + up;
    const sy = top - hR;
    const sx = c.railX - (sy - c.railY) * lean;
    const round = (f, x, y) => {
      const th = (f * Math.PI) / 2;
      return [x * Math.pow(Math.cos(th), 2 / n), y + hR * Math.pow(Math.sin(th), 2 / n)];
    };
    const right = [[c.beltX, c.beltY]];
    if (detail) {
      for (const t of [1 / 3, 2 / 3]) {
        right.push([lerp(c.beltX, c.railX, t) + c.bulge * 4 * t * (1 - t), lerp(c.beltY, c.railY, t)]);
      }
      right.push([c.railX, c.railY]);
      // Under the cab roof the shoulder vertex slides onto the roof's rounding instead of doubling the rail
      const k = Math.min(1, up / 0.05);
      const r0 = round(0.1, sx, sy);
      right.push([lerp(r0[0], sx, k), lerp(r0[1], sy, k)]);
    } else {
      right.push([sx, sy]);
    }
    for (const f of detail ? [0.2, 0.42, 0.68] : [0.5]) right.push(round(f, sx, sy));
    return mirrorSection(right, [0, top], z);
  };
  // Sections along the windshield, at the rise curve's knots (the first one is the windshield header) and on the
  // tail's plan rounding; the far proxy keeps the header, the end of the cap and the tail
  const zr = spec.zRear;
  const knots = cargo.rise.map((p) => p[0]).filter((z) => z > zr);
  const capEnd = cargo.rise.find((p) => p[1] === fullRise)[0];
  const zs = detail
    ? [...[0, 0.12, 0.3, 0.55, 0.8].map((t) => lerp(cab.cowl, cab.roofFront, t)), ...knots, zr + 0.045, zr + 0.015, zr]
    : [cab.cowl, cab.roofFront, lerp(cab.roofFront, capEnd, 0.4), capEnd, zr];
  const parts = [part(new LoftGeometry(zs.map(section), { closed: false, capEnd: true }), CAR_PARTS.WINDOW)];
  if (detail) {
    // Step bumper wrapping around the rear corners: a plan-view rounded rectangle extruded upwards
    const [bottom, top, depth] = cargo.bumper;
    const outline = roundedRectShape(L.body(zr + 0.1).W, depth, depth * 0.9);
    const bumper = new THREE.ExtrudeGeometry(outline, { depth: top - bottom, bevelEnabled: false, curveSegments: 2 })
      .rotateX(Math.PI / 2)
      .translate(0, top, zr);
    parts.push(part(bumper, CAR_PARTS.TRIM));
  }
  return mergeGeometries(parts);
}

/**
 * Half-width of a body's outer skin at height y of the cross-section at z (for decals & signs that hug the sides)
 */
function carBodyHalfWidthAt(spec, z, y) {
  const s = bodyProfile(spec)(z);
  const n1 = spec.lowerRound || BODY_LOWER_ROUND;
  const n2 = spec.upperRound || BODY_UPPER_ROUND;
  const pts = [];
  for (let i = 0; i <= 16; i++) {
    const th = ((i / 16) * Math.PI) / 2;
    pts.push([s.xB + (s.W - s.xB) * Math.pow(Math.sin(th), 2 / n1), s.yS - (s.yS - s.yB) * Math.pow(Math.cos(th), 2 / n1)]);
  }
  for (let i = 1; i <= 16; i++) {
    const th = ((i / 16) * Math.PI) / 2;
    pts.push([s.xE + (s.W - s.xE) * Math.pow(Math.cos(th), 2 / n2), s.yS + (s.yE - s.yS) * Math.pow(Math.sin(th), 2 / n2)]);
  }
  if (y <= pts[0][1]) return pts[0][0];
  for (let i = 1; i < pts.length; i++) {
    if (y <= pts[i][1]) {
      const t = (y - pts[i - 1][1]) / Math.max(pts[i][1] - pts[i - 1][1], 1e-6);
      return lerp(pts[i - 1][0], pts[i][0], t);
    }
  }
  return s.xE;
}

/**
 * A thin grid patch lying `offset` m off the body side (side = +1: +x) over z0..z1, y0..y1. UVs read from the
 * front of the car to the back on both sides (u = 0 at the front on the +x side, at the back on the -x side).
 */
function buildCarSidePatch(spec, side, z0, z1, y0, y1, offset = 0.003, nz = 10, ny = 6) {
  const positions = [];
  const uvs = [];
  const indices = [];
  for (let j = 0; j <= ny; j++) {
    const v = j / ny;
    const y = lerp(y0, y1, v);
    for (let i = 0; i <= nz; i++) {
      const u = i / nz;
      const z = side > 0 ? lerp(z1, z0, u) : lerp(z0, z1, u);
      positions.push(side * (carBodyHalfWidthAt(spec, z, y) + offset), y, z);
      uvs.push(u, v);
      if (i < nz && j < ny) {
        const a = j * (nz + 1) + i;
        const b = a + 1;
        const c = a + nz + 1;
        const d = c + 1;
        if (side > 0) indices.push(a, b, c, b, d, c);
        else indices.push(a, c, b, b, c, d);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(indices);
  g.computeVertexNormals();
  return g;
}

const WHEEL_SEGMENTS = 18;

/**
 * Builds a single wheel assembly centered at the origin (for steerable/spinning player wheels) or translated to
 * (x, r, z): a low-profile LatheGeometry tyre (flat tread, rounded shoulders, bulged sidewalls), a concave alloy face
 * (rim flange dishing in to a domed centre cap) and a dark disc closing the tyre from the inboard side.
 */
function buildWheelParts(spec, side, translateToAxle = false, z = 0) {
  const r = spec.wheelRadius;
  const rim = r * 0.68;
  const width = r * 0.68;
  const bead = rim + 0.006;
  const hubR = rim * 0.3;
  // Lathe profiles run from inboard (-) to outboard (+) along the axle; LatheGeometry revolves them about y
  const tyre = new THREE.LatheGeometry([
    new THREE.Vector2(bead, -width * 0.42),
    new THREE.Vector2(r * 0.86, -width * 0.5),
    new THREE.Vector2(r, -width * 0.33),
    new THREE.Vector2(r, width * 0.33),
    new THREE.Vector2(r * 0.86, width * 0.5),
    new THREE.Vector2(bead, width * 0.42)
  ], WHEEL_SEGMENTS);
  const face = new THREE.LatheGeometry([
    new THREE.Vector2(bead, width * 0.42),
    new THREE.Vector2(rim - 0.01, width * 0.4),
    new THREE.Vector2(hubR, width * 0.25)
  ], WHEEL_SEGMENTS);
  // Centre cap: a fan whose rim vertices coincide with the face's inner ring (CircleGeometry turned onto the lathe
  // axis, phase-shifted to the lathe's angles)
  const cap = new THREE.CircleGeometry(hubR, WHEEL_SEGMENTS, -Math.PI / 2);
  cap.attributes.position.setZ(0, 0.012);
  cap.computeVertexNormals();
  cap.rotateX(-Math.PI / 2).translate(0, width * 0.25, 0);
  // Closes the tyre's inboard bead hole: a 9-gon whose edges stay outside the bead circle
  const back = new THREE.CircleGeometry((bead + 0.003) / Math.cos(Math.PI / 9), 9)
    .rotateX(Math.PI / 2)
    .translate(0, -width * 0.4, 0);

  const x = translateToAxle ? side * spec.wheelX : 0;
  const y = translateToAxle ? r : 0;
  const zOff = translateToAxle ? z : 0;
  const list = [part(tyre, CAR_PARTS.TYRE), part(face, CAR_PARTS.ALLOY), part(cap, CAR_PARTS.ALLOY), part(back, CAR_PARTS.TRIM)];
  for (const g of list) g.rotateZ(-side * Math.PI * 0.5).translate(x, y, zOff);

  if (translateToAxle) list.push(buildWheelWell(spec, side, z));
  return list;
}

// Dark arch liner behind a wheel, reaching down to the sill so the arch never shows through to the other side
function buildWheelWell(spec, side, z) {
  const r = spec.wheelRadius;
  const archR = r + spec.archGap;
  const width = r * 0.68;
  const y0 = spec.sill[1][1];
  const rx = archR + 0.015;
  const ry = r + archR - y0 + 0.015;
  const x = side * (spec.wheelX - (width * 0.5 + 0.02));
  const archPow = spec.archPower || 2;
  const makeHalf = (rotY) => {
    const geo = new THREE.CircleGeometry(1, 10, 0, Math.PI);
    if (archPow !== 2) {
      const pos = geo.attributes.position;
      for (let i = 1; i < pos.count; i++) {
        const u = Math.min(1, Math.abs(pos.getX(i)));
        pos.setY(i, Math.pow(1 - Math.pow(u, archPow), 1 / archPow));
      }
    }
    return geo.scale(rx, ry, 1).rotateY(rotY).translate(x, y0, z);
  };
  return part(mergeGeometries([makeHalf(side * Math.PI * 0.5), makeHalf(-side * Math.PI * 0.5)]), CAR_PARTS.TRIM);
}

function buildSteerableWheelGeo(spec, side) {
  return mergeGeometries(buildWheelParts(spec, side, false));
}

function buildMirrors(spec) {
  const L = carLayout(spec);
  const z = spec.cabin.cowl - 0.17;
  const c = L.cabin(z);
  const [sx, sy, sz] = spec.mirrorScale || [1, 1, 1];
  const list = [];
  for (const side of [-1, 1]) {
    const housing = roundedBox(0.1, 0.06, 0.085, 0.035, 0.014)
      .scale(sx, sy, sz)
      .rotateY(side * 0.12)
      .translate(side * (c.beltX + 0.15), c.beltY + 0.085, z - 0.02);
    const arm = new THREE.BoxGeometry(0.12, 0.035, 0.06)
      .rotateZ(side * 0.35)
      .translate(side * (c.beltX + 0.04), c.beltY + 0.045, z);
    list.push(part(housing, CAR_PARTS.MIRROR), part(arm, CAR_PARTS.TRIM));
  }
  return list;
}

function buildRoofRails(spec) {
  const L = carLayout(spec);
  const cab = spec.cabin;
  const list = [];
  for (const side of [-1, 1]) {
    const sections = [0.04, 0.1, 0.9, 0.96].map((t, i) => {
      const z = lerp(cab.roofFront, cab.roofRear, t);
      const c = L.cabin(z);
      const x = side * c.railX * 0.8;
      const y = L.cabinTop(c, x) + (i === 0 || i === 3 ? 0.004 : 0.05);
      return [
        new THREE.Vector3(x - 0.02, y - 0.016, z),
        new THREE.Vector3(x + 0.02, y - 0.016, z),
        new THREE.Vector3(x + 0.02, y + 0.016, z),
        new THREE.Vector3(x - 0.02, y + 0.016, z)
      ].reverse();
    });
    list.push(part(new LoftGeometry(sections, { capStart: true, capEnd: true }), CAR_PARTS.TRIM));
  }
  return list;
}

// NYC medallion roof light: a lit, gently tapered box on a black mount
function taxiSignPlacement(spec) {
  const L = carLayout(spec);
  const cab = spec.cabin;
  const z = lerp(cab.roofFront, cab.roofRear, 0.45);
  const c = L.cabin(z);
  return { z, y: c.railY + c.h };
}

function buildTaxiSign(spec) {
  const { z, y } = taxiSignPlacement(spec);
  const shape = new THREE.Shape();
  const hw0 = 0.3;
  const hw1 = 0.27;
  const h = 0.15;
  const r = 0.035;
  shape.moveTo(-hw0, 0);
  shape.lineTo(hw0, 0);
  shape.lineTo(hw1, h - r);
  shape.quadraticCurveTo(hw1 - 0.004, h, hw1 - r, h);
  shape.lineTo(-hw1 + r, h);
  shape.quadraticCurveTo(-hw1 + 0.004, h, -hw1, h - r);
  shape.lineTo(-hw0, 0);
  const sign = new THREE.ExtrudeGeometry(shape, {
    depth: 0.12,
    bevelEnabled: true,
    bevelThickness: 0.025,
    bevelSize: 0.012,
    bevelSegments: 2,
    curveSegments: 3
  }).translate(0, y + 0.03, z - 0.06);
  const mount = new THREE.BoxGeometry(0.46, 0.04, 0.12).translate(0, y + 0.012, z);
  return [part(sign, CAR_PARTS.SIGN), part(mount, CAR_PARTS.TRIM)];
}

// Matte-black tonneau cover and bed-side rail caps over a pickup truck's bed (behind cabin.deck)
function buildBedCover(spec) {
  const body = bodyProfile(spec);
  const zs = [spec.cabin.deck - 0.01, spec.zRear + 0.42, spec.zRear + 0.08];
  const sections = zs.map((z) => {
    const s = body(z);
    const x = s.xE - 0.045;
    const y = s.yE + 0.014;
    return [
      [-x, y],
      [-x + 0.006, y + 0.032],
      [-x + 0.056, y + 0.032],
      [-x + 0.068, y + 0.02],
      [x - 0.068, y + 0.02],
      [x - 0.056, y + 0.032],
      [x - 0.006, y + 0.032],
      [x, y]
    ].map(([px, py]) => new THREE.Vector3(px, py, z));
  });
  return [part(new LoftGeometry(sections, { closed: false, capStart: false, capEnd: true }), CAR_PARTS.TRIM)];
}

// Bumpers are part of the body loft (the raked nose & tail): body-coloured fascias, like modern cars'
function buildCarGeometry(spec, includeWheels = true) {
  const parts = [buildCarBody(spec, 1), buildCarCabin(spec, 1), ...buildMirrors(spec)];
  for (const side of [-1, 1]) {
    for (const z of [-spec.wheelZ, spec.wheelZ]) {
      if (includeWheels) parts.push(...buildWheelParts(spec, side, true, z));
      else parts.push(buildWheelWell(spec, side, z));
    }
  }
  if (spec.rails) parts.push(...buildRoofRails(spec));
  if (spec.bedCover) parts.push(...buildBedCover(spec));
  if (spec.sign) parts.push(...buildTaxiSign(spec));
  return mergeGeometries(parts);
}

// A ~250-triangle stand-in for distant cars (a few pixels tall): the same body & glasshouse lofted from a handful of
// coarse sections, dark wheel blocks and the taxi's roof sign. Same attributes (partId, uv, normal) as the full
// model, so it renders with the same material and per-instance paint.
function buildCarProxyGeometry(spec) {
  const parts = [buildCarBody(spec, 0), buildCarCabin(spec, 0)];
  const r = spec.wheelRadius;
  for (const side of [-1, 1]) {
    for (const z of [-spec.wheelZ, spec.wheelZ]) {
      const wheel = new THREE.CylinderGeometry(r * 0.96, r * 0.96, r * 0.62, 6)
        .rotateZ(Math.PI * 0.5)
        .translate(side * spec.wheelX, r, z);
      parts.push(part(wheel, CAR_PARTS.TYRE));
    }
  }
  if (spec.sign) {
    const { z, y } = taxiSignPlacement(spec);
    parts.push(part(new THREE.BoxGeometry(0.58, 0.16, 0.16).translate(0, y + 0.1, z), CAR_PARTS.SIGN));
  }
  return mergeGeometries(parts);
}

// Outward half-planes of a counter-clockwise polygon, each edge moved in by its margin (the glass outlines of
// carmaterial.js)
function polygonPlanes(points, margins) {
  const planes = [];
  for (let i = 0; i < points.length; i++) {
    const [ax, ay] = points[i];
    const [bx, by] = points[(i + 1) % points.length];
    const len = Math.hypot(bx - ax, by - ay);
    const nx = (by - ay) / len;
    const ny = -(bx - ax) / len;
    planes.push([nx, ny, ax * nx + ay * ny - margins[i]]);
  }
  return planes;
}

// Per-instance style fields packed into carState.w: livery 0..7 (4: a black roof), metallic 0..1, trim 0..3 (1 chrome,
// 2 blackout, 3 two-tone), wheel 0..3
function carStyleCode({ livery = 0, metallic = 0, trim = 0, wheel = 0 } = {}) {
  return (livery & 7) + ((metallic & 1) << 3) + ((trim & 3) << 4) + ((wheel & 3) << 6);
}

export {
  CAR_PARTS,
  BODY_SPECS,
  carLayout,
  carBodyHalfWidthAt,
  carTipZ,
  taxiSignPlacement,
  polygonPlanes,
  carStyleCode,
  buildCarSidePatch,
  buildSteerableWheelGeo,
  buildCarGeometry,
  buildCarProxyGeometry,
  buildBodyLoft,
  part,
  mirrorSection,
  roundedBox,
  roundedRectShape,
};
