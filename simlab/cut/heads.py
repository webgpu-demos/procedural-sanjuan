# heads of the expressway queues at 7-8: a jammed mainline edge whose successor flows; what the node there is, and
# what the successor carries per lane (near 1,800: demand over real capacity; far less: the junction throttles)
import sys, gzip, collections, xml.etree.ElementTree as ET, sumolib
C, X, RUN = sys.argv[1:4]
net = sumolib.net.readNet(C + ('/art.net.xml.gz' if RUN == 'art' else '/base2.net.xml.gz'))
D = collections.defaultdict(lambda: [0.0, 0.0, 0])
for ev, iv in ET.iterparse(gzip.open(f'{X}/{RUN}.xml.gz'), events=('end',)):
    if iv.tag != 'interval': continue
    if 25200 <= float(iv.get('begin')) < 28800:
        for e in iv:
            s = float(e.get('sampledSeconds')); t = D[e.get('id')]; t[0] += s; t[1] += s * float(e.get('speed') or 0); t[2] += int(float(e.get('entered') or 0))
    iv.clear()
v = lambda e: 3.6 * D[e.getID()][1] / D[e.getID()][0] if D[e.getID()][0] else float('nan')
ex = lambda e: e.getPriority() >= 13 and e.getName() and e.getFunction() != 'internal'
delay = lambda e: max(0.0, D[e.getID()][0] - D[e.getID()][1] / e.getSpeed()) / 3600
tot = sum(delay(e) for e in net.getEdges() if ex(e)); rows = []
for e in net.getEdges():
    if not ex(e) or not (v(e) < 30): continue
    outs = [o for o in e.getOutgoing() if ex(o)]
    if not outs: continue
    o = max(outs, key=lambda o: D[o.getID()][2])
    if not (v(o) > 45): continue
    # the queue behind this head: walk back along jammed mainline edges
    q = 0.0; x = e; seen = set(); L = 0
    while x and x not in seen and v(x) < 30:
        seen.add(x); q += delay(x); L += x.getLength()
        ins = [i for i in x.getIncoming() if ex(i)]; x = max(ins, key=lambda i: D[i.getID()][2]) if ins else None
    n = e.getToNode(); ins = [i for i in n.getIncoming() if i.getFunction() != 'internal']
    rows.append((q, f"{q:5.0f} veh-h in {L:5.0f} m of queue  {e.getName()[:28]:28s} {e.getID():10s} {e.getLaneNumber()}L at {v(e):3.0f} km/h -> {o.getID():11s} {o.getLaneNumber()}L at {v(o):3.0f} km/h carrying {D[o.getID()][2]:5d}/h = {D[o.getID()][2] / o.getLaneNumber():5.0f}/lane  node {n.getType():9s} in {'+'.join(str(i.getLaneNumber()) for i in ins)} out {'+'.join(str(x.getLaneNumber()) for x in n.getOutgoing())}  off {'yes' if len(n.getOutgoing()) > 1 else 'no'}"))
rows.sort(reverse=True)
print(f'{RUN}: {tot:.0f} veh-h lost on expressway mainlines at 7-8; queue heads found: {len(rows)}, holding {sum(r[0] for r in rows):.0f}')
for q, s in rows[:22]: print(s)
