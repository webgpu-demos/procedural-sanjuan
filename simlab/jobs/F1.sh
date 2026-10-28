#!/bin/bash
# The San Juan compile's raw data fetched (the terrain tiles, the 1 m lidar, Garita's buildings) and brought back in
# 90 MB pieces: raw.tar.* (cat raw.tar.* | tar x, in data/raw/sanjuan).
set -x
cd "$ROOT"
git clone -q --depth 1 -b compile-inputs "https://x-access-token:$GH_TOKEN@github.com/$REPO" $W/inputs
mkdir -p data/raw/sanjuan
for f in $W/inputs/sanjuan/*.gz; do gunzip -c $f > data/raw/sanjuan/$(basename $f .gz); done
npm ci --no-audit --no-fund > $RES/npm.txt 2>&1
node --max-old-space-size=4096 tools/pipeline/fetch.mjs --area=sanjuan > $RES/fetch.txt 2>&1
code=$?
du -sh data/raw/sanjuan/* data/raw/sanjuan/dem/* > $RES/sizes.txt
( cd data/raw/sanjuan && tar cf - dem garita | split -b 90m - $RES/raw.tar. )
ls -la $RES
exit $code
