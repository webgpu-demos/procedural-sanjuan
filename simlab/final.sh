#!/bin/bash
# The published runs, the client's files brought back in $RES/sim.
#   MODE=all (default): tools/sim/all.sh with SCALE, ITER, RUNARGS, DEMANDARGS
#   MODE=morning: the morning only, and what the apagón starts from (its state, routes, gates, buses) in $RES/carry
#   MODE=apagon FROM=<job>: the apagón from that job's morning
set -x
cd "$ROOT"
S=$ROOT/data/sim/sanjuan
T=public/tiles/sanjuan/sim
PY=.venv-sim/bin/python
mkdir -p $RES/sim
case ${MODE:-all} in
all)
  SCALE=${SCALE:-1} ITER=${ITER:-10} RUNARGS="$RUNARGS" DEMANDARGS="$DEMANDARGS" sh tools/sim/all.sh sanjuan > $RES/all.txt 2>&1
  code=$?
  cp $S/morning/stats.xml $RES/stats-morning.xml; cp $S/apagon/stats.xml $RES/stats-apagon.xml
  cp -r $T/* $RES/sim/ ;;
morning)
  ( set -e
    node tools/sim/network.mjs --area=sanjuan
    $PY tools/sim/demand.py --area=sanjuan --scale=${SCALE:-1} $DEMANDARGS
    $PY tools/sim/gtfs.py --area=sanjuan
    rm -f $S/morning/assigned.rou.alt.xml.gz; $PY tools/sim/route.py --area=sanjuan
    timeout ${LIMIT:-320}m $PY tools/sim/run.py --area=sanjuan --scenario=morning --demand=morning --end=10.25 --share=${SCALE:-1} $RUNARGS
    $PY tools/sim/validate.py --area=sanjuan --scenario=morning ) > $RES/all.txt 2>&1
  code=$?
  cp $S/morning/stats.xml $RES/stats-morning.xml
  cp -r $T/morning $T/buses.json $T/ferries.json $RES/sim/
  mkdir -p $RES/carry && cp $S/morning/state_20700.xml.gz $S/morning/taz.add.xml $S/morning/busstops.add.xml $RES/carry/ &&
    gzip -c $S/morning/routes.rou.xml > $RES/carry/routes.rou.xml.gz && gzip -c $S/morning/trips.json > $RES/carry/trips.json.gz ;;
apagon)
  ( set -e
    git clone -q --depth 1 -b simres/$FROM "https://x-access-token:$GH_TOKEN@github.com/$REPO" $W/from
    node tools/sim/network.mjs --area=sanjuan
    mkdir -p $S/morning $T && cp -r $W/from/sim/* $T/
    cp $W/from/carry/state_20700.xml.gz $W/from/carry/taz.add.xml $W/from/carry/busstops.add.xml $S/morning/
    gunzip -c $W/from/carry/routes.rou.xml.gz > $S/morning/routes.rou.xml; gunzip -c $W/from/carry/trips.json.gz > $S/morning/trips.json
    SHARE=$(python3 -c "import json; print(json.load(open('$T/morning/index.json'))['share'])")
    timeout ${LIMIT:-320}m $PY tools/sim/run.py --area=sanjuan --scenario=apagon --demand=morning --end=8.5 --share=$SHARE $RUNARGS
    $PY tools/sim/validate.py --area=sanjuan --scenario=apagon ) > $RES/all.txt 2>&1
  code=$?
  cp $S/apagon/stats.xml $RES/stats-apagon.xml
  cp -r $T/apagon $RES/sim/ ;;
esac
tr '\r' '\n' < $RES/all.txt | grep -v "^Warning" | grep -v "^Step #" > $RES/all-short.txt
du -sh $RES/sim/* $RES/carry 2>/dev/null
exit $code
