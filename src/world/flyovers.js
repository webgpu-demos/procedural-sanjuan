// Elevated roads: the Shuto expressway, its ramps and ordinary road bridges. Built once for the whole
// area from roads.json, whose points carry the road level (tools/pipeline/roadprofile.mjs).
import * as THREE from 'three';
import { Soup, sections } from './rails.js';
import { lampUniforms } from './lamplight.js';
import { shared } from './materials.js';
import { pavedHalf, roadLanes, paintOf } from '../shared/roadway.js';

export { pavedHalf, roadLanes, paintOf };

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

// Where a deck meets a road the tiles drape on the ground, it meets it at the ground. The road's level there (the
// simulation's, roads.json) can stand some decimetres off the terrain, and a deck that started at it stood up out
// of the street as a step across the lanes: on PR-22 at the Quebrada Margarita, 0.3 m, right under the opening's
// ride. Mismatches within 1.5 m are landed (more is a cutting, or a structure the terrain has in it: left as they
// are); the deck eases back to its own level over 15 m. Run after correctProfiles, before anything uses the
// levels (the decks, the simulated cars). Returns the number of ends landed.
export function landDecks(roads, ground, reach = 15, most = 1.5) {
  const onGround = new Set();
  for (const e of roads.edges) if (!leftOut(e) && !e.tunnel) { onGround.add(e.a); onGround.add(e.b); }
  let landed = 0;
  for (const e of roads.edges) {
    if (!leftOut(e)) continue;
    const p = e.pts, n = p.length / 3, cum = [0];
    if (n < 2) continue;
    for (let k = 1; k < n; k++) cum.push(cum[k - 1] + Math.hypot(p[k * 3] - p[k * 3 - 3], p[k * 3 + 2] - p[k * 3 - 1]));
    const total = cum[n - 1], L = Math.min(reach, total * 0.5);
    for (const [k0, node] of [[0, e.a], [n - 1, e.b]]) {
      if (!onGround.has(node) || L <= 0) continue;
      const d = ground(p[k0 * 3], p[k0 * 3 + 2]) - p[k0 * 3 + 1];
      if (Math.abs(d) < 0.02 || Math.abs(d) > most) continue;
      e.pts0 ??= Array.from({ length: n }, (_, k) => p[k * 3 + 1]); // (the levels the simulation drove)
      for (let k = 0; k < n; k++) { const s = k0 === 0 ? cum[k] : total - cum[k]; if (s < L) p[k * 3 + 1] += d * (1 - s / L); }
      landed++;
    }
  }
  return landed;
}

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

// What would stand up through a deck: a tree, a pole, a street lamp or a signal on the ground under one, taller than
// the room under it (a palm on the avenue beneath PR-22 grew out of the expressway's lanes). footprints: a
// flyovers mesh's userData.footprints; deck(x, z) gives the deck's level over (x, z) by the sections it was drawn
// with. Returns (kind, x, z, scale) => true for such a prop.
const TALL = { tree: 12, pole: 9.5, light: 10.5, signal: 7 };
export function overDecks(footprints, PROP) {
  const CELL = 32, grid = new Map();
  footprints.forEach((f, i) => {
    const r = f[4] + 4;
    for (let x = Math.floor((Math.min(f[0], f[2]) - r) / CELL); x <= Math.floor((Math.max(f[0], f[2]) + r) / CELL); x++)
      for (let z = Math.floor((Math.min(f[1], f[3]) - r) / CELL); z <= Math.floor((Math.max(f[1], f[3]) + r) / CELL); z++) {
        const k = x + ',' + z; if (!grid.has(k)) grid.set(k, []); grid.get(k).push(i);
      }
  });
  const height = { [PROP.TREE]: TALL.tree, [PROP.POLE]: TALL.pole, [PROP.LIGHT]: TALL.light, [PROP.SIGNAL]: TALL.signal };
  return (kind, x, z, scale) => {
    const tall = height[kind];
    if (!tall) return false;
    const top = tall * (kind === PROP.TREE ? Math.max(0.6, scale) : 1), reach = kind === PROP.TREE ? 3 * Math.max(0.6, scale) : 0.5;
    for (const i of grid.get(Math.floor(x / CELL) + ',' + Math.floor(z / CELL)) ?? []) {
      const [x0, z0, x1, z1, w, deck, ground] = footprints[i], dx = x1 - x0, dz = z1 - z0, l2 = dx * dx + dz * dz || 1;
      const t = Math.max(0, Math.min(1, ((x - x0) * dx + (z - z0) * dz) / l2));
      if (Math.hypot(x0 + dx * t - x, z0 + dz * t - z) > w + reach) continue;
      if (top > deck - 1.6 - ground) return true; // (under the girder's depth)
    }
    return false;
  };
}

// paving: the tiles' road and paint materials (materials.js): a bridge at grade is paved with them, as the road up to
// it is, so that it reads as the same road and not as a patch of another colour
export async function buildFlyovers(roads, ground, depth = null, paving = null) { // (roads: roads.json, or its url)
  const { edges } = typeof roads === 'string' ? await (await fetch(roads)).json() : roads;
  const concrete = [0.6, 0.6, 0.58], asphalt = [0.3, 0.3, 0.32], paint = [0.9, 0.9, 0.87], barrier = [0.7, 0.72, 0.72], sidewalk = [0.55, 0.55, 0.53];
  const soup = new Soup();
  const footprints = []; // [x0, z0, x1, z1, half width, the deck's level, the ground's under it] of every deck drawn
  // the bridges at grade, paved as the tiles pave (meshing.js ROAD_STYLE): carriageway, sidewalk and paint
  const lin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const PAVE = { asphalt: [[0.36, 0.36, 0.38].map(lin), 0, 0.06], sidewalk: [[0.63, 0.61, 0.58].map(lin), 1, 0.2], paint: [[0.9, 0.9, 0.87].map(lin), 3, 0.15],
    yellow: [[0.88, 0.66, 0.12].map(lin), 3, 0.15] };
  const paved = { road: { position: [], normal: [], color: [], aLayer: [] }, paint: { position: [], normal: [], color: [], aLayer: [] } };
  const pave = (a, b, l0, l1, kind) => { // a strip between offsets l0 and l1 across, from section a to b
    const [color, layer, lift] = PAVE[kind], g = kind === 'paint' || kind === 'yellow' ? paved.paint : paved.road;
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
  const lanesOf = roadLanes(edges);
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
    // a deck as wide as the tiles pave the road onto it, its parapets just outside that; painted as they paint it
    const width = pavedHalf(e, mapped), lines = paintOf(e, lanes, width);
    const w = e.span ? lanes * 1.65 + 7 : width.half + 0.25;
    // a bridge at grade: its deck flush with the roads at its ends, never under the ground between
    if (e.grade) for (const c of cs) if (c.h < 0.02) { c.p = [c.p[0], c.p[1] + 0.02 - c.h, c.p[2]]; c.h = 0.02; }
    for (let i = 0; i + 1 < cs.length; i++) {
      const a = cs[i], b = cs[i + 1], h = Math.max(a.h, b.h);
      if ((h <= RAMP_ABOVE && !leftOut(e)) || b.s < from || a.s > to) continue;
      if (!e.span) footprints.push([a.p[0], a.p[2], b.p[0], b.p[2], w, Math.min(a.p[1], b.p[1]), Math.min(a.p[1] - a.h, b.p[1] - b.h)]);
      if (e.span) {
        // girders seen from the tracks below; the road polygons above are single-sided
        if (Math.min(a.h, b.h) > DECK_ABOVE) sweep(a, b, [[-w, -0.3], [-w, -1.5], [w, -1.5], [w, -0.3]], concrete);
        continue;
      }
      // (dashes 5 m on, 5 m off, as markings.mjs paints them)
      const dashed = Math.floor(a.s / 5) % 2 === 0;
      const c = width.carriage / 2, side = width.half - c > 0.3 && !expressway ? 'sidewalk' : 'asphalt';
      if (paving) {
        // the carriageway and (a street's) sidewalks, as the tiles pave them either side, in their materials
        pave(a, b, -c, c, 'asphalt');
        for (const s of [-1, 1]) pave(a, b, s * c, s * width.half, side);
        if (side === 'sidewalk') for (const s of [-1, 1]) sweep(a, b, [[s * c, 0.06], [s * c, 0.2]], sidewalk); // (the kerb)
        for (const l of lines) if (!l.dashed || dashed) pave(a, b, l.o - 0.075, l.o + 0.075, l.yellow ? 'yellow' : 'paint');
      } else {
        sweep(a, b, [[-c, 0], [c, 0]], asphalt);
        for (const s of [-1, 1]) sweep(a, b, [[s * c, 0], [s * width.half, 0]], side === 'sidewalk' ? sidewalk : asphalt);
        for (const l of lines) if (!l.dashed || dashed) sweep(a, b, [[l.o - 0.075, 0.015], [l.o + 0.075, 0.015]], l.yellow ? [0.88, 0.66, 0.12] : paint);
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
          float power = uGrid.z < 0.0 ? 1.0 : mix(1.0, 0.0, 1.0 - smoothstep(uGrid.z - uGrid.w, uGrid.z, distance(vDeckW.xz, uGrid.xy)));
          totalEmissiveRadiance += (1.0 - le.x * le.y) * 0.2 * vec3(1.0, 0.6, 0.28) * uNight * power * smoothstep(0.5, 0.8, abs(vDeckUp)) * step(0.01, uLampOn);
        }`);
  };
  // The expressway's lane lines through its merges and forks. The tiles paint lanes as wide as the carriageway is
  // (markings.mjs), and where a ramp joins or leaves it the paving is wider than its lanes: there they painted
  // nothing, and the opening's ride crossed forty metres of bare asphalt on PR-22. The lanes go on through, about
  // the painted centre either side (lanes.json); the line on the ramp's side is dashed, as at a merge.
  const table = roads.lanes?.edges, SAMPLE = roads.lanes?.step ?? 2.5;
  if (table && paving) for (const [i, t] of Object.entries(table)) {
    const e = edges[i], c = t.c, median = t.lanes * t.lw;
    let samples = null;
    for (let k = 1; k < c.length; k++) {
      if (c[k] != null || c[k - 1] == null) continue;
      let j = k; while (j < c.length && c[j] == null) j++;
      if (j >= c.length) break; // (unpainted to the end: a junction)
      if (t.why && !/^w+$/.test(t.why.slice(k, j))) { k = j; continue; } // (only where it is paved wider: not off the paving)
      if (!samples) { // (as lanetable.mjs and markings.mjs sample it: every 2.5 m from 1.25 m, the normal to the right of travel)
        samples = [];
        let next = SAMPLE / 2, walked = 0;
        for (let q = 3; q < e.pts.length; q += 3) {
          const ax = e.pts[q - 3], az = e.pts[q - 1], bx = e.pts[q], bz = e.pts[q + 2], len = Math.hypot(bx - ax, bz - az);
          if (len < 1e-6) continue;
          for (; next <= walked + len; next += SAMPLE) { const f = (next - walked) / len; samples.push([ax + (bx - ax) * f, az + (bz - az) * f, (bx - ax) / len, (bz - az) / len]); }
          walked += len;
        }
      }
      const a = k - 1, ca = c[a], cb = c[j];
      const section = (n) => {
        const [x, z, dx, dz] = samples[n], off = ca + ((cb - ca) * (n - a)) / (j - a);
        return { x: x - dz * off, z: z + dx * off, nx: -dz, nz: dx };
      };
      // (a line o metres right of the centre, each corner on the ground the tiles drape there)
      const line = (s0, s1, o, kind) => {
        const [color, layer, lift] = PAVE[kind], g = paved.paint;
        const P = [[s0, o - 0.075], [s1, o - 0.075], [s1, o + 0.075], [s0, o + 0.075]].map(([s, l]) => { const x = s.x + s.nx * l, z = s.z + s.nz * l; return [x, ground(x, z) + lift, z]; });
        const cross = (P[1][0] - P[0][0]) * (P[2][2] - P[0][2]) - (P[1][2] - P[0][2]) * (P[2][0] - P[0][0]);
        for (const k of cross > 0 ? [0, 2, 1, 0, 3, 2] : [0, 1, 2, 0, 2, 3]) { g.position.push(...P[k]); g.normal.push(0, 1, 0); g.color.push(...color); g.aLayer.push(layer); }
      };
      for (let n = a; n < j && n + 1 < samples.length; n++) {
        const s0 = section(n), s1 = section(n + 1), gap = Math.floor(n / 2) % 2, edge = median / 2 - 0.35;
        for (let m = 1; m < t.lanes; m++) if (!gap) line(s0, s1, -median / 2 + m * t.lw, 'paint');
        if (e.highway === 'motorway' || e.highway === 'trunk') line(s0, s1, -edge, 'yellow');
        if (!gap) line(s0, s1, edge, 'paint');
      }
      k = j;
    }
  }

  material.customProgramCacheKey = () => 'flyovers-v2';
  const mesh = soup.mesh(material);
  mesh.name = 'flyovers';
  mesh.userData.footprints = footprints;
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
