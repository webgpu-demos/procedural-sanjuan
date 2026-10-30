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
  const cells = new Map(), reach = PAD_BACK + PAD_EASE;
  pads.forEach((p, k) => {
    const [x, z, , , half, , , fwd] = p, r = Math.max(reach, fwd + PAD_ON) + half + PAD_EASE + 2;
    for (let i = Math.floor((x - r) / PAD_CELL); i <= Math.floor((x + r) / PAD_CELL); i++)
      for (let j = Math.floor((z - r) / PAD_CELL); j <= Math.floor((z + r) / PAD_CELL); j++) {
        const key = i * 65536 + j;
        if (!cells.has(key)) cells.set(key, []);
        cells.get(key).push(k);
      }
  });
  const ease = (t) => (t <= 0 ? 1 : t >= 1 ? 0 : 1 - t * t * (3 - 2 * t));
  return (x, z, y) => {
    const list = cells.get(Math.floor(x / PAD_CELL) * 65536 + Math.floor(z / PAD_CELL));
    if (!list) return y;
    // (where two pads reach, the nearer one's level: each weighs as its reach there to the fourth power)
    let most = 0, sum = 0, pull = 0, lo = Infinity, hi = -Infinity;
    for (const k of list) {
      const p = pads[k], [px, pz, tx, tz, half, y0, grade, fwd] = p;
      const s = (x - px) * tx + (z - pz) * tz, l = Math.abs((x - px) * -tz + (z - pz) * tx);
      const w = ease((l - half - 2) / PAD_EASE) * (s >= 0 ? ease((s - fwd) / PAD_ON) : ease((-s - PAD_BACK) / PAD_EASE));
      if (w <= 0) continue;
      // on the deck's side its level; behind it, a straight run down to the road's middle PAD_BACK metres back (the
      // middle has humps the lattice of the drawn ground would spread across it), then the road's middle
      const n = p.length - 8, back = (d) => { const f = Math.min(d / PAD_STEP, n - 1), i = Math.floor(f); return i + 1 < n ? p[8 + i] + (p[9 + i] - p[8 + i]) * (f - i) : p[8 + n - 1]; };
      const level = s >= 0 ? y0 + grade * s : -s <= PAD_BACK ? y0 + (back(PAD_BACK) - y0) * (-s / PAD_BACK) : back(-s);
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
export function meshHeight(g, x, z, tileSize = 256, at = (px, pz) => sampleGrid(g, px, pz)) {
  const step = tileSize / Math.ceil(tileSize / g.step);
  const i = Math.floor(x / step), j = Math.floor(z / step), u = x / step - i, v = z / step - j;
  const x0 = i * step, z0 = j * step, x1 = x0 + step, z1 = z0 + step;
  return u + v <= 1
    ? at(x0, z0) * (1 - u - v) + at(x1, z0) * u + at(x0, z1) * v
    : at(x1, z1) * (u + v - 1) + at(x0, z1) * (1 - u) + at(x1, z0) * (1 - v);
}
