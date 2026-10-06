# procedural-sanjuan

A three.js city set in San Juan, Puerto Rico, compiled from public data with procedural detail on top.
It is a port of [procedural-tokyo](https://github.com/jeantimex/tokyo), which follows
[BoundlessNYC](https://github.com/mkturkcan/boundless-nyc): an offline compiler turns raw records into
binary tiles, and the client streams them around the camera.

## Client

```
npm install
node tools/assets/fetch_textures.mjs   # once: CC0 textures from Poly Haven -> public/textures/ (17 MB)
npm run dev                            # http://localhost:5280  (needs compiled tiles, see below)
```

Streams the 256 m tiles around the camera; meshing runs in Web Workers (`src/world/meshing.js`).

- **Buildings**: OSM footprints with OSM heights and floor counts, FEMA LiDAR heights where OSM has none;
  walls in painted plaster and stucco, pastel in the neighbourhoods, white and cream on the condominium towers.
  Inside Old San Juan's walls every house gets one of the colonial city's colours, and El Morro, San
  Cristóbal and their bastions are drawn as windowless sandstone. Flat concrete roofs with water tanks; a
  few houses with metal roofs. Windows lit room by room at night.
- **Ground**: terrain, the sea traced from OSM's coastline (the Atlantic, San Juan Bay, the Condado lagoon),
  beaches, parks, mangrove, the blue adoquín cobbles of the old city, the city walls (La Muralla), and
  road surfaces generated from the OSM centrelines (`tools/pipeline/roadsurface.mjs`): each road widened
  to its lanes and sidewalks, the buildings cut out of it, then split into carriageway and sidewalk.
- **Rules of the road**: right-hand traffic. US (MUTCD) paint: double yellow centre lines, white lane and
  edge lines, continental crosswalks with stop lines on the right, PARE at stop signs, signals on the
  right-hand kerb. Speed limits read from OSM in mph.
- **Street objects** (`src/world/props.js`): coconut palms, royal palms and flamboyanes in flower among the
  shade trees, concrete utility poles with wires, street lights, signals that cycle, USPS collection
  boxes, pillar hydrants, bus stops, statues (Columbus on his column at Plaza Colón).
- **Traffic**: compacts, sedans, SUVs, pickups, delivery trucks and AMA buses.
- **Surroundings** (`far.js`): beyond the area, the rest of the island out to the horizon (the far shore of
  the bay, Cataño, Guaynabo, the mountains) as coarse terrain under a low-resolution aerial photo, over the sea.
- **Atmosphere** (`atmosphere.js`, `environment.js`): physical sky and aerial perspective placed on the globe
  at San Juan, volumetric clouds, sun shadows, ambient occlusion, bloom, day and night on San Juan's clock
  (AST, UTC−4 all year).

Drag to pan, right-drag to rotate, WASD to move, N for day/night, click a building to inspect it.
URL parameters: `?area=condado`, `?night=1`, `?time=18.5`, `?cam=x,z,distance,azimuth,elevation`, `?radius=1500`.

## Pipeline

```
npm run fetch      # raw data -> data/raw/<area>/          (a minute or two; ~300 MB for the whole municipality)
npm run compile    # data/raw -> public/tiles/<area>/      (seconds; several minutes and 2 GB of memory for the whole municipality)
npm run preview    # top-down render -> data/preview/<area>.png
npm test           # tile format round trip + checks over the compiled areas
```

All scripts take `--area=<id>` (default `sanjuan`). Areas are defined in `tools/pipeline/config.mjs` as an
origin, a bounding box and a default view:

| id | Area | Origin |
|---|---|---|
| `sanjuan` | The whole municipality, El Morro to Caimito (about 14 x 20 km, 160 000 buildings) | Plaza de Armas |
| `condado` | Condado, the lagoon and Miramar | Ashford Avenue |
| `hatorey` | Hato Rey, the Milla de Oro and Tren Urbano | Avenida Ponce de León |

`sanjuan` streams: full detail within 1 km of the point looked at (`?radius=` changes it), the buildings as
plain blocks out to 7 km, and beyond them the photo-draped ground (`far.js`), which also stands in for every
tile that is not loaded. The small areas load whole. (Old San Juan on its own, `viejosanjuan`, was an area
until the municipality took it in; its links open there.)

| Source | What we take |
|---|---|
| [OpenStreetMap](https://www.openstreetmap.org/) ([Geofabrik](https://download.geofabrik.de/north-america/us/puerto-rico.html) Puerto Rico extract) | Building outlines, `height`, `building:levels`, building parts; drivable road graph (class, lanes, one-way, speed, layer, bridge/tunnel, names); railways; coastline; parks, woods, beaches, water, trees, crossings, signals; paths, car parks, walls; named places for signs |
| [FEMA / ORNL USA Structures](https://gis-fema.hub.arcgis.com/pages/usa-structures) | Building heights (from LiDAR) and occupancy classes, for the buildings OSM gives no height or use; buildings OSM does not have |
| [AWS Terrain Tiles](https://registry.opendata.aws/terrain-tiles/) | Terrain (terrarium encoding, zoom 15; USGS 3DEP elevations on land); zoom 12 for the surroundings |
| [USGS The National Map](https://www.usgs.gov/programs/national-geospatial-program/national-map) | Orthoimagery draped over the open ground (zoom 16) and over the surroundings (zoom 13) |

OpenStreetMap comes from Geofabrik's daily Puerto Rico extract (74 MB, downloaded once a day and shared by the
areas), cut to the area and filtered in one pass by `tools/pipeline/extract.mjs` into the same files the
Overpass queries in `fetch.mjs` would give; `--overpass` queries the live data instead (split into cells for a
large area, and slow when the public servers are busy).

Puerto Rico has nothing like Japan's PLATEAU survey of road surfaces, so the compiler builds them: see
`tools/pipeline/roadsurface.mjs` (right-of-way per road class) and `roadsplit.mjs` (carriageway and sidewalk).
The terrain tiles carry bathymetry offshore; the compiler flattens the sea to 0 m inside the coastline,
levels lagoons and ponds at their lowest shore, and keeps dry land above the sea.

## Publishing

```
npm run deploy     # vite build (with the compiled areas in public/) -> force-push dist/ to the gh-pages branch
```

GitHub Pages serves that branch (Settings → Pages → Deploy from a branch → `gh-pages`, `/`). The build uses
relative URLs (`base: './'` in `vite.config.js`), so it works under `https://<owner>.github.io/<repo>/`.
The branch holds only the latest build (about 210 MB with all four areas); compile the areas before deploying.

## Compiled output (`public/tiles/<area>/`)

World frame: metres, x east, y up (above mean sea level), z south; the origin is the area's origin.

| File | Contents |
|---|---|
| `manifest.json` | origin, bounds, tile list, terrain grid description, sea level, default view, attribution |
| `t_<x>_<z>.bin` | one 256 m tile: buildings, ground surfaces (roads, paint, parks, beaches, the sea), props and wires; format in `src/shared/tileformat.js` |
| `x_<x>_<z>.bin` | a tile's landmark models (`tools/pipeline/landmarks.mjs`): the forts with their tiers, parapets and garitas, the garitas of the city walls, El Morro's lighthouse, the Capitol dome, the cathedral front, the Convention Center roof |
| `k_<x>_<z>.bin` | the buildings alone, 4 x 4 tiles to a file, drawn as plain blocks in the distance when an area streams |
| `terrain.bin` | Float32 height grid, 5 m spacing, out to the tile grid (`manifest.extent`) |
| `far.bin` | Float32 height grid of the surroundings, 128 m spacing, 12 km beyond the extent (sea below 0) |
| `roads.json` | road graph: junction nodes `[x, y, z]`, edges with polylines (road level per point) and OSM attributes |
| `rails.json` | surface and elevated railway polylines |
| `structures.json` | footbridges, station platforms and canopies |

`src/shared/` is used by both the compiler and the client.

## Attribution

Buildings, roads, coastline and places: © OpenStreetMap contributors (ODbL); a redistributed compiled area
is a derived database under the ODbL. Building heights: FEMA / ORNL USA Structures (public domain).
Elevation: USGS 3DEP via the AWS Terrain Tiles. Aerial photo: USGS The National Map (public domain).
Textures: Poly Haven (CC0). Trees: ez-tree (MIT). Original city engine: procedural-tokyo.
