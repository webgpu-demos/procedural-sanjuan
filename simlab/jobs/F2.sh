#!/bin/bash
# What the San Juan compile needs from the network, small enough to bring back: the terrain tiles, Garita's buildings,
# and the grid as the 1 m lidar leaves it (compile.mjs --save-lidar-grid; the lidar tiles themselves run to 4.6 GB).
set -x
cd "$ROOT"
git clone -q --depth 1 -b compile-inputs "https://x-access-token:$GH_TOKEN@github.com/$REPO" $W/inputs
mkdir -p data/raw/sanjuan
for f in $W/inputs/sanjuan/*.gz; do gunzip -c $f > data/raw/sanjuan/$(basename $f .gz); done
npm ci --no-audit --no-fund > $RES/npm.txt 2>&1
node --max-old-space-size=4096 tools/pipeline/fetch.mjs --area=sanjuan > $RES/fetch.txt 2>&1 || exit 1
du -sh data/raw/sanjuan/* data/raw/sanjuan/dem/* > $RES/sizes.txt
node --max-old-space-size=12000 tools/pipeline/compile.mjs --area=sanjuan --save-lidar-grid=$RES/lidar-grid.bin > $RES/grid.txt 2>&1 || exit 1
( cd data/raw/sanjuan && tar czf $RES/raw-small.tgz --exclude=dem/lidar dem garita )
ls -la $RES
