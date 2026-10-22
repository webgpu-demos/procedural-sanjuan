// The frame's post-processing: ambient occlusion, then the sky, the aerial perspective and volumetric clouds
// of @takram/three-atmosphere and @takram/three-clouds, then bloom and tone mapping. (pmndrs postprocessing:
// the takram effects are written for it.)
//
// The takram effects work in physical units on an Earth-centred frame. The scene keeps its own lights and its
// local frame: worldToECEFMatrix places it on the globe, and the colour buffer is scaled into their units
// before the effects and back after them.
import * as THREE from 'three';
import { EffectComposer, RenderPass, EffectPass, Effect, EffectAttribute, BloomEffect, ToneMappingEffect, ToneMappingMode, VignetteEffect, NoiseEffect, BlendFunction } from 'postprocessing';
import { N8AOPostPass } from 'n8ao';
import { WindowReflections } from './reflections.js';
import { shared } from './materials.js';
import { AerialPerspectiveEffect, PrecomputedTexturesGenerator, getSunDirectionECEF, getMoonDirectionECEF } from '@takram/three-atmosphere';
import { CloudsEffect, CLOUD_SHAPE_TEXTURE_SIZE, CLOUD_SHAPE_DETAIL_TEXTURE_SIZE } from '@takram/three-clouds';
import { DataTextureLoader, Ellipsoid, Geodetic, parseUint8Array, radians, STBNLoader } from '@takram/three-geospatial';

const ASSETS = 'assets/takram'; // cloud shape and weather textures and blue noise, as shipped with the packages
const UNITS = 0.1;              // scene radiance -> the radiance the atmosphere works in (a sunlit white wall in both)
const FADE = 500;                // metres beyond the area over which the clouds thin out to nothing
const SHADE = 0.42;             // what is left of a surface's light under a thick cloud: the sky still lights it

class Scale extends Effect {
  constructor(k) {
    super('Scale', 'uniform float k; void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) { outputColor = vec4(inputColor.rgb * k, inputColor.a); }',
      { uniforms: new Map([['k', new THREE.Uniform(k)]]) });
  }
}

// The sky in the dark hours: the physical sky all but vanishes once the sun is ten degrees down, which reads as
// a black void; twilight is a deep navy, lighter towards the horizon, with the brighter stars. Added where the
// depth says sky, as much as the night is dark (uNight).
class TwilightSky extends Effect {
  constructor(camera) {
    super('TwilightSky', `
      uniform mat4 uInvViewProj; uniform float uNight; uniform vec3 uSunDir; uniform vec3 uCam;
      float hash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
      void mainImage(const in vec4 inputColor, const in vec2 uv, const in float depth, out vec4 outputColor) {
        outputColor = inputColor;
        if (uNight <= 0.0) return;
        vec4 w = uInvViewProj * vec4(uv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
        vec3 hit = w.xyz / w.w, dir = normalize(hit - uCam);
        float up = clamp(dir.y, -0.05, 1.0);
        bool isSky = depth >= 0.99999;
        if (!isSky) {
          // the far ground and sea melt into the twilight horizon (the physical haze stays bright after dusk)
          // (lights shine through: only what is dim is darkened)
          float lum = dot(inputColor.rgb, vec3(0.3, 0.59, 0.11));
          float far = smoothstep(1500.0, 20000.0, distance(hit, uCam)) * uNight * 0.9 * (1.0 - smoothstep(0.35, 1.2, lum));
          outputColor.rgb = mix(inputColor.rgb, vec3(0.03, 0.05, 0.11) * 0.6, far);
          return;
        }
        // navy overhead, a paler blue at the horizon, warmer towards where the sun will rise
        vec3 sky = mix(vec3(0.035, 0.06, 0.13), vec3(0.008, 0.014, 0.04), smoothstep(0.0, 0.5, up));
        float east = max(0.0, dot(normalize(vec3(dir.x, 0.0, dir.z)), normalize(vec3(uSunDir.x, 0.0, uSunDir.z))));
        sky += vec3(0.09, 0.045, 0.03) * pow(east, 3.0) * (1.0 - smoothstep(0.0, 0.25, up)) * smoothstep(-0.35, -0.02, uSunDir.y);
        // stars: the brightest, fading in as it darkens
        vec3 cell = floor(dir * 420.0);
        float star = step(0.9975, hash(cell)) * smoothstep(0.05, 0.3, up) * smoothstep(0.55, 0.95, uNight);
        sky += vec3(star * (0.4 + 0.6 * hash(cell + 7.0)));
        outputColor.rgb = inputColor.rgb + sky * uNight * 0.6;
      }`, {
      attributes: EffectAttribute.DEPTH,
      uniforms: new Map([['uInvViewProj', new THREE.Uniform(new THREE.Matrix4())], ['uNight', shared.uNight], ['uSunDir', shared.uSunDir], ['uCam', new THREE.Uniform(new THREE.Vector3())]]),
    });
    this.camera = camera;
  }
  update() {
    this.uniforms.get('uInvViewProj').value.multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse).invert();
    this.uniforms.get('uCam').value.copy(this.camera.position);
  }
}

export class Atmosphere {
  // origin: { lon, lat } of the world origin; the world is x east, y up, z south.
  // bounds: { minX, maxX, minZ, maxZ } of the area; the clouds can be kept to the sky above it.
  constructor(renderer, scene, camera, origin, bounds) {
    this.renderer = renderer;
    renderer.toneMapping = THREE.NoToneMapping; // done by the last pass

    // ---- where the scene sits on the globe
    const position = new Geodetic(radians(origin.lon), radians(origin.lat), 0).toECEF();
    const east = new THREE.Vector3(), north = new THREE.Vector3(), up = new THREE.Vector3();
    Ellipsoid.WGS84.getEastNorthUpVectors(position, east, north, up);
    this.worldToECEF = new THREE.Matrix4().makeBasis(east, up, north.clone().negate()).setPosition(position);
    this.rotation = new THREE.Matrix3().setFromMatrix4(this.worldToECEF);

    // ---- sky and aerial perspective. The scene is lit by its own lights, so no post-process lighting;
    // the shadow of the clouds is laid over it instead (see below).
    const aerial = this.aerial = new AerialPerspectiveEffect(camera);
    aerial.sky = true;
    aerial.ground = false; // no dark planet below the horizon: beyond the area there is only sky
    aerial.worldToECEFMatrix.copy(this.worldToECEF);
    const hook = 'radiance = inputColor.rgb;\n  #endif // defined(SUN_LIGHT) || defined(SKY_LIGHT)';
    const source = aerial.getFragmentShader();
    if (source.includes(hook)) aerial.setFragmentShader(source.replace(hook, `radiance = inputColor.rgb * mix(${SHADE.toFixed(2)}, 1.0, sunTransmittance);\n  #endif // defined(SUN_LIGHT) || defined(SKY_LIGHT)`));
    else console.warn('atmosphere: the aerial perspective shader has changed; clouds will not shade the ground');
    // Blue all round: the area is an island in the sky, so a ray that leaves it downwards sees the sky mirrored
    // at the horizon (capped, so that no second sun appears below) instead of a planet's surface.
    const sky = `    outputColor.rgb = getSkyRadiance(
      vCameraPosition,
      rayDirection,`, lit = aerial.getFragmentShader();
    if (lit.includes(sky)) aerial.setFragmentShader(lit.replace(sky, `    vec3 skyUp = normalize(vCameraPosition);
    float skyBelow = min(dot(rayDirection, skyUp), 0.0);
    vec3 skyDirection = rayDirection - 2.0 * skyBelow * skyUp;
    outputColor.rgb = getSkyRadiance(
      vCameraPosition,
      skyDirection,`)
      .replace(`    outputColor.a = 1.0;
    #else // SKY`, `    if (skyBelow < 0.0) outputColor.rgb = min(outputColor.rgb, vec3(0.5));
    outputColor.a = 1.0;
    #else // SKY`));
    else console.warn('atmosphere: the sky shader has changed; the sky is not mirrored below the horizon');

    // ---- clouds: rendered into buffers that the aerial perspective composites
    const clouds = this.clouds = new CloudsEffect(camera);
    clouds.worldToECEFMatrix.copy(this.worldToECEF);
    clouds.coverage = 0.25;
    clouds.localWeatherVelocity.set(0.001, 0);
    this.base = 450; // metres: the foot of the low clouds (the library's default is 750)

    // Clouds over the area only. The library spreads its weather map over the whole globe; here the map is
    // faded out beyond the area's rectangle, in the cloud pass and in the pass that renders their shadow.
    this.cityRect = new THREE.Uniform(new THREE.Vector4(bounds.minX, bounds.minZ, bounds.maxX, bounds.maxZ));
    this.cityFade = new THREE.Uniform(FADE);
    const where = 'vec2 getGlobeUv(const vec3 position) {', mask = '  #ifdef SHADOW\n  localWeather *= shadowLayerMask;';
    for (const material of [clouds.cloudsPass.currentMaterial, clouds.shadowPass.currentMaterial]) {
      const src = material.fragmentShader;
      if (!src.includes(where) || !src.includes(mask)) { console.warn('atmosphere: the cloud shader has changed; clouds are not kept to the area'); continue; }
      material.fragmentShader = src
        .replace(where, `uniform vec4 cityRect;\nuniform float cityFade;\nvec3 cityPosition;\n${where}\n  cityPosition = position;`)
        .replace(mask, `  {\n    vec3 w = (ecefToWorldMatrix * vec4(cityPosition - altitudeCorrection, 1.0)).xyz;\n    vec2 d = max(cityRect.xy - w.xz, w.xz - cityRect.zw);\n    localWeather *= 1.0 - smoothstep(0.0, cityFade, max(d.x, d.y));\n  }\n${mask}`);
      material.uniforms.cityRect = this.cityRect;
      material.uniforms.cityFade = this.cityFade;
      material.needsUpdate = true;
    }
    const pass = (property) => {
      if (property === 'atmosphereOverlay') aerial.overlay = clouds.atmosphereOverlay;
      else if (property === 'atmosphereShadow') aerial.shadow = clouds.atmosphereShadow;
      else if (property === 'atmosphereShadowLength') aerial.shadowLength = clouds.atmosphereShadowLength;
    };
    clouds.events.addEventListener('change', (e) => pass(e.property));
    this.connect = () => ['atmosphereOverlay', 'atmosphereShadow', 'atmosphereShadowLength'].forEach(pass);

    // the atmosphere's lookup tables are computed here rather than downloaded
    const generator = new PrecomputedTexturesGenerator(renderer);
    this.ready = false; // (the sky is dark until the tables are done)
    generator.update().then(() => { this.ready = true; }).catch((e) => console.error(e));
    Object.assign(aerial, generator.textures);
    Object.assign(clouds, generator.textures);

    const repeat = (t) => { t.minFilter = THREE.LinearMipMapLinearFilter; t.magFilter = THREE.LinearFilter; t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.NoColorSpace; t.needsUpdate = true; };
    const volume = (size) => new DataTextureLoader(THREE.Data3DTexture, parseUint8Array, {
      width: size, height: size, depth: size, format: THREE.RedFormat, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
      wrapS: THREE.RepeatWrapping, wrapT: THREE.RepeatWrapping, wrapR: THREE.RepeatWrapping, colorSpace: THREE.NoColorSpace,
    });
    clouds.localWeatherTexture = new THREE.TextureLoader().load(`${ASSETS}/local_weather.png`, repeat);
    clouds.turbulenceTexture = new THREE.TextureLoader().load(`${ASSETS}/turbulence.png`, repeat);
    clouds.shapeTexture = volume(CLOUD_SHAPE_TEXTURE_SIZE).load(`${ASSETS}/shape.bin`);
    clouds.shapeDetailTexture = volume(CLOUD_SHAPE_DETAIL_TEXTURE_SIZE).load(`${ASSETS}/shape_detail.bin`);
    const stbn = new STBNLoader().load(`${ASSETS}/stbn.bin`);
    clouds.stbnTexture = stbn; aerial.stbnTexture = stbn;

    // The same sky without clouds, for when they are switched off: the cloud passes then cost nothing.
    const plain = this.plain = new AerialPerspectiveEffect(camera);
    plain.sky = true;
    plain.ground = false;
    plain.worldToECEFMatrix.copy(this.worldToECEF);
    plain.setFragmentShader(aerial.getFragmentShader());
    Object.assign(plain, generator.textures);
    plain.stbnTexture = stbn;

    // ---- the passes
    this.composer = new EffectComposer(renderer, { frameBufferType: THREE.HalfFloatType, multisampling: 0 });
    this.composer.addPass(new RenderPass(scene, camera));
    // window glass reflects what is on screen (first of all: it reads the panes marked in the alpha channel)
    this.reflections = new WindowReflections(camera);
    this.reflectionPass = new EffectPass(camera, this.reflections);
    this.composer.addPass(this.reflectionPass);
    // ambient occlusion: contact shading between buildings and the ground
    this.ao = new N8AOPostPass(scene, camera, innerWidth, innerHeight);
    Object.assign(this.ao.configuration, { aoRadius: 7, distanceFalloff: 1, intensity: 2.6, halfRes: true, gammaCorrection: false });
    this.ao.configuration.color = new THREE.Color(0.02, 0.02, 0.03);
    this.composer.addPass(this.ao);
    // (each scale in a pass of its own: within one pass, postprocessing runs the effects that read depth first)
    this.composer.addPass(new EffectPass(camera, new Scale(UNITS)));
    this.cloudPass = new EffectPass(camera, clouds, aerial);
    this.composer.addPass(this.cloudPass);
    this.skyPass = new EffectPass(camera, plain);
    this.composer.addPass(this.skyPass);
    this.composer.addPass(new EffectPass(camera, new Scale(1 / UNITS)));
    this.bloom = new BloomEffect({ intensity: 0.5, luminanceThreshold: 0.9, luminanceSmoothing: 0.2, mipmapBlur: true });
    // the film: a soft vignette and a fine grain over the tone-mapped picture (the experience turns them up for its shots)
    this.twilight = new TwilightSky(camera);
    this.vignette = new VignetteEffect({ offset: 0.32, darkness: 0.38 });
    this.grain = new NoiseEffect({ blendFunction: BlendFunction.OVERLAY, premultiply: false });
    this.grain.blendMode.opacity.value = 0.05;
    this.composer.addPass(new EffectPass(camera, this.twilight, this.bloom, new ToneMappingEffect({ mode: ToneMappingMode.ACES_FILMIC }), this.vignette, this.grain));
    this.connect();
    this.sun = new THREE.Vector3(); this.moon = new THREE.Vector3();
    this.cloudsOn = false; // volumetric clouds are heavy: off until asked for
  }

  get cloudsOn() { return this.cloudPass.enabled; }
  set cloudsOn(v) { this.cloudPass.enabled = v; this.skyPass.enabled = !v; }
  get reflect() { return this.reflectionPass.enabled; }
  set reflect(v) { this.reflectionPass.enabled = v; }
  get coverage() { return this.clouds.coverage; }
  set coverage(v) { this.clouds.coverage = v; }
  // Altitude of the base of the two low cloud layers (the second starts 250 m above the first, as by default).
  get base() { return this.clouds.cloudLayers[0].altitude; }
  set base(v) { this.clouds.cloudLayers[0].altitude = v; this.clouds.cloudLayers[1].altitude = v + 250; }
  // clouds over the area only, or over the whole sky
  get overCity() { return this.cityFade.value < 1e6; }
  set overCity(v) { this.cityFade.value = v ? FADE : 1e9; }
  get quality() { return this.clouds.qualityPreset; }
  set quality(v) { this.clouds.qualityPreset = v; }

  // Puts the sun and the moon where they stand over the area at `date`. Returns their directions in world
  // space (unit vectors, y up) for the scene's own light.
  setDate(date) {
    getSunDirectionECEF(date, this.sun);
    getMoonDirectionECEF(date, this.moon);
    for (const fx of [this.aerial, this.plain]) { fx.sunDirection.copy(this.sun); fx.moonDirection.copy(this.moon); }
    this.clouds.sunDirection.copy(this.sun);
    // world -> ECEF is a rotation: its transpose brings a direction back
    const toWorld = this.toWorld ??= this.rotation.clone().transpose();
    return { sun: this.sun.clone().applyMatrix3(toWorld), moon: this.moon.clone().applyMatrix3(toWorld) };
  }

  setSize(w, h) { this.composer.setSize(w, h); }
  render(dt) { this.composer.render(dt); }
}
