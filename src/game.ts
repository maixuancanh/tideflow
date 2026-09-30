import { TransformNode, Vector3 } from '@babylonjs/core';
import type { World } from './world';

export type VesselState='waiting'|'sailing'|'docked'|'unloading'|'departing';
export type Vessel={name:string,state:VesselState,berth:number|null,cargo:number,progress:number,from:Vector3,to:Vector3};
const ease=(t:number)=>t*t*(3-2*t);
export class HarborGame {
  selected=0;paused=false;time=0;delivered=0;storage=12;capacity=24;credits=180;shift=1;completed=false;
  toast='Select UNLOAD to work the Coral. Route the Mariner to an open berth.';
  vessels:Vessel[];
  changed:()=>void=()=>{};
  constructor(public world:World){
    this.vessels=this.initial();
    world.onSelect((kind,id)=>kind==='vessel'?this.select(id):this.route(id));
    world.cranes.forEach((c,i)=>c.hoist.setEnabled(i===0));
  }
  initial():Vessel[]{return [
    {name:'MV Coral',state:'docked',berth:0,cargo:4,progress:0,from:new Vector3(),to:new Vector3()},
    {name:'MV Mariner',state:'waiting',berth:null,cargo:4,progress:0,from:new Vector3(),to:new Vector3()},
  ];}
  notice(message:string){this.toast=message;this.changed();}
  select(id:number){this.selected=id;this.world.clearRoute();const v=this.vessels[id];this.notice(v.state==='waiting'?'Choose an open berth below to route this vessel.':`${v.name} · ${v.state}. ${v.cargo} containers on board.`);}
  route(berth:number){
    if(this.paused||this.completed)return;
    const v=this.vessels[this.selected];
    if(v.state!=='waiting'){this.notice('Select a vessel waiting in the bay before choosing a berth.');return;}
    if(this.vessels.some(other=>other.berth===berth)){this.notice('That berth is occupied. Choose an open berth.');return;}
    v.berth=berth;v.state='sailing';v.progress=0;v.from=this.world.vessels[this.selected].root.position.clone();v.to=this.world.berths[berth].dock.clone();
    this.world.drawRoute(v.from,v.to);this.notice(`${v.name} is heading to berth 0${berth+1}.`);
  }
  unload(){
    const v=this.vessels[this.selected];if(this.paused||this.completed||v.state!=='docked')return;
    if(this.storage+v.cargo>this.capacity){this.notice('The yard is full. Dispatch cargo or upgrade storage first.');return;}
    v.state='unloading';v.progress=0;this.notice(`Unloading ${v.name}. The crane is now working.`);
  }
  dispatch(){if(this.paused||this.completed)return;const n=Math.min(8,this.storage);if(!n){this.notice('The yard is empty. Unload a vessel first.');return;}this.storage-=n;this.credits+=n*10;this.notice(`${n} containers dispatched inland. +${n*10} harbor credits.`);}
  upgrade(){if(this.paused||this.completed)return;if(this.credits<120){this.notice('You need 120 harbor credits. Dispatch cargo to earn more.');return;}this.credits-=120;this.capacity+=8;this.notice('Storage expanded by 8 slots.');}
  pause(){this.paused=!this.paused;this.changed();}
  reset(){this.vessels=this.initial();this.time=0;this.storage=12;this.capacity=24;this.credits=180;this.delivered=0;this.shift=1;this.paused=false;this.completed=false;this.selected=0;
    this.world.vessels.forEach((v,i)=>{v.root.position.copyFrom(i===0?this.world.berths[0].dock:new Vector3(8,.07,16));v.root.rotation.y=i===0?0:-.55;v.cargo.getChildren().forEach(c=>(c as TransformNode).setEnabled(true));});
    this.world.cranes.forEach((c,i)=>{c.turret.rotation.y=0;c.hoist.position.y=2.95;c.hoist.setEnabled(i===0);});this.world.clearRoute();this.notice('New practice shift. Unload both vessels, then dispatch the cargo.');
  }
  update(dt:number){
    if(this.paused||this.completed)return;this.time+=dt;
    this.vessels.forEach((v,i)=>{
      const visual=this.world.vessels[i];
      if(v.state==='sailing'||v.state==='departing'){
        v.progress=Math.min(1,v.progress+dt/(v.state==='departing'?12:15));const t=ease(v.progress);
        const pos=Vector3.Lerp(v.from,v.to,t);pos.x+=Math.sin(t*Math.PI)*2;visual.root.position.x=pos.x;visual.root.position.z=pos.z;
        const next=Vector3.Lerp(v.from,v.to,Math.min(1,t+.005));next.x+=Math.sin(Math.min(1,t+.005)*Math.PI)*2;
        if(t<.999)visual.root.rotation.y=Math.atan2(next.x-pos.x,next.z-pos.z);
        if(v.progress>=1){if(v.state==='sailing'){v.state='docked';visual.root.rotation.y=0;this.world.clearRoute();this.notice(`${v.name} has docked. Select it and unload.`);}else{v.state='waiting';v.berth=null;v.progress=0;v.cargo=4;visual.cargo.getChildren().forEach(c=>(c as TransformNode).setEnabled(true));if(this.delivered>=8){this.completed=true;this.notice('Shift complete! Eight containers safely unloaded. Start a new shift to play again.');}}}
      }
      if(v.state==='unloading'&&v.berth!==null){
        v.progress+=dt/6;const c=this.world.cranes[v.berth];c.hoist.setEnabled(true);
        const t=Math.min(v.progress,1);c.hoist.position.y=2.65+Math.sin(t*Math.PI)*1.1;c.turret.rotation.y=Math.sin(t*Math.PI)*-1.35;
        c.cable.scaling.y=5.15-c.hoist.position.y-.14;c.cable.position.y=(5.15+c.hoist.position.y+.14)/2;
        if(v.progress>=1){
          v.progress=0;v.cargo--;this.storage++;this.delivered++;this.credits+=25;c.turret.rotation.y=0;
          const cargo=visual.cargo.getChildren() as TransformNode[];cargo[3-v.cargo]?.setEnabled(false);
          this.changed();
          if(v.cargo===0){c.hoist.setEnabled(false);v.state='departing';v.progress=0;v.from=visual.root.position.clone();v.to=new Vector3(i===0?-8:10,.07,19);this.notice(`${v.name} is leaving. +100 harbor credits earned.`);}
        }
      }
    });
  }
}
