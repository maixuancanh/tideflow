import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import type { CargoBatch, CargoFeed, HarborDemand, FlowEvidence } from '../src/study/cargoFeed';
import { isHarborChain } from '../src/study/chains';

export type Baseline={mean:number;observations:number};
export type FlowCache={nextAttempt:number;evidence:FlowEvidence|null};
export type EndpointCache={observedAt:number;nextAttempt:number;value?:unknown};
export type IntelligenceState={version:1;endpointCache:Record<string,EndpointCache>;chainAttempts:Record<string,number>;dexAttempt:number;flowCache:Record<string,FlowCache>;lastAttempt:number;rotation:number;reservations:Array<{at:number;count:number}>;seen:Record<string,number>;batches:CargoBatch[];demands:HarborDemand[];baselines:Record<string,Baseline>;feed:CargoFeed|null;droppedBatches:number};
const initial=():IntelligenceState=>({version:1,endpointCache:{},chainAttempts:{},dexAttempt:0,flowCache:{},lastAttempt:0,rotation:0,reservations:[],seen:{},batches:[],demands:[],baselines:{},feed:null,droppedBatches:0});
const validTime=(v:unknown)=>typeof v==='string'&&Number.isFinite(Date.parse(v));
function validate(value:IntelligenceState){
 value.endpointCache??={};value.chainAttempts??={};value.dexAttempt??=0;
 if(!value.endpointCache||Array.isArray(value.endpointCache)||Object.values(value.endpointCache).some(c=>!c||!Number.isFinite(c.observedAt)||!Number.isFinite(c.nextAttempt))||!value.chainAttempts||Object.values(value.chainAttempts).some(t=>!Number.isFinite(t))||!Number.isFinite(value.dexAttempt))throw new Error("Invalid endpoint cache");
 value.flowCache??={};
 if(typeof value.flowCache!=='object'||Array.isArray(value.flowCache)||Object.values(value.flowCache).some(c=>!Number.isFinite(c.nextAttempt)||(c.evidence&&(!validTime(c.evidence.observedAt)||!Number.isFinite(c.evidence.pressure)||Math.abs(c.evidence.pressure)>1))))throw new Error('Invalid flow cache');
 if(value?.version!==1||!Array.isArray(value.batches)||!Array.isArray(value.demands)||!Array.isArray(value.reservations)||!value.seen||!value.baselines||!Number.isFinite(value.lastAttempt)||!Number.isInteger(value.rotation)||value.rotation<0||!Number.isFinite(value.droppedBatches))throw new Error('Invalid intelligence store');
 if(value.reservations.some(r=>!Number.isFinite(r.at)||!Number.isInteger(r.count)||r.count<0)||Object.values(value.seen).some(t=>!Number.isFinite(t))||Object.values(value.baselines).some(b=>!Number.isFinite(b.mean)||b.mean<0||!Number.isInteger(b.observations)||b.observations<0))throw new Error('Invalid intelligence accounting');
 if(value.batches.some(b=>typeof b.id!=='string'||!isHarborChain(b.chain)||!validTime(b.eventAt)||!Array.isArray(b.tokens)||b.tokens.some(t=>typeof t.address!=='string'||typeof t.symbol!=='string'||!Number.isInteger(t.count)||t.count<1||t.count>8)))throw new Error('Invalid persisted batch');
 if(value.demands.some(d=>typeof d.id!=='string'||!isHarborChain(d.chain)||!validTime(d.expiresAt)||!validTime(d.eventAt)||!Number.isInteger(d.quantity)||d.quantity<1||d.quantity>4||!Number.isInteger(d.bonusPerUnit)||d.bonusPerUnit<0||d.bonusPerUnit>3))throw new Error('Invalid persisted demand');
 if(value.feed&&(!['live','stale','unavailable'].includes(value.feed.status)||!Array.isArray(value.feed.batches)))throw new Error('Invalid cached feed');
}
/** Single local Vite process owns this file. Corruption fails closed; never reset dedup silently. */
export class NansenIntelligenceStore{
 private state:IntelligenceState|null=null;
 private tail:Promise<void>=Promise.resolve();
 constructor(private readonly path:string){}
 async read():Promise<IntelligenceState>{
  await this.tail;
  if(!this.state){
   try{const value=JSON.parse(await readFile(this.path,'utf8')) as IntelligenceState;validate(value);this.state=value;}
   catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;this.state=initial();}
  }
  return structuredClone(this.state);
 }
 async save(value:IntelligenceState){
  const snapshot=structuredClone(value);validate(snapshot);
  const write=this.tail.then(async()=>{
   await mkdir(dirname(this.path),{recursive:true});const temporary=this.path+'.'+randomUUID()+'.tmp';
   try{const file=await open(temporary,'wx');try{await file.writeFile(JSON.stringify(snapshot));await file.sync();}finally{await file.close();}await rename(temporary,this.path);this.state=snapshot;}
   catch(error){await unlink(temporary).catch(()=>{});throw error;}
  });
  this.tail=write.catch(()=>{});await write;
 }
}


