// Sky, sun, image-based ambient light and the day/night blend. (No fog: the whole area is loaded and seen clearly.)
import * as THREE from 'three';
import { createSky, SKY } from './sky.js';
import { shared } from './materials.js';

const SHADOW_SIZE = 4096;

const DAY = { hemi: 0.55, sun: 3.4, sunColor: new THREE.Color(0xfff0dc), env: 1.0, exposure: 0.82, bloom: 0.12,
  sky: new THREE.Color(0xfff4e6), ground: new THREE.Color(0x8a8172) };
// (a dark night: the city is its lights, the walls and roofs only a little moonlit blue)
const NIGHT = {
  hemi: 0.13, sun: 0.18, sunColor: new THREE.Color(0x9fb4e0),
  env: 0.4, exposure: 1.15, bloom: 0.45, sky: new THREE.Color(0x6f86b8), ground: new THREE.Color(0x1c2230),
};

const SUNSET = new THREE.Color(0xff9a52);
const MOON_STAND_IN = new THREE.Vector3().setFromSphericalCoords(1, THREE.MathUtils.degToRad(90 - 40), THREE.MathUtils.degToRad(205));

export class Environment {
  constructor(scene, renderer) {
    this.scene = scene;
    this.renderer = renderer;
    this.night = 0;  // how far the city's lights are on: they come on while it is still light
    this.dark = 0;   // how dark it is: this follows the sun all the way down through twilight
    // how dark the sky's light is (the ambient and the environment map): faster than `dark`. The sky the atmosphere
    // draws (atmosphere.js) has lost most of its light by the time the sun is down; the environment map's sky
    // (sky.js) kept three quarters of the day's, and at 6:14, five minutes before sunrise, the open ground lay
    // pale blue under a dark violet sky, as if under snow
    this.shade = 0;
    this.daylight = 1; this.moonlight = 0; this.warmth = 0; this.elevation = 40;
    this.time = 0;
    this.cloudCover = 0; // the sky's cloud cover as the atmosphere draws it (setClouds)
    this.sunDir = new THREE.Vector3().setFromSphericalCoords(1, THREE.MathUtils.degToRad(90 - 40), THREE.MathUtils.degToRad(205));

    this.sky = createSky();
    this.sky.material.uniforms.uSunDir.value.copy(this.sunDir);
    scene.add(this.sky);

    // Environment map: the same sky without the sun disc (the sun is the directional light).
    this.pmrem = new THREE.PMREMGenerator(renderer);
    this.envScene = new THREE.Scene();
    this.envSky = createSky({ sunDisc: 0, ground: SKY.ground });
    this.envSky.material.uniforms.uSunDir.value.copy(this.sunDir);
    this.envScene.add(this.envSky);
    this.bakeEnvironment();

    this.hemi = new THREE.HemisphereLight(DAY.sky, DAY.ground);
    scene.add(this.hemi);

    this.sun = new THREE.DirectionalLight();
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(SHADOW_SIZE, SHADOW_SIZE);
    const c = this.sun.shadow.camera;
    c.near = 10; c.far = 4000;
    this.shadowExtent = 0;
    this.sun.shadow.bias = -0.0003;
    this.sun.shadow.normalBias = 0.5;
    scene.add(this.sun, this.sun.target);

    this.apply();
  }

  // Renders the environment map for the sky as dark as it now is (again whenever that has changed a little).
  // The map's sky follows the real one: its sun where the sun is, the colours of a sunset when it is low, clouds
  // only when the atmosphere draws clouds (else the water and the glass mirrored clouds the sky did not have).
  bakeEnvironment() {
    this.baked = this.shade;
    const u = this.envSky.material.uniforms;
    u.uNight.value = this.baked;
    u.uSunDir.value.copy(shared.uSunDir.value);
    u.uWarm.value = this.warmth * (this.afterglow ?? 1);
    u.uCloudCover.value = this.cloudCover;
    this.bakedSun = u.uSunDir.value.clone(); this.bakedWarm = u.uWarm.value; this.bakedCover = this.cloudCover;
    const old = this.scene.environment;
    this.scene.environment = this.pmrem.fromScene(this.envScene, 0, 0.1, 10).texture;
    old?.dispose();
  }

  // sun, moon: unit vectors towards them (world space). The light is the sun by day — dimmer and warmer as it
  // sinks — and the moon by night (or a stand-in for it while the moon is down); the change of direction
  // happens around sunset, when neither casts a shadow to speak of.
  setSky(sun, moon) {
    const deg = THREE.MathUtils.radToDeg(Math.asin(THREE.MathUtils.clamp(sun.y, -1, 1))), step = THREE.MathUtils.smoothstep;
    this.elevation = deg;
    // Dusk in order: the lights come on as the sun nears the horizon and are all on when it sets; the dark
    // then comes slowly, with the sun, until the end of nautical twilight (and the other way round at dawn).
    this.night = 1 - step(deg, 0, 9);
    this.dark = 1 - step(deg, -13, 5);
    this.shade = Math.max(this.dark, Math.min(0.9, 1 - step(deg, -8, 6))); // (the last tenth with `dark`: a city still shows against the dawn)
    // how much of the sun's light arrives: none while it is below the horizon (the afterglow is the sky's light,
    // `shade`). It had come from five degrees down, from a sun held three degrees up: light grazing the ground
    // before sunrise, every gentle swell of the terrain shaded as on a satin sheet, the grass bright lime
    this.daylight = step(deg, -1, 8);
    this.afterglow = step(deg, -5, 9);         // and the sky's sunrise or sunset colours round where it is
    this.moonlight = 1 - step(deg, -14, -5.5);
    this.warmth = 1 - step(deg, 3, 24);        // 1 at the horizon: orange light
    if (deg > -5.5) this.sunDir.copy(sun).setY(Math.max(sun.y, 0.06)).normalize(); // (never quite grazing: shadows stay finite)
    else if (moon.y > 0.2) this.sunDir.copy(moon);
    else this.sunDir.copy(MOON_STAND_IN);
    shared.uSunDir.value.copy(sun);
    shared.uSunGlint.value.copy(DAY.sunColor).lerp(SUNSET, this.warmth).multiplyScalar(this.daylight * 3);
    this.apply();
    const moved = this.bakedSun && shared.uSunDir.value.angleTo(this.bakedSun) > 0.035, warmer = Math.abs(this.warmth * this.afterglow - this.bakedWarm) > 0.04;
    if (moved || warmer || Math.abs(this.shade - this.baked) > 0.04 || (this.shade !== this.baked && (this.shade === 0 || this.shade === 1))) this.bakeEnvironment();
  }

  // The atmosphere's clouds (cover 0 when it draws none), for the sky of the environment map.
  setClouds(cover) {
    this.cloudCover = cover;
    if (Math.abs(cover - (this.bakedCover ?? 0)) > 0.05 || (cover === 0) !== ((this.bakedCover ?? 0) === 0)) this.bakeEnvironment();
  }

  // The sky follows the camera; the shadow frustum follows the focus, snapped to texels so shadows do not shimmer.
  follow(focus, camera) {
    this.sky.position.copy(camera.position);
    // Shadow coverage grows with the viewing distance (in coarse steps, so it rarely changes).
    const want = THREE.MathUtils.clamp(camera.position.distanceTo(focus) * 1.1, 220, 1800);
    const extent = 220 * 1.3 ** Math.ceil(Math.log(want / 220) / Math.log(1.3));
    if (extent !== this.shadowExtent) {
      this.shadowExtent = extent;
      const c = this.sun.shadow.camera;
      c.left = c.bottom = -extent; c.right = c.top = extent;
      c.updateProjectionMatrix();
      this.sun.shadow.normalBias = 0.25 + extent / 900;
    }
    const texel = (2 * extent) / SHADOW_SIZE;
    const fx = Math.round(focus.x / texel) * texel, fz = Math.round(focus.z / texel) * texel;
    this.sun.target.position.set(fx, focus.y, fz);
    this.sun.position.copy(this.sun.target.position).addScaledVector(this.sunDir, 2000);
  }

  update(dt) {
    this.time += dt;
    this.sky.material.uniforms.uTime.value = this.time;
  }

  apply() {
    const t = this.dark, lerp = (a, b, k = t) => a + (b - a) * k, sh = this.shade;
    this.sky.material.uniforms.uNight.value = t;
    this.hemi.intensity = lerp(DAY.hemi, NIGHT.hemi, sh);
    this.hemi.color.copy(DAY.sky).lerp(NIGHT.sky, sh); this.hemi.groundColor.copy(DAY.ground).lerp(NIGHT.ground, sh);
    this.sun.intensity = DAY.sun * this.daylight + NIGHT.sun * this.moonlight;
    this.sun.color.copy(DAY.sunColor).lerp(SUNSET, this.warmth).lerp(NIGHT.sunColor, this.moonlight);
    this.scene.environmentIntensity = lerp(DAY.env, NIGHT.env, sh); // (the map itself darkens with the sky)
    this.renderer.toneMappingExposure = lerp(DAY.exposure, NIGHT.exposure, sh); // (the eye opens as the sky's light goes)
    this.bloom = lerp(DAY.bloom, NIGHT.bloom);
    shared.uNight.value = this.night;
    shared.uDark.value = this.dark;
  }
}
