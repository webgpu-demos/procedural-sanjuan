// Window glass and water that reflect the city: screen-space reflections, for the window panes and the water only.
// The facade and water shaders mark their mirrors in the alpha channel of the colour buffer (1 everywhere else).
// For each marked pixel the mirrored view ray is marched through the depth buffer; where it meets something that
// is on screen, the mirror shows it. A ray that leaves the screen or finds nothing keeps what the mirror had: the
// reflection of the sky from the environment map. Glass adds its own Fresnel here; water (a level surface) has
// put its Fresnel in the mark already, and its reflection trembles with the waves.
import * as THREE from 'three';
import { Effect, EffectAttribute } from 'postprocessing';
import { shared } from './materials.js';

const STEPS = 28;

const fragment = /* glsl */ `
uniform mat4 uProjection;
uniform mat4 uInverseProjection;
uniform mat4 uCameraWorld;
uniform float uStrength;
uniform float uTime;

vec3 viewPosition(const vec2 uv, const float depth) {
  vec4 p = uInverseProjection * vec4(uv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
  return p.xyz / p.w;
}
float rhash(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float rnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(rhash(i), rhash(i + vec2(1.0, 0.0)), f.x), mix(rhash(i + vec2(0.0, 1.0)), rhash(i + vec2(1.0, 1.0)), f.x), f.y);
}

// Marches the mirrored ray from P along R through the depth buffer: the point of the screen it meets, or -1.
// Steps grow with distance (the next building is tens of metres away, the skyline a kilometre); jitter in [0, 1)
// staggers where they fall.
vec2 traceMirror(vec3 P, vec3 R, float jitter) {
  float t = 1.5 + jitter, growth = 1.24, last = 0.0;
  for (int i = 0; i < ${STEPS}; i++) {
    vec3 Q = P + R * t;
    if (Q.z > -1.0) break;                               // behind the camera
    vec4 c = uProjection * vec4(Q, 1.0);
    vec2 q = c.xy / c.w * 0.5 + 0.5;
    if (q.x < 0.0 || q.x > 1.0 || q.y < 0.0 || q.y > 1.0) break;
    float d = readDepth(q);
    if (d < 1.0) {
      float sceneZ = viewPosition(q, d).z, behind = sceneZ - Q.z; // > 0: the ray is behind what is drawn there
      if (behind > 0.0 && behind < max(3.0, (t - last) * 1.5)) {
        // halve the last step a few times to land on the surface
        float lo = last, hi = t;
        for (int k = 0; k < 5; k++) {
          float mid = 0.5 * (lo + hi);
          vec3 M = P + R * mid;
          vec4 mc = uProjection * vec4(M, 1.0);
          vec2 mq = mc.xy / mc.w * 0.5 + 0.5;
          if (viewPosition(mq, readDepth(mq)).z - M.z > 0.0) hi = mid; else lo = mid;
          q = mq;
        }
        return q;
      }
    }
    last = t;
    t = t * growth + 0.5;
  }
  return vec2(-1.0);
}

void mainImage(const in vec4 inputColor, const in vec2 uv, const in float depth, out vec4 outputColor) {
  outputColor = vec4(inputColor.rgb, 1.0);
  float pane = 1.0 - inputColor.a;
  if (pane < 0.02 || depth >= 1.0) return;

  vec3 P = viewPosition(uv, depth);
  // the mirror's normal from the depth buffer: walls and water are flat, so neighbouring pixels give it
  vec3 N = normalize(cross(dFdx(P), dFdy(P)));
  vec3 V = normalize(P);
  if (dot(N, V) > 0.0) N = -N;
  bool level = (mat3(uCameraWorld) * N).y > 0.85;  // water
  if (level) N = normalize(transpose(mat3(uCameraWorld)) * vec3(0.0, 1.0, 0.0)); // (exactly level: no stair-steps from the depth)
  vec3 R = reflect(V, N);
  if (R.z > -0.02 && dot(R, V) < 0.0) return; // heading back at the camera: what it would show is not on screen

  // Two rays, half a step apart, for glass (one alone left a pane speckled where neighbouring pixels found and
  // missed what it mirrors); one does for water, whose own blur hides the speckle.
  float jitter = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
  vec2 hit = traceMirror(P, R, jitter), hit2 = level ? vec2(-1.0) : traceMirror(P, R, fract(jitter + 0.5));
  if (hit.x < 0.0) { hit = hit2; hit2 = vec2(-1.0); }
  if (hit.x < 0.0) return;

  float k;
  vec3 seen;
  if (level) {
    // Water: the waves break the image up and draw it out towards the viewer (a lit window over the sea at
    // night is a column of light), less far off where the ripples are too fine to see
    vec3 W = (uCameraWorld * vec4(P, 1.0)).xyz;
    vec2 wob = vec2(rnoise(W.xz * 0.21 + vec2(uTime * 0.5, 0.0)) - 0.5, rnoise(W.xz * 0.17 + vec2(3.1, uTime * 0.4)) - 0.5)
             + 0.6 * vec2(rnoise(W.xz * 0.9 - uTime * 0.9) - 0.5, rnoise(W.xz * 0.8 + 7.0 + uTime * 0.8) - 0.5);
    float near = clamp(40.0 / -P.z, 0.15, 1.0);
    vec2 base = hit + wob * vec2(0.007, 0.03) * near;
    vec3 sum = vec3(0.0);
    float weight = 0.0;
    for (int s = -3; s <= 3; s++) {
      vec2 o = base + vec2(0.0, float(s) * 0.007 * near);
      if (o.y <= 0.0 || o.y >= 1.0 || readDepth(o) >= 1.0) continue; // (the sky there: the environment's own reflection stays)
      float wgt = 1.0 - abs(float(s)) * 0.22;
      sum += texture2D(inputBuffer, o).rgb * wgt; weight += wgt;
    }
    if (weight <= 0.0) return;
    seen = sum / weight;
    k = pane * weight / 4.36; // (its Fresnel is in the mark already; less where much of the column is sky)
  } else {
    // glass reflects more at a glancing angle (and as much as both rays found something to mirror)
    seen = hit2.x < 0.0 ? texture2D(inputBuffer, hit).rgb : 0.5 * (texture2D(inputBuffer, hit).rgb + texture2D(inputBuffer, hit2).rgb);
    k = pane * (0.3 + 0.7 * pow(1.0 - max(dot(-V, N), 0.0), 3.0)) * (hit2.x < 0.0 ? 0.75 : 1.0);
  }
  // reflections fade out towards the edge of the screen
  vec2 edge = smoothstep(vec2(0.0), vec2(0.08), hit) * (1.0 - smoothstep(vec2(0.92), vec2(1.0), hit));
  k *= edge.x * edge.y * uStrength;
  outputColor.rgb = mix(inputColor.rgb, seen, clamp(k, 0.0, 1.0));
}
`;

export class WindowReflections extends Effect {
  constructor(camera) {
    super('WindowReflections', fragment, {
      attributes: EffectAttribute.DEPTH,
      uniforms: new Map([
        ['uProjection', new THREE.Uniform(camera.projectionMatrix)],
        ['uInverseProjection', new THREE.Uniform(camera.projectionMatrixInverse)],
        ['uCameraWorld', new THREE.Uniform(camera.matrixWorld)],
        ['uStrength', new THREE.Uniform(1)],
        ['uTime', shared.uTime],
      ]),
    });
  }

  get strength() { return this.uniforms.get('uStrength').value; }
  set strength(v) { this.uniforms.get('uStrength').value = v; }
}
