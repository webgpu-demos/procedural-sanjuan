// All ground layers use the terrain mesh's world-aligned triangles. Sampling heights only at a
// polygon's own vertices gives it a different slope from the road beneath it, burying paint on hills.
import { TILE } from '../shared/geo.js';

// Clip a convex polygon to a half-plane; extra vertex components (such as UVs) interpolate too.
function clip(poly, distance) {
  const out = [];
  let a = poly.at(-1), da = distance(a);
  for (const b of poly) {
    const db = distance(b);
    if ((da >= 0) !== (db >= 0)) {
      const t = da / (da - db);
      out.push(a.map((v, i) => v + (b[i] - v) * t));
    }
    if (db >= 0) out.push(b);
    a = b; da = db;
  }
  return out;
}

// cuts: a tile's cuttings (src/shared/cuttings.js cutField().forTile, with the field's `fine`, `corner` and `inside`):
// what lies inside their outline is split along the floor's own lattice and takes the floor's height. Every point
// emitted then carries its height as `y` (a point on the outline belongs to the floor in one piece and to the ground
// in the next: its place alone does not say which).
export function createDraper(grid, surface, tileSize = TILE, cuts = null) {
  const base = plainDraper(grid, surface, tileSize);
  if (!cuts) return base;
  const floor = plainDraper({ step: cuts.fine }, cuts.corner, tileSize);
  const on = (d, emit) => (p, q, r) => { for (const v of [p, q, r]) if (v.y === undefined) v.y = d.height(v[0], v[1]); emit(p, q, r); };
  const fan = (piece, d, emit) => { for (let k = 1; k + 1 < piece.length; k++) d.triangle(piece[0], piece[k], piece[k + 1], on(d, emit)); };
  return {
    height: (x, z) => (cuts.inside(x, z) ? floor.height(x, z) : base.height(x, z)),
    triangle: (a, b, c, emit) => {
      const s = cuts.split([a, b, c]);
      if (!s) { base.triangle(a, b, c, on(base, emit)); return; }
      // (a corner of the polygon itself is used again by the triangles round it: copies, each with its own height)
      for (const piece of s.out) fan(piece.map((v) => v.slice()), base, emit);
      for (const piece of s.ins) fan(piece.map((v) => v.slice()), floor, emit);
    },
    segment: base.segment,
  };
}
function plainDraper(grid, surface, tileSize) {
  const step = tileSize / Math.ceil(tileSize / grid.step);
  const heights = new Map();
  const node = (i, j) => {
    const key = `${i},${j}`;
    if (!heights.has(key)) heights.set(key, surface(i * step, j * step));
    return heights.get(key);
  };
  // The diagonal joins the north-east and south-west corners, matching terrainMesh().
  const height = (x, z) => {
    const i = Math.floor(x / step), j = Math.floor(z / step), u = x / step - i, v = z / step - j;
    return u + v <= 1
      ? node(i, j) * (1 - u - v) + node(i + 1, j) * u + node(i, j + 1) * v
      : node(i + 1, j + 1) * (u + v - 1) + node(i, j + 1) * (1 - u) + node(i + 1, j) * (1 - v);
  };
  // Split a triangle at every terrain cell boundary and diagonal. Each emitted triangle is planar
  // with the corresponding road/terrain triangle, even when the source polygons span different tiles.
  const triangle = (a, b, c, emit) => {
    const minX = Math.min(a[0], b[0], c[0]), maxX = Math.max(a[0], b[0], c[0]);
    const minZ = Math.min(a[1], b[1], c[1]), maxZ = Math.max(a[1], b[1], c[1]);
    for (let j = Math.floor(minZ / step); j <= Math.floor(maxZ / step); j++) {
      const z0 = j * step, z1 = (j + 1) * step;
      let row = clip([a, b, c], (p) => p[1] - z0);
      if (row.length < 3) continue;
      row = clip(row, (p) => z1 - p[1]);
      if (row.length < 3) continue;
      const xMin = Math.max(minX, Math.min(...row.map((p) => p[0])));
      const xMax = Math.min(maxX, Math.max(...row.map((p) => p[0])));
      for (let i = Math.floor(xMin / step); i <= Math.floor(xMax / step); i++) {
        const x0 = i * step, x1 = (i + 1) * step;
        let cell = clip(row, (p) => p[0] - x0);
        if (cell.length < 3) continue;
        cell = clip(cell, (p) => x1 - p[0]);
        if (cell.length < 3) continue;
        for (const sign of [1, -1]) {
          const poly = clip(cell, (p) => sign * (step - (p[0] - x0) - (p[1] - z0)));
          for (let k = 1; k + 1 < poly.length; k++) {
            const p = poly[0], q = poly[k], r = poly[k + 1];
            if (Math.abs((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])) < 1e-10) continue;
            emit(p, q, r);
          }
        }
      }
    }
  };
  // Kerb tops must use the same vertices as their draped sidewalk edges.
  const segment = (a, b, emit) => {
    const cuts = [0, 1];
    for (const [start, end] of [[a[0], b[0]], [a[1], b[1]], [a[0] + a[1], b[0] + b[1]]]) {
      if (start === end) continue;
      for (let k = Math.floor(Math.min(start, end) / step) + 1; k * step < Math.max(start, end); k++) {
        cuts.push((k * step - start) / (end - start));
      }
    }
    cuts.sort((x, y) => x - y);
    const at = (t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    for (let k = 1; k < cuts.length; k++) if (cuts[k] - cuts[k - 1] > 1e-10) emit(at(cuts[k - 1]), at(cuts[k]));
  };
  return { height, triangle, segment };
}
