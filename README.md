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
- **Water** (`materials.js`, `water.js`, `reflections.js`): the trade-wind sea in waves, deep blue offshore and turquoise
  over the shallows, surf where the Atlantic reaches the shore and still water in the bay and the lagoons (a map of
  the distance to land and the openness to the ocean, made at load); the sun's glitter, and the city mirrored in it.
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
- **Traffic**: the simulated morning (below): every car a trip SUMO drove, with its brake lights, its
  lamps on the road at dawn, the signal heads showing the simulation's own lights. Outside the simulated
  hours, compacts, sedans, SUVs, pickups, delivery trucks and AMA buses drive around the camera.
- **Surroundings** (`far.js`): beyond the area, the rest of the island out to the horizon (the far shore of
  the bay, Cataño, Guaynabo, the mountains) as coarse terrain under a low-resolution aerial photo, over the sea.
- **The city from afar at night** (`nightroads.js`, `far.js`): the streets of the whole area drawn into a map of light the
  distant ground wears, sodium on the avenues and white on the back streets, pools under the lamps nearer.
- **Atmosphere** (`atmosphere.js`, `environment.js`): physical sky and aerial perspective placed on the globe
  at San Juan, volumetric clouds, sun shadows, ambient occlusion, bloom, day and night on San Juan's clock
  (AST, UTC−4 all year).

Drag to pan, right-drag to rotate, WASD to move, N for day/night, click a building to inspect it.
URL parameters: `?area=condado`, `?night=1`, `?time=18.5`, `?cam=x,z,distance,azimuth,elevation`, `?radius=1500`.

## Garita, the island above it (`src/shared/twin.js`)

This city is the street view of [Garita](https://github.com/webgpu-demos/garita), the island-wide twin: Garita opens
a building or a place in the municipality here, and a building clicked here opens in Garita.

- `?ll=lat,lon[,distance,azimuth,elevation]` opens the view on a place by its coordinates (latitude first) instead of
  `?cam`'s world metres, and goes straight there, past the opening (`?xp=1` keeps it). Outside the area, the area's
  own view.
- `?sea=1.5` raises the sea to that level in metres above mean sea level, Garita's sea-level scenario: the sea's
  surface over every point of ground below it, its shallows and surf along the new shore, and a line at the top of
  the screen saying so. It is Garita's bathtub, not a flood model: ground below the level is under water whether or
  not the sea can reach it.
- `?from=garita` adds a way back (top centre, *← Garita*), to the place in view.
- Click a building: *Este edificio en Garita ↗* opens Garita over it with `?pick=lon,lat` (the point clicked, half a
  metre inside the wall), which pins the footprint there, with the raised sea if there is one. Where the compile had
  Garita's tiles, the link also carries `?bld=<GERS id>`, and Garita pins the building by its id first.
- `?bld=<GERS id>` with `?ll=` (as Garita's street-view link sends it): the building with that id near the place is
  the one picked here, and the way back carries it.

Both twins name a building by its Overture GERS id. `npm run fetch` takes Garita's building tiles over the area
(`tools/pipeline/garita.mjs`; `--garita=<site or directory>`, `--no-garita`), and the compile gives each OSM building
the GERS id Garita carries for it (a `building:part` its outline's; a FEMA-only building the id of the Garita
building under it), and Garita's height where Garita measured it in the lidar point cloud (an OSM `height` tag still
wins over it; building:levels and the FEMA average do not). `t_x_z.ids` beside each tile has `<gers>,<osm>` per
building in tile order; the client fetches it when a building is clicked, and the HUD shows both ids. An area
compiled before this (its simulated runs are made on its roads, so recompiling it means simulating again) gets the
ids without a new compile: `node tools/pipeline/ids.mjs --area=<id>` gives each building the ids of the Garita
building under it (on Condado: the same GERS id as the compiler's for 99.6 % of buildings).

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
| [USGS 3DEP 1 m lidar DEM](https://www.usgs.gov/3d-elevation-program) (project `PR_PuertoRicoUSVI_D24`, flown 2023-25) | The ground of the area itself: each terrain cell the mean of the 1 m lidar cells inside it, where at least half hold data (the terrain tiles stand in elsewhere); `tools/pipeline/lidar.mjs` |
| [USGS The National Map](https://www.usgs.gov/programs/national-geospatial-program/national-map) | Orthoimagery draped over the open ground (zoom 16) and over the surroundings (zoom 13) |

OpenStreetMap comes from Geofabrik's daily Puerto Rico extract (74 MB, downloaded once a day and shared by the
areas), cut to the area and filtered in one pass by `tools/pipeline/extract.mjs` into the same files the
Overpass queries in `fetch.mjs` would give; `--overpass` queries the live data instead (split into cells for a
large area, and slow when the public servers are busy).

Puerto Rico has nothing like Japan's PLATEAU survey of road surfaces, so the compiler builds them: see
`tools/pipeline/roadsurface.mjs` (right-of-way per road class) and `roadsplit.mjs` (carriageway and sidewalk).
The terrain comes from the 1 m lidar DEM wherever it covers the area (`npm run fetch` downloads its 10 km tiles,
about 130 MB each: 2 for Condado, 6 for the municipality; `--no-lidar` skips them). The terrain tiles' 10 m surface
lies on the coastal plain in flat terraces at whole metres and carries the expressway's overpasses as ridges; the
lidar ground is bare earth, buildings and bridges removed. The compiler logs the share of the grid it covered and the
share of land cells sitting on a whole metre before and after, and the manifest says (`terrain.lidar`).
The terrain tiles carry bathymetry offshore; the compiler flattens the sea to 0 m inside the coastline,
levels lagoons and ponds at their lowest shore, and keeps dry land above the sea.

## Free roaming (`src/hud.js`, `src/world/drive.js`, `src/world/player.js`)

"Explorar libremente", or the end of the opening, leaves you in the city with a game's heads-up display, after
mrdoob's [Slop New York](https://github.com/mrdoob/slop-newyork) (MIT):

- **Ways round** (`1`–`5`): Explorar (the map's camera); Caminar (W S walk, A D turn, Shift run, Space jump: the
  walker is a man of Microsoft's [Rocketbox](https://github.com/microsoft/Microsoft-Rocketbox) avatars, MIT, with
  his own idle, walk and run, each played at the pace that keeps his planted foot still; see
  `public/models/people/README.md`);
  Bici (W pedal, S brake, A D steer, Shift sprint: it leans into the turns; the same man rides it, seated, his
  feet and hands put on the pedals and the bars by inverse kinematics);
  Manejar (W A S D, Space the handbrake, Shift a push); Volar, a helicopter (W S, A D, Space up, C down, Shift a
  push; it cannot fly through the towers, and by night it lights the street with its searchlight). `E` gets out
  of the car on foot, by the driver's door (the car stays parked where it stopped), and back in; `Esc` goes back
  to exploring. The one you are is lit by the street lamps it passes under.
- **Running into things** (`src/world/collide.js`): every solid thing is a capsule, a segment on the ground and a
  radius round it (a pole or a trunk a point; a car, a parked car, a bench, a bus shelter along its axis). The
  walker, the bike and the car stop against the buildings' walls, the street's things and every vehicle (the
  simulated cars near you, the procedural traffic, the car you left), sliding along them on foot. The procedural
  traffic stops behind you and behind your parked car; the simulated cars, which keep to their recorded way,
  fade out before they would touch either.
- **Nothing in the lanes** (`src/shared/roadway.js`): as a tile loads, a street light, pole, tree or piece of
  furniture on the paved carriageway, or within reach of a car in a road's outer lane, is left out (a signal
  mast steps back along its approach instead); `node tools/audit/roadway.mjs` counts them (about 2,100 of
  460,000 props across San Juan).
- **On the paving, not in it**: each tile's worker rasterises how high its surfaces stand over the terrain (a
  sidewalk 20 cm, a carriageway 6, an island 22; `streamer.lift`), and the walker, the bike and the car stand on
  that, up a kerb and down again.
- **The expressway's height** (`src/shared/profile.js`): the elevation model has the overpasses crossing the
  expressway in it, and the compiler lifts every expressway bridge a flyover's clearance even over its own
  embankment; both made humps of walled ramp over a road that runs on the ground (PR-22 in the opening). As
  roads.json loads, an expressway bridge on its embankment runs level from bank to bank, the rest of the
  expressway takes its ground from a low percentile of the terrain round it, and the 6% grade is laid over again
  (a ramp still climbs to every true flyover); the simulated cars driven over an old hump are put on the road.
  Flyover and footbridge piers stand clear of the lanes below them (moved along or across the deck, or left out).
- **Cameras** (`V`): chase, close, first person, cinematic.
- **The time of day**: dawn, rush hour, noon, dusk, night (the simulated cars from 4:30 to 10:15; outside the
  run, the procedural traffic).
- **Ir a** and **Mapa** (`M`): places of San Juan; the full map pans and zooms, and a click goes there. The
  minimap shows the roads and the simulated cars round you, and Puerto Rico's green street-name signs say where
  you are.
- **Touch**: a thumbstick where the left thumb lands, and the buttons of the way in use.
- Where you were, and how, is kept for the next visit (localStorage). `H` hides the HUD, `N` the sound.

## The simulated morning (`tools/sim/`)

A weekday morning in San Juan, 4:30 to 10:15, simulated with [Eclipse SUMO](https://eclipse.dev/sumo/) on the
city's own road graph and played back in the browser: some 360,000 car trips and the AMA's 520 bus trips. It
opens with a title and four shots (the city before dawn, the headlights on PR-22, one commuter's ride, the sun
coming up behind the Milla de Oro: it rises about 6:19 AST in late October); then the clock and its time line,
the speed of time (the cars at their own speed by default), **free roaming** on foot, by bike, by car and by helicopter
(below: the car rides the ground or the flyover it drove onto and stops against the buildings' walls and the
simulated cars, which fade rather than drive through you), the **apagón** (at 5:45 the grid fails: windows, street lamps and every signal go dark in a
wave from the Monacillos transmission centre, and the rush is simulated without them, every dark signal an
all-way stop as the law has it; it plays as a scene of
its own: the dark rolling across the city, Ponce de León and Roosevelt with its signals dead, the jam two hours
on), riding with any car
(click it: where it comes from, why it drives, its delay), the jam map, the lancha crossing to Cataño on its
timetable, and plenas on the radio ("Callejón de Panderetas", "Fiesta de la Memoria" and "Romanoctubre", made
for the project with Suno, one after the other; in the apagón the radio dies with the power, and comes back
faint, a battery radio somewhere down the street). The frame rate is kept up by stepping quality down and back
up as needed (`?quality=high` keeps it all). `G` brings back
the settings panel; `?xp=0` skips the experience, `?sim=0` the simulation, `?scenario=apagon` opens the blackout.

```
npm run sim:setup                    # once: Python environment with SUMO 1.28 and libsumo (.venv-sim/)
npm run sim:data                     # Census: commuting flows, departure times, municipio boundaries
npm run sim:net                      # roads.json -> SUMO network; buildings as trip ends; FHWA counts
npm run sim:demand                   # the morning's trips (data/sim/<area>/morning/trips.xml)
npm run sim:run                      # simulate and record -> public/tiles/<area>/sim/morning/
npm run sim:run -- --scenario=apagon # the blackout, from the morning's state at 5:45
npm run sim:validate                 # simulated vs counted traffic (GEH) -> validation.json
```

- **Network** (`network.mjs`): the graph in `roads.json` becomes SUMO's plain XML, the frames coinciding
  (SUMO's y is the world's -z), so simulated lanes lie on the painted ones; netconvert joins the junctions
  OSM draws as several nodes and gives the mapped signals fixed plans.
- **Demand** (`demand.py`): a cordon model. Homes, jobs, schools and shops are the floor area of the city's
  buildings, by use and municipio; the ACS municipio-to-municipio commuting flows say who drives where;
  commuters from beyond the area enter through the roads that cross its edge, towards their municipio,
  biggest roads first; departure times by municipio of residence (ACS B08302); school runs, errands,
  deliveries and through traffic on top.
- **Network fixes that made the rush hour flow** (measured on a quarter of the demand, 7:00-7:15: waiting time
  down five-fold): acceleration lanes on the expressway ramps, junctions OSM draws as several nodes joined,
  actuated signals, and San Juan merging (a driver at a give-way line takes a smaller gap after 90 s). And lane
  drops: OSM draws a toll plaza as stretches of five or six lanes, and SUMO leaves the lanes beyond a narrowing
  as dead ends drivers must leave at walking pace (PR-22 at Buchanan, six lanes into two and an exit, locked the
  west of the city at the rush); an expressway is made at most one lane wider than the lanes leaving its end.
- **Routes** (`route.py`): made beforehand with contraction hierarchies on the travel times a previous run
  measured (a step towards the routes drivers settle on). Re-planning during the run is an option
  (`--reroute=0.15`), off by default: SUMO then spends most of its time waiting (6.7x slower measured).
- **Buses** (`gtfs.py`): the ATI's GTFS feed; every Tuesday bus trip in the morning with its stops placed on
  the kerb lane, calling at each until its timetabled departure; the Cataño ferry for the client.
- **Simulation and recording** (`run.py`): microscopic, every car with its own car-following and continuous
  lane changes. Each car's track is kept to the fewest points that hold it within 30 cm sideways and 1.5 m
  along its way of where SUMO had it at every second, and packed into gzipped windows of two and a half minutes
  (`w_<t>.bin.gz`, decoded in a worker; in columns, each step stored as what is left after guessing it from
  the step before, a third smaller than packed as rows), with the road speeds (`speeds.bin`), every signal's changes
  (`signals.json`) and why each car drives (`trips.bin`). The apagón starts from the morning's saved state
  and switches every signal to SUMO's `off` program, on a copy of the network whose dark signals are all-way
  stops (`--dark=priority` keeps netconvert's priorities instead).
- **Validation** (`validate.py`): the cars SUMO sends along each road FHWA counts (HPMS 2024), 7 to 8 a.m.,
  against the count's peak hour (AADT x 0.08), scored with the GEH statistic; the main carriageway in each
  direction is matched to the counted line (which runs down the median of a divided road). A run at a quarter
  of the demand carried 0.30 of the counted traffic (freeways 0.25, arterials 0.38; r² 0.43), which is what
  set the demand at 0.8. The figures for the published run are in the experience (¿Qué tan real?).

What it is not: real cars. The trips are drawn from survey data and simulated; they are checked against
counts, not recorded from traffic.

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
