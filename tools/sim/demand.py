#!/usr/bin/env python3
"""A weekday morning in San Juan, 4:30 to 10:00: who drives where, and when.

A cordon model over the simulated area (the compiled city's bounding box):
  homes, jobs   the floor area of the city's own buildings (tools/sim/buildings.mjs), by use and by municipio
  commutes      the ACS 2016-2020 municipio-to-municipio commuting flows (Census table 1): residents of a
                municipio partly inside the area live in its buildings here in proportion to their floor
                area, the rest drive in through the gates on the area's edge
  gates         the roads that cross the edge of the area; a municipio's commuters use the gates towards it,
                big roads first
  departures    the time leaving home, by municipio of residence (ACS 2018-2022, B08302); trips from beyond
                the edge reach their gate later by the drive to it
  school, errands, the airport, deliveries: on top, with their own hours
Writes data/sim/<area>/<scenario>/trips.xml (SUMO routes them at departure) and trips.json (what each car
is doing: from where, to where, why: the client tells it when a car is followed).

Usage: .venv-sim/bin/python tools/sim/demand.py [--area=sanjuan] [--scale=1.0] [--seed=1]
"""
import gzip, json, math, os, random, sys, collections, xml.etree.ElementTree as ET
import numpy as np

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '../..'))
args = dict(a[2:].split('=', 1) for a in sys.argv[1:] if a.startswith('--') and '=' in a)
AREA, SCALE, SEED = args.get('area', 'sanjuan'), float(args.get('scale', 1)), int(args.get('seed', 1))
SIM, CENSUS = os.path.join(ROOT, 'data/sim', AREA), os.path.join(ROOT, 'data/sim/census')
OUT = os.path.join(SIM, args.get('scenario', 'morning'))
os.makedirs(OUT, exist_ok=True)
rng = random.Random(SEED)
np.random.seed(SEED)

BEGIN, END = 4.5 * 3600, 10 * 3600  # the window departures fall in (seconds after midnight)
VEH_PER_WORKER = 0.76  # cars on the road per worker on a weekday: 83% drive alone, 8% share (2.2 a car), ~12% off, at home or not working that day
CELL = 400.0           # metres: the zones trips start and end in

# ---------------------------------------------------------------- the frame (src/shared/geo.js)
B = json.load(open(os.path.join(SIM, 'buildings.json')))
lon0, lat0 = B['origin']['lon'], B['origin']['lat']
phi = math.radians(lat0)
M_LAT = 111132.954 - 559.822 * math.cos(2 * phi) + 1.175 * math.cos(4 * phi)
M_LON = 111412.84 * math.cos(phi) - 93.5 * math.cos(3 * phi)
def to_sumo(lon, lat): return ((lon - lon0) * M_LON, (lat - lat0) * M_LAT)  # SUMO's y is north: -z
bnd = B['bounds']  # world: x, z (south)
X0, X1, Y0, Y1 = bnd['minX'], bnd['maxX'], -bnd['maxZ'], -bnd['minZ']
inside = lambda x, y: X0 <= x <= X1 and Y0 <= y <= Y1

# ---------------------------------------------------------------- municipios
MUNI = json.load(open(os.path.join(CENSUS, 'municipios.json')))
polys = {}
for name, m in MUNI.items():
    polys[name] = [np.array([to_sumo(lon, lat) for lon, lat in ring]) for ring in m['rings']]
def centroid(rings):
    a = cx = cy = 0.0
    for r in rings:
        x, y = r[:, 0], r[:, 1]; x2, y2 = np.roll(x, -1), np.roll(y, -1); c = x * y2 - x2 * y
        a += c.sum() / 2; cx += ((x + x2) * c).sum() / 6; cy += ((y + y2) * c).sum() / 6
    return (cx / a, cy / a) if a else tuple(rings[0].mean(axis=0))
CENTRE = {n: centroid(r) for n, r in polys.items()}
def in_ring(x, y, r):
    xs, ys = r[:, 0], r[:, 1]; xj, yj = np.roll(xs, 1), np.roll(ys, 1)
    return bool(np.sum(((ys > y) != (yj > y)) & (x < (xj - xs) * (y - ys) / np.where(yj == ys, 1e-9, yj - ys) + xs)) % 2)
near = [n for n, rings in polys.items() if any(r[:, 0].max() > X0 and r[:, 0].min() < X1 and r[:, 1].max() > Y0 and r[:, 1].min() < Y1 for r in rings)]
def muni_of(x, y, hint=[None]):
    if hint[0] and any(in_ring(x, y, r) for r in polys[hint[0]]): return hint[0]
    for n in near:
        if any(in_ring(x, y, r) for r in polys[n]): hint[0] = n; return n
    return None

# ---------------------------------------------------------------- buildings -> zones
# what a square metre of floor is, by usage code (tools/pipeline/buildings.mjs): home, job, school, shop
USE = {411: (1, 0, 0, 0), 412: (1, 0, 0, 0), 413: (0.6, 0.4, 0, 0.4), 414: (0.5, 0.5, 0, 0.6), 415: (0.6, 0.4, 0, 0),
       401: (0, 1.6, 0, 0), 402: (0, 1, 0, 1), 403: (0, 0.5, 0, 0.3), 404: (0, 1, 0, 1), 421: (0, 1.4, 0, 0), 422: (0, 1, 1, 0),
       431: (0, 0.5, 0, 0), 441: (0, 0.6, 0, 0), 452: (0, 0.2, 0, 0), 454: (0, 0.1, 0, 0.1), 461: (0.7, 0.3, 0, 0.1)}
zones = {}   # (i, j) -> {muni -> [home, job, school, shop]}
mfloor = collections.defaultdict(lambda: np.zeros(4))
for x, z, floor, usage, storeys in B['rows']:
    y = -z
    w = USE.get(usage, USE[461])
    m = muni_of(x, y) or 'San Juan'
    v = np.array(w) * floor
    key = (int((x - X0) // CELL), int((y - Y0) // CELL))
    zones.setdefault(key, {}).setdefault(m, np.zeros(4))
    zones[key][m] += v
    mfloor[m] += v
print('floor by municipio inside the area (home / job / school / shop, km²):')
for m, v in sorted(mfloor.items(), key=lambda kv: -kv[1][0]): print(f'  {m:14s}', ' '.join(f'{a / 1e6:6.2f}' for a in v))

# ---------------------------------------------------------------- the network: where trips can start and end
import sumolib
net = sumolib.net.readNet(os.path.join(SIM, f'{AREA}.net.xml.gz'))
# The network's core: the roads one can both reach from and return to the main road network (a one-way
# trap, a fragment cut off at the edge of the map, cannot be a trip's end). Gates must lead into it (inbound)
# or out of it (outbound).
def reach(seed, forward):
    seen, todo = {seed}, [seed]
    while todo:
        e = todo.pop()
        for n in (e.getOutgoing() if forward else e.getIncoming()):
            if n not in seen and n.allows('passenger'): seen.add(n); todo.append(n)
    return seen
seed = max((e for e in net.getEdges() if e.getFunction() != 'internal' and e.allows('passenger')), key=lambda e: e.getPriority() * 1000 + e.getLaneNumber())
fwd, back = reach(seed, True), reach(seed, False)
core = fwd & back
print(f'network core: {len(core)} of {sum(1 for e in net.getEdges() if e.getFunction() != "internal")} edges')
cell_edges = collections.defaultdict(list)  # zone -> [(edge id, length)] of streets one can park on
gates_in, gates_out = [], []
for e in net.getEdges():
    if e.getFunction() == 'internal' or not e.allows('passenger'): continue
    a, b = e.getFromNode().getCoord(), e.getToNode().getCoord()
    if not inside(*a) and inside(*b) and e in back: gates_in.append(e)
    if inside(*a) and not inside(*b) and e in fwd: gates_out.append(e)
    if e in core and e.getPriority() <= 10 and e.getLength() > 25 and inside(*a) and inside(*b):
        shape = e.getShape(); mx, my = shape[len(shape) // 2]
        cell_edges[(int((mx - X0) // CELL), int((my - Y0) // CELL))].append((e.getID(), e.getLength()))
def capacity(e): return e.getLaneNumber() * (e.getSpeed() ** 1.5) * (4 if e.getPriority() >= 12 else 2 if e.getPriority() >= 10 else 1)
print(f'{len(gates_in)} gates in, {len(gates_out)} out; {len(cell_edges)} zones with streets')
# zones without streets borrow the nearest zone that has some
zkeys = np.array(list(cell_edges.keys()))
def edges_near(key):
    if key in cell_edges: return cell_edges[key]
    d = np.abs(zkeys - np.array(key)).sum(axis=1); return cell_edges[tuple(zkeys[d.argmin()])]
def pick_edge(key):
    es = edges_near(key); lens = np.array([l for _, l in es])
    return es[np.searchsorted(np.cumsum(lens), rng.random() * lens.sum())][0]
def gate_for(name, gates):
    cx, cy = CENTRE[name]
    pos = np.array([(g.getToNode() if gates is gates_in else g.getFromNode()).getCoord() for g in gates])
    d = np.hypot(pos[:, 0] - cx, pos[:, 1] - cy)
    w = np.array([capacity(g) for g in gates]) * np.exp(-(d - d.min()) / 2500)
    return gates, w / w.sum(), d.min()
GATE_CACHE = {}
# A trip from beyond the edge leaves its municipio by whichever of the roads towards it the router finds best (a
# TAZ: the gates within GATE_REACH of the nearest, roads of some size): drawn by the gates' sizes, half of
# Carolina's commuters had come in on Avenida 65 de Infantería, two lanes, and it stood still from five o'clock.
# (--taz=0: drawn by size and distance, as before)
TAZ, GATE_REACH = args.get('taz', '1') == '1', float(args.get('gatereach', 3000))
TAZ_IDS, TAZ_USED = {n: f'm{i}' for i, n in enumerate(sorted(MUNI))}, {}
def gate_set(name, inbound):
    gates = gates_in if inbound else gates_out
    cx, cy = CENTRE[name]
    pos = np.array([(g.getToNode() if inbound else g.getFromNode()).getCoord() for g in gates])
    d = np.hypot(pos[:, 0] - cx, pos[:, 1] - cy)
    big = np.array([g.getPriority() >= 9 or g.getLaneNumber() >= 2 for g in gates])
    keep = (d <= d.min() + GATE_REACH) & big; keep[d.argmin()] = True
    return [gates[i].getID() for i in np.flatnonzero(keep)], d.min()
def pick_gate(name, inbound):
    k = (name, inbound)
    if TAZ:
        if k not in GATE_CACHE: GATE_CACHE[k] = gate_set(name, inbound)
        ids, dist = GATE_CACHE[k]; TAZ_USED[k] = ids
        return 'taz:' + TAZ_IDS[name], dist
    if k not in GATE_CACHE: GATE_CACHE[k] = gate_for(name, gates_in if inbound else gates_out)
    gates, p, dist = GATE_CACHE[k]
    return gates[np.searchsorted(np.cumsum(p), rng.random())].getID(), dist

# ---------------------------------------------------------------- when people leave home
DEP = json.load(open(os.path.join(CENSUS, 'departures.json')))
BINS = [(0, 5), (5, 5.5), (5.5, 6), (6, 6.5), (6.5, 7), (7, 7.5), (7.5, 8), (8, 8.5), (8.5, 9), (9, 10)]
LABELS = ['00-05', '05-0530', '0530-06', '06-0630', '0630-07', '07-0730', '0730-08', '08-0830', '0830-09', '09-10']
def profile(name):
    d = DEP.get(name) or {k: sum(v[k] for v in DEP.values()) for k in ['total'] + LABELS}
    w = np.array([d[l] for l in LABELS], float); w[0] *= 0.35  # (of those leaving before 5, the ones still on the road after 4:30)
    return w
# (the departures are tabled for the six municipios round the area; any other leaves home as all six together do. The
# share had been their sum over San Juan's workers alone, 2.4 for 0.83: Toa Baja and Toa Alta drove in three times over)
ALL = {k: sum(v[k] for v in DEP.values()) for k in ['total'] + LABELS}
AM_SHARE = {n: profile(n).sum() / (DEP.get(n) or ALL)['total'] for n in MUNI}
def depart_time(name):
    w = profile(name); i = np.searchsorted(np.cumsum(w), rng.random() * w.sum())
    lo, hi = BINS[i]; lo = max(lo, 4.5)
    return (lo + rng.random() * (hi - lo)) * 3600

# ---------------------------------------------------------------- trip ends inside the area
def zone_sampler(name, kind):
    keys, w = [], []
    for k, ms in zones.items():
        v = ms.get(name)
        if v is not None and v[kind] > 0: keys.append(k); w.append(v[kind])
    return keys, np.array(w)
SAMPLERS = {}
def sample_zone(name, kind, near_xy=None, decay=None):
    k = (name, kind)
    if k not in SAMPLERS: SAMPLERS[k] = zone_sampler(name, kind)
    keys, w = SAMPLERS[k]
    if not keys: return None
    if near_xy is not None and decay:
        c = np.array([(X0 + (a + 0.5) * CELL, Y0 + (b + 0.5) * CELL) for a, b in keys])
        w = w * np.exp(-np.hypot(c[:, 0] - near_xy[0], c[:, 1] - near_xy[1]) / decay)
    return keys[np.searchsorted(np.cumsum(w), rng.random() * w.sum())]
zc = lambda key: (X0 + (key[0] + 0.5) * CELL, Y0 + (key[1] + 0.5) * CELL)

# share of a municipio's residents (or jobs) living (working) inside the area: its floor here against San
# Juan's floor per resident worker (per job), San Juan lying wholly inside
FLOWS = json.load(open(os.path.join(CENSUS, 'pr_flows.json')))
live, work = collections.Counter(), collections.Counter()
for f in FLOWS: live[f['from']] += f['n']; work[f['to']] += f['n']
home_per_worker = mfloor['San Juan'][0] / live['San Juan']
job_per_job = mfloor['San Juan'][1] / work['San Juan']
h_in = {m: min(1, mfloor[m][0] / (live[m] * home_per_worker)) if live[m] else 0 for m in MUNI}
j_in = {m: min(1, mfloor[m][1] / (work[m] * job_per_job)) if work[m] else 0 for m in MUNI}
h_in['San Juan'] = j_in['San Juan'] = 1.0
print('share inside the area (homes, jobs):', {m: (round(h_in[m], 2), round(j_in[m], 2)) for m in near})

import functools
@functools.lru_cache(maxsize=None)
def crosses(a, b):
    """Does the straight line between two municipio centres pass over the area?"""
    (x1, y1), (x2, y2) = CENTRE[a], CENTRE[b]
    for t in np.linspace(0, 1, 60):
        if inside(x1 + (x2 - x1) * t, y1 + (y2 - y1) * t): return True
    return False

# ---------------------------------------------------------------- trips
trips = []  # (depart, from edge, to edge, type, story)
TYPES = ['compact', 'sedan', 'suv', 'pickup']
CAR_SHARE = [0.28, 0.25, 0.30, 0.17]
def car_type(): return TYPES[np.searchsorted(np.cumsum(CAR_SHARE), rng.random())]
def add(t, a, b, kind, story, typ=None):
    if a and b and a != b and BEGIN <= t < END: trips.append((t, a, b, typ or car_type(), kind, story))

def poisson(x): return np.random.poisson(x) if x > 0 else 0
stats = collections.Counter()
for f in FLOWS:
    a, b, n = f['from'], f['to'], f['n']
    if b not in MUNI: continue  # (abroad)
    if not (h_in.get(a, 0) > 0 or j_in.get(b, 0) > 0 or crosses(a, b)): continue
    cars = poisson(n * VEH_PER_WORKER * AM_SHARE[a] * SCALE)
    for _ in range(cars):
        t = depart_time(a)
        o_in, d_in = rng.random() < h_in.get(a, 0), rng.random() < j_in.get(b, 0)
        if o_in:
            oz = sample_zone(a, 0); o = pick_edge(oz) if oz else None; ox = zc(oz) if oz else CENTRE[a]
        else:
            o, dist = pick_gate(a, True); ox = CENTRE[a]; t += dist / 15.0  # (the drive to the edge, at ~55 km/h)
        if d_in:
            dz = sample_zone(b, 1, ox, 6000 if a == b else None); d = pick_edge(dz) if dz else None
        else:
            if not o_in and not crosses(a, b): continue
            d, _ = pick_gate(b, False)
        kind = 'work' if (o_in or d_in) else 'through'
        stats[kind] += 1
        add(t, o, d, kind, [a, b])

# school runs: a parent drives to school and back, 6:40-7:55 (private schools; public school buses are few)
for m in near:
    if h_in.get(m, 0) <= 0: continue
    kids = live[m] * h_in[m] * 0.42 * 0.5 * SCALE   # ~0.42 school-age children per worker here; half driven
    for _ in range(poisson(kids * 0.55)):            # (siblings share a car)
        hz = sample_zone(m, 0)
        if not hz: break
        sz = sample_zone(m, 2, zc(hz), 2500) or sample_zone('San Juan', 2, zc(hz), 2500)
        if not sz: continue
        h, s = pick_edge(hz), pick_edge(sz)
        t = rng.gauss(7.3, 0.28) * 3600
        add(t, h, s, 'school', [m, m]); add(t + rng.uniform(300, 700), s, h, 'school-return', [m, m])
        stats['school'] += 2

# errands, the doctor, the supermarket: 7:30-10:00, rising through the morning
for m in near:
    if h_in.get(m, 0) <= 0: continue
    for _ in range(poisson(live[m] * h_in[m] * 0.22 * SCALE)):
        hz = sample_zone(m, 0)
        if not hz: break
        sz = sample_zone(m, 3, zc(hz), 2000) or sample_zone('San Juan', 3, zc(hz), 2000)
        if not sz: continue
        t = (7.5 + 2.5 * math.sqrt(rng.random())) * 3600
        add(t, pick_edge(hz), pick_edge(sz), 'errand', [m, m]); stats['errand'] += 1

# the airport (Luis Muñoz Marín, Isla Verde): drop-offs for the morning's flights, from homes and from the
# hotels, earliest flights first; most of the cars that drop someone off drive back
AIRPORT = to_sumo(-66.0018, 18.4394)
air_edges = [(e.getID(), e.getLength()) for e in core if e.getPriority() <= 10 and e.getLength() > 30
             and math.dist(e.getShape()[len(e.getShape()) // 2][:2], AIRPORT) < 450]
hotels = [k for k, ms in zones.items() for m, v in ms.items() if v[3] > 0]  # (shops and hotels: tourists' zones)
if air_edges:
    for _ in range(poisson(6000 * SCALE)):
        t = (4.5 + 5 * rng.betavariate(1.6, 2.8)) * 3600
        m = 'San Juan' if rng.random() < 0.75 else rng.choice([n for n in near if h_in.get(n, 0) > 0])
        hz = sample_zone(m, 0)
        if not hz: continue
        a = pick_edge(hz); b = rng.choice(air_edges)[0]
        add(t, a, b, 'airport', [m, 'Carolina']); stats['airport'] += 1
        if rng.random() < 0.7: add(t + rng.uniform(900, 1500), b, a, 'airport-return', ['Carolina', m]); stats['airport'] += 1

# deliveries and freight: trucks from the gates and the industrial zones to the shops, from 5:00
for _ in range(poisson(len(trips) * 0.045)):
    t = rng.uniform(5.0, 10.0) * 3600
    o = pick_gate(rng.choice(['Bayamón', 'Carolina', 'Caguas', 'Guaynabo']), True)[0] if rng.random() < 0.5 else pick_edge(sample_zone('San Juan', 1))
    sz = sample_zone('San Juan', 3)
    if sz: add(t, o, pick_edge(sz), 'delivery', ['', 'San Juan'], 'truck'); stats['delivery'] += 1

trips.sort(key=lambda r: r[0])
print(f'{len(trips)} trips:', dict(stats), f'(scale {SCALE})')
hours = collections.Counter(int(t // 1800) / 2 for t, *_ in trips)
print('departures by half hour:', ' '.join(f'{h:.1f}h {hours[h]}' for h in sorted(hours)))

# ---------------------------------------------------------------- write
VTYPES = {  # lengths as the models (src/world/traffic.js TYPES); Puerto Rico drives a little over the limit (the bus: gtfs.py)
    'compact': dict(length=4.2, width=1.74, accel=2.8, decel=4.5, maxSpeed=48),
    'sedan': dict(length=4.8, width=1.82, accel=2.6, decel=4.5, maxSpeed=50),
    'suv': dict(length=4.7, width=1.9, accel=2.5, decel=4.5, maxSpeed=48),
    'pickup': dict(length=5.6, width=1.95, accel=2.4, decel=4.5, maxSpeed=46),
    'truck': dict(length=7.0, width=2.3, accel=1.3, decel=4.0, maxSpeed=30, vClass='delivery'),
}
# (San Juan drives close: 2 m gaps, less dawdling than SUMO's default driver; the capacity that comes of it is
# what the counts are checked against. The headway, tau, stays at SUMO's step of 1 s: below it Krauss drivers
# can run into the car ahead, and SUMO clears each crash by teleporting a car: at 0.9 s, one car in six.)
# (--vtype=a=1;b=2: more of SUMO's driver parameters, for every type)
VEXTRA = dict(kv.split('=', 1) for kv in args.get('vtype', '').split(';') if '=' in kv)
with open(os.path.join(OUT, 'trips.xml'), 'w') as fx:
    fx.write('<routes>\n')
    for k, v in VTYPES.items():
        cls = v.pop('vClass', 'passenger')
        drive = dict(speedFactor='normc(1.06,0.1,0.75,1.35)', sigma=0.3, tau=1.0, minGap=2.0, lcStrategic=1.2, lcCooperative=0.8, lcAssertive=1.3, impatience=0.5)
        drive.update(VEXTRA)
        fx.write(f'  <vType id="{k}" vClass="{cls}" ' + ' '.join(f'{a}="{b}"' for a, b in {**v, **drive}.items()) + '/>\n')
    end = lambda k, e: f'{k}Taz="{e[4:]}"' if e.startswith('taz:') else f'{k}="{e}"'
    for i, (t, a, b, typ, kind, story) in enumerate(trips):
        fx.write(f'  <trip id="{i}" type="{typ}" depart="{t:.0f}" {end("from", a)} {end("to", b)} departLane="best" departSpeed="max" departPos="random_free"/>\n')
    fx.write('</routes>\n')
# the municipios' gates (route.py and the assignment route with --with-taz)
with open(os.path.join(OUT, 'taz.add.xml'), 'w') as fx:
    fx.write('<additional>\n')
    for name in sorted({n for n, _ in TAZ_USED}):
        fx.write(f'  <taz id="{TAZ_IDS[name]}" name="{name}">\n')
        for g in TAZ_USED.get((name, True), []): fx.write(f'    <tazSource id="{g}" weight="1"/>\n')
        for g in TAZ_USED.get((name, False), []): fx.write(f'    <tazSink id="{g}" weight="1"/>\n')
        fx.write('  </taz>\n')
    fx.write('</additional>\n')
json.dump({'begin': BEGIN, 'end': END, 'kinds': sorted({k for *_, k, _ in trips}),
           'trips': [[round(t), k, s[0], s[1]] for t, a, b, typ, k, s in trips]}, open(os.path.join(OUT, 'trips.json'), 'w'))
print('->', os.path.relpath(OUT, ROOT))
