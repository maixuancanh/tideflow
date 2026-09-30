import {mountSceneMinimap} from './sceneMinimap';
/// <reference types="vite/client" />
import {clearRearCorridor} from './rearCorridor';
import { portAppearance } from './portAppearance';
import { harborMist } from './harborMist';
import './style.css';
import { ArcRotateCamera, Color3, Color4, DefaultRenderingPipeline, DirectionalLight, DynamicTexture, Engine, HDRCubeTexture, HemisphericLight, ImageProcessingConfiguration, Matrix, PBRMaterial, PointerEventTypes, Scene, SceneLoader, ShadowGenerator, Texture, TransformNode, Vector3, VertexBuffer } from '@babylonjs/core';
import '@babylonjs/loaders/glTF';
import '@babylonjs/core/Shaders/noise.fragment';
import '@babylonjs/core/Shaders/depthBoxBlur.fragment';
import '@babylonjs/core/Shaders/postprocess.vertex';
// Keep Babylon's shadow shader in the initial bundle.  The optimizer can
// otherwise leave a lazy shadowMap import behind and the scene goes blank
// when PLAY starts in a fresh browser profile.
import '@babylonjs/core/Shaders/shadowMap.fragment';
import '@babylonjs/core/Shaders/shadowMap.vertex';
import { ocean } from './water';
import { studyControls } from './studyControls';

import { concreteApron } from './concrete';
import { shoreInfill } from './shoreInfill';
import { harborLayout } from './harborLayout';
import { harborOperations } from './operations';
import { connectHarborSession } from './harborSession';
import { PortWorld, PORT_LOCATIONS, type PortId } from './portWorld';
import { installSceneCollision3d } from './sceneCollision3d';
import { launchScreen, createArrival } from './launch';
import { mountTideflowHud } from './tideflowHud';

async function createPortAssets(scene:Scene,shadow:ShadowGenerator){
  const existingMaterials=new Set(scene.materials),existingMeshes=new Set(scene.meshes);
  const loaded=await SceneLoader.ImportMeshAsync('','/study/','flow-harbor-berth-baked.glb',scene);
  // The baked detail layer contains the obsolete loose rods, wheel stops and
  // short stone strips that were left on the old apron. The active apron and
  // its authored fenders/bollards are retained in the main quay mesh.
  for(const mesh of loaded.meshes){
    let node:typeof mesh|null=mesh;
    while(node){if(node.name==='quay-details'){mesh.setEnabled(false);break;}node=node.parent as typeof mesh|null;}
  }
  // Remove obsolete bollards, ropes and fittings on the old internal quay edge.
  for(const mesh of loaded.meshes){
    let node:typeof mesh|null=mesh;let isQuay=false;
    while(node){if(node.name==='quay'||node.name.startsWith('quay_')||node.name==='quay-details')isQuay=true;node=node.parent as typeof mesh|null;}
    if(!isQuay)continue;
    const p=mesh.getVerticesData(VertexBuffer.PositionKind),ix=mesh.getIndices();if(!p||!ix)continue;
    const world=mesh.computeWorldMatrix(true),keep:number[]=[];
    for(let i=0;i<ix.length;i+=3){
      const v=[ix[i],ix[i+1],ix[i+2]].map(j=>Vector3.TransformCoordinates(Vector3.FromArray(p,j*3),world));
      const isOldHawser=mesh.material?.name.split('::')[0]==='Twisted hemp rope' && v.every(a=>a.z>-4.1);
      const oldSign=v.every(a=>a.x>-10.3&&a.x<-8.7&&a.z>-5.5&&a.z<-5&&a.y>1.35);
      // Keep structural paving, but remove entire old props including vertices
      // below the deck surface (straps, corner castings and trolley feet).
      const surfaceMaterial=/^(Scanned limestone concrete|Limestone course|Apron slab|Faded ochre deck markings)/.test(mesh.material?.name??'');
      const clearedApron=!surfaceMaterial&&v.every(a=>a.x>-12&&a.x<15&&a.z<-5&&a.z>-13.9);
      const quayContainer=/container::quay/i.test(mesh.material?.name??'') && v.every(a=>a.z<-8.7&&a.z>-11.1);
      const looseWood=mesh.material?.name.split('::')[0]==='Weathered wood' && v.every(a=>a.x>-9&&a.x<-6&&a.z>-9.2&&a.z<-7.1);
      const obsolete=clearedApron||oldSign||isOldHawser||quayContainer||looseWood||v.every(a=>a.z>-4.04&&a.z<-2.75&&a.y>1.25);
      if(!obsolete)keep.push(ix[i],ix[i+1],ix[i+2]);
    }
    mesh.setIndices(keep,null);
  }
  for(const mesh of loaded.meshes){mesh.receiveShadows=true;if(mesh.getTotalVertices()>0)shadow.addShadowCaster(mesh);}
  const apronTexture=new DynamicTexture('Fine weathered paving',{width:1024,height:1024},scene,true);
  const ctx=apronTexture.getContext() as CanvasRenderingContext2D;ctx.fillStyle='#d5c6a9';ctx.fillRect(0,0,1024,1024);
  let seed=173;const random=()=>{seed=(seed*1664525+1013904223)>>>0;return seed/4294967296;};
  for(let i=0;i<70000;i++){const light=random()>.55;ctx.fillStyle=light?'rgba(245,233,204,0.2)':'rgba(91,81,62,0.1)';const r=random()*1.2+.3;ctx.fillRect(random()*1024,random()*1024,r,r);}
  for(let i=0;i<130;i++){const x=random()*1024,y=random()*1024,r=random()*50+4;const grad=ctx.createRadialGradient(x,y,0,x,y,r);grad.addColorStop(0,'rgba(92,84,64,0.045)');grad.addColorStop(1,'rgba(92,84,64,0)');ctx.fillStyle=grad;ctx.fillRect(x-r,y-r,r*2,r*2);}
  apronTexture.update();
  const stoneNormal=new Texture('/study/concrete-normal.jpg',scene,false,false);stoneNormal.level=.2;
  for(const source of scene.materials.filter(m=>!existingMaterials.has(m))){if(source.getClassName()==='PBRMaterial'){const material=source as PBRMaterial;const name=material.name.split('::')[0];material.environmentIntensity=.7;material.ambientTextureStrength=.72;
    // Reload linear authored paint without glTF's hardware sRGB decode.
    if(material.albedoTexture && name!=='Scanned limestone concrete'){
      const paint=new Texture('/study/'+name.replaceAll(' ','-')+'-paint.png',scene,false,false);paint.gammaSpace=false;material.albedoTexture=paint;
    }
    if(name==='Scanned limestone concrete'){material.albedoColor=new Color3(2.15,1.94,1.55);material.roughness=.94;if(material.bumpTexture)material.bumpTexture.level=.28;}
    if(name.startsWith('Limestone course')){material.roughness=.98;}
    if(name.startsWith('Apron slab')){material.albedoTexture=apronTexture;material.albedoColor=new Color3(1,1,.97);material.bumpTexture=stoneNormal;material.roughness=.93;}
    if(name==='Tinted bridge glazing'){material.environmentIntensity=1.1;}
  }}
  const apron = await concreteApron(scene);
  const surroundings=await SceneLoader.ImportMeshAsync('','/study/','harbor-surroundings.glb',scene);
  // Clear freight and its metal straps from the garage swept paths before widening the shell.
  for(const mesh of surroundings.meshes){
    if(!/Storage timber|Dock iron/.test(mesh.material?.name??''))continue;
    const vertices=mesh.getVerticesData(VertexBuffer.PositionKind),indices=mesh.getIndices();if(!vertices||!indices)continue;
    const world=mesh.computeWorldMatrix(true),keep:number[]=[];
    for(let i=0;i<indices.length;i+=3){const tri=[indices[i],indices[i+1],indices[i+2]];
      const crate=tri.every(index=>{const p=Vector3.TransformCoordinates(Vector3.FromArray(vertices,index*3),world);return p.x>-11&&p.x<-3&&p.z<-17&&p.z>-22&&p.y>1.4&&p.y<3.5;});
      if(!crate)keep.push(...tri);
    }mesh.setIndices(keep,mesh.getTotalVertices());
  }
  for(const node of [...surroundings.meshes,...surroundings.transformNodes])if(node.name==='warehouse'){
    // Narrow around the garage/road center x=-7, retaining the fleet's alignment.
    const widthScale=1.24;
    node.scaling.x*=widthScale;node.position.x+=7*(widthScale-1);
    node.scaling.z*=1.25;node.position.z+=3.5;
  }
  for(const mesh of surroundings.meshes){mesh.receiveShadows=true;if(mesh.getTotalVertices()>0)shadow.addShadowCaster(mesh);}
  // Restored from the pre-road build study-DvjLLmtx.js (2026-09-27 15:40).
  const rockColor=new Texture('/study/concrete-color.jpg',scene,false,false);rockColor.uScale=3;rockColor.vScale=3;
  const mineralImage=new Image();mineralImage.src='/study/concrete-color.jpg';await mineralImage.decode();
  const mineralTexture=new DynamicTexture('Granular mineral surface',1024,scene,true);
  const mineralContext=mineralTexture.getContext() as CanvasRenderingContext2D;mineralContext.drawImage(mineralImage,0,0,1024,1024);
  const mineralPixels=mineralContext.getImageData(0,0,1024,1024);
  for(let i=0;i<mineralPixels.data.length;i+=4){const g=mineralPixels.data[i]*.3+mineralPixels.data[i+1]*.59+mineralPixels.data[i+2]*.11;mineralPixels.data[i]=150+g*.42;mineralPixels.data[i+1]=148+g*.40;mineralPixels.data[i+2]=140+g*.38;}
  mineralContext.putImageData(mineralPixels,0,0);mineralTexture.update();mineralTexture.wrapU=Texture.WRAP_ADDRESSMODE;mineralTexture.wrapV=Texture.WRAP_ADDRESSMODE;mineralTexture.uScale=2;mineralTexture.vScale=2;
  const rockNormal=new Texture('/study/concrete-normal.jpg',scene,false,false);rockNormal.uScale=3;rockNormal.vScale=3;rockNormal.level=.65;
  for(const source of scene.materials.filter(m=>!existingMaterials.has(m))){if(source.getClassName()!=='PBRMaterial')continue;const m=source as PBRMaterial;
    if(m.name.startsWith('Olive foliage')){m.backFaceCulling=false;m.twoSidedLighting=true;m.roughness=.88;}
    if(m.name==='Natural fractured limestone'){m.albedoTexture=mineralTexture;m.albedoColor=new Color3(1.35,1.35,1.35);m.bumpTexture=rockNormal;m.roughness=.96;m.environmentIntensity=.35;}
    if(m.name==='Earth in rock crevices'){m.albedoTexture=rockColor;m.albedoColor=new Color3(.85,.69,.48);m.bumpTexture=rockNormal;m.roughness=1;}
    if(m.name.startsWith('Coast limestone')){m.albedoTexture=(apron.material as PBRMaterial).albedoTexture;m.albedoColor=m.albedoColor.scale(1.3);m.bumpTexture=rockNormal;m.roughness=.98;}
    if(m.name==='Warehouse lime plaster'){m.albedoColor=Color3.FromHexString('#d2c7b0');m.bumpTexture=stoneNormal;m.roughness=.96;}
  }
  const yard=apron.clone('Warehouse service apron')!;yard.position.set(0,1.409,-18.85);yard.scaling.z=12.73/8.97;
  const soil=scene.materials.find(m=>!existingMaterials.has(m)&&m.name==='Earth in rock crevices') as PBRMaterial;
  // Imported ground carries baked vertex tint; the connecting bank does not.
  // Use the exact same material and shading inputs for both surfaces.
  soil.twoSidedLighting=true;
  // The low-poly bank has steep/downward faces. Use identical texture color
  // on the imported bank and its connector, independent of face lighting.
  soil.unlit=true;
  for(const mesh of surroundings.meshes)if(mesh.material===soil){mesh.useVertexColors=false;mesh.material=soil;}
  const infill=shoreInfill(scene,soil,apron.material as PBRMaterial);
  clearRearCorridor(surroundings.meshes);
  for(const mesh of infill)shadow.addShadowCaster(mesh);
  // Place the primary crane on the broad working pier, like the concept.
  for(const node of [...loaded.meshes,...loaded.transformNodes]){
    if(['crane','crane-details','hoist'].includes(node.name)){node.position.x-=10;node.position.z+=8;}
  }
  const harbor=harborLayout(scene,apron.material as PBRMaterial);
  apron.setEnabled(false);yard.setEnabled(false);
  for(const mesh of scene.meshes)if(!existingMeshes.has(mesh)&&mesh.name==='Faint expansion cut')mesh.setEnabled(false);
  for(const mesh of harbor)shadow.addShadowCaster(mesh);
  // Move the authored ship clear of the new pier footprints; preserve its detail groups.
  for(const node of [...loaded.meshes,...loaded.transformNodes]){
    if(node.name==='vessel'||node.name==='vessel-details'){node.position.z+=13;node.position.x-=9;}
  }
  const incomingRoot=new TransformNode('Second cargo vessel in approach',scene);
  // Operational ships are created by harborOperations; this legacy marker needs no cloned hull.
  incomingRoot.position.set(32,0,24);incomingRoot.rotation.y=-.95;incomingRoot.scaling.setAll(.8);
  for(const mesh of incomingRoot.getChildMeshes())shadow.addShadowCaster(mesh);
  incomingRoot.setEnabled(false);
  return {loaded,incomingRoot,reflectables:[...loaded.meshes,...surroundings.meshes].filter(m=>m.getTotalVertices()>0).concat([apron,yard,...infill,...harbor,...incomingRoot.getChildMeshes()])};
}

async function openStudy(){
  const launch=launchScreen();
  document.body.append(document.querySelector('#loading')!);
  launch.stage(5,'Loading harbor');
  await launch.artwork();
  launch.stage(8,'Preparing profile');
  await launch.profile();
  const canvas=document.querySelector<HTMLCanvasElement>('#scene')!;
  const engine=new Engine(canvas,true,{preserveDrawingBuffer:true,stencil:true,antialias:true});
  window.addEventListener('resize',()=>engine.resize());
  engine.setHardwareScalingLevel(Math.max(1,window.devicePixelRatio/1.5));
  const scene=new Scene(engine);scene.useRightHandedSystem=true;scene.clearColor=new Color4(.36,.6,.65,1);
  scene.imageProcessingConfiguration.toneMappingEnabled=true;scene.imageProcessingConfiguration.toneMappingType=ImageProcessingConfiguration.TONEMAPPING_ACES;
  scene.imageProcessingConfiguration.exposure=1.22;scene.imageProcessingConfiguration.contrast=1.1;
  const camera=new ArcRotateCamera('Reference oblique composition',1.12,.84,73,new Vector3(0,2.4,1),scene);
  camera.fov=.7;camera.lowerRadiusLimit=16;camera.upperRadiusLimit=90;camera.lowerBetaLimit=.4;camera.upperBetaLimit=1.37;camera.minZ=.15;camera.maxZ=500;
  camera.wheelPrecision=11;camera.panningSensibility=140;camera.inertia=.75;camera.attachControl(canvas,true);
  const env=new HDRCubeTexture('/study/daylight.hdr',scene,128,false,true,false,true);
  scene.environmentTexture=env;scene.environmentIntensity=.65;
  const fill=new HemisphericLight('Soft sky fill',new Vector3(0,1,0),scene);fill.intensity=.14;fill.groundColor=Color3.FromHexString('#74817d');
  const sun=new DirectionalLight('Warm low daylight',new Vector3(.45,-1,-.5),scene);sun.position=new Vector3(-18,30,22);sun.intensity=3.6;sun.diffuse=Color3.FromHexString('#fff0d5');sun.shadowMinZ=1;sun.shadowMaxZ=80;
  const shadow=new ShadowGenerator(2048,sun);shadow.usePercentageCloserFiltering=true;shadow.filteringQuality=ShadowGenerator.QUALITY_HIGH;shadow.bias=.0003;shadow.normalBias=.015;shadow.darkness=.12;
  const bootstrap=await connectHarborSession();
  launch.stage(18,'Connecting to harbor');
  const ownedPorts=(bootstrap.state.economy.ownedPorts??['coral']).filter((id):id is PortId=>id==='coral'||id==='jade');
  const world=new PortWorld();
  const interfaceTemplate=document.querySelector<HTMLElement>('#interface')!.cloneNode(true) as HTMLElement;
  const ports:Array<{id:PortId;root:TransformNode;uiRoot:Document|HTMLElement;operations:ReturnType<typeof harborOperations>;assets:Awaited<ReturnType<typeof createPortAssets>>;materials:typeof scene.materials}>=[];
  for(const id of ownedPorts){
    // All authored setup and local-coordinate geometry edits run at the origin.
    const beforeNodes=new Set([...scene.meshes,...scene.transformNodes]),beforeMaterials=new Set(scene.materials);
    const assets=await createPortAssets(scene,shadow);
    launch.stage(Math.min(72,22+ports.length*25),'Loading harbor models');
    const uiRoot:Document|HTMLElement=ports.length===0?document:document.createElement('div');
    if(uiRoot!==document){const panel=interfaceTemplate.cloneNode(true) as HTMLElement;panel.querySelector('#loading')?.remove();(uiRoot as HTMLElement).append(panel);}
    const operations=harborOperations(scene,assets.loaded,{portId:id,world,uiRoot});
    launch.stage(ports.length===0?45:84,'Connecting to Nansen');
    await operations.ready;
    await operations.feedReady;
    launch.stage(Math.min(86,74+ports.length*8),'Preparing ships');
    const nodes=[...scene.meshes,...scene.transformNodes].filter(node=>!beforeNodes.has(node));
    const root=new TransformNode('Port world root '+id,scene);root.metadata={portId:id,portRoot:true};
    for(const node of nodes){node.metadata={...(node.metadata??{}),portId:id};if(!node.parent)node.parent=root;}
    const offset=PORT_LOCATIONS[id];root.position.set(offset.x,0,offset.z);
    root.computeWorldMatrix(true);for(const node of nodes)node.computeWorldMatrix(true);
    for(const mesh of operations.meshes)shadow.addShadowCaster(mesh);
    const materials=scene.materials.filter(m=>!beforeMaterials.has(m));
    for(const material of materials)material.metadata={...(material.metadata??{}),portId:id};
    ports.push({id,root,uiRoot,operations,assets,materials});
  }
  const primary=ports[0],operations=primary.operations,incomingRoot=primary.assets.incomingRoot;
  // Port identity and paint are scoped to their own materials below.
  for(const port of ports)portAppearance(scene,()=>port.id,port.materials,port.uiRoot);
  const collision3d=installSceneCollision3d(scene);
  const reflectables=ports.flatMap(port=>[...port.assets.reflectables,...port.operations.meshes]);
  const movingMeshes=ports.flatMap(port=>port.operations.vesselRoots.flatMap(root=>root.getChildMeshes()));
  const water=ocean(scene,reflectables,movingMeshes,operations.vesselOffset,operations.vesselMotion);
  // A single ocean spans every island; no second overlapping reflection surface.
  const worldMinX=Math.min(...ports.map(p=>p.root.position.x)),worldMaxX=Math.max(...ports.map(p=>p.root.position.x));
  water.mesh.scaling.x=1+(worldMaxX-worldMinX)/320;water.mesh.position.x=(worldMinX+worldMaxX)/2;
  camera.maxZ=1000;
  water.mesh.alphaIndex=1;
  const pipeline=new DefaultRenderingPipeline('Subtle antialiasing',true,scene,[camera]);pipeline.fxaaEnabled=true;pipeline.samples=1;pipeline.imageProcessingEnabled=false;
  // Do not apply screen-space AO to the custom water shader. Its geometry-buffer
  // output does not match the PBR shoreline, producing dark projected patches
  // when the camera enters SSAO's former 70-unit depth range. Sun shadows remain.
  const mist=harborMist(scene,camera,()=>operations.portLevel,()=>ports.map(port=>port.root.position));
  let focusedPort=primary.id;
  const focusPort=(id:PortId,move=true)=>{const selected=ports.find(p=>p.id===id);if(!selected)return;focusedPort=id;
    for(const port of ports){const panel=port.uiRoot.querySelector<HTMLElement>('#interface');if(panel&&port.uiRoot!==document)panel.hidden=true;}
    void selected.operations.refresh();if(move)mist.focus(selected.root.position.add(new Vector3(-3,2.4,-6)),70);
  };
  for(const port of ports){if(port.uiRoot!==document){document.body.append(port.uiRoot as HTMLElement);const panel=port.uiRoot.querySelector<HTMLElement>('#interface')!;panel.hidden=true;
      port.uiRoot.querySelector('#home')?.addEventListener('click',()=>mist.overview());
      port.uiRoot.querySelector('#detail')?.addEventListener('click',()=>mist.focus(port.root.position.add(new Vector3(-15,3,5)),26));
      port.uiRoot.querySelector('#pause')?.addEventListener('click',()=>{paused=!paused;});
      const reference=port.uiRoot.querySelector<HTMLElement>('#reference-panel');port.uiRoot.querySelector('#reference')?.addEventListener('click',()=>{if(reference)reference.hidden=false;});port.uiRoot.querySelector('#close-reference')?.addEventListener('click',()=>{if(reference)reference.hidden=true;});
    }
  }
  window.addEventListener('harbor-focus-port',event=>focusPort((event as CustomEvent<PortId>).detail));
  scene.onPointerObservable.add(info=>{if(info.type!==PointerEventTypes.POINTERPICK)return;let node=info.pickInfo?.pickedMesh as import("@babylonjs/core").Node|null|undefined;let id:PortId|undefined;while(node&&!id){id=node.metadata?.portId as PortId|undefined;node=node.parent;}if(id&&id!==focusedPort)focusPort(id);});
  scene.onPointerObservable.add(info=>{if(info.type!==PointerEventTypes.POINTERMOVE)return;const picked=scene.pick(scene.pointerX,scene.pointerY,m=>!!m.metadata?.portId&&m.isEnabled()&&m.isVisible);let node=picked?.pickedMesh as import("@babylonjs/core").Node|null|undefined;let id:PortId|undefined;while(node&&!id){id=node.metadata?.portId as PortId|undefined;node=node.parent;}window.dispatchEvent(new CustomEvent('harbor-hover',{detail:id??null}));});canvas.addEventListener('pointerleave',()=>window.dispatchEvent(new CustomEvent('harbor-hover',{detail:null})),{passive:true});
  focusPort((bootstrap.state.economy.activePort??'coral') as PortId,false);
  launch.stage(92,'Connecting to Nansen');
  await Promise.all(ports.map(port=>port.operations.feedReady));
  launch.stage(96,'Preparing textures');
  // All GLB, texture and Nansen promises have completed above. Babylon's
  // scene readiness check also waits for shader compilation, but no render
  // loop is running until after the PLAY gate, so waiting here can deadlock.
  // Shader warm-up happens during the covered cinematic intro instead.
  const vesselNodes:TransformNode[]=ports.map(port=>port.assets.incomingRoot);
  let paused=false,time=0,playable=false;
  const home=()=>mist.overview();
  document.querySelector('#home')!.addEventListener('click',home);
  const overview=document.createElement('button');overview.textContent='Full harbor';document.querySelector('.controls')!.prepend(overview);
  overview.addEventListener('click',()=>mist.overview());
  const workView=document.createElement('button');workView.textContent='Operations';document.querySelector('.controls')!.prepend(workView);
  workView.addEventListener('click',()=>{camera.alpha=1.7;camera.beta=.91;camera.radius=40;camera.target.set(-7,3,-2);});
  const craneView=document.createElement('button');craneView.textContent='Crane rig';document.querySelector('.controls')!.append(craneView);
  craneView.onclick=()=>{camera.lowerRadiusLimit=7;camera.alpha=2.6;camera.beta=.95;camera.radius=15;camera.target.set(-10.8,5,1);};
  const planView=document.createElement('button');planView.textContent='Harbor layout';document.querySelector('.controls')!.append(planView);
  planView.addEventListener('click',()=>{camera.lowerBetaLimit=.04;camera.alpha=Math.PI/2;camera.beta=.05;camera.radius=57;camera.target.set(-1,1,-5);});
  const coastView=document.createElement('button');coastView.textContent='Rocky shore & trees';document.querySelector('.controls')!.append(coastView);
  coastView.addEventListener('click',()=>{camera.alpha=.55;camera.beta=.97;camera.radius=21;camera.target.set(18,2.5,-19);});
  document.querySelector('#detail')!.addEventListener('click',()=>{camera.alpha=1.48;camera.beta=1.04;camera.radius=24;camera.target.set(-15.8,2.8,3);});
  for (const view of [
    {name:'Vessel bow',alpha:.68,beta:.94,x:-11.5,z:11},
    {name:'Vessel stern',alpha:2.65,beta:.88,x:-19.8,z:-4.5},
    {name:'Cabin',alpha:1.6,beta:1.03,x:-18.7,z:-2.3},
  ]) {
    const button=document.createElement('button');button.textContent=view.name;
    document.querySelector('.controls')!.append(button);
    button.addEventListener('click',()=>{camera.lowerRadiusLimit=7;camera.alpha=view.alpha;camera.beta=view.beta;camera.radius=10;camera.target.set(view.x,2.7,view.z);});
  }
  const dockView=document.createElement('button');dockView.textContent='Concrete apron';
  document.querySelector('.controls')!.append(dockView);
  dockView.addEventListener('click',()=>{camera.alpha=1.05;camera.beta=.68;camera.radius=18;camera.target.set(-7,1.4,-8);});
  document.querySelector('#pause')!.addEventListener('click',()=>{paused=!paused;const b=document.querySelector<HTMLButtonElement>('#pause')!;b.setAttribute('aria-pressed',String(paused));b.textContent=paused?'Resume motion':'Pause motion';});
  const save=document.createElement('button');save.id='save-frame';save.textContent='Save image';save.title='Save the current 3D render';document.querySelector('.controls')!.append(save);
  save.addEventListener('click',()=>{scene.render();canvas.toBlob(blob=>{if(!blob)return;const url=URL.createObjectURL(blob);const link=document.createElement('a');link.href=url;link.download='flow-harbor-berth-render.png';link.click();setTimeout(()=>URL.revokeObjectURL(url),10000);},'image/png');});
  const panel=document.querySelector<HTMLElement>('#reference-panel')!;
  document.querySelector('#reference')!.addEventListener('click',()=>panel.hidden=false);document.querySelector('#close-reference')!.addEventListener('click',()=>panel.hidden=true);
  window.addEventListener('keydown',e=>{if(e.key==='Escape')panel.hidden=true;});
  studyControls(scene,camera,ports.flatMap(port=>port.operations.vesselRoots),incomingRoot,(point)=>mist.focus(point));
  mountTideflowHud(operations.economy,ports.map(port=>({id:port.id,label:port.id==='jade'?'Jade Harbor':'Coral Harbor',x:port.root.position.x,z:port.root.position.z,read:()=>port.operations.hudSnapshot,purchase:port.operations.purchase,equipEquipment:port.operations.equipEquipment,upgradeCapacity:port.operations.upgradeCapacity,economy:port.operations.economy,uiRoot:port.uiRoot})),()=>camera.alpha);
  mountSceneMinimap(scene,camera,ports.map(port=>({x:port.root.position.x,z:port.root.position.z,read:()=>port.operations.hudSnapshot})));
  const vesselLabels=ports.flatMap(port=>port.operations.hudSnapshot.ships.map((ship,index)=>{const label=document.createElement('div');label.className='tf-vessel-label';label.textContent=ship.name;label.hidden=true;document.body.append(label);return {port,index,label};}));
  let labelAt=0;
  scene.onAfterRenderObservable.add(()=>{if(performance.now()-labelAt<120)return;labelAt=performance.now();const viewport=camera.viewport.toGlobal(engine.getRenderWidth(),engine.getRenderHeight());const bounds=canvas.getBoundingClientRect();for(const {port,index,label} of vesselLabels){const ship=port.operations.hudSnapshot.ships[index];if(document.body.dataset.launch!=='playing'||!ship.visible){label.hidden=true;continue;}const point=Vector3.Project(new Vector3(port.root.position.x+ship.x,5,port.root.position.z+ship.z),Matrix.Identity(),scene.getTransformMatrix(),viewport);label.hidden=point.z<0||point.z>1||point.x<0||point.x>viewport.width||point.y<0||point.y>viewport.height;label.style.left=`${bounds.left+point.x/viewport.width*bounds.width}px`;label.style.top=`${bounds.top+point.y/viewport.height*bounds.height}px`;}});
  mist.overview();
  launch.stage(100,'Ready to sail');
  engine.runRenderLoop(()=>{if(playable&&!paused)time+=Math.min(engine.getDeltaTime()/1000,.1);if(playable){for(const vessel of vesselNodes){vessel.position.y=Math.sin(time*.63)*.018;vessel.rotation.z=Math.sin(time*.51)*.0012;}for(const port of ports)port.operations.update(time);water.update(time);}scene.render();});
  await launch.waitForPlay();
  mist.suspend();
  const arrival=createArrival(scene,camera,new Vector3((worldMinX+worldMaxX)/2-3,2.4,-6),70+(worldMaxX-worldMinX)*.85);
  await arrival.play();
  mist.resume();
  launch.complete();
  playable=true;
}
openStudy().catch(error=>{
  console.error('Art study initialization:',error);
  const loading=document.querySelector<HTMLElement>('#loading')??document.body.appendChild(document.createElement('div'));loading.id='loading';
  loading.style.cssText='position:fixed;inset:0;z-index:200;display:flex;background:#185c64;color:white';
  // Keep initialization failures visible even if the first port panel was hidden.
  document.body.append(loading);
  document.body.dataset.launch='error';loading.hidden=false;
  const title=document.createElement('strong');title.textContent='Unable to load Tideflow';
  const detail=document.createElement('span');detail.textContent='The harbor could not be prepared. Please retry.';
  const retry=document.createElement('button');retry.textContent='Retry';retry.onclick=()=>location.reload();loading.replaceChildren(title,detail,retry);
});




