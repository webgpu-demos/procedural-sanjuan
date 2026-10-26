// Synthetic drone images with labels, for training a detector (tools/synth/export.mjs drives this from a headless
// browser; tools/synth/experiment/ measures what the images are worth against real frames). On window.__app.synth.
//
//   configure({ damage, seed })   a share of the low buildings gets a blue tarp on its roof and piles of debris
//                                 beside it (hurricane damage as it looks from the air in Puerto Rico after María)
//   plan({ ... })                 drone poses over a box: flight lines at an altitude, a camera pitch and heading
//   pose(p)                       puts the camera there; ready() waits until the tiles under the view are in
//   capture({ ... })              the picture (JPEG), the labels (boxes per instance: building, blue_tarp, debris,
//                                 vehicle), an id image for masks, and what the frame is (pose, ids of buildings)
//
// The labels come from the scene itself (src/synth/labels.js), so they are exact for what the camera sees; what
// is not in the scene (people, wires, laundry) is not in them either. Distant buildings drawn as plain blocks are
// not labelled: capture() says how much of the frame they cover (share.block), the exporter skips such frames.
import * as THREE from 'three';
import { packTarp } from './tarp.js';
import { renderLabels, decodeLabels, NAMES } from './labels.js';

const hash = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return ((h >>> 0) % 1e9) / 1e9; };
const rng = (seed) => { let a = Math.floor(seed * 4294967296) >>> 0 || 1; return () => { a ^= a << 13; a ^= a >>> 17; a ^= a << 5; return ((a >>> 0) % 1e9) / 1e9; }; };
const KIND_ROOF = (k) => (k > 0.5 && k < 1.5) || (k > 2.5 && k < 3.5);

// debris: what a hurricane leaves beside a house (linear colours)
const DEBRIS = [
  { c: [0.20, 0.11, 0.05], s: [2.6, 0.12, 0.3] },   // planks
  { c: [0.33, 0.20, 0.10], s: [1.2, 0.5, 0.9] },    // furniture, cabinets
  { c: [0.30, 0.31, 0.33], s: [1.8, 0.04, 0.9] },   // zinc roofing sheets
  { c: [0.22, 0.09, 0.03], s: [1.6, 0.04, 0.8] },   // rusted sheets
  { c: [0.25, 0.25, 0.24], s: [0.6, 0.5, 0.6] },    // concrete
  { c: [0.62, 0.62, 0.60], s: [0.8, 0.9, 0.7] },    // an appliance
  { c: [0.40, 0.32, 0.22], s: [1.9, 0.25, 1.4] },   // a mattress
  { c: [0.07, 0.14, 0.03], s: [2.0, 0.8, 1.5] },    // branches
  { c: [0.012, 0.08, 0.33], s: [1.4, 0.06, 1.0] },  // torn tarp
];

export class Synth {
  constructor(app) {
    this.app = app; // { scene, camera, renderer, controls, streamer, frame, traffic, sim (getter) }
    this.damage = 0; this.seed = 1;
    this.done = new Map();   // facade mesh -> settings key it was prepared with
    this.sites = new Map();  // facade mesh -> [{ x, z, y, ax, ex, ez }] damaged buildings, for debris
    this.debris = null;
    this.rt = null;
    this.names = NAMES;
  }

  configure({ damage = 0, seed = 1 } = {}) {
    this.damage = damage; this.seed = seed;
    this.refresh();
    return { damage, seed };
  }

  facades() {
    const out = [];
    for (const [key, t] of this.app.streamer.tiles) {
      if (t.state !== 'ready' || !t.group) continue;
      t.group.traverse((o) => { if (o.isMesh && o.userData.facade && o.userData.ends) out.push([key, o]); });
    }
    return out;
  }

  // The per-vertex building index (aId) and, for the damaged buildings, the tarp (aSynth), on every loaded tile.
  refresh() {
    const setting = `${this.damage}|${this.seed}`;
    let changed = false;
    const live = new Set();
    for (const [key, m] of this.facades()) {
      live.add(m);
      const g = m.geometry, n = g.attributes.position.count, ends = m.userData.ends, info = m.userData.info;
      if (!g.attributes.aId) {
        const id = new Float32Array(n);
        for (let b = 0, s = 0; b < ends.length; s = ends[b++]) id.fill(b, s, ends[b]);
        g.setAttribute('aId', new THREE.BufferAttribute(id, 1));
      }
      if (this.done.get(m) === setting) continue;
      changed = true;
      const syn = new Float32Array(n * 4), pos = g.attributes.position.array, kind = g.attributes.aBldg.array, sites = [];
      if (this.damage > 0) {
        for (let b = 0, s = 0; b < ends.length; s = ends[b++]) {
          const e = ends[b], height = info[b]?.[2] ?? 99;
          if (e - s < 6 || height > 15 || hash(`${key}|${b}|${this.seed}`) >= this.damage) continue;
          // the roof: its orientation (principal axis of its vertices) and extent along and across it
          let n0 = 0, mx = 0, mz = 0;
          for (let v = s; v < e; v++) { if (!KIND_ROOF(kind[v * 4 + 2])) continue; mx += pos[v * 3]; mz += pos[v * 3 + 2]; n0++; }
          if (n0 < 3) continue;
          mx /= n0; mz /= n0;
          let cxx = 0, czz = 0, cxz = 0;
          for (let v = s; v < e; v++) {
            if (!KIND_ROOF(kind[v * 4 + 2])) continue;
            const dx = pos[v * 3] - mx, dz = pos[v * 3 + 2] - mz; cxx += dx * dx; czz += dz * dz; cxz += dx * dz;
          }
          const ang = 0.5 * Math.atan2(2 * cxz, cxx - czz), ax = [Math.cos(ang), Math.sin(ang)], pe = [-ax[1], ax[0]];
          let u0 = Infinity, u1 = -Infinity, w0 = Infinity, w1 = -Infinity;
          for (let v = s; v < e; v++) {
            if (!KIND_ROOF(kind[v * 4 + 2])) continue;
            const dx = pos[v * 3] - mx, dz = pos[v * 3 + 2] - mz, u = dx * ax[0] + dz * ax[1], w = dx * pe[0] + dz * pe[1];
            u0 = Math.min(u0, u); u1 = Math.max(u1, u); w0 = Math.min(w0, w); w1 = Math.max(w1, w);
          }
          const ex = (u1 - u0) / 2, ez = (w1 - w0) / 2;
          if (ex * ez * 4 < 25) continue; // (a shed: no tarp)
          const r = rng(hash(`${key}|${b}|tarp|${this.seed}`));
          const hx = ex * (0.3 + 0.3 * r()), hz = ez * (0.3 + 0.3 * r());
          const cu = (u0 + u1) / 2 + (r() * 2 - 1) * (ex - hx) * 0.7, cw = (w0 + w1) / 2 + (r() * 2 - 1) * (ez - hz) * 0.7;
          const t = packTarp(mx + cu * ax[0] + cw * pe[0], mz + cu * ax[1] + cw * pe[1], hx, hz, ang);
          for (let v = s; v < e; v++) syn.set(t, v * 4);
          sites.push({ x: mx + ((u0 + u1) / 2) * ax[0] + ((w0 + w1) / 2) * pe[0], z: mz + ((u0 + u1) / 2) * ax[1] + ((w0 + w1) / 2) * pe[1], ax, pe, ex, ez, seed: hash(`${key}|${b}|debris|${this.seed}`) });
        }
      }
      g.setAttribute('aSynth', new THREE.BufferAttribute(syn, 4));
      this.done.set(m, setting);
      this.sites.set(m, sites);
    }
    for (const m of [...this.done.keys()]) if (!live.has(m)) { this.done.delete(m); this.sites.delete(m); changed = true; }
    if (changed) this.buildDebris();
  }

  // Piles of debris beside the damaged buildings: one instanced mesh of boxes; aPile numbers the piles
  buildDebris() {
    const { scene, streamer } = this.app;
    const boxes = [];
    let pile = 0;
    for (const sites of this.sites.values()) for (const s of sites) {
      const r = rng(s.seed);
      if (r() > 0.85) continue;
      for (let p = 0, np = 1 + Math.floor(r() * 2.5); p < np; p++) {
        pile++;
        // beside one of the four walls, one to four metres out
        const side = Math.floor(r() * 4), along = side < 2 ? s.ax : s.pe, across = side < 2 ? s.pe : s.ax, sign = side % 2 ? -1 : 1;
        const out = (side < 2 ? s.ex : s.ez) + 1 + r() * 3, lat = (r() * 2 - 1) * 0.8 * (side < 2 ? s.ez : s.ex);
        const px = s.x + along[0] * out * sign + across[0] * lat, pz = s.z + along[1] * out * sign + across[1] * lat;
        const gy = streamer.ground(px, pz);
        let top = 0;
        for (let k = 0, nk = 4 + Math.floor(r() * 10); k < nk; k++) {
          const d = DEBRIS[Math.floor(r() * DEBRIS.length)], sc = 0.7 + r() * 0.6;
          const size = [d.s[0] * sc, d.s[1] * sc, d.s[2] * sc];
          const ox = (r() * 2 - 1) * 1.4, oz = (r() * 2 - 1) * 1.4, y = gy + top * 0.5 + size[1] / 2;
          top += size[1] * 0.6;
          boxes.push({ pile, x: px + ox, y, z: pz + oz, size, yaw: r() * Math.PI, tilt: (r() * 2 - 1) * 0.35, c: d.c.map((v) => v * (0.8 + 0.4 * r())) });
        }
      }
    }
    if (this.debris) { scene.remove(this.debris); this.debris.geometry.dispose(); this.debris.material.dispose(); this.debris = null; }
    if (!boxes.length) return;
    const geo = new THREE.BoxGeometry(1, 1, 1);
    const mesh = new THREE.InstancedMesh(geo, new THREE.MeshStandardMaterial({ roughness: 0.9 }), boxes.length);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), c = new THREE.Color(), pileId = new Float32Array(boxes.length);
    boxes.forEach((b, i) => {
      q.setFromEuler(e.set(b.tilt, b.yaw, b.tilt * 0.5));
      mesh.setMatrixAt(i, m.compose(new THREE.Vector3(b.x, b.y, b.z), q, new THREE.Vector3(...b.size)));
      mesh.setColorAt(i, c.setRGB(...b.c));
      pileId[i] = b.pile;
    });
    geo.setAttribute('aPile', new THREE.InstancedBufferAttribute(pileId, 1));
    mesh.castShadow = mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    mesh.name = 'synth debris';
    scene.add(mesh);
    this.debris = mesh;
    this.piles = pile;
  }

  /**
   * Drone poses over a box: flight lines `spacing` apart (default: the footprint at the mean altitude with 30 %
   * side overlap), a shot every `step` metres along them (50 % forward overlap), each with its altitude, pitch and
   * heading drawn from the ranges. box: [minX, minZ, maxX, maxZ] in world metres; hfov in degrees; aspect w/h.
   */
  plan({ box, alt = [60, 120], pitch = [-90, -70], hfov = 73.7, aspect = 4 / 3, heading = null, side = 0.3, front = 0.5, max = 500, seed = 1, minBuildings = 20 } = {}) {
    // only over the city: a shot whose 256 m tile holds fewer than minBuildings buildings (sea, park, beach) is left out
    const M = this.app.manifest, size = M.tileSize, count = new Map(M.tiles.map((t) => [t.x + ',' + t.z, t.buildings]));
    const city = (x, z) => (count.get(Math.floor(x / size) + ',' + Math.floor(z / size)) ?? 0) >= minBuildings && this.app.streamer.ground(x, z) > 0.3;
    const r = rng(hash(`plan|${seed}`)), mean = (alt[0] + alt[1]) / 2, half = Math.tan((hfov * Math.PI) / 360);
    const fw = 2 * mean * half, fh = fw / aspect, spacing = fw * (1 - side), step = fh * (1 - front);
    const h0 = heading ?? r() * 180, a = (h0 * Math.PI) / 180, dir = [Math.sin(a), -Math.cos(a)], nrm = [-dir[1], dir[0]];
    const [x0, z0, x1, z1] = box, cx = (x0 + x1) / 2, cz = (z0 + z1) / 2, R = Math.hypot(x1 - x0, z1 - z0) / 2;
    const out = [];
    for (let l = 0, w = -R; w <= R; w += spacing, l++) {
      const back = l % 2 === 1;
      for (let s = -R; s <= R; s += step) {
        const t = back ? -s : s, x = cx + nrm[0] * w + dir[0] * t, z = cz + nrm[1] * w + dir[1] * t;
        if (x < x0 || x > x1 || z < z0 || z > z1 || !city(x, z)) continue;
        const p = { x, z, alt: alt[0] + r() * (alt[1] - alt[0]), pitch: pitch[0] + r() * (pitch[1] - pitch[0]), heading: (h0 + (back ? 180 : 0) + (r() * 2 - 1) * 10 + 360) % 360, line: l };
        // (and where it looks: the ground point at the middle of the picture, over land in the city too)
        const ahead = p.alt / Math.tan((-p.pitch * Math.PI) / 180), hh = (p.heading * Math.PI) / 180;
        if (!city(x + Math.sin(hh) * ahead, z - Math.cos(hh) * ahead)) continue;
        out.push(p);
      }
    }
    // more shots than wanted: an even pick along the flight
    if (out.length > max) { const k = out.length / max; return Array.from({ length: max }, (_, i) => out[Math.floor(i * k)]); }
    return out;
  }

  pose({ x, z, alt, pitch, heading, hfov = 73.7 }) {
    const { camera, controls, streamer } = this.app;
    const aspect = camera.aspect, vfov = (2 * Math.atan(Math.tan((hfov * Math.PI) / 360) / aspect) * 180) / Math.PI;
    camera.fov = vfov; camera.updateProjectionMatrix();
    const g = streamer.ground(x, z), p = (Math.max(-89.5, Math.min(-5, pitch)) * Math.PI) / 180, h = (heading * Math.PI) / 180;
    const d = [Math.sin(h) * Math.cos(p), Math.sin(p), -Math.cos(h) * Math.cos(p)], t = alt / -Math.sin(p);
    camera.position.set(x, g + alt, z);
    controls.target.set(x + d[0] * t, g, z + d[2] * t);
    camera.lookAt(controls.target);
    controls.update();
    return { ground: g };
  }

  // Resolves once the tiles around the view are in and a few frames have been drawn.
  async ready(maxMs = 120000) {
    const t0 = performance.now(), s = this.app.streamer;
    let quiet = 0;
    while (performance.now() - t0 < maxMs) {
      await new Promise((r) => requestAnimationFrame(() => r()));
      quiet = s.pending === 0 ? quiet + 1 : 0;
      if (quiet >= 4) return true;
    }
    return false;
  }

  /** One frame: { image (JPEG data URL), ids (PNG data URL), width, height, instances [{ cls, name, box, n, ... }], share } */
  async capture({ quality = 0.92, minPixels = 0, withIds = true } = {}) {
    const { renderer, scene, camera, streamer } = this.app;
    this.refresh();
    this.app.frame(1 / 60);
    const image = renderer.domElement.toDataURL('image/jpeg', quality);
    const size = renderer.getDrawingBufferSize(new THREE.Vector2()), W = size.x, H = size.y;
    if (!this.rt || this.rt.width !== W || this.rt.height !== H) { this.rt?.dispose(); this.rt = new THREE.WebGLRenderTarget(W, H, { depthBuffer: true }); }
    // a slot (1..250) per building mesh; the rest of the meshes (beyond 250 tiles) stay unlabelled occluders
    const facades = new Map(), slotTile = [null];
    for (const [key, m] of this.facades()) { if (slotTile.length > 250) break; facades.set(m, slotTile.length); slotTile.push([key, m]); }
    const px = renderLabels({ renderer, scene, camera, rt: this.rt, facades, vehicles: [this.app.traffic?.group, this.app.sim?.group], debris: this.debris });
    const { instances, ids, share } = decodeLabels(px, W, H);
    const out = [];
    for (const r of instances) {
      if (r.n < minPixels) continue;
      const o = { no: r.no, cls: r.cls, name: NAMES[r.cls], box: [r.x0, r.y0, r.x1 + 1, r.y1 + 1], n: r.n, edge: r.x0 === 0 || r.y0 === 0 || r.x1 === W - 1 || r.y1 === H - 1 };
      if (r.cls <= 1) {
        const k = parseInt(r.key.slice(1), 10), slot = k >> 16, index = k & 0xffff, st = slotTile[slot];
        if (st) {
          const [tile, m] = st, rec = (await streamer.idsOf(tile))?.[index];
          Object.assign(o, { tile, index, gers: rec?.gers ?? null, osm: rec?.osm ?? null, height: m.userData.info?.[index]?.[2] ?? null });
        }
      } else if (r.cls === 2) o.pile = parseInt(r.key.slice(1), 10);
      out.push(o);
    }
    let idsUrl = null;
    if (withIds) {
      const c = document.createElement('canvas'); c.width = W; c.height = H;
      c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(ids.buffer), W, H), 0, 0);
      idsUrl = c.toDataURL('image/png');
    }
    return { image, ids: idsUrl, width: W, height: H, instances: out, share, camera: { position: camera.position.toArray(), target: this.app.controls.target.toArray(), fov: camera.fov, aspect: camera.aspect } };
  }
}
