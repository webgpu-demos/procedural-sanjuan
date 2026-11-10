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
import { lampMaterial, lampUniforms } from './lamplight.js';

const NEAR = 700, MID = 2800, LIGHTS = 12000;           // metres from the camera (near: the default; sim.near)
const NONE = []; // (an empty cell: a lookup that finds nothing makes no array; never added to. Not frozen: a frozen array is iterated the slow way, allocating)
const BAND = 110;                                       // a car hands over from its model to its box over this
// a seen car's move onto what is drawn (its painted lane, the deck, the street), eased as a driver steers across: over
// about MOVE s, no faster across than DRIFT m/s (a lane change on the expressway is 3.5 m in two seconds or more)
const MOVE = 0.4, DRIFT = 2.0;
const AROUND = [-1, -0.5, 0.5, 1]; // (where else along its track a model's painted lane is looked up, in spans of about 24 m)
const DETAIL = 250;                                     // within this, the full model; beyond, a lighter one
const ABREAST = 2.5;                                    // metres between two cars side by side, at least (relane)
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
    // (with the AMA's buses, tools/sim/gtfs.py: route, headsign, colour by vehicle id; fetched together)
    const [index, buses] = await Promise.all([
      fetch(`${base}/index.json`).then((r) => (r.ok ? r.json() : null)).catch(() => null),
      fetch(`${base}/../buses.json`).then((r) => (r.ok ? r.json() : {})).catch(() => ({})),
    ]);
    if (!index) return null;
    const sim = new SimTraffic(base, index, surface);
    if (roads) sim.raise(roads, ground, drawn);
    sim.buses = buses;
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
      if (!this.requests.has(id)) return; // (called off)
      const w0 = this.requests.get(id); this.requests.delete(id);
      if (error || !W) { console.warn('track window', w0, error); this.windows.delete(w0); this.failed.set(w0, performance.now()); return; }
      W.cursor = new Uint16Array(W.n); W.heading = new Float32Array(W.n).fill(NaN); W.carried = new Float32Array(W.n).fill(NaN);
      // (the knot before each track's first and after its last, where the windows either side have them, and whether
      // it is a car setting off on the window's first second: link())
      W.ends = new Float32Array(W.n * 6).fill(NaN); W.fresh = new Uint8Array(W.n);
      this.windows.set(w0, W);
      this.link(w0 - this.index.window, w0); this.link(w0, w0 + this.index.window);
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
    this.looks = new Map(); this.spins = new Map();
    // mid distance: one box per car, sized to its type
    const boxGeo = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0), boxMat = new THREE.MeshStandardMaterial({ roughness: 0.45, metalness: 0.3 });
    this.boxHide = new THREE.InstancedBufferAttribute(new Float32Array(MAX_MID), 1); this.boxHide.setUsage(THREE.DynamicDrawUsage);
    boxGeo.setAttribute('aHide', this.boxHide);
    // (the lamp uniforms too, which every material otherwise gets by default: a sampler left unset collides
    // with the shadow map's, and then no box is drawn at all)
    // (dissolved the other way round from the model: across the band where one hands over to the other, the box is
    // drawn in just the pixels the model leaves out. Each left out its own share of the same pattern: half way, a
    // quarter of the car's pixels were drawn twice and a quarter not at all, a stipple of holes that crawled.)
    boxMat.onBeforeCompile = (shader) => { lampUniforms(shader); dissolve(shader, true); }; boxMat.customProgramCacheKey = () => 'car-box-v3';
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
    this.covers = null;    // (the roofs drawn over a place: drive.js Overhead, set by main.js; a car under one fades out)
    this.trace = null;     // (testing: called with each seen car's placement, to find what would show as a glitch)
    this.probe = null;     // [x, z] of the visitor (in a car, on a bike, on foot); probeHits: the cars within 30 m
    this.probeHits = [];   // of it, 7 numbers each (x, y, z, heading, length, width, speed)
    this.capsule = [];
    this.solids = [];      // what the cars must not drive through: the visitor and the car parked, as capsules
                           // [ax, az, bx, bz, r] (collide.js); a car that would, fades out instead
    this.nearby = [];      // x, z, x, z, ... of the cars within 320 m of the camera (the minimap's dots)
    this.heights = new Map(); this.trail = new Map(); this.corr = new Map(); this.placed = new Map(); this.boxLooks = new Map(); this.frameNo = 0; // (each seen car's eased height, and the frame it was set)
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
      for (const g of this.laneCells?.get(c + a * CELLS + b) ?? NONE) {
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
    let best = null, bd = Infinity, bu = 0, bdd = 0;
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) {
      for (const g of this.laneCells.get(c + a * CELLS + b) ?? NONE) {
        if (g.tx * hx + g.tz * hz < 0.9) continue; // (driving along it)
        const u = (p[0] - g.x0) * g.tx + (p[2] - g.z0) * g.tz;
        if (u < -0.5 || u > g.len + 0.5) continue;
        const d = (p[0] - g.x0) * -g.tz + (p[2] - g.z0) * g.tx; // (to the right of the way)
        // (out of its lanes: on another road where two meet or part, a ramp alongside; left as SUMO drove it)
        if (Math.abs(d) > g.sumo * g.sw / 2 + 0.5 || Math.abs(d) >= bd) continue;
        bd = Math.abs(d); best = g; bu = u; bdd = d;
      }
    }
    if (!best) return null;
    const g = best, u = bu, d = bdd;
    const fromRight = g.sumo / 2 - 0.5 - d / g.sw;                // SUMO's lane, counted from the right
    // (more lanes in SUMO than painted, where the paint is narrower than OSM's count or SUMO's network widened a join:
    // SUMO's lanes share the painted width evenly, so that two cars side by side in SUMO do not ride in one painted
    // lane; and no closer than ABREAST, spilling evenly onto the shoulders where the paint is too narrow for that: four
    // in two painted lanes were drawn 1.8 m apart, the one through the other, on PR-18 in the jam)
    const lane = g.sumo > g.painted
      ? (g.painted - 1) / 2 + (fromRight - (g.sumo - 1) / 2) * Math.max(g.painted / g.sumo, ABREAST / g.lw)
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
    const out = this.relaned ??= [0, 0]; // (one array, filled each call: the caller takes the numbers out)
    out[0] = -g.tz * shift; out[1] = g.tx * shift;
    return out;
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
      const list = this.fixes?.get(c + a * CELLS + b);
      if (!list) continue;
      for (let k = 0; k < list.length; k++) {
        const sg = list[k], x0 = sg[0], y0 = sg[1], z0 = sg[2], n0 = sg[6], n1 = sg[7], hw = sg[8], oneway = sg[9], e = sg[10];
        const dx = sg[3] - x0, dz = sg[5] - z0, y1 = sg[4], l2 = dx * dx + dz * dz || 1, f = Math.max(0, Math.min(1, ((x - x0) * dx + (z - z0) * dz) / l2));
        const ex = x0 + dx * f - x, ez = z0 + dz * f - z, d = Math.sqrt(ex * ex + ez * ez), h = y0 + (y1 - y0) * f;
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

  // Two windows that follow one another, both here: a car on the road across the hour between them
  //  - keeps the way it faced at the end of the first (a long wait in a jam can span a whole window);
  //  - has its curve the same in both. A window's track runs from the knot at or before its start to the one at or
  //    after its end, and the curve through a track's first and last knots had nothing beyond them to take its
  //    slope from: the same stretch, between the knots either side of the hour, was one curve in the first window and
  //    another in the second, and at the hour the car stepped from one to the other, a metre and more where it was
  //    turning or braking. Each takes the missing knot from the other (W.ends: t, x, z before its first knot and after
  //    its last);
  //  - is not a car setting off. A track whose first knot falls on the hour itself read as one that starts there (it
  //    starts at or after the window's start), and was faded in: a quarter of the cars on the road, and at some hours
  //    nearly all, gone in a frame and back over a second, every two and a half minutes. Only one the first window
  //    did not have is (W.fresh).
  link(a0, b0) {
    const A = this.windows.get(a0), B = this.windows.get(b0);
    if (!A || !B || A === 'loading' || B === 'loading') return;
    const at = new Map(); // vehicle -> its track still on the road at the end of A
    for (let i = 0; i < A.n; i++) if (A.K[(A.start[i] + A.count[i] - 1) * 4] >= A.t1) at.set(A.vid[i], i);
    for (let i = 0; i < B.n; i++) {
      const s = B.start[i] * 4, t = B.K[s];
      if (t > B.t0) continue;
      const j = at.get(B.vid[i]);
      if (j === undefined) { if (t === B.t0) B.fresh[i] = 1; continue; }
      // (the way it faced at the end of A, for a car standing as B begins: the way it came there, or else as last
      // drawn. Not A's heading as it was when B arrived, seconds into A: a car that turned a corner since stood at
      // its old angle, then swung round as it pulled away)
      const came = this.restHeading(A, j, A.t1, NaN, false);
      B.carried[i] = came ?? A.heading[j];
      // A's track ends [.., p, q, r] where B's begins [q, r, n, ..] (q: the knot at or before the hour, r: the one at
      // or after it): B takes p, A takes n. (Found by their times: the two were cut from one list of knots.)
      const a0k = A.start[j] * 4, r = (A.start[j] + A.count[j] - 1) * 4, K = A.K;
      let q = r; while (q > a0k && K[q] > t + 0.01) q -= 4;
      if (Math.abs(K[q] - t) > 0.06) continue; // (not the same knot: tracks of two different cuts)
      if (q > a0k) { B.ends[i * 6] = K[q - 4]; B.ends[i * 6 + 1] = K[q - 3]; B.ends[i * 6 + 2] = K[q - 1]; }
      const n = s + (r - q) / 4 * 4 + 4; // (B's knot after the one that is A's last)
      if (n <= (B.start[i] + B.count[i] - 1) * 4 && Math.abs(B.K[n - 4] - K[r]) < 0.06) { A.ends[j * 6 + 3] = B.K[n]; A.ends[j * 6 + 4] = B.K[n + 1]; A.ends[j * 6 + 5] = B.K[n + 3]; }
    }
  }

  // Position at time T along track i of window W, into out[0..2]; false if outside the track.
  static at(W, i, T, out) {
    const s = W.start[i], c = W.count[i], K = W.K, first = s * 4, last = (s + c - 1) * 4;
    if (T < K[first] || T > K[last]) return false;
    let j = W.cursor[i];
    if (j >= c - 1) j = c - 2;
    while (j < c - 2 && K[(s + j + 1) * 4] <= T) j++;
    while (j > 0 && K[(s + j) * 4] > T) j--;
    W.cursor[i] = j;
    const a = (s + j) * 4, b = a + 4, dt = Math.max(1e-6, K[b] - K[a]), f = (T - K[a]) / dt;
    out[1] = K[a + 2] + (K[b + 2] - K[a + 2]) * f;
    // Across the ground, a curve through the knots, not straight from one to the next (a cubic, its slope at each knot
    // the way between the knots either side: Catmull-Rom). The knots are SUMO's seconds where the track bends; drawn
    // straight between, a car turning at a junction changed course in a jolt at each, 40° at a time, while its
    // heading (eased) turned smoothly: seen sideways for a moment every second.
    // One velocity at each knot, the same for the steps either side of it, so the speed has no step there. (Each step
    // held its slopes to its own length instead, so a car slowing down changed speed in a jolt at every knot, 20 to
    // 18 m/s in a frame, and lurched once a second: most of the hard braking seen in the opening that the simulation
    // did not do.) Its speed no more than twice the slower step's either side (Steffen's limit): a car stopping at a
    // knot comes to rest there and does not run on past it and back.
    // (Written out, with no helper made per call: this is called for every car on the road every frame and several
    // times for each one seen; with two closures and six hypots it was 112 ns a call, 2.9 ms a frame at the rush
    // hour and a pause for the garbage every few frames. 33 ns so.)
    const ax = K[a + 1], az = K[a + 3], bx = K[b + 1], bz = K[b + 3], ex = bx - ax, ez = bz - az;
    const E = W.ends, e = i * 6;
    if (c < 3 && !(E && (E[e] === E[e] || E[e + 3] === E[e + 3]))) { out[0] = ax + ex * f; out[2] = az + ez * f; return true; }
    const here = Math.sqrt(ex * ex + ez * ez) / dt; // (this step's speed)
    // the velocity at a: over the knots either side of it (the one before: the track's, or the window before's)
    let vax = ex / dt, vaz = ez / dt, vbx = vax, vbz = vaz, pt = NaN, px = 0, pz = 0;
    if (a > first) { pt = K[a - 4]; px = K[a - 3]; pz = K[a - 1]; } else if (E && E[e] === E[e]) { pt = E[e]; px = E[e + 1]; pz = E[e + 2]; }
    if (pt === pt) {
      const span = Math.max(1e-6, K[b] - pt), dx = ax - px, dz = az - pz;
      vax = (bx - px) / span; vaz = (bz - pz) / span;
      const v = Math.sqrt(vax * vax + vaz * vaz), most = 2 * Math.min(Math.sqrt(dx * dx + dz * dz) / Math.max(1e-6, K[a] - pt), here);
      if (v > most) { vax *= most / v; vaz *= most / v; }
    }
    // and at b
    let nt = NaN, nx = 0, nz = 0;
    if (b < last) { nt = K[b + 4]; nx = K[b + 5]; nz = K[b + 7]; } else if (E && E[e + 3] === E[e + 3]) { nt = E[e + 3]; nx = E[e + 4]; nz = E[e + 5]; }
    if (nt === nt) {
      const span = Math.max(1e-6, nt - K[a]), dx = nx - bx, dz = nz - bz;
      vbx = (nx - ax) / span; vbz = (nz - az) / span;
      const v = Math.sqrt(vbx * vbx + vbz * vbz), most = 2 * Math.min(here, Math.sqrt(dx * dx + dz * dz) / Math.max(1e-6, nt - K[b]));
      if (v > most) { vbx *= most / v; vbz *= most / v; }
    }
    const f2 = f * f, f3 = f2 * f, h10 = (f3 - 2 * f2 + f) * dt, h01 = 3 * f2 - 2 * f3, h11 = (f3 - f2) * dt;
    out[0] = ax + h01 * ex + h10 * vax + h11 * vbx;
    out[2] = az + h01 * ez + h10 * vaz + h11 * vbz;
    return true;
  }

  // ---------------------------------------------------------------- the frame
  update(T, camera, dt = 1 / 60) {
    const W = this.windows.get(this.windowStart(T));
    const span = this.index.window;
    // (the window under the clock and the one after it. The one before was fetched too: the clock does not run back,
    // and after a jump along the time line it was a third window to bring in and unpack for nothing. One already
    // here, the clock having run on out of it, stays until the next: link().)
    this.ensure(this.windowStart(T)); this.ensure(this.windowStart(T) + span);
    // drop windows far from the clock (a rush-hour window decodes to tens of MB), but those a directed shot has
    // asked to keep (this.keep: [from, to] in seconds, the time the shot plays through); one still on its way is
    // called off (simworker.js), or a drag along the time line left a queue of them ahead of the one wanted
    const keep = this.keep;
    for (const [k, w] of this.windows) {
      if (Math.abs(k - this.windowStart(T)) <= span || (keep && k + span > keep[0] && k < keep[1])) continue;
      this.windows.delete(k);
      if (w === 'loading') for (const [id, w0] of this.requests) if (w0 === k) { this.requests.delete(id); this.worker.postMessage({ cancel: id }); }
    }
    if (T < this.begin || T >= this.end) { this.hide(); return; }
    if (!W || W === 'loading') return; // (the window is on its way: the cars hold where they were for a frame or two)

    const cx = camera.position.x, cy = camera.position.y, cz = camera.position.z;
    const p = [0, 0, 0], q = [0, 0, 0], r = [0, 0, 0];
    this.covers?.refresh();
    let mid = 0, lights = 0, active = 0, nearSpeed = 0, nearStopped = 0, nearN = 0;
    const m = this.m.elements, night = shared.uNight.value;
    this.view = null; this.probeHits.length = 0;
    // (written over in place, their length set at the end: emptied each frame, they gave up their storage and grew it again)
    const cars = this.cars ??= [], nearby = this.nearby; let nCars = 0, nNear = 0;
    this.fleet.begin();
    // A seen car's height follows the street exactly, but a step of more than half a metre from one frame to the
    // next (onto a deck, off it) is eased over a tenth of a second, or at the speed of the opening the car would
    // hop. (Eased only from one frame to the next: a car first seen, or after a cut, is put down.)
    const frame = ++this.frameNo;
    // (the simulation's seconds since the last frame: what turns a car's wheels. They turned by the frame's own time:
    // with the clock stopped, or waiting for a window, a standing queue's slow cars stood with their wheels turning,
    // and at four times the speed they turned a quarter as fast as the car went.)
    const gone = T - (this.lastT ?? T), dT = Math.max(0, Math.min(8, gone)); this.lastT = T;
    // (by day, how far a car beyond the boxes may come nearer in a frame: its own 45 m/s and the camera's move. The
    // camera's place last frame: a cut, or a flight, counts.)
    const eyeWas = this.eyeWas ??= [cx, cy, cz], eyeMoved = Math.hypot(cx - eyeWas[0], cy - eyeWas[1], cz - eyeWas[2]);
    eyeWas[0] = cx; eyeWas[1] = cy; eyeWas[2] = cz;
    const closing = 45 * Math.max(dT, dt) + eyeMoved * 1.5 + 1, skip = W.skip ??= new Int32Array(W.n);
    if (eyeMoved > 400 || Math.abs(gone) > 5) skip.fill(0); // (a cut, or the clock moved by hand: anything may be anywhere)
    if (frame % 120 === 0) {
      for (const [k, v] of this.heights) if (frame - v[1] > 60) this.heights.delete(k);
      for (const map of [this.corr, this.trail]) for (const [k, v] of map) if (frame - v[2] > 60) map.delete(k);
      for (const [k, v] of this.placed) if (frame - v[4] > 60) { this.placed.delete(k); this.boxLooks.delete(k); }
    }
    // (a car seen only as its lamps, past the boxes at night, kept as it was worked out on one of the last two frames:
    // [x, y of its lamps, z, x and z from its middle to its front lamps, the frame, how far it is faded in] per track)
    const far = W.far ??= new Float32Array(W.n * 7).fill(-1e9);
    for (let i = 0; i < W.n; i++) {
      // Far off at night a car is two points of light, eight thousand of them in the rush hour; each worked out
      // every 3rd frame, a third of them each frame (its place moves less than a pixel in between), they were most
      // of the cars' time on an M3. Past 5 km, every 6th (by where it was last worked out: half the lamps of a wide
      // view are that far, and at dusk they were 2 of the cars' 4.6 ms on an M3).
      const f7 = i * 7, fx = far[f7] - cx, fz = far[f7 + 2] - cz, lampEvery = fx * fx + fz * fz > 5000 * 5000 ? 6 : 3;
      if (night > 0.02 && (i + frame) % lampEvery !== 0 && far[f7 + 5] >= frame - (lampEvery - 1) && W.vid[i] !== this.followed) {
        active++;
        if (lights < MAX_LIGHTS) {
          const x = far[f7], h = far[f7 + 1], z = far[f7 + 2], sx = far[f7 + 3], sz = far[f7 + 4], shown = far[f7 + 6], o = lights * 6;
          this.lightPos[o] = x + sx; this.lightPos[o + 1] = h; this.lightPos[o + 2] = z + sz;
          this.lightPos[o + 3] = x - sx; this.lightPos[o + 4] = h; this.lightPos[o + 5] = z - sz;
          this.lightCol[o] = shown; this.lightCol[o + 1] = 0.9 * shown; this.lightCol[o + 2] = 0.72 * shown;
          const red = 0.45 * shown;
          this.lightCol[o + 3] = red; this.lightCol[o + 4] = 0.03 * red; this.lightCol[o + 5] = 0.02 * red;
          lights++;
        }
        continue;
      }
      // By day a car beyond the boxes is not drawn at all, and need not be looked at until it could have come within
      // them: the frame it was last worked out and how far off it was say when (W.skip). Every car on the road, thirty
      // thousand at the rush hour, was put on its track every frame to find that out, most of the cars' time by day.
      if (skip[i] > frame && W.vid[i] !== this.followed) { active++; continue; }
      if (!SimTraffic.at(W, i, T, p)) { far[f7 + 5] = -1e9; continue; }
      active++;
      const dx = p[0] - cx, dz = p[2] - cz, d2 = dx * dx + dz * dz + (p[1] - cy) * (p[1] - cy);
      const vid = W.vid[i], followed = vid === this.followed;
      // (beyond the boxes only the lamps show, and only from dusk to dawn)
      if (!followed && (d2 > LIGHTS * LIGHTS || (d2 > MID * MID && night <= 0.02))) {
        if (night <= 0.02 && d2 > (MID + 150) * (MID + 150)) skip[i] = frame + Math.min(90, Math.floor((Math.sqrt(d2) - MID - 100) / closing));
        continue;
      }
      let heading = W.heading[i], speed = 0, hadQ = false, hadR = false, rawHeading = NaN;
      // A box beyond the models (past sim.near): its way, speed and brake lights, and its place on what is drawn (its
      // painted lane, the corrected level, the deck or the street under it), worked out every 4th frame, a quarter of
      // them each frame; in between it keeps its heading and the move and height over its track it had. Out there a
      // car moves a few pixels a frame; worked out every frame for the thousand or so of them, they were over half the
      // frame's time on an M3 in the opening's ride.
      // (and so a model past DETAIL, the lighter one, its nose's pitch with it: in the opening's long shots, models out to
      // 1.3 km, a few hundred of them worked out every frame were 5 ms of the frame headless)
      const box = !followed && d2 <= MID * MID && d2 > DETAIL * DETAIL, px0 = p[0], pz0 = p[2], py0 = p[1];
      // (past a kilometre, where a box is a few pixels long, every 8th frame)
      const every = d2 > 1000 * 1000 ? 8 : 4, placed = box ? this.placed.get(vid) : null, reuse = !!placed && placed[4] >= frame - every && (frame + vid) % every !== 0;
      if (reuse) { heading = placed[6]; speed = placed[7]; }
      else if (d2 > MID * MID && !followed) {
        // only its lamps show: the way along its stretch of track is near enough (tens of thousands of these)
        const a = (W.start[i] + W.cursor[i]) * 4, K = W.K, hx = K[a + 5] - K[a + 1], hz = K[a + 7] - K[a + 3];
        if (hx * hx + hz * hz > 0.01) heading = W.heading[i] = Math.atan2(hx, hz);
        else if (Number.isNaN(heading)) heading = W.heading[i] = this.restHeading(W, i, T);
      } else {
        // heading and speed from where it was half a second ago and will be half a second on
        hadQ = SimTraffic.at(W, i, T - 0.5, q); hadR = SimTraffic.at(W, i, T + 0.5, r);
        SimTraffic.at(W, i, T, p); // (restore the cursor)
        const hx = (hadR ? r[0] : p[0]) - (hadQ ? q[0] : p[0]), hz = (hadR ? r[2] : p[2]) - (hadQ ? q[2] : p[2]);
        const moved = Math.sqrt(hx * hx + hz * hz); speed = moved / ((hadQ ? 0.5 : 0) + (hadR ? 0.5 : 0) || 1);
        let fx = hx, fz = hz;
        // (a slow car takes its heading over a longer stretch of its way: SUMO moves a car into the next lane in one
        // step of a second, and in a queue at walking pace that step was three metres sideways to one forward, the car
        // turned broadside across the lanes for that second)
        if (moved > 0.02 && moved < 8) {
          const back = this.back, on = this.on ??= [0, 0, 0];
          for (let sp = 0; sp < 2; sp++) { const span = sp ? 3 : 1.5;
            const hb = SimTraffic.at(W, i, T - span, back), ho = SimTraffic.at(W, i, T + span, on);
            const gx = (ho ? on[0] : p[0]) - (hb ? back[0] : p[0]), gz = (ho ? on[2] : p[2]) - (hb ? back[2] : p[2]);
            if (gx * gx + gz * gz > fx * fx + fz * fz) { fx = gx; fz = gz; }
            if (fx * fx + fz * fz >= 64) break;
          }
          SimTraffic.at(W, i, T, p);
        }
        if (moved > 0.02) { heading = Math.atan2(fx, fz); W.heading[i] = heading; }
        else if (Number.isNaN(heading)) heading = W.heading[i] = this.restHeading(W, i, T);
        // (the way the moves onto what is drawn look along, below: as it was shown last, if it was)
        const tr = this.trail.get(vid);
        if (tr && tr[2] >= frame - 8) { rawHeading = heading; heading = tr[3]; }
      }
      // braking: slower than half a second ago by more than ~1.2 m/s², or standing in a queue
      let brake = reuse ? placed[8] : 0;
      if (!reuse && hadQ && (d2 < this.near * this.near || followed || (night > 0.02 && d2 < 2000 * 2000))) { // (only where a brake light can be seen)
        const back = this.back;
        if (SimTraffic.at(W, i, T - 1.0, back)) {
          const bx = q[0] - back[0], bz = q[2] - back[2], before = Math.sqrt(bx * bx + bz * bz) / 0.5;
          brake = before - speed > 0.6 || speed < 0.4 ? 1 : 0;
        }
        SimTraffic.at(W, i, T, p);
      }
      let sin = Math.sin(heading), cos = Math.cos(heading);
      const seen = d2 < MID * MID || followed;
      // (a box between its 4th frames: as it was, moved along its track)
      let y, raised, sy, road = null, lag = 0; // (lag: how far the move onto what is drawn is behind the one wanted, m: for this.trace)
      if (reuse) {
        p[0] += placed[0]; p[2] += placed[1]; y = sy = py0 + placed[2]; raised = placed[3] === 1;
      } else {
        // Where the picture moves a car from where SUMO has it, onto what is drawn: into the lane the tiles paint, on the
        // expressway (relane); onto the deck drawn, from just beyond its edge (stand's push); and its whole body on what is
        // drawn (roadlevel.js fit: across its way, as far as it takes, up to 4 m. SUMO's lanes are not always the city's:
        // netconvert's --ramps.guess gave Avenida Piñero a third lane for the 94 m before a ramp, 5 m out from its middle
        // where the tiles pave 3.5). The three are one move across, and the car makes it as a driver would: no faster
        // across than a third of its speed (and 0.3 m/s at a standstill), turned the way it moves (below). Each eased on its own, and the
        // deck's push not at all, they slid the cars sideways, broadside at walking pace, or jumped them 3.5 m in a frame
        // where a deck's edge came and went: in half a minute at five places, one car in five slid.
        // (A car first seen, or after a cut, is put down where the moves put it.)
        // On what the city draws there: the street (the tiles' surface, flat across the triangles they draw it with:
        // src/shared/terrain.js meshHeight), or a deck or a ramp the flyovers draw (roadlevel.js), the one of the two
        // nearer the level the simulation has the car at. Never at a height nothing is drawn at: the simulation drove the levels the
        // compiler gave the roads, humps of the elevation model in them here and there, and a car following them
        // sank into the street where the street ran over a hump the levels did not have, or rose off it where the
        // levels had one the street did not. For a car seen only as its lamps, the simulation's own height is near
        // enough (and the ground is not looked up for tens of thousands).
        // (the simulation's height for it, put on the corrected levels: fixAt)
        const fixed = seen && this.fixes?.size ? this.fixAt(p[0], p[2], p[1], heading) : null; sy = fixed ?? p[1]; road = fixed == null ? null : this.fixEdge;
        // The track is the car's front bumper (SUMO's place for a vehicle: in a standing queue the tracks are a
        // leader's length and SUMO's 2 m apart, whatever follows), and the bodies are drawn about their middles: its
        // middle is half its length back along the way it faces. (Drawn with its middle on the track, every car stood
        // half its length ahead of where it was: over the stop line by two metres and more, a bus six, and a bus in a
        // queue stood a metre or two inside the car in front of it.)
        const half = seen ? TYPES[W.type[i]].L / 2 : 0;
        const rx = p[0] - sin * half, rz = p[2] - cos * half;
        let cx = 0, cz = 0;
        if ((d2 < MID * MID || followed) && this.laneCells) {
          const mid = this.mid ??= [0, 0, 0]; mid[0] = rx; mid[2] = rz;
          const m = this.relane(mid, heading);
          let sx = m ? m[0] : 0, sz = m ? m[1] : 0, n = 1, any = !!m;
          // (a full model: the move into its painted lane taken as well where its track has it a little before and
          // after, about 24 m either way, and averaged: where SUMO's lanes and the painted ones change in number, three
          // into five and then four into four, the lane a car is put in changed at a line across the road, a lane's
          // width at once on PR-22. Averaged, it moves across before the line and after it, as a driver would. Further
          // off, the easing below makes the same move, only after the line.)
          if (d2 < DETAIL * DETAIL || followed) {
            const span = Math.min(6, Math.max(0.5, 24 / Math.max(1, speed))), o = this.around ??= [0, 0, 0];
            for (const k of AROUND) {
              if (!SimTraffic.at(W, i, T + k * span, o)) continue;
              const mk = this.relane(o, heading); n++;
              if (mk) { sx += mk[0]; sz += mk[1]; any = true; }
            }
            SimTraffic.at(W, i, T, o); // (restore the cursor)
          }
          if (any) { cx = sx / n; cz = sz / n; }
        }
        let stood = seen ? this.drawn.stand(this.surface, rx + cx, rz + cz, sy, heading, road) : null;
        if (stood?.push) { cx += stood.push[0]; cz += stood.push[1]; } // (onto the deck drawn, from just beyond its edge)
        if (seen && (d2 < this.near * this.near || followed)) {
          const spec = TYPES[W.type[i]];
          const f = this.drawn.fit(this.surface, rx + cx, rz + cz, stood.y, heading, stood.deck, spec.spec.W, spec.L, road);
          if (f) { cx += f[0]; cz += f[1]; }
        }
        if (seen) {
          // Towards the move wanted as a driver steers across: a spring, critically damped (MOVE s), no faster across
          // than DRIFT m/s at speed (0.3 at a standstill), over the time since this car was last worked out, as
          // simulated. (Stepped towards it at a third of the car's speed instead, 7 m/s across on the expressway, a car
          // went sideways a metre in a few frames wherever the move wanted changed, and twitched where it flickered for
          // a frame, as it does where one stretch of painted lanes meets the next: the expressway's cars braked and
          // surged half a metre at a time with nothing in front of them.) [x, z, frame, its speed across x, z]
          const was = this.corr.get(vid), gap = was ? frame - was[2] : Infinity, wx = cx, wz = cz;
          if (gap <= 8) {
            const h = Math.max(1e-6, gap * dt * Math.max(1, this.rate || 0)), w = 1 / MOVE, decay = Math.exp(-w * h);
            const ex = was[0] - cx, ez = was[1] - cz, gx = was[3] + w * ex, gz = was[4] + w * ez;
            let nx = cx + (ex + gx * h) * decay, nz = cz + (ez + gz * h) * decay;
            let vx = (was[3] - gx * w * h) * decay, vz = (was[4] - gz * w * h) * decay;
            const most = Math.min(DRIFT, 0.3 + 0.12 * speed) * h, mx = nx - was[0], mz = nz - was[1], m = Math.hypot(mx, mz);
            if (m > most) { nx = was[0] + mx * most / m; nz = was[1] + mz * most / m; vx = (nx - was[0]) / h; vz = (nz - was[1]) / h; }
            was[3] = vx; was[4] = vz;
            cx = was[0] = nx; cz = was[1] = nz; was[2] = frame;
          } else if (was) { was[0] = cx; was[1] = cz; was[2] = frame; was[3] = was[4] = 0; }
          else this.corr.set(vid, [cx, cz, frame, 0, 0]);
          lag = Math.hypot(wx - cx, wz - cz);
          if (cx !== 0 || cz !== 0) stood = this.drawn.stand(this.surface, rx + cx, rz + cz, sy, heading, road);
        }
        p[0] = rx + cx; p[2] = rz + cz;
        // Its heading: from its rear axle, dragged behind its front bumper, where SUMO has it (a trailer's hitch, the
        // tractrix: a car's tail follows its nose and never goes sideways), four fifths of its length back. Taken from the track half a second either
        // way and eased, it slid: SUMO moves a car into the next lane at walking pace three metres across to one along.
        // (Behind SUMO's place, not the one shown: the moves onto what is drawn come and go a little from frame to frame,
        // and a car dragged by them wagged its tail.) A car first seen, after a cut, or put down metres from where it
        // was: its rear on its track's heading.
        // (the track's knots are SUMO's seconds, the way between them straight: dragged along it, a car on a curve turned
        // in a jolt every second. The nose it drags by is the track eased over a second, half before and half after.)
        if (seen) {
          const K = TYPES[W.type[i]].L * 0.8; let tr = this.trail.get(vid);
          const fx = hadQ && hadR ? (q[0] + 2 * px0 + r[0]) / 4 : px0, fz = hadQ && hadR ? (q[2] + 2 * pz0 + r[2]) / 4 : pz0;
          if (tr && tr[2] >= frame - 8 && (fx - tr[4]) ** 2 + (fz - tr[5]) ** 2 < 64) {
            const bx = fx - tr[0], bz = fz - tr[1], b = Math.sqrt(bx * bx + bz * bz);
            if (b > 1e-4) {
              // (and it turns no faster than 2.5 rad/s, as simulated: SUMO puts a car across a junction or into a lane
              // in a step now and then, and it swung round on its tail)
              const want = Math.atan2(bx, bz), dh = Math.atan2(Math.sin(want - tr[3]), Math.cos(want - tr[3]));
              const cap = 2.5 * (frame - tr[2]) * dt * Math.max(1, this.rate || 0), h = tr[3] + Math.max(-cap, Math.min(cap, dh));
              tr[0] = fx - Math.sin(h) * K; tr[1] = fz - Math.cos(h) * K; tr[3] = h;
            }
            tr[2] = frame; tr[4] = fx; tr[5] = fz;
          } else {
            const h = Number.isNaN(rawHeading) ? heading : rawHeading;
            if (tr) { tr[0] = fx - Math.sin(h) * K; tr[1] = fz - Math.cos(h) * K; tr[2] = frame; tr[3] = h; tr[4] = fx; tr[5] = fz; }
            else this.trail.set(vid, (tr = [fx - Math.sin(h) * K, fz - Math.cos(h) * K, frame, h, fx, fz]));
          }
          heading = tr[3];
          // (turned the way it moves across onto what is drawn, as a car steering into its lane is, not sliding there
          // broadside: its speed across over its speed along, that taken as at least 4 m/s, so a car standing in a
          // queue, nudged across, turns a few degrees and not round to face the way it is nudged)
          const cv = this.corr.get(vid);
          if (cv && cv[2] === frame && (cv[3] || cv[4])) { const s = Math.max(4, speed); heading = Math.atan2(Math.sin(heading) * s + cv[3], Math.cos(heading) * s + cv[4]); }
          sin = Math.sin(heading); cos = Math.cos(heading);
          // (its middle again, behind its bumper the way it now faces)
          p[0] = px0 - sin * half + cx; p[2] = pz0 - cos * half + cz;
        }
        raised = !!stood?.deck;
        y = seen ? stood.y : sy;
        if (seen) {
          // (a step in what it stands on, onto a deck or off it: taken up as a height over the surface that dies away
          // in a tenth of a second. [that height, the frame, the surface's level, x, z] Eased only while more than
          // half a metre was left of it, the last half metre was a hop in one frame, and a kerb's or a deck joint's
          // 20 cm was not eased at all.)
          const h = this.heights.get(vid);
          if (h && h[1] >= frame - 8) {
            const run = Math.hypot(p[0] - h[3], p[2] - h[4]), step = y - h[2];
            let over0 = h[0] * Math.exp(-(frame - h[1]) * dt / 0.1);
            if (Math.abs(step) > 0.08 + 0.12 * run && Math.abs(step) < 12) over0 -= step; // (not the road's own slope)
            h[0] = Math.abs(over0) < 0.004 ? 0 : over0; h[1] = frame; h[2] = y; h[3] = p[0]; h[4] = p[2];
            y += h[0];
          } else if (h) { h[0] = 0; h[1] = frame; h[2] = y; h[3] = p[0]; h[4] = p[2]; }
          else this.heights.set(vid, [0, frame, y, p[0], p[2]]);
        }
        if (box) {
          // (numbers only, so that they are kept as numbers, not each in a box of its own: raised 0 or 1, the pitch NaN till known)
          if (placed) { placed[0] = p[0] - px0; placed[1] = p[2] - pz0; placed[2] = y - py0; placed[3] = raised ? 1 : 0; placed[4] = frame; placed[6] = heading; placed[7] = speed; placed[8] = brake; placed[9] = NaN; }
          else this.placed.set(vid, [p[0] - px0, p[2] - pz0, y - py0, raised ? 1 : 0, frame, 0, heading, speed, brake, NaN]);
        }
      }
      // A car setting off or arriving (or split where SUMO cleared a jam) fades in or out, over about half a
      // second as watched: its track starts or ends inside this window, not at its edge.
      const s0 = W.start[i] * 4, s1 = (W.start[i] + W.count[i] - 1) * 4, fade = Math.max(1, this.rate * 0.5);
      let shown = 1;
      if (W.K[s0] > W.t0 || W.fresh[i]) shown = Math.min(shown, (T - W.K[s0]) / fade); // (on the hour itself: only one the window before did not have, link())
      if (W.K[s1] < W.t1 - 0.5) shown = Math.min(shown, (W.K[s1] - T) / fade);
      shown = smooth(0, 1, shown);
      if (followed) this.view = { x: p[0], y, z: p[2], heading, speed, vid, type: W.type[i], brake };
      const t = W.type[i], spec = TYPES[t];
      // under a building drawn (this.covers: drive.js Overhead), out of sight: its nose, middle and tail each a third
      if (this.covers && seen && d2 < this.near * this.near) {
        const hl = spec.L * 0.4, top = y + 2.2, cv = this.covers;
        const n = (cv.at(p[0], p[2]) > top) + (cv.at(p[0] + sin * hl, p[2] + cos * hl) > top) + (cv.at(p[0] - sin * hl, p[2] - cos * hl) > top);
        if (n) shown *= 1 - n / 3;
      }
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
      if (this.trace) this.trace(vid, p[0], y, p[2], d2 < this.near * this.near ? 'near' : d2 < MID * MID ? 'mid' : 'far', p[1], sy, raised, shown, heading, spec, lag);
      if (d2 < 320 * 320) { nearby[nNear++] = p[0]; nearby[nNear++] = p[2]; } // (for the minimap: x, z of each)
      if (d2 < 420 * 420) { cars[nCars++] = p[0]; cars[nCars++] = p[2]; cars[nCars++] = heading; cars[nCars++] = speed; } // (for the people waiting to cross: src/world/people.js)
      if (d2 < 250 * 250) { nearN++; nearSpeed += speed; if (speed < 0.5) nearStopped++; }
      // near: the model; across the band at its edge it dissolves into the box, which stands in from there out
      const d = Math.sqrt(d2), near = this.near, handover = followed ? 0 : smooth(near - BAND, near, d);
      let boxed = true, modelled = false;
      if (d < near || followed) {
        // nose up or down with the road (a model placed with its box's: kept with its place)
        let pitch = reuse ? placed[9] : NaN;
        if (Number.isNaN(pitch)) {
          const ahead = (this.drawn.stand(this.surface, p[0] + sin * 2.5, p[2] + cos * 2.5, y, heading, road).y - this.drawn.stand(this.surface, p[0] - sin * 2.5, p[2] - cos * 2.5, y, heading, road).y) / 5;
          pitch = -Math.atan(ahead);
          if (box) (placed ?? this.placed.get(vid))[9] = pitch;
        }
        const cp = Math.cos(pitch), sp = Math.sin(pitch);
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
          const dist = sp0 && sp0[1] === frame - 1 ? sp0[0] + speed * dT : hash(vid) * 40;
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
        // (a box's look kept with its place: worked out afresh for every box every frame, a thousand of them)
        let lk = this.looks.get(vid);
        if (!lk) { lk = this.boxLooks.get(vid); if (!lk) this.boxLooks.set(vid, (lk = lookOf(spec.name, vid))); }
        this.boxes.setColorAt(mid, this.color.setRGB(lk.paint[0], lk.paint[1], lk.paint[2]));
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
        // (kept for the next two frames, if it is one of the far ones)
        if (d2 > MID * MID && !followed) { const f7 = i * 7; far[f7] = p[0]; far[f7 + 1] = h; far[f7 + 2] = p[2]; far[f7 + 3] = sin * L; far[f7 + 4] = cos * L; far[f7 + 5] = frame; far[f7 + 6] = shown; }
        else far[i * 7 + 5] = -1e9;
      }
    }
    this.fleet.end();
    cars.length = nCars; nearby.length = nNear;
    if (frame % 240 === 0) {
      for (const [k, v] of this.spins) if (frame - v[1] > 60) { this.spins.delete(k); this.looks.delete(k); }
    }
    // Only the part of each buffer in use goes up to the GPU. They are sized for the busiest morning (40,000 boxes,
    // 120,000 pairs of lamps), and sent whole every frame they were 9 MB a frame, 14 ms of an M3's frame in the
    // browser's upload, the most of any one thing (a few hundred kilobytes now).
    const upload = (attr, n) => { if (n <= 0) return; attr.clearUpdateRanges(); attr.addUpdateRange(0, n * attr.itemSize); attr.needsUpdate = true; }; // (none in use: nothing is drawn, nothing sent)
    upload(this.boxHide, mid);
    this.boxes.count = mid; upload(this.boxes.instanceMatrix, mid);
    if (this.boxes.instanceColor) upload(this.boxes.instanceColor, mid);
    const g = this.lights.geometry;
    g.setDrawRange(0, lights * 2);
    upload(g.attributes.position, lights * 2); upload(g.attributes.color, lights * 2);
    this.lights.material.uniforms.uScale.value = Math.min(3, devicePixelRatio || 1);
    this.beam.color.setScalar(0.36 * this.headlights * night);
    this.beam.visible = night > 0.02;
    this.stats = { active, near: this.fleet.count, mid, lights, nearSpeed: nearN ? nearSpeed / nearN : null, nearStopped, nearCount: nearN };
  }

  // (another run takes its place, main.js setScenario: its buffers on the GPU go too, 7 MB and more a run otherwise left)
  dispose() {
    this.worker.terminate(); this.windows.clear();
    this.fleet.dispose();
    for (const o of [this.boxes, this.lights]) { o.geometry.dispose(); o.material.dispose(); }
    this.beam.map?.dispose(); this.beam.dispose();
  }

  hide() {
    this.fleet.hide();
    this.boxes.count = 0; this.lights.geometry.setDrawRange(0, 0);
    this.stats = { active: 0, near: 0, mid: 0, lights: 0 };
  }

  // The way a standing car faces: the way it came (the last stretch of its track before T where it moved; else, its
  // track having come over from the window before, the way it came there: link()), or for a car that has not moved
  // yet, the way it will go. (ahead false: only the way it came, or null)
  restHeading(W, i, T, carried = W.carried?.[i] ?? NaN, ahead = true) {
    const s = W.start[i], c = W.count[i], K = W.K;
    const dir = (j) => { const a = (s + j) * 4, b = a + 4, dx = K[b + 1] - K[a + 1], dz = K[b + 3] - K[a + 3]; return dx * dx + dz * dz > 0.25 ? Math.atan2(dx, dz) : null; };
    let j = 0;
    while (j < c - 2 && K[(s + j + 1) * 4] <= T) j++;
    for (let k = j; k >= 0; k--) { const h = dir(k); if (h != null) return h; }
    if (!Number.isNaN(carried)) return carried;
    if (!ahead) return null;
    for (let k = j + 1; k < c - 1; k++) { const h = dir(k); if (h != null) return h; }
    return 0;
  }

  // Whether car vid is on the road at T (its window loaded)
  alive(vid, T) {
    const W = this.windows.get(this.windowStart(T));
    if (!W || W === 'loading') return false;
    const p = [0, 0, 0];
    for (let i = 0; i < W.n; i++) if (W.vid[i] === vid && SimTraffic.at(W, i, T, p)) return true; // (a car set down further on has two tracks)
    return false;
  }
  // Cars within `radius` of (x, z) at time T that will still be driving `until` seconds on: [{ vid, x, z, heading }].
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
