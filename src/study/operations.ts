import {gameIcon} from './gameIcons';
import {arrivalDirector, type ArrivalPort} from './arrivalFlow';
import {createInlandExport} from './inlandExport';
import {createSeaExport,type SeaExport} from './seaExport';
import { PortWorld, toPortPose, toWorldPose, type PortId } from './portWorld';
import { markCollision } from './sceneCollision3d';
import { mountOperationSummary } from './operationSummary';
import { mountTripHistory, type RecordedTrip } from './tripHistory';
import { connectHarborSession, HarborRequestError, type HarborSession, type HarborManifest } from './harborSession';
import { buildResourceSchedule, sampleResourceJob, resourceTelemetry, type ResourceJob, type ResourceSchedule, type ResourceReservation } from './resourceSchedule';
import { fetchCargoFeed } from './cargoFeed';
import { priorityForToken } from './nansenOperations';
import { CHAINS, isHarborChain, canonicalChain, tokenIdentity, hasNansenProvenance } from './chains';
import { createEconomy, PORTS, type EquipmentId } from './economy';
import { mountShop } from './shop';
import { paintCargo } from './cargoIdentity';
import { auditShipRoutes, auditTruckRoute } from './routeAudit';
import { ShipTraffic, BERTH_POSES, WAIT_SECONDS, WAITING_POSES } from './shipNavigation';
import { AbstractMesh, Color3, Matrix, Mesh, MeshBuilder, PointerEventTypes, PBRMaterial, Quaternion, Scene, TransformNode, Vector3, VertexData } from '@babylonjs/core';
import { Shapes } from '../geometry';
import { yardPanel } from './yardPanel';

const ease=(t:number)=>{t=Math.max(0,Math.min(1,t));return t*t*(3-2*t);};
const lerp=(a:number,b:number,t:number)=>a+(b-a)*ease(t);
const mix=(a:Vector3,b:Vector3,t:number)=>Vector3.Lerp(a,b,ease(t));

/** Local deterministic handling sequence. Each manifest container passes between all machines. */
export function harborOperations(scene:Scene,loaded:{meshes:AbstractMesh[];transformNodes:TransformNode[]},options:{portId?:PortId;world?:PortWorld;uiRoot?:ParentNode}={}){
  const uiRoot=options.uiRoot??document,portId=options.portId??'coral';
  const world=options.world??new PortWorld();
  const localMatrix=(node:TransformNode)=>{const matrix=node.computeWorldMatrix(true).clone();let root=node.parent;while(root){if(root.metadata?.portRoot)return matrix.multiply(Matrix.Invert((root as TransformNode).computeWorldMatrix(true)));root=root.parent;}return matrix;};
  const before=new Set(scene.meshes),g=new Shapes(scene);
  const economy=createEconomy();
  let session:HarborSession|undefined,claiming=false,settling=false,settlementRetryAt=0;
  const shipManifests:(HarborManifest|undefined)[]=CHAINS.map(()=>undefined);
  let demands:import('./cargoFeed').HarborDemand[]=[];
  const reportError=(e:unknown)=>{penaltyNotice=e instanceof Error?e.message:'Could not save progress; try again.';};
  let recordedTrips:RecordedTrip[]=[],savingCheckpoint=false,nextCheckpoint=0;
  const history=mountTripHistory(trips=>{recordedTrips=trips;nextCheckpoint=0;},uiRoot);
  window.addEventListener('harbor-open-record',event=>{const detail=(event as CustomEvent<{portId:string;recordId:string}>).detail;if(detail.portId===portId)history.open(detail.recordId);});
  const operationSummary=mountOperationSummary(()=>session?.state.operational,uiRoot);
  let yardFullSeconds=0;
  let rawClock=0,pausedSeconds=0,tripWaitSeconds=0,exportPreparing=false;
  let selectedUnitId:string|undefined;
  let capacity=PORTS[economy.state.portIndex].capacity;
  const feedButton=document.createElement('button');feedButton.textContent='Nansen source';uiRoot.querySelector('.controls')!.append(feedButton);
  const feedStatus=document.createElement('p');feedStatus.style.cssText='position:absolute;left:34px;top:210px;max-width:380px;background:#173c42;color:#fff;padding:10px;pointer-events:auto';feedStatus.hidden=true;uiRoot.querySelector('#interface')!.append(feedStatus);
  const priorityBoard=document.createElement('p');priorityBoard.style.cssText='position:absolute;left:34px;top:290px;max-width:380px;background:#173c42;color:#fff;padding:10px;pointer-events:none;font-size:12px';uiRoot.querySelector('#interface')!.append(priorityBoard);
  let loadingCargo=false;
  let feedState:'live'|'stale'|'unavailable'='unavailable';
  let chainFeedStatus:Record<string,string>={};
  const cargoCounts=CHAINS.map(()=>0),cargoIds:string[][]=CHAINS.map(()=>[]);
  const traffic=world.createTraffic(portId);
  function syncCapacity(){world.setCapacity(portId,{enabled:!!session,freeSlots:capacity-(session?.state.inventory.length??0)-(session?.state.manifests.filter(m=>m.status==='claimed').reduce((n,m)=>n+m.units.length,0)??0),queueLength:0});}
  let navigationClock=0,serviceAt=-1,departureRequested=false;
  const restoredDepartures=new Set<number>();
  const lossRecorded=CHAINS.map(()=>false),penaltyPending=CHAINS.map(()=>false),penaltyRetryAt=CHAINS.map(()=>0);
  const timeoutRetryAt=CHAINS.map(()=>0);
  let nextArrivalAt=0,arrivalCursor=0,arrivalRetryAt=0,nextServiceTryAt=0;
  // Serialize Nansen arrival claims so the player receives one berth decision at a time.
  let schedulingArrival=false;
  const pendingBatches:import('./cargoFeed').CargoBatch[]=[];
  const seenBatches=new Set<string>();
  let nextPollAt=0;
  let arrivalBlocked='';
  const freeArrivalSlots=()=>Math.max(0,capacity-(session?.state.inventory.length??0)-(session?.state.manifests.filter(m=>m.status==='claimed').reduce((n,m)=>n+m.units.length,0)??0));
  async function fillShip(index:number){
    if(!session||claiming||arrivalLocked||dispatch||exportBatch)return;
    if(cargoCounts[index]||!['empty','gone'].includes(traffic.ships[index].phase)||index===activeShip&&start>=0)return;
    if(last<nextArrivalAt)return;
    const chain=CHAINS[index].id;
    const selected:import('./cargoFeed').CargoBatch[]=[];let count=0;
    for(const batch of pendingBatches){
      const size=batch.tokens.reduce((n,t)=>n+t.count,0);
      if(world.batchAvailable(batch.id,portId)&&batch.chain===chain&&(!shipManifests[index]||shipManifests[index]!.batchIds.includes(batch.id))&&size>0&&count+size<=8){selected.push(batch);count+=size;}
    }
    if(!count)return;
    syncCapacity();
    if(!shipManifests[index]&&world.choosePort(count,index,true)!==portId){arrivalBlocked='Assigning vessels between harbors';return;}
    if(!world.reserveBatches(selected.map(b=>b.id),portId))return;
    arrivalBlocked='';
    claiming=true;
    try{
    let saved=shipManifests[index];
    if(!saved){saved=(await session.claim(selected.map(b=>b.id))).manifest;shipManifests[index]=saved;if(saved)world.recordAssignment(portId);}
    if(!saved||!traffic.spawn(index))return;
    syncCapacity();
    count=saved.units.length;
    nextArrivalAt=last+4/Math.max(.5,Math.min(2,selected[0]?.intensity?.multiplier??1));
    const slots=[...ships[index].cargo.slice(0,Math.max(0,count-4)),...ships[index].cargo.slice(4,4+Math.min(4,count))];
    saved.units.forEach((unit,cursor)=>{const root=slots[cursor].mesh;paintCargo(scene,root,unit);root.metadata={...(root.metadata??{}),batchId:unit.batchId,eventAt:unit.eventAt??saved.createdAt,unitId:unit.id};});
    for(const id of saved.batchIds){seenBatches.add(id);const offset=pendingBatches.findIndex(b=>b.id===id);if(offset>=0)pendingBatches.splice(offset,1);}
    cargoCounts[index]=count;cargoIds[index]=saved.batchIds;
    ships[index].cargo.forEach(item=>item.mesh.setEnabled(slots.includes(item)));
    lossRecorded[index]=false;
    if(index===activeShip)plan();
    }catch(e){world.releaseBatches(selected.map(b=>b.id),portId);reportError(e);try{await session.refresh();shipManifests[index]=session.state.manifests.find(m=>m.status==='claimed'&&m.units[0]?.chain===chain);for(const id of session.state.claimedBatchIds){seenBatches.add(id);if(!shipManifests[index]?.batchIds.includes(id)){const at=pendingBatches.findIndex(b=>b.id===id);if(at>=0)pendingBatches.splice(at,1);}}}catch{}}finally{claiming=false;}
  }
  async function loadLiveCargo(){
    if(loadingCargo)return;loadingCargo=true;feedButton.disabled=true;
    try{
      const lowChains=CHAINS.filter(c=>pendingBatches.filter(b=>b.chain===c.id&&!seenBatches.has(b.id)).reduce((n,b)=>n+b.tokens.reduce((sum,t)=>sum+t.count,0),0)<24).map(c=>c.id);
      const result=await fetchCargoFeed(undefined,lowChains);feedState=result.status;chainFeedStatus=result.chainStatus??{};demands=result.demands??[];refreshDemands();
      if(result.status==='live'||result.status==='stale')for(const batch of result.batches){
        if(!batch.id||!isHarborChain(batch.chain)||seenBatches.has(batch.id)||pendingBatches.some(b=>b.id===batch.id))continue;
        const valid=Array.isArray(batch.tokens)&&batch.tokens.length>0&&batch.tokens.every(t=>typeof t.address==='string'&&!!t.address&&typeof t.symbol==='string'&&Number.isInteger(t.count)&&t.count>0&&t.count<=8);
        if(valid&&batch.tokens.reduce((n,t)=>n+t.count,0)<=8&&pendingBatches.length<500)pendingBatches.push(batch);
      }
      // Already assigned manifests remain immutable, including during outages.
      void scheduleArrivals();
      const evidenceDemand=result.demands?.find(d=>d.flowEvidence);
      const evidence=evidenceDemand?.flowEvidence;
      const flowSummary=evidence
        ? `Flow ${result.flowStatus??'unavailable'} · locked evidence for ${evidenceDemand!.chain}/${evidenceDemand!.tokenSymbol}, read ${evidence.observedAt}, order ${evidenceDemand!.id}: pressure ${evidence.pressure>=0?'+':''}${(evidence.pressure*100).toFixed(0)}% · multiplier ${evidence.quantityMultiplier.toFixed(2)} · bonus adjustment ${evidence.premiumAdjustmentBps>=0?'+':''}${evidence.premiumAdjustmentBps}bps`
        : `Flow Intelligence ${result.flowStatus??'unavailable'}`;
      const coverage=result.coverage
        ? ` · API ${result.coverage.requestsReservedThisHour}/${result.coverage.maxRequestsPerHour} · backlog ${result.coverage.backlog}`
        : '';
      const age=result.fetchedAt?`Cargo data updated ${Math.max(0,Math.floor((Date.now()-Date.parse(result.fetchedAt))/60000))} minutes ago`:'No successful refresh yet';
      feedStatus.textContent=`Nansen ${result.status} · ${age} · ${flowSummary}${coverage} · ${CHAINS.map((c,i)=>c.name+' '+cargoCounts[i]+' containers').join(' · ')} · ${pendingBatches.length} pending batches. ${result.message??''}`;
    }catch{feedState='unavailable';feedStatus.textContent='Could not read Nansen data. Waiting for refresh; no sample containers.';}finally{loadingCargo=false;feedButton.disabled=false;nextPollAt=last+60;}
  }
  feedButton.onclick=()=>{feedStatus.hidden=!feedStatus.hidden;if(last>=nextPollAt)void loadLiveCargo();};
  async function scheduleArrivals(){
    if(!session||claiming||schedulingArrival||last<nextArrivalAt||last<arrivalRetryAt)return;
    schedulingArrival=true;arrivalRetryAt=last+1;arrivalBlocked='';
    try{
      for(let n=0;n<CHAINS.length;n++){
        const index=(arrivalCursor+n)%CHAINS.length;
        const before=cargoCounts[index];
        await fillShip(index);
        if(cargoCounts[index]!==before||claiming){arrivalCursor=(index+1)%CHAINS.length;break;}
      }
    }finally{schedulingArrival=false;}
  }

  const sessionId=crypto.randomUUID();
  let receiptSequence=0,receiptId=sessionId+':0',penaltyNotice='';
  const roots=[...loaded.meshes,...loaded.transformNodes];
  const mat=(name:string,hex:string)=>{const old=scene.materials.find(m=>m.name.split('::')[0]===name&&(!m.metadata?.portId||m.metadata.portId===portId));if(old)return old;const m=new PBRMaterial(name,scene);m.albedoColor=Color3.FromHexString(hex);m.roughness=.8;return m;};
  const orange=mat('Crane coral enamel','#c36a42'),steel=mat('Weathered dark metal','#3e5051'),yellow=mat('Handling equipment ochre','#cba14d'),ivory=mat('Warm ivory enamel','#e2dcc7'),rubber=mat('Aged black rubber','#233333'),skin=mat('Worker skin','#b08060'),blue=mat('Worker navy clothing','#344954');
  const descendants=(name:string)=>loaded.meshes.filter(m=>{let n:any=m;while(n){if(n.name===name)return true;n=n.parent;}return false;});
  let vesselRoots=roots.filter(n=>n.name==='vessel'||n.name==='vessel-details');
  // Offset the entire berth seaward, normal to the diagonal hull, including all detail roots.
  // Cargo pickup matrices and the arrival/departure path derive from this same pose.
  let shipAngle=-1.07;const berthSetback=3.2;
  const berthOrigin=new Vector3(-17.4,0,4.2).add(new Vector3(Math.sin(shipAngle),0,Math.cos(shipAngle)).scale(berthSetback));
  for(const n of vesselRoots){n.position.copyFrom(berthOrigin);n.rotationQuaternion=Quaternion.RotationYawPitchRoll(shipAngle,0,0).multiply(n.rotationQuaternion??Quaternion.FromEulerVector(n.rotation));n.rotation.set(0,0,0);n.computeWorldMatrix(true);}
  for(const name of ['crane','crane-details','hoist']){
    const n=roots.find(n=>n.name===name);if(n){n.position.set(-10.8,0,7.3);n.computeWorldMatrix(true);if(name==='hoist')n.setEnabled(false);}
  }
  function extract(source:AbstractMesh,predicate:(v:Vector3[])=>boolean,name:string,parent:TransformNode,origin:Vector3,remove=true){
    if(!(source instanceof Mesh)||!source.getTotalVertices())return;
    source.makeGeometryUnique();
    const ix=source.getIndices(),p=source.getVerticesData('position');if(!p||!ix)return;
    const world=source.computeWorldMatrix(true),selected:number[]=[],remain:number[]=[];
    for(let i=0;i<ix.length;i+=3){const tri=[ix[i],ix[i+1],ix[i+2]];const points=tri.map(j=>Vector3.TransformCoordinates(Vector3.FromArray(p,j*3),world));(predicate(points)?selected:remain).push(...tri);}
    if(!selected.length)return;
    // Retain only vertices referenced by this extracted part, never the full GLB buffer.
    const remap=new Map<number,number>(),vertices:number[]=[],indices:number[]=[];
    for(const index of selected){let mapped=remap.get(index);if(mapped===undefined){mapped=vertices.length;vertices.push(index);remap.set(index,mapped);}indices.push(mapped);}
    const out=new Mesh(name,scene),data=new VertexData();data.indices=indices;
    data.positions=new Float32Array(vertices.length*3);
    for(let i=0;i<vertices.length;i++){const v=Vector3.TransformCoordinates(Vector3.FromArray(p,vertices[i]*3),world).subtract(origin);v.toArray(data.positions,i*3);}
    const normals=source.getVerticesData('normal');if(normals){data.normals=new Float32Array(vertices.length*3);for(let i=0;i<vertices.length;i++)Vector3.TransformNormal(Vector3.FromArray(normals,vertices[i]*3),world).normalize().toArray(data.normals,i*3);}
    for(const [kind,field,stride] of [['uv','uvs',2],['uv2','uvs2',2],['color','colors',4]] as const){const values=source.getVerticesData(kind);if(values){const compact=new Float32Array(vertices.length*stride);for(let i=0;i<vertices.length;i++)for(let k=0;k<stride;k++)compact[i*stride+k]=values[vertices[i]*stride+k];data[field]=compact;}}
    data.applyToMesh(out);out.material=source.material;out.sideOrientation=source.sideOrientation;out.parent=parent;out.receiveShadows=true;if(remove)source.setIndices(remain);return out;
  }
  const base=new Vector3(-10.8,3.38,1),slew=new TransformNode('Crane slewing upperworks',scene);slew.position.copyFrom(base);
  // Coordinates below are authored Blender pivots converted to Babylon (x,z,-y), relative to the slew bearing.
  const foot=new Vector3(-.4,.75,0),knee=new Vector3(-1.1,7.17,1.9),tip=new Vector3(3.6,5.82,3.75);
  const boomFoot=new TransformNode('Original boom foot joint',scene);boomFoot.parent=slew;boomFoot.position.copyFrom(foot);
  const boomElbow=new TransformNode('Original boom elbow joint',scene);boomElbow.parent=boomFoot;boomElbow.position.copyFrom(knee.subtract(foot));
  const pointSegmentDistance=(p:Vector3,a:Vector3,b:Vector3)=>{const ab=b.subtract(a),u=Math.max(0,Math.min(1,Vector3.Dot(p.subtract(a),ab)/ab.lengthSquared()));return Vector3.Distance(p,a.add(ab.scale(u)));};
  const oldLines:[Vector3,Vector3,number][]=[];
  for(const dx of [-.23,.23]){
    oldLines.push([new Vector3(-.4+dx,.97,.12),new Vector3(-.4+dx,3.63,1.37),.13]);
    oldLines.push([new Vector3(-.4+dx,3.63,1.37),new Vector3(-.4+dx,4.82,1.71),.095]);
    oldLines.push([new Vector3(1.24+dx,.88,0),knee.add(new Vector3(dx,0,0)),.055]);
  }
  for(const mesh of [...descendants('crane'),...descendants('crane-details')]){
    const metal=/metal|hardware/i.test(mesh.material?.name??'');
    if(metal){const obsolete=extract(mesh,v=>v.every(p=>oldLines.some(([a,b,r])=>pointSegmentDistance(p.subtract(base),a,b)<r)),'Retired disconnected ram and support wire',slew,base);obsolete?.dispose();}
    const center=(v:Vector3[])=>v[0].add(v[1]).add(v[2]).scale(1/3).subtract(base);
    extract(mesh,v=>{const c=center(v);return pointSegmentDistance(c,knee,tip)<.68&&pointSegmentDistance(c,knee,tip)<=pointSegmentDistance(c,foot,knee);},'Crane outer jib',boomElbow,base.add(knee));
    extract(mesh,v=>{const c=center(v);return c.y>1.1&&pointSegmentDistance(c,foot,knee)<.85;},'Crane inner boom',boomFoot,base.add(foot));
    extract(mesh,v=>v.every(p=>p.y>3.38),'Crane upperworks housing',slew,base);
  }
  const shipMatrix=vesselRoots[0].computeWorldMatrix(true);
  const inv=Matrix.Invert(shipMatrix);
  const vesselMotion={position:berthOrigin.clone(),forward:new Vector3(Math.cos(shipAngle),0,-Math.sin(shipAngle)),speed:0,visibility:1,angle:0,home:berthOrigin.clone()};
  const vesselOffset=Vector3.Zero(),forward=new Vector3(Math.cos(shipAngle),0,-Math.sin(shipAngle));
  const berthPositions=vesselRoots.map(root=>root.position.clone());
  const homeRotations=vesselRoots.map(root=>root.rotationQuaternion!.clone());
  const homeOrigin=berthOrigin.clone(),homeAngle=shipAngle;
  let manifest:{mesh:TransformNode,pickup:Vector3}[]=[];
  for(const x of [3.45,-1.25])for(const z of [-1.03,1.03]){
    const origin=Vector3.TransformCoordinates(new Vector3(x,1.83,z),shipMatrix),cargo=new TransformNode('Ship container '+manifest.length,scene);cargo.position.copyFrom(origin);cargo.rotation.y=shipAngle;
    for(const mesh of descendants('vessel')){
      const out=extract(mesh,v=>v.every(p=>{const q=Vector3.TransformCoordinates(p,inv);return q.x>x-2.4&&q.x<x+2.53&&Math.abs(q.z-z)<1.10&&q.y>1.79&&q.y<4.05;}),'Container detail',cargo,origin);
      if(out){const data=VertexData.ExtractFromMesh(out,true,true),undo=Matrix.RotationY(-shipAngle);for(const key of ['positions','normals'] as const){const values=data[key];if(values)for(let i=0;i<values.length;i+=3){const q=Vector3.TransformNormal(Vector3.FromArray(values,i),undo);values[i]=q.x;values[i+1]=q.y;values[i+2]=q.z;}}data.applyToMesh(out);}
    }
    const token={chain:'bnb' as const,address:'native',symbol:'BNB'};paintCargo(scene,cargo,token);cargo.metadata={token};
    manifest.push({mesh:cargo,pickup:origin});
  }
  const top=manifest.map((item,i)=>{const mesh=item.mesh.clone('Ship upper container '+i,null)!;const pickup=item.pickup.add(new Vector3(0,2.05,0));mesh.position.copyFrom(pickup);return {mesh,pickup};});
  manifest.unshift(...top); // Always unload the upper layer first: 8 containers maximum.
  const homePickups=manifest.map(item=>item.pickup.clone());
  const ships=CHAINS.map((chain,index)=>({name:chain.name,
    roots:index===0?vesselRoots:vesselRoots.map(root=>root.clone(root.name+' '+chain.id,null)!),
    cargo:index===0?manifest:manifest.map((item,i)=>({mesh:item.mesh.clone(chain.name+' cargo '+i,null)!,pickup:item.pickup.clone()})),
    trips:0,delivered:0,
  }));
  ships.forEach(ship=>ship.cargo.forEach(item=>item.mesh.setEnabled(false)));
  let activeShip=0,tripRecorded=false;
  const schedule=document.createElement('div');schedule.className='fleet-schedule';uiRoot.querySelector('#interface')!.append(schedule);
  const shipSelect=document.createElement('select');shipSelect.setAttribute('aria-label','Choose service vessel');
  ships.forEach((ship,i)=>{const option=document.createElement('option');option.value=String(i);option.textContent=ship.name;shipSelect.append(option);});
  uiRoot.querySelector('.controls')!.prepend(shipSelect);
  const fadeShip=(ship:typeof ships[number],opacity:number)=>{
    ship.roots.forEach(root=>root.getChildMeshes().forEach(mesh=>mesh.visibility=opacity));
  };
  const truck=new TransformNode('Container forklift',scene),wheels:TransformNode[]=[];
  g.box('Heavy forklift chassis',0,2.05,0,2.05,.8,3.7,yellow,truck,.16);
  g.box('Counterweight',0,2.5,-1.25,2.1,1.15,.95,yellow,truck,.2);
  for(const x of [-1.04,1.04])for(const z of [-1.2,1.15]){
    const axle=new TransformNode('Fixed wheel axle',scene);axle.parent=truck;axle.position.set(x,1.97,z);
    const roll=new TransformNode('Wheel rolling around local X',scene);roll.parent=axle;wheels.push(roll);
    const w=g.cylinder('Driven forklift wheel',0,0,0,.5,.3,rubber,roll);w.rotation.z=Math.PI/2;
    const hub=g.cylinder('Wheel hub',Math.sign(x)*.16,0,0,.24,.035,steel,roll);hub.rotation.z=Math.PI/2;
    for(let k=0;k<6;k++){const a=k*Math.PI/3;g.sphere('Wheel lug',Math.sign(x)*.19,Math.cos(a)*.16,Math.sin(a)*.16,.025,.025,.025,ivory,roll);}
  }
  for(const x of [-.78,.78]){
    g.beam('Heavy lift mast',new Vector3(x,1.65,1.6),new Vector3(x,4.55,1.6),.1,steel,truck);
    g.beam('Cab guard pillar',new Vector3(x,2.4,-.65),new Vector3(x,4.35,-.65),.055,steel,truck);
  }
  g.box('Operator canopy',0,4.37,-.35,1.85,.14,1.6,yellow,truck,.07);
  g.box('Driver seat',0,2.72,-.4,.7,.2,.6,rubber,truck,.08);
  const fork=new TransformNode('Fork carriage',scene);fork.parent=truck;
  for(const x of [-.72,.72])g.box('Container fork',x,2.15,3,.18,.13,3,steel,fork,.015);
  g.box('Fork backplate',0,2.7,1.7,1.85,1.1,.14,steel,fork,.025);
  // A slewing pedestal crane beside the warehouse replaces the overhead gantry.
  const yardBase=new Vector3(14,3.38,-13),yardFixed=new TransformNode('Warehouse crane pedestal',scene),yardSlew=new TransformNode('Warehouse crane rotating upperworks',scene);
  yardFixed.position.copyFrom(yardBase);yardSlew.position.copyFrom(yardBase);
  for(const source of [...descendants('crane'),...descendants('crane-details')])extract(source,()=>true,'Warehouse crane foundation',yardFixed,base,false);
  // Preserve the joint hierarchy when duplicating the working crane.
  const yardFoot=boomFoot.clone('Warehouse foot joint',yardSlew)!;
  const yardElbow=yardFoot.getChildTransformNodes(true).find(n=>n.name.includes('elbow'))!;
  for(const source of slew.getChildMeshes(true))if(source instanceof Mesh){const copy=source.clone('Warehouse crane housing',yardSlew);copy.parent=yardSlew;}
  const berthCranePositions=[base.clone(),new Vector3(-.4,3.38,5.3),new Vector3(13,3.38,6)];
  const extraDockRigs=berthCranePositions.slice(1).map((position,i)=>{
    const foundation=new TransformNode('Berth '+(i+2)+' fixed foundation',scene);foundation.position.copyFrom(position);
    for(const source of [...descendants('crane'),...descendants('crane-details')])extract(source,()=>true,'Berth foundation detail',foundation,base,false);
    const body=slew.clone('Berth '+(i+2)+' rotating upperworks',null)!;body.position.copyFrom(position);
    const arm=body.getChildTransformNodes(true).find(n=>n.name.includes('foot joint'))!;
    const elbow=arm.getChildTransformNodes(true).find(n=>n.name.includes('elbow joint'))!;
    return {body,arm,elbow};
  });
  const dockSpreader=new TransformNode('Dock hook and four lifting slings',scene),yardSpreader=new TransformNode('Warehouse hook and four lifting slings',scene);
  const secondYardFixed=yardFixed.clone('Second yard crane foundation',null)!;secondYardFixed.position.set(14,3.38,-10);
  const secondYardBody=yardSlew.clone('Second yard crane upperworks',null)!;secondYardBody.position.copyFrom(secondYardFixed.position);
  const secondYardArm=secondYardBody.getChildTransformNodes(true).find(n=>n.name.includes('foot joint'))!;
  const secondYardElbow=secondYardArm.getChildTransformNodes(true).find(n=>n.name.includes('elbow'))!;
  const hooks=[dockSpreader,yardSpreader,new TransformNode('Berth 02 hook',scene),new TransformNode('Berth 03 hook',scene),new TransformNode('Second yard crane hook',scene)];
  const slingSets:{root:TransformNode,lines:Mesh[],ends:Mesh[]}[]=[];
  for(const r of hooks){
    const lines:Mesh[]=[],ends:Mesh[]=[];slingSets.push({root:r,lines,ends});
    g.box('Steel hook block',0,1.39,0,.25,.26,.2,steel,r,.06);
    const hook=MeshBuilder.CreateTube('Open forged lifting hook',{path:Array.from({length:19},(_,i)=>{const a=-.3+i/18*Math.PI*1.7;return new Vector3(Math.cos(a)*.13,1.17+Math.sin(a)*.13,0);}),radius:.043,tessellation:10,cap:Mesh.CAP_ALL},scene);hook.material=steel;hook.parent=r;
    for(const x of [-2.18,2.18])for(const z of [-.9,.9]){
      const line=MeshBuilder.CreateCylinder('Flexible lifting sling',{diameter:.045,height:1,tessellation:8},scene);line.material=steel;line.parent=r;lines.push(line);
      ends.push(g.box('Corner lifting shackle',x,.045,z,.12,.1,.1,steel,r,.025));
    }
  }
  const ropes:Mesh[]=[];
  for(let i=0;i<hooks.length*2;i++)ropes.push(MeshBuilder.CreateCylinder('Continuous boom to hook cable',{diameter:.035,height:1,tessellation:8},scene));
  for(const r of ropes)r.material=steel;
  function cable(m:Mesh,a:Vector3,b:Vector3){const d=b.subtract(a);m.position.copyFrom(a.add(b).scale(.5));m.scaling.y=d.length();m.rotationQuaternion=Quaternion.FromUnitVectorsToRef(Vector3.Up(),d.normalize(),new Quaternion());}
  const rigLinks=[{body:slew,arm:boomFoot,elbow:boomElbow},{body:yardSlew,arm:yardFoot,elbow:yardElbow},...extraDockRigs,{body:secondYardBody,arm:secondYardArm,elbow:secondYardElbow}].map(rig=>{
    const parts=Array.from({length:2},()=>({barrel:MeshBuilder.CreateCylinder('Pinned hydraulic barrel',{height:1,diameter:.19,tessellation:16},scene),rod:MeshBuilder.CreateCylinder('Sliding chrome piston',{height:1,diameter:.105,tessellation:16},scene),lower:g.sphere('Ram lower clevis',0,0,0,.14,.14,.14,steel),upper:g.sphere('Ram upper clevis',0,0,0,.14,.14,.14,steel)}));
    for(const p of parts){p.barrel.material=steel;p.rod.material=mat('Piston chrome','#b6c0bf');}
    const wire=Array.from({length:2},()=>MeshBuilder.CreateCylinder('Winch routed running cable',{height:1,diameter:.035,tessellation:8},scene));for(const w of wire)w.material=steel;
    return {...rig,parts,wire};
  });
  rigLinks.forEach((r,i)=>{for(const node of [r.body,r.arm,r.elbow,hooks[i],...r.wire,...r.parts.flatMap(p=>[p.barrel,p.rod,p.lower,p.upper]),...ropes.slice(i*2,i*2+2),slingSets[i].root])markCollision(node,portId+':crane:'+i,'crane');});
  function updateRigLinks(){for(const r of rigLinks){const body=localMatrix(r.body),arm=localMatrix(r.arm),elbow=localMatrix(r.elbow);
    r.parts.forEach((part,i)=>{const dx=i===0?-.47:.47;
      const lower=Vector3.TransformCoordinates(new Vector3(-.4+dx,.97,.12),body);
      const upper=Vector3.TransformCoordinates(knee.subtract(foot).scale(.66).add(new Vector3(dx,0,.12)),arm);
      const direction=upper.subtract(lower).normalize(),length=Math.min(2.55,Vector3.Distance(lower,upper)-.25),join=lower.add(direction.scale(length));cable(part.barrel,lower,join);cable(part.rod,lower.add(direction.scale(length-.18)),upper);part.lower.position.copyFrom(lower);part.upper.position.copyFrom(upper);
    });
    const spool=Vector3.TransformCoordinates(new Vector3(.8,1.29,.02),body),guide=Vector3.TransformCoordinates(new Vector3(.22,.22,-.12),elbow),end=rigTips[rigLinks.indexOf(r)].clone();
    cable(r.wire[0],spool,guide);cable(r.wire[1],guide,end);
  }}
  function worker(name:string,parent?:TransformNode){
    const r=new TransformNode(name,scene);r.parent=parent??null;
    g.box('Safety vest',0,.98,0,.38,.52,.25,orange,r,.05);
    g.sphere('Worker head',0,1.41,0,.13,.16,.13,skin,r);
    g.cylinder('Hard hat',0,1.56,0,.17,.1,yellow,r);
    const limbs:TransformNode[]=[];
    for(const side of [-1,1]){
      const arm=new TransformNode('Shoulder joint',scene);arm.parent=r;arm.position.set(side*.25,1.19,0);g.box('Worker arm',0,-.24,0,.12,.49,.12,blue,arm,.035);limbs.push(arm);
      const leg=new TransformNode('Hip joint',scene);leg.parent=r;leg.position.set(side*.11,.73,0);g.box('Trouser leg',0,-.3,0,.15,.6,.16,blue,leg,.03);g.box('Work boot',0,-.63,.055,.18,.13,.29,rubber,leg,.035);limbs.push(leg);
    }
    return {r,limbs};
  }
  const signal=worker('Dock signal worker');signal.r.position.set(-13,1.48,-1.5);
  const walking=worker('Yard worker');const driver=worker('Forklift driver',truck);driver.r.position.set(0,2.36,-.4);driver.r.scaling.setAll(.85);
  const yardWorker=worker('Yard banksman');yardWorker.r.position.set(14,1.48,-7.5);
  driver.limbs[0].rotation.x=driver.limbs[2].rotation.x=-.8;
    savePresentation();
  const forkliftFleet=[truck,...Array.from({length:7},(_,i)=>truck.clone('Forklift '+(i+2),null)!)];
  const fleet=forkliftFleet.map((root,i)=>({root,wheels:root.getChildTransformNodes().filter(n=>n.name.includes('Wheel rolling')),previous:Vector3.Zero(),angle:i%2===0?Math.PI/2:-Math.PI/2,garage:new Vector3(i%2===0?-11.4:-2.6,0,-15.7-Math.floor(i/2)*2.55)}));
  // Keep the forklift handoff inside the yard edge. The crane only lifts the final short gap.
  const receiving=new Vector3(-8.3,2.25,-3),yardPickup=new Vector3(11,2.25,-9);
  fleet.forEach((f,i)=>markCollision(f.root,portId+':truck:'+i,'truck'));
  ships.forEach(ship=>ship.cargo.forEach(c=>markCollision(c.mesh,portId+':cargo:'+c.mesh.uniqueId,'cargo')));
  const cells=Array.from({length:36},(_,i)=>({row:Math.floor(i/3),col:i%3,height:i<12?1+(Math.floor(i/3)+i%3)%2:0}));
  const slotAt=(cell:number,level:number)=>new Vector3(1.8+cell%3*4.6,1.48+level*2.05,-16-Math.floor(cell/3)*2.3);
  let jobs:{mesh:TransformNode,pickup:Vector3,slot:Vector3,cell:number,start:number,truck:number,timing:ResourceJob}[]=[];
  const status=document.createElement('div');status.className='operation-status';status.style.cssText='position:absolute;top:90px;left:34px;color:#fff4db;background:#173c42dd;padding:12px 16px;border-radius:8px;max-width:390px;font:13px sans-serif';uiRoot.querySelector('#interface')!.append(status);
  let start=-1,last=0,elapsed=0;
  const button=document.createElement('button');button.textContent='Start voyage';uiRoot.querySelector('.controls')!.prepend(button);
  const reset=document.createElement('button');reset.textContent='Reset voyage';uiRoot.querySelector('.controls')!.append(reset);
  let selectedBerth=0;
  const berthChoices=[
    {name:'01',origin:new Vector3(BERTH_POSES[0].x,0,BERTH_POSES[0].z),angle:BERTH_POSES[0].a,crane:base.clone(),receipt:new Vector3(-8.3,2.25,-3)},
    {name:'02',origin:new Vector3(6.5,0,10.5),angle:Math.PI/2,crane:new Vector3(-.4,3.38,5.3),receipt:new Vector3(-1.8,2.25,-3)},
    {name:'03',origin:new Vector3(BERTH_POSES[2].x,0,BERTH_POSES[2].z),angle:BERTH_POSES[2].a,crane:new Vector3(13,3.38,6),receipt:new Vector3(4.3,2.25,-3)}
  ];
  const berthSelect=document.createElement('select');berthSelect.setAttribute('aria-label','Choose receiving berth');
  berthChoices.forEach((berth,i)=>{const option=document.createElement('option');option.value=String(i);option.textContent='Call at '+berth.name;berthSelect.append(option);});
  uiRoot.querySelector('.controls')!.prepend(berthSelect);
  const approachDuration=4;
  let resourceSchedule=buildResourceSchedule(0,{portId,truckCount:4});
  let dispatchInterval=4; // The next truck exits as its predecessor starts receiving cargo.
  const arrivalDuration=3,departureDuration=10;let playbackRate=1;
  // Keep machine speed constant. Completion comes from the last actual job, never a padded timer.
  let handlingTicks=0,departureAt=arrivalDuration,tripDuration=arrivalDuration+departureDuration;
  const initialLevels=cells.map(()=>0),yardLevels=[...initialLevels];
  const initialOccupancy=initialLevels.reduce((a,b)=>a+b,0);
  // Allocate persistent meshes up front so water reflections and shadow lists include later deliveries.
  const storedCargo=Array.from({length:108},(_,i)=>{
    const root=manifest[i%manifest.length].mesh.clone('Stored delivery '+i,null)!;
    root.setEnabled(false);markCollision(root,portId+':cargo:'+root.uniqueId,'cargo');return root;
  });
  const inventory=yardPanel(scene,uiRoot);
  // Extra rows are real concrete storage plots, enabled only after a port purchase.
  const expansionRows=Array.from({length:8},(_,i)=>{const root=new TransformNode('Purchased yard row '+(i+5),scene);
    g.box('Expanded yard foundation',6.4,.36,-16-(i+4)*2.3,14.4,2.2,2.3,mat('Yard extension concrete','#afa997'),root);
    for(let col=0;col<3;col++)for(const dx of [-2.23,2.23])g.box('Storage boundary',1.8+col*4.6+dx,1.476,-16-(i+4)*2.3,.05,.012,2.15,yellow,root);
    return root;});
  type StoredRecord={mesh:TransformNode,slot:Vector3,cell:number,initial:boolean};
  const initialCargo:StoredRecord[]=scene.transformNodes.filter(n=>n.metadata?.yardCell!==undefined&&(!n.metadata.portId||n.metadata.portId===portId)).map(mesh=>{
    const cell=mesh.metadata.yardCell as number;mesh.setEnabled(false);
    paintCargo(scene,mesh,mesh.metadata.token??{chain:cell%2?'ethereum':'bnb',address:'native',symbol:cell%2?'ETH':'BNB'});
    return {mesh,cell,initial:true,slot:new Vector3(1.8+cell%3*4.6,1.48+mesh.metadata.level*2.05,-16-Math.floor(cell/3)*2.3)};
  });
  const storedRecords:StoredRecord[]=[],exported=new Set<TransformNode>();
  const inlandExport=createInlandExport(scene);
  let seaExport:SeaExport|undefined;
  let dispatch:{mode?:'inland'|'sea';loadAt?:number;ship?:number;record:StoredRecord,start:number,rest:Vector3,lifted:boolean,previous:Vector3,demandId?:string,requestId:string,reservationId?:string,saving?:boolean,retryAt?:number}|null=null,exportCount=0;
  let exportBatch:{ids:string[];total:number;done:number;mode:'inland'|'sea';demandId?:string}|null=null;
  const dispatchButton=document.createElement('button');dispatchButton.textContent='Export containers';uiRoot.querySelector('.controls')!.append(dispatchButton);
  const actualOccupancy=()=>yardLevels.reduce((a,b)=>a+b,0)+jobs.filter(j=>(!exported.has(j.mesh)||dispatch?.record.mesh===j.mesh)&&elapsed>=j.timing.placedAt).length;
  let storedCount=0,tripNumber=1,finished=false;
  let autoShift=false,nextTripAt=-1;
  let arrivalLocked=false;
  let stackingMode:'priority'|'compact'|'balanced'='priority';
  const interTripDelay=2;
  const autoButton=document.createElement('button');autoButton.textContent='Run full shift';
  autoButton.setAttribute('aria-pressed','false');
  autoButton.title='Automatically accept the next vessel after departure; stop when the yard is full';
  uiRoot.querySelector('.controls')!.prepend(autoButton);
  const shiftSummary=document.createElement('section');shiftSummary.className='shift-summary';shiftSummary.hidden=true;
  shiftSummary.setAttribute('role','status');shiftSummary.setAttribute('aria-label','Shift result');
  uiRoot.querySelector('#interface')!.append(shiftSummary);
  const next=document.createElement('button');next.textContent='Next voyage';uiRoot.querySelector('.controls')!.append(next);
  reset.textContent='Reset scene';reset.hidden=true; // Production economy never resets inventory to farm the same cargo.
  let switchingPort=false;
  const shop=mountShop(economy,{uiRoot,advice:()=>{
      const ops=session?.state.operational,used=session?.state.inventory.length??0;
      const demandCount=openDemands().reduce((n,d)=>n+Math.max(0,d.quantity-(session?.state.demandProgress[d.id]??0)),0);
      if(used>=capacity*.85)return `Yard ${used}/${capacity}, remaining ${demandCount} containers in the Nansen order. Prioritize container exports; the new harbor adds fixed capacity.`;
      if(!ops?.measuredTrips)return 'Not enough operating data to recommend equipment.';
      if(ops.yardCraneQueueSeconds>ops.truckWaitSeconds)return `Nansen order: ${demandCount} containers; yard truck wait ${ops.yardCraneQueueSeconds.toFixed(1)}s. Consider a yard crane upgrade first.`;
      if(ops.craneWaitSeconds>ops.truckWaitSeconds)return 'Cranes wait for transport more than trucks wait for cranes. Consider another forklift.';
      return `Truck wait for crane ${ops.truckWaitSeconds.toFixed(1)}s. Consider a berth crane first; more trucks may increase the queue.`;
    },onSwitchPort:async(id)=>{window.dispatchEvent(new CustomEvent('harbor-focus-port',{detail:id}));},canPurchase:()=>claiming||loadingCargo||savingCheckpoint||autoShift||parallelEnabled||parallelTrips.length||exportBatch||exportPreparing||settling||dispatch||start>=0&&!finished?'Wait for the current voyage to finish.':null,onPurchase:(_state,id)=>{if(id==='harbor:jade'){location.reload();return;}applyAssets();if(start<0)plan();update(rawClock);}});
  function applyAssets(){const enabled=economy.state.extraYardCrane;secondYardFixed.setEnabled(enabled);secondYardBody.setEnabled(enabled);hooks[4].setEnabled(enabled);for(const mesh of [...ropes.slice(8,10),...rigLinks[4].wire,...rigLinks[4].parts.flatMap(p=>[p.barrel,p.rod,p.lower,p.upper])])mesh.setEnabled(enabled);capacity=PORTS[economy.state.portIndex].capacity;expansionRows.forEach((root,i)=>root.setEnabled((i+5)*9<=capacity));fleet.forEach((f,i)=>f.root.setEnabled(i<economy.state.trucks));}
  applyAssets();
  let tripCargoSnapshot:RecordedTrip['cargo']|undefined;
  type ParallelTrip={ship:number,berth:number,manifest:HarborManifest,wait:number,jobs:typeof jobs,cargoSnapshot?:RecordedTrip['cargo'],schedule?:ResourceSchedule,departed:boolean,saving:boolean,retryAt:number};
  let parallelEnabled=false;
  const parallelTrips:ParallelTrip[]=[];
  const parallelCalendar:ResourceReservation[]=[];
  const parallelButton=document.createElement('button');parallelButton.textContent='Operate 3 berths';parallelButton.setAttribute('aria-pressed','false');uiRoot.querySelector('.controls')!.prepend(parallelButton);
  parallelButton.onclick=()=>{if(start>=0||finished&&!tripRecorded||dispatch||exportBatch||exportPreparing||settling)return;parallelEnabled=!parallelEnabled;autoShift=false;parallelButton.setAttribute('aria-pressed',String(parallelEnabled));if(!parallelEnabled&&!parallelTrips.length){plan();autoButton.disabled=false;shipSelect.disabled=false;berthSelect.disabled=false;}update(rawClock);};
  function openDemands(){return demands.filter(d=>Date.parse(d.expiresAt)>Date.now()&&d.quantity>(session?.state.demandProgress[d.id]??0));}
  function cargoPriority(token:{chain?:unknown;address?:unknown}|undefined){return priorityForToken(token?.chain,token?.address,openDemands()).score;}
  function shipPriority(index:number){const nav=traffic.ships[index];const wait=Number.isFinite(nav.waitSince)?Math.max(0,last-nav.waitSince):0;return Math.min(200,wait*10)+Math.max(0,...(shipManifests[index]?.units??[]).map(cargoPriority));}
  function orderedCargo<T extends {mesh:TransformNode}>(items:T[],source:T[]){
    // Top deck always precedes bottom deck. Nansen orders only physically accessible tiers.
    return items.sort((a,b)=>Number(source.indexOf(a)>=4)-Number(source.indexOf(b)>=4)||cargoPriority(b.mesh.metadata?.token)-cargoPriority(a.mesh.metadata?.token));
  }
  function yardChooser(levels:number[],incoming:{chain?:unknown;address?:unknown}[]){
    const stacks=Array.from({length:capacity/3},(_,cell)=>(session?.state.inventory??[]).filter(u=>u.cell===cell).sort((a,b)=>(a.level??0)-(b.level??0)).map(u=>({key:tokenIdentity(u.chain,u.address),score:cargoPriority(u)})));
    return (token:{chain?:unknown;address?:unknown})=>{
      const key=tokenIdentity(token.chain,token.address),score=cargoPriority(token);
      const candidates=levels.map((level,cell)=>({level,cell})).filter(x=>x.cell<capacity/3&&x.level<3);
      const cost=(cell:number)=>{if(stackingMode==='compact')return -levels[cell]*100+cell;if(stackingMode==='balanced')return levels[cell]*100+cell;const stack=stacks[cell],top=stack.at(-1);return (top&&top.key!==key?Math.max(0,top.score-score)*10+30:0)+(top?.key===key?-20:0)+levels[cell]*4+(score>0?(2-cell%3)*3+Math.floor(cell/3):0);};
      const cell=candidates.sort((a,b)=>cost(a.cell)-cost(b.cell)||a.cell-b.cell)[0]?.cell??0;
      stacks[cell].push({key,score});return cell;
    };
  }
  function cargoSnapshot(saved:HarborManifest,ordered:typeof jobs,lockPriority:boolean):RecordedTrip['cargo']{
    const units=new Map(saved.units.map(unit=>[unit.id,unit]));
    const activeDemands=lockPriority?openDemands():[];
    return ordered.map(job=>{
      const unit=units.get(job.mesh.metadata?.unitId);
      if(!unit)throw new Error('Container not found in the locked manifest');
      const {id,batchId,symbol,address,chain,eventAt,provenance}=unit;
      return structuredClone({id,batchId,symbol,address,chain,eventAt,provenance,priority:lockPriority?priorityForToken(chain,address,activeDemands).score:undefined});
    });
  }
  function restoreCargoSnapshot(value:unknown,saved:HarborManifest):RecordedTrip['cargo']|undefined{
    if(!Array.isArray(value)||value.length!==saved.units.length||new Set(value.map(c=>c?.id)).size!==value.length)return;
    const units=new Map(saved.units.map(unit=>[unit.id,unit]));
    if(!value.every(c=>c&&units.has(c.id)&&(c.priority===undefined||typeof c.priority==='number'&&Number.isFinite(c.priority)&&c.priority>=0)))return;
    return value.map(c=>{
      const {id,batchId,symbol,address,chain,eventAt,provenance}=units.get(c.id)!;
      return structuredClone({id,batchId,symbol,address,chain,eventAt,provenance,priority:c.priority});
    });
  }
  function renderPriorityBoard(){
    const priorities=openDemands().map(d=>({d,p:priorityForToken(d.chain,d.tokenAddress,demands)})).sort((a,b)=>b.p.score-a.p.score).slice(0,3);
    priorityBoard.textContent=priorities.length?`Nansen priority · ${priorities.map(x=>`${x.d.tokenSymbol}: ${x.p.label} · ${x.p.reason}`).join(' | ')}`:'Nansen priority · No live export order';
  }
  function plan(){
    const levels=[...yardLevels],count=cargoCounts[activeShip];
    dispatchInterval=4;
    // The synchronized handoff rate is bounded by both cranes and vehicle availability.
    // Duration is the sum of the actual dock / transport / yard service budgets.
    // More storage does not change any of these rates.
    const dockRate=1+economy.state.craneLevels[selectedBerth]*.35;
    const yardRate=1+economy.state.craneLevels[3]*.35;
    
    playbackRate=1;
    resourceSchedule=buildResourceSchedule(count,{portId,truckCount:economy.state.trucks,dockRate,yardRate,yardCount:economy.state.extraYardCrane?2:1});
    const free=capacity-levels.reduce((a,b)=>a+b,0);
    // Partial loads still rest on deck; only add an upper tier when all four lower slots are loaded.
    const active=orderedCargo([...manifest.slice(0,Math.max(0,count-4)),...manifest.slice(4,4+Math.min(4,count))],manifest);
    if(tripCargoSnapshot){const order=new Map(tripCargoSnapshot.map((unit,index)=>[unit.id,index]));active.sort((a,b)=>(order.get(a.mesh.metadata?.unitId)??Infinity)-(order.get(b.mesh.metadata?.unitId)??Infinity));}
    for(const item of manifest){exported.delete(item.mesh);item.mesh.setEnabled(active.includes(item));}
    const pickCell=yardChooser(levels,active.map(i=>i.mesh.metadata.token));
    jobs=active.map((item,i)=>{
      const cell=pickCell(item.mesh.metadata.token);
      const level=free>=count?levels[cell]++:0;
      return {...item,cell,truck:resourceSchedule.jobs[i].truck,start:resourceSchedule.jobs[i].dockAt,timing:resourceSchedule.jobs[i],slot:slotAt(cell,level)};
    });
    const lastJob=jobs.at(-1);
    handlingTicks=resourceSchedule.duration;
    departureAt=arrivalDuration+(lastJob?lastJob.start+2:0)/playbackRate;
    tripDuration=Math.max(departureAt+departureDuration,arrivalDuration+handlingTicks/playbackRate);
  }
  plan();
  function beginService(){
    if(arrivalLocked||!shipManifests[activeShip]?.admission)return false;
    if(parallelEnabled||parallelTrips.length)return false;
    if(!session||parallelEnabled||parallelTrips.length||exportBatch||exportPreparing||settling||start>=0||!jobs.length||dispatch||capacity-actualOccupancy()<jobs.length)return false;
    if(last<nextServiceTryAt)return false;nextServiceTryAt=last+1;
    let admitted=traffic.requestBerth(activeShip,selectedBerth);
    if(!admitted&&autoShift)for(const berth of [0,1,2]){
      if(berth===selectedBerth)continue;
      if(traffic.requestBerth(activeShip,berth)){chooseBerth(berth,false);admitted=true;break;}
    }
    if(!admitted){penaltyNotice='No safe route to the berth; waiting for vessel traffic.';return false;}
    tripWaitSeconds=Math.max(0,last-traffic.ships[activeShip].waitSince);
    plan();tripCargoSnapshot=cargoSnapshot(shipManifests[activeShip]!,jobs,true);start=last;serviceAt=-1;departureRequested=false;penaltyNotice='';return true;
  }
  button.onclick=()=>{beginService();update(rawClock);};
  function prepareNextTrip(){
    if(!finished||!tripRecorded||dispatch)return false;
    for(const job of jobs){
      if(exported.has(job.mesh))continue;
      const stored=storedCargo.find(root=>!root.isEnabled())!;storedCount++;exported.delete(stored);
      storedRecords.push({mesh:stored,cell:job.cell,slot:job.slot.clone(),initial:false});
      // Preserve this cargo's materials and geometry when reusing the ship's manifest next trip.
      const sourceMeshes=job.mesh.getChildMeshes(),targetMeshes=stored.getChildMeshes();
      targetMeshes.forEach((mesh,i)=>{const source=sourceMeshes[i];if(source){mesh.material=source.material;if(mesh instanceof Mesh&&source instanceof Mesh)source.geometry?.applyToMesh(mesh);}});
      stored.metadata={...(stored.metadata??{}),token:job.mesh.metadata?.token,unitId:job.mesh.metadata?.unitId};
      stored.position.copyFrom(job.slot);stored.rotation.set(0,0,0);stored.setEnabled(true);yardLevels[job.cell]++;
    }
    cargoCounts[activeShip]=0;cargoIds[activeShip]=[];shipManifests[activeShip]=undefined;ships[activeShip].cargo.forEach(item=>item.mesh.setEnabled(false));
    tripCargoSnapshot=undefined;tripNumber++;start=-1;elapsed=0;finished=false;nextTripAt=-1;tripRecorded=false;serviceAt=-1;departureRequested=false;receiptId=sessionId+':'+(++receiptSequence);
    // Release handling equipment without hiding the empty ship still sailing out.
    if(traffic.ships[activeShip].phase==='gone')traffic.ships[activeShip].phase='empty';
    plan();return true;
  }
  next.onclick=async()=>{if(!autoShift&&prepareNextTrip()){plan();update(rawClock);}};
  autoButton.onclick=()=>{
    if(parallelEnabled||parallelTrips.length||dispatch||exportBatch||exportPreparing||settling)return;
    if(autoShift){autoShift=false;nextTripAt=-1;}
    else if(actualOccupancy()<capacity){
      autoShift=true;
      if(start<0&&jobs.length>0&&capacity-actualOccupancy()>=jobs.length)beginService();
      else if(finished)nextTripAt=last+interTripDelay;
    }
    update(rawClock);
  };
  reset.onclick=()=>{penaltyNotice='Progress is stored on the server; reload to restore it.';};
  const exportMode=document.createElement('select');exportMode.setAttribute('aria-label','Delivery method');exportMode.innerHTML='<option value="inland">Inland delivery</option><option value="sea">Sea transfer</option>';uiRoot.querySelector('.controls')!.append(exportMode);
  const demandSelect=document.createElement('select');demandSelect.setAttribute('aria-label','Export order');uiRoot.querySelector('.controls')!.append(demandSelect);
  function refreshDemands(){const selected=demandSelect.value;demandSelect.replaceChildren();const ordinary=document.createElement('option');ordinary.value='';ordinary.textContent='Standard delivery · no bonus';demandSelect.append(ordinary);for(const d of [...demands].sort((a,b)=>priorityForToken(b.chain,b.tokenAddress,openDemands()).score-priorityForToken(a.chain,a.tokenAddress,openDemands()).score)){const remaining=d.quantity-(session?.state.demandProgress[d.id]??0);if(remaining<=0||Date.parse(d.expiresAt)<=Date.now())continue;const option=document.createElement('option');option.value=d.id;option.textContent=`${d.chain} · ${d.tokenSymbol} · remaining ${remaining} · +${d.bonusPerUnit} NS/container`;const flow=d.flowEvidence;option.title=`Nansen ${d.provenance.endpoint} · ${d.eventAt}${flow?` · Flow 1h pressure ${(flow.pressure*100).toFixed(0)}% · multiplier ${flow.quantityMultiplier.toFixed(2)}`:''}`;demandSelect.append(option);}demandSelect.value=selected;}

  const exportDialog=document.createElement('dialog');exportDialog.className='tideflow-modal tf-transfer-modal';
  document.body.append(exportDialog);
  function exportCandidates(){
    const records=[...initialCargo,...storedRecords,...jobs.filter(j=>elapsed>=j.timing.placedAt).map(j=>({mesh:j.mesh,slot:j.slot,cell:j.cell,initial:false}))];
    const unique=new Map<string,StoredRecord>();for(const r of records)if(r.mesh.isEnabled()&&!exported.has(r.mesh)&&r.mesh.metadata?.unitId){const unit=session?.state.inventory.find(u=>u.id===r.mesh.metadata.unitId);if(hasNansenProvenance(unit)){r.mesh.metadata.token={...unit,chain:canonicalChain(unit!.chain)};unique.set(r.mesh.metadata.unitId,r);}}return [...unique.values()].sort((a,b)=>priorityForToken(b.mesh.metadata.token?.chain,b.mesh.metadata.token?.address,openDemands()).score-priorityForToken(a.mesh.metadata.token?.chain,a.mesh.metadata.token?.address,openDemands()).score);
  }
  const tokenKey=(r:StoredRecord)=>tokenIdentity(r.mesh.metadata.token?.chain,r.mesh.metadata.token?.address)??'';
  function availableForExport(key:string){
    const rows=exportCandidates(),result:StoredRecord[]=[];
    for(const cell of new Set(rows.map(r=>r.cell))){for(const r of rows.filter(r=>r.cell===cell).sort((a,b)=>b.slot.y-a.slot.y)){if(tokenKey(r)!==key)break;result.push(r);}}
    return result.sort((a,b)=>b.slot.y-a.slot.y);
  }
  function exportShipStatus(key:string){
    const chain=canonicalChain(key.split(':')[0]),i=CHAINS.findIndex(c=>c.id===chain);
    if(i<0)return 'No matching vessel';
    const name=`MV ${chain==='bnb'?'BNB':CHAINS[i].name} Carrier`,nav=traffic.ships[i];
    if(!cargoCounts[i]&&['empty','gone'].includes(nav.phase))return `${name} · ready to call at berth`;
    if(nav.blocked)return `${name} · waiting for a clear route; availability time unknown`;
    if(nav.phase==='departing'&&nav.route&&nav.speed>.1)return `${name} · expected to be free in about ${Math.ceil((nav.route.length-nav.distance)/nav.speed)} seconds (may change if the route is blocked)`;
    return `${name} · ${nav.phase==='waiting'?`remaining ${Math.max(0,Math.ceil(WAIT_SECONDS-(last-nav.waitSince)))} seconds waiting for cargo; `:''}availability unknown; depends on unloading and departure route`;
  }
  dispatchButton.onclick=()=>{
    if(!session||parallelEnabled||parallelTrips.length||dispatch||exportBatch||exportPreparing||settling||autoShift||start>=0&&!tripRecorded)return;
    exportDialog.replaceChildren();
    const heading=document.createElement('h2');heading.textContent='Transfer containers';exportDialog.append(heading);
    const grid=document.createElement('div');grid.className='tf-item-grid tf-transfer-grid';exportDialog.append(grid);
    const quantityLabel=document.createElement('label');quantityLabel.textContent='Quantity ';
    const quantity=document.createElement('input');quantity.type='number';quantity.min='1';quantity.step='1';quantity.value='1';quantityLabel.append(quantity);exportDialog.append(quantityLabel);
    const note=document.createElement('p');note.setAttribute('role','status');exportDialog.append(note);
    const confirm=document.createElement('button');confirm.textContent='Confirm transfer';confirm.hidden=true;
    const cancel=document.createElement('button');cancel.textContent='×';cancel.className='modal-close';cancel.setAttribute('aria-label','Close transfer');cancel.onclick=()=>exportDialog.close();exportDialog.append(confirm,cancel);
    let chosen='',mode:'inland'|'sea'|null=null;
    const groups=new Map<string,StoredRecord[]>();for(const r of exportCandidates()){const key=tokenKey(r);groups.set(key,[...(groups.get(key)??[]),r]);}
    const demand=demands.find(d=>d.id===demandSelect.value);
    const available=(key:string)=>Math.min(availableForExport(key).length,demand?Math.max(0,demand.quantity-(session?.state.demandProgress[demand.id]??0)):Infinity);
    for(const [key,rows] of groups){
      const token=rows[0].mesh.metadata.token;
      const allowed=available(key)>0&&(!demand||tokenIdentity(token.chain,token.address)===tokenIdentity(demand.chain,demand.tokenAddress));
      const wrap=document.createElement('div');wrap.className='tf-transfer-cell';
      const item=document.createElement('button');item.className='tf-item';item.disabled=!allowed;
      item.title=allowed?`${token.symbol} · ${token.chain}`:'Locked: container is covered or not eligible for this order';
      item.append(Object.assign(document.createElement('span'),{innerHTML:gameIcon('container')}));
      const name=document.createElement('b');name.textContent=token.symbol;item.append(name);
      const count=document.createElement('small');count.textContent=`${token.chain} · ${rows.length}`;item.append(count);
      const progress=document.createElement('progress');progress.max=rows.length;progress.value=available(key);progress.setAttribute('aria-label','Accessible containers');item.append(progress);
      if(!allowed){const lock=document.createElement('span');lock.className='tf-item-lock';lock.innerHTML=gameIcon('lock');item.append(lock);}
      item.onclick=()=>{
        grid.querySelectorAll('.tf-transfer-choice').forEach(e=>e.remove());
        chosen=key;mode=null;confirm.hidden=true;
        const choice=document.createElement('div');choice.className='tf-transfer-choice tf-above-item';
        for(const [value,label] of [['inland','Inland delivery'],['sea','Sea transfer']] as const){
          const b=document.createElement('button');b.innerHTML=gameIcon(value);b.append(document.createTextNode(label));
          b.onclick=()=>{mode=value;quantity.value='1';quantity.max=String(available(key));choice.remove();confirm.hidden=false;note.textContent=value==='sea'?exportShipStatus(key):`${available(key)} containers ready for inland delivery`;};choice.append(b);
        }
        wrap.append(choice);
      };wrap.append(item);grid.append(wrap);
    }
    if(!groups.size)note.textContent='No eligible Nansen containers available.';
    confirm.onclick=()=>{const count=Number(quantity.value);if(!mode||!Number.isInteger(count)||count<1||count>available(chosen)){note.textContent=`Choose a quantity from 1 to ${available(chosen)}.`;return;}
      exportBatch={ids:availableForExport(chosen).slice(0,count).map(r=>r.mesh.metadata.unitId),total:count,done:0,mode,demandId:demand?.id};exportDialog.close();void sendExportUnit(exportBatch.ids[0]);};
    exportDialog.show();
  };
  window.addEventListener('harbor-open-transfer',event=>{const detail=(event as CustomEvent<{portId:string;unitId?:string}>).detail;if(detail.portId!==portId)return;selectedUnitId=detail.unitId;dispatchButton.click();});
  async function sendExportUnit(unitId:string){
    if(!session||parallelEnabled||parallelTrips.length||dispatch||exportPreparing||settling||autoShift||start>=0&&!tripRecorded)return;
    const demand=demands.find(d=>d.id===exportBatch?.demandId);
    const candidates=exportCandidates();
    const exposed=candidates.filter(r=>!candidates.some(other=>other.cell===r.cell&&other.slot.y>r.slot.y+.1));
    const record=exposed.filter(r=>r.mesh.metadata?.unitId===unitId&&(!demand||tokenKey(r)===tokenIdentity(demand.chain,demand.tokenAddress))).sort((a,b)=>b.slot.y-a.slot.y)[0];
    if(!record){exportBatch=null;penaltyNotice='Export stopped: the container is no longer on top of its stack.';return;}
    const mode=exportBatch!.mode,ship=CHAINS.findIndex(c=>c.id===canonicalChain(record.mesh.metadata?.token?.chain));
    if(mode==='sea'&&(ship<0||cargoCounts[ship]>0||!['empty','gone'].includes(traffic.ships[ship].phase))){penaltyNotice=exportShipStatus(tokenKey(record));return;}
    exportPreparing=true;const requestId=crypto.randomUUID();
    try{const result=await session.reserveExport([record.mesh.metadata.unitId],demand?.id,requestId,mode,portId);if(!result.reservation)throw new Error('Could not reserve the export containers.');if(mode==='sea')seaExport=createSeaExport(traffic,ship,selectedBerth);dispatch={mode,ship,record,start:last,rest:record.mesh.position.clone(),lifted:false,previous:fleet[0].garage.clone(),demandId:demand?.id,requestId,reservationId:result.reservation.id};shiftSummary.hidden=true;}
    catch(e){reportError(e);try{await session.refresh();const reserved=session.state.exportReservations.find(r=>r.status==='reserved'&&r.unitIds.includes(record.mesh.metadata.unitId));if(reserved){if(mode==='sea'&&!seaExport)seaExport=createSeaExport(traffic,ship,selectedBerth);dispatch={mode,ship,record,start:last,rest:record.mesh.position.clone(),lifted:false,previous:fleet[0].garage.clone(),requestId,reservationId:reserved.id};}}catch{}}
    finally{exportPreparing=false;if(!dispatch)exportBatch=null;}
  };
  // Smooth waypoint traversal. The payload is always derived from the carrying vehicle transform.
  const offset=(heading:number)=>new Vector3(Math.sin(heading)*3,2.25,Math.cos(heading)*3);
  const receiptRoot=receiving.subtract(offset(0)),deliveryRoot=yardPickup.subtract(offset(Math.PI/2));
  function chooseBerth(index:number,render=true){
    if(parallelEnabled||parallelTrips.length||exportBatch||exportPreparing||settling||start>=0||dispatch||index<0||index>=berthChoices.length)return;
    selectedBerth=index;berthSelect.value=String(index);const berth=berthChoices[index];
    shipAngle=berth.angle;berthOrigin.copyFrom(berth.origin);const turn=shipAngle-homeAngle,rotation=Matrix.RotationY(turn);
    forward.set(Math.cos(shipAngle),0,-Math.sin(shipAngle));vesselMotion.forward.copyFrom(forward);vesselMotion.angle=turn;
    vesselRoots.forEach((root,i)=>{berthPositions[i].copyFrom(berthOrigin);root.rotationQuaternion=Quaternion.RotationYawPitchRoll(turn,0,0).multiply(homeRotations[i]);});
    manifest.forEach((item,i)=>item.pickup.copyFrom(Vector3.TransformNormal(homePickups[i].subtract(homeOrigin),rotation).add(berthOrigin)));
    receiving.copyFrom(berth.receipt);receiptRoot.copyFrom(receiving.subtract(offset(0)));
    signal.r.position.copyFrom(berth.crane.add(new Vector3(-1.4,-1.9,-2)));
    plan();if(render)update(rawClock);
  }
  function activateShip(index:number){
    if(parallelEnabled||parallelTrips.length||exportBatch||exportPreparing||settling||start>=0||dispatch)return;
    if(index===activeShip)return;
    activeShip=index;shipSelect.value=String(index);vesselRoots=ships[index].roots;manifest=ships[index].cargo;
    chooseBerth(selectedBerth,false);
  }
  scene.onPointerObservable.add(event=>{
    if(event.type!==PointerEventTypes.POINTERTAP||!event.pickInfo?.pickedMesh||parallelEnabled||parallelTrips.length||start>=0||dispatch||exportBatch||exportPreparing||settling)return;
    let node:any=event.pickInfo.pickedMesh;
    while(node){
      if(node.metadata?.unitId&&storedRecords.some(r=>r.mesh===node)){selectedUnitId=node.metadata.unitId;penaltyNotice=`Selected ${node.metadata.token?.symbol??'container'} · click Export containers to choose a quantity.`;return;}
      const index=ships.findIndex(ship=>ship.roots.includes(node)||ship.cargo.some(c=>c.mesh===node));
      if(index>=0){arrivalDirector(world).open(portId,index);return;}
      node=node.parent;
    }
  });
  shipSelect.onchange=()=>activateShip(Number(shipSelect.value));
  berthSelect.onchange=()=>chooseBerth(Number(berthSelect.value));
  function truckPose(j:Pick<typeof jobs[number],'truck'>,t:number,receipt=receiptRoot){const garage=fleet[j.truck].garage;
    // Straight outbound and return lanes; heading changes happen while stopped.
    const parkedAngle=garage.x<-7?Math.PI/2:-Math.PI/2;
    const exit=new Vector3(-7,0,garage.z),turn=new Vector3(-7,0,Math.max(garage.z,-21.8)),door=new Vector3(-7,0,-15.9);
    const returnCorner=new Vector3(8,0,-3.8),returnDoor=new Vector3(-7,0,-3.8),inside=new Vector3(-7,0,garage.z);
    const queue=new Vector3(-10.8,0,-10.8);
    const lane=queue,outbound=new Vector3(-7,0,-10.8);
    const outboundHeading=-Math.PI/2;
    const frames:[number,Vector3,number][]=[
      [-4,garage,parkedAngle],[-3.85,garage,parkedAngle],[-3.6,exit,parkedAngle],[-3.4,turn,0],[-3.15,door,0],[-2.85,outbound,0],[-2.65,outbound,outboundHeading],[-2.3,lane,outboundHeading],[-2.1,queue,0],
      // Wait behind the receiving vehicle until its loaded turn and exit have cleared the bay.
      [-.7,queue,0],[0,receipt,0],
      [2.05,receipt,0],[2.5,receipt,Math.PI/2],
      [3.3,deliveryRoot,Math.PI/2],[4.7,deliveryRoot,Math.PI/2],
      [5,deliveryRoot,0],[5.5,returnCorner,0],
      [5.8,returnCorner,-Math.PI/2],[6.5,returnDoor,-Math.PI/2],
      [6.8,returnDoor,-Math.PI],[7.4,turn,Math.PI],[7.55,inside,parkedAngle<0?Math.PI*1.5:parkedAngle],[7.8,garage,parkedAngle<0?Math.PI*1.5:parkedAngle],[8,garage,parkedAngle<0?Math.PI*1.5:parkedAngle]
    ];
    if(t<=-4)return {p:garage.clone(),a:parkedAngle};if(t>=8)return {p:garage.clone(),a:parkedAngle};
    let k=1;while(k<frames.length-1&&t>frames[k][0])k++;const a=frames[k-1],b=frames[k],u=(t-a[0])/(b[0]-a[0]);return {p:mix(a[1],b[1],u),a:a[2]+Math.atan2(Math.sin(b[2]-a[2]),Math.cos(b[2]-a[2]))*ease(u)};
  }
  // Two-bone solver. Only the outer telescoping segment changes length; the cab/pedestal never scales.
  const inner=knee.subtract(foot),outer=tip.subtract(knee),innerLength=inner.length();
  const telescopes=rigLinks.map(rig=>rig.elbow).map(elbow=>{
    const shaft=new TransformNode('Telescopic outer section',scene);shaft.parent=elbow;
    const orient=Quaternion.FromUnitVectorsToRef(Vector3.Up(),outer.normalizeToNew(),new Quaternion());shaft.rotationQuaternion=orient;
    const invRot=Matrix.Invert(Matrix.FromQuaternionToRef(orient,new Matrix()));
    for(const child of elbow.getChildMeshes(true))if(child instanceof Mesh){child.makeGeometryUnique();const data=VertexData.ExtractFromMesh(child,true,true);for(const key of ['positions','normals'] as const){const values=data[key];if(values)for(let i=0;i<values.length;i+=3){const q=Vector3.TransformNormal(Vector3.FromArray(values,i),invRot);values[i]=q.x;values[i+1]=q.y;values[i+2]=q.z;}}data.applyToMesh(child);child.parent=shaft;}
    return shaft;
  });
  const rigTips=rigLinks.map(()=>Vector3.Zero());
  const dockRigIndices=[0,2,3];
  function aim(index:number,target:Vector3){const rig=rigLinks[index],body=rig.body;body.scaling.setAll(1);body.rotation.y=Math.atan2(target.x-body.position.x,target.z-body.position.z);body.computeWorldMatrix(true);
    const local=Vector3.TransformCoordinates(target,Matrix.Invert(localMatrix(body))),delta=local.subtract(foot),distance=delta.length(),direction=delta.normalizeToNew();
    const length=Math.max(outer.length(),distance-innerLength+.7);
    const along=(innerLength*innerLength-length*length+distance*distance)/(2*distance),height=Math.sqrt(Math.max(0,innerLength*innerLength-along*along));
    const up=Vector3.Up().subtract(direction.scale(Vector3.Dot(Vector3.Up(),direction))).normalize();const elbowPosition=foot.add(direction.scale(along)).add(up.scale(height));
    rig.arm.rotation.setAll(0);rig.arm.rotationQuaternion=Quaternion.FromUnitVectorsToRef(inner.normalizeToNew(),elbowPosition.subtract(foot).normalize(),new Quaternion());rig.arm.computeWorldMatrix(true);
    const desired=Vector3.TransformNormal(local.subtract(elbowPosition),Matrix.Invert(Matrix.FromQuaternionToRef(rig.arm.rotationQuaternion,new Matrix()))).normalize();
    rig.elbow.rotation.setAll(0);rig.elbow.rotationQuaternion=Quaternion.FromUnitVectorsToRef(outer.normalizeToNew(),desired,new Quaternion());
    telescopes[index].scaling.y=length/outer.length();rigTips[index].copyFrom(target);
  }
  function hookPose(index:number,bottom:Vector3,yaw:number,spread:number){const hook=hooks[index];hook.position.copyFrom(bottom.add(new Vector3(0,2.05,0)));hook.rotation.y=yaw;
    aim(index,bottom.add(new Vector3(0,4.35,0)));
    for(let i=0;i<2;i++)cable(ropes[index*2+i],rigTips[index].add(new Vector3((i-.5)*.1,0,0)),hook.position.add(new Vector3((i-.5)*.1,1.5,0)));
    let i=0;for(const x of [-2.18,2.18])for(const z of [-.9,.9]){const end=new Vector3(x*(.06+.94*spread),.025-(1-spread)*.75,z*(.06+.94*spread));slingSets[index].ends[i].position.copyFrom(end);cable(slingSets[index].lines[i],new Vector3(0,1.13,0),end);i++;}
  }
  function dockPose(j:typeof jobs[number],t:number,receipt=receiving,angle=shipAngle,group=jobs){const high=j.pickup.clone();high.y=6.6;const over=receipt.clone();over.y=6.6;
    if(t<.35)return {p:mix(high,j.pickup,t/.35),a:angle,s:ease(t/.35)};
    if(t<.8)return {p:mix(j.pickup,high,(t-.35)/.45),a:angle,s:1};
    if(t<1.55)return {p:mix(high,over,(t-.8)/.75),a:lerp(angle,0,(t-.8)/.75),s:1};
    if(t<2)return {p:mix(over,receipt,(t-1.55)/.45),a:0,s:1};
    const next=group[Math.min(group.indexOf(j)+1,group.length-1)].pickup.clone();next.y=6.6;
    const u=(t-2)/(dispatchInterval-2);const p=mix(receipt,next,u);p.y+=Math.sin(Math.PI*Math.max(0,Math.min(1,u)))*2;
    return {p,a:lerp(0,angle,u),s:1-ease(u)};
  }
  function yardPose(j:typeof jobs[number],t:number){const u=t-4,high=yardPickup.clone();high.y=8;const over=j.slot.clone();over.y=8;
    if(u<.25)return {p:mix(high,yardPickup,u/.25),a:Math.PI/2,s:ease(u/.25)};
    if(u<.7)return {p:mix(yardPickup,high,(u-.25)/.45),a:Math.PI/2,s:1};
    if(u<1.45)return {p:mix(high,over,(u-.7)/.75),a:lerp(Math.PI/2,0,(u-.7)/.75),s:1};
    if(u<1.95)return {p:mix(over,j.slot,(u-1.45)/.5),a:0,s:1};
    const returnTime=(u-1.95)/.45,p=mix(j.slot,high,returnTime);p.y+=Math.sin(Math.PI*Math.max(0,Math.min(1,returnTime)))*2;
    return {p,a:lerp(0,Math.PI/2,returnTime),s:1-ease(returnTime)};
  }
  function updateParallel(time:number){
    const occupied=new Set(parallelTrips.map(t=>t.berth));
    let free=capacity-yardLevels.reduce((a,b)=>a+b,0)-parallelTrips.reduce((n,t)=>n+t.manifest.units.length,0);
    if(parallelEnabled&&session)for(const ship of ships.map((_,i)=>i).sort((a,b)=>shipPriority(b)-shipPriority(a))){
      const nav=traffic.ships[ship],saved=shipManifests[ship];
      if(!saved?.admission||nav.phase!=='waiting'||nav.expired||parallelTrips.some(t=>t.ship===ship)||cargoCounts[ship]>free)continue;
      const berth=saved.admission.berth;if(occupied.has(berth))continue;
      if(!traffic.requestBerth(ship,berth))continue;
      parallelTrips.push({ship,berth,manifest:saved,wait:Math.max(0,time-nav.waitSince),jobs:[],departed:false,saving:false,retryAt:0});occupied.add(berth);free-=cargoCounts[ship];
    }
    for(const trip of parallelTrips){
      if(trip.schedule||traffic.ships[trip.ship].phase!=='docked')continue;
      const levels=[...yardLevels];for(const other of parallelTrips)for(const j of other.jobs)levels[j.cell]++;
      const schedule=buildResourceSchedule(trip.manifest.units.length,{portId,truckCount:economy.state.trucks,dockRate:1+economy.state.craneLevels[trip.berth]*.35,yardRate:1+economy.state.craneLevels[3]*.35,yardCount:economy.state.extraYardCrane?2:1,berth:trip.berth,earliest:time,reservations:parallelCalendar.filter(r=>r.end>time)});
      trip.schedule=schedule;parallelCalendar.push(...schedule.reservations);
      const berth=berthChoices[trip.berth],rotation=Matrix.RotationY(berth.angle-homeAngle),count=trip.manifest.units.length,source=ships[trip.ship].cargo,items=[...source.slice(0,Math.max(0,count-4)),...source.slice(4,4+Math.min(4,count))];
      const pickCell=yardChooser(levels,items.map(i=>i.mesh.metadata.token));
      trip.jobs=orderedCargo(items,source).map((item,i)=>{const cell=pickCell(item.mesh.metadata.token);const level=levels[cell]++;const cargoIndex=source.indexOf(item);return {...item,pickup:Vector3.TransformNormal(homePickups[cargoIndex].subtract(homeOrigin),rotation).add(berth.origin),cell,slot:slotAt(cell,level),truck:schedule.jobs[i].truck,start:schedule.jobs[i].dockAt,timing:schedule.jobs[i]};});
      trip.cargoSnapshot=cargoSnapshot(trip.manifest,trip.jobs,true);
    }
    const all=parallelTrips.flatMap(trip=>trip.jobs.map(job=>({trip,job})));
    for(let i=0;i<fleet.length;i++){
      const f=fleet[i],entry=all.filter(({job})=>job.truck===i&&time>=job.timing.approachAt&&time<job.timing.truckReturnedAt).sort((a,b)=>b.job.timing.approachAt-a.job.timing.approachAt)[0],sample=entry?sampleResourceJob(entry.job.timing,time):undefined;
      const pose=entry?truckPose(entry.job,sample!.truckT,berthChoices[entry.trip.berth].receipt.subtract(offset(0))):{p:f.garage.clone(),a:f.garage.x<-7?Math.PI/2:-Math.PI/2};f.root.position.copyFrom(pose.p);f.root.rotation.y=pose.a;f.angle=pose.a;const distance=Vector3.Dot(pose.p.subtract(f.previous),new Vector3(Math.sin(pose.a),0,Math.cos(pose.a)));for(const wheel of f.wheels)wheel.rotation.x+=distance/.5;f.previous.copyFrom(pose.p);for(const carriage of f.root.getChildTransformNodes().filter(n=>n.name.includes('Fork carriage')))carriage.scaling.z=sample?.carrying?1:.4;
    }
    for(let berth=0;berth<3;berth++){const trip=parallelTrips.find(t=>t.berth===berth),j=trip?.jobs.filter(j=>time>=j.timing.dockAt&&time<j.timing.dockResetAt).at(-1),rig=dockRigIndices[berth];if(trip&&j){const p=dockPose(j,sampleResourceJob(j.timing,time).dockT,berthChoices[berth].receipt,berthChoices[berth].angle,trip.jobs);hookPose(rig,p.p,p.a,p.s);}else hookPose(rig,berthCranePositions[berth].add(new Vector3(0,3.62,-3)),0,0);}
    for(let yard=0;yard<(economy.state.extraYardCrane?2:1);yard++){const entry=all.find(({job})=>job.timing.yard===yard&&time>=job.timing.yardAt&&time<job.timing.yardResetAt),rig=yard===0?1:4;if(entry){const p=yardPose(entry.job,sampleResourceJob(entry.job.timing,time).yardT);hookPose(rig,p.p,p.a,p.s);}else hookPose(rig,rigLinks[rig].body.position.add(new Vector3(-2,5,0)),0,0);}
    for(const {trip,job} of all){const sample=sampleResourceJob(job.timing,time);job.mesh.metadata.collisionIgnoreOwners=sample.cargoPhase==='dock'?['crane:'+dockRigIndices[trip.berth]]:sample.cargoPhase==='truck'?['truck:'+job.truck]:sample.cargoPhase==='yard'?['crane:'+(job.timing.yard===0?1:4)]:[];if(sample.cargoPhase==='aboard')continue;if(sample.cargoPhase==='dock'){const p=dockPose(job,sample.dockT,berthChoices[trip.berth].receipt,berthChoices[trip.berth].angle,trip.jobs);job.mesh.position.copyFrom(p.p);job.mesh.rotation.y=p.a;}else if(sample.cargoPhase==='truck'){const f=fleet[job.truck];job.mesh.position.copyFrom(f.root.position.add(offset(f.angle)));job.mesh.rotation.y=f.angle;}else if(sample.cargoPhase==='yard'){const p=yardPose(job,sample.yardT);job.mesh.position.copyFrom(p.p);job.mesh.rotation.y=p.a;}else{job.mesh.position.copyFrom(job.slot);job.mesh.rotation.y=0;}}
    for(const trip of [...parallelTrips]){if(!trip.schedule)continue;if(time>=trip.schedule.dockReleasedAt&&!trip.departed)trip.departed=traffic.depart(trip.ship);if(time<trip.schedule.duration||!trip.departed||trip.saving||time<trip.retryAt||!session)continue;trip.saving=true;const telemetry=resourceTelemetry(trip.schedule);void session.complete(trip.manifest.id,trip.jobs.map(j=>({unitId:j.mesh.metadata.unitId,cell:j.cell,level:Math.round((j.slot.y-1.48)/2.05)})),{vesselWaitSeconds:trip.wait,truckWaitSeconds:telemetry.truckWaitingSeconds,craneWaitSeconds:0,yardCraneQueueSeconds:telemetry.yardWaitingSeconds,handlingSeconds:trip.schedule.duration-Math.min(...trip.jobs.map(j=>j.timing.approachAt))}).then(()=>{for(const j of trip.jobs){const stored=storedCargo.find(root=>!root.isEnabled());if(!stored)throw new Error('No mesh remains for storage');stored.position.copyFrom(j.slot);stored.rotation.setAll(0);paintCargo(scene,stored,j.mesh.metadata.token);stored.metadata={...(stored.metadata??{}),token:j.mesh.metadata?.token,unitId:j.mesh.metadata?.unitId};stored.setEnabled(true);storedRecords.push({mesh:stored,slot:j.slot.clone(),cell:j.cell,initial:false});yardLevels[j.cell]++;j.mesh.setEnabled(false);}const saved=trip.manifest;history.record({version:1,id:saved.id,rulesVersion:saved.rulesVersion,chain:saved.units[0].chain,berth:trip.berth,recordedAt:new Date().toISOString(),batchIds:saved.batchIds,cargo:trip.cargoSnapshot??cargoSnapshot(saved,trip.jobs,false),schedule:trip.schedule!,ns:saved.rewardNs??saved.units.length*10,waitSeconds:trip.wait});tripNumber++;ships[trip.ship].trips++;ships[trip.ship].delivered+=trip.jobs.length;cargoCounts[trip.ship]=0;cargoIds[trip.ship]=[];shipManifests[trip.ship]=undefined;parallelTrips.splice(parallelTrips.indexOf(trip),1);if(!parallelEnabled&&!parallelTrips.length){plan();autoButton.disabled=false;shipSelect.disabled=false;berthSelect.disabled=false;}}).catch(e=>{trip.saving=false;trip.retryAt=last+5;reportError(e);});}
    for(let index=0;index<ships.length;index++){const ship=ships[index],pose=traffic.ships[index].pose,position=new Vector3(pose.x,0,pose.z),turn=pose.a-homeAngle,rotation=Matrix.RotationY(turn),opacity=traffic.opacity(index);ship.roots.forEach((root,i)=>{root.position.copyFrom(position);root.rotationQuaternion=Quaternion.RotationYawPitchRoll(turn,0,0).multiply(homeRotations[i]);});fadeShip(ship,opacity);ship.cargo.forEach((item,i)=>{const entry=all.find(({job})=>job.mesh===item.mesh),aboard=!entry||time<entry.job.timing.liftedAt;if(aboard){item.mesh.position.copyFrom(Vector3.TransformNormal(homePickups[i].subtract(homeOrigin),rotation).add(position));item.mesh.rotation.y=pose.a;}if(dispatch?.record.mesh!==item.mesh)item.mesh.getChildMeshes().forEach(mesh=>mesh.visibility=aboard?opacity:1);});}
    const foam=traffic.ships[0];vesselMotion.position.set(foam.pose.x,0,foam.pose.z);vesselMotion.forward.set(Math.cos(foam.pose.a),0,-Math.sin(foam.pose.a));vesselMotion.angle=foam.pose.a-homeAngle;vesselMotion.speed=foam.speed;vesselMotion.visibility=traffic.opacity(0);updateRigLinks();
    const levels=[...yardLevels],reserved=Array<number>(36).fill(0);for(const {job} of all)if(time>=job.timing.placedAt)levels[job.cell]++;else reserved[job.cell]++;inventory.update({levels:levels.slice(0,capacity/3),reserved:reserved.slice(0,capacity/3),receiving:all.find(({job})=>time>=job.timing.yardLiftedAt&&time<job.timing.placedAt)?.job.cell??null,trip:tripNumber,completed:all.filter(({job})=>time>=job.timing.placedAt).length,total:all.length,phase:'Three berths · shared resources'});
    status.textContent=`Operations ${parallelTrips.length}/3 berth · Yard ${levels.reduce((a,b)=>a+b,0)}/${capacity} · Reserved ${parallelTrips.reduce((n,t)=>n+t.manifest.units.length,0)} · NS ${economy.state.ns.toLocaleString('en-US')}`;schedule.textContent=parallelTrips.map(t=>`Berth ${t.berth+1}: ${ships[t.ship].name} · ${t.schedule?t.jobs.filter(j=>time>=j.timing.placedAt).length+'/'+t.jobs.length+' stacked':'Entering berth'}`).join(' | ')||'Waiting for a vessel with Nansen data';parallelButton.textContent=parallelEnabled?'Stop accepting new vessels':'Operate 3 berths';parallelButton.setAttribute('aria-pressed',String(parallelEnabled));renderPriorityBoard();button.disabled=next.disabled=shipSelect.disabled=berthSelect.disabled=dispatchButton.disabled=autoButton.disabled=true;shiftSummary.hidden=true;for(let i=parallelCalendar.length-1;i>=0;i--)if(parallelCalendar[i].end<=time)parallelCalendar.splice(i,1);
  }
  function completionMetrics(){
    const t=resourceTelemetry(resourceSchedule);
    const craneWaitSeconds=resourceSchedule.jobs.reduce((sum,j,i)=>sum+Math.max(0,j.dockAt-(i?resourceSchedule.jobs[i-1].dockResetAt:0)),0);
    return {vesselWaitSeconds:tripWaitSeconds,truckWaitSeconds:t.truckWaitingSeconds,craneWaitSeconds,yardCraneQueueSeconds:t.yardWaitingSeconds,handlingSeconds:t.totalSeconds};
  }
  function savePresentation(){
    if(!session||arrivalLocked||parallelEnabled||parallelTrips.length||savingCheckpoint||claiming||settling||exportPreparing||last<nextCheckpoint)return;
    savingCheckpoint=true;nextCheckpoint=last+2;
    const runtime={version:1,tripCargoSnapshot,time:last,activeShip,selectedBerth,start,serviceAt,departureRequested,autoShift,tripNumber,tripWaitSeconds,nextArrivalAt,manifests:shipManifests.map(m=>m?.id??null),traffic:traffic.snapshot(),departures:[...restoredDepartures]};
    void session.checkpoint({version:2,trips:recordedTrips,runtime,yardFullSeconds}).catch(reportError).finally(()=>savingCheckpoint=false);
  }
  function receiveArrival(arrival:import('./arrivalFlow').Arrival,pose:import('./collisionAudit').Pose){
    const index=arrival.index,saved=arrival.manifest;
    shipManifests[index]=saved;cargoCounts[index]=saved.units.length;cargoIds[index]=saved.batchIds;
    const slots=[...ships[index].cargo.slice(0,Math.max(0,saved.units.length-4)),...ships[index].cargo.slice(4,4+Math.min(4,saved.units.length))];
    saved.units.forEach((unit,i)=>{paintCargo(scene,slots[i].mesh,unit);slots[i].mesh.metadata={...slots[i].mesh.metadata,unitId:unit.id,batchId:unit.batchId,eventAt:unit.eventAt??saved.createdAt};});
    ships[index].cargo.forEach(c=>c.mesh.setEnabled(slots.includes(c)));
    Object.assign(traffic.ships[index],{phase:'waiting',pose,route:null,distance:0,speed:0,expired:false,blocked:false,berth:null,waitSince:last});
    lossRecorded[index]=false;restoredDepartures.delete(index);
    for(const id of saved.batchIds)seenBatches.add(id);
    nextCheckpoint=0;
  }
  const receivingPort:ArrivalPort={
    id:portId,label:portId==='jade'?'Jade Harbor':'Coral Harbor',
    arrivals:()=>traffic.ships.flatMap((nav,index)=>{
      const saved=shipManifests[index];
      return nav.phase==='waiting'&&!nav.expired&&saved?.status==='claimed'&&!saved.admission?[{index,name:ships[index].name,manifest:saved}]:[];
    }),
    free:()=>Math.max(0,capacity-actualOccupancy()-shipManifests.reduce((n,m,i)=>n+(m?.admission&&traffic.ships[i].phase==='waiting'?m.units.length:0),0)),
    full:()=>actualOccupancy()>=capacity,
    balance:()=>economy.state.ns,
    available:(arrival,source)=>!!session&&!arrivalLocked&&!claiming&&!settling&&!savingCheckpoint&&!dispatch&&!exportBatch&&!exportPreparing&&start<0&&!parallelTrips.length&&(source===portId||(!cargoCounts[arrival.index]&&['empty','gone'].includes(traffic.ships[arrival.index].phase))),
    berths:()=>[0,1,2].filter(berth=>!traffic.ships.some(nav=>nav.berth===berth&&!['empty','gone'].includes(nav.phase))&&!shipManifests.some(m=>m?.admission?.berth===berth)),
    lock:value=>{arrivalLocked=value;},receive:receiveArrival,
    refresh:async()=>{await session?.refresh();},
    transfer:()=>dispatchButton.click(),
    async accept(arrival,target,plan){
      if(!session)throw new Error('Harbor session is not ready.');
      if(!target.available(arrival,portId))throw new Error('Receiving port is busy. Please choose again.');
      const nav=traffic.ships[arrival.index];
      if(nav.phase!=='waiting'||nav.expired)throw new Error('This vessel is no longer waiting.');
      arrivalLocked=true;target.lock(true);
      try{
        const result=await session.acceptArrival(arrival.manifest.id,plan);
        const accepted=result.manifest;if(!accepted?.admission)throw new Error('Arrival confirmation was not saved.');
        if(target.id===portId)shipManifests[arrival.index]=accepted;
        else{
          const pose=toPortPose(target.id,toWorldPose(portId,nav.pose));
          // Preserve the physical world position and let the destination's route solver navigate from it.
          nav.phase='empty';nav.route=null;nav.berth=null;cargoCounts[arrival.index]=0;cargoIds[arrival.index]=[];shipManifests[arrival.index]=undefined;
          ships[arrival.index].cargo.forEach(c=>c.mesh.setEnabled(false));
          world.releaseBatches(accepted.batchIds,portId);world.reserveBatches(accepted.batchIds,target.id);
          target.receive({...arrival,manifest:accepted},pose);
          if(arrival.index===activeShip)planCurrentShip();
          // Refresh may fail after a committed transfer. Local cargo ownership is already reconciled.
          await target.refresh().catch(reportError);
        }
        nextCheckpoint=0;
      }finally{arrivalLocked=false;target.lock(false);}
    },
    async reject(arrival,expectedPenalty){
      if(!session)throw new Error('Harbor session is not ready.');
      arrivalLocked=true;
      try{await session.rejectArrival(arrival.manifest.id,expectedPenalty);lossRecorded[arrival.index]=true;traffic.ships[arrival.index].expired=true;restoredDepartures.add(arrival.index);nextCheckpoint=0;}
      catch(error){await session.refresh().catch(reportError);throw error;}
      finally{arrivalLocked=false;}
    }
  };
  // Alias avoids shadowing the schedule planner with the player's arrival plan.
  function planCurrentShip(){plan();}
  arrivalDirector(world).register(receivingPort);
  function processAcceptedArrival(){
    if(arrivalLocked||start>=0||dispatch||settling||exportBatch||exportPreparing||parallelTrips.length)return;
    const index=traffic.ships.findIndex((nav,i)=>nav.phase==='waiting'&&!nav.expired&&shipManifests[i]?.admission);
    if(index<0)return;
    const approval=shipManifests[index]!.admission!;
    stackingMode=approval.strategy;activateShip(index);chooseBerth(approval.berth,false);beginService();
  }
  function update(rawTime:number){if(switchingPort)return;const rawDelta=Math.max(0,rawTime-rawClock);rawClock=rawTime;if(history.paused||operationSummary.paused||exportPreparing){pausedSeconds+=rawDelta;return;}const time=rawTime-pausedSeconds;last=time;if(exportBatch&&!dispatch&&!exportPreparing){void sendExportUnit(exportBatch.ids[0]);}
    if(finished&&tripRecorded&&!dispatch)prepareNextTrip();
    const dt=Math.max(0,time-navigationClock);navigationClock=time;
    // A pending player decision never times out into an automatic rejection.
    traffic.ships.forEach(nav=>{if(nav.phase==='waiting'&&!nav.expired)nav.waitSince+=dt;});
    if(traffic.ships.some((nav,i)=>nav.phase==='waiting'&&cargoCounts[i]>capacity-actualOccupancy()))yardFullSeconds+=Math.min(dt,1);
    seaExport?.tick(time);
    traffic.update(dt,time);
    let activeNavigation=traffic.ships[activeShip];
    for(let i=0;i<ships.length;i++){
      const nav=traffic.ships[i];
      if(seaExport?.index===i)continue;
      if(restoredDepartures.has(i)&&time>=timeoutRetryAt[i]){
        timeoutRetryAt[i]=time+1;
        if(['departing','gone','empty'].includes(nav.phase)||traffic.depart(i))restoredDepartures.delete(i);
      }
      if(nav.expired&&['waiting','departing','gone'].includes(nav.phase)){
        if(!lossRecorded[i]&&!penaltyPending[i]&&time>=penaltyRetryAt[i]){const id=shipManifests[i]?.id;if(id&&session){penaltyPending[i]=true;void session.penalize(id).then(()=>{lossRecorded[i]=true;}).catch(e=>{penaltyRetryAt[i]=last+5;reportError(e);}).finally(()=>penaltyPending[i]=false);}}
        if(nav.phase==='waiting'&&time>=timeoutRetryAt[i]){timeoutRetryAt[i]=time+1;traffic.depart(i);}
      }
      if(nav.phase==='gone'&&lossRecorded[i]){
        cargoCounts[i]=0;cargoIds[i]=[];shipManifests[i]=undefined;ships[i].cargo.forEach(item=>item.mesh.setEnabled(false));
        if(i===activeShip)plan();
        nav.phase='empty';
      }
      if(nav.phase==='gone'&&!cargoCounts[i])nav.phase='empty';
    }
    scheduleArrivals();
    processAcceptedArrival();
    activeNavigation=traffic.ships[activeShip];
    arrivalDirector(world).tick();
    if(session&&time>=nextPollAt&&!loadingCargo&&time>0)void loadLiveCargo();
    if(autoShift&&start<0&&!dispatch&&!settling){
      const waiting=traffic.ships.map((nav,index)=>({nav,index})).filter(({nav,index})=>nav.phase==='waiting'&&!nav.expired&&cargoCounts[index]>0&&cargoCounts[index]<=capacity-actualOccupancy()).sort((a,b)=>shipPriority(b.index)-shipPriority(a.index)||a.nav.waitSince-b.nav.waitSince)[0];
      if(waiting&&waiting.index!==activeShip){activeShip=waiting.index;shipSelect.value=String(activeShip);vesselRoots=ships[activeShip].roots;manifest=ships[activeShip].cargo;chooseBerth(selectedBerth,false);activeNavigation=traffic.ships[activeShip];}
    }
    // Use the scene clock: pausing the scene also pauses the inter-trip queue.
    if(autoShift&&nextTripAt>=0&&time>=nextTripAt&&prepareNextTrip()&&capacity-actualOccupancy()>=jobs.length)nextTripAt=-1;
    if(autoShift&&jobs.length>0&&start<0&&capacity-actualOccupancy()>=jobs.length)beginService();
    if(start>=0&&serviceAt<0&&activeNavigation.phase==='docked')serviceAt=time;
    if(parallelEnabled||parallelTrips.length){updateParallel(time);return;}
    const voyage=start<0?0:time-start;
    elapsed=serviceAt<0?0:Math.min((time-serviceAt)*playbackRate,handlingTicks);
    if(serviceAt>=0&&elapsed>=resourceSchedule.dockReleasedAt&&!departureRequested)departureRequested=traffic.depart(activeShip);
    const arriving=start<0||serviceAt<0,departing=departureRequested;
    vesselOffset.set(activeNavigation.pose.x-berthOrigin.x,0,activeNavigation.pose.z-berthOrigin.z);
    const completed=jobs.filter(j=>elapsed>=j.timing.placedAt).length;
    const aboard=jobs.filter(j=>elapsed<j.timing.liftedAt).length;
    const visibleLevels=[...yardLevels],reserved=Array<number>(36).fill(0);
    for(const job of jobs){if(elapsed>=job.timing.placedAt){if(!exported.has(job.mesh)||dispatch?.record.mesh===job.mesh)visibleLevels[job.cell]++;}else if(start>=0)reserved[job.cell]++;}
    const receivingJob=jobs.find(job=>elapsed>=job.timing.yardLiftedAt&&elapsed<job.timing.placedAt);
    const phase=start<0?(activeNavigation.expired?'Time expired while waiting · Departing':activeNavigation.phase==='entering'?'Vessel approaching':jobs.length?'Choose a berth':'Waiting for new Nansen cargo'):arriving?'Vessel entering berth':departing?(activeNavigation.phase==='gone'?'Vessel departed':'Unloaded · departing'):aboard===0?'Unloaded · waiting for a safe exit route':'Alternating handling';
    inventory.update({levels:visibleLevels.slice(0,capacity/3),reserved:reserved.slice(0,capacity/3),receiving:receivingJob?.cell??null,trip:tripNumber,completed,total:jobs.length,phase});
    finished=start>=0&&elapsed>=handlingTicks&&departureRequested;
    if(finished&&!tripRecorded&&!settling&&time>=settlementRetryAt&&session&&shipManifests[activeShip]){settling=true;void session.complete(shipManifests[activeShip]!.id,jobs.map(j=>({unitId:j.mesh.metadata.unitId,cell:j.cell,level:Math.round((j.slot.y-1.48)/2.05)})),completionMetrics()).then(()=>{ships[activeShip].trips++;ships[activeShip].delivered+=jobs.length;tripRecorded=true;const saved=shipManifests[activeShip]!;history.record({version:1,id:saved.id,rulesVersion:saved.rulesVersion,chain:saved.units[0].chain,berth:selectedBerth,recordedAt:new Date().toISOString(),batchIds:saved.batchIds,cargo:tripCargoSnapshot??cargoSnapshot(saved,jobs,false),schedule:resourceSchedule,ns:saved.rewardNs??saved.units.length*10,waitSeconds:tripWaitSeconds});}).catch(e=>{settlementRetryAt=last+5;reportError(e);}).finally(()=>settling=false);}
    shipSelect.disabled=start>=0||!!dispatch;
    const fleetText=ships.map((ship,i)=>{const n=traffic.ships[i],remaining=i===activeShip&&start>=0?aboard:cargoCounts[i];return `${ship.name}: ${n.phase==='waiting'?(n.expired?'Time expired · Waiting for exit route':`Waiting ${Math.max(0,Math.ceil(WAIT_SECONDS-(time-n.waitSince)))}s`):({empty:arrivalBlocked||'Waiting for data',entering:'Approaching',inbound:'Entering berth',docked:'Unloading',departing:'Departing',gone:'Departed'} as Record<string,string>)[n.phase]} · ${remaining} containers aboard · ${ship.trips} voyages`;}).join(' | ');
    if(schedule.textContent!==fleetText)schedule.textContent=fleetText;
    const occupancy=actualOccupancy(),full=jobs.length>0&&capacity-occupancy<jobs.length;
    const ops=session?.state.operational;
    const opsSummary=ops?` · Shift: +${ops.nsWon} NS / -${ops.nsLost} NS · vessel cancellations ${ops.lostTrips} · exported ${ops.exportedUnits}`:'';
    renderPriorityBoard();
    status.textContent=`${ships[activeShip].name} · NS ${economy.state.ns.toLocaleString('en-US')} · Source ${feedState} · Berth ${berthChoices[selectedBerth].name} · Voyage ${tripNumber} · ${phase} · ${voyage.toFixed(1)} seconds · Handling ${(handlingTicks/playbackRate).toFixed(1)} seconds · On vessel ${aboard}/${jobs.length} · In transit ${jobs.length-aboard-completed} · Stacked ${completed}/${jobs.length} · Yard ${occupancy}/${capacity}${full?' · Yard full':''} · Exported ${exportCount}${opsSummary}`;
    berthSelect.disabled=start>=0||!!dispatch;
    button.disabled=!jobs.length||start>=0||!!dispatch||full||activeNavigation.phase!=='waiting'||activeNavigation.expired;reset.disabled=start<0&&tripNumber===1;
    if(finished&&autoShift){
      if(full){autoShift=false;nextTripAt=-1;}
      else if(nextTripAt<0)nextTripAt=time+interTripDelay;
    }
    if(arrivalBlocked&&!jobs.length)status.textContent+=' · '+arrivalBlocked;
    if(autoShift)status.textContent+=nextTripAt>=0?` · New voyage in ${Math.max(0,Math.ceil(nextTripAt-time))} seconds`:' · Automatically accepting voyages';
    autoButton.disabled=(finished&&full)||!!dispatch;
    autoButton.textContent=autoShift?'Stop accepting new voyages':finished&&full?'Shift complete':'Run full shift';
    autoButton.setAttribute('aria-pressed',String(autoShift));
    next.disabled=!finished||autoShift||!!dispatch;
    dispatchButton.disabled=(start>=0&&!finished)||autoShift||!!dispatch||!!exportBatch||occupancy===0;next.textContent='Receive next vessel';
    shiftSummary.hidden=!full||!!dispatch;
    if(full){
      const summary=`Yard space unavailable for vessel ${jobs.length} containers · ${occupancy}/${capacity}. Open Shop to buy a harbor or export containers to free space.`;
      if(shiftSummary.textContent!==summary)shiftSummary.textContent=summary;
    }
    for(let i=0;i<fleet.length;i++){const f=fleet[i],job=jobs.filter(j=>j.truck===i&&elapsed>=j.timing.approachAt).at(-1);const pose=job?truckPose(job,sampleResourceJob(job.timing,elapsed).truckT):{p:f.garage.clone(),a:f.garage.x<-7?Math.PI/2:-Math.PI/2};f.root.position.copyFrom(pose.p);f.root.rotation.y=pose.a;
      const carrying=!!job&&sampleResourceJob(job.timing,elapsed).carrying;
      for(const carriage of f.root.getChildTransformNodes().filter(n=>n.name.includes('Fork carriage')))carriage.scaling.z=carrying?1:.4;
      if(start>=0){const d=Vector3.Dot(pose.p.subtract(f.previous),new Vector3(Math.sin(pose.a),0,Math.cos(pose.a)));for(const w of f.wheels)w.rotation.x+=d/.5;}f.previous.copyFrom(pose.p);f.angle=pose.a;
    }
    if(jobs.length){
    const dockJob=jobs.filter(j=>elapsed>=j.timing.dockAt).at(-1)??jobs[0],dt=sampleResourceJob(dockJob.timing,elapsed).dockT,dp=dockPose(dockJob,Math.min(dt,dispatchInterval));const dockRigIndex=dockRigIndices[selectedBerth],parkedHook=rigLinks[dockRigIndex].body.position.add(new Vector3(0,3.62,-3));
    const craneReady=0,cranePark=departing?ease((elapsed-resourceSchedule.dockReleasedAt)/.7):0;
    hookPose(dockRigIndex,arriving?Vector3.Lerp(parkedHook,dp.p,craneReady):departing?Vector3.Lerp(dp.p,parkedHook,cranePark):dp.p,arriving?dp.a*craneReady:departing?dp.a*(1-cranePark):dp.a,arriving||departing?0:dp.s);
    for(let yard=0;yard<(economy.state.extraYardCrane?2:1);yard++){const candidates=jobs.filter(j=>(j.timing.yard??0)===yard),yardJob=candidates.filter(j=>elapsed>=j.timing.yardAt).at(-1);if(yardJob){const yt=sampleResourceJob(yardJob.timing,elapsed).yardT,yp=yardPose(yardJob,Math.min(yt,6.4));hookPose(yard===0?1:4,yp.p,yp.a,yp.s);}else hookPose(yard===0?1:4,rigLinks[yard===0?1:4].body.position.add(new Vector3(-2,5,0)),0,0);}
    }else{hookPose(dockRigIndices[selectedBerth],rigLinks[dockRigIndices[selectedBerth]].body.position.add(new Vector3(0,3.62,-3)),0,0);hookPose(1,rigLinks[1].body.position.add(new Vector3(-2,2,0)),0,0);}
    for(const j of jobs){if(exported.has(j.mesh))continue;const sample=sampleResourceJob(j.timing,elapsed);j.mesh.metadata.collisionIgnoreOwners=sample.cargoPhase==='dock'?['crane:'+dockRigIndices[selectedBerth]]:sample.cargoPhase==='truck'?['truck:'+j.truck]:sample.cargoPhase==='yard'?['crane:'+(j.timing.yard===0?1:4)]:[];const t=sample.dockT;if(sample.cargoPhase==='aboard'){j.mesh.position.copyFrom(j.pickup.add(vesselOffset));j.mesh.rotation.y=shipAngle;}
      else if(sample.cargoPhase==='dock'){const p=dockPose(j,t);j.mesh.position.copyFrom(p.p);j.mesh.rotation.y=p.a;}
      else if(sample.cargoPhase==='truck'){const f=fleet[j.truck];j.mesh.position.copyFrom(f.root.position.add(offset(f.angle)));j.mesh.rotation.y=f.angle;}
      else if(sample.cargoPhase==='yard'){const p=yardPose(j,sample.yardT);j.mesh.position.copyFrom(p.p);j.mesh.rotation.y=p.a;}
      else{j.mesh.position.copyFrom(j.slot);j.mesh.rotation.y=0;}
    }
    if(dispatch){
      const d=dispatch,record=d.record,isSea=d.mode==='sea';
      if(isSea&&seaExport?.ready&&d.loadAt===undefined)d.loadAt=time;
      const u=Math.max(0,time-(isSea?(d.loadAt??time):d.start));
      const high=record.slot.clone();high.y=9;
      const handoff=isSea?yardPickup.clone():inlandExport.cargoPosition(4),over=handoff.clone();over.y=9;
      const canLoad=!isSea||d.loadAt!==undefined;
      const truck=isSea?fleet[0]:undefined;
      if(!isSea)inlandExport.update(u);
      const hook=u<3?mix(over,high,u/3):u<4?mix(high,record.slot,u-3):u<5?mix(record.slot,high,u-4):u<6.5?mix(high,over,(u-5)/1.5):u<8?mix(over,handoff,(u-6.5)/1.5):over;
      const handoffYaw=isSea?Math.PI/2:Math.PI;
      const yaw=u<5?0:u<6.5?lerp(0,handoffYaw,(u-5)/1.5):handoffYaw;
      if(canLoad)hookPose(1,hook,yaw,u>=3&&u<8?1:0);
      if(canLoad&&u>=4&&!d.lifted){d.lifted=true;exported.add(record.mesh);}
      if(canLoad&&u>=4&&u<8){record.mesh.position.copyFrom(hook);record.mesh.rotation.y=yaw;}
      if(isSea&&seaExport){
        const berth=berthChoices[seaExport.berth],receipt=berth.receipt;
        const receiveRoot=receipt.subtract(offset(0));
        if(canLoad&&truck){
          const routeT=u<4?-4+7.3*u/4:u<8?3.3:u<11?3.3*(1-(u-8)/3):u<15?0:-4*Math.min(1,(u-15)/4);
          const sampled=truckPose({truck:0},routeT,receiveRoot),pose=sampled.p,angle=sampled.a;
          const distance=Vector3.Dot(pose.subtract(d.previous),new Vector3(Math.sin(angle),0,Math.cos(angle)));truck.wheels.forEach(w=>w.rotation.x+=distance/.5);d.previous.copyFrom(pose);
          truck.root.position.copyFrom(pose);truck.root.rotation.y=angle;truck.angle=angle;
          if(u>=8&&u<11){record.mesh.position.copyFrom(pose.add(offset(angle)));record.mesh.rotation.y=angle;}
        }
        const nav=traffic.ships[seaExport.index],rotation=Matrix.RotationY(nav.pose.a-homeAngle);
        const aboard=Vector3.TransformNormal(homePickups[4].subtract(homeOrigin),rotation).add(new Vector3(nav.pose.x,0,nav.pose.z));
        if(u>=11&&u<15){const lifted=receipt.clone();lifted.y=9;const shipHigh=aboard.clone();shipHigh.y=9;const p=u<12?mix(receipt,lifted,u-11):u<14?mix(lifted,shipHigh,(u-12)/2):mix(shipHigh,aboard,u-14);record.mesh.position.copyFrom(p);record.mesh.rotation.y=lerp(0,nav.pose.a,(u-11)/4);hookPose(dockRigIndices[seaExport.berth],p,record.mesh.rotation.y,1);}
        if(u>=15){record.mesh.position.copyFrom(aboard);record.mesh.rotation.y=nav.pose.a;record.mesh.getChildMeshes().forEach(m=>m.visibility=seaExport!.opacity);seaExport.finishLoading();}
      }else if(u>=8){record.mesh.position.copyFrom(inlandExport.cargoPosition(u));record.mesh.rotation.y=inlandExport.cargoYaw;}
      const delivered=isSea?!!seaExport?.completed:u>=14;
      if(delivered)record.mesh.setEnabled(false);
      status.textContent=isSea?`Sea transfer · ${seaExport?.phase??'Waiting for vessel'} · ${record.mesh.metadata?.token?.symbol??''}`:`Inland delivery · ${u<4?'Truck approaching':u<8?'Yard crane delivering':u<14?'Truck passing gate':'Handover in progress'} · ${Math.min(u,14).toFixed(1)}/14 seconds`;
      if(delivered&&!d.saving&&time>=(d.retryAt??0)&&session){d.saving=true;void session.finishExport(d.reservationId!).then(()=>{if(!jobs.some(j=>j.mesh===record.mesh))yardLevels[record.cell]--;exportCount++;selectedUnitId=undefined;for(let i=storedRecords.length-1;i>=0;i--)if(storedRecords[i].mesh===record.mesh)storedRecords.splice(i,1);seaExport?.dispose();seaExport=undefined;inlandExport.reset();dispatch=null;if(exportBatch){exportBatch.ids.shift();exportBatch.done++;penaltyNotice=`Exported ${exportBatch.done}/${exportBatch.total} containers`;if(!exportBatch.ids.length)exportBatch=null;}if(!exportBatch&&start<0)plan();}).catch(e=>{if(!(e instanceof HarborRequestError)||e.status>=500){d.saving=false;d.retryAt=last+5;reportError(e);return;}void session!.cancelExport(d.reservationId!).catch(reportError);exported.delete(record.mesh);record.mesh.position.copyFrom(d.rest);record.mesh.rotation.setAll(0);record.mesh.setEnabled(true);record.mesh.getChildMeshes().forEach(m=>m.visibility=1);if(seaExport){traffic.depart(seaExport.index);seaExport.dispose();seaExport=undefined;}inlandExport.reset();dispatch=null;exportBatch=null;reportError(e);});}
    }
    for(let berth=0;berth<3;berth++)if(berth!==selectedBerth&&berth!==seaExport?.berth){
      const index=dockRigIndices[berth];hookPose(index,berthCranePositions[berth].add(new Vector3(0,3.62,-3)),0,0);
    }
    const telemetry=resourceTelemetry(resourceSchedule,elapsed);status.textContent+=` · Truck wait for crane ${telemetry.truckWaitingSeconds.toFixed(1)}s · Yard crane wait ${telemetry.yardWaitingSeconds.toFixed(1)}s`;
    if(penaltyNotice)status.textContent+=' · '+penaltyNotice;
    for(let index=0;index<ships.length;index++){
      const ship=ships[index],nav=traffic.ships[index],pose=nav.pose;
      const position=new Vector3(pose.x,0,pose.z),turn=pose.a-homeAngle,rotation=Matrix.RotationY(turn),opacity=traffic.opacity(index);
      ship.roots.forEach((root,i)=>{root.position.copyFrom(position);root.rotationQuaternion=Quaternion.RotationYawPitchRoll(turn,0,0).multiply(homeRotations[i]);});
      fadeShip(ship,opacity);
      ship.cargo.forEach((item,i)=>{
        const job=index===activeShip?jobs.find(j=>j.mesh===item.mesh):undefined;
        const aboard=!job||elapsed<job.timing.liftedAt;
        if(aboard&&dispatch?.record.mesh!==item.mesh){item.mesh.position.copyFrom(Vector3.TransformNormal(homePickups[i].subtract(homeOrigin),rotation).add(position));item.mesh.rotation.y=pose.a;}
        if(dispatch?.record.mesh!==item.mesh)item.mesh.getChildMeshes().forEach(mesh=>mesh.visibility=aboard?opacity:1);
      });
    }
    // Contact foam is authored from the original ship, so it follows that ship even when selection changes.
    const foam=traffic.ships[0];vesselMotion.position.set(foam.pose.x,0,foam.pose.z);
    vesselMotion.forward.set(Math.cos(foam.pose.a),0,-Math.sin(foam.pose.a));
    vesselMotion.angle=foam.pose.a-homeAngle;vesselMotion.speed=foam.speed;vesselMotion.visibility=traffic.opacity(0);
    updateRigLinks();
    signal.limbs[0].rotation.z=-.9-Math.sin(time*3)*.2;yardWorker.limbs[0].rotation.z=-1+Math.sin(time*3)*.2;
    walking.r.position.set(-13.8,1.48,-10.5+Math.sin(time*.3)*.25);walking.r.rotation.y=0;walking.limbs.forEach((limb,i)=>limb.rotation.x=Math.sin(time*5+i*Math.PI/2)*.32);
    driver.limbs[0].rotation.x=driver.limbs[2].rotation.x=-.8;
    savePresentation();
  }
  const auditButton=document.createElement('button');auditButton.textContent='Check routes';uiRoot.querySelector('.controls')!.append(auditButton);
  const auditReport=document.createElement('pre');auditReport.className='collision-report';auditReport.hidden=true;uiRoot.querySelector('#interface')!.append(auditReport);
  auditReport.onclick=()=>auditReport.hidden=true;
  auditButton.onclick=async()=>{
    auditButton.disabled=true;auditReport.hidden=false;auditReport.textContent='Checking route replicas; current shift continues normally…';
    const reports:string[]=[];
    try{
      const obstacles=[
        {name:'left warehouse wall',x:-14.2,z:-19.625,w:.22,d:5.625},
        {name:'right warehouse wall',x:.2,z:-19.625,w:.22,d:5.625},
        {name:'rear warehouse wall',x:-7,z:-25.25,w:7.2,d:.2},
        {name:'left door post',x:-12.65,z:-14,w:1.55,d:.22},
        {name:'right door post',x:-1.35,z:-14,w:1.55,d:.22},
        {name:'apron worker',x:-13.8,z:-10.5,w:.4,d:.65},
        {name:'yard worker',x:14,z:-7.5,w:.4,d:.4},
        ...Array.from({length:capacity/3},(_,cell)=>{const p=slotAt(cell,0);return {name:'container slot '+(cell+1),x:p.x,z:p.z,w:2.45,d:1.05};}),
        ...berthCranePositions.map((p,i)=>({name:'berth crane '+(i+1),x:p.x,z:p.z,w:1.3,d:1.3})),
        {name:'yard crane',x:yardBase.x,z:yardBase.z,w:1.3,d:1.3}
      ].map(o=>({name:o.name,pose:{x:o.x,z:o.z,a:0},halfWidth:o.w,halfDepth:o.d}));
      for(let berth=0;berth<berthChoices.length;berth++){
        const receipt=berthChoices[berth].receipt.subtract(offset(0));
        const profiles=[{truckCount:economy.state.trucks,dockRate:1+economy.state.craneLevels[berth]*.35,yardRate:1+economy.state.craneLevels[3]*.35,label:'current fleet'},
          ...Array.from({length:fleet.length-3},(_,i)=>i+4).flatMap(truckCount=>[0,3].map(level=>({truckCount,dockRate:1+level*.35,yardRate:1+level*.35,label:truckCount+' trucks, crane level '+level})))];
        for(const profile of profiles){
          const result=auditTruckRoute({...profile,obstacles,pose:(truck,t)=>{const v=truckPose({truck},t,receipt);return {x:v.p.x,z:v.p.z,a:v.a};}});
          reports.push('Berth '+(berth+1)+' · '+profile.label+': '+(result.issues.length?result.issues.map(x=>x.name+' ('+x.samples+' samples, first '+x.firstSecond.toFixed(2)+'s)').join('; '):'no intersections detected'));
          await new Promise<void>(resolve=>setTimeout(resolve,0));
        }
        const vessels=auditShipRoutes(berth,ships.map(s=>s.name));
        reports.push('Berth '+(berth+1)+' · vessel: '+vessels.filter(v=>v.ok).length+'/'+vessels.length+' routes available.'+vessels.filter(v=>!v.ok).map(v=>' '+v.ship+' / '+v.scenario+': requires a clear channel.').join(''));
        auditReport.textContent=reports.join('\n');
        await new Promise<void>(resolve=>setTimeout(resolve,0));
      }
      auditReport.textContent='8 containers/voyage · forklifts 4–'+fleet.length+' · '+ships.length+' vessel · '+berthChoices.length+' berth. Forklift sample 0.05s, vessel maximum 0.35m.\n'+reports.join('\n')+'\nIndependent copy; does not change NS, yard, berths, or clock. Bounds include forklifts, containers, and parked vehicles; baseline, maximum, and current crane setups. Unavailable routes wait; they never pass through obstacles. This is sampled geometry checking; it does not prove every motion combination or hydrodynamics. Click the panel to close.';
    }catch(error){auditReport.textContent='Check did not finish: '+String(error)+'\n'+reports.join('\n');}
    finally{auditButton.disabled=false;}
  };
  chooseBerth(0);
  const initialize=()=>connectHarborSession(portId).then(async connected=>{
    session=connected;yardFullSeconds=session.state.operational.yardFullSeconds;exportCount=session.state.operational.exportedUnits;economy.sync(session.state.economy);applyAssets();syncCapacity();
    session.subscribe(state=>{economy.sync(state.economy);applyAssets();syncCapacity();refreshDemands();});
    const checkpoint=session.state.checkpoint as {trips?:RecordedTrip[];runtime?:any}|null;
    recordedTrips=history.restore(checkpoint?.trips);
    economy.bindPurchase(async id=>{await session!.purchase(id);});
    economy.bindEquip(async (equipmentId:EquipmentId,targetPortId)=>{await session!.equipEquipment(equipmentId,targetPortId as 'coral'|'jade');});
    economy.bindUpgrade(async targetPortId=>{await session!.upgradeCapacity(targetPortId as 'coral'|'jade');});
    for(const id of session.state.claimedBatchIds)seenBatches.add(id);
    for(const unit of [...session.state.inventory].sort((a,b)=>(a.level??0)-(b.level??0))){const cell=unit.cell??yardLevels.findIndex((level,i)=>level<3&&i<capacity/3);if(cell<0)break;const mesh=storedCargo.find(m=>!m.isEnabled())!;const level=unit.level??yardLevels[cell];const slot=slotAt(cell,level);yardLevels[cell]=Math.max(yardLevels[cell],level+1);paintCargo(scene,mesh,unit);mesh.metadata={...mesh.metadata,unitId:unit.id};mesh.position.copyFrom(slot);mesh.rotation.setAll(0);mesh.setEnabled(true);storedRecords.push({mesh,cell,slot,initial:false});}
    for(const manifest of session.state.manifests.filter(m=>m.status==='claimed')){const index=CHAINS.findIndex(c=>c.id===manifest.units[0]?.chain);if(index<0)continue;shipManifests[index]=manifest;for(const id of manifest.batchIds){const units=manifest.units.filter(u=>u.batchId===id);pendingBatches.push({id,chain:units[0].chain,eventAt:manifest.createdAt,tokens:units.map(u=>({address:u.address,symbol:u.symbol,count:1}))});}}
    const runtime=checkpoint?.runtime;
    if(runtime?.version===1&&Number.isFinite(runtime.time)&&runtime.time>=0&&Number.isInteger(runtime.activeShip)&&runtime.activeShip>=0&&runtime.activeShip<ships.length&&Number.isInteger(runtime.selectedBerth)&&runtime.selectedBerth>=0&&runtime.selectedBerth<3&&Array.isArray(runtime.traffic)&&Array.isArray(runtime.manifests)){
      last=runtime.time;pausedSeconds=-last;navigationClock=last;nextCheckpoint=last+2;nextArrivalAt=Math.max(last,Number(runtime.nextArrivalAt)||last);
      const departuresToResume:number[]=[];
      for(let index=0;index<ships.length;index++){
        const saved=shipManifests[index],id=runtime.manifests[index],nav=runtime.traffic[index];
        const known=session.state.manifests.find(m=>m.id===id);
        if(saved&&saved.id===id&&nav?.phase!=='empty'&&traffic.restore(index,nav)){
          const count=saved.units.length,slots=[...ships[index].cargo.slice(0,Math.max(0,count-4)),...ships[index].cargo.slice(4,4+Math.min(4,count))];
          saved.units.forEach((unit,i)=>{paintCargo(scene,slots[i].mesh,unit);slots[i].mesh.metadata={...slots[i].mesh.metadata,unitId:unit.id,batchId:unit.batchId};});
          ships[index].cargo.forEach(c=>c.mesh.setEnabled(slots.includes(c)));cargoCounts[index]=count;cargoIds[index]=saved.batchIds;
          for(let i=pendingBatches.length-1;i>=0;i--)if(saved.batchIds.includes(pendingBatches[i].id))pendingBatches.splice(i,1);
        }else if(!saved&&['departing','docked','waiting'].includes(nav?.phase)&&(known&&known.status!=='claimed'||nav.phase==='departing'||Array.isArray(runtime.departures)&&runtime.departures.includes(index))&&traffic.restore(index,nav)){if(nav.phase!=='departing')departuresToResume.push(index);}
      }
      // Route only after every saved vessel occupies its restored position.
      for(const index of departuresToResume)if(!traffic.depart(index))restoredDepartures.add(index);
      activeShip=runtime.activeShip;shipSelect.value=String(activeShip);vesselRoots=ships[activeShip].roots;manifest=ships[activeShip].cargo;chooseBerth(runtime.selectedBerth,false);
      if(cargoCounts[activeShip]>0&&shipManifests[activeShip]?.id===runtime.manifests[activeShip]&&Number.isFinite(runtime.start)&&runtime.start>=0&&runtime.start<=last&&Number.isFinite(runtime.serviceAt)&&runtime.serviceAt<=last){tripCargoSnapshot=restoreCargoSnapshot(runtime.tripCargoSnapshot,shipManifests[activeShip]!);start=runtime.start;serviceAt=runtime.serviceAt;departureRequested=runtime.departureRequested===true;}
      autoShift=false;tripNumber=Math.max(1,Number(runtime.tripNumber)||1);tripWaitSeconds=Math.max(0,Number(runtime.tripWaitSeconds)||0);
    }
    for(let i=0;i<traffic.ships.length;i++)if(shipManifests[i]?.status==='claimed'&&traffic.ships[i].phase==='waiting'){traffic.ships[i].expired=false;traffic.ships[i].waitSince=last;}
    stackingMode=shipManifests[activeShip]?.admission?.strategy??'priority';
    const recovery=session.state.exportReservations.filter(r=>r.status==='reserved'&&(!r.portId||r.portId===portId));
    // Resume the one-unit export without awarding it until its animation completes.
    const first=recovery[0];if(first){const record=storedRecords.find(r=>r.mesh.metadata.unitId===first.unitIds[0]);if(record){const placement=first.placements?.find(p=>p.unitId===record.mesh.metadata.unitId);if(placement){record.cell=placement.cell;record.slot=slotAt(placement.cell,placement.level);record.mesh.position.copyFrom(record.slot);}const mode=first.mode??'inland';const ship=CHAINS.findIndex(c=>c.id===canonicalChain(record.mesh.metadata?.token?.chain));if(mode==='sea'&&ship>=0){const nav=traffic.ships[ship];nav.phase='empty';nav.route=null;nav.berth=null;ships[ship].cargo.forEach(c=>c.mesh.setEnabled(false));seaExport=createSeaExport(traffic,ship,selectedBerth);}dispatch={mode,ship,record,start:last,rest:record.mesh.position.clone(),lifted:false,previous:fleet[0].garage.clone(),requestId:first.id,reservationId:first.id,demandId:first.demandId};}}
    for(const reservation of recovery.slice(1))await session.cancelExport(reservation.id);
    plan();if(start>=0&&!tripCargoSnapshot&&shipManifests[activeShip])tripCargoSnapshot=cargoSnapshot(shipManifests[activeShip]!,jobs,false);await loadLiveCargo();
  }).catch(e=>{reportError(e);feedButton.textContent='Reconnect session';feedButton.onclick=()=>{if(!session)void initialize();else{feedStatus.hidden=!feedStatus.hidden;void loadLiveCargo();}};});
  autoButton.onclick=()=>arrivalDirector(world).tick();
  parallelButton.onclick=()=>arrivalDirector(world).tick();
  const ready=initialize();
  const feedReady=ready.then(()=>{if(!session)throw new Error('Unable to connect to the harbor.');});
  return {ready,feedReady,economy,purchase:shop.purchase,equipEquipment:(equipmentId:EquipmentId,targetPortId:string)=>economy.equip(equipmentId,targetPortId),upgradeCapacity:(targetPortId:string)=>economy.upgradeCapacity(targetPortId),get hudSnapshot(){return {feed:feedState,used:actualOccupancy(),capacity,inventory:session?.state.inventory??[],records:recordedTrips,ships:traffic.ships.map((nav,i)=>({id:CHAINS[i].id,name:ships[i].name,x:nav.pose.x,z:nav.pose.z,angle:nav.pose.a,visible:traffic.opacity(i)>.05,phase:nav.phase})),trucks:economy.state.trucks,cranes:4+(economy.state.extraYardCrane?1:0),craneLevels:economy.state.craneLevels};},update,refresh:()=>session?.refresh(),get activePort(){return economy.state.activePort??"coral";},get portLevel(){return economy.state.portIndex;},meshes:scene.meshes.filter(m=>!before.has(m)),vesselRoots:ships.flatMap(ship=>ship.roots),contactRoots:ships[0].roots,vesselOffset,vesselMotion,chooseBerth};
}









