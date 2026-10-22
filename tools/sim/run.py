#!/usr/bin/env python3
"""Run the morning in SUMO and record every car, compactly, for the client.

SUMO runs on its own (a subprocess, 4-5x faster than stepping it from Python here) and writes every car's position
each second (fcd.csv.gz), every change of every signal (tls.xml), the road speeds (edgedata.xml) and each trip
(tripinfo.xml). The positions are then read back in large batches: each car's track is simplified to the fewest
knots that hold every second of it within CROSS metres of where SUMO had it sideways (out of its lane: that
shows) and ALONG metres along its way (a little early or late: that does not). A car that teleports (SUMO
clearing a jam) is split there: the client hides it over the jump.

  public/tiles/<area>/sim/<scenario>/index.json  windows, types, municipios, the run's statistics
  .../w_<t>.bin.gz  the cars on the road in each five-minute window: see encode() for the layout
  .../speeds.bin    mean speed / free speed of every edge per 5 min (u8 / 254; 255 no cars), for the jam map
  .../trips.bin     per car: why it drives and between which municipios (the follow camera tells it)
  .../tripinfo.bin  per car: its delay and its distance
  .../signals.json  every signal's changes, and the links of the roads into it, for the signal heads

Scenarios: morning (an ordinary weekday); apagon (the grid fails at APAGON_AT: every signal goes dark; it
starts from the morning's state saved then).
Usage: .venv-sim/bin/python tools/sim/run.py [--area=sanjuan] [--scenario=morning] [--demand=morning] [--end=10.25]
"""
import collections, gzip, json, math, os, struct, subprocess, sys, time, xml.etree.ElementTree as ET
import numpy as np
import pyarrow as pa, pyarrow.csv as pacsv, pyarrow.compute as pc

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '../..'))
args = dict(a[2:].split('=', 1) for a in sys.argv[1:] if a.startswith('--') and '=' in a)
AREA, SCEN = args.get('area', 'sanjuan'), args.get('scenario', 'morning')
DEMAND = args.get('demand', 'morning')
SIM = os.path.join(ROOT, 'data/sim', AREA)
WORK = os.path.join(SIM, SCEN); os.makedirs(WORK, exist_ok=True)
OUT = os.path.join(ROOT, 'public/tiles', AREA, 'sim', SCEN); os.makedirs(OUT, exist_ok=True)
NET = os.path.join(SIM, f'{AREA}.net.xml.gz')
BEGIN, END = 4.5 * 3600, float(args.get('end', 10.25)) * 3600
APAGON_AT = 5.75 * 3600  # (5:45: still dark, the city lit; sunrise in late October is about 6:19 AST; the rush still to come)
CROSS, ALONG, RISE, MAX_GAP = 0.3, 1.5, 0.6, 30.0
WINDOW = 300                  # seconds of the morning per file
TYPES = ['compact', 'sedan', 'suv', 'pickup', 'truck', 'bus']  # (src/world/traffic.js TYPES, in order)
t0 = time.time()
def log(m): print(f'{time.time() - t0:7.1f}s {m}', flush=True)
os.chdir(WORK)

# ---------------------------------------------------------------- what SUMO writes besides the positions
net = ET.parse(gzip.open(NET)).getroot()
TLS = {tl.get('id'): len(tl.find('phase').get('state')) for tl in net.iter('tlLogic')}
with open('outputs.add.xml', 'w') as f:
    f.write('<additional>\n')
    f.write(f'  <edgeData id="speeds" freq="300" begin="{BEGIN:.0f}" file="edgedata.xml" excludeEmpty="true" writeAttributes="speed sampledSeconds entered traveltime"/>\n')
    for tl in TLS: f.write(f'  <timedEvent type="SaveTLSSwitchStates" source="{tl}" dest="tls.xml"/>\n')
    f.write('</additional>\n')
apagon = SCEN == 'apagon'
STATE = os.path.join(SIM, 'morning', f'state_{int(APAGON_AT)}.xml.gz')  # the normal morning, as it stood when the grid failed
begin = APAGON_AT if apagon and os.path.exists(STATE) else BEGIN
extra = []
if apagon:
    # the grid fails: every signal switches to a program of one phase, all "O" (no signal: the junction's rules
    # of way apply), at the moment of the failure
    with open('apagon.add.xml', 'w') as f:
        f.write('<additional>\n')
        for tl, n in TLS.items(): f.write(f'  <tlLogic id="{tl}" programID="off" type="static" offset="0"><phase duration="86400" state="{"O" * n}"/></tlLogic>\n')
        f.write(f'  <WAUT id="grid" refTime="0" startProg="0"><wautSwitch time="{APAGON_AT + 1:.0f}" to="off"/></WAUT>\n')
        for tl in TLS: f.write(f'  <wautJunction wautID="grid" junctionID="{tl}"/>\n')
        f.write('</additional>\n')
    extra = [os.path.join(WORK, 'apagon.add.xml')]
ROUTES = os.path.join(SIM, DEMAND, 'routes.rou.xml')  # routes made beforehand (route.py)
STOPS = os.path.join(SIM, DEMAND, 'busstops.add.xml')  # the AMA's stops (gtfs.py)
cmd = [os.path.join(ROOT, '.venv-sim/bin/sumo'), '-n', NET, '-r', ROUTES if os.path.exists(ROUTES) else os.path.join(SIM, DEMAND, 'trips.xml'),
       '--begin', str(begin), '--end', str(END),
       '--additional-files', ','.join([os.path.join(WORK, 'outputs.add.xml')] + ([STOPS] if os.path.exists(STOPS) else []) + extra),
       '--time-to-teleport', '240', '--ignore-route-errors', '--max-depart-delay', '900',
       '--lanechange.duration', '2.5',  # a lane change takes its time (SUMO's default is instant): it reads as one
       # San Juan merging: after a minute and a half at a give-way line a driver takes a smaller gap, and a car
       # stuck across a junction stops blocking it after 15 s (SUMO's defaults lock the grid at the peak)
       '--time-to-impatience', '90', '--ignore-junction-blocker', '15',
       '--routing-algorithm', 'astar',
       '--fcd-output', os.path.join(WORK, 'fcd.csv.gz'), '--fcd-output.attributes', 'x,y,z',
       '--tripinfo-output', os.path.join(WORK, 'tripinfo.xml'), '--tripinfo-output.write-unfinished',
       '--statistic-output', os.path.join(WORK, 'stats.xml'), '--duration-log.statistics', '--no-warnings',
       '--step-log.period', '900']
# Drivers keep the routes made beforehand from a previous run's travel times (route.py). Re-planning on the way
# (--reroute=0.15: that share of drivers, every quarter hour) is closer to a navigation app, but on this machine
# SUMO then spends most of its time waiting: measured 6.7x slower at full scale.
if float(args.get('reroute', 0)) > 0:
    cmd += ['--device.rerouting.probability', args['reroute'], '--device.rerouting.period', '900']
if SCEN == 'morning': cmd += ['--save-state.times', str(APAGON_AT), '--save-state.files', STATE, '--save-state.rng']
if begin != BEGIN: cmd += ['--load-state', STATE]  # (the apagón: the same morning until the failure)
if args.get('skip-sumo') != '1':
    log(f'sumo {SCEN}: {begin / 3600:.2f} h to {END / 3600:.2f} h ...')
    subprocess.run(cmd, check=True)
    log('sumo done')

# ---------------------------------------------------------------- the cars' types (tripinfo, unfinished included)
ti, vtype = {}, {}
for ev, el in ET.iterparse('tripinfo.xml', events=('end',)):
    if el.tag == 'tripinfo':
        v = int(el.get('id').split('#')[0]); vtype[v] = el.get('vType')
        ti[v] = (float(el.get('duration')), float(el.get('timeLoss')), float(el.get('routeLength'))); el.clear()
kind_of = lambda v: TYPES.index(vtype[v]) if vtype.get(v) in TYPES else 0

# ---------------------------------------------------------------- tracks
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

finished = []   # (vehicle, type, knots float32 [n, 4]: t, x, y, z)
pieces = {}     # vehicle still on the road at the end of a batch -> its simplified knots so far
def close(v, knots):
    """A track ends: its pieces so far and this last one, as one."""
    parts = pieces.pop(v, [])
    if parts: knots = np.concatenate(parts + [knots[1:]])  # (each piece starts where the last ended)
    if len(knots) >= 2: finished.append((v, kind_of(v), knots.astype(np.float32)))

opts = dict(read_options=pacsv.ReadOptions(block_size=1 << 26), parse_options=pacsv.ParseOptions(delimiter=';'),
            convert_options=pacsv.ConvertOptions(column_types={'timestep_time': pa.float64(), 'vehicle_id': pa.string(),
                                                               'vehicle_x': pa.float64(), 'vehicle_y': pa.float64(), 'vehicle_z': pa.float64()}))
reader = pacsv.open_csv(pa.input_stream('fcd.csv.gz', compression='gzip'), **opts)
carry = None   # the last sample of each car still on the road: (t, v, x, y, z) arrays
peak, rows = 0, 0
for batch in reader:
    vc = batch.column('vehicle_id')
    batch = batch.filter(pc.and_(pc.is_valid(vc), pc.not_equal(vc, '')))  # (a second with no cars is a row of its own)
    t = batch.column('timestep_time').to_numpy()
    if not len(t): continue
    v = pc.cast(batch.column('vehicle_id'), pa.int64()).to_numpy()
    x, y, z = (batch.column(c).to_numpy() for c in ('vehicle_x', 'vehicle_y', 'vehicle_z'))
    rows += len(t)
    _, per = np.unique(t, return_counts=True); peak = max(peak, int(per.max()))
    if carry is not None: t, v, x, y, z = (np.concatenate([a, b]) for a, b in zip(carry, (t, v, x, y, z)))
    tmax = t.max()
    o = np.lexsort((t, v)); t, v, x, y, z = t[o], v[o], x[o], y[o], z[o]
    starts = np.flatnonzero(np.r_[True, v[1:] != v[:-1]]); ends = np.r_[starts[1:], len(v)]
    keep_rows = []
    for a, b in zip(starts, ends):
        vid = int(v[a]); T = t[a:b]; P = np.column_stack([x[a:b], y[a:b], z[a:b]])
        # teleports, or a car missing for more than a second: split there
        cut = np.flatnonzero((np.diff(T) > 1.5) | (np.hypot(*np.diff(P[:, :2], axis=0).T) > 60)) + 1
        segs = np.split(np.arange(len(T)), cut)
        for k, seg in enumerate(segs):
            last = k == len(segs) - 1
            if len(seg) < 2:
                if last and T[seg[-1]] >= tmax - 1.0: keep_rows.append(a + seg[-1])
                elif k == 0 and vid in pieces: close(vid, np.column_stack([T[seg], P[seg]]))  # (its track ends here)
                continue
            knots = np.column_stack([T[seg], P[seg]])[simplify(T[seg], P[seg])]
            if last and T[seg[-1]] >= tmax - 1.0:
                # still driving at the end of the batch: keep what there is, carry its last sample on
                pieces.setdefault(vid, []).append(knots if vid not in pieces else knots[1:])
                keep_rows.append(a + seg[-1])
            else:
                close(vid, knots)
    kr = np.array(keep_rows, dtype=np.int64)
    carry = (t[kr], v[kr], x[kr], y[kr], z[kr])
    if rows // 20_000_000 != (rows - len(batch)) // 20_000_000:
        log(f'tracks: {rows / 1e6:.0f} M samples read, up to {t.max() / 3600:.2f} h, {len(finished)} tracks, {len(pieces)} on the road')
# what is still on the road at the end
for vid in list(pieces): close(vid, pieces[vid].pop() if pieces[vid] else np.zeros((0, 4)))
log(f'{len(finished)} tracks from {rows / 1e6:.0f} M samples; peak {peak} cars on the road at once')

# ---------------------------------------------------------------- what each signal showed
lights = collections.defaultdict(list)  # signal -> [(time, state)]
for ev, el in ET.iterparse('tls.xml', events=('end',)):
    if el.tag == 'tlsState':
        L = lights[el.get('id')]; st = el.get('state')
        if not L or L[-1][1] != st: L.append((float(el.get('time')), st))
        el.clear()

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
