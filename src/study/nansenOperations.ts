import type { HarborDemand, CargoBatch } from './cargoFeed';
import { tokenIdentity } from './chains';
export type NansenPriority={score:number;label:string;reason:string;deadlineSeconds:number|undefined};
export function priorityForToken(chain:unknown,address:unknown,demands:HarborDemand[],now=Date.now()):NansenPriority{
 const matches=demands.filter(d=>Date.parse(d.expiresAt)>now&&tokenIdentity(d.chain,d.tokenAddress)===tokenIdentity(chain,address));
 if(!matches.length)return {score:0,label:'Standard',reason:'No Nansen export order',deadlineSeconds:undefined};
 const d=[...matches].sort((a,b)=>Date.parse(a.expiresAt)-Date.parse(b.expiresAt))[0];
 const left=Math.max(0,Math.round((Date.parse(d.expiresAt)-now)/1000));
 const flow=Math.max(-1,Math.min(1,d.flowEvidence?.pressure??0));
 const smart=Math.max(-1,Math.min(1,(d.smartMoneyEvidence?.netFlow1hUsd??0)>0?1:(d.smartMoneyEvidence?.netFlow1hUsd??0)<0?-1:0));
 const urgency=Math.max(0,Math.min(1,1-left/900));
 const score=Math.max(0,Math.min(100,d.premiumBps/25+urgency*45+Math.max(0,flow)*20+Math.max(0,smart)*10));
 return {score,label:score>=70?'High priority':score>=35?'Priority':'Monitor',reason:`Order ${d.tokenSymbol} remaining ${left}s · Flow ${(flow*100).toFixed(0)}%${smart?` · Smart Money ${smart>0?'rising':'falling'}`:''}`,deadlineSeconds:left};
}
export function batchIntensity(batch:CargoBatch){return Math.max(.5,Math.min(2,batch.intensity?.multiplier??1));}
