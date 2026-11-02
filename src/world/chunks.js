// A mesh built for the whole city at once (the flyovers, the railways' viaducts, the structures) cut into a few
// pieces, each a compact stretch of the city. Whole, it was drawn whole wherever the camera looked: three culls a
// mesh by its bounds, and the bounds of one of these are the city. The sun's shadow map is redrawn every third frame
// over a square of a kilometre and a half round the focus, and each time it drew every flyover in the city (on an M3,
// 0.9 of the 3 million triangles that went into it at 10:00 over PR-22). Cut into squares of a kilometre, the picture
// gained little for hundreds more draw calls; cut in halves, across the longer side, till each piece is at most `max`
// triangles, a handful of pieces each, and the shadow map and the picture leave out the ones out of their view.
import * as THREE from 'three';

// Each mesh under `root` of more than `max` triangles is replaced by a group of the same name holding its pieces
// (material, shadows, layers and the rest as it had them). Returns root, or what replaced it. Call before frozen().
export function chunked(root, { max = 80000 } = {}) {
  const targets = [];
  root.traverse((o) => {
    if (!o.isMesh || o.isInstancedMesh || o.isSkinnedMesh || o.isBatchedMesh || Array.isArray(o.material)) return;
    const g = o.geometry;
    if (!g?.attributes.position || g.morphAttributes.position || g.groups.length > 1) return;
    if (Object.values(g.attributes).some((a) => a.isInterleavedBufferAttribute || a.isInstancedBufferAttribute)) return;
    if ((g.index ? g.index.count : g.attributes.position.count) / 3 > max) targets.push(o);
  });
  let out = root;
  // (deepest first: a piece's parent may itself be cut, and its children move with it)
  for (const o of targets.reverse()) {
    const pieces = split(o, max);
    const group = new THREE.Group();
    group.name = o.name; group.userData = o.userData; group.layers.mask = o.layers.mask;
    group.position.copy(o.position); group.quaternion.copy(o.quaternion); group.scale.copy(o.scale);
    group.matrixAutoUpdate = o.matrixAutoUpdate; group.updateMatrix();
    for (const p of pieces) {
      p.name = o.name; p.castShadow = o.castShadow; p.receiveShadow = o.receiveShadow; p.layers.mask = o.layers.mask;
      p.renderOrder = o.renderOrder; p.frustumCulled = o.frustumCulled; p.visible = o.visible;
      group.add(p);
    }
    for (const c of [...o.children]) group.add(c);
    if (o.parent) { const parent = o.parent, at = parent.children.indexOf(o); parent.remove(o); parent.add(group); parent.children.splice(parent.children.indexOf(group), 1); parent.children.splice(at, 0, group); }
    if (o === out) out = group;
    o.geometry.dispose();
  }
  return out;
}

function split(o, max) {
  const g = o.geometry, pos = g.attributes.position, idx = g.index, n = (idx ? idx.count : pos.count) / 3;
  const corner = (t, k) => (idx ? idx.getX(t * 3 + k) : t * 3 + k);
  // each triangle's middle, on the ground
  const mx = new Float32Array(n), mz = new Float32Array(n);
  for (let t = 0; t < n; t++) {
    const a = corner(t, 0), b = corner(t, 1), c = corner(t, 2);
    mx[t] = (pos.getX(a) + pos.getX(b) + pos.getX(c)) / 3; mz[t] = (pos.getZ(a) + pos.getZ(b) + pos.getZ(c)) / 3;
  }
  // halves across the longer side, at the middle triangle, till each is small enough
  const leaves = [], stack = [Int32Array.from({ length: n }, (_, t) => t)];
  while (stack.length) {
    const tris = stack.pop();
    if (tris.length <= max) { leaves.push(tris); continue; }
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const t of tris) { x0 = Math.min(x0, mx[t]); x1 = Math.max(x1, mx[t]); z0 = Math.min(z0, mz[t]); z1 = Math.max(z1, mz[t]); }
    const along = x1 - x0 >= z1 - z0 ? mx : mz, sorted = Array.from(tris).sort((p, q) => along[p] - along[q]), h = sorted.length >> 1;
    stack.push(Int32Array.from(sorted.slice(0, h)), Int32Array.from(sorted.slice(h)));
  }
  const names = Object.keys(g.attributes), remap = idx ? new Int32Array(pos.count).fill(-1) : null;
  return leaves.map((tris) => {
    const geo = new THREE.BufferGeometry();
    if (idx) {
      // the corners the piece's triangles use, numbered afresh
      const used = [], index = new Uint32Array(tris.length * 3);
      tris.forEach((t, i) => { for (let k = 0; k < 3; k++) { const v = corner(t, k); if (remap[v] < 0) { remap[v] = used.length; used.push(v); } index[i * 3 + k] = remap[v]; } });
      geo.setIndex(new THREE.BufferAttribute(used.length <= 65535 ? Uint16Array.from(index) : index, 1));
      for (const name of names) {
        const a = g.attributes[name], s = a.itemSize, arr = new a.array.constructor(used.length * s);
        used.forEach((v, i) => { for (let c = 0; c < s; c++) arr[i * s + c] = a.array[v * s + c]; });
        geo.setAttribute(name, new THREE.BufferAttribute(arr, s, a.normalized));
      }
      for (const v of used) remap[v] = -1;
    } else {
      for (const name of names) {
        const a = g.attributes[name], s = a.itemSize, arr = new a.array.constructor(tris.length * 3 * s);
        tris.forEach((t, i) => arr.set(a.array.subarray(t * 3 * s, t * 3 * s + 3 * s), i * 3 * s));
        geo.setAttribute(name, new THREE.BufferAttribute(arr, s, a.normalized));
      }
    }
    geo.computeBoundingBox(); geo.computeBoundingSphere();
    return new THREE.Mesh(geo, o.material);
  });
}
