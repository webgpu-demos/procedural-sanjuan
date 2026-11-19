# evalcut.py <R> <cut net> name=dir ...  : validate.py's matching, on the cut-out's counted roads, 7-8 a.m.
import gzip, collections, json, math, os, sys, re, xml.etree.ElementTree as ET
import numpy as np
R, NET = sys.argv[1:3]; runs = [a.split('=') for a in sys.argv[3:]]
FSYS = {1: (12, 13), 2: (11, 13), 3: (9, 12), 4: (8, 11), 5: (7, 10), 6: (5, 9), 7: (4, 8)}
K = 0.08
import sumolib
net = sumolib.net.readNet(NET)
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
    """The SUMO edges carrying an HPMS segment's traffic: in each direction, the main carriageway along it
    (the most lanes, then the nearest, within 45 m of the counted line, which runs down the median of a
    divided road), seen at three points along its middle; a road's two directions are summed (AADT counts both)."""
    p = seg['pts']
    L = [0.0]
    for i in range(1, len(p)): L.append(L[-1] + math.dist(p[i - 1], p[i]))
    if L[-1] < 60: return []
    lo, hi = FSYS.get(seg['fsys'], (4, 13))
    votes = {1: collections.Counter(), -1: collections.Counter()}
    for f in (0.35, 0.5, 0.65):
        d = L[-1] * f; i = max(1, next(j for j in range(1, len(p)) if L[j] >= d))
        t = (d - L[i - 1]) / max(1e-6, L[i] - L[i - 1])
        x, y = p[i - 1][0] + (p[i][0] - p[i - 1][0]) * t, p[i - 1][1] + (p[i][1] - p[i - 1][1]) * t
        ux, uy = p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1]; ul = math.hypot(ux, uy) or 1; ux, uy = ux / ul, uy / ul
        best = {1: None, -1: None}
        seen = set()
        for cx in range(int(x // 50) - 1, int(x // 50) + 2):
            for cy in range(int(y // 50) - 1, int(y // 50) + 2):
                for e in grid.get((cx, cy), []):
                    if e in seen or not (lo <= e.getPriority() <= hi): continue
                    seen.add(e)
                    sh = e.getShape(); dist = 1e9; dot = 0
                    for a, b in zip(sh, sh[1:]):
                        vx, vy = b[0] - a[0], b[1] - a[1]; vl = math.hypot(vx, vy) or 1
                        s = max(0, min(1, ((x - a[0]) * vx + (y - a[1]) * vy) / vl ** 2))
                        dd = math.hypot(a[0] + vx * s - x, a[1] + vy * s - y)
                        if dd < dist: dist, dot = dd, (vx * ux + vy * uy) / vl
                    if dist > 45 or abs(dot) < 0.85: continue
                    side = 1 if dot > 0 else -1
                    score = (e.getLaneNumber(), -dist)
                    if best[side] is None or score > best[side][0]: best[side] = (score, e.getID())
        for side in (1, -1):
            if best[side]: votes[side][best[side][1]] += 1
    out = []
    for side in (1, -1):
        if votes[side]:
            e, n = votes[side].most_common(1)[0]
            if n >= 2: out.append(e)
    return out


H = json.load(open(R + '/data/sim/sanjuan/hpms.json'))
segs, used = [], set()
for seg in H:
    if seg['aadt'] < 2000: continue
    es = edges_under(seg)
    if not es: continue
    key = tuple(sorted(es))
    if key in used: continue
    used.add(key); segs.append((seg, es))
CLASS = {1: 'freeways', 2: 'freeways', 3: 'arterials', 4: 'arterials', 5: 'collectors', 6: 'collectors'}
MAIN = {'PR-22 mainline': 'Autopista José de Diego', 'PR-18 mainline': 'Expreso Las Américas'}
print(len(segs), 'counted roads in the cut-out')
for name, d in runs:
    ent = collections.Counter(); spd = {}
    try:
        for ev, el in ET.iterparse((gzip.open(d + '/edgedata.xml.gz') if os.path.exists(d + '/edgedata.xml.gz') else d + '/edgedata.xml'), events=('end',)):
            if el.tag == 'interval':
                if 25200 <= float(el.get('begin')) < 28800:
                    for e in el.findall('edge'): ent[e.get('id')] += int(float(e.get('entered') or 0)); spd[e.get('id')] = float(e.get('speed') or 0)
                el.clear()
    except ET.ParseError: pass
    by = collections.defaultdict(list)
    for seg, es in segs:
        M = sum(ent[e] for e in es); C = seg['aadt'] * K; g = math.sqrt(2 * (M - C) ** 2 / (M + C)) if M + C else 0
        by['all'].append((C, M, g)); by[CLASS.get(seg['fsys'], 'other')].append((C, M, g))
        for k, nm in MAIN.items():
            if all(net.getEdge(e).getName() == nm for e in es) and len(es) == 2: by[k].append((C, M, g))
    log = open(d + '/log').read().replace(chr(13), chr(10))
    f = lambda k: (re.findall(k + r'\D*([\d.]+)', log) or ['?'])[-1]
    print(f"== {name}: inserted {f('Inserted:')} of {f('Loaded:')}, running at 8:30 {f('Running:')}, teleports {f('Teleports:')} (jam {f('Jam:')}, yield {f('Yield:')}), time loss {f('TimeLoss:')} s, speed {f(' Speed:')}")
    for k in ('all', 'freeways', 'PR-22 mainline', 'PR-18 mainline', 'arterials', 'collectors'):
        v = by[k]
        if v: print(f"  {k:16s} n {len(v):4d}  simulated/counted {sum(m for _, m, _ in v) / sum(c for c, _, _ in v):.2f}  GEH<5 {100 * sum(g < 5 for *_, g in v) / len(v):3.0f}%  GEH<10 {100 * sum(g < 10 for *_, g in v) / len(v):3.0f}%")
