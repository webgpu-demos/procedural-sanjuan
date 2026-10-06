// The landmarks of the old city, built from their OSM outlines into each tile's static mesh (x_<x>_<z>.bin,
// drawn with materials.models):
//   forts     every fortification (El Morro, San Cristóbal, their bastions, San Gerónimo): stepped tiers of
//             battered sandstone walls, parapets with embrasures, a garita on each salient corner
//   garitas   the domed sentry boxes; a fortification too small to be a fort (La Garita del Diablo) is one
//   domes     on buildings OSM gives a dome roof (the Capitol's rotunda): a drum, a colonnade if large, the
//             dome and a lantern
//   lighthouses  on OSM's man_made=lighthouse (the Faro de El Morro)
//   cathedral the crossing dome and the bell gable of San Juan Bautista
//   convention  the Puerto Rico Convention Center's wave roof over its curved glass front
// Geometry is a list of triangles in world metres with an sRGB colour each; encodeMesh writes the format the
// tile worker reads (src/world/tileWorker.js models()). The worker takes a triangle's normal from its winding, and
// shadows are looked up along that normal, so every surface here is wound to face out (tops up, walls outwards).
import earcut from 'earcut';
import polygonClipping from 'polygon-clipping';

// sRGB colours
const SANDSTONE = [0.78, 0.68, 0.5], SANDSTONE_DARK = [0.6, 0.52, 0.38], SANDSTONE_LIGHT = [0.84, 0.75, 0.57];
const TERREPLEIN = [0.62, 0.57, 0.48], GARITA = [0.84, 0.71, 0.5], GARITA_DOME = [0.88, 0.78, 0.6];
const MARBLE = [0.93, 0.92, 0.88], MARBLE_SHADE = [0.86, 0.85, 0.81], DARK = [0.18, 0.17, 0.16], CREAM = [0.94, 0.9, 0.8];
const TRIM = [0.85, 0.79, 0.66], GLASS = [0.3, 0.42, 0.47], ROOF_METAL = [0.8, 0.82, 0.83], SOFFIT = [0.93, 0.93, 0.91], MULLION = [0.84, 0.85, 0.85];

export class Tris {
  constructor() { this.pos = []; this.col = []; }
  tri(a, b, c, rgb) { this.pos.push(...a, ...b, ...c); for (let i = 0; i < 3; i++) this.col.push(...rgb); }
  quad(a, b, c, d, rgb) { this.tri(a, b, c, rgb); this.tri(a, c, d, rgb); }
  // a horizontal(ish) triangle facing up (or down: up = false)
  flat(a, b, c, rgb, up = true) {
    const ny = (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]);
    if ((ny > 0) === up) this.tri(a, b, c, rgb); else this.tri(a, c, b, rgb);
  }
  get count() { return this.pos.length / 9; }
}

// u32 vertex count | f32 positions | u8 sRGB colours
export function encodeMesh(t) {
  const n = t.pos.length / 3, buf = Buffer.alloc(4 + n * 12 + n * 3);
  buf.writeUInt32LE(n, 0);
  Buffer.from(new Float32Array(t.pos).buffer).copy(buf, 4);
  for (let i = 0; i < n * 3; i++) buf[4 + n * 12 + i] = Math.round(Math.min(1, Math.max(0, t.col[i])) * 255);
  return buf;
}

// ---------------------------------------------------------------- shapes
// a ring of `seg` points of radius r around (cx, cz) at height y
const circle = (cx, cz, y, r, seg, phase = 0) => Array.from({ length: seg }, (_, k) => {
  const a = phase + (k / seg) * Math.PI * 2;
  return [cx + Math.cos(a) * r, y, cz + Math.sin(a) * r];
});
// the side of a truncated cone (or cylinder) from radius r0 at y0 to r1 at y1, and a cap on top
function cylinder(t, cx, cz, y0, y1, r0, r1, rgb, seg = 12, cap = true) {
  const lo = circle(cx, cz, y0, r0, seg), hi = circle(cx, cz, y1, r1, seg);
  for (let k = 0; k < seg; k++) { const j = (k + 1) % seg; t.quad(lo[k], hi[k], hi[j], lo[j], rgb); }
  if (cap) for (let k = 0; k < seg; k++) t.tri([cx, y1, cz], hi[(k + 1) % seg], hi[k], rgb);
}
// a dome (half an ellipsoid) of radius r rising `rise` above y
function dome(t, cx, cz, y, r, rise, rgb, seg = 18, rings = 7) {
  let prev = circle(cx, cz, y, r, seg);
  for (let i = 1; i <= rings; i++) {
    const a = (i / rings) * (Math.PI / 2), cur = circle(cx, cz, y + Math.sin(a) * rise, Math.cos(a) * r, seg);
    for (let k = 0; k < seg; k++) { const j = (k + 1) % seg; t.quad(prev[k], cur[k], cur[j], prev[j], rgb); }
    prev = cur;
  }
}
// a box between y0 and y1 over the quad of corners [[x, z] x 4]
function prism(t, corners, y0, y1, rgb, top = true) {
  if (ringArea(corners) < 0) corners = [...corners].reverse(); // counter-clockwise: walls out, top up
  for (let k = 0; k < 4; k++) { const [ax, az] = corners[k], [bx, bz] = corners[(k + 1) % 4]; t.quad([ax, y0, az], [bx, y0, bz], [bx, y1, bz], [ax, y1, az], rgb); }
  if (top) t.quad(...corners.map(([x, z]) => [x, y1, z]), rgb);
}
// a box centred at (cx, cz), half sizes (hu along (ux, uz), hv across), between y0 and y1
const box = (t, cx, cz, ux, uz, hu, hv, y0, y1, rgb, top = true) => prism(t, [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) => [cx + ux * hu * a - uz * hv * b, cz + uz * hu * a + ux * hv * b]), y0, y1, rgb, top);

// The garita of San Juan: a corbelled cylinder with a dome and a finial, standing at (x, z) on y.
export function garita(t, x, z, y, k = 1) {
  cylinder(t, x, z, y - 1.0 * k, y, 0.35 * k, 1.05 * k, SANDSTONE, 10, false); // corbel, under the parapet line
  cylinder(t, x, z, y, y + 2.3 * k, 1.0 * k, 1.0 * k, GARITA, 10, false);
  cylinder(t, x, z, y + 2.3 * k, y + 2.5 * k, 1.12 * k, 1.12 * k, SANDSTONE_LIGHT, 10, true); // cornice
  dome(t, x, z, y + 2.5 * k, 1.05 * k, 1.05 * k, GARITA_DOME, 10, 4);
  cylinder(t, x, z, y + 3.5 * k, y + 4.0 * k, 0.12 * k, 0.02 * k, SANDSTONE_LIGHT, 6, false); // finial
  // the slits that look out over the sea
  for (let s = 0; s < 3; s++) { const a = s * 2.1, ox = Math.cos(a) * 1.01 * k, oz = Math.sin(a) * 1.01 * k; box(t, x + ox, z + oz, -Math.sin(a), Math.cos(a), 0.08 * k, 0.02 * k, y + 0.9 * k, y + 1.7 * k, DARK); }
}

// ---------------------------------------------------------------- polygons
export const ringArea = (r) => { let s = 0; for (let i = 0; i < r.length; i++) { const [x1, z1] = r[i], [x2, z2] = r[(i + 1) % r.length]; s += x2 * z1 - x1 * z2; } return s / 2; };
const close = (r) => [...r, r[0]];
// Douglas-Peucker on a closed ring
export function simplify(ring, tol) {
  if (ring.length < 6) return ring;
  const dp = (pts) => {
    if (pts.length < 3) return pts;
    const [ax, az] = pts[0], [bx, bz] = pts.at(-1), len = Math.hypot(bx - ax, bz - az) || 1e-9;
    let far = 0, at = 0;
    for (let i = 1; i < pts.length - 1; i++) { const d = Math.abs((bx - ax) * (az - pts[i][1]) - (ax - pts[i][0]) * (bz - az)) / len; if (d > far) { far = d; at = i; } }
    return far <= tol ? [pts[0], pts.at(-1)] : [...dp(pts.slice(0, at + 1)).slice(0, -1), ...dp(pts.slice(at))];
  };
  const out = dp([...ring, ring[0]]).slice(0, -1);
  return out.length >= 3 ? out : ring;
}
// The ring shrunk by d: what is left of it once a band of width d along its edges is taken away (robust where
// a plain offset would cross itself). Returns the outer rings of the pieces, counter-clockwise.
function inset(ring, d) {
  if (d <= 0) return [ring];
  const band = [];
  for (let i = 0; i < ring.length; i++) {
    const [ax, az] = ring[i], [bx, bz] = ring[(i + 1) % ring.length], len = Math.hypot(bx - ax, bz - az);
    band.push([close(Array.from({ length: 8 }, (_, k) => [ax + Math.cos((k + 0.5) * Math.PI / 4) * d * 1.08, az + Math.sin((k + 0.5) * Math.PI / 4) * d * 1.08]))]);
    if (len < 0.01) continue;
    const nx = (-(bz - az) / len) * d, nz = ((bx - ax) / len) * d;
    band.push([close([[ax - nx, az - nz], [bx - nx, bz - nz], [bx + nx, bz + nz], [ax + nx, az + nz]])]);
  }
  try {
    const left = polygonClipping.difference([close(ring)], polygonClipping.union(...band));
    return left.map((p) => p[0].slice(0, -1)).filter((r) => r.length >= 3).map((r) => (ringArea(r) > 0 ? r : [...r].reverse()));
  } catch { return []; }
}
// per vertex of a counter-clockwise ring: the unit direction into the polygon and how far it may move (miter, clamped)
function inward(ring) {
  const n = ring.length;
  return ring.map((p, i) => {
    const a = ring[(i + n - 1) % n], b = ring[(i + 1) % n];
    const e1 = [p[0] - a[0], p[1] - a[1]], e2 = [b[0] - p[0], b[1] - p[1]], l1 = Math.hypot(...e1) || 1, l2 = Math.hypot(...e2) || 1;
    // inward normals of a counter-clockwise ring: (dz, -dx) per edge (outward is (-dz, dx), see meshing.js)
    const n1 = [e1[1] / l1, -e1[0] / l1], n2 = [e2[1] / l2, -e2[0] / l2];
    let mx = n1[0] + n2[0], mz = n1[1] + n2[1];
    const ml = Math.hypot(mx, mz) || 1; mx /= ml; mz /= ml;
    const cos = mx * n1[0] + mz * n1[1];
    return { dx: mx, dz: mz, k: Math.min(2, 1 / Math.max(cos, 0.3)), room: 0.4 * Math.min(l1, l2), convex: e1[0] * e2[1] - e1[1] * e2[0] < 0 };
  });
}

// ---------------------------------------------------------------- forts
// ring: the outline (world, counter-clockwise); ground(x, z); spots: the garitas placed so far ([x, z], added
// to), which keep new ones 25 m apart. Returns { tris, top, pieces }: top = height of the upper tier, pieces =
// [{ ring, y }] the terrepleins.
const SPACING = 25;
const free = (spots, x, z) => spots.every(([sx, sz]) => Math.hypot(sx - x, sz - z) >= SPACING);
export function fort(ring, ground, t = new Tris(), spots = []) {
  const outline = simplify(ring, 0.8), area = Math.abs(ringArea(outline));
  if (area < 40) { // a lone garita
    const cx = outline.reduce((s, p) => s + p[0], 0) / outline.length, cz = outline.reduce((s, p) => s + p[1], 0) / outline.length;
    const y = ground(cx, cz) + 1.2;
    cylinder(t, cx, cz, y - 3, y, 1.15, 1.15, SANDSTONE, 10, true);
    garita(t, cx, cz, y, 1.1);
    spots.push([cx, cz]);
    return { tris: t, top: y + 4, pieces: [] };
  }
  const tiers = area > 8000 ? 3 : area > 1500 ? 2 : 1, insets = [0, area > 8000 ? 9 : 6, 19], rises = [5, 8.5, 11.5];
  let top = 0;
  const pieces = [];
  for (let k = 0; k < tiers; k++) {
    for (const piece of inset(outline, insets[k])) {
      if (Math.abs(ringArea(piece)) < (k ? 80 : 30)) continue;
      const g = piece.map(([x, z]) => ground(x, z)), gmax = Math.max(...g), gmin = Math.min(...g);
      const y = gmax + rises[k];
      top = Math.max(top, y);
      // battered walls: the top of each wall leans back by a little over a tenth of its height
      const dirs = inward(piece), batter = Math.min(3, Math.max(0.6, 0.11 * (y - gmin)));
      const upper = piece.map(([x, z], i) => { const d = dirs[i], m = Math.min(batter * d.k, d.room); return [x + d.dx * m, z + d.dz * m]; });
      for (let i = 0; i < piece.length; i++) {
        const j = (i + 1) % piece.length, [ax, az] = piece[i], [bx, bz] = piece[j], [cx2, cz2] = upper[j], [dx2, dz2] = upper[i];
        const yb = Math.min(g[i], g[j]) - 2.5, band = Math.min(y, yb + 4.5);
        // a darker, weathered foot, then the wall
        t.quad([ax, yb, az], [bx, yb, bz], [bx + (cx2 - bx) * 0.15, band, bz + (cz2 - bz) * 0.15], [ax + (dx2 - ax) * 0.15, band, az + (dz2 - az) * 0.15], SANDSTONE_DARK);
        t.quad([ax + (dx2 - ax) * 0.15, band, az + (dz2 - az) * 0.15], [bx + (cx2 - bx) * 0.15, band, bz + (cz2 - bz) * 0.15], [cx2, y, cz2], [dx2, y, dz2], k ? SANDSTONE_LIGHT : SANDSTONE);
      }
      // the terreplein on top, the parapet round its edge
      const flat = upper.flat(), idx = earcut(flat);
      for (let i = 0; i < idx.length; i += 3) t.flat(...[idx[i], idx[i + 1], idx[i + 2]].map((v) => [flat[v * 2], y, flat[v * 2 + 1]]), TERREPLEIN);
      parapet(t, upper, y);
      pieces.push({ ring: upper, y });
      // garitas on the salient corners: the sharpest, on long enough walls; a small bastion has one or two
      const corners = inward(upper).map((d, i) => ({ d, i, len: Math.min(Math.hypot(upper[i][0] - upper[(i + upper.length - 1) % upper.length][0], upper[i][1] - upper[(i + upper.length - 1) % upper.length][1]), Math.hypot(upper[(i + 1) % upper.length][0] - upper[i][0], upper[(i + 1) % upper.length][1] - upper[i][1])) }))
        .filter((c) => c.d.convex && c.d.k > 1.15 && c.len > 7).sort((a, b) => b.d.k - a.d.k);
      let room = area < 1500 ? 2 : k === tiers - 1 ? 6 : 4;
      for (const { d, i } of corners) {
        const x = upper[i][0] - d.dx * 0.7, z = upper[i][1] - d.dz * 0.7;
        if (room <= 0 || !free(spots, x, z)) continue;
        garita(t, x, z, y + 1.1, 1);
        spots.push([x, z]); room--;
      }
    }
  }
  return { tris: t, top, pieces };
}

// Garitas on the city walls (La Muralla, drawn 4.5 m high by meshing.js): at the salient corners, where the wall
// turns by more than 30 degrees and the outside of the bend faces out of the city. lines: polylines [[x, z]...];
// outside(xOut, zOut, xIn, zIn): whether the first point is outside the walls; tris(x, z): where to put one.
export function wallGaritas(lines, ground, outside, tris, spots = [], wallHeight = 4.5) {
  let n = 0;
  for (const pts of lines) {
    const closed = pts.length > 3 && Math.hypot(pts[0][0] - pts.at(-1)[0], pts[0][1] - pts.at(-1)[1]) < 0.5;
    const ring = closed ? pts.slice(0, -1) : pts, m = ring.length;
    for (let i = closed ? 0 : 1; i < (closed ? m : m - 1); i++) {
      const [px, pz] = ring[i], [ax, az] = ring[(i + m - 1) % m], [cx, cz] = ring[(i + 1) % m];
      const la = Math.hypot(ax - px, az - pz), lc = Math.hypot(cx - px, cz - pz);
      if (la < 6 || lc < 6) continue;
      let bx = (ax - px) / la + (cx - px) / lc, bz = (az - pz) / la + (cz - pz) / lc;
      const bl = Math.hypot(bx, bz);
      if (bl < 0.52) continue; // straighter than 150 degrees
      bx /= bl; bz /= bl; // into the bend; the garita stands on its outside
      if (!outside(px - bx * 8, pz - bz * 8, px + bx * 8, pz + bz * 8)) continue;
      const x = px - bx * 0.9, z = pz - bz * 0.9;
      if (!free(spots, x, z)) continue;
      garita(tris(x, z), x, z, ground(px, pz) + wallHeight + 0.2, 1);
      spots.push([x, z]); n++;
    }
  }
  return n;
}

// A parapet along a ring at height y: 0.9 m thick, merlons 1.2 m high with lower embrasures every 6 m.
function parapet(t, ring, y) {
  const dirs = inward(ring);
  for (let i = 0; i < ring.length; i++) {
    const j = (i + 1) % ring.length, [ax, az] = ring[i], [bx, bz] = ring[j], len = Math.hypot(bx - ax, bz - az);
    if (len < 1) continue;
    const ux = (bx - ax) / len, uz = (bz - az) / len, nx = uz, nz = -ux; // inward normal
    const step = 6, gap = 1.1;
    for (let s = 0; s < len; s += step) {
      const e = Math.min(len, s + step - gap), p = (d) => [ax + ux * d, az + uz * d];
      const seg = (d0, d1, h) => {
        if (d1 - d0 < 0.05) return;
        const [x0, z0] = p(d0), [x1, z1] = p(d1);
        prism(t, [[x0, z0], [x1, z1], [x1 + nx * 0.9, z1 + nz * 0.9], [x0 + nx * 0.9, z0 + nz * 0.9]], y, y + h, SANDSTONE_LIGHT);
      };
      seg(s, e, 1.2);
      seg(e, Math.min(len, s + step), 0.45); // the embrasure
    }
    void dirs;
  }
}

// ---------------------------------------------------------------- domes, lighthouse, cathedral
// A dome over a round(ish) building part: centre, the height its walls stop at, radius. A large one (the
// Capitol's) stands on a drum ringed by columns and carries a lantern.
export function domeOn(t, cx, cz, y, r, { grand = r > 6, colour = MARBLE } = {}) {
  let base = y;
  if (grand) {
    const drum = r * 0.55;
    cylinder(t, cx, cz, y, y + drum, r * 0.92, r * 0.92, MARBLE_SHADE, 24, false);
    const cols = 20;
    for (let k = 0; k < cols; k++) { const a = (k / cols) * Math.PI * 2; cylinder(t, cx + Math.cos(a) * r * 1.05, cz + Math.sin(a) * r * 1.05, y, y + drum, r * 0.045, r * 0.04, colour, 6, false); }
    cylinder(t, cx, cz, y + drum, y + drum + r * 0.08, r * 1.12, r * 1.12, colour, 24, true); // entablature
    base = y + drum + r * 0.08;
  }
  dome(t, cx, cz, base, r * 0.95, r * 1.05, colour, 24, 9);
  const lr = r * (grand ? 0.16 : 0.2), ly = base + r * 1.05;
  cylinder(t, cx, cz, ly - 0.2, ly + lr * 1.8, lr, lr, colour, 10, false);
  dome(t, cx, cz, ly + lr * 1.8, lr * 1.1, lr * 1.1, colour, 10, 4);
  cylinder(t, cx, cz, ly + lr * 2.9, ly + lr * 3.6, lr * 0.25, 0.02, colour, 6, false);
  return ly + lr * 3.6;
}

// The Faro de El Morro: a square tower of two stages and a glazed lantern, standing at (x, z) on y.
export function lighthouse(t, x, z, y) {
  box(t, x, z, 1, 0, 2.6, 2.6, y - 1, y + 7, CREAM);
  box(t, x, z, 1, 0, 2.9, 2.9, y + 7, y + 7.5, SANDSTONE_LIGHT);
  box(t, x, z, 1, 0, 2.0, 2.0, y + 7.5, y + 12, CREAM);
  box(t, x, z, 1, 0, 2.3, 2.3, y + 12, y + 12.4, SANDSTONE_LIGHT);
  cylinder(t, x, z, y + 12.4, y + 14.4, 1.3, 1.3, [0.25, 0.32, 0.36], 8, false); // the lantern glass
  cylinder(t, x, z, y + 14.4, y + 15.4, 1.5, 0.3, [0.2, 0.22, 0.24], 8, true);
}

// The cathedral: its walls are the building's own; this adds the dome over the crossing (towards the
// sanctuary, opposite the facade) and the bell gable over the facade. facade: { ax, az, bx, bz } the facade
// edge (counter-clockwise, so the outside is to its right), y: the roof line, base: the foot of the walls.
export function cathedral(t, ring, facade, y, base = y - 12) {
  const cx = ring.reduce((s, p) => s + p[0], 0) / ring.length, cz = ring.reduce((s, p) => s + p[1], 0) / ring.length;
  const { ax, az, bx, bz } = facade, len = Math.hypot(bx - ax, bz - az), ux = (bx - ax) / len, uz = (bz - az) / len, ox = -uz, oz = ux; // outward
  const mx = (ax + bx) / 2, mz = (az + bz) / 2;
  // the crossing: from the facade's middle a little past the middle of the building, away from the facade
  const depth = (cx - mx) * -ox + (cz - mz) * -oz, kx = mx - ox * depth * 1.25, kz = mz - oz * depth * 1.25;
  const r = Math.min(5, len * 0.28);
  cylinder(t, kx, kz, y, y + 2.6, r, r, MARBLE, 8, false);
  domeOn(t, kx, kz, y + 2.6, r, { grand: false, colour: MARBLE });
  // the bell gable: a stepped wall over the facade with arched openings for the bells
  const w = Math.min(len * 0.8, 11), gx = mx - ox * 0.7, gz = mz - oz * 0.7;
  box(t, gx, gz, ux, uz, w / 2, 0.7, y - 0.5, y + 4.5, CREAM);
  box(t, gx, gz, ux, uz, w * 0.27, 0.7, y + 4.5, y + 7.5, CREAM);
  box(t, gx, gz, ux, uz, w * 0.1, 0.7, y + 7.5, y + 8.6, CREAM);
  for (const [off, y0, y1] of [[-w * 0.24, y + 1.4, y + 3.6], [w * 0.24, y + 1.4, y + 3.6], [0, y + 5.0, y + 7.0]])
    box(t, gx + ux * off + ox * 0.72, gz + uz * off + oz * 0.72, ux, uz, 0.55, 0.03, y0, y1, DARK);
  // the front below it: pilasters, a cornice, the portal and the windows over it (just proud of the wall)
  const at = (off, out) => [mx + ux * off + ox * out, mz + uz * off + oz * out], hgt = y - base;
  for (const off of [-len * 0.32, -len * 0.12, len * 0.12, len * 0.32]) box(t, ...at(off, 0.3), ux, uz, 0.45, 0.3, base - 1, y - 0.5, TRIM);
  box(t, ...at(0, 0.35), ux, uz, len / 2, 0.35, y - 0.9, y, TRIM);
  box(t, ...at(0, 0.5), ux, uz, 1.9, 0.12, base - 1, base + Math.min(6.5, hgt * 0.5), TRIM); // the portal's frame
  box(t, ...at(0, 0.6), ux, uz, 1.4, 0.06, base - 1, base + Math.min(5.8, hgt * 0.45), DARK);
  for (const off of [-len * 0.22, 0, len * 0.22]) box(t, ...at(off, 0.4), ux, uz, 0.6, 0.05, base + hgt * 0.64, base + hgt * 0.82, DARK);
}

// ---------------------------------------------------------------- the Convention Center
const inRing = (x, z, r) => {
  let c = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [xi, zi] = r[i], [xj, zj] = r[j];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) c = !c;
  }
  return c;
};
const segDist = (x, z, ax, az, bx, bz) => {
  const dx = bx - ax, dz = bz - az, l = dx * dx + dz * dz, f = l ? Math.min(1, Math.max(0, ((x - ax) * dx + (z - az) * dz) / l)) : 0;
  return Math.hypot(x - ax - dx * f, z - az - dz * f);
};
// The Puerto Rico Convention Center: a long hall whose roof sweeps up towards its curved glass front and breaks
// over it like a wave, cantilevered past the glass. ring: the outline (world, counter-clockwise); y: the hall's
// roof line; toward: [x, z], roughly the way the front faces; base: the ground, for the lobby's glass wall.
export function convention(t, ring, y, toward, base = y - 15) {
  const n = ring.length;
  // the hall's axis: the length-weighted mean direction of its edges (angles doubled, so opposite sides agree)
  let sx = 0, sz = 0;
  for (let i = 0; i < n; i++) {
    const [ax, az] = ring[i], [bx, bz] = ring[(i + 1) % n], a = Math.atan2(bz - az, bx - ax), l = Math.hypot(bx - ax, bz - az);
    sx += l * Math.cos(2 * a); sz += l * Math.sin(2 * a);
  }
  const th = Math.atan2(sz, sx) / 2, ux = Math.cos(th), uz = Math.sin(th); // along
  let vx = -uz, vz = ux; // across, towards the front
  if (vx * toward[0] + vz * toward[1] < 0) { vx = -vx; vz = -vz; }
  const U = (x, z) => x * ux + z * uz, V = (x, z) => x * vx + z * vz;
  let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
  for (const [x, z] of ring) { u0 = Math.min(u0, U(x, z)); u1 = Math.max(u1, U(x, z)); v0 = Math.min(v0, V(x, z)); v1 = Math.max(v1, V(x, z)); }
  const OVER = 10, RISE = 9, WAVE = 1.8, THICK = 1.1, CELL = 6;
  const normal = (i) => { const [ax, az] = ring[i], [bx, bz] = ring[(i + 1) % n], l = Math.hypot(bx - ax, bz - az) || 1; return [-(bz - az) / l, (bx - ax) / l]; };
  const facing = (i) => { const [nx, nz] = normal(i); return Math.min(1, Math.max(0, (nx * vx + nz * vz - 0.3) / 0.5)); };
  // the roof's plan: the outline, an eave all round, the cantilever over the front
  const reach = (i) => 1.2 + (OVER - 1.2) * facing(i), parts = [[close(ring)]];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n, [ax, az] = ring[i], [bx, bz] = ring[j], [nx, nz] = normal(i), w = reach(i), [mx, mz] = normal(j), w2 = reach(j);
    parts.push([close([[ax, az], [bx, bz], [bx + nx * w, bz + nz * w], [ax + nx * w, az + nz * w]])]);
    const join = [[bx, bz], [bx + nx * w, bz + nz * w], [bx + mx * w2, bz + mz * w2]];
    if (Math.abs(ringArea(join)) > 0.01) parts.push([close(join)]);
  }
  let plan, outside;
  try { plan = polygonClipping.union(...parts); outside = polygonClipping.difference(plan, [close(ring)]); } catch { plan = [[close(ring)]]; outside = []; }
  // the roof: rising across the hall to the front, a wave along its length growing towards the front, a lip
  // turning up over the cantilever
  const beyond = (x, z) => {
    if (inRing(x, z, ring)) return 0;
    let d = Infinity;
    for (let i = 0; i < n; i++) { const [ax, az] = ring[i], [bx, bz] = ring[(i + 1) % n]; d = Math.min(d, segDist(x, z, ax, az, bx, bz)); }
    return d;
  };
  const height = (x, z) => {
    const d = Math.min(1, Math.max(0, (V(x, z) - v0) / (v1 - v0))), s = (U(x, z) - u0) / (u1 - u0), e = Math.min(1, beyond(x, z) / OVER);
    return y + 0.4 + RISE * d ** 2.4 + WAVE * Math.sin(Math.PI * (2 * s + 0.25)) * d ** 3 + 3.5 * e ** 1.6;
  };
  // the surface, cut into cells of the hall's frame so it can curve
  const surface = (multi, under) => {
    for (let a = Math.floor((u0 - OVER) / CELL); a * CELL < u1 + OVER; a++) for (let b = Math.floor((v0 - OVER) / CELL); b * CELL < v1 + OVER; b++) {
      const cell = [[a, b], [a + 1, b], [a + 1, b + 1], [a, b + 1], [a, b]].map(([p, q]) => [p * CELL * ux + q * CELL * vx, p * CELL * uz + q * CELL * vz]);
      let pieces;
      try { pieces = polygonClipping.intersection(multi, [cell]); } catch { continue; }
      for (const poly of pieces) {
        const flat = [], holes = [];
        poly.forEach((r, i) => { if (i) holes.push(flat.length / 2); for (const p of r.slice(0, -1)) flat.push(p[0], p[1]); });
        const idx = earcut(flat, holes);
        for (let i = 0; i < idx.length; i += 3) {
          t.flat(...[idx[i], idx[i + 1], idx[i + 2]].map((v) => { const x = flat[v * 2], z = flat[v * 2 + 1]; return [x, height(x, z) - (under ? THICK : 0), z]; }), under ? SOFFIT : ROOF_METAL, !under);
        }
      }
    }
  };
  surface(plan, false);
  if (outside.length) surface(outside, true);
  // the fascia round the roof's edge
  const along = (ax, az, bx, bz, step, fn) => {
    const k = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / step));
    for (let s = 0; s < k; s++) fn(ax + (bx - ax) * s / k, az + (bz - az) * s / k, ax + (bx - ax) * (s + 1) / k, az + (bz - az) * (s + 1) / k, s);
  };
  for (const poly of plan) for (const r of poly) for (let i = 0; i + 1 < r.length; i++) {
    along(r[i][0], r[i][1], r[i + 1][0], r[i + 1][1], 3, (x0, z0, x1, z1) => {
      const h0 = height(x0, z0), h1 = height(x1, z1);
      t.quad([x0, h0 - THICK, z0], [x1, h1 - THICK, z1], [x1, h1, z1], [x0, h0, z0], SOFFIT);
    });
  }
  // the lobby's glass wall along the front, from the ground to the roof (with mullions), and panels under the
  // roof where it rises above the hall elsewhere
  for (let i = 0; i < n; i++) {
    const [ax, az] = ring[i], [bx, bz] = ring[(i + 1) % n], len = Math.hypot(bx - ax, bz - az), glass = facing(i) > 0;
    if (len < 0.5) continue;
    const ex = (bx - ax) / len, ez = (bz - az) / len, [nx, nz] = normal(i), o = glass ? 0.12 : 0; // just proud of the wall
    along(ax + nx * o, az + nz * o, bx + nx * o, bz + nz * o, 4.5, (x0, z0, x1, z1) => {
      const h0 = height(x0, z0) - THICK, h1 = height(x1, z1) - THICK, y0 = glass ? base - 0.5 : y - 0.3;
      if (!glass && Math.max(h0, h1) <= y + 0.05) return;
      t.quad([x0, y0, z0], [x1, y0, z1], [x1, Math.max(y, h1), z1], [x0, Math.max(y, h0), z0], glass ? GLASS : SOFFIT);
      if (glass) {
        box(t, x0, z0, ex, ez, 0.1, 0.15, y0, Math.max(y, h0), MULLION);
        for (const f of [0.34, 0.67]) box(t, (x0 + x1) / 2, (z0 + z1) / 2, ex, ez, 2.25, 0.08, base + (y - base) * f - 0.12, base + (y - base) * f + 0.12, MULLION); // transoms
      }
    });
  }
}
