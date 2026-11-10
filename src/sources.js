// Where everything in the city comes from, for the data sources panel (index.html #sources): the data the
// compiler reads (tools/pipeline/fetch.mjs), the assets the client draws with, and the software under it.
export const SOURCES = [
  {
    group: 'Map data',
    items: [
      {
        name: 'OpenStreetMap', url: 'https://www.openstreetmap.org/copyright',
        what: 'Building outlines, heights and floors; streets, railways and the coastline; parks, beaches, water and paths; the names on the signs.',
        license: '© OpenStreetMap contributors, ODbL 1.0',
        via: ['Geofabrik Puerto Rico extract', 'https://download.geofabrik.de/north-america/us/puerto-rico.html'],
      },
      {
        name: 'Garita', url: 'https://github.com/webgpu-demos/garita',
        what: 'Building ids (Overture GERS) and building heights from lidar, matched to the footprints.',
        license: 'from Overture Maps Foundation (under its data licences) and USGS 3DEP (public domain)',
      },
      {
        name: 'FEMA / ORNL USA Structures', url: 'https://gis-fema.hub.arcgis.com/pages/usa-structures',
        what: 'Building heights measured by LiDAR, and building uses, where OpenStreetMap has none.',
        license: 'Public domain',
      },
    ],
  },
  {
    group: 'Traffic',
    items: [
      {
        name: 'Eclipse SUMO', url: 'https://eclipse.dev/sumo/',
        what: 'The traffic simulation: every car on the road in the simulated morning is a trip SUMO drove, lane by lane, through the city’s junctions and signals.',
        license: 'EPL-2.0, German Aerospace Center (DLR) and others',
      },
      {
        name: 'U.S. Census Bureau, American Community Survey', url: 'https://www.census.gov/data/tables/2020/demo/metro-micro/commuting-flows-2020.html',
        what: 'Who commutes from which municipio to which (2016-2020 flows), when people leave home for work (B08302, 2018-2022), and the municipios’ boundaries.',
        license: 'Public domain',
      },
      {
        name: 'FHWA Highway Performance Monitoring System', url: 'https://www.fhwa.dot.gov/policyinformation/hpms.cfm',
        what: 'Traffic counts (AADT) on Puerto Rico’s roads, 2024: what the simulated morning is checked against.',
        license: 'Public domain (CC0)',
        via: ['National Transportation Atlas Database', 'https://geo.dot.gov/server/rest/services/Hosted/HPMS_FULL_PR_2024/FeatureServer'],
      },
      {
        name: 'ATI GTFS feed', url: 'https://www.ati.pr.gov/relaciones-comunidad?tab=DatosAbiertos',
        what: 'The AMA buses: their routes, stops and timetables (PRITA_GTFS), driven as scheduled in the simulated morning.',
        license: 'ATI, Gobierno de Puerto Rico, under its open-data terms (not affiliated)',
      },
    ],
  },
  {
    group: 'Elevation and imagery',
    items: [
      {
        name: 'USGS 3DEP elevation', url: 'https://www.usgs.gov/3d-elevation-program',
        what: 'The terrain, from El Morro to the hills of Caimito, and of the island around it.',
        license: 'Public domain',
        via: ['AWS Terrain Tiles (Mapzen / Tilezen)', 'https://registry.opendata.aws/terrain-tiles/'],
      },
      {
        name: 'USGS 3DEP 1 m lidar DEM', url: 'https://www.usgs.gov/3d-elevation-program',
        what: 'The ground of the city itself where an area was compiled with it: bare earth from the 2023-25 lidar, buildings and bridges removed, averaged into each terrain cell (the 10 m surface stands in where it has no data).',
        license: 'Public domain',
        via: ['USGS The National Map, project PR_PuertoRicoUSVI_D24', 'https://prd-tnm.s3.amazonaws.com/index.html?prefix=StagedProducts/Elevation/1m/Projects/PR_PuertoRicoUSVI_D24/'],
      },
      {
        name: 'USGS The National Map orthoimagery', url: 'https://www.usgs.gov/programs/national-geospatial-program/national-map',
        what: 'The aerial photo on the open ground and on the surrounding island.',
        license: 'Public domain',
      },
    ],
  },
  {
    group: '3D assets',
    items: [
      {
        name: 'Poly Haven', url: 'https://polyhaven.com',
        what: 'Textures: stucco, plaster and concrete walls, asphalt, pavers, grass, sand and the cobblestones of the old city.',
        license: 'CC0',
      },
      {
        name: 'ez-tree', url: 'https://github.com/dgreenheck/ez-tree',
        what: 'The shade trees and the flamboyanes (the palms are generated here).',
        license: 'MIT, Daniel Greenheck',
      },
      {
        name: 'Microsoft Rocketbox', url: 'https://github.com/microsoft/Microsoft-Rocketbox',
        what: 'The one who walks and cycles (Male_Adult_01, with his idle, walk and run and a seated pose), and the 39 people on foot in the streets, with the library\'s walks, waits, talks and seats (converted to glTF).',
        license: 'MIT, Microsoft',
      },
      {
        name: 'NVIDIA MotionBricks', url: 'https://github.com/NVlabs/motionbricks',
        what: 'The people\'s steps between their clips: setting off, stopping, standing up, the walker turning on the spot.',
        license: 'NVIDIA Open Model Agreement (no claim on its outputs)',
      },
      {
        name: 'Takram three-geospatial', url: 'https://github.com/takram-design-engineering/three-geospatial',
        what: 'The sky, the haze of distance and the volumetric clouds, with their noise textures.',
        license: 'MIT',
      },
    ],
  },
  {
    group: 'Music',
    items: [
      {
        name: 'Callejón de Panderetas, Fiesta de la Memoria, Romanoctubre, Island Call and Response, Bounce Playful, Perdona mi Vida', url: 'https://suno.com',
        what: 'The six songs on the radio, plenas and more, made for this project with Suno.',
        license: 'made with Suno',
      },
    ],
  },
  {
    group: 'Software',
    items: [
      {
        name: 'procedural-tokyo', url: 'https://github.com/jeantimex/tokyo',
        what: 'The city engine this is a port of: tile compiler, streaming, facades, traffic and lighting.',
        license: 'MIT, jeantimex',
      },
      {
        name: 'Slop New York', url: 'https://github.com/mrdoob/slop-newyork',
        what: 'mrdoob\'s game shell, after which the free roaming is laid out: its HUD, the ways round (walking, cycling, driving, flying), the cameras, the map; and its cars, whose bodies and paint the cars and the AMA bus are built from.',
        license: 'MIT',
      },
      {
        name: 'Inter and Overpass', url: 'https://fonts.google.com',
        what: 'The HUD\'s type, and the street-name signs\' (Overpass: after Highway Gothic), from Google Fonts.',
        license: 'SIL Open Font License 1.1',
      },
      {
        name: 'three.js and friends', url: 'https://threejs.org',
        what: 'three.js, postprocessing, N8AO, lil-gui, earcut, polygon-clipping, osm-pbf-parser-node.',
        license: 'MIT / ISC',
      },
    ],
  },
];

// Not data: generated by the compiler and the client.
export const GENERATED = 'Modelled, not observed: the simulated morning (who drives where and when is drawn from the Census commuting data, then simulated; '
  + 'it is checked against counts, not recorded from real cars), and the apagón scenario. '
  + 'Generated, not mapped: window patterns, wall colours (the colonial palette of the old city included), palms, '
  + 'street lights and poles, parked and moving cars, road paint where OpenStreetMap has none, billboards and shop sign colours. '
  + 'The landmarks (the tiers and garitas of El Morro and San Cristóbal, the garitas of the walls, the lighthouse, the Capitol dome, '
  + 'the cathedral front and the Convention Center roof) are modelled by hand from their OpenStreetMap outlines.';

// Fills the panel: `list` the element the sources go in, `compiled` the area's compile date (manifest.compiled).
export function renderSources(list, compiled) {
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text) e.textContent = text; return e; };
  const link = (text, href) => { const a = el('a', null, text); a.href = href; a.target = '_blank'; a.rel = 'noopener'; return a; };
  list.replaceChildren();
  list.append(el('h2', null, 'Data sources'));
  for (const { group, items } of SOURCES) {
    list.append(el('h3', null, group));
    const ul = el('ul');
    for (const s of items) {
      const li = el('li');
      li.append(link(s.name, s.url), el('p', 'what', s.what));
      const meta = el('p', 'meta', s.license);
      if (s.via) meta.append(' · via ', link(s.via[0], s.via[1]));
      li.append(meta);
      ul.append(li);
    }
    list.append(ul);
  }
  list.append(el('p', 'generated', GENERATED));
  if (compiled) list.append(el('p', 'compiled', `This city compiled ${compiled.slice(0, 10)}.`));
}
