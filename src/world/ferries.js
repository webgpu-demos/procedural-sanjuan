// The lancha: the ATI's ferry between Old San Juan and Cataño, crossing the bay on its timetable (GTFS,
// tools/sim/gtfs.py ferries.json). Between crossings it waits at the pier it came to.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { shared } from './materials.js';
import { lampUniforms } from './lamplight.js';

function boatGeometry() {
  const tint = (g, rgb, glow = 0) => {
    g = g.toNonIndexed(); const n = g.attributes.position.count, c = new Float32Array(n * 3), e = new Float32Array(n);
    for (let i = 0; i < n; i++) { c.set(rgb, i * 3); e[i] = glow; }
    g.setAttribute('color', new THREE.BufferAttribute(c, 3)); g.setAttribute('aGlow', new THREE.BufferAttribute(e, 1)); g.deleteAttribute('uv'); return g;
  };
  // a hull 24 m long, pointed at the bow (+z), white above a blue band
  const hull = new THREE.BoxGeometry(6.4, 2.2, 24, 1, 1, 4), p = hull.attributes.position;
  for (let i = 0; i < p.count; i++) { const z = p.getZ(i), y = p.getY(i); const k = z > 6 ? 1 - (z - 6) / 6 * 0.85 : 1; p.setX(i, p.getX(i) * k * (y < 0 ? 0.82 : 1)); }
  hull.computeVertexNormals();
  return mergeGeometries([
    tint(hull.translate(0, 0.6, 0), [0.92, 0.93, 0.94]),
    tint(new THREE.BoxGeometry(6.5, 0.5, 20).translate(0, -0.25, -1), [0.08, 0.22, 0.48]),     // the waterline band
    tint(new THREE.BoxGeometry(5.2, 2.4, 13).translate(0, 2.9, -2.5), [0.9, 0.91, 0.9]),        // the cabin
    tint(new THREE.BoxGeometry(5.3, 0.9, 12.4).translate(0, 3.0, -2.5), [1.0, 0.86, 0.6], 1),   // its windows, lit
    tint(new THREE.BoxGeometry(5.6, 0.25, 14).translate(0, 4.2, -2.5), [0.25, 0.27, 0.3]),      // the roof
    tint(new THREE.BoxGeometry(2.6, 1.6, 3).translate(0, 5.1, 1.5), [0.92, 0.92, 0.9]),         // the wheelhouse
    tint(new THREE.CylinderGeometry(0.08, 0.08, 3).translate(0, 7.2, 1.5), [0.2, 0.2, 0.2]),
    tint(new THREE.SphereGeometry(0.22, 8, 6).translate(0, 8.8, 1.5), [1, 1, 0.95], 2),         // masthead light
    tint(new THREE.SphereGeometry(0.2, 8, 6).translate(-3.1, 2.0, 4), [1, 0.1, 0.08], 2),       // port: red
    tint(new THREE.SphereGeometry(0.2, 8, 6).translate(3.1, 2.0, 4), [0.1, 1, 0.3], 2),         // starboard: green
  ]);
}

export class Ferries {
  static async load(url) {
    const list = await fetch(url).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    return list?.length ? new Ferries(list) : null;
  }
  constructor(list) {
    this.trips = list.map((f) => {
      const pts = f.path.map(([x, z]) => new THREE.Vector3(x, 0, z)), cum = [0];
      for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + pts[i].distanceTo(pts[i - 1]));
      return { ...f, pts, cum };
    }).sort((a, b) => a.depart - b.depart);
    const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.5, metalness: 0.1 });
    m.onBeforeCompile = (shader) => {
      lampUniforms(shader); // (its own hook: the lamp map's sampler must still be given, lamplight.js)
      shader.uniforms.uNight = shared.uNight;
      shader.vertexShader = shader.vertexShader.replace('#include <common>', '#include <common>\nattribute float aGlow;\nvarying float vGlow;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvGlow = aGlow;');
      shader.fragmentShader = shader.fragmentShader.replace('#include <common>', '#include <common>\nuniform float uNight;\nvarying float vGlow;')
        .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\nif (vGlow > 0.5) totalEmissiveRadiance += diffuseColor.rgb * (vGlow > 1.5 ? 0.6 + 4.0 * uNight : 2.2 * uNight);');
    };
    m.customProgramCacheKey = () => 'ferry-v1';
    this.boat = new THREE.Mesh(boatGeometry(), m);
    this.boat.castShadow = true;
    // the wake: a pale fan behind the stern, fading out
    const wg = new THREE.PlaneGeometry(9, 60).rotateX(-Math.PI / 2).translate(0, 0.05, -40);
    const wc = new Float32Array(wg.attributes.position.count * 4);
    for (let i = 0; i < wg.attributes.position.count; i++) { const z = wg.attributes.position.getZ(i); wc.set([1, 1, 1, Math.max(0, 1 + (z + 10) / 60) * 0.5], i * 4); }
    wg.setAttribute('color', new THREE.BufferAttribute(wc, 4));
    this.wake = new THREE.Mesh(wg, new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, opacity: 0.55 }));
    this.group = new THREE.Group(); this.group.name = 'ferries';
    this.group.add(this.boat, this.wake);
  }

  update(T, seaLevel = 0) {
    // the crossing under way, or the last one made (the boat waits at its pier), or the first to come
    let trip = this.trips.find((t) => T >= t.depart && T <= t.arrive);
    let s = 0, moving = !!trip;
    if (trip) s = (T - trip.depart) / Math.max(1, trip.arrive - trip.depart);
    else { trip = [...this.trips].reverse().find((t) => t.arrive < T); s = 1; if (!trip) { trip = this.trips[0]; s = 0; } }
    // easing out of the pier and into the next
    const e = s < 0.12 ? (s / 0.12) ** 2 * 0.06 : s > 0.88 ? 1 - ((1 - s) / 0.12) ** 2 * 0.06 : 0.06 + (s - 0.12) / 0.76 * 0.88;
    const d = e * trip.cum.at(-1);
    let i = 1; while (i < trip.cum.length - 1 && trip.cum[i] < d) i++;
    const a = trip.pts[i - 1], b = trip.pts[i], f = (d - trip.cum[i - 1]) / Math.max(1e-6, trip.cum[i] - trip.cum[i - 1]);
    const t = shared.uTime.value;
    this.boat.position.set(a.x + (b.x - a.x) * f, seaLevel + 0.15 + Math.sin(t * 0.9) * 0.12, a.z + (b.z - a.z) * f);
    const heading = Math.atan2(b.x - a.x, b.z - a.z);
    this.boat.rotation.set(Math.sin(t * 0.7) * 0.012, heading, Math.sin(t * 0.55) * 0.025, 'YXZ');
    this.wake.position.copy(this.boat.position).setY(seaLevel + 0.02); this.wake.rotation.y = heading;
    this.wake.material.opacity = moving && s > 0.05 && s < 0.95 ? 0.55 : 0;
  }
}
