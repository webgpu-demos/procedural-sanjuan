#!/usr/bin/env python3
"""Run the morning in SUMO and record every car, compactly, for the client.

SUMO runs on its own (a subprocess, 4-5x faster than stepping it from Python here) and writes every car's position
each second (fcd.csv.gz), every change of every signal (tls.xml), the road speeds (edgedata.xml) and each trip
(tripinfo.xml). The positions are then read back in large batches: each car's track is simplified to the fewest
knots that hold every second of it within CROSS metres of where SUMO had it sideways (out of its lane: that
shows) and ALONG metres along its way (a little early or late: that does not). A car that teleports (SUMO
clearing a jam) is split there: the client hides it over the jump.

  public/tiles/<area>/sim/<scenario>/index.json  windows, types, municipios, the run's statistics
  .../w_<t>.bin.gz  the cars on the road in each window of WINDOW seconds: see window() for the layout
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
WINDOW = 150                  # seconds of the morning per file (a rush-hour one decodes to ~40 MB; it must divide APAGON_AT - BEGIN)
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
SUMO_NET = NET
if apagon:
    # the grid fails: at that moment every signal switches to SUMO's "off" program (an explicit program of "O"
    # phases is refused). A dark signal then shows each link's off state from the network: by default "w", an
    # all-way stop (--dark=allway: each driver stops, then goes in turn; how the law has it, and near enough how
    # San Juan drives it), else netconvert's "O" go / "o" give way by the roads' priorities (--dark=priority: the
    # avenue carries on as if it had the green). The all-way stop runs on a copy of the network with the off
    # state of every signalled connection set to "w" (the same lanes and ids, so the morning's state loads).
    if args.get('dark', 'allway') == 'allway':
        import re
        SUMO_NET = os.path.join(WORK, 'allway.net.xml.gz')
        off = re.compile(r'(<connection [^>]* tl="[^"]+"[^>]* state=")[oO](")')
        with gzip.open(NET, 'rt') as src, gzip.open(SUMO_NET, 'wt', compresslevel=1) as dst:
            for line in src: dst.write(off.sub(r'\1w\2', line))
    with open('apagon.add.xml', 'w') as f:
        f.write('<additional>\n')
        for tl in TLS: f.write(f'  <tlLogic id="{tl}" programID="off" type="static" offset="0"/>\n')
        f.write(f'  <WAUT id="grid" refTime="0" startProg="0"><wautSwitch time="{APAGON_AT + 1:.0f}" to="off"/></WAUT>\n')
        for tl in TLS: f.write(f'  <wautJunction wautID="grid" junctionID="{tl}"/>\n')
        f.write('</additional>\n')
    extra = [os.path.join(WORK, 'apagon.add.xml')]
ROUTES = os.path.join(SIM, DEMAND, 'routes.rou.xml')  # routes made beforehand (route.py)
STOPS = os.path.join(SIM, DEMAND, 'busstops.add.xml')  # the AMA's stops (gtfs.py)
cmd = [os.path.join(ROOT, '.venv-sim/bin/sumo'), '-n', SUMO_NET, '-r', ROUTES if os.path.exists(ROUTES) else os.path.join(SIM, DEMAND, 'trips.xml'),
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
def simplify(t, P, first):
    """Which samples to keep as knots, for every track of a batch at once (first: where each track starts).
    Douglas-Peucker on the synchronized error (where the car is at the same moment), split into sideways,
    along-the-way and height parts with their own tolerances, and a knot at least every MAX_GAP s; breadth first,
    every track's spans in one go (the same knots as depth first, 5x faster than track by track)."""
    n = len(t); idx = np.arange(n)
    keep = first.copy(); keep[np.r_[np.flatnonzero(first)[1:] - 1, n - 1]] = True  # (each track's ends)
    open_ = ~keep  # samples in spans still to look at
    while True:
        c = np.flatnonzero(open_)
        if not len(c): break
        L = np.maximum.accumulate(np.where(keep, idx, 0))[c]                  # the knot before
        R = np.minimum.accumulate(np.where(keep, idx, n)[::-1])[::-1][c]      # and after
        f = ((t[c] - t[L]) / (t[R] - t[L]))[:, None]
        err = P[c] - (P[L] + (P[R] - P[L]) * f)
        ux, uy = P[R, 0] - P[L, 0], P[R, 1] - P[L, 1]; ul = np.hypot(ux, uy)
        moving = ul > 0.5; ul = np.where(moving, ul, 1); ux, uy = ux / ul, uy / ul  # (standing, or nearly: any movement counts)
        along = np.abs(err[:, 0] * ux + err[:, 1] * uy); cross = np.abs(err[:, 0] * uy - err[:, 1] * ux)
        h = np.hypot(err[:, 0], err[:, 1]); along = np.where(moving, along, h); cross = np.where(moving, cross, h)
        e = np.maximum(np.maximum(cross / CROSS, along / ALONG), np.abs(err[:, 2]) / RISE)
        # per span: its worst sample (the first, on a tie)
        g0 = np.flatnonzero(np.r_[True, L[1:] != L[:-1]]); glen = np.diff(np.r_[g0, len(c)])
        gmax = np.maximum.reduceat(e, g0)
        hit = np.flatnonzero(e == np.repeat(gmax, glen)); gid = np.repeat(np.arange(len(g0)), glen)[hit]
        worst = c[hit[np.r_[True, gid[1:] != gid[:-1]]]]
        Lg, Rg = L[g0], R[g0]
        split = gmax > 1
        long_ = ~split & (t[Rg] - t[Lg] > MAX_GAP)  # (only too long: split it in the middle)
        new = np.r_[worst[split], (Lg + 1 + (Rg - Lg - 1) // 2)[long_]]
        keep[new] = True
        open_[c[np.repeat(~(split | long_), glen)]] = False; open_[new] = False
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
    P = np.column_stack([x, y, z])
    # a track per car, split where it teleports or goes missing for more than a second
    newv = np.r_[True, v[1:] != v[:-1]]
    first = newv | np.r_[False, (np.diff(t) > 1.5) | (np.hypot(np.diff(x), np.diff(y)) > 60)]
    kidx = np.flatnonzero(simplify(t, P, first)); KN = np.column_stack([t[kidx], P[kidx]])
    starts = np.flatnonzero(first); ends = np.r_[starts[1:], len(t)]
    ks, ke = np.searchsorted(kidx, starts), np.searchsorted(kidx, ends)
    on = np.r_[newv, True][ends] & (t[ends - 1] >= tmax - 1.0)  # the car's last track here, and still driving
    keep_rows = []
    for a, b, k0, k1, fs, op in zip(starts.tolist(), ends.tolist(), ks.tolist(), ke.tolist(), newv[starts].tolist(), on.tolist()):
        vid = int(v[a])
        if b - a < 2:
            if op: keep_rows.append(a)
            elif fs and vid in pieces: close(vid, KN[k0:k1])  # (its track ends here)
            continue
        if op:
            # still driving at the end of the batch: keep what there is, carry its last sample on
            if vid in pieces: pieces[vid].append(KN[k0 + 1:k1])  # (each piece starts where the last ended)
            else: pieces[vid] = [KN[k0:k1]]
            keep_rows.append(b - 1)
        else:
            close(vid, KN[k0:k1])
    kr = np.array(keep_rows, dtype=np.int64)
    carry = (t[kr], v[kr], x[kr], y[kr], z[kr])
    if rows // 20_000_000 != (rows - len(batch)) // 20_000_000:
        log(f'tracks: {rows / 1e6:.0f} M samples read, up to {t.max() / 3600:.2f} h, {len(finished)} tracks, {len(pieces)} on the road')
# what is still on the road at the end
for vid in list(pieces): close(vid, np.zeros((1, 4)))  # (its pieces, as they are)
log(f'{len(finished)} tracks from {rows / 1e6:.0f} M samples; peak {peak} cars on the road at once')

# ---------------------------------------------------------------- what each signal showed
lights = collections.defaultdict(list)  # signal -> [(time, state)]
for ev, el in ET.iterparse('tls.xml', events=('end',)):
    if el.tag == 'tlsState':
        L = lights[el.get('id')]; st = el.get('state')
        if not L or L[-1][1] != st: L.append((float(el.get('time')), st))
        el.clear()

# ---------------------------------------------------------------- pack: windows of the morning
# window file 'SJT2', in columns (each squeezes well on its own):
#   u32 'SJT2' | u32 tracks n | f32 t0 | f32 t1 | u32 steps m (the knots after each track's first)
#   per track, column by column: u32 vehicle | u8 type | u16 knots | i32 x | i32 y | i32 z | i32 t (its first knot)
#   per step, byte plane by byte plane: u16 dt | u24 dx | u24 dy | u24 dz
# units: x, y 5 cm, z 1 cm, t 0.1 s (SUMO's frame: y north; the client turns it into the world's z = -y). A step is
# stored as what is left over after guessing it from the step before (the same velocity for this step's dt; integer
# arithmetic, so the client guesses exactly the same), zigzagged (small either way -> small).
UNITS = np.array([10, 20, 20, 100])  # t, x, y, z
def encode(knots, lo, hi):
    """The knots of a track that matter in [lo, hi), on the grid: one before, one after."""
    t = knots[:, 0]
    i0 = max(0, int(np.searchsorted(t, lo, 'right')) - 1); i1 = min(len(t), int(np.searchsorted(t, hi, 'left')) + 1)
    if i1 - i0 < 2: return None
    q = np.round(knots[i0:i1].astype(np.float64) * UNITS).astype(np.int64)
    keep = np.r_[True, np.diff(q[:, 0]) > 0]  # (two knots on the same tenth of a second: one)
    return q[keep] if keep.sum() >= 2 else None

def window(tracks):
    """[(vehicle, type, q)] -> the bytes after the magic: n, m, the track columns, the step planes."""
    n = len(tracks); cnt = np.array([len(q) for _, _, q in tracks], np.int64)
    Q = np.concatenate([q for _, _, q in tracks]); first = np.r_[0, np.cumsum(cnt)[:-1]]
    d = np.diff(Q, axis=0); step = np.ones(len(d), bool); step[first[1:] - 1] = False; d = d[step]  # (within tracks)
    # the guess: the step before's velocity over this step's dt (none for a track's first step)
    lead = np.zeros(len(d), bool); lead[np.r_[0, np.cumsum(cnt - 1)[:-1]]] = True
    dt, dtp = d[:, 0], np.r_[1, d[:-1, 0]]
    guess = (d[:-1, 1:] * dt[1:, None] + (dtp[1:, None] >> 1)) // dtp[1:, None]
    r = d[:, 1:].copy(); r[1:] -= np.where(lead[1:, None], 0, guess)
    zz = (r << 1) ^ (r >> 63)
    planes = [((dt >> s) & 255).astype(np.uint8) for s in (0, 8)] + [((zz[:, c] >> s) & 255).astype(np.uint8) for c in range(3) for s in (0, 8, 16)]
    assert dt.max(initial=0) < 65536 and zz.max(initial=0) < 1 << 24
    head = Q[first]
    cols = [np.array([v for v, _, _ in tracks], '<u4'), np.array([k for _, k, _ in tracks], 'u1'), cnt.astype('<u2'),
            head[:, 1].astype('<i4'), head[:, 2].astype('<i4'), head[:, 3].astype('<i4'), head[:, 0].astype('<i4')]
    return struct.pack('<II', n, len(d)), b''.join(c.tobytes() for c in cols) + b''.join(p.tobytes() for p in planes)

windows, total = [], 0
if begin != BEGIN:
    before = json.load(open(os.path.join(ROOT, 'public/tiles', AREA, 'sim', 'morning', 'index.json')))
    for w in before['windows']:
        if w[0] < begin: windows.append([w[0], '../morning/' + w[1], w[2], w[3]])
spans = sorted(((float(k[0, 0]), float(k[-1, 0]), i) for i, (_, _, k) in enumerate(finished)))
for w0 in np.arange(begin, END, WINDOW):
    w1 = w0 + WINDOW
    tracks = []
    for a, b, i in spans:
        if a >= w1: break
        if b < w0: continue
        vid, typ, knots = finished[i]
        q = encode(knots, w0, w1)
        if q is not None: tracks.append((vid, typ, q))
    nm, body = window(tracks) if tracks else (struct.pack('<II', 0, 0), b'')
    name = f'w_{int(w0)}.bin.gz'  # (gzipped: the client inflates it with DecompressionStream)
    with gzip.open(os.path.join(OUT, name), 'wb', compresslevel=9) as f:
        f.write(struct.pack('<I', 0x32544a53) + nm[:4] + struct.pack('<ff', w0, w1) + nm[4:] + body)
    size = os.path.getsize(os.path.join(OUT, name))
    windows.append([int(w0), name, len(tracks), size]); total += size
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
