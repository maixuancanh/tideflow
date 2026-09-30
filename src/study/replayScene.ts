import { ArcRotateCamera, Color3, Color4, DynamicTexture, Engine, HemisphericLight, Mesh, MeshBuilder, Quaternion, Scene, StandardMaterial, TransformNode, Vector3 } from '@babylonjs/core';
import { sampleResourceJob, type ResourceSchedule } from './resourceSchedule';

type Cargo = { id:string; symbol:string; address:string };
export interface ReplaySceneInput { schedule:ResourceSchedule; cargo:readonly Cargo[]; chain:string; berth:number }
const mix=(a:Vector3,b:Vector3,t:number)=>Vector3.Lerp(a,b,Math.max(0,Math.min(1,t)));
const fraction=(t:number,a:number,b:number)=>b<=a?Number(t>=b):(t-a)/(b-a);

/** Own engine, meshes and clock. This view has no session/economy/network imports.
 * Every pose is sampled from the recorded schedule, so backward seek is exact.
 * Geometry is a schematic reconstruction; imported harbour art is not recorded. */
export function createReplayScene(canvas:HTMLCanvasElement){
  const engine=new Engine(canvas,true,{preserveDrawingBuffer:false,stencil:true});
  const scene=new Scene(engine);scene.clearColor=new Color4(.1,.32,.36,1);
  const camera=new ArcRotateCamera('replay-camera',-Math.PI/2.5,1.0,37,new Vector3(0,1,0),scene);
  camera.attachControl(canvas,true);camera.lowerRadiusLimit=15;camera.upperRadiusLimit=60;camera.upperBetaLimit=1.5;
  new HemisphericLight('replay-light',new Vector3(.4,1,-.3),scene).intensity=1.3;
  const mat=(name:string,color:string)=>{const m=new StandardMaterial(name,scene);m.diffuseColor=Color3.FromHexString(color);m.specularColor=new Color3(.1,.1,.1);return m;};
  const ground=mat('quay','#a9aaa0'),water=mat('sea','#287f8a'),steel=mat('steel','#d27344'),dark=mat('dark','#253e43'),yellow=mat('truck','#dec35d');
  function box(name:string,size:Vector3,position:Vector3,material:StandardMaterial,parent?:TransformNode){const mesh=MeshBuilder.CreateBox(name,{width:size.x,height:size.y,depth:size.z},scene);mesh.position.copyFrom(position);mesh.material=material;if(parent)mesh.parent=parent;return mesh;}
  box('sea',new Vector3(55,.2,45),new Vector3(0,-.8,0),water);
  box('quay',new Vector3(28,.8,19),new Vector3(0,-.4,2.5),ground);
  box('garage-roof',new Vector3(5,.3,4),new Vector3(-10,3.7,8),dark);
  for(const x of [-12.3,-7.7])box('garage-side',new Vector3(.25,3.5,4),new Vector3(x,1.8,8),ground);
  for(let b=0;b<3;b++)box(`berth-${b+1}`,new Vector3(7,.15,.4),new Vector3(-9+b*9,.1,-6.9),yellow);
  const ship=new TransformNode('replay-ship',scene);
  box('hull',new Vector3(8,1.1,3),new Vector3(0,.2,0),dark,ship);
  box('bridge',new Vector3(1.5,2,2.6),new Vector3(-3.1,1.5,0),ground,ship);
  const dockPoint=new Vector3(-4,1.65,-4.5),yardPoint=new Vector3(6,1.65,2),garagePoint=new Vector3(-10,.5,8),queuePoint=new Vector3(-7,.5,-4.5);
  type Crane={base:Vector3; mast:Mesh; boom:Mesh; rope:Mesh; hook:Mesh};
  const link=(mesh:Mesh,a:Vector3,b:Vector3)=>{mesh.position.copyFrom(a.add(b).scale(.5));const v=b.subtract(a);mesh.scaling.y=Math.max(.001,v.length());mesh.rotationQuaternion=Quaternion.FromUnitVectorsToRef(Vector3.Up(),v.normalize(),new Quaternion());};
  function crane(name:string,base:Vector3):Crane{const mast=box(name+'-mast',new Vector3(.4,6,.4),base.add(new Vector3(0,3,0)),steel);const boom=box(name+'-boom',new Vector3(.25,1,.25),Vector3.Zero(),steel);const rope=box(name+'-rope',new Vector3(.04,1,.04),Vector3.Zero(),dark);const hook=box(name+'-hook',new Vector3(.3,.25,.3),Vector3.Zero(),dark);return {base,mast,boom,rope,hook};}
  const dock=crane('dock-crane',new Vector3(-2,0,-5)),yard=crane('yard-crane',new Vector3(8,0,0));
  const poseCrane=(c:Crane,p:Vector3)=>{const tip=new Vector3(p.x,Math.max(6,p.y+1.5),p.z);link(c.boom,c.base.add(new Vector3(0,6,0)),tip);link(c.rope,tip,p);c.hook.position.copyFrom(p);};
  let input:ReplaySceneInput|undefined,trucks:TransformNode[]=[],containers:Mesh[]=[],cargoMaterials:StandardMaterial[]=[],textures:DynamicTexture[]=[],visible=false;
  function load(next:ReplaySceneInput){
    input=next;
    trucks.forEach(t=>t.dispose());containers.forEach(c=>c.dispose());cargoMaterials.forEach(m=>m.dispose());textures.forEach(t=>t.dispose());
    trucks=[];containers=[];cargoMaterials=[];textures=[];
    ship.position.set(-9+next.berth*9,0,-9);
    dockPoint.x=-9+next.berth*9;queuePoint.x=dockPoint.x-3;
    dock.base.x=dockPoint.x+2;dock.mast.position.x=dock.base.x;
    for(let i=0;i<next.schedule.truckCount;i++){
      const t=new TransformNode(`replay-truck-${i}`,scene);trucks.push(t);
      box('truck-body',new Vector3(1.2,.7,1.8),new Vector3(0,.25,0),yellow,t);
      box('fork-mast',new Vector3(1.1,1.8,.15),new Vector3(0,1,.9),dark,t);
      for(const x of [-.42,.42])box('fork',new Vector3(.16,.12,1.2),new Vector3(x,.55,1.4),dark,t);
      for(const x of [-.65,.65])for(const z of [-.6,.6]){const wheel=MeshBuilder.CreateCylinder('wheel',{diameter:.55,height:.2},scene);wheel.rotation.z=Math.PI/2;wheel.position.set(x,0,z);wheel.material=dark;wheel.parent=t;}
    }
    for(const [i,cargo] of next.cargo.entries()){
      const tex=new DynamicTexture(`cargo-label-${i}`,{width:512,height:256},scene,false);textures.push(tex);
      const context=tex.getContext();context.fillStyle=next.chain.toLowerCase().includes('bnb')?'#d8b644':'#7486df';context.fillRect(0,0,512,256);context.fillStyle='#ffffff';(context as CanvasRenderingContext2D).textAlign='center';context.font='bold 64px sans-serif';context.fillText(cargo.symbol.slice(0,12),256,132);context.font='24px sans-serif';context.fillText(next.chain,256,190);tex.update();
      const material=mat(`cargo-${i}`,'#ffffff');material.diffuseTexture=tex;cargoMaterials.push(material);
      containers.push(box(`replay-cargo-${cargo.id}`,new Vector3(2,1.1,1.1),Vector3.Zero(),material));
    }
    sample(0);
  }
  function sample(time:number){
    if(!input)return;
    const {schedule}=input;
    trucks.forEach((t,i)=>{t.position.set(-11+(i%3),.5,7+Math.floor(i/3));t.rotation.y=0;});
    poseCrane(dock,dockPoint.add(new Vector3(0,1.6,0)));poseCrane(yard,yardPoint.add(new Vector3(0,1.6,0)));
    schedule.jobs.forEach((job,i)=>{
      const cargo=containers[i];if(!cargo)return;
      const phase=sampleResourceJob(job,time),truck=trucks[job.truck];
      const aboard=ship.position.add(new Vector3(-1.6+(i%4)*1.35,1.3+Math.floor(i/4)*1.1,0));
      const stored=new Vector3(2+(i%3)*2.25,.55+Math.floor(i/12)*1.1,5+Math.floor(i%12/3)*1.3);
      const receive=new Vector3(dockPoint.x,.5,dockPoint.z),drop=new Vector3(yardPoint.x,.5,yardPoint.z);
      const queue=queuePoint.clone();
      let truckPos=garagePoint.clone();
      if(time>=job.approachAt&&time<job.queueAt)truckPos=mix(garagePoint,queue,fraction(time,job.approachAt,job.queueAt));
      else if(time>=job.queueAt&&time<job.dockAt)truckPos=mix(queue,receive,Math.max(0,fraction(time,job.dockAt-.2,job.dockAt)));
      else if(time>=job.dockAt&&time<job.dockReleasedAt)truckPos=receive;
      else if(time>=job.dockReleasedAt&&time<job.yardArrivedAt)truckPos=mix(receive,drop,fraction(time,job.dockReleasedAt,job.yardArrivedAt));
      else if(time>=job.yardArrivedAt&&time<job.truckClearAt)truckPos=drop;
      else if(time>=job.truckClearAt)truckPos=mix(drop,garagePoint,fraction(time,job.truckClearAt,job.truckReturnedAt));
      if(phase.truckActive){truck.position.copyFrom(truckPos);const target=time<job.dockAt?receive:time<job.truckClearAt?drop:garagePoint;const direction=target.subtract(truckPos);if(direction.lengthSquared()>.001)truck.rotation.y=Math.atan2(direction.x,direction.z);}
      if(phase.cargoPhase==='aboard')cargo.position.copyFrom(aboard);
      else if(phase.cargoPhase==='dock'){
        const p=Math.max(0,Math.min(1,fraction(time,job.liftedAt,job.dockReleasedAt)));
        const high=aboard.clone();high.y=4.7;const over=dockPoint.clone();over.y=4.7;
        cargo.position.copyFrom(p<.25?mix(aboard,high,p*4):p<.7?mix(high,over,(p-.25)/.45):mix(over,dockPoint,(p-.7)/.3));
      }else if(phase.cargoPhase==='truck')cargo.position.copyFrom(truckPos.add(new Vector3(0,1.15,0)));
      else if(phase.cargoPhase==='yard'){
        const p=Math.max(0,Math.min(1,fraction(time,job.yardLiftedAt,job.placedAt)));
        const high=yardPoint.clone();high.y=5;const over=stored.clone();over.y=5;
        cargo.position.copyFrom(p<.25?mix(yardPoint,high,p*4):p<.75?mix(high,over,(p-.25)*2):mix(over,stored,(p-.75)*4));
      }else cargo.position.copyFrom(stored);
      if(time>=job.dockAt&&time<job.dockResetAt)poseCrane(dock,cargo.position.add(new Vector3(0,.65,0)));
      if(time>=job.yardAt&&time<job.yardResetAt)poseCrane(yard,cargo.position.add(new Vector3(0,.65,0)));
    });
    if(visible)scene.render();
  }
  const observer=new ResizeObserver(()=>engine.resize());observer.observe(canvas);
  engine.runRenderLoop(()=>{if(visible)scene.render();});
  return {load,sample,setVisible(value:boolean){visible=value;if(value){engine.resize();scene.render();}},dispose(){observer.disconnect();scene.dispose();engine.dispose();}};
}
