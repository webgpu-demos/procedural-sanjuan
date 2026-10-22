// Procedural San Juan client: streams the compiled city and renders it. Free camera for now; the car comes next.
//
// URL parameters: ?area=condado (default: sanjuan)  ?time=18.5 (San Juan hour; default: now; the simulated morning if there is one)  ?sim=0  ?scenario=apagon  ?rate=60  ?night=1  ?cam=x,z,distance,azimuthDeg,elevationDeg  ?radius=3000  ?traffic=0  ?ortho=0  ?clouds=0.25 (on, with that cover)  ?birds=150  ?cars=600
import * as THREE from 'three';
import { MapControls } from 'three/addons/controls/MapControls.js';
import GUI from 'lil-gui';
import { makeProjection } from './shared/geo.js';
import { createMaterials, shared } from './world/materials.js';
import { loadTextures } from './world/textures.js';
import { Streamer } from './world/streamer.js';
import { Props } from './world/props.js';
import { Signs } from './world/signs.js';
import { buildRailways } from './world/rails.js';
import { buildFlyovers } from './world/flyovers.js';
import { Traffic, MAX_CARS } from './world/traffic.js';
import { SimTraffic } from './world/simtraffic.js';
import { SimSignals } from './world/simsignals.js';
import { Experience } from './experience.js';
import { SpeedMap } from './world/speedmap.js';
import { Ferries } from './world/ferries.js';
import { buildStructures } from './world/structures.js';
import { loadOrtho } from './world/ortho.js';
import { buildSurroundings } from './world/far.js';
import { renderSources } from './sources.js';
import { Environment } from './world/environment.js';
import { Atmosphere } from './world/atmosphere.js';
import { createBirds, MAX_BIRDS } from './world/birds.js';
import { LampLight, installLampLight } from './world/lamplight.js';

installLampLight(); // (before any material is compiled)

const params = new URLSearchParams(location.search);
// (Old San Juan was an area of its own, around the same origin: its links, views included, open in the municipality)
const ALIASES = { viejosanjuan: 'sanjuan' };
const AREA = ALIASES[params.get('area')] ?? params.get('area') ?? 'sanjuan';

// The loading screen (index.html): the city's name, a bar and what is being done.
const loader = {
  el: document.getElementById('loader'),
  show(city, step = '') { this.el.classList.remove('done'); if (city) this.el.querySelector('.city').textContent = city; this.set(0, step); },
  set(fraction, step) { this.el.querySelector('.fill').style.width = `${Math.round(fraction * 100)}%`; if (step != null) this.el.querySelector('.step').textContent = step; },
  hide() { this.el.classList.add('done'); },
};
loader.show(null, 'textures'); // (index.html has already written the city's name)
const USAGE = {
  401: 'office', 402: 'commercial', 403: 'hotel', 404: 'commercial complex', 411: 'house', 412: 'apartments',
  413: 'house + shop', 414: 'shops + homes', 415: 'house + workshop', 421: 'government', 422: 'school / hospital / church / culture',
  431: 'transport / warehouse', 441: 'industrial', 452: 'utility', 454: 'fortification / other', 461: 'unknown',
};

// ---------------------------------------------------------------- renderer, scene, camera
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.shadowMap.enabled = true;
renderer.info.autoReset = false; // the composer renders several passes; count the whole frame
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 1, 60000);
const controls = new MapControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.12;
controls.maxPolarAngle = THREE.MathUtils.degToRad(88);
controls.minDistance = 8;
controls.maxDistance = 3500;
controls.enableZoom = false; // the wheel is handled below, with inertia

const env = new Environment(scene, renderer);
// Time of day, as San Juan's clock (Atlantic Standard Time all year, AST = UTC - 4 h): the real time, or an hour set by hand.
const clockTime = {
  live: params.get('time') == null && params.get('night') !== '1',
  hour: params.get('time') != null ? Number(params.get('time')) : params.get('night') === '1' ? 22 : 12,
  // the moment on today's San Juan date at which its clock shows `hour`
  date() {
    const AST = -4 * 3600e3, now = Date.now();
    if (this.live) { const t = new Date(now + AST); this.hour = t.getUTCHours() + t.getUTCMinutes() / 60 + t.getUTCSeconds() / 3600; return new Date(now); }
    const midnight = Math.floor((now + AST) / 864e5) * 864e5 - AST;
    return new Date(midnight + this.hour * 3600e3);
  },
  // the hour and the minute on their own, for the panel; setting either stops the live clock
  get h() { return Math.floor(this.hour) % 24; },
  set h(v) { this.live = false; this.hour = v + this.m / 60; },
  get m() { return Math.floor((this.hour % 1) * 60 + 1e-6); },
  set m(v) { this.live = false; this.hour = this.h + v / 60; },
  label() { const h = this.h, m = this.m; return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`; },
  // how fast a set hour runs on: 0 stands still, 1 is real time, 60 a minute a second
  rate: Number(params.get('rate') ?? 0),
  tick(dt) { if (!this.live && this.rate) this.hour = (this.hour + (dt * this.rate) / 3600 + 24) % 24; },
};

const materials = createMaterials(await loadTextures(renderer));
const props = new Props();
const signs = new Signs();
const streamer = new Streamer(scene, materials, props, signs, { base: `tiles/${AREA}`, radius: Number(params.get('radius')) || 1e5 });
const VIEW_RADIUS = 1000; // metres: full tiles around the focus, when the whole city is not loaded at once
loader.set(0.08, 'terrain');
const manifest = await streamer.init();
// A large area (the whole municipality) streams: full detail around the view, plain blocks out to 7 km, the
// photo-draped ground beyond (far.js). It is never loaded whole.
const LARGE = manifest.stream != null || manifest.tiles.length > 600;
if (LARGE) {
  streamer.radius = Number(params.get('radius')) || manifest.stream || VIEW_RADIUS;
  streamer.blockRadius = manifest.blockRadius ?? 7000;
  controls.maxDistance = 9000;
}
loader.set(0.14, 'railways and roads');
const proj = makeProjection(manifest.origin.lon, manifest.origin.lat);
// Beyond the area: the rest of the island (far.js) over the sea, out to the haze of the horizon; without the
// surroundings, plain ground in the grey of the area's own unbuilt land unless the area has a coast.
{
  const b = manifest.bounds, coastal = manifest.sea != null || manifest.far != null;
  const plain = new THREE.Mesh(new THREE.CircleGeometry(50000, 64).rotateX(-Math.PI / 2), coastal ? materials.sea
    : new THREE.MeshStandardMaterial({ color: 0x8a8a86, roughness: 0.95, metalness: 0 }));
  plain.position.set((b.minX + b.maxX) / 2, coastal ? (manifest.sea ?? 0) - 0.15 : manifest.terrain.min - 1, (b.minZ + b.maxZ) / 2); // just under the sea in the tiles, or the lowest ground
  plain.receiveShadow = true;
  plain.name = 'plain';
  scene.add(plain);
}
// the ground of the tiles not loaded, and of the island around the area (far.js)
buildSurroundings(`tiles/${AREA}`, `ortho/${AREA}/far`, manifest, proj).then((far) => far && scene.add(far));
const birds = createBirds(manifest.bounds, streamer.ground(0, 0));
if (params.get('birds') != null) birds.geometry.instanceCount = Math.min(MAX_BIRDS, Number(params.get('birds')) || 0);
scene.add(birds);
const lampLight = new LampLight(renderer);
// post-processing: ambient occlusion, sky, aerial perspective, volumetric clouds, bloom, tone mapping
const atmosphere = new Atmosphere(renderer, scene, camera, manifest.origin, manifest.bounds);
env.sky.visible = false; // the atmosphere draws the sky (the environment map keeps its own)
const ao = atmosphere.ao;
if (params.get('reflect') === '0') atmosphere.reflect = false;
if (Number(params.get('clouds')) > 0) { atmosphere.coverage = Number(params.get('clouds')); atmosphere.cloudsOn = true; }
let orthoLoaded = false, orthoWanted = true; // (the photo fills in when the tiles arrive; the panel may have switched it off by then)
if (params.get('ortho') !== '0') loadOrtho(`ortho/${AREA}`, proj, manifest.extent ?? manifest.bounds, renderer).then((ok) => { orthoLoaded = ok; shared.uOrthoOn.value = ok && orthoWanted ? 1 : 0; });
const railways = await buildRailways(`tiles/${AREA}/${manifest.rails}`, (x, z) => streamer.ground(x, z), streamer.cover);
scene.add(railways);
scene.add(await buildFlyovers(`tiles/${AREA}/${manifest.roads}`, (x, z) => streamer.ground(x, z)));
if (manifest.structures) scene.add(await buildStructures(`tiles/${AREA}/${manifest.structures}`, (x, z) => streamer.ground(x, z)));
const roads = await (await fetch(`tiles/${AREA}/${manifest.roads}`)).json();
const traffic = new Traffic(roads, streamer.surface);
if (params.get('cars') != null) traffic.count = Math.min(MAX_CARS, Number(params.get('cars')) || 0);
if (params.get('traffic') !== '0') scene.add(traffic.group);
// The simulated morning (tools/sim): every car a trip SUMO drove. Without a time in the link it opens on it,
// running in real time from before dawn.
let sim = params.get('sim') === '0' ? null : await SimTraffic.load(`tiles/${AREA}/sim/${params.get('scenario') || 'morning'}`, streamer.surface, roads, (x, z) => streamer.ground(x, z));
// its signals: the heads at the junctions show what the simulation's lights showed (before any tile is built)
const simSignals = sim && await fetch(`${sim.base}/signals.json`).then((r) => (r.ok ? r.json() : null)).then((j) => j && new SimSignals(j, roads)).catch(() => null);
if (simSignals) { props.signalSlot = (x, z, rot) => simSignals.slot(x, z, rot); props.mats.lens.uniforms.uSig.value = simSignals.texture; }
if (sim) {
  scene.add(sim.group);
  if (params.get('time') == null && params.get('night') !== '1') { clockTime.live = false; clockTime.hour = 5.45; }
  if (params.get('rate') == null) clockTime.rate = 1;
}
const simOn = () => sim && clockTime.hour * 3600 >= sim.begin && clockTime.hour * 3600 < sim.end;
// the jam map: the main roads coloured by the simulation's speeds
const speedMap = sim && await fetch(`${sim.base}/speeds.bin`).then((r) => (r.ok ? r.arrayBuffer() : null)).then((b) => b && new SpeedMap(sim.index, b, roads, (x, z) => streamer.ground(x, z))).catch(() => null);
if (speedMap) scene.add(speedMap.mesh);
// the lancha across the bay, on its timetable
const ferries = sim && await Ferries.load(`tiles/${AREA}/sim/ferries.json`);
if (ferries) scene.add(ferries.group);
// Another run of the morning (the apagón): its cars and its signals in place of the current ones.
async function setScenario(name) {
  const next = await SimTraffic.load(`tiles/${AREA}/sim/${name}`, streamer.surface, roads, (x, z) => streamer.ground(x, z));
  if (!next) return false;
  const lights = await fetch(`${next.base}/signals.json`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  if (sim) { scene.remove(sim.group); next.followed = sim.followed; sim.dispose(); }
  next.headlights = sim?.headlights ?? next.headlights;
  sim = next; scene.add(sim.group);
  if (lights && simSignals) simSignals.setTimeline(lights.timeline);
  const speeds = await fetch(`${sim.base}/speeds.bin`).then((r) => (r.ok ? r.arrayBuffer() : null)).catch(() => null);
  if (speeds && speedMap) speedMap.setSpeeds(sim.index, speeds);
  return true;
}
// the data sources: the button at the bottom opens the list of everything the city is made from (sources.js)
{
  const list = document.getElementById('sources-list'), toggle = document.getElementById('sources-toggle');
  const show = (open) => { list.hidden = !open; toggle.setAttribute('aria-expanded', String(open)); };
  renderSources(list, manifest.compiled);
  toggle.addEventListener('click', () => show(list.hidden));
  addEventListener('keydown', (e) => { if (e.key === 'Escape' && !list.hidden) show(false); });
}

// initial view: the area's own (manifest.view), or over the origin
const [cx, cz, dist, az, el] = (params.get('cam') || (manifest.view ?? [0, 0, 600, 200, 32]).join(',')).split(',').map(Number);
controls.target.set(cx, streamer.ground(cx, cz), cz);
camera.position.copy(controls.target).add(new THREE.Vector3().setFromSphericalCoords(
  dist, THREE.MathUtils.degToRad(90 - el), THREE.MathUtils.degToRad(az)));
controls.update();

// ---------------------------------------------------------------- control panel
let guiState, clockText, guiPanel;
{
  // the compiled areas (tools/pipeline/compile.mjs keeps the list); another city is another page load
  const areas = await fetch('tiles/areas.json').then((r) => (r.ok ? r.json() : null)).catch(() => null) ?? [{ id: AREA, name: manifest.name }];
  const trains = railways.userData.trains.group, AO = ao.configuration.intensity;
  const state = {
    city: AREA,
    get info() { return document.getElementById('hud').style.display !== 'none'; }, set info(v) { document.getElementById('hud').style.display = v ? '' : 'none'; },

    get traffic() { return !!traffic.group.parent; }, set traffic(v) { if (v) scene.add(traffic.group); else scene.remove(traffic.group); },
    get trains() { return trains.visible; }, set trains(v) { trains.visible = v; },
    get photo() { return orthoWanted; }, set photo(v) { orthoWanted = v; shared.uOrthoOn.value = v && orthoLoaded ? 1 : 0; },
    get shadows() { return env.sun.castShadow; }, set shadows(v) { env.sun.castShadow = v; },
    get occlusion() { return ao.configuration.intensity > 0; }, set occlusion(v) { ao.configuration.intensity = v ? AO : 0; },
    bloom: true,
    // the whole city at once, or only what lies within the view radius of the point looked at (fewer tiles: more frames)
    wholeCity: !params.get('radius') && !LARGE, near: Number(params.get('radius')) || (LARGE ? streamer.radius : VIEW_RADIUS),
    get whole() { return this.wholeCity; }, set whole(v) { this.wholeCity = v && !LARGE; streamer.radius = this.wholeCity ? 1e5 : this.near; },
    get radius() { return this.near; }, set radius(v) { this.near = v; if (!this.wholeCity) streamer.radius = v; },
  };
  guiState = state;
  // the names of the cities, for the loading screen of the next visit (index.html reads them)
  try { for (const a of areas) localStorage.setItem(`procedural-sanjuan:name:${a.id}`, a.name); } catch { /* storage unavailable */ }
  const gui = new GUI({ title: 'Scene' });
  guiPanel = gui;
  gui.add({ share: () => shareView() }, 'share').name('copy link to this view');
  if (innerWidth < 700) gui.close(); // (on a phone the open panel would cover the city: one tap on its title opens it)
  gui.add(state, 'city', Object.fromEntries(areas.map((a) => [a.name, a.id]))).onChange((id) => {
    const url = new URL(location.href);
    url.search = '';
    url.searchParams.set('area', id);
    loader.show(areas.find((a) => a.id === id)?.name ?? id, 'leaving for the next city');
    setTimeout(() => { location.href = url.href; }, 60); // (let the screen appear first)
  });
  const time = gui.addFolder('Time (San Juan)');
  time.add(clockTime, 'live').name('live clock').listen();
  // one slider over the day, with the clock time written beside it in place of the number box
  const slider = time.add(clockTime, 'hour', 0, 24, 1 / 60).name('time').listen().onChange(() => { clockTime.live = false; });
  slider.$input.style.display = 'none';
  clockText = document.createElement('span');
  clockText.style.cssText = 'min-width: 3.4em; padding-left: 8px; text-align: right; font-variant-numeric: tabular-nums;';
  slider.$widget.appendChild(clockText);
  if (sim) {
    const f = gui.addFolder('Simulated morning');
    f.add(clockTime, 'rate', { paused: 0, 'real time': 1, '×4': 4, '×15': 15, '×60': 60, '×240': 240 }).name('time speed').listen();
    f.add({ ride: () => rideRandom() }, 'ride').name('ride with a car');
    f.add({ stop: () => stopRiding() }, 'stop').name('stop riding');
    f.add(sim, 'headlights', 0, 20, 0.5).name('car headlights');
  }
  gui.add(state, 'traffic');
  gui.add(traffic, 'count', 0, MAX_CARS, 10).name('cars');
  gui.add(traffic, 'highway', 0, 20, 0.5).name('highway traffic');
  gui.add(traffic, 'headlights', 0, 20, 0.5).name('car headlights');
  gui.add(state, 'trains');
  gui.add(state, 'photo').name('aerial photo').listen();
  gui.add(birds.geometry, 'instanceCount', 0, MAX_BIRDS, 10).name('birds');
  gui.add(state, 'info').name('info panel');
  const sky = gui.addFolder('Clouds');
  sky.add(atmosphere, 'cloudsOn').name('clouds');
  sky.add(atmosphere, 'coverage', 0, 1, 0.05);
  sky.add(atmosphere, 'base', 200, 2000, 50).name('base altitude (m)');
  sky.add(atmosphere, 'overCity').name('over the city only');
  sky.add(atmosphere, 'quality', ['low', 'medium', 'high', 'ultra']);
  sky.add(atmosphere.clouds.localWeatherVelocity, 'x', 0, 0.02, 0.0005).name('wind');
  const rooms = gui.addFolder('Night windows');
  rooms.add(shared.uWindowLife.value, 'x', 0, 1, 0.05).name('rooms that change');
  rooms.add(shared.uWindowLife.value, 'y', 0.2, 30, 0.1).name('pace');
  rooms.add(shared.uCityGlass, 'value', 0, 3, 0.05).name('city in tower glass');
  rooms.add(shared.uNightBlue, 'value', 0, 1, 0.05).name('blue lights');
  const quality = gui.addFolder('Rendering');
  if (!LARGE) quality.add(state, 'whole').name('whole city');
  quality.add(state, 'radius', 300, 3000, 50).name('view radius (m), if not');
  quality.add(atmosphere, 'reflect').name('window reflections');
  quality.add(shared.uGlintOn, 'value', 0, 1, 1).name('sun in the windows');
  quality.add(state, 'shadows');
  quality.add(state, 'occlusion').name('ambient occlusion');
  quality.add(state, 'bloom');

  // The panel's settings are kept (in this browser) and are the same for every city: what is switched off in
  // one is off in the next. A URL that sets something itself (?time=, ?cars=, ...) is taken as it stands.
  const KEY = 'procedural-sanjuan:settings';
  // (a shared view link carries the camera and perhaps the hour: those do not count as settings)
  const explicit = [...params.keys()].some((k) => !['area', 'cam', 'time'].includes(k));
  const strip = (saved) => { delete saved.controllers?.city; return saved; }; // (the city is the page's, not a setting)
  if (!explicit) {
    try {
      const saved = JSON.parse(localStorage.getItem(KEY) ?? 'null');
      if (saved) {
        gui.load(strip(saved));
        // (loading the time moved the slider, which stops the live clock: put the saved choice back)
        const live = saved.folders?.['Time (San Juan)']?.controllers?.['live clock'];
        if (live != null) clockTime.live = live;
        if (params.get('time') != null) { clockTime.live = false; clockTime.hour = Number(params.get('time')); } // (the link's hour wins)
        else if (sim) { clockTime.live = false; clockTime.hour = 5.45; } // (the simulated morning opens before dawn)
      }
    } catch (e) { console.warn('settings not restored:', e.message); }
  }
  const keep = () => { try { localStorage.setItem(KEY, JSON.stringify(strip(gui.save()))); } catch { /* storage unavailable: nothing is kept */ } };
  gui.onFinishChange(keep);
  addEventListener('pagehide', keep);
}

// ---------------------------------------------------------------- view links
// The address follows the camera (?area=&cam=x,z,distance,azimuth,elevation, and the hour when it is set by
// hand), so the address bar always holds a link to what is on the screen.
const viewSpherical = new THREE.Spherical();
function viewLink() {
  viewSpherical.setFromVector3(new THREE.Vector3().subVectors(camera.position, controls.target));
  const az = ((THREE.MathUtils.radToDeg(viewSpherical.theta) % 360) + 360) % 360, el = 90 - THREE.MathUtils.radToDeg(viewSpherical.phi);
  const url = new URL(location.href);
  url.searchParams.set('area', AREA);
  url.searchParams.set('cam', [controls.target.x, controls.target.z, viewSpherical.radius, az, el].map((v) => Math.round(v)).join(','));
  if (clockTime.live) url.searchParams.delete('time'); else url.searchParams.set('time', clockTime.hour.toFixed(2));
  url.searchParams.delete('night'); // (the hour says it)
  return url.href.replace(/%2C/g, ','); // (commas are fine in a query: keep the link readable)
}
let linkWritten = 0, lastLink = '';
function updateViewLink(now) {
  if (now - linkWritten < 600) return;
  linkWritten = now;
  const link = viewLink();
  if (link !== lastLink) { lastLink = link; history.replaceState(null, '', link); }
}
const toast = document.getElementById('toast');
function shareView() {
  const link = viewLink();
  const done = (text) => { toast.textContent = text; toast.classList.add('on'); clearTimeout(toast.timer); toast.timer = setTimeout(() => toast.classList.remove('on'), 1800); };
  navigator.clipboard?.writeText(link).then(() => done('Link to this view copied'), () => done(link)) ?? done(link);
}

// ---------------------------------------------------------------- input
const keys = new Set();
const MOVE_KEYS = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);
addEventListener('keydown', (e) => {
  const el = document.activeElement, typing = el?.tagName === 'INPUT' && (el.type === 'text' || el.type === 'number');
  if (typing) return; // a number being typed into the panel
  // A panel control that was clicked keeps the keyboard: the arrow keys would then step its slider or its
  // city list instead of moving the view. Movement keys always belong to the scene.
  if (MOVE_KEYS.has(e.code)) { e.preventDefault(); if (el && el !== document.body) el.blur(); }
  if (e.code === 'KeyN') { clockTime.live = false; clockTime.hour = env.dark > 0.5 ? 12 : 22; } // noon <-> night
  keys.add(e.code);
}, { capture: true });
addEventListener('keyup', (e) => keys.delete(e.code));
addEventListener('blur', () => keys.clear());

// WASD / arrows move the focus point over the ground; speed scales with the camera distance.
function keyboardPan(dt) {
  const f = (keys.has('KeyW') || keys.has('ArrowUp') ? 1 : 0) - (keys.has('KeyS') || keys.has('ArrowDown') ? 1 : 0);
  const r = (keys.has('KeyD') || keys.has('ArrowRight') ? 1 : 0) - (keys.has('KeyA') || keys.has('ArrowLeft') ? 1 : 0);
  if (!f && !r) return;
  const fwd = new THREE.Vector3().subVectors(controls.target, camera.position).setY(0).normalize();
  const right = new THREE.Vector3().crossVectors(fwd, THREE.Object3D.DEFAULT_UP);
  const speed = Math.max(20, camera.position.distanceTo(controls.target)) * (keys.has('ShiftLeft') || keys.has('ShiftRight') ? 2.5 : 0.9);
  const move = fwd.multiplyScalar(f).addScaledVector(right, r).normalize().multiplyScalar(speed * dt);
  controls.target.add(move);
  camera.position.add(move);
}

// Wheel zoom with inertia: each notch adds to a pending amount that is paid out over the next frames,
// towards the point of the ground under the cursor.
const zoom = { pending: 0, pivot: new THREE.Vector3(), ray: new THREE.Raycaster(), plane: new THREE.Plane() };
renderer.domElement.addEventListener('wheel', (e) => {
  e.preventDefault();
  if (chase.on) return; // (riding: the wheel sets how far behind the car the camera is)
  const notches = (e.deltaMode === 1 ? e.deltaY * 33 : e.deltaMode === 2 ? e.deltaY * 800 : e.deltaY) / 100;
  zoom.pending = THREE.MathUtils.clamp(zoom.pending + notches * 0.16, -1.6, 1.6);
  zoom.ray.setFromCamera(new THREE.Vector2((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1), camera);
  zoom.plane.set(THREE.Object3D.DEFAULT_UP, -controls.target.y);
  const hit = zoom.ray.ray.intersectPlane(zoom.plane, new THREE.Vector3());
  // looking at the sky, or at ground far beyond the view: zoom on the focus point instead
  zoom.pivot.copy(hit && hit.distanceTo(controls.target) < camera.position.distanceTo(controls.target) * 3 ? hit : controls.target);
}, { passive: false });
function wheelZoom(dt) {
  if (Math.abs(zoom.pending) < 1e-4) { zoom.pending = 0; return; }
  const step = zoom.pending * (1 - Math.exp(-dt * 9));
  zoom.pending -= step;
  const dist = camera.position.distanceTo(controls.target), scale = THREE.MathUtils.clamp(Math.exp(step), controls.minDistance / dist, controls.maxDistance / dist);
  camera.position.sub(zoom.pivot).multiplyScalar(scale).add(zoom.pivot);
  controls.target.sub(zoom.pivot).multiplyScalar(scale).add(zoom.pivot);
}

// Click a building to inspect it.
let picked = null;
const raycaster = new THREE.Raycaster();
let downAt = null;
renderer.domElement.addEventListener('pointerdown', (e) => { downAt = [e.clientX, e.clientY]; });
renderer.domElement.addEventListener('pointerup', (e) => {
  if (!downAt || Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 4) return;
  raycaster.setFromCamera(new THREE.Vector2((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1), camera);
  if (sim && simOn()) {
    const vid = sim.pick(raycaster.ray, clockTime.hour * 3600, Math.max(4, camera.position.distanceTo(controls.target) * 0.012));
    if (vid != null) { ride(vid); return; }
  }
  const hit = raycaster.intersectObjects(scene.children, true).find((h) => h.object.userData.facade);
  picked = hit ? streamer.buildingAt(hit) : null;
});

// ---------------------------------------------------------------- riding with a car
// The camera follows one simulated car: behind and above it, easing after it through the turns. Esc, or a
// drag of the view, lets it go.
const chase = { on: false, target: new THREE.Vector3(), eye: new THREE.Vector3(), heading: 0, back: 13, up: 4.2, yaw: 0, tilt: 0.3, drag: null };
function ride(vid) {
  sim.followed = vid; chase.on = true; chase.fresh = true; chase.yaw = 0;
  controls.enabled = false;
}
function stopRiding() { if (!sim) return; sim.followed = null; chase.on = false; controls.enabled = true; }
function rideRandom() {
  const W = sim.windows.get(sim.windowStart(clockTime.hour * 3600));
  if (!W || W === 'loading') return;
  const p = [0, 0, 0], T = clockTime.hour * 3600;
  for (let tries = 0; tries < 200; tries++) {
    const i = Math.floor(Math.random() * W.n);
    if (SimTraffic.at(W, i, T, p) && SimTraffic.at(W, i, T + 120, p)) { ride(W.vid[i]); return; }
  }
}
addEventListener('keydown', (e) => { if (e.key === 'Escape') stopRiding(); });
renderer.domElement.addEventListener('pointerdown', (e) => {
  if (!chase.on) return;
  if (e.button === 2) { stopRiding(); return; }
  chase.drag = { x: e.clientX, y: e.clientY };
});
addEventListener('pointermove', (e) => {
  if (!chase.on || !chase.drag) return;
  // look around the car: sideways swings the camera round it, up and down raises or lowers it
  chase.yaw -= (e.clientX - chase.drag.x) * 0.006;
  chase.tilt = THREE.MathUtils.clamp(chase.tilt + (e.clientY - chase.drag.y) * 0.004, 0.05, 1.2);
  chase.drag = { x: e.clientX, y: e.clientY };
});
addEventListener('pointerup', () => { chase.drag = null; });
renderer.domElement.addEventListener('wheel', (e) => {
  if (!chase.on) return;
  chase.back = THREE.MathUtils.clamp(chase.back * Math.exp(Math.sign(e.deltaY) * 0.12), 6, 80);
}, { passive: true });
function chaseCamera(dt) {
  const v = sim?.view;
  if (!chase.on) return;
  // the car has arrived: ride on with another one near it (or let go, if there is none)
  if (!v) {
    if (chase.fresh) return;
    const last = chase.target, T = clockTime.hour * 3600;
    const next = sim.carsNear(T, last.x, last.z, 300, 60).filter((c) => c.moving)[0];
    if (next) { sim.followed = next.vid; chase.fresh = false; } else stopRiding();
    return;
  }
  // ease the heading, so the camera swings round behind the car instead of snapping
  let dh = v.heading - chase.heading; dh = Math.atan2(Math.sin(dh), Math.cos(dh));
  chase.heading += dh * (chase.fresh ? 1 : 1 - Math.exp(-dt * 2.2));
  // (let go, the camera drifts back behind the car)
  if (!chase.drag) chase.yaw *= Math.exp(-dt * 0.35);
  const h = chase.heading + chase.yaw, flat = Math.cos(chase.tilt) * chase.back;
  const want = new THREE.Vector3(v.x, v.y + 1.4, v.z);
  const eye = new THREE.Vector3(v.x - Math.sin(h) * flat, v.y + 1.4 + Math.sin(chase.tilt) * chase.back, v.z - Math.cos(h) * flat);
  if (chase.fresh) { chase.target.copy(want); chase.eye.copy(eye); chase.fresh = false; }
  chase.target.lerp(want, 1 - Math.exp(-dt * 8));
  chase.eye.lerp(eye, 1 - Math.exp(-dt * 3.5));
  controls.target.copy(chase.target);
  camera.position.copy(chase.eye);
  camera.lookAt(chase.target);
}

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  atmosphere.setSize(innerWidth, innerHeight);
});

// ---------------------------------------------------------------- the experience (the simulated morning to watch)
const xp = sim && params.get('xp') !== '0' ? new Experience({
  scene, camera, controls, streamer, clockTime, atmosphere, roads, manifest, chase, ride, stopRiding, setScenario, speedMap,
  get sim() { return sim; },
}) : null;
if (xp) {
  // a clean picture: the settings panel and the readout come back with G
  guiPanel?.hide(); document.getElementById('hud').style.display = 'none';
  addEventListener('keydown', (e) => {
    if (e.code !== 'KeyG' || document.activeElement?.tagName === 'INPUT') return;
    const show = guiPanel._hidden; guiPanel.show(show); document.getElementById('hud').style.display = show ? '' : 'none';
  });
}

// ---------------------------------------------------------------- loop
const hud = document.getElementById('hud');
const clock = new THREE.Clock();
let frames = 0, fpsTime = 0, fps = 0;

let loading = true;
function frame(_, manual) {
  const dt = manual ?? Math.min(clock.getDelta(), 0.1); // (manual: a step driven from outside, for testing with the page hidden)
  renderer.info.reset();
  clockTime.tick(dt);
  const directed = xp?.directing;
  if (!chase.on && !directed) { keyboardPan(dt); wheelZoom(dt); controls.update(); }

  // keep the focus on the ground and the camera above it
  if (!chase.on && !directed) controls.target.y = streamer.ground(controls.target.x, controls.target.z);
  const floor = streamer.ground(camera.position.x, camera.position.z) + 2;
  if (camera.position.y < floor) camera.position.y = floor;

  streamer.update(controls.target, camera.position);
  // the loading screen stays until the tiles around the view are in
  if (loading) {
    const size = manifest.tileSize, wanted = manifest.tiles.filter((t) => Math.hypot((t.x + 0.5) * size - controls.target.x, (t.z + 0.5) * size - controls.target.z) <= Math.min(streamer.radius, 900)).length || 1;
    const got = Math.min(1, streamer.stats.loaded / wanted);
    loader.set(0.2 + 0.8 * got, `city tiles ${streamer.stats.loaded} / ${manifest.tiles.length}`);
    if (got >= 1) { loading = false; loader.hide(); xp?.showTitle(Number(sim?.index.stats?.vehicles?.inserted) || sim?.index.tripinfo?.count); }
  }
  props.update(dt);
  signs.update();
  railways.userData.trains.update(dt, env.night);
  // the simulated morning while it lasts; the cars around the camera otherwise
  const simulating = simOn();
  traffic.group.visible = !simulating;
  if (traffic.group.parent && !simulating) traffic.update(dt, controls.target);
  if (sim) { if (simulating) sim.update(clockTime.hour * 3600, camera); else sim.hide(); }
  if (simSignals) { props.mats.lens.uniforms.uSigOn.value = simulating ? 1 : 0; if (simulating) simSignals.update(clockTime.hour * 3600); }
  chaseCamera(dt);
  xp?.update(dt, { night: env.night, uGrid: shared.uGrid.value });
  speedMap?.update(dt, clockTime.hour * 3600, camera.position.y - streamer.ground(camera.position.x, camera.position.z));
  ferries?.update(clockTime.hour * 3600, manifest.sea ?? 0);
  env.setSky(...Object.values(atmosphere.setDate(clockTime.date())));
  clockText.textContent = clockTime.label();
  env.update(dt);
  env.follow(controls.target, camera);
  lampLight.update(scene, controls.target, camera.position, env.night);
  atmosphere.bloom.intensity = guiState.bloom ? env.bloom * 3 : 0;
  atmosphere.render(dt);
  if (!loading) updateViewLink(performance.now());

  frames++; fpsTime += dt;
  if (fpsTime >= 0.5) { fps = frames / fpsTime; frames = 0; fpsTime = 0; }
  const s = streamer.stats, info = renderer.info.render;
  const [lon, lat] = proj.unproject(controls.target.x, controls.target.z);
  hud.textContent =
    `${manifest.name}  ${Math.abs(lat).toFixed(5)}${lat < 0 ? 'S' : 'N'} ${Math.abs(lon).toFixed(5)}${lon < 0 ? 'W' : 'E'}  ${controls.target.y.toFixed(1)} m\n` +
    `San Juan ${clockTime.label()}${clockTime.live ? ' (live)' : ''} · sun ${env.elevation.toFixed(0)}°\n` +
    `${fps.toFixed(0)} fps · ${info.calls} draws · ${(info.triangles / 1e6).toFixed(2)}M tris\n` +
    `tiles ${s.loaded}/${manifest.tiles.length}${streamer.pending ? ` (+${streamer.pending})` : ''} · ${s.buildings} buildings\n` +
    (sim && simOn() ? `simulated: ${sim.stats.active.toLocaleString()} cars on the road · ${sim.stats.near} near · ${clockTime.rate}×\n` : '') +
    (picked ? `\n▸ ${USAGE[picked.usage] ?? 'usage ' + picked.usage}, ${picked.height.toFixed(1)} m` +
      `${picked.storeys ? `, ${picked.storeys} floors` : ''}, base ${picked.base.toFixed(1)} m\n` : '') +
    `\ndrag pan · right-drag rotate · wheel zoom\nWASD move (shift fast) · N day/night · click building`;
  if (manual == null) requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

window.__app = { scene, camera, controls, streamer, env, renderer, materials, ao, atmosphere, traffic, shared, viewLink, get sim() { return sim; }, clockTime, ride, stopRiding, xp, frame: (dt) => frame(0, dt) };
