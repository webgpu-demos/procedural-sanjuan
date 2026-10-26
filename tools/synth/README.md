# Synthetic drone images

Labelled aerial frames rendered from the city, for training a detector, and a harness that measures whether they
help on real drone frames.

## What is made

Each frame is a camera over the city at drone altitude, with a label for everything the camera sees of four
classes:

| id | class | from |
|---|---|---|
| 0 | `building` | the building meshes (OpenStreetMap footprints, FEMA heights; Garita's lidar heights and GERS ids where the compile had them) |
| 1 | `blue_tarp` | a blue tarp on the roof of a damaged building (`--damage`) |
| 2 | `debris` | piles of debris beside damaged buildings: planks, zinc sheets, furniture, appliances, branches, torn tarp |
| 3 | `vehicle` | the traffic around the view |

The labels come from a second render of the same scene in which every material writes what the pixel is
(`src/synth/labels.js`), so a box covers exactly the visible part of its instance, occlusion included. Masks
(`masks/*.png`: R = class + 1, G·256 + B = instance in the frame) and per-frame metadata (`meta/*.json`: pose,
hour, every instance with its box, pixel count and, for buildings, tile, OSM id and GERS id) come with the boxes.

Varied per frame: altitude (`--alt`, default 50 to 120 m above the ground), camera pitch (`--pitch`, -90 to -70°),
heading along flight lines, the hour (`--hour`, 8:30 to 16:30: sun angle and shadows), and which buildings are
damaged (`--damage`, `--seed`). The camera is a 73.7° horizontal field of view (`--hfov`; DJI Phantom 4 / Mavic
class) at 1280 × 960 (`--size`).

Limits, which matter when reading the results: the city is procedural above the footprints (wall colours, windows,
roof shapes are generated; roofs are not the real roofs), the ground is procedural unless `--ortho` drapes the
aerial photo (which then carries the real roofs and cars of the photo, unlabelled), there are no people, laundry,
water tanks or solar panels, and damage is limited to tarps and debris piles (no collapsed walls, no missing roofs).
Roof-only structures (OSM `building=roof`: canopies, the tops of some car parks), footbridges and platforms are
not labelled as buildings; they still hide what is under them. A frame where distant buildings are drawn as plain
unlabelled blocks over more than 2 % of the picture is skipped.

## Making a dataset

```sh
npm install
node tools/assets/fetch_textures.mjs                       # once, if public/textures is not there yet
npm run fetch -- --area=sanjuan && npm run compile -- --area=sanjuan   # if the area is not compiled yet
npm run dev                         # the client, at http://localhost:5173/ (or serve a build)
node tools/synth/export.mjs --area=sanjuan --frames=400 --damage=0.25 --out=data/synth/sj
node tools/synth/export.mjs --area=hatorey --frames=200 --damage=0.1 --seed=2 --out=data/synth/hr
```

Chrome or Chromium is found in the usual places; else `--chrome=<path>`. Without a GPU, Chrome draws on the CPU
(SwiftShader): there the city took about two minutes to load and a 640 × 480 frame about a minute. Use a machine
with a GPU for thousands of frames. The output is the
layout Ultralytics reads (`images/{train,val}`, `labels/{train,val}`, `dataset.yaml`), so
`yolo train data=data/synth/sj/dataset.yaml` trains on it directly.

## Measuring what it is worth: `experiment/`

The question is whether synthetic frames improve a detector **on your real frames**, and by how much at each amount
of real labelled data. `prepare.py` splits your real frames once, by flight, into train / val / test, and sets up
the conditions: real share (default 10, 25, 50, 100 % of the real training frames) × synthetic frames per real
frame (0 = baseline, 1, 4, and synthetic only), × seeds. `run.py` trains each (Ultralytics YOLO), picks weights
on real val, scores on real test, and writes `results.csv` and `summary.md` (mAP50-95 and mAP50 tables, the paired
gain over the real-only baseline, per class). `--finetune` adds pretraining on synthetic alone then fine-tuning on
the real share.

```sh
pip install -r tools/synth/experiment/requirements.txt
python tools/synth/experiment/prepare.py --real ~/drone/labelled --real-names building,blue_tarp \
    --synth data/synth/sj data/synth/hr --group '^([^_]+)_' --out runs/exp1
python tools/synth/experiment/run.py --exp runs/exp1 --model yolo11n.pt --epochs 60 --imgsz 1024 --device 0 --finetune
```

Your frames: YOLO format (`images/` and `labels/` side by side, any subfolders), the names of your classes in index
order (`--real-names`), and a regular expression that pulls a flight id out of a file name (`--group`) so frames of
one flight are never on both sides of the split. Only classes in both sets are compared (`--classes` to choose);
your labels are rewritten to that list under `runs/exp1/pool`, the images linked. Name your classes as the synthetic
ones are named (`building`, `blue_tarp`, `debris`, `vehicle`) or pass `--classes` with the shared ones.

What to read in `summary.md`: the gain row at the smallest real share is where synthetic data usually helps most;
a gain inside the seed spread is not a gain; "synth only" says how far the synthetic frames get alone (the domain
gap); per class shows which classes the generator serves well. `--budget` keeps the number of images seen equal
across conditions (otherwise a condition with more frames also trains longer).

`experiment/smoke.sh <export dir>` runs the whole harness for one epoch on the CPU with part of a synthetic export
standing in for real frames: a check that it runs, not a result.
