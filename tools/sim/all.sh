#!/bin/sh
# The published runs, from the compiled city: the network, the demand (SCALE: the share of the estimated morning,
# default 1), the buses, the routes the drivers settle on (assign.py), then the morning (it saves its state at the
# failure) and the apagón from that state, each validated against the counts. ~3 h on a 4-core machine.
# Usage: SCALE=1 sh tools/sim/all.sh [area]
set -e
cd "$(dirname "$0")/../.."
AREA=${1:-sanjuan}
PY=.venv-sim/bin/python
node tools/sim/network.mjs --area=$AREA
$PY tools/sim/demand.py --area=$AREA --scale=${SCALE:-1} $DEMANDARGS
$PY tools/sim/gtfs.py --area=$AREA
$PY tools/sim/assign.py --area=$AREA --iter=${ITER:-10}
$PY tools/sim/run.py --area=$AREA --scenario=morning --demand=morning --end=10.25 --share=${SCALE:-1} $RUNARGS
$PY tools/sim/validate.py --area=$AREA --scenario=morning
$PY tools/sim/run.py --area=$AREA --scenario=apagon --demand=morning --end=8.5 --share=${SCALE:-1} $RUNARGS
$PY tools/sim/validate.py --area=$AREA --scenario=apagon
echo "all runs done"
