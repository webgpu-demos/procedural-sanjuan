// The sea, from OpenStreetMap's coastline. OSM draws the coastline with the land on its left and the
// water on its right; the ways join end to start into long chains (closed rings for islands).
//
// Each chain is clipped to the area's rectangle, giving pieces that enter and leave through its edge. The
// sea is traced piece by piece: at the end of a piece, the rectangle's edge is followed clockwise (water
// on the right) to the start of the next piece, until the trace closes. Islands inside the rectangle
// become holes in the sea around them.
import fs from 'node:fs';
import { inRings } from './landscape.mjs';

// file: Overpass JSON with natural=coastline ways; bbox { west, south, east, north }; isSea(lon, lat):
// fallback for a rectangle that no coastline crosses. Returns { polygons: [[outer, ...holes]] in lon/lat, stats }.
export function buildSea(file, bbox, isSea) {
  const stats = { ways: 0, chains: 0, islands: 0, pieces: 0, dangling: 0 };
  if (!fs.existsSync(file)) return { polygons: [], stats };
  const { elements } = JSON.parse(fs.readFileSync(file, 'utf8'));
  const nodes = new Map(), ways = [];
  for (const e of elements) {
    if (e.type === 'node') nodes.set(e.id, [e.lon, e.lat]);
    else if (e.type === 'way' && e.tags?.natural === 'coastline') ways.push(e.nodes);
  }
  stats.ways = ways.length;

  // ---- chains: join each way's last node to another's first
  const byStart = new Map();
  for (const w of ways) byStart.set(w[0], w);
  const used = new Set(), chains = [];
  const hasPredecessor = new Set(ways.map((w) => w.at(-1)));
  // start from ways nothing leads into (open chains), then whatever is left (closed rings)
  const order = [...ways.filter((w) => !hasPredecessor.has(w[0])), ...ways];
  for (const w of order) {
    if (used.has(w)) continue;
    used.add(w);
    let chain = [...w];
    for (let next = byStart.get(chain.at(-1)); next && !used.has(next); next = byStart.get(chain.at(-1))) {
      used.add(next);
      chain = chain.concat(next.slice(1));
    }
    chains.push(chain.map((id) => nodes.get(id)).filter(Boolean));
  }
  stats.chains = chains.length;

  const { west, south, east, north } = bbox, W = east - west, H = north - south, P = 2 * (W + H);
  const inside = ([x, y]) => x > west && x < east && y > south && y < north;
  // position along the edge, clockwise from the north-west corner
  const perim = ([x, y]) => {
    const e = 1e-9;
    if (Math.abs(y - north) < e) return x - west;
    if (Math.abs(x - east) < e) return W + (north - y);
    if (Math.abs(y - south) < e) return W + H + (east - x);
    return 2 * W + H + (y - south);
  };
  const corners = [[0, [west, north]], [W, [east, north]], [W + H, [east, south]], [2 * W + H, [west, south]]];
  // Liang-Barsky: the part of segment a-b inside the rectangle as [t0, t1], or null
  const clipSeg = (a, b) => {
    let t0 = 0, t1 = 1;
    const dx = b[0] - a[0], dy = b[1] - a[1];
    for (const [p, q] of [[-dx, a[0] - west], [dx, east - a[0]], [-dy, a[1] - south], [dy, north - a[1]]]) {
      if (p === 0) { if (q < 0) return null; continue; }
      const r = q / p;
      if (p < 0) { if (r > t1) return null; if (r > t0) t0 = r; } else { if (r < t0) return null; if (r < t1) t1 = r; }
    }
    return [t0, t1];
  };
  const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  // a point on the rectangle's edge where a ray from p along (p - q) leaves it (for chains that stop short)
  const toEdge = (p, q) => {
    const dx = p[0] - q[0], dy = p[1] - q[1];
    let best = Infinity;
    if (dx > 0) best = Math.min(best, (east - p[0]) / dx); if (dx < 0) best = Math.min(best, (west - p[0]) / dx);
    if (dy > 0) best = Math.min(best, (north - p[1]) / dy); if (dy < 0) best = Math.min(best, (south - p[1]) / dy);
    return Number.isFinite(best) ? lerp(p, [p[0] + dx, p[1] + dy], best) : null;
  };

  const pieces = [], islands = [];
  for (let chain of chains) {
    if (chain.length < 2) continue;
    const closed = chain.length > 3 && chain[0][0] === chain.at(-1)[0] && chain[0][1] === chain.at(-1)[1];
    if (closed && chain.every(inside)) { islands.push(chain.slice(0, -1)); continue; }
    if (closed) { // start the ring outside the rectangle
      const k = chain.findIndex((p) => !inside(p));
      chain = [...chain.slice(k, -1), ...chain.slice(0, k + 1)];
    } else {
      // a chain that ends inside the rectangle (the data stops there): carry it straight on to the edge
      if (inside(chain[0])) { const e = toEdge(chain[0], chain[1]); if (e) chain.unshift(e); stats.dangling++; }
      if (inside(chain.at(-1))) { const e = toEdge(chain.at(-1), chain.at(-2)); if (e) chain.push(e); stats.dangling++; }
    }
    let cur = null;
    for (let i = 1; i < chain.length; i++) {
      const a = chain[i - 1], b = chain[i], c = clipSeg(a, b);
      if (!c) continue;
      const [t0, t1] = c;
      if (!cur || t0 > 0) cur = { pts: [lerp(a, b, t0)] };
      if (t1 < 1) { cur.pts.push(lerp(a, b, t1)); if (cur.pts.length >= 2) pieces.push(cur); cur = null; }
      else cur.pts.push(b);
    }
  }
  for (const p of pieces) { p.tIn = perim(p.pts[0]); p.tOut = perim(p.pts.at(-1)); }
  stats.pieces = pieces.length; stats.islands = islands.length;

  // ---- trace the sea
  const polygons = [];
  const left = new Set(pieces);
  const ahead = (from, to) => ((to - from) % P + P) % P; // clockwise distance along the edge
  while (left.size) {
    const first = left.values().next().value, ring = [];
    for (let cur = first, guard = 0; guard <= pieces.length; guard++) {
      left.delete(cur);
      ring.push(...cur.pts);
      let next = null, best = Infinity;
      for (const q of pieces) { const d = ahead(cur.tOut, q.tIn); if (d < best && (left.has(q) || q === first)) { best = d; next = q; } }
      if (!next) break;
      for (const [t, xy] of [...corners].sort((a, b) => ahead(cur.tOut, a[0]) - ahead(cur.tOut, b[0]))) if (ahead(cur.tOut, t) < best) ring.push(xy);
      if (next === first) break;
      cur = next;
    }
    if (ring.length >= 3) polygons.push([ring]);
  }
  if (!pieces.length && (islands.length || isSea((west + east) / 2, (south + north) / 2)))
    polygons.push([[[west, north], [east, north], [east, south], [west, south]]]);
  // islands: holes in the sea around them
  for (const isl of islands) {
    const [x, y] = isl[0];
    const sea = polygons.find((p) => inRings(x, y, [p[0]]));
    if (sea) sea.push(isl);
  }
  return { polygons, stats };
}
