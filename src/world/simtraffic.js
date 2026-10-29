// The simulated morning (tools/sim/run.py): every car on the road is a trip SUMO drove, played back from its
// recorded track: where it was at every moment, within 35 cm, its stops at the lights and in the queues
// included. Nothing here decides where a car goes; it only shows what the simulation did.
//
// Three levels of detail, by distance from the camera:
//   near   the full car models (traffic.js), brake lights from the track's deceleration, lamps on the road
//   mid    a plain box in the car's colour
//   lights every car out to the horizon as its lamps: white ahead, red behind (they show from dusk to dawn)
// Tracks come in windows of the morning (w_<t>.bin, WINDOW s each), fetched ahead of the clock.
import * as THREE from 'three';
import { segDist, vehicleCapsule } from './collide.js';
import { roadLanes, paintOf, pavedHalf } from './flyovers.js';
import { DrawnDecks } from './roadlevel.js';
import { Fleet, BODY_OF, lookOf, wheelBlur } from './fleet.js';
import { TYPES, dissolve, beamGeometry, beamTexture } from './traffic.js';
import { shared } from './materials.js';
import { LAMP_LAYER, lampMaterial, lampUniforms } from './lamplight.js';

const NEAR = 700, MID = 2800, LIGHTS = 12000;           // metres from the camera (near: the default; sim.near)
const BAND = 110;                                       // a car hands over from its model to its box over this
const DETAIL = 250;                                     // within this, the full model; beyond, a lighter one
// a 24 m cell's number (the corrected levels by cell, fixAt): the cell east of it is +1, north +CELLS
const CELLS = 1 << 16;
const reversed = (pts) => { const out = []; for (let k = pts.length - 3; k >= 0; k -= 3) out.push(pts[k], pts[k + 1], pts[k + 2]); return out; };
const cellKey = (x, z) => (Math.floor(z / 24) + CELLS / 2) * CELLS + Math.floor(x / 24) + CELLS / 2;
const smooth = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const MAX_NEAR = 4500, MAX_MID = 40000, MAX_LIGHTS = 120000;

const hash = (v) => { v = Math.imul(v ^ (v >>> 16), 0x45d9f3b); v = Math.imul(v ^ (v >>> 16), 0x45d9f3b); return ((v ^ (v >>> 16)) >>> 0) / 4294967296; };

// Light sprites: a soft round glow, brighter at night, scaled by distance.
function lightsMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: { uNight: shared.uNight, uScale: { value: 1 } },
    vertexShader: /* glsl */`
      attribute vec3 color;
      uniform float uScale;
      varying vec3 vColor;
      void main() {
        vColor = color;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mv;
        // a lamp, not a ball of light: small up close (the model shows its own), never under two pixels far off
        gl_PointSize = clamp(uScale * 1100.0 / -mv.z, 2.2 * uScale, 8.0 * uScale); // (uScale: device pixels per CSS pixel)
      }`,
    fragmentShader: /* glsl */`
      uniform float uNight;
      varying vec3 vColor;
      void main() {
        vec2 d = gl_PointCoord - 0.5;
        float a = exp(-dot(d, d) * 24.0);
        gl_FragColor = vec4(vColor * a * (0.3 + 5.0 * uNight), 1.0);
      }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
}

export class SimTraffic {
  static NEAR = NEAR;
  // base: the scenario's folder (tiles/<area>/sim/<scenario>); surface(x, z): height of the road surface.
  static async load(base, surface, roads = null, ground = surface, drawn = null) {
    const index = await fetch(`${base}/index.json`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    if (!index) return null;
    const sim = new SimTraffic(base, index, surface);
    if (roads) sim.raise(roads, ground, drawn);
    // the AMA's buses (tools/sim/gtfs.py): route, headsign, colour by vehicle id
    sim.buses = await fetch(`${base}/../buses.json`).then((r) => (r.ok ? r.json() : {})).catch(() => ({}));
    return sim;
  }

  constructor(base, index, surface) {
    this.base = base; this.index = index; this.surface = surface;
    this.begin = index.begin; this.end = index.end;
    this.windows = new Map(); // window start -> decoded | 'loading'
    // the windows are fetched and decoded in a worker (simworker.js): a rush-hour window holds tens of thousands of tracks
    this.worker = new Worker(new URL('./simworker.js', import.meta.url), { type: 'module' });
    this.requests = new Map();
    this.worker.onmessage = ({ data: { id, W, error } }) => {
      const w0 = this.requests.get(id); this.requests.delete(id);
      if (error || !W) { console.warn('track window', w0, error); this.windows.delete(w0); this.failed.set(w0, performance.now()); return; }
      W.cursor = new Uint16Array(W.n); W.heading = new Float32Array(W.n).fill(NaN);
      this.carry(w0, W); this.windows.set(w0, W);
    };
    this.nextRequest = 0; this.failed = new Map(); // window start -> when it last failed (tried again after a while)
    this.group = new THREE.Group(); this.group.name = 'simulated traffic';
    this.stats = { active: 0, near: 0, mid: 0, lights: 0 };
    this.headlights = 5;

    this.beam = lampMaterial(beamTexture(), { vertexColors: true });
    const share = [0.27, 0.24, 0.29, 0.16, 0.04, 0.01];
    // The cars and the buses: the lofted bodies (fleet.js), the full model within DETAIL of the camera, the stand-in out
    // to `near`
    const caps = {};
    TYPES.forEach((t, k) => {
      if (!BODY_OF[t.name]) return;
      for (const [body, f] of t.name === 'suv' ? [['suv', 1], ['minivan', 0.4]] : [[BODY_OF[t.name], 1]]) {
        const c = caps[body] ?? (caps[body] = [16, 16]);
        c[0] += Math.ceil(MAX_NEAR * share[k] * 0.5 * f); c[1] += Math.ceil(MAX_NEAR * share[k] * 1.6 * f);
      }
    });
    this.fleet = new Fleet(caps, { beam: beamGeometry, beamMaterial: this.beam });
    this.group.add(this.fleet.group);
    this.looks = new Map(); this.spins = new Map(); this.fits = new Map();
    // mid distance: one box per car, sized to its type
    const boxGeo = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0), boxMat = new THREE.MeshStandardMaterial({ roughness: 0.45, metalness: 0.3 });
    this.boxHide = new THREE.InstancedBufferAttribute(new Float32Array(MAX_MID), 1); this.boxHide.setUsage(THREE.DynamicDrawUsage);
    boxGeo.setAttribute('aHide', this.boxHide);
    // (the lamp uniforms too, which every material otherwise gets by default: a sampler left unset collides
    // with the shadow map's, and then no box is drawn at all)
    boxMat.onBeforeCompile = (shader) => { lampUniforms(shader); dissolve(shader); }; boxMat.customProgramCacheKey = () => 'car-box-v2';
    this.boxes = new THREE.InstancedMesh(boxGeo, boxMat, MAX_MID);
    this.boxes.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.boxes.frustumCulled = false; this.boxes.count = 0;
    this.boxes.setColorAt(0, new THREE.Color());
    this.group.add(this.boxes);
    // lamps as points of light, two per car
    const lg = new THREE.BufferGeometry();
    this.lightPos = new Float32Array(MAX_LIGHTS * 2 * 3); this.lightCol = new Float32Array(MAX_LIGHTS * 2 * 3);
    lg.setAttribute('position', new THREE.BufferAttribute(this.lightPos, 3).setUsage(THREE.DynamicDrawUsage));
    lg.setAttribute('color', new THREE.BufferAttribute(this.lightCol, 3).setUsage(THREE.DynamicDrawUsage));
    lg.setDrawRange(0, 0);
    this.lights = new THREE.Points(lg, lightsMaterial());
    this.lights.frustumCulled = false;
    this.group.add(this.lights);

    this.color = new THREE.Color();
    this.m = new THREE.Matrix4();
    this.back = [0, 0, 0];
    this.near = NEAR;      // within this, a car is drawn as its model (further for a directed shot)
    this.keep = null;      // [from, to] (s): windows a directed shot will play through, loaded ahead and kept
    this.trace = null;     // (testing: called with each seen car's placement, to find what would show as a glitch)
    this.probe = null;     // [x, z] of the visitor (in a car, on a bike, on foot); probeHits: the cars within 30 m
    this.probeHits = [];   // of it, 7 numbers each (x, y, z, heading, length, width, speed)
    this.capsule = [];
    this.solids = [];      // what the cars must not drive through: the visitor and the car parked, as capsules
                           // [ax, az, bx, bz, r] (collide.js); a car that would, fades out instead
    this.nearby = [];      // [x, z] of the cars within 320 m of the camera (the minimap's dots)
    this.heights = new Map(); this.turns = new Map(); this.shifts = new Map(); this.frameNo = 0; // (each seen car's eased height, and the frame it was set)
    this.rate = 1;         // the clock's speed: a car's arrival and departure fade over about half a second of it
    this.followed = null;  // vehicle id the camera rides with
    this.view = null;      // the followed car's place this frame: { x, y, z, heading, speed }
  }

  // The expressway's lanes as SUMO drove them and as the tiles paint them. The tiles paint the lanes as the
  // carriageway is wide (four-metre lanes on PR-22). The network (tools/sim/network.mjs) gives SUMO the same lanes,
  // as wide, and lists them in the run's index; only where it narrowed a stretch (a toll plaza's six lanes into two,
  // a lane at a time) does SUMO drive fewer. (An older run drove 3 m lanes, as many as OSM counts: on 4 km of San
  // Juan's expressway three where four are painted, and the opening's commuter rode down a painted line.) Each seen
  // car on a one-way expressway is moved across into the same lane counted from the left among the painted ones
  // (a lane SUMO dropped is the right one), and in it as far off its middle as it was in SUMO's: a car changing
  // lanes still crosses the line. Where the lanes agree, it only moves onto the painted carriageway's centre.
  relanes(roads) {
    const fast = (e) => /^(motorway|trunk)(_link)?$/.test(e.highway);
    const dir = [];
    roads.edges.forEach((e, i) => {
      if (e.a === e.b || !e.oneway || !fast(e)) return;
      const [a, b] = e.oneway === -1 ? [e.b, e.a] : [e.a, e.b];
      dir.push({ e, i, from: a, to: b, lanes: Math.max(1, e.lanes) });
    });
    // SUMO's lanes on each, and their width: as the run's index lists them (tools/sim/network.mjs gives the expressway
    // the lanes the tiles paint); a run without that list had 3 m lanes, narrowed by network.mjs's lane drops, which
    // are made again here on the same graph
    const listed = this.index?.lanes;
    for (const d of dir) {
      const l = listed?.[d.i];
      d.sw = l ? l[1] : 3.0;
      if (l) d.lanes = l[0];
    }
    const outOf = new Map();
    for (const d of dir) (outOf.get(d.from) ?? outOf.set(d.from, []).get(d.from)).push(d);
    for (let pass = 0; pass < 6 && !listed; pass++) {
      let changed = 0;
      for (const d of dir) {
        if (d.e.highway.endsWith('_link')) continue;
        const on = (outOf.get(d.to) ?? []).filter((o) => o.i !== d.i);
        if (!on.length) continue;
        const room = on.reduce((t, o) => t + o.lanes, 0) + 1;
        if (d.lanes > room) { d.lanes = room; changed++; }
      }
      if (!changed) break;
    }
    // (a two-way expressway's lanes are SUMO's two-way ones: left as they are)
    // The painted lanes: as the tiles paint them, measured again from their carriageways (tools/pipeline/
    // lanetable.mjs: lanes.json, roads.lanes) where they paint the road; on a deck (flyovers.js paints it) or a ramp,
    // by the same rule about the OSM line.
    const table = roads.lanes?.edges ?? {}, step = roads.lanes?.step ?? 2.5, lanesOf = roadLanes(roads.edges);
    const paintedOf = (d) => {
      const t = table[d.i];
      if (t) return { painted: t.lanes, lw: t.lw, t };
      const p = paintOf(d.e, Math.max(1, lanesOf(d.e) || d.e.lanes || 1));
      return { painted: p.lanes, lw: p.lw, t: null };
    };
    const offsets = (t) => { // (where markings.mjs painted nothing, the offset is carried across from either side)
      const c = Float32Array.from(t.c, (v) => (v == null ? NaN : v));
      let last = NaN;
      for (let k = 0; k < c.length; k++) if (Number.isNaN(c[k])) c[k] = last; else last = c[k];
      last = NaN;
      for (let k = c.length - 1; k >= 0; k--) if (Number.isNaN(c[k])) c[k] = Number.isNaN(last) ? 0 : last; else last = c[k];
      return c;
    };
    this.laneCells = new Map();
    for (const d of dir) {
      const { painted, lw, t } = paintedOf(d), off = t ? offsets(t) : null;
      const p = d.e.oneway === -1 ? reversed(d.e.pts) : d.e.pts;
      let total = 0;
      for (let k = 3; k < p.length; k += 3) total += Math.hypot(p[k] - p[k - 3], p[k + 2] - p[k - 1]);
      let along = 0;
      for (let k = 3; k < p.length; k += 3) {
        const x0 = p[k - 3], z0 = p[k - 1], x1 = p[k], z1 = p[k + 2], len = Math.hypot(x1 - x0, z1 - z0);
        if (len < 0.1) continue;
        const seg = { x0, z0, tx: (x1 - x0) / len, tz: (z1 - z0) / len, len, sumo: d.lanes, sw: d.sw, painted, lw, off, rev: d.e.oneway === -1, step,
          s0: along, total, highway: d.e.highway };
        for (let s = 0; s <= len + 12; s += 12) {
          const f = Math.min(1, s / len), key = cellKey(x0 + (x1 - x0) * f, z0 + (z1 - z0) * f);
          let cell = this.laneCells.get(key);
          if (!cell) this.laneCells.set(key, (cell = []));
          if (cell.at(-1) !== seg) cell.push(seg);
        }
        along += len;
      }
    }
  }
  // Whether (x, z), facing `heading`, is in the lanes of a one-way expressway (relanes' cells)
  onExpressway(x, z, heading) {
    const c = cellKey(x, z), hx = Math.sin(heading), hz = Math.cos(heading);
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) {
      for (const g of this.laneCells?.get(c + a * CELLS + b) ?? []) {
        if (g.tx * hx + g.tz * hz < 0.9 || /_link$/.test(g.highway)) continue;
        const u = (x - g.x0) * g.tx + (z - g.z0) * g.tz, d = (x - g.x0) * -g.tz + (z - g.z0) * g.tx;
        if (u >= 0 && u <= g.len && Math.abs(d) <= g.sumo * g.sw / 2 + 1) return true;
      }
    }
    return false;
  }
  // p: a seen car's place; heading: the way it faces. The move across into its painted lane, [dx, dz], or null
  relane(p, heading) {
    const c = cellKey(p[0], p[2]), hx = Math.sin(heading), hz = Math.cos(heading);
    let best = null, bd = Infinity;
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) {
      for (const g of this.laneCells.get(c + a * CELLS + b) ?? []) {
        if (g.tx * hx + g.tz * hz < 0.9) continue; // (driving along it)
        const u = (p[0] - g.x0) * g.tx + (p[2] - g.z0) * g.tz;
        if (u < -0.5 || u > g.len + 0.5) continue;
        const d = (p[0] - g.x0) * -g.tz + (p[2] - g.z0) * g.tx; // (to the right of the way)
        // (out of its lanes: on another road where two meet or part, a ramp alongside; left as SUMO drove it)
        if (Math.abs(d) > g.sumo * g.sw / 2 + 0.5 || Math.abs(d) >= bd) continue;
        bd = Math.abs(d); best = [g, u, d];
      }
    }
    if (!best) return null;
    const [g, u, d] = best;
    const fromRight = g.sumo / 2 - 0.5 - d / g.sw;                // SUMO's lane, counted from the right
    // (more lanes in SUMO than painted, where the paint is narrower than OSM's count: SUMO's lanes share the painted
    // width evenly, so that two cars side by side in SUMO do not ride in one painted lane, the one through the other)
    const lane = g.sumo > g.painted
      ? Math.min(g.painted - 0.55, Math.max(-0.45, (fromRight + 0.5) * (g.painted / g.sumo) - 0.5))
      : Math.min(g.painted - 0.55, Math.max(-0.45, fromRight + g.painted - g.sumo));
    const at = g.s0 + u;
    // (the painted centre's offset from the OSM line, to the right of the way travelled)
    let centre = 0;
    if (g.off) {
      const sp = g.rev ? g.total - at : at, f = Math.max(0, Math.min(g.off.length - 1, (sp - g.step / 2) / g.step)), k = Math.floor(f);
      const c = g.off[k] + (g.off[Math.min(k + 1, g.off.length - 1)] - g.off[k]) * (f - k);
      centre = g.rev ? -c : c;
    }
    // (one lane: kept as far off its middle as SUMO had it, in metres; a ramp seven metres wide does not spread it)
    const shift = g.painted === 1 && g.sumo === 1 ? centre : centre + (g.painted / 2 - 0.5 - lane) * g.lw - d;
    return [-g.tz * shift, g.tx * shift];
  }

  raise(roads, ground, drawn) {
    this.relanes(roads);
    // (where the client corrected the roads' levels, src/shared/profile.js correctProfiles and flyovers.js landDecks,
    // the simulation drove the levels roads.json has, kept in pts0: a car on one is put at the new, fixAt. The decks
    // are drawn at the new: a car left at the simulation's level was metres off them, flying beside a bridge at grade
    // or sunk under one. A run built on roads.json's levels, index.levels 'roads', drove pts0 too.)
    this.fixes = new Map();
    this.fixLevels(roads);
    // what the flyovers draw (roadlevel.js): a car on one, at about its level, drives on it; any other on the street
    this.drawn = drawn ?? new DrawnDecks(roads, ground);
  }
  fixLevels(roads) {
    const keep = [];
    const file = (seg, only) => {
      const len = Math.hypot(seg[3] - seg[0], seg[5] - seg[2]);
      for (let s = 0; s <= len; s += 12) {
        const f = len ? s / len : 0, key = cellKey(seg[0] + (seg[3] - seg[0]) * f, seg[2] + (seg[5] - seg[2]) * f);
        if (only && !only(key)) continue;
        let cell = this.fixes.get(key);
        if (!cell) this.fixes.set(key, (cell = []));
        if (cell.at(-1) !== seg) cell.push(seg);
      }
    };
    const lanesOf = roadLanes(roads.edges);
    for (const e of roads.edges) {
      const p = e.pts, o = e.pts0, hw = pavedHalf(e, lanesOf(e)).half + 2.5; // (a car on it is within its paved width, or not far out: SUMO's lanes are its own)
      for (let k = 3; k < p.length; k += 3) {
        const y0 = o ? o[k / 3 - 1] : p[k - 2], y1 = o ? o[k / 3] : p[k + 1];
        const seg = [p[k - 3], y0, p[k - 1], p[k], y1, p[k + 2], p[k - 2], p[k + 1], hw, e.oneway, e];
        if (Math.abs(y1 - p[k + 1]) < 0.5 && Math.abs(y0 - p[k - 2]) < 0.5) keep.push(seg); else file(seg);
      }
    }
    // (and the roads whose level stayed, where they pass near one whose was corrected: a car on one of them is
    // matched to its own road, not to the corrected one beside it)
    const fixed = new Set(this.fixes.keys());
    const near = (key) => { for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) if (fixed.has(key + a * CELLS + b)) return true; return false; };
    for (const seg of keep) file(seg, near);
  }
  // The corrected level of the road under (x, z) for a car the simulation has at height y on its old level there,
  // facing `heading`, or null: of the roads it is on (within their paved width, driving along them), the one whose old
  // level is nearest its height (this.fixEdge: that road). (Matched by nearness alone, a car on a flyover could take
  // the level of a bridge at grade beside it, corrected metres down, and drive under the flyover's deck.)
  fixAt(x, z, y, heading = null) {
    const c = cellKey(x, z), hx = heading == null ? 0 : Math.sin(heading), hz = heading == null ? 0 : Math.cos(heading);
    let best = null, score = Infinity;
    this.fixEdge = null;
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) {
      for (const [x0, y0, z0, x1, y1, z1, n0, n1, hw, oneway, e] of this.fixes?.get(c + a * CELLS + b) ?? []) {
        const dx = x1 - x0, dz = z1 - z0, l2 = dx * dx + dz * dz || 1, f = Math.max(0, Math.min(1, ((x - x0) * dx + (z - z0) * dz) / l2));
        const d = Math.hypot(x0 + dx * f - x, z0 + dz * f - z), h = y0 + (y1 - y0) * f;
        if (d > hw || Math.abs(h - y) >= 2.5) continue;
        if (heading != null) {
          const al = (hx * dx + hz * dz) / Math.sqrt(l2), along = oneway === 1 ? al : oneway === -1 ? -al : Math.abs(al);
          if (along < 0.5) continue; // (a road it crosses, or one the other way)
        }
        const sc = Math.abs(h - y) + 0.05 * d;
        if (sc < score) { score = sc; best = n0 + (n1 - n0) * f; this.fixEdge = e; }
      }
    }
    return best;
  }
  // the deck drawn under (x, z) near height y, or null (the visitor's car, bike and walk: drive.js, player.js)
  deckAt(x, z, y) { return this.drawn?.at(x, z, y, 2.0) ?? null; }

  // ---------------------------------------------------------------- windows
  windowStart(T) { return this.begin + Math.floor((T - this.begin) / this.index.window) * this.index.window; }
  ensure(w0) {
    if (w0 < this.begin || w0 >= this.end || this.windows.has(w0)) return;
    if (performance.now() - (this.failed.get(w0) ?? -1e9) < 5000) return;
    const entry = this.index.windows.find((w) => w[0] === w0);
    if (!entry) return;
    this.windows.set(w0, 'loading');
    const id = ++this.nextRequest; this.requests.set(id, w0);
    this.worker.postMessage({ id, url: new URL(`${this.base}/${entry[1]}`, location.href).href });
  }

  // Is the window under the clock here? (the clock waits for it, rather than the cars standing still while it runs on)
  ready(T) {
    if (T < this.begin || T >= this.end) return true;
    const w0 = this.windowStart(T); this.ensure(w0);
    const W = this.windows.get(w0);
    return (!!W && W !== 'loading') || this.failed.has(w0);
  }

  // A car keeps the way it faced at the end of the window before (a long wait in a jam can span a whole window).
  carry(w0, W) {
    const prev = this.windows.get(w0 - this.index.window);
    if (!prev || prev === 'loading') return;
    const at = new Map();
    for (let i = 0; i < prev.n; i++) if (!Number.isNaN(prev.heading[i])) at.set(prev.vid[i], prev.heading[i]);
    for (let i = 0; i < W.n; i++) { const h = at.get(W.vid[i]); if (h !== undefined) W.heading[i] = h; }
  }

  // Position at time T along track i of window W, into out[0..2]; false if outside the track.
  static at(W, i, T, out) {
    const s = W.start[i], c = W.count[i], K = W.K;
    if (T < K[s * 4] || T > K[(s + c - 1) * 4]) return false;
    let j = W.cursor[i];
    if (j >= c - 1) j = c - 2;
    while (j < c - 2 && K[(s + j + 1) * 4] <= T) j++;
    while (j > 0 && K[(s + j) * 4] > T) j--;
    W.cursor[i] = j;
    const a = (s + j) * 4, b = a + 4, f = (T - K[a]) / Math.max(1e-6, K[b] - K[a]);
    out[0] = K[a + 1] + (K[b + 1] - K[a + 1]) * f; out[1] = K[a + 2] + (K[b + 2] - K[a + 2]) * f; out[2] = K[a + 3] + (K[b + 3] - K[a + 3]) * f;
    return true;
  }

  // ---------------------------------------------------------------- the frame
  update(T, camera, dt = 1 / 60) {
    const W = this.windows.get(this.windowStart(T));
    const span = this.index.window;
    this.ensure(this.windowStart(T)); this.ensure(this.windowStart(T) + span); this.ensure(this.windowStart(T) - span);
    // drop windows far from the clock (a rush-hour window decodes to tens of MB), but those a directed shot has
    // asked to keep (this.keep: [from, to] in seconds, the time the shot plays through)
    const keep = this.keep;
    for (const k of this.windows.keys()) if (Math.abs(k - this.windowStart(T)) > span && !(keep && k + span > keep[0] && k < keep[1])) this.windows.delete(k);
    if (T < this.begin || T >= this.end) { this.hide(); return; }
    if (!W || W === 'loading') return; // (the window is on its way: the cars hold where they were for a frame or two)

    const cx = camera.position.x, cy = camera.position.y, cz = camera.position.z;
    const p = [0, 0, 0], q = [0, 0, 0], r = [0, 0, 0];
    let mid = 0, lights = 0, active = 0, nearSpeed = 0, nearStopped = 0, nearN = 0;
    const m = this.m.elements, night = shared.uNight.value;
    this.view = null; this.probeHits.length = 0; this.nearby.length = 0; (this.cars ??= []).length = 0;
    this.fleet.begin();
    // A seen car's height follows the street exactly, but a step of more than half a metre from one frame to the
    // next (onto a deck, off it) is eased over a tenth of a second, or at the speed of the opening the car would
    // hop. (Eased only from one frame to the next: a car first seen, or after a cut, is put down.)
    const ease = 1 - Math.exp(-dt / 0.1), turn = 1 - Math.exp(-dt / 0.3), drift = 1 - Math.exp(-dt / 0.5), fast = 1 - Math.exp(-dt / 0.2), frame = ++this.frameNo;
    if (frame % 120 === 0) {
      for (const map of [this.heights, this.turns]) for (const [k, v] of map) if (frame - v[1] > 60) map.delete(k);
      for (const [k, v] of this.shifts) if (frame - v[2] > 60) this.shifts.delete(k);
    }
    for (let i = 0; i < W.n; i++) {
      if (!SimTraffic.at(W, i, T, p)) continue;
      active++;
      const dx = p[0] - cx, dz = p[2] - cz, d2 = dx * dx + dz * dz + (p[1] - cy) * (p[1] - cy);
      const vid = W.vid[i], followed = vid === this.followed;
      // (beyond the boxes only the lamps show, and only from dusk to dawn)
      if (!followed && (d2 > LIGHTS * LIGHTS || (d2 > MID * MID && night <= 0.02))) continue;
      let heading = W.heading[i], speed = 0, hadQ = false;
      if (d2 > MID * MID && !followed) {
        // only its lamps show: the way along its stretch of track is near enough (tens of thousands of these)
        const a = (W.start[i] + W.cursor[i]) * 4, K = W.K, hx = K[a + 5] - K[a + 1], hz = K[a + 7] - K[a + 3];
        if (hx * hx + hz * hz > 0.01) heading = W.heading[i] = Math.atan2(hx, hz);
        else if (Number.isNaN(heading)) heading = W.heading[i] = this.restHeading(W, i, T);
      } else {
        // heading and speed from where it was half a second ago and will be half a second on
        hadQ = SimTraffic.at(W, i, T - 0.5, q); const hadR = SimTraffic.at(W, i, T + 0.5, r);
        SimTraffic.at(W, i, T, p); // (restore the cursor)
        const hx = (hadR ? r[0] : p[0]) - (hadQ ? q[0] : p[0]), hz = (hadR ? r[2] : p[2]) - (hadQ ? q[2] : p[2]);
        const moved = Math.hypot(hx, hz); speed = moved / ((hadQ ? 0.5 : 0) + (hadR ? 0.5 : 0) || 1);
        let fx = hx, fz = hz;
        // (a slow car takes its heading over a longer stretch of its way: SUMO moves a car into the next lane in one
        // step of a second, and in a queue at walking pace that step was three metres sideways to one forward, the car
        // turned broadside across the lanes for that second)
        if (moved > 0.02 && moved < 8) {
          const back = this.back, on = this.on ??= [0, 0, 0];
          for (const span of [1.5, 3]) {
            const hb = SimTraffic.at(W, i, T - span, back), ho = SimTraffic.at(W, i, T + span, on);
            const gx = (ho ? on[0] : p[0]) - (hb ? back[0] : p[0]), gz = (ho ? on[2] : p[2]) - (hb ? back[2] : p[2]);
            if (Math.hypot(gx, gz) > Math.hypot(fx, fz)) { fx = gx; fz = gz; }
            if (Math.hypot(fx, fz) >= 8) break;
          }
          SimTraffic.at(W, i, T, p);
        }
        if (moved > 0.02) { heading = Math.atan2(fx, fz); W.heading[i] = heading; }
        else if (Number.isNaN(heading)) heading = W.heading[i] = this.restHeading(W, i, T);
        // (and turns, from one frame to the next, over a third of a second: a lane change at speed is a gentle
        // swing, not a snap to the next track segment's direction)
        const was = this.turns.get(vid);
        if (was && was[1] === frame - 1) heading = was[0] + Math.atan2(Math.sin(heading - was[0]), Math.cos(heading - was[0])) * turn;
        if (was) { was[0] = heading; was[1] = frame; } else this.turns.set(vid, [heading, frame]);
      }
      // braking: slower than half a second ago by more than ~1.2 m/s², or standing in a queue
      let brake = 0;
      if (hadQ && (d2 < this.near * this.near || followed || (night > 0.02 && d2 < 2000 * 2000))) { // (only where a brake light can be seen)
        const back = this.back;
        if (SimTraffic.at(W, i, T - 1.0, back)) {
          const before = Math.hypot(q[0] - back[0], q[2] - back[2]) / 0.5;
          brake = before - speed > 0.6 || speed < 0.4 ? 1 : 0;
        }
        SimTraffic.at(W, i, T, p);
      }
      // (in the lane the tiles paint, on the expressway: relane; where the lanes change in number, at a node, the move
      // changes, and the car drifts across to its new place over half a second, as in a lane change, not in a jump)
      if ((d2 < MID * MID || followed) && this.laneCells) {
        const m = this.relane(p, heading) ?? [0, 0], was = this.shifts.get(vid);
        if (was && was[2] === frame - 1) { m[0] = was[0] + (m[0] - was[0]) * drift; m[1] = was[1] + (m[1] - was[1]) * drift; }
        if (was) { was[0] = m[0]; was[1] = m[1]; was[2] = frame; } else this.shifts.set(vid, [m[0], m[1], frame]);
        p[0] += m[0]; p[2] += m[1];
      }
      const sin = Math.sin(heading), cos = Math.cos(heading);
      // On what the city draws there: the street (the tiles' surface, flat across the triangles they draw it with:
      // src/shared/terrain.js meshHeight), or a deck or a ramp the flyovers draw (roadlevel.js), the one of the two
      // nearer the level the simulation has the car at. Never at a height nothing is drawn at: the simulation drove the levels the
      // compiler gave the roads, humps of the elevation model in them here and there, and a car following them
      // sank into the street where the street ran over a hump the levels did not have, or rose off it where the
      // levels had one the street did not. For a car seen only as its lamps, the simulation's own height is near
      // enough (and the ground is not looked up for tens of thousands).
      const seen = d2 < MID * MID || followed;
      // (the simulation's height for it, put on the corrected levels: fixAt)
      const fixed = seen && this.fixes?.size ? this.fixAt(p[0], p[2], p[1], heading) : null, sy = fixed ?? p[1], road = fixed == null ? null : this.fixEdge;
      // its road's deck drawn under it, or the street (roadlevel.js)
      let stood = seen ? this.drawn.stand(this.surface, p[0], p[2], sy, heading, road) : null;
      if (stood?.push) { p[0] += stood.push[0]; p[2] += stood.push[1]; } // (onto the deck drawn, from just beyond its edge)
      // and its whole body on what is drawn (roadlevel.js fit): across its way, as far as it takes (up to 4 m),
      // eased in and out as relane's shift is (a car with nothing drawn near it is left where it is). (SUMO's lanes are
      // not always the city's: netconvert's --ramps.guess gave Avenida Piñero a third lane for the 94 m before a ramp,
      // 5 m out from its middle where the tiles pave 3.5)
      if (seen && (d2 < this.near * this.near || followed)) {
        const spec = TYPES[W.type[i]], f = this.drawn.fit(this.surface, p[0], p[2], stood.y, heading, stood.deck, spec.spec.W, spec.L, road) ?? [0, 0], was = this.fits.get(vid);
        // (quickly out of a parapet, in a fifth of a second; back over half a second)
        if (was && was[2] === frame - 1) { const k = f[0] * f[0] + f[1] * f[1] > was[0] * was[0] + was[1] * was[1] ? fast : drift; f[0] = was[0] + (f[0] - was[0]) * k; f[1] = was[1] + (f[1] - was[1]) * k; }
        if (f[0] || f[1] || was) {
          if (was) { was[0] = f[0]; was[1] = f[1]; was[2] = frame; } else this.fits.set(vid, [f[0], f[1], frame]);
          if (Math.abs(f[0]) + Math.abs(f[1]) > 0.01) { p[0] += f[0]; p[2] += f[1]; stood = this.drawn.stand(this.surface, p[0], p[2], sy, heading, road); }
        }
      }
      const raised = !!stood?.deck;
      let y = seen ? stood.y : sy;
      if (seen) {
        const h = this.heights.get(vid);
        if (h && h[1] === frame - 1 && Math.abs(y - h[0]) < 12 && Math.abs(y - h[0]) > 0.5) y = h[0] + (y - h[0]) * ease; // (a step: onto a deck, off it)
        if (h) { h[0] = y; h[1] = frame; } else this.heights.set(vid, [y, frame]);
      }
      // A car setting off or arriving (or split where SUMO cleared a jam) fades in or out, over about half a
      // second as watched: its track starts or ends inside this window, not at its edge.
      const s0 = W.start[i] * 4, s1 = (W.start[i] + W.count[i] - 1) * 4, fade = Math.max(1, this.rate * 0.5);
      let shown = 1;
      if (W.K[s0] >= W.t0) shown = Math.min(shown, (T - W.K[s0]) / fade);
      if (W.K[s1] < W.t1 - 0.5) shown = Math.min(shown, (W.K[s1] - T) / fade);
      shown = smooth(0, 1, shown);
      if (followed) this.view = { x: p[0], y, z: p[2], heading, speed, vid, type: W.type[i], brake };
      const t = W.type[i], spec = TYPES[t];
      // the visitor (this.probe: [x, z]): the simulated cars round about, to run into; one that would pass through
      // the visitor or the car parked (they keep to their recorded way) fades out before it touches, its whole
      // length (a bus's too) measured, not its middle
      if (this.probe) {
        const px = p[0] - this.probe[0], pz = p[2] - this.probe[1], pd = px * px + pz * pz;
        if (pd < 900) {
          this.probeHits.push(p[0], y, p[2], heading, spec.L, spec.spec.W, speed);
          const c = vehicleCapsule(p[0], p[2], heading, spec.L, spec.spec.W, this.capsule);
          for (const s of this.solids) shown *= smooth(0.05, 0.7, segDist(c[0], c[1], c[2], c[3], s[0], s[1], s[2], s[3]) - c[4] - s[4]);
        }
      }
      if (this.trace) this.trace(vid, p[0], y, p[2], d2 < this.near * this.near ? 'near' : d2 < MID * MID ? 'mid' : 'far', p[1], sy, raised, shown, heading, spec);
      if (d2 < 320 * 320) this.nearby.push([p[0], p[2]]); // (for the minimap)
      if (d2 < 420 * 420) this.cars.push(p[0], p[2], heading, speed); // (for the people waiting to cross: src/world/people.js)
      if (d2 < 250 * 250) { nearN++; nearSpeed += speed; if (speed < 0.5) nearStopped++; }
      // near: the model; across the band at its edge it dissolves into the box, which stands in from there out
      const d = Math.sqrt(d2), near = this.near, handover = followed ? 0 : smooth(near - BAND, near, d);
      let boxed = true, modelled = false;
      if (d < near || followed) {
        // nose up or down with the road
        const ahead = (this.drawn.stand(this.surface, p[0] + sin * 2.5, p[2] + cos * 2.5, y, heading, road).y - this.drawn.stand(this.surface, p[0] - sin * 2.5, p[2] - cos * 2.5, y, heading, road).y) / 5;
        const pitch = -Math.atan(ahead), cp = Math.cos(pitch), sp = Math.sin(pitch);
        // rotation Y(heading) * X(pitch), then translation
        m[0] = cos; m[1] = 0; m[2] = -sin; m[3] = 0;
        m[4] = sin * sp; m[5] = cp; m[6] = cos * sp; m[7] = 0;
        m[8] = sin * cp; m[9] = -sp; m[10] = cos * cp; m[11] = 0;
        m[12] = p[0]; m[13] = y + 0.03; m[14] = p[2]; m[15] = 1;
        const lod = d < DETAIL || followed ? 0 : 1, hide = 1 - shown * (1 - handover);
        {
          let look = this.looks.get(vid);
          if (!look) {
            look = lookOf(spec.name, vid);
            // (a bus in its route's colour: buses.json, from the GTFS)
            const bus = this.buses?.[vid];
            if (bus && look.body === 'bus') { this.color.set(bus[3]); look.paint = [this.color.r, this.color.g, this.color.b]; }
            this.looks.set(vid, look);
          }
          // its wheels turn with the way it goes (eased over cuts: a car first seen starts where its id puts it)
          const r = this.fleet.wheelRadius(look.body), sp0 = this.spins.get(vid);
          const dist = sp0 && sp0[1] === frame - 1 ? sp0[0] + speed * dt : hash(vid) * 40;
          if (sp0) { sp0[0] = dist; sp0[1] = frame; } else this.spins.set(vid, [dist, frame]);
          // its turn signal, blinking where its track turns a few seconds on (at a junction's pace, not a curve's)
          let left = 0, right = 0;
          if (lod === 0 && speed < 14) {
            const on = this.on3 ??= [0, 0, 0], on4 = this.on4 ??= [0, 0, 0];
            if (SimTraffic.at(W, i, T + 3, on) && SimTraffic.at(W, i, T + 4.5, on4)) {
              const gx = on4[0] - on[0], gz = on4[2] - on[2];
              if (gx * gx + gz * gz > 1) {
                const turn = Math.atan2(gx, gz) - heading, tt = Math.atan2(Math.sin(turn), Math.cos(turn));
                const blink = (shared.uTime.value * 1.4 + hash(vid + 3)) % 1 < 0.5 ? 1 : 0;
                if (tt > 0.6) left = blink; else if (tt < -0.6) right = blink;
              }
            }
            SimTraffic.at(W, i, T, (this.scratch ??= [0, 0, 0])); // (restore the cursor)
          }
          if (this.fleet.add(lod, this.m, look, brake, left, right, dist / r, wheelBlur(speed, r), hide)) { boxed = handover > 0; modelled = true; }
        }
      }
      if (boxed && d2 < MID * MID && mid < MAX_MID) {
        const L = spec.L, Wd = spec.spec.W, H = spec.spec.roof;
        m[0] = cos * Wd; m[1] = 0; m[2] = -sin * Wd; m[3] = 0;
        m[4] = 0; m[5] = H; m[6] = 0; m[7] = 0;
        m[8] = sin * L; m[9] = 0; m[10] = cos * L; m[11] = 0;
        m[12] = p[0]; m[13] = y + 0.15; m[14] = p[2]; m[15] = 1;
        this.boxes.setMatrixAt(mid, this.m);
        const lk = this.looks.get(vid) ?? lookOf(spec.name, vid);
        this.boxes.setColorAt(mid, this.color.setRGB(...lk.paint));
        this.boxHide.array[mid] = 1 - shown * (modelled ? handover : 1); // (no model drawn: the box is the car)
        mid++;
      }
      if (night > 0.02 && lights < MAX_LIGHTS) {
        // the lamps: white at the front, red at the back (red brighter when braking)
        const L = spec.L * 0.48, h = y + 0.75, o = lights * 6;
        this.lightPos[o] = p[0] + sin * L; this.lightPos[o + 1] = h; this.lightPos[o + 2] = p[2] + cos * L;
        this.lightPos[o + 3] = p[0] - sin * L; this.lightPos[o + 4] = h; this.lightPos[o + 5] = p[2] - cos * L;
        this.lightCol[o] = shown; this.lightCol[o + 1] = 0.9 * shown; this.lightCol[o + 2] = 0.72 * shown;
        const red = (brake ? 1.0 : 0.45) * shown;
        this.lightCol[o + 3] = red; this.lightCol[o + 4] = 0.03 * red; this.lightCol[o + 5] = 0.02 * red;
        lights++;
      }
    }
    this.fleet.end();
    if (frame % 240 === 0) {
      for (const [k, v] of this.spins) if (frame - v[1] > 60) { this.spins.delete(k); this.looks.delete(k); }
      for (const [k, v] of this.fits) if (frame - v[2] > 60) this.fits.delete(k);
    }
    this.boxHide.needsUpdate = true;
    this.boxes.count = mid; this.boxes.instanceMatrix.needsUpdate = true;
    if (this.boxes.instanceColor) this.boxes.instanceColor.needsUpdate = true;
    const g = this.lights.geometry;
    g.setDrawRange(0, lights * 2);
    g.attributes.position.needsUpdate = true; g.attributes.color.needsUpdate = true;
    this.lights.material.uniforms.uScale.value = Math.min(3, devicePixelRatio || 1);
    this.beam.color.setScalar(0.36 * this.headlights * night);
    this.beam.visible = night > 0.02;
    this.stats = { active, near: this.fleet.count, mid, lights, nearSpeed: nearN ? nearSpeed / nearN : null, nearStopped, nearCount: nearN };
  }

  dispose() { this.worker.terminate(); this.windows.clear(); }

  hide() {
    this.fleet.hide();
    this.boxes.count = 0; this.lights.geometry.setDrawRange(0, 0);
    this.stats = { active: 0, near: 0, mid: 0, lights: 0 };
  }

  // The way a standing car faces: the way it came (the last stretch of its track before T where it moved), or
  // for a car that has not moved yet, the way it will go.
  restHeading(W, i, T) {
    const s = W.start[i], c = W.count[i], K = W.K;
    const dir = (j) => { const a = (s + j) * 4, b = a + 4, dx = K[b + 1] - K[a + 1], dz = K[b + 3] - K[a + 3]; return dx * dx + dz * dz > 0.25 ? Math.atan2(dx, dz) : null; };
    let j = 0;
    while (j < c - 2 && K[(s + j + 1) * 4] <= T) j++;
    for (let k = j; k >= 0; k--) { const h = dir(k); if (h != null) return h; }
    for (let k = j + 1; k < c - 1; k++) { const h = dir(k); if (h != null) return h; }
    return 0;
  }



  // Cars within `radius` of (x, z) at time T that will still be driving `until` seconds on: [{ vid, x, z, heading }].
  // Whether car vid is on the road at T (its window loaded)
  alive(vid, T) {
    const W = this.windows.get(this.windowStart(T));
    if (!W || W === 'loading') return false;
    const p = [0, 0, 0];
    for (let i = 0; i < W.n; i++) if (W.vid[i] === vid) return SimTraffic.at(W, i, T, p);
    return false;
  }
  carsNear(T, x, z, radius, until = 60) {
    const W = this.windows.get(this.windowStart(T)), out = [];
    if (!W || W === 'loading') return out;
    const p = [0, 0, 0], q = [0, 0, 0];
    for (let i = 0; i < W.n; i++) {
      if (!SimTraffic.at(W, i, T, p) || Math.hypot(p[0] - x, p[2] - z) > radius) continue;
      const K = W.K, last = (W.start[i] + W.count[i] - 1) * 4;
      if (K[last] < T + until && K[last] < this.windowStart(T) + this.index.window - 1) continue; // (arrives too soon)
      if (!SimTraffic.at(W, i, T + 2, q)) continue;
      const d = Math.hypot(q[0] - p[0], q[2] - p[2]);
      out.push({ vid: W.vid[i], x: p[0], z: p[2], heading: Math.atan2(q[0] - p[0], q[2] - p[2]), moving: d > 4, speed: d / 2 });
    }
    return out;
  }

  // The car nearest to a ray (a click), within `radius` metres of it: its vehicle id, or null.
  pick(ray, T, radius = 6) {
    const W = this.windows.get(this.windowStart(T));
    if (!W || W === 'loading') return null;
    const p = [0, 0, 0], v = new THREE.Vector3();
    let best = null, bestD = radius;
    for (let i = 0; i < W.n; i++) {
      if (!SimTraffic.at(W, i, T, p)) continue;
      v.set(p[0], (p[1] > this.surface(p[0], p[2], -2) + 1.5 ? p[1] : this.surface(p[0], p[2], -2)) + 0.8, p[2]);
      const d = ray.distanceToPoint(v);
      if (d < bestD) { bestD = d; best = W.vid[i]; }
    }
    return best;
  }
}
