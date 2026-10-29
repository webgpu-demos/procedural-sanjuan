// The material of the lofted car bodies (carbodies.js): one MeshStandardMaterial per body type that paints every
// detail from the object-space position and normal, after mrdoob's TSL car material in slop-newyork (js/cars.js,
// MIT), written out here as GLSL for WebGLRenderer. Glass outlines (side windows in side view, windshield and
// backlight from above) are convex polygons as signed distances; seals, pillars, door seams, handles, headlamps (a
// projector, a DRL bar, a turn segment), tail lamps (an LED bar, the turn and reverse sections), grille mesh, intakes,
// exhausts and plates are rounded boxes and bands. Every edge is filtered over the screen footprint across it (the
// per-axis fwidth of the position, weighted by the edge's direction), so lines stay crisp but never alias, and fine
// periodic patterns fade to their mean below a pixel.
// Per instance: paintColor (vec3) and carState (vec4: brake, left (+x) and right (-x) turn signals, the style code of
// carStyleCode: livery, metallic, trim, wheel), aWheel (vec2: the wheels' turn so far, radians, and a blur 0..1 as
// they spin faster than the eye can follow), aHide (the dissolve, traffic.js). A fixed colour (the car you drive)
// takes uniforms instead.
import * as THREE from 'three';
import { carLayout, taxiSignPlacement, polygonPlanes, CAR_PARTS } from './carbodies.js';
import { shared } from './materials.js';
import { lampUniforms, HERO_RIM } from './lamplight.js';
import { SHADOW } from './people.js';

// a float literal, a colour as linear RGB (hex colours are sRGB, as three's)
const f = (x) => { const s = Number(x).toFixed(5); return s.includes('.') ? s : `${s}.0`; };
const c = (hex) => { const k = new THREE.Color(hex); return `vec3(${f(k.r)}, ${f(k.g)}, ${f(k.b)})`; };

const HELPERS = /* glsl */`
float ss(float a, float b, float x) { float t = clamp((x - a) / (b - a), 0.0, 1.0); return t * t * (3.0 - 2.0 * t); }
float cov(float d, float w) { return ss(w * 0.5, -w * 0.5, d); }
float band(float d, float h, float w) { return clamp((min(d + h, w * 0.5) - max(d - h, -w * 0.5)) / w, 0.0, 1.0); }
vec2 rrectEdge(vec2 pt, vec2 hs, float rad, vec2 fw2) { vec2 q = abs(pt) - hs + rad; return vec2(length(max(q, vec2(0.0))) + min(max(q.x, q.y), 0.0) - rad, mix(fw2.y, fw2.x, step(q.y, q.x))); }
float rrect(vec2 pt, vec2 hs, float rad, vec2 fw2) { vec2 e = rrectEdge(pt, hs, rad, fw2); return cov(e.x, e.y); }
float maxEdgeW(float a, float b, float wa, float wb) { return mix(wa, wb, step(a, b)); }
float minEdgeW(float a, float b, float wa, float wb) { return mix(wa, wb, step(b, a)); }
float smax(float a, float b, float k) { float h = max(k - abs(a - b), 0.0) / k; return max(a, b) + h * h * k * 0.25; }
float fadeFine(float w) { return ss(0.018, 0.005, w); }
float fadeMed(float w) { return ss(0.042, 0.012, w); }
vec3 alloyColor(vec2 wv, float rN, float fwRing, float fwSpoke, float blackout, float wheelCode, float spin, float blur) {
  float wAngle = atan(wv.y, wv.x) + spin;
  float inSpokeZone = ss(0.14, 0.18, rN) * ss(0.63, 0.59, rN);
  float spokeVal;
  if (abs(wheelCode - 2.0) < 0.25) { float fork = mix(0.62, 0.22, ss(0.34, 0.56, rN)); spokeVal = ss(0.26, 0.1, abs(cos(wAngle * 7.0) - fork)); }
  else if (abs(wheelCode - 1.0) < 0.25) spokeVal = ss(0.32, 0.62, cos(wAngle * 10.0 + rN * 2.2));
  else { float c5 = abs(cos(wAngle * 5.0)); spokeVal = ss(0.54, 0.68, c5) * (1.0 - ss(0.86, 0.94, c5) * ss(0.24, 0.34, rN)); }
  float sharp = fadeMed(fwSpoke) * (1.0 - blur);
  float spokes = mix(0.55, spokeVal, sharp) * inSpokeZone;
  float rimRing = ss(0.59, 0.62, rN) * ss(0.695, 0.675, rN);
  float centerHub = ss(0.2, 0.16, rN);
  float lugHoles = ss(0.145, 0.115, rN) * ss(0.08, 0.105, rN) * ss(0.4, 0.7, cos(wAngle * 5.0)) * fadeMed(max(fwRing, fwSpoke)) * (1.0 - blur);
  float centerCap = ss(0.075, 0.055, rN);
  float alloyMetal = clamp(max(spokes, max(rimRing, centerHub)) - max(lugHoles * 0.85, centerCap * 0.75), 0.0, 1.0);
  float brakeDisc = ss(0.2, 0.24, rN) * ss(0.5, 0.46, rN) * (1.0 - alloyMetal);
  float brakeCaliper = brakeDisc * ss(0.15, 0.25, wv.x) * ss(0.05, 0.15, wv.y);
  vec3 wheelFinish = mix(${c(0xd8e0e8)}, ${c(0x4a5058)}, max(blackout, step(abs(wheelCode - 3.0), 0.25)));
  vec3 rotorCol = mix(mix(${c(0x0c0f13)}, ${c(0x3e444b)}, brakeDisc), ${c(0x8a1c20)}, brakeCaliper);
  return mix(rotorCol, wheelFinish, alloyMetal);
}
vec3 tyreColor(float rN, float fwRing) {
  float rib = ss(0.018, 0.004, abs(rN - 0.8)) * 0.06 * ss(0.018, 0.005, fwRing);
  return ${c(0x17191c)} * (ss(0.88, 0.96, rN) * -0.14 + 0.92 + rib);
}`;

// The signed distance (approximate outside, exact inside) to a convex polygon given as outward half-planes, and the
// screen footprint across its nearest edge: <id>D, <id>W
function polygon(id, planes, k, u, v, fu, fv) {
  let s = '';
  planes.forEach(([nx, ny, cc], i) => {
    const e = `(${u} * ${f(nx)} + ${v} * ${f(ny)} - ${f(cc)})`, we = `(${fu} * ${f(Math.abs(nx))} + ${fv} * ${f(Math.abs(ny))})`;
    s += i === 0
      ? `float ${id}D = ${e}; float ${id}W = ${we}; float ${id}N = ${id}D;\n`
      : `{ float e = ${e}; float we = ${we}; ${id}D = smax(${id}D, e, ${f(k)}); ${id}W = mix(${id}W, we, step(${id}N, e)); ${id}N = max(${id}N, e); }\n`;
  });
  return s;
}

// Puerto Rico's plates, four of them in one small atlas (rows): white, the island's name across the top in blue and
// three letters and three digits; with mipmaps, for the traffic far off
let plates = null;
function plateTexture() {
  if (plates) return plates;
  const canvas = document.createElement('canvas');
  canvas.width = 128; canvas.height = 256;
  const ctx = canvas.getContext('2d');
  ['JKM-428', 'HTR-831', 'IXL-250', 'GBN-716'].forEach((label, row) => {
    const y0 = row * 64;
    const g = ctx.createLinearGradient(0, y0, 0, y0 + 64);
    g.addColorStop(0, '#f4f6f8'); g.addColorStop(1, '#d8e2ec');
    ctx.fillStyle = g; ctx.fillRect(0, y0, 128, 64);
    ctx.fillStyle = '#c8202a'; ctx.fillRect(0, y0 + 58, 128, 6);
    ctx.fillStyle = '#1d3f8a'; ctx.font = 'italic bold 11px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('Puerto Rico', 64, y0 + 9);
    ctx.fillStyle = '#152a55'; ctx.font = 'bold 23px monospace';
    ctx.fillText(label, 64, y0 + 36);
  });
  plates = new THREE.CanvasTexture(canvas);
  plates.colorSpace = THREE.SRGBColorSpace;
  plates.anisotropy = 8;
  return plates;
}

// The masks and colours for one body spec, as the fragment code that sets carCol, carRough, carMetal, carEmit and
// carGlass (0..1, for the reflection pass's mark)
function paintCode(spec) {
  const L = carLayout(spec), cab = spec.cabin;
  const bc = L.belt.cowl, bd = L.belt.deck;
  const glassEndZ = cab.glassEnd ?? cab.deck;
  const bEndY = L.body(glassEndZ).yE - 0.004;
  const rearEdgeMargin = cab.glassEnd !== undefined ? 0.034 : 0.065;
  const rf = L.rail.front, rm = L.rail.mid, rr = L.rail.rear;
  const sidePlanes = polygonPlanes([[cab.cowl, bc.y], [cab.roofFront, rf.y], [L.rail.roofMid, rm.y], [cab.roofRear, rr.y], [glassEndZ, bEndY]], [0.048, 0.028, 0.028, rearEdgeMargin, 0.02]);
  const frontPlanes = polygonPlanes([[-1, cab.cowl], [-1, cab.roofFront], [rf.x, cab.roofFront], [bc.x, cab.cowl]], [0, 0.042, 0.058, 0.048]);
  const rearPlanes = polygonPlanes([[-1, cab.roofRear], [-1, cab.deck], [bd.x, cab.deck], [rr.x, cab.roofRear]], [0, 0.045, 0.062, 0.048]);
  const [hlX, hlY, hlW, hlH] = spec.headlight, [tlX, tlY, tlW, tlH] = spec.taillight;
  const [grY, grW, grH] = spec.grille, [inY, inW, inH] = spec.intake, [plateF, plateR] = spec.plates;
  const frontZone = spec.zFront - 0.58, rearZone = spec.zRear + 0.58, sillY = spec.sill[1][1], rearSill = spec.tail.sill[1];
  const doorMid = (spec.doors[0] + spec.doors[1]) / 2, trunkBot = Math.min(spec.bumperLine[1], plateR - 0.115);
  const signY = spec.sign ? taxiSignPlacement(spec).y + 0.105 : 0;
  const archR = L.archR;

  // the glass: side windows, windshield, backlight, and the seal round them
  const windowGlass = `
    ${polygon('sg', sidePlanes, 0.065, 'p.z', 'p.y', 'fwZ', 'fwY')}
    float dSideG = sgD, wSideG = sgW;
    ${[...cab.pillars.map((zp) => [zp, 0.038]), ...(cab.pillars.length === 1 ? [[cab.roofRear - 0.04, 0.014]] : [])].map(([zp, hw]) =>
    `{ float e = ${f(hw)} - abs(p.z - ${f(zp)}); wSideG = maxEdgeW(dSideG, e, wSideG, fwZ); dSideG = max(dSideG, e); }`).join('\n')}
    ${polygon('fg', frontPlanes, 0.085, 'ax', 'p.z', 'fwX', 'fwZ')}
    float sideGlass = cov(dSideG, wSideG), frontGlass = cov(fgD, fgW);
    ${spec.cargo ? 'float rearGlass = 0.0;' : `${polygon('rg', rearPlanes, 0.085, 'ax', 'p.z', 'fwX', 'fwZ')}\n    float rearGlass = cov(rgD, rgW);`}
    float glass = max(max(sideGlass, frontGlass), rearGlass);
    float dSeal = sgD, wSeal = sgW;
    wSeal = minEdgeW(dSeal, fgD, wSeal, fgW); dSeal = min(dSeal, fgD);
    ${spec.cargo ? '' : 'wSeal = minEdgeW(dSeal, rgD, wSeal, rgW); dSeal = min(dSeal, rgD);'}
    float seal = cov(dSeal - 0.016, wSeal);`;

  const headlamps = `
    vec2 hlUV = vec2(ax - ${f(hlX)}, p.y - ${f(hlY)} - (ax - ${f(hlX)}) * 0.032);
    float headlight = rrect(hlUV, vec2(${f(hlW)}, ${f(hlH)}), 0.014, fwXY) * ss(0.02, 0.25, n.z);
    float turnFront = ss(${f(hlW * 0.76)}, ${f(hlW * 0.83)}, hlUV.x) * headlight;
    float hlLit = headlight * (1.0 - turnFront);
    vec2 projUV = vec2(abs(hlUV.x + ${f(hlW * 0.09)}) - ${f(hlW * 0.25)}, hlUV.y - ${f(hlH * 0.08)});
    vec2 proj = rrectEdge(projUV, vec2(${f(hlW * 0.165)}, ${f(hlH * 0.44)}), 0.009, fwXY);
    float drlH = max(abs(hlUV.y + ${f(hlH * 0.6)}), max(hlUV.x - ${f(hlW * 0.67)}, ${f(-hlW * 0.82)} - hlUV.x));
    float drlV = max(abs(hlUV.x - ${f(hlW * 0.67)}), max(hlUV.y - ${f(hlH * 0.48)}, ${f(-hlH * 0.6)} - hlUV.y));
    float projBucket = cov(proj.x - 0.008, proj.y) * hlLit, projRing = cov(proj.x - 0.002, proj.y) * hlLit, headlightLens = cov(proj.x + 0.004, proj.y) * hlLit;
    float drl = cov(min(drlH, drlV) - 0.0045, minEdgeW(drlH, drlV, fwY, fwX)) * hlLit;`;

  const taillamps = `
    vec2 tlUV = vec2(ax - ${f(tlX)}, p.y - ${f(tlY)});
    vec2 tail = rrectEdge(tlUV, vec2(${f(tlW * 1.04)}, ${f(tlH * 1.2)}), 0.018, fwXY);
    float taillight = cov(tail.x, tail.y) * ss(0.02, 0.25, -n.z);
    float lowerStrip = ss(${f(-tlH * 0.12)}, ${f(-tlH * 0.24)}, tlUV.y);
    float tailLens = cov(tail.x + 0.0045, tail.y) * taillight;
    float turnRearSection = lowerStrip * ss(0.0, ${f(tlW * 0.08)}, tlUV.x);
    float reverseRearSection = lowerStrip * ss(${f(tlW * 0.04)}, ${f(-tlW * 0.04)}, tlUV.x);
    float ledBarMask = max(band(tlUV.y - ${f(tlH * 0.36)}, 0.0085, fwY), band(tlUV.y + ${f(tlH * 0.02)}, 0.0085, fwY));`;

  const chmsl = spec.barnDoors
    ? `rrect(vec2(p.x, p.y - ${f(spec.barnDoors[1] + 0.055)}), vec2(0.16, 0.015), 0.005, fwXY) * ss(-0.15, -0.45, n.z) * ss(${f(rearZone + 0.05)}, ${f(rearZone - 0.05)}, p.z)`
    : `rrect(vec2(p.x, p.z - ${f(cab.roofRear - 0.075)}), vec2(0.16, 0.011), 0.005, fwXZ) * rearGlass * ss(-0.05, -0.2, n.z)`;

  let trunkSeam;
  if (spec.barnDoors) {
    const [barnW] = spec.barnDoors;
    trunkSeam = `float barnSide = ax - ${f(barnW)}, barnBottom = ${f(trunkBot)} - p.y;
      float barnOutline = band(max(barnSide, barnBottom), 0.0035, maxEdgeW(barnBottom, barnSide, fwY, fwX));
      float barnSplit = band(p.x, 0.0045, fwX) * cov(barnBottom, fwY);
      float trunkSeam = max(barnOutline, barnSplit) * rear * (1.0 - platePocket);`;
  } else {
    trunkSeam = `float trunkWidth = mix(${f(tlX - tlW - 0.025)}, ${f(tlX)}, ss(${f(tlY - tlH)}, ${f(spec.tail.edge[1])}, p.y));
      float trunkSide = ax - trunkWidth, trunkBottom = ${f(trunkBot)} - p.y;
      float trunkSeam = band(max(trunkSide, trunkBottom), 0.003, maxEdgeW(trunkBottom, trunkSide, fwY, fwX)) * rear * (1.0 - platePocket);`;
  }
  const tailgateHandle = spec.bedCover
    ? `rrect(vec2(p.x, p.y - ${f(tlY + tlH * 0.42)}), vec2(0.085, 0.016), 0.005, fwXY) * rear`
    : spec.barnDoors ? 'rrect(vec2(p.x + 0.072, p.y - 1.04), vec2(0.013, 0.056), 0.005, fwXY) * rear' : '0.0';

  let handles = `float hDistZ = abs(p.z - ${f(spec.handles[0])});`;
  for (let i = 1; i < spec.handles.length; i++) handles += ` hDistZ = min(hDistZ, abs(p.z - ${f(spec.handles[i])}));`;

  const slide = spec.slidingDoor;
  const sideDoors = `
      float frontOfSlide = ${slide ? `ss(${f(slide[0] + 0.02)}, ${f(slide[0] + 0.06)}, p.z)` : '1.0'};
      float sideDoorMask = ${slide ? 'max(frontOfSlide, step(p.x, 0.0))' : '1.0'};
      float topDoorFade = ${slide ? 'mix(1.0, ss(0.0, -0.015, p.y - belt), frontOfSlide)' : 'ss(0.0, -0.015, p.y - belt)'};
      float onDoors = isSide * ss(${f(sillY + 0.04)}, ${f(sillY + 0.07)}, p.y) * topDoorFade * sideDoorMask;
      float seams = 0.0;
      ${spec.doors.map((zd) => `seams = max(seams, band(p.z - ${f(zd)}, 0.0035, fwZ));`).join(' ')}
      ${handles}
      vec2 hUV = vec2(hDistZ, p.y - (belt - 0.092));
      vec2 handle = rrectEdge(hUV, vec2(0.066, 0.0085), 0.005, fwZY);
      float handleBar = cov(handle.x, handle.y) * onDoors;
      vec2 pocket = rrectEdge(vec2(hDistZ, hUV.y + 0.002), vec2(0.028, 0.015), 0.009, fwZY);
      float handlePocket = cov(pocket.x - 0.004, pocket.y) * (1.0 - handleBar) * onDoors;
      bCol *= (1.0 - seams * onDoors * 0.58) * (1.0 - handlePocket * 0.68);
      bCol = mix(bCol, mix(bCol * 1.12, ${c(0xd8dfe6)}, hasChrome * 0.75), handleBar);
      ${slide ? `bCol = mix(bCol, ${c(0x121519)}, rrect(vec2(p.z - ${f(slide[1] - 0.42)}, p.y - (belt - 0.048)), vec2(0.42, 0.009), 0.004, fwZY) * step(p.x, 0.0) * isSide);` : ''}`;

  // roof paint over the glasshouse loft (the van's cargo box is part of it): two-tone roof, the van's doors
  let roofExtra = '';
  if (slide) {
    const [sdFront, sdRear, sdTop] = slide, mid = (sdFront + sdRear) * 0.5, half = (sdFront - sdRear) * 0.5;
    roofExtra += `{ float slideSide = abs(p.z - ${f(mid)}) - ${f(half)}, slideTop = p.y - ${f(sdTop)};
        float slideSeamW = band(max(slideSide, slideTop), 0.0035, maxEdgeW(slideTop, slideSide, fwY, fwZ)) * step(p.x, -0.2) * isSide;
        float panelRibW = band(p.z + 1.98, 0.0035, fwZ) * cov(slideTop, fwY) * isSide * 0.55;
        roofPaint *= 1.0 - max(slideSeamW, panelRibW) * 0.58; }`;
  }
  if (spec.barnDoors) {
    const [barnW, barnTop] = spec.barnDoors;
    roofExtra += `{ float rearWall = ss(-0.15, -0.45, n.z) * ss(${f(rearZone + 0.05)}, ${f(rearZone - 0.05)}, p.z);
        float barnSide = ax - ${f(barnW)}, barnTopD = p.y - ${f(barnTop)};
        float barnOutlineW = band(max(barnSide, barnTopD), 0.0035, maxEdgeW(barnTopD, barnSide, fwY, fwX));
        float barnSplitW = band(p.x, 0.0045, fwX) * cov(barnTopD, fwY);
        float barnHinge = rrect(vec2(ax - ${f(barnW)}, abs(p.y - 1.78) - 0.34), vec2(0.022, 0.03), 0.005, fwXY) * rearWall;
        roofPaint = mix(roofPaint * (1.0 - max(barnOutlineW, barnSplitW) * rearWall * 0.58), ${c(0x14171b)}, barnHinge); }`;
  }

  return /* glsl */`
  vec3 p = vCarPos, n = normalize(vCarNor);
  float partId = vCarPart;
  float isBody = step(abs(partId - ${f(CAR_PARTS.BODY)}), 0.25), isWindow = step(abs(partId - ${f(CAR_PARTS.WINDOW)}), 0.25);
  float isTyre = step(abs(partId - ${f(CAR_PARTS.TYRE)}), 0.25), isAlloy = step(abs(partId - ${f(CAR_PARTS.ALLOY)}), 0.25);
  float isMirror = step(abs(partId - ${f(CAR_PARTS.MIRROR)}), 0.25), isSign = step(abs(partId - ${f(CAR_PARTS.SIGN)}), 0.25);
  float ax = abs(p.x);
  float isSide = ss(0.45, 0.7, abs(n.x));
  float belt = mix(${f(bd.y)}, ${f(bc.y)}, clamp((p.z - ${f(cab.deck)}) / ${f(cab.cowl - cab.deck)}, 0.0, 1.0));
  vec3 nView = normalize(vNormal) * (gl_FrontFacing ? 1.0 : -1.0);
  float ndv = clamp(dot(nView, normalize(vViewPosition)), 0.0, 1.0), fresnel = pow(1.0 - ndv, 3.2);
  // the footprint of the position on the screen, per axis (outside every branch: derivatives need uniform control)
  vec3 fwp = max(fwidth(p), vec3(0.0005));
  float fwX = fwp.x, fwY = fwp.y, fwZ = fwp.z;
  vec2 fwXY = vec2(fwX, fwY), fwXZ = vec2(fwX, fwZ), fwZY = vec2(fwZ, fwY);
  float livery = vCarStyle.x, isMetallic = vCarStyle.y, trimCode = vCarStyle.z, wheelCode = vCarStyle.w;
  float isTwoTone = max(step(abs(livery - 4.0), 0.25), step(abs(trimCode - 3.0), 0.25));
  float isBlackout = step(abs(trimCode - 2.0), 0.25);
  float hasChrome = max(${spec.chrome ? '1.0' : '0.0'}, step(abs(trimCode - 1.0), 0.25)) * (1.0 - isBlackout);
  // the wheels: the distance from the nearest axle in side view (signed along the car: the pattern turns one way)
  vec2 wheelVec = vec2(p.z - sign(p.z) * ${f(spec.wheelZ)}, p.y - ${f(spec.wheelRadius)});
  float wheelDist = length(wheelVec), rNorm = wheelDist / ${f(spec.wheelRadius)};
  vec2 wheelDir = wheelVec / max(wheelDist, 0.0001);
  float fwRing = abs(wheelDir.x) * fwZ + abs(wheelDir.y) * fwY, fwSpoke = abs(wheelDir.y) * fwZ + abs(wheelDir.x) * fwY;
  float proxyAlloy = isTyre * cov((rNorm - 0.6) * ${f(spec.wheelRadius)}, fwRing) * ss(0.68, 0.82, abs(n.x));
  float isAlloyFace = max(isAlloy, proxyAlloy), isTyreRubber = isTyre - proxyAlloy;
  vec3 paint = vCarPaint;
  float paintLuma = dot(paint, vec3(0.299, 0.587, 0.114));
  vec3 basePaint = paint * mix(0.98, 0.84, ss(0.6, 0.92, paintLuma)) * mix(1.0, ndv * 0.22 + 0.82, isMetallic);
  float archLip = ss(${f(archR + 0.05)}, ${f(archR - 0.005)}, wheelDist) * ss(0.6, 0.9, ax);
  float ao = (ss(0.22, 0.66, p.y) * 0.2 + 0.8) * (1.0 - archLip * 0.55);
  // the plate (sampled outside the branches, for its mipmaps)
  float plateVariant = floor(fract(paint.r * 7.0 + paint.g * 13.0 + paint.b * 17.0) * 4.0);
  float isFrontSide = ss(-0.02, 0.02, n.z);
  float plateSignX = mix(-0.31, 0.31, isFrontSide), plateCenterY = mix(${f(plateR)}, ${f(plateF)}, isFrontSide);
  vec2 plateUV = vec2(clamp(p.x / plateSignX + 0.5, 0.02, 0.98), (clamp((p.y - plateCenterY) / 0.115 + 0.5, 0.06, 0.94) + plateVariant) / 4.0);
  vec3 plateCol = texture2D(uPlates, vec2(plateUV.x, 1.0 - plateUV.y)).rgb;
  float brake = vCarState.x;
  float blink = max(vCarState.y * step(0.0, p.x), vCarState.z * step(p.x, 0.0));
  float nightLamp = ss(0.15, 0.75, uNight);
  float paintRough = mix(0.11, 0.16, isMetallic), paintMetal = mix(0.32, 0.42, isMetallic) + fresnel * 0.14;

  vec3 carCol = ${c(0x181b1f)}, carEmit = vec3(0.0);
  float carRough = 0.78, carMetal = 0.04, carGlass = 0.0;
  if (isBody > 0.5) {
    vec3 bCol = basePaint * ao;
    ${spec.cladding > 0 ? `bCol = mix(bCol, ${c(0x1d2024)}, max(ss(${f(spec.cladding + 0.01)}, ${f(spec.cladding - 0.01)}, p.y), ss(${f(archR + 0.068)}, ${f(archR + 0.052)}, wheelDist)));` : ''}
    ${spec.bedCover ? `bCol = mix(bCol, ${c(0x16191d)}, cov(p.z - ${f(cab.deck - 0.01)}, fwZ) * cov(${f(spec.zRear + 0.08)} - p.z, fwZ) * ss(0.68, 0.85, n.y) * cov(ax - 0.88, fwX));` : ''}
    bCol = mix(bCol, ${c(0x2d2b28)}, ss(${f(sillY + 0.16)}, ${f(sillY - 0.01)}, p.y) * 0.2);
    if (isSide > 0.05) {
      ${sideDoors}
    }
    if (p.z > ${f(frontZone)} && n.z > 0.02) {
      // the face: headlamps, the grille's mesh, the lower intake, air curtains, the front plate
      float front = ss(0.12, 0.38, n.z);
      bCol *= 1.0 - band(p.y - ${f(spec.bumperLine[0])}, 0.0035, fwY) * cov(ax - ${f(hlX - hlW * 0.5)}, fwX) * front * 0.52;
      vec2 g = rrectEdge(vec2(p.x, p.y - ${f(grY)}), vec2(${f(grW)}, ${f(grH)}), 0.015, fwXY);
      float grille = cov(g.x, g.y) * front, grilleOuter = cov(g.x - 0.013, g.y) * front;
      float grilleWing = band(p.y - ${f(grY + grH * 0.12)}, 0.0045, fwY) * grille;
      float grilleFrame = max(grilleOuter - grille, grilleWing * 0.75);
      float emblemFront = rrect(vec2(p.x, p.y - ${f(grY + grH * 0.12)}), vec2(0.032, 0.015), 0.008, fwXY) * grille;
      float intake = rrect(vec2(p.x, p.y - ${f(inY)}), vec2(${f(inW)}, ${f(inH)}), 0.032, fwXY) * front;
      float airCurtain = rrect(vec2(ax - ${f(hlX + hlW * 0.42)}, p.y - ${f(inY + 0.03)}), vec2(0.042, ${f(inH * 0.85)}), 0.014, fwXY) * front;
      float meshWave = ss(-0.1, 0.35, sin((p.x + p.y) * 110.0) * sin((p.x - p.y) * 110.0));
      float meshPattern = mix(0.68, meshWave * 0.38 + 0.52, fadeFine(max(fwX, fwY)));
      float intakeSlats = mix(0.72, ss(0.3, 0.6, fract(p.y * 52.0)) * 0.35 + 0.55, fadeFine(fwY));
      bCol = mix(bCol, mix(${c(0x181b20)}, ${c(0xd2d8de)}, hasChrome), grilleFrame);
      bCol = mix(bCol, ${c(0x101317)} * meshPattern, grille * (1.0 - grilleWing));
      bCol = mix(bCol, ${c(0xd4dbe2)}, emblemFront);
      bCol = mix(bCol, ${c(0x0f1216)} * intakeSlats, max(intake, airCurtain));
      ${headlamps}
      vec3 lampBezel = mix(mix(${c(0x13171d)}, ${c(0x4a535e)}, projBucket), ${c(0x9ea8b2)}, projRing * 0.78);
      vec3 lampColor = mix(mix(lampBezel, ${c(0xf4f8ff)}, headlightLens), vec3(1.0), drl);
      bCol = mix(bCol, mix(lampColor, ${c(0xb85e16)}, turnFront), headlight);
      vec2 fp = rrectEdge(vec2(p.x, p.y - ${f(plateF)}), vec2(0.155, 0.055), 0.008, fwXY);
      bCol = mix(bCol, ${c(0x1e2227)}, cov(fp.x - 0.015, fp.y) * front);
      bCol = mix(bCol, plateCol, cov(fp.x, fp.y) * front);
      carEmit = ${c(0xfff8ec)} * (headlightLens * (nightLamp * 3.0 + 0.3) * uLampsOn + drl * (nightLamp * 1.2 + 0.9)) * (1.0 - max(turnFront, drl) * blink) * uCarLamps
        + ${c(0xff9812)} * max(turnFront, drl * 0.75) * blink * 2.4;
    } else if (p.z < ${f(rearZone)} && n.z < -0.02) {
      // the tail: wrap-round lamps, the trunk's shut line, a plate in its pocket, the valance, the exhausts
      float rear = ss(0.12, 0.38, -n.z);
      vec2 rp = rrectEdge(vec2(p.x, p.y - ${f(plateR)}), vec2(0.155, 0.06), 0.008, fwXY);
      float platePocket = rrect(vec2(p.x, p.y - ${f(plateR + 0.01)}), vec2(0.24, 0.105), 0.03, fwXY) * rear;
      ${trunkSeam}
      bCol *= 1.0 - trunkSeam * 0.56;
      bCol = mix(bCol, bCol * (ss(${f(plateR - 0.09)}, ${f(plateR + 0.115)}, p.y) * -0.25 + 0.9), platePocket);
      ${taillamps}
      float tailgateHandle = ${tailgateHandle};
      float ledBar = ledBarMask * tailLens * (1.0 - max(turnRearSection, reverseRearSection));
      float tailFacet = ss(${f(-tlH)}, ${f(tlH)}, tlUV.y) * 0.28 + 0.78;
      vec3 tailRuby = mix(${c(0x981018)} * tailFacet, ${c(0xff2834)}, ledBar);
      vec3 tailColor = mix(mix(tailRuby, ${c(0xf07818)}, turnRearSection), ${c(0xe4edf4)}, reverseRearSection);
      float rearValance = ss(${f(rearSill + 0.075)}, ${f(rearSill + 0.02)}, p.y) * rear;
      vec2 ex = rrectEdge(vec2(ax - 0.5, p.y - ${f(rearSill + 0.036)}), vec2(0.052, 0.017), 0.008, fwXY);
      float exhaustRim = cov(ex.x, ex.y) * rearValance, exhaustBore = cov(ex.x + 0.006, ex.y) * rearValance;
      float reflector = rrect(vec2(ax - 0.65, p.y - ${f(spec.bumpers[1][0] + 0.04)}), vec2(0.075, 0.01), 0.004, fwXY) * rear;
      float emblemRear = ${spec.barnDoors ? '0.0' : `rrect(vec2(p.x, p.y - ${f(tlY - tlH * 0.12)}), vec2(0.022, 0.01), 0.009, fwXY) * rear`};
      bCol = mix(bCol, ${c(0x14171b)}, max(rearValance, tailgateHandle));
      bCol = mix(mix(bCol, ${c(0x828a92)}, exhaustRim), ${c(0x060709)}, exhaustBore);
      bCol = mix(bCol, ${c(0x8a0c14)}, reflector);
      bCol = mix(bCol, ${c(0x16090c)}, taillight);
      bCol = mix(bCol, tailColor, tailLens);
      bCol = mix(bCol, ${c(0xb8c0c8)}, emblemRear);
      bCol = mix(bCol, ${c(0x1e2227)}, cov(rp.x - 0.02, rp.y) * rear);
      bCol = mix(bCol, plateCol, cov(rp.x, rp.y) * rear);
      float redArea = tailLens * (1.0 - max(turnRearSection, reverseRearSection));
      float redLens = max(redArea * 0.58, ledBarMask * redArea);
      carEmit = ${c(0xff0c16)} * redLens * (brake * 2.3 + nightLamp * 0.9 * uLampsOn + 0.12) * uCarLamps
        + ${c(0xff9812)} * turnRearSection * tailLens * blink * 2.4
        + ${c(0xf0f6ff)} * tailLens * reverseRearSection * uReverse * 1.8;
    }
    carCol = mix(bCol, ${c(0x0c0e11)}, ss(-0.25, -0.55, n.y));
    carRough = paintRough + ss(${f(sillY + 0.1)}, ${f(sillY - 0.01)}, p.y) * 0.16;
    carMetal = paintMetal;
  } else if (isWindow > 0.5) {
    ${windowGlass}
    float beltStrip = band(p.y - (belt + 0.01), 0.007, fwY) * ss(0.5, 0.7, abs(n.x)) * cov(${f(glassEndZ + 0.03)} - p.z, fwZ) * cov(p.z - ${f(cab.cowl - 0.07)}, fwZ);
    float chmsl = ${chmsl};
    float rearWiper = ${spec.rearWiper ? `rrect(vec2(p.x + 0.15, p.z - ${f(cab.deck + 0.075)}), vec2(0.22, 0.006), 0.003, fwXZ) * rearGlass` : '0.0'};
    vec3 glassCol = mix(${c(0x0a1016)}, ${c(0x1a2632)}, max(ss(0.2, 0.9, n.y), fresnel * 0.55));
    vec3 roofPaint = mix(basePaint * ao, ${c(0x111418)}, isTwoTone * cov(${f(rf.y - 0.04)} - p.y, fwY));
    ${roofExtra}
    vec3 wCol = mix(mix(mix(mix(roofPaint, ${c(0x111315)}, max(seal, beltStrip)), glassCol, glass), ${c(0xd2d8de)}, beltStrip * hasChrome), ${c(0x6a0a0e)}, chmsl);
    carCol = mix(wCol, ${c(0x14171a)}, rearWiper);
    carRough = mix(mix(paintRough, 0.78, seal), 0.08, glass);
    carMetal = mix(mix(paintMetal, 0.04, seal), mix(0.16, 0.36, fresnel), glass);
    carEmit = ${c(0xff0c16)} * chmsl * brake * 2.3 * uCarLamps;
    carGlass = glass;
  } else if (isAlloyFace > 0.5) {
    carCol = alloyColor(wheelVec, rNorm, fwRing, fwSpoke, isBlackout, wheelCode, vCarWheel.x, vCarWheel.y);
    carRough = 0.22; carMetal = 0.84;
  } else if (isTyreRubber > 0.5) {
    carCol = tyreColor(rNorm, fwRing);
  } else if (isMirror > 0.5) {
    float mirrorGlass = ss(0.45, 0.65, -n.z);
    float mirrorTurn = ss(0.05, 0.2, n.z) * band(p.y - ${f(bc.y + 0.082)}, 0.006, fwY) * cov(0.88 - ax, fwX);
    carCol = mix(mix(mix(basePaint, ${c(0x121519)}, max(isTwoTone, isBlackout)), ${c(0x8896a2)}, mirrorGlass), ${c(0x98a4ae)}, mirrorTurn);
    carRough = 0.12; carMetal = mix(paintMetal, 0.65, mirrorGlass);
    carEmit = ${c(0xff9812)} * mirrorTurn * blink * 2.0;
  }${spec.sign ? ` else if (isSign > 0.5) {
    float signFace = ss(0.55, 0.75, abs(n.z));
    float signGlyph = ss(0.25, 0.58, sin(p.x * 90.0)) * band(p.x, 0.17, fwX) * band(p.y - ${f(signY)}, 0.042, fwY) * fadeFine(fwX);
    carCol = mix(${c(0xf3efe2)}, mix(${c(0xfff1b8)}, ${c(0x15181b)}, signGlyph), signFace);
    carRough = 0.35;
    carEmit = ${c(0xffe28a)} * signFace * (1.0 - signGlyph * 0.9) * (0.4 + nightLamp * 1.25);
  }` : ''}
  diffuseColor.rgb = carCol;`;
}

/**
 * The material for one body spec. instanced: per-instance paint and state; else `fixed` paint (hex) and the
 * uniforms userData.carState / userData.wheel. hero: the car you drive (clear-coated paint, the street lamps on it).
 */
export function loftedCarMaterial(spec, { fixed = null, hero = false } = {}) {
  const m = hero
    ? new THREE.MeshPhysicalMaterial({ roughness: 0.3, metalness: 0.3, clearcoat: 1, clearcoatRoughness: 0.05 })
    : new THREE.MeshStandardMaterial({ roughness: 0.3, metalness: 0.3 });
  m.envMapIntensity = 1.35;
  const instanced = fixed == null;
  const state = { carState: { value: new THREE.Vector4(0, 0, 0, 0) }, wheel: { value: new THREE.Vector2(0, 0) }, paint: { value: new THREE.Color(fixed ?? 0xffffff) }, reverse: { value: 0 } };
  m.userData = state;
  const code = paintCode(spec);
  m.onBeforeCompile = (shader) => {
    if (hero) lampUniforms(shader); else { shader.uniforms.uLampOn = { value: 0 }; shader.uniforms.uLampMap = shared.uLampMap; }
    Object.assign(shader.uniforms, {
      uNight: shared.uNight, uPlates: { value: plateTexture() }, uCarLamps: CAR_LAMPS.strength, uLampsOn: CAR_LAMPS.on, uReverse: state.reverse,
      uCarState: state.carState, uCarWheel: state.wheel, uCarPaint: state.paint, uSunDir: shared.uSunDir, uShadowLift: SHADOW.lift,
    });
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        attribute float partId;
        ${instanced ? 'attribute vec3 paintColor; attribute vec4 carState; attribute vec2 aWheel;' : 'uniform vec4 uCarState; uniform vec2 uCarWheel; uniform vec3 uCarPaint;'}
        attribute float aHide;
        uniform vec3 uSunDir; uniform float uShadowLift;
        varying vec3 vCarPos; varying vec3 vCarNor; varying float vCarPart; varying vec3 vCarPaint; varying vec4 vCarState; varying vec4 vCarStyle; varying vec2 vCarWheel; varying float vHide;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vCarPos = position; vCarNor = normal; vCarPart = partId; vHide = aHide;
        ${instanced ? 'vCarPaint = paintColor; vCarState = carState; vCarWheel = aWheel;' : 'vCarPaint = uCarPaint; vCarState = uCarState; vCarWheel = uCarWheel;'}
        { int code = int(vCarState.w + 0.5); vCarStyle = vec4(float(code & 7), float((code >> 3) & 1), float((code >> 4) & 3), float((code >> 6) & 3)); }`)
      .replace('#include <shadowmap_vertex>', SHADOW_LIFT);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform float uNight; uniform sampler2D uPlates; uniform float uCarLamps; uniform float uLampsOn; uniform float uReverse;
        varying vec3 vCarPos; varying vec3 vCarNor; varying float vCarPart; varying vec3 vCarPaint; varying vec4 vCarState; varying vec4 vCarStyle; varying vec2 vCarWheel; varying float vHide;
        ${HELPERS}`)
      .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>
        if (vHide > 0.0 && fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715)))) < vHide) discard;`)
      .replace('#include <color_fragment>', `#include <color_fragment>\n${code}`)
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = carRough;')
      .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\nmetalnessFactor = carMetal;')
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>\ntotalEmissiveRadiance += carEmit;${hero ? `\nif (isBody > 0.5) totalEmissiveRadiance += ${HERO_RIM};` : ''}`)
      // (the windows are marked in alpha for the reflection pass, like those of the buildings)
      .replace('#include <opaque_fragment>', '#include <opaque_fragment>\nif (carGlass > 0.5) gl_FragColor.a = 0.1;');
  };
  if (hero) m.defines = { ...m.defines, LAMP_SIDES: '' };
  m.customProgramCacheKey = () => `lofted-car-${spec.name}-${instanced ? 'i' : 'f'}${hero ? 'h' : ''}-v1`;
  return m;
}

// the receiver's side of the shadows' offsets (people.js): a car does not shade itself
const SHADOW_LIFT = THREE.ShaderChunk.shadowmap_vertex.replace(
  'shadowWorldPosition = worldPosition + vec4( shadowWorldNormal * directionalLightShadows[ i ].shadowNormalBias, 0 );',
  'shadowWorldPosition = worldPosition + vec4( shadowWorldNormal * directionalLightShadows[ i ].shadowNormalBias + uSunDir * uShadowLift, 0 );');

// The depth pass: a car stands nearer the sun by SHADOW.push (the sun's depth bias is most of a car's height; people.js)
// and dissolves as it does
export function carDepth() {
  const m = new THREE.MeshDepthMaterial();
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, { uShadowPush: SHADOW.push, uShadowRange: SHADOW.range });
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aHide;\nvarying float vHide;\nuniform float uShadowPush, uShadowRange;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvHide = aHide;')
      .replace('#include <project_vertex>', '#include <project_vertex>\ngl_Position.z -= 2.0 * uShadowPush / uShadowRange * gl_Position.w;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vHide;')
      .replace('#include <clipping_planes_fragment>', '#include <clipping_planes_fragment>\nif (vHide > 0.0 && fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715)))) < vHide) discard;');
  };
  m.customProgramCacheKey = () => 'lofted-car-depth-v1';
  return m;
}

// The lamps' strength (the panel's) and whether they are on (dusk to dawn: the headlamps' and the tail lamps' glow)
export const CAR_LAMPS = { strength: { value: 1 }, on: { value: 1 } };

// The soft shadow under a car (a footprint of rounded-box darkening, deeper under the tyres): what grounds it where the
// sun's shadow is faint or the sun is down. A quad in the car's own frame, sized to its body: an instanced mesh that
// shares the car's matrices.
export function contactShadowGeometry(spec) {
  const hw = Math.max(...spec.halfWidth.map((q) => q[1])) + spec.archFlare, w = 2 * hw + 0.33, l = spec.zFront - spec.zRear + 0.55, zc = (spec.zFront + spec.zRear) / 2;
  return new THREE.PlaneGeometry(w, l).rotateX(-Math.PI / 2).translate(0, 0.035, zc);
}
let shadowMat = null;
export function contactShadowMaterial() {
  if (shadowMat) return shadowMat;
  shadowMat = new THREE.MeshBasicMaterial({ color: 0x020305, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  shadowMat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aHide;\nvarying float vHide;\nvarying vec2 vQuad;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvHide = aHide; vQuad = uv;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vHide;\nvarying vec2 vQuad;\nfloat ss(float a, float b, float x) { float t = clamp((x - a) / (b - a), 0.0, 1.0); return t * t * (3.0 - 2.0 * t); }')
      .replace('#include <alphamap_fragment>', `#include <alphamap_fragment>
        vec2 q2 = abs((vQuad - 0.5) * 2.0);
        vec2 qq = q2 - vec2(0.64, 0.70);
        float dq = length(max(qq, vec2(0.0))) + min(max(qq.x, qq.y), 0.0);
        float chassisAO = ss(0.30, -0.14, dq), coreAO = ss(0.76, 0.12, q2.x) * ss(0.82, 0.16, q2.y);
        float wheelPatch = ss(0.22, 0.0, length((q2 - vec2(0.68, 0.56)) * vec2(1.4, 1.0)));
        diffuseColor.a *= clamp(chassisAO * 0.72 + coreAO * 0.18 + wheelPatch * 0.18, 0.0, 0.88) * (1.0 - vHide);`);
  };
  shadowMat.customProgramCacheKey = () => 'car-contact-shadow-v1';
  return shadowMat;
}
