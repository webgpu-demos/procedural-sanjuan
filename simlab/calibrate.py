#!/usr/bin/env python3
"""The morning's cars, re-weighted to match the counts.

The routes the morning's cars take (route.py's, at departure, and their stories, trips.json) cross the counted roads
(HPMS, validate.py's matching) at times their free-flow travel times give (x SLOW). Each car is given a weight, so
many copies of it, between a quarter and MAX times the share scaled to F, chosen so the weighted cars' crossings in the
fitted hours (--hours, of 5-10) match AADT x K(hour) x F at the counted roads, and the totals of each class of road
match theirs, with a penalty on moving a weight away from the share: a least-squares fit (L-BFGS-B) on the log of each
car's weight. The cars that cross no fitted road keep the share; the copies of a car leave up to five minutes either
side of it. The buses stay as they were.

(SUMO's routeSampler, the usual tool, was tried first: with counts the routes cannot meet together, it filled the
shortfall with short trips, four times the cars for the same crossings. Re-weighting cannot move a car off its route:
the published routes ran down the avenues beside the expressways, the free-flow times leaving out the wait at each
light, and no weights met both; route.py --duaargs="--weights.tls-penalty 10" first.)

--holdout=1: only half the counted roads (in each class, at random) are fitted; the other half check the fit
(holdout.py). --nofit=1: the cars as they are (scaled to F), the same counts and halves, for comparison.
Writes <out>/routes.rou.xml, <out>/trips.json and <out>/points.json (the roads, fitted or held out).
Usage: calibrate.py --routes=data/sim/sanjuan/morning/routes.rou.xml --trips=data/sim/sanjuan/morning/trips.json
                    --out=data/sim/sanjuan/morning --f=0.7 [--from-share=0.7] [--hours=7] [--holdout=1] [--nofit=1]
                    [--max=4] [--seed=1] [--lam=1] [--slow=1.4]
"""
import collections, gzip, json, math, os, sys, xml.etree.ElementTree as ET
import numpy as np
import scipy.optimize, scipy.sparse

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
args = dict(a[2:].split('=', 1) for a in sys.argv[1:] if a.startswith('--') and '=' in a)
F, FROM = float(args.get('f', 1)), float(args.get('from-share', 0.7))
SEED, HOLDOUT, OUT = int(args.get('seed', 1)), args.get('holdout', '0') == '1', args['out']
LAM, SLOW = float(args.get('lam', 1)), float(args.get('slow', 1.4))  # (SLOW: travel time over free flow, the lights and the rest)
LO, HI = math.log(0.25), math.log(float(args.get('max', 4)))  # (--max: the most copies of a car, over the share)
NOFIT = args.get('nofit') == '1'  # (the cars as they were, scaled to F: the routes alone, against the same counts)
# a weekday's share of the AADT in each hour of the morning on urban roads (FHWA's traffic monitoring guide's urban
# profiles, the peak hour at validate.py's K = 0.08)
K = {5: 0.03, 6: 0.06, 7: 0.08, 8: 0.07, 9: 0.055}
K = {h: K[h] for h in map(int, args.get('hours', '5,6,7,8,9').split(','))}  # (--hours=6,7,8: the others' cars as they were)
HOURS = sorted(K)
rng = np.random.default_rng(SEED)

# ---------------------------------------------------------------- the counted roads (validate.py's matching)
src = open(os.path.join(ROOT, 'tools/sim/validate.py')).read()
g = {'__file__': os.path.join(ROOT, 'tools/sim/validate.py'), '__name__': 'calibrate'}
argv = sys.argv; sys.argv = ['validate.py', '--area=sanjuan']
exec(compile(src[:src.index('# simulated vehicles per edge')], 'validate.py', 'exec'), g)
sys.argv = argv
net = g['net']
CLASS = {1: 'freeway', 2: 'freeway', 3: 'arterial', 4: 'arterial', 5: 'collector', 6: 'collector', 7: 'local'}
points, used = [], set()
for seg in json.load(open(os.path.join(ROOT, 'data/sim/sanjuan/hpms.json'))):
    if seg['aadt'] < 2000: continue
    es = g['edges_under'](seg)
    if not es or tuple(sorted(es)) in used: continue
    used.add(tuple(sorted(es)))
    points.append({'name': seg['name'], 'fsys': seg['fsys'], 'aadt': seg['aadt'], 'edges': es, 'fit': True})
if HOLDOUT:
    by = collections.defaultdict(list)
    for i, p in enumerate(points): by[CLASS.get(p['fsys'], 'other')].append(i)
    for k in sorted(by):
        idx = rng.permutation(by[k])
        for i in idx[(len(idx) + 1) // 2:]: points[i]['fit'] = False
at = collections.defaultdict(list)  # edge -> the counted roads it is under
for i, p in enumerate(points):
    for e in p['edges']: at[e].append(i)
print(f'{len(points)} counted roads, {sum(p["fit"] for p in points)} fitted', flush=True)

# ---------------------------------------------------------------- the published morning's cars
vtypes, cars, buses = [], [], []
for ev, el in ET.iterparse(gzip.open(args['routes']) if args['routes'].endswith('.gz') else open(args['routes']), events=('end',)):
    if el.tag == 'vType': vtypes.append(ET.tostring(el, encoding='unicode').strip())
    elif el.tag == 'vehicle':
        if el.get('type') == 'bus': buses.append((float(el.get('depart')), ET.tostring(el, encoding='unicode').strip()))
        else:
            r = el.find('route')
            if r is not None:
                cars.append({'id': int(el.get('id')), 'type': el.get('type'), 'depart': float(el.get('depart')), 'edges': r.get('edges'),
                             'taz': {k: el.get(k) for k in ('fromTaz', 'toTaz') if el.get(k)}})
        el.clear()
T = json.load(gzip.open(args['trips']) if args['trips'].endswith('.gz') else open(args['trips']))
for c in cars: c['story'] = T['trips'][c['id']][1:]
print(f'{len(cars)} cars, {len(buses)} buses', flush=True)

# ---------------------------------------------------------------- when each car crosses each counted road
tt = {}
def time_on(e):
    if e not in tt:
        try: x = net.getEdge(e); tt[e] = x.getLength() / max(1, x.getSpeed()) * SLOW
        except KeyError: tt[e] = 0.0
    return tt[e]
row = lambda p, h: p * len(HOURS) + (h - HOURS[0])
ri, ci = [], []
for j, c in enumerate(cars):
    t = c['depart']
    for e in c['edges'].split():
        if e in at:
            h = int(t // 3600)
            if HOURS[0] <= h <= HOURS[-1]:
                for p in at[e]: ri.append(row(p, h)); ci.append(j)
        t += time_on(e)
A = scipy.sparse.csr_matrix((np.ones(len(ri)), (ri, ci)), shape=(len(points) * len(HOURS), len(cars)))
C = np.array([p['aadt'] * K[h] * F for p in points for h in HOURS])
fitrow = np.array([p['fit'] for p in points for h in HOURS])
Af, Cf = A[fitrow], C[fitrow]; Wd = 1 / np.maximum(Cf, 50)
w0 = np.full(len(cars), F / FROM)
free = np.asarray(Af.sum(axis=0)).ravel() > 0  # (the cars that cross a fitted road; the rest keep the share)
print(f'{A.nnz} crossings, {free.sum()} cars cross a fitted road', flush=True)

# and the totals of each class of road in each hour, as much as all its roads together (a fit of the roads alone
# leans low: a road over its count costs as much as one as far under, and the roads over are the many small ones)
grp = [f'{CLASS.get(p["fsys"], "other")} {h}' for p in points for h in HOURS if p['fit']]
names = sorted(set(grp)); gi = {n: i for i, n in enumerate(names)}
G = scipy.sparse.csr_matrix((np.ones(len(grp)), ([gi[x] for x in grp], np.arange(len(grp)))), shape=(len(names), len(grp)))
Cg = G @ Cf; Ng = np.asarray(G.sum(axis=1)).ravel(); Wg = Ng / np.maximum(Cg, 1)

def f(u):
    w = w0 * np.exp(u); L = Af @ w; r = L - Cf; rg = G @ L - Cg
    val = (r * r * Wd).sum() + (rg * rg * Wg).sum() + LAM * (w0 * u * u).sum()
    grad = w * (Af.T @ (2 * r * Wd + G.T @ (2 * rg * Wg))) + 2 * LAM * w0 * u
    return val, grad * free
if NOFIT: w = w0.copy()
else:
    res = scipy.optimize.minimize(f, np.zeros(len(cars)), jac=True, method='L-BFGS-B', bounds=[(LO, HI)] * len(cars),
                                  options={'maxiter': 400})
    w = w0 * np.exp(res.x)
    print(f'fit: {res.message} after {res.nit} steps; weights {np.percentile(w / w0, [5, 25, 50, 75, 95]).round(2)} of the share', flush=True)

# ---------------------------------------------------------------- what the weights put on the counted roads (before any driving)
def report(wt, label):
    L = A @ wt
    out = {}
    for name, sel in (('fitted', [i for i, p in enumerate(points) if p['fit']]), ('held out', [i for i, p in enumerate(points) if not p['fit']])):
        if not sel: continue
        rows = [row(i, 7) for i in sel]
        M, Cc = L[rows], np.array([points[i]['aadt'] * 0.08 for i in sel])
        geh = np.sqrt(2 * (M - Cc) ** 2 / np.maximum(M + Cc, 1e-9))
        line = f'{label:6s} {name:9s} n {len(sel):4d}  7-8 crossings/counted {M.sum() / Cc.sum():.2f}  GEH<5 {(geh < 5).mean() * 100:.0f}%  r² {np.corrcoef(M, Cc)[0, 1] ** 2:.2f}  |'
        for cl in ('freeway', 'arterial', 'collector'):
            k = [n for n, i in enumerate(sel) if CLASS.get(points[i]['fsys']) == cl]
            if k: line += f'  {cl} {M[k].sum() / Cc[k].sum():.2f}'
        print(line, flush=True)
        out[name] = {'ratio': float(M.sum() / Cc.sum()), 'geh5': float((geh < 5).mean()), 'r2': float(np.corrcoef(M, Cc)[0, 1] ** 2)}
    return out
before, after = report(w0, 'share'), report(w, 'fitted')
for label, wt in (('share', w0), ('fitted', w)):
    L = Af @ wt
    print(label, 'by hour, fitted roads, crossings/counted:', ' '.join(f'{h}h {L[np.arange(len(L)) % len(HOURS) == k].sum() / Cf[np.arange(len(Cf)) % len(HOURS) == k].sum():.2f}' for k, h in enumerate(HOURS)), flush=True)

# ---------------------------------------------------------------- write
n = np.floor(w).astype(int) + (rng.random(len(w)) < w - np.floor(w))
out = []
for c, k in zip(cars, n):
    for i in range(k):
        t = c['depart'] if i == 0 else float(np.clip(c['depart'] + rng.uniform(-300, 300), T['begin'], T['end'] - 1))
        out.append((t, None, c))
items = sorted(out + [(t, xml, None) for t, xml in buses], key=lambda x: x[0])
os.makedirs(OUT, exist_ok=True)
trips, i = [], 0
with open(os.path.join(OUT, 'routes.rou.xml'), 'w') as fo:
    fo.write('<routes>\n')
    for v in vtypes: fo.write('    ' + v + '\n')
    for t, xml, c in items:
        if xml: fo.write('    ' + xml + '\n'); continue
        taz = ''.join(f' {k}="{v}"' for k, v in c['taz'].items())
        fo.write(f'    <vehicle id="{i}" type="{c["type"]}" depart="{t:.2f}" departLane="best" departPos="random_free" departSpeed="max"{taz}>\n'
                 f'        <route edges="{c["edges"]}"/>\n    </vehicle>\n')
        trips.append([round(t), *c['story']]); i += 1
    fo.write('</routes>\n')
json.dump({'begin': T['begin'], 'end': T['end'], 'kinds': T['kinds'], 'trips': trips}, open(os.path.join(OUT, 'trips.json'), 'w'))
json.dump({'f': F, 'holdout': HOLDOUT, 'seed': SEED, 'lam': LAM, 'cars': i, 'was': len(cars), 'before': before, 'after': after,
           'points': [{k: p[k] for k in ('name', 'fsys', 'aadt', 'edges', 'fit')} for p in points]}, open(os.path.join(OUT, 'points.json'), 'w'))
print(f'{i} cars (the share at {F}: {round(len(cars) * F / FROM)}), {len(buses)} buses', flush=True)
