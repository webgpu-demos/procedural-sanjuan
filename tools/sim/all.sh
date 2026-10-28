#!/bin/sh
# The published runs, from the compiled city: the network, the demand (SCALE: the share of the estimated morning,
# 0.7 published), the buses, the routes (on the free roads; ITER=10: SUMO's assignment instead, assign.py), then the
# morning (it saves its state at the failure) and the apagón from that state, every driver re-planning every five
# minutes (RUNARGS), each validated against the counts. ~6 h on a 4-core machine at 0.7.
# Usage: SCALE=0.7 sh tools/sim/all.sh [area]
set -e
cd "$(dirname "$0")/../.."
AREA=${1:-sanjuan}
PY=.venv-sim/bin/python
node tools/sim/network.mjs --area=$AREA
SCALE=${SCALE:-0.7}; DEMANDARGS=${DEMANDARGS---spread=15}; RUNARGS=${RUNARGS---reroute=1 --reroute-period=300}
$PY tools/sim/demand.py --area=$AREA --scale=$SCALE $DEMANDARGS
$PY tools/sim/gtfs.py --area=$AREA
if [ "${ITER:-0}" = 0 ]; then rm -f data/sim/$AREA/morning/assigned.rou.alt.xml.gz; $PY tools/sim/route.py --area=$AREA
else $PY tools/sim/assign.py --area=$AREA --iter=${ITER:-10}; fi
$PY tools/sim/run.py --area=$AREA --scenario=morning --demand=morning --end=10.25 --share=$SCALE $RUNARGS
$PY tools/sim/validate.py --area=$AREA --scenario=morning
$PY tools/sim/run.py --area=$AREA --scenario=apagon --demand=morning --end=8.5 --share=$SCALE $RUNARGS
$PY tools/sim/validate.py --area=$AREA --scenario=apagon
echo "all runs done"
