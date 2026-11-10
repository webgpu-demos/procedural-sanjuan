// Height grid sampling shared by the compiler and the client.
// A grid is { x0, z0, step, w, h, data: Float32Array } with rows running along +z (north -> south).

// Bilinear height at world (x, z), clamped to the grid edges.
export function sampleGrid(g, x, z) {
  const fx = Math.min(Math.max((x - g.x0) / g.step, 0), g.w - 1.001);
  const fz = Math.min(Math.max((z - g.z0) / g.step, 0), g.h - 1.001);
  const i = Math.floor(fx), j = Math.floor(fz), tx = fx - i, tz = fz - j;
  const d = g.data, w = g.w;
  const y = (d[j * w + i] * (1 - tx) + d[j * w + i + 1] * tx) * (1 - tz) +
    (d[(j + 1) * w + i] * (1 - tx) + d[(j + 1) * w + i + 1] * tx) * tz;
  return g.pads ? g.pads(x, z, y) : y;
}

// The ground levelled where a deck lands on it (src/world/flyovers.js deckPads): the elevation model's crown along an
// embankment's top left a deck's end, flat across, standing up to 0.7 m over the drawn road at its edges, the ground
// seen under it (PR-22 under the opening's ride). Each pad is [x, z, tx, tz, half, y0, grade, fwd, ...back]: the
// deck's end, its way into the deck, its half width, its level there and its grade on, how far on under it the
// ground is held to it, and the road's level at its middle every PAD_STEP metres back from the end. Across the
// deck's width and 2 m beyond, from PAD_BACK metres back to `fwd` on, the ground is the road's level at its middle
// (on the deck's side, the deck's); it eases back to the terrain over PAD_EASE metres beside and behind, PAD_ON on.
// Returns (x, z, y) => the ground there, given the terrain's y.
export const PAD_STEP = 2.5, PAD_BACK = 12, PAD_EASE = 9, PAD_ON = 6;
const PAD_CELL = 64;
// How far the ground as drawn stands off a pad's deck across its end (the step a car drove up or down), on `g` as
// its pads are.
export function padStep(g, p) {
  const [x, z, tx, tz, half, y0] = p;
  let step = 0;
  for (let l = -half + 0.3; l <= half - 0.3; l += 0.5) step = Math.max(step, Math.abs(meshHeight(g, x - tz * l, z + tx * l) - y0));
  return step;
}
// The pads to keep on `g`: those that leave less of a step than there was (where another deck's pad, or the lattice
// of the drawn ground, undoes one, the ground is left as it was). Sets g.pads.
export function settlePads(g, pads) {
  g.pads = null;
  const before = pads.map((p) => padStep(g, p));
  let keep = pads.map((p, i) => i);
  for (let round = 0; round < 6; round++) {
    g.pads = padField(keep.map((i) => pads[i]));
    const after = pads.map((p) => padStep(g, p)), worse = pads.filter((p, i) => after[i] > before[i] + 0.03);
    const next = keep.filter((i) => after[i] < before[i] - 0.03 && !worse.some((q) => q !== pads[i] && Math.hypot(q[0] - pads[i][0], q[1] - pads[i][1]) < 60));
    if (next.length === keep.length) break;
    keep = next;
  }
  const kept = keep.map((i) => pads[i]);
  g.pads = padField(kept);
  return kept;
}
export function padField(pads) {
  // (the pads that reach each PAD_CELL square, in a flat table over the squares they cover: a lookup on every
  // height asked for anywhere, so no map and nothing allocated)
  const reach = PAD_BACK + PAD_EASE, R = pads.map((p) => Math.max(reach, p[7] + PAD_ON) + p[4] + PAD_EASE + 2);
  let i0 = Infinity, i1 = -Infinity, j0 = Infinity, j1 = -Infinity;
  pads.forEach((p, k) => { i0 = Math.min(i0, Math.floor((p[0] - R[k]) / PAD_CELL)); i1 = Math.max(i1, Math.floor((p[0] + R[k]) / PAD_CELL)); j0 = Math.min(j0, Math.floor((p[1] - R[k]) / PAD_CELL)); j1 = Math.max(j1, Math.floor((p[1] + R[k]) / PAD_CELL)); });
  if (!pads.length) return (x, z, y) => y;
  const W = i1 - i0 + 1, H = j1 - j0 + 1, lists = Array.from({ length: W * H }, () => null);
  pads.forEach((p, k) => {
    for (let i = Math.floor((p[0] - R[k]) / PAD_CELL); i <= Math.floor((p[0] + R[k]) / PAD_CELL); i++)
      for (let j = Math.floor((p[1] - R[k]) / PAD_CELL); j <= Math.floor((p[1] + R[k]) / PAD_CELL); j++) (lists[(j - j0) * W + i - i0] ??= []).push(k);
  });
  const start = new Int32Array(W * H + 1), items = [];
  for (let c = 0; c < W * H; c++) { start[c] = items.length; if (lists[c]) items.push(...lists[c]); }
  start[W * H] = items.length;
  const list = Int32Array.from(items);
  const ease = (t) => (t <= 0 ? 1 : t >= 1 ? 0 : 1 - t * t * (3 - 2 * t));
  // the road's middle d metres back from pad p's end (its samples every PAD_STEP)
  const back = (p, d) => { const n = p.length - 8, f = Math.min(d / PAD_STEP, n - 1), i = Math.floor(f); return i + 1 < n ? p[8 + i] + (p[9 + i] - p[8 + i]) * (f - i) : p[8 + n - 1]; };
  return (x, z, y) => {
    const ci = Math.floor(x / PAD_CELL) - i0, cj = Math.floor(z / PAD_CELL) - j0;
    if (ci < 0 || cj < 0 || ci >= W || cj >= H) return y;
    const c = cj * W + ci, e = start[c + 1];
    if (start[c] === e) return y;
    // (where two pads reach, the nearer one's level: each weighs as its reach there to the fourth power)
    let most = 0, sum = 0, pull = 0, lo = Infinity, hi = -Infinity;
    for (let q = start[c]; q < e; q++) {
      const p = pads[list[q]], px = p[0], pz = p[1], tx = p[2], tz = p[3];
      const s = (x - px) * tx + (z - pz) * tz, l = Math.abs((x - px) * -tz + (z - pz) * tx);
      const w = ease((l - p[4] - 2) / PAD_EASE) * (s >= 0 ? ease((s - p[7]) / PAD_ON) : ease((-s - PAD_BACK) / PAD_EASE));
      if (w <= 0) continue;
      // on the deck's side its level; behind it, a straight run down to the road's middle PAD_BACK metres back (the
      // middle has humps the lattice of the drawn ground would spread across it), then the road's middle
      const y0 = p[5], level = s >= 0 ? y0 + p[6] * s : -s <= PAD_BACK ? y0 + (back(p, PAD_BACK) - y0) * (-s / PAD_BACK) : back(p, -s);
      const k4 = w * w * w * w;
      most = Math.max(most, w); sum += k4; pull += k4 * level;
      if (w > 0.5) { lo = Math.min(lo, level); hi = Math.max(hi, level); }
    }
    // (two decks landing side by side at levels apart, a ramp beside the expressway: the ground left as it is
    // between them rather than pulled to either)
    const agree = hi > lo ? Math.max(0, Math.min(1, 2 - (hi - lo) / 0.3)) : 1;
    return most > 0 ? y + Math.max(-1.5, Math.min(1.5, pull / sum - y)) * most * agree : y;
  };
}

// The ground as the meshes draw it. The terrain mesh and the draped road surfaces (src/world/meshing.js,
// src/world/drape.js) take the grid at the corners of a lattice of tileSize / ceil(tileSize / step) metres from the
// origin and are flat across each triangle of it (each square split along its north-east to south-west diagonal).
// Between those corners the bilinear surface stands above or below the triangles: on the 10 m grid a tenth of a
// metre at the 90th percentile, a few tenths on a slope, metres at a cliff or an embankment. What stands, walks or
// drives on the ground takes this, or it sinks into the drawn ground or floats over it.
// `at(x, z)`: the height at the lattice's corners (the bilinear grid by default; the decks' surface for roads).
export function meshHeight(g, x, z, tileSize = 256, at = null) {
  const step = tileSize / Math.ceil(tileSize / g.step);
  const i = Math.floor(x / step), j = Math.floor(z / step), u = x / step - i, v = z / step - j;
  const x0 = i * step, z0 = j * step, x1 = x0 + step, z1 = z0 + step;
  // (the grid itself unless told otherwise: no function made for it on every call, the hottest path there is)
  if (!at) return u + v <= 1
    ? sampleGrid(g, x0, z0) * (1 - u - v) + sampleGrid(g, x1, z0) * u + sampleGrid(g, x0, z1) * v
    : sampleGrid(g, x1, z1) * (u + v - 1) + sampleGrid(g, x0, z1) * (1 - u) + sampleGrid(g, x1, z0) * (1 - v);
  return u + v <= 1
    ? at(x0, z0) * (1 - u - v) + at(x1, z0) * u + at(x0, z1) * v
    : at(x1, z1) * (u + v - 1) + at(x0, z1) * (1 - u) + at(x1, z0) * (1 - v);
}
