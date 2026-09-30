import { ArcRotateCamera, Color4, DepthRenderer, Effect, Matrix, PostProcess, Scene, Texture, Vector3 } from '@babylonjs/core';
import '@babylonjs/core/Rendering/depthRendererSceneComponent';

/** World-space reveal: orbiting the camera never moves the unlocked territory. */
export function harborMist(scene:Scene,camera:ArcRotateCamera,getPortLevel:()=>number,getCenters:()=>Vector3[]=()=>[Vector3.Zero()]){
  // Territory fog owns a dedicated nonlinear depth map for world reconstruction.
  const caps=scene.getEngine().getCaps();
  const depth=new DepthRenderer(scene,caps.textureFloatRender?1:caps.textureHalfFloatRender?2:0,camera,true,Texture.NEAREST_SAMPLINGMODE);
  scene.customRenderTargets.push(depth.getDepthMap());
  depth.forceDepthWriteTransparentMeshes=true;
  scene.clearColor=new Color4(.975,.975,.96,1);
  Effect.ShadersStore.harborTerritoryMistFragmentShader=`
    precision highp float;
    varying vec2 vUV;
    uniform sampler2D textureSampler,depthSampler;
    uniform mat4 inverseViewProjection;
    uniform vec3 eye;
    uniform float expansion,packedDepth,portCount;
    uniform vec2 port0,port1;
    float unpackDepth(vec4 p){return dot(p,vec4(1./16581375.,1./65025.,1./255.,1.));}
    void main(){
      vec4 source=texture2D(textureSampler,vUV);
      vec4 raw=texture2D(depthSampler,vUV);
      float d=mix(raw.r,unpackDepth(raw),packedDepth);
      vec4 world=inverseViewProjection*vec4(vUV*2.-1.,d*2.-1.,1.);
      vec3 p=world.xyz/world.w;
      // For sky pixels use intersection with sea level, not camera distance.
      if(d>.99999){
        vec4 farPoint=inverseViewProjection*vec4(vUV*2.-1.,.9999,1.);
        vec3 ray=normalize(farPoint.xyz/farPoint.w-eye);
        if(ray.y>=-.0001){gl_FragColor=vec4(.975,.975,.96,1.);return;}
        p=eye+ray*((.01-eye.y)/ray.y);
      }
      vec2 center=vec2(-3.,-6.-expansion*.5);
      vec2 extent=vec2(40.,42.+expansion*.5);
      float distanceFromPort=length((p.xz-(center+port0))/extent);
      if(portCount>1.5){
        // Reveal a continuous capsule joining owned ports, including water between them.
        vec2 segment=port1-port0;
        float along=clamp(dot(p.xz-center-port0,segment)/max(dot(segment,segment),.001),0.,1.);
        distanceFromPort=length((p.xz-center-port0-segment*along)/extent);
      }
      float edge=max(smoothstep(.84,1.36,distanceFromPort),smoothstep(32.,44.,-p.z));
      gl_FragColor=vec4(mix(source.rgb,vec3(.975,.975,.96),edge),source.a);
    }`;
  const mist=new PostProcess('Territory mist','harborTerritoryMist',['inverseViewProjection','eye','expansion','packedDepth','portCount','port0','port1'],['depthSampler'],1,camera,Texture.BILINEAR_SAMPLINGMODE,scene.getEngine());
  let expansion=[0,4.6,9.2,18.4][getPortLevel()]??0;
  const inverse=Matrix.Identity();
  const applyMist=(effect:Parameters<NonNullable<typeof mist.onApply>>[0])=>{
    const desired=[0,4.6,9.2,18.4][getPortLevel()]??0;
    expansion+=(desired-expansion)*(1-Math.exp(-scene.getEngine().getDeltaTime()/900));
    camera.getViewMatrix().multiply(camera.getProjectionMatrix()).invertToRef(inverse);
    effect.setMatrix('inverseViewProjection',inverse);effect.setVector3('eye',camera.globalPosition);
    const centers=getCenters();effect.setFloat('portCount',centers.length);effect.setFloat2('port0',centers[0]?.x??0,centers[0]?.z??0);effect.setFloat2('port1',centers[1]?.x??0,centers[1]?.z??0);
    effect.setFloat('expansion',expansion);effect.setFloat('packedDepth',depth.isPacked?1:0);effect.setTexture('depthSampler',depth.getDepthMap());
  };
  mist.onApply=applyMist;
  let transition:{from:Vector3;to:Vector3;radius:number;toRadius:number;beta:number;toBeta:number;start:number}|null=null;
  function focus(point:Vector3,radius=35,beta=.85){
    camera.inertialAlphaOffset=camera.inertialBetaOffset=camera.inertialRadiusOffset=0;
    camera.inertialPanningX=camera.inertialPanningY=0;
    transition={from:camera.target.clone(),to:point.clone(),radius:camera.radius,toRadius:radius,beta:camera.beta,toBeta:beta,start:performance.now()};
  }
  let suspended=false;
  const observer=scene.onBeforeRenderObservable.add(()=>{
    if(suspended)return;
    const centers=getCenters(),maxX=Math.max(...centers.map(p=>p.x)),minX=Math.min(...centers.map(p=>p.x));
    const limit=76+expansion*.8+(maxX-minX)*1.2;camera.upperRadiusLimit=limit;
    if(transition){const t=Math.min(1,(performance.now()-transition.start)/850),u=t*t*(3-2*t);
      camera.setTarget(Vector3.Lerp(transition.from,transition.to,u));camera.radius=transition.radius+(transition.toRadius-transition.radius)*u;camera.beta=transition.beta+(transition.toBeta-transition.beta)*u;
      if(t===1)transition=null;
    }
    camera.target.x=Math.max(minX-25,Math.min(maxX+23,camera.target.x));camera.target.z=Math.max(-27-expansion,Math.min(18,camera.target.z));
  });
  const canvas=scene.getEngine().getRenderingCanvas();const cancel=()=>{transition=null;};
  canvas?.addEventListener('pointerdown',cancel);canvas?.addEventListener('wheel',cancel);
  scene.onDisposeObservable.addOnce(()=>{scene.onBeforeRenderObservable.remove(observer);canvas?.removeEventListener('pointerdown',cancel);canvas?.removeEventListener('wheel',cancel);mist.dispose();depth.dispose();});
  return {suspend:()=>{suspended=true;transition=null;},resume:()=>{suspended=false;},focus,overview:()=>{const centers=getCenters(),width=Math.max(...centers.map(p=>p.x))-Math.min(...centers.map(p=>p.x));focus(new Vector3(centers.reduce((n,p)=>n+p.x,0)/centers.length-3,2.4,-6-expansion*.5),70+width*.85+expansion*.7,.84);}};
}

