// The streets' lights seen from afar. Close by, the street lamps light the street themselves (lamplight.js); beyond
// the tiles that are in, the ground is the distant photo-draped mesh (far.js), and a city at night seen from the
// air is the grid of its streets in sodium and LED. Every road of the area is drawn here as a line of light, the
// avenues and expressways brighter and wider than the back streets, into a map the distant ground wears at night.
import * as THREE from 'three';
import { shared } from './materials.js';

const PX = 8; // metres per pixel
// [width of the lit strip (m), how bright] by road class (a _link like its road)
const LIGHT = {
  motorway: [26, 1], trunk: [22, 0.95], primary: [18, 0.85], secondary: [15, 0.75], tertiary: [12, 0.62],
  residential: [9, 0.45], unclassified: [9, 0.4], living_street: [8, 0.38], service: [6, 0.22],
};

// roads: roads.json; extent: the area's tile extent (manifest.extent).
export function buildNightRoads(roads, extent) {
  const W = Math.ceil((extent.maxX - extent.minX) / PX), H = Math.ceil((extent.maxZ - extent.minZ) / PX);
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const g = canvas.getContext('2d', { willReadFrequently: true });
  g.fillStyle = '#000'; g.fillRect(0, 0, W, H);
  g.lineCap = 'round'; g.lineJoin = 'round';
  g.globalCompositeOperation = 'lighter'; // (crossings shine brighter, as they do)
  g.filter = 'blur(0.6px)';
  for (const e of roads.edges) {
    if (e.tunnel) continue;
    const light = LIGHT[(e.highway ?? '').replace('_link', '')];
    if (!light) continue;
    const p = typeof e.pts === 'string' ? JSON.parse(e.pts) : e.pts;
    if (!p || p.length < 6) continue;
    g.lineWidth = Math.max(1, light[0] / PX);
    g.strokeStyle = `rgba(255, 255, 255, ${light[1] * 0.75})`;
    g.beginPath();
    for (let i = 0; i < p.length; i += 3) {
      const x = (p[i] - extent.minX) / PX, y = (p[i + 2] - extent.minZ) / PX;
      if (i) g.lineTo(x, y); else g.moveTo(x, y);
    }
    g.stroke();
  }
  const rgba = g.getImageData(0, 0, W, H).data, r = new Uint8Array(W * H);
  for (let i = 0; i < r.length; i++) r[i] = rgba[i * 4];
  const t = new THREE.DataTexture(r, W, H, THREE.RedFormat);
  t.magFilter = THREE.LinearFilter; t.minFilter = THREE.LinearMipmapLinearFilter; t.generateMipmaps = true;
  t.unpackAlignment = 1;
  t.needsUpdate = true;
  shared.uNightRoads.value = t;
  shared.uNightRoadsRect.value.set(extent.minX, extent.minZ, W * PX, H * PX);
  return t;
}
