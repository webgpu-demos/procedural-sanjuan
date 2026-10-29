// The AMA's 40-foot low-floor bus, lofted with the car bodies' machinery (carbodies.js), after mrdoob's slop-newyork
// (js/bus.js, MIT): rounded plan-view corners, a raked windshield, a tight roof radius, arches over the wheels; bumpers,
// the folded front bike rack, stalk mirrors and the roof's AC and battery pods are pieces of the same mesh (partId),
// the heavy steel wheels too. Windows, doors, livery, signs and lamps are painted by its material (busmaterial.js).
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { LoftGeometry } from 'three/addons/geometries/LoftGeometry.js';
import { part, mirrorSection, roundedBox, buildBodyLoft } from './carbodies.js';

const BUS_PARTS = {
  BODY: 0,
  TRIM: 1,
  POD: 2,
  FAIRING: 3,
  TYRE: 4,
  DISC: 5
};

const BUS_SPEC = {
  name: 'bus',
  headlight: [0.89, 0.78], // midpoint of each swept Xcelsior LED headlamp cluster
  zFront: 5.9,
  zRear: -6.22,
  wheelRadius: 0.5,
  wheelZ: 3.6,
  wheelX: 1.12,
  archGap: 0.085,
  archFlare: 0.012,
  tuck: 0.035,
  stationStep: 0.92,
  lowerRound: 3.4,
  upperRound: 7.5,
  upperSamples: [0.35, 0.66, 0.89, 1],
  halfWidth: [[5.9, 1.3], [-6.22, 1.3]],
  sill: [[5.9, 0.35], [-6.22, 0.36]],
  shoulder: [[5.9, 0.98], [-6.22, 0.98]],
  edge: [[5.9, 2.94], [-6.22, 2.94]],
  crown: [[5.9, 0.04], [-6.22, 0.04]],
  tumble: [[5.9, 0.055], [-6.22, 0.055]],
  nose: { halfWidth: [0.28, 1.06, 2.2], edge: [0.26, 2.74, 2], crown: [0.26, 0.006, 2], sill: [0.08, 0.42, 2], shoulder: [0.2, 0.92, 2] },
  tail: { halfWidth: [0.22, 1.12, 2.2], edge: [0.2, 2.78, 2], crown: [0.2, 0.006, 2], sill: [0.1, 0.46, 2], shoulder: [0.18, 0.94, 2] },
  rake: 0.22, // how far the top of the windshield & sign header leans back
  window: [1.22, 2.42], // side window band (y)
  frontDoor: [4.36, 5.42], // curb-side (-x) low-floor entry & rear exit doors (z ranges)
  rearDoor: [-2.06, -1.02]
};

// Windshield & header rake at the nose (plus slight plan-view bow and upper-rear cap taper)
function busRake(y, z, x = 0) {
  const s = BUS_SPEC;
  const alongF = Math.min(1, Math.max(0, (z - (s.zFront - 1.15)) / 1.15));
  const upF = Math.min(1, Math.max(0, (y - 1.1) / 1.72));
  const noseBow = alongF * alongF * (0.028 * x * x + Math.max(0, 1.12 - y) * 0.035);
  const alongR = Math.min(1, Math.max(0, (s.zRear + 0.75 - z) / 0.75));
  const upR = Math.min(1, Math.max(0, (y - 1.38) / 1.5));
  const tailTaper = -0.055 * alongR * alongR * Math.pow(upR, 1.25);
  return s.rake * alongF * alongF * Math.pow(upF, 1.22) + noseBow + tailTaper;
}

function buildLoftedBusBodyGeometry() {
  const s = BUS_SPEC;
  const body = buildBodyLoft(s, 1);
  const pos = body.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    pos.setZ(i, z - busRake(y, z, x));
  }
  body.computeVertexNormals();
  const parts = [part(body, BUS_PARTS.BODY)];

  // Sculpted New Flyer Xcelsior full-length roof fairing (shroud): aerodynamic sloped nose behind the front sign,
  // raised battery/cooling fairing over the front half, stepped rear HVAC shroud, painted in upper-body livery
  const roofY = s.edge[0][1] + s.crown[0][1] - 0.03;
  const fairingStations = [
    [4.68, 0.92, 0.01, 0.005],
    [4.12, 1.08, 0.22, 0.035],
    [3.35, 1.13, 0.26, 0.04],
    [-0.35, 1.13, 0.26, 0.04],
    [-0.85, 1.12, 0.2, 0.035],
    [-5.55, 1.11, 0.19, 0.035],
    [-5.95, 0.98, 0.02, 0.008]
  ];
  const fairingSections = fairingStations.map(([z, hw, h, cr]) =>
    mirrorSection(
      [
        [hw, roofY],
        [hw - 0.035, roofY + h * 0.68],
        [hw - 0.12, roofY + h],
        [hw * 0.45, roofY + h + cr * 0.8]
      ],
      [0, roofY + h + cr],
      z
    )
  );
  parts.push(part(new LoftGeometry(fairingSections, { closed: false }), BUS_PARTS.FAIRING));

  // Recessed roof HVAC & battery cooling modules nested inside the roof shroud
  parts.push(part(roundedBox(0.88, 0.065, 2.5, 0.08, 0.025).translate(0, roofY + 0.22, -3.35), BUS_PARTS.POD));
  parts.push(part(roundedBox(0.84, 0.06, 2.7, 0.08, 0.025).translate(0, roofY + 0.27, 1.45), BUS_PARTS.POD));

  // Wraparound 3-piece energy-absorbing front & rear bumpers + folded Sportworks front bike rack
  const zNose = s.zFront - busRake(0.48, s.zFront, 0);
  parts.push(part(roundedBox(1.27, 0.13, 0.26, 0.075, 0.028).translate(0, 0.47, zNose - 0.02), BUS_PARTS.TRIM));
  parts.push(part(roundedBox(1.26, 0.125, 0.24, 0.065, 0.028).translate(0, 0.46, s.zRear + 0.03), BUS_PARTS.TRIM));
  const rackZ = zNose + 0.14;
  parts.push(part(roundedBox(0.54, 0.022, 0.045, 0.018, 0.007).translate(0, 0.96, rackZ + 0.03), BUS_PARTS.TRIM));
  parts.push(part(roundedBox(0.5, 0.02, 0.045, 0.016, 0.007).translate(0, 0.68, rackZ), BUS_PARTS.TRIM));
  for (const side of [-1, 1]) {
    parts.push(part(new THREE.BoxGeometry(0.032, 0.34, 0.032).rotateX(-0.1).translate(side * 0.49, 0.81, rackZ + 0.015), BUS_PARTS.TRIM));
    parts.push(part(new THREE.BoxGeometry(0.024, 0.28, 0.024).rotateX(-0.1).translate(side * 0.18, 0.81, rackZ + 0.015), BUS_PARTS.TRIM));
  }

  // Asymmetric Xcelsior transit mirrors: high-mount curb arm (-x) clearing boarding passengers, mid-mount driver arm (+x)
  for (const side of [-1, 1]) {
    const mountY = side < 0 ? 2.48 : 2.16;
    const headY = side < 0 ? 2.28 : 1.98;
    const stalk = new THREE.BoxGeometry(0.036, 0.036, 0.44)
      .rotateX(0.32)
      .rotateY(side * 0.42)
      .translate(side * 1.27, mountY - 0.06, s.zFront - 0.06);
    const head = roundedBox(0.072, 0.19, 0.055, 0.026, 0.01).translate(side * 1.37, headY, s.zFront + 0.08);
    parts.push(part(stalk, BUS_PARTS.TRIM), part(head, BUS_PARTS.TRIM));
  }

  // Enclosed 3D wheel-well housings (inward-facing arch ceiling + double-sided back liner) so no gap shows around the wheels
  const wellR = s.wheelRadius + s.archGap + 0.008;
  const wellDepth = 0.36;
  for (const side of [-1, 1]) {
    for (const z of [-s.wheelZ, s.wheelZ]) {
      const cyl = new THREE.CylinderGeometry(wellR, wellR, wellDepth, 10, 1, true, -0.28, Math.PI + 0.56)
        .scale(-1, 1, 1)
        .rotateZ(-Math.PI * 0.5)
        .translate(side * (s.wheelX - 0.02), s.wheelRadius, z);
      const backOut = new THREE.CircleGeometry(wellR, 10, -0.28, Math.PI + 0.56)
        .rotateY(side * Math.PI * 0.5)
        .translate(side * (s.wheelX - 0.19), s.wheelRadius, z);
      const backIn = new THREE.CircleGeometry(wellR, 10, -0.28, Math.PI + 0.56)
        .rotateY(-side * Math.PI * 0.5)
        .translate(side * (s.wheelX - 0.19), s.wheelRadius, z);
      parts.push(part(cyl, BUS_PARTS.TRIM), part(backOut, BUS_PARTS.TRIM), part(backIn, BUS_PARTS.TRIM));
    }
  }
  return mergeGeometries(parts);
}

// Heavy-duty 22.5" transit bus wheel: tall 305/70R22.5 tyre sidewall with deep-dish white/silver steel wheel,
// 10 lug nuts, 5 hand-hole cutouts, and a protruding cast-iron axle hub (spins about x, centred on the origin)
function buildBusWheelGeo(side) {
  const r = BUS_SPEC.wheelRadius;
  const w = 0.3;
  const rimR = r * 0.59;
  const tyre = new THREE.LatheGeometry(
    [
      new THREE.Vector2(rimR, -w * 0.48),
      new THREE.Vector2(r * 0.95, -w * 0.44),
      new THREE.Vector2(r, -w * 0.28),
      new THREE.Vector2(r, w * 0.28),
      new THREE.Vector2(r * 0.95, w * 0.44),
      new THREE.Vector2(rimR, w * 0.48)
    ],
    22
  );
  const disc = new THREE.LatheGeometry(
    [
      new THREE.Vector2(rimR, w * 0.48),
      new THREE.Vector2(rimR * 0.92, w * 0.42),
      new THREE.Vector2(rimR * 0.72, w * 0.18),
      new THREE.Vector2(0.115, w * 0.22)
    ],
    22
  );
  const backDisc = new THREE.LatheGeometry(
    [
      new THREE.Vector2(0, -w * 0.18),
      new THREE.Vector2(rimR * 0.75, -w * 0.18),
      new THREE.Vector2(rimR, -w * 0.48)
    ],
    14
  );
  const cap = new THREE.CylinderGeometry(0.095, 0.118, 0.13, 14).translate(0, w * 0.26, 0);
  const parts = [
    part(tyre, BUS_PARTS.TYRE),
    part(disc, BUS_PARTS.DISC),
    part(backDisc, BUS_PARTS.DISC),
    part(cap, BUS_PARTS.DISC)
  ];
  for (const g of parts) g.rotateZ(-side * Math.PI * 0.5);
  return mergeGeometries(parts);
}

// The whole bus at the axles: body, pieces, wheels. detail 0: the stand-in further off (a coarse loft, the body's
// raked nose and tail, plain wheels)
function buildBusGeometry(detail = 1) {
  const s = BUS_SPEC;
  if (!detail) {
    const body = buildBodyLoft(s, 0), pos = body.attributes.position;
    for (let i = 0; i < pos.count; i++) pos.setZ(i, pos.getZ(i) - busRake(pos.getY(i), pos.getZ(i), pos.getX(i)));
    body.computeVertexNormals();
    const parts = [part(body, BUS_PARTS.BODY)];
    for (const side of [-1, 1]) for (const z of [-s.wheelZ, s.wheelZ]) {
      parts.push(part(new THREE.CylinderGeometry(s.wheelRadius * 0.97, s.wheelRadius * 0.97, 0.3, 8).rotateZ(Math.PI / 2).translate(side * s.wheelX, s.wheelRadius, z), BUS_PARTS.TYRE));
    }
    return mergeGeometries(parts);
  }
  const parts = [buildLoftedBusBodyGeometry()];
  for (const side of [-1, 1]) for (const z of [-s.wheelZ, s.wheelZ]) parts.push(buildBusWheelGeo(side).translate(side * s.wheelX, s.wheelRadius, z));
  return mergeGeometries(parts);
}

export { BUS_PARTS, BUS_SPEC, busRake, buildBusGeometry };
