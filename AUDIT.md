# Audit, November 2026: what was fixed and what is left for you

Two passes. The audit (branch `audit-pass`, PR #48) fixed what the browser code could fix. The pipeline pass
(branch `pipeline-pass`) fixed the compiler and the simulation tooling, recompiled the three areas, re-ran the
morning and the apagón on GitHub Actions on the new roads, and published tiles, runs and code together.

This checkout deploys again. The runs in `public/tiles/sanjuan/sim/` were driven on these tiles' `roads.json` (its
sha1 is in each run's index), and `tools/deploy.sh` refuses a run made on other roads and a working tree with
uncommitted changes. The build that was live before is kept as the local branch `gh-pages-before-pipeline`.

## Pipeline pass

### What it changed
- **Compiler** (`tools/pipeline/`): `--road-levels` keeps an earlier compile's levels on structures only, and
  ordinary streets take this compile's ground. Skywalks and raised parts keep `min_height` (flag `BFLAG.RAISED`):
  no walls below the base, an underside, a skywalk's base at least 4.5 m over the highest ground under it; your car
  and people on foot pass under anything 2.5 m up (`drive.js` `Walls`). Paint is clipped at the kerb and under
  every sidewalk, and car-park bays are not laid across a sidewalk. Untagged two-way main roads take the lanes
  that fit between the walls (2 to 4). Invented ads are centred on the Milla de Oro, not the Plaza de Armas.
  Expressway stretches narrower than what joins them are widened (`pinches.mjs`: 8 in San Juan, among them
  PR-18 into PR-22 at Hato Rey, 2 → 4). `rebuild.sh` runs the compile and every tool that writes into the area.
- **Simulation** (`tools/sim/`): trips from and to places in the area set off from the kerb standing and pull in
  to the kerb; gate trips still come and go at speed. `checknet.py` fails a network with a junction link that
  starts behind its lane (0 of 84,979; the old net had 22). One table of vehicle and lane sizes
  (`src/shared/vehicles.json`) for SUMO and the client; the truck had been simulated at 7.0 m and drawn at 5.9 m.
  `run.py` splits short jam teleports itself. The network and the run record the `roads.json` they were made on.
- **Client**: where SUMO has more lanes than the paint, cars side by side are drawn at least 2.5 m apart; on a
  two-way street whose lanes are split unevenly (Calle Notre Dame: 1 north, 3 south), SUMO's road is moved across
  onto the middle of the paving, where its outer lane had been pushed into the next; ez-tree's
  unused textures are left out of the bundle (main JS 5.6 MB → 1.6 MB); in development, the console says when a
  run was made on other roads; `@takram/three-geospatial-effects` and `libsumo` are gone, `sumolib` is pinned.

### Gates
Live before = the site as it was (tiles of 2026-10-26/28, run P1). San Juan unless named.

| Measure | Live before | Now | Must be |
|---|---|---|---|
| At-grade road points over 0.5 m off the terrain | 0.06% (81% on this checkout's old compile) | 0.03%; Condado 0.2%, Hato Rey 0.01% | under 2% |
| Skywalks across a road | 2: one removed, one solid | both raised, 4.6 m clear | 0 solid |
| Paint marks under a sidewalk (0.05 m² or more) | 5,113; Condado 386, Hato Rey 355 | 0 in all three | 0 |
| Invented ads the client hides | 116 of 138 | 0 of 67 | 0 |
| House fronts inside a driven lane | 3,272 (major roads 90) | 2,940 (76); Condado 132, Hato Rey 213 | reported |
| Junction links starting behind their lane | 22 (old net) | 0 of 84,979 | 0 |
| Roads where SUMO has more lanes than the paint | PR-18 and PR-22 clusters | 0 (16 one-way roads have fewer, 2.6 km) | 0 |
| Inside-origin cars starting above 5 m/s | 93% (median 41 km/h) | 0.2% (median 11 km/h, first second) | under 5% |
| Morning teleports / share of counted traffic | 1,410 / 0.45 | 1,433 / 0.453 | at most 2,000 / at least 0.43 |
| Cars still on the road at 10:15 | 1,388 | 1,215 | at most 2,000 |
| Drawn overlaps at PR-18, 7:30 (10 checks) | 93 (SUMO's own: 18) | 52 (SUMO's own: 52) | SUMO's own + 5 |
| Frame cost, benchmark views | see below | at or under the audit's in seven; morning +2.3% | within 3% |
| Site size | 802 MB | 908 MB (as `tools/deploy.sh` measures it) | under 980 MB |
| `npm test`, live page with no errors | pass | pass; the production build (`vite preview`) plays the intro with no errors, stalls or GL errors | pass |

House fronts: the lane fit set 4 of 320 untagged streets to two lanes; the rest measure 18 to 40 m between walls,
so 4 lanes fit. What is left is single buildings standing forward of their neighbours, scattered, and partly the
lane width now being 3.0 m as in SUMO (it was 3.2 m in `roadway.js`).

Frame cost (`tools/render/views.mjs`, GPU time to the end of the frame, ms): opening 20.6 → 20.8 (median of three
loads; single loads gave 19.0 to 25.3), oldsj 18.3 → 17.1, condado 27.7 → 23.9, hatorey 26.4 → 23.3, expressway
25.3 → 23.5, morning 25.6 → 26.2 (median of three: 25.6, 26.2, 26.2; on the new run), night 23.2 → 23.4, sunset
22.1 → 18.8. Errors 0.

The run is job Q1 (`simres/Q1`). Q2, the same with cars arriving at 3 m/s instead of stopping, came out worse:
1,535 teleports, 1,869 cars on the road at 10:15, the same 0.45. Gate trips still enter at speed (median 14 km/h
in their first second) as they should. The intro, every shot frame by frame (`tools/audit/intro.js`), against the
live site: steps in a car's speed 610 → 534, of over a metre 8 → 4 (one bus at a stop), heights 7,118 → 6,505,
headings 4,203 → 4,280, bodies inside one another 5 → 3; stalls, blinks and GL errors 0 in both.

The apagón is job B2 (`simres/B2`), from Q1's morning: 788 teleports (live A1: 782), 0.41 of counted traffic (0.41),
r² 0.43 (0.40), at most 30,969 cars on the road at once. At PR-18 at 7:30 the drawing adds 1 overlap to SUMO's own
75 (live: 21 to 48); the rest is the ramp merge below. (B1, the same job, ran but brought nothing back: its clone URL
held the job's token, `set -x` logged it and the first progress push published it, and every push after that was
refused. `simlab` now clones without a token, scrubs any from what it pushes and keeps the results as an artifact.)

## The audit (PR #48): fixed, measured where a number is given

### Cars
- **Procedural traffic** (`src/world/traffic.js`, largely rewritten). Over 1,500 frames:
  - Hato Rey: jumps 176 → 0, heading snaps 228 → 0, respawns in view 23 → 0, lateral over 8 m/s² 319 → 0.
  - PR-18/PR-22 interchange: jumps 491 → 0, snaps 1,987 → 0, lateral over 8 m/s² 3,138 → 3.
  - Baldorioty: respawns in view 44 → 0.
  - How: real curves through bends and turns; lane choice by side (right turns from the kerb); lane drops merged before the node; anticipation of slower roads ahead; yellow taken only when the car cannot stop; braking that stops from expressway speed; expressway merges no longer treated as junctions; rear-axle steering; cars respawn out of view; turn signals held through the turn.
- **Simulated cars** (`simtraffic.js`, `simworker.js`). Over 600 frames of rush hour on Baldorioty (this checkout's run): near pops 32 → 0, blinks 19 → 0.
  - Cars carried across the 150 s window boundary no longer fade out and back in. This had hit about a quarter of the cars every 2.5 simulated minutes.
  - Cars are drawn centred on the car, not on SUMO's front-bumper point, so noses no longer overhang stop lines and buses no longer sit inside the car ahead.
  - Jam teleports of 9–50 m in a second are split into a fade out and a fade in (`unlunge`).
  - The one-second dips to 20 km/h on Las Américas and PR-1 are smoothed: 139 → 0 in the 7:30 window, 0 left in the windows checked (`undip`). They came from backward junction links in the SUMO network, which the pipeline pass removed (`undip` stays as a guard).
  - Height steps ease out fully.
  - Standing cars face the way they came.
  - Wheels turn on the simulation clock.
  - The model-to-box hand-over no longer leaves holes.
  - Far cars are skipped by day.
  - Stale window requests are cancelled.
- **Your car** (`drive.js`): a grip limit (no 8 g U-turns), braking at about 1 g, no speed cut when Shift is released, settling that no longer depends on frame rate, pitch from the street or deck under it, and flyover parapets that hold.
- **Trains** run on the simulation clock while it runs. **The ferry** turns round at the pier instead of flipping in a frame, and has no speed step.

### Buildings and roads
- 241 buildings in San Juan, 13 in Condado and 18 in Hato Rey had a street-level road through them; there are now 0. 86 + 8 + 6 were taken out and the rest notched, with paving laid in the slots. Done by `tools/pipeline/clearroads.mjs` (flag `BFLAG.NO_SOLID`, which `meshing.js` honours). The compiler applies the same rule (`tools/pipeline/roadclear.mjs`) on the next compile.
- Places to look:
  - `?ll=18.416308,-66.078311`: Avenida FDR. An 809 m² FEMA building was removed from the carriageway.
  - `?ll=18.388348,-66.069973`: Paseo de las Ciencias, notched.
  - `?ll=18.359540,-66.110539`: Calle José R. Carazo, a building passage now paved through.
- `npm run compile` now refuses to delete an area's `sim/` without `--force`.

### Picture
- SMAA edge smoothing, in gamma space, as its own final pass. The old `antialias: true` only smoothed the one full-screen triangle.
- N8AO no longer renders the scene twice more each frame for "transparency".
- Shadows:
  - Snapped to texels in the light's frame, so they no longer crawl while panning.
  - They fade out at the edge of the shadow map instead of stopping at a square line.
  - Redrawn every 3, 6 or 12 frames by extent, instead of every third frame at any zoom.
- Normal maps on walls and ground had their green channel inverted, so grooves read as ridges; fixed.
- Precision and sampling:
  - The near plane follows the camera's height, which fixes z-fighting in map views.
  - Park, wood, path and pitch layers are set apart in height.
  - The road outline is no longer drawn under the carriageways.
  - Reflection and star derivatives are taken before any early return, so pane edges no longer speckle.
  - Anisotropic filtering on the far ground photo and the night-roads map.
  - Motion blur no longer smears for one frame when it switches back on.

### Performance and memory
- Distant buildings have levels of detail. Small houses drop beyond 2.5 km and mid-size buildings beyond 4.5 km, scaled by the frame-rate governor.
- The surrounding island and the deck lamps are cut into pieces, so they are culled by view and distance.
- Tile meshes free their JavaScript copies once on the GPU: about 130–155 MB of heap around Hato Rey.
- Texture-array pixels and the PMREM target are released.
- An empty fleet level no longer uploads its whole buffer every frame.
- Signal-head slots are reused instead of growing with every tile build.
- The hidden technical readout is not rebuilt every frame.
- A click raycasts only facades.
- Start-up fetches run in parallel: textures with the manifest, and the sim's signals, speeds, ferries and the structures file early.
- Flat varyings are gone (the crowd's GPU-memory blow-up on ANGLE/Metal).
- Governor:
  - It waits for streaming to finish after a step up.
  - Its retry wait decays.
  - The AO checkbox really disables the pass.
  - Edge smoothing is the first thing it drops.

### Interface and the rest
- A saved place is validated before it is used, so a bad one no longer opens black.
- Keys are cleared on a mode change, so touch buttons no longer stick.
- Mode keys are ignored under the title screen.
- The readout and README name the right keys (N is sound, not day/night).
- `tools/synth/export.mjs` uses the dev server's port, 5280.
- `.gitignore` describes San Juan's sources and ignores `data/tiles-backup/`.
- Touch buttons send their key-up, and held buttons let go on a mode change. HUD keys are dead under the title and the intro. The time slider no longer keeps the keyboard. A clicked checkbox in the panel no longer blocks E and G either.
- The full map's empty "Ir a" button is hidden. The minimap canvas is no longer reallocated every frame.
- Text:
  - "hora pico" throughout, and the hints say "Girar".
  - Clean view (H) also hides the stats and the story.
  - The in-app credits match what ships, and the READMEs say 39 avatars.
  - The README describes the apagón scene that plays: Avenida 65 de Infantería, then the jam map an hour and a half on.
- The intro:
  - Skipping it during a black load no longer takes the camera back seconds later.
  - Switching scenario mid-switch is safe, and old caption timers are dropped.
  - The fixed morning date holds outside the intro too.
- The radio dies with the power in the apagón and comes back with it. Before, the blackout's automation was cancelled in the frame it was scheduled.
- Far flamboyanes stay red instead of turning green. Power lines fade out before their tile hides them instead of popping at a third opaque.
- The font stylesheet no longer blocks first paint.

### People on foot (`people.js`)
Measured by replaying the crowd headless, before → after:
- Spots no longer die. Benches and bus stops held 26 people falling to 1 over 12 minutes, with 21 spots stuck as taken; now 47 → 42, with none stuck. People no longer sit two to a seat.
- No more teleports when leaving a spot or at sharp joints:
  - The largest step in a frame fell from 3.6–3.8 m to 0.05 m.
  - Steps over 0.12 m fell from 8,543 to 5 in 7.7 million.
  - People leave a seat by walking to their path, or wait until unseen.
- People standing up no longer get NaN positions (30 → 0).
- The detailed model holds out to 40 m, with a ±10% band, instead of switching at 24 m every few frames (91 flips → 0).
- Each avatar strides with its own leg length, so children's feet no longer slide.
- The avatar bake yields between avatars. The longest stall at the title fell from 472 ms to 85–139 ms.
- Checked in a page at Calle de la Fortaleza: 1,045 people over 450 frames, 0 NaN, largest step 0.21 m, no errors.

### Measured: frame cost of the benchmark views (the audit)
GPU time to the end of the frame, in ms, from `tools/render/views.mjs` at 1280×720 on this M3. Side-by-side pictures are in `data/renders/views/audit-before-vs-audit-after/`. Errors are 0 in every view.

| View | Before (ms) | After (ms) | Triangles, before → after |
|---|---|---|---|
| opening | 22.7 | 20.6 | |
| oldsj | 17.9 | 18.3 | |
| condado | 31.9 | 27.7 | 4.7 M → 3.3 M |
| hatorey | 30.0 | 26.4 | |
| expressway | 25.8 | 25.3 | |
| morning | 28.3 | 25.6 | 4.6 M → 2.6 M |
| night | 23.2 | 23.2 | (JS heap 1,145 → 862 MB) |
| sunset | 21.8 | 22.1 | |

`views.mjs` still forces `people=0`, a leftover from the crowd's old GPU-memory blow-up, so these numbers leave the crowd out.

## For you to review

### Left from the pipeline pass
1. **House fronts in a driven lane** (2,940 in San Juan, above): single buildings standing forward of the line of
   their street. Narrowing a street for one building would make the lane wrong for the rest of it; notching the
   building (as `roadclear.mjs` does for centrelines) is the other way, and changes buildings people know.
2. **Trees past 1 km.** Keeping a crown of 20 triangles for every tree past `FAR_SMALL` cost 1.8 ms a frame in the
   opening's view and 0.9 ms at night, measured in-page in interleaved blocks; batched into one draw per tile it
   cost as much (the cost goes with the 6,500 crowns, under a pixel each, not with draws or shading). It was taken
   back out. Tree cover painted into the far ground's colour (`far.js`, from the props' tree density) would keep
   the green at no cost per frame.
3. **Condado and Hato Rey** were compiled without `--road-levels` (their road graphs differ from the live ones), so
   their decks and flyovers take this compile's profile; they have no structures tuned shot by shot.
4. **`sharp`** is still in devDependencies and imported by nothing in the repository.

### Cars still drawn inside one another in jams
At PR-18 in the 7:30 jam, 52 cars are drawn inside another (53 on another load), and SUMO has the same so. Of the
first 16 located, 15 are at one merge (x ≈ 5,220, z ≈ 6,420): the PR-18 ramp (way 22221833) joins Avenida Piñero over its last 75 m, and
netconvert lays the ramp's lane on Piñero's right lane for that stretch (their centre lines 0.1 m apart), so SUMO
queues cars on both, each blind to the other. The fix is in the network: cut the junction back where two ways meet
at a slant (`network.mjs`, or netconvert's junction shape at that node), then a new run. The other 45 drawn on the
first measure were the drawing's (`roadlevel.js` fit pushing Calle Notre Dame's outer lane into the next) and are
fixed.

### Decisions
1. **`covered=yes` roads** notch the building over them, though the road really runs under it. The largest case is a 245 m cut through the Mall of San Juan's car park (`?ll=18.412099,-66.024036`). The thresholds are judgment calls too: keep at least 35% of a building (50% for low ones), and count a road from 0.5 m in.
2. **Trees vanish beyond about 1 km** (500 m at the lowest detail). Tried in the pipeline pass and measured too dear; see "Left from the pipeline pass", 2.
3. **Tokyo/PLATEAU leftovers.**
   - `tower.js` and the `surfaces`/photo-roof path in `streamer.js`, `meshing.js` and `materials.js`. The `aPhoto` attribute is on every building vertex (about 10 MB CPU and 10 MB GPU around Hato Rey) and costs a texture fetch per facade fragment.
   - Vending, shrine, torii and rail-crossing props with no instances.
   - The taxi sign in `carbodies.js`, and the `CAR_LAMPS` uniforms that are always 1. Their unused exports are gone; the rest touches shaders.
   - All are dead with the current data. Delete them, or keep them for another city?
4. **Dependencies.** Done in the pipeline pass, but for `sharp` (above).
5. **Load size.** ez-tree's textures: done in the pipeline pass (main JS 5.6 → 1.6 MB). The Google Fonts stylesheet still blocks first paint.
6. **Crowd memory.** About 135 MB of GPU memory and 115 MB of JS heap: the atlas is RGBA8 (KTX2 would be about 8× smaller), and the batches are sized at 1.3× their need. The bake of all 39 avatars blocks about 1 s at the title.
7. **Seven always-on `backdrop-filter` blurs** over the canvas. Their cost is unmeasured; solid glass would be cheaper.
8. **Shadow bias.** A 1.2 m depth bias plus normal bias removes contact shadows at wall feet and under rooftop equipment. Tuning it is coupled to `people.js` SHADOW and `carDepth`, and needs eyes.
9. **More shadow casters, fewer triangles.**
   - Parapets, barriers and La Muralla cast no shadow: they are in the road mesh.
   - Rails are three quads each, every 3 m (0.28 M triangles in a wide view).
   - Kerbs (13% of road triangles) and draped level water (82 k) could move to their own culled or undraped meshes.
10. **Tile skirts.** In the hills, a gap of metres can show between loaded tiles and the 128 m far ground.
11. **The night lamp map** renders the whole scene again each night frame. Put the lamp quads in their own scene.
12. **The governor's step-ups** are probes under vsync. Gating them on GPU time (`EXT_disjoint_timer_query_webgl2`) would end the step up, miss, step down cycle.
13. **Simulated turn signals** blink all the way round loop ramps.
14. **Car and transit physics.** Trains pass stations without stopping. Your car bounces off walls instead of sliding along them, which needs hit normals from `Walls` and `Collider`.
15. **Scenario switching** rebuilds the simulated traffic from scratch (it no longer leaks). A `setRun()` like `SimSignals.setTimeline` would reuse it.
16. **Deploy and cleanup.**
    - `tools/deploy.sh` checks the tree and the runs' roads (pipeline pass). The old local runs (`morning`, `apagon`, `morning.quarter`, `test25`) are in `data/sim-archive/` and can probably go.
    - `samples/plena-*.m4a` are untracked.
    - Unused assets:
      - `crowd/moves.json` and `turns.json` are described in the README but never loaded.
      - The clips `walkfast` (in the 1.3 MB `m01.glb`) and `turnB` are never played.
      - The `*-moves.glb` and `m-turns.glb` files ship without meshopt.
17. **Leaf colour.** Leaf maps are premultiplied (ez-tree), but the material treats them as straight colour. Crowns darken with coverage, up close at the edges and from 30–300 m as a whole, and gains of 1.5 and 1.2 compensate. Dividing by alpha and retuning the tints needs eyes.
18. **Crowd GPU work at distance.**
    - Every person casts a shadow, at any shadow extent.
    - Each vertex does four bone lookups whatever its weights.
    - The farthest model is 480 triangles for a figure 5–12 px tall.
    - Drawing the detailed model out to 40 m now, instead of 24 m, is unmeasured on the GPU.
19. **HUD.**
    - The street-name sign blinks out along long straight streets. Two name indices are built at start-up (about 40 ms each); one shared, densified index fixes both.
    - The full map lacks `touch-action: none` and a pointercancel handler.
    - The full map re-scans 106,874 segments on every drag move, under a scene that keeps rendering.
    - The minimap redraws every frame while it is shown.
20. **Walking.** Turning on the spot goes in quarter turns, at about 55°/s.
21. **Language.**
    - The page is `lang="en"`.
    - The sources panel, toast and loader are English in a Spanish interface.
    - The story says "SUV" for cars drawn as minivans.
    - "4:30" and "5:45 a.m." are written in rather than read from the run; they match today's data.
