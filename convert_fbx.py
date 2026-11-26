import bpy, os, sys

src = r"C:\Users\rorym\OneDrive\Desktop\NBHD_INTERACT\animations_rm_prep"
dst = r"C:\Users\rorym\OneDrive\Desktop\NBHD_INTERACT\public\models"
os.makedirs(dst, exist_ok=True)

files = [("Running Slide.fbx", "Slide"), ("Crouched Walking.fbx", "CrouchWalk")]

for f, clip in files:
    path = os.path.join(src, f)
    if not os.path.exists(path):
        print(f"SKIP missing: {f}")
        continue
    # Reset scene
    bpy.ops.object.select_all(action='SELECT')
    bpy.ops.object.delete(use_global=False)
    for block in bpy.data.actions:
        bpy.data.actions.remove(block)
    # Import FBX
    bpy.ops.import_scene.fbx(filepath=path, global_scale=0.01, use_anim=True)
    # Report
    meshes = [o for o in bpy.context.scene.objects if o.type == 'MESH']
    arms = [o for o in bpy.context.scene.objects if o.type == 'ARMATURE']
    actions = list(bpy.data.actions)
    print(f"IMPORT {f}: meshes={len(meshes)} armatures={len(arms)} actions={[a.name for a in actions]}")
    # Rename action to a clean clip name
    if actions:
        actions[0].name = clip
    # Export GLB
    out = os.path.join(dst, clip + ".glb")
    bpy.ops.export_scene.gltf(filepath=out, export_format='GLB', export_animations=True,
                              export_skins=True, export_morph=True, export_yup=True,
                              export_apply=False)
    print(f"EXPORTED {out} ({os.path.getsize(out)} bytes)")

print("DONE")
