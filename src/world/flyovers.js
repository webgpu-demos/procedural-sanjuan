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

export async function buildFlyovers(roads, ground, depth = null) { // (roads: roads.json, or its url)
  const { edges } = typeof roads === 'string' ? await (await fetch(roads)).json() : roads;
  const concrete = [0.6, 0.6, 0.58], asphalt = [0.3, 0.3, 0.32], paint = [0.9, 0.9, 0.87], barrier = [0.7, 0.72, 0.72];
  const soup = new Soup();
  const at = (c, l, v) => [c.p[0] + c.n[0] * l, c.p[1] + v, c.p[2] + c.n[2] * l];
  const sweep = (a, b, profile, color) => {
    const pa = typeof profile === 'function' ? profile(a) : profile, pb = typeof profile === 'function' ? profile(b) : profile;
    for (let j = 0; j + 1 < pa.length; j++) soup.quad(at(a, ...pa[j]), at(b, ...pb[j]), at(b, ...pb[j + 1]), at(a, ...pa[j + 1]), color);
  };

  for (const e of edges) {
    if (e.tunnel) continue;
    const expressway = e.highway.startsWith('motorway');
    // Structures are built for flyovers, for the expressway ramps that climb up to them, and (underside
    // only) for street-level spans. Every other road is the ground surface from the tiles, even where its
    // level and the terrain disagree by a little.
    if (!e.flyover && !e.span && !expressway) continue;
    const cs = sections(e.pts, ground);
    if (!cs.some((c) => c.h > (e.flyover || e.span ? RAMP_ABOVE : 1.5))) continue;
    // half width; a street-level span (e.span) also carries the sidewalks, and its surface is the ordinary
    // road polygons draped on the deck, so only the structure is built here
    const lanes = Math.max(1, e.lanes), w = e.span ? lanes * 1.65 + 7 : (lanes * 3.3 + (expressway ? 2.2 : 1.4)) / 2;
    for (let i = 0; i + 1 < cs.length; i++) {
      const a = cs[i], b = cs[i + 1], h = Math.max(a.h, b.h);
      if (h <= RAMP_ABOVE) continue;
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
      // parapets, with a taller noise barrier on the expressway
      const top = expressway ? 1.9 : 1.0;
      for (const s of [-1, 1]) {
        sweep(a, b, [[s * (w - 0.25), 0], [s * (w - 0.25), 0.9], [s * w, 0.9]], concrete);
        if (expressway) sweep(a, b, [[s * (w - 0.1), 0.9], [s * (w - 0.1), top]], barrier);
      }
      if (Math.min(a.h, b.h) > DECK_ABOVE) {
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
