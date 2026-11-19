#!/usr/bin/env python3
"""Takes the normal morning's figures out of a packed apagón run's tripinfo.bin, where they do not belong.

run.py filled the apagón's per-car delay and distance with the morning's, then wrote over them the cars that
arrived in the blackout. A car that had not arrived when the blackout's run ended kept the morning's delay: the
later it left, the more of them (of the cars leaving after 8:30, where the run ends, all), and the blackout read
as no worse than the morning, or better. run.py now carries over only the cars that left before the failure.

This repairs a run packed before that, without its tripinfo.xml: of the cars that left at or after the failure,
those whose delay and distance are the morning's to the second and the ten metres are taken as not arrived (0, 0).
About 1 in 100 that did arrive has the same figures by chance, and is lost with them.

Usage: python3 tools/sim/fix_apagon_tripinfo.py [--area=sanjuan] [--scenario=apagon]
"""
import json, os, sys
import numpy as np

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '../..'))
args = dict(a[2:].split('=', 1) for a in sys.argv[1:] if a.startswith('--') and '=' in a)
SIM = os.path.join(ROOT, 'public/tiles', args.get('area', 'sanjuan'), 'sim')
OUT = os.path.join(SIM, args.get('scenario', 'apagon'))
at = json.load(open(os.path.join(OUT, 'index.json')))['apagon']
trips = np.fromfile(os.path.join(OUT, 'trips.bin'), np.dtype([('kind', 'u1'), ('from', 'u1'), ('to', 'u1'), ('minute', '<u2')]))
M = np.fromfile(os.path.join(SIM, 'morning', 'tripinfo.bin'), np.uint16).reshape(-1, 2)
A = np.fromfile(os.path.join(OUT, 'tripinfo.bin'), np.uint16).reshape(-1, 2)
n = min(len(trips), len(M), len(A))
left_after = trips['minute'][:n].astype(int) * 60 >= at - 59  # (the minute is rounded down)
carried = left_after & (A[:n] == M[:n]).all(axis=1) & (A[:n, 1] > 0)
A[:n][carried] = 0
A.tofile(os.path.join(OUT, 'tripinfo.bin'))
print(f'{int(carried.sum())} of {int(left_after.sum())} cars that left after the failure had the morning\'s figures: now not arrived')
