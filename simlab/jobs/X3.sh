# The corridor cut-out again, for the surface junction at the foot of three PR-18 exits (Américo Miranda southbound
# and northbound, Chardón southbound). In X1 and X2 those ramps passed half of what is routed onto them whatever was
# done on the expressway, because the ramp ends and the avenue there are 1 lane in SUMO; the aerial photo shows 2 to 4.
#   base2   the network as it is: the control, run again in the same job
#   foot    17 edges at those junctions raised to the lanes on the ground (simlab/cut/footpatch.py), signals re-guessed
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
run base2 $C/base2.net.xml.gz types-base.add.xml &
run foot $C/foot.net.xml.gz types-base.add.xml &
wait
for n in base2 foot; do mkdir -p $RES/$n; gzip -c $W/$n/edgedata.xml > $RES/$n/edgedata.xml.gz; cp $W/$n/stats.xml $RES/$n/; tr '\r' '\n' < $W/$n/log | grep -v "^Step #" > $RES/$n/log; done
$PY simlab/cut/evalcut.py $ROOT $C/base2.net.xml.gz base2=$RES/base2 > $RES/eval.txt 2>&1
$PY simlab/cut/evalcut.py $ROOT $C/foot.net.xml.gz foot=$RES/foot >> $RES/eval.txt 2>&1
cat $RES/eval.txt
