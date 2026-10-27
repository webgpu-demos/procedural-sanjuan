// "La mañana": the simulated morning as something to watch. A title, an opening of four shots (dawn over the
// bay, the jam on PR-22, one commuter's ride, sunrise on the Milla de Oro), then the city to explore with a
// clock, the speed of time, the apagón, and the story of any car you ride with.
// Everything it shows comes from the simulation (tools/sim) and the data it was made from.
import { SimTraffic } from './world/simtraffic.js';
import { CitySound } from './world/sound.js';

const CSS = `
#xp-bars::before, #xp-bars::after { content: ''; position: fixed; left: 0; right: 0; height: 0; background: #000; z-index: 900; transition: height 1.1s cubic-bezier(.6,0,.2,1); pointer-events: none; }
#xp-bars::before { top: 0; } #xp-bars::after { bottom: 0; }
#xp-bars.on::before, #xp-bars.on::after { height: 10.5vh; }
#xp-fade { position: fixed; inset: 0; background: #000; opacity: 0; pointer-events: none; z-index: 950; transition: opacity 0.7s ease; }
#xp-fade.on { opacity: 1; }
.xp { font-family: "Avenir Next", "Segoe UI", system-ui, sans-serif; color: #f6f1e7; }
#xp-cap { position: fixed; left: 50%; bottom: 13vh; transform: translateX(-50%); z-index: 960; text-align: center; width: min(900px, 90vw);
  opacity: 0; transition: opacity 1.2s ease; pointer-events: none; text-shadow: 0 2px 18px rgba(0,0,0,0.75); }
#xp-cap.on { opacity: 1; }
/* (a soft shade behind the lines: over the lit expressway they were lost) */
#xp-cap::before { content: ''; position: absolute; inset: -30px -70px; z-index: -1; background: radial-gradient(ellipse closest-side, rgba(0,0,0,0.5), rgba(0,0,0,0)); }
body:not(.hud-off) #xp-cap { bottom: 140px; } /* (free roaming: above the HUD's ways round the city) */
#xp-cap .a { font-size: clamp(18px, 2.3vw, 30px); font-weight: 600; letter-spacing: 0.01em; }
#xp-cap .b { margin-top: 8px; font-size: clamp(12px, 1.25vw, 15px); letter-spacing: 0.14em; text-transform: uppercase; color: rgba(246,241,231,0.86); }
#xp-start { position: fixed; inset: 0; z-index: 980; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 14px;
  background: radial-gradient(ellipse at 50% 70%, rgba(8,30,46,0.55), rgba(2,6,12,0.88)); transition: opacity 1s ease; }
#xp-start.gone { opacity: 0; pointer-events: none; }
#xp-start .k { font-size: 13px; letter-spacing: 0.5em; color: #5fe0d0; text-transform: uppercase; }
#xp-start h1 { margin: 0; font-size: clamp(44px, 8vw, 104px); font-weight: 800; letter-spacing: 0.02em; line-height: 0.95; text-shadow: 0 0 30px rgba(255,122,69,0.45); }
#xp-start .s { font-size: clamp(16px, 2vw, 22px); color: rgba(246,241,231,0.85); }
#xp-start .d { max-width: 640px; text-align: center; font-size: 13px; line-height: 1.55; color: rgba(246,241,231,0.62); padding: 0 20px; }
#xp-start .row { display: flex; gap: 12px; margin-top: 14px; flex-wrap: wrap; justify-content: center; }
.xp button { appearance: none; border: 0; cursor: pointer; font: inherit; color: inherit; background: none; }
#xp-start button { padding: 13px 26px; border-radius: 999px; font-size: 15px; font-weight: 600; letter-spacing: 0.04em; }
#xp-start .go { background: linear-gradient(90deg, #ff7a45, #f2c94c); color: #1b1206; box-shadow: 0 6px 30px rgba(255,122,69,0.35); }
#xp-start .free { background: rgba(255,255,255,0.1); }
#xp-start button:hover { filter: brightness(1.08); }
#xp-skip { position: fixed; right: 22px; top: 3.2vh; z-index: 970; padding: 7px 14px; border-radius: 999px; background: rgba(0,0,0,0.45); font-size: 12px; letter-spacing: 0.08em; display: none; }
#xp-dock { position: fixed; right: 18px; top: 76px; z-index: 930; display: flex; align-items: center; gap: 8px;
  padding: 6px 8px 6px 14px; border-radius: 16px; background: rgba(18,19,22,0.62); backdrop-filter: blur(14px) saturate(1.2); -webkit-backdrop-filter: blur(14px) saturate(1.2);
  border: 1px solid rgba(255,255,255,0.09); box-shadow: 0 18px 40px -18px rgba(0,0,0,0.7); transition: opacity 0.6s ease, transform 0.6s ease; flex-wrap: wrap; justify-content: center;
  width: min(470px, calc(100vw - 36px)); box-sizing: border-box; font-family: 'Inter', -apple-system, sans-serif; }
#xp-dock.hidden, .hud-hidden #xp-dock { opacity: 0; transform: translateY(-14px); pointer-events: none; }
#xp-dock .clock { display: flex; align-items: baseline; gap: 6px; min-width: 128px; }
#xp-dock .clock .t { font-size: 22px; font-weight: 750; font-variant-numeric: tabular-nums; letter-spacing: -0.01em; }
#xp-dock .clock .ap { font-size: 13px; color: rgba(246,241,231,0.7); }
#xp-dock .clock .day { font-size: 11px; color: rgba(246,241,231,0.5); text-transform: uppercase; letter-spacing: 0.12em; }
#xp-dock .grp { display: flex; gap: 2px; padding: 3px; border-radius: 10px; background: rgba(255,255,255,0.06); }
#xp-dock .grp button { padding: 7px 10px; border-radius: 8px; font-size: 13px; color: rgba(246,241,231,0.75); }
#xp-dock .grp button.on { background: rgba(255,255,255,0.16); color: #fff; }
#xp-dock .grp button.alert.on { background: #c43d2b; color: #fff; }
#xp-dock .act { padding: 9px 13px; border-radius: 10px; background: rgba(255,255,255,0.08); font-size: 13px; }
#xp-dock .act:hover, #xp-dock .grp button:hover { background: rgba(255,255,255,0.18); }
#xp-stats { position: fixed; top: 78px; left: 20px; z-index: 930; font-size: 11px; letter-spacing: 0.12em; text-transform: uppercase; color: rgba(246,241,231,0.7);
  text-shadow: 0 1px 8px rgba(0,0,0,0.6); pointer-events: none; transition: opacity 0.6s; }
#xp-stats b { color: #fff; font-weight: 600; }
#xp-story { position: fixed; right: 18px; bottom: 200px; z-index: 935; width: 300px; padding: 14px 16px; border-radius: 14px;
  background: rgba(8,12,20,0.66); backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px); box-shadow: 0 8px 30px rgba(0,0,0,0.35);
  opacity: 0; transform: translateY(10px); transition: opacity 0.5s ease, transform 0.5s ease; pointer-events: none; }
#xp-story.on { opacity: 1; transform: none; }
#xp-story .h { font-size: 11px; letter-spacing: 0.16em; text-transform: uppercase; color: #5fe0d0; }
#xp-story .r { margin-top: 6px; font-size: 19px; font-weight: 700; }
#xp-story .w { margin-top: 2px; font-size: 13px; color: rgba(246,241,231,0.78); }
#xp-story .g { display: grid; grid-template-columns: 1fr 1fr; gap: 8px 12px; margin-top: 12px; }
#xp-story .g div { font-size: 11px; color: rgba(246,241,231,0.55); text-transform: uppercase; letter-spacing: 0.08em; }
#xp-story .g b { display: block; font-size: 16px; color: #fff; text-transform: none; letter-spacing: 0; margin-top: 2px; font-variant-numeric: tabular-nums; }
#xp-story .st { margin-top: 10px; font-size: 12px; color: rgba(246,241,231,0.7); min-height: 1.3em; }
#xp-dock .act .k { font-size: 10px; padding: 1px 5px; margin-left: 4px; border-radius: 4px; background: rgba(255,255,255,0.14); color: rgba(246,241,231,0.8); }
#xp-drive { position: fixed; right: 26px; bottom: 96px; z-index: 935; text-align: right; pointer-events: none; opacity: 0; transition: opacity 0.4s ease; text-shadow: 0 2px 14px rgba(0,0,0,0.7); }
#xp-drive.on { opacity: 1; }
#xp-drive .v { font-size: 64px; font-weight: 800; line-height: 1; font-variant-numeric: tabular-nums; letter-spacing: -0.02em; }
#xp-drive .u { font-size: 13px; letter-spacing: 0.2em; color: rgba(246,241,231,0.7); }
#xp-drive .st { margin-top: 6px; font-size: 15px; font-weight: 600; }
#xp-drive .help { margin-top: 10px; font-size: 11px; letter-spacing: 0.06em; color: rgba(246,241,231,0.55); }
#xp-time { flex-basis: 100%; position: relative; height: 22px; margin: 2px 4px 0; }
#xp-time input { width: 100%; margin: 0; appearance: none; -webkit-appearance: none; height: 22px; background: transparent; cursor: pointer; position: relative; z-index: 2; }
#xp-time input::-webkit-slider-runnable-track { height: 4px; border-radius: 2px; background: linear-gradient(90deg, #0b2a44 0%, #2a5d8a 22%, #f2a65a 33%, #ffe6b0 40%, #9fd4ff 100%); }
#xp-time input::-moz-range-track { height: 4px; border-radius: 2px; background: linear-gradient(90deg, #0b2a44 0%, #2a5d8a 22%, #f2a65a 33%, #ffe6b0 40%, #9fd4ff 100%); }
#xp-time input::-webkit-slider-thumb { -webkit-appearance: none; width: 14px; height: 14px; margin-top: -5px; border-radius: 50%; background: #fff; box-shadow: 0 0 10px rgba(255,255,255,0.7); }
#xp-time input::-moz-range-thumb { width: 14px; height: 14px; border: 0; border-radius: 50%; background: #fff; }
#xp-time .mark { position: absolute; top: 15px; transform: translateX(-50%); font-size: 9.5px; letter-spacing: 0.08em; text-transform: uppercase; color: rgba(246,241,231,0.55); white-space: nowrap; pointer-events: none; }
#xp-time .mark.alert { color: #ff6a4d; }
#xp-dock { padding-bottom: 16px; }
#xp-truth { position: fixed; left: 50%; bottom: 84px; transform: translateX(-50%); z-index: 945; width: min(560px, calc(100vw - 24px)); padding: 16px 18px;
  border-radius: 14px; background: rgba(8,12,20,0.86); backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px); box-shadow: 0 10px 40px rgba(0,0,0,0.45);
  font-size: 13px; line-height: 1.5; color: rgba(246,241,231,0.85); }
#xp-truth[hidden] { display: none; }
#xp-truth h3 { margin: 0 0 2px; font-size: 16px; color: #fff; }
#xp-truth .sub { font-size: 11px; letter-spacing: 0.12em; text-transform: uppercase; color: #5fe0d0; margin-bottom: 10px; }
#xp-truth .nums { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin: 10px 0; }
#xp-truth .nums div { padding: 8px 10px; border-radius: 10px; background: rgba(255,255,255,0.06); font-size: 11px; color: rgba(246,241,231,0.6); }
#xp-truth .nums b { display: block; font-size: 22px; color: #fff; font-variant-numeric: tabular-nums; }
#xp-truth canvas { width: 100%; height: 190px; border-radius: 10px; background: rgba(255,255,255,0.04); }
#xp-truth .not { margin-top: 8px; font-size: 12px; color: rgba(246,241,231,0.6); }
@media (max-width: 760px) { body:not(.hud-off) #xp-stats { display: none; } #xp-dock { top: 70px; padding: 4px 6px 12px 10px; gap: 6px; }
  #xp-dock .clock .t { font-size: 19px; } #xp-dock .act { padding: 7px 10px; font-size: 12px; } #xp-dock .grp button { font-size: 12px; } #xp-time .mark { font-size: 8.5px; } }
@media (max-width: 700px) { #xp-dock .clock .t { font-size: 19px; } #xp-story { width: calc(100vw - 36px); bottom: 150px; } #xp-dock .grp button { padding: 6px 7px; } }
`;

const KIND = {
  work: ['va al trabajo', 'commuting to work'], 'school': ['lleva a los nenes a la escuela', 'the school run'],
  'school-return': ['vuelve de dejar a los nenes', 'back from the school run'], errand: ['hace una diligencia', 'an errand'],
  through: ['pasa por San Juan', 'driving through San Juan'], delivery: ['hace entregas', 'making deliveries'],
  airport: ['va al aeropuerto', 'to the airport (SJU)'], 'airport-return': ['vuelve del aeropuerto', 'back from the airport'],
};
const TYPE_NAME = ['carro compacto', 'sedán', 'SUV', 'pickup', 'camión de entregas', 'guagua'];
const DAYS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const ease = (t) => t * t * (3 - 2 * t);
const lerp = (a, b, t) => a + (b - a) * t;
const clockLabel = (hour) => {
  const h = Math.floor(hour) % 24, m = Math.floor((hour % 1) * 60);
  return { t: `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')}`, ap: h < 12 ? 'a.m.' : 'p.m.' };
};

// Where the grid failed in the apagón: the Monacillos transmission centre, Río Piedras (lon -66.075, lat 18.39)
const GRID_ORIGIN = [4390, 8330];

export class Experience {
  // app: what the page shares (main.js): scene, camera, controls, streamer, clockTime, atmosphere, sim (getter),
  // setScenario(name) -> Promise, ride(vid), stopRiding(), chase, roads, manifest
  constructor(app) {
    this.app = app;
    this.sound = new CitySound();
    this.directing = false;  // the opening owns the camera
    this.shot = -1; this.shotT = 0;
    this.scenario = 'morning';
    this.wave = null;        // the apagón's spreading darkness: { start (performance.now) } or null
    const style = document.createElement('style'); style.textContent = CSS; document.head.appendChild(style);
    const el = (html) => { const d = document.createElement('div'); d.innerHTML = html.trim(); return document.body.appendChild(d.firstChild); };
    this.bars = el('<div id="xp-bars"></div>');
    this.fade = el('<div id="xp-fade"></div>');
    this.cap = el('<div id="xp-cap" class="xp"><div class="a"></div><div class="b"></div></div>');
    this.stats = el('<div id="xp-stats" class="xp"></div>');
    this.story = el(`<div id="xp-story" class="xp"><div class="h">Siguiendo un carro · riding along</div><div class="r"></div><div class="w"></div>
      <div class="g"><div>salió<b class="dep">–</b></div><div>velocidad<b class="spd">–</b></div><div>demora del viaje<b class="loss">–</b></div><div>vehículo<b class="typ">–</b></div></div>
      <div class="st"></div></div>`);
    this.skip = el('<button id="xp-skip" class="xp">Saltar intro · skip ›</button>');
    this.dock = el(`<div id="xp-dock" class="xp hidden">
      <div id="xp-time"><input type="range" min="16200" max="36000" step="30" value="21060"></div>
      <div class="clock"><span class="t">5:50</span><span class="ap">a.m.</span><span class="day"></span></div>
      <div class="grp speed"><button data-r="0" title="pausa">❚❚</button><button data-r="1">1×</button><button data-r="6">6×</button><button data-r="30">30×</button><button data-r="120">120×</button></div>
      <div class="grp scen"><button data-s="morning" class="on">Mañana normal</button><button data-s="apagon" class="alert">Apagón</button></div>
      <button class="act ride">🚗 Seguir un carro</button>
      <button class="act map">🗺️ Tapón</button>
      <button class="act truth">📊 ¿Qué tan real?</button>
    </div>`);
    this.truth = el(`<div id="xp-truth" class="xp" hidden></div>`);
    this.dock.querySelectorAll('.speed button').forEach((b) => b.addEventListener('click', () => { this.app.clockTime.rate = Number(b.dataset.r); }));
    // the morning as a line: drag to any moment of it
    this.timeInput = this.dock.querySelector('#xp-time input');
    this.timeInput.addEventListener('input', () => { this.app.clockTime.live = false; this.app.clockTime.hour = Number(this.timeInput.value) / 3600; this.scrubbing = true; });
    this.timeInput.addEventListener('change', () => { this.scrubbing = false; });
    this.marks();
    this.dock.querySelectorAll('.scen button').forEach((b) => b.addEventListener('click', () => this.setScenario(b.dataset.s)));
    this.dock.querySelector('.ride').addEventListener('click', () => this.rideNear());
    this.dock.querySelector('.truth').addEventListener('click', () => this.toggleTruth());
    this.dock.querySelector('.map').addEventListener('click', () => {
      const m = this.app.speedMap; if (!m) return;
      m.on = !m.on; this.mapButton();
    });
    this.skip.addEventListener('click', () => this.endIntro());
    addEventListener('keydown', (e) => { if (this.directing && (e.key === 'Escape' || e.key === ' ')) { e.preventDefault(); this.endIntro(); } });
    // driving wants a keyboard: on a touch screen alone, the button is not offered
    this.canDrive = !!app.drive && !(matchMedia('(pointer: coarse)').matches && !matchMedia('(any-pointer: fine)').matches);
    this.trips = null; this.tripinfo = null; this.loadStories(this.app.sim);
    this.nameIndex = this.indexNames(app.roads);
  }

  // ---------------------------------------------------------------- data for the stories
  async loadStories(sim) {
    if (!sim) return;
    const [t, i] = await Promise.all([fetch(`${sim.base}/trips.bin`).then((r) => r.arrayBuffer()), fetch(`${sim.base}/tripinfo.bin`).then((r) => r.arrayBuffer())]).catch(() => [null, null]);
    this.trips = t ? new DataView(t) : null; this.tripinfo = i ? new Uint16Array(i) : null;
  }
  trip(vid) {
    const idx = this.app.sim.index;
    if (!this.trips || vid * 5 + 5 > this.trips.byteLength) return null;
    const d = this.trips, o = vid * 5;
    return { kind: idx.kinds[d.getUint8(o)], from: idx.municipios[d.getUint8(o + 1) - 1] ?? '', to: idx.municipios[d.getUint8(o + 2) - 1] ?? '', depart: d.getUint16(o + 3, true) / 60,
      loss: this.tripinfo && vid * 2 + 1 < this.tripinfo.length ? this.tripinfo[vid * 2] : null, km: this.tripinfo && vid * 2 + 1 < this.tripinfo.length ? this.tripinfo[vid * 2 + 1] / 100 : null };
  }
  // road names by 60 m cell, for "on Avenida Ponce de León"
  indexNames(roads) {
    const cells = new Map();
    if (!roads) return cells;
    for (const e of roads.edges) {
      const name = e.name ?? e.ref; if (!name) continue;
      const p = e.pts;
      for (let i = 0; i < p.length; i += 3) {
        const k = Math.floor(p[i] / 60) + ',' + Math.floor(p[i + 2] / 60);
        if (!cells.has(k)) cells.set(k, []);
        cells.get(k).push([p[i], p[i + 2], e.ref && e.name ? `${e.name} (${e.ref})` : name]);
      }
    }
    return cells;
  }
  streetAt(x, z) {
    let best = null, bd = 28;
    const cx = Math.floor(x / 60), cz = Math.floor(z / 60);
    for (let i = cx - 1; i <= cx + 1; i++) for (let j = cz - 1; j <= cz + 1; j++)
      for (const [px, pz, n] of this.nameIndex.get(i + ',' + j) ?? []) { const d = Math.hypot(px - x, pz - z); if (d < bd) { bd = d; best = n; } }
    return best;
  }

  // ---------------------------------------------------------------- the title, the opening
  showTitle(total) {
    const n = total ? total.toLocaleString('es-PR') : '', end = clockLabel((this.app.sim?.end ?? 36000) / 3600).t;
    this.titleUp = true;
    this.start = (() => { const d = document.createElement('div'); d.id = 'xp-start'; d.className = 'xp'; document.body.appendChild(d); return d; })();
    this.start.innerHTML = `<div class="k">Puerto Rico · simulación</div><h1>SAN JUAN</h1><div class="s">La mañana — un martes cualquiera</div>
      <div class="d">${n ? n + ' viajes' : 'Cada viaje'} simulados con SUMO, de las 4:30 a las ${end} de la mañana: quién sale de dónde, cuándo y hacia dónde,
      según el Censo (ACS), con los conteos de la FHWA y las calles de OpenStreetMap.<br>Every car you will see is a simulated trip.</div>
      <div class="row"><button class="go">▶ Comenzar · with sound</button><button class="free">Explorar libremente</button></div>`;
    this.start.querySelector('.go').addEventListener('click', () => { this.sound.start(); this.setSoundButton(); this.hideTitle(); this.beginIntro(); });
    this.start.querySelector('.free').addEventListener('click', () => { this.clouds(); this.hideTitle(); this.endIntro(true); this.app.startFree?.(); });
  }
  hideTitle() { this.titleUp = false; this.start?.classList.add('gone'); setTimeout(() => this.start?.remove(), 1100); }

  // The opening: dark (5:28), blue hour over the expressway into the city (5:58), a ride with the headlights on
  // (6:06), the sun coming up behind the towers of the Milla de Oro, looking east (it rises about 6:19 in late
  // October, a little south of east)
  get shots() {
    return [
      { hour: 5.47, rate: 1, dur: 13, eye: [[1300, 520, 7700], [1950, 470, 7050]], at: [[5400, 40, 3000], [5600, 40, 3150]],
        cap: ['San Juan, 5:28 a.m.', 'Un martes, antes del amanecer · a Tuesday, before dawn'] },
      { hour: 6.24, rate: 1, dur: 13, eye: [[1700, 46, 5330], [2010, 38, 5192]], at: [[2900, 3, 5193], [3250, 3, 5100]],
        cap: ['138,000 personas entran a San Juan cada mañana', 'commuters driving in every weekday · U.S. Census ACS'] },
      { hour: 6.28, rate: 1, dur: 18, ride: [2700, 5273, 420] },
      { hour: 6.322, rate: 1, dur: 16, eye: [[4974, 75, 4153], [5084, 170, 4243]], at: [[6274, 80, 4503], [6284, 60, 4523]],
        cap: ['Puerto Rico en movimiento', 'Cada carro es un viaje simulado · every car is a simulated trip'] },
    ];
  }
  // the trade-wind cumulus over the island, lit by the dawn (unless the link set the clouds itself)
  clouds() {
    const a = this.app.atmosphere;
    if (new URLSearchParams(location.search).has('clouds') || innerWidth < 700) return; // (heavy: not on a phone)
    a.coverage = 0.3; a.quality = 'medium'; a.cloudsOn = true;
  }
  // (the high shots stay under the trade-wind cumulus: its base is at 450 m)
  // The apagón as a scene: high over Hato Rey, looking south to Monacillos as the grid stumbles and the dark rolls
  // towards the camera; then, with the day, Avenida Piñero in Río Piedras queued at its dead signals (where the
  // run jams worst against the ordinary morning); then Río Piedras from the east, the sun behind, red with the jam
  apagonShots(at) {
    const h = (s) => (at + s) / 3600;
    return [
      { hour: h(-9), rate: 1, dur: 21, eye: [[4150, 410, 2350], [4250, 390, 2750]], at: [[4450, 0, 7600], [4450, 0, 7700]],
        cap: ['5:45 a.m.', 'Monacillos, Río Piedras · el centro de transmisión'], capAt: 1.5 },
      { hour: 7.0, rate: 1, dur: 15, eye: [[5040, 8, 6425], [5072, 6.5, 6422]], at: [[5195, 2.5, 6416], [5195, 2.5, 6416]],
        cap: ['7:00 a.m. · Avenida Piñero, Río Piedras', 'sin semáforos: cada esquina, un pare · every signal dark, every corner a stop'] },
      { hour: 7.3, rate: 1, dur: 15, map: true, eye: [[6500, 380, 6000], [6300, 330, 6150]], at: [[4800, 0, 7200], [4750, 0, 7250]],
        cap: ['7:18 a.m. · sin semáforos', 'the rush hour, with no signals: red is the jam'] },
    ];
  }
  playApagon(at) {
    if (innerWidth < 700) return false; // (a phone: just the clock and the caption)
    this.reel = this.apagonShots(at); this.reelName = 'apagon';
    this.directing = true; this.app.controls.enabled = false;
    this.bars.classList.add('on'); this.skip.style.display = 'block';
    this.app.atmosphere.vignette.darkness = 0.55;
    this.shot = -1; this.cut(0);
    return true;
  }
  beginIntro() {
    this.clouds();
    this.reel = this.shots; this.reelName = 'intro';
    this.directing = true; this.app.controls.enabled = false;
    this.bars.classList.add('on'); this.skip.style.display = 'block';
    this.app.atmosphere.vignette.darkness = 0.55; this.app.atmosphere.grain.blendMode.opacity.value = 0.08;
    this.shot = -1; this.cut(0);
  }
  // to shot k, through black
  async cut(k) {
    const shots = this.reel;
    this.fade.classList.add('on'); this.caption(null); this.fading = true; // (in the black: a moment for changes that would show)
    await new Promise((r) => setTimeout(r, 750));
    if (!this.directing) return;
    if (k >= shots.length) { this.endIntro(); return; }
    const s = shots[k], app = this.app;
    this.shot = k; this.shotT = 0;
    app.stopRiding();
    if (app.sim) app.sim.near = 1300; // (a directed shot: every car in the picture as itself, out to the middle distance)
    app.clockTime.live = false; app.clockTime.hour = s.hour; app.clockTime.rate = 0;
    // place the camera at the start of the shot and let the city and the cars arrive before the picture does
    if (s.eye) this.place(s, 0); else { app.controls.target.set(s.ride[0], 0, s.ride[1]); app.camera.position.set(s.ride[0] - 60, 80, s.ride[1] + 60); }
    const sim = app.sim, T = s.hour * 3600;
    // every window of cars the shot will play through, loaded before it is seen and kept until it ends (the
    // clock would otherwise wait for one mid-shot, and every car stand still while the camera glides on)
    const span = [T, T + s.dur * Math.max(1, s.rate) + 20], ws = [];
    if (sim) { sim.keep = span; for (let w = sim.windowStart(span[0]); w < span[1]; w += sim.index.window) { sim.ensure(w); ws.push(w); } }
    // (and the tiles round the camera and ahead of it, in the black: up to half a minute on a slow connection,
    // rather than a shot that opens on the bare terrain with the cars driving over it)
    for (let i = 0, quiet = 0; i < 300; i++) {
      const ready = ws.every((w) => { const W = sim.windows.get(w); return (W && W !== 'loading') || w >= sim.end || sim.failed.has(w); });
      quiet = app.streamer.pending ? 0 : quiet + 1;
      if ((!sim || ready) && quiet >= 3 && i > 6) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    if (s.ride) {
      // (on the road for the whole shot: a car whose trip ended halfway was swapped for another, a different car)
      const cars = sim.carsNear(T, s.ride[0], s.ride[1], s.ride[2], s.dur + 20).filter((c) => c.moving && Math.sin(c.heading) > 0.3)
        .filter((c, i) => i > 400 || sim.alive(c.vid, T + s.dur + 4));
      // a commuter from beyond the city, if there is one in reach (on the expressway, at its speed, if one is):
      // the story of the morning
      const commuter = (c) => { const t = this.trip(c.vid); return t && t.kind === 'work' && t.from && t.from !== 'San Juan'; };
      // (on the expressway itself, not the avenue alongside it)
      const onX = (c) => sim.onExpressway?.(c.x, c.z, c.heading) ?? true;
      const pick = cars.find((c) => onX(c) && c.speed > 16 && commuter(c)) ?? cars.find((c) => onX(c) && commuter(c)) ?? cars.find(onX)
        ?? cars.find((c) => c.speed > 16 && commuter(c)) ?? cars.find(commuter) ?? cars[0];
      // (low and close behind it, all in focus: from 13 m back and up, softened before and behind, the expressway
      // looked like a model of itself)
      if (pick) { app.ride(pick.vid); Object.assign(app.chase, { back: 9.5, tilt: 0.15, sharp: true }); }
    }
    app.clockTime.rate = s.rate;
    if (app.speedMap) { app.speedMap.on = !!s.map; this.mapButton(); }
    if (s.cap) setTimeout(() => this.directing && this.shot === k && this.caption(s.cap), (s.capAt ?? 0.9) * 1000);
    this.fade.classList.remove('on'); this.fading = false;
  }
  place(s, f) {
    const g = (x, z) => this.app.streamer.ground(x, z), e = ease(Math.min(1, f));
    const ex = lerp(s.eye[0][0], s.eye[1][0], e), ez = lerp(s.eye[0][2], s.eye[1][2], e), ey = lerp(s.eye[0][1], s.eye[1][1], e);
    const ax = lerp(s.at[0][0], s.at[1][0], e), az = lerp(s.at[0][2], s.at[1][2], e), ay = lerp(s.at[0][1], s.at[1][1], e);
    this.app.camera.position.set(ex, g(ex, ez) + ey, ez);
    this.app.controls.target.set(ax, g(ax, az) + ay, az);
    this.app.camera.lookAt(this.app.controls.target);
  }
  caption(lines) {
    if (!lines) { this.cap.classList.remove('on'); return; }
    this.cap.querySelector('.a').textContent = lines[0]; this.cap.querySelector('.b').textContent = lines[1] ?? '';
    this.cap.classList.add('on');
  }
  endIntro(fromTitle = false) {
    const app = this.app, reel = this.reelName;
    this.directing = false; this.shot = -1; this.reelName = null; this.fading = false;
    if (app.sim) app.sim.keep = null;
    if (app.sim) app.sim.near = app.sim.constructor.NEAR;
    this.bars.classList.remove('on'); this.skip.style.display = 'none'; this.caption(null);
    this.fade.classList.remove('on');
    app.atmosphere.vignette.darkness = 0.38; app.atmosphere.grain.blendMode.opacity.value = 0.05;
    app.stopRiding();
    if (reel === 'apagon') { app.controls.enabled = true; app.clockTime.rate = 1; this.dock.classList.remove('hidden'); return; } // (where the scene ended)
    // the morning at its own pace: every car at the speed it drives (the dock's buttons speed the clock up)
    if (!fromTitle) { app.controls.enabled = true; app.clockTime.live = false; app.clockTime.rate = 1; }
    else { app.clockTime.rate = Math.max(app.clockTime.rate, 1); }
    // the view the opening ended on, as a free camera over the Milla de Oro
    if (!fromTitle) {
      const s = this.shots.at(-1);
      app.clockTime.hour = Math.max(app.clockTime.hour, s.hour + 0.05);
      this.place(s, 1);
    }
    app.controls.enabled = true;
    this.dock.classList.remove('hidden');
    // what can be done now: the ways round the city (a keyboard's)
    if (this.canDrive && !fromTitle) { this.caption(['Recorre San Juan: 2 caminar · 3 bici · 4 manejar · 5 volar', 'walk, cycle, drive or fly · M for the map · V for the camera']); setTimeout(() => !this.directing && this.caption(null), 7000); }
  }

  // the moments of the morning, under the time line
  marks() {
    const box = this.dock.querySelector('#xp-time');
    if (this.app.sim) { this.timeInput.min = String(this.app.sim.begin); this.timeInput.max = String(this.app.sim.end); }
    box.querySelectorAll('.mark').forEach((m) => m.remove());
    const at = (sec, text, cls = '') => {
      const m = document.createElement('div'); m.className = 'mark ' + cls; m.textContent = text;
      const lo = this.app.sim?.begin ?? 16200, hi = this.app.sim?.end ?? 36000;
      m.style.left = `${((sec - lo) / (hi - lo)) * 100}%`; box.appendChild(m);
    };
    const hi = this.app.sim?.end ?? 36000, end = clockLabel(hi / 3600);
    at(16200 + 600, '4:30'); at(6.32 * 3600, 'amanece'); at(7.25 * 3600, 'hora pico'); at(hi - 600, end.t);
    if (this.app.sim?.index.apagon != null) at(this.app.sim.index.apagon, 'apagón', 'alert');
  }

  // ---------------------------------------------------------------- controls
  rideNear() {
    const app = this.app, sim = app.sim; if (!sim) return;
    const T = app.clockTime.hour * 3600, t = app.controls.target;
    for (const r of [400, 1200, 3000]) {
      const cars = sim.carsNear(T, t.x, t.z, r, 90).filter((c) => c.moving);
      if (cars.length) { app.ride(cars[Math.floor(Math.random() * cars.length)].vid); return; }
    }
  }
  async setScenario(name) {
    if (name === this.scenario) return;
    this.dock.querySelectorAll('.scen button').forEach((b) => b.classList.toggle('on', b.dataset.s === name));
    const ok = await this.app.setScenario(name);
    if (!ok) { this.dock.querySelectorAll('.scen button').forEach((b) => b.classList.toggle('on', b.dataset.s === this.scenario)); return; }
    this.scenario = name; this.wave = null; this.marks();
    await this.loadStories(this.app.sim);
    const at = this.app.sim.index.apagon;
    if (at != null && !this.directing && this.playApagon(at)) return;
    if (at != null) {
      const T = this.app.clockTime.hour * 3600;
      // before the failure: bring the clock to a minute before it, so the moment can be watched
      if (T > at + 600 || T < at - 1800) { this.app.clockTime.hour = (at - 75) / 3600; }
      this.caption(['Apagón · 5:45 a.m.', 'La red eléctrica falla y todos los semáforos se apagan · the grid fails; every signal goes dark']);
      setTimeout(() => this.caption(null), 6500);
    }
  }
  // How real is it: the run against the counts (validation.json, tools/sim/validate.py)
  async toggleTruth() {
    if (!this.truth.hidden) { this.truth.hidden = true; return; }
    const sim = this.app.sim, v = await fetch(`${sim.base}/validation.json`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    const n = (sim.index.tripinfo?.count ?? 0).toLocaleString('es-PR'), a = v?.all, end = clockLabel(sim.end / 3600).t;
    this.truth.innerHTML = `<h3>¿Qué tan real es esto?</h3><div class="sub">How real is this</div>
      <div>${n} viajes simulados con SUMO, de las 4:30 a las ${end}, a partir de los flujos de viaje al trabajo del Censo (ACS),
      las horas de salida de cada municipio y los edificios de la ciudad. Se comparan con los conteos de tránsito de la FHWA (HPMS 2024).</div>
      ${sim.index.share ? `<div class="not">Se simula el ${Math.round(sim.index.share * 100)}% de la demanda estimada: con más, las
      intersecciones de la red simulada (trazadas de OpenStreetMap, con semáforos supuestos) se trancan por completo antes de las 8. Es
      un límite del modelo, no de la ciudad. · ${Math.round(sim.index.share * 100)}% of the estimated demand: with more, the simulated
      network locks solid before 8 a.m.</div>` : ''}
      ${a ? `<div class="nums"><div>conteos comparados<b>${a.n}</b></div><div>GEH &lt; 5 (meta: 85%)<b>${Math.round(a.geh5 * 100)}%</b></div><div>simulado / contado<b>${a.ratio.toFixed(2)}</b></div></div>
      <canvas width="1040" height="380"></canvas>` : '<div class="not">(la validación de esta corrida no está disponible)</div>'}
      <div class="not">Lo que no es: tránsito en vivo ni carros reales. Es un modelo, calibrado con datos públicos y comparado con conteos;
      cada punto es una vía contada (7–8 a.m.): sobre la diagonal, el modelo acierta. · Not live traffic: a model, checked against counts.</div>`;
    this.truth.hidden = false;
    const cv = this.truth.querySelector('canvas');
    if (cv && v) {
      const g = cv.getContext('2d'), W = cv.width, H = cv.height, P = 46, max = Math.max(...v.points.map((p) => Math.max(p[0], p[1])), 100);
      const sx = (x) => P + (Math.log10(Math.max(x, 10)) - 1) / (Math.log10(max) - 1) * (W - P * 1.5), sy = (y) => H - P - (Math.log10(Math.max(y, 10)) - 1) / (Math.log10(max) - 1) * (H - P * 1.6);
      g.strokeStyle = 'rgba(255,255,255,0.25)'; g.lineWidth = 2; g.beginPath(); g.moveTo(sx(10), sy(10)); g.lineTo(sx(max), sy(max)); g.stroke();
      g.fillStyle = 'rgba(246,241,231,0.55)'; g.font = '22px system-ui'; g.fillText('contado (veh/h) →', W / 2 - 80, H - 10);
      g.save(); g.translate(18, H / 2 + 60); g.rotate(-Math.PI / 2); g.fillText('simulado →', 0, 0); g.restore();
      for (const [c, m, f] of v.points) { g.fillStyle = f <= 2 ? '#ff7a45' : f <= 4 ? '#f2c94c' : '#5fe0d0'; g.beginPath(); g.arc(sx(c), sy(m), 5, 0, Math.PI * 2); g.fill(); }
    }
  }
  mapButton() {
    const b = this.dock.querySelector('.map'), on = !!this.app.speedMap?.on;
    b.classList.toggle('on', on); b.style.background = on ? 'rgba(255,122,69,0.45)' : '';
  }
  toggleSound() { if (this.sound.on) this.sound.stop(); else this.sound.start(); this.setSoundButton(); }
  setSoundButton() { /* (the HUD's sound button follows the sound itself: hud.js) */ }

  // ---------------------------------------------------------------- each frame
  update(dt, { night, uGrid }) {
    const app = this.app, sim = app.sim, T = app.clockTime.hour * 3600;
    // the opening's camera
    if (this.directing && this.shot >= 0) {
      const s = this.reel[this.shot];
      // (the shot's time runs once the picture is up: in the black, while the city arrives, it waits at the start)
      if (!this.fading) this.shotT += dt;
      if (s.eye) this.place(s, this.shotT / s.dur);
      if (this.shotT > s.dur && !this.cutting) { this.cutting = true; this.cut(this.shot + 1).then(() => { this.cutting = false; }); }
    }
    // the end of the simulated morning: round again from before dawn (it can run as a loop, unattended)
    const ran = this.lastT != null && this.lastT < sim?.end - 30 && T - this.lastT < 60; this.lastT = T;
    if (sim && ran && !this.directing && app.clockTime.rate > 0 && T >= sim.end - 30) {
      app.clockTime.hour = 5.45; this.wave = null;
      this.caption(['Otra mañana', 'the simulated morning begins again']); setTimeout(() => this.caption(null), 4000);
    }
    // the clock
    const c = clockLabel(app.clockTime.hour);
    this.dock.querySelector('.t').textContent = c.t; this.dock.querySelector('.ap').textContent = c.ap;
    this.dock.querySelector('.day').textContent = sim && !sim.ready(T) ? 'cargando…' : 'martes'; // (the clock waiting for the cars)
    if (!this.scrubbing) this.timeInput.value = String(Math.round(app.clockTime.hour * 3600));
    this.dock.querySelectorAll('.speed button').forEach((b) => b.classList.toggle('on', Number(b.dataset.r) === app.clockTime.rate));
    // the apagón: the darkness spreads from where the grid failed, at a few hundred metres a second
    const at = sim?.index.apagon;
    if (at != null && T >= at) {
      if (!this.wave) { this.wave = { start: performance.now(), late: T - at > 30 }; if (!this.wave.late) this.sound.blackout(); }
      // the grid stumbles (the lights flicker, the whole city at once) for a second, then the dark spreads
      const age = (performance.now() - this.wave.start) / 1000, FLICKER = 1.3;
      let r = this.wave.late ? 1e6 : Math.max(0, age - FLICKER) * 650;
      if (!this.wave.late && age < FLICKER) r = Math.sin(age * 37) * Math.sin(age * 23) > 0.15 ? 1e6 : -1;
      uGrid.set(GRID_ORIGIN[0], GRID_ORIGIN[1], r, 450);
    } else { this.wave = null; uGrid.set(GRID_ORIGIN[0], GRID_ORIGIN[1], -1, 450); }
    // the numbers
    if (sim) {
      const st = sim.stats;
      this.stats.innerHTML = st.active ? `SUMO · <b>${st.active.toLocaleString('es-PR')}</b> carros en la calle${st.nearSpeed != null ? ` · cerca, <b>${Math.round(st.nearSpeed * 3.6)}</b> km/h` : ''}${uGrid.z >= 0 ? ' · <b style="color:#ff6a4d">apagón</b>' : ''}` : '';
      this.stats.style.opacity = this.directing ? 0 : 1;
    }
    // the story of the car being ridden with
    const v = app.mode && app.mode !== 'explore' ? null : sim?.view;
    if (v && app.chase.on) {
      const t = this.trip(v.vid), bus = sim.buses?.[v.vid];
      this.story.classList.add('on');
      if (bus) {
        this.story.querySelector('.r').textContent = `AMA · Ruta ${bus[0]}`;
        this.story.querySelector('.w').textContent = `${bus[1]}${bus[2] ? ' → ' + bus[2] : ''} · horario real (GTFS)`;
        this.story.querySelector('.dep').textContent = '–'; this.story.querySelector('.loss').textContent = '–';
      } else if (t) {
        const k = KIND[t.kind] ?? [t.kind, ''], dep = clockLabel(t.depart);
        this.story.querySelector('.r').textContent = t.from && t.to && t.from !== t.to ? `${t.from} → ${t.to}` : t.from ? `En ${t.from}` : 'De paso';
        this.story.querySelector('.w').textContent = `${k[0]} · ${k[1]}`;
        this.story.querySelector('.dep').textContent = `${dep.t} ${dep.ap}`;
        this.story.querySelector('.loss').textContent = t.loss != null ? `${Math.round(t.loss / 60)} min` : '–';
      }
      this.story.querySelector('.spd').textContent = `${Math.round(v.speed * 3.6)} km/h`;
      this.story.querySelector('.typ').textContent = TYPE_NAME[v.type] ?? '';
      const street = this.streetAt(v.x, v.z);
      this.story.querySelector('.st').textContent = street ? `por ${street}` : '';
    } else this.story.classList.remove('on');
    // the sound
    this.sound.update(dt, {
      night, cars: sim?.stats.near ?? 0, moving: sim?.stats.nearSpeed ?? 0, jammed: sim?.stats.nearStopped ?? 0,
      height: app.camera.position.y - app.streamer.ground(app.camera.position.x, app.camera.position.z),
      powered: uGrid.z < 0 ? 1 : Math.hypot(app.controls.target.x - uGrid.x, app.controls.target.z - uGrid.y) > uGrid.z ? 1 : 0,
    });
  }
}
