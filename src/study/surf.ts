import { AbstractMesh, Effect, Mesh, Scene, ShaderMaterial, Vector3, VertexBuffer, VertexData } from '@babylonjs/core';

/** Intersect the actual rock triangles with sea level; expand each segment into surf. */
export function rockSurf(scene:Scene, rocks:AbstractMesh[]) {
  const positions:number[]=[], uvs:number[]=[], indices:number[]=[];
  const segments:[Vector3,Vector3][]=[];const normals=new Map<string,Vector3>();
  const key=(v:Vector3)=>`${v.x.toFixed(4)},${v.z.toFixed(4)}`;
  for(const rock of rocks){
    if(rock.material?.name!=='Natural fractured limestone')continue;
    const p=rock.getVerticesData(VertexBuffer.PositionKind), ix=rock.getIndices();if(!p||!ix)continue;
    const world=rock.computeWorldMatrix(true);
    for(let t=0;t<ix.length;t+=3){
      const triangle=[0,1,2].map(k=>Vector3.TransformCoordinates(Vector3.FromArray(p,ix[t+k]*3),world));
      const cuts:Vector3[]=[];
      for(let k=0;k<3;k++){
        const a=triangle[k],b=triangle[(k+1)%3];
        if((a.y-.035)*(b.y-.035)<0)cuts.push(Vector3.Lerp(a,b,(.035-a.y)/(b.y-a.y)));
      }
      if(cuts.length!==2)continue;
      const [a,b]=cuts,delta=b.subtract(a);if(delta.length()<.003)continue;
      const n=Vector3.Cross(triangle[1].subtract(triangle[0]),triangle[2].subtract(triangle[0]));n.y=0;n.normalize();
      for(const v of [a,b]){const k=key(v);normals.set(k,(normals.get(k)??Vector3.Zero()).add(n));}segments.push([a,b]);
    }
  }
  for(const [a,b] of segments){const base=positions.length/3;
    for(const [v,d] of [[a,-.1],[b,-.1],[b,.85],[a,.85]] as [Vector3,number][]){const n=normals.get(key(v))!.normalizeToNew();positions.push(v.x+n.x*d,.07,v.z+n.z*d);uvs.push(v.x*.3+v.z*.17,d);}
    indices.push(base,base+1,base+2,base,base+2,base+3);
  }
  Effect.ShadersStore.rockSurfVertexShader=`precision highp float;attribute vec3 position;attribute vec2 uv;uniform mat4 worldViewProjection;uniform float time;varying vec2 vUV;varying vec3 vP;
  void main(){vUV=uv;vP=position;vec3 p=position;float phase=time*1.55+uv.x;float impact=pow(max(0.,sin(phase)),6.);p.y+=impact*.22*exp(-abs(uv.y)*6.);gl_Position=worldViewProjection*vec4(p,1.);}`;
  Effect.ShadersStore.rockSurfFragmentShader=`precision highp float;varying vec2 vUV;varying vec3 vP;uniform float time;
  float hash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
  float noise(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);return mix(mix(hash(i),hash(i+vec2(1,0)),f.x),mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),f.x),f.y);}
  void main(){float d=abs(vUV.y);float phase=time*1.55+vUV.x;float impact=pow(max(0.,sin(phase)),4.);
  float incoming=pow(max(0.,sin(phase+d*4.)),10.);float wash=pow(max(0.,sin(phase-.8-d*2.)),2.);
  float grain=noise(vP.xz*24.+vec2(time*.5,-time*.3));float holes=noise(vP.xz*9.-time*.22);
  float edge=1.-smoothstep(.65,1.08,d);float foam=(impact*exp(-d*3.)+incoming*.42+wash*.6*exp(-d*1.4))*edge;
  float cells=smoothstep(.25,.63,grain*.6+holes*.4);float alpha=clamp(foam*(.35+cells*.8),0.,.94);if(alpha<.035)discard;
  gl_FragColor=vec4(mix(vec3(.65,.86,.83),vec3(.98,1.,.96),cells),alpha);}`;
  const mesh=new Mesh('Breaking surf along rock intersections',scene);const data=new VertexData();data.positions=positions;data.indices=indices;data.uvs=uvs;data.applyToMesh(mesh);
  const material=new ShaderMaterial('Wave impact and receding whitewater',scene,{vertex:'rockSurf',fragment:'rockSurf'},{attributes:['position','uv'],uniforms:['worldViewProjection','time'],needAlphaBlending:true});
  material.backFaceCulling=false;material.disableDepthWrite=true;mesh.material=material;mesh.alphaIndex=2;mesh.isPickable=false;
  return {update:(time:number)=>material.setFloat('time',time)};
}
