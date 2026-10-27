#!/bin/bash
# The published runs (tools/sim/all.sh with SCALE, ITER, RUNARGS), the client's files brought back in $RES/sim.
set -x
cd "$ROOT"
S=$ROOT/data/sim/sanjuan
SCALE=${SCALE:-1} ITER=${ITER:-10} RUNARGS="$RUNARGS" sh tools/sim/all.sh sanjuan > $RES/all.txt 2>&1
code=$?
tr '\r' '\n' < $RES/all.txt | grep -v "^Warning" | grep -v "^Step #" > $RES/all-short.txt
cp $S/morning/stats.xml $RES/stats-morning.xml; cp $S/apagon/stats.xml $RES/stats-apagon.xml
mkdir -p $RES/sim && cp -r public/tiles/sanjuan/sim/* $RES/sim/
du -sh $RES/sim/*
exit $code
