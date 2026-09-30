import { Economy, EconomyState } from './economy';
export function mountShop(economy:Economy,options:{advice?:()=>string;uiRoot?:ParentNode;canPurchase?:(id:string)=>string|null;onPurchase?:(state:EconomyState,id:string)=>void;onSwitchPort?:(id:string)=>Promise<void>}){
 const uiRoot=options.uiRoot??document;
 const button=document.createElement('button');uiRoot.querySelector('header')!.append(button);
 const panel=document.createElement('section');panel.className='tideflow-panel';panel.hidden=true;panel.style.cssText='position:absolute;right:20px;top:85px;width:340px;max-height:70vh;overflow:auto;background:#f5edda;color:#243d43;padding:52px 20px 20px;border-radius:14px;pointer-events:auto;z-index:80';uiRoot.querySelector('#interface')!.append(panel);
 async function purchase(id:string){
 const offer=economy.offers.find(o=>o.id===id);
 if(!offer?.allowed||economy.state.ns<offer.price)return {ok:false,message:'This item is unavailable or requires more NS.'};
 const reason=options.canPurchase?.(id);if(reason)return {ok:false,message:'Finish the current operation before purchasing equipment.'};
 const result=await economy.purchase(id);if(result.ok)options.onPurchase?.(economy.state,id);
 refresh();return {ok:result.ok,message:result.ok?'Purchase complete.':'Purchase could not be saved. Please try again.'};
 }
 let message='Jade Harbor: separate harbor, 36 fixed slots, 3 berths and 4 starting forklifts. Same route layout as Coral Harbor. Separate yard and equipment; shared NS.';
 function refresh(){button.textContent=`Shop · ${economy.state.ns} NS`;panel.replaceChildren();const title=document.createElement('h2');title.textContent='Harbor shop';panel.append(title);if(options.advice){const advice=document.createElement('p');advice.textContent=options.advice();panel.append(advice);}const info=document.createElement('p');info.textContent=message;info.setAttribute('role','status');panel.append(info);
 for(const offer of economy.offers){const row=document.createElement('button');row.style.cssText='display:block;width:100%;margin:8px 0;padding:12px;text-align:left';const effect=offer.id==='yard-crane'?'Dedicated crane for parallel stacking · requires 54-slot harbor':offer.id==='truck'?'Increase transport capacity':offer.id.startsWith('crane:')?'+35% crane capacity per level':'Separate harbor · does not expand existing yard';row.textContent=`${offer.name} · ${offer.price.toLocaleString('en-US')} NS · ${effect}`;row.disabled=!offer.allowed||economy.state.ns<offer.price;row.onclick=async()=>{const reason=options.canPurchase?.(offer.id);if(reason){message=reason;refresh();return;}row.disabled=true;const result=await economy.purchase(offer.id);message=result.message;if(result.ok)options.onPurchase?.(economy.state,offer.id);refresh();};panel.append(row);}
 const preview=document.createElement('button');preview.textContent='Preview Jade Harbor';preview.onclick=()=>window.dispatchEvent(new CustomEvent('harbor-port-preview',{detail:'jade'}));panel.append(preview);
 for(const id of economy.state.ownedPorts??['coral']){const visit=document.createElement('button');visit.textContent=(id==='jade'?'Visit Jade Harbor':'Visit Coral Harbor')+((economy.state.activePort??'coral')===id?' · Currently here':'');visit.disabled=(economy.state.activePort??'coral')===id;visit.onclick=async()=>{const reason=options.canPurchase?.('switch-port');if(reason){message=reason;refresh();return;}visit.disabled=true;try{await options.onSwitchPort?.(id);}catch(error){message=(error as Error).message;refresh();}};panel.append(visit);}
 const close=document.createElement('button');close.className='panel-close';close.textContent='×';close.setAttribute('aria-label','Close shop');close.onclick=()=>{panel.hidden=true;window.dispatchEvent(new CustomEvent("harbor-port-preview",{detail:null}));};panel.append(close);}
 button.onclick=()=>{panel.hidden=!panel.hidden;if(panel.hidden)window.dispatchEvent(new CustomEvent("harbor-port-preview",{detail:null}));refresh();};economy.subscribe(refresh);refresh();return{refresh,purchase};
}


