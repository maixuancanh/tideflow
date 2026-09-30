import { Color3, DynamicTexture, Mesh, MeshBuilder, Scene, StandardMaterial, Vector2 } from '@babylonjs/core';
import { WaterMaterial } from '@babylonjs/materials/water/waterMaterial';

export function createWater(scene:Scene){
  const water=MeshBuilder.CreateGround('living turquoise bay',{width:250,height:250,subdivisions:120},scene);water.position.y=.015;water.isPickable=false;
  const material=new WaterMaterial('reflective turquoise seawater',scene,new Vector2(512,512));
  const texture=new DynamicTexture('authored seamless wave normals',{width:256,height:256},scene,false);
  const ctx=texture.getContext() as CanvasRenderingContext2D,image=ctx.createImageData(256,256);
  const height=(x:number,y:number)=>Math.sin(x*8+y*3)*.36+Math.sin(y*11-x*5)*.24+Math.sin(x*19+y*17)*.12+Math.sin(x*31-y*23)*.055;
  for(let y=0;y<256;y++)for(let x=0;x<256;x++){
    const u=x/256*Math.PI*2,v=y/256*Math.PI*2,h=height(u,v),nx=(h-height(u+.01,v))*3,ny=(h-height(u,v+.01))*3,len=Math.sqrt(nx*nx+ny*ny+1),i=(y*256+x)*4;
    image.data[i]=Math.round((nx/len*.5+.5)*255);image.data[i+1]=Math.round((ny/len*.5+.5)*255);image.data[i+2]=Math.round((1/len*.5+.5)*255);image.data[i+3]=255;
  }
  ctx.putImageData(image,0,0);texture.update();material.bumpTexture=texture;
  material.windForce=1.3;material.windDirection=new Vector2(.65,.35);material.waveHeight=.015;material.waveLength=.028;material.waveSpeed=22;material.waveCount=70;
  material.bumpHeight=.22;material.bumpSuperimpose=true;material.bumpAffectsReflection=true;material.fresnelSeparate=true;
  material.waterColor=Color3.FromHexString('#148d91');material.colorBlendFactor=.55;material.waterColor2=Color3.FromHexString('#4b9ba5');material.colorBlendFactor2=.3;
  material.specularColor=new Color3(.6,.67,.57);material.specularPower=110;material.backFaceCulling=false;
  water.material=material;
  const seabed=MeshBuilder.CreateGround('underwater sandy floor',{width:250,height:250,subdivisions:1},scene);seabed.position.y=-2.4;seabed.isPickable=false;
  const sand=new StandardMaterial('submerged sand',scene);sand.diffuseColor=Color3.FromHexString('#8da69a');sand.specularColor=Color3.Black();seabed.material=sand;
  return {water,setup:()=>{for(const mesh of scene.meshes)if(mesh!==water&&mesh instanceof Mesh&&mesh.isVisible&&mesh.visibility>0)material.addToRenderList(mesh);},update:(_time:number,paused=false)=>{material.windForce=paused?0:1.3;material.waveSpeed=paused?0:22;}};
}
