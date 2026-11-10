# Audit, November 2026: what was fixed and what is left for you

Branch `audit-pass` (from `main` at c8a71ba7). Nothing is committed. `npm test` passes, with a new
`roads-clear` test. The local tiles in `public/tiles/{sanjuan,condado,hatorey}` were patched in place by
`tools/pipeline/clearroads.mjs`; the originals are in `data/tiles-backup/before-clearroads-<area>/`. The deployed
site is unchanged: `npm run deploy` publishes these local tiles, so deploy only once you have looked.

**Before any deploy from this checkout, read this.** The published site and this checkout disagree:
- The **simulated runs here are older and gridlocked**. Here, `sim/morning` was run at share 0.35, with 34,322 teleports, and 41,334 cars were still on the road at the end. The published `morning` was run at share 0.7, with 1,410 teleports; the published `apagon` has 782 teleports against 11,115 here.
- The **tiles here are newer**: compiled 2026-11-08, against 2026-10-28 for the published ones. The flyover decks sit up to about 3.7 m lower, and `roads.json` differs.
- `tools/deploy.sh` publishes `sim/morning` and `sim/apagon` from here, so a plain `npm run deploy` would replace the good published runs with the gridlocked ones. Extract the published runs first (about 560 MB), then swap them for `public/tiles/sanjuan/sim/morning` and `apagon`:

  ```bash
  mkdir -p /tmp/pages && git archive origin/gh-pages tiles/sanjuan/sim/morning tiles/sanjuan/sim/apagon | tar -x -C /tmp/pages
  ```

  Then check that their heights agree with the new decks; the published run was driven on the old `roads.json` levels. (The PR-18 measurement below was taken with the published morning on these tiles; it loads and plays.)
- `lanes.json` is published. It was missing here, so every local load 404'd on it. It is now generated here with `tools/pipeline/lanetable.mjs`, and matches the published one but for 3 of 810 edges.

## Fixed (measured where a number is given)

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
  - The one-second dips to 20 km/h on Las Américas and PR-1 are smoothed: 139 → 0 in the 7:30 window, 0 left in the windows checked (`undip`). They come from backward junction links in the SUMO network; see "Needs a SUMO re-run".
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

### Measured: frame cost of the benchmark views
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

### Needs a SUMO re-run (`tools/sim`)
1. **Backward junction links.** The net was built with netconvert's `--ramps.guess`, and 22 junction links start up to 9 m behind where the lane into them ends: PR-18 by Las Américas, and PR-1. The client now hides the dip. The proper fix is to rebuild the net and add a check after netconvert that fails on such links.
2. **Cars appear and vanish at speed.** `demand.py` uses `departSpeed="max" departPos="random_free"`, and 93% of tracks start above 5 m/s (median 41 km/h). For street trips, use `departSpeed="0"` and `arrivalSpeed="0"`.
3. **This checkout's runs are not the published ones.** See the warning at the top. Either copy the published runs in, or re-run here at share 0.7 with `index.lanes` and `levels: 'roads'` against the new tiles, then run `validate.py`.
4. **Lane widths and vehicle sizes disagree.** `roadway.js` uses 3.2 m lanes and the net uses 3.0 m (2.6 m on shared streets). In `demand.py` the truck is 7.0 m against 5.9 m drawn. One shared constants module would settle it.
5. **4-lane default.** Untagged two-way primary and secondary roads become 4 lanes (79 ways, `osm.mjs`). Driven lanes then run into 3,934 house fronts, though no building is crossed by a centreline. A default of 2, or a cap from the measured wall-to-wall width (`roadsplit.mjs` measures it), changes the network.
6. **Short teleports.** `run.py` splits a track only on jumps over 60 m. The client now does it at 9 m and up; move it into `run.py`.

### Needs a recompile (it deletes `sim/`, so move it away or `--force`)
1. **Stale road levels.** With `--road-levels`, ordinary roads keep levels from the old terrain: 81% of at-grade points are more than 0.5 m off `terrain.bin`, and the worst is 49 m.
2. **Raised building parts.** Skywalks (`building=bridge`) lose their `min_height` and stand as solid blocks across Av. Muñoz Rivera and Calle Feria. Raised parts also get walls 4 m below their base and no underside (`meshing.js` SINK), so the client needs a floor for a raised base.
3. **Already fixed in the compiler, waiting on a recompile:** roof-like tags (`roof;yes`, carports), underground stations, and FEMA outlines under OSM roofs.
4. **Invented billboards.** 113 of the 138 invented ads are placed in Old San Juan, where the client hides them all. Centre them on Hato Rey or Santurce instead.
5. **Paint under sidewalks.** 664 paint polygons lie under a sidewalk and show through it from about 20 m. Clip marks to carriageways.

### Cars still drawn inside one another in jams
On PR-18 at 7:30 (`?time=7.5&cam=4940,6475,300,0,25`), 10 checks over 300 frames:
- On the published run: 93 overlaps as drawn, against 18 where SUMO has the cars.
- On this checkout's gridlocked run: 189 against 5.

The extra ones come from the client moving cars onto the painted lanes (`relane`, `fit` in `simtraffic.js`). Where SUMO's lane count and the paint's disagree, it puts cars from two SUMO lanes into one painted lane. The worst clusters are around (5430, 6433–6462) and (4936, 6424). This is not new: `main` draws the same. The fix is to keep the cars' SUMO lane order when mapping, or to let a mapped car fall back to its SUMO lane while another car occupies the target. That needs care with the smoothing that went in with PR #47, so I left it.

### Decisions
1. **`covered=yes` roads** notch the building over them, though the road really runs under it. The largest case is a 245 m cut through the Mall of San Juan's car park (`?ll=18.412099,-66.024036`). The thresholds are judgment calls too: keep at least 35% of a building (50% for low ones), and count a road from 0.5 m in.
2. **Trees vanish beyond about 1 km** (500 m at the lowest detail), because their far crowns are culled with the street furniture. Keeping the current crowns costs about 1 M triangles. A crown of 8–20 triangles would cost 40–100 k. The far crowns are now tagged `userData.crown`, so keeping them is one condition in `cullSmall` (`main.js`): `&& !o.userData.crown`.
3. **Tokyo/PLATEAU leftovers.**
   - `tower.js` and the `surfaces`/photo-roof path in `streamer.js`, `meshing.js` and `materials.js`. The `aPhoto` attribute is on every building vertex (about 10 MB CPU and 10 MB GPU around Hato Rey) and costs a texture fetch per facade fragment.
   - Vending, shrine, torii and rail-crossing props with no instances.
   - The taxi sign in `carbodies.js`, and the `CAR_LAMPS` uniforms that are always 1. Their unused exports are gone; the rest touches shaders.
   - All are dead with the current data. Delete them, or keep them for another city?
4. **Dependencies.** `@takram/three-geospatial-effects`, `sharp` and `libsumo` are imported by nothing. `pngjs` and `polygon-clipping` belong in devDependencies.
5. **Load size.** ez-tree bundles 20 base64 textures (about 3.3 MB of the 5.5 MB JS bundle), and props.js uses 3. Alias its texture module to a stub. The Google Fonts stylesheet also blocks first paint.
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
    - `tools/deploy.sh` deploys the working tree under HEAD's hash with no dirty-tree check.
    - `sim/morning.quarter` and `sim/test25` (583 MB, local only) can probably go.
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
