# The crowd's Rocketbox skeleton (22 Bip01 bones, as tools/assets/crowd.py exports it) and MotionBricks' SOMA skeleton,
# and motion carried from either to the other: each Bip01 bone and the SOMA joint it stands for point the same way in
# the world (the two rest poses' bones aligned once, bone by bone, then every frame turned as the other turns); the
# hips carried along scaled by the two skeletons' hip heights. SOMA joints with no Bip01 bone (the second neck joint,
# the jaw, the eyes, the fingers) keep their rest pose.
import json, struct
import numpy as np
from scipy.spatial.transform import Rotation as Rot

# Bip01 bone -> SOMA joint
MAP = {
    'Bip01 Pelvis': 'Hips', 'Bip01 Spine': 'Spine1', 'Bip01 Spine1': 'Spine2', 'Bip01 Spine2': 'Chest',
    'Bip01 Neck': 'Neck1', 'Bip01 Head': 'Head',
    **{f'Bip01 {s} {b}': f'{side}{j}' for s, side in (('L', 'Left'), ('R', 'Right')) for b, j in (
        ('Clavicle', 'Shoulder'), ('UpperArm', 'Arm'), ('Forearm', 'ForeArm'), ('Hand', 'Hand'),
        ('Thigh', 'Leg'), ('Calf', 'Shin'), ('Foot', 'Foot'), ('Toe0', 'ToeBase'))},
}
# (where a bone points: to this joint's child, for the ends that have none among the 22)
SOMA_TIP = {'Head': 'HeadEnd', 'LeftHand': 'LeftHandMiddle1', 'RightHand': 'RightHandMiddle1', 'LeftToeBase': 'LeftToeEnd', 'RightToeBase': 'RightToeEnd',
            'Neck1': 'Head', 'Chest': 'Neck1'}


def read_glb(path):
    b = open(path, 'rb').read()
    jl = struct.unpack('<I', b[12:16])[0]
    J = json.loads(b[20:20 + jl])
    bl = struct.unpack('<I', b[20 + jl:24 + jl])[0]
    return J, b[28 + jl:28 + jl + bl]


def accessor(J, bin_, i):
    a = J['accessors'][i]; v = J['bufferViews'][a['bufferView']]
    n = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4, 'MAT4': 16}[a['type']]
    dt = {5126: np.float32, 5123: np.uint16, 5125: np.uint32, 5121: np.uint8}[a['componentType']]
    off = v.get('byteOffset', 0) + a.get('byteOffset', 0)
    return np.frombuffer(bin_, dt, a['count'] * n, off).reshape(a['count'], n).astype(np.float64)


def trs(t, r, s):
    m = np.eye(4); m[:3, :3] = Rot.from_quat(r).as_matrix() * s; m[:3, 3] = t; return m


class RocketboxRig:
    """An avatar's GLB from crowd.py: its node tree, the 22 bones' rest transforms and every clip at 30 Hz."""
    def __init__(self, path):
        self.J, self.bin = read_glb(path)
        nodes = self.J['nodes']
        self.parent = [-1] * len(nodes)
        for i, n in enumerate(nodes):
            for c in n.get('children', []): self.parent[c] = i
        self.rest = [(np.array(n.get('translation', [0, 0, 0]), float), np.array(n.get('rotation', [0, 0, 0, 1]), float), np.array(n.get('scale', [1, 1, 1]), float)) for n in nodes]
        self.index = {n.get('name'): i for i, n in enumerate(nodes)}
        self.bones = list(MAP)
        self.node = [self.index[b] for b in self.bones]
        self.order = self._order()

    def _order(self):
        out, seen = [], set()
        def visit(i):
            if i in seen: return
            if self.parent[i] >= 0: visit(self.parent[i])
            seen.add(i); out.append(i)
        for i in range(len(self.parent)): visit(i)
        return out

    def clip(self, name):
        """Every frame of a clip, at its keys (30 Hz): {node: (T[F,3], R[F,4], S[F,3])}, and the frame count."""
        a = next(x for x in self.J['animations'] if x['name'] == name)
        out, F = {}, 0
        for c in a['channels']:
            s = a['samplers'][c['sampler']]
            v = accessor(self.J, self.bin, s['output'])
            node, path = c['target']['node'], c['target']['path']
            d = out.setdefault(node, {})
            d[path] = v; F = max(F, len(v))
        return {k: (d.get('translation'), d.get('rotation'), d.get('scale')) for k, d in out.items()}, F

    def world(self, frame_locals=None):
        """World matrices of every node: the rest pose, or with frame_locals {node: (t, r, s)} in place."""
        W = [None] * len(self.parent)
        for i in self.order:
            t, r, s = self.rest[i]
            if frame_locals and i in frame_locals:
                ft, fr, fs = frame_locals[i]
                t = ft if ft is not None else t; r = fr if fr is not None else r; s = fs if fs is not None else s
            m = trs(t, r, s)
            W[i] = m if self.parent[i] < 0 else W[self.parent[i]] @ m
        return W

    def frames(self, name):
        """A clip's frames as world matrices of the 22 bones: [F, 22, 4, 4]."""
        ch, F = self.clip(name)
        out = np.zeros((F, len(self.node), 4, 4))
        for f in range(F):
            loc = {k: tuple(None if v is None else v[min(f, len(v) - 1)] for v in tr) for k, tr in ch.items()}
            W = self.world(loc)
            for b, i in enumerate(self.node): out[f, b] = W[i]
        return out


def unit(m):
    """The rotation of a matrix with scale (columns normalised)."""
    r = m[:3, :3]; return r / np.linalg.norm(r, axis=0)


class Retarget:
    """Rocketbox (one avatar's rig) <-> SOMA (MotionBricks' skeleton: joints, parents, rest locals [J, 7])."""
    def __init__(self, rb, joints, parents, reference):
        self.rb, self.joints, self.parents, self.ref = rb, list(joints), np.asarray(parents), np.asarray(reference, float)
        self.j = {n: i for i, n in enumerate(self.joints)}
        self.sref = self.soma_world(self.ref)
        W = rb.world()
        self.bw = np.array([W[i] for i in rb.node])            # the bones' rest, world
        self.root = W[rb.index['Bip01']] if 'Bip01' in rb.index else np.eye(4)
        # facing: the feet to the toes
        def facing(p_foot, p_toe):
            d = sum(t - f for f, t in zip(p_foot, p_toe)); d[1] = 0; return d / np.linalg.norm(d)
        bi = {b: k for k, b in enumerate(rb.bones)}
        fb = facing([self.bw[bi[f'Bip01 {s} Foot']][:3, 3] for s in 'LR'], [self.bw[bi[f'Bip01 {s} Toe0']][:3, 3] for s in 'LR'])
        fs = facing([self.sref[self.j[f'{s}Foot']][:3, 3] for s in ('Left', 'Right')], [self.sref[self.j[f'{s}ToeBase']][:3, 3] for s in ('Left', 'Right')])
        ang = np.arctan2(fs[0], fs[2]) - np.arctan2(fb[0], fb[2])
        self.F = Rot.from_euler('y', ang).as_matrix()          # Rocketbox world -> SOMA world (turned to face alike)
        # hips: heights over the ground (the rest's lowest toe)
        hb = self.bw[0][1, 3] - min(self.bw[bi[f'Bip01 {s} Toe0']][1, 3] for s in 'LR')
        hs = self.sref[0][1, 3] - min(self.sref[self.j[f'{s}ToeEnd']][1, 3] for s in ('Left', 'Right'))
        self.scale = hs / hb
        self.ground_b = min(self.bw[bi[f'Bip01 {s} Toe0']][1, 3] for s in 'LR')
        # each bone's rest aligned to its joint's: the turn that points it the joint's way, then the offset between them
        self.align, self.offset = [], []
        for k, b in enumerate(rb.bones):
            j = self.j[MAP[b]]
            d_s = self._soma_dir(j)
            d_b = self.F @ self._bone_dir(k)
            A = self._swing(d_b, d_s)
            Rb = A @ self.F @ unit(self.bw[k])
            self.align.append(A)
            self.offset.append(Rb.T @ unit(self.sref[j]))       # SOMA joint = (F W_b) A' ... : G_j = A F R_b O
        self.align, self.offset = np.array(self.align), np.array(self.offset)

    def _soma_dir(self, j):
        name = self.joints[j]
        tip = SOMA_TIP.get(name)
        kids = [c for c in range(len(self.joints)) if self.parents[c] == j]
        c = self.j[tip] if tip else (kids[0] if kids else None)
        d = self.sref[c][:3, 3] - self.sref[j][:3, 3]
        return d / np.linalg.norm(d)

    def _bone_dir(self, k):
        rb, i = self.rb, self.rb.node[k]
        name = rb.bones[k]
        # (along the chain: the spine up the spine, not to a thigh or a collarbone)
        chain = {'Bip01 Pelvis': 'Bip01 Spine', 'Bip01 Spine': 'Bip01 Spine1', 'Bip01 Spine1': 'Bip01 Spine2', 'Bip01 Spine2': 'Bip01 Neck', 'Bip01 Neck': 'Bip01 Head'}
        kids = [rb.index[chain[name]]] if name in chain else [c for c, p in enumerate(rb.parent) if p == i and c in rb.node]
        if kids:
            W = self.bw; d = W[rb.node.index(kids[0])][:3, 3] - W[k][:3, 3]
        else:
            d = unit(self.bw[k]) @ np.array([1.0, 0, 0])
        return d / np.linalg.norm(d)

    @staticmethod
    def _swing(a, b):
        v = np.cross(a, b); c = float(np.dot(a, b))
        if np.linalg.norm(v) < 1e-9: return np.eye(3)
        return Rot.from_rotvec(v / np.linalg.norm(v) * np.arccos(np.clip(c, -1, 1))).as_matrix()

    # ------------------------------------------------------------ SOMA forward kinematics
    def soma_world(self, local):
        W = np.zeros((len(self.joints), 4, 4))
        for i in range(len(self.joints)):
            m = np.eye(4); m[:3, :3] = Rot.from_quat(local[i, 3:7]).as_matrix(); m[:3, 3] = local[i, :3]
            W[i] = m if self.parents[i] < 0 else W[self.parents[i]] @ m
        return W

    # ------------------------------------------------------------ Rocketbox -> SOMA
    def to_soma(self, bones_world, at=(0.0, 0.0), heading=0.0):
        """Frames of the 22 bones' world matrices [F, 22, 4, 4] -> SOMA local transforms [F, J, 7], placed at `at`
        (x, z) and turned by `heading` about the vertical (their first frame's hips at `at`)."""
        F = len(bones_world)
        H = Rot.from_euler('y', heading).as_matrix()
        p0 = self.F @ (bones_world[0][0][:3, 3] * [1, 0, 1])
        out = np.zeros((F, len(self.joints), 7))
        for f in range(F):
            G = {}
            for k, b in enumerate(self.rb.bones):
                G[self.j[MAP[b]]] = H @ self.align[k] @ self.F @ unit(bones_world[f][k]) @ self.offset[k]
            hips = self.F @ bones_world[f][0][:3, 3]
            hips = H @ ((hips - p0) * [self.scale, 0, self.scale]) + [at[0], 0, at[1]]
            hips[1] = (bones_world[f][0][1, 3] - self.ground_b) * self.scale + self.ground_s()
            out[f] = self._locals(G, hips)
        return out

    def ground_s(self):
        return min(self.sref[self.j[f'{s}ToeEnd']][1, 3] for s in ('Left', 'Right'))

    def _locals(self, G, hips):
        """SOMA local transforms from the world rotations of the mapped joints (the rest kept elsewhere) and the hips'
        world position."""
        n = len(self.joints)
        Wr = np.zeros((n, 3, 3)); L = np.zeros((n, 7))
        for i in range(n):
            p = self.parents[i]
            if i in G:
                Wr[i] = G[i]
                lr = G[i] if p < 0 else Wr[p].T @ G[i]
            else:
                lr = Rot.from_quat(self.ref[i, 3:7]).as_matrix()
                Wr[i] = lr if p < 0 else Wr[p] @ lr
            L[i, 3:7] = Rot.from_matrix(lr).as_quat()
            L[i, :3] = hips if p < 0 else self.ref[i, :3]
        return L

    # ------------------------------------------------------------ SOMA -> Rocketbox
    def to_rocketbox(self, soma_local):
        """SOMA local transforms [F, J, 7] -> each bone's local rotation (its node's, glTF xyzw) [F, 22, 4] and the
        pelvis node's local translation [F, 3], on this avatar's rig (its root node as it stands)."""
        F = len(soma_local)
        rb = self.rb
        rot = np.zeros((F, len(rb.bones), 4)); pel = np.zeros((F, 3))
        root_inv = np.linalg.inv(self.root)
        Wroot = self.root
        for f in range(F):
            Ws = self.soma_world(soma_local[f])
            Wb = {}
            for k, b in enumerate(rb.bones):
                Rw = self.F.T @ self.align[k].T @ unit(Ws[self.j[MAP[b]]]) @ self.offset[k].T
                Wb[rb.node[k]] = Rw
            for k, b in enumerate(rb.bones):
                i = rb.node[k]; p = rb.parent[i]
                Pw = Wb[p] if p in Wb else unit(Wroot if p == rb.index.get('Bip01') else rb.world()[p])
                rot[f, k] = Rot.from_matrix(Pw.T @ Wb[i]).as_quat()
            # the hips, back to the rig's scale, in its root node's space
            h = Ws[0][:3, 3]
            g = np.array([h[0], (h[1] - self.ground_s()) / self.scale + self.ground_b, h[2]])
            g[[0, 2]] = (self.F.T @ (np.array([h[0], 0, h[2]]) / self.scale))[[0, 2]]
            pel[f] = (root_inv @ np.append(g, 1))[:3]
        return rot, pel
