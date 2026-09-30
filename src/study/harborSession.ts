import type { HarborChain } from './chains';
import type { EconomyState, EquipmentId } from './economy';
import type { SourceProvenance } from './cargoFeed';

export type HarborUnit = { id:string; batchId:string; chain:HarborChain; address:string; symbol:string; eventAt?:string; provenance?:SourceProvenance; cell?:number; level?:number };
export type HarborPlacement = {unitId:string;cell:number;level:number};
export type ExportReservation = {id:string;unitIds:string[];demandId?:string;bonus:number;status:'reserved'|'completed'|'cancelled';mode?:'inland'|'sea';portId?:string;placements?:HarborPlacement[];createdAt:string};
export type ArrivalPlan = {portId:'coral'|'jade';berth:number;strategy:'priority'|'compact'|'balanced'};
export type HarborManifest = { admission?:ArrivalPlan; id:string; batchIds:string[]; units:HarborUnit[]; status:'claimed'|'completed'|'penalized'; createdAt:string; penaltyEligibleAt?:string; rulesVersion?:string; rewardNs?:number; penaltyNs?:number };
export type CompletionMetrics = {vesselWaitSeconds:number;truckWaitSeconds:number;craneWaitSeconds:number;yardCraneQueueSeconds:number;handlingSeconds:number};
export type HarborOperationalSummary = CompletionMetrics & { measuredTrips:number; metricsSince:string; yardFullSeconds:number; exportedUnits:number; completedTrips:number; lostTrips:number; nsWon:number; nsLost:number };
export type HarborSnapshot = {
  portSummaries?:Array<{id:string;capacity:number;stored:number;queued:number;trucks:number}>;
  revision:number; economy:EconomyState; inventory:HarborUnit[]; manifests:HarborManifest[];
  claimedBatchIds:string[]; demandProgress:Record<string,number>; exportReservations:ExportReservation[]; operational:HarborOperationalSummary; checkpoint:unknown; updatedAt:string;
};
export class HarborRequestError extends Error {constructor(message:string,public status:number){super(message);}}
export type HarborResult = { state:HarborSnapshot; manifest?:HarborManifest; reservation?:ExportReservation; receiptId?:string };

/** Cookie identifies a local demo save. Only server transitions can change balances,
 * inventory or manifests. Checkpoints contain presentation state only and must never
 * be used to restore economic state. Retry a failed operation with the same requestId.
 * This adapter intentionally does not prove that the animation actually ran. */
export async function connectHarborSession(portId?:'coral'|'jade') {
  let state:HarborSnapshot;
  let scenePort:string|undefined;
  const listeners = new Set<(state:HarborSnapshot)=>void>();
  let queue:Promise<unknown> = Promise.resolve();
  const accept=(next:HarborSnapshot)=>{
    if(!next || !Number.isInteger(next.revision) || !next.economy || !Array.isArray(next.inventory))throw new Error('Invalid harbor save');
    scenePort??=next.economy.activePort??'coral';
    if(!state || next.revision>=state.revision){next.operational={vesselWaitSeconds:0,truckWaitSeconds:0,craneWaitSeconds:0,yardCraneQueueSeconds:0,handlingSeconds:0,measuredTrips:0,metricsSince:next.updatedAt,yardFullSeconds:0,exportedUnits:0,completedTrips:0,lostTrips:0,nsWon:0,nsLost:0,...(next.operational as Partial<HarborOperationalSummary>??{})};state=next;listeners.forEach(listener=>listener(state));}
  };
  async function request(body?:unknown):Promise<HarborResult>{
    const response=await fetch('/api/harbor/session'+(portId?'?port='+portId:''),{method:body?'POST':'GET',credentials:'same-origin',signal:AbortSignal.timeout(15000),headers:{Accept:'application/json',...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify({...body as object,...(portId&&(body as {action?:string}).action!=='switchPort'?{portId}:{})})}:{})});
    const result=await response.json();
    if(!response.ok)throw new HarborRequestError(result.error??`Harbor save ${response.status}`,response.status);
    accept(result.state);return result;
  }
  const mutate=(action:string,payload:Record<string,unknown>,requestId:string=crypto.randomUUID())=>{
    const run=async()=>{const body={action,requestId,activePort:scenePort??'coral',...payload,...(action==='checkpoint'?{expectedRevision:state.revision}:{})};try{return await request(body);}catch(error){if(error instanceof HarborRequestError&&error.status<500){if(action==='checkpoint'&&error.message.includes('stale')){await request();return request({...body,expectedRevision:state.revision});}throw error;}return request(body);}};
    const result=queue.then(run,run);queue=result.catch(()=>{});return result;
  };
  await request();
  return {
    get state(){return state;},
    subscribe(listener:(state:HarborSnapshot)=>void){listeners.add(listener);return()=>{listeners.delete(listener);};},
    refresh:()=>request(),
    claim:(batchIds:string[],requestId?:string)=>mutate('claim',{batchIds},requestId),
    complete:(manifestId:string,placements?:HarborPlacement[],metrics?:CompletionMetrics)=>mutate('complete',{manifestId,...(placements?{placements}:{}),...(metrics?{metrics}:{})},`complete:${manifestId}`),
    acceptArrival:(manifestId:string,plan:ArrivalPlan)=>mutate('acceptArrival',{manifestId,plan},`acceptArrival:${manifestId}`),
    rejectArrival:(manifestId:string,expectedPenalty:number)=>mutate('rejectArrival',{manifestId,expectedPenalty},`rejectArrival:${manifestId}`),
    penalize:(manifestId:string)=>mutate('penalize',{manifestId},`penalize:${manifestId}`),
    exportCargo:(inventoryIds:string[],demandId?:string,requestId?:string)=>mutate('export',{inventoryIds,demandId},requestId),
    reserveExport:(inventoryIds:string[],demandId?:string,requestId?:string,mode:'inland'|'sea'='inland',portId?:string,placements?:HarborPlacement[])=>mutate('reserveExport',{inventoryIds,demandId,mode,portId,placements},requestId),
    finishExport:(reservationId:string)=>mutate('finishExport',{reservationId},`finishExport:${reservationId}`),
    cancelExport:(reservationId:string)=>mutate('cancelExport',{reservationId},`cancelExport:${reservationId}`),
    switchPort:(portId:string)=>mutate('switchPort',{portId}),
    purchase:(offerId:string,requestId?:string)=>mutate('purchase',{offerId},requestId),
    equipEquipment:(equipmentId:EquipmentId,targetPortId:'coral'|'jade',requestId?:string)=>mutate('equipEquipment',{equipmentId,targetPortId},requestId),
    upgradeCapacity:(targetPortId:'coral'|'jade',requestId?:string)=>mutate('upgradePortCapacity',{targetPortId},requestId),
    checkpoint:(value:unknown,requestId?:string)=>mutate('checkpoint',{value},requestId),
  };
}
export type HarborSession = Awaited<ReturnType<typeof connectHarborSession>>;


