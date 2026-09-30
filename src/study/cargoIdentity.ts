import { Color3, DynamicTexture, PBRMaterial, Scene, TransformNode, MeshBuilder } from '@babylonjs/core';
import { isHarborChain, type HarborChain } from './chains';

export type CargoToken = {
  chain: HarborChain;
  address: string;
  symbol: string;
};

type IdentityAssets = { body: PBRMaterial; side: PBRMaterial; top: PBRMaterial };
const assets = new WeakMap<Scene, Map<string, IdentityAssets>>();


const chainStyle = {
  bnb: { body: '#d6a936', accent: '#111820', label: '#171b22', badge: 'BNB CHAIN' },
  ethereum: { body: '#5c6fc6', accent: '#272d52', label: '#12182c', badge: 'ETHEREUM' },
  base: { body: '#195cdb', accent: '#ecf3ff', label: '#102245', badge: 'BASE' },
  arbitrum: { body: '#269cc8', accent: '#142338', label: '#142338', badge: 'ARBITRUM' },
  polygon: { body: '#8648bd', accent: '#ede2ff', label: '#291438', badge: 'POLYGON' },
} as const;

// Only symbols with a deliberately drawn, recognizable mark use a logo. Other
// assets still receive their symbol text, avoiding unsafe arbitrary logo lookup.
const verifiedLogos = new Set(['BNB', 'ETH', 'USDT']);
const knownAddresses: Record<string, Set<string>> = {
  BNB: new Set(['native', '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee']),
  ETH: new Set(['native', '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee']),
  USDT: new Set([
    '0x55d398326f99059ff775485246999027b3197955', // BNB Chain USDT
    '0xdac17f958d2ee523a2206206994597c13d831ec7', // Ethereum USDT
  ]),
};

function hasVerifiedLogo(token: CargoToken): boolean {
  const symbol = token.symbol.trim().toUpperCase();
  const address = (token.address || 'native').trim().toLowerCase();
  return verifiedLogos.has(symbol) && (knownAddresses[symbol]?.has(address) ?? false);
}

function materialFor(scene: Scene, token: CargoToken): IdentityAssets {
  let map = assets.get(scene);
  if (!map) { map = new Map(); assets.set(scene, map); }
  const symbol = token.symbol.trim().toUpperCase() || 'CONTAINER';
  const key = `${token.chain}:${symbol}:${token.address.trim().toLowerCase()}`;
  const cached = map.get(key);
  if (cached) return cached;
  const style = chainStyle[token.chain];
  const body = new PBRMaterial(`Cargo body ${key}`, scene);
  body.albedoColor = Color3.FromHexString(style.body); body.roughness = .72; body.metallic = .14;
  const side = new PBRMaterial(`Cargo identity side ${key}`, scene);
  side.albedoColor = Color3.FromHexString(style.label); side.roughness = .8;
  const top = new PBRMaterial(`Cargo identity top ${key}`, scene);
  top.albedoColor = Color3.FromHexString(style.label); top.roughness = .8;
  const result = { body, side, top }; map.set(key, result); return result;
}

function drawIdentity(scene: Scene, token: CargoToken, texture: DynamicTexture, includeLogo: boolean, face: 'side' | 'top') {
  const ctx:any = texture.getContext();
  const w = texture.getSize().width, h = texture.getSize().height;
  const style = chainStyle[token.chain];
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = style.label; ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = style.body; ctx.fillRect(12, 12, w - 24, h - 24);
  ctx.strokeStyle = style.accent; ctx.lineWidth = 10; ctx.strokeRect(14, 14, w - 28, h - 28);
  if (includeLogo) {
    const cx = 90, cy = h / 2;
    ctx.fillStyle = style.accent; ctx.beginPath(); ctx.moveTo(cx, cy - 55); ctx.lineTo(cx + 48, cy); ctx.lineTo(cx, cy + 55); ctx.lineTo(cx - 48, cy); ctx.closePath(); ctx.fill();
    ctx.fillStyle = '#f1eee3'; ctx.font = 'bold 42px Arial'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(token.symbol.trim().toUpperCase() === 'USDT' ? 'T' : token.symbol.trim().toUpperCase(), cx, cy);
  }
  ctx.fillStyle = '#f7f0dc'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.font = 'bold 92px Arial';
  ctx.fillText((token.symbol.trim().toUpperCase() || 'CONTAINER').slice(0, 8), 170, h * .47);
  ctx.font = 'bold 30px Arial'; ctx.fillStyle = '#fff8e8'; ctx.fillText(style.badge, 174, h * .77);
  // Canvas text must keep its vertical orientation when uploaded to the plane.
  texture.update(face === 'side');
}

function identityTexture(scene: Scene, token: CargoToken, face: 'side' | 'top'): DynamicTexture {
  const symbol = token.symbol.trim().toUpperCase() || 'CONTAINER';
  const key = `Cargo identity texture ${face}:${token.chain}:${symbol}:${token.address.trim().toLowerCase()}`;
  const existing = scene.textures.find(t => t.name === key) as DynamicTexture | undefined;
  if (existing) return existing;
  const texture = new DynamicTexture(key, { width: 1024, height: 256 }, scene, true);
  drawIdentity(scene, token, texture, hasVerifiedLogo(token), face);
  return texture;
}

/** Closed, smooth six-face shell shared by ship, forklift and stored cargo. */
export function paintCargo(scene: Scene, root: TransformNode, token: CargoToken): void {
  if(!isHarborChain(token.chain))throw new Error('Unsupported container chain');
  const normalized: CargoToken = { chain: token.chain, address: token.address || 'native', symbol: token.symbol?.trim().toUpperCase() || 'CONTAINER' };
  const materials = materialFor(scene, normalized);
  const children = root.getChildMeshes();
  // Discard obsolete extracted geometry before cloning cargo for ships and storage.
  // Shared materials/textures remain owned by the scene.
  for (const mesh of children) if (!mesh.metadata?.smoothCargo) mesh.dispose(false, false);
  let shell = children.find(m => m.metadata?.smoothCargo === 'shell');
  if (!shell) {
    shell = MeshBuilder.CreateBox('Smooth cargo closed shell', {width:4.4,height:2,depth:2}, scene);
    shell.parent=root;shell.position.y=1;shell.metadata={smoothCargo:'shell'};shell.receiveShadows=true;
    const trim=new PBRMaterial('Smooth cargo corner trim',scene);
    trim.albedoColor=Color3.FromHexString('#b9bbae');trim.metallic=.25;trim.roughness=.75;
    const bar=(name:string,x:number,y:number,z:number,width:number,height:number,depth:number)=>{
      const m=MeshBuilder.CreateBox(name,{width,height,depth},scene);m.parent=root;m.position.set(x,y,z);m.material=trim;m.metadata={smoothCargo:'trim'};m.receiveShadows=true;
    };
    for(const x of [-2.17,2.17])for(const z of [-.97,.97])bar('Cargo corner post',x,1,z,.09,2.02,.09);
    for(const y of [.045,1.955]){
      for(const z of [-.98,.98])bar('Cargo perimeter long rail',0,y,z,4.4,.09,.06);
      for(const x of [-2.18,2.18])bar('Cargo perimeter end rail',x,y,0,.06,.09,2);
    }
    // Centered signage on all four walls; the roof remains flat beneath its print.
    for(const face of ['front','back','left','right']){
      const end=face==='left'||face==='right';
      const panel=MeshBuilder.CreatePlane('Cargo smooth logo '+face,{width:end?1.65:2.8,height:end?.72:.9},scene);
      panel.parent=root;panel.position.y=1.06;
      if(face==='front'){panel.position.z=1.012;panel.rotation.y=Math.PI;}
      if(face==='back'){panel.position.z=-1.012;panel.rotation.y=0;}
      if(face==='left'){panel.position.x=-2.212;panel.rotation.y=Math.PI/2;}
      if(face==='right'){panel.position.x=2.212;panel.rotation.y=-Math.PI/2;}
      panel.metadata={smoothCargo:'logo'};panel.isPickable=false;
    }
  }
  let roof = root.getChildMeshes().find(mesh=>mesh.metadata?.smoothCargo==='roofLogo');
  if(!roof){
    roof=MeshBuilder.CreatePlane('Cargo smooth roof logo',{width:4.12,height:1.76},scene);
    roof.parent=root;roof.position.set(0,2.016,0);roof.rotation.x=Math.PI/2;
    roof.metadata={smoothCargo:'roofLogo'};roof.isPickable=false;
  }
  shell.material=materials.body;
  materials.side.albedoColor=Color3.White();
  materials.side.albedoTexture=identityTexture(scene,normalized,'side');
  materials.side.metallic=0;materials.side.backFaceCulling=true;
  materials.top.albedoColor=Color3.White();
  materials.top.albedoTexture=identityTexture(scene,normalized,'top');
  materials.top.metallic=0;materials.top.backFaceCulling=true;
  roof.material=materials.top;
  for(const mesh of root.getChildMeshes())if(mesh.metadata?.smoothCargo==='logo')mesh.material=materials.side;
  root.metadata={...(root.metadata??{}),token:normalized,cargoIdentity:true};
}
