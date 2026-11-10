// The gates the city's data passes before it is published: the compiled tiles of each area and a simulated run,
// measured the same way before and after a change (AUDIT.md, "Gates"). Reads only.
//   node tools/audit/gates.mjs [--tiles=public/tiles] [--areas=sanjuan,condado,hatorey] [--raw=data/raw]
//                              [--sim=public/tiles/sanjuan/sim/morning] [--json=<file>]
// Tiles, per area:
//   levels    road points of ordinary streets (not a bridge, span, tunnel, flyover or expressway) more than 0.5 m
//             off the terrain: they float over the ground or sink into it
//   skywalks  OSM building=bridge (data/raw/<area>/osm_buildings.json) as drawn: raised, solid from the ground, or
//             taken out of the road (NO_SOLID)
//   paint     road-marking polygons whose middle lies on a sidewalk (they show through it from afar)
//   ads       invented billboards and screens, and how many fall where the client hides them (Old San Juan)
//   fronts    drawn buildings reaching 0.3 m or more into the corridor of a car in the outer lane of an at-grade
//             street (src/shared/roadway.js corridorOf), all streets and tertiary and above
// A run (--sim): cars loaded, inserted and still running at the end, teleports, the share of the counted traffic
// (validation.json), and how fast cars are going over the first and last second of their tracks, those that start
// in the area (their municipio of origin is the area's) and those that come in by a gate.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { decodeTile, AREA, BFLAG } from '../../src/shared/tileformat.js';
import { sampleGrid } from '../../src/shared/terrain.js';
import { makeProjection } from '../../src/shared/geo.js';
import { corridorOf } from '../../src/shared/roadway.js';
import { NO_ADS } from '../../src/shared/places.js';

const arg = (k, d) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const TILES = arg('tiles', 'public/tiles'), RAW = arg('raw', 'data/raw');
const AREAS = arg('areas', fs.readdirSync(TILES).filter((d) => fs.existsSync(path.join(TILES, d, 'manifest.json'))).join(',')).split(',');
const out = { tiles: TILES, areas: {} };

// ---------------------------------------------------------------- geometry
const inRing = (x, z, r) => {
  let c = false;
  for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) {
    const xi = r[i], zi = r[i + 1], xj = r[j], zj = r[j + 1];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) c = !c;
  }
  return c;
};
const inPolygon = (x, z, rings) => inRing(x, z, rings[0]) && !rings.slice(1).some((h) => inRing(x, z, h));
const bbox = (r) => { let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity; for (let i = 0; i < r.length; i += 2) { x0 = Math.min(x0, r[i]); x1 = Math.max(x1, r[i]); z0 = Math.min(z0, r[i + 1]); z1 = Math.max(z1, r[i + 1]); } return [x0, z0, x1, z1]; };
const centroid = (r) => { let a = 0, cx = 0, cz = 0; for (let i = 0, n = r.length; i < n; i += 2) { const j = (i + 2) % n, f = r[i] * r[j + 1] - r[j] * r[i + 1]; a += f; cx += (r[i] + r[j]) * f; cz += (r[i + 1] + r[j + 1]) * f; } return Math.abs(a) < 1e-9 ? [r[0], r[1]] : [cx / (3 * a), cz / (3 * a)]; };

// ---------------------------------------------------------------- roads
const flyover = (e) => e.bridge && !e.tunnel && (e.highway.startsWith('motorway') || e.layer >= 2);
const ordinary = (e) => !e.tunnel && !e.bridge && !e.span && !flyover(e) && !e.highway.startsWith('motorway');
const DRIVEN = /^(motorway|trunk|primary|secondary|tertiary|unclassified|residential)/;
const MAJOR = /^(motorway|trunk|primary|secondary|tertiary)/;

function tilesOf(dir, m) {
  return function* () {
    for (const t of m.tiles) {
      const buf = fs.readFileSync(path.join(dir, t.file));
      const tile = decodeTile(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
      const ids = t.ids && fs.existsSync(path.join(dir, t.ids)) ? fs.readFileSync(path.join(dir, t.ids), 'utf8').split('\n') : null;
      yield { t, tile, ids };
    }
  };
}

function measureArea(id) {
  const dir = path.join(TILES, id), m = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  const roads = JSON.parse(fs.readFileSync(path.join(dir, m.roads ?? 'roads.json'), 'utf8'));
  const tb = fs.readFileSync(path.join(dir, m.terrain.file));
  const grid = { ...m.terrain, data: new Float32Array(tb.buffer.slice(tb.byteOffset, tb.byteOffset + tb.byteLength)) };
  const ground = (x, z) => sampleGrid(grid, x, z);
  const proj = makeProjection(m.origin.lon, m.origin.lat);
  const tiles = tilesOf(dir, m);
  const r = { compiled: m.compiled, roadsCleared: m.roadsCleared?.buildings ?? null };

  // levels
  {
    let n = 0, off = 0, worst = 0, at = null;
    for (const e of roads.edges) {
      if (!ordinary(e)) continue;
      for (let k = 0; k < e.pts.length; k += 3) {
        const d = Math.abs(e.pts[k + 1] - ground(e.pts[k], e.pts[k + 2]));
        n++; if (d > 0.5) off++;
        if (d > worst) { worst = d; at = [Math.round(e.pts[k]), Math.round(e.pts[k + 2]), e.name || e.highway]; }
      }
    }
    r.levels = { points: n, off, share: +(off / n).toFixed(4), worst: +worst.toFixed(1), at };
  }

  // the corridors of the at-grade streets, in 32 m cells: [ax, az, bx, bz, half, major]
  const CELL = 32, cells = new Map();
  for (const e of roads.edges) {
    if (!DRIVEN.test(e.highway) || e.bridge || e.tunnel || e.flyover || e.span || e.layer > 0) continue;
    const c = corridorOf(e), p = e.pts, major = MAJOR.test(e.highway);
    for (let i = 3; i < p.length; i += 3) {
      const s = [p[i - 3], p[i - 1], p[i], p[i + 2], c, major];
      const x0 = Math.floor((Math.min(s[0], s[2]) - c - 1) / CELL), x1 = Math.floor((Math.max(s[0], s[2]) + c + 1) / CELL);
      const z0 = Math.floor((Math.min(s[1], s[3]) - c - 1) / CELL), z1 = Math.floor((Math.max(s[1], s[3]) + c + 1) / CELL);
      for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) { const k = x * 100003 + z; let l = cells.get(k); if (!l) cells.set(k, (l = [])); l.push(s); }
    }
  }
  const depthAt = (x, z) => { // [deepest into any corridor, deepest into a major road's]
    let all = -Infinity, major = -Infinity;
    for (const [ax, az, bx, bz, c, mj] of cells.get(Math.floor(x / CELL) * 100003 + Math.floor(z / CELL)) ?? []) {
      const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz, t = l2 ? Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2)) : 0;
      const d = c - Math.hypot(x - ax - dx * t, z - az - dz * t);
      if (d > all) all = d;
      if (mj && d > major) major = d;
    }
    return [all, major];
  };

  // skywalks: the area's building=bridge ways
  const bridges = new Set();
  const rawFile = path.join(RAW, id, 'osm_buildings.json');
  if (fs.existsSync(rawFile)) {
    const text = fs.readFileSync(rawFile, 'utf8');
    for (const mt of text.matchAll(/\{"type":"way","id":(\d+)[^{}]*"tags":\{[^{}]*"building":"bridge"[^{}]*\}/g)) bridges.add('w' + mt[1]);
  }
  const sky = [];
  const paint = { marks: 0, onSidewalk: 0 }, ads = { all: 0, hidden: 0 }, fronts = { all: 0, major: 0, buildings: 0 };
  const [hx0, hz1] = proj.project(NO_ADS.west, NO_ADS.south), [hx1, hz0] = proj.project(NO_ADS.east, NO_ADS.north);
  for (const { tile, ids } of tiles()) {
    // paint on sidewalks
    const walks = [];
    for (const a of tile.areas) if (a.kind === AREA.SIDEWALK) for (const rings of a.polygons) walks.push([bbox(rings[0]), rings]);
    for (const a of tile.areas) {
      if (a.kind !== AREA.MARK_WHITE && a.kind !== AREA.MARK_YELLOW) continue;
      for (const rings of a.polygons) {
        paint.marks++;
        const [x, z] = centroid(rings[0]);
        if (walks.some(([b, w]) => x >= b[0] && x <= b[2] && z >= b[1] && z <= b[3] && inPolygon(x, z, w))) paint.onSidewalk++;
      }
    }
    // ads
    for (const s of tile.signs) {
      if (s.style < 3) continue;
      ads.all++;
      if (s.x >= hx0 && s.x <= hx1 && s.z >= hz0 && s.z <= hz1) ads.hidden++;
    }
    tile.buildings.forEach((b, bi) => {
      const ref = ids?.[bi]?.split(',')[1];
      if (ref && bridges.has(ref)) {
        const [x0, z0, x1, z1] = bbox(b.polygons[0][0]), cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
        sky.push({ osm: ref, at: [Math.round(cx), Math.round(cz)], flags: b.flags,
          drawn: b.flags & BFLAG.NO_SOLID ? 'removed' : b.flags & (BFLAG.RAISED ?? 0) ? 'raised' : 'solid',
          clearance: +(b.base - ground(cx, cz)).toFixed(1), height: +b.height.toFixed(1) });
      }
      // fronts in a corridor
      if (b.flags & (BFLAG.NO_SOLID | BFLAG.MASONRY | (BFLAG.RAISED ?? 0))) return;
      fronts.buildings++;
      let all = -Infinity, major = -Infinity;
      for (const rings of b.polygons) {
        const ring = rings[0];
        for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) {
          const ax = ring[j], az = ring[j + 1], bx = ring[i], bz = ring[i + 1], len = Math.hypot(bx - ax, bz - az), n = Math.max(1, Math.ceil(len));
          for (let s = 0; s < n; s++) { const [d, dm] = depthAt(ax + ((bx - ax) * s) / n, az + ((bz - az) * s) / n); if (d > all) all = d; if (dm > major) major = dm; }
        }
      }
      if (all >= 0.3) fronts.all++;
      if (major >= 0.3) fronts.major++;
    });
  }
  r.skywalks = sky;
  r.paint = paint; r.ads = ads; r.fronts = fronts;
  return r;
}

// ---------------------------------------------------------------- a run
async function measureRun(dir) {
  globalThis.self ??= {};
  const { decode } = await import('../../src/world/simworker.js');
  const index = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'));
  const v = index.stats?.vehicles ?? {};
  const r = {
    dir, scenario: index.scenario, share: index.share, roads: index.roads ?? null,
    loaded: +v.loaded, inserted: +v.inserted, notInserted: +v.loaded - +v.inserted, runningAtEnd: +v.running,
    teleports: +(index.stats?.teleports?.total ?? NaN), teleportsBy: index.stats?.teleports,
  };
  const valFile = path.join(dir, 'validation.json');
  if (fs.existsSync(valFile)) { const val = JSON.parse(fs.readFileSync(valFile, 'utf8')); r.counted = { ratio: +val.all.ratio.toFixed(3), r2: +val.all.r2.toFixed(3), geh5: +val.all.geh5.toFixed(3), n: val.all.n }; }
  // why each car drives, and from where
  const tripsFile = path.join(dir, 'trips.bin');
  const trips = fs.existsSync(tripsFile) ? fs.readFileSync(tripsFile) : null;
  const home = index.municipios.indexOf(arg('municipio', 'San Juan')) + 1;
  const local = (vid) => trips && vid * 5 + 2 < trips.length ? trips[vid * 5 + 1] === home : null;
  const sp = { localStart: [], gateStart: [], localEnd: [], gateEnd: [] };
  const hour = 1800, own = index.windows.filter(([, f]) => !f.startsWith('..'));
  for (let t = index.begin + hour; t < index.end; t += hour) {
    const w = own.find(([t0]) => t0 <= t && t < t0 + index.window);
    if (!w) continue;
    const buf = zlib.gunzipSync(fs.readFileSync(path.join(dir, w[1])));
    const W = decode(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)), K = W.K;
    for (let i = 0; i < W.n; i++) {
      const s = W.start[i], c = W.count[i];
      if (c < 2) continue;
      const a = s * 4, z = (s + c - 1) * 4, l = local(W.vid[i]);
      if (K[a] > W.t0 + 0.5) (l ? sp.localStart : sp.gateStart).push(Math.hypot(K[a + 5] - K[a + 1], K[a + 7] - K[a + 3]) / Math.max(1e-3, K[a + 4] - K[a]));
      if (K[z] < W.t1 - 0.5) (l ? sp.localEnd : sp.gateEnd).push(Math.hypot(K[z + 1] - K[z - 3], K[z + 3] - K[z - 1]) / Math.max(1e-3, K[z] - K[z - 4]));
    }
  }
  const st = (a) => { a.sort((x, y) => x - y); return a.length ? { n: a.length, medianKmh: +(a[a.length >> 1] * 3.6).toFixed(0), over5: +(a.filter((x) => x > 5).length / a.length).toFixed(3) } : null; };
  r.speeds = Object.fromEntries(Object.entries(sp).map(([k, a]) => [k, st(a)]));
  return r;
}

for (const id of AREAS) { out.areas[id] = measureArea(id); console.log(id, JSON.stringify(out.areas[id])); }
if (arg('sim')) { out.run = await measureRun(arg('sim')); console.log('run', JSON.stringify(out.run)); }
if (arg('json')) fs.writeFileSync(arg('json'), JSON.stringify(out, null, 1));
