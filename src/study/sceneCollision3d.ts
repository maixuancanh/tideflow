import { AbstractMesh, Scene, TransformNode, Vector3 } from '@babylonjs/core';
import { ContinuousCollisionWorld, type Box3, type Contact3 } from './collision3d';

export type CollisionCategory='crane'|'cargo'|'truck'|'structure';
export function markCollision(node:TransformNode,owner:string,category:CollisionCategory){
  node.metadata={...node.metadata,collisionOwner:owner,collisionCategory:category};
}
function registration(mesh:AbstractMesh):{owner:string;category:CollisionCategory;ignore:string[]}|undefined{
  let node:TransformNode|null=mesh;
  while(node){if(node.metadata?.collisionOwner)return {owner:node.metadata.collisionOwner,category:node.metadata.collisionCategory,ignore:node.metadata.collisionIgnoreOwners??[]};node=node.parent as TransformNode|null;}
  // Existing GLB and authored meshes predate the metadata contract. Register
  // their moving envelopes by stable semantic name until operations adds tags.
  const names=[] as string[];let cursor: any=mesh;while(cursor&&names.length<5){names.push(String(cursor.name??''));cursor=cursor.parent;}
  const cargoAnchor=names.find(n=>/ship container|stored delivery|container detail/i.test(n));
  const truckAnchor=names.find(n=>/forklift|fork carriage|truck/i.test(n));
  const craneAnchor=names.find(n=>/crane|boom|hook|sling|cable|hydraulic|winch|spreader/i.test(n));
  if(cargoAnchor)return {owner:`cargo:${cargoAnchor}`,category:'cargo',ignore:[]};
  if(truckAnchor)return {owner:`truck:${truckAnchor}`,category:'truck',ignore:[]};
  if(craneAnchor)return {owner:`crane:${craneAnchor}`,category:'crane',ignore:[]};
  return undefined;
}
function corners(mesh:AbstractMesh):Box3{
  const matrix=mesh.computeWorldMatrix(true),box=mesh.getBoundingInfo().boundingBox;
  // 0 -> 1/2/4 must be the three independent box edges for SAT.
  return Array.from({length:8},(_,i)=>Vector3.TransformCoordinates(new Vector3(i&1?box.maximum.x:box.minimum.x,i&2?box.maximum.y:box.minimum.y,i&4?box.maximum.z:box.minimum.z),matrix));
}
/** Continuous diagnostics use real enabled scene meshes, including export motion.
 * Envelopes are conservative: a contact is a candidate until mesh-level review.
 * This monitor never edits economy state or silently pauses a delivery.
 */
export function installSceneCollision3d(scene:Scene){
  const world=new ContinuousCollisionWorld();
  const history:Array<Contact3&{frame:number;names:string[]}>=[];
  const button=document.createElement('button');button.textContent='3D collision';
  const panel=document.createElement('pre');panel.className='collision-report';panel.hidden=true;panel.style.maxHeight='50vh';panel.style.overflow='auto';
  document.querySelector('.controls')?.append(button);document.querySelector('#interface')?.append(panel);
  let lastPaint=0,enabled=false,registered=0;
  const render=()=>{panel.textContent=`Continuous 3D check · ${world.frames} frames · ${registered} bounding boxes · ${world.pairChecks} pairs\n${history.length?'Most recent bounding-box contacts (valid mechanical contacts need review):':'No contacts recorded between registered bounding boxes.'}\n`+history.slice(-24).reverse().map(h=>`${h.names.join(' ↔ ')} · frames ${h.frame} · t=${h.fraction.toFixed(3)}${h.uncertain?' · trong dung sai':''}`).join('\n')+'\nLimitations: bounding boxes oriented; linear vertex interpolation between frames; not triangle-mesh collision or soft-body dynamics.';};
  button.onclick=()=>{panel.hidden=!panel.hidden;enabled=!panel.hidden;world.reset();render();};panel.onclick=()=>{panel.hidden=true;enabled=false;};
  const observer=scene.onAfterRenderObservable.add(()=>{
    if(!enabled)return;
    const records=scene.meshes.filter(m=>m.isEnabled()&&m.getTotalVertices()>0&&m.isVisible&&m.visibility>0&&!['trim','label'].includes(m.metadata?.smoothCargo)).flatMap(mesh=>{const tag=registration(mesh);return tag?[{mesh,tag,id:String(mesh.uniqueId)}]:[];});registered=records.length;
    const lookup=new Map(records.map(r=>[r.id,r]));
    const contacts=world.step(records.map(r=>({id:r.id,owner:r.tag.owner,corners:corners(r.mesh)})),(a,b)=>{
      const x=lookup.get(a)!,y=lookup.get(b)!;
      return x.tag.category==='structure'&&y.tag.category==='structure'||x.tag.ignore.includes(y.tag.owner)||y.tag.ignore.includes(x.tag.owner);
    });
    const owners=new Set<string>();
    for(const hit of contacts){const x=lookup.get(hit.a)!,y=lookup.get(hit.b)!;const key=[x.tag.owner,y.tag.owner].sort().join('|');if(owners.has(key))continue;owners.add(key);
      const previous=history.at(-1);if(previous?.names[0]===x.tag.owner&&previous.names[1]===y.tag.owner&&world.frames-previous.frame<30)continue;
      history.push({...hit,frame:world.frames,names:[x.tag.owner,y.tag.owner]});if(history.length>128)history.shift();
    }
    if(!panel.hidden&&performance.now()-lastPaint>300){lastPaint=performance.now();render();}
  });
  const api={getReport:()=>({frames:world.frames,registered,pairChecks:world.pairChecks,contacts:history.map(h=>({...h}))}),reset:()=>{world.reset();history.length=0;},setEnabled:(value:boolean)=>{enabled=value;world.reset();},dispose:()=>{scene.onAfterRenderObservable.remove(observer);button.remove();panel.remove();}};
  scene.onDisposeObservable.addOnce(()=>api.dispose());return api;
}
