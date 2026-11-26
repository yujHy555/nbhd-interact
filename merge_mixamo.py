import bpy, os

SRC = r"C:\Users\rorym\OneDrive\Desktop\NBHD_INTERACT\skinned_animations_mixamo"
OUT = r"C:\Users\rorym\OneDrive\Desktop\NBHD_INTERACT\public\models\BlobothanChar.glb"

FILES = [("Idle.fbx", "Idle"), ("Walking.fbx", "Walking"),
         ("Running.fbx", "Running"), ("Jumping.fbx", "Jumping"),
         ("Running Slide.fbx", "Slide"), ("Crouched Walking.fbx", "CrouchWalk")]

# Clean scene
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)
for a in list(bpy.data.actions):
    bpy.data.actions.remove(a)

base_arm = None
base_mesh = None

for idx, (fname, clip) in enumerate(FILES):
    path = os.path.join(SRC, fname)
    before = set(bpy.data.objects)
    bpy.ops.import_scene.fbx(filepath=path, global_scale=0.01, use_anim=True)
    new = [o for o in bpy.data.objects if o not in before]

    arm = next((o for o in new if o.type == 'ARMATURE'), None)
    meshes = [o for o in new if o.type == 'MESH']
    acts = list(bpy.data.actions)

    if idx == 0:
        base_arm = arm
        base_mesh = meshes[0] if meshes else None
        base_arm.name = "MixamoArmature"
        if base_mesh:
            base_mesh.name = "BlobothanCharacter"
        # rename the imported action
        if acts:
            acts[0].name = clip
        print(f"BASE: {fname} arm={base_arm.name} mesh={base_mesh.name if base_mesh else None} action={acts[0].name if acts else None}")
    else:
        # Copy animation from this import's action onto the BASE armature.
        # Bone names are identical (all Mixamo), so we can just assign the
        # action to the base armature via NLA strip with a unique name.
        src_action = acts[0] if acts else None
        if src_action is None:
            print(f"WARN: no action in {fname}")
            continue
        src_action.name = clip  # e.g. Walking
        # Bake out root motion: Mixamo clips translate the hips bone, which
        # would slide the visible mesh inside the skeleton then snap back when
        # the clip ends. Keep rotation, zero the location keys so clips play
        # in place — the kinematic controller owns all world-space movement.
        # Blender 4.4+/5.x uses layered actions; fall back to legacy fcurves.
        all_fcurves = []
        if hasattr(src_action, 'fcurves'):
            all_fcurves = list(src_action.fcurves)
        else:
            for layer in getattr(src_action, 'layers', []):
                for strip in layer.strips:
                    for bag in getattr(strip, 'channelbags', []):
                        all_fcurves.extend(list(bag.fcurves))
        for fc in all_fcurves:
            if 'Hips' in fc.data_path and fc.array_index < 3 and fc.keyframe_points:
                base = fc.keyframe_points[0].co.y
                for kp in fc.keyframe_points:
                    kp.co.y = base
                    kp.handle_left.y = base
                    kp.handle_right.y = base
        # Attach action to base armature as an NLA track so the glTF exporter
        # exports each as a separate AnimationGroup.
        if base_arm.animation_data is None:
            base_arm.animation_data_create()
        track = base_arm.animation_data.nla_tracks.new()
        track.name = clip
        strip = track.strips.new(clip, 0, src_action)
        strip.action_frame_start = src_action.frame_range[0]
        strip.action_frame_end = src_action.frame_range[1]
        print(f"MERGED {fname} action={clip} range={tuple(src_action.frame_range)}")

        # Remove the duplicate imported armature + meshes (keep only base)
        for o in new:
            if o is not base_arm and o is not base_mesh:
                bpy.data.objects.remove(o, do_unlink=True)

os.makedirs(os.path.dirname(OUT), exist_ok=True)
bpy.ops.export_scene.gltf(
    filepath=OUT,
    export_format='GLB',
    export_animations=True,
    export_skins=True,
    export_morph=True,
    export_yup=True,
    export_apply=False,
    export_nla_strips=True,
)
print(f"EXPORTED {OUT} ({os.path.getsize(OUT)} bytes)")
print("DONE")
