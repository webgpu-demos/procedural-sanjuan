#!/usr/bin/env python3
"""How close is the simulated morning to the counted one?

Each road FHWA counts in the area (HPMS 2024, hpms.json) is matched to the SUMO edges under it (both
carriageways of a divided road, the same class of road, running along it), and the vehicles the simulation
sent onto them between 7 and 8 a.m. (edgeData "entered") are set against the count's peak hour:
AADT x K, K = 0.08 (the share of a weekday's traffic in the morning peak hour on urban roads; FHWA's design
hour factors run 0.08-0.10). The fit is measured with the GEH statistic, GEH = sqrt(2 (M - C)^2 / (M + C)):
under 5 is the usual standard for a calibrated model, on 85% of counts.

Writes public/tiles/<area>/sim/<scenario>/validation.json (the summary and the points for a chart) and
prints the table. Usage: .venv-sim/bin/python tools/sim/validate.py [--area=sanjuan] [--scenario=morning]
"""
import collections, gzip, json, math, os, sys, xml.etree.ElementTree as ET
import numpy as np

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '../..'))
args = dict(a[2:].split('=', 1) for a in sys.argv[1:] if a.startswith('--') and '=' in a)
AREA, SCEN = args.get('area', 'sanjuan'), args.get('scenario', 'morning')
SIM = os.path.join(ROOT, 'data/sim', AREA); WORK = os.path.join(SIM, SCEN)
OUT = os.path.join(ROOT, 'public/tiles', AREA, 'sim', SCEN)
K = float(args.get('k', 0.08)); H0, H1 = 7 * 3600, 8 * 3600
# HPMS functional system -> the SUMO priorities its road could have (tools/sim/network.mjs PRIORITY)
FSYS = {1: (12, 13), 2: (11, 13), 3: (9, 12), 4: (8, 11), 5: (7, 10), 6: (5, 9), 7: (4, 8)}

import sumolib
net = sumolib.net.readNet(os.path.join(SIM, f'{AREA}.net.xml.gz'))
grid = collections.defaultdict(list)  # 50 m cell -> edges with a point in it
for e in net.getEdges():
    if e.getFunction() == 'internal': continue
    sh = e.getShape()
    for i in range(len(sh) - 1):
        (x0, y0), (x1, y1) = sh[i][:2], sh[i + 1][:2]
        n = max(1, int(math.hypot(x1 - x0, y1 - y0) // 25))
        for k in range(n + 1):
            x, y = x0 + (x1 - x0) * k / n, y0 + (y1 - y0) * k / n
            grid[(int(x // 50), int(y // 50))].append(e)

def edges_under(seg):
    """The SUMO edges along an HPMS segment: near its middle third, the same class, parallel to it."""
    p = seg['pts']
    L = [0.0]
    for i in range(1, len(p)): L.append(L[-1] + math.dist(p[i - 1], p[i]))
    if L[-1] < 60: return []
    found = collections.Counter()
    probes = 0
    for f in (0.35, 0.5, 0.65):
        d = L[-1] * f; i = max(1, next(j for j in range(1, len(p)) if L[j] >= d))
        t = (d - L[i - 1]) / max(1e-6, L[i] - L[i - 1])
        x, y = p[i - 1][0] + (p[i][0] - p[i - 1][0]) * t, p[i - 1][1] + (p[i][1] - p[i - 1][1]) * t
        ux, uy = p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1]; ul = math.hypot(ux, uy) or 1; ux, uy = ux / ul, uy / ul
        lo, hi = FSYS.get(seg['fsys'], (4, 13))
        seen = set(); probes += 1
        for cx in range(int(x // 50) - 1, int(x // 50) + 2):
            for cy in range(int(y // 50) - 1, int(y // 50) + 2):
                for e in grid.get((cx, cy), []):
                    if e in seen or not (lo <= e.getPriority() <= hi): continue
                    seen.add(e)
                    sh = e.getShape(); best = 1e9; dot = 0
                    for a, b in zip(sh, sh[1:]):
                        vx, vy = b[0] - a[0], b[1] - a[1]; vl = math.hypot(vx, vy) or 1
                        s = max(0, min(1, ((x - a[0]) * vx + (y - a[1]) * vy) / vl ** 2))
                        dd = math.hypot(a[0] + vx * s - x, a[1] + vy * s - y)
                        if dd < best: best, dot = dd, abs(vx * ux + vy * uy) / vl
                    if best < 22 and dot > 0.85: found[e.getID()] += 1
    # an edge under most of the probes (not one crossing at a junction)
    return [e for e, n in found.items() if n >= 2 or probes == 1]

# simulated vehicles per edge, 7-8 a.m.
entered = collections.Counter()
for ev, el in ET.iterparse(os.path.join(WORK, 'edgedata.xml'), events=('end',)):
    if el.tag == 'interval':
        b = float(el.get('begin'))
        if H0 <= b < H1:
            for e in el.findall('edge'): entered[e.get('id')] += int(float(e.get('entered') or 0))
        el.clear()

H = json.load(open(os.path.join(SIM, 'hpms.json')))
rows, used = [], set()
for seg in H:
    if seg['aadt'] < 2000: continue
    es = edges_under(seg)
    if not es: continue
    key = tuple(sorted(es))
    if key in used: continue  # (several HPMS pieces over the same SUMO edges: count once)
    used.add(key)
    M = sum(entered[e] for e in es); C = seg['aadt'] * K
    geh = math.sqrt(2 * (M - C) ** 2 / (M + C)) if M + C > 0 else 0
    rows.append({'name': seg['name'], 'fsys': seg['fsys'], 'aadt': seg['aadt'], 'counted': round(C), 'simulated': M, 'geh': round(geh, 2)})

def summary(rs):
    g = np.array([r['geh'] for r in rs]); m = np.array([r['simulated'] for r in rs]); c = np.array([r['counted'] for r in rs])
    return {'n': len(rs), 'geh5': float((g < 5).mean()) if len(g) else 0, 'geh10': float((g < 10).mean()) if len(g) else 0,
            'ratio': float(m.sum() / c.sum()) if c.sum() else 0, 'r2': float(np.corrcoef(m, c)[0, 1] ** 2) if len(rs) > 2 else 0}
CLASS = {1: 'interstate / freeway', 2: 'interstate / freeway', 3: 'arterials', 4: 'arterials', 5: 'collectors', 6: 'collectors', 7: 'local'}
by = collections.defaultdict(list)
for r in rows: by[CLASS.get(r['fsys'], 'other')].append(r)
report = {'k': K, 'hour': [H0, H1], 'all': summary(rows), 'byClass': {k: summary(v) for k, v in by.items()},
          'points': [[r['counted'], r['simulated'], r['fsys']] for r in rows],
          'worst': sorted(rows, key=lambda r: -r['geh'])[:12]}
os.makedirs(OUT, exist_ok=True)
json.dump(report, open(os.path.join(OUT, 'validation.json'), 'w'))
a = report['all']
print(f"{a['n']} counted roads matched; simulated/counted {a['ratio']:.2f}; GEH<5 {a['geh5'] * 100:.0f}%, GEH<10 {a['geh10'] * 100:.0f}%, r² {a['r2']:.2f}")
for k, v in report['byClass'].items(): print(f"  {k:22s} n {v['n']:4d}  ratio {v['ratio']:.2f}  GEH<5 {v['geh5'] * 100:4.0f}%  GEH<10 {v['geh10'] * 100:4.0f}%")
print('worst:', [(r['name'], r['counted'], r['simulated']) for r in report['worst'][:6]])
