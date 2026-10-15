# Reference glTF evaluator: node world matrices at time t and CPU skinning of one mesh (exact spec math).
import json, struct, numpy as np, sys
CT={5126:np.float32,5125:np.uint32,5123:np.uint16,5121:np.uint8,5122:np.int16,5120:np.int8}
NC={'SCALAR':1,'VEC2':2,'VEC3':3,'VEC4':4,'MAT4':16}
class G:
    def __init__(s,path):
        b=open(path,'rb').read()
        jl=struct.unpack('<I',b[12:16])[0]; s.j=json.loads(b[20:20+jl]); o=20+jl
        bl=struct.unpack('<I',b[o:o+4])[0]; s.bin=b[o+8:o+8+bl]
        s.parent={}
        for i,n in enumerate(s.j['nodes']):
            for c in n.get('children',[]): s.parent[c]=i
    def acc(s,i):
        a=s.j['accessors'][i]; bv=s.j['bufferViews'][a['bufferView']]
        dt=CT[a['componentType']]; n=NC[a['type']]
        off=bv.get('byteOffset',0)+a.get('byteOffset',0)
        arr=np.frombuffer(s.bin,dtype=dt,count=a['count']*n,offset=off).reshape(a['count'],n)
        if a.get('normalized') and dt!=np.float32: arr=arr.astype(np.float64)/np.iinfo(dt).max
        return arr
    def trs(s,i,t,anim):
        n=s.j['nodes'][i]
        if 'matrix' in n and not anim.get(i): return np.array(n['matrix'],dtype=np.float64).reshape(4,4).T
        T=np.array(n.get('translation',[0,0,0]),float); R=np.array(n.get('rotation',[0,0,0,1]),float); S=np.array(n.get('scale',[1,1,1]),float)
        for path,(inp,out) in anim.get(i,{}).items():
            v=s.sample(inp,out,t,path)
            if path=='translation':T=v
            elif path=='rotation':R=v
            elif path=='scale':S=v
        x,y,z,w=R
        Rm=np.array([[1-2*(y*y+z*z),2*(x*y-z*w),2*(x*z+y*w)],[2*(x*y+z*w),1-2*(x*x+z*z),2*(y*z-x*w)],[2*(x*z-y*w),2*(y*z+x*w),1-2*(x*x+y*y)]])
        M=np.eye(4); M[:3,:3]=Rm*S[None,:]; M[:3,3]=T; return M
    def sample(s,inp,out,t,path):
        k=np.searchsorted(inp,t)
        if k<=0: return out[0].astype(float)
        if k>=len(inp): return out[-1].astype(float)
        t0,t1=inp[k-1],inp[k]; a=(t-t0)/(t1-t0) if t1>t0 else 0
        v0=out[k-1].astype(float); v1=out[k].astype(float)
        if path=='rotation':
            d=np.dot(v0,v1)
            if d<0: v1=-v1; d=-d
            if d>0.9995: r=v0+a*(v1-v0)
            else:
                th=np.arccos(d); r=(np.sin((1-a)*th)*v0+np.sin(a*th)*v1)/np.sin(th)
            return r/np.linalg.norm(r)
        return v0+a*(v1-v0)
    def anim_map(s,ai=0):
        m={}
        if 'animations' not in s.j: return m
        A=s.j['animations'][ai]
        for ch in A['channels']:
            sm=A['samplers'][ch['sampler']]
            m.setdefault(ch['target']['node'],{})[ch['target']['path']]=(s.acc(sm['input'])[:,0].astype(float),s.acc(sm['output']))
        return m
    def world(s,i,t,anim,cache):
        if i in cache: return cache[i]
        M=s.trs(i,t,anim)
        if i in s.parent: M=s.world(s.parent[i],t,anim,cache)@M
        cache[i]=M; return M
    def skinned(s,node,t,anim):
        n=s.j['nodes'][node]; mesh=s.j['meshes'][n['mesh']]; pr=mesh['primitives'][0]['attributes']
        P=s.acc(pr['POSITION']).astype(float); J=s.acc(pr['JOINTS_0']).astype(int); W=s.acc(pr['WEIGHTS_0']).astype(float)
        sk=s.j['skins'][n['skin']]; ibm=s.acc(sk['inverseBindMatrices']).reshape(-1,4,4).transpose(0,2,1) if 'inverseBindMatrices' in sk else None
        cache={}; Jm=[]
        for k,jn in enumerate(sk['joints']):
            M=s.world(jn,t,anim,cache)
            if ibm is not None: M=M@ibm[k]
            Jm.append(M)
        Jm=np.array(Jm)
        Ph=np.c_[P,np.ones(len(P))]
        out=np.zeros((len(P),3))
        for c in range(4):
            out+=W[:,c:c+1]*np.einsum('nij,nj->ni',Jm[J[:,c]],Ph)[:,:3]
        return out
