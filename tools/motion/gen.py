# Transitions for the crowd (src/world/people.js), made by MotionBricks (mbcpu.py) from the crowd's own Rocketbox clips
# (rig.py carries them to SOMA and back): each starts in one of the clips and ends in another, the motion between them
# the model's.
import numpy as np
from scipy.spatial.transform import Rotation as Rot, Slerp


def resample(W, src_hz, hz=30):
    """A clip's frames [F, 22, 4, 4] at src_hz -> at hz (rotations slerped, positions lerped)."""
    F = len(W)
    if src_hz == hz or F < 2: return W
    T = (F - 1) / src_hz
    n = int(round(T * hz)) + 1
    t0, t1 = np.arange(F) / src_hz, np.minimum(np.arange(n) / hz, (F - 1) / src_hz)
    out = np.zeros((n, W.shape[1], 4, 4)); out[:, :, 3, 3] = 1
    for b in range(W.shape[1]):
        s = np.linalg.norm(W[0, b, :3, :3], axis=0)
        R = Rot.from_matrix(W[:, b, :3, :3] / s)
        out[:, b, :3, :3] = Slerp(t0, R)(t1).as_matrix() * s
        for c in range(3): out[:, b, c, 3] = np.interp(t1, t0, W[:, b, c, 3])
    return out


def hips(S):
    return S[:, 0, :3]


def contacts_slide(rt, S, contacts=None):
    """How far the planted feet slide: per foot, the ground speed (m/s) at frames where it is low and nearly still."""
    W = np.array([rt.soma_world(s) for s in S])
    out = []
    for side in ('Left', 'Right'):
        for j in (rt.j[f'{side}Foot'], rt.j[f'{side}ToeBase']):
            p = W[:, j, :3, 3]
            v = np.linalg.norm(np.diff(p[:, [0, 2]], axis=0), axis=1) * 30
            low = p[1:, 1] < (0.12 if 'Foot' in rt.joints[j] else 0.05)
            planted = low & (v < 0.6)
            out.append(float(np.mean(v[planted])) if planted.any() else 0.0)
    return out
