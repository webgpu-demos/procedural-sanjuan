// Procedural San Juan client: streams the compiled city and renders it. Free camera for now; the car comes next.
//
// URL parameters: ?area=condado (default: sanjuan)  ?time=18.5 (San Juan hour; default: now; the simulated morning if there is one)  ?sim=0  ?scenario=apagon  ?rate=60  ?night=1  ?cam=x,z,distance,azimuthDeg,elevationDeg  ?radius=3000  ?traffic=0  ?ortho=0  ?clouds=0.25 (on, with that cover)  ?birds=150  ?cars=600
//                 ?ll=lat,lon[,distance,azimuthDeg,elevationDeg] (a place instead of ?cam; skips the opening)  ?sea=1.5 (the sea raised to that level, metres)  ?from=garita (a way back)
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
import { buildFlyovers, overDecks, landDecks } from './world/flyovers.js';
import { PROP } from './shared/tileformat.js';
import { Traffic, MAX_CARS } from './world/traffic.js';
import { correctProfiles } from './shared/profile.js';
import { laneDepth, mergeApproaches } from './shared/roadway.js';
import { Collider, vehicleCapsule } from './world/collide.js';
import { SimTraffic } from './world/simtraffic.js';
import { Driver, placeOnRoad } from './world/drive.js';
import { Walker, Cyclist, Flyer } from './world/player.js';
import { Hud } from './hud.js';
import { SimSignals } from './world/simsignals.js';
import { Experience } from './experience.js';
import { SpeedMap } from './world/speedmap.js';
import { Ferries } from './world/ferries.js';
import { buildStructures } from './world/structures.js';
import { loadOrtho } from './world/ortho.js';
import { buildSurroundings } from './world/far.js';
import { buildShore } from './world/water.js';
import { buildNightRoads } from './world/nightroads.js';
import { renderSources } from './sources.js';
import { Environment } from './world/environment.js';
import { Atmosphere } from './world/atmosphere.js';
import { createBirds, MAX_BIRDS } from './world/birds.js';
import { LampLight, installLampLight } from './world/lamplight.js';
import { parseLatLon, parseSeaLevel, parseGers, garitaLink } from './shared/twin.js';

installLampLight(); // (before any material is compiled)

const params = new URLSearchParams(location.search);
// (Old San Juan was an area of its own, around the same origin: its links, views included, open in the municipality)
const ALIASES = { viejosanjuan: 'sanjuan' };
const AREA = ALIASES[params.get('area')] ?? params.get('area') ?? 'sanjuan';
// A place by its coordinates (Garita's street-view links): ?ll=lat,lon opens the view on it, and a link with a place
// in it goes straight there, past the opening (?xp=1 keeps it).
const LL = parseLatLon(params.get('ll'));
const FROM_GARITA = params.get('from') === 'garita';
const BLD = parseGers(params.get('bld')); // the building Garita had selected (its GERS id), found near ?ll=

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
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5)); // (the frame-rate governor sets it from here on)
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.shadowMap.enabled = true;
renderer.info.autoReset = false; // the composer renders several passes; count the whole frame
// (PCF, filtered: three r18x has no PCFSoftShadowMap, and swaps it for this the first time the map is drawn, after
// the night's materials were compiled for the old one: their shadow samplers then meet a depth texture of the
// other kind, and from a night set straight to day nothing lit was drawn at all)
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.shadowMap.autoUpdate = false; // (redrawn when needed: see the frame loop)
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight || 1, 1, 60000); // (a page opened without a size: fitView below)
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
  // a San Juan date to keep to instead of today's (its midnight, ms): the opening's morning (experience.js)
  day: null,
  // the moment on today's San Juan date (or `day`) at which its clock shows `hour`
  date() {
    const AST = -4 * 3600e3, now = Date.now();
    if (this.live) { const t = new Date(now + AST); this.hour = t.getUTCHours() + t.getUTCMinutes() / 60 + t.getUTCSeconds() / 3600; return new Date(now); }
    const midnight = this.day ?? Math.floor((now + AST) / 864e5) * 864e5 - AST;
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
let baseRadius = 1e5; // (the area's streaming radius, before the governor's reach)
const VIEW_RADIUS = 1000; // metres: full tiles around the focus, when the whole city is not loaded at once
loader.set(0.08, 'terrain');
const manifest = await streamer.init();
// A large area (the whole municipality) streams: full detail around the view, plain blocks out to 7 km, the
// photo-draped ground beyond (far.js). It is never loaded whole.
const LARGE = manifest.stream != null || manifest.tiles.length > 600;
if (LARGE) {
  streamer.radius = Number(params.get('radius')) || manifest.stream || VIEW_RADIUS;
  baseRadius = streamer.radius;
  streamer.blockRadius = manifest.blockRadius ?? 7000;
  controls.maxDistance = 9000;
}
loader.set(0.14, 'railways and roads');
const proj = makeProjection(manifest.origin.lon, manifest.origin.lat);
// A raised sea (?sea=, Garita's sea-level scenario): the sea's surface at that height, over everything lower. It is
// Garita's bathtub, not a flood model: ground below the level is under water whether or not the sea can reach it.
const FLOOD = parseSeaLevel(params.get('sea'), manifest.sea ?? 0);
// Beyond the area: the rest of the island (far.js) over the sea, out to the haze of the horizon; without the
// surroundings, plain ground in the grey of the area's own unbuilt land unless the area has a coast.
{
  const b = manifest.bounds, coastal = manifest.sea != null || manifest.far != null;
  const plain = new THREE.Mesh(new THREE.CircleGeometry(50000, 256).rotateX(-Math.PI / 2), coastal || FLOOD != null ? materials.sea
    : new THREE.MeshStandardMaterial({ color: 0x8a8a86, roughness: 0.95, metalness: 0 }));
  plain.position.set((b.minX + b.maxX) / 2, FLOOD ?? (coastal ? (manifest.sea ?? 0) - 0.15 : manifest.terrain.min - 1), (b.minZ + b.maxZ) / 2); // just under the sea in the tiles, or the lowest ground
  plain.receiveShadow = true;
  plain.name = 'plain';
  scene.add(plain);
}
// the ground of the tiles not loaded, and of the island around the area (far.js)
buildSurroundings(`tiles/${AREA}`, `ortho/${AREA}/far`, manifest, proj).then((far) => far && scene.add(far));
// how far the sea lies from the land, for its shallows and its surf (water.js)
// (with the sea raised, its shore is where the ground meets the new level: the shallows and the surf follow it inland)
buildShore(streamer.grid, FLOOD != null ? { ...manifest, sea: FLOOD } : manifest, `tiles/${AREA}`).catch((e) => console.warn('shore:', e.message));
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
const [roads, rails, lanes] = await Promise.all([
  fetch(`tiles/${AREA}/${manifest.roads}`).then((r) => r.json()),
  manifest.rails ? fetch(`tiles/${AREA}/${manifest.rails}`).then((r) => (r.ok ? r.json() : [])).catch(() => []) : [],
  // (the expressway's painted lanes, measured from the tiles: tools/pipeline/lanetable.mjs; simtraffic.js relane)
  fetch(`tiles/${AREA}/lanes.json`).then((r) => (r.ok ? r.json() : null)).catch(() => null),
]);
roads.lanes = lanes;
// (the expressway's height without the humps the elevation model's overpass ridges put in it, and the bridges that
// cross no road or railway flush with their roads: src/shared/profile.js)
correctProfiles(roads, (x, z) => streamer.ground(x, z), rails);
landDecks(roads, (x, z) => streamer.ground(x, z)); // (decks flush with the streets they meet: world/flyovers.js)
streamer.merges(mergeApproaches(roads)); // (no turn arrows on the expressway where it merges or forks)
streamer.laneDepth = laneDepth(roads); // (the tiles' props clear of the lanes cars drive: src/shared/roadway.js; the piers too)
const railways = await buildRailways(rails, (x, z) => streamer.ground(x, z), streamer.cover, streamer.laneDepth);
scene.add(railways);
{
  const flyovers = await buildFlyovers(roads, (x, z) => streamer.ground(x, z), streamer.laneDepth, { road: materials.deck, paint: materials.deckPaint });
  scene.add(flyovers);
  streamer.under = overDecks(flyovers.userData.footprints, PROP); // (nothing on the ground standing up through a deck)
}
if (manifest.structures) scene.add(await buildStructures(`tiles/${AREA}/${manifest.structures}`, (x, z) => streamer.ground(x, z), streamer.laneDepth));
if (LARGE) setTimeout(() => buildNightRoads(roads, manifest.extent ?? manifest.bounds), 0); // (the streets' lights from afar, on the distant ground; off the loading's way)
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

// initial view: ?cam, else the place of ?ll when the area holds it, else the area's own (manifest.view), or over the origin
let llView = null;
if (LL && !params.get('cam')) {
  const [x, z] = proj.project(LL.lon, LL.lat), b = manifest.bounds;
  if (x >= b.minX && x <= b.maxX && z >= b.minZ && z <= b.maxZ) llView = [x, z, ...(LL.view ?? [320, 200, 38])];
  else console.warn(`?ll=${LL.lat},${LL.lon} is outside ${manifest.name}: opening its own view`);
}
const [cx, cz, dist, az, el] = llView ?? (params.get('cam') || (manifest.view ?? [0, 0, 600, 200, 32]).join(',')).split(',').map(Number);
controls.target.set(cx, streamer.ground(cx, cz), cz);
camera.position.copy(controls.target).add(new THREE.Vector3().setFromSphericalCoords(
  dist, THREE.MathUtils.degToRad(90 - el), THREE.MathUtils.degToRad(az)));
controls.update();

// ---------------------------------------------------------------- the frame rate, kept up
// When the frames come slower than 45 a second, the costliest things give way first, a step at a time: pixel
// density, the clouds' detail, ambient occlusion, the window reflections and depth of field, the clouds, the
// shadows' sharpness; when there is room again (57 or more for a while) they come back the same way, and a step
// back up that does not hold is tried again only after longer. ?quality=high keeps everything, low starts lean.
const governor = (() => {
  const top = Math.min(devicePixelRatio, 1.5), lean = { ao: false, reflect: false, dof: false }; // (2x costs a quarter more for little)
  // (detail: how far off the small things are drawn, as a share of the full distance; reach: how far out the city
  // is streamed in full, as a share of the area's radius: a machine that keeps up sees more of it)
  const LEVELS = [
    { ratio: top, reach: 1.4 },
    { ratio: top, clouds: 'low', reach: 1.4 },
    { ratio: Math.min(top, 1.25), clouds: 'low', reach: 1.3 },
    { ratio: Math.min(top, 1.25), clouds: 'low', ao: false, detail: 0.8, reach: 1.2 },
    { ratio: Math.min(top, 1.25), clouds: 'low', ...lean, detail: 0.8, reach: 1.15 },
    { ratio: 1, clouds: 'off', ...lean, detail: 0.6 },
    { ratio: 1, clouds: 'off', ...lean, shadow: 2048, detail: 0.5 },
    { ratio: 0.8, clouds: 'off', ...lean, shadow: 1024, detail: 0.4 },
  ];
  const q = params.get('quality');
  // (it starts a little lean and earns the rest: a slow first minute is worse than a plain one)
  const g = { auto: q !== 'high', level: q === 'low' ? 5 : q === 'high' ? 0 : 2, times: [], settle: 2, slow: 0, fast: 0, upWait: 5, raisedAt: -1e9 };
  g.apply = () => {
    const L = LEVELS[g.level];
    g.detail = L.detail ?? 1;
    if (!params.get('radius')) streamer.radius = baseRadius * (L.reach ?? 1);
    if (renderer.getPixelRatio() !== L.ratio) { renderer.setPixelRatio(L.ratio); renderer.setSize(innerWidth, innerHeight); atmosphere.setSize(innerWidth, innerHeight); }
    atmosphere.limit({ clouds: L.clouds ?? 'ultra', reflect: L.reflect !== false, dof: L.dof !== false });
    ao.enabled = L.ao !== false;
    const size = L.shadow ?? 4096;
    if (env.sun.shadow.mapSize.x !== size) { env.sun.shadow.mapSize.set(size, size); env.sun.shadow.map?.dispose(); env.sun.shadow.map = null; }
  };
  // busy: not a frame to judge by (loading); hold: judge, but change nothing until the hold is off (a shot of the
  // opening is playing: a change of resolution mid-shot shows; it waits for the next cut to black)
  g.update = (dt, busy, hold = false) => {
    if (!g.auto || document.hidden || !(dt > 0)) return;
    g.times.push(dt); if (g.times.length > 45) g.times.shift();
    if ((g.settle -= dt) > 0 || busy || g.times.length < 45) return;
    const typical = [...g.times].sort((a, b) => a - b)[22]; // (the median: a tile arriving is one slow frame, not a slow scene)
    g.slow = typical > 1 / 45 ? g.slow + dt : 0;
    g.fast = typical < 1 / 57 ? g.fast + dt : 0;
    const now = performance.now() / 1000;
    if (hold) return;
    if (g.slow > 1 && g.level < LEVELS.length - 1) {
      if (now - g.raisedAt < 6) g.upWait = Math.min(120, g.upWait * 2); // (the step up did not hold)
      g.level = Math.min(LEVELS.length - 1, g.level + (typical > 1 / 25 ? 2 : 1)); // (far too slow: two steps at once)
      g.apply(); g.settle = 1.5; g.slow = g.fast = 0; g.times.length = 0;
    } else if (g.fast > g.upWait && g.level > 0) {
      g.level--; g.apply(); g.settle = 2; g.slow = g.fast = 0; g.times.length = 0; g.raisedAt = now;
    }
  };
  g.apply();
  return g;
})();

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
    shadowsWanted: true, get shadows() { return this.shadowsWanted; }, set shadows(v) { this.shadowsWanted = v; },
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
  quality.add(governor, 'auto').name('auto quality (keeps the frame rate)');

  // The panel's settings are kept (in this browser) and are the same for every city: what is switched off in
  // one is off in the next. A URL that sets something itself (?time=, ?cars=, ...) is taken as it stands.
  const KEY = 'procedural-sanjuan:settings';
  // (a shared view link carries the camera and perhaps the hour: those do not count as settings)
  const explicit = [...params.keys()].some((k) => !['area', 'cam', 'time', 'debug'].includes(k));
  // (the city is the page's, not a setting; nor is the hour: a city with a simulated morning sets its own, before
  // dawn, and kept, that hour would open every other city in the dark with the clock stopped. Only the choice of the
  // live clock is kept, and not from a page whose simulated morning made it.)
  const strip = (saved) => {
    delete saved.controllers?.city;
    const time = saved.folders?.['Time (San Juan)']?.controllers;
    if (time) { delete time.time; if (sim) delete time['live clock']; }
    return saved;
  };
  if (!explicit) {
    try {
      const saved = JSON.parse(localStorage.getItem(KEY) ?? 'null');
      if (saved) {
        gui.load(strip(saved)); // (settings saved before the hour was left out still carry it: strip drops it)
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
  url.searchParams.delete('ll'); // (the camera says where; ?sea and ?from stay)
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
const MOVE_KEYS = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space']); // (Space: the handbrake, not a focused button)
addEventListener('keydown', (e) => {
  const el = document.activeElement, typing = el?.tagName === 'INPUT' && (el.type === 'text' || el.type === 'number');
  if (typing) return; // a number being typed into the panel
  // A panel control that was clicked keeps the keyboard: the arrow keys would then step its slider or its
  // city list instead of moving the view. Movement keys always belong to the scene.
  if (MOVE_KEYS.has(e.code)) { e.preventDefault(); if (el && el !== document.body) el.blur(); }
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
  if (sim && simOn() && mode === 'explore') {
    const vid = sim.pick(raycaster.ray, clockTime.hour * 3600, Math.max(4, camera.position.distanceTo(controls.target) * 0.012));
    if (vid != null) { ride(vid); return; }
  }
  const hit = raycaster.intersectObjects(scene.children, true).find((h) => h.object.userData.facade);
  picked = hit ? streamer.buildingAt(hit) : null;
  if (picked) {
    // where the building stands, for Garita: the point hit, half a metre inside when it is on a wall (Garita finds the
    // footprint that holds the point)
    const p = hit.point.clone(), n = hit.face?.normal;
    if (n && Math.abs(n.y) < 0.5) p.addScaledVector(new THREE.Vector3(n.x, 0, n.z).normalize(), -0.5);
    picked.at = proj.unproject(p.x, p.z);
    withIds(picked);
  }
  showTwinLink();
});
// The ids of a picked building (the tile's ids file, fetched once): its GERS id goes to Garita with the link.
function withIds(b) {
  streamer.idsOf(b.tile).then((ids) => {
    if (picked !== b || !ids?.[b.index]) return;
    Object.assign(b, ids[b.index]);
    showTwinLink();
  });
}
// Arriving from Garita with a building (?bld=): the building with that id near ?ll= is the one picked, once its tile is in.
if (BLD && LL) {
  const [x, z] = proj.project(LL.lon, LL.lat);
  streamer.findGers(BLD, x, z).then((found) => {
    if (!found) return;
    const take = (tries) => {
      const b = streamer.buildingIn(found.key, found.index);
      if (b) { if (!picked) { picked = Object.assign(b, { gers: BLD, at: [LL.lon, LL.lat] }); withIds(picked); showTwinLink(); } return; }
      if (tries > 0) setTimeout(() => take(tries - 1), 500);
    };
    take(60);
  });
}

// The way to Garita (top centre, index.html #twin): the building clicked, else (arriving from Garita) the place in view.
const twinLink = document.getElementById('twin-link');
function showTwinLink() {
  if (!twinLink) return;
  const at = picked?.at ?? (FROM_GARITA ? proj.unproject(controls.target.x, controls.target.z) : null);
  twinLink.hidden = !at;
  if (!at) return;
  twinLink.href = garitaLink(at[0], at[1], { sea: FLOOD, gers: picked?.gers });
  twinLink.textContent = picked?.at ? 'Este edificio en Garita ↗' : '← Garita';
  twinLink.title = picked?.at ? 'Open this building in Garita, the island-wide twin' : 'Back to Garita, at the place in view';
}
if (FROM_GARITA) { showTwinLink(); controls.addEventListener('end', () => { if (!picked) showTwinLink(); }); }
// The raised sea says what it is, on screen for as long as it is raised.
if (FLOOD != null) {
  const tag = document.getElementById('sea-tag');
  if (tag) {
    tag.hidden = false;
    tag.textContent = `Mar a +${FLOOD.toFixed(1)} m · modelo de bañera, como en Garita`;
    tag.title = 'Bathtub model: all ground below the level is under water, connected to the sea or not (as Garita counts it)';
  }
}

// ---------------------------------------------------------------- riding with a car
// The camera follows one simulated car: behind and above it, easing after it through the turns. Esc, or a
// drag of the view, lets it go.
const chase = { on: false, target: new THREE.Vector3(), eye: new THREE.Vector3(), heading: 0, back: 13, up: 4.2, yaw: 0, tilt: 0.3, drag: null };
function ride(vid) {
  setMode('explore');
  sim.followed = vid; chase.on = true; chase.fresh = true; chase.yaw = 0; Object.assign(chase, { back: 13, tilt: 0.3, sharp: false });
  controls.enabled = false;
}
function stopRiding() { setMode('explore'); if (!sim) return; sim.followed = null; chase.on = false; controls.enabled = true; atmosphere.focus(null); }

// ---------------------------------------------------------------- the ways round the city (drive.js, player.js)
// Explorar (the map's camera), Caminar, Bici, Manejar, Volar: 1 to 5 (hud.js); E gets in a car (on foot or exploring)
// and out of it again, Esc back to exploring. Each way has its camera rigs (V cycles: chase, close, first person,
// cinematic). Where you were, and how, is kept for the next visit.
const tiles = () => scene.children.filter((o) => o.name.startsWith('tile '));
const lift = (x, z) => streamer.lift(x, z); // (how high the paving stands: what stands on it is not sunk in it)
const driver = new Driver({ scene, surface: streamer.surface, sim: () => sim, tiles, lift });
const players = { car: driver, walk: new Walker({ scene, surface: streamer.surface, sim: () => sim, tiles, lift }), bike: new Cyclist({ scene, surface: streamer.surface, sim: () => sim, tiles, lift }), fly: new Flyer({ scene, surface: streamer.surface, tiles }) };
let mode = 'explore', cameraIndex = 0;
// What you run into (collide.js): the street's things come with the tiles; the vehicles round you are gathered
// each frame (the simulated cars near you, the traffic, the car you left). And what you are, to them: the
// simulated cars fade rather than drive through you or the car parked, the traffic stops for you.
const collider = new Collider(tiles);
for (const p of Object.values(players)) p.collider = collider;
function aroundYou(player, simulating) {
  const v = player && mode !== 'fly' ? player.view : null, list = collider.dynamic, solids = [];
  list.length = 0;
  if (v) {
    if (simulating) {
      const H = sim.probeHits;
      for (let i = 0; i < H.length; i += 7) list.push({ c: vehicleCapsule(H[i], H[i + 2], H[i + 3], H[i + 4], H[i + 5]), y: H[i + 1], heading: H[i + 3], speed: H[i + 6] });
    } else if (traffic.group.parent) {
      for (const o of traffic.near(v.x, v.z, 40)) list.push({ c: vehicleCapsule(o.x, o.z, o.heading, o.L, o.W), y: o.y, heading: o.heading, speed: o.speed });
    }
    const L = mode === 'car' ? driver.spec.L : mode === 'bike' ? 1.7 : 0.7, W = mode === 'car' ? driver.spec.spec.W : 0.6;
    solids.push(vehicleCapsule(v.x, v.z, v.heading, L, W));
  }
  const pk = mode !== 'car' ? driver.parked : null;
  if (pk) {
    const c = vehicleCapsule(pk.x, pk.z, pk.heading, driver.spec.L, driver.spec.spec.W);
    list.push({ c, y: pk.y, heading: pk.heading, speed: 0 });
    solids.push(c);
  }
  if (sim) { sim.probe = v ? [v.x, v.z] : null; sim.solids = solids; }
  traffic.blockers = solids;
}
const active = () => players[mode] ?? null;
const CAMERAS = [['chase', 'Persecución'], ['close', 'Cerca'], ['pov', 'Primera persona'], ['orbit', 'Cinemática']];
// [distance behind, elevation] of each rig, and the height of the eyes in first person
const RIG = {
  car: { chase: [7.2, 0.17], close: [4.6, 0.09], orbit: [12, 0.3], eye: 1.15 },
  walk: { chase: [4.4, 0.24], close: [2.4, 0.1], orbit: [7, 0.32], eye: 1.62 },
  bike: { chase: [5.2, 0.2], close: [3, 0.1], orbit: [8, 0.3], eye: 1.55 },
  fly: { chase: [24, 0.3], close: [13, 0.16], orbit: [42, 0.38], eye: 1.7 },
};
const cameraId = () => CAMERAS[cameraIndex][0];
function applyRig() {
  const r = RIG[mode]?.[cameraId()];
  if (r) Object.assign(chase, { back: r[0], tilt: r[1], yaw: 0 });
  // first person: the body out of the way (it would fill the view)
  for (const [k, p] of Object.entries(players)) { const m = p.mesh ?? p.model; if (m && p.on) m.visible = !(k === mode && cameraId() === 'pov'); }
  if (driver.on && driver.beams) driver.beams.visible = true;
}
function cycleCamera(step) { cameraIndex = (cameraIndex + step + CAMERAS.length) % CAMERAS.length; applyRig(); }
// to another way round the city, at a place given or where you are now
function setMode(next, at = null) {
  if (next === mode && !at) return true;
  const look = Math.atan2(controls.target.x - camera.position.x, controls.target.z - camera.position.z);
  const from = at ?? active()?.view ?? { x: controls.target.x, z: controls.target.z, heading: look };
  const heading = from.heading ?? look;
  if (sim) sim.followed = null;
  // out of the car on foot, it stays where it stopped (E beside it gets back in); any other way, it goes
  const leave = () => { if (mode === 'car' && next === 'walk') driver.stop({ park: true }); else active()?.stop(); if (next !== 'walk' && next !== 'car') driver.unpark(); };
  if (next === 'explore') {
    leave(); mode = 'explore'; chase.on = false; controls.enabled = true; atmosphere.focus(null); atmosphere.blur(0);
    if (camera.fov !== 55) { camera.fov = 55; camera.updateProjectionMatrix(); }
    // the map's camera over where you were, looking the way you were going
    controls.target.set(from.x, streamer.ground(from.x, from.z), from.z);
    camera.position.set(from.x - Math.sin(heading) * 150, controls.target.y + 110, from.z - Math.cos(heading) * 150);
    return true;
  }
  let place = { x: from.x, z: from.z, heading, y: null };
  if (at?.exact) place = { x: at.x, z: at.z, heading, y: at.y ?? null }; // (just there: out of the car, back into it)
  else if (next !== 'fly') {
    const road = placeOnRoad(roads, from.x, from.z, heading);
    if (!road) return false;
    place = { x: road.x, z: road.z, heading: road.heading, y: road.raised ? road.y : null };
    if (next === 'walk' || next === 'bike') { // on foot: off the lane, towards the pavement on its right; a bike by the kerb (unless a wall is there)
      const off = next === 'walk' ? 3.5 : 1.4, rx = -Math.cos(road.heading), rz = Math.sin(road.heading), wx = road.x + rx * off, wz = road.z + rz * off;
      if (!players.walk.walls.blocked(wx, wz)) Object.assign(place, { x: wx, z: wz });
    }
  }
  leave();
  mode = next;
  players[next].start(place.x, place.z, place.heading, next === 'fly' ? (from.y ?? streamer.ground(from.x, from.z)) + 70 : place.y);
  Object.assign(chase, { on: true, fresh: true, heading: place.heading });
  applyRig();
  controls.enabled = false; clockTime.live = false; if (clockTime.rate > 6) clockTime.rate = 1;
  savePlace();
  return true;
}
// (for the experience: the car, and back)
function drive() { return setMode('car'); }
function stopDriving() { if (mode !== 'explore') setMode('explore'); }
// the active one, somewhere else: a road there for the car and on foot, the air above it for the helicopter
function teleport(x, z) {
  if (mode === 'explore') { setMode('explore', { x, z, heading: Math.atan2(controls.target.x - camera.position.x, controls.target.z - camera.position.z) }); return; }
  setMode(mode, { x, z, heading: active()?.view?.heading ?? 0 });
}
// where you were, for the next visit
function savePlace() {
  try {
    const v = active()?.view, p = v ? { mode, x: v.x, z: v.z, heading: v.heading } : { mode: 'explore', x: controls.target.x, z: controls.target.z, heading: 0 };
    localStorage.setItem(`procedural-sanjuan:place:${AREA}`, JSON.stringify(p));
  } catch { /* storage unavailable */ }
}
function savedPlace() { try { return JSON.parse(localStorage.getItem(`procedural-sanjuan:place:${AREA}`)); } catch { return null; } }
addEventListener('pagehide', savePlace);
let nextSave = 0;
addEventListener('keydown', (e) => {
  if (e.repeat || document.activeElement?.tagName === 'INPUT' || xp?.directing || hud?.mapOpen) return;
  // E: into a car (from exploring or on foot), out of it on foot beside it; Esc: back to exploring
  if (e.code === 'KeyE' && mode !== 'fly') {
    if (mode === 'car') { // out of the driver's door (on the left; the right if a wall is there)
      const v = driver.view;
      if (v) {
        const lx = Math.cos(v.heading) * 1.5, lz = -Math.sin(v.heading) * 1.5, side = players.walk.walls.blocked(v.x + lx, v.z + lz) ? -1 : 1;
        setMode('walk', { x: v.x + lx * side, z: v.z + lz * side, y: v.y, heading: v.heading, exact: true });
      }
    } else { // into the car left nearby, or one on the nearest road
      const p = driver.parked, w = active()?.view;
      if (p && w && Math.hypot(p.x - w.x, p.z - w.z) < 9) setMode('car', { ...p, exact: true }); else setMode('car');
    }
  }
  if (e.key === 'Escape') { if (mode !== 'explore') setMode('explore'); else stopRiding(); }
});
function rideRandom() {
  const W = sim.windows.get(sim.windowStart(clockTime.hour * 3600));
  if (!W || W === 'loading') return;
  const p = [0, 0, 0], T = clockTime.hour * 3600;
  for (let tries = 0; tries < 200; tries++) {
    const i = Math.floor(Math.random() * W.n);
    if (SimTraffic.at(W, i, T, p) && SimTraffic.at(W, i, T + 120, p)) { ride(W.vid[i]); return; }
  }
}
renderer.domElement.addEventListener('pointerdown', (e) => {
  if (!chase.on) return;
  if (e.button === 2 && mode === 'explore') { stopRiding(); return; }
  chase.drag = { x: e.clientX, y: e.clientY };
});
addEventListener('pointermove', (e) => {
  if (!chase.on || !chase.drag) return;
  // look around: sideways swings the camera round, up and down raises or lowers it (in first person: looks)
  chase.yaw -= (e.clientX - chase.drag.x) * 0.006;
  chase.tilt = THREE.MathUtils.clamp(chase.tilt + (e.clientY - chase.drag.y) * 0.004, cameraId() === 'pov' ? -0.7 : 0.03, 1.2);
  chase.drag = { x: e.clientX, y: e.clientY };
});
addEventListener('pointerup', () => { chase.drag = null; });
renderer.domElement.addEventListener('wheel', (e) => {
  if (!chase.on) return;
  chase.back = THREE.MathUtils.clamp(chase.back * Math.exp(Math.sign(e.deltaY) * 0.12), mode === 'walk' ? 1.6 : 3.5, 120);
}, { passive: true });
function chaseCamera(dt) {
  const player = active(), v = player ? player.view : sim?.view;
  if (!chase.on) return;
  if (player && !v) return;
  // the car has arrived: ride on with another one near it (or let go, if there is none)
  if (!v) {
    if (chase.fresh) return;
    const last = chase.target, T = clockTime.hour * 3600;
    const next = sim.carsNear(T, last.x, last.z, 300, 60).filter((c) => c.moving)[0];
    if (next) { sim.followed = next.vid; chase.fresh = false; } else stopRiding();
    return;
  }
  const cam = player ? cameraId() : 'chase', fast = player && mode !== 'walk';
  // ease the heading, so the camera swings round behind instead of snapping (backing up, it stays as it was)
  let dh = v.heading - chase.heading; dh = Math.atan2(Math.sin(dh), Math.cos(dh));
  if (!v.reversing) chase.heading += dh * (chase.fresh ? 1 : 1 - Math.exp(-dt * (player ? 3.2 : 2.2)));
  // (let go, the camera drifts back behind; the cinematic one circles on its own)
  if (cam === 'orbit') chase.yaw += dt * 0.16; else if (!chase.drag) chase.yaw *= Math.exp(-dt * (cam === 'pov' ? 2 : 0.35));
  // first person: at the eyes, looking the way it faces (a drag looks round)
  if (cam === 'pov') {
    const eyeY = v.y + RIG[mode].eye, h = v.heading + chase.yaw, pitch = -(chase.tilt - RIG[mode].chase[1]) * 0.8;
    camera.position.set(v.x + Math.sin(v.heading) * (mode === 'car' ? 0.3 : 0.15), eyeY, v.z + Math.cos(v.heading) * (mode === 'car' ? 0.3 : 0.15));
    camera.lookAt(camera.position.x + Math.sin(h) * Math.cos(pitch) * 20, eyeY + Math.sin(pitch) * 20, camera.position.z + Math.cos(h) * Math.cos(pitch) * 20);
    controls.target.set(v.x, v.y, v.z);
    chase.target.set(v.x, v.y + 1.4, v.z); chase.eye.copy(camera.position);
  } else {
    const h = chase.heading + chase.yaw, flat = Math.cos(chase.tilt) * chase.back;
    // moving fast: the camera looks a little ahead as the speed gathers, widens, and feels a knock
    const ahead = fast ? Math.min(mode === 'fly' ? 20 : 7, v.speed * 0.22) : 0;
    const lift = mode === 'walk' ? 1.5 : mode === 'fly' ? 2 : 1.4;
    const want = new THREE.Vector3(v.x + Math.sin(v.heading) * ahead, v.y + lift, v.z + Math.cos(v.heading) * ahead);
    if (v.bump > 0.02) want.y += (Math.random() - 0.5) * v.bump * 0.6;
    const eye = new THREE.Vector3(v.x - Math.sin(h) * flat, v.y + lift + Math.sin(chase.tilt) * chase.back, v.z - Math.cos(h) * flat);
    eye.y = Math.max(eye.y, streamer.ground(eye.x, eye.z) + 1); // (never under the ground)
    if (chase.fresh) { chase.target.copy(want); chase.eye.copy(eye); chase.fresh = false; }
    // (with a player, the camera is held close: only its swing round the turns is eased, above)
    chase.target.lerp(want, 1 - Math.exp(-dt * (player ? 20 : 8)));
    chase.eye.lerp(eye, 1 - Math.exp(-dt * (player ? 14 : 3.5)));
    controls.target.copy(chase.target);
    camera.position.copy(chase.eye);
    // (not inside the buildings: the eye comes in along its line to the one you are, short of the first wall it
    // would look through; the first couple of metres are left free, the kerb's cells straddle the street)
    if (player) {
      const d = chase.eye.clone().sub(chase.target), len = d.length(), roofs = players.fly.roofs;
      for (let m = 2.5; m < len; m += 0.75) {
        const f = m / len;
        if (roofs.at(chase.target.x + d.x * f, chase.target.z + d.z * f) > chase.target.y + d.y * f - 0.6) { camera.position.copy(chase.target).addScaledVector(d, (m - 0.75) / len); break; }
      }
    }
    camera.lookAt(chase.target);
  }
  const fov = fast ? 55 + Math.min(14, v.speed * 0.32) : 55;
  if (Math.abs(camera.fov - fov) > 0.05) { camera.fov += (fov - camera.fov) * (1 - Math.exp(-dt * 3)); camera.updateProjectionMatrix(); }
  // riding along: the car sharp, the city behind it soft (playing: everything sharp, as a game is)
  atmosphere.focus(player || chase.sharp ? null : camera.position.distanceTo(chase.target)); // (sharp: the opening's ride, all in focus)
  atmosphere.blur(fast && cam !== 'orbit' ? Math.min(1.1, v.speed / 30) : 0); // (driving: the street rushes past)
}

// (also once now: a page loaded where it had no size yet, a hidden pane or tab, would otherwise keep a camera
// without an aspect until the window next changes size, and draw nothing)
const fitView = () => {
  if (!innerWidth || !innerHeight) return;
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  atmosphere.setSize(innerWidth, innerHeight);
};
addEventListener('resize', fitView);
fitView();

// ---------------------------------------------------------------- the experience (the simulated morning to watch)
const xp = sim && params.get('xp') !== '0' && !(llView && params.get('xp') == null) ? new Experience({
  scene, camera, controls, streamer, clockTime, atmosphere, roads, manifest, chase, ride, stopRiding, setScenario, speedMap, driver, drive, stopDriving,
  // free roaming from the title: where you were last time, else in a car on Ponce de León at the Milla de Oro
  startFree() { const p = savedPlace(); setMode(p?.mode && p.mode !== 'explore' ? p.mode : 'car', p ?? { x: 6262, z: 4640, heading: Math.PI }); },
  get mode() { return mode; },
  get sim() { return sim; },
}) : null;
// the heads-up display of free roaming (hud.js)
const hud = new Hud({
  roads, proj, name: manifest.name, simulated: !!sim, bounds: manifest.bounds,
  get mode() { return mode; },
  setMode: (m) => { if (!xp?.directing) setMode(m); },
  cycleCamera, cameraName: () => (active() ? CAMERAS[cameraIndex][1] : chase.on ? 'Siguiendo un carro' : 'Mapa'),
  view: () => active()?.view ?? null,
  focus: () => ({ x: controls.target.x, z: controls.target.z }),
  lookHeading: () => Math.atan2(controls.target.x - camera.position.x, controls.target.z - camera.position.z),
  vehicleLabel: () => active()?.label ?? (chase.on ? 'Carro simulado' : 'Explorando'),
  teleport,
  setHour: (h) => { clockTime.live = false; clockTime.hour = h; if (clockTime.rate === 0 || clockTime.rate > 6) clockTime.rate = 1; },
  hour: () => clockTime.hour,
  soundOn: () => !!xp?.sound.on, toggleSound: () => xp?.toggleSound(),
  sim: () => (sim && simOn() ? sim : null),
  fps: () => fps,
  mapOpen: (open) => { keys.clear(); },
  keys, // (the touch controls press them)
});
// A clean picture, the city in any area: the settings panel and the technical readout come back with G (?debug=1
// opens with them).
{
  const setDebug = (show) => { guiPanel?.show(show); document.getElementById('hud').style.display = show ? '' : 'none'; };
  setDebug(params.get('debug') === '1');
  addEventListener('keydown', (e) => {
    if (e.code !== 'KeyG' || document.activeElement?.tagName === 'INPUT') return;
    setDebug(!!guiPanel?._hidden);
  });
}

// ---------------------------------------------------------------- loop
const readout = document.getElementById('hud'); // (the technical readout: G)
const clock = new THREE.Clock();
let frames = 0, fpsTime = 0, fps = 0;

let loading = true, shadowKey = '', shadowFrame = 0, detailFrame = 0;
const streamFocus = new THREE.Vector3(), STREAM_AHEAD = 450;
// how far small things are drawn (m), times the governor's detail: parked cars, street furniture and lamps
const FAR_PARKED = 1300, FAR_SMALL = 1000;
// Small things are not drawn far off: parked cars beyond 1.3 km and street furniture beyond 1 km are a pixel or
// two each, yet most of the draw calls of a wide view (the governor brings them nearer on a slow machine)
function cullSmall() {
  const size = manifest.tileSize, c = camera.position, up = Math.max(0, c.y - streamer.ground(c.x, c.z));
  for (const tile of scene.children) {
    if (!tile.name.startsWith('tile ')) continue;
    if (!tile.userData.small) {
      tile.userData.small = [];
      tile.traverse((o) => {
        if (!o.isInstancedMesh) return;
        const key = String((Array.isArray(o.material) ? o.material[0] : o.material).customProgramCacheKey?.() ?? '');
        if (key.startsWith('car-parked')) tile.userData.small.push([o, FAR_PARKED]);
        else if (!/leaves|lamp-head|lamp-quad/.test(key)) tile.userData.small.push([o, FAR_SMALL]);
      });
      const [x, z] = tile.name.slice(5).split('_').map(Number);
      tile.userData.centre = [(x + 0.5) * size, (z + 0.5) * size];
    }
    const [x, z] = tile.userData.centre, d = Math.max(0, Math.hypot(x - c.x, z - c.z, up) - size * 0.7);
    for (const [o, far] of tile.userData.small) o.visible = d < far * governor.detail;
  }
}
function frame(_, manual) {
  const dt = manual ?? Math.min(clock.getDelta(), 0.1); // (manual: a step driven from outside, for testing with the page hidden)
  renderer.info.reset();
  clockTime.tick(sim && simOn() && !sim.ready(clockTime.hour * 3600) ? 0 : dt); // (the clock waits for the cars' next window)
  const directed = xp?.directing;
  if (!chase.on && !directed) { keyboardPan(dt); wheelZoom(dt); controls.update(); }

  // keep the focus on the ground and the camera above it
  if (!chase.on && !directed) controls.target.y = streamer.ground(controls.target.x, controls.target.z);
  const floor = streamer.ground(camera.position.x, camera.position.z) + 2;
  if (camera.position.y < floor) camera.position.y = floor;

  // (streamed round a point ahead of what is looked at, the further the higher the camera: a wide view from
  // above is a long way across, and what is in front of the eye matters more than what is behind it)
  {
    const t = controls.target, up = Math.max(0, camera.position.y - t.y), fx = t.x - camera.position.x, fz = t.z - camera.position.z, l = Math.hypot(fx, fz) || 1;
    const ahead = Math.min(STREAM_AHEAD, up * 0.9);
    streamFocus.set(t.x + (fx / l) * ahead, t.y, t.z + (fz / l) * ahead);
    streamer.look = [fx / l, fz / l];
  }
  streamer.update(streamFocus, camera.position);
  if (++detailFrame % 15 === 0) cullSmall();
  // the loading screen stays until the tiles around the view are in
  if (loading) {
    const size = manifest.tileSize, wanted = manifest.tiles.filter((t) => Math.hypot((t.x + 0.5) * size - controls.target.x, (t.z + 0.5) * size - controls.target.z) <= Math.min(streamer.radius, 900)).length || 1;
    const got = Math.min(1, streamer.stats.loaded / wanted);
    loader.set(0.2 + 0.8 * got, `city tiles ${streamer.stats.loaded} / ${manifest.tiles.length}`);
    if (got >= 1) { loading = false; loader.hide(); xp?.showTitle(Number(sim?.index.stats?.vehicles?.inserted) || sim?.index.tripinfo?.count); }
  }
  props.update(dt);
  props.mats.wire.uniforms.uPx.value = renderer.domElement.height * 0.5 * camera.projectionMatrix.elements[5];
  signs.update();
  railways.userData.trains.update(dt, env.night);
  // the simulated morning while it lasts; the cars around the camera otherwise
  const simulating = simOn();
  traffic.group.visible = !simulating;
  if (traffic.group.parent && !simulating) traffic.update(dt, controls.target);
  if (sim) { sim.rate = clockTime.rate; if (simulating) sim.update(clockTime.hour * 3600, camera, dt); else sim.hide(); }
  if (simSignals) { props.mats.lens.uniforms.uSigOn.value = simulating ? 1 : 0; if (simulating) simSignals.update(clockTime.hour * 3600); }
  // the one being played: on foot, in the car, in the air (the simulated cars round it fade rather than pass through)
  const player = active();
  aroundYou(player, simulating);
  player?.update(dt, keys);
  chaseCamera(dt);
  if (hud) {
    hud.visible = !xp?.directing && !xp?.titleUp && !loading;
    if (!hud.locked) hud.update(dt);
    if (player && performance.now() > nextSave) { savePlace(); nextSave = performance.now() + 5000; }
  }
  xp?.update(dt, { night: env.night, uGrid: shared.uGrid.value });
  speedMap?.update(dt, clockTime.hour * 3600, camera.position.y - streamer.ground(camera.position.x, camera.position.z));
  ferries?.update(clockTime.hour * 3600, manifest.sea ?? 0);
  env.setSky(...Object.values(atmosphere.setDate(clockTime.date())));
  env.setClouds(atmosphere.cloudsOn ? Math.min(1, atmosphere.coverage * 1.6) : 0);
  clockText.textContent = clockTime.label();
  env.update(dt);
  env.follow(controls.target, camera);
  // Shadows: faded out once the sun is down (the moon's, at this strength, would not show) and then not drawn at
  // all; by day the map is drawn again when its frustum moves, else every third frame (for the cars): it is a
  // whole second pass over the city. (The light keeps casting: switching that recompiles every material.)
  env.sun.castShadow = guiState.shadowsWanted;
  env.sun.shadow.intensity = Math.min(1, env.daylight / 0.15);
  {
    const p = env.sun.target.position, key = `${p.x},${p.z},${env.shadowExtent}`;
    // (and once at the start, by night too: until the map exists the materials' shadow samplers are given a
    // texture of the wrong kind, and their draws fail)
    renderer.shadowMap.needsUpdate = !env.sun.shadow.map || (env.sun.shadow.intensity > 0 && (key !== shadowKey || ++shadowFrame % 3 === 0));
    shadowKey = key;
  }
  lampLight.update(scene, controls.target, camera.position, env.night);
  atmosphere.bloom.intensity = guiState.bloom ? env.bloom * 3 : 0;
  atmosphere.render(dt);
  if (manual == null) governor.update(dt, loading, xp?.directing && !xp.fading);
  if (!loading) updateViewLink(performance.now());

  frames++; fpsTime += dt;
  if (fpsTime >= 0.5) { fps = frames / fpsTime; frames = 0; fpsTime = 0; }
  const s = streamer.stats, info = renderer.info.render;
  const [lon, lat] = proj.unproject(controls.target.x, controls.target.z);
  readout.textContent =
    `${manifest.name}  ${Math.abs(lat).toFixed(5)}${lat < 0 ? 'S' : 'N'} ${Math.abs(lon).toFixed(5)}${lon < 0 ? 'W' : 'E'}  ${controls.target.y.toFixed(1)} m\n` +
    `San Juan ${clockTime.label()}${clockTime.live ? ' (live)' : ''} · sun ${env.elevation.toFixed(0)}°\n` +
    `${fps.toFixed(0)} fps${governor.level ? ` (quality step ${governor.level})` : ''} · ${info.calls} draws · ${(info.triangles / 1e6).toFixed(2)}M tris\n` +
    `tiles ${s.loaded}/${manifest.tiles.length}${streamer.pending ? ` (+${streamer.pending})` : ''} · ${s.buildings} buildings\n` +
    (sim && simOn() ? `simulated: ${sim.stats.active.toLocaleString()} cars on the road · ${sim.stats.near} near · ${clockTime.rate}×\n` : '') +
    (picked ? `\n▸ ${USAGE[picked.usage] ?? 'usage ' + picked.usage}, ${picked.height.toFixed(1)} m` +
      `${picked.storeys ? `, ${picked.storeys} floors` : ''}, base ${picked.base.toFixed(1)} m` +
      `${picked.osm ? `\n  OSM ${picked.osm}` : ''}${picked.gers ? `${picked.osm ? ' · ' : '\n  '}GERS ${picked.gers.slice(0, 8)}…` : ''}\n` : '') +
    `\ndrag pan · right-drag rotate · wheel zoom\nWASD move (shift fast) · N day/night · click building`;
  if (manual == null) requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

window.__app = { scene, camera, controls, streamer, env, renderer, materials, ao, atmosphere, traffic, shared, viewLink, get sim() { return sim; }, clockTime, ride, stopRiding, chase, driver, players, setMode, get mode() { return mode; }, cycleCamera, teleport, hud, drive, stopDriving, keys, xp, governor, frame: (dt) => frame(0, dt),
  proj, manifest,
  // synthetic drone images with labels (src/synth/synth.js; tools/synth/export.mjs), made on first use
  get synth() { return (synthApi ??= import('./synth/synth.js').then(({ Synth }) => new Synth(window.__app))); } };
let synthApi = null;
