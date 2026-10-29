# The crowd's transitions (src/world/people.js), made by NVIDIA's MotionBricks (mbcpu.py; github.com/NVlabs/motionbricks:
# code Apache-2.0, the model under the NVIDIA Open Model Agreement, which claims no ownership of what it makes) between
# poses of the crowd's own Rocketbox clips (rig.py carries them to the model's SOMA skeleton and back):
#   start     standing (idle) -> walking (the walk's first frame, at its pace)
#   stopL/R   walking, from either foot (the walk at 30% and 78% of its cycle) -> standing (idle's first frame)
#   standup   sitting (the bench's sit) -> standing a step forward (idle)
# Each is written as one more clip on the rig of the library's first woman and first man (crowd.py's f01, m01), as
# their move and still clips are (crowd_pack.mjs): <sex>-moves.glb, the pelvis's travel kept in its track.
#
#   python tools/motion/transitions.py <motionbricks checkout> <mmm_v6_soma_fp32.onnx> <crowd.py output dir> [out dir]
# (pip install onnxruntime warp-lang usd-core scipy; the checkout's Git LFS files: the SOMA skeleton
# motionbricks/assets/human/soma_base_skel_minimal_no_root.usd)
import sys, os, json, struct
import numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from mbcpu import CpuSOMA
from rig import RocketboxRig, Retarget, read_glb
from gen import resample, contacts_slide

REPO, ONNX, SRC = sys.argv[1:4]
OUT = sys.argv[4] if len(sys.argv) > 4 else os.path.join(os.path.dirname(__file__), '../../public/models/people/crowd')
REPS = {'f': 'f01', 'm': 'm01'}
STILL_HZ = 10  # (crowd.py bakes the still clips at every third frame of 30)


def place(S, dx=0.0, dz=0.0):
    S = S.copy(); S[:, 0, 0] += dx; S[:, 0, 2] += dz; return S


def best(engine, rt, ctx, tgt, tokens, tries=4):
    """The generation whose planted feet slide least, of a few (the model samples)."""
    out = None
    for _ in range(tries):
        f, c = engine.generate(ctx, tgt, tokens=tokens)
        score = sum(contacts_slide(rt, f))
        if out is None or score < out[2]: out = (f, c, score)
    return out


def write_clips(rep_glb, clips, path):
    """A GLB of the rig's nodes (no meshes) with these clips: {name: (rotations [F, 22, 4], pelvis [F, 3])} at 30 Hz,
    on the 22 bones (rb.node)."""
    J, _ = read_glb(rep_glb)
    nodes = [{k: v for k, v in n.items() if k not in ('mesh', 'skin')} for n in J['nodes']]
    rb = clips['__rig']
    blob = bytearray(); views = []; accs = []
    def add(arr, typ, minmax=False):
        a = np.ascontiguousarray(arr, np.float32); off = len(blob); blob.extend(a.tobytes())
        while len(blob) % 4: blob.append(0)
        views.append({'buffer': 0, 'byteOffset': off, 'byteLength': a.nbytes})
        acc = {'bufferView': len(views) - 1, 'componentType': 5126, 'count': int(a.shape[0]), 'type': typ}
        if minmax: acc['min'] = [float(a.min())]; acc['max'] = [float(a.max())]
        accs.append(acc); return len(accs) - 1
    anims = []
    for name, clip in clips.items():
        if name.startswith('__'): continue
        rot, pel = clip
        F = len(rot)
        t = add(np.arange(F)[:, None] / 30.0, 'SCALAR', True)
        samplers, channels = [], []
        for k, node in enumerate(rb.node):
            samplers.append({'input': t, 'output': add(rot[:, k], 'VEC4'), 'interpolation': 'LINEAR'})
            channels.append({'sampler': len(samplers) - 1, 'target': {'node': node, 'path': 'rotation'}})
        samplers.append({'input': t, 'output': add(pel, 'VEC3'), 'interpolation': 'LINEAR'})
        channels.append({'sampler': len(samplers) - 1, 'target': {'node': rb.node[0], 'path': 'translation'}})
        anims.append({'name': name, 'samplers': samplers, 'channels': channels})
    out = {'asset': {'version': '2.0', 'generator': 'tools/motion/transitions.py (MotionBricks)'}, 'scene': 0,
           'scenes': J['scenes'], 'nodes': nodes, 'animations': anims, 'accessors': accs, 'bufferViews': views,
           'buffers': [{'byteLength': len(blob)}]}
    j = json.dumps(out).encode(); j += b' ' * ((4 - len(j) % 4) % 4)
    b = bytes(blob)
    with open(path, 'wb') as fh:
        fh.write(struct.pack('<III', 0x46546C67, 2, 12 + 8 + len(j) + 8 + len(b)))
        fh.write(struct.pack('<II', len(j), 0x4E4F534A)); fh.write(j)
        fh.write(struct.pack('<II', len(b), 0x004E4942)); fh.write(b)


def main():
    engine = CpuSOMA(REPO, ONNX)
    report = {}
    for sex, rep in REPS.items():
        glb = os.path.join(SRC, rep + '.glb')
        rb = RocketboxRig(glb); rt = Retarget(rb, engine.joints, engine.parents, engine.reference)
        walk = rt.to_soma(rb.frames('walk'))
        idle = rt.to_soma(resample(rb.frames('idle'), STILL_HZ))
        sit = rt.to_soma(resample(rb.frames('sit'), STILL_HZ))
        n = len(walk) - 1  # (the walk's last key is its first again)
        made = {}
        # start: from standing still (the idle's poses at 30 Hz) to the walk's first four frames 1.2 m on
        made['start'] = best(engine, rt, idle[30:34], place(walk[0:4], dz=1.2), range(8, 15))
        # stop: from the walk (either foot), to standing 1.2 m on
        for side, at in (('stopL', round(0.30 * n)), ('stopR', round(0.78 * n))):
            ctx = walk[at - 3:at + 1]
            tgt = place(idle[0:4], dx=ctx[-1, 0, 0] - idle[0, 0, 0], dz=ctx[-1, 0, 2] + 1.2 - idle[0, 0, 2])
            made[side] = best(engine, rt, ctx, tgt, range(8, 15))
        # stand up: from the seat, to standing a step forward
        s0 = sit[40:44]
        made['standup'] = best(engine, rt, s0, place(idle[0:4], dx=s0[-1, 0, 0] - idle[0, 0, 0], dz=s0[-1, 0, 2] + 0.35 - idle[0, 0, 2]), range(8, 15))
        clips = {'__rig': rb}
        for name, (f, c, score) in made.items():
            rot, pel = rt.to_rocketbox(f)
            clips[name] = (rot, pel)
            h = f[:, 0]
            report[f'{sex}-{name}'] = {'frames': len(f), 'seconds': round(len(f) / 30, 2), 'travel_m': round(float(np.hypot(h[-1, 0] - h[0, 0], h[-1, 2] - h[0, 2]) / rt.scale), 2),
                                       'slide': [round(v, 2) for v in contacts_slide(rt, f)]}
        os.makedirs(OUT, exist_ok=True)
        write_clips(glb, clips, os.path.join(OUT, f'{sex}-moves.glb'))
        print(sex, json.dumps({k: v for k, v in report.items() if k.startswith(sex)}))
    json.dump(report, open(os.path.join(OUT, 'moves.json'), 'w'), indent=1)


if __name__ == '__main__':
    main()
