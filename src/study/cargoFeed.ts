import type { HarborChain } from './chains';
export type FeedStatus='live'|'unavailable'|'stale';
export type SourceProvenance={provider:'nansen';endpoint:'tgm/transfers'|'tgm/dex-trades';transactionHash:string;observedAt:string;windowFrom:string;windowTo:string;sampled:true};
export type FlowEvidence={endpoint:'tgm/flow-intelligence';observedAt:string;windowFrom:string;windowTo:string;timeframe:'1h';exchangeNetFlowUsd:number|null;smartTraderNetFlowUsd:number|null;whaleNetFlowUsd:number|null;pressure:number;quantityMultiplier:number;premiumAdjustmentBps:number;method:'bounded-segment-net-flow-v1'};
export type SmartMoneyEvidence={endpoint:'smart-money/netflow';observedAt:string;chain:HarborChain;tokenAddress:string;netFlow1hUsd:number|null;netFlow7dUsd:number|null;traderCount:number|null;holderCount:number|null;holderValueUsd:number|null;quantityMultiplier:number;premiumAdjustmentBps:number;method:'bounded-smart-holder-signal-v1'};
export type TokenIntensity={multiplier:number;sampleCount:number;baseline:number;observations:number;method:'token-ewma-sampled-count'};
export type CargoBatch={id:string;chain:HarborChain;tokens:Array<{address:string;symbol:string;count:number}>;eventAt:string;provenance?:SourceProvenance;intensity?:TokenIntensity};
/** Game demand derived from a sampled BUY, not a real exchange order or token balance. */
export type HarborDemand={id:string;chain:HarborChain;tokenAddress:string;tokenSymbol:string;quantity:number;premiumBps:number;bonusPerUnit:number;eventAt:string;observedAt:string;expiresAt:string;provenance:SourceProvenance;flowEvidence?:FlowEvidence;smartMoneyEvidence?:SmartMoneyEvidence};
export type CargoFeed={status:FeedStatus;fetchedAt:string|null;eventAt:string|null;batches:CargoBatch[];demands?:HarborDemand[];demandStatus?:FeedStatus;chainStatus?:Record<string,string>;flowStatus?:FeedStatus;smartMoneyStatus?:FeedStatus;coverage?:{requestsThisPoll?:number;cacheHits?:number;maxRequestsPerPoll:number;requestsReservedThisHour:number;maxRequestsPerHour:number;backlog:number;droppedBatches:number;invalidRows:number;sampled:true};message?:string};
let lastGood:CargoFeed|null=null;
/** Client boundary for the server-owned Nansen adapter. No API key is ever read in the browser. */
export async function fetchCargoFeed(signal?:AbortSignal,lowChains:HarborChain[]=[]):Promise<CargoFeed>{
 try{const response=await fetch('/api/harbor/feed?low='+encodeURIComponent(lowChains.join(',')),{signal:signal??AbortSignal.timeout(20000),headers:{Accept:'application/json'}});if(!response.ok)throw new Error(`feed ${response.status}`);const data=await response.json() as CargoFeed;if(!['live','stale','unavailable'].includes(data.status)||!Array.isArray(data.batches))throw new Error('invalid feed');if(data.status!=='unavailable')lastGood=data;return data;}
 catch(error){if(signal?.aborted)throw error;if(lastGood)return {...lastGood,status:'stale',message:'Refresh delayed; using saved Nansen data.'};return {status:'unavailable',fetchedAt:null,eventAt:null,batches:[],demands:[],demandStatus:'unavailable',message:'Nansen source not connected; new container arrivals are paused.'};}
}


