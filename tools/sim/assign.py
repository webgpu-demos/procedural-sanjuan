#!/usr/bin/env python3
"""The routes the morning's drivers settle on: SUMO's iterative assignment (duaIterate, Gawron's route choice) on the
mesoscopic simulation, ITER rounds. Each round routes everyone on the travel times the round before measured,
every quarter hour, and drives the morning again; a driver keeps a few routes and picks among them by how they went.
Routed on the free roads alone (route.py), everyone took the same shortest way: at 5 a.m. Avenida 65 de Infantería
carried at the rate of 1,700 cars an hour on its two lanes, at 7, of 7,900, and the city locked from the east.
Trips from beyond the edge leave from their municipio's gates (demand.py's TAZ), by whichever the routes favour.

Writes data/sim/<area>/<demand>/assigned.rou.alt.xml.gz (each car's routes and their odds; run.py drives it, with
the buses) and assign/ (the rounds). Takes ~4 min a round at the full demand on a 4-core machine.
Usage: .venv-sim/bin/python tools/sim/assign.py [--area=sanjuan] [--demand=morning] [--iter=10]
"""
import glob, os, shutil, subprocess, sys, time
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '../..'))
args = dict(a[2:].split('=', 1) for a in sys.argv[1:] if a.startswith('--') and '=' in a)
AREA, DEMAND, ITER = args.get('area', 'sanjuan'), args.get('demand', 'morning'), int(args.get('iter', 10))
SIM = os.path.join(ROOT, 'data/sim', AREA); DEM = os.path.join(SIM, DEMAND)
WORK = os.path.join(DEM, 'assign'); os.makedirs(WORK, exist_ok=True)
import sumo
env = dict(os.environ, SUMO_HOME=sumo.SUMO_HOME)
taz = os.path.join(DEM, 'taz.add.xml')
cmd = [sys.executable, os.path.join(sumo.SUMO_HOME, 'tools/assign/duaIterate.py'),
       '-n', os.path.join(SIM, f'{AREA}.net.xml.gz'), '-t', os.path.join(DEM, 'trips.xml'), '-l', str(ITER),
       '-b', '16200', '-e', '36900', '--mesosim', '-j', '--meso-recheck', '10', '--time-to-teleport', '300',
       '--routing-algorithm', 'CH', '-T', '-E', '-a', '900'] + (['-D', taz] if os.path.exists(taz) else []) + [
       'duarouter--routing-threads', str(os.cpu_count() or 2), 'sumo--ignore-route-errors', 'true', 'sumo--max-depart-delay', '900',
       'sumo--duration-log.statistics', 'true']
t0 = time.time()
subprocess.run(cmd, check=True, cwd=WORK, env=env)
last = sorted(glob.glob(os.path.join(WORK, '0*')))[-1]
alt = glob.glob(os.path.join(last, '*.rou.alt.xml*'))[0]
shutil.copy(alt, os.path.join(DEM, 'assigned.rou.alt.xml.gz' if alt.endswith('.gz') else 'assigned.rou.alt.xml'))
print(f'{ITER} rounds in {(time.time() - t0) / 60:.0f} min ->', os.path.relpath(alt, ROOT))
