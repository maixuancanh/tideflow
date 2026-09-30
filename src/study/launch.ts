import { ArcRotateCamera, Color3, DynamicTexture, Mesh, MeshBuilder, Scene, StandardMaterial, Vector3 } from '@babylonjs/core';

/** The launch gate owns visibility and input until the first playable frame. */
export function launchScreen(){
  const root=document.querySelector<HTMLElement>('#loading')!;
  const status=root.querySelector<HTMLElement>('#launch-status')!;
  const progress=root.querySelector<HTMLProgressElement>('progress')!;
  const play=root.querySelector<HTMLButtonElement>('#launch-play')!;
  const retry=root.querySelector<HTMLButtonElement>('#launch-retry')!;
  const tips=['Live onchain activity becomes port traffic, cargo demand and yard decisions.','Every container carries a chain and token identity.','Unload, store, export, and keep the harbor moving.','Nansen data powers the port. Your decisions run it.','The market moves. The harbor responds.'];
  root.querySelector('#launch-tip')!.textContent=tips[Math.floor(Math.random()*tips.length)];
  retry.onclick=()=>location.reload();
  const stage=(value:number,label:string)=>{progress.value=Math.max(progress.value,value);status.textContent=label;};
  async function profile(){
    const saved=localStorage.getItem('tideflow.profile.v1');
    if(saved){try{const p=JSON.parse(saved);if(typeof p.username==='string'&&p.username.trim())return p;}catch{/* Show creation form for invalid saves. */}}
    const form=root.querySelector<HTMLFormElement>('#launch-profile')!;form.hidden=false;
    const input=form.querySelector<HTMLInputElement>('input')!;input.focus();
    return new Promise<{username:string}>(resolve=>{form.onsubmit=event=>{event.preventDefault();const username=input.value.trim();if(!username){input.setCustomValidity('Enter a captain name.');input.reportValidity();return;}try{const p={username};localStorage.setItem('tideflow.profile.v1',JSON.stringify(p));form.hidden=true;resolve(p);}catch{fail();}};input.oninput=()=>input.setCustomValidity('');});
  }
  function fail(){document.body.dataset.launch='error';root.hidden=false;root.querySelector<HTMLFormElement>('#launch-profile')!.hidden=true;play.hidden=true;progress.hidden=true;status.textContent='Unable to prepare the harbor.';retry.hidden=false;retry.focus();}
  return {stage,profile,fail,async artwork(){const background=new Image();background.src='/study/loading-harbor.png';await Promise.all([background.decode(),...Array.from(root.querySelectorAll('img')).map(img=>img.decode())]);},async waitForPlay(){stage(100,'Ready to sail');play.hidden=false;play.focus();await new Promise<void>(resolve=>{play.onclick=()=>{play.disabled=true;resolve();};});document.body.dataset.launch='cinematic';root.hidden=true;},complete(){document.body.dataset.launch='playing';document.querySelector<HTMLCanvasElement>('#scene')?.focus();}};
}

/** Layered camera-facing cloud meshes; no simulation time elapses in the intro. */
export function createArrival(scene:Scene,camera:ArcRotateCamera,target:Vector3,radius:number){
  const texture=new DynamicTexture('Arrival cloud texture',512,scene,false);
  const ctx=texture.getContext() as CanvasRenderingContext2D;ctx.clearRect(0,0,512,512);
  for(let i=0;i<28;i++){const angle=i*2.39996,r=80+50*Math.sin(i*1.7),x=256+Math.cos(angle)*r,y=256+Math.sin(angle)*r;
    const gradient=ctx.createRadialGradient(x,y,5,x,y,145);gradient.addColorStop(0,'rgba(255,255,250,.98)');gradient.addColorStop(.55,'rgba(239,246,243,.85)');gradient.addColorStop(1,'rgba(239,246,243,0)');ctx.fillStyle=gradient;ctx.fillRect(x-145,y-145,290,290);}
  texture.hasAlpha=true;texture.update();
  const material=new StandardMaterial('Arrival cloud',scene);material.diffuseTexture=texture;material.useAlphaFromDiffuseTexture=true;material.emissiveColor=Color3.White();material.disableLighting=true;material.backFaceCulling=false;material.disableDepthWrite=true;
  const clouds=Array.from({length:35},(_,i)=>{const mesh=MeshBuilder.CreatePlane('Arrival cloud '+i,{size:1,sideOrientation:Mesh.DOUBLESIDE},scene);mesh.parent=camera;mesh.material=material;mesh.isPickable=false;mesh.renderingGroupId=3;mesh.alwaysSelectAsActiveMesh=true;return {mesh,x:(i%7-3)/3,y:(Math.floor(i/7)-2)/2,depth:18+i%3};});
  const veil=document.createElement('div');veil.className='arrival-veil';document.body.append(veil);
  camera.detachControl();camera.lowerBetaLimit=.05;camera.upperRadiusLimit=radius*3;camera.setTarget(target);camera.alpha=1.12;camera.beta=.12;camera.radius=radius*2.7;
  const ease=(t:number)=>t*t*(3-2*t);
  function sample(t:number){const u=ease(t),spread=ease(Math.max(0,Math.min(1,(t-.22)/.65)));
    camera.beta=.12+(.84-.12)*u;camera.radius=radius*(2.7-1.7*u);
    veil.style.opacity=String(1-Math.min(1,t/.4));
    const aspect=scene.getEngine().getAspectRatio(camera);
    for(const c of clouds){const h=Math.tan(camera.fov/2)*c.depth,w=h*aspect;c.mesh.position.set(c.x*w*(1+spread*2.8),c.y*h*(1+spread*2.8),-c.depth);c.mesh.scaling.set(w*1.15*(1+spread*.6),h*1.8*(1+spread*.6),1);c.mesh.visibility=1-ease(Math.max(0,(t-.45)/.55));}
  }
  sample(0);
  return {sample,async play(){const duration=matchMedia('(prefers-reduced-motion: reduce)').matches?900:5800;await new Promise<void>(resolve=>{const started=performance.now();const tick=()=>{if(document.hidden){requestAnimationFrame(tick);return;}const t=Math.min(1,(performance.now()-started)/duration);sample(t);if(t<1)requestAnimationFrame(tick);else resolve();};requestAnimationFrame(tick);});clouds.forEach(c=>c.mesh.dispose());material.dispose();texture.dispose();veil.remove();camera.lowerBetaLimit=.4;camera.upperRadiusLimit=radius+20;camera.attachControl(scene.getEngine().getRenderingCanvas()!,true);}};
}
