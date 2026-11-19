# The corridor cut-out again, for the ramps' speed. An untagged ramp gets its expressway's limit (88 km/h), so the
# fastest way on paper often leaves the expressway by a ramp and comes straight back on: 39,157 of the cut-out's
# 159,680 cars do (5,900 an hour over one single-lane pair on PR-22), and 26 ramps are routed over 2,000 cars a lane.
# The cut-out's cars are routed again here as trips (first edge to last, duarouter as route.py runs it) on each net.
#   ctl       the network as it is, routed again: the control (the same routes as X1's base2, but for ties)
#   link      untagged ramps at 56 km/h (trunk ramps 48), routed on that: no car leaves and rejoins, 6 ramps over 2,000
#   linkfoot  the same with X3's lanes at the foot of three PR-18 exits
set -x
C=$ROOT/simlab/cut; gunzip -c $C/trips.xml.gz > $W/trips.xml
route() { $BIN/duarouter -n $1 -r $W/trips.xml --additional-files $C/types-base.add.xml -o $2 --routing-algorithm CH --ignore-errors --no-warnings --no-step-log --repair --write-trips.junctions false; grep -c "<vehicle" $2; }
route $C/base2.net.xml.gz $W/ctl.rou.xml; route $C/link.net.xml.gz $W/link.rou.xml
run() { # name net routes
  local D=$W/$1 net=$2 rou=$3; mkdir -p $D; ( cd $D
  echo '<additional><edgeData id="h" freq="900" begin="18000" file="edgedata.xml" excludeEmpty="true" writeAttributes="speed sampledSeconds entered traveltime"/></additional>' > out.add.xml
  $BIN/sumo -n $net -r $rou --begin 16200 --end 30600 --additional-files $C/types-base.add.xml,out.add.xml \
    --time-to-teleport 240 --ignore-route-errors --max-depart-delay 900 --lanechange.duration 2.5 \
    --time-to-impatience 90 --ignore-junction-blocker 15 --routing-algorithm astar \
    --device.rerouting.probability 1 --device.rerouting.period 300 --device.rerouting.threads 1 \
    --statistic-output stats.xml --duration-log.statistics --no-warnings --step-log.period 1800 > log 2>&1; echo "exit $?" >> log )
}
run ctl $C/base2.net.xml.gz $W/ctl.rou.xml &
run link $C/link.net.xml.gz $W/link.rou.xml &
run linkfoot $C/linkfoot.net.xml.gz $W/link.rou.xml &
wait
for n in ctl link linkfoot; do mkdir -p $RES/$n; gzip -c $W/$n/edgedata.xml > $RES/$n/edgedata.xml.gz; cp $W/$n/stats.xml $RES/$n/; tr '\r' '\n' < $W/$n/log | grep -v "^Step #" > $RES/$n/log; done
$PY simlab/cut/evalcut.py $ROOT $C/base2.net.xml.gz ctl=$RES/ctl > $RES/eval.txt 2>&1
$PY simlab/cut/evalcut.py $ROOT $C/link.net.xml.gz link=$RES/link >> $RES/eval.txt 2>&1
$PY simlab/cut/evalcut.py $ROOT $C/linkfoot.net.xml.gz linkfoot=$RES/linkfoot >> $RES/eval.txt 2>&1
cat $RES/eval.txt
