# A Microsoft Rocketbox avatar (MIT; github.com/microsoft/Microsoft-Rocketbox) -> one GLB for the crowd
# (src/world/people.js): its skeleton cut to the 22 bones a walk moves (fingers and face folded into the hand and the
# head), its body in three levels of detail on that skeleton, and its clips retargeted onto it (as
# rocketbox_to_glb.py does for the walker): walks, a jog, standing, waiting, a phone, looking round, talking, sitting.
# Its colour maps go into one atlas beside it (crowd_atlas.py: <id>.webp, the skin marked in alpha).
#
#   python tools/assets/crowd.py <Rocketbox Assets dir> <avatar path, e.g. Adults/Female_Adult_01> <sex f|m> <out dir> <id>
# (Blender as a Python module: pip install bpy pillow numpy)
import bpy, bmesh, sys, os, json, math
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from crowd_atlas import build as build_atlas

ASSETS, AVATAR, SEX, OUT, ID = sys.argv[1:6]
NAME = os.path.basename(AVATAR)
ADIR = os.path.join(ASSETS, 'Avatars', AVATAR)
XY = os.path.join(ASSETS, 'Animations', 'all_animations_max_motextr_xy')        # (clips that travel: walks, the jog)
STATIC = os.path.join(ASSETS, 'Animations', 'all_animations_max_motextr_static') # (clips on the spot)
# name -> (file, folder, keep every n-th frame: a walk at 30 a second, the slow clips at 10)
CLIPS = {
    'walk': (f'{SEX}_walk_neutral_01', XY, 1), 'walk2': (f'{SEX}_walk_neutral_02', XY, 1),
    'stroll': (f'{SEX}_walk_stroll_01', XY, 1), 'brisk': (f'{SEX}_walk_fast_01', XY, 1), 'jog': (f'{SEX}_run_slow_01', XY, 1),
    'idle': (f'{SEX}_idle_neutral_01', STATIC, 3), 'wait': (f'{SEX}_idle_waiting_01', STATIC, 3),
    'text': (f'{SEX}_cell_phone_textmessage', STATIC, 3), 'look': (f'{SEX}_idle_look_around_01', STATIC, 3),
    'talk': (f'{SEX}_gestic_talk_relaxed_01', STATIC, 3), 'sit': (f'{SEX}_sit_chair_idle_neutral_01', STATIC, 3),
}
if SEX == 'm': CLIPS['call'] = ('m_cell_phone_talk_01', STATIC, 3)
KEEP = ['Bip01 Pelvis', 'Bip01 Spine', 'Bip01 Spine1', 'Bip01 Spine2', 'Bip01 Neck', 'Bip01 Head'] + \
    [f'Bip01 {s} {b}' for s in 'LR' for b in ['Clavicle', 'UpperArm', 'Forearm', 'Hand', 'Thigh', 'Calf', 'Foot', 'Toe0']]
LODS = [5200, 1600, 480]   # triangles of the opaque body at each level; the cutout cards (hair, lashes) at LOD 0 and 1 as they are

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
scene.render.fps = 30
bpy.ops.import_scene.fbx(filepath=os.path.join(ADIR, 'Export', NAME + '.fbx'))
arm = next(o for o in bpy.data.objects if o.type == 'ARMATURE')
meshes = [o for o in bpy.data.objects if o.type == 'MESH']
for o in list(bpy.data.objects):
    if o is not arm and o not in meshes: bpy.data.objects.remove(o, do_unlink=True)
for a in list(bpy.data.actions): bpy.data.actions.remove(a)
# (the children's skeleton is named Bip02: the clips' bones are Bip01; renaming a bone renames its vertex group)
for b in arm.data.bones:
    if b.name.startswith('Bip02'): b.name = 'Bip01' + b.name[5:]

# ---------------------------------------------------------------- the clips, retargeted
def select_only(objs, active):
    for o in bpy.data.objects: o.select_set(o in objs)
    bpy.context.view_layer.objects.active = active

actions = []
for name, (file, folder, step) in CLIPS.items():
    before = set(bpy.data.objects)
    bpy.ops.import_scene.fbx(filepath=os.path.join(folder, file + '.max.fbx'))
    new = [o for o in bpy.data.objects if o not in before]
    src = next(o for o in new if o.type == 'ARMATURE')
    f0, f1 = (int(round(x)) for x in src.animation_data.action.frame_range)
    for pb in arm.pose.bones:
        if pb.name not in src.pose.bones: continue
        c = pb.constraints.new('COPY_ROTATION'); c.target = src; c.subtarget = pb.name; c.target_space = c.owner_space = 'WORLD'
        if pb.name == 'Bip01 Pelvis':
            c = pb.constraints.new('COPY_LOCATION'); c.target = src; c.subtarget = pb.name; c.target_space = c.owner_space = 'WORLD'
    select_only([arm], arm)
    bpy.ops.object.mode_set(mode='POSE')
    bpy.ops.pose.select_all(action='SELECT')
    bpy.ops.nla.bake(frame_start=f0, frame_end=f1, step=step, only_selected=True, visual_keying=True, clear_constraints=True,
                     use_current_action=False, bake_types={'POSE'})
    bpy.ops.object.mode_set(mode='OBJECT')
    act = arm.animation_data.action
    act.name = name; act.use_fake_user = True
    actions.append(act)
    arm.animation_data.action = None
    for o in new: bpy.data.objects.remove(o, do_unlink=True)
    print('baked', name, f0, f1, step)

# ---------------------------------------------------------------- the skeleton, cut to the bones a walk moves
bones = arm.data.bones
kept = set(KEEP)
for b in bones:
    if b.name in KEEP:
        p = b.parent
        while p: kept.add(p.name); p = p.parent    # (and what they hang from)
missing = [n for n in KEEP if n not in bones]
if missing: raise SystemExit(f'{NAME}: no {missing}')
def kept_ancestor(name):
    b = bones[name]
    while b.name not in kept: b = b.parent
    return b.name
fold = {b.name: kept_ancestor(b.name) for b in bones if b.name not in kept}
for m in meshes:
    vg = m.vertex_groups
    for target in set(fold.values()):
        if target not in vg: vg.new(name=target)
    moved = {}
    for v in m.data.vertices:
        for g in v.groups:
            n = vg[g.group].name
            if n in fold and g.weight > 0: moved.setdefault((fold[n], v.index), 0.0); moved[(fold[n], v.index)] += g.weight
    for (target, i), w in moved.items(): vg[target].add([i], w, 'ADD')
    for n in fold:
        if n in vg: vg.remove(vg[n])
# (what no bone carries, a helmet, an earring, goes with the bone nearest it: else the exporter hangs it on a bone of
# its own, still at the feet)
from mathutils.geometry import intersect_point_line
segs = [(n, arm.matrix_world @ bones[n].head_local, arm.matrix_world @ bones[n].tail_local) for n in KEEP]
loose = 0
for m in meshes:
    vg = m.vertex_groups
    names = {g.index: g.name for g in vg}
    for v in m.data.vertices:
        if sum(g.weight for g in v.groups if names.get(g.group) in kept) > 1e-4: continue
        p = m.matrix_world @ v.co
        def dist(s):
            q, t = intersect_point_line(p, s[1], s[2]); t = min(1, max(0, t))
            return (p - (s[1] + (s[2] - s[1]) * t)).length
        vg[min(segs, key=dist)[0]].add([v.index], 1.0, 'REPLACE'); loose += 1
print('loose vertices', loose)
select_only([arm], arm)
bpy.ops.object.mode_set(mode='EDIT')
for n in fold: arm.data.edit_bones.remove(arm.data.edit_bones[n])
bpy.ops.object.mode_set(mode='OBJECT')

def curves(act):
    if hasattr(act, 'layers') and len(act.layers):
        for layer in act.layers:
            for strip in layer.strips:
                for bag in strip.channelbags: yield bag.fcurves
    else: yield act.fcurves
for act in actions:
    for fcs in curves(act):
        for fc in list(fcs):
            bone = fc.data_path.split('"')[1] if '"' in fc.data_path else ''
            keep = bone in kept and (fc.data_path.endswith('rotation_quaternion') or fc.data_path.endswith('rotation_euler')
                                     or (fc.data_path.endswith('location') and bone == 'Bip01 Pelvis'))
            if not keep: fcs.remove(fc); continue
            for k in fc.keyframe_points: k.interpolation = 'LINEAR'

# ---------------------------------------------------------------- one atlas, two materials
rects, skin = build_atlas(os.path.join(ADIR, 'Textures'), os.path.join(OUT, ID + '.webp'))
AW, AH = 768, 512
mat_opaque = bpy.data.materials.new('opaque'); mat_cut = bpy.data.materials.new('cutout')
cut_maps = set()
for m in meshes:
    me = m.data; uv = me.uv_layers.active.data
    slot_rect = []
    for ms in m.material_slots:
        img = None
        if ms.material and ms.material.node_tree:
            for n in ms.material.node_tree.nodes:
                if n.type == 'TEX_IMAGE' and n.image and '_color' in n.image.filepath.lower(): img = os.path.basename(n.image.filepath.replace('\\', '/')); break
        r = rects.get(img) if img else None
        if r is None: print('no map for', m.name, ms.material and ms.material.name, img)
        slot_rect.append((img, r))
    was = [p.material_index for p in me.polygons]
    me.materials.clear(); me.materials.append(mat_opaque); me.materials.append(mat_cut)   # (this sets every face's to 0)
    for p in me.polygons:
        img, r = slot_rect[was[p.index]] if was[p.index] < len(slot_rect) else (None, None)
        x, y, w, h = r if r else (0, 0, 1, 1)
        for li in p.loop_indices:
            u, v = uv[li].uv
            u = min(1.0, max(0.0, u)); v = min(1.0, max(0.0, v))
            uv[li].uv = ((x + u * w) / AW, 1 - (y + (1 - v) * h) / AH)
        p.material_index = 1 if img and 'opacity' in img.lower() else 0

# joined into one body, then split into its opaque part and its cutout cards
select_only(meshes, meshes[0])
if len(meshes) > 1: bpy.ops.object.join()
body = bpy.context.view_layer.objects.active
body.name = 'body'
while body.data.color_attributes: body.data.color_attributes.remove(body.data.color_attributes[0])

def copy_of(obj, name):
    c = obj.copy(); c.data = obj.data.copy(); c.name = name
    bpy.context.collection.objects.link(c)
    return c

def keep_faces(obj, cut):
    # remove the faces of the other kind (cut: keep only the cutout cards)
    bm = bmesh.new(); bm.from_mesh(obj.data)
    bmesh.ops.delete(bm, geom=[f for f in bm.faces if (f.material_index == 1) != cut], context='FACES')
    bm.to_mesh(obj.data); bm.free(); obj.data.update()

def tris(obj): return sum(len(p.vertices) - 2 for p in obj.data.polygons)

stats = {}
for lod, target in enumerate(LODS):
    o = copy_of(body, f'LOD{lod}')
    if target is not None:
        cards = copy_of(body, f'cards{lod}') if lod < 2 else None
        keep_faces(o, cut=False)
        if cards: keep_faces(cards, cut=True)
        mod = o.modifiers.new('decimate', 'DECIMATE'); mod.ratio = min(1.0, target / max(1, tris(o))); mod.use_collapse_triangulate = True
        select_only([o], o)
        bpy.ops.object.modifier_move_to_index(modifier='decimate', index=0)
        bpy.ops.object.modifier_apply(modifier='decimate')
        if cards:
            select_only([o, cards], o); bpy.ops.object.join()
    stats[f'LOD{lod}'] = tris(o)
bpy.data.objects.remove(body, do_unlink=True)

# one NLA track per clip (the exporter writes each track as an animation)
ad = arm.animation_data_create()
for act in actions:
    tr = ad.nla_tracks.new(); tr.name = act.name
    st = tr.strips.new(act.name, int(act.frame_range[0]), act)
    if hasattr(st, 'action_slot') and act.slots: st.action_slot = act.slots[0]
ad.action = None

select_only([arm] + [o for o in bpy.data.objects if o.name.startswith('LOD')], arm)
glb = os.path.join(OUT, ID + '.glb')
bpy.ops.export_scene.gltf(filepath=glb, export_format='GLB', use_selection=True, export_animation_mode='NLA_TRACKS',
    export_image_format='NONE', export_optimize_animation_size=True, export_force_sampling=False,
    export_def_bones=True, export_leaf_bone=False, export_apply=False, export_normals=True, export_tangents=False,
    export_materials='EXPORT', export_extras=False)
info = {'id': ID, 'source': NAME, 'sex': SEX, 'triangles': stats, 'skin': [round(v, 1) for v in skin],
        'clips': {a.name: [round(a.frame_range[0]), round(a.frame_range[1])] for a in actions}}
json.dump(info, open(os.path.join(OUT, ID + '.json'), 'w'))
print('EXPORTED', json.dumps(info))
