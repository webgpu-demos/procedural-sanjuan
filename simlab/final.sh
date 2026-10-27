#!/bin/bash
# The published runs: the network, the demand at $SCALE, its routes (assigned with ASSIGN=<iterations>, else
# duarouter), the morning with every car's positions, the apagón from the morning's state at 5:45, each validated;
# the client's files (public/tiles/sanjuan/sim) brought back in $RES/sim.
set -x
cd "$ROOT"
S=$ROOT/data/sim/sanjuan
export SUMO_HOME=$($PY -c "import sumo; print(sumo.SUMO_HOME)")
node tools/sim/network.mjs $NETARGS > $RES/network.txt 2>&1 || exit 1
$PY tools/sim/demand.py --area=sanjuan --scale=${SCALE:-1} --scenario=morning "--vtype=$VTYPE" > $RES/demand.txt 2>&1 || exit 1
$PY tools/sim/gtfs.py --area=sanjuan --demand=morning > $RES/gtfs.txt 2>&1
if [ -n "$ASSIGN" ]; then
  A=$W/assign; mkdir -p $A; cd $A
  $PY $SUMO_HOME/tools/assign/duaIterate.py -n $S/sanjuan.net.xml.gz -t $S/morning/trips.xml -l $ASSIGN \
    -b 16200 -e 36900 --mesosim -j --meso-recheck 10 --time-to-teleport 300 --routing-algorithm astar -T -E -a 900 \
    $ASSIGNARGS duarouter--routing-threads 4 sumo--ignore-route-errors true sumo--max-depart-delay 900 > $RES/assign.txt 2>&1
  cd "$ROOT"
  last=$(ls -d $A/0* | sort | tail -1)
  ROUTES=$(ls $last/*.rou.alt.xml | head -1),$S/morning/buses.xml
else
  $PY tools/sim/route.py --area=sanjuan --demand=morning > $RES/route.txt 2>&1 || exit 1
  ROUTES=$S/morning/routes.rou.xml
fi
$PY tools/sim/run.py --area=sanjuan --scenario=morning --demand=morning --routes=$ROUTES --end=10.25 --share=${SCALE:-1} $RUNARGS > $RES/morning.txt 2>&1 || exit 1
$PY tools/sim/validate.py --area=sanjuan --scenario=morning > $RES/validate-morning.txt 2>&1
cp $S/morning/stats.xml $RES/stats-morning.xml
mkdir -p $RES/sim && cp -r public/tiles/sanjuan/sim/morning public/tiles/sanjuan/sim/*.json $RES/sim/
[ -n "$NOAPAGON" ] && exit 0
$PY tools/sim/run.py --area=sanjuan --scenario=apagon --demand=morning --routes=$ROUTES --end=8.5 --share=${SCALE:-1} $RUNARGS > $RES/apagon.txt 2>&1 || exit 1
$PY tools/sim/validate.py --area=sanjuan --scenario=apagon > $RES/validate-apagon.txt 2>&1
cp $S/apagon/stats.xml $RES/stats-apagon.xml
cp -r public/tiles/sanjuan/sim/apagon $RES/sim/
du -sh $RES/sim/*
