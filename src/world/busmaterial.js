// The bus's material (busbody.js): after mrdoob's TSL bus material in slop-newyork (js/bus.js, MIT), as GLSL for
// WebGLRenderer, in the AMA's colours: white, a band in the route's colour (GTFS, buses.json) along the lower body
// under a thin navy stripe, a dark skirt. The black windshield and destination-sign mask (its amber LED line lit),
// framed side windows with mullions and a transom, the curb-side doors, seats, stanchions and the ceiling's light
// strip behind the glass (lit at night), swept headlamps, the rear's stacked round lamps, louvers and route box,
// wheel-arch flares, plates; the steel wheels with their lugs and hand holes, turning as the bus goes. Edges filtered
// over their screen footprint, as the cars' (carmaterial.js). Per instance: paintColor (the band), carState (brake,
// turn signals), aWheel (turn, blur), aHide.
import * as THREE from 'three';
import { BUS_SPEC, BUS_PARTS } from './busbody.js';
import { shared } from './materials.js';
import { SHADOW } from './people.js';
import { CAR_LAMPS } from './carmaterial.js';

const f = (x) => { const s = Number(x).toFixed(5); return s.includes('.') ? s : `${s}.0`; };
const c = (hex) => { const k = new THREE.Color(hex); return `vec3(${f(k.r)}, ${f(k.g)}, ${f(k.b)})`; };

const HELPERS = /* glsl */`
float ss(float a, float b, float x) { float t = clamp((x - a) / (b - a), 0.0, 1.0); return t * t * (3.0 - 2.0 * t); }
float cov(float d, float w) { return clamp(0.5 - d / w, 0.0, 1.0); }
float covAt(float r, float d, float w) { return clamp(0.5 - (d - r) / w, 0.0, 1.0); }
float covUp(float r, float d, float w) { return clamp(0.5 + (d - r) / w, 0.0, 1.0); }
float band(float d, float h, float w) { return clamp((min(d + h, w * 0.5) - max(d - h, -w * 0.5)) / w, 0.0, 1.0); }
vec2 boxEdge(float dx, float dy, float hx, float hy, float wx, float wy) { float ex = abs(dx) - hx, ey = abs(dy) - hy; return vec2(max(ex, ey), mix(wy, wx, step(ey, ex))); }
float boxMask(float dx, float dy, float hx, float hy, float wx, float wy) { vec2 e = boxEdge(dx, dy, hx, hy, wx, wy); return cov(e.x, e.y); }
vec2 rBoxEdge(float dx, float dy, float hx, float hy, float r, float wx, float wy) { float ex = abs(dx) - (hx - r), ey = abs(dy) - (hy - r); return vec2(length(vec2(max(ex, 0.0), max(ey, 0.0))) + min(max(ex, ey), 0.0) - r, mix(wy, wx, step(ey, ex))); }
float detailFade(float w) { return ss(0.055, 0.014, w); }
float fineFade(float w) { return ss(0.028, 0.007, w); }`;

function code() {
  const s = BUS_SPEC, [wy0, wy1] = s.window, winMid = (wy0 + wy1) / 2, winHalf = (wy1 - wy0) / 2, archR = s.wheelRadius + s.archGap;
  return /* glsl */`
  vec3 p = vCarPos, n = normalize(vCarNor);
  float partId = vCarPart;
  float isBody = step(abs(partId - ${f(BUS_PARTS.BODY)}), 0.25), isTrim = step(abs(partId - ${f(BUS_PARTS.TRIM)}), 0.25);
  float isPod = step(abs(partId - ${f(BUS_PARTS.POD)}), 0.25), isFairing = step(abs(partId - ${f(BUS_PARTS.FAIRING)}), 0.25);
  float isTyre = step(abs(partId - ${f(BUS_PARTS.TYRE)}), 0.25), isDisc = step(abs(partId - ${f(BUS_PARTS.DISC)}), 0.25);
  float isSkin = max(isBody, isFairing);
  float ax = abs(p.x), az = abs(p.z);
  vec3 fwp = max(fwidth(p), vec3(0.0015));
  float fwX = fwp.x, fwY = fwp.y, fwZ = fwp.z, fwXY = max(fwX, fwY), fwZY = max(fwZ, fwY);
  float front = ss(0.15, 0.42, n.z) * ss(${f(s.zFront - 0.98)}, ${f(s.zFront - 0.9)}, p.z) * isBody;
  float rear = ss(0.15, 0.42, -n.z) * ss(${f(s.zRear + 0.98)}, ${f(s.zRear + 0.9)}, p.z) * isBody;
  float side = ss(0.45, 0.72, abs(n.x)) * isSkin;
  float curb = step(p.x, 0.0);
  float night = ss(0.15, 0.75, uNight);
  float brake = vCarState.x, blink = max(vCarState.y * step(0.0, p.x), vCarState.z * step(p.x, 0.0));

  // the front: one black mask round the windshield and the destination sign; the split windshield and its wipers
  vec2 fm = rBoxEdge(p.x, p.y - 1.97, 1.22, 0.8, 0.15, fwX, fwY);
  float frontMask = cov(fm.x, fm.y) * front;
  float frontGlassOuter = boxMask(p.x, p.y - 1.8, 1.15, 0.56, fwX, fwY) * frontMask;
  float inWiperY = ss(1.23, 1.25, p.y) * ss(1.97, 1.95, p.y), wiperTilt = (p.y - 1.24) * 0.36;
  float wipers = max(band(p.x - 0.38 + wiperTilt, 0.015, fwX), band(p.x + 0.14 - wiperTilt, 0.015, fwX)) * inWiperY;
  float frontGlass = frontGlassOuter * (1.0 - band(p.x, 0.015, fwX)) * (1.0 - wipers * 0.85);
  float signBand = boxMask(p.x, p.y - 2.56, 1.02, 0.16, fwX, fwY) * front;
  // (the sign's amber line: the route and where it goes, as a row of LED letters)
  float signText = mix(0.45, ss(0.15, 0.55, sin(p.x * 48.0) * sin(p.y * 160.0)), fineFade(fwX)) * band(p.y - 2.56, 0.065, fwY) * band(p.x + 0.05, 0.82, fwX) * front;
  float browCenterX = min(ax, abs(ax - 0.13));
  float browMarker = max(covAt(0.022, length(vec2(browCenterX * 0.7, (p.y - 2.81) * 1.4)), fwXY), covAt(0.025, length(vec2((ax - 0.98) * 0.65, (p.y - 2.79) * 1.4)), fwXY)) * front;

  // the rear: the route's box, louvers, three ID lamps, the ad frame, the engine door, the high brake lamp
  float rearSignBox = boxMask(p.x + 0.45, p.y - 2.58, 0.31, 0.14, fwX, fwY) * rear;
  float rearSignText = mix(0.45, ss(0.15, 0.55, sin(p.x * 48.0) * sin(p.y * 160.0)), fineFade(fwX)) * boxMask(p.x + 0.45, p.y - 2.58, 0.25, 0.07, fwX, fwY) * rear;
  float rearLouverArea = boxMask(p.x - 0.42, p.y - 2.58, 0.44, 0.14, fwX, fwY) * covUp(0.024, abs(p.x - 0.42), fwX) * rear;
  float rearUpperSlats = mix(0.58, ss(0.32, 0.46, fract(p.y * 22.0)) * 0.55 + 0.25, fineFade(fwY));
  float rearIdLamps = max(covAt(0.02, length(vec2(min(ax, abs(ax - 0.14)) * 0.7, (p.y - 2.79) * 1.4)), fwXY), covAt(0.023, length(vec2((ax - 0.96) * 0.65, (p.y - 2.74) * 1.4)), fwXY)) * rear;
  vec2 rearAd = boxEdge(p.x, p.y - 1.82, 0.63, 0.21, fwX, fwY);
  float rearAdInner = cov(rearAd.x, rearAd.y) * rear, rearAdFrame = covAt(0.03, rearAd.x, rearAd.y) * rear;
  float rearSeam = max(band(p.y - 1.42, 0.008, fwY) * ss(0.95, 0.93, ax), band(ax - 0.92, 0.008, fwX) * ss(0.58, 0.62, p.y) * ss(2.77, 2.73, p.y)) * rear;
  float highBrake = boxMask(p.x, p.y - 1.48, 0.2, 0.018, fwX, fwY) * rear;
  float sideRearGrille = max(boxMask(p.z - ${f(s.zRear + 0.52)}, p.y - 0.88, 0.38, 0.3, fwZ, fwY), boxMask(p.z - ${f(s.zRear + 0.48)}, p.y - 2.62, 0.26, 0.13, fwZ, fwY)) * side;
  float slats = mix(0.56, ss(0.38, 0.52, fract(p.y * 18.0)) * 0.5 + 0.3, fineFade(fwY));

  // the side: the window band, its seal, mullions every 1.3 m and a transom; the driver's window; the curb-side doors
  vec2 sideWin = rBoxEdge(p.z + 0.78, p.y - ${f(winMid)}, 4.92, ${f(winHalf)}, 0.065, fwZ, fwY);
  float sideBand = cov(sideWin.x, sideWin.y) * side, sideSeal = covAt(0.044, sideWin.x, sideWin.y) * side;
  float mullion = 1.0 - band(fract(p.z * 0.76 + 0.18) - 0.5, 0.038, fwZ * 0.76);
  float transomBar = 1.0 - band(p.y - 2.08, 0.015, fwY) * 0.88;
  float sideSignCutout = 1.0 - boxMask(p.z - 3.74, p.y - 2.26, 0.56, 0.11, fwZ, fwY) * curb;
  float sideSign = boxMask(p.z - 3.74, p.y - 2.26, 0.5, 0.08, fwZ, fwY) * curb * side;
  vec2 drvWin = boxEdge(p.z - 4.92, p.y - ${f(winMid + 0.02)}, 0.52, ${f(winHalf)}, fwZ, fwY);
  float driverSeal = covAt(0.044, drvWin.x, drvWin.y) * side * (1.0 - curb);
  float driverWin = cov(drvWin.x, drvWin.y) * covUp(0.02, abs(p.z - 4.92), fwZ) * side * (1.0 - curb);
  float dzDoor = min(abs(p.z - 4.89), abs(p.z + 1.54)), doorSide = side * curb;
  float doorFrame = boxMask(dzDoor, p.y - 1.42, 0.525, 1.02, fwZ, fwY) * doorSide;
  float doorGlass = boxMask(abs(dzDoor - 0.25), p.y - 1.48, 0.19, 0.86, fwZ, fwY) * (1.0 - band(p.y - 1.18, 0.015, fwY) * 0.85) * doorSide;
  float sideGlassPanes = sideBand * mullion * transomBar * sideSignCutout * (1.0 - doorFrame);
  float glass = clamp(max(frontGlass, max(max(sideGlassPanes, driverWin), doorGlass)), 0.0, 1.0);
  float seal = clamp(max(max(frontMask, rearSignBox), max(max(sideSeal, driverSeal), max(signBand, doorFrame))), 0.0, 1.0);
  vec2 archVec = vec2(az - ${f(s.wheelZ)}, max(0.0, p.y - ${f(s.wheelRadius)}));
  float dArch = length(archVec);
  vec2 archDir = archVec / max(dArch, 0.0001);
  float archFlareMask = band(dArch - ${f(archR + 0.0225)}, 0.0325, max(abs(archDir.x) * fwZ + abs(archDir.y) * fwY, 0.0005)) * covUp(0.35, p.y, fwY) * side;

  // the AMA's colours: white; the route's colour along the lower body under a navy stripe, sweeping up to the front
  float shadeY = ss(0.34, 1.25, p.y) * 0.16 + 0.84;
  float rise = ss(3.2, 5.2, p.z) * 0.32;
  float routeBand = ss(1.06 + rise, 1.04 + rise, p.y) * max(side, front) * (1.0 - doorFrame);
  float navy = band(p.y - (1.13 + rise), 0.03, fwY + fwZ * 0.16) * side * (1.0 - doorFrame);
  vec3 livery = mix(mix(${c(0xedf1f6)}, vCarPaint, routeBand), ${c(0x14306e)}, navy);
  livery = mix(livery, ${c(0x181c22)}, covAt(0.415, p.y, fwY)) * shadeY;

  // plates, the AMA's badge on the front, the wheelchair sign at the front door
  float dBadge = length(vec2(p.x, p.y - 0.95));
  float badge = covAt(0.102, dBadge, fwXY) * front * (1.0 - covAt(0.072, dBadge, fwXY) * 0.85);
  float wheelchairBadge = boxMask(p.z - 5.52, p.y - 0.98, 0.065, 0.075, fwZ, fwY) * doorSide;
  float frontPlate = boxMask(p.x - 0.88, p.y - 1.02, 0.14, 0.065, fwX, fwY) * front;
  vec2 rearPlateEdge = boxEdge(p.x, p.y - 0.76, 0.155, 0.07, fwX, fwY);
  float plate = max(frontPlate, cov(rearPlateEdge.x, rearPlateEdge.y) * rear), rearPlateRecess = covAt(0.036, rearPlateEdge.x, rearPlateEdge.y) * rear;
  float plateText = mix(0.55, ss(0.35, 0.55, fract(p.x * 22.0)), fineFade(fwX)) * max(band(p.y - 0.76, 0.035, fwY), band(p.y - 1.02, 0.03, fwY));

  // lamps: the swept headlamp pods (a lamp, a daytime bar), the turn signals under them; the rear's stack of four
  float lampTiltY = p.y - (0.74 + (ax - 0.76) * 0.14);
  float pod = boxMask(ax - 0.93, lampTiltY, 0.21, 0.064, fwX, fwY) * front;
  float headLamp = covAt(0.041, length(vec2(abs(ax - 0.91) - 0.07, lampTiltY)), fwXY) * pod;
  float drlStrip = band(lampTiltY + 0.038, 0.011, fwY) * pod;
  float turnFront = boxMask(ax - 1.05, p.y - 0.62, 0.075, 0.022, fwX, fwY) * front;
  float inRearStack = ss(0.59, 0.61, p.y) * ss(1.41, 1.39, p.y) * rear;
  float dRearLamp = length(vec2(ax - 1.03, (fract((p.y - 0.6) * 5.0) - 0.5) * 0.2));
  float rearBezel = covAt(0.066, dRearLamp, fwXY) * inRearStack, rearLens = covAt(0.049, dRearLamp, fwXY) * inRearStack;
  float turnRear = rearLens * step(1.2, p.y), tailLamp = rearLens * step(0.8, p.y) * step(p.y, 1.2), reverseLamp = rearLens * step(p.y, 0.8);
  float sideMarkers = covAt(0.025, length(vec2(az - ${f(s.wheelZ + 0.68)}, p.y - 1.02)), fwZY) * side;

  // behind the glass: seats, yellow stanchions, the ceiling's light strip
  float skyGrad = clamp((p.y - 1.22) * 0.85, 0.0, 1.0);
  float seatBack = ss(1.64, 1.54, p.y) * ss(0.1, 0.2, abs(fract(p.z * 1.15) - 0.5)) * ss(3.85, 3.75, p.z);
  float grabRail = band(fract(p.z * 0.76 + 0.5) - 0.5, 0.026, fwZ * 0.76) * ss(2.3, 2.26, p.y);
  float frontInterior = ss(1.62, 1.3, p.y) * ss(0.15, 0.35, ax) * front;
  float ceilingStrip = ss(2.12, 2.32, p.y) * ss(4.45, 4.35, p.z);
  vec3 glassTint = mix(${c(0x0f1c2b)}, ${c(0x1f3852)}, skyGrad);
  glassTint = mix(glassTint, ${c(0x0a1524)}, max(seatBack * 0.68, frontInterior * 0.45));
  glassTint = mix(glassTint, ${c(0xb8921c)}, grabRail * side * 0.5);
  glassTint = mix(glassTint, ${c(0x324d66)}, ceilingStrip * 0.28);

  vec3 body = mix(livery, ${c(0x12161b)}, max(seal, max(archFlareMask, max(rearSeam, rearPlateRecess))));
  body = mix(body, ${c(0x181c22)} * slats, sideRearGrille);
  body = mix(body, ${c(0x282418)} * rearUpperSlats, rearLouverArea);
  body = mix(body, ${c(0x1c222b)}, rearAdFrame);
  body = mix(body, ${c(0x162e48)}, rearAdInner);
  body = mix(body, ${c(0xf2f6fa)}, badge);
  body = mix(body, ${c(0x1258b8)}, wheelchairBadge);
  body = mix(body, ${c(0x12151a)}, max(pod, rearBezel));
  body = mix(body, ${c(0xf2f8ff)}, max(headLamp, drlStrip));
  body = mix(body, ${c(0xff9d14)}, max(turnFront, max(browMarker, sideMarkers)));
  body = mix(body, ${c(0x9e0e16)}, max(tailLamp, max(highBrake, rearIdLamps)));
  body = mix(body, ${c(0xd86e18)}, turnRear);
  body = mix(body, ${c(0xe8eef4)}, reverseLamp);
  body = mix(body, mix(${c(0xf2f4f6)}, ${c(0x182648)}, plateText * 0.65), plate);
  body = mix(body, glassTint, glass);
  body = mix(body, ${c(0x2a1a06)}, max(signText, max(rearSignText, sideSign * 0.8)) * 0.9);

  // the wheels: tyre and steel disc, the disc's ten lugs and five hand holes turning with it
  vec2 wv = vec2(p.z - sign(p.z) * ${f(s.wheelZ)}, p.y - ${f(s.wheelRadius)});
  float radial = length(wv), theta = atan(wv.y, wv.x) + vCarWheel.x;
  vec2 radDir = wv / max(radial, 0.0001);
  float fwRing = abs(radDir.x) * fwZ + abs(radDir.y) * fwY, fwTan = abs(radDir.y) * fwZ + abs(radDir.x) * fwY, fwRound = max(fwRing, fwTan);
  float sharp = 1.0 - vCarWheel.y;
  float a10 = (fract(theta * 1.5915494 + 0.5) - 0.5) * 0.6283185, lugArc = radial * a10;
  float dLug = length(vec2(radial - 0.175, lugArc));
  float lugs = covAt(0.015, dLug, fwRound) * detailFade(fwRound) * sharp;
  float a5 = (fract((theta - 0.31) * 0.7957747 + 0.5) - 0.5) * 1.256637;
  float vents = mix(0.3, covAt(0.03, length(vec2(radial - 0.238, radial * a5 * 0.85)), fwRound), sharp) * ss(0.06, 0.015, fwRound);
  float rimLip = band(radial - 0.282, 0.008, fwRing);
  vec3 steel = ${c(0xdce2e8)} * (ss(0.16, 0.27, radial) * 0.22 + 0.78) * (1.0 - rimLip * 0.35);
  vec3 disc = mix(steel, ${c(0x101317)}, vents * 0.92);
  disc = mix(disc, ${c(0x22262b)}, covAt(0.115, radial, fwRing));
  disc = mix(disc, ${c(0x3a4048)}, covAt(0.068, radial, fwRing));
  disc = mix(disc, ${c(0x1e2228)}, lugs * 0.88);
  float sidewall = ss(0.295, 0.36, radial) * (1.0 - ss(0.44, 0.495, radial) * 0.22) * 0.28 + 0.72 + band(radial - 0.41, 0.008, fwRing) * 0.06;
  vec3 tyreCol = ${c(0x16181b)} * sidewall;

  vec3 carCol = mix(mix(body, ${c(0x191d22)}, isTrim), ${c(0xd0d5dc)}, isPod);
  carCol = mix(carCol, disc, isDisc);
  carCol = mix(carCol, tyreCol, isTyre);
  float carRough = mix(mix(mix(0.16, 0.06, max(glass, max(headLamp, rearLens))), 0.68, max(isTrim, max(archFlareMask, seal * (1.0 - glass)))), 0.36, isPod);
  carRough = mix(carRough, mix(0.32, 0.78, vents), isDisc);
  carRough = mix(carRough, 0.86, isTyre);
  float carMetal = mix(mix(0.24, 0.82, glass), 0.06, max(isTrim, isPod));
  carMetal = mix(carMetal, mix(0.55, 0.15, vents), isDisc);
  carMetal = mix(carMetal, 0.02, isTyre);
  float cabinGlow = glass * side * (ceilingStrip * 0.55 + 0.18 - seatBack * 0.12 + grabRail * 0.15) * night;
  float headEmit = pod * mix(0.25, 0.42, night) + drlStrip * mix(1.1, 1.8, night) + headLamp * mix(0.6, 3.0, night);
  vec3 carEmit = (${c(0xe8f4ff)} * headEmit + ${c(0xff0c14)} * (tailLamp * (brake * 1.6 + 0.2 + night * 0.55) + highBrake * brake * 1.8 + rearIdLamps * night)) * uCarLamps
    + ${c(0xfff0d4)} * cabinGlow
    + ${c(0xff9210)} * max(browMarker, sideMarkers) * mix(0.35, 1.15, night)
    + ${c(0xff9a14)} * max(turnFront, turnRear) * blink * 2.2
    + ${c(0xffb020)} * max(signText, max(rearSignText, sideSign * 0.8)) * (0.8 + night * 1.2);
  float carGlass = glass;
  diffuseColor.rgb = carCol;`;
}

export function busMaterial() {
  const m = new THREE.MeshStandardMaterial({ roughness: 0.3, metalness: 0.2 });
  m.envMapIntensity = 1.2;
  const body = code();
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uLampOn = { value: 0 }; shader.uniforms.uLampMap = shared.uLampMap;
    Object.assign(shader.uniforms, { uNight: shared.uNight, uCarLamps: CAR_LAMPS.strength, uSunDir: shared.uSunDir, uShadowLift: SHADOW.lift });
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        attribute float partId; attribute vec3 paintColor; attribute vec4 carState; attribute vec2 aWheel; attribute float aHide;
        uniform vec3 uSunDir; uniform float uShadowLift;
        varying vec3 vCarPos; varying vec3 vCarNor; varying float vCarPart; varying vec3 vCarPaint; varying vec4 vCarState; varying vec2 vCarWheel; varying float vHide;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vCarPos = position; vCarNor = normal; vCarPart = partId; vHide = aHide; vCarPaint = paintColor; vCarState = carState; vCarWheel = aWheel;`)
      .replace('#include <shadowmap_vertex>', THREE.ShaderChunk.shadowmap_vertex.replace(
        'shadowWorldPosition = worldPosition + vec4( shadowWorldNormal * directionalLightShadows[ i ].shadowNormalBias, 0 );',
        'shadowWorldPosition = worldPosition + vec4( shadowWorldNormal * directionalLightShadows[ i ].shadowNormalBias + uSunDir * uShadowLift, 0 );'));
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform float uNight; uniform float uCarLamps;
        varying vec3 vCarPos; varying vec3 vCarNor; varying float vCarPart; varying vec3 vCarPaint; varying vec4 vCarState; varying vec2 vCarWheel; varying float vHide;
        ${HELPERS}`)
      .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>
        if (vHide > 0.0 && fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715)))) < vHide) discard;`)
      .replace('#include <color_fragment>', `#include <color_fragment>\n${body}`)
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = carRough;')
      .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\nmetalnessFactor = carMetal;')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += carEmit;')
      .replace('#include <opaque_fragment>', '#include <opaque_fragment>\nif (carGlass > 0.5) gl_FragColor.a = 0.1;');
  };
  m.customProgramCacheKey = () => 'lofted-bus-v1';
  return m;
}
