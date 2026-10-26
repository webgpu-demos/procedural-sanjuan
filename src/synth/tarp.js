// The blue tarp over a damaged roof, shared by the facade material (what the camera sees) and the label pass
// (src/synth/labels.js), so a tarp's pixels and its label are the same pixels. A damaged building's vertices carry
// aSynth = (centre x, centre z, round(10 hx) * 1000 + round(10 hz), angle + 4): a rectangle of half sizes hx, hz
// turned by `angle` (radians) on the roof. w below 3.5 (the attribute missing: WebGL reads (0, 0, 0, 1)) = no tarp.
export const TARP_GLSL = /* glsl */ `
float synthTarp(vec3 p, vec4 s, float kind) {
  if (s.w < 3.5) return 0.0;
  if (!((kind > 0.5 && kind < 1.5) || (kind > 2.5 && kind < 3.5))) return 0.0; // roofs only (KIND.FLAT_ROOF, PITCHED_ROOF)
  float a = s.w - 4.0, hx = floor(s.z / 1000.0 + 0.0001) / 10.0, hz = (s.z - floor(s.z / 1000.0 + 0.0001) * 1000.0) / 10.0;
  vec2 ax = vec2(cos(a), sin(a)), pe = vec2(-ax.y, ax.x), d = p.xz - s.xy;
  return step(abs(dot(d, ax)), hx) * step(abs(dot(d, pe)), hz);
}
// along-tarp coordinate, for its folds
float synthTarpU(vec3 p, vec4 s) { float a = s.w - 4.0; return dot(p.xz - s.xy, vec2(cos(a), sin(a))); }
`;

/** Packs a tarp for aSynth: centre (x, z) in world metres, half sizes (m, up to 99.9), angle (radians). */
export function packTarp(cx, cz, hx, hz, angle) {
  const q = (v) => Math.max(1, Math.min(999, Math.round(v * 10)));
  return [cx, cz, q(hx) * 1000 + q(hz), ((angle % Math.PI) + Math.PI) % Math.PI + 4];
}
