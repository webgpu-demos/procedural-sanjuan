#!/bin/bash
# A diagnostic morning: the network (network.mjs with $NETARGS), the demand at $SCALE, routes, and SUMO without
# positions (fast), its warnings logged; then where it jams. Extra SUMO options: $SUMOARGS. End: $END h.
# With ASSIGN=<iterations>, the routes are assigned first (duaIterate, mesoscopic), else duarouter on free roads.
set -x
cd "$ROOT"
D=$W/diag; mkdir -p $D
S=$ROOT/data/sim/sanjuan
export SUMO_HOME=$($PY -c "import sumo; print(sumo.SUMO_HOME)")
node tools/sim/${NETSCRIPT:-network.mjs} $NETARGS > $RES/network.txt 2>&1 || exit 1
$PY tools/sim/demand.py --area=sanjuan --scale=${SCALE:-1} --scenario=lab "--vtype=$VTYPE" > $RES/demand.txt 2>&1 || exit 1
$PY tools/sim/gtfs.py --area=sanjuan --demand=lab > $RES/gtfs.txt 2>&1
if [ -n "$ASSIGN" ]; then
  A=$W/assign; mkdir -p $A; cd $A
  /usr/bin/time -v $PY $SUMO_HOME/tools/assign/duaIterate.py -n $S/sanjuan.net.xml.gz -t $S/lab/trips.xml -l $ASSIGN \
    -b 16200 -e 36900 --mesosim -j --meso-recheck 10 --time-to-teleport 300 --routing-algorithm ${ASSIGNALG:-CH} -T -E -a 900 -D $S/lab/taz.add.xml \
    $ASSIGNARGS duarouter--routing-threads 4 sumo--ignore-route-errors true sumo--max-depart-delay 900 sumo--duration-log.statistics true > $RES/assign.txt 2>&1
  cd "$ROOT"
  last=$(ls -d $A/0* | sort | tail -1)
  ROUTES=$(ls $last/*.rou.alt.xml* | head -1),$S/lab/buses.xml
  ls -la $last >> $RES/assign.txt
  cp $last/*.rou.xml.gz $RES/ 2>/dev/null  # (the routes it settled on, to drive again)
  for it in $(ls -d $A/0*); do echo "== $it"; grep -E "Inserted|Running|Waiting|Teleports|Speed|Duration|TimeLoss" $it/*.sumo.log | grep -v Warning | tail -8; done >> $RES/assign.txt
  # (each iteration's mean travel time, from duaIterate's summaries)
  for it in $(ls -d $A/0*); do echo "$it $(grep -o 'meanTravelTime="[^"]*"' $it/*summary* 2>/dev/null | tail -1)"; done >> $RES/assign.txt
else
  $PY tools/sim/route.py --area=sanjuan --demand=lab ${ROUTEARGS} > $RES/route.txt 2>&1 || exit 1
  ROUTES=$S/lab/routes.rou.xml
fi
[ -f $S/lab/taz.add.xml ] && TAZADD=,$S/lab/taz.add.xml
cat > $D/ed.add.xml <<X
<additional>
  <edgeData id="d" freq="900" begin="16200" file="$D/ed.xml" excludeEmpty="true"/>
</additional>
X
/usr/bin/time -v $BIN/sumo -n $S/sanjuan.net.xml.gz -r $ROUTES \
 --additional-files $D/ed.add.xml,$S/lab/busstops.add.xml$TAZADD --begin 16200 --end $(python3 -c "print(int(${END:-10.25}*3600))") \
 --time-to-teleport 240 --ignore-route-errors --max-depart-delay 900 --lanechange.duration ${LCDUR:-2.5} \
 --time-to-impatience ${IMPATIENCE:-90} --ignore-junction-blocker ${BLOCKER:-15} --routing-algorithm astar \
 --statistic-output $RES/stats.xml --summary-output $D/summary.xml --summary-output.period 60 \
 --log $D/sumo.log --duration-log.statistics --step-log.period 900 $SUMOARGS > $RES/sumo.txt 2>&1
tr '\r' '\n' < $RES/sumo.txt | grep -v "^Warning" > $RES/sumo-steps.txt
grep Teleporting $D/sumo.log | gzip > $RES/teleports.txt.gz
$PY tools/sim/hotspots.py $S/sanjuan.net.xml.gz $D/sumo.log $D/ed.xml --top=60 > $RES/hotspots.txt 2>&1
$PY tools/sim/validate.py --area=sanjuan --scenario=lab --edgedata=$D/ed.xml --out=$RES > $RES/validate.txt 2>&1
gzip -c $D/summary.xml > $RES/summary.xml.gz
gzip -c $D/ed.xml > $RES/ed.xml.gz
cp $S/net/*.json $RES/ 2>/dev/null; gzip -f $RES/merged.json $RES/inside.json 2>/dev/null
