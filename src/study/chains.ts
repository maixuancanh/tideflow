export const CHAINS = [
  {id:'bnb',name:'BNB Chain'},
  {id:'ethereum',name:'Ethereum'},
  {id:'base',name:'Base'},
  {id:'arbitrum',name:'Arbitrum'},
  {id:'polygon',name:'Polygon'},
] as const;
export type HarborChain = typeof CHAINS[number]['id'];
export const isHarborChain=(value:unknown):value is HarborChain=>CHAINS.some(chain=>chain.id===value);

export function canonicalChain(value:unknown):HarborChain|undefined{
  const key=String(value??'').trim().toLowerCase().replace(/[ _-]+/g,'');
  const aliases:Record<string,HarborChain>={bnb:'bnb',bsc:'bnb',bnbchain:'bnb',bnbsmartchain:'bnb',ethereum:'ethereum',eth:'ethereum',base:'base',arbitrum:'arbitrum',arb:'arbitrum',arbitrumone:'arbitrum',polygon:'polygon',matic:'polygon'};
  return aliases[key];
}
export function canonicalAddress(value:unknown){return String(value??'').trim().toLowerCase();}

export function tokenIdentity(chain:unknown,address:unknown){const c=canonicalChain(chain),a=canonicalAddress(address);return c&&a?`${c}:${a}`:undefined;}
export function hasNansenProvenance(unit:{id?:string;batchId?:string;chain?:unknown;address?:unknown;provenance?:{provider?:string;endpoint?:string;transactionHash?:string;observedAt?:string}}|undefined){return !!(unit?.id&&unit.batchId&&tokenIdentity(unit.chain,unit.address)&&unit.provenance?.provider==='nansen'&&['tgm/transfers','tgm/dex-trades'].includes(unit.provenance.endpoint??'')&&unit.provenance.transactionHash&&Number.isFinite(Date.parse(unit.provenance.observedAt??'')));}
