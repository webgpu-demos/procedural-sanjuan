#!/usr/bin/env python3
"""What the network must pass before a run is made on it.

  backward  a junction's internal link (the way a car takes across it) that starts more than MAX metres behind the end
            of the lane it leaves: SUMO puts the car back that far when it enters the junction, and the client draws
            the car hopping backwards (netconvert's --ramps.guess made 22 of them on PR-18 and PR-22, 2026-11).

Exits 1 when anything fails; prints the worst first, with where they are in world metres (x, z = -y).
Usage: .venv-sim/bin/python tools/sim/checknet.py [--area=sanjuan | <net.xml.gz>] [--max=1] [--top=30]
"""
import math, os, sys
import sumolib

args = [a for a in sys.argv[1:] if not a.startswith('--')]
opts = dict(a[2:].split('=', 1) for a in sys.argv[1:] if a.startswith('--') and '=' in a)
MAX, TOP = float(opts.get('max', 1)), int(opts.get('top', 30))
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..')
area = opts.get('area', 'sanjuan')
path = args[0] if args else os.path.join(ROOT, 'data', 'sim', area, f'{area}.net.xml.gz')
net = sumolib.net.readNet(path, withInternal=True)

bad, links = [], 0
for edge in net.getEdges(withInternal=False):
    for lane in edge.getLanes():
        shape = lane.getShape()
        if len(shape) < 2: continue
        (ax, ay), (bx, by) = shape[-2][:2], shape[-1][:2]
        l = math.hypot(bx - ax, by - ay)
        if l < 1e-6: continue
        dx, dy = (bx - ax) / l, (by - ay) / l
        for c in lane.getOutgoing():
            via = c.getViaLaneID()
            if not via: continue
            links += 1
            vx, vy = net.getLane(via).getShape()[0][:2]
            behind = (bx - vx) * dx + (by - vy) * dy  # (how far back along the lane the link starts)
            if behind > MAX:
                bad.append((behind, lane.getID(), via, bx, -by, edge.getName()))

bad.sort(reverse=True)
print(f'{os.path.relpath(path, ROOT)}: {links} junction links; {len(bad)} start more than {MAX:g} m behind the lane they leave')
for behind, lane, via, x, z, name in bad[:TOP]:
    print(f'  {behind:6.1f} m  {lane:24s} -> {via:28s} world ({x:6.0f}, {z:6.0f}) {name}')
sys.exit(1 if bad else 0)
