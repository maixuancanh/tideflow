import { AbstractMesh, Matrix, RawTexture, Scene, Texture, Vector3, VertexBuffer } from '@babylonjs/core';

/** World-space distance to every modeled waterline: ship, quay, terrain and rocks. */
export function contactField(scene:Scene,objects:AbstractMesh[],offset=Vector3.Zero(),frame?:{position:Vector3,angle:number,home:Vector3}){
  const size=512,step=80/size,dist=new Float32Array(size*size).fill(10000);
  const inverse=frame?Matrix.RotationY(-frame.angle):null;
  for(const mesh of objects){
    const p=mesh.getVerticesData(VertexBuffer.PositionKind),ix=mesh.getIndices();if(!p||!ix)continue;
    const world=mesh.computeWorldMatrix(true),bounds=mesh.getBoundingInfo().boundingBox;
    if(bounds.minimumWorld.y>.12||bounds.maximumWorld.y<.02)continue;
    const points:Array<Vector3|undefined>=[];
    const point=(i:number)=>{
      if(points[i])return points[i]!;
      const v=Vector3.TransformCoordinates(Vector3.FromArray(p,i*3),world);
      return points[i]=frame?Vector3.TransformNormal(v.subtract(frame.position),inverse!).add(frame.home):v.subtract(offset);
    };
    for(let t=0;t<ix.length;t+=3){
      const v=[point(ix[t]),point(ix[t+1]),point(ix[t+2])],cuts:Vector3[]=[];
      for(let k=0;k<3;k++){const a=v[k],b=v[(k+1)%3];if((a.y-.07)*(b.y-.07)<0)cuts.push(Vector3.Lerp(a,b,(.07-a.y)/(b.y-a.y)));}
      if(cuts.length!==2)continue;
      const [a,b]=cuts,count=Math.max(1,Math.ceil(Vector3.Distance(a,b)/step*2));
      for(let k=0;k<=count;k++){const x=Math.floor((a.x+(b.x-a.x)*k/count+40)/step),z=Math.floor((a.z+(b.z-a.z)*k/count+45)/step);if(x>=0&&x<size&&z>=0&&z<size)dist[z*size+x]=0;}
    }
  }
  for(let z=0;z<size;z++)for(let x=0;x<size;x++){const i=z*size+x;dist[i]=Math.min(dist[i],x?dist[i-1]+1:10000,z?dist[i-size]+1:10000,x&&z?dist[i-size-1]+1.414:10000,x<size-1&&z?dist[i-size+1]+1.414:10000);}
  for(let z=size-1;z>=0;z--)for(let x=size-1;x>=0;x--){const i=z*size+x;dist[i]=Math.min(dist[i],x<size-1?dist[i+1]+1:10000,z<size-1?dist[i+size]+1:10000,x<size-1&&z<size-1?dist[i+size+1]+1.414:10000,x&&z<size-1?dist[i+size-1]+1.414:10000);}
  const data=new Uint8Array(size*size*4);for(let i=0;i<dist.length;i++){const d=Math.min(255,Math.round(dist[i]*step/8*255));data.set([d,d,d,255],i*4);}
  const texture=RawTexture.CreateRGBATexture(data,size,size,scene,false,false,Texture.BILINEAR_SAMPLINGMODE);texture.gammaSpace=false;texture.wrapU=texture.wrapV=Texture.CLAMP_ADDRESSMODE;return texture;
}
