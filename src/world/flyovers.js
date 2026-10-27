// Elevated roads: the Shuto expressway, its ramps and ordinary road bridges. Built once for the whole
// area from roads.json, whose points carry the road level (tools/pipeline/roadprofile.mjs).
import * as THREE from 'three';
import { Soup, sections } from './rails.js';
import { lampUniforms } from './lamplight.js';
import { shared } from './materials.js';

const DECK_ABOVE = 2.0;   // road level this far above the ground gets a deck on piers; lower, a walled ramp
export const RAMP_ABOVE = 0.35; // below this the road is the ordinary ground surface (simtraffic.js drives the same decks)
const PIER_SPACING = 27, STEP = 3;

// depth(x, z): how far inside the lanes of a road at street level (x, z) is (src/shared/roadway.js laneDepth), or
// null: no pier stands in them
// The section at or near cs[i] (up to 4 on either side, nearest first) where a pier of half-size `foot` can stand
// clear of the lanes below, moved `across` the deck if need be: a section-like { p, t, n, h }, or null
export function clearSpot(cs, i, across, high, foot, depth, skip = null) {
  for (const k of [0, 1, -1, 2, -2, 3, -3, 4, -4]) {
    const c = cs[i + k];
    if (!c || c.h <= high) continue;
    for (const l of across) {
      const p = [c.p[0] + c.n[0] * l, c.p[1], c.p[2] + c.n[2] * l];
      if (!depth || depth(p[0], p[2], skip) + foot <= 0) return { ...c, p };
    }
  }
  return null;
}

// The roads a structure is built for (and simtraffic.js drives on), each with the stretch of it, [from, to] in
// metres along it: a bridge at grade, a flyover that stands RAMP_ABOVE off the ground somewhere, an expressway that
// climbs 1.5 m off it somewhere (whole), and from the end of any of them that stands off the ground, the expressway
// beyond it as far as it
// takes to come down to the ground. A structure that ended there, the road beyond on the ground surface, would leave
// a step: cars dropping off its end.
// The roads the tiles leave out of their surfaces (tools/pipeline/roadsurface.mjs: every bridge that is not a span,
// and every flyover; tunnels are not drawn at all)
export const leftOut = (e) => !e.tunnel && !e.span && !!(e.bridge || e.flyover || e.grade);

export function structureEdges(edges, ground) {
  const at = new Map(), built = new Map(), cs = new Map();
  const sec = (e) => { if (!cs.has(e)) cs.set(e, sections(e.pts, ground)); return cs.get(e); };
  for (const e of edges) {
    if (e.tunnel || e.span || (!e.flyover && !e.grade && !e.bridge && !e.highway.startsWith('motorway'))) continue;
    for (const n of [e.a, e.b]) { if (!at.has(n)) at.set(n, []); at.get(n).push(e); }
    const c = sec(e);
    // (a bridge at grade, src/shared/profile.js, whole: the tiles leave its road out)
    // (and every bridge or flyover, however low: the tiles leave them out, so a road not drawn here is a hole)
    if (leftOut(e) || c.some((x) => x.h > (e.flyover ? RAMP_ABOVE : 1.5))) built.set(e, [0, Infinity]);
  }
  const queue = [...built.keys()];
  while (queue.length) {
    const e = queue.pop(), c = sec(e), [from, to] = built.get(e);
    for (const [n, end] of [[e.a, c[0]], [e.b, c.at(-1)]]) {
      if (!end || end.s < from - 0.01 || end.s > to + 0.01 || end.h <= RAMP_ABOVE) continue;
      for (const o of at.get(n) ?? []) {
        if (o === e) continue;
        const oc = sec(o), fromA = o.a === n, L = oc.at(-1)?.s ?? 0, had = built.get(o);
        if (had && had[0] === 0 && had[1] >= L) continue;
        // as far along it as its level stands off the ground, and a step on
        let k = 0;
        while (k < oc.length && oc[fromA ? k : oc.length - 1 - k].h > RAMP_ABOVE) k++;
        const reach = k >= oc.length ? L : oc[fromA ? Math.min(k, oc.length - 1) : Math.max(oc.length - 1 - k, 0)].s;
        let span = fromA ? [0, reach] : [reach, L];
        if (had) span = [Math.min(had[0], span[0]), Math.max(had[1], span[1])];
        built.set(o, span);
        if (k >= oc.length) queue.push(o); // (off the ground all the way: on through its other end)
      }
    }
  }
  return built;
}

// The width the tiles pave a road at (tools/pipeline/roadsurface.mjs, and roadsplit.mjs carriageWidth): its
// carriageway (OSM's width where mapped, else its lanes) and an expressway's shoulders or a street's sidewalks.
// { carriage, half }: the carriageway's whole width, and half the paved width.
const LANE = 3.0, SHOULDER = 1.4;
const SIDEWALK = { trunk: 2.6, primary: 2.6, secondary: 2.3, tertiary: 2.1, unclassified: 1.7, residential: 1.7, living_street: 1.2, service: 0.4 };
export function pavedHalf(e, lanes = e.lanes) {
  const carriage = e.width >= 3 && e.width <= 30 ? e.width : lanes >= 2 ? lanes * LANE + 1 : e.oneway ? 4.2 : 5;
  const hw = e.highway.replace('_link', '');
  return { carriage, half: carriage / 2 + (hw === 'motorway' ? SHOULDER : SIDEWALK[hw] ?? 1.5) };
}

// paving: the tiles' road and paint materials (materials.js): a bridge at grade is paved with them, as the road up to
// it is, so that it reads as the same road and not as a patch of another colour
export async function buildFlyovers(roads, ground, depth = null, paving = null) { // (roads: roads.json, or its url)
  const { edges } = typeof roads === 'string' ? await (await fetch(roads)).json() : roads;
  const concrete = [0.6, 0.6, 0.58], asphalt = [0.3, 0.3, 0.32], paint = [0.9, 0.9, 0.87], barrier = [0.7, 0.72, 0.72], sidewalk = [0.55, 0.55, 0.53];
  const soup = new Soup();
  // the bridges at grade, paved as the tiles pave (meshing.js ROAD_STYLE): carriageway, sidewalk and paint
  const lin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const PAVE = { asphalt: [[0.36, 0.36, 0.38].map(lin), 0, 0.06], sidewalk: [[0.63, 0.61, 0.58].map(lin), 1, 0.2], paint: [[0.9, 0.9, 0.87].map(lin), 3, 0.15] };
  const paved = { road: { position: [], normal: [], color: [], aLayer: [] }, paint: { position: [], normal: [], color: [], aLayer: [] } };
  const pave = (a, b, l0, l1, kind) => { // a strip between offsets l0 and l1 across, from section a to b
    const [color, layer, lift] = PAVE[kind], g = kind === 'paint' ? paved.paint : paved.road;
    const P = [at(a, l0, lift), at(b, l0, lift), at(b, l1, lift), at(a, l0, lift), at(b, l1, lift), at(a, l1, lift)];
    // (wound so that its face is up whichever way the section's normal points)
    const cross = (P[1][0] - P[0][0]) * (P[2][2] - P[0][2]) - (P[1][2] - P[0][2]) * (P[2][0] - P[0][0]);
    const tri = cross > 0 ? [0, 2, 1, 3, 5, 4] : [0, 1, 2, 3, 4, 5];
    for (const k of tri) { g.position.push(...P[k]); g.normal.push(0, 1, 0); g.color.push(...color); g.aLayer.push(layer); }
  };
  const at = (c, l, v) => [c.p[0] + c.n[0] * l, c.p[1] + v, c.p[2] + c.n[2] * l];
  const sweep = (a, b, profile, color) => {
    const pa = typeof profile === 'function' ? profile(a) : profile, pb = typeof profile === 'function' ? profile(b) : profile;
    for (let j = 0; j + 1 < pa.length; j++) soup.quad(at(a, ...pa[j]), at(b, ...pb[j]), at(b, ...pb[j + 1]), at(a, ...pa[j + 1]), color);
  };

  const built = structureEdges(edges, ground);
  // (a bridge is as wide as the road it carries on: OSM often tags the lanes on the road and not on the bridge,
  // which the compiler then gives its class's default, and a five-lane expressway crossed its creek on a two-lane
  // deck, the creek showing either side; so a bridge takes the lanes the road has at both its ends, if more)
  const ends = new Map();
  for (const e of edges) for (const n of [e.a, e.b]) { if (!ends.has(n)) ends.set(n, []); ends.get(n).push(e); }
  const kind = (e) => (e.highway.startsWith('motorway') ? 'motorway' : e.highway.replace('_link', ''));
  const lanesOf = (e) => {
    if (!e.bridge) return e.lanes || null;
    const at = [e.a, e.b].map((n) => Math.max(0, ...ends.get(n).filter((o) => o !== e && !o.bridge && kind(o) === kind(e)).map((o) => o.lanes || 0)));
    const road = at[0] && at[1] ? Math.min(...at) : Math.max(...at);
    return Math.max(e.lanes || 0, road) || null;
  };
  for (const e of edges) {
    if (e.tunnel) continue;
    const expressway = e.highway.startsWith('motorway');
    // Structures are built for flyovers, for the expressway ramps that climb up to them (structureEdges), and
    // (underside only) for street-level spans. Every other road is the ground surface from the tiles, even where
    // its level and the terrain disagree by a little.
    if (!e.span && !built.has(e)) continue;
    const cs = sections(e.pts, ground), [from, to] = built.get(e) ?? [0, Infinity];
    if (e.span && !cs.some((c) => c.h > RAMP_ABOVE)) continue;
    // half width; a street-level span (e.span) also carries the sidewalks, and its surface is the ordinary
    // road polygons draped on the deck, so only the structure is built here
    // (a street's bridge at grade carries its sidewalks too, as the street up to it does)
    const mapped = lanesOf(e), lanes = Math.max(1, mapped || (e.grade && !e.oneway ? 2 : 1));
    // a bridge at grade as wide as the tiles pave the road at its ends, its parapets just outside that
    const width = e.grade ? pavedHalf(e, mapped) : 0;
    const w = e.grade ? width.half + 0.25 : e.span ? lanes * 1.65 + 7 : (lanes * 3.3 + (expressway ? 2.2 : 1.4)) / 2;
    // a bridge at grade: its deck flush with the roads at its ends, never under the ground between
    if (e.grade) for (const c of cs) if (c.h < 0.02) { c.p = [c.p[0], c.p[1] + 0.02 - c.h, c.p[2]]; c.h = 0.02; }
    for (let i = 0; i + 1 < cs.length; i++) {
      const a = cs[i], b = cs[i + 1], h = Math.max(a.h, b.h);
      if ((h <= RAMP_ABOVE && !leftOut(e)) || b.s < from || a.s > to) continue;
      if (e.span) {
        // girders seen from the tracks below; the road polygons above are single-sided
        if (Math.min(a.h, b.h) > DECK_ABOVE) sweep(a, b, [[-w, -0.3], [-w, -1.5], [w, -1.5], [w, -0.3]], concrete);
        continue;
      }
      const line = (o) => sweep(a, b, [[o - 0.07, 0.015], [o + 0.07, 0.015]], paint);
      const dashed = Math.floor(a.s / (STEP * 2)) % 2 === 0;
      if (e.grade && paving) {
        // the carriageway and (a street's) sidewalks, as the tiles pave them either side, in their materials
        const c = width.carriage / 2, side = width.half - c > 0.3 ? 'sidewalk' : 'asphalt';
        pave(a, b, -c, c, 'asphalt');
        for (const s of [-1, 1]) pave(a, b, s * c, s * width.half, side);
        if (side === 'sidewalk') for (const s of [-1, 1]) sweep(a, b, [[s * c, 0.06], [s * c, 0.2]], sidewalk); // (the kerb)
        const mark = (o) => pave(a, b, o - 0.07, o + 0.07, 'paint');
        mark(-c + 0.3); mark(c - 0.3);
        if (expressway && dashed) for (let k = 1; k < lanes; k++) mark(-c + 0.5 + k * LANE);
        else if (!expressway && !e.oneway && dashed) mark(0);
      } else if (e.grade) {
        const c = width.carriage / 2;
        sweep(a, b, [[-c, 0], [c, 0]], asphalt);
        for (const s of [-1, 1]) sweep(a, b, [[s * c, 0], [s * width.half, 0]], width.half - c > 0.3 ? sidewalk : asphalt);
        line(-c + 0.3); line(c - 0.3);
      } else if (paving) {
        // (a flyover's deck in the streets' own asphalt and paint, as the road onto it)
        pave(a, b, -w + 0.25, w - 0.25, 'asphalt');
        const mark = (o) => pave(a, b, o - 0.07, o + 0.07, 'paint');
        mark(-w + 0.75); mark(w - 0.75);
        if (dashed) for (let k = 1; k < lanes; k++) mark(-w + 0.75 + (k * (2 * w - 1.5)) / lanes);
      } else {
        sweep(a, b, [[-w + 0.25, 0], [w - 0.25, 0]], asphalt);
        // lane paint: solid edges, dashed dividers
        line(-w + 0.75); line(w - 0.75);
        if (dashed) for (let k = 1; k < lanes; k++) line(-w + 0.75 + (k * (2 * w - 1.5)) / lanes);
      }
      // parapets, with a taller noise barrier on the expressway's flyovers
      const top = expressway && !e.grade ? 1.9 : 1.0;
      for (const s of [-1, 1]) {
        sweep(a, b, [[s * (w - 0.25), 0], [s * (w - 0.25), 0.9], [s * w, 0.9]], concrete);
        if (top > 1) sweep(a, b, [[s * (w - 0.1), 0.9], [s * (w - 0.1), top]], barrier);
      }
      if (e.grade) {
        // a slab on its abutments: its edge and underside show over the creek or the dip it crosses
        sweep(a, b, [[-w, 0.9], [-w, -0.4], [-w * 0.8, -1.1], [w * 0.8, -1.1], [w, -0.4], [w, 0.9]], concrete);
      } else if (Math.min(a.h, b.h) > DECK_ABOVE) {
        // box girder: outer faces and the underside
        sweep(a, b, [[-w, 0.9], [-w, -0.5], [-w * 0.55, -1.5], [w * 0.55, -1.5], [w, -0.5], [w, 0.9]], concrete);
      } else {
        // ramp on fill between retaining walls
        sweep(a, b, (c) => [[-w, 0.9], [-w, -Math.max(c.h, 0) - 0.4]], concrete);
        sweep(a, b, (c) => [[w, -Math.max(c.h, 0) - 0.4], [w, 0.9]], concrete);
      }
    }
    // piers every 27 m where the deck stands high, each at the nearest place clear of the lanes of the roads
    // under it (along the deck, or across it: a median, a sidewalk); none where there is no such place near
    const slot = Math.round(PIER_SPACING / STEP), pw = Math.min(1.5, w * 0.4);
    for (let i = 0; i < cs.length; i++) {
      if (e.span || Math.round(cs[i].s / STEP) % slot !== 1 || cs[i].h <= DECK_ABOVE + 1.5) continue;
      const spot = clearSpot(cs, i, [0, 0.45 * w, -0.45 * w, 0.8 * w - pw / 2, -(0.8 * w - pw / 2)], DECK_ABOVE + 1.5, 1.0, depth, e.way);
      if (spot) soup.box(spot.p, spot.t, spot.n, 1.1, pw, spot.p[1] - spot.h - 1.5, spot.p[1] - 1.5, concrete);
    }
  }
  for (let i = 0; i < soup.col.length; i += 3) {
    const c = new THREE.Color().setRGB(soup.col[i], soup.col[i + 1], soup.col[i + 2], THREE.SRGBColorSpace);
    soup.col[i] = c.r; soup.col[i + 1] = c.g; soup.col[i + 2] = c.b;
  }
  const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0.02, side: THREE.DoubleSide });
  // (at night, beyond the lamp light map round what the view looks at, a deck keeps the faint sodium of its
  // street lamps, as the distant ground's streets do: from the air the flyovers were black ribbons laid over the
  // lit expressway)
  material.onBeforeCompile = (shader) => {
    lampUniforms(shader);
    shader.uniforms.uNight = shared.uNight; shader.uniforms.uGrid = shared.uGrid;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vDeckW;\nvarying float vDeckUp;')
      .replace('#include <project_vertex>', '#include <project_vertex>\nvDeckW = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvDeckUp = normalize(mat3(modelMatrix) * objectNormal).y;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vDeckW;\nvarying float vDeckUp;\nuniform float uNight;\nuniform vec4 uGrid;')
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        {
          vec2 lu = vec2(vDeckW.x - uLampRect.x, uLampRect.y - vDeckW.z) / (2.0 * uLampRect.z) + 0.5;
          vec2 le = smoothstep(vec2(0.0), vec2(0.08), lu) * (1.0 - smoothstep(vec2(0.92), vec2(1.0), lu));
          float power = uGrid.z < 0.0 ? 1.0 : mix(1.0, 0.12, 1.0 - smoothstep(uGrid.z - uGrid.w, uGrid.z, distance(vDeckW.xz, uGrid.xy)));
          totalEmissiveRadiance += (1.0 - le.x * le.y) * 0.2 * vec3(1.0, 0.6, 0.28) * uNight * power * smoothstep(0.5, 0.8, abs(vDeckUp)) * step(0.01, uLampOn);
        }`);
  };
  material.customProgramCacheKey = () => 'flyovers-v2';
  const mesh = soup.mesh(material);
  mesh.name = 'flyovers';
  for (const [g, m, name] of [[paved.road, paving?.road, 'bridge decks'], [paved.paint, paving?.paint, 'bridge deck paint']]) {
    if (!m || !g.position.length) continue;
    const geo = new THREE.BufferGeometry();
    for (const [k, n] of [['position', 3], ['normal', 3], ['color', 3], ['aLayer', 1]]) geo.setAttribute(k, new THREE.Float32BufferAttribute(g[k], n));
    const deck = new THREE.Mesh(geo, m);
    deck.receiveShadow = true; deck.name = name;
    mesh.add(deck);
  }
  return mesh;
}
