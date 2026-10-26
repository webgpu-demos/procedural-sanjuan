// Height grid sampling shared by the compiler and the client.
// A grid is { x0, z0, step, w, h, data: Float32Array } with rows running along +z (north -> south).

// Bilinear height at world (x, z), clamped to the grid edges.
export function sampleGrid(g, x, z) {
  const fx = Math.min(Math.max((x - g.x0) / g.step, 0), g.w - 1.001);
  const fz = Math.min(Math.max((z - g.z0) / g.step, 0), g.h - 1.001);
  const i = Math.floor(fx), j = Math.floor(fz), tx = fx - i, tz = fz - j;
  const d = g.data, w = g.w;
  return (d[j * w + i] * (1 - tx) + d[j * w + i + 1] * tx) * (1 - tz) +
    (d[(j + 1) * w + i] * (1 - tx) + d[(j + 1) * w + i + 1] * tx) * tz;
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
