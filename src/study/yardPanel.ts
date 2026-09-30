import { ArcRotateCamera, Color3, MeshBuilder, Scene, Vector3 } from '@babylonjs/core';

export interface YardSnapshot {
  levels:number[];
  reserved:number[];
  receiving:number|null;
  trip:number;
  completed:number;
  total:number;
  phase:string;
}

/** Inventory mirrors completed handoffs, never containers still suspended from the hook. */
export function yardPanel(scene:Scene,uiRoot:ParentNode=document){
  const panel=document.createElement('section');
  panel.id='yard-inventory';panel.className='yard-panel';panel.hidden=true;
  panel.setAttribute('aria-label','Container yard management');
  panel.innerHTML=`<div class="yard-heading"><h2>Container yard</h2><button type="button" aria-label="Close yard management">×</button></div>
    <p class="yard-total"></p><progress max="36" value="18" aria-label="Yard capacity"></progress>
    <p class="yard-phase"></p><div class="yard-grid" role="group" aria-label="Expanded container yard"></div>
    <p class="yard-selection">Select a slot to inspect its stack.</p>
    <p class="yard-key">Each slot holds up to 3 tiers. Row A is nearest the apron; row D is nearest the wall. + shows containers waiting to stack.</p>`;
  uiRoot.querySelector('#interface')!.append(panel);
  // Yard telemetry remains available to the simulation, but the old standalone inventory panel is not exposed in the HUD.
  const toggle=document.createElement('button');toggle.hidden=true;
  const total=panel.querySelector<HTMLElement>('.yard-total')!,phase=panel.querySelector<HTMLElement>('.yard-phase')!;
  const progress=panel.querySelector('progress')!,selection=panel.querySelector<HTMLElement>('.yard-selection')!;
  let selected=-1,lastKey='',snapshot:YardSnapshot|null=null;
  const outline=MeshBuilder.CreateLines('Selected storage slot',{points:[new Vector3(-2.3,0,-1.1),new Vector3(2.3,0,-1.1),new Vector3(2.3,0,1.1),new Vector3(-2.3,0,1.1),new Vector3(-2.3,0,-1.1)]},scene);
  outline.color=Color3.FromHexString('#fff0a8');outline.isPickable=false;outline.setEnabled(false);
  const label=(index:number)=>`${String.fromCharCode(65+Math.floor(index/3))}${index%3+1}`;
  function showSelection(){
    if(selected<0||!snapshot)return;
    const level=snapshot.levels[selected],pending=snapshot.reserved[selected];
    selection.textContent=`Slot ${label(selected)} · ${level}/3 tiers · ${pending?`${pending} containers waiting to stack`:level===3?'Full':`Remaining ${3-level} open tiers`}`;
    outline.position.set(1.8+(selected%3)*4.6,1.48+level*2.05+.08,-16-Math.floor(selected/3)*2.3);
    outline.setEnabled(!panel.hidden);
  }
  const buttons=Array.from({length:36},(_,index)=>{
    const button=document.createElement('button');button.type='button';button.className='yard-cell';
    button.innerHTML=`<strong>${label(index)}</strong><span class="yard-level"></span><span class="yard-pending"></span>`;
    button.setAttribute('aria-pressed','false');
    button.onclick=()=>{
      selected=index;buttons.forEach((b,i)=>b.setAttribute('aria-pressed',String(i===index)));showSelection();
      if(scene.activeCamera instanceof ArcRotateCamera){
        const camera=scene.activeCamera;camera.inertialAlphaOffset=0;camera.inertialBetaOffset=0;camera.inertialRadiusOffset=0;
        camera.alpha=1.35;camera.beta=.75;camera.radius=21;
        outline.computeWorldMatrix(true);const worldPosition=outline.getAbsolutePosition();camera.setTarget(new Vector3(worldPosition.x,3.2,worldPosition.z));
      }
    };
    panel.querySelector('.yard-grid')!.append(button);return button;
  });
  function setOpen(open:boolean){panel.hidden=!open;toggle.setAttribute('aria-expanded',String(open));outline.setEnabled(open&&selected>=0);if(open)showSelection();}
  toggle.onclick=()=>setOpen(panel.hidden);
  panel.querySelector<HTMLButtonElement>('.yard-heading button')!.onclick=()=>{setOpen(false);toggle.focus();};
  panel.addEventListener('keydown',event=>{if(event.key==='Escape'){setOpen(false);toggle.focus();}});
  return {update(value:YardSnapshot){
    const key=JSON.stringify(value);if(key===lastKey)return;lastKey=key;snapshot=value;
    const capacity=value.levels.length*3;progress.max=capacity;
    const used=value.levels.reduce((a,b)=>a+b,0),pending=value.reserved.reduce((a,b)=>a+b,0);
    total.textContent=`${used}/${capacity} container · ${used===capacity?'Yard full':`Remaining ${capacity-used} tier positions`}`;
    progress.value=used;phase.textContent=`Voyage ${value.trip} · ${value.phase} · Delivered ${value.completed}/${value.total}${pending?` · ${pending} containers reserved`:''}`;
    buttons.forEach((button,index)=>{
      button.hidden=index>=value.levels.length;if(button.hidden)return;
      const level=value.levels[index],reserved=value.reserved[index],receiving=value.receiving===index;
      button.querySelector('.yard-level')!.textContent=`${level}/3`;
      button.querySelector('.yard-pending')!.textContent=receiving?'Stacking':reserved?`+${reserved} waiting`:level===3?'Full':'Space available';
      button.dataset.full=String(level===3);button.dataset.receiving=String(receiving);
      button.setAttribute('aria-label',`Slot ${label(index)}, ${level} of 3 tiers${reserved?`, ${reserved} containers waiting to stack`:''}${receiving?', crane is delivering':''}`);
    });
    showSelection();
  }};
}
