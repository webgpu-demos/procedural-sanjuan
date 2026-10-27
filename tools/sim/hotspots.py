#!/usr/bin/env python3
"""Where a run jams: its teleports (SUMO's log, warnings on) and its waiting (edgeData), by junction.

Usage: .venv-sim/bin/python tools/sim/hotspots.py <net.xml.gz> <sumo.log> [edgedata.xml] [--top=40]
"""
import collections, gzip, re, sys, xml.etree.ElementTree as ET
import sumolib

args = [a for a in sys.argv[1:] if not a.startswith('--')]
opts = dict(a[2:].split('=', 1) for a in sys.argv[1:] if a.startswith('--') and '=' in a)
TOP = int(opts.get('top', 40))
net = sumolib.net.readNet(args[0], withInternal=True)
TP = re.compile(r"Teleporting vehicle '([^']+)'; (?:waited too long \((\w[\w ]*)\)|(collision)[^,]*), lane='([^']+)'.*?time=([\d.]+)")
tele = collections.Counter(); kinds = collections.defaultdict(collections.Counter); first = {}
coll = collections.Counter()
for line in open(args[1], errors='replace'):
    if 'Teleporting' not in line: continue
    m = TP.search(line)
    if not m: continue
    kind = m.group(2) or 'collision'; lane = m.group(4); t = float(m.group(5))
    edge = lane.rsplit('_', 1)[0]
    try: e = net.getEdge(edge)
    except KeyError: continue
    node = e.getToNode().getID() if not edge.startswith(':') else edge[1:].rsplit('_', 1)[0]
    tele[node] += 1; kinds[node][kind] += 1; first.setdefault(node, t)
total = sum(tele.values())
print(f'teleports: {total}', dict(sum((kinds[n] for n in kinds), collections.Counter())))
def where(nid):
    n = net.getNode(nid); x, y = n.getCoord()
    inc = n.getIncoming(); names = sorted({e.getName() for e in inc if e.getName()})[:3]
    return n, x, y, inc, names
cum = 0
for nid, c in tele.most_common(TOP):
    n, x, y, inc, names = where(nid); cum += c
    lanes = '+'.join(str(e.getLaneNumber()) for e in inc if e.getFunction() != 'internal')
    out = '+'.join(str(e.getLaneNumber()) for e in n.getOutgoing() if e.getFunction() != 'internal')
    print(f'{c:5d} {100 * cum / total:5.1f}% {nid[:28]:28s} {n.getType():24s} world ({x:6.0f}, {-y:6.0f}) in {lanes:10s} out {out:8s} '
          f'first {first[nid] / 3600:5.2f} h {dict(kinds[nid])} {names}')
if len(args) > 2:
    last = None; waits = collections.Counter()
    for ev, el in ET.iterparse(args[2], events=('end',)):
        if el.tag == 'interval':
            for e in el.findall('edge'): waits[e.get('id')] += float(e.get('waitingTime') or 0)
            el.clear()
    bynode = collections.Counter()
    for eid, w in waits.items():
        try: bynode[net.getEdge(eid).getToNode().getID()] += w
        except KeyError: pass
    tw = sum(bynode.values())
    print(f'\nwaiting: {tw / 3600:.0f} vehicle-hours on edges; by the junction they wait at:')
    byType = collections.Counter()
    for nid, w in bynode.items(): byType[net.getNode(nid).getType()] += w
    print(' by type:', {k: round(v / 3600) for k, v in byType.most_common()})
    cum = 0
    for nid, w in bynode.most_common(TOP):
        n, x, y, inc, names = where(nid); cum += w
        print(f'{w / 3600:7.0f} h {100 * cum / tw:5.1f}% {nid[:28]:28s} {n.getType():24s} world ({x:6.0f}, {-y:6.0f}) teleports {tele.get(nid, 0):4d} {names}')
