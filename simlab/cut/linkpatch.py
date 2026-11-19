# test patch on the cut-out (X4): ramps and link roads whose speed is the class default (osm.mjs gives an untagged
# motorway_link the motorway's 88 km/h, a trunk_link 72) get a ramp's speed: 56 km/h (35 mph) and 48 km/h (30 mph).
# Also writes the cut-out's cars as trips (first edge to last, every attribute kept) to be routed again on each net.
import sys, re, json, collections
PLAIN, OUTP, WAYS, ROU, TRIPS = sys.argv[1:6]
W = json.load(open(WAYS)); NEW = {'motorway_link': (24.4, 15.56), 'trunk_link': (20.0, 13.33)}
n = collections.Counter(); km = 0.0
def fix(m):
    global km
    s = m.group(0); i = re.search(r'id="([^"]+)"', s).group(1); w = W.get(i[1:].replace('-acc', ''))
    if not w or w[4] not in NEW: return s
    lim, new = NEW[w[4]]; sp = float(re.search(r'speed="([\d.]+)"', s).group(1))
    if abs(sp - lim) > 0.2: return s          # a tagged limit: left alone
    n[w[4]] += 1
    return re.sub(r'speed="[\d.]+"', f'speed="{new}"', s)
s = re.sub(r'<edge id="[^>]*>', fix, open(PLAIN + '/p.edg.xml').read())
open(OUTP + '.edg.xml', 'w').write(s); print('edges slowed:', dict(n))
k = 0
with open(ROU) as f, open(TRIPS, 'w') as o:
    o.write('<routes>\n'); pend = None
    for line in f:
        if '<vehicle ' in line: pend = line.strip(); continue
        m = re.search(r'<route edges="([^"]+)"', line)
        if m and pend:
            es = m.group(1).split(); o.write(pend.replace('<vehicle ', '<trip ').rstrip('>').rstrip('/') + f' from="{es[0]}" to="{es[-1]}"/>\n'); k += 1; pend = None
    o.write('</routes>\n')
print(k, 'trips')
