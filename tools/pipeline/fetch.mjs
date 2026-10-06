// Downloads the raw data for an area into data/raw/<area>/. Cached files are skipped.
//   OpenStreetMap    buildings, drivable road network, railways, coastline, land cover, paths and named
//                    places, from Geofabrik's Puerto Rico extract (or the Overpass API with --overpass)
//   FEMA / ORNL      USA Structures: building outlines with a LiDAR height and an occupancy class
//                    (ArcGIS feature service), used for the heights and uses OSM does not record
//   AWS Terrain      terrarium elevation tiles (USGS 3DEP on land)
//   USGS imagery     The National Map orthoimagery tiles, into public/ortho/<area>/ (the client drapes them on the ground)
// Usage: node tools/pipeline/fetch.mjs [--area=sanjuan] [--force] [--overpass]
import fs from 'node:fs';
import path from 'node:path';
import { resolveArea, ROOT, RAW } from './config.mjs';
import { demTileRange, DEM_SOURCES, FAR_DEM } from './terrain.mjs';
import { EXTRACT_URL, extractArea } from './extract.mjs';

const area = resolveArea();
const FORCE = process.argv.includes('--force');
const UA = 'procedural-sanjuan/0.1 (city compiler; https://github.com/jeantimex/tokyo fork)';
const OVERPASS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];
const FEMA = 'https://services2.arcgis.com/FiaPA4ga0iQKduv3/ArcGIS/rest/services/USA_Structures_View/FeatureServer/0/query';
const ORTHO = (z, x, y) => `https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/${z}/${y}/${x}`;

const t0 = Date.now();
const log = (...a) => console.log(((Date.now() - t0) / 1000).toFixed(1).padStart(6) + 's', ...a);
const exists = (f) => !FORCE && fs.existsSync(f) && fs.statSync(f).size > 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function download(url, file, { retries = 3, timeout = 300000, ...init } = {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      // (a server that stops answering must not hang the run: give up on it after `timeout` ms)
      const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(timeout), ...init });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (file) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file + '.part', buf);
        fs.renameSync(file + '.part', file);
      }
      return buf;
    } catch (e) {
      if (attempt >= retries) throw new Error(`${url.slice(0, 120)}: ${e.message}`);
      await sleep(1500 * attempt);
    }
  }
}

// Runs `fn` over items with at most `n` in flight.
async function pool(items, n, fn) {
  const queue = [...items];
  await Promise.all(Array.from({ length: n }, async () => { while (queue.length) await fn(queue.shift()); }));
}

// Overpass queries, one cached file each. `{bb}` is replaced by the area bounding box, `{bbw}` by the
// bounding box with a margin (for lines that must be followed past the edge: the coastline).
const OSM_QUERIES = {
  // drivable roads and railways
  'osm.json': `(
  way["highway"~"^(motorway|motorway_link|trunk|trunk_link|primary|primary_link|secondary|secondary_link|tertiary|tertiary_link|unclassified|residential|living_street|service)$"]({bb});
  way["railway"~"^(rail|light_rail|subway|monorail|narrow_gauge)$"]({bb});
);`,
  // buildings and the parts of buildings that are mapped in 3D
  'osm_buildings.json': `(
  way["building"]({bb});
  relation["building"]["type"="multipolygon"]({bb});
  way["building:part"]({bb});
);`,
  // the coastline: the sea is whatever lies on its right
  'osm_coast.json': `(
  way["natural"="coastline"]({bbw});
);`,
  // green space, water, beaches, mapped trees, pedestrian crossings and street objects
  'osm_land.json': `(
  way["leisure"~"^(park|garden|playground|pitch)$"]({bb});
  relation["leisure"~"^(park|garden)$"]({bb});
  way["landuse"~"^(grass|forest|cemetery|religious|recreation_ground|village_green|meadow)$"]({bb});
  relation["landuse"~"^(grass|forest|religious)$"]({bb});
  way["natural"~"^(wood|water|scrub|grassland|beach|sand|wetland)$"]({bb});
  relation["natural"~"^(wood|water|beach)$"]({bb});
  way["natural"="tree_row"]({bb});
  node["natural"="tree"]({bb});
  node["highway"~"^(traffic_signals|crossing)$"]({bb});
  way["footway"="crossing"]({bb});
  node["amenity"="vending_machine"]({bb});
);`,
  // everything else that is drawn, with geometry: the pedestrian network, platforms, car parks, barriers,
  // waterways, canopies, gates and small mapped objects
  'osm_extra.json': `(
  way["highway"~"^(footway|path|pedestrian|steps|cycleway)$"]({bb});
  way["railway"="platform"]({bb});
  way["public_transport"="platform"]({bb});
  way["amenity"="parking"]({bb});
  way["barrier"~"^(fence|hedge|wall|retaining_wall|guard_rail|city_wall)$"]({bb});
  way["historic"="citywalls"]({bb});
  way["waterway"~"^(river|stream|canal|ditch)$"]({bb});
  way["man_made"~"^(bridge|pier)$"]({bb});
  way["building"="roof"]({bb});
  way["leisure"="swimming_pool"]({bb});
  node["highway"="stop"]({bb});
  node["railway"="level_crossing"]({bb});
  node["emergency"="fire_hydrant"]({bb});
  node["tourism"="information"]["information"~"^(map|board)$"]({bb});
  node["leisure"="picnic_table"]({bb});
  node["playground"]({bb});
  way["building"]["building:colour"]({bb});
  way["building"]["building:material"]({bb});
);`,
  // named places (shops, restaurants, offices, named buildings) and street furniture, as points:
  // "out center" gives ways and relations a single coordinate
  'osm_poi.json': `(
  nwr["name"]["shop"]({bb});
  nwr["name"]["amenity"]({bb});
  nwr["name"]["tourism"]({bb});
  nwr["name"]["office"]({bb});
  nwr["name"]["leisure"~"^(fitness_centre|sports_centre|amusement_arcade|dance|bowling_alley)$"]({bb});
  nwr["name"]["building"]({bb});
  node["railway"~"^(station|subway_entrance)$"]({bb});
  node["highway"="bus_stop"]({bb});
  node["amenity"~"^(bench|bicycle_parking|post_box|telephone|toilets|taxi|police)$"]({bb});
  node["historic"]({bb});
  node["man_made"~"^(flagpole|surveillance)$"]({bb});
  node["barrier"="bollard"]({bb});
);
out center tags;`,
};

async function fetchOsm() {
  if (area.source !== 'overpass' && !process.argv.includes('--overpass')) return osmFromExtract();
  let first = true;
  for (const [name, body] of Object.entries(OSM_QUERIES)) {
    if (exists(path.join(area.rawDir, name))) { log(`osm ${name}: cached`); continue; }
    // A large area is queried cell by cell (cached one by one, so a failed run resumes), then merged.
    // The coastline is wanted past the edges anyway: one query.
    if (area.chunk && !body.includes('{bbw}')) { await fetchChunked(name, body); first = false; continue; }
    if (!first) await sleep(6000); // (the public Overpass servers rate-limit back-to-back queries)
    first = false;
    await fetchOverpass(name, body);
  }
}

// OpenStreetMap from Geofabrik's Puerto Rico extract (one download, shared by the areas, kept for a day):
// tools/pipeline/extract.mjs. --overpass (or source: 'overpass' in config.mjs) queries the live data instead,
// cell by cell for a large area.
async function osmFromExtract() {
  const names = Object.keys(OSM_QUERIES);
  if (names.every((n) => exists(path.join(area.rawDir, n)))) return log('osm: cached');
  const pbf = path.join(RAW, '_extract', 'puerto-rico-latest.osm.pbf');
  const stale = !fs.existsSync(pbf) || Date.now() - fs.statSync(pbf).mtimeMs > 864e5;
  if (stale || FORCE) {
    log(`osm extract: downloading ${EXTRACT_URL}`);
    const buf = await download(EXTRACT_URL, pbf, { timeout: 1800000 });
    log(`osm extract: ${(buf.length / 1e6).toFixed(0)} MB`);
  } else log('osm extract: cached');
  const files = await extractArea(pbf, area.bbox, 0.012, log);
  for (const n of names) {
    fs.writeFileSync(path.join(area.rawDir, n), JSON.stringify(files[n]));
    log(`osm ${n}: ${files[n].elements.length} elements (from the extract)`);
  }
}

// (two cells at a time, on the main server, which gives each client two slots; the others are the fallback)
async function fetchChunked(name, body) {
  const { south, west, north, east } = area.bbox, c = area.chunk;
  const nx = Math.ceil((east - west) / c - 1e-9), ny = Math.ceil((north - south) / c - 1e-9), base = name.replace('.json', '');
  const cells = [];
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++)
    cells.push({ part: path.join('osm_parts', `${base}_${i}_${j}.json`), box: { west: west + i * c, east: Math.min(east, west + (i + 1) * c), south: south + j * c, north: Math.min(north, south + (j + 1) * c) } });
  const readable = (part) => { try { return JSON.parse(fs.readFileSync(path.join(area.rawDir, part), 'utf8')); } catch { return null; } };
  const todo = cells.filter((cl) => !exists(path.join(area.rawDir, cl.part)) || !readable(cl.part));
  log(`osm ${name}: ${cells.length} cells, ${todo.length} to fetch`);
  await Promise.all([0, 1].map(async () => {
    for (let cl; (cl = todo.shift());) { await fetchOverpass(cl.part, body, cl.box); await sleep(3000); }
  }));
  const seen = new Set(), elements = [];
  for (const cl of cells) {
    for (const e of readable(cl.part).elements) {
      const k = e.type[0] + e.id;
      if (!seen.has(k)) { seen.add(k); elements.push(e); }
    }
  }
  fs.writeFileSync(path.join(area.rawDir, name), JSON.stringify({ elements }));
  log(`osm ${name}: ${nx * ny} cells merged, ${elements.length} elements`);
}

async function fetchOverpass(name, body, box = area.bbox, server = 0) {
  const file = path.join(area.rawDir, name);
  const { south, west, north, east } = box, m = 0.012;
  // queries end with their own "out" statement, or get the default: the elements with all their nodes
  const filled = body.replaceAll('{bbw}', `${south - m},${west - m},${north + m},${east + m}`).replaceAll('{bb}', `${south},${west},${north},${east}`);
  const query = `[out:json][timeout:400];\n${filled}${/\bout\b/.test(filled) ? '' : '\n(._;>;);\nout body;'}`;
  // the preferred server first, then the others
  const servers = [...OVERPASS.slice(server), ...OVERPASS.slice(0, server)];
  for (let round = 0; round < 2; round++)
    for (const url of servers) {
      try {
        log(`osm ${name}: querying ${new URL(url).host}`);
        const buf = await download(url, null, {
          retries: 2, method: 'POST', timeout: 420000,
          headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded' },
          body: 'data=' + encodeURIComponent(query),
        });
        const json = JSON.parse(buf); // (an overloaded server answers with an HTML page: try the next one)
        if (json.remark && /error|timed out/i.test(json.remark)) throw new Error(json.remark);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, buf);
        return log(`osm ${name}: ${json.elements.length} elements, ${(buf.length / 1e6).toFixed(1)} MB`);
      } catch (e) {
        log(`osm ${name}: ${e.message.slice(0, 160)}`);
        await sleep(8000);
      }
    }
  throw new Error(`osm ${name}: every Overpass endpoint failed`);
}

// FEMA USA Structures in the bounding box, as one GeoJSON FeatureCollection (the service pages by 2000).
async function fetchStructures() {
  const file = path.join(area.rawDir, 'fema_structures.json');
  if (exists(file)) return log('fema structures: cached');
  const { south, west, north, east } = area.bbox;
  const features = [];
  for (let offset = 0; ; offset += 2000) {
    const q = new URLSearchParams({
      where: '1=1', geometry: `${west},${south},${east},${north}`, geometryType: 'esriGeometryEnvelope', inSR: '4326',
      spatialRel: 'esriSpatialRelIntersects', outFields: 'BUILD_ID,OCC_CLS,PRIM_OCC,HEIGHT,SQMETERS,PROP_ADDR', outSR: '4326',
      orderByFields: 'OBJECTID', resultOffset: String(offset), resultRecordCount: '2000', f: 'geojson',
    });
    const page = JSON.parse(await download(`${FEMA}?${q}`, null, { retries: 4 }));
    if (page.error) throw new Error(`fema: ${JSON.stringify(page.error)}`);
    features.push(...(page.features ?? []));
    log(`fema structures: ${features.length}`);
    if (!page.features?.length || !(page.exceededTransferLimit || page.properties?.exceededTransferLimit) && page.features.length < 2000) break;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ type: 'FeatureCollection', features }));
  log(`fema structures: ${features.length} buildings`);
}

// the bounding box with a margin: the edge tiles reach out to the 256 m tile grid (tools/pipeline/compile.mjs)
const margin = (b, m = 0.004) => ({ west: b.west - m, south: b.south - m, east: b.east + m, north: b.north + m });

async function fetchDem() {
  for (const src of DEM_SOURCES) {
    const { z, x0, x1, y0, y1 } = demTileRange(margin(area.bbox), src.zoom);
    const jobs = [];
    for (let x = x0; x <= x1; x++)
      for (let y = y0; y <= y1; y++)
        jobs.push({ url: src.url(z, x, y), file: path.join(area.rawDir, 'dem', src.id, `${z}_${x}_${y}.png`) });
    const todo = jobs.filter((j) => !exists(j.file));
    log(`dem ${src.id}: ${jobs.length} tiles, ${todo.length} to download`);
    await pool(todo, 4, async (j) => {
      try { await download(j.url, j.file); } catch (e) { log(`  ${e.message} (left as a gap)`); }
    });
  }
}

// Aerial photo: zoom 16 (about 2.3 m per pixel here) is the finest The National Map serves over Puerto Rico
// (a large area takes zoom 15: the client stitches the whole photo into one texture).
async function fetchOrtho() {
  const z = area.orthoZoom ?? 16, dir = path.join(ROOT, 'public/ortho', area.id), { x0, x1, y0, y1 } = demTileRange(margin(area.bbox), z);
  const jobs = [];
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++)
    jobs.push({ url: ORTHO(z, x, y), file: path.join(dir, `${z}_${x}_${y}.jpg`) });
  const todo = jobs.filter((j) => !exists(j.file));
  log(`aerial photo: ${jobs.length} tiles, ${todo.length} to download`);
  await pool(todo, 4, async (j) => { try { await download(j.url, j.file); } catch (e) { log(`  ${e.message} (left as a gap)`); } });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify({ z, x0, x1, y0, y1, attribution: 'Aerial photo: USGS The National Map orthoimagery' }));
}

// The surroundings, out to the horizon: coarse terrain (zoom 12, about 37 m) and aerial photo (zoom 13, about
// 19 m per pixel) for FAR degrees around the area, for the landscape the client draws beyond it.
const FAR = 0.12;
async function fetchSurroundings() {
  const around = margin(area.bbox, FAR), jobs = [];
  { const { z, x0, x1, y0, y1 } = demTileRange(around, FAR_DEM.zoom);
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) jobs.push({ url: FAR_DEM.url(z, x, y), file: path.join(area.rawDir, 'dem', FAR_DEM.id, `${z}_${x}_${y}.png`) }); }
  const z = 13, dir = path.join(ROOT, 'public/ortho', area.id, 'far'), { x0, x1, y0, y1 } = demTileRange(around, z);
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) jobs.push({ url: ORTHO(z, x, y), file: path.join(dir, `${z}_${x}_${y}.jpg`) });
  const todo = jobs.filter((j) => !exists(j.file));
  log(`surroundings: ${jobs.length} tiles, ${todo.length} to download`);
  await pool(todo, 4, async (j) => { try { await download(j.url, j.file); } catch (e) { log(`  ${e.message} (left as a gap)`); } });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify({ z, x0, x1, y0, y1, attribution: 'Aerial photo: USGS The National Map orthoimagery' }));
}

log(`area ${area.id}: bbox lat ${area.bbox.south.toFixed(5)}..${area.bbox.north.toFixed(5)} lon ${area.bbox.west.toFixed(5)}..${area.bbox.east.toFixed(5)}`);
await fetchDem();
await fetchOrtho();
await fetchSurroundings();
await fetchStructures();
await fetchOsm();
log('done');
