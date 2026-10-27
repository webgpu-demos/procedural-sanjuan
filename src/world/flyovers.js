// Elevated roads: the Shuto expressway, its ramps and ordinary road bridges. Built once for the whole
// area from roads.json, whose points carry the road level (tools/pipeline/roadprofile.mjs).
import * as THREE from 'three';
import { Soup, sections } from './rails.js';

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
export function structureEdges(edges, ground) {
  const at = new Map(), built = new Map(), cs = new Map();
  const sec = (e) => { if (!cs.has(e)) cs.set(e, sections(e.pts, ground)); return cs.get(e); };
  for (const e of edges) {
    if (e.tunnel || e.span || (!e.flyover && !e.grade && !e.highway.startsWith('motorway'))) continue;
    for (const n of [e.a, e.b]) { if (!at.has(n)) at.set(n, []); at.get(n).push(e); }
    const c = sec(e);
    // (a bridge at grade, src/shared/profile.js, whole: the tiles leave its road out)
    if (e.grade || c.some((x) => x.h > (e.flyover ? RAMP_ABOVE : 1.5))) built.set(e, [0, Infinity]);
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

export async function buildFlyovers(roads, ground, depth = null) { // (roads: roads.json, or its url)
  const { edges } = typeof roads === 'string' ? await (await fetch(roads)).json() : roads;
  const concrete = [0.6, 0.6, 0.58], asphalt = [0.3, 0.3, 0.32], paint = [0.9, 0.9, 0.87], barrier = [0.7, 0.72, 0.72];
  const soup = new Soup();
  const at = (c, l, v) => [c.p[0] + c.n[0] * l, c.p[1] + v, c.p[2] + c.n[2] * l];
  const sweep = (a, b, profile, color) => {
    const pa = typeof profile === 'function' ? profile(a) : profile, pb = typeof profile === 'function' ? profile(b) : profile;
    for (let j = 0; j + 1 < pa.length; j++) soup.quad(at(a, ...pa[j]), at(b, ...pb[j]), at(b, ...pb[j + 1]), at(a, ...pa[j + 1]), color);
  };

  const built = structureEdges(edges, ground);
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
    const lanes = Math.max(1, e.lanes || (e.grade && !e.oneway ? 2 : 1));
    const w = e.span ? lanes * 1.65 + 7 : e.grade && !expressway ? lanes * 1.65 + 1.9 : (lanes * 3.3 + (expressway ? 2.2 : 1.4)) / 2;
    // a bridge at grade: its deck flush with the roads at its ends, never under the ground between
    if (e.grade) for (const c of cs) if (c.h < 0.08) { c.p = [c.p[0], c.p[1] + 0.08 - c.h, c.p[2]]; c.h = 0.08; }
    for (let i = 0; i + 1 < cs.length; i++) {
      const a = cs[i], b = cs[i + 1], h = Math.max(a.h, b.h);
      if ((h <= RAMP_ABOVE && !e.grade) || b.s < from || a.s > to) continue;
      if (e.span) {
        // girders seen from the tracks below; the road polygons above are single-sided
        if (Math.min(a.h, b.h) > DECK_ABOVE) sweep(a, b, [[-w, -0.3], [-w, -1.5], [w, -1.5], [w, -0.3]], concrete);
        continue;
      }
      sweep(a, b, [[-w + 0.25, 0], [w - 0.25, 0]], asphalt);
      if (!e.span) {
        // lane paint: solid edges, dashed dividers
        const line = (o) => sweep(a, b, [[o - 0.07, 0.015], [o + 0.07, 0.015]], paint);
        line(-w + 0.75); line(w - 0.75);
        if (Math.floor(a.s / (STEP * 2)) % 2 === 0) for (let k = 1; k < lanes; k++) line(-w + 0.75 + (k * (2 * w - 1.5)) / lanes);
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
  const mesh = soup.mesh(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0.02, side: THREE.DoubleSide }));
  mesh.name = 'flyovers';
  return mesh;
}
