import {canonicalChain, canonicalAddress, tokenIdentity, hasNansenProvenance} from '../src/study/chains';
import type { Plugin } from 'vite';
import { createHash, randomUUID, createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { PORTS, NEW_PORT, type EquipmentId, type EquipmentAssignment, type EquipmentInventory } from '../src/study/economy';
import { isHarborChain } from '../src/study/chains';
import type { CargoBatch } from '../src/study/cargoFeed';
import type { ExportReservation, HarborManifest, HarborOperationalSummary, HarborPlacement, HarborResult, HarborSnapshot, HarborUnit } from '../src/study/harborSession';

// Structural subset of HarborDemand; frozen server feed terms, never accepted from POST.
export type DemandTerm = { id:string; chain:HarborUnit['chain']; tokenAddress:string; tokenSymbol:string; quantity:number; premiumBps:number; expiresAt:string; observedAt:string; provenance:CargoBatch['provenance'] };
type PortSave=Pick<HarborSnapshot,'inventory'|'manifests'|'exportReservations'|'operational'|'checkpoint'> & {equipment:Pick<HarborSnapshot['economy'],'portIndex'|'trucks'|'craneLevels'|'extraYardCrane'>};
type SavedSession = HarborSnapshot & { ports?:Record<string,PortSave>; requests:Record<string,{fingerprint:string;manifestId?:string;reservationId?:string;receiptId?:string}> };
type Database = { version:1; sessions:Record<string,SavedSession>; batches:Record<string,CargoBatch>; demands:Record<string,DemandTerm> };
class HarborError extends Error { constructor(message:string,public status=400){super(message);} }
function assert(condition:unknown,message:string):asserts condition{if(!condition)throw new HarborError(message);}
const identifier=(value:unknown):value is string=>typeof value==='string'&&/^[A-Za-z0-9:_.,-]{1,200}$/.test(value)&&!['__proto__','constructor','prototype'].includes(value);
const copy=<T>(value:T):T=>structuredClone(value);
const own=(object:object,key:string)=>Object.prototype.hasOwnProperty.call(object,key);
function ensureSessionEquipment(session:SavedSession){ const economy=session.economy as SavedSession['economy'] & {equipmentInventory?:EquipmentInventory;equipmentAssignments?:Record<string,EquipmentAssignment>}; economy.equipmentInventory??={forklifts:0,yardCranes:0}; economy.equipmentAssignments??={coral:{forklifts:4,yardCranes:1}}; for(const id of economy.ownedPorts??['coral']) economy.equipmentAssignments[id]??={forklifts:4,yardCranes:1}; }
function snapshot(session:SavedSession):HarborSnapshot { ensureSessionEquipment(session); const {requests,ports,...state}=session;
  const current=session.economy.activePort??'coral';
  const portSummaries=(session.economy.ownedPorts??['coral']).map(id=>{const p=id===current?portSave(session):ports?.[id];return {id,capacity:PORTS[p?.equipment.portIndex??0].capacity,stored:p?.inventory.length??0,queued:p?.manifests.filter(m=>m.status==='claimed').length??0,trucks:p?.equipment.trucks??4};});
  return copy({...state,portSummaries}); }
/** Materialize one port inside the serialized transaction, retaining global NS,
 * request receipts and consumed batches. Never shares mutable fleet equipment. */
function selectPort(session:SavedSession,id:string){
  assert(id==='coral'||id==='jade','Unknown port');
  assert((session.economy.ownedPorts??['coral']).includes(id),'Harbor is not owned');
  const current=session.economy.activePort??'coral';if(current===id)return;
  session.ports??={};session.ports[current]=portSave(session);const target=session.ports[id];assert(target,'Missing port save');
  session.inventory=copy(target.inventory);session.manifests=copy(target.manifests);session.exportReservations=copy(target.exportReservations);session.operational=copy(target.operational);session.checkpoint=copy(target.checkpoint);
  Object.assign(session.economy,copy(target.equipment),{activePort:id});
}
function portSave(s:SavedSession):PortSave{return copy({inventory:s.inventory,manifests:s.manifests,exportReservations:s.exportReservations,operational:s.operational,checkpoint:s.checkpoint,equipment:{portIndex:s.economy.portIndex,trucks:s.economy.trucks,craneLevels:s.economy.craneLevels,extraYardCrane:s.economy.extraYardCrane}});}
const freshOperational=():HarborOperationalSummary=>({vesselWaitSeconds:0,truckWaitSeconds:0,craneWaitSeconds:0,yardCraneQueueSeconds:0,handlingSeconds:0,measuredTrips:0,metricsSince:new Date().toISOString(),yardFullSeconds:0,exportedUnits:0,completedTrips:0,lostTrips:0,nsWon:0,nsLost:0});
function fresh():SavedSession{return {revision:0,economy:{ns:0,portIndex:0,trucks:4,craneLevels:[0,0,0,0],extraYardCrane:false,receipts:[],equipmentInventory:{forklifts:0,yardCranes:0},equipmentAssignments:{coral:{forklifts:4,yardCranes:1}}},inventory:[],manifests:[],claimedBatchIds:[],demandProgress:{},exportReservations:[],operational:freshOperational(),checkpoint:null,updatedAt:new Date().toISOString(),requests:{}};}
function placeUnits(session:SavedSession,units:HarborUnit[],placements?:HarborPlacement[]){
  const cells=PORTS[session.economy.portIndex].capacity/3;
  const occupied=new Map<number,number>();
  for(const unit of session.inventory){assert(Number.isInteger(unit.cell)&&Number.isInteger(unit.level),'Inventory placement missing');occupied.set(unit.cell!,Math.max(occupied.get(unit.cell!)??0,unit.level!+1));}
  const reservedIds=new Set(session.exportReservations.filter(r=>r.status==='reserved').flatMap(r=>r.unitIds));
  const reservedCells=new Set(session.inventory.filter(u=>reservedIds.has(u.id)).map(u=>u.cell));
  if(placements)assert(placements.length===units.length&&placements.every(p=>p&&typeof p==='object')&&new Set(placements.map(p=>p.unitId)).size===units.length,'Placements must cover every unit once');
  const result:HarborUnit[]=[];
  const ordered=placements?[...units].sort((a,b)=>(placements.find(p=>p.unitId===a.id)?.level??0)-(placements.find(p=>p.unitId===b.id)?.level??0)):units;
  for(const unit of ordered){
    const placement=placements?.find(p=>p.unitId===unit.id);
    if(placements)assert(placement,'Unknown placement unit');
    const cell=placement?.cell??Array.from({length:cells},(_,i)=>i).find(i=>(occupied.get(i)??0)<3&&!reservedCells.has(i));
    assert(cell!==undefined&&Number.isInteger(cell)&&cell>=0&&cell<cells&&!reservedCells.has(cell),'Invalid or reserved yard cell');
    const level=placement?.level??occupied.get(cell)??0;
    assert(Number.isInteger(level)&&level===(occupied.get(cell)??0)&&level<3,'Placement overlaps or leaves a stack gap');
    occupied.set(cell,level+1);result.push({...unit,cell,level});
  }return units.map(unit=>result.find(placed=>placed.id===unit.id)!);
}
function assertTop(session:SavedSession,units:HarborUnit[]){const selected=new Set(units.map(u=>u.id));for(const unit of units)assert(!session.inventory.some(other=>other.cell===unit.cell&&other.level!>unit.level!&&!selected.has(other.id)),'Only top containers can export');}
function validProvenance(value:unknown){const p=value as CargoBatch['provenance'];return !!p&&p.provider==='nansen'&&(p.endpoint==='tgm/transfers'||p.endpoint==='tgm/dex-trades')&&typeof p.transactionHash==='string'&&p.transactionHash.length>0&&typeof p.observedAt==='string'&&Number.isFinite(Date.parse(p.observedAt))&&typeof p.windowFrom==='string'&&typeof p.windowTo==='string'&&p.sampled===true;}

/** Single-process local JSON adapter. Writes serialize through one queue and rename
 * a flushed temporary file. Run one Vite process per save path; this is not a
 * multi-process database or authenticated multiplayer anti-cheat service. */
export function createHarborStore(path=resolve(process.cwd(),'.data/harbor-state-v1.json')) {
  let database:Database|undefined;let queue:Promise<unknown>=Promise.resolve();
  function ensureEquipment(session:SavedSession){
    const economy=session.economy as SavedSession['economy'] & {equipmentInventory?:EquipmentInventory;equipmentAssignments?:Record<string,EquipmentAssignment>};
    economy.equipmentInventory??={forklifts:0,yardCranes:0};
    economy.equipmentAssignments??={coral:{forklifts:4,yardCranes:1}};
    economy.equipmentAssignments.coral??={forklifts:4,yardCranes:1};
    for(const id of economy.ownedPorts??['coral']) economy.equipmentAssignments[id]??={forklifts:4,yardCranes:1};
  }
  function savedPort(session:SavedSession,id:string):PortSave{
    const current=session.economy.activePort??'coral';
    if(id===current)return portSave(session);
    const saved=session.ports?.[id];assert(saved,`Missing port save for ${id}`);return saved;
  }
  function equip(session:SavedSession,equipmentId:EquipmentId,targetId:string){
    ensureEquipment(session);assert((session.economy.ownedPorts??['coral']).includes(targetId),'Harbor is not owned');
    const key=equipmentId==='forklift'?'forklifts':'yardCranes';const inventory=session.economy.equipmentInventory!;assert(inventory[key]>0,'Equipment is no longer in storage');
    const target=savedPort(session,targetId);const assignment=session.economy.equipmentAssignments![targetId]??={forklifts:4,yardCranes:1};
    if(equipmentId==='forklift'){const max=PORTS[target.equipment.portIndex].maxTrucks;assert(target.equipment.trucks<max,'Harbor has reached its forklift limit');target.equipment.trucks++;assignment.forklifts++;}
    else {assert(!target.equipment.extraYardCrane,'Harbor already has a yard crane');target.equipment.extraYardCrane=true;assignment.yardCranes++;}
    inventory[key]--;
    if(targetId===(session.economy.activePort??'coral')){session.economy.trucks=target.equipment.trucks;session.economy.extraYardCrane=target.equipment.extraYardCrane;}
  }
  function upgradePort(session:SavedSession,targetId:string){
    assert((session.economy.ownedPorts??['coral']).includes(targetId),'Harbor is not owned');
    const target=savedPort(session,targetId);const current=target.equipment.portIndex;const next=PORTS[current+1];
    assert(next,'Harbor has reached maximum capacity');assert(session.economy.ns>=next.price,'Not enough NS to upgrade capacity');
    session.economy.ns-=next.price;target.equipment.portIndex=current+1;
    if(targetId===(session.economy.activePort??'coral'))session.economy.portIndex=target.equipment.portIndex;
  }
  async function load(){
    if(database)return database;
    try{const parsed=JSON.parse(await readFile(path,'utf8'));
      if(parsed.version!==1||!parsed.sessions||!parsed.batches||!parsed.demands)throw new Error('Unsupported harbor save');
      for(const session of Object.values(parsed.sessions) as SavedSession[]){
        ensureEquipment(session);
        session.exportReservations??=[];
        session.operational={...freshOperational(),...(session.operational??{})};
        if(session.inventory.some(unit=>unit.cell===undefined||unit.level===undefined))session.inventory=session.inventory.map((unit,index)=>({...unit,cell:Math.floor(index/3),level:index%3}));
      }database=parsed;
    }catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;database={version:1,sessions:{},batches:{},demands:{}};}
    return database!;
  }
  async function persist(next:Database){
    await mkdir(dirname(path),{recursive:true});const temporary=path+'.'+randomUUID()+'.tmp';
    try{const file=await open(temporary,'wx');try{await file.writeFile(JSON.stringify(next));await file.sync();}finally{await file.close();}await rename(temporary,path);database=next;}
    catch(error){await unlink(temporary).catch(()=>{});throw error;}
  }
  function serial<T>(work:(db:Database)=>Promise<T>){const result=queue.then(async()=>work(await load()));queue=result.catch(()=>{});return result;}
  return {
    registerBatches(batches:CargoBatch[]){return serial(async db=>{
      const next=copy(db);let changed=false;
      for(const batch of batches){
        assert(identifier(batch.id)&&isHarborChain(batch.chain)&&Array.isArray(batch.tokens),'Invalid registered cargo');
        assert(batch.tokens.length>0&&Number.isFinite(Date.parse(batch.eventAt))&&validProvenance(batch.provenance)&&batch.tokens.every(t=>typeof t.address==='string'&&t.address.length<=200&&typeof t.symbol==='string'&&t.symbol.length<=32&&Number.isInteger(t.count)&&t.count>0),'Invalid registered tokens');
        assert(batch.tokens.reduce((sum,t)=>sum+t.count,0)<=8,'Registered batch exceeds vessel capacity');
        if(!own(next.batches,batch.id)){next.batches[batch.id]=copy(batch);changed=true;}
      }
      if(changed)await persist(next);
    });},
    registerDemands(demands:DemandTerm[]){return serial(async db=>{
      const next=copy(db);let changed=false;
      for(const demand of demands){if(Number.isFinite(Date.parse(demand.expiresAt))&&Date.parse(demand.expiresAt)<=Date.now())continue;assert(identifier(demand.id)&&isHarborChain(demand.chain)&&typeof demand.tokenAddress==='string'&&typeof demand.tokenSymbol==='string'&&Number.isInteger(demand.quantity)&&demand.quantity>0&&demand.quantity<=108&&Number.isInteger(demand.premiumBps)&&demand.premiumBps>=0&&demand.premiumBps<=2500&&Number.isFinite(Date.parse(demand.observedAt))&&Number.isFinite(Date.parse(demand.expiresAt))&&Date.parse(demand.expiresAt)>Date.now()&&Date.parse(demand.expiresAt)-Date.now()<=86400000&&validProvenance(demand.provenance),'Invalid registered demand');
        if(!own(next.demands,demand.id)){next.demands[demand.id]=copy(demand);changed=true;}
      }if(changed)await persist(next);
    });},
    recoverLocal(){return serial(async db=>{const candidates=Object.entries(db.sessions).filter(([,s])=>(s.economy.ownedPorts??[]).includes('jade')).sort((a,b)=>b[1].updatedAt.localeCompare(a[1].updatedAt));return candidates[0]?.[0]??null;});},
    read(sessionId:string,portId?:string){return serial(async db=>{if(!own(db.sessions,sessionId)){const next=copy(db);next.sessions[sessionId]=fresh();await persist(next);}const view=copy(database!.sessions[sessionId]);if(portId)selectPort(view,portId);return {state:snapshot(view)};});},
    mutate(sessionId:string,input:Record<string,unknown>){return serial(async db=>{
      assert(identifier(input.requestId),'Missing request ID');const requestId=input.requestId;
      assert(typeof input.action==='string','Missing action');
      const next=copy(db);const session=next.sessions[sessionId]??(next.sessions[sessionId]=fresh());ensureSessionEquipment(session);
      const presentationPort=session.economy.activePort??'coral';
      if(input.portId!==undefined&&input.action!=='switchPort'){assert(typeof input.portId==='string','Invalid port');selectPort(session,input.portId);}
      session.operational={...freshOperational(),...(session.operational??{})};
      const rawFingerprint=JSON.stringify(input),fingerprint=createHash('sha256').update(rawFingerprint).digest('hex');
      if(own(session.requests,requestId)){
        const previous=session.requests[requestId];assert(previous.fingerprint===fingerprint||previous.fingerprint===rawFingerprint,'Request ID reused for a different action');
        return {state:snapshot(session),manifest:session.manifests.find(m=>m.id===previous.manifestId)??Object.values(session.ports??{}).flatMap(p=>p.manifests).find(m=>m.id===previous.manifestId),reservation:session.exportReservations.find(r=>r.id===previous.reservationId),receiptId:previous.receiptId};
      }
      let manifest:HarborManifest|undefined,reservation:ExportReservation|undefined,receiptId:string|undefined;
      assert((input.activePort??'coral')===(session.economy.activePort??'coral'),'Active harbor changed in another tab. Reload before continuing.');
      if(input.action==='claim'){
        assert(Array.isArray(input.batchIds)&&input.batchIds.length>0&&input.batchIds.length<=8&&input.batchIds.every(identifier),'Invalid batch IDs');
        const batchIds=[...new Set(input.batchIds as string[])];
        assert(batchIds.every(id=>own(next.batches,id)&&!session.claimedBatchIds.includes(id)),'Batch unavailable or already claimed');
        const batches=batchIds.map(id=>next.batches[id]);assert(batches.every(b=>b.chain===batches[0].chain),'A manifest must have one chain');
        const units:HarborUnit[]=[];const id=randomUUID();
        for(const batch of batches)for(const token of batch.tokens)for(let n=0;n<token.count;n++)units.push({id:`${id}:${units.length}`,batchId:batch.id,chain:batch.chain,address:token.address,symbol:token.symbol,eventAt:batch.eventAt,provenance:copy(batch.provenance)});
        assert(units.length>0&&units.length<=8,'Vessel capacity exceeded');
        assert(session.manifests.filter(m=>m.status==='claimed').length<5,'Five manifests are already active');
        const createdAt=new Date().toISOString();manifest={id,batchIds,units,status:'claimed',createdAt,penaltyEligibleAt:new Date(Date.now()+15000).toISOString(),rulesVersion:'harbor-v1',rewardNs:units.length*10,penaltyNs:20};session.manifests.push(manifest);session.claimedBatchIds.push(...batchIds);
      }else if(input.action==='acceptArrival'){
        assert(typeof input.manifestId==='string','Missing manifest');
        manifest=session.manifests.find(m=>m.id===input.manifestId);
        assert(manifest?.status==='claimed'&&!manifest.admission,'Arrival already decided');
        const plan=input.plan as import('../src/study/harborSession').ArrivalPlan;
        assert(plan&&(plan.portId==='coral'||plan.portId==='jade')&&Number.isInteger(plan.berth)&&plan.berth>=0&&plan.berth<3&&['priority','compact','balanced'].includes(plan.strategy),'Invalid arrival plan');
        const source=session.economy.activePort??'coral';
        if(plan.portId!==source){
          session.manifests=session.manifests.filter(m=>m.id!==manifest!.id);
          selectPort(session,plan.portId);
          assert(!session.manifests.some(m=>m.status==='claimed'&&m.units[0]?.chain===manifest!.units[0]?.chain),'Destination already has a vessel for this chain');
          session.manifests.push(manifest);
        }
        const reserved=session.manifests.filter(m=>m.status==='claimed'&&m.admission).reduce((n,m)=>n+m.units.length,0);
        assert(session.inventory.length+reserved+manifest.units.length<=PORTS[session.economy.portIndex].capacity,'Not enough yard space');
        manifest.admission=copy(plan);
        if(plan.portId!==source)selectPort(session,source);
      }else if(input.action==='complete'||input.action==='penalize'||input.action==='rejectArrival'){
        assert(typeof input.manifestId==='string','Missing manifest');manifest=session.manifests.find(m=>m.id===input.manifestId);assert(manifest,'Unknown manifest');
        if(input.action==='rejectArrival')assert(!manifest.admission,'Accepted arrival cannot be cancelled');
        const target=input.action==='complete'?'completed':'penalized';
        assert(manifest.status==='claimed'||manifest.status===target,'Manifest already settled');
        receiptId=`${input.action}:${manifest.id}`;
        if(manifest.status==='claimed'){
          if(target==='completed'&&input.metrics!==undefined){
            const metrics=input.metrics as Record<string,unknown>;
            assert(metrics&&typeof metrics==='object','Invalid completion metrics');
            const keys=['vesselWaitSeconds','truckWaitSeconds','craneWaitSeconds','yardCraneQueueSeconds','handlingSeconds'] as const;
            for(const key of keys)assert(typeof metrics[key]==='number'&&Number.isFinite(metrics[key])&&metrics[key]>=0&&metrics[key]<=86400,'Invalid completion metrics');
            for(const key of keys)session.operational[key]+=metrics[key] as number;
            session.operational.measuredTrips++;
          }
          if(target==='completed'){assert(session.inventory.length+manifest.units.length<=PORTS[session.economy.portIndex].capacity,'Yard capacity exceeded');if(input.placements!==undefined)assert(Array.isArray(input.placements),'Invalid placements');session.inventory.push(...placeUnits(session,manifest.units,input.placements as HarborPlacement[]|undefined));const reward=manifest.rewardNs??manifest.units.length*10;session.economy.ns+=reward;session.operational.completedTrips++;session.operational.nsWon+=reward;}
          else {assert(input.action==='rejectArrival'||Date.now()>=Date.parse(manifest.penaltyEligibleAt??new Date(Date.parse(manifest.createdAt)+15000).toISOString()),'Voyage waiting period has not ended');const penalty=manifest.penaltyNs??20;const paid=Math.min(session.economy.ns,penalty);if(input.action==='rejectArrival')assert(input.expectedPenalty===paid,'Balance changed. Go back and confirm the updated cancellation fee.');session.economy.ns-=paid;session.operational.lostTrips++;session.operational.nsLost+=paid;}
          manifest.status=target;session.economy.receipts.push(receiptId);
        }
      }else if(input.action==='export'||input.action==='reserveExport'){
        assert(Array.isArray(input.inventoryIds)&&input.inventoryIds.length>0&&input.inventoryIds.length<=8&&input.inventoryIds.every(identifier),'Invalid inventory IDs');
        const ids=new Set(input.inventoryIds as string[]);assert(ids.size===input.inventoryIds.length,'Duplicate inventory IDs');
        const units=session.inventory.filter(unit=>ids.has(unit.id));assert(units.length===ids.size,'Inventory already exported or missing');
        assertTop(session,units);
        assert(units.every(hasNansenProvenance),'Container has no Nansen provenance and cannot be exported');
        assert(input.mode!=='sea'||new Set(units.map(u=>canonicalChain(u.chain))).size===1,'Sea export must use one chain');
        assert(!session.exportReservations.some(r=>r.status==='reserved'&&r.unitIds.some(id=>ids.has(id))),'Inventory export already reserved');
        let bonus=0;
        if(input.demandId!==undefined){assert(typeof input.demandId==='string'&&own(next.demands,input.demandId),'Unknown demand');const demand=next.demands[input.demandId];
          assert(Date.parse(demand.expiresAt)>Date.now(),'Demand expired');
          assert(units.every(unit=>tokenIdentity(unit.chain,unit.address)===tokenIdentity(demand.chain,demand.tokenAddress)),'Cargo does not match demand');
          const fulfilled=session.demandProgress[demand.id]??0;
          const reserved=session.exportReservations.filter(r=>r.status==='reserved'&&r.demandId===demand.id).reduce((sum,r)=>sum+r.unitIds.length,0);
          assert(fulfilled+reserved+units.length<=demand.quantity,'Demand quantity exceeded');
          bonus=units.length*Math.ceil(10*demand.premiumBps/10000);
          if(input.action==='export')session.demandProgress[demand.id]=fulfilled+units.length;
        }
        if(input.action==='reserveExport'){assert(input.mode===undefined||input.mode==='inland'||input.mode==='sea','Invalid delivery mode');assert(input.portId===undefined||input.portId==='coral'||input.portId==='jade','Invalid port');assert(input.placements===undefined||Array.isArray(input.placements)&&input.placements.length===ids.size,'Invalid placements');reservation={id:randomUUID(),unitIds:[...ids],demandId:input.demandId as string|undefined,bonus,mode:(input.mode??'inland') as 'inland'|'sea',portId:session.economy.activePort??'coral',placements:units.map(u=>({unitId:u.id,cell:u.cell!,level:u.level!})),status:'reserved',createdAt:new Date().toISOString()};session.exportReservations.push(reservation);}
        else {session.inventory=session.inventory.filter(unit=>!ids.has(unit.id));session.economy.ns+=bonus;receiptId=`export:${requestId}`;session.economy.receipts.push(receiptId);session.operational.exportedUnits+=units.length;session.operational.nsWon+=bonus;}
      }else if(input.action==='finishExport'||input.action==='cancelExport'){
        assert(typeof input.reservationId==='string','Missing reservation');reservation=session.exportReservations.find(r=>r.id===input.reservationId);assert(reservation,'Unknown reservation');assert(!reservation.portId||reservation.portId===(session.economy.activePort??'coral'),'Reservation belongs to another port');
        const target=input.action==='finishExport'?'completed':'cancelled';assert(reservation.status==='reserved'||reservation.status===target,'Reservation already settled');
        if(reservation.status==='reserved'){
          if(target==='completed'){
            const ids=new Set(reservation.unitIds);const units=session.inventory.filter(u=>ids.has(u.id));assert(units.length===ids.size,'Reserved inventory missing');assert(!reservation.placements||reservation.placements.every(p=>units.some(u=>u.id===p.unitId&&u.cell===p.cell&&u.level===p.level)),'Reserved placement changed');assertTop(session,units);
            session.inventory=session.inventory.filter(u=>!ids.has(u.id));session.economy.ns+=reservation.bonus;
            if(reservation.demandId)session.demandProgress[reservation.demandId]=(session.demandProgress[reservation.demandId]??0)+units.length;
            receiptId=`export:${reservation.id}`;session.economy.receipts.push(receiptId);session.operational.exportedUnits+=units.length;session.operational.nsWon+=reservation.bonus;
          }reservation.status=target;
        }
      }else if(input.action==='purchase'){
        assert(typeof input.offerId==='string','Missing offer');const id=input.offerId;let price:number|undefined;let apply:()=>void=()=>{};
        if(id==='harbor:jade'){assert(!(session.economy.ownedPorts??['coral']).includes('jade'),'Harbor already owned');price=NEW_PORT.price;apply=()=>{session.economy.ownedPorts=[...(session.economy.ownedPorts??['coral']),'jade'];session.ports??={};session.ports.jade=portSave(fresh());};}
        else if(id==='yard-crane'){const owned=(session.economy.ownedPorts??['coral']).length;const count=(session.economy.equipmentInventory?.yardCranes??0)+Object.values(session.economy.equipmentAssignments??{}).reduce((n,a)=>n+(a?.yardCranes??0),0)-owned;assert((session.economy.equipmentInventory?.yardCranes??0)<owned,'Each harbor can have only one yard crane');price=5000+Math.max(0,count)*2500;apply=()=>{session.economy.equipmentInventory!.yardCranes++;equip(session,'yard-crane',session.economy.activePort??'coral');};}
        else if(id==='truck'){const purchased=Object.values(session.economy.equipmentAssignments??{}).reduce((n,a)=>n+(a?.forklifts??0),0)+(session.economy.equipmentInventory?.forklifts??0)-4;price=[800,1400,2400,4000][Math.max(0,purchased)]??4000;apply=()=>{session.economy.equipmentInventory!.forklifts++;equip(session,'forklift',session.economy.activePort??'coral');};}
        else if(/^crane:[0-3]$/.test(id)){const crane=Number(id.slice(6));const level=session.economy.craneLevels[crane];assert(level<3,'Crane maximum reached');price=[1000,2200,4500][level];apply=()=>{session.economy.craneLevels[crane]++;};}
        assert(price!==undefined,'Unknown offer');assert(session.economy.ns>=price,'Not enough NS.');session.economy.ns-=price;apply();receiptId=`purchase:${requestId}`;session.economy.receipts.push(receiptId);
      }else if(input.action==='equipEquipment'){
        assert(input.equipmentId==='forklift'||input.equipmentId==='yard-crane','Unknown equipment');assert(typeof input.targetPortId==='string','Missing target port');equip(session,input.equipmentId as EquipmentId,input.targetPortId);receiptId=`equip:${requestId}`;session.economy.receipts.push(receiptId);
      }else if(input.action==='upgradePortCapacity'){
        assert(typeof input.targetPortId==='string','Missing target port');upgradePort(session,input.targetPortId);receiptId=`upgrade:${requestId}`;session.economy.receipts.push(receiptId);
      }else if(input.action==='switchPort'){
        const id=input.portId;assert(id==='coral'||id==='jade','Unknown port');
        assert((session.economy.ownedPorts??['coral']).includes(id),'Harbor is not owned');
        assert(!session.exportReservations.some(r=>r.status==='reserved'),'Wait for container exports to finish');
        const current=session.economy.activePort??'coral';
        if(id!==current){session.ports??={};session.ports[current]=portSave(session);const target=session.ports[id];assert(target,'Missing port save');
          session.inventory=copy(target.inventory);session.manifests=copy(target.manifests);session.exportReservations=copy(target.exportReservations);session.operational=copy(target.operational);session.checkpoint=copy(target.checkpoint);
          Object.assign(session.economy,copy(target.equipment),{activePort:id});
        }
      }else if(input.action==='checkpoint'){
        const measured=(input.value as {yardFullSeconds?:unknown}|null)?.yardFullSeconds;
        if(measured!==undefined){assert(typeof measured==='number'&&Number.isFinite(measured)&&measured>=0&&measured<=session.operational.yardFullSeconds+86400,'Invalid yard telemetry');session.operational.yardFullSeconds=Math.max(session.operational.yardFullSeconds,measured);}
        assert(input.expectedRevision===session.revision,'Checkpoint is stale; refresh session first');
        assert(JSON.stringify(input.value??null).length<=64_000,'Checkpoint too large');session.checkpoint=copy(input.value??null);
      }else throw new HarborError('Unknown action');
      assert(Number.isSafeInteger(session.economy.ns)&&session.economy.ns>=0,'Balance limit exceeded');
      session.revision++;session.updatedAt=new Date().toISOString();if(input.action!=='checkpoint')session.requests[requestId]={fingerprint,manifestId:manifest?.id,reservationId:reservation?.id,receiptId};
      const result={state:snapshot(session),manifest:manifest?copy(manifest):undefined,reservation:reservation?copy(reservation):undefined,receiptId} satisfies HarborResult;
      if(input.action!=='switchPort')selectPort(session,presentationPort);
      await persist(next);return result;
    });},
  };
}
export const harborStore=createHarborStore(resolve(process.env.HARBOR_DATA_DIR??process.cwd()+ '/.data','harbor-state-v1.json'));

/** GET returns {state}; POST accepts {action,requestId,...fields}. Same-origin JSON
 * only. All endpoint mutations are atomic and idempotent by requestId, with
 * additional permanent manifest settlement guards. No client balance/count input. */
export function createSessionHandler(store=harborStore, options:{secret?:string;secure?:boolean;origin?:string}={}) {
  const signature=(id:string)=>createHmac('sha256',options.secret!).update(id).digest('hex');
  const valid=(value:string)=>{if(!options.secret)return /^[a-f0-9-]{36}$/.test(value);const [id,sig]=value.split('.');if(!/^[a-f0-9-]{36}$/.test(id??'')||!sig||!/^[a-f0-9]{64}$/.test(sig))return false;return timingSafeEqual(Buffer.from(sig,'hex'),Buffer.from(signature(id),'hex'));};
  return async(req:IncomingMessage,res:ServerResponse)=>{
    res.setHeader('Content-Type','application/json; charset=utf-8');res.setHeader('Cache-Control','no-store');
    try{
      if(req.method!=='GET'&&req.method!=='POST')throw new HarborError('Method not allowed',405);
      if(req.headers.origin&&(options.origin?req.headers.origin!==options.origin:req.headers.origin!==`http://${req.headers.host}`&&req.headers.origin!==`https://${req.headers.host}`))throw new HarborError('Origin rejected',403);
      const cookie=(req.headers.cookie??'').split(';').map((part:string)=>part.trim()).find((part:string)=>part.startsWith('harbor_session='))?.slice(15);
      const accepted=typeof cookie==='string'&&valid(cookie);
      const sessionId=accepted?cookie!.split('.')[0]:randomUUID();
      if(!accepted)res.setHeader('Set-Cookie',`harbor_session=${sessionId}${options.secret?'.'+signature(sessionId):''}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000${options.secure?'; Secure':''}`);
      if(req.method==='GET'){const portId=new URL(req.url??'/', 'http://localhost').searchParams.get('port')??undefined;res.end(JSON.stringify(await store.read(sessionId,portId)));return;}
      if(!req.headers['content-type']?.startsWith('application/json'))throw new HarborError('JSON required',415);
      let body='';for await(const chunk of req){body+=chunk.toString();if(Buffer.byteLength(body)>80_000)throw new HarborError('Request too large',413);}
      let input:unknown;try{input=JSON.parse(body);}catch{throw new HarborError('Invalid JSON');}
      assert(input&&typeof input==='object'&&!Array.isArray(input),'Invalid action');
      res.end(JSON.stringify(await store.mutate(sessionId,input as Record<string,unknown>)));
    }catch(error){res.statusCode=error instanceof HarborError?error.status:500;res.end(JSON.stringify({error:error instanceof HarborError?error.message:'Harbor save unavailable; progress was not acknowledged.'}));}
  };
}
export function harborStatePlugin(store=harborStore):Plugin {
  const install=(server:{middlewares:{use:Function}})=>{
    // Local development recovery only; never installed by the production server.
    server.middlewares.use('/api/harbor/recover-local',async(req:IncomingMessage,res:ServerResponse)=>{
      res.setHeader('Content-Type','application/json');res.setHeader('Cache-Control','no-store');
      const remote=req.socket.remoteAddress;
      if(!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(remote??'')||!/^127\.0\.0\.1:\d+$/.test(req.headers.host??'')||(req.headers.origin&&req.headers.origin!==`http://${req.headers.host}`)){res.statusCode=403;res.end('{}');return;}
      if(req.method!=='GET'&&req.method!=='POST'){res.statusCode=405;res.end('{}');return;}
      try{const id=await store.recoverLocal();if(req.method==='POST'&&id)res.setHeader('Set-Cookie',`harbor_session=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`);res.end(JSON.stringify({available:!!id}));}catch{res.statusCode=500;res.end('{}');}
    });
    server.middlewares.use('/api/harbor/session',createSessionHandler(store));
  };
  return {name:'harbor-durable-state',configureServer:install,configurePreviewServer:install};
}




