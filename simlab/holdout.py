#!/usr/bin/env python3
"""The simulated morning against the counts, the roads calibrate.py fitted and those it held out apart.
Usage: holdout.py --points=<calibrate's points.json> --edgedata=data/sim/sanjuan/morning/edgedata.xml --out=holdout.json"""
import collections, json, math, sys, xml.etree.ElementTree as ET
import numpy as np
args = dict(a[2:].split('=', 1) for a in sys.argv[1:] if a.startswith('--') and '=' in a)
P = json.load(open(args['points']))
entered = collections.Counter()
for ev, el in ET.iterparse(args['edgedata'], events=('end',)):
    if el.tag == 'interval':
        if 7 * 3600 <= float(el.get('begin')) < 8 * 3600:
            for e in el.findall('edge'): entered[e.get('id')] += int(float(e.get('entered') or 0))
        el.clear()
out = {}
for name, fit in (('fitted', True), ('held out', False)):
    rows = [p for p in P['points'] if p['fit'] == fit]
    if not rows: continue
    M = np.array([sum(entered[e] for e in p['edges']) for p in rows], float); C = np.array([p['aadt'] * 0.08 for p in rows])
    geh = np.sqrt(2 * (M - C) ** 2 / np.maximum(M + C, 1e-9))
    cls = {}
    for cl, fs in (('freeway', (1, 2)), ('arterial', (3, 4)), ('collector', (5, 6))):
        k = [i for i, p in enumerate(rows) if p['fsys'] in fs]
        if k: cls[cl] = {'n': len(k), 'ratio': float(M[k].sum() / C[k].sum()), 'geh5': float((geh[k] < 5).mean())}
    out[name] = {'n': len(rows), 'ratio': float(M.sum() / C.sum()), 'geh5': float((geh < 5).mean()), 'geh10': float((geh < 10).mean()),
                 'r2': float(np.corrcoef(M, C)[0, 1] ** 2), 'byClass': cls}
    print(f"{name:9s} n {len(rows):4d}  simulated/counted {out[name]['ratio']:.2f}  GEH<5 {out[name]['geh5'] * 100:.0f}%  r² {out[name]['r2']:.2f}  |",
          '  '.join(f"{k} {v['ratio']:.2f} ({v['geh5'] * 100:.0f}%)" for k, v in cls.items()))
json.dump(out, open(args['out'], 'w'))
