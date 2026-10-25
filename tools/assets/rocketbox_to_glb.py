# Microsoft Rocketbox avatar + clips -> one GLB for the walker and the cyclist (public/models/people/m01.glb).
# Download from github.com/microsoft/Microsoft-Rocketbox (MIT): Assets/Avatars/Adults/Male_Adult_01/Export/*.fbx with its
# Textures/ beside it as tex/, and the clips from Assets/Animations/all_animations_max_motextr_{static,xy}/. Then:
#   Blender -b --factory-startup -P tools/assets/rocketbox_to_glb.py -- Male_Adult_01.fbx m01.glb \
#     idle=m_idle_neutral_01.fbx walk=m_walk_neutral_01.fbx run=m_run_neutral_01.fbx walkfast=m_walk_fast_01.fbx sit=m_sit_chair_idle_neutral_01.fbx
# (the walk and run keep their travel in the pelvis's track: src/world/player.js measures it and takes it out)
# args: avatar.fbx out.glb name=clip.fbx ...
import bpy, sys, os
args = sys.argv[sys.argv.index('--') + 1:]
avatar, out, clips = args[0], args[1], [a.split('=', 1) for a in args[2:]]
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.context.scene.render.fps = 30
bpy.ops.import_scene.fbx(filepath=avatar)
arm = next(o for o in bpy.data.objects if o.type == 'ARMATURE')
mesh = next(o for o in bpy.data.objects if o.type == 'MESH')
for o in list(bpy.data.objects):
    if o not in (arm, mesh): bpy.data.objects.remove(o, do_unlink=True)
# (the textures are referred to where their author kept them: here, they are in tex/ beside the avatar)
texdir = os.path.join(os.path.dirname(os.path.abspath(avatar)), 'tex')
for im in bpy.data.images:
    im.filepath = os.path.join(texdir, os.path.basename(im.filepath.replace('\\', '/'))); im.reload()
    print('texture', im.name, im.size[:])
for a in list(bpy.data.actions): bpy.data.actions.remove(a)
# the clips: import each and retarget it onto the avatar's skeleton (the clips' skeletons rest in other poses, so
# their values cannot be copied as they are): every bone of the avatar turned as its namesake turns in the world,
# the pelvis also placed where it is, then baked into an action under the clip's name
actions = []
bpy.context.view_layer.objects.active = arm
for name, path in clips:
    before = set(bpy.data.objects)
    bpy.ops.import_scene.fbx(filepath=path)
    new = [o for o in bpy.data.objects if o not in before]
    src = next(o for o in new if o.type == 'ARMATURE')
    f0, f1 = (int(x) for x in src.animation_data.action.frame_range)
    if name == 'sit': f1 = f0 + 1
    for pb in arm.pose.bones:
        if pb.name not in src.pose.bones: continue
        c = pb.constraints.new('COPY_ROTATION'); c.target = src; c.subtarget = pb.name; c.target_space = c.owner_space = 'WORLD'
        if pb.name == 'Bip01 Pelvis':
            c = pb.constraints.new('COPY_LOCATION'); c.target = src; c.subtarget = pb.name; c.target_space = c.owner_space = 'WORLD'
    for o in bpy.data.objects: o.select_set(o == arm)
    bpy.context.view_layer.objects.active = arm
    bpy.ops.object.mode_set(mode='POSE')
    bpy.ops.pose.select_all(action='SELECT')
    bpy.ops.nla.bake(frame_start=f0, frame_end=f1, only_selected=True, visual_keying=True, clear_constraints=True, use_current_action=False, bake_types={'POSE'})
    bpy.ops.object.mode_set(mode='OBJECT')
    act = arm.animation_data.action
    act.name = name; act.use_fake_user = True
    actions.append(act)
    arm.animation_data.action = None
    for o in new: bpy.data.objects.remove(o, do_unlink=True)
    print('baked', name, f0, f1)
# Only what moves: the bones turn (their lengths are fixed), the pelvis moves too; a still pose ('sit') is a frame
def curves(act):
    if hasattr(act, 'layers') and len(act.layers):
        for layer in act.layers:
            for strip in layer.strips:
                for bag in strip.channelbags: yield bag.fcurves
    else: yield act.fcurves
for act in actions:
    for fcs in curves(act):
        for fc in list(fcs):
            keep = fc.data_path.endswith('rotation_quaternion') or fc.data_path.endswith('rotation_euler') or (fc.data_path.endswith('location') and 'Bip01 Pelvis' in fc.data_path)
            if not keep: fcs.remove(fc); continue
            if act.name == 'sit':
                for k in [k for k in fc.keyframe_points if k.co[0] > 2][::-1]: fc.keyframe_points.remove(k)
    print('action', act.name, sum(len(f) for f in curves(act)), act.frame_range[:])
# one NLA track per clip on the avatar's skeleton (the exporter writes each track as an animation)
ad = arm.animation_data_create()
for act in actions:
    tr = ad.nla_tracks.new(); tr.name = act.name
    st = tr.strips.new(act.name, int(act.frame_range[0]), act)
    if hasattr(st, 'action_slot') and act.slots: st.action_slot = act.slots[0]
    tr.mute = False
ad.action = None
# textures: 1024 (the hair and lashes' cutout map 512); the specular maps dropped, a cloth's and a skin's roughness
for m in bpy.data.materials:
    nt = m.node_tree; bsdf = next(n for n in nt.nodes if n.type == 'BSDF_PRINCIPLED')
    for n in list(nt.nodes):
        if n.type == 'TEX_IMAGE' and n.image and 'specular' in n.image.filepath.lower(): nt.nodes.remove(n)
    bsdf.inputs['Roughness'].default_value = 0.55 if 'head' in m.name else 0.8
    bsdf.inputs['Metallic'].default_value = 0.0
    for n in nt.nodes:
        if n.type == 'TEX_IMAGE' and n.image:
            s = 512 if 'opacity' in n.image.filepath.lower() else 1024
            if n.image.size[0] > s: n.image.scale(s, s)
for o in bpy.data.objects: o.select_set(True)
bpy.ops.export_scene.gltf(filepath=out, export_format='GLB', use_selection=True, export_animation_mode='NLA_TRACKS',
    export_image_format='WEBP', export_image_quality=82, export_optimize_animation_size=True, export_force_sampling=False,
    export_def_bones=True, export_leaf_bone=False, export_apply=False)
print('EXPORTED', out, [a.name for a in actions])
