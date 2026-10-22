// The jam map ("mapa de tapón"): every main road of the simulation as a ribbon over it, coloured by how fast
// its traffic moved in that five minutes of the morning against how fast it could (speeds.bin, tools/sim/run.py):
// green flowing, yellow slowing, red stopped. The ribbons widen with the camera's height so they read from above.
import * as THREE from 'three';

const MAJOR = /^(motorway|trunk|primary|secondary|tertiary)/;
// speed / free speed -> colour
function colour(r, out) {
  if (r >= 0.75) out.setRGB(0.15, 0.85, 0.45);
  else if (r >= 0.5) out.setRGB(0.98, 0.82, 0.2);
  else if (r >= 0.3) out.setRGB(1.0, 0.45, 0.12);
  else if (r >= 0.15) out.setRGB(0.92, 0.12, 0.1);
  else out.setRGB(0.6, 0.03, 0.12);
  return out;
}

export class SpeedMap {
  // index: the run's index.json; speeds: speeds.bin; roads: roads.json; ground(x, z)
  constructor(index, speeds, roads, ground) {
    this.index = index; this.grid = new Uint8Array(speeds); this.nEdges = index.edges.length;
    this.interval = -1;
    const centre = [], side = [], idx = [], vEdge = [];
    let v = 0;
    index.edges.forEach((id, k) => {
      const m = /^([er])(\d+)(-Added\w+)?$/.exec(id); if (!m) return; // (ramps: pieces netconvert adds keep the road's number)
      const e = roads.edges[Number(m[2])]; if (!e || !MAJOR.test(e.highway) || e.tunnel) return;
      const p = [];
      for (let i = 0; i < e.pts.length; i += 3) p.push([e.pts[i], e.pts[i + 1], e.pts[i + 2]]);
      if (m[1] === 'r' || e.oneway === -1) p.reverse();
      const off = e.oneway ? 0 : 1; // two-way: each direction on its own side of the line (right-hand traffic)
      for (let i = 0; i < p.length; i++) {
        const a = p[Math.max(0, i - 1)], b = p[Math.min(p.length - 1, i + 1)];
        let nx = -(b[2] - a[2]), nz = b[0] - a[0]; const l = Math.hypot(nx, nz) || 1; nx /= l; nz /= l; // right of travel (x east, z south)
        const x = p[i][0] - nx * off, z = p[i][2] - nz * off, y = Math.max(p[i][1], ground(x, z)) + 1.2;
        for (const s of [0, 1]) { centre.push(x, y, z); side.push(nx, nz, s ? 1 : 0); vEdge.push(k); }
        if (i > 0) idx.push(v - 2, v - 1, v, v - 1, v + 1, v);
        v += 2;
      }
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(centre, 3));
    g.setAttribute('aSide', new THREE.Float32BufferAttribute(side, 3));
    this.colors = new Float32Array(v * 4);
    g.setAttribute('color', new THREE.BufferAttribute(this.colors, 4).setUsage(THREE.DynamicDrawUsage));
    g.setIndex(idx);
    this.vEdge = Int32Array.from(vEdge);
    this.material = new THREE.ShaderMaterial({
      uniforms: { uWidth: { value: 8 }, uOpacity: { value: 0 } },
      vertexShader: /* glsl */`
        attribute vec3 aSide; attribute vec4 color; uniform float uWidth; varying vec4 vColor;
        void main() {
          vColor = color;
          vec3 p = position + vec3(aSide.x, 0.0, aSide.y) * (aSide.z * 2.0 - 1.0) * uWidth * 0.5 + vec3(aSide.x, 0.0, aSide.y) * uWidth * 0.5;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
        }`,
      fragmentShader: /* glsl */`
        uniform float uOpacity; varying vec4 vColor;
        void main() { gl_FragColor = vec4(vColor.rgb * 1.6, vColor.a * uOpacity); }`,
      transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -6, polygonOffsetUnits: -12,
    });
    this.mesh = new THREE.Mesh(g, this.material);
    this.mesh.frustumCulled = false; this.mesh.renderOrder = 5; this.mesh.visible = false;
    this.on = false; this.opacity = 0;
    this.c = new THREE.Color();
  }

  // another run of the same network (the apagón)
  setSpeeds(index, speeds) { this.index = index; this.grid = new Uint8Array(speeds); this.interval = -1; }

  // T: seconds after midnight; height: the camera's above the ground
  update(dt, T, height) {
    this.opacity += ((this.on ? 0.92 : 0) - this.opacity) * (1 - Math.exp(-dt * 4));
    this.mesh.visible = this.opacity > 0.01;
    this.material.uniforms.uOpacity.value = this.opacity;
    this.material.uniforms.uWidth.value = Math.max(5, Math.min(60, height * 0.012));
    if (!this.mesh.visible) return;
    const k = Math.floor((T - this.index.speedBegin) / this.index.speedInterval);
    const rows = this.grid.length / this.nEdges;
    if (k === this.interval || k < 0 || k >= rows) return;
    this.interval = k;
    const row = this.grid.subarray(k * this.nEdges, (k + 1) * this.nEdges), c = this.colors;
    for (let v = 0; v < this.vEdge.length; v++) {
      const s = row[this.vEdge[v]];
      if (s === 255) { c[v * 4 + 3] = 0; continue; }
      colour(s / 254, this.c);
      c[v * 4] = this.c.r; c[v * 4 + 1] = this.c.g; c[v * 4 + 2] = this.c.b; c[v * 4 + 3] = 1;
    }
    this.mesh.geometry.attributes.color.needsUpdate = true;
  }
}
