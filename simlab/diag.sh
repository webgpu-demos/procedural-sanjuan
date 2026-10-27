#!/bin/bash
# A diagnostic morning: the network (network.mjs with $NETARGS), the demand at $SCALE, routes, and SUMO without
# positions (fast), its warnings logged; then where it jams. Extra SUMO options: $SUMOARGS. End: $END h.
set -x
cd "$ROOT"
D=$W/diag; mkdir -p $D
node tools/sim/network.mjs $NETARGS || exit 1
$PY tools/sim/demand.py --area=sanjuan --scale=${SCALE:-1} --scenario=lab > $RES/demand.txt 2>&1 || exit 1
$PY tools/sim/gtfs.py --area=sanjuan --demand=lab > $RES/gtfs.txt 2>&1
$PY tools/sim/route.py --area=sanjuan --demand=lab ${ROUTEARGS} > $RES/route.txt 2>&1 || exit 1
S=$ROOT/data/sim/sanjuan
cat > $D/ed.add.xml <<X
<additional>
  <edgeData id="d" freq="900" begin="16200" file="$D/ed.xml" excludeEmpty="true"/>
</additional>
X
/usr/bin/time -v $BIN/sumo -n $S/sanjuan.net.xml.gz -r $S/lab/routes.rou.xml \
 --additional-files $D/ed.add.xml,$S/lab/busstops.add.xml --begin 16200 --end $(python3 -c "print(int(${END:-10.25}*3600))") \
 --time-to-teleport 240 --ignore-route-errors --max-depart-delay 900 --lanechange.duration 2.5 \
 --time-to-impatience 90 --ignore-junction-blocker 15 --routing-algorithm astar \
 --statistic-output $RES/stats.xml --summary-output $D/summary.xml --summary-output.period 60 \
 --log $D/sumo.log --duration-log.statistics --step-log.period 900 $SUMOARGS > $RES/sumo.txt 2>&1
tr '\r' '\n' < $RES/sumo.txt | grep -v "^Warning" > $RES/sumo-steps.txt
grep Teleporting $D/sumo.log | gzip > $RES/teleports.txt.gz
$PY tools/sim/hotspots.py $S/sanjuan.net.xml.gz $D/sumo.log $D/ed.xml --top=60 > $RES/hotspots.txt 2>&1
gzip -c $D/summary.xml > $RES/summary.xml.gz
gzip -c $D/ed.xml > $RES/ed.xml.gz
