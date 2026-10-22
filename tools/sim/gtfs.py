#!/usr/bin/env python3
"""The AMA's buses, on their own routes and timetables, from the ATI's official GTFS feed (PRITA_GTFS.zip):
every bus trip of a Tuesday that runs in the simulated morning and stops in the area becomes a SUMO bus that
calls at its stops in order, waiting at each until its timetabled departure.

  stops     each GTFS stop on the nearest lane a bus may use, within 35 m (a stop with none is passed by)
  trips     from the first stop in the area to the last, through the others (duarouter routes it via them)
Writes data/sim/<area>/<demand>/buses.xml (the bus trips) and busstops.add.xml (the stops), and
public/tiles/<area>/sim/buses.json (each bus's route, for the follow camera). The feed: ATI, Gobierno de
Puerto Rico (not affiliated with ATI; its terms: https://www.ati.pr.gov/relaciones-comunidad?tab=DatosAbiertos).
Usage: .venv-sim/bin/python tools/sim/gtfs.py [--area=sanjuan] [--demand=morning]
"""
import csv, io, json, math, os, sys, urllib.request, zipfile, collections
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '../..'))
args = dict(a[2:].split('=', 1) for a in sys.argv[1:] if a.startswith('--') and '=' in a)
AREA, DEMAND = args.get('area', 'sanjuan'), args.get('demand', 'morning')
SIM = os.path.join(ROOT, 'data/sim', AREA); OUT = os.path.join(SIM, DEMAND)
FEED = os.path.join(ROOT, 'data/sim/gtfs/PRITA_GTFS.zip')
BEGIN, END = 4.5 * 3600, 10 * 3600
if not os.path.exists(FEED):
    os.makedirs(os.path.dirname(FEED), exist_ok=True)
    open(FEED, 'wb').write(urllib.request.urlopen('https://docs.pr.gov/files/ATI/DATOS_ABIERTOS/GTFS/PRITA_GTFS.zip', timeout=300).read())
z = zipfile.ZipFile(FEED)
read = lambda name: list(csv.DictReader(io.TextIOWrapper(z.open(name), 'utf-8-sig')))

B = json.load(open(os.path.join(SIM, 'buildings.json')))
lon0, lat0 = B['origin']['lon'], B['origin']['lat']; phi = math.radians(lat0)
M_LAT = 111132.954 - 559.822 * math.cos(2 * phi) + 1.175 * math.cos(4 * phi); M_LON = 111412.84 * math.cos(phi) - 93.5 * math.cos(3 * phi)
b = B['bounds']
inside = lambda x, y: b['minX'] <= x <= b['maxX'] and b['minZ'] <= -y <= b['maxZ']

routes = {r['route_id']: r for r in read('routes.txt')}
TUESDAY = {s['service_id'] for s in read('calendar.txt') if s['tuesday'] == '1'}
trips = {t['trip_id']: t for t in read('trips.txt') if t['service_id'] in TUESDAY and routes[t['route_id']]['route_type'] == '3'}
stops = {s['stop_id']: s for s in read('stops.txt')}
hms = lambda v: sum(int(p) * m for p, m in zip(v.split(':'), (3600, 60, 1)))
calls = collections.defaultdict(list)
for st in read('stop_times.txt'):
    if st['trip_id'] in trips: calls[st['trip_id']].append((int(st['stop_sequence']), st['stop_id'], hms(st['arrival_time']), hms(st['departure_time'])))

import sumolib
net = sumolib.net.readNet(os.path.join(SIM, f'{AREA}.net.xml.gz'))
placed = {}
def place(sid):
    if sid in placed: return placed[sid]
    s = stops[sid]; x, y = (float(s['stop_lon']) - lon0) * M_LON, (float(s['stop_lat']) - lat0) * M_LAT
    best = None
    if inside(x, y):
        for lane, d in sorted(net.getNeighboringLanes(x, y, 35), key=lambda ld: ld[1]):
            e = lane.getEdge()
            if e.getFunction() == 'internal' or not lane.allows('bus') or e.getPriority() >= 13: continue
            if lane.getIndex() != 0: continue  # (the kerb lane)
            pos = lane.getClosestLanePosAndDist((x, y))[0]
            L = lane.getLength()
            if L < 16: continue
            pos = min(max(pos, 13), L - 1)
            best = (lane.getID(), pos - 12, pos, e.getID()); break
    placed[sid] = best
    return best

buses, used = [], set()
for tid, cs in calls.items():
    cs.sort()
    here = [(seq, sid, arr, dep) for seq, sid, arr, dep in cs if place(sid)]
    if len(here) < 2 or here[-1][2] < BEGIN or here[0][3] > END: continue
    # the stops the bus reaches in the morning
    here = [c for c in here if BEGIN - 600 <= c[3] <= END + 600]
    if len(here) < 2: continue
    # (two stops in a row on one edge but out of order along it would make the route turn back: keep the first)
    clean = [here[0]]
    for c in here[1:]:
        if place(c[1])[3] == place(clean[-1][1])[3] and place(c[1])[2] <= place(clean[-1][1])[2]: continue
        clean.append(c)
    if len(clean) < 2: continue
    buses.append((tid, clean)); used.update(c[1] for c in clean)

with open(os.path.join(OUT, 'busstops.add.xml'), 'w') as f:
    f.write('<additional>\n')
    for sid in sorted(used):
        lane, a, e, _ = placed[sid]
        name = stops[sid]['stop_name'].replace('&', '&amp;').replace('"', '&quot;').replace('<', '&lt;')
        f.write(f'  <busStop id="s{sid}" lane="{lane}" startPos="{a:.1f}" endPos="{e:.1f}" name="{name}"/>\n')
    f.write('</additional>\n')
first = int(args.get('first', 10_000_000))  # bus ids: after every car's (run.py reads ids as numbers)
info = {}
with open(os.path.join(OUT, 'buses.xml'), 'w') as f:
    f.write('<routes>\n')
    for k, (tid, cs) in enumerate(sorted(buses, key=lambda b: b[1][0][3])):
        vid = first + k; r = routes[trips[tid]['route_id']]
        f.write(f'  <trip id="{vid}" type="bus" depart="{max(BEGIN, cs[0][3] - 30)}" from="{placed[cs[0][1]][3]}" to="{placed[cs[-1][1]][3]}" departPos="base" departLane="best">\n')
        for seq, sid, arr, dep in cs: f.write(f'    <stop busStop="s{sid}" duration="20" until="{dep}"/>\n')
        f.write('  </trip>\n')
        info[vid] = [r['route_short_name'], r['route_long_name'], trips[tid].get('trip_headsign') or '', '#' + r['route_color']]
    f.write('</routes>\n')
os.makedirs(os.path.join(ROOT, 'public/tiles', AREA, 'sim'), exist_ok=True)
json.dump(info, open(os.path.join(ROOT, 'public/tiles', AREA, 'sim', 'buses.json'), 'w'))
print(f'{len(buses)} bus trips on {len({trips[t]["route_id"] for t, _ in buses})} routes, {len(used)} stops in the area '
      f'(of {sum(1 for s in placed.values() if s)} placed)')

# ---------------------------------------------------------------- the ferries across the bay (route type 4)
# Their path (the GTFS shape) and their crossings in the morning, for the client to sail (src/world/ferries.js).
shapes = collections.defaultdict(list)
for p in read('shapes.txt'): shapes[p['shape_id']].append((int(p['shape_pt_sequence']), float(p['shape_pt_lon']), float(p['shape_pt_lat'])))
ferry_trips = {t['trip_id']: t for t in read('trips.txt') if t['service_id'] in TUESDAY and routes[t['route_id']]['route_type'] == '4'}
fcalls = collections.defaultdict(list)
for st in read('stop_times.txt'):
    if st['trip_id'] in ferry_trips: fcalls[st['trip_id']].append((int(st['stop_sequence']), hms(st['arrival_time']), hms(st['departure_time'])))
ferries = []
for tid, t in ferry_trips.items():
    cs = sorted(fcalls[tid])
    if len(cs) < 2 or cs[-1][1] < BEGIN or cs[0][2] > END: continue
    pts = [((lon - lon0) * M_LON, -(lat - lat0) * M_LAT) for _, lon, lat in sorted(shapes.get(t.get('shape_id'), []))]
    if len(pts) < 2 or not any(inside(x, -z) for x, z in pts): continue
    ferries.append({'route': routes[t['route_id']]['route_long_name'], 'depart': cs[0][2], 'arrive': cs[-1][1],
                    'path': [[round(x, 1), round(z, 1)] for x, z in pts]})
json.dump(ferries, open(os.path.join(ROOT, 'public/tiles', AREA, 'sim', 'ferries.json'), 'w'))
print(f'{len(ferries)} ferry crossings in the morning:', sorted({f["route"] for f in ferries}))
