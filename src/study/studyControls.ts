import { ArcRotateCamera, PointerEventTypes, Scene, TransformNode, Vector3 } from '@babylonjs/core';

export function studyControls(scene:Scene,camera:ArcRotateCamera,vesselRoots:TransformNode[],incoming:TransformNode,moveCamera?:(point:Vector3)=>void){
  const controls=document.querySelector('.controls')!;
  const views=document.createElement('details');views.className='view-menu';
  const summary=document.createElement('summary');summary.textContent='View';views.append(summary);
  const options=document.createElement('div');views.append(options);
  const names=['Operations','Full harbor','Concept view','Vessel close-up','Crane rig','Harbor layout','Rocky shore & trees','Vessel bow','Vessel stern','Cabin','Concrete apron','Save image'];
  for(const button of Array.from(controls.querySelectorAll('button')))if(names.includes(button.textContent??''))options.append(button);
  controls.append(views);
  const help=document.createElement('details');help.className='view-menu';help.innerHTML='<summary>Guide</summary><div class="control-help">Start voyage: use the selected berth and process the actual container count; the vessel departs after the final container is delivered. Run full shift automatically accepts voyages until the yard is full. Container delivery: choose Inland delivery to load a tractor truck through the gate, or Sea transfer to load a vessel on the same chain. Stop accepting new voyages and let the current voyage finish. Pause motion freezes the overview. Select a vessel or berth to inspect; Yard management shows each slot. Container batches and export demand come from Nansen; open Nansen source to view refresh status. NS is the in-game score.</div>';controls.append(help);
  const selection=document.createElement('div');selection.className='scene-selection';selection.setAttribute('role','status');selection.textContent='MV Coral · Choose a berth before starting the voyage';document.querySelector('#interface')!.append(selection);
  function focus(point:Vector3,text:string){if(moveCamera)moveCamera(point);else{camera.setTarget(point);camera.radius=28;camera.beta=.85;}selection.textContent=text;}
  function selectVessel(root:TransformNode){focus(root.getAbsolutePosition().add(new Vector3(0,2,0)),root===incoming?'Vessel waiting outside the bay · no handling route yet':'MV Coral · Choose a berth in the controls');}
  const targets=[new Vector3(-10,2,7),new Vector3(0,2,6),new Vector3(13,2,7)];
  function selectBerth(i:number){focus(targets[i],'Berth 0'+(i+1)+' · choose Call at in the controls before starting the voyage');}
  const berthButtons=document.createElement('div');berthButtons.className='berth-buttons';
  for(let i=0;i<3;i++){const b=document.createElement('button');b.textContent='Berth 0'+(i+1);b.onclick=()=>selectBerth(i);berthButtons.append(b);}
  options.append(berthButtons);
  scene.onPointerObservable.add(info=>{
    if(info.type!==PointerEventTypes.POINTERPICK||!info.pickInfo?.hit)return;
    let node=info.pickInfo.pickedMesh?.parent;
    while(node){if(node===incoming||vesselRoots.includes(node as TransformNode)){selectVessel(node as TransformNode);return;}node=node.parent;}
    const p=info.pickInfo.pickedPoint;
    if(p&&p.y>1&&p.z<=0&&p.z>-48&&p.x>-15&&p.x<15){let root:any=info.pickInfo.pickedMesh;while(root){if(root.name==='Three berth harbor infrastructure'||root.name.startsWith('Purchased yard row')){focus(new Vector3(p.x,2.4,p.z),'Harbor area · drag to orbit, scroll to zoom');return;}root=root.parent;}}
    if(p&&p.x>-40&&p.x<40&&p.z>0&&p.z<13&&p.y>1&&p.y<1.8){const index=targets.map((v,i)=>({i,d:Vector3.DistanceSquared(p,v)})).sort((a,b)=>a.d-b.d)[0].i;selectBerth(index);}
  });
}

