// Lanes for the main streets OSM gives no count: what fits between the buildings on either side.
//
// An untagged two-way primary or secondary road was given two lanes each way (osm.mjs DEFAULT_LANES): down a street
// of houses that put its outer lanes, the paint's and the simulated traffic's, into the house fronts (Calle Wilson,
// the Carretera Trujillo Alto: AUDIT.md, 2026-11-09). Here, every STEP metres along such a road, the distance from
// its centreline to the first wall on each side, out to REACH; where both sides have one, the street's width wall to
// wall. Four lanes where the median of those widths holds four lanes, the kerb's strip and both sidewalks
// (roadsplit.mjs carriageWidth, roadsurface.mjs SIDEWALK); two where it does not. A mapped width (OSM width=*) is the
// carriageway's own and decides it instead. Where fewer than SAMPLES places have walls on both sides (open land, a
// road along a park) the road keeps its four.
import { PolyIndex } from './landscape.mjs';

const STEP = 10, REACH = 30, RAY = 0.5, SAMPLES = 3;
const LANE = 3.0, STRIP = 1;                       // roadsplit.mjs carriageWidth: lanes * LANE + 1
const SIDEWALK = { primary: 2.6, secondary: 2.3 }; // roadsurface.mjs SIDEWALK

// edges: the graph's ({ ids, highway, oneway, lanes, width, guessed }); pos(id) -> [x, z]; buildings: [{ polygons }]
// in world metres, standing on the ground. Changes `lanes` on the roads it settles; returns what it did.
export function fitLanes(edges, pos, buildings) {
  const walls = new PolyIndex(24);
  for (const b of buildings) for (const rings of b.polygons) walls.add(rings);
  const out = { roads: 0, two: 0, four: 0, open: 0, byWidth: 0, widths: [] };
  for (const e of edges) {
    if (!e.guessed || e.oneway || e.lanes !== 4) continue;
    const hw = e.highway.replace('_link', '');
    if (!(hw in SIDEWALK) || e.highway.endsWith('_link')) continue;
    out.roads++;
    const need4 = 4 * LANE + STRIP + 2 * SIDEWALK[hw];
    if (e.width >= 3 && e.width <= 30) { // (the carriageway as mapped)
      out.byWidth++;
      if (e.width < 4 * LANE + STRIP) { e.lanes = 2; out.two++; } else out.four++;
      continue;
    }
    const widths = [];
    const pts = e.ids.map(pos);
    let carry = 0;
    for (let i = 1; i < pts.length; i++) {
      const [ax, az] = pts[i - 1], [bx, bz] = pts[i], len = Math.hypot(bx - ax, bz - az);
      if (len < 0.01) continue;
      const tx = (bx - ax) / len, tz = (bz - az) / len, nx = -tz, nz = tx;
      for (let s = carry; s < len; s += STEP) {
        const x = ax + tx * s, z = az + tz * s;
        if (walls.has(x, z)) continue; // (a building on the line itself: the road clearing deals with it)
        const reach = (sx, sz) => { for (let d = RAY; d <= REACH; d += RAY) if (walls.has(x + sx * d, z + sz * d)) return d; return null; };
        const l = reach(nx, nz), r = l == null ? null : reach(-nx, -nz);
        if (l != null && r != null) widths.push(l + r);
      }
      carry = (carry - len) % STEP; if (carry < 0) carry += STEP;
    }
    if (widths.length < SAMPLES) { out.open++; out.four++; continue; }
    widths.sort((a, b) => a - b);
    const w = widths[widths.length >> 1];
    out.widths.push(w);
    if (w < need4) { e.lanes = 2; out.two++; } else out.four++;
  }
  return out;
}
