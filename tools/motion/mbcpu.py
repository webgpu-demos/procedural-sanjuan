# NVIDIA's MotionBricks SOMA model (github.com/NVlabs/motionbricks: code Apache-2.0, model under the NVIDIA Open Model
# Agreement) on the CPU: its own engine's encoding, decoding and endpoint correction (Warp kernels, which run on the
# CPU too), with ONNX Runtime in place of TensorRT. One generation fills the motion between the 4 latest poses of a
# character and 1 to 4 poses it is to reach: 18 to 58 frames at 30 Hz, about 0.15 s of two cores' time each.
#
#   engine = CpuSOMA(<motionbricks checkout>, <mmm_v6_soma_fp32.onnx>)
#   frames, contacts = engine.generate(context_poses[4, J, 7], target_poses[n, J, 7], tokens=range(8, 15))
# Poses: the SOMA skeleton's local transforms (engine.skeleton: its joints, Hips first), each [x y z qx qy qz qw], the
# root's in the world (Y up, metres; the model's own space).
import sys, contextlib
from pathlib import Path
import numpy as np


class _Timer:
    milliseconds = {}
    @contextlib.contextmanager
    def stage(self, name): yield
    def read(self): pass


def load(repo):
    """Import the MotionBricks package from a checkout (without TensorRT: a stand-in module answers its imports)."""
    import types
    if 'tensorrt' not in sys.modules:
        class _Any(type):
            def __getattr__(cls, name): return _Stub
        class _Stub(metaclass=_Any):
            def __init__(self, *a, **k): pass
        trt = types.ModuleType('tensorrt'); trt.__getattr__ = lambda name: _Stub; trt.__version__ = '0'
        sys.modules['tensorrt'] = trt
    sys.path.insert(0, str(repo))
    import warp as wp
    wp.config.quiet = True
    wp.init(); wp.set_device('cpu')
    from motionbricks.model.soma.engine import MotionBricksSOMAEngine
    return wp, MotionBricksSOMAEngine


class CpuSOMA:
    def __init__(self, repo, onnx_path, threads=2):
        import onnxruntime as ort
        wp, Base = load(repo)
        from motionbricks.io.usd import load_skeleton_from_usd
        from motionbricks.io.utils import SOMA_SKELETON_PRIM_PATH, get_asset_file
        from motionbricks.model.config import MotionBricksInferenceConfig
        self.wp, self.Config = wp, MotionBricksInferenceConfig
        so = ort.SessionOptions(); so.intra_op_num_threads = threads
        session = ort.InferenceSession(str(onnx_path), so, providers=['CPUExecutionProvider'])

        class Engine(Base):
            # the engine, its TensorRT plan, stream and CUDA graph left out
            def __init__(self):
                self._closed = False
                self._stream = None
                self._cuda_graph = None
                self._tensor_specs = {s.name: s for s in self.contract.tensor_specs}
                self._buffers = {s.name: wp.zeros(s.shape, dtype=wp.float32 if s.dtype == np.dtype(np.float32) else wp.int32, device='cpu')
                                 for s in self.contract.tensor_specs}
                self._use_cuda_graph = False
                self._model_to_runtime = wp.transform_identity()
                self._runtime_to_model = wp.transform_identity()
                self.timer = _Timer()
                self._alignment = wp.empty(1, dtype=wp.transform, device='cpu')
                self._generated_frame_count = wp.empty(1, dtype=wp.int32, device='cpu')
                self._initialize_pose_layout()
            @property
            def device(self): return wp.get_device('cpu')
            @property
            def stream(self): return None
            def _ensure_open(self): pass
            def synchronize(self): pass
            def close(self): pass
            def _enqueue_tensorrt(self):
                names = [s.name for s in self.contract.tensor_specs if str(s.mode).lower().endswith('input')]
                out = session.run(None, {n: self._buffers[n].numpy() for n in names})
                for o, v in zip(session.get_outputs(), out): self._buffers[o.name].assign(v)

        self.engine = Engine()
        self.skeleton = load_skeleton_from_usd(get_asset_file('human', 'soma_base_skel_minimal_no_root.usd'), SOMA_SKELETON_PRIM_PATH)
        self.context = self.engine.create_input(self.skeleton)
        self.target = self.engine.create_input(self.skeleton)
        self.output = self.engine.create_output(self.skeleton)

    @property
    def joints(self): return list(self.skeleton.joint_names)
    @property
    def parents(self): return self.skeleton.parent_indices.numpy()
    @property
    def reference(self): return self.skeleton.reference_local_transforms.numpy()

    def generate(self, context, target, tokens=range(8, 15), correct=True):
        wp = self.wp
        self.context.update_from_poses(wp.array(np.asarray(context, np.float32), dtype=wp.transform, device='cpu'))
        self.target.update_from_poses(wp.array(np.asarray(target, np.float32), dtype=wp.transform, device='cpu'))
        cfg = self.Config(allowed_token_counts=tuple(tokens), correct_generated_diff=correct)
        self.engine.generate_animation(self.context, self.target, self.output, config=cfg)
        n = self.output.num_frames
        return self.output.poses.numpy()[:n].copy(), self.output.foot_contacts.numpy()[:n].copy()
