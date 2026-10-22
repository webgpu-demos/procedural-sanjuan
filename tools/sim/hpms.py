#!/usr/bin/env python3
"""FHWA HPMS (Puerto Rico, 2024) inside the simulated area: counted roads, as calibration targets.
Writes data/sim/<area>/hpms.json: [{aadt, lanes, fsys, name, pts: [[x, y] SUMO frame ...]}].
Public domain (CC0, NTAD). Usage: .venv-sim/bin/python tools/sim/hpms.py [--area=sanjuan]"""
import json, math, os, sys, urllib.parse, urllib.request
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '../..'))
args = dict(a[2:].split('=', 1) for a in sys.argv[1:] if a.startswith('--') and '=' in a)
AREA = args.get('area', 'sanjuan'); SIM = os.path.join(ROOT, 'data/sim', AREA)
B = json.load(open(os.path.join(SIM, 'buildings.json')))
lon0, lat0 = B['origin']['lon'], B['origin']['lat']; phi = math.radians(lat0)
M_LAT = 111132.954 - 559.822 * math.cos(2 * phi) + 1.175 * math.cos(4 * phi); M_LON = 111412.84 * math.cos(phi) - 93.5 * math.cos(3 * phi)
b = B['bounds']
west, east = lon0 + b['minX'] / M_LON, lon0 + b['maxX'] / M_LON
north, south = lat0 - b['minZ'] / M_LAT, lat0 - b['maxZ'] / M_LAT
U = 'https://geo.dot.gov/server/rest/services/Hosted/HPMS_FULL_PR_2024/FeatureServer/0/query'
out, off = [], 0
while True:
    q = urllib.parse.urlencode({'where': 'aadt > 0', 'geometry': f'{west},{south},{east},{north}', 'geometryType': 'esriGeometryEnvelope', 'inSR': 4326,
        'spatialRel': 'esriSpatialRelIntersects', 'outFields': 'aadt,through_lanes,f_system,routename,routenumber,speed_limit,number_signals,dir_through_lanes',
        'returnGeometry': 'true', 'outSR': 4326, 'f': 'json', 'resultOffset': off, 'resultRecordCount': 2000, 'orderByFields': 'objectid'})
    d = json.load(urllib.request.urlopen(U + '?' + q, timeout=120))
    for f in d.get('features', []):
        a = f['attributes']
        for path in f['geometry']['paths']:
            out.append({'aadt': a['aadt'], 'lanes': a['through_lanes'], 'dirLanes': a['dir_through_lanes'], 'fsys': a['f_system'], 'speed': a['speed_limit'],
                        'name': a['routename'] or (f"PR-{a['routenumber']}" if a['routenumber'] else None), 'signals': a['number_signals'],
                        'pts': [[round((lon - lon0) * M_LON, 1), round((lat - lat0) * M_LAT, 1)] for lon, lat in path]})
    if len(d.get('features', [])) < 2000: break
    off += 2000
json.dump(out, open(os.path.join(SIM, 'hpms.json'), 'w'))
L = lambda p: sum(math.dist(p[i], p[i + 1]) for i in range(len(p) - 1))
dvkt = sum(s['aadt'] * L(s['pts']) for s in out) / 1000
print(f"{len(out)} counted segments in the area, {sum(L(s['pts']) for s in out) / 1000:.0f} km; {dvkt / 1e6:.2f} M vehicle-km a day on them; max AADT {max(s['aadt'] for s in out)}")
top = sorted(out, key=lambda s: -s['aadt'])[:8]
for s in top: print(f"  {s['name']}: AADT {s['aadt']}, {s['lanes']} lanes")
