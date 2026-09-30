import { Color3, Material, PBRMaterial, Scene } from '@babylonjs/core';

/** Same meshes, scale and transforms as Coral. Only non-cargo paint changes.
 * Routing, collision envelopes and crane attachment points remain identical. */
export function portAppearance(scene:Scene,activePort:()=>string,materials:Material[]=scene.materials,uiRoot:ParentNode=document){
  const paints=materials.filter((m):m is PBRMaterial=>m instanceof PBRMaterial)
    .map(material=>({material,color:material.albedoColor.clone()}));
  const badge=document.createElement('div');badge.className='port-identity';
  badge.style.cssText='position:absolute;left:24px;top:66px;padding:7px 12px;border-radius:8px;background:#163f43;color:#fff;pointer-events:none;z-index:5;font-size:12px';
  uiRoot.querySelector('#interface')?.append(badge);
  function apply(id:string,preview=false){
    for(const {material,color} of paints){
      material.albedoColor.copyFrom(color);
      if(id!=='jade')continue;
      const name=material.name.toLowerCase();
      if(/cargo|token|container|vessel|bridge|hull/.test(name))continue;
      if(/crane|orange|ochre enamel/.test(name))material.albedoColor=Color3.FromHexString('#59a99b');
      else if(/warehouse lime plaster/.test(name))material.albedoColor=Color3.FromHexString('#bad2c8');
      else if(/roof|corrugated|galvanized/.test(name))material.albedoColor=Color3.FromHexString('#c4d6d5');
      else if(/berth sign navy/.test(name))material.albedoColor=Color3.FromHexString('#15695e');
      else if(/worn ochre markings/.test(name))material.albedoColor=Color3.FromHexString('#dcebd9');
    }
    badge.textContent=`${preview?'PREVIEW · ':''}${id==='jade'?'JADE HARBOR · 36 SLOT':'CORAL HARBOR'}`;
  }
  const preview=(event:Event)=>{const id=(event as CustomEvent<string|null>).detail;if(uiRoot.querySelector<HTMLElement>('#interface')?.hidden)return;apply(id??activePort(),!!id);};
  window.addEventListener('harbor-port-preview',preview);apply(activePort());
  scene.onDisposeObservable.addOnce(()=>{window.removeEventListener('harbor-port-preview',preview);badge.remove();});
}
