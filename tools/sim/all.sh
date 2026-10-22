#!/bin/sh
# The published runs, one after the other: the morning (it saves its state at the failure), then the apagón from
# that state, each validated against the counts. Logs in data/sim/<area>/runs.log.
# Usage: sh tools/sim/all.sh [area]   (the network, demand and routes first: npm run sim:net, sim:demand, sim:route)
set -e
cd "$(dirname "$0")/../.."
AREA=${1:-sanjuan}
PY=.venv-sim/bin/python
$PY tools/sim/run.py --area=$AREA --scenario=morning --demand=morning --end=10.25
$PY tools/sim/validate.py --area=$AREA --scenario=morning
$PY tools/sim/run.py --area=$AREA --scenario=apagon --demand=morning --end=8.5
$PY tools/sim/validate.py --area=$AREA --scenario=apagon
echo "all runs done"
