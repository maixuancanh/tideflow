import { ArcRotateCamera, Color3, Color4, DirectionalLight, Engine, HemisphericLight, Mesh, MeshBuilder, Scene, ShadowGenerator, TransformNode, Vector3, DynamicTexture, StandardMaterial, PointerEventTypes } from '@babylonjs/core';
import { Assets } from './assets';
import { Shapes, batch, seedRandom } from './geometry';
import { palette } from './materials';
import { createWater } from './water';

export function buildWorld(canvas: HTMLCanvasElement) {
  const engine=new Engine(canvas,true,{preserveDrawingBuffer:true,stencil:true,antialias:true});
  engine.setHardwareScalingLevel(Math.max(1,window.devicePixelRatio/1.5));
  const scene=new Scene(engine);scene.useRightHandedSystem=true;scene.clearColor=new Color4(.62,.79,.81,1);
  scene.ambientColor=new Color3(.22,.23,.2);
  const camera=new ArcRotateCamera('harbor camera',Math.PI/2-.13, .98, 51,new Vector3(0,1,-3.5),scene);
  camera.fov=.78;
  camera.lowerRadiusLimit=26;camera.upperRadiusLimit=85;camera.lowerBetaLimit=.36;camera.upperBetaLimit=1.2;
  camera.wheelPrecision=5;camera.panningSensibility=95;camera.inertia=.78;camera.minZ=.15;camera.maxZ=350;camera.attachControl(canvas,true);
  // Camera is on positive Z looking toward warehouse behind the piers.
  camera.alpha=Math.PI/2-.15;
  const home={alpha:camera.alpha,beta:camera.beta,radius:camera.radius,target:camera.target.clone()};
  const ambient=new HemisphericLight('sky bounce',new Vector3(0,1,0),scene);ambient.intensity=.79;ambient.diffuse=Color3.FromHexString('#e4f4ed');ambient.groundColor=Color3.FromHexString('#a1a084');
  const sun=new DirectionalLight('warm afternoon sun',new Vector3(.65,-1,.38),scene);sun.position.set(-32,45,-26);sun.intensity=1.45;sun.diffuse=Color3.FromHexString('#fff0d2');
  const shadows=new ShadowGenerator(2048,sun);shadows.useBlurExponentialShadowMap=true;shadows.blurKernel=24;shadows.darkness=.24;shadows.bias=.001;shadows.normalBias=.025;
  const p=palette(scene),g=new Shapes(scene),a=new Assets(scene,p),staticRoot=new TransformNode('harbor buildings and coastline',scene);
  const water=createWater(scene);
  // Back shore: a broad apron, articulated seawall, three finger piers.
  g.box('main apron',0,.48,-14,45,1.0,13,p.concrete,staticRoot,.25);
  g.box('back island',0,.18,-66,160,.8,100,p.soil,staticRoot,.6);
  for(let x=-22;x<=22;x+=2.15){g.box('quay wall block',x,.3,-7.5,2.1,.78,.55,p.edge,staticRoot,.045);g.box('quay coping',x,.88,-7.35,2.16,.15,.74,p.cream,staticRoot,.04);}
  const berthXs=[-14,0,14];
  const berths=berthXs.map((x,index)=>{
    const length=index===1?12:11;
    const pier=g.box('pier '+(index+1),x,.47,-2.2,4.7,1.0,length,p.concrete,staticRoot,.18);pier.metadata={berth:index};
    for(const side of [-1,1]){
      g.box('raised stone edge',x+side*2.26,1.025,-2.2,.25,.13,length-.2,p.edge,staticRoot,.04);
      for(let z=-6.5;z<3;z+=1.9){
        const f=g.torus('black rubber quay fender',x+side*2.4,.45,z,.72,.22,p.black,staticRoot);f.rotation.z=Math.PI/2;
        g.beam('fender rope',new Vector3(x+side*2.34,.94,z),new Vector3(x+side*2.42,.55,z),.017,p.black,staticRoot);
        g.cylinder('mooring bollard',x+side*1.95,1.18,z,.11,.39,p.orangeDark,staticRoot);g.cylinder('bollard cap',x+side*1.95,1.39,z,.18,.09,p.orange,staticRoot);
      }
      g.box('yellow edge marking',x+side*1.65,1.037,-1.8,.07,.012,length-.9,p.line,staticRoot,.003);
    }
    for(let z=-6;z<3;z+=1.6)g.box('loading center dash',x,1.038,z,.07,.012,.65,p.white,staticRoot,.003);
    const signRoot=new TransformNode('berth sign '+index,scene);signRoot.position.set(x,1,-.9);
    g.cylinder('sign pole',0,.75,0,.052,1.5,p.steel,signRoot);
    const mat=new StandardMaterial('berth number '+index,scene);const texture=new DynamicTexture('painted sign',{width:256,height:256},scene,false);const ctx=texture.getContext() as CanvasRenderingContext2D;ctx.fillStyle='#263f46';ctx.fillRect(0,0,256,256);ctx.strokeStyle='#eee7cb';ctx.lineWidth=12;ctx.strokeRect(8,8,240,240);ctx.font='bold 145px Arial';ctx.fillStyle='#fff2d3';ctx.textAlign='center';ctx.fillText('0'+(index+1),128,183);texture.update();mat.diffuseTexture=texture;mat.emissiveColor=new Color3(.16,.16,.14);mat.backFaceCulling=false;
    const sign=MeshBuilder.CreatePlane('berth number',{size:1.05,sideOrientation:Mesh.DOUBLESIDE},scene);sign.material=mat;sign.position.y=1.6;sign.parent=signRoot;
    return {index,x,dock:new Vector3(x-4.15,.07,-1.2),label:signRoot};
  });
  const warehouse=a.warehouse();warehouse.position.set(-9,1,-15.2);warehouse.parent=staticRoot;
  const colors=[p.blue,p.coral,p.yellow,p.cargoCream];
  for(let row=0;row<3;row++)for(let col=0;col<7;col++)for(let level=0;level<(col>3?3:2);level++){
    const c=a.container('yard cargo',colors[(row+col+level)%4],1.12);c.position.set(2.2+col*1.47,1.01+level*1.15,-12-row*3.05);c.parent=staticRoot;
  }
  const forklift=a.forklift();forklift.position.set(-8,1,-10.6);forklift.rotation.y=-.35;forklift.parent=staticRoot;
  const truck=a.forklift();truck.position.set(7,1,-8.8);truck.rotation.y=1.2;truck.parent=staticRoot;
  for(const [x,z] of [[-13,-10],[-4,-12],[-2,-10.4],[16,-9.6],[18,-14]]){
    g.box('wooden crate',x,1.38,z,.65,.72,.7,p.wood,staticRoot,.04);
    for(const y of [1.08,1.64])g.box('crate strap',x,y,z+.36,.67,.055,.025,p.edge,staticRoot,.005);
  }
  // Break up the coastline with natural asymmetry instead of square tile islands.
  const rand=seedRandom(581);
  for(let i=0;i<110;i++){
    const left=i<58;const t=left?i/58:(i-58)/52;const x=(left?-1:1)*(22+Math.sin(t*6)*2.5);const z=-26+t*(left?53:34);
    const rock=a.rock(i+10,.65+rand()*1.8);rock.position.set(x+(rand()-.5)*4,.1+rand()*.3,z);rock.parent=staticRoot;
    if(i%3===0){const tree=a.tree(i+91,.65+rand()*.45);tree.position.set(x+(left?-1.1:1.1),.6,z);tree.parent=staticRoot;}
  }
  for(let i=0;i<22;i++){const tree=a.tree(i+191,.9+rand()*.65);tree.position.set(-28+i*2.6,1,-23-rand()*4);tree.parent=staticRoot;}
  // A small lighthouse anchors the foreground composition.
  const lighthouse=new TransformNode('lighthouse',scene);lighthouse.position.set(-23,.4,19);lighthouse.parent=staticRoot;
  g.cylinder('lighthouse rock base',0,.3,0,2.3,.65,p.stone,lighthouse,2.1);
  g.cylinder('lighthouse tower',0,1.75,0,.72,2.8,p.cream,lighthouse,.53);
  g.cylinder('lighthouse red band',0,2.31,0,.606,.45,p.coral,lighthouse,.57);
  g.cylinder('lantern balcony',0,3.19,0,.82,.13,p.cream,lighthouse);
  g.cylinder('lantern glazing',0,3.54,0,.43,.55,p.glass,lighthouse);
  g.cylinder('lantern roof',0,3.89,0,.66,.22,p.coral,lighthouse,.1);
  for(let i=0;i<12;i++){const t=i/12*Math.PI*2;g.beam('lighthouse railing',new Vector3(Math.cos(t)*.76,3.22,Math.sin(t)*.76),new Vector3(Math.cos(t)*.76,3.64,Math.sin(t)*.76),.017,p.steel,lighthouse);}
  g.torus('balcony handrail',0,3.65,0,1.52,.035,p.steel,lighthouse);
  for(const [x,z] of [[-18,-8],[-3,-8],[12,-8],[18,-17]]){
    g.cylinder('lamp post',x,2.6,z,.045,3.2,p.steel,staticRoot);g.beam('lamp neck',new Vector3(x,4.2,z),new Vector3(x+.45,4.4,z),.042,p.steel,staticRoot);g.sphere('lamp',x+.47,4.39,z,.24,.07,.14,p.cream,staticRoot);
  }
  batch(staticRoot,'harbor');
  // Merged quay meshes need separate invisible selection targets with explicit metadata.
  const pickZones=berths.map(b=>{const m=MeshBuilder.CreateBox('select berth '+(b.index+1),{width:4.8,height:1.2,depth:11},scene);m.position.set(b.x,.6,-2);m.visibility=0;m.isPickable=true;m.metadata={berth:b.index};return m;});
  const cranes=berths.map((b,i)=>{const c=a.crane('crane '+i);c.root.position.set(b.x,1,-3);if(i===2)c.root.scaling.setAll(.8);return c;});
  const vessels=[a.ship('MV Coral',0),a.ship('MV Mariner',2)];
  vessels[0].root.position.copyFrom(berths[0].dock);vessels[0].root.rotation.y=0;
  vessels[1].root.position.set(8,.07,16);vessels[1].root.rotation.y=-.55;
  vessels.forEach((v,i)=>{for(const m of v.root.getChildMeshes())m.metadata={vessel:i};});
  for(const m of scene.meshes)if(m instanceof Mesh && m!==water.water && !pickZones.includes(m) && m.material && !m.name.includes('sign'))shadows.addShadowCaster(m);
  // A thin mint selection ring follows the selected vessel, without a massive overlay.
  const ring=MeshBuilder.CreateTorus('selected vessel waterline',{diameter:5.1,thickness:.025,tessellation:100},scene);ring.scaling.z=2.1;ring.material=p.emissive;ring.position.y=.11;ring.isPickable=false;
  const routeMat=new StandardMaterial('route ivory',scene);routeMat.diffuseColor=Color3.FromHexString('#e6fcdf');routeMat.emissiveColor=new Color3(.45,.7,.6);routeMat.alpha=.8;
  let route:ReturnType<typeof MeshBuilder.CreateDashedLines>|undefined;
  function drawRoute(from:Vector3,to:Vector3){route?.dispose();const path=[];for(let i=0;i<=50;i++){const t=i/50;path.push(Vector3.Lerp(from,to,t).add(new Vector3(Math.sin(t*Math.PI)*2,.1,0)));}route=MeshBuilder.CreateDashedLines('proposed shipping lane',{points:path,dashSize:1,gapSize:.55,dashNb:35},scene);route.color=Color3.FromHexString('#e4f4d9');route.isPickable=false;}
  const wakeMat=new StandardMaterial('sea foam',scene);wakeMat.diffuseColor=Color3.FromHexString('#d3efe2');wakeMat.emissiveColor=new Color3(.17,.3,.24);wakeMat.alpha=.3;
  const wakes=vessels.map(v=>{
    const root=new TransformNode('ship wake',scene);root.parent=v.root;
    for(let i=0;i<12;i++){const m=MeshBuilder.CreateTorus('wake ripple',{diameter:.65+i*.38,thickness:.035,tessellation:24},scene);m.material=wakeMat;m.parent=root;m.position.set(0,-.025,-4-i*.25);m.scaling.z=.38;m.isPickable=false;}
    return root;
  });
  water.setup();
  let onSelect:(kind:'vessel'|'berth',id:number)=>void=()=>{};
  scene.onPointerObservable.add(info=>{if(info.type!==PointerEventTypes.POINTERTAP)return;const data=info.pickInfo?.pickedMesh?.metadata;if(data?.vessel!==undefined)onSelect('vessel',data.vessel);if(data?.berth!==undefined)onSelect('berth',data.berth);});
  function update(time:number, selected:number, paused:boolean){
    water.update(time,paused);
    vessels.forEach((v,i)=>{v.root.position.y=.08+Math.sin(time*.8+i*2)*.035;v.root.rotation.z=Math.sin(time*.65+i)*.007;});
    ring.position.x=vessels[selected].root.position.x;ring.position.z=vessels[selected].root.position.z;ring.rotation.y=vessels[selected].root.rotation.y;ring.isVisible=true;
    wakes.forEach((w,i)=>w.setEnabled(!paused && vessels[i].root.position.z>5));
  }
  return {engine,scene,camera,home,vessels,cranes,berths,drawRoute,clearRoute:()=>{route?.dispose();route=undefined;},update,onSelect:(fn:typeof onSelect)=>onSelect=fn,
    resetCamera:()=>{camera.alpha=home.alpha;camera.beta=home.beta;camera.radius=home.radius;camera.target.copyFrom(home.target);}};
}
export type World=ReturnType<typeof buildWorld>;

