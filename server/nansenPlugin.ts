import type { Plugin } from 'vite';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { CHAINS, type HarborChain } from '../src/study/chains';
import type { CargoBatch, CargoFeed, HarborDemand, SourceProvenance, FlowEvidence, SmartMoneyEvidence } from '../src/study/cargoFeed';
import { NansenIntelligenceStore } from './nansenIntelligenceStore';
import { harborStore } from './harborState';

type Row=Record<string,unknown>;
type CatalogToken={chain:HarborChain;address:string;symbol:string};
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const finite=(v:unknown):v is number=>typeof v==='number'&&Number.isFinite(v);
const text=(v:unknown):v is string=>typeof v==='string'&&v.length>0;
const MAX_REQUESTS_HOUR=360, MAX_REQUESTS_POLL=24, MAX_BACKLOG=500, COOLDOWN=60000;
const MINUTE=60000;
const CACHE_TTL:Record<string,number>={'token-screener':30*MINUTE,'smart-money/netflow':15*MINUTE,'tgm/holders':60*MINUTE};
const empty=(message:string):CargoFeed=>({status:'unavailable',fetchedAt:null,eventAt:null,batches:[],demands:[],demandStatus:'unavailable',message});
const rowsOf=(value:unknown):Row[]=>{
 if(!value||typeof value!=='object'||!Array.isArray((value as {data?:unknown}).data))throw new Error('Invalid Nansen envelope');
 return (value as {data:unknown[]}).data.filter((r):r is Row=>!!r&&typeof r==='object'&&!Array.isArray(r));
};
function stale(feed:CargoFeed|null,message:string):CargoFeed{
 if(!feed)return empty(message);
 return {...feed,status:feed.batches.length?'stale':'unavailable',demandStatus:feed.demands?.some(d=>Date.parse(d.expiresAt)>Date.now())?'stale':'unavailable',flowStatus:feed.flowStatus==='live'?'stale':feed.flowStatus,smartMoneyStatus:feed.smartMoneyStatus==='live'?'stale':feed.smartMoneyStatus,chainStatus:Object.fromEntries(Object.entries(feed.chainStatus??{}).map(([chain,status])=>[chain,status==='unavailable'?'unavailable':'stale'])),message};
}
/** Fair retention and delivery: at most 100 recent batches per chain, interleaved across chains. */
function fairBacklog(batches:CargoBatch[]):CargoBatch[]{
 const groups=CHAINS.map(c=>batches.filter(b=>b.chain===c.id).sort((a,b)=>Date.parse(b.eventAt)-Date.parse(a.eventAt)||a.id.localeCompare(b.id)).slice(0,MAX_BACKLOG/CHAINS.length));
 const output:CargoBatch[]=[];
 for(let i=0;i<MAX_BACKLOG/CHAINS.length;i++)for(const group of groups)if(group[i])output.push(group[i]);
 return output;
}
/** Single local Vite process. Paid API calls only occur on client polling, never module import. */
export function createFeedHandler(input:string|string[]){
 const keys=(Array.isArray(input)?input:input.split(/[\s,;]+/)).map(value=>value.trim()).filter(Boolean);
 let keyCursor=0;
 const blockedUntil=new Map<number,number>();
 const store=new NansenIntelligenceStore(join(process.env.HARBOR_FEED_DIR??join(process.cwd(),'.harbor-data'),'nansen-feed.json'));
 let pending:Promise<CargoFeed>|null=null,guardAttempt=0,latest:CargoFeed|null=null;
 async function register(feed:CargoFeed){const batches=feed.batches.filter(batch=>Number.isFinite(Date.parse(batch.eventAt))&&!!batch.provenance&&batch.provenance.provider==='nansen'&&(batch.provenance.endpoint==='tgm/transfers'||batch.provenance.endpoint==='tgm/dex-trades'));const demands=(feed.demands??[]).filter(demand=>Date.parse(demand.expiresAt)>Date.now()&&!!demand.provenance);await harborStore.registerBatches(batches);await harborStore.registerDemands(demands);}
 async function request(path:string,body:unknown,beforeAttempt:()=>Promise<void>){
  if(!keys.length)throw new Error('Nansen API keys are not configured.');
  let lastStatus=0;
  for(let attempt=0;attempt<keys.length;attempt++){
   const index=(keyCursor+attempt)%keys.length;
   if((blockedUntil.get(index)??0)>Date.now())continue;
   await beforeAttempt();
   const response=await fetch('https://api.nansen.ai/api/v1/'+path,{method:'POST',headers:{apikey:keys[index],'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(12000)});
   if(response.ok){keyCursor=index;return response.json() as Promise<unknown>;}
   lastStatus=response.status;
   if([401,403,429].includes(response.status)){blockedUntil.set(index,Date.now()+(response.status===429?60000:15*60000));}
   await response.body?.cancel();
   // Rotate only for credential/rate-limit failures. Schema and request errors
   // must remain visible instead of being hidden by a different key.
   if(![401,403,429].includes(response.status))throw new Error('Nansen HTTP '+response.status);
  }
  throw new Error(lastStatus?`Nansen HTTP ${lastStatus} on all available API keys`:'Nansen API keys are cooling down; using saved data');
 }
 const lowUntil=new Map<string,number>();
 async function poll():Promise<CargoFeed>{
  const state=await store.read(),now=Date.now(); latest??=state.feed;
  if(now-Math.max(state.lastAttempt,guardAttempt)<COOLDOWN){const feed=latest??state.feed??empty('Waiting for the next Nansen refresh.');await register(feed);return feed;}
  guardAttempt=now;
  const reservations=state.reservations.filter(x=>x.at>now-3600000),reserved=reservations.reduce((n,x)=>n+x.count,0);
  if(reserved>=MAX_REQUESTS_HOUR){latest=stale(state.feed,'Nansen request limit reached; using saved data.');await register(latest);await store.save({...state,lastAttempt:now,reservations,feed:latest});return latest;}
  const observedAt=new Date(now).toISOString(),from=new Date(now-300000).toISOString();
  const inWindow=(v:unknown):v is string=>text(v)&&Number.isFinite(Date.parse(v))&&Date.parse(v)>=now-300000&&Date.parse(v)<=now;
  const next={...state,reservations,lastAttempt:now,rotation:state.rotation,feed:state.feed};
  let actualRequests=0,cacheHits=0;
  // Persist each actual request before sending it; cache hits never spend budget.
  async function query(path:string,body:unknown){
   const ttl=CACHE_TTL[path]??0,cacheKey=hash([path,body]),cached=next.endpointCache[cacheKey];
   if(ttl&&cached&&now<cached.nextAttempt){if(cached.value!==undefined){cacheHits++;return cached.value;}throw new Error('Endpoint retry cooldown');}
   if(actualRequests>=MAX_REQUESTS_POLL||reserved+actualRequests>=MAX_REQUESTS_HOUR)throw new Error('Nansen request budget reached');
   if(ttl)next.endpointCache[cacheKey]={observedAt:cached?.observedAt??0,nextAttempt:now+5*MINUTE,...(cached?.value!==undefined?{value:cached.value}:{})};
   const reserveAttempt=async()=>{if(actualRequests>=MAX_REQUESTS_POLL||reserved+actualRequests>=MAX_REQUESTS_HOUR)throw new Error('Nansen request budget reached');next.reservations.push({at:Date.now(),count:1});actualRequests++;await store.save(next);};
   try{const value=await request(path,body,reserveAttempt);rowsOf(value);if(ttl){next.endpointCache[cacheKey]={observedAt:now,nextAttempt:now+ttl,value};await store.save(next);}return value;}
   catch(error){if(cached?.value!==undefined){cacheHits++;return cached.value;}throw error;}
  }
  await store.save(next);latest=next.feed;
  const provenance=(endpoint:SourceProvenance['endpoint'],row:Row):SourceProvenance=>({provider:'nansen',endpoint,transactionHash:String(row.transaction_hash),observedAt,windowFrom:from,windowTo:observedAt,sampled:true});
  const batches:CargoBatch[]=[],catalogs:CatalogToken[]=[],statuses:Record<string,string>={...state.feed?.chainStatus};let invalidRows=0,transfersUpdated=false;
  // Sequential writes make durable request accounting atomic inside this handler.
  for(const {id:chain} of CHAINS){
   try{
    const catalog=rowsOf(await query('token-screener',{chains:[chain],timeframe:'1h',filters:{include_native_tokens:false},pagination:{page:1,per_page:3},order_by:[{field:'market_cap_usd',direction:'DESC'}]}));
    const tokens:CatalogToken[]=catalog.slice(0,3).filter(t=>text(t.token_address)&&text(t.token_symbol)).map(t=>({chain,address:String(t.token_address),symbol:String(t.token_symbol).slice(0,16)}));
    catalogs.push(...tokens);let succeeded=0;
    const interval=(lowUntil.get(chain)??0)>now?3*MINUTE:5*MINUTE;
    if(now-(next.chainAttempts[chain]??0)<interval)continue;
    next.chainAttempts[chain]=now;await store.save(next);
    for(const token of tokens){
     try{
      const data=rowsOf(await query('tgm/transfers',{chain,token_address:token.address,date:{from,to:observedAt},pagination:{page:1,per_page:100}})).slice(0,100);
      const rows=data.filter(r=>text(r.transaction_hash)&&inWindow(r.block_timestamp)&&text(r.from_address)&&text(r.to_address));invalidRows+=data.length-rows.length;succeeded++;
      const baselineKey=chain+':'+token.address.toLowerCase(),prior=next.baselines[baselineKey],old=prior?.mean??rows.length;
      const observations=(prior?.observations??0)+1,multiplier=Math.max(.5,Math.min(2,observations>=3?rows.length/Math.max(1,old):1));
      next.baselines[baselineKey]={mean:old*.7+rows.length*.3,observations};
      const duplicates=new Map<string,number>();
      // Repeated identical rows get stable occurrence ordinals; mutable labels never affect identity.
      for(const row of rows){
       const raw=[chain,token.address.toLowerCase(),row.transaction_hash,String(row.block_timestamp),row.from_address,row.to_address,row.transfer_amount??null,row.transfer_value_usd??null];
       const identity=JSON.stringify(raw),ordinal=duplicates.get(identity)??0;duplicates.set(identity,ordinal+1);
       // Preserve the original singleton identity for compatibility with previously persisted batches.
       const id=ordinal===0?hash(raw):hash([raw,ordinal]);if(next.seen[id])continue;next.seen[id]=now;
       batches.push({id:hash(['batch',id]),chain,eventAt:String(row.block_timestamp),tokens:[{address:token.address,symbol:token.symbol,count:1}],provenance:provenance('tgm/transfers',row),intensity:{multiplier,sampleCount:rows.length,baseline:old,observations,method:'token-ewma-sampled-count'}});
      }
     }catch{/* A failed token does not discard successful chains. */}
    }
    if(succeeded>0)transfersUpdated=true;
    statuses[chain]=succeeded===tokens.length&&tokens.length>0?'live':succeeded>0?'partial':'unavailable';
   }catch{statuses[chain]='unavailable';}
  }
  // Official schema: https://docs.nansen.ai/api/token-god-mode/dex-trades.md
  // Rotated DEX sample, plus at most one aggregate refresh when its 15-minute cache expires.
  const demandToken=now-next.dexAttempt>=3*MINUTE?catalogs.find(t=>t.chain===CHAINS[state.rotation%CHAINS.length].id):undefined;let demandSucceeded=false;
  if(demandToken){next.dexAttempt=now;next.rotation=(state.rotation+1)%CHAINS.length;await store.save(next);}
  let flowEvidence:FlowEvidence|undefined,flowStatus:CargoFeed['flowStatus']=demandToken?'unavailable':state.feed?.flowStatus??'unavailable';
  let smartMoneyEvidence:SmartMoneyEvidence|undefined,smartMoneyStatus:CargoFeed['smartMoneyStatus']=demandToken?'unavailable':state.feed?.smartMoneyStatus??'unavailable';
  if(demandToken){
   const cacheKey=demandToken.chain+':'+demandToken.address.toLowerCase();
   let cached=next.flowCache[cacheKey];
   if(!cached||now>=cached.nextAttempt){
    next.flowCache[cacheKey]={nextAttempt:now+300000,evidence:cached?.evidence??null};
    await store.save(next);
    try{
     const row=rowsOf(await query('tgm/flow-intelligence',{chain:demandToken.chain,token_address:demandToken.address,timeframe:'1h'}))[0];
     if(!row)throw new Error('No flow sample');
     const exchange=finite(row.exchange_net_flow_usd)?row.exchange_net_flow_usd:null;
     const smart=finite(row.smart_trader_net_flow_usd)?row.smart_trader_net_flow_usd:null;
     const whale=finite(row.whale_net_flow_usd)?row.whale_net_flow_usd:null;
     if(exchange===null&&smart===null&&whale===null)throw new Error('Invalid flow sample');
     // Segments can overlap: average normalized scores, never treat their sum as volume.
     const scores=[exchange===null?null:exchange/Math.max(1000,Math.abs(exchange)),smart===null?null:-smart/Math.max(1000,Math.abs(smart)),whale===null?null:-whale/Math.max(1000,Math.abs(whale))].filter((v):v is number=>v!==null);
     const pressure=scores.reduce((a,b)=>a+b,0)/scores.length;
     const evidence:FlowEvidence={endpoint:'tgm/flow-intelligence',observedAt,windowFrom:new Date(now-3600000).toISOString(),windowTo:observedAt,timeframe:'1h',exchangeNetFlowUsd:exchange,smartTraderNetFlowUsd:smart,whaleNetFlowUsd:whale,pressure,quantityMultiplier:1+.5*pressure,premiumAdjustmentBps:Math.round(500*pressure),method:'bounded-segment-net-flow-v1'};
     next.flowCache[cacheKey]={nextAttempt:now+900000,evidence};
    }catch{/* Fail closed: do not invent aggregate signals. Backoff was persisted before request. */}
    cached=next.flowCache[cacheKey];
   }
   if(cached?.evidence){
    if(now-Date.parse(cached.evidence.observedAt)<900000){flowEvidence=cached.evidence;flowStatus='live';}
    else flowStatus='stale';
   }
  }
  if(demandToken)try{
   const netflowBody={chains:[demandToken.chain],filters:{token_address:demandToken.address,include_smart_money_labels:['Fund','Smart Trader']},pagination:{page:1,per_page:10},order_by:[{field:'net_flow_1h_usd',direction:'DESC'}]};
   const holderBody={chain:demandToken.chain,token_address:demandToken.address,label_type:'all_holders',aggregate_by_entity:false,pagination:{page:1,per_page:10},order_by:[{field:'value_usd',direction:'DESC'}]};
   const netflow=rowsOf(await query('smart-money/netflow',netflowBody))[0];
   const holders=rowsOf(await query('tgm/holders',holderBody));
   const evidenceAt=Math.min(next.endpointCache[hash(['smart-money/netflow',netflowBody])]?.observedAt??now,next.endpointCache[hash(['tgm/holders',holderBody])]?.observedAt??now);
   if(now-(next.endpointCache[hash(['smart-money/netflow',netflowBody])]?.observedAt??0)>=15*MINUTE||now-(next.endpointCache[hash(['tgm/holders',holderBody])]?.observedAt??0)>=60*MINUTE)throw new Error('Aggregate evidence expired');
   const n1=finite(netflow?.net_flow_1h_usd)?Number(netflow.net_flow_1h_usd):null,n7=finite(netflow?.net_flow_7d_usd)?Number(netflow.net_flow_7d_usd):null;
   const hValue=holders.reduce((sum,row)=>sum+(finite(row.value_usd)?Number(row.value_usd):0),0);const pressure=(n1===null?0:Math.max(-1,Math.min(1,n1/Math.max(1000,Math.abs(n1)))));
   smartMoneyEvidence={endpoint:'smart-money/netflow',observedAt:new Date(evidenceAt).toISOString(),chain:demandToken.chain,tokenAddress:demandToken.address,netFlow1hUsd:n1,netFlow7dUsd:n7,traderCount:finite(netflow?.trader_count)?Number(netflow.trader_count):null,holderCount:holders.length||null,holderValueUsd:holders.length?hValue:null,quantityMultiplier:1+.25*pressure,premiumAdjustmentBps:Math.round(250*pressure),method:'bounded-smart-holder-signal-v1'};smartMoneyStatus=now-evidenceAt<60*MINUTE?'live':'stale';
  }catch{smartMoneyStatus=next.demands.some(d=>d.smartMoneyEvidence)?'stale':'unavailable';}
  if(demandToken)try{
   const data=rowsOf(await query('tgm/dex-trades',{chain:demandToken.chain,token_address:demandToken.address,date:{from,to:observedAt},pagination:{page:1,per_page:20},filters:{action:'BUY'},order_by:[{field:'block_timestamp',direction:'DESC'}]})).slice(0,20);
   const rows=data.filter(r=>r.action==='BUY'&&text(r.transaction_hash)&&inWindow(r.block_timestamp)&&text(r.trader_address)&&text(r.token_address)&&r.token_address.toLowerCase()===demandToken.address.toLowerCase()&&finite(r.estimated_value_usd)&&r.estimated_value_usd>=0&&finite(r.token_amount)&&r.token_amount>0);
   invalidRows+=data.length-rows.length;demandSucceeded=data.length===0||rows.length>0;
   const row=rows[0];if(row){
    const id=hash(['demand',demandToken.chain,demandToken.address.toLowerCase(),row.transaction_hash,row.trader_address,row.block_timestamp]);
    if(!next.demands.some(d=>d.id===id)){
     const baselineKey='buy:'+demandToken.chain+':'+demandToken.address.toLowerCase(),prior=next.baselines[baselineKey],value=Number(row.estimated_value_usd),ratio=prior&&prior.observations>=2?value/Math.max(1,prior.mean):1;
     const quantity=Math.max(1,Math.min(4,Math.round(2*ratio*(flowEvidence?.quantityMultiplier??1)*(smartMoneyEvidence?.quantityMultiplier??1)))),premiumBps=Math.max(0,Math.min(2500,Math.round(1000*ratio)+(flowEvidence?.premiumAdjustmentBps??0)+(smartMoneyEvidence?.premiumAdjustmentBps??0)));
     next.baselines[baselineKey]={mean:prior?prior.mean*.7+value*.3:value,observations:(prior?.observations??0)+1};
     const demand:HarborDemand={id,chain:demandToken.chain,tokenAddress:demandToken.address,tokenSymbol:demandToken.symbol,quantity,premiumBps,bonusPerUnit:Math.ceil(10*premiumBps/10000),eventAt:String(row.block_timestamp),observedAt,expiresAt:new Date(Date.parse(String(row.block_timestamp))+900000).toISOString(),provenance:provenance('tgm/dex-trades',row),...(flowEvidence?{flowEvidence}: {}),...(smartMoneyEvidence?{smartMoneyEvidence}: {})};
     next.demands.push(demand);
    }
   }
  }catch{/* Keep immutable historical terms; never fabricate live demand. */}
  const combined=[...next.batches,...batches];next.batches=fairBacklog(combined);next.droppedBatches+=combined.length-next.batches.length;
  next.demands=next.demands.filter(d=>Date.parse(d.expiresAt)>now-3600000);
  // Only a 5-minute source window is accepted, so one-day dedup retention cannot replay old events.
  next.seen=Object.fromEntries(Object.entries(next.seen).filter(([,at])=>at>now-86400000));
  next.endpointCache=Object.fromEntries(Object.entries(next.endpointCache).filter(([,entry])=>Math.max(entry.observedAt,entry.nextAttempt)>now-7*86400000));
  const anySuccess=transfersUpdated;
  for(const chain of CHAINS)if(now-(next.chainAttempts[chain.id]??0)>5*MINUTE&&statuses[chain.id]!=='unavailable')statuses[chain.id]='stale';
  const feed:CargoFeed={status:anySuccess||state.feed?.fetchedAt&&now-Date.parse(state.feed.fetchedAt)<5*MINUTE?'live':next.batches.length?'stale':'unavailable',fetchedAt:anySuccess?observedAt:state.feed?.fetchedAt??null,eventAt:next.batches.reduce<string|null>((a,b)=>!a||Date.parse(b.eventAt)>Date.parse(a)?b.eventAt:a,null),batches:next.batches,demands:next.demands,demandStatus:demandSucceeded?'live':next.demands.some(d=>Date.parse(d.expiresAt)>now)?'stale':'unavailable',chainStatus:statuses,flowStatus,smartMoneyStatus,coverage:{requestsThisPoll:actualRequests,cacheHits,maxRequestsPerPoll:MAX_REQUESTS_POLL,requestsReservedThisHour:reserved+actualRequests,maxRequestsPerHour:MAX_REQUESTS_HOUR,backlog:next.batches.length,droppedBatches:next.droppedBatches,invalidRows,sampled:true},message:`Saved Nansen data · ${actualRequests} new requests, ${cacheHits} cache hits this cycle · transfers every 3–5 minutes, portfolio every 30 minutes, Smart Money/Flow every 15 minutes, Holders every 60 minutes. Sampled data; past events do not create new containers.`};
  next.feed=feed;await register(feed);await store.save(next);latest=feed;return feed;
 }
 return async(req:IncomingMessage,res:ServerResponse)=>{
  res.setHeader('Content-Type','application/json; charset=utf-8');res.setHeader('Cache-Control','no-store');if(req.method!=='GET'){res.statusCode=405;res.end('{}');return;}
  if(!keys.length){const saved=await store.read();const feed=stale(saved.feed,'Nansen API keys are not configured; using saved data.');await register(feed);res.end(JSON.stringify(feed));return;}
  const url=new URL(req.url??'/', 'http://localhost');
  for(const chain of (url.searchParams.get('low')??'').split(',').slice(0,CHAINS.length))if(CHAINS.some(c=>c.id===chain))lowUntil.set(chain,Date.now()+2*MINUTE);
  if(!pending)pending=poll().catch(()=>{latest=stale(latest,'Could not refresh Nansen; using saved data.');return latest;}).finally(()=>{pending=null;});
  // A multi-endpoint refresh can exceed the browser deadline. Serve durable
  // evidence promptly while the single shared refresh continues in background.
  const cached=latest??(await store.read()).feed;
  let timer:ReturnType<typeof setTimeout>|undefined;
  const feed=await Promise.race([pending,new Promise<CargoFeed>(resolve=>{timer=setTimeout(()=>resolve(stale(cached,'Nansen refresh in progress; using saved data.')),8000);})]);
  if(timer)clearTimeout(timer);
  res.end(JSON.stringify(feed));
 };
}
export function nansenFeedPlugin(key:string):Plugin{
 const handler=createFeedHandler(key);
 const install=(server:{middlewares:{use:Function}})=>{server.middlewares.use('/api/harbor/feed',handler);};
 return {name:'harbor-nansen-feed',configureServer:install,configurePreviewServer:install};
}





