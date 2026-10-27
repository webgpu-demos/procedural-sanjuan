#!/usr/bin/env python3
"""A simlab result in a few lines: python3 simlab/report.py <result dir>..."""
import gzip, os, re, sys, xml.etree.ElementTree as ET

for d in sys.argv[1:]:
    print(f'=== {os.path.basename(d.rstrip("/"))}')
    log = open(os.path.join(d, 'job.log'), errors='replace').read() if os.path.exists(os.path.join(d, 'job.log')) else ''
    m = re.search(r'exit (\d+) after (\d+) min', log)
    if m: print(f'  exit {m.group(1)} after {m.group(2)} min')
    st = os.path.join(d, 'stats.xml')
    if os.path.exists(st):
        r = ET.parse(st).getroot()
        v = r.find('vehicles').attrib; t = r.find('teleports').attrib; s = r.find('vehicleTripStatistics').attrib
        perf = r.find('performance').attrib if r.find('performance') is not None else {}
        print(f"  loaded {v['loaded']} inserted {v['inserted']} running {v['running']} waiting {v['waiting']} | "
              f"teleports {t['total']} (jam {t['jam']}, yield {t['yield']}, wrong lane {t['wrongLane']})")
        print(f"  trips {s['count']}: route {float(s['routeLength']) / 1000:.1f} km, speed {float(s['speed']) * 3.6:.0f} km/h, duration {float(s['duration']) / 60:.0f} min, "
              f"time loss {float(s['timeLoss']) / 60:.0f} min, depart delay {float(s['departDelay']):.0f} s"
              + (f" | sumo {float(perf.get('duration', 0)) / 60:.0f} min wall" if perf else ''))
    sm = os.path.join(d, 'summary.xml.gz')
    if os.path.exists(sm):
        rows = []
        for ev, el in ET.iterparse(gzip.open(sm), events=('end',)):
            if el.tag == 'step':
                t = float(el.get('time'))
                if t % 1800 == 0: rows.append((t / 3600, int(el.get('running')), int(el.get('halting')), float(el.get('meanSpeed')), int(el.get('teleports') or 0)))
                el.clear()
        print('  hour  running  halting  speed')
        for h, run, halt, sp, tp in rows: print(f'  {h:5.1f} {run:8d} {halt:8d} {sp * 3.6:6.1f}')
    va = os.path.join(d, 'validate.txt')
    if os.path.exists(va): print('  ' + open(va).read().strip().replace('\n', '\n  '))
    hs = os.path.join(d, 'hotspots.txt')
    if os.path.exists(hs): print('  ' + '\n  '.join(open(hs).read().splitlines()[:12]))
