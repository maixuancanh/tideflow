import {ArcRotateCamera,Scene} from '@babylonjs/core';
type MapPort={x:number;z:number;read:()=>{ships:Array<{x:number;z:number;visible:boolean;name:string}>}};
const COLORS=['#ffb649','#ae90ff','#37b9ff','#ff7667','#66dc82'];
const WORLD={minX:-100,maxX:155,minZ:-30,maxZ:115};
/** Static minimap artwork plus cheap DOM markers. No secondary Babylon camera or readback. */
export function mountSceneMinimap(scene:Scene,main:ArcRotateCamera,ports:MapPort[]){
 const host=document.querySelector<HTMLElement>('.tf-minimap');if(!host)return;
 host.replaceChildren();host.setAttribute('aria-label','Harbor map with live vessel positions');
 const rotor=document.createElement('div');rotor.className='tf-map-rotor';
 const image=document.createElement('img');image.src='/brand/minimap-terrain.png';image.alt='Static overhead harbor terrain';image.draggable=false;rotor.append(image);host.append(rotor);
 const heading=document.createElement('span');heading.className='tf-map-heading';heading.setAttribute('aria-hidden','true');host.append(heading);
 const markers=ports.map(port=>port.read().ships.map((ship,index)=>{const el=document.createElement('span');el.className='tf-map-vessel';el.style.background=COLORS[index%COLORS.length];el.title=ship.name;rotor.append(el);return el;}));
 let last=0,disposed=false;
 const percent=(x:number,z:number)=>({x:Math.max(4,Math.min(96,(x-WORLD.minX)/(WORLD.maxX-WORLD.minX)*100)),y:Math.max(4,Math.min(96,100-(z-WORLD.minZ)/(WORLD.maxZ-WORLD.minZ)*100))});
 const observer=scene.onAfterRenderObservable.add(()=>{
  if(disposed||document.hidden||document.body.dataset.launch!=='playing'||performance.now()-last<120)return;last=performance.now();
  rotor.style.transform=`rotate(${main.alpha-Math.PI/2}rad)`;
  ports.forEach((port,p)=>port.read().ships.forEach((ship,index)=>{const marker=markers[p][index];if(!marker)return;marker.hidden=!ship.visible;if(!ship.visible)return;const pos=percent(port.x+ship.x,port.z+ship.z);marker.style.left=`${pos.x}%`;marker.style.top=`${pos.y}%`;}));
 });
 scene.onDisposeObservable.addOnce(()=>{disposed=true;scene.onAfterRenderObservable.remove(observer);});
}
