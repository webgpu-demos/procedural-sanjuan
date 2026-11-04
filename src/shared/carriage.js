// The carriageways a car drives, kept clear of paving. The tile compiler (tools/pipeline/roadsplit.mjs) splits each road
// outline into carriageway (the centreline buffered to the width its lanes need) and sidewalk (the rest); where the
// outline had a hole (a median OSM draws, sometimes on across the junction it meets), and the width it measured beside
// one was small, the buffer came out narrow, and the median's paving ran on across the other road: at Hato Rey the
// medians of Roosevelt crossed Ponce de León's four lanes, and the cars drove over them (the simulated cars keep to
// the centrelines, the lanes either side). Each tile is built with the paving within a carriageway of a road taken
// out (sidewalks, islands, plazas: buildTile, src/world/meshing.js); what is under it is the road's own asphalt.
//
// Pure functions: the segments from roads.json on the main thread, the lookup in the tile workers.

// Width of the carriageway a road needs (as roadsplit.mjs carriageWidth: OSM's width where mapped, else its lanes,
// and a parking strip on a single-lane street).
const LANE = 3.0;
export function carriageWidth(e) {
  if (e.width >= 3 && e.width <= 30) return e.width;
  return e.lanes >= 2 ? e.lanes * LANE + 1 : e.oneway ? 4.2 : 5;
}

// roads.json -> [x0, z0, x1, z1, half width, ...] of every surface road's centreline (the roads roadsplit buffers: not
// a bridge's deck, a tunnel or an expressway; nor an unnamed service way), a little narrower than its carriageway (0.3 m each side: what the
// compiler buffered is never narrower where it had room for a sidewalk)
export function carriageSegs(roads) {
  const out = [];
  for (const e of roads.edges) {
    if ((e.bridge && !e.span) || e.tunnel || e.highway.startsWith('motorway')) continue;
    if (e.highway === 'service' && !e.name) continue; // (a driveway, a car park's lane: no simulated car takes it, and it crosses plazas)
    const h = carriageWidth(e) / 2 - 0.3, p = e.pts;
    if (h <= 0.5) continue;
    for (let k = 3; k < p.length; k += 3) out.push(p[k - 3], p[k - 1], p[k], p[k + 2], h);
  }
  return Float32Array.from(out);
}

const cross = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
function clip(poly, f) {
  const out = [];
  let a = poly[poly.length - 1], fa = f(a);
  for (const b of poly) {
    const fb = f(b);
    if ((fa >= 0) !== (fb >= 0)) { const t = fa / (fa - fb); out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]); }
    if (fb >= 0) out.push(b);
    a = b; fa = fb;
  }
  return out;
}
const area2 = (p) => { let s = 0; for (let i = 0; i < p.length; i++) { const a = p[i], b = p[(i + 1) % p.length]; s += a[0] * b[1] - b[0] * a[1]; } return s; };
// The pieces of the convex polygon `poly` outside the convex polygon `cut` (its corners in the order cross() > 0).
function subtract(poly, cut) {
  const out = [];
  let rest = poly;
  for (let k = 0; k < cut.length && rest.length >= 3; k++) {
    const a = cut[k], b = cut[(k + 1) % cut.length], side = (p) => cross(a, b, p);
    const outside = clip(rest, (p) => -side(p));
    if (outside.length >= 3 && Math.abs(area2(outside)) > 1e-6) out.push(outside);
    rest = clip(rest, side);
  }
  return out;
}

// segs (carriageSegs) -> { inside(x, z): within a carriageway; cut(poly): the pieces of a convex polygon [[x, z], ...]
// outside every carriageway, or null when none touches it }. Each segment is a box its half width either side, run on
// past its ends by as much (the joints of a bend, and a junction's corner, covered).
export function carriageLookup(segs, cell = 16) {
  const grid = new Map();
  for (let i = 0; i < segs.length; i += 5) {
    const x0 = segs[i], z0 = segs[i + 1], x1 = segs[i + 2], z1 = segs[i + 3], h = segs[i + 4], len = Math.hypot(x1 - x0, z1 - z0);
    if (len < 0.05) continue;
    const ux = (x1 - x0) / len, uz = (z1 - z0) / len, nx = -uz * h, nz = ux * h, ax = x0 - ux * h, az = z0 - uz * h, bx = x1 + ux * h, bz = z1 + uz * h;
    let box = [[ax - nx, az - nz], [bx - nx, bz - nz], [bx + nx, bz + nz], [ax + nx, az + nz]];
    if (cross(box[0], box[1], box[2]) < 0) box = box.reverse(); // (corners counter-clockwise: cross() > 0)
    const bb = [Math.min(ax, bx) - h, Math.min(az, bz) - h, Math.max(ax, bx) + h, Math.max(az, bz) + h];
    const item = { box, bb };
    for (let gx = Math.floor(bb[0] / cell); gx <= Math.floor(bb[2] / cell); gx++)
      for (let gz = Math.floor(bb[1] / cell); gz <= Math.floor(bb[3] / cell); gz++) {
        const k = gx * 65536 + gz; let list = grid.get(k); if (!list) grid.set(k, (list = [])); list.push(item);
      }
  }
  const inBox = (b, x, z) => { for (let k = 0; k < 4; k++) if (cross(b[k], b[(k + 1) % 4], [x, z]) < 0) return false; return true; };
  return {
    inside(x, z) {
      for (const it of grid.get(Math.floor(x / cell) * 65536 + Math.floor(z / cell)) ?? []) {
        if (x < it.bb[0] || x > it.bb[2] || z < it.bb[1] || z > it.bb[3]) continue;
        if (inBox(it.box, x, z)) return true;
      }
      return false;
    },
    cut(poly) {
      let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
      for (const [x, z] of poly) { x0 = Math.min(x0, x); z0 = Math.min(z0, z); x1 = Math.max(x1, x); z1 = Math.max(z1, z); }
      let pieces = null;
      const seen = new Set();
      for (let gx = Math.floor(x0 / cell); gx <= Math.floor(x1 / cell); gx++)
        for (let gz = Math.floor(z0 / cell); gz <= Math.floor(z1 / cell); gz++)
          for (const it of grid.get(gx * 65536 + gz) ?? []) {
            if (seen.has(it) || it.bb[0] > x1 || it.bb[2] < x0 || it.bb[1] > z1 || it.bb[3] < z0) continue;
            seen.add(it);
            // (a box wholly beside it, past one of its edges: nothing to cut, and the piece left whole)
            const b = it.box;
            let apart = false;
            for (let k = 0; k < 4 && !apart; k++) { apart = true; for (const piece of pieces ?? [poly]) for (const q of piece) if (cross(b[k], b[(k + 1) % 4], q) > 0) { apart = false; break; } }
            if (apart) continue;
            const next = [];
            for (const piece of pieces ?? [poly]) next.push(...subtract(piece, it.box));
            pieces = next;
            if (!pieces.length) return pieces;
          }
      return pieces;
    },
  };
}
