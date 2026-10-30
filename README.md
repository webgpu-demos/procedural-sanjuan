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

- **Buildings**: OSM footprints with OSM heights; where OSM has no height, the height Garita measured from the
  USGS lidar point cloud, then OSM floor counts, then FEMA's;
  walls in painted plaster and stucco, pastel in the neighbourhoods, white and cream on the condominium towers.
  Inside Old San Juan's walls every house gets one of the colonial city's colours, and El Morro, San
  Cristóbal and their bastions are drawn as windowless sandstone: El Morro on its terraces stepping down to the
  sea, with its sunken plaza; the University of Puerto Rico's tower with its clock, belfry and tiled dome. Flat
  concrete roofs with water tanks; a few houses with metal roofs. Windows lit room by room at night.
- **Water** (`materials.js`, `water.js`, `reflections.js`): the trade-wind sea in waves, deep blue offshore and turquoise
  over the shallows, surf where the Atlantic reaches the shore and still water in the bay and the lagoons (a map of
  the distance to land and the openness to the ocean, made at load); the sun's glitter, and the city mirrored in it.
- **Ground**: terrain, the sea traced from OSM's coastline (the Atlantic, San Juan Bay, the Condado lagoon),
  beaches, parks, mangrove, the blue adoquín cobbles of the old city, the city walls (La Muralla); rivers,
  canals and streams in channels cut into the ground (`src/world/channels.js`), the water level from bank to
  bank and falling the way it flows (`tools/pipeline/channels.mjs`); and
  road surfaces generated from the OSM centrelines (`tools/pipeline/roadsurface.mjs`): each road widened
  to its lanes and sidewalks, the buildings cut out of it, then split into carriageway and sidewalk.
- **Rules of the road**: right-hand traffic. US (MUTCD) paint: double yellow centre lines, white lane and
  edge lines, continental crosswalks with stop lines on the right, PARE at stop signs, signals on the
  right-hand kerb. Speed limits read from OSM in mph.
- **Street objects** (`src/world/props.js`): coconut palms, royal palms and flamboyanes in flower among the
  shade trees (the trees OSM maps, and parks and woods filled out; a lawn only lightly, open ground such as El
  Morro's esplanade not at all), concrete utility poles with wires, street lights, signals that cycle, USPS collection
  boxes, pillar hydrants, bus stops, statues (Columbus on his column at Plaza Colón).
- **Traffic** (`traffic.js`, `simtraffic.js`, `fleet.js`): the simulated morning (below): every car a trip SUMO drove,
  the signal heads showing the simulation's own lights; outside the simulated hours, compacts, sedans, SUVs and
  minivans, pickups, delivery vans and AMA buses drive around the camera. The cars are the lofted bodies of mrdoob's
  [slop-newyork](https://github.com/mrdoob/slop-newyork) (MIT, `carbodies.js`): each body lofted from design tables
  (half-width, sill, shoulder, belt and crown curves along the car, rounded into the nose and tail; a glasshouse
  lofted over it; lathed tyres and alloys), every detail (glass and its seals, pillars, door seams and handles,
  headlamps with their projectors and daytime bar, tail lamps with an LED bar, grille mesh, plates with Puerto Rico's)
  painted by one material from the object-space position and normal, the edges filtered over their screen footprint
  (`carmaterial.js`). Per car: its paint, solid or metallic, chrome or blacked-out trim, a black roof now and then,
  one of four wheel designs, whose pattern turns as it goes (blurred to the rim's mean once it turns faster than the
  eye can follow); brake lights, turn signals before a turn, reversing lamps on the car you drive; a soft contact
  shadow under it; near the camera the full model (3,400 triangles), further off a ~490-triangle stand-in in the same
  material (the bus: `busbody.js`, `busmaterial.js`, white with a band in its route's colour). A car stands on its
  road's deck where the flyovers draw one under it, else on the street the tiles draw, and up onto any deck drawn too
  low over that to drive under (`roadlevel.js`); where a ramp's deck runs into the expressway's, it takes the
  expressway's level over the overlap (`mergeDecks`). The roads' asphalt is worn and repaired as San Juan's is: block
  cracking, utility-cut patches and trenches with sealed edges, tar snakes, oil drips, potholes (after slop-newyork's
  road material).
- **People on foot** (`people.js`): the sidewalks, crossings, footways and plazas walked by as many people as would be
  there at that hour (below), each one of 38 of Microsoft's [Rocketbox](https://github.com/microsoft/Microsoft-Rocketbox)
  avatars (MIT), chosen for a San Juan street: everyday clothes for the heat, office clothes in the Milla de Oro, a
  clinic's whites and scrubs, runners on the promenades at dawn, swimwear by the beach, children with a grown-up; not
  the library's winter clothes, other countries' uniforms, or headscarves and robes. Most of the library is fair;
  the same avatar is drawn with a skin tone of San Juan's (fair to dark brown) by a mask of its skin in its atlas.
  They keep right, slow behind the one in front, wait at a crossing for the simulation's lights and for a gap in the
  cars, stand at bus stops and shop doors, talk in twos and threes, sit on benches; couples, friends and families
  walk together. They stop at the kerb from the foot they are on, set off from standing, and stand up from a bench
  before they go: transitions made by NVIDIA's [MotionBricks](https://github.com/NVlabs/motionbricks) between the
  clips' own poses (`tools/motion/`). All of them are two draws (`THREE.BatchedMesh`), skinned on the GPU from a texture of every clip's
  poses, in three levels of detail.
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
The lidar tiles run to 4.6 GB for the municipality: `--save-lidar-grid=<file>` writes the grid as they leave it and
stops, and `--lidar-grid=<file>` compiles from that grid on a machine without them. An area compiled before the
lidar takes its ground with `node tools/pipeline/reterrain.mjs --area=<id>`, without compiling it again: buildings
rebased by the compiler's rule; signs, landmarks, roads, railways, footbridges and decks moved with the ground;
roads keep the levels a simulation drove in `pts0` (the manifest says `terrain.lidar.applied` and `reterrained`).
San Juan, which had it so, is compiled on the lidar again: its road graph comes out the same (every node and line
where it was, the lanes as painted), so its simulated mornings still drive on it, and `--road-levels=<roads.json>`
keeps the levels of the roads, the street-level decks and the railways from the compile before (checked shot by
shot; a profile laid on the 10 m lidar grid, which smooths an embankment's top away, stood PR-22's approaches up
to 7 m off it on walled ramps). What stands or drives on the ground takes the same triangles the tiles draw it with
(`src/shared/terrain.js` `meshHeight`).
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

A weekday morning in San Juan, 4:30 to 10:15, simulated with [Eclipse SUMO](https://eclipse.dev/sumo/) on the city's
own road graph and played back in the browser: some 230,000 car trips (seven tenths of the morning's estimated
demand) and the AMA's 500 bus trips. It opens with a title and four shots (the city before dawn, the headlights on
PR-22, one commuter's ride, the sun coming up behind the Milla de Oro: it rises about 6:19 AST in late October);
then the clock and its time line, the speed of time (the cars at their own speed by default), **free roaming** on
foot, by bike, by car and by helicopter (below: the car rides the ground or the flyover it drove onto and stops
against the buildings' walls and the simulated cars, which fade rather than drive through you), the **apagón** (at
5:45 the grid fails: windows, street lamps and every signal go dark in a wave from the Monacillos transmission
centre, and the rush is simulated without them, every dark signal an all-way stop as the law has it; it plays as a
scene of its own: the dark rolling across the city, Ponce de León and Roosevelt with its signals dead, the jam two
hours on), riding with any car (click it: where it comes from, why it drives, its delay), the jam map, the lancha
crossing to Cataño on its timetable, and plenas on the radio ("Callejón de Panderetas", "Fiesta de la Memoria" and
"Romanoctubre", made for the project with Suno, one after the other; in the apagón the radio dies with the power,
and comes back faint, a battery radio somewhere down the street). The frame rate is kept up by stepping quality down
and back up as needed (`?quality=high` keeps it all). `G` brings back the settings panel; `?xp=0` skips the
experience, `?sim=0` the simulation, `?scenario=apagon` opens the blackout.

```
npm run sim:setup                    # once: Python environment with SUMO 1.28 and libsumo (.venv-sim/)
npm run sim:data                     # Census: commuting flows, departure times, municipio boundaries
npm run sim:net                      # roads.json -> SUMO network; buildings as trip ends; FHWA counts
npm run sim:all                      # demand, buses, routes, the morning and the apagón, validated (SCALE=, RUNARGS=)
```

- **Network** (`network.mjs`): the graph in `roads.json` becomes SUMO's plain XML, the frames coinciding
  (SUMO's y is the world's -z). The expressway is given the lanes the tiles paint, as wide (four-metre lanes on
  PR-22), and a street its lanes as wide as painted; the run lists SUMO's lanes in its index, and the client
  moves each car into its painted lane (`simtraffic.js` relane). A run of roads joined end to end with nothing
  else meeting them is one SUMO edge (`net/merged.json`: run.py gives each road its speeds); junctions OSM draws
  as several nodes within 20 m are one node (netconvert cut the pieces between them to nothing: 2,907 edges under
  a metre, and a car that could not stop on one waited across the junction behind it); driveways and car parks
  (OSM's unnamed service ways) are left out, where a signal had given a car park a phase of its own. Signals
  allow right on red; where two expressway carriageways merge into fewer lanes, a zipper; a ramp joins in the lanes
  OSM gives the road (netconvert's guessed acceleration lanes, `--ramps`, widened roads past what the tiles pave);
  an expressway is made at most one lane wider than the lanes leaving its end (a toll plaza's six lanes).
- **Demand** (`demand.py`): a cordon model. Homes, jobs, schools and shops are the floor area of the city's
  buildings, by use and municipio; the ACS municipio-to-municipio commuting flows say who drives where; a
  commuter from beyond the area leaves by whichever of the roads towards their municipio the routes favour (a
  TAZ of its gates); departure times by municipio of residence (ACS B08302, the six round the area; any other as
  those six together), smoothed over the survey's half hours (`--spread=15`); school runs, errands, deliveries
  and through traffic on top. The whole morning is about 334,000 trips.
- **Routes** (`route.py`, `assign.py`): every driver re-plans on the way, every five minutes, on the travel times
  of the moment (`--reroute=1`): at half the demand, the run teleported 355 cars where the same routes driven as
  planned teleported 11,000 and locked Hato Rey from 7:30. `assign.py` (SUMO's iterative assignment on the
  mesoscopic simulation) is the other way to spread the routes.
- **Buses** (`gtfs.py`): the ATI's GTFS feed; every Tuesday bus trip in the morning with its stops placed on
  the kerb lane (never a dead end), calling at each until its timetabled departure; the Cataño ferry for the client.
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
  direction is matched to the counted line (which runs down the median of a divided road). The published run, at
  seven tenths of the demand, carried 0.48 of the counted traffic (freeways 0.40, arterials 0.59; r² 0.40), about
  seven tenths of it scaled to the whole demand, and teleported 1,286 of its 228,000 cars; at half the demand 0.42
  (328 teleported), at six tenths 0.45 (676), at 0.85 0.49 (3,119, and trips half as long again): past seven
  tenths the rush hour mostly queues longer.
  The figures for the published run are in the experience (¿Qué tan real?).
- **Experiments** run on GitHub Actions (the `simlab` branch: `simlab/jobs.json` lists the jobs, each pushes what
  it found to a branch `simres/<job>`); `hotspots.py` lists where a run teleports cars and why.

What it is not: real cars. The trips are drawn from survey data and simulated; they are checked against
counts, not recorded from traffic.

## Where people walk (`tools/pipeline/walkways.mjs`, `tools/assets/`)

```
node tools/pipeline/walkways.mjs --area=<id>                  # the walks of a compiled area -> public/tiles/<id>/walks*
python tools/assets/crowd.py <Rocketbox Assets> <avatar> f|m <out> <id>   # an avatar for the crowd (Blender's bpy)
node tools/assets/crowd_pack.mjs <out>                        # -> public/models/people/crowd/ (gltfpack)
```

- **The network**: every street's sidewalks, measured on the compiled tiles (from the centreline out to the kerb,
  then across the paving), the corners where neighbouring streets' sidewalks meet, a crossing across each street's
  mouth at a junction (on OSM's zebra where it maps one; at the lights where the junction has them), OSM's
  mid-block crossings, its footways, paths, steps and pedestrian streets (their loose ends joined to the nearest
  walk). A street of houses without a sidewalk is walked at its edge; the inner side of a divided road is a median,
  crossed, not walked. Old San Juan's narrow streets are walked as streets.
- **How many**: from what stands along each stretch (OSM's shops, cafés, bars, offices, schools, clinics, sights and
  bus stops; the floor area of the buildings by their use; the beach; the historic district), as people per 100 m
  at the busiest hour of each kind (shops, offices, sights, bars, schools, buses, homes, clinics, the beach and the
  parks), each kind with its own day (`src/world/people.js` `DAY`). An estimate, scaled to a few places: about 20 on
  Calle Fortaleza at its busiest, 10 on Ashford, 6 on the Milla de Oro, under one on a street of houses. Not a count.
- **Where they stop**: bus stops (and their shelters' benches), benches, shop doors and cafés, bars at night.
- In blocks of 1 km (`walks/<x>_<z>.bin`, listed in `walks.json`), loaded round the view. `npm run walks -- --area=<id>`
  after a compile (which clears the area's folder). A bridge's sidewalks, which the tiles do not pave (the deck is
  drawn on its own), are put where the street's would be; footbridges are left out (people would walk under them).
  The municipality's walks come in a few large pieces (the expressways and the bay part them).
- **The people** (`public/models/people/README.md`): `crowd.py` cuts a Rocketbox avatar's skeleton to the 22 bones a
  walk moves, makes its three levels of detail and its atlas (`crowd_atlas.py`: the skin found by its colour against
  the face's and the hair's, and marked in alpha), and retargets the clips; `crowd_pack.mjs` keeps one set of clips for
  the women and one for the men (the retargeting gives every avatar of either the same rotations) and compresses the
  rest. In the client every avatar's every clip is baked into the pose texture on its own skeleton.
- **The crowd's transitions** (`tools/motion/transitions.py`): NVIDIA's MotionBricks (SIGGRAPH 2026; code Apache-2.0,
  the model under the NVIDIA Open Model Agreement) fills the motion between 4 poses of one clip and 4 of another. It
  runs here on the CPU (`mbcpu.py`: the model's own encoding and decoding, Warp kernels, with ONNX Runtime in place of
  TensorRT; about 0.15 s a generation on two cores). `rig.py` carries the crowd's Rocketbox clips onto the model's
  SOMA skeleton and the result back (each bone turned as the joint it stands for, the two rest poses aligned bone by
  bone; the hips scaled by the hip heights): setting off (idle to walk), stopping from either foot (walk to idle),
  standing up (sit to idle), as `<sex>-moves.glb` (the pelvis's travel kept: the client carries the person along it).

  ```
  pip install onnxruntime warp-lang usd-core scipy
  git clone https://github.com/NVlabs/motionbricks; cd motionbricks; git lfs pull   # (the ONNX models, the SOMA skeleton)
  python tools/motion/transitions.py <motionbricks> <motionbricks>/motionbricks/assets/onnx/soma/mmm_v6_soma_fp32.onnx <crowd.py output>
  ```

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
| `x_<x>_<z>.bin` | a tile's landmark models (`tools/pipeline/landmarks.mjs`): the forts with their tiers, parapets and garitas (El Morro's terraces and sunken plaza), the garitas of the city walls, El Morro's lighthouse, the Capitol dome, the cathedral front, the Convention Center roof, the UPR tower |
| `k_<x>_<z>.bin` | the buildings alone, 4 x 4 tiles to a file, drawn as plain blocks in the distance when an area streams |
| `terrain.bin` | Float32 height grid (5 m spacing; 10 m for the municipality), out to the tile grid (`manifest.extent`) |
| `far.bin` | Float32 height grid of the surroundings, 128 m spacing, 12 km beyond the extent (sea below 0) |
| `roads.json` | road graph: junction nodes `[x, y, z]`, edges with polylines (road level per point) and OSM attributes |
| `rails.json` | surface and elevated railway polylines |
| `structures.json` | footbridges, station platforms and canopies |
| `walks.json`, `walks/<x>_<z>.bin` | where people walk, in blocks of 1 km: sidewalks, corners, crossings, footways; people per 100 m by kind of day; bus stops, benches, shop doors (`tools/pipeline/walkways.mjs`) |
| `channels.json` | rivers, canals, streams and ditches: per stretch its kind, width, end flags and line with the water's level (`tools/pipeline/channels.mjs`) |

`src/shared/` is used by both the compiler and the client.

## Attribution

Buildings, roads, coastline and places: © OpenStreetMap contributors (ODbL); a redistributed compiled area
is a derived database under the ODbL. Building heights: FEMA / ORNL USA Structures (public domain).
Elevation: USGS 3DEP via the AWS Terrain Tiles. Aerial photo: USGS The National Map (public domain).
Textures: Poly Haven (CC0). Trees: ez-tree (MIT). People: Microsoft Rocketbox (MIT; `public/models/people/README.md`), their transitions made with NVIDIA's MotionBricks. Cars, the bus and the asphalt's wear: after mrdoob's slop-newyork (MIT). Original city engine: procedural-tokyo.
