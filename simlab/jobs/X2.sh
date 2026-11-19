# The corridor cut-out again (X1's base2 is the control: same routes, same seed), for the exits: in X1 the expressway
# queues start at exits, the lanes past each exit running free and nearly empty (about 250 cars a lane an hour).
#   decel   a lane for the exit on the edge before each of the 40 exits whose outer lane serves exit and road ahead
#   strat   the network as it is, drivers choosing the exit's lane earlier (lcStrategic 5, lcCooperative 1)
#   both    the two together
set -x
C=$ROOT/simlab/cut; gunzip -c $C/base.rou.xml.gz > $W/base.rou.xml
run() { # name net types [sumo args]
  local D=$W/$1 net=$2 ty=$3; shift 3; mkdir -p $D; ( cd $D
  echo '<additional><edgeData id="h" freq="900" begin="18000" file="edgedata.xml" excludeEmpty="true" writeAttributes="speed sampledSeconds entered traveltime"/></additional>' > out.add.xml
  $BIN/sumo -n $net -r $W/base.rou.xml --begin 16200 --end 30600 --additional-files $C/$ty,out.add.xml \
    --time-to-teleport 240 --ignore-route-errors --max-depart-delay 900 --lanechange.duration 2.5 \
    --time-to-impatience 90 --ignore-junction-blocker 15 --routing-algorithm astar \
    --device.rerouting.probability 1 --device.rerouting.period 300 --device.rerouting.threads 1 \
    --statistic-output stats.xml --duration-log.statistics --no-warnings --step-log.period 1800 "$@" > log 2>&1; echo "exit $?" >> log )
}
run decel $C/decel.net.xml.gz types-base.add.xml &
run strat $C/base2.net.xml.gz types-strat.add.xml &
run both $C/decel.net.xml.gz types-strat.add.xml &
wait
for n in decel strat both; do mkdir -p $RES/$n; gzip -c $W/$n/edgedata.xml > $RES/$n/edgedata.xml.gz; cp $W/$n/stats.xml $RES/$n/; tr '\r' '\n' < $W/$n/log | grep -v "^Step #" > $RES/$n/log; done
$PY simlab/cut/evalcut.py $ROOT $C/base2.net.xml.gz strat=$RES/strat > $RES/eval.txt 2>&1
$PY simlab/cut/evalcut.py $ROOT $C/decel.net.xml.gz decel=$RES/decel both=$RES/both >> $RES/eval.txt 2>&1
cat $RES/eval.txt
