# The PR-22 / PR-18 corridor cut out of U1's morning (159,680 vehicles, 4:30-8:30), three ways at once:
#   base2   the network as it is
#   art     the avenues with FHWA's through lanes where the map has fewer, and the 2-lane expressway stretches widened
#   notls   as base2 with every signal off (not a road anyone could build: how much the signals hold back)
# Scored at 7-8 a.m. with the cut-out's own matcher (simlab/cut/evalcut.py), each against the others.
set -x
C=$ROOT/simlab/cut; gunzip -c $C/base.rou.xml.gz > $W/base.rou.xml
run() { # name net [sumo args]
  local D=$W/$1 net=$2; shift 2; mkdir -p $D; ( cd $D
  echo '<additional><edgeData id="h" freq="900" begin="18000" file="edgedata.xml" excludeEmpty="true" writeAttributes="speed sampledSeconds entered traveltime"/></additional>' > out.add.xml
  $BIN/sumo -n $net -r $W/base.rou.xml --begin 16200 --end 30600 --additional-files $C/types-base.add.xml,out.add.xml \
    --time-to-teleport 240 --ignore-route-errors --max-depart-delay 900 --lanechange.duration 2.5 \
    --time-to-impatience 90 --ignore-junction-blocker 15 --routing-algorithm astar \
    --device.rerouting.probability 1 --device.rerouting.period 300 --device.rerouting.threads 1 \
    --statistic-output stats.xml --duration-log.statistics --no-warnings --step-log.period 1800 "$@" > log 2>&1; echo "exit $?" >> log )
}
run base2 $C/base2.net.xml.gz &
run art $C/art.net.xml.gz &
run notls $C/base2.net.xml.gz --tls.all-off true &
wait
for n in base2 art notls; do mkdir -p $RES/$n; gzip -c $W/$n/edgedata.xml > $RES/$n/edgedata.xml.gz; cp $W/$n/stats.xml $RES/$n/; tr '\r' '\n' < $W/$n/log | grep -v "^Step #" > $RES/$n/log; done
$PY simlab/cut/evalcut.py $ROOT $C/base2.net.xml.gz base2=$RES/base2 notls=$RES/notls > $RES/eval.txt 2>&1
$PY simlab/cut/evalcut.py $ROOT $C/art.net.xml.gz art=$RES/art >> $RES/eval.txt 2>&1
cat $RES/eval.txt
