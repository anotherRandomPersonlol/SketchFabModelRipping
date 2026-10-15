# Compares Blender's glTF import with exact glTF skinning (tools/gltf_skin_reference.py).
# Needs Blender as a Python module: pip install bpy
# Usage: python3 tools/blender_compare.py file=<export.glb> times=0.5,2,4
# The script compares skin 1 / the mesh with 6395 vertices (the test girl); edit the two marked lines for another model.
import sys, numpy as np, bpy
sys.path.insert(0,'tools'); from gltf_skin_reference import G
opts=dict(a.split('=') for a in sys.argv[1:])
path=opts.get('file','girl/Blu - Anime Girl Character.glb')
bpy.ops.wm.read_factory_settings(use_empty=True)
kw={}
if 'bind' in opts: kw['guess_original_bind_pose']=(opts['bind']=='1')
if 'bonedir' in opts: kw['bone_heuristic']=opts['bonedir']
bpy.ops.import_scene.gltf(filepath=path, **kw)
sc=bpy.context.scene; fps=sc.render.fps/sc.render.fps_base
g=G(path); anim=g.anim_map(0)   # reference: exact skinning of the same file
# Blender mesh objects named like the glTF meshes; pick the one with the skin-1 Body (6395 verts)
target=[o for o in sc.objects if o.type=='MESH' and len(o.data.vertices)==6395]   # <- edit: vertex count of the mesh to check
print('fps',fps,'candidates',[o.name for o in target], 'inherit', set(b.inherit_scale for a in bpy.data.armatures for b in a.bones))
ob=target[0]
dg=bpy.context.evaluated_depsgraph_get()
rest=np.array([v.co for v in ob.data.vertices])
times=[float(x) for x in opts.get('times','0.5,2.0,4.0,6.0,8.0').split(',')]
for t in times:
    sc.frame_set(int(round(t*fps)), subframe=t*fps-int(round(t*fps)))
    dg=bpy.context.evaluated_depsgraph_get(); ev=ob.evaluated_get(dg)
    me=ev.to_mesh(); B=np.array([ob.matrix_world @ v.co for v in me.vertices]); ev.to_mesh_clear()
    R=g.skinned(1,t,anim)   # <- edit: node index of that mesh
    R=np.c_[R[:,0],-R[:,2],R[:,1]]   # glTF Y-up -> Blender Z-up
    if len(B)!=len(R): print('vertex count differs',len(B),len(R)); continue
    d=np.linalg.norm(B-R,axis=1); size=np.linalg.norm(R.max(0)-R.min(0))
    print('t=%.2f max err %.5f (%.2f%% of size) mean %.6f  verts>1%%: %d' % (t,d.max(),100*d.max()/size,d.mean(),(d>0.01*size).sum()))
# split error by whether a vertex is weighted to a sheared joint (31..38 in skin 1)
t=4.0
sc.frame_set(int(t*fps)); dg=bpy.context.evaluated_depsgraph_get(); ev=ob.evaluated_get(dg)
me=ev.to_mesh(); B=np.array([ob.matrix_world @ v.co for v in me.vertices]); ev.to_mesh_clear()
R=g.skinned(1,t,anim); R=np.c_[R[:,0],-R[:,2],R[:,1]]
d=np.linalg.norm(B-R,axis=1)
pr=g.j['meshes'][g.j['nodes'][1]['mesh']]['primitives'][0]['attributes']
J=g.acc(pr['JOINTS_0']).astype(int); W=g.acc(pr['WEIGHTS_0']).astype(float)
sheared=set(range(31,39))
mask=np.array([any((J[i,c] in sheared) and W[i,c]>0 for c in range(4)) for i in range(len(J))])
print('sheared-weighted verts',mask.sum(),'max err',d[mask].max() if mask.any() else 0,'| other verts max err',d[~mask].max())
worst=np.argsort(-d)[:5]
for i in worst: print(' vert',i,'err %.4f'%d[i],'joints',J[i],'w',np.round(W[i],2))
