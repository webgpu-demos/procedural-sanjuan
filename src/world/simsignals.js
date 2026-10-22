// The signal heads (props.js) showing what the simulation's lights showed (tools/sim/run.py signals.json):
// each head is matched to the road it faces, the road to SUMO's incoming edge, and the edge to its signal and
// link; each frame the state of every head goes into a small texture the lens shader reads.
//   state: 0 green, 1 yellow, 2 red, 3 dark (no power)
import * as THREE from 'three';

const SIZE = 256; // texture width; heads in rows of SIZE
const STATE = { G: 0, g: 0, y: 1, Y: 1, r: 2, R: 2, u: 2, s: 2, o: 3, O: 3 };

export class SimSignals {
  // signals: signals.json; roads: roads.json (the edges SUMO's "e<i>" / "r<i>" are made from)
  constructor(signals, roads) {
    this.links = signals.links; this.timeline = signals.timeline;
    this.heads = [];              // slot -> { tl, link } or null
    this.data = new Uint8Array(SIZE * 32);
    this.texture = new THREE.DataTexture(this.data, SIZE, 32, THREE.RedFormat, THREE.UnsignedByteType);
    this.texture.needsUpdate = true;
    this.cursor = new Map();      // signal -> index of its current change
    // road ends by cell, to find the road a head faces
    this.ends = new Map();
    roads.edges.forEach((e, i) => {
      const p = e.pts, n = p.length / 3;
      if (n < 2) return;
      const add = (k, k0, along) => {
        const x = p[k * 3], z = p[k * 3 + 2], dx = x - p[k0 * 3], dz = z - p[k0 * 3 + 2], l = Math.hypot(dx, dz) || 1;
        const key = Math.floor(x / 40) + ',' + Math.floor(z / 40);
        if (!this.ends.has(key)) this.ends.set(key, []);
        this.ends.get(key).push({ i, x, z, dx: dx / l, dz: dz / l, along, oneway: e.oneway });
      };
      add(n - 1, n - 2, true);  // travelling along the road, arriving at its last point
      add(0, 1, false);         // travelling against it, arriving at its first
    });
  }

  // A head at (x, z) facing `rot` (it faces the traffic arriving): its slot in the texture, or -1.
  slot(x, z, rot) {
    const dx = -Math.sin(rot), dz = -Math.cos(rot); // the way that traffic travels
    let best = null, bestD = 30;
    const cx = Math.floor(x / 40), cz = Math.floor(z / 40);
    for (let i = cx - 1; i <= cx + 1; i++) for (let j = cz - 1; j <= cz + 1; j++)
      for (const e of this.ends.get(i + ',' + j) ?? []) {
        if (e.dx * dx + e.dz * dz < 0.8) continue;
        if (e.along ? e.oneway === -1 : e.oneway === 1) continue; // (one-way the other way)
        const d = Math.hypot(e.x - x, e.z - z);
        if (d < bestD) { bestD = d; best = e; }
      }
    if (!best) return -1;
    const edge = best.along ? `e${best.i}` : best.oneway === -1 ? `e${best.i}` : `r${best.i}`;
    // (a ramp's last stretch is a piece netconvert added: "e<i>-AddedOffRampEdge")
    const links = this.links[edge] ?? Object.entries(this.links).find(([k]) => k.startsWith(edge + '-'))?.[1];
    if (!links?.length) return -1;
    const [tl, link] = links.find((l) => l[2] === 's') ?? links[0];
    if (!this.timeline[tl]) return -1;
    this.heads.push({ tl, link });
    return this.heads.length - 1;
  }

  // Another run of the same network (the apagón): the same heads and links, another history of the lights.
  setTimeline(timeline) { this.timeline = timeline; this.cursor.clear(); }

  // The lights at time T (seconds after midnight).
  update(T) {
    const now = new Map();
    for (let s = 0; s < this.heads.length; s++) {
      const { tl, link } = this.heads[s];
      let st = now.get(tl);
      if (st === undefined) {
        const { states, changes } = this.timeline[tl];
        let k = this.cursor.get(tl) ?? 0;
        while (k < changes.length - 1 && changes[k + 1][0] <= T) k++;
        while (k > 0 && changes[k][0] > T) k--;
        this.cursor.set(tl, k);
        st = states[changes[k][1]];
        now.set(tl, st);
      }
      this.data[s] = STATE[st[link]] ?? 2;
    }
    this.texture.needsUpdate = true;
  }
}
