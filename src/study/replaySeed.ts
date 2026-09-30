import { buildResourceSchedule, resourceTelemetry, type ResourceSchedule } from './resourceSchedule';

export type ReplayCargo=Readonly<{id:string;symbol:string;address:string;chain?:string;batchId?:string;priority?:number;eventAt?:string}>;
export type ReplaySnapshot=Readonly<{batchIds:readonly string[];seed:string|number;chain:string;capturedAt:string;rulesVersion:string;cargo:readonly ReplayCargo[]}>;
export type ReplayAllocation=Readonly<{truckCount:number;dockLevel:number;yardLevel:number}>;
export type ReplayScenario=Readonly<{mode:'replay';readOnly:true;batchIds:readonly string[];seed:string;chain:string;capturedAt:string;rulesVersion:string;manifestHash:string;replayRulesVersion:'resource-replay-v2';units:readonly Readonly<ReplayCargo & {priority:number;prioritySource:'recorded-nansen'|'seeded-fallback'}>[];nsAward:0}>;
export const REPLAY_BUDGET=4;
const hash=(s:string)=>{let n=2166136261;for(let i=0;i<s.length;i++)n=Math.imul(n^s.charCodeAt(i),16777619);return n>>>0;};
const compare=(a:string,b:string)=>a<b?-1:a>b?1:0;
/** Copies and freezes the recorded cargo; no network, session or economic capability. */
export function createReplayScenario(snapshot:ReplaySnapshot):ReplayScenario{
  if(!snapshot.batchIds.length||snapshot.cargo.length>8||new Set(snapshot.cargo.map(c=>c.id)).size!==snapshot.cargo.length)throw new Error('Invalid replay manifest');
  const batchIds=Object.freeze([...snapshot.batchIds].sort(compare)),seed=String(snapshot.seed),rulesVersion=snapshot.rulesVersion||'unknown-source';
  const counts=new Map<string,number>();
  // Manifest UUIDs and recording timestamps differ between sessions. Source keys
  // use batch/token identity plus occurrence; only primitive values are copied.
  const canonical=snapshot.cargo.map(c=>({batchId:c.batchId??(batchIds.length===1?batchIds[0]:'legacy-unassigned'),chain:c.chain??snapshot.chain,address:c.address.toLowerCase(),symbol:c.symbol,priority:c.priority,eventAt:c.eventAt??''})).sort((a,b)=>compare(JSON.stringify(a),JSON.stringify(b))).map(c=>{const key=JSON.stringify([c.batchId,c.chain,c.address,c.eventAt]);const occurrence=counts.get(key)??0;counts.set(key,occurrence+1);return {...c,id:`${key}:${occurrence}`};});
  const source=JSON.stringify({batchIds,chain:snapshot.chain,rulesVersion,cargo:canonical});
  const units=canonical.map(c=>Object.freeze({...c,priority:Number.isFinite(c.priority)&&c.priority!>=0?c.priority!:1+hash(`${seed}:${c.id}:priority`)%3,prioritySource:Number.isFinite(c.priority)&&c.priority!>=0?'recorded-nansen' as const:'seeded-fallback' as const})).sort((a,b)=>hash(`${seed}:${source}:${a.id}`)-hash(`${seed}:${source}:${b.id}`)||compare(a.id,b.id));
  return Object.freeze({mode:'replay',readOnly:true,batchIds,seed,chain:snapshot.chain,capturedAt:snapshot.capturedAt,rulesVersion,replayRulesVersion:'resource-replay-v2',manifestHash:hash(source).toString(16).padStart(8,'0'),units:Object.freeze(units),nsAward:0});
}
export function runReplay(scenario:ReplayScenario,order:readonly string[],allocation:ReplayAllocation){
  const {truckCount,dockLevel,yardLevel}=allocation;
  if(![truckCount,dockLevel,yardLevel].every(Number.isInteger)||truckCount<4||truckCount>8||dockLevel<0||dockLevel>3||yardLevel<0||yardLevel>3||truckCount-4+dockLevel+yardLevel>REPLAY_BUDGET)throw new Error('Allocation exceeds the four-point budget');
  if(order.length!==scenario.units.length||new Set(order).size!==order.length||order.some(id=>!scenario.units.some(u=>u.id===id)))throw new Error('Invalid replay order');
  const units=Object.freeze(order.map(id=>scenario.units.find(u=>u.id===id)!));
  const schedule:ResourceSchedule=buildResourceSchedule(units.length,{truckCount,dockRate:1+.35*dockLevel,yardRate:1+.35*yardLevel});
  const telemetry=resourceTelemetry(schedule);
  const priorityCompletion=units.reduce((sum,u,i)=>sum+u.priority*schedule.jobs[i].placedAt,0)/Math.max(1,units.reduce((sum,u)=>sum+u.priority,0));
  return Object.freeze({units,schedule,telemetry,priorityCompletion,spent:truckCount-4+dockLevel+yardLevel,nsAward:0});
}
