# test patch on the cut-out (X3): the surface junction at the foot of three PR-18 exits rebuilt to the lanes seen in
# the aerial photo (Esri World Imagery z19, 2026-11-19). Lanes raised only; connections and signals re-guessed there.
import sys, re
PLAIN, OUTP = sys.argv[1:3]
P = {
    # PR-18 SB exit to Américo Miranda: ramp fans to 4 lanes at the stop line (two 2-lane arms in SUMO)
    'e19623': 2, 'e20737': 2, 'e28800': 2,
    # PR-18 NB exit to Américo Miranda: 2 lanes side by side up to the signal
    'e5381': 2,
    # Avenida Américo Miranda: 3 lanes eastbound at the west stop line, 2 each way over the bridge and beyond
    'e20753': 2, 'e20754': 3, 'e20755': 3, 'e20751': 2, 'e20744': 2, 'e20749': 2, 'e20745': 2, 'e20747': 2, 'e19136': 2, 'e19137': 2,
    # PR-18 SB exit to Chardón: 2 lanes to the signal (SUMO narrows to 1 for the last 18 m); the avenue 2 each way under the viaduct
    'e32515': 2, 'e26504': 2, 'e19648': 2,
}
s = open(PLAIN + '/p.edg.xml').read(); c = 0
for k, v in P.items():
    s, a = re.subn(r'(<edge id="%s" [^>]*numLanes=")\d+' % re.escape(k), r'\g<1>%d' % v, s); c += a
open(OUTP + '.edg.xml', 'w').write(s)
Ls = open(PLAIN + '/p.con.xml').readlines()
# every connection of a patched edge, and of an edge feeding one, is re-guessed whole (a half-explicit edge loses turns)
ft = [(m.group(1), m.group(2)) if (m := re.search(r'<connection from="([^"]+)" to="([^"]+)"', l)) else None for l in Ls]
feed = {a for x in ft if x for a, b in [x] if b in P} | set(P)
out = [l for l, x in zip(Ls, ft) if not (x and x[0] in feed)]
open(OUTP + '.con.xml', 'w').writelines(out)
print(c, 'of', len(P), 'edges patched;', len(Ls) - len(out), 'connections left to netconvert')
