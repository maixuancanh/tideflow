import { gameIcon } from './gameIcons';
import type { ArrivalPlan, HarborManifest } from './harborSession';
import type { PortId, PortWorld } from './portWorld';

export type Arrival = {index:number;name:string;manifest:HarborManifest};
export type ArrivalPort = {
  id:PortId; label:string;
  arrivals:()=>Arrival[];
  free:()=>number;
  full:()=>boolean;
  balance:()=>number;
  available:(arrival:Arrival,source:PortId)=>boolean;
  berths:()=>number[];
  accept:(arrival:Arrival,target:ArrivalPort,plan:ArrivalPlan)=>Promise<void>;
  reject:(arrival:Arrival,expectedPenalty:number)=>Promise<void>;
  transfer:()=>void;
  lock:(value:boolean)=>void;
  receive:(arrival:Arrival,pose:import('./collisionAudit').Pose)=>void;
  refresh:()=>Promise<unknown>;
};
const directors=new WeakMap<PortWorld,ReturnType<typeof createDirector>>();
export function arrivalDirector(world:PortWorld){
  let director=directors.get(world);
  if(!director){director=createDirector();directors.set(world,director);}
  return director;
}
function createDirector(){
  const ports=new Map<PortId,ArrivalPort>();
  const deferred=new Map<string,number>();
  const dialog=document.createElement('dialog');
  dialog.className='tideflow-modal tf-arrival';
  dialog.setAttribute('aria-label','Harbor notification');
  document.body.append(dialog);
  let current:{port:ArrivalPort;arrival?:Arrival}|undefined;
  let busy=false;
  let previousFocus:HTMLElement|null=null;
  const toast=document.createElement('div');toast.className='tf-arrival-toast';toast.hidden=true;document.body.append(toast);
  let queued:{port:ArrivalPort;arrival?:Arrival}|undefined;
  function showToast(value:{port:ArrivalPort;arrival?:Arrival}){queued=value;toast.innerHTML=`<b>${value.arrival?'Incoming vessel':'Yard full'}</b><small>${value.arrival?`${value.arrival.name} is waiting with ${value.arrival.manifest.units.length} containers.`:`${value.port.label} is full. Free up yard space.`}</small>`;toast.hidden=false;toast.onclick=()=>{if(queued&&!document.querySelector('.tf-command-panel:not([hidden])')&&!document.querySelector('dialog[open]')){const next=queued;queued=undefined;toast.hidden=true;open(next.port,next.arrival);}};}
  function clearToast(){queued=undefined;toast.hidden=true;}
  const close=()=>{
    if(busy)return;
    if(current)deferred.set(current.arrival?.manifest.id??`full:${current.port.id}`,Date.now()+30000);
    dialog.close();current=undefined;previousFocus?.focus();
  };
  dialog.addEventListener('close',()=>{if(!dialog.open&&current&&!busy){deferred.set(current.arrival?.manifest.id??`full:${current.port.id}`,Date.now()+30000);current=undefined;}});
  dialog.addEventListener('keydown',event=>{if(event.key==='Escape'){event.preventDefault();close();}});
  dialog.addEventListener('cancel',event=>{event.preventDefault();close();});
  dialog.addEventListener('pointerdown',event=>{if(event.target===dialog)close();});
  function button(label:string,action:()=>void,secondary=false){
    const node=document.createElement('button');node.type='button';node.textContent=label;
    node.className=secondary?'tf-arrival-secondary':'tf-arrival-primary';node.onclick=action;return node;
  }
  function shell(title:string,description:string){
    dialog.replaceChildren();
    const x=button('×',close,true);x.className='tf-arrival-close';x.setAttribute('aria-label','Close notification');
    const icon=document.createElement('div');icon.className='tf-arrival-icon';icon.innerHTML=gameIcon(current?.arrival?'arrival':'yard');
    const heading=document.createElement('h2');heading.textContent=title;
    const text=document.createElement('p');text.textContent=description;
    dialog.append(x,icon,heading,text);
    const status=document.createElement('p');status.className='tf-arrival-status';status.setAttribute('role','status');dialog.append(status);
    return status;
  }
  async function run(action:()=>Promise<void>,status:HTMLElement){
    if(busy)return;busy=true;dialog.setAttribute('aria-busy','true');
    dialog.querySelectorAll<HTMLButtonElement|HTMLSelectElement>('button,select').forEach(n=>n.disabled=true);
    try{await action();busy=false;close();}
    catch(error){status.textContent=error instanceof Error?error.message:'Unable to save. Please retry.';}
    finally{busy=false;dialog.removeAttribute('aria-busy');dialog.querySelectorAll<HTMLButtonElement|HTMLSelectElement>('button,select').forEach(n=>n.disabled=false);}
  }
  function notice(){
    const {port,arrival}=current!;
    if(!arrival){
      shell('Yard full',`${port.label} needs more space before receiving containers.`);
      dialog.append(button('Free up yard',()=>{close();port.transfer();}));return;
    }
    shell('Incoming vessel',`${arrival.name} is waiting with ${arrival.manifest.units.length} containers. Choose whether to receive these containers.`);
    const actions=document.createElement('div');actions.className='tf-arrival-actions';
    actions.append(button('Accept',configure),button('Cancel',cancel,true));dialog.append(actions);
  }
  function cancel(){
    const {port,arrival}=current!;if(!arrival)return;
    const fee=Math.min(port.balance(),arrival.manifest.penaltyNs??20);
    const status=shell('Cancel this arrival?',`Declining ${arrival.name} will deduct ${fee} NS. Your containers will not enter the yard.`);
    const actions=document.createElement('div');actions.className='tf-arrival-actions';
    actions.append(button(`Confirm · −${fee} NS`,()=>void run(()=>port.reject(arrival,fee),status)),button('Back',notice,true));dialog.append(actions);
  }
  function configure(){
    const {port:source,arrival}=current!;if(!arrival)return;
    const status=shell('Receive vessel',`${arrival.name} · ${arrival.manifest.units.length} containers`);
    const form=document.createElement('div');form.className='tf-arrival-form';
    const choiceGrid=(label:string)=>{const section=document.createElement('section');section.className='tf-arrival-choice-section';const title=document.createElement('b');title.textContent=label;section.append(title);const grid=document.createElement('div');grid.className='tf-arrival-choice-grid';section.append(grid);form.append(section);return grid;};
    const destinationGrid=choiceGrid('Receiving harbor'),berthGrid=choiceGrid('Receiving berth'),strategyGrid=choiceGrid('Stacking strategy');
    let destinationId:PortId|undefined,berthId:number|undefined,strategyId:ArrivalPlan['strategy']='balanced';
    const destinationButtons:Array<HTMLButtonElement>=[];
    for(const port of ports.values()){
      const allowed=port.available(arrival,source.id)&&port.free()>=arrival.manifest.units.length;
      const button=document.createElement('button');button.type='button';button.textContent=`${port.label} · ${port.free()} free`;button.disabled=!allowed;
      button.onclick=()=>{destinationId=port.id;destinationButtons.forEach(b=>b.classList.toggle('selected',b===button));updateBerths();};destinationGrid.append(button);destinationButtons.push(button);
    }
    const preferred=Array.from(ports.values()).find(port=>port.id===source.id&&port.available(arrival,source.id)&&port.free()>=arrival.manifest.units.length)??Array.from(ports.values()).find(port=>port.available(arrival,source.id)&&port.free()>=arrival.manifest.units.length);
    if(preferred){destinationId=preferred.id;destinationButtons.find(b=>b.textContent?.startsWith(preferred.label))?.classList.add('selected');}
    const berthButtons:Array<HTMLButtonElement>=[];
    const updateBerths=()=>{berthGrid.replaceChildren();berthId=undefined;const target=destinationId?ports.get(destinationId):undefined;for(const id of target?.berths()??[]){const b=document.createElement('button');b.type='button';b.textContent=`Berth ${String(id+1).padStart(2,'0')}`;b.onclick=()=>{berthId=id;berthButtons.forEach(x=>x.classList.toggle('selected',x===b));};berthGrid.append(b);berthButtons.push(b);}if(!berthGrid.children.length){const empty=document.createElement('small');empty.textContent='All berths are busy. The vessel stays in the queue.';berthGrid.append(empty);}};
    for(const [value,label] of [['priority','Demand priority'],['compact','Compact stacks'],['balanced','Balanced yard'] ] as const){const b=document.createElement('button');b.type='button';b.textContent=label;b.onclick=()=>{strategyId=value;strategyGrid.querySelectorAll('button').forEach(x=>x.classList.toggle('selected',x===b));};strategyGrid.append(b);if(value==='balanced')b.classList.add('selected');}
    updateBerths();
    const confirm=button('Confirm arrival',()=>{const target=destinationId?ports.get(destinationId):undefined;const selectedBerth=berthId;if(!target||selectedBerth===undefined||!target.available(arrival,source.id)||target.free()<arrival.manifest.units.length||!target.berths().includes(selectedBerth)){status.textContent='Choose an available harbor and berth.';return;}void run(()=>source.accept(arrival,target,{portId:target.id,berth:selectedBerth,strategy:strategyId}),status);});
    dialog.append(form,confirm,button('Back',notice,true),button('Free up yard',()=>{close();source.transfer();},true));
  }
  function open(port:ArrivalPort,arrival?:Arrival){
    if(busy||document.body.dataset.launch!=='playing'||document.querySelector('dialog[open]'))return;
    clearToast();current={port,arrival};previousFocus=document.activeElement instanceof HTMLElement?document.activeElement:null;notice();dialog.show();dialog.querySelector<HTMLButtonElement>('button')?.focus();
  }
  return {
    register(port:ArrivalPort){ports.set(port.id,port);},
    open(id:PortId,index:number){const port=ports.get(id);const arrival=port?.arrivals().find(a=>a.index===index);if(port&&arrival)open(port,arrival);},
    tick(){
      if(document.body.dataset.launch!=='playing'||busy)return;
      if(dialog.open){clearToast();return;}
      let candidate:{port:ArrivalPort;arrival?:Arrival}|undefined;
      for(const port of ports.values()){for(const arrival of port.arrivals())if((deferred.get(arrival.manifest.id)??0)<Date.now()){candidate={port,arrival};break;}if(candidate)break;}
      if(!candidate)for(const port of ports.values())if(port.full()&&(deferred.get(`full:${port.id}`)??0)<Date.now()){candidate={port};break;}
      if(!candidate){if(!dialog.open)clearToast();return;}
      if(document.querySelector('.tf-command-panel:not([hidden])')||dialog.open||document.querySelector('dialog[open]')){showToast(candidate);return;}
      open(candidate.port,candidate.arrival);
    },
    dispose(){dialog.remove();toast.remove();}
  };
}
