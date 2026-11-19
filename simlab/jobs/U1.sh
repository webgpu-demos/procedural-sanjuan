# S1 with the trips from beyond the edge on the gates the counts say (demand.py --gates=counts): PR-52 and Baldorioty
# carry what came in on PR-1 and 65 de Infantería. Routed on empty roads the expressways go from 0.51 to 0.68 of
# their counts at 7-8 and the arterials from 0.87 to 0.66; this run: what SUMO makes of it.
MODE=morning SCALE=0.7 LIMIT=335 RUNARGS="--reroute=1 --reroute-period=300" DEMANDARGS="--spread=15 --gates=counts --vtype=lcMaxSpeedLatStanding=0.3;lcMaxSpeedLatFactor=0.5" . simlab/final.sh
