import { Color3, Mesh, MeshBuilder, PBRMaterial, Scene, VertexBuffer, VertexData } from '@babylonjs/core';

/** Reclaimed bank: sealed beneath the quay, eroded slope toward the existing rocks. */
export function shoreInfill(scene:Scene,soil:PBRMaterial,concrete:PBRMaterial){
  const meshes:Mesh[]=[];
  const foundation=MeshBuilder.CreateBox('Solid rear quay extension',{width:29,height:2,depth:1.75},scene);
  foundation.position.set(0,.39,-24.3);foundation.material=concrete;meshes.push(foundation);
  const smooth=(a:number,b:number,x:number)=>{const t=Math.max(0,Math.min(1,(x-a)/(b-a)));return t*t*(3-2*t);};
  const grain=(x:number,y:number)=>Math.sin(x*3.7+y*2.1)*.055+Math.sin(y*5.2-x*1.8)*.038+Math.sin(x*11.3+y*9.7)*.018;
  const height=(x:number,y:number)=>{
    const t=Math.max(0,Math.min(1,(x-14.38)/3.9));
    const bank=2.25-Math.abs(x-17.3)*.83-Math.max(0,10-y)*.8;
    const ridge=1.25+(Math.max(1.25,bank)-1.25)*smooth(0,.85,t);
    const erosion=(1-smooth(5.8+Math.sin(x*2)*.3,10.5,y))*smooth(.015,.6,t)*3.3;
    return ridge-erosion+grain(x,y)*smooth(0,.25,t);
  };
  let seed=781;const random=()=>{seed=(seed*1664525+1013904223)>>>0;return seed/4294967296;};
  const stone=scene.materials.find(m=>m.name==='Natural fractured limestone') as PBRMaterial;
  const rubble=stone.clone('Dust coated limestone fragments')!;rubble.albedoColor=new Color3(.57,.49,.36);rubble.environmentIntensity=.25;
  for(const side of [-1,1]){
    const positions:number[]=[],indices:number[]=[],uvs:number[]=[];
    const nx=24,ny=112;
    for(let j=0;j<=ny;j++){
      const y=4.5+j*21/ny;
      for(let i=0;i<=nx;i++){
        const t=i/nx;
        const x=14.38+3.9*t+Math.sin(y*2.3)*.12*t*t;
        positions.push(side*x,height(x,y),-y);uvs.push(side*x/3,y/3);
      }
    }
    for(let j=0;j<ny;j++)for(let i=0;i<nx;i++){
      const a=j*(nx+1)+i;indices.push(a,a+nx+1,a+1,a+1,a+nx+1,a+nx+2);
    }
    if(side===1)for(let i=0;i<indices.length;i+=3){const b=indices[i+1];indices[i+1]=indices[i+2];indices[i+2]=b;}
    const normals:number[]=[];VertexData.ComputeNormals(positions,indices,normals);
    const data=new VertexData();data.positions=positions;data.indices=indices;data.normals=normals;data.uvs=uvs;
    const mesh=new Mesh('Eroded shore connection '+side,scene);data.applyToMesh(mesh);mesh.material=soil;meshes.push(mesh);
    // Angular mineral fragments bedded into the slope, varied in size and attitude.
    for(let k=0;k<125;k++){
      const y=6+random()*19,x=14.62+random()*2.65,h=height(x,y);
      if(h<-.7)continue;
      const r=(k%11===0?.32:.07)+random()*.18;
      const rock=MeshBuilder.CreateIcoSphere('Embedded limestone rubble',{radius:1,subdivisions:1,flat:true},scene);
      const p=rock.getVerticesData(VertexBuffer.PositionKind)!;
      for(let i=0;i<p.length;i+=3){const a=p[i],b=p[i+1],c=p[i+2];const f=.9+.13*Math.sin(a*19+b*7+c*13+k);p[i]=Math.max(-.77,Math.min(.85,a))*f;p[i+1]=Math.max(-.65,Math.min(.64,b))*f;p[i+2]=c*f;}
      rock.updateVerticesData(VertexBuffer.PositionKind,p);
      const n:number[]=[];VertexData.ComputeNormals(p,rock.getIndices()!,n);rock.updateVerticesData(VertexBuffer.NormalKind,n);
      rock.scaling.set(r*(1+random()*.7),r*.75,r*(.7+random()*.5));
      rock.position.set(side*x,h+r*.08,-y);rock.rotation.set(random()*.3,random()*6.28,random()*.4);
      rock.material=rubble;meshes.push(rock);
    }
  }
  for(const mesh of meshes){mesh.receiveShadows=true;mesh.isPickable=false;}
  return meshes;
}
