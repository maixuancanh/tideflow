import { harborOutline } from './harborFootprint';
import earcut from 'earcut';
import { Color3, DynamicTexture, Mesh, MeshBuilder, PBRMaterial, Scene, TransformNode, Vector3, VertexBuffer } from '@babylonjs/core';
import { Shapes, batch } from '../geometry';

/** Three finger piers extend the retained working apron; dimensions are in scene metres. */
export function harborLayout(scene:Scene,concrete:PBRMaterial){
  const root=new TransformNode('Three berth harbor infrastructure',scene),g=new Shapes(scene);
  const find=(name:string)=>scene.materials.find(m=>m.name.split('::')[0]===name) as PBRMaterial;
  const paint=(name:string,color:string)=>{const m=new PBRMaterial(name,scene);m.albedoColor=Color3.FromHexString(color);m.roughness=.8;return m;};
  const stone=find('Limestone course 2')??concrete,metal=find('Galvanized hardware')??paint('Harbor metal','#727b78');
  const rubber=find('Aged black rubber')??paint('Harbor rubber','#263b3b'),yellow=paint('Worn ochre markings','#d4af55');
  const ivory=find('Warm ivory enamel'),navy=paint('Berth sign navy','#294954');
  const cargo=[paint('Yard cargo blue','#356275'),paint('Yard cargo ochre','#ba9141'),paint('Yard cargo coral','#aa5741')];
  const lamp=(x:number,z:number)=>{
    g.cylinder('Cast lamp footing',x,1.54,z,.2,.24,metal,root);
    g.cylinder('Tapered dock lamp',x,3.8,z,.055,4.5,metal,root,.035);
    g.beam('Lamp curved bracket',new Vector3(x,6,z),new Vector3(x+.45,6.15,z),.035,metal,root);
    g.box('Lamp hood',x+.47,6.13,z,.42,.1,.24,metal,root,.04);
    g.box('Lamp glass',x+.47,6.07,z,.31,.025,.17,ivory,root,.02);
  };
  // One continuous apron outline, traced from the supplied overhead reference.
  // Walking clockwise: outer right shore, wide basin, middle tongue,
  // narrow oblique basin, diagonal working quay, stepped left shoulder.
  {
    const outline=harborOutline;
    for(const [name,top,thickness,material] of [
      ['Chamfered pier foundation',1.34,2.2,stone],
      ['Chamfered concrete surface',1.465,.125,concrete],
    ] as const){
      const surfaceOutline=name==='Chamfered concrete surface' ? [[-14.5,-25.215],[14.5,-25.215],...outline.slice(1),[-14.5,-4.1]] : outline;
      const m=MeshBuilder.ExtrudePolygon(name,{shape:surfaceOutline.map(([a,b])=>new Vector3(a,0,b)),depth:thickness,sideOrientation:Mesh.DOUBLESIDE},scene,earcut);
      if(name==='Chamfered concrete surface'){
        const positions=m.getVerticesData(VertexBuffer.PositionKind)!;
        const uv:number[]=[];
        for(let i=0;i<positions.length;i+=3)uv.push(positions[i]/28.98,positions[i+2]/8.97);
        m.setVerticesData(VertexBuffer.UVKind,uv);
      }
      m.position.y=top;m.parent=root;m.material=material;m.receiveShadows=true;
    }
    // Follow every diagonal with cut stone blocks, a setback stripe and fenders.
    for(let edge=1;edge<outline.length;edge++){
      const a=outline[edge],b=outline[(edge+1)%outline.length];
      const dx=b[0]-a[0],dz=b[1]-a[1],length=Math.hypot(dx,dz);
      const ux=dx/length,uz=dz/length,nx=-uz,nz=ux;
      const count=Math.ceil(length/1.15);
      for(let k=0;k<count;k++){
        const t=(k+.5)/count;
        const block=g.box('Cut limestone perimeter',a[0]+dx*t+nx*.14,1.46,a[1]+dz*t+nz*.14,length/count-.018,.22,.36,stone,root,.025);
        block.rotation.y=-Math.atan2(dz,dx);
      }
      const stripe=g.box('Safety line follows chamfer',(a[0]+b[0])/2+nx*.58,1.474,(a[1]+b[1])/2+nz*.58,length+.15,.008,.11,yellow,root,.002);
      stripe.rotation.y=-Math.atan2(dz,dx);
      if(length>2){
        const number=Math.max(1,Math.floor(length/2.5));
        for(let k=0;k<number;k++){
          const t=(k+.5)/number,px=a[0]+dx*t,pz=a[1]+dz*t;
          const f=g.torus('Perimeter tire fender',px-nx*.1,.5,pz-nz*.1,1,.23,rubber,root);f.rotation.set(Math.PI/2,Math.atan2(nx,nz),0);
          g.beam('Fender chain',new Vector3(px,1.5,pz),new Vector3(px-nx*.13,.96,pz-nz*.13),.022,metal,root);
          g.cylinder('Bollard base',px+nx*.48,1.58,pz+nz*.48,.23,.1,metal,root);
          g.cylinder('Bollard post',px+nx*.48,1.85,pz+nz*.48,.12,.45,yellow,root);
          g.cylinder('Bollard cap',px+nx*.48,2.1,pz+nz*.48,.23,.09,yellow,root);
        }
      }
    }
  }
  for(const [index,point] of [[-9,9],[-.3,7.8],[13.4,10]].entries()){
    const [x,z]=point;lamp(x-1,z-2.2);
    g.box('Berth number pedestal',x,1.85,z,1.4,.8,.35,stone,root);
    const sign=MeshBuilder.CreatePlane('Berth '+(index+1)+' number',{width:1.2,height:.8},scene);
    sign.parent=root;sign.position.set(x,2.5,z+.2);
    const tex=new DynamicTexture('Painted berth number '+index,256,scene,false);
    tex.drawText('0'+(index+1),null,177,'bold 142px sans-serif','#eee5cd','#294954',true);
    const mat=navy.clone('Number '+index)!;mat.albedoColor=Color3.White();mat.albedoTexture=tex;mat.backFaceCulling=false;sign.material=mat;
  }
  function container(x:number,z:number,level:number,kind:number){
    const cargoRoot=new TransformNode('Yard inventory container',scene);cargoRoot.parent=root;
    cargoRoot.metadata={yardCell:Math.round((-z-16)/2.3)*3+Math.round((x-1.8)/4.6),level};
    cargoRoot.position.set(x,1.48+level*2.05,z);x=0;z=0;
    const m=cargo[kind%3],y=0;
    g.box('Corrugated yard container',x,y+.98,z,4.4,1.96,2,m,cargoRoot,.045);
    for(const side of [-1,1]){
      for(let i=0;i<24;i++)g.box('Pressed cargo corrugation',x-2.06+i*.18,y+.98,z+side*1.015,.065,1.8,.04,m,cargoRoot,.01);
      for(const dx of [-2.14,2.14])g.box('Container corner column',x+dx,y+.98,z+side*.97,.12,2,.12,m,cargoRoot,.018);
      for(const h of [.07,1.91])g.box('Cargo rail',x,y+h,z+side*1,4.4,.12,.1,m,cargoRoot,.018);
    }
    for(let i=0;i<24;i++)g.box('Roof ribs',x-2.07+i*.18,y+1.98,z,.065,.035,1.92,m,cargoRoot,.009);
    for(const dz of [-.48,.48]){
      g.box('Container door panel',x+2.215,y+.98,z+dz,.035,1.78,.92,m,cargoRoot,.014);
      for(const d of [-.21,.21])g.beam('Cargo locking rod',new Vector3(x+2.25,y+.16,z+dz+d),new Vector3(x+2.25,y+1.8,z+dz+d),.018,metal,cargoRoot);
    }
  }
  // Four rows of three end-to-end positions, shared with the handling scheduler.
  for(let row=0;row<4;row++)for(let col=0;col<3;col++){
    const levels=1+(row+col)%2;
    for(let level=0;level<levels;level++)container(1.8+col*4.6,-16-row*2.3,level,row+col+level);
  }
  // Yard handling crane now occupies the former lamp position (12, -10).
  // Keep a clear truck aisle in front of the yard stacks.
  for(let x=-12;x<14;x+=2)g.box('Dashed service road',x,1.474,-12.6,1.15,.008,.1,yellow,root,.001);
  function forklift(x:number,z:number){
    g.box('Forklift chassis',x,1.88,z,1.05,.55,1.8,yellow,root,.15);
    g.box('Forklift counterweight',x,2.15,z-.65,1.07,.7,.55,yellow,root,.16);
    for(const side of [-1,1])for(const dz of [-.58,.61]){
      const wheel=g.cylinder('Forklift rubber wheel',x+side*.54,1.77,z+dz,.3,.19,rubber,root);wheel.rotation.z=Math.PI/2;
      const hub=g.cylinder('Wheel hub',x+side*.65,1.77,z+dz,.13,.025,metal,root);hub.rotation.z=Math.PI/2;
    }
    g.box('Operator seat',x,2.27,z-.2,.53,.15,.47,rubber,root,.06);
    g.box('Seat back',x,2.5,z-.42,.53,.48,.1,rubber,root,.05);
    for(const side of [-1,1]){
      g.beam('Overhead guard post',new Vector3(x+side*.43,2.1,z-.65),new Vector3(x+side*.43,3.3,z-.65),.035,metal,root);
      g.beam('Lift mast',new Vector3(x+side*.36,1.58,z+.92),new Vector3(x+side*.36,3.4,z+.92),.055,metal,root);
      g.box('Fork tine',x+side*.29,1.62,z+1.43,.12,.07,1.1,metal,root,.01);
    }
    g.box('Overhead guard',x,3.32,z-.14,1.05,.1,1.25,metal,root,.03);
    g.box('Fork carriage',x,1.95,z+.98,.88,.65,.09,metal,root,.015);
  }

  // No loose crates or pallets block the warehouse doorway; the active forklift starts inside.
  // Keep inventory containers independent so dispatch can remove real cargo.
  const inventoryRoots=root.getChildTransformNodes(true).filter(n=>n.metadata?.yardCell!==undefined);
  for(const cargoRoot of inventoryRoots)cargoRoot.parent=null;
  batch(root,'Harbor infrastructure');
  for(const cargoRoot of inventoryRoots){const position=cargoRoot.position.clone();cargoRoot.position.setAll(0);cargoRoot.computeWorldMatrix(true);batch(cargoRoot,'Yard inventory');cargoRoot.position.copyFrom(position);cargoRoot.parent=root;}
  return root.getChildMeshes().filter(m=>m instanceof Mesh) as Mesh[];
}
