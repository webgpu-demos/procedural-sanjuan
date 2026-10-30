# The visitor's walker (src/world/player.js), the man of the library (crowd.py's m01, the walker's own rig: their
# bones' rest poses are the same): turning on the spot, a quarter either way and about, and sitting down on a seat
# behind him, made by NVIDIA's MotionBricks as transitions.py makes the crowd's transitions (setting off, stopping,
# standing up: <sex>-moves.glb, which the walker plays too).
#   turnL / turnR / turnB   standing (idle) -> standing a quarter turned either way, or turned about, where he stood
#   sitdown                 standing -> seated on a seat 0.35 m behind (the bench's sit; standup is its way back)
# Written as clips on the rig of crowd.py's m01: m-turns.glb, the pelvis's travel and turn kept in its track (the
# client takes them out and carries him along and round by them).
#
#   python tools/motion/walker.py <motionbricks checkout> <mmm_v6_soma_fp32.onnx> <crowd.py output dir> [out dir]
import sys, os, json
import numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from mbcpu import CpuSOMA
from rig import RocketboxRig, Retarget
from gen import resample, contacts_slide
from transitions import best, write_clips, place, STILL_HZ

REPO, ONNX, SRC = sys.argv[1:4]
OUT = sys.argv[4] if len(sys.argv) > 4 else os.path.join(os.path.dirname(__file__), '../../public/models/people/crowd')


def main():
    engine = CpuSOMA(REPO, ONNX)
    glb = os.path.join(SRC, 'm01.glb')
    rb = RocketboxRig(glb); rt = Retarget(rb, engine.joints, engine.parents, engine.reference)
    still = resample(rb.frames('idle'), STILL_HZ)
    idle = rt.to_soma(still)
    sit = rt.to_soma(resample(rb.frames('sit'), STILL_HZ))
    ctx = idle[30:34]
    made = {}
    # turning where he stands: to the idle's first pose, turned about the vertical, his hips where they were
    for name, h in (('turnL', np.pi / 2), ('turnR', -np.pi / 2), ('turnB', np.pi)):
        tgt = rt.to_soma(still, heading=h)[0:4]
        tgt = place(tgt, dx=ctx[-1, 0, 0] - tgt[0, 0, 0], dz=ctx[-1, 0, 2] - tgt[0, 0, 2])
        made[name] = best(engine, rt, ctx, tgt, range(8, 15))
    # sitting down: to the seated pose 0.35 m behind (standup, its way back, ends a step forward of the seat)
    s0 = sit[40:44]
    made['sitdown'] = best(engine, rt, ctx, place(s0, dx=ctx[-1, 0, 0] - s0[0, 0, 0], dz=ctx[-1, 0, 2] - 0.35 - s0[0, 0, 2]), range(8, 15))
    clips = {'__rig': rb}
    report = {}
    for name, (f, c, score) in made.items():
        rot, pel = rt.to_rocketbox(f)
        clips[name] = (rot, pel)
        h = f[:, 0]
        report[name] = {'frames': len(f), 'seconds': round(len(f) / 30, 2), 'travel_m': round(float(np.hypot(h[-1, 0] - h[0, 0], h[-1, 2] - h[0, 2]) / rt.scale), 2),
                        'slide': [round(v, 2) for v in contacts_slide(rt, f)]}
    os.makedirs(OUT, exist_ok=True)
    write_clips(glb, clips, os.path.join(OUT, 'm-turns.glb'))
    json.dump(report, open(os.path.join(OUT, 'turns.json'), 'w'), indent=1)
    print(json.dumps(report))


if __name__ == '__main__':
    main()
