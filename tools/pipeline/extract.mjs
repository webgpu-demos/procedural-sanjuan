// OpenStreetMap from a regional extract instead of the Overpass API: Geofabrik's Puerto Rico .osm.pbf, cut to
// an area and filtered into the same files the Overpass queries of fetch.mjs produce (same selections, same
// JSON shapes). For a large area the public Overpass servers are slow; the extract is one download, read in
// one pass (it is sorted: nodes, then ways, then relations).
import fs from 'node:fs';
import { createOSMStream } from 'osm-pbf-parser-node';

export const EXTRACT_URL = 'https://download.geofabrik.de/north-america/us/puerto-rico-latest.osm.pbf';

const among = (v, list) => v != null && list.includes(v);
const DRIVABLE = ['motorway', 'motorway_link', 'trunk', 'trunk_link', 'primary', 'primary_link', 'secondary', 'secondary_link',
  'tertiary', 'tertiary_link', 'unclassified', 'residential', 'living_street', 'service'];

// The queries of fetch.mjs (OSM_QUERIES) as predicates over tags. wide: selected within the bounding box with a
// margin (the coastline, which is followed past the edges); center: ways and relations are written as a single
// point ("out center tags"), and no nodes are added for them.
export const FILTERS = {
  'osm.json': {
    way: (t) => among(t.highway, DRIVABLE) || among(t.railway, ['rail', 'light_rail', 'subway', 'monorail', 'narrow_gauge']),
  },
  'osm_buildings.json': {
    way: (t) => t.building != null || t['building:part'] != null,
    relation: (t) => t.building != null && t.type === 'multipolygon',
  },
  'osm_coast.json': { wide: true, way: (t) => t.natural === 'coastline' },
  'osm_land.json': {
    way: (t) => among(t.leisure, ['park', 'garden', 'playground', 'pitch']) || among(t.landuse, ['grass', 'forest', 'cemetery', 'religious', 'recreation_ground', 'village_green', 'meadow'])
      || among(t.natural, ['wood', 'water', 'scrub', 'grassland', 'beach', 'sand', 'wetland', 'tree_row']) || t.footway === 'crossing',
    relation: (t) => among(t.leisure, ['park', 'garden']) || among(t.landuse, ['grass', 'forest', 'religious']) || among(t.natural, ['wood', 'water', 'beach']),
    node: (t) => t.natural === 'tree' || among(t.highway, ['traffic_signals', 'crossing']) || t.amenity === 'vending_machine',
  },
  'osm_extra.json': {
    way: (t) => among(t.highway, ['footway', 'path', 'pedestrian', 'steps', 'cycleway']) || t.railway === 'platform' || t.public_transport === 'platform'
      || t.amenity === 'parking' || among(t.barrier, ['fence', 'hedge', 'wall', 'retaining_wall', 'guard_rail', 'city_wall']) || t.historic === 'citywalls'
      || among(t.waterway, ['river', 'stream', 'canal', 'ditch']) || among(t.man_made, ['bridge', 'pier']) || t.building === 'roof' || t.leisure === 'swimming_pool'
      || (t.building != null && (t['building:colour'] != null || t['building:material'] != null)),
    node: (t) => t.highway === 'stop' || t.railway === 'level_crossing' || t.emergency === 'fire_hydrant'
      || (t.tourism === 'information' && among(t.information, ['map', 'board'])) || t.leisure === 'picnic_table' || t.playground != null,
  },
  'osm_poi.json': {
    center: true,
    way: (t) => named(t),
    relation: (t) => named(t),
    node: (t) => named(t) || among(t.railway, ['station', 'subway_entrance']) || t.highway === 'bus_stop'
      || among(t.amenity, ['bench', 'bicycle_parking', 'post_box', 'telephone', 'toilets', 'taxi', 'police']) || t.historic != null
      || among(t.man_made, ['flagpole', 'surveillance']) || t.barrier === 'bollard',
  },
};
function named(t) {
  return t.name != null && (t.shop != null || t.amenity != null || t.tourism != null || t.office != null || t.building != null
    || among(t.leisure, ['fitness_centre', 'sports_centre', 'amusement_arcade', 'dance', 'bowling_alley']));
}

// pbf: the extract; bbox { west, south, east, north }; wide: margin (degrees) for the `wide` selections.
// Returns { name: { elements } } for every file of FILTERS.
export async function extractArea(pbf, bbox, wide = 0.012, log = () => {}) {
  const keep = 0.02; // node coordinates are kept this far past the box: ways that leave it keep their next points
  const inBox = (lon, lat, m) => lon >= bbox.west - m && lon <= bbox.east + m && lat >= bbox.south - m && lat <= bbox.north + m;
  // node id -> slot in the coordinate arrays (a large area holds millions)
  const slot = new Map(), tagsOf = new Map();
  let lon = new Float64Array(1 << 20), lat = new Float64Array(1 << 20), n = 0;
  const ways = new Map(); // way id -> { refs, tags, inner (a node in the box), wide (a node in the wide box) }
  const out = Object.fromEntries(Object.keys(FILTERS).map((k) => [k, { nodes: [], ways: new Set(), relations: [] }]));
  const filters = Object.entries(FILTERS);
  let seen = 0;
  for await (const batch of createOSMStream(pbf, { withInfo: false })) {
    for (const e of Array.isArray(batch) ? batch : [batch]) {
      if (++seen % 2e6 === 0) log(`  extract: ${(seen / 1e6).toFixed(0)}M elements read, ${(n / 1e6).toFixed(1)}M nodes kept`);
      if (e.type === 'node') {
        if (!inBox(e.lon, e.lat, keep)) continue;
        if (n === lon.length) { const a = new Float64Array(n * 2), b = new Float64Array(n * 2); a.set(lon); b.set(lat); lon = a; lat = b; }
        slot.set(e.id, n); lon[n] = e.lon; lat[n] = e.lat; n++;
        if (e.tags) {
          tagsOf.set(e.id, e.tags);
          for (const [name, f] of filters) if (f.node && inBox(e.lon, e.lat, f.wide ? wide : 0) && f.node(e.tags)) out[name].nodes.push(e.id);
        }
      } else if (e.type === 'way') {
        let inner = false, wideIn = false, any = false;
        for (const r of e.refs) {
          const s = slot.get(r);
          if (s === undefined) continue;
          any = true;
          if (!inner && inBox(lon[s], lat[s], 0)) inner = true;
          if (!wideIn && inBox(lon[s], lat[s], wide)) wideIn = true;
        }
        if (!any) continue;
        const w = { refs: e.refs, tags: e.tags ?? {}, inner, wide: wideIn };
        ways.set(e.id, w);
        if (e.tags) for (const [name, f] of filters) if (f.way && (f.wide ? wideIn : inner) && f.way(e.tags)) out[name].ways.add(e.id);
      } else if (e.type === 'relation') {
        if (!e.tags) continue;
        const members = e.members.filter((m) => m.type === 'way' && ways.has(m.ref));
        if (!members.length) continue;
        const inner = members.some((m) => ways.get(m.ref).inner);
        for (const [name, f] of filters) if (f.relation && inner && f.relation(e.tags)) out[name].relations.push(e);
      }
    }
  }
  log(`  extract: ${(seen / 1e6).toFixed(1)}M elements read, ${n} nodes and ${ways.size} ways near the area`);

  const node = (id, withTags = true) => {
    const s = slot.get(id);
    if (s === undefined) return null;
    const e = { type: 'node', id, lat: lat[s], lon: lon[s] }, t = tagsOf.get(id);
    if (t && withTags) e.tags = t;
    return e;
  };
  const centre = (refs) => {
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const r of refs) { const s = slot.get(r); if (s === undefined) continue; x0 = Math.min(x0, lon[s]); x1 = Math.max(x1, lon[s]); y0 = Math.min(y0, lat[s]); y1 = Math.max(y1, lat[s]); }
    return x0 <= x1 ? { lat: (y0 + y1) / 2, lon: (x0 + x1) / 2 } : null;
  };
  const result = {};
  for (const [name, f] of filters) {
    const sel = out[name], elements = [];
    if (f.center) {
      for (const id of sel.nodes) elements.push(node(id));
      for (const id of sel.ways) { const w = ways.get(id), c = centre(w.refs); if (c) elements.push({ type: 'way', id, center: c, tags: w.tags }); }
      for (const r of sel.relations) {
        const c = centre(r.members.filter((m) => m.type === 'way' && ways.has(m.ref)).flatMap((m) => ways.get(m.ref).refs));
        if (c) elements.push({ type: 'relation', id: r.id, center: c, tags: r.tags });
      }
    } else {
      // the selection and everything it is made of: the member ways of relations, the nodes of every way
      const wayIds = new Set(sel.ways), nodeIds = new Set(sel.nodes);
      for (const r of sel.relations) for (const m of r.members) if (m.type === 'way' && ways.has(m.ref)) wayIds.add(m.ref);
      for (const id of wayIds) for (const r of ways.get(id).refs) nodeIds.add(r);
      for (const id of nodeIds) { const e = node(id); if (e) elements.push(e); }
      for (const id of wayIds) { const w = ways.get(id); elements.push({ type: 'way', id, nodes: w.refs, tags: w.tags }); }
      for (const r of sel.relations) elements.push({ type: 'relation', id: r.id, members: r.members, tags: r.tags });
    }
    result[name] = { elements };
  }
  return result;
}
