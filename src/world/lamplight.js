// Lamp light on the ground at night: street lamps, car and train headlamps.
// Every lamp is a flat quad carrying the footprint of its light. The quads are not drawn in the picture:
// they are drawn from straight above into a light map around the focus, where overlapping lamps keep the
// brighter of the two (lights never pile up into a glare), and every lit surface that faces the sky takes its
// lamp light from that map — as light on its own colour, so asphalt stays asphalt and paint stays paint.
import * as THREE from 'three';
import { shared } from './materials.js';

export const LAMP_LAYER = 2; // the layer the lamp quads live on: the picture's camera does not see it
const SIZE = 2048;
const Y0 = 200, YSPAN = 1000; // heights are stored as (y + Y0) / YSPAN

// Material for a lamp quad: `map` is the footprint; the colour (times the vertex colour, if any) is the light.
// grid: a street lamp, which goes out in an apagón (shared.uGrid); a car's lamps do not.
export function lampMaterial(map, params = {}, { grid = false } = {}) {
  const m = new THREE.MeshBasicMaterial({
    map, side: THREE.DoubleSide, depthTest: false, depthWrite: false, transparent: true,
    blending: THREE.CustomBlending, blendEquation: THREE.MaxEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor, ...params,
  });
  // The height the light lies at goes into the alpha channel, so that a lamp under a flyover does not light
  // the deck above it, nor a car on the deck the street below.
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uGrid = shared.uGrid;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying float vLampY;\nvarying vec2 vLampXZ;')
      .replace('#include <project_vertex>', `#include <project_vertex>
        vec4 lampWorld = vec4(transformed, 1.0);
        #ifdef USE_INSTANCING
        lampWorld = instanceMatrix * lampWorld;
        #endif
        lampWorld = modelMatrix * lampWorld;
        vLampY = lampWorld.y; vLampXZ = lampWorld.xz;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vLampY;\nvarying vec2 vLampXZ;\nuniform vec4 uGrid;')
      .replace('#include <opaque_fragment>', `#include <opaque_fragment>
        ${grid ? 'if (uGrid.z >= 0.0) gl_FragColor.rgb *= smoothstep(uGrid.z - uGrid.w, uGrid.z, distance(vLampXZ, uGrid.xy));' : ''}
        gl_FragColor.a = dot(gl_FragColor.rgb, vec3(1.0)) > 0.004 ? (vLampY + ${Y0}.0) / ${YSPAN}.0 : 0.0;`);
  };
  m.customProgramCacheKey = () => (grid ? 'lamp-quad-grid-v2' : 'lamp-quad-v2');
  return m;
}

// A plain material (a lamp's glowing head) that goes dark where the apagón has reached (shared.uGrid).
export function gridAware(m, key) {
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uGrid = shared.uGrid;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vGridXZ;')
      .replace('#include <project_vertex>', `#include <project_vertex>
        vec4 gridWorld = vec4(transformed, 1.0);
        #ifdef USE_INSTANCING
        gridWorld = instanceMatrix * gridWorld;
        #endif
        vGridXZ = (modelMatrix * gridWorld).xz;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vGridXZ;\nuniform vec4 uGrid;')
      .replace('#include <opaque_fragment>', `#include <opaque_fragment>
        if (uGrid.z >= 0.0) gl_FragColor.rgb *= mix(0.12, 1.0, smoothstep(uGrid.z - uGrid.w, uGrid.z, distance(vGridXZ, uGrid.xy)));`);
  };
  m.customProgramCacheKey = () => key;
  return m;
}

// Call once, before any material is compiled: teaches three's lit materials to read the light map.
export function installLampLight() {
  THREE.ShaderChunk.lights_pars_begin += /* glsl */ `
uniform float uLampOn;
uniform sampler2D uLampMap;
uniform vec4 uLampRect; // centre x, centre z, half size, 0
`;
  THREE.ShaderChunk.lights_fragment_end += /* glsl */ `
if (uLampOn > 0.5) {
  mat3 lampToWorld = transpose(mat3(viewMatrix));
  vec3 lampAt = cameraPosition + lampToWorld * geometryPosition;
  vec2 lampUv = vec2(lampAt.x - uLampRect.x, uLampRect.y - lampAt.z) / (2.0 * uLampRect.z) + 0.5;
  vec2 lampEdge = smoothstep(vec2(0.0), vec2(0.04), lampUv) * (1.0 - smoothstep(vec2(0.96), vec2(1.0), lampUv));
  #ifdef LAMP_SIDES
  float lampUp = mix(0.45, 1.0, smoothstep(-0.2, 0.7, (lampToWorld * geometryNormal).y)); // (the one you are: lit on its sides too)
  #else
  float lampUp = smoothstep(0.25, 0.7, (lampToWorld * geometryNormal).y);
  #endif
  vec4 lampTexel = texture2D(uLampMap, lampUv);
  float lampLevel = 1.0 - smoothstep(2.5, 5.0, abs(lampAt.y - (lampTexel.a * ${YSPAN}.0 - ${Y0}.0)));   // only light lying at this height
  reflectedLight.directDiffuse += lampTexel.rgb * lampEdge.x * lampEdge.y * lampUp * lampLevel * material.diffuseColor;
}
`;
  // Plain materials get the uniforms here. A material with a hook of its own sets them itself: lampUniforms
  // (shader) to take part, or uLampOn 0 and the map to stay out (buildings, vehicles: a roof is far above the
  // lamps). The map must always be given: a sampler left unset falls on texture unit 0, and if the material
  // has a texture of another kind there (the facades' texture arrays), nothing is drawn at all.
  THREE.Material.prototype.onBeforeCompile = function (shader) { lampUniforms(shader); };
}
export function lampUniforms(shader) {
  shader.uniforms.uLampOn = shared.uLampOn; shader.uniforms.uLampMap = shared.uLampMap; shader.uniforms.uLampRect = shared.uLampRect;
}
// The one you are (the walker, the helicopter; the car driven has its own, traffic.js): lit by the street lamps on
// its sides as well as from above, and at night the glow of the city along its edges, so its shape reads against
// the dark street.
export const HERO_RIM = 'pow(1.0 - saturate(dot(normal, normalize(vViewPosition))), 3.0) * uNight * vec3(0.16, 0.18, 0.24)';
export function heroLit(m) {
  m.defines = { ...m.defines, LAMP_SIDES: '' };
  m.onBeforeCompile = (shader) => {
    lampUniforms(shader); shader.uniforms.uNight = shared.uNight;
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uNight;')
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>\ntotalEmissiveRadiance += ${HERO_RIM};`);
  };
  m.customProgramCacheKey = () => 'hero-lit-v1';
  return m;
}

export class LampLight {
  constructor(renderer) {
    this.renderer = renderer;
    this.target = new THREE.WebGLRenderTarget(SIZE, SIZE, { type: THREE.HalfFloatType, depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 4000);
    this.camera.up.set(0, 0, -1);
    this.camera.layers.set(LAMP_LAYER);
    this.half = 0;
    this.black = new THREE.Color(0, 0, 0);
    shared.uLampMap.value = this.target.texture;
  }

  // scene: the scene holding the lamp quads; focus: what the view looks at; eye: the camera's position.
  update(scene, focus, eye, night) {
    shared.uLampOn.value = night > 0.02 ? 1 : 0;
    if (night <= 0.02) return;
    // the map reaches as far as the view does (in coarse steps), and moves a whole texel at a time
    const want = THREE.MathUtils.clamp(eye.distanceTo(focus) * 1.6, 350, 2400), half = 350 * 1.35 ** Math.ceil(Math.log(want / 350) / Math.log(1.35));
    const cam = this.camera;
    if (half !== this.half) { this.half = half; cam.left = cam.bottom = -half; cam.right = cam.top = half; cam.updateProjectionMatrix(); }
    const texel = (2 * half) / SIZE, cx = Math.round(focus.x / texel) * texel, cz = Math.round(focus.z / texel) * texel;
    cam.position.set(cx, focus.y + 2000, cz);
    cam.lookAt(cx, focus.y, cz);
    shared.uLampRect.value.set(cx, cz, half, 0);

    const r = this.renderer, shadows = r.shadowMap.autoUpdate, background = scene.background, previous = r.getRenderTarget();
    const clear = r.getClearColor(new THREE.Color()), alpha = r.getClearAlpha();
    r.shadowMap.autoUpdate = false; scene.background = null; // (only the lamp quads are of interest)
    r.setRenderTarget(this.target);
    r.setClearColor(this.black, 0);
    r.clear();
    r.render(scene, cam);
    r.setRenderTarget(previous);
    r.setClearColor(clear, alpha);
    r.shadowMap.autoUpdate = shadows; scene.background = background;
  }
}
