import { AbstractMesh, Color4, Effect, MeshBuilder, MirrorTexture, Plane, Scene, ShaderMaterial, Vector3 } from '@babylonjs/core';
import { contactField } from './contactField';

export function ocean(scene:Scene,reflectables:AbstractMesh[],movingMeshes:AbstractMesh[]=[],movingOffset=Vector3.Zero(),motion={position:Vector3.Zero(),forward:new Vector3(1,0,0),speed:0,visibility:1,angle:0,home:Vector3.Zero()}){
  const moving=new Set(movingMeshes);
  const isVessel=(mesh:AbstractMesh)=>{
    let node:any=mesh;
    while(node){if(/vessel|incoming|mariner/i.test(node.name))return true;node=node.parent;}
    return false;
  };
  // No ship may be baked into the static shoreline distance field.
  const contacts=contactField(scene,reflectables.filter(mesh=>mesh.isEnabled()&&!moving.has(mesh)&&!isVessel(mesh)));
  const vesselContacts=contactField(scene,movingMeshes,Vector3.Zero(),motion);
  const waves=`
    float wave(vec2 p){return .012*sin(p.y*1.3+p.x*.8+time*.7)+.009*sin(p.x*1.7-p.y*.9-time*.85);}
  `;
  const mirror=new MirrorTexture('Harbor planar reflection',1024,scene,true);
  mirror.mirrorPlane=new Plane(0,-1,0,.01);// Reflect vessels only. Authored coastal sheets and rock undersides project
  // large dark polygons into this stylized water and must never enter the RTT.
  mirror.renderList=reflectables.filter(mesh=>isVessel(mesh)||moving.has(mesh));mirror.clearColor=new Color4(.32,.55,.61,1);mirror.blurKernel=1;
  Effect.ShadersStore.berthOceanVertexShader=`
    precision highp float;
    attribute vec3 position;uniform mat4 worldViewProjection;uniform mat4 world;uniform float time;
    varying vec3 vWorld;
    ${waves}
    void main(){vec3 p=position;p.y+=wave(p.xz);vWorld=(world*vec4(p,1.)).xyz;gl_Position=worldViewProjection*vec4(p,1.);}
  `;
  Effect.ShadersStore.berthOceanFragmentShader=`
    precision highp float;varying vec3 vWorld;
    uniform float time;uniform vec3 cameraPosition;uniform mat4 viewProjection;uniform sampler2D reflectionSampler;uniform sampler2D contactSampler;uniform sampler2D vesselContactSampler;uniform vec3 vesselOffset;uniform vec3 vesselPosition;uniform vec3 vesselForward;uniform float vesselSpeed;uniform float vesselVisibility;uniform float vesselAngle;uniform vec3 vesselHome;
    ${waves}
    float hash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
    float noise(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);return mix(mix(hash(i),hash(i+vec2(1,0)),f.x),mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),f.x),f.y);}
    float h(vec2 p){
      float swell=sin(p.x*.72+p.y*.38-time*.7)*.016+sin(p.x*-.42+p.y*1.08-time*.86)*.012;
      vec2 warp=vec2(noise(p*.6+time*.04),noise(p*.6-time*.04));
      float ripples=sin(p.x*6.2+p.y*3.4+warp.x*12.+time*1.2)*.008+sin(p.x*-4.5+p.y*8.7+warp.y*12.-time*1.5)*.005;
      return wave(p)*.25+ripples*.7+noise(p*3.+vec2(time*.12,-time*.08))*.046+noise(p*8.-time*.14)*.019+noise(p*19.+time*.09)*.004;
    }
    float hullWidth(float x){float bow=1.-smoothstep(5.6,10.,x);float stern=.65+.35*smoothstep(-9.5,-7.,x);return 2.35*bow*stern;}
    void main(){vec2 p=vWorld.xz;float a=h(p),hx=h(p+vec2(.012,0)),hz=h(p+vec2(0,.012));vec3 n=normalize(vec3((a-hx)/.012,1.,(a-hz)/.012));vec3 v=normalize(cameraPosition-vWorld);
      vec4 proj=viewProjection*vec4(vWorld,1.);vec2 uv=proj.xy/proj.w*.5+.5;uv+=n.xz*.033;
      vec3 reflected=texture2D(reflectionSampler,clamp(uv,vec2(.001),vec2(.999))).rgb;
      float fres=.22+pow(1.-max(dot(n,v),0.),4.)*.52;
      float variation=noise(p*.12)*.65+noise(p*.45)*.35;
      float nearQuay=exp(-abs(p.y+3.25)*.3)*(1.-smoothstep(13.5,16.,abs(p.x)));
      vec3 deep=mix(vec3(.02,.34,.39),vec3(.08,.47,.46),variation*.8+nearQuay*.13);
      vec3 color=mix(deep,reflected,fres);
      vec3 light=normalize(vec3(-.45,1.,.5));float spec=pow(max(dot(reflect(-light,n),v),0.),180.);color+=vec3(1.,.95,.78)*spec*.65;
      vec3 skyLight=normalize(vec3(.45,1.,-.5));float skySpec=pow(max(dot(reflect(-skyLight,n),v),0.),38.);color+=vec3(.13,.22,.23)*skySpec;
      float quay=abs(p.y+3.18);float contact=(1.-smoothstep(.0,.32,quay))*step(abs(p.x),14.6);
      float hull=abs(abs(p.y)-hullWidth(p.x));float atHull=(1.-smoothstep(.02,.3,hull))*step(-9.4,p.x)*step(p.x,9.95);
      float bubbles=smoothstep(.48,.74,noise(p*23.+vec2(time*.19,0))*.5+noise(p*41.-time*.13)*.5);
      vec2 contactUV=(p+vec2(40.,45.))/80.;
      float distanceToSolid=texture2D(contactSampler,contactUV).r*8.;
      if(any(lessThan(contactUV,vec2(0.)))||any(greaterThan(contactUV,vec2(1.))))distanceToSolid=8.;
      vec2 delta=p-vesselPosition.xz;
      float cs=cos(vesselAngle),sn=sin(vesselAngle);
      vec2 vesselUV=(vec2(cs*delta.x-sn*delta.y,sn*delta.x+cs*delta.y)+vesselHome.xz+vec2(40.,45.))/80.;
      if(all(greaterThanEqual(vesselUV,vec2(0.)))&&all(lessThanEqual(vesselUV,vec2(1.))))distanceToSolid=min(distanceToSolid,mix(8.,texture2D(vesselContactSampler,vesselUV).r*8.,vesselVisibility));
      float aPhase=time*1.3+noise(p*.35)*6.28;
      float impact=pow(max(0.,sin(aPhase-.15)),3.);
      float recede=pow(max(0.,sin(aPhase-1.1-distanceToSolid*1.5)),2.);
      float nearSolid=1.-smoothstep(.02,.85+impact*.4,distanceToSolid);
      float lace=smoothstep(.25,.7,noise(p*16.+vec2(0,time*.65))*.6+noise(p*35.-time*.17)*.4);
      float foam=nearSolid*(.18+impact*.95+recede*.45)*(.22+lace*.78);
      float wash=(1.-smoothstep(.0,.68,hull))*step(-9.4,p.x)*step(p.x,9.95);color=mix(color,vec3(.13,.48,.46),wash*.12);
      vec2 relative=p-vesselPosition.xz;
      float along=dot(relative,vesselForward.xz),across=abs(dot(relative,vec2(-vesselForward.z,vesselForward.x)));
      float aft=max(0.,-along-8.);
      float trail=(1.-smoothstep(2.,18.,aft))*smoothstep(0.,1.,aft);
      float wakeEdge=1.-smoothstep(.12,.65,abs(across-(1.3+aft*.18)));
      float churn=(1.-smoothstep(.3,1.7+aft*.08,across))*.45;
      float underway=clamp(vesselSpeed*.1,0.,1.)*trail*(wakeEdge+churn)*lace;
      foam=max(foam,underway*vesselVisibility);
      color=mix(color,vec3(.94,.98,.94),clamp(foam,0.,.96));
      // Continuous depth falloff: never substitute a shallow constant outside
      // the bank or clip translucency with a rectangular step mask.
      float sideHeight=2.25-abs(abs(p.x)-17.3)*.83-max(0.,10.+p.y)*.8-max(0.,-p.y-31.)*.8;
      float rearHeight=2.3-abs(-p.y-28.4)*.69-max(0.,abs(p.x)-20.)*.85;
      float bankHeight=max(sideHeight,rearHeight);
      float coastSide=smoothstep(13.8,16.,abs(p.x));
      float coastRear=smoothstep(23.5,26.,-p.y);
      float naturalCoast=max(coastSide,coastRear);
      // The modeled bank only occupies this footprint. Fade before its edges
      // so a rectangular mesh boundary cannot show through the surface.
      float bankFootprint=(1.-smoothstep(21.,24.,abs(p.x)))
        *smoothstep(5.,8.,-p.y)*(1.-smoothstep(33.,36.,-p.y));
      float shallows=(1.-smoothstep(.2,2.8,-bankHeight))*naturalCoast*bankFootprint;
      color=mix(color,vec3(.2,.63,.57),shallows*.2);
      // Water carries its own shallow tint; terrain polygons must not show through it.
      gl_FragColor=vec4(color,1.);
    }
  `;
  const mesh=MeshBuilder.CreateGround('Real time harbor water',{width:320,height:320,subdivisions:320},scene);mesh.position.y=.01;mesh.isPickable=false;
  const mat=new ShaderMaterial('Small scale reflected seawater',scene,{vertex:'berthOcean',fragment:'berthOcean'},{attributes:['position'],uniforms:['worldViewProjection','world','time','cameraPosition','viewProjection','vesselOffset','vesselPosition','vesselForward','vesselSpeed','vesselVisibility','vesselAngle','vesselHome'],samplers:['reflectionSampler','contactSampler','vesselContactSampler'],needAlphaBlending:false});
  mat.setTexture('contactSampler',contacts);mat.setTexture('vesselContactSampler',vesselContacts);
  mat.setTexture('reflectionSampler',mirror);mesh.material=mat;
  // Custom shaders need explicit RTT registration; otherwise the reflection is never rendered.
  scene.customRenderTargets.push(mirror);
  return {update:(time:number)=>{mat.setFloat('time',time);mat.setVector3('vesselOffset',movingOffset);mat.setVector3('vesselPosition',motion.position);mat.setVector3('vesselForward',motion.forward);mat.setFloat('vesselSpeed',motion.speed);mat.setFloat('vesselVisibility',motion.visibility);mat.setFloat('vesselAngle',motion.angle);mat.setVector3('vesselHome',motion.home);mat.setVector3('cameraPosition',scene.activeCamera?.position??Vector3.Zero());mat.setMatrix('viewProjection',scene.getTransformMatrix());},mesh};
}
