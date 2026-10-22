#!/usr/bin/env python3
"""Routes for the morning's trips before the simulation runs (duarouter, contraction hierarchies: seconds for
hundreds of thousands of trips), so SUMO does not route each car as it sets off. With --weights=<scenario>, the
travel times a previous run measured on each road are the cost (an earlier morning's congestion: one step
towards the routes drivers settle on); without, the roads' free travel times.

Writes data/sim/<area>/<demand>/routes.rou.xml, which run.py then drives in place of trips.xml.
Usage: .venv-sim/bin/python tools/sim/route.py [--area=sanjuan] [--demand=morning] [--weights=test25]
"""
import os, subprocess, sys, time
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '../..'))
args = dict(a[2:].split('=', 1) for a in sys.argv[1:] if a.startswith('--') and '=' in a)
AREA, DEMAND, WEIGHTS = args.get('area', 'sanjuan'), args.get('demand', 'morning'), args.get('weights')
SIM = os.path.join(ROOT, 'data/sim', AREA)
# the AMA's buses (gtfs.py), routed through their stops, with the cars
buses, stops = os.path.join(SIM, DEMAND, 'buses.xml'), os.path.join(SIM, DEMAND, 'busstops.add.xml')
files = os.path.join(SIM, DEMAND, 'trips.xml') + (',' + buses if os.path.exists(buses) else '')
cmd = [os.path.join(ROOT, '.venv-sim/bin/duarouter'), '-n', os.path.join(SIM, f'{AREA}.net.xml.gz'),
       '-r', files, '-o', os.path.join(SIM, DEMAND, 'routes.rou.xml'),
       '--routing-algorithm', 'CH', '--ignore-errors', '--no-warnings', '--no-step-log', '--repair',
       '--write-trips.junctions', 'false', '--departlane', 'best', '--departspeed', 'max']
if os.path.exists(stops): cmd += ['--additional-files', stops]
if WEIGHTS:
    # edgeData of that run: its travel times, every five minutes
    cmd += ['--weight-files', os.path.join(SIM, WEIGHTS, 'edgedata.xml'), '--weight-attribute', 'traveltime']
t0 = time.time()
subprocess.run(cmd, check=True)
print(f'routes in {time.time() - t0:.0f}s ->', os.path.relpath(os.path.join(SIM, DEMAND, 'routes.rou.xml'), ROOT))
