#!/bin/sh
# An area compiled and made ready to serve, in one go. The compile clears the area's folder, and with it what the
# other tools write there; they run again here, in the order each needs the one before:
#   compile.mjs     data/raw/<area> -> public/tiles/<area> (tiles, roads.json, manifest.json, ...)
#   clearroads.mjs  the street-level centrelines still bare (neither paved nor under a building) paved; anything the
#                   compiler's own road rule left in a road taken out (a no-op on a clean compile)
#   lanetable.mjs   lanes.json: the expressway's lanes as painted (the client's lanes, and the simulation's network)
#   walkways.mjs    the walks the people on foot keep to
#   gates.mjs       what the data must pass (tools/audit/gates.mjs), printed
# then the tests over every compiled area. Its simulated runs (sim/) are not made here: tools/sim (npm run sim:net,
# sim:all), on this area's new roads.json. The compile refuses an area whose sim/ is still there (pass --force to
# delete it with the rest).
# Usage: sh tools/pipeline/rebuild.sh --area=<id> [compile.mjs options: --road-levels=<roads.json>, --force, ...]
set -e
cd "$(dirname "$0")/../.."
AREA=sanjuan
for a in "$@"; do case "$a" in --area=*) AREA="${a#--area=}" ;; esac; done
DIR=public/tiles/$AREA
STAMP=$(date +%Y%m%d-%H%M%S)
node --max-old-space-size=6144 tools/pipeline/compile.mjs "$@"
node --max-old-space-size=4096 tools/pipeline/clearroads.mjs --area="$AREA" --backup="data/tiles-backup/clearroads-$AREA-$STAMP"
node tools/pipeline/lanetable.mjs "$DIR"
node --max-old-space-size=6144 tools/pipeline/walkways.mjs --area="$AREA"
node --max-old-space-size=4096 tools/audit/gates.mjs --areas="$AREA" --json="data/tiles-backup/gates-$AREA-$STAMP.json"
npm test
