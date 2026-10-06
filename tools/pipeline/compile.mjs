// City compiler: raw OSM / FEMA / terrain data -> streaming tiles in public/tiles/<area>/.
//   manifest.json   area, origin, bounds, tile list, terrain grid description, sea level, attribution
//   terrain.bin     Float32 height grid (metres above sea level), row-major, rows run north -> south (+z)
//   t_<x>_<z>.bin   per 256 m tile: buildings, ground surfaces (roads, paint, parks, beaches, the sea), props
//                   (trees, poles, lights, signals) and wires (format: src/shared/tileformat.js)
//   roads.json      drivable road graph from OSM (junction nodes + polyline edges; y = road level, above the
//                   ground on bridges and elevated expressways)
//   structures.json footbridges, station platforms and canopies (tools/pipeline/extras.mjs)
//   rails.json      surface and elevated railway lines from OSM, with their height profile (y = track bed)
//   k_<x>_<z>.bin   the buildings alone, 4 x 4 tiles to a file, for the distant blocks of a streamed area
//   x_<x>_<z>.bin   a tile's landmark models (landmarks.mjs), where it has any
//   far.bin         the coarse terrain of the area and the island around it, for the distant ground
// Usage: node tools/pipeline/compile.mjs [--area=viejosanjuan] [--no-ads]   (--no-ads: leave out the invented billboards, screens and banners)
import fs from 'node:fs';
import path from 'node:path';
import polygonClipping from 'polygon-clipping';
import { resolveArea, ROOT } from './config.mjs';
import { makeProjection, TILE, tileOf, tileKey } from '../../src/shared/geo.js';
import { encodeTile, AREA, BFLAG, PROP, VERSION, SPORT, MATERIAL } from '../../src/shared/tileformat.js';
import { readOsm, buildRoadGraph, buildRailways } from './osm.mjs';
import { buildHeightGrid, sampleGrid, demSource, FAR_DEM } from './terrain.mjs';
import { PolyIndex, readLand, clipRing, placeProps, inRings } from './landscape.mjs';
import { buildMarkings } from './markings.mjs';
import { splitOutlineRoads } from './roadsplit.mjs';
import { profileRailways } from './rails.mjs';
import { readPlaces, placeSigns, placeAds } from './signs.mjs';
import { placeFurniture } from './furniture.mjs';
import { readExtra, buildExtras } from './extras.mjs';
import { profileRoads, flyover, BANK } from './roadprofile.mjs';
import { DECK_FLAG, CORRIDOR_MARGIN, projectOnDeck } from '../../src/shared/decks.js';
import { readBuildingSources } from './buildings.mjs';
import { buildSea } from './coast.mjs';
import { buildRoadSurfaces } from './roadsurface.mjs';
import { Tris, fort, wallGaritas, domeOn, lighthouse, cathedral, convention, encodeMesh, simplify } from './landmarks.mjs';

const TERRAIN_STEP_DEFAULT = 5; // metres (an area may set its own: config.mjs)
const SEA = 0;            // the sea surface (m)
const LAND_MIN = 0.3;     // dry land is kept at least this far above it

// Old San Juan's colours: the painted plaster of the colonial city (sRGB)
const COLONIAL = [0xf2c94c, 0xe9a86e, 0x79c2cd, 0x98c49b, 0xe07a5f, 0xc58fa3, 0x4f8fc0, 0xf3e1b0, 0xcf5c55, 0x84c0a6,
  0xf2a65a, 0xb7a3d6, 0x5fb0b0, 0xe8d6a0, 0xec7b5c, 0xa6c6ee, 0xf6d36b, 0xd4876e, 0x8fb8de, 0xe2b04a];

const area = resolveArea();
const TERRAIN_STEP = area.terrain ?? TERRAIN_STEP_DEFAULT;
const proj = makeProjection(...area.origin);
const t0 = Date.now();
const log = (...a) => console.log(((Date.now() - t0) / 1000).toFixed(1).padStart(6) + 's', ...a);

const [minX, maxZ] = proj.project(area.bbox.west, area.bbox.south);
const [maxX, minZ] = proj.project(area.bbox.east, area.bbox.north);
const bounds = { minX, maxX, minZ, maxZ };
const inBounds = (x, z) => x >= minX && x <= maxX && z >= minZ && z <= maxZ;
// The tiles at the edge reach past the bounding box to the tile grid: the terrain and the sea fill them
// out to there (the buildings, roads and props stop at the bounding box).
const extent = { minX: Math.floor(minX / TILE) * TILE, maxX: Math.ceil(maxX / TILE) * TILE, minZ: Math.floor(minZ / TILE) * TILE, maxZ: Math.ceil(maxZ / TILE) * TILE };
const [extW, extS] = proj.unproject(extent.minX, extent.maxZ), [extE, extN] = proj.unproject(extent.maxX, extent.minZ);
log(`area ${area.id}: ${(maxX - minX).toFixed(0)} x ${(maxZ - minZ).toFixed(0)} m around [${area.origin}]`);

// ---------------------------------------------------------------- geometry helpers
const r2 = (v) => Math.round(v * 100) / 100;
// Signed area seen from above, positive = counter-clockwise (x east, -z north).
const areaEN = (ring) => {
  let s = 0;
  for (let i = 0, n = ring.length; i < n; i++) {
    const [x1, z1] = ring[i], [x2, z2] = ring[(i + 1) % n];
    s += x2 * z1 - x1 * z2;
  }
  return s / 2;
};

// lon/lat ring -> clean world ring: closing point dropped, near-duplicate and collinear points removed.
function cleanRing(ll) {
  let pts = ll.map(([lon, lat]) => proj.project(lon, lat)).map(([x, z]) => [r2(x), r2(z)]);
  if (pts.length > 1) { const [a, b] = [pts[0], pts.at(-1)]; if (Math.hypot(a[0] - b[0], a[1] - b[1]) < 0.02) pts.pop(); }
  pts = pts.filter((p, i) => { const q = pts[(i + pts.length - 1) % pts.length]; return Math.hypot(p[0] - q[0], p[1] - q[1]) >= 0.02; });
  for (let changed = true; changed && pts.length > 3;) {
    changed = false;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[(i + pts.length - 1) % pts.length], b = pts[i], c = pts[(i + 1) % pts.length];
      const cross = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
      const len = Math.hypot(c[0] - a[0], c[1] - a[1]);
      if (Math.abs(cross) / Math.max(len, 1e-6) < 0.01) { pts.splice(i, 1); changed = true; break; }
    }
  }
  return pts.length >= 3 ? pts : null;
}

// [[outer, ...holes]] in lon/lat -> world polygons with outer CCW and holes CW; drops slivers.
function cleanPolygons(polys, minArea = 0.5) {
  const out = [];
  for (const rings of polys) {
    const outer = cleanRing(rings[0]);
    if (!outer || Math.abs(areaEN(outer)) < minArea) continue;
    if (areaEN(outer) < 0) outer.reverse();
    const holes = [];
    for (const h of rings.slice(1)) {
      const ring = cleanRing(h);
      if (!ring || Math.abs(areaEN(ring)) < 0.1) continue;
      if (areaEN(ring) > 0) ring.reverse();
      holes.push(ring);
    }
    out.push([outer, ...holes]);
  }
  return out;
}

const centroidOf = (polys) => {
  let sx = 0, sz = 0, sa = 0;
  for (const [outer] of polys) {
    const a = Math.abs(areaEN(outer));
    const cx = outer.reduce((s, p) => s + p[0], 0) / outer.length, cz = outer.reduce((s, p) => s + p[1], 0) / outer.length;
    sx += cx * a; sz += cz * a; sa += a;
  }
  return [sx / sa, sz / sa];
};
const close = (r) => [...r, r[0]];
const fromClip = (multi) => multi.map((poly) => poly.map((r) => r.slice(0, -1)).filter((r) => r.length >= 3)).filter((p) => p.length && Math.abs(areaEN(p[0])) >= 1)
  .map((rings) => rings.map((r, i) => ((areaEN(r) > 0) === (i === 0) ? r : [...r].reverse())));

// Calls fn(cell index) for every grid point inside the polygons (even-odd over all their rings).
function rasterize(grid, polygons, fn) {
  for (const rings of polygons) {
    let z0 = Infinity, z1 = -Infinity;
    for (const [, z] of rings[0]) { z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
    const j0 = Math.max(0, Math.ceil((z0 - grid.z0) / grid.step)), j1 = Math.min(grid.h - 1, Math.floor((z1 - grid.z0) / grid.step));
    for (let j = j0; j <= j1; j++) {
      const z = grid.z0 + j * grid.step, xs = [];
      for (const r of rings) for (let i = 0, n = r.length; i < n; i++) {
        const [xa, za] = r[i], [xb, zb] = r[(i + 1) % n];
        if ((za <= z) !== (zb <= z)) xs.push(xa + ((z - za) / (zb - za)) * (xb - xa));
      }
      xs.sort((a, b) => a - b);
      for (let k = 0; k + 1 < xs.length; k += 2)
        for (let i = Math.max(0, Math.ceil((xs[k] - grid.x0) / grid.step)); i <= Math.min(grid.w - 1, Math.floor((xs[k + 1] - grid.x0) / grid.step)); i++) fn(j * grid.w + i);
    }
  }
}

// ---------------------------------------------------------------- terrain, the sea and the water
const grid = buildHeightGrid(path.join(area.rawDir, 'dem'), proj, extent, TERRAIN_STEP);
const rawGround = (x, z) => sampleGrid(grid, x, z);
const seaRaw = buildSea(path.join(area.rawDir, 'osm_coast.json'), { west: extW, south: extS, east: extE, north: extN }, (lon, lat) => rawGround(...proj.project(lon, lat)) < -3);
const seaPolys = cleanPolygons(seaRaw.polygons, 20);
log(`coastline (OSM): ${seaRaw.stats.ways} ways in ${seaRaw.stats.chains} chains, ${seaRaw.stats.pieces} cross the area, ${seaRaw.stats.islands} islands` +
  ` -> ${seaPolys.length} sea polygons${seaRaw.stats.dangling ? ` (${seaRaw.stats.dangling} chain ends carried to the edge)` : ''}`);
const landRaw = readLand(path.join(area.rawDir, 'osm_land.json'));
const xz = (ll) => ll.map(([lon, lat]) => proj.project(lon, lat));
const seaIndex = new PolyIndex(64);
for (const p of seaPolys) seaIndex.add(p);
const land = landRaw.areas.map(({ kind, ring, code }) => {
  const r = xz(ring).slice(0, -1); // drop the closing point
  if (areaEN(r) < 0) r.reverse();
  return { kind, ring: r, code: kind === AREA.PITCH ? code : 0 };
}).filter((a) => a.ring.length >= 3 && Math.abs(areaEN(a.ring)) > 4)
  // (water mapped inside the sea, a bay or a harbour basin, is already sea)
  .filter((a) => !(a.kind === AREA.WATER && seaIndex.has(...a.ring.reduce((s, p) => [s[0] + p[0] / a.ring.length, s[1] + p[1] / a.ring.length], [0, 0]))));
// The sea surface is flat at SEA (the tiles carry bathymetry offshore, and the 10 m DEM blurs the shore);
// lagoons and ponds lie flat at their lowest shore; dry land stays above the sea.
const wetCell = new Uint8Array(grid.data.length);
rasterize(grid, seaPolys, (i) => { wetCell[i] = 1; });
for (let i = 0; i < grid.data.length; i++) grid.data[i] = wetCell[i] ? SEA - 0.08 : Math.max(grid.data[i], SEA + LAND_MIN);
let lagoons = 0;
for (const a of land) {
  if (a.kind !== AREA.WATER) continue;
  let shore = Infinity;
  for (let i = 0; i < a.ring.length; i++) shore = Math.min(shore, rawGround(...a.ring[i]));
  shore = Math.max(SEA, Math.min(shore, ...a.ring.map(([x, z]) => sampleGrid(grid, x, z))));
  rasterize(grid, [[a.ring]], (i) => { grid.data[i] = Math.min(grid.data[i], shore - 0.08); wetCell[i] = 2; });
  lagoons++;
}
let gMin = Infinity, gMax = -Infinity;
for (const v of grid.data) { gMin = Math.min(gMin, v); gMax = Math.max(gMax, v); }
log(`terrain ${grid.w} x ${grid.h} @ ${TERRAIN_STEP} m, ${gMin.toFixed(1)}..${gMax.toFixed(1)} m (${grid.stats.holes} filled; ` +
  `${wetCell.reduce((s, v) => s + (v === 1), 0)} sea cells, ${lagoons} lagoons and ponds levelled)`);
const ground = (x, z) => sampleGrid(grid, x, z);

// The surroundings out to the horizon, for the client's distant landscape: a coarse grid (FAR_STEP metres,
// lined up with the tile grid) reaching FAR metres beyond the extent. The sea is pushed below the sea surface.
const FAR_STEP = 128, FAR = 96 * FAR_STEP;
let far = null;
if (fs.existsSync(path.join(area.rawDir, 'dem', FAR_DEM.id))) {
  const sample = demSource(path.join(area.rawDir, 'dem'), FAR_DEM);
  const w = (extent.maxX - extent.minX + 2 * FAR) / FAR_STEP + 1, h = (extent.maxZ - extent.minZ + 2 * FAR) / FAR_STEP + 1;
  const data = new Float32Array(w * h), x0 = extent.minX - FAR, z0 = extent.minZ - FAR;
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    const x = x0 + i * FAR_STEP, z = z0 + j * FAR_STEP;
    if (x >= extent.minX && x <= extent.maxX && z >= extent.minZ && z <= extent.maxZ) {
      // inside the area: its own terrain; the sea sinks below the sea plane, lagoons and rivers keep their level
      const gi = Math.min(grid.w - 1, Math.round((x - grid.x0) / grid.step)), gj = Math.min(grid.h - 1, Math.round((z - grid.z0) / grid.step));
      data[j * w + i] = wetCell[gj * grid.w + gi] === 1 ? SEA - 3 : sampleGrid(grid, x, z);
      continue;
    }
    const v = sample(...proj.unproject(x, z));
    data[j * w + i] = !(v > 0.1) ? SEA - 3 : v;
  }
  far = { file: 'far.bin', x0, z0, step: FAR_STEP, w, h, data };
  log(`surroundings: ${w} x ${h} @ ${FAR_STEP} m, ${(data.filter((v) => v > SEA).length / data.length * 100).toFixed(0)}% land`);
}
const wet = (x, z) => seaIndex.has(x, z) || wetCell[Math.round((z - grid.z0) / grid.step) * grid.w + Math.round((x - grid.x0) / grid.step)] > 0;

// ---------------------------------------------------------------- buildings
const tiles = new Map();
const tileFor = (x, z) => {
  const [tx, tz] = tileOf(x, z), k = tileKey(tx, tz);
  if (!tiles.has(k)) tiles.set(k, { tx, tz, buildings: [], areas: [], props: [], wires: [], walls: [], signs: [], blockOnly: [] });
  return tiles.get(k);
};
// Point-in-polygon indexes used to place paint, trees and street furniture.
const idx = { building: new PolyIndex(), road: new PolyIndex(), carriageway: new PolyIndex(), sidewalk: new PolyIndex(), water: new PolyIndex() };

const src = readBuildingSources({ osmFile: path.join(area.rawDir, 'osm_buildings.json'), femaFile: path.join(area.rawDir, 'fema_structures.json'), proj, heritage: area.heritage, colonial: COLONIAL });
const bstats = { dropped: 0, wet: 0, heights: [], usage: {}, slope: [] };
const allBuildings = [];
for (const b of src.buildings) {
  const polys = cleanPolygons(b.polygons);
  if (!polys.length || !(b.height > 0.5)) { bstats.dropped++; continue; }
  const [cx, cz] = centroidOf(polys);
  if (!inBounds(cx, cz)) { bstats.dropped++; continue; }
  if (seaIndex.has(cx, cz) && b.id.startsWith('f')) { bstats.wet++; continue; } // (a pier shed, a ship at its berth)
  // The walls stand on the lowest ground under the outline (they run a few metres below it anyway, see
  // meshing.js); the roof stays where the height puts it above the middle of the building.
  const gc = ground(cx, cz), lowest = Math.min(gc, ...polys[0][0].map(([x, z]) => ground(x, z)));
  const base = Math.max(lowest, gc - 6) + b.minHeight, height = b.height + (gc - Math.max(lowest, gc - 6));
  bstats.slope.push(gc - lowest);
  bstats.heights.push(b.height);
  bstats.usage[b.usage] = (bstats.usage[b.usage] ?? 0) + 1;
  const building = { id: b.id, usage: b.usage, storeys: b.storeys, flags: b.masonry ? BFLAG.MASONRY : 0, base: r2(base), height: r2(height), measuredHeight: b.measured ? r2(height) : -1, polygons: polys, surfaces: [], hint: b.hint, cx, cz, roof: b.roof, name: b.name };
  allBuildings.push(building);
}
const pct = (arr, p) => { const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? 0; };
const s0 = src.stats;
log(`buildings: ${allBuildings.length} kept of ${s0.osm} OSM outlines (${s0.parts} building parts standing for ${s0.outlinesWithParts} outlines) and ${s0.femaOnly} FEMA-only; ${bstats.dropped} dropped, ${bstats.wet} in the sea`);
log(`  heights from: OSM height ${s0.fromHeight}, OSM floors ${s0.fromLevels}, FEMA LiDAR ${s0.fromFema}, default ${s0.fromDefault} (FEMA has ${s0.femaTotal} outlines here)`);
log(`  height median ${pct(bstats.heights, 0.5).toFixed(1)} m, p95 ${pct(bstats.heights, 0.95).toFixed(1)} m, max ${pct(bstats.heights, 1).toFixed(1)} m; ground drop under outline p95 ${pct(bstats.slope, 0.95).toFixed(1)} m`);
log(`  usage codes: ${Object.entries(bstats.usage).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join(' ')}`);

// ---------------------------------------------------------------- OSM road graph
const osm = readOsm(path.join(area.rawDir, 'osm.json'));
const graph = buildRoadGraph(osm, proj.project, inBounds);
// road level per node: the ground, or above it on bridges and elevated expressways
const { level, spans } = profileRoads(graph.edges, graph.pos, ground, wet);
for (const edge of graph.edges) {
  edge.span = spans.has(edge) ? 1 : 0;  // a street-level bridge: treated as an ordinary road from here on
  edge.flyover = flyover(edge) ? 1 : 0; // carried on its own structure above the streets
}

// ---------------------------------------------------------------- road surfaces
// The streets widened to their right-of-way and the buildings cut out of them (roadsurface.mjs). A FEMA
// outline standing in the middle of a street is a structure over it (a canopy, a bridge), not a building.
const surf = buildRoadSurfaces({ edges: graph.edges, pos: graph.pos, bounds, flyover, buildings: allBuildings,
  removable: (b) => b.id.startsWith('f') });
const keptBuildings = allBuildings.filter((b) => !surf.removed.has(b));
for (const b of keptBuildings) {
  const { cx, cz, id, roof, name, ...rest } = b;
  b.entry = rest; // what the tile holds (landmarks below adjust it)
  tileFor(cx, cz).buildings.push(rest);
  for (const rings of b.polygons) idx.building.add(rings);
}
const outlineOnly = []; // road outlines to split into carriageway and sidewalk
for (const { tx, tz, polygon } of surf.outlines) {
  const polygons = [polygon.map((r) => r.map(([x, z]) => [r2(x), r2(z)]))];
  tiles.get(tileKey(tx, tz)) ?? tileFor((tx + 0.5) * TILE, (tz + 0.5) * TILE);
  tiles.get(tileKey(tx, tz)).areas.push({ kind: AREA.ROAD, code: 0, polygons });
  idx.road.add(polygons[0]);
  outlineOnly.push(polygons[0]);
}
for (const { tx, tz, polygon } of surf.motorway) {
  const polygons = [polygon.map((r) => r.map(([x, z]) => [r2(x), r2(z)]))];
  tileFor((tx + 0.5) * TILE, (tz + 0.5) * TILE).areas.push({ kind: AREA.CARRIAGEWAY, code: 0, polygons });
  idx.road.add(polygons[0]); idx.carriageway.add(polygons[0]);
}
log(`road surfaces: ${surf.stats.edges} streets and ${surf.stats.motorwayEdges} expressway edges -> ${surf.stats.outlines} outline pieces, ` +
  `${surf.stats.motorway} expressway pieces over ${surf.stats.tiles} tiles${surf.stats.failed + surf.stats.skipped ? ` (${surf.stats.failed} tiles failed, ${surf.stats.skipped} pieces left out)` : ''}; ${surf.removed.size} FEMA structures in the street dropped`);

const roadsOut = {
  nodes: graph.nodes.map(({ id, p }) => [r2(p[0]), r2(level.get(id) ?? ground(p[0], p[1])), r2(p[1])]),
  edges: graph.edges.map((edge) => {
    const { ids, way, spanLength, spanEnds, ...e } = edge;
    return { ...e, way, pts: ids.flatMap((id) => { const [x, z] = graph.pos(id); return [r2(x), r2(level.get(id)), r2(z)]; }) };
  }),
};
const byClass = {};
let km = 0;
for (const e of graph.edges) {
  let len = 0;
  for (let i = 1; i < e.ids.length; i++) { const p = graph.pos(e.ids[i - 1]), q = graph.pos(e.ids[i]); len += Math.hypot(q[0] - p[0], q[1] - p[1]); }
  byClass[e.highway] = (byClass[e.highway] ?? 0) + len / 1000; km += len / 1000;
}
log(`road graph (OSM): ${roadsOut.nodes.length} nodes, ${roadsOut.edges.length} edges, ${km.toFixed(1)} km`);
log(`  ${Object.entries(byClass).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v.toFixed(1)}`).join(', ')}`);
log(`  bridges ${roadsOut.edges.filter((e) => e.bridge).length} (${spans.size} street-level spans), tunnels ${roadsOut.edges.filter((e) => e.tunnel).length}, oneway ${roadsOut.edges.filter((e) => e.oneway).length}`);
// The deck line runs BANK metres past each end, level, to cover the ground that slumps towards the dip.
const decks = roadsOut.edges.filter((e) => e.span).map((e) => {
  const p = e.pts, n = p.length;
  const out = (i, j) => { // point BANK metres beyond point i, away from point j
    const len = Math.hypot(p[i] - p[j], p[i + 2] - p[j + 2]) || 1;
    return [r2(p[i] + ((p[i] - p[j]) / len) * BANK), p[i + 1], r2(p[i + 2] + ((p[i + 2] - p[j + 2]) / len) * BANK)];
  };
  return { pts: [...out(0, 3), ...p, ...out(n - 3, n - 6)], half: Math.max(1, e.lanes) * 1.65 + CORRIDOR_MARGIN };
});
// Under a road bridge the terrain model shows the bridge, not the track bed below it.
const underBridge = (x, z) => decks.some((d) => { const p = projectOnDeck(d, x, z); return p.inside && p.dist <= d.half - CORRIDOR_MARGIN + 6; });
const rails = profileRailways(buildRailways(osm, proj.project, inBounds), ground, inBounds, underBridge);
// Record where each track crosses a building outline (a station built over the line) so the client can
// put a tunnel mouth there: [x, y, z, dirX, dirZ], pointing in.
let portals = 0;
for (const line of rails) {
  const p = line.pts; // (line.portals already holds the tunnel mouths)
  for (let i = 3; i < p.length; i += 3) {
    const len = Math.hypot(p[i] - p[i - 3], p[i + 2] - p[i - 1]);
    if (len < 0.01) continue;
    const at = (d) => [p[i - 3] + ((p[i] - p[i - 3]) * d) / len, p[i - 2] + ((p[i + 1] - p[i - 2]) * d) / len, p[i - 1] + ((p[i + 2] - p[i - 1]) * d) / len];
    let was = idx.building.has(p[i - 3], p[i - 1]);
    for (let d = 0.5; d <= len; d += 0.5) {
      const q = at(Math.min(d, len)), now = idx.building.has(q[0], q[2]);
      if (now !== was) {
        const s = now ? 1 : -1; // direction pointing into the building
        line.portals.push([r2(q[0]), r2(q[1]), r2(q[2]), r2((s * (p[i] - p[i - 3])) / len), r2((s * (p[i + 2] - p[i - 1])) / len)]);
        portals++; was = now;
      }
    }
  }
}
log(`railways (OSM): ${rails.length} lines (${rails.filter((r) => r.bridge).length} elevated sections), ${portals} portals where tracks pass through buildings`);

// The road outlines get their carriageway from the OSM centrelines; the rest is sidewalk.
const extraRaw = readExtra(path.join(area.rawDir, 'osm_extra.json'), proj.project);
// pedestrian streets and paths in the open, as lines (stairs, bridges and passages are not streets)
const walkLines = extraRaw.ways.filter((w) => ['pedestrian', 'footway', 'path'].includes(w.tags.highway) && !w.closed && !w.tags.bridge && !w.tags.tunnel
  && w.tags.indoor !== 'yes' && !['sidewalk', 'crossing', 'link'].includes(w.tags.footway)).map((w) => w.pts);
const split = splitOutlineRoads({ outlines: outlineOnly, edges: graph.edges, pos: graph.pos, idxRoad: idx.road, walkLines });
// the streets of the historic district are paved with adoquines (carriageway code 1)
const heritageRing = area.heritage ? [area.heritage.map(([lon, lat]) => proj.project(lon, lat))] : null;
let cobbled = 0;
for (const [kind, polys, index] of [[AREA.CARRIAGEWAY, split.carriageway, idx.carriageway], [AREA.SIDEWALK, split.sidewalk, idx.sidewalk]]) {
  for (const rings of polys) {
    const polygon = rings.map((r) => r.map(([x, z]) => [r2(x), r2(z)]));
    index.add(polygon);
    const [cx, cz] = centroidOf([polygon]);
    const code = kind === AREA.CARRIAGEWAY && heritageRing && inRings(cx, cz, heritageRing) ? 1 : 0;
    cobbled += code;
    tileFor(Math.min(Math.max(cx, minX), maxX - 0.01), Math.min(Math.max(cz, minZ), maxZ - 0.01)).areas.push({ kind, code, polygons: [polygon] });
  }
}
log(`road outlines: ${outlineOnly.length} polygons -> ${split.carriageway.length} carriageway, ${split.sidewalk.length} sidewalk pieces` +
  ` (${split.pedestrian} pedestrian streets, ${split.untouched} without any OSM way, ${split.failed} failed to clip); ${cobbled} cobbled`);

// ---------------------------------------------------------------- the sea, land cover, paint, props
// The sea, cut at tile edges like every large area (islands stay holes in it)
let seaPieces = 0;
for (const rings of seaPolys) {
  idx.water.add(rings);
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const [x, z] of rings[0]) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
  const box = (bx0, bz0, bx1, bz1) => [[[bx0, bz0], [bx1, bz0], [bx1, bz1], [bx0, bz1], [bx0, bz0]]];
  const tz0 = Math.floor(Math.max(z0, extent.minZ) / TILE), tz1 = Math.floor(Math.min(z1, extent.maxZ - 0.01) / TILE);
  // a column of tiles at a time first (the whole coastline is clipped once per column, not once per tile)
  for (let tx = Math.floor(Math.max(x0, extent.minX) / TILE); tx <= Math.floor(Math.min(x1, extent.maxX - 0.01) / TILE); tx++) {
    let column;
    try { column = polygonClipping.intersection([rings.map(close)], box(tx * TILE, tz0 * TILE, (tx + 1) * TILE, (tz1 + 1) * TILE)); } catch { continue; }
    if (!column.length) continue;
    for (let tz = tz0; tz <= tz1; tz++) {
      let pieces;
      try { pieces = fromClip(polygonClipping.intersection(column, box(tx * TILE, tz * TILE, (tx + 1) * TILE, (tz + 1) * TILE))); } catch { continue; }
      for (const p of pieces) { tileFor((tx + 0.5) * TILE, (tz + 0.5) * TILE).areas.push({ kind: AREA.WATER, code: 1, polygons: [p.map((r) => r.map(([x, z]) => [r2(x), r2(z)]))] }); seaPieces++; }
    }
  }
}
log(`sea: ${seaPieces} pieces`);
for (const a of land) if (a.kind === AREA.WATER) idx.water.add([a.ring]);
// Large areas (a park can span a kilometre) are cut at tile edges so they stream with their tile.
const lstats = {};
const pushClipped = (kind, ring, code = 0) => {
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const [x, z] of ring) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
  for (let tx = Math.floor(Math.max(x0, minX) / TILE); tx <= Math.floor(Math.min(x1, maxX) / TILE); tx++)
    for (let tz = Math.floor(Math.max(z0, minZ) / TILE); tz <= Math.floor(Math.min(z1, maxZ) / TILE); tz++) {
      const piece = clipRing(ring, tx * TILE, tz * TILE, (tx + 1) * TILE, (tz + 1) * TILE);
      if (!piece || Math.abs(areaEN(piece)) < 1) continue;
      tileFor((tx + 0.5) * TILE, (tz + 0.5) * TILE).areas.push({ kind, code, polygons: [[piece.map(([x, z]) => [r2(x), r2(z)])]] });
    }
};
const courtLines = [];
for (const { kind, ring, code } of land) {
  lstats[kind] = (lstats[kind] ?? 0) + 1;
  pushClipped(kind, ring, code);
  // a tennis court gets its lines: the outline, the net and the service boxes, fitted to the pitch
  if (kind === AREA.PITCH && code === SPORT.TENNIS) {
    let best = null;
    for (let i = 0; i < ring.length; i++) {
      const [ax, az] = ring[i], [bx, bz] = ring[(i + 1) % ring.length], len = Math.hypot(bx - ax, bz - az);
      if (!best || len > best.len) best = { len, dx: (bx - ax) / (len || 1), dz: (bz - az) / (len || 1) };
    }
    const cx = ring.reduce((s, p) => s + p[0], 0) / ring.length, cz = ring.reduce((s, p) => s + p[1], 0) / ring.length;
    const { dx, dz } = best, at = (u, v) => [cx + dx * u - dz * v, cz + dz * u + dx * v];
    const line = (u0, v0, u1, v1) => { const w = 0.05, along = Math.abs(u1 - u0) > Math.abs(v1 - v0); courtLines.push(along ? [at(u0, v0 - w), at(u1, v0 - w), at(u1, v0 + w), at(u0, v0 + w)] : [at(u0 - w, v0), at(u0 + w, v0), at(u0 + w, v1), at(u0 - w, v1)]); };
    const L = 11.885, W = 5.485, S = 4.115; // half length, half width (doubles), half width (singles)
    if ([at(-L, -W), at(L, -W), at(L, W), at(-L, W)].every(([x, z]) => inRings(x, z, [ring]))) { // only where a full court fits
      for (const v of [-W, -S, S, W]) line(-L, v, L, v);
      for (const u of [-L, -6.4, 0, 6.4, L]) line(u, Math.abs(u) === 6.4 ? -S : -W, u, Math.abs(u) === 6.4 ? S : W);
      line(-6.4, 0, 6.4, 0);
    }
  }
}
const kindName = Object.fromEntries(Object.entries(AREA).map(([k, v]) => [v, k.toLowerCase()]));
log(`land cover (OSM): ${Object.entries(lstats).map(([k, v]) => `${kindName[k]} ${v}`).join(', ')}`);

const worldLand = {
  stops: extraRaw.points.filter((p) => p.tags.highway === 'stop').map((p) => p.id),
  crossings: landRaw.crossings.map(xz), signals: landRaw.signals,
  crossingNodes: landRaw.crossingNodes,
};
const paint = buildMarkings({ edges: graph.edges, pos: graph.pos, idx, land: worldLand, inBounds });
for (const m of paint.marks) {
  const ring = m.ring.map(([x, z]) => [r2(x), r2(z)]);
  if (areaEN(ring) < 0) ring.reverse();
  const cx = ring.reduce((s, p) => s + p[0], 0) / ring.length, cz = ring.reduce((s, p) => s + p[1], 0) / ring.length;
  if (inBounds(cx, cz)) tileFor(cx, cz).areas.push({ kind: m.kind, code: 0, polygons: [[ring]] });
}
// Street-level bridges. Every road polygon touching a bridge's corridor is tied to that deck (the client
// holds it at deck level between the banks), and the edges of those polygons that face open air over the
// dip get a parapet.
const GROUND_KINDS = new Set([AREA.PARK, AREA.WOOD, AREA.WATER, AREA.PITCH, AREA.BEACH]);
let deckAreas = 0, deckWalls = 0;
// each deck's reach as a box, so the polygons far from every bridge are passed over at once
const deckBox = decks.map((d) => {
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (let i = 0; i < d.pts.length; i += 3) { x0 = Math.min(x0, d.pts[i]); x1 = Math.max(x1, d.pts[i]); z0 = Math.min(z0, d.pts[i + 2]); z1 = Math.max(z1, d.pts[i + 2]); }
  return [x0 - d.half, x1 + d.half, z0 - d.half, z1 + d.half];
});
for (const t of tiles.values()) {
  if (!decks.length) break;
  for (const a of t.areas) {
    if (GROUND_KINDS.has(a.kind)) continue;
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const [x, z] of a.polygons[0][0]) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
    const deck = decks.findIndex((d, k) => { const b = deckBox[k]; return x1 >= b[0] && x0 <= b[1] && z1 >= b[2] && z0 <= b[3]
      && a.polygons.some((rings) => rings[0].some(([x, z]) => { const p = projectOnDeck(d, x, z); return p.inside && p.dist <= d.half; })); });
    if (deck < 0) continue;
    a.code = DECK_FLAG | deck; deckAreas++;
    if (a.kind !== AREA.ROAD) continue;
    // outer rings only: a hole in a road outline is a median or a pier, not the edge of the bridge
    for (const [ring] of a.polygons) for (let i = 0; i < ring.length; i++) {
      const [ax, az] = ring[i], [bx, bz] = ring[(i + 1) % ring.length], len = Math.hypot(bx - ax, bz - az);
      if (len < 0.3) continue;
      const mx = (ax + bx) / 2, mz = (az + bz) / 2, p = projectOnDeck(decks[deck], mx, mz);
      if (!p.inside || p.dist > decks[deck].half || p.y - ground(mx, mz) < 1.5) continue; // off the bridge, or on the bank: no drop here
      // Open air beyond? An edge counts as the side of the bridge only if no road surface follows within 9 m.
      const nx = -(bz - az) / len, nz = (bx - ax) / len;
      if ([0.5, 1.5, 3, 5, 7, 9].some((d) => idx.road.has(mx + nx * d, mz + nz * d)) || len < 1.5) continue;
      t.walls.push([ax, az, bx, bz, deck]); deckWalls++;
    }
  }
}
log(`street bridges: ${decks.length} decks, ${deckAreas} polygons on them, ${deckWalls} parapet segments`);

// ---- everything else OSM maps: paths, stairs, platforms, car parks, barriers, water, gates, small objects
const roadAt = new Map();
for (const e of graph.edges) e.ids.forEach((id, i) => {
  const p = graph.pos(e.ids[Math.max(0, i - 1)]), q = graph.pos(e.ids[Math.min(e.ids.length - 1, i + 1)]), l = Math.hypot(q[0] - p[0], q[1] - p[1]) || 1;
  roadAt.set(id, { dx: (q[0] - p[0]) / l, dz: (q[1] - p[1]) / l });
});
const extras = buildExtras(extraRaw, { idx, ground, inBounds, rails, roadAt });
const centre = (ring) => [ring.reduce((s, p) => s + p[0], 0) / ring.length, ring.reduce((s, p) => s + p[1], 0) / ring.length];
const rounded = (ring) => { const r = ring.map(([x, z]) => [r2(x), r2(z)]); if (areaEN(r) < 0) r.reverse(); return r; };
for (const a of extras.areas) {
  if (a.clip) { pushClipped(a.kind, a.ring, a.code); continue; }
  const [cx, cz] = centre(a.ring);
  if (inBounds(cx, cz)) tileFor(cx, cz).areas.push({ kind: a.kind, code: a.code, polygons: [[rounded(a.ring)]] });
}
for (const m of [...extras.marks, ...courtLines.map((ring) => ({ kind: AREA.MARK_WHITE, ring }))]) {
  const [cx, cz] = centre(m.ring);
  if (inBounds(cx, cz)) tileFor(cx, cz).areas.push({ kind: m.kind, code: 0, polygons: [[rounded(m.ring)]] });
}
for (const b of extras.barriers) tileFor((b[0] + b[2]) / 2, (b[1] + b[3]) / 2).walls.push(b);
log(`OSM extras: ${Object.entries(extras.count).map(([k, v]) => `${k} ${v}`).join(', ')}`);

const placed = placeProps({
  land, trees: landRaw.trees.map(([lon, lat, g]) => [...proj.project(lon, lat), g]), treeRows: landRaw.treeRows.map((row) => Object.assign(xz(row), { genus: row.genus })), vending: xz(landRaw.vending),
  edges: roadsOut.edges, idx, inBounds,
});
const allProps = [...placed.props, ...paint.props, ...extras.props];
for (const p of allProps) tileFor(p.x, p.z).props.push({ ...p, x: r2(p.x), z: r2(p.z) });
for (const w of placed.wires) tileFor(w[0], w[1]).wires.push(w.map(r2));
const propName = Object.fromEntries(Object.entries(PROP).map(([k, v]) => [v, k.toLowerCase()]));
const pcount = {};
for (const p of allProps) pcount[propName[p.kind]] = (pcount[propName[p.kind]] ?? 0) + 1;
log(`paint: ${paint.marks.length} marks; props: ${Object.entries(pcount).map(([k, v]) => `${k} ${v}`).join(', ')}; wires ${placed.wires.length}`);

// ---------------------------------------------------------------- OSM building hints
// building:colour and building:material, where a mapper recorded them, override the generated finish.
const CSS = { white: 0xf2f2f0, black: 0x1c1c1e, grey: 0x9a9a9a, gray: 0x9a9a9a, gainsboro: 0xdcdcdc, yellow: 0xe6cf5a, brown: 0x7a5236, beige: 0xe6dcc0, red: 0xa83232, blue: 0x3a5f95, green: 0x4f7d4f, orange: 0xd98a3a, pink: 0xe6a8b8, silver: 0xc0c0c0, cream: 0xf3ead2 };
const MATERIALS = { concrete: MATERIAL.CONCRETE, cement: MATERIAL.CONCRETE, glass: MATERIAL.GLASS, 'concrete/glass': MATERIAL.GLASS, metal: MATERIAL.METAL, metal_plates: MATERIAL.METAL,
  wood: MATERIAL.METAL, tiles: MATERIAL.TILE, brick: MATERIAL.BRICK, plaster: MATERIAL.PLASTER, stone: MATERIAL.PLASTER, stucco: MATERIAL.PLASTER };
let hinted = 0;
for (const w of extraRaw.ways) {
  const colour = (w.tags['building:colour'] ?? '').split(';')[0].trim().toLowerCase(), material = MATERIALS[w.tags['building:material']];
  if (!w.tags.building || (!colour && !material)) continue;
  const rgb = /^#?[0-9a-f]{6}$/.test(colour) ? Number.parseInt(colour.replace('#', ''), 16) : CSS[colour];
  const hint = ((rgb != null ? 0x80000000 | rgb : 0) | ((material ?? 0) << 24)) >>> 0;
  if (!hint) continue;
  const [cx, cz] = centre(w.pts);
  if (!inBounds(cx, cz)) continue;
  // the building under the middle of the OSM outline (it may be filed under a neighbouring tile)
  const [tx, tz] = [Math.floor(cx / TILE), Math.floor(cz / TILE)];
  search: for (let i = tx - 1; i <= tx + 1; i++) for (let j = tz - 1; j <= tz + 1; j++)
    for (const b of tiles.get(tileKey(i, j))?.buildings ?? []) if (b.polygons.some((rings) => inRings(cx, cz, rings))) { b.hint = hint; hinted++; break search; }
}
log(`OSM building hints: ${hinted} buildings with a mapped colour or material; ${keptBuildings.filter((b) => b.hint).length} with a colour in all`);
// Steel lattice towers: the client draws them as open steelwork.
let lattice = 0;
for (const e of JSON.parse(fs.readFileSync(path.join(area.rawDir, 'osm_poi.json'), 'utf8')).elements) {
  const t = e.tags ?? {}, at = e.center ?? e;
  if (t.man_made !== 'tower' || t['tower:construction'] !== 'lattice' || at.lat == null) continue;
  const [cx, cz] = proj.project(at.lon, at.lat), [tx, tz] = [Math.floor(cx / TILE), Math.floor(cz / TILE)];
  search: for (let i = tx - 1; i <= tx + 1; i++) for (let j = tz - 1; j <= tz + 1; j++)
    for (const b of tiles.get(tileKey(i, j))?.buildings ?? []) if (b.polygons.some((rings) => inRings(cx, cz, rings))) { b.flags |= BFLAG.LATTICE; lattice++; break search; }
}
if (lattice) log(`lattice towers (OSM): ${lattice}`);

// ---------------------------------------------------------------- landmarks
// The old city's landmarks as built models (landmarks.mjs), in the static mesh of the tile they stand in: the
// forts (which take the place of their building there; the distant blocks keep it), the garitas on the city
// walls, El Morro's lighthouse, the domes OSM maps, the cathedral and the Convention Center.
const LANDMARKS = {
  w59744985: { hint: 0xeeebe2 },                                               // the Capitol: white marble
  w255583481: { hint: 0xf1e6cc, model: 'cathedral', facing: [-1, 0] },         // San Juan Bautista, its facade on Calle del Cristo
  w196616058: { hint: 0xebeae4, model: 'convention', facing: [1, -1] },        // the Convention Center, its glass front to the boulevard
};
const lmTiles = new Map();
const lmTris = (x, z) => { const t = tileFor(x, z), k = tileKey(t.tx, t.tz); if (!lmTiles.has(k)) lmTiles.set(k, new Tris()); return lmTiles.get(k); };
const spots = [], fortPieces = [], lmCount = { forts: 0, garitas: 0, domes: 0, lighthouses: 0, models: 0 };
const tileOfEntry = (b) => tileFor(b.cx, b.cz);
const removeEntry = (b, keepForBlocks) => {
  const tile = tileOfEntry(b), i = tile.buildings.indexOf(b.entry);
  if (i < 0) return;
  tile.buildings.splice(i, 1);
  if (keepForBlocks) tile.blockOnly.push(b.entry);
};
// the forts first: the garitas on the walls keep clear of theirs
for (const b of keptBuildings) {
  if (!(b.entry.flags & BFLAG.MASONRY)) continue;
  const f = fort(b.polygons[0][0], ground, lmTris(b.cx, b.cz), spots);
  fortPieces.push(...f.pieces);
  removeEntry(b, true);
  lmCount.forts++;
}
lmCount.garitas = spots.length;
{
  const walls = extraRaw.ways.filter((w) => w.tags.barrier === 'city_wall' || w.tags.historic === 'citywalls').map((w) => w.pts);
  // outside the walls: the sea, or ground falling away
  const outsideWalls = (xo, zo, xi, zi) => wet(xo, zo) || ground(xo, zo) < ground(xi, zi) - 1;
  lmCount.garitas += wallGaritas(walls.filter((pts) => pts.some(([x, z]) => inBounds(x, z))), ground, outsideWalls, lmTris, spots);
}
for (const e of JSON.parse(fs.readFileSync(path.join(area.rawDir, 'osm_poi.json'), 'utf8')).elements) {
  const at = e.center ?? e;
  if (e.tags?.man_made !== 'lighthouse' || at.lat == null) continue;
  const [x, z] = proj.project(at.lon, at.lat);
  if (!inBounds(x, z)) continue;
  // on the terreplein it stands on, if a fort's
  const on = fortPieces.filter((p) => inRings(x, z, [p.ring])).reduce((y, p) => Math.max(y, p.y), -Infinity);
  lighthouse(lmTris(x, z), x, z, on > -Infinity ? on : ground(x, z));
  lmCount.lighthouses++;
}
const enclosing = (b) => { // the buildings round the middle of b
  const [tx, tz] = tileOf(b.cx, b.cz), out = [];
  for (let i = tx - 1; i <= tx + 1; i++) for (let j = tz - 1; j <= tz + 1; j++)
    for (const o of tiles.get(tileKey(i, j))?.buildings ?? []) if (o !== b.entry && o.polygons.some((rings) => inRings(b.cx, b.cz, rings))) out.push(o);
  return out;
};
for (const b of keptBuildings) {
  const entry = b.entry, ring = b.polygons[0][0], spec = LANDMARKS[b.id];
  if (spec?.hint) entry.hint = (0x80000000 | spec.hint | (MATERIAL.PLASTER << 24)) >>> 0;
  if (b.roof === 'dome') {
    // the walls stop a radius below the dome's top, or at the roof of the building it rises from
    const r = Math.sqrt(Math.abs(areaEN(ring)) / Math.PI), top = enclosing(b).reduce((y, o) => Math.max(y, o.base + o.height), -Infinity);
    const y = Math.max(entry.base + entry.height - r, top);
    if (y - entry.base < 0.5 || top >= y - 0.5) removeEntry(b, false); // hidden inside the building it rises from
    else entry.height = r2(y - entry.base);
    domeOn(lmTris(b.cx, b.cz), b.cx, b.cz, y, r);
    lmCount.domes++;
  }
  if (spec?.model === 'cathedral') {
    // the facade: the longest side facing the street it fronts (length seen from that street)
    const s = simplify(ring, 1), [fx, fz] = spec.facing;
    let best = null, score = 0;
    for (let i = 0; i < s.length; i++) {
      const [ax, az] = s[i], [bx, bz] = s[(i + 1) % s.length], len = Math.hypot(bx - ax, bz - az);
      const k = (-(bz - az) * fx + (bx - ax) * fz) / Math.hypot(fx, fz); // facing x length
      if (len > 6 && k > score) { score = k; best = { ax, az, bx, bz }; }
    }
    if (best) { cathedral(lmTris(b.cx, b.cz), ring, best, entry.base + entry.height, ground((best.ax + best.bx) / 2, (best.az + best.bz) / 2)); lmCount.models++; }
    entry.flags |= BFLAG.MASONRY; // plain walls: not an office block's window grid
  } else if (spec?.model === 'convention') {
    convention(lmTris(b.cx, b.cz), ring, entry.base + entry.height, spec.facing, ground(b.cx, b.cz));
    entry.flags |= BFLAG.MASONRY; // plain panels, the glass is the model's
    lmCount.models++;
  }
}
log(`landmarks: ${lmCount.forts} forts, ${lmCount.garitas} garitas, ${lmCount.domes} domes, ${lmCount.lighthouses} lighthouses, ${lmCount.models} other models, `
  + `${[...lmTiles.values()].reduce((n, t) => n + t.count, 0)} triangles in ${lmTiles.size} tiles`);

// ---------------------------------------------------------------- signboards
const places = readPlaces(path.join(area.rawDir, 'osm_poi.json'), proj.project);
const signBuildings = [...tiles.values()].flatMap((t) => t.buildings.map((b) => ({ ring: b.polygons[0][0], base: b.base, height: b.height, usage: b.usage, storeys: b.storeys < 255 ? b.storeys : 0 })));
const signs = placeSigns(places, signBuildings, (x, z) => idx.road.has(x, z));
// Billboards, screens and banners are invented, not mapped data: --no-ads leaves them out.
const ads = process.argv.includes('--no-ads') ? [] : placeAds(signBuildings, [0, 0], area.ads ?? 0.3);
signs.push(...ads);
log(`ads: ${ads.filter((s) => s.style === 3).length} billboards, ${ads.filter((s) => s.style === 4).length} screens, ${ads.filter((s) => s.style === 5).length} rooftop boards, ${ads.filter((s) => s.style === 6).length} banners`);
for (const s of signs) if (inBounds(s.x, s.z)) tileFor(s.x, s.z).signs.push({ ...s, x: r2(s.x), y: r2(s.y), z: r2(s.z), w: r2(s.w), h: r2(s.h) });
log(`signs: ${signs.length} from ${places.length} named places (fascia ${signs.filter((s) => s.style === 0).length}, blade ${signs.filter((s) => s.style === 1).length}, building names ${signs.filter((s) => s.style === 2).length})`);

// ---------------------------------------------------------------- street furniture
const furniture = placeFurniture(path.join(area.rawDir, 'osm_poi.json'), proj.project, idx, ground, inBounds);
for (const p of furniture.props) tileFor(p.x, p.z).props.push({ ...p, x: r2(p.x), z: r2(p.z) });
for (const s of furniture.signs) tileFor(s.x, s.z).signs.push({ ...s, x: r2(s.x), y: r2(s.y), z: r2(s.z), w: r2(s.w), h: r2(s.h) });
log(`street furniture (OSM): ${Object.entries(furniture.count).map(([k, v]) => `${propName[k]} ${v}`).join(', ')}`);

// ---------------------------------------------------------------- write
fs.rmSync(area.outDir, { recursive: true, force: true });
fs.mkdirSync(area.outDir, { recursive: true });
let bytes = 0;
const tileList = [];
for (const t of [...tiles.values()].sort((a, b) => a.tz - b.tz || a.tx - b.tx)) {
  const file = `t_${t.tx}_${t.tz}.bin`, buf = encodeTile(t);
  fs.writeFileSync(path.join(area.outDir, file), buf);
  bytes += buf.length;
  const entry = { x: t.tx, z: t.tz, file, buildings: t.buildings.length, areas: t.areas.length, props: t.props.length, signs: t.signs.length, bytes: buf.length };
  const models = lmTiles.get(tileKey(t.tx, t.tz));
  if (models?.count) {
    const mesh = encodeMesh(models);
    entry.mesh = `x_${t.tx}_${t.tz}.bin`;
    fs.writeFileSync(path.join(area.outDir, entry.mesh), mesh);
    bytes += mesh.length;
  }
  tileList.push(entry);
}
// Distant buildings, for a client that streams: the buildings alone (no ground, paint or props), BLOCK x BLOCK
// tiles to a file, in each tile's own order (meshing.js picks a building's colour by its index in the tile).
//   k_<cx>_<cz>.bin   u32 'BLK1' | u32 nTiles | per tile: i32 tx | i32 tz | u32 byteLength | a tile (tileformat.js) of buildings only
const BLOCK = 4, blockFiles = [];
{
  const chunks = new Map();
  for (const t of tiles.values()) {
    if (!t.buildings.length && !t.blockOnly.length) continue;
    const k = Math.floor(t.tx / BLOCK) + '_' + Math.floor(t.tz / BLOCK);
    if (!chunks.has(k)) chunks.set(k, []);
    chunks.get(k).push(t);
  }
  for (const [k, list] of chunks) {
    const parts = list.map((t) => ({ t, buf: encodeTile({ tx: t.tx, tz: t.tz, buildings: t.buildings.concat(t.blockOnly).map((b) => ({ ...b, surfaces: [] })), areas: [] }) }));
    const out = Buffer.alloc(8 + parts.reduce((n, p) => n + 12 + p.buf.length, 0));
    out.writeUInt32LE(0x314b4c42, 0); out.writeUInt32LE(parts.length, 4);
    let o = 8;
    for (const { t, buf } of parts) { out.writeInt32LE(t.tx, o); out.writeInt32LE(t.tz, o + 4); out.writeUInt32LE(buf.length, o + 8); Buffer.from(buf).copy(out, o + 12); o += 12 + buf.length; }
    const file = `k_${k}.bin`, [cx, cz] = k.split('_').map(Number);
    fs.writeFileSync(path.join(area.outDir, file), out);
    blockFiles.push([cx, cz, file, list.reduce((n, t) => n + t.buildings.length + t.blockOnly.length, 0)]);
    bytes += out.length;
  }
}
fs.writeFileSync(path.join(area.outDir, 'terrain.bin'), Buffer.from(grid.data.buffer));
if (far) fs.writeFileSync(path.join(area.outDir, far.file), Buffer.from(far.data.buffer));
// junction nodes with traffic signals (indices into roads.json nodes), for the traffic simulation
const signalIds = new Set(landRaw.signals);
roadsOut.signals = graph.nodes.map((n, i) => (signalIds.has(n.id) ? i : -1)).filter((i) => i >= 0);
fs.writeFileSync(path.join(area.outDir, 'roads.json'), JSON.stringify(roadsOut));
fs.writeFileSync(path.join(area.outDir, 'rails.json'), JSON.stringify(rails));
fs.writeFileSync(path.join(area.outDir, 'structures.json'), JSON.stringify(extras.structures));
const manifest = {
  format: VERSION, area: area.id, name: area.name, compiled: new Date().toISOString(),
  origin: { lon: area.origin[0], lat: area.origin[1] },
  frame: 'metres; x east, y up (above mean sea level), z south',
  tileSize: TILE, bounds: Object.fromEntries(Object.entries(bounds).map(([k, v]) => [k, r2(v)])),
  extent, // the bounds out to the tile grid: the terrain and the aerial photo cover this
  terrain: { file: 'terrain.bin', x0: r2(grid.x0), z0: r2(grid.z0), step: grid.step, w: grid.w, h: grid.h, min: r2(gMin), max: r2(gMax) },
  // the sea surface, where the area has a coast (the client fills the world beyond the area with sea)
  sea: seaPolys.length ? SEA : null,
  view: area.view ?? null,
  // a large area: the radius (m) the client streams full tiles within, instead of loading them all
  stream: area.stream ?? null,
  // the surroundings, coarse, beyond the extent (the photo for them is in ortho/<area>/far)
  far: far && { file: far.file, x0: far.x0, z0: far.z0, step: far.step, w: far.w, h: far.h },
  // distant buildings, BLOCK x BLOCK tiles to a file: [cx, cz, file, buildings]
  blocks: { size: BLOCK, chunks: blockFiles },
  roads: 'roads.json', rails: 'rails.json', structures: 'structures.json',
  // street-level bridge decks: road polygons marked with a deck, and street objects, follow these instead of the terrain (src/shared/decks.js)
  decks,
  tiles: tileList,
  attribution: [
    'Buildings, roads, coastline and places: © OpenStreetMap contributors (ODbL 1.0)',
    'Building heights: FEMA / ORNL USA Structures (public domain)',
    'Elevation: USGS 3DEP via AWS Terrain Tiles',
  ],
};
fs.writeFileSync(path.join(area.outDir, 'manifest.json'), JSON.stringify(manifest, null, 1));
// the list of compiled areas, for the client's city switch
const tilesDir = path.join(ROOT, 'public/tiles');
const compiled = fs.readdirSync(tilesDir).filter((d) => fs.existsSync(path.join(tilesDir, d, 'manifest.json')))
  .map((d) => ({ id: d, name: JSON.parse(fs.readFileSync(path.join(tilesDir, d, 'manifest.json'), 'utf8')).name }));
fs.writeFileSync(path.join(tilesDir, 'areas.json'), JSON.stringify(compiled));
const mb = (n) => (n / 1e6).toFixed(1) + ' MB';
const size = (f) => fs.statSync(path.join(area.outDir, f)).size;
log(`wrote ${tileList.length} tiles (${mb(bytes)}), terrain ${mb(size('terrain.bin'))}, roads ${mb(size('roads.json'))}, rails ${mb(size('rails.json'))} -> ${path.relative(process.cwd(), area.outDir)}`);
