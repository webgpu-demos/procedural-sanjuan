#!/usr/bin/env python3
"""Run the morning in SUMO (libsumo, in-process) and record every car, compactly, for the client.

Each second every car's position is sampled; when it arrives its track is simplified to the fewest knots
that keep it within TOL metres of where SUMO had it at every second (the synchronized distance: position at
the same moment, so stops at the lights, queues and lane changes survive the simplification). A car that
teleports (SUMO clearing a jam) is split there: the client hides it over the jump.

  public/tiles/<area>/sim/<scenario>/index.json  windows, types, municipios, the run's statistics
  .../w_<k>.bin    the cars on the road in window k (WINDOW s): see pack() for the layout
  .../speeds.bin   mean speed / free speed of every edge per 5 min (u8 / 255), for the ribbons
  .../trips.bin    per car: why it drives and between which municipios (the follow camera tells it)
  .../signals.json the signal plans (static), for the signal heads

Scenarios: morning (an ordinary weekday); apagon (the grid fails at APAGON_AT: every signal goes dark).
Usage: .venv-sim/bin/python tools/sim/run.py [--area=sanjuan] [--scenario=morning] [--demand=morning] [--end=10.5]
"""
import array, collections, gzip, json, math, os, struct, sys, time, xml.etree.ElementTree as ET
import numpy as np
import libsumo as ls
tc = ls  # (libsumo carries traci's constants: VAR_POSITION3D, ...)

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '../..'))
args = dict(a[2:].split('=', 1) for a in sys.argv[1:] if a.startswith('--') and '=' in a)
AREA, SCEN = args.get('area', 'sanjuan'), args.get('scenario', 'morning')
DEMAND = args.get('demand', 'morning')
SIM = os.path.join(ROOT, 'data/sim', AREA)
WORK = os.path.join(SIM, SCEN); os.makedirs(WORK, exist_ok=True)
OUT = os.path.join(ROOT, 'public/tiles', AREA, 'sim', SCEN); os.makedirs(OUT, exist_ok=True)
NET = os.path.join(SIM, f'{AREA}.net.xml.gz')
BEGIN, END = 4.5 * 3600, float(args.get('end', 10.5)) * 3600
APAGON_AT = 5.75 * 3600  # (5:45: still dark, the city lit; sunrise in late October is about 6:19 AST; the rush still to come)
# A track is kept to the knots that hold every second of it within CROSS metres of the true path sideways (out
# of its lane: that shows) and ALONG metres along it (a little early or late: that does not), and its height
# within RISE; a knot at least every MAX_GAP seconds.
CROSS, ALONG, RISE, MAX_GAP = 0.3, 1.5, 0.6, 30.0
WINDOW = 300                  # seconds of the morning per file
TYPES = ['compact', 'sedan', 'suv', 'pickup', 'truck', 'bus']  # (src/world/traffic.js TYPES, in order)
t0 = time.time()
def log(m): print(f'{time.time() - t0:7.1f}s {m}', flush=True)

# ---------------------------------------------------------------- outputs SUMO writes itself
with open(os.path.join(WORK, 'meandata.add.xml'), 'w') as f:
    f.write(f'<additional><edgeData id="speeds" freq="300" begin="{BEGIN:.0f}" file="edgedata.xml" excludeEmpty="true" '
            'writeAttributes="speed sampledSeconds entered traveltime"/></additional>')
STATE = os.path.join(SIM, 'morning', f'state_{int(APAGON_AT)}.xml.gz')  # the normal morning, as it stood when the grid failed
apagon = SCEN == 'apagon'
begin = APAGON_AT if apagon and os.path.exists(STATE) else BEGIN
# routes made beforehand (route.py), if there are: SUMO then routes only the drivers who re-plan
ROUTES = os.path.join(SIM, DEMAND, 'routes.rou.xml')
STOPS = os.path.join(SIM, DEMAND, 'busstops.add.xml')  # the AMA's stops (gtfs.py)
cmd = ['sumo', '-n', NET, '-r', ROUTES if os.path.exists(ROUTES) else os.path.join(SIM, DEMAND, 'trips.xml'), '--begin', str(begin), '--end', str(END),
       '--additional-files', os.path.join(WORK, 'meandata.add.xml') + (',' + STOPS if os.path.exists(STOPS) else ''),
       '--time-to-teleport', '240', '--ignore-route-errors', '--max-depart-delay', '900',
       '--lanechange.duration', '2.5',
       # San Juan merging: after a minute and a half at a give-way line a driver takes a smaller gap, and a car
       # stuck across a junction stops blocking it after 15 s (SUMO's defaults lock the grid at the peak)
       '--time-to-impatience', '90', '--ignore-junction-blocker', '15',  # a lane change takes its time (SUMO's default is instant): it reads as one
       # some drivers re-plan every quarter hour from the traffic as it is (a navigation app; the rest keep the
       # routes made beforehand from a previous run's travel times: route.py); single-threaded A* (SUMO's routing
       # threads only fight over locks on this machine: measured 10x slower)
       '--device.rerouting.probability', args.get('reroute', '0.15'), '--device.rerouting.period', '900', '--routing-algorithm', 'astar',
       '--tripinfo-output', os.path.join(WORK, 'tripinfo.xml'), '--statistic-output', os.path.join(WORK, 'stats.xml'),
       '--no-step-log', '--no-warnings', '--duration-log.statistics']
if SCEN == 'morning': cmd += ['--save-state.times', str(APAGON_AT), '--save-state.files', STATE, '--save-state.rng']
if begin != BEGIN: cmd += ['--load-state', STATE]  # (the apagón: the same morning until the failure)
log(' '.join(cmd[1:6]) + ' ...')
ls.start(cmd)
os.chdir(WORK)

tracks, kinds = {}, {}   # vehicle -> array of t, x, y, z per second; vehicle -> type index
starts = {}              # vehicle -> first sampled second
finished = []            # (vid, type, t0, knots float32 [n, 4]: t, x, y, z)

def simplify(t, P):
    """Indices to keep: Douglas-Peucker on the synchronized error (where the car is at the same moment), split
    into sideways, along-the-way and height parts with their own tolerances; a knot at least every MAX_GAP s."""
    n = len(t); keep = np.zeros(n, bool); keep[0] = keep[-1] = True
    stack = [(0, n - 1)]
    while stack:
        i, j = stack.pop()
        if j <= i + 1: continue
        k = np.arange(i + 1, j)
        f = ((t[k] - t[i]) / (t[j] - t[i]))[:, None]
        err = P[k] - (P[i] + (P[j] - P[i]) * f)
        ux, uy = P[j, 0] - P[i, 0], P[j, 1] - P[i, 1]; ul = math.hypot(ux, uy)
        if ul > 0.5:
            ux, uy = ux / ul, uy / ul
            along = np.abs(err[:, 0] * ux + err[:, 1] * uy); cross = np.abs(err[:, 0] * uy - err[:, 1] * ux)
        else:  # (standing, or nearly: any movement counts)
            along = cross = np.hypot(err[:, 0], err[:, 1])
        e = np.maximum(np.maximum(cross / CROSS, along / ALONG), np.abs(err[:, 2]) / RISE)
        m = int(e.argmax())
        if e[m] > 1 or t[j] - t[i] > MAX_GAP:
            if e[m] <= 1: m = len(k) // 2  # (only too long: split it in the middle)
            keep[k[m]] = True; stack += [(i, int(k[m])), (int(k[m]), j)]
    return keep

def finish(vid):
    a = tracks.pop(vid, None); starts.pop(vid, None)
    if a is None or len(a) < 24: return
    S = np.frombuffer(a, dtype=np.float32).reshape(-1, 4).astype(np.float64)
    t, P = S[:, 0], S[:, 1:]
    # a teleport (SUMO clearing a jam: the car leaves the road and comes back further on), or a car not seen
    # for a second: the track is split there, and the client hides it over the gap
    gap = np.where((np.diff(t) > 1.5) | (np.hypot(*np.diff(P[:, :2], axis=0).T) > 60))[0]
    for seg in np.split(np.arange(len(P)), gap + 1):
        if len(seg) < 3: continue
        keep = simplify(t[seg], P[seg])
        k = seg[keep]
        finished.append((int(vid.split('#')[0]), kinds[vid], np.column_stack([t[k], P[k]]).astype(np.float32)))

step, peak = 0, 0
lights_out = False
TLS = ls.trafficlight.getIDList()
lights = {tl: [] for tl in TLS}  # signal -> [(time, state)] each change of its lights
for tl in TLS: ls.trafficlight.subscribe(tl, [tc.TL_RED_YELLOW_GREEN_STATE])
def track(vid, now):
    ls.vehicle.subscribe(vid, [tc.VAR_POSITION3D])
    tracks[vid] = array.array('f'); starts[vid] = now
    typ = ls.vehicle.getTypeID(vid); kinds[vid] = TYPES.index(typ) if typ in TYPES else 0
# (started from the saved morning: the cars already on the road are tracked from here)
for vid in ls.vehicle.getIDList(): track(vid, ls.simulation.getTime())
while True:
    ls.simulationStep()
    now = ls.simulation.getTime()
    for tl, r in ls.trafficlight.getAllSubscriptionResults().items():
        st = r[tc.TL_RED_YELLOW_GREEN_STATE]
        tl_ = lights[tl]
        if not tl_ or tl_[-1][1] != st: tl_.append((now, st))
    for vid in ls.simulation.getDepartedIDList(): track(vid, now)
    for vid, r in ls.vehicle.getAllSubscriptionResults().items():
        p = r.get(tc.VAR_POSITION3D)
        a = tracks.get(vid)
        if p is None or a is None or abs(p[0]) > 1e7: continue  # (teleporting: off the road)
        a.extend((now, p[0], p[1], p[2]))
    for vid in ls.simulation.getArrivedIDList(): finish(vid)
    if apagon and now >= APAGON_AT and not lights_out:
        lights_out = True
        for tl in ls.trafficlight.getIDList(): ls.trafficlight.setProgram(tl, 'off')
        log(f'{now / 3600:.2f} h: the grid fails; {len(ls.trafficlight.getIDList())} signals go dark')
    step += 1
    peak = max(peak, len(tracks))
    if step % 900 == 0:
        log(f'{now / 3600:5.2f} h  on the road {len(tracks):6d}  finished {len(finished):7d}  waiting {ls.simulation.getMinExpectedNumber() - len(tracks)}')
    if now >= END or ls.simulation.getMinExpectedNumber() == 0: break
for vid in list(tracks): finish(vid)
ls.close()
log(f'{len(finished)} tracks, peak {peak} cars on the road at once')

# ---------------------------------------------------------------- pack: windows of the morning
# window file: u32 'SJT1' | u32 count | f32 t0 | f32 t1 | per track:
#   u32 vehicle | u8 type | u8 0 | u16 knots | f32 x0 | f32 y0 | f32 z0 | f32 t0 |
#   knots-1 x (u16 dt 0.1 s | i16 dx 5 cm | i16 dy 5 cm | i16 dz 1 cm), each from the previous knot as decoded
# (SUMO's frame: y north; the client turns it into the world's z = -y)
def encode(knots, lo, hi):
    """The knots of a track that matter in [lo, hi): one before, one after."""
    t = knots[:, 0]
    i0 = max(0, int(np.searchsorted(t, lo, 'right')) - 1); i1 = min(len(t), int(np.searchsorted(t, hi, 'left')) + 1)
    k = knots[i0:i1].astype(np.float64)
    if len(k) < 2: return None
    out = bytearray()
    x, y, z, tt = k[0, 1], k[0, 2], k[0, 3], k[0, 0]
    out += struct.pack('<ffff', x, y, z, tt)
    rx, ry, rz, rt = np.float32(x), np.float32(y), np.float32(z), np.float32(tt)
    rx, ry, rz, rt = float(rx), float(ry), float(rz), float(rt)
    for row in k[1:]:
        dt = int(round((row[0] - rt) * 10)); dx = int(round((row[1] - rx) * 20)); dy = int(round((row[2] - ry) * 20)); dz = int(round((row[3] - rz) * 100))
        dt, dx, dy, dz = min(65535, max(0, dt)), max(-32768, min(32767, dx)), max(-32768, min(32767, dy)), max(-32768, min(32767, dz))
        out += struct.pack('<Hhhh', dt, dx, dy, dz)
        rt += dt / 10; rx += dx / 20; ry += dy / 20; rz += dz / 100
    return len(k), out

windows, total = [], 0
if begin != BEGIN:
    before = json.load(open(os.path.join(ROOT, 'public/tiles', AREA, 'sim', 'morning', 'index.json')))
    for w in before['windows']:
        if w[0] < begin: windows.append([w[0], '../morning/' + w[1], w[2], w[3]])
spans = sorted(((float(k[0, 0]), float(k[-1, 0]), i) for i, (_, _, k) in enumerate(finished)))
for w0 in np.arange(begin, END, WINDOW):
    w1 = w0 + WINDOW
    body, n = bytearray(), 0
    for a, b, i in spans:
        if a >= w1: break
        if b < w0: continue
        vid, typ, knots = finished[i]
        enc = encode(knots, w0, w1)
        if not enc: continue
        cnt, data = enc
        body += struct.pack('<IBBH', vid, typ, 0, cnt) + data; n += 1
    name = f'w_{int(w0)}.bin.gz'  # (gzipped: the client inflates it with DecompressionStream)
    with gzip.open(os.path.join(OUT, name), 'wb', compresslevel=6) as f: f.write(struct.pack('<IIff', 0x31544a53, n, w0, w1) + body)
    size = os.path.getsize(os.path.join(OUT, name))
    windows.append([int(w0), name, n, size]); total += size
log(f'{len(windows)} windows, {total / 1e6:.1f} MB (gzipped)')

# ---------------------------------------------------------------- edge speeds every 5 min
edges = {}  # edge id -> index (the client maps them to roads: "e<i>" / "r<i>")
intervals = []
for ev, el in ET.iterparse('edgedata.xml', events=('end',)):
    if el.tag == 'interval':
        row = {}
        for e in el.findall('edge'):
            if e.get('speed') is None: continue
            row[e.get('id')] = float(e.get('speed'))
        intervals.append((float(el.get('begin')), row)); el.clear()
net = ET.parse(gzip.open(NET)).getroot()
free = {}
for e in net.iter('edge'):
    if e.get('function') == 'internal': continue
    ln = e.find('lane')
    if ln is not None: free[e.get('id')] = float(ln.get('speed'))
ids = sorted(free); index = {k: i for i, k in enumerate(ids)}
grid = np.full((len(intervals), len(ids)), 255, np.uint8)  # 255: no cars in that interval
for r, (_, row) in enumerate(intervals):
    for eid, v in row.items():
        if eid in index: grid[r, index[eid]] = min(254, int(round(254 * min(1, v / max(1, free[eid])))))
speed_begin = intervals[0][0] if intervals else begin
if begin != BEGIN:  # (the apagón: the normal morning's speeds until the failure)
    m = json.load(open(os.path.join(os.path.join(ROOT, 'public/tiles', AREA, 'sim', 'morning'), 'index.json')))
    rows = int((begin - m['speedBegin']) // 300)
    before = np.fromfile(os.path.join(os.path.join(ROOT, 'public/tiles', AREA, 'sim', 'morning'), 'speeds.bin'), np.uint8).reshape(-1, len(m['edges']))[:rows]
    grid = np.concatenate([before, grid]); speed_begin = m['speedBegin']
with open(os.path.join(OUT, 'speeds.bin'), 'wb') as f: f.write(grid.tobytes())
log(f'speeds: {len(grid)} intervals x {len(ids)} edges')

# ---------------------------------------------------------------- signal plans (static: the heads show them)
links = collections.defaultdict(list)  # incoming edge -> [(tls, link index, direction)]
for c in net.iter('connection'):
    if c.get('tl') and not c.get('from').startswith(':'):
        links[c.get('from')].append([c.get('tl'), int(c.get('linkIndex')), c.get('dir')])
# what each signal showed, as it changed: states numbered per signal ([time, state index] pairs)
if begin != BEGIN:  # (the apagón: the normal morning's lights until the failure)
    m = json.load(open(os.path.join(os.path.join(ROOT, 'public/tiles', AREA, 'sim', 'morning'), 'signals.json')))['timeline']
    for tl in lights:
        if tl in m: lights[tl] = [(t, m[tl]['states'][i]) for t, i in m[tl]['changes'] if t < begin] + lights[tl]
timeline = {}
for tl, ch in lights.items():
    states = sorted({st for _, st in ch}); si = {st: i for i, st in enumerate(states)}
    timeline[tl] = {'states': states, 'changes': [[round(t), si[st]] for t, st in ch]}
json.dump({'links': links, 'timeline': timeline, 'apagon': APAGON_AT if apagon else None}, open(os.path.join(OUT, 'signals.json'), 'w'))

# ---------------------------------------------------------------- why each car drives
D = json.load(open(os.path.join(SIM, DEMAND, 'trips.json')))
munis = sorted({m for _, _, a, b in D['trips'] for m in (a, b) if m})
mi = {m: i + 1 for i, m in enumerate(munis)}
KINDS = D['kinds']
rows = bytearray()
for t, k, a, b in D['trips']: rows += struct.pack('<BBBH', KINDS.index(k), mi.get(a, 0), mi.get(b, 0), int(t // 60))
with open(os.path.join(OUT, 'trips.bin'), 'wb') as f: f.write(rows)

# ---------------------------------------------------------------- the run, for the index and the report
ti = {}
for ev, el in ET.iterparse('tripinfo.xml', events=('end',)):
    if el.tag == 'tripinfo':
        ti[int(el.get('id').split('#')[0])] = (float(el.get('duration')), float(el.get('timeLoss')), float(el.get('routeLength'))); el.clear()
st = ET.parse('stats.xml').getroot()
stats = {k: dict(st.find(k).attrib) for k in ('vehicles', 'teleports', 'vehicleTripStatistics') if st.find(k) is not None}
json.dump({'version': 1, 'scenario': SCEN, 'begin': BEGIN, 'end': END, 'window': WINDOW, 'windows': windows,
           'types': TYPES, 'kinds': KINDS, 'municipios': munis, 'edges': ids, 'speedInterval': 300, 'speedBegin': speed_begin,
           'apagon': APAGON_AT if apagon else None, 'stats': stats, 'peak': peak,
           'tripinfo': {'count': len(ti), 'meanDuration': float(np.mean([v[0] for v in ti.values()])) if ti else 0,
                        'meanTimeLoss': float(np.mean([v[1] for v in ti.values()])) if ti else 0}},
          open(os.path.join(OUT, 'index.json'), 'w'))
# per-car delay (s) and distance, for the follow camera's story
with open(os.path.join(OUT, 'tripinfo.bin'), 'wb') as f:
    cars = [k for k in ti if k < 10_000_000]  # (buses are numbered from ten million: gtfs.py)
    n = max(cars) + 1 if cars else 0
    arr = np.zeros((n, 2), np.uint16)
    if begin != BEGIN:  # (the apagón: the cars that arrived before the failure keep the morning's figures)
        before = np.fromfile(os.path.join(os.path.join(ROOT, 'public/tiles', AREA, 'sim', 'morning'), 'tripinfo.bin'), np.uint16).reshape(-1, 2)
        n = max(n, len(before)); arr = np.zeros((n, 2), np.uint16); arr[:len(before)] = before
    for k in cars: dur, loss, length = ti[k]; arr[k] = (min(65535, int(loss)), min(65535, int(length / 10)))
    f.write(arr.tobytes())
log(f'done: {json.dumps(stats.get("teleports", {}))}')
