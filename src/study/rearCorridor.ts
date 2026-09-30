import {AbstractMesh,Mesh,Matrix,Vector3,VertexData} from '@babylonjs/core';
/** Cut an opening without deleting an entire merged scenery mesh. */
export function clearRearCorridor(meshes:AbstractMesh[]){
  const buildings=meshes.filter(m=>/Warehouse lime plaster/i.test(m.material?.name??'')).map(m=>{m.computeWorldMatrix(true);const b=m.getBoundingInfo().boundingBox;return {lo:b.minimumWorld.clone(),hi:b.maximumWorld.clone()};});
  for(const mesh of meshes){
    const name=mesh.name+' '+(mesh.material?.name??'');
    if(!(mesh instanceof Mesh)||!/limestone|rock|earth|foliage|trunk|branch|tree|bark|palm|plaster|wall|timber|fence/i.test(name))continue;
    if(/earth/i.test(name)){lowerRoadSoil(mesh);continue;}
    if(!/plaster|wall/i.test(name)) { removeRearObstacles(mesh, /foliage|trunk|branch|tree|bark|palm/i.test(name),buildings); continue; }
    mesh.computeWorldMatrix(true);const bounds=mesh.getBoundingInfo().boundingBox;const lo=bounds.minimumWorld,hi=bounds.maximumWorld;if(hi.x<-9.8||lo.x>-4.2||hi.z<-42||lo.z>-23||hi.y<1.42||lo.y>6)continue;
    const p=mesh.getVerticesData('position'),ix=mesh.getIndices();if(!p||!ix)continue;
    const normals=mesh.getVerticesData('normal'),uv=mesh.getVerticesData('uv'),world=mesh.computeWorldMatrix(true);
    const pos:number[]=[],nor:number[]=[],tex:number[]=[],indices:number[]=[];let changed=false;
    type V={p:Vector3;w:Vector3;n:Vector3;u:number;v:number};
    const interpolate=(a:V,b:V,t:number):V=>({p:Vector3.Lerp(a.p,b.p,t),w:Vector3.Lerp(a.w,b.w,t),n:Vector3.Lerp(a.n,b.n,t),u:a.u+(b.u-a.u)*t,v:a.v+(b.v-a.v)*t});
    const clip=(poly:V[],distance:(v:V)=>number,inside:boolean)=>{const out:V[]=[];for(let i=0;i<poly.length;i++){const a=poly[i],b=poly[(i+1)%poly.length],da=distance(a),db=distance(b),ina=inside?da>=0:da<=0,inb=inside?db>=0:db<=0;if(ina)out.push(a);if(ina!==inb)out.push(interpolate(a,b,da/(da-db)));}return out;};
    const emit=(poly:V[])=>{for(let j=1;j<poly.length-1;j++)for(const v of [poly[0],poly[j],poly[j+1]]){indices.push(pos.length/3);pos.push(v.p.x,v.p.y,v.p.z);nor.push(v.n.x,v.n.y,v.n.z);tex.push(v.u,v.v);}};
    // Full truck clearance through the rear wall and landscaped strip; roof retained.
    const planes=[(v:V)=>v.w.x+9.8,(v:V)=>-4.2-v.w.x,(v:V)=>-23-v.w.z,(v:V)=>v.w.z+42,(v:V)=>v.w.y-1.42,(v:V)=>6-v.w.y];
    for(let i=0;i<ix.length;i+=3){const tri=[ix[i],ix[i+1],ix[i+2]].map(k=>{const pt=Vector3.FromArray(p,k*3);return {p:pt,w:Vector3.TransformCoordinates(pt,world),n:normals?Vector3.FromArray(normals,k*3):Vector3.Up(),u:uv?.[k*2]??0,v:uv?.[k*2+1]??0};});
      if(planes.some(f=>tri.every(v=>f(v)<0))){emit(tri);continue;}
      changed=true;let rest=tri;for(const f of planes){if(rest.length<3)break;emit(clip(rest,f,false));rest=clip(rest,f,true);}
    }
    if(changed){mesh.makeGeometryUnique();const data=new VertexData();data.positions=pos;data.normals=nor;data.uvs=tex;data.indices=indices;data.applyToMesh(mesh);}
  }
}

/** Keep original vertex attributes; remove whole connected objects instead of slicing rocks/leaves. */
function removeRearObstacles(mesh:Mesh, vegetation:boolean, buildings:{lo:Vector3;hi:Vector3}[]){
  const p=mesh.getVerticesData('position'),ix=mesh.getIndices();if(!p||!ix)return;
  const world=mesh.computeWorldMatrix(true),count=p.length/3,parent=new Int32Array(count);
  const find=(v:number):number=>{while(parent[v]!==v){parent[v]=parent[parent[v]];v=parent[v];}return v;};
  const join=(a:number,b:number)=>{parent[find(a)]=find(b);};
  const welded=new Map<string,number>();
  for(let i=0;i<count;i++){parent[i]=i;const key=[p[i*3],p[i*3+1],p[i*3+2]].map(v=>Math.round(v*10000)).join(',');const prev=welded.get(key);if(prev!==undefined)join(i,prev);else welded.set(key,i);}
  for(let i=0;i<ix.length;i+=3){join(ix[i],ix[i+1]);join(ix[i],ix[i+2]);}
  const bounds=new Map<number,number[]>();
  for(let i=0;i<count;i++){const r=find(i),v=Vector3.TransformCoordinates(Vector3.FromArray(p,i*3),world);let b=bounds.get(r);if(!b){b=[v.x,v.x,v.z,v.z,v.y];bounds.set(r,b);}else{b[0]=Math.min(b[0],v.x);b[1]=Math.max(b[1],v.x);b[2]=Math.min(b[2],v.z);b[3]=Math.max(b[3],v.z);b[4]=Math.max(b[4],v.y);}}
  const removed=new Set<number>();
  for(const [id,b] of bounds){
    const rear=b[2]<-23&&b[3]>-60;
    const overlapsRoad=b[1]>-10.4&&b[0]<-3.6;
    const onBuilding=vegetation&&buildings.some(box=>b[1]>box.lo.x-.6&&b[0]<box.hi.x+.6&&b[3]>box.lo.z-.6&&b[2]<box.hi.z+.6);
    if((rear&&b[4]>1.43&&overlapsRoad)||onBuilding)removed.add(id);
  }
  if(!removed.size)return;
  const keep:number[]=[];for(let i=0;i<ix.length;i+=3)if(!removed.has(find(ix[i])))keep.push(ix[i],ix[i+1],ix[i+2]);
  mesh.makeGeometryUnique();mesh.setIndices(keep,count);if(!keep.length)mesh.setEnabled(false);
}

/** Retain the original continuous shore; lower only soil beneath the new road. */
function lowerRoadSoil(mesh:Mesh){
  const original=mesh.getVerticesData('position');if(!original)return;
  const p=Array.from(original),world=mesh.computeWorldMatrix(true),inverse=Matrix.Invert(world);let changed=false;
  for(let i=0;i<p.length;i+=3){const v=Vector3.TransformCoordinates(Vector3.FromArray(p,i),world);
    if(v.x>-9.65&&v.x<-4.35&&v.z<-23&&v.z>-60&&v.y>1.38){v.y=1.38;const local=Vector3.TransformCoordinates(v,inverse);p[i]=local.x;p[i+1]=local.y;p[i+2]=local.z;changed=true;}}
  if(changed){mesh.makeGeometryUnique();mesh.setVerticesData('position',p);const normals:number[]=[];VertexData.ComputeNormals(p,mesh.getIndices()!,normals);mesh.setVerticesData('normal',normals);}
}
