import { Mesh, MeshBuilder, Scene, TransformNode, Vector3, Material } from '@babylonjs/core';
import { Shapes, batch, seedRandom } from './geometry';
import type { Palette } from './materials';

export class Assets {
  g: Shapes;
  constructor(public scene: Scene, public p: Palette) { this.g = new Shapes(scene); }

  container(name: string, color: Material, scale = 1, merge = true) {
    const root = new TransformNode(name, this.scene), g = this.g, p = this.p;
    g.box('corrugated body', 0, .49, 0, 1.12, .98, 2.45, color, root, .045);
    for (let i = 0; i < 17; i++) {
      const z = -1.12 + i * .14;
      for (const x of [-.57, .57]) g.box('side rib', x, .5, z, .042, .84, .044, color, root, .008);
      g.box('roof rib', 0, .993, z, 1.06, .022, .044, color, root, .005);
    }
    for (const x of [-.5, .5]) for (const z of [-1.18, 1.18]) {
      g.box('corner post', x, .5, z, .09, 1.02, .1, color, root, .012);
      for (const y of [.07, .95]) g.box('corner casting', x, y, z, .095, .09, .11, p.steel, root, .008);
    }
    for (const x of [-.25, .25]) {
      g.box('door', x, .5, 1.245, .48, .87, .02, color, root, .008);
      g.beam('door lock', new Vector3(x, .11, 1.273), new Vector3(x, .9, 1.273), .013, p.steel, root);
      g.box('door latch', x + .055, .45, 1.28, .13, .023, .023, p.steel, root, .004);
    }
    g.box('cargo ID plate', .27, .69, 1.28, .25, .13, .015, p.cream, root, .004);
    if (merge) batch(root, name); root.scaling.setAll(scale); return root;
  }

  ship(name: string, variant = 0) {
    const root = new TransformNode(name, this.scene), g = this.g, p = this.p;
    // Continuous hull rings create a rounded bow, flared sides and tapered stern.
    const outline: [number, number][] = [[0,4.8],[.64,4.35],[1.15,3.6],[1.42,2.5],[1.48,1],[1.48,-2.9],[1.3,-3.9],[.85,-4.25],[0,-4.35],[-.85,-4.25],[-1.3,-3.9],[-1.48,-2.9],[-1.48,1],[-1.42,2.5],[-1.15,3.6],[-.64,4.35]];
    const layer = (name: string, rings: number[][], mat: Material) => {
      const pos: number[] = [], ind: number[] = [], n = outline.length;
      rings.forEach(([y, factor]) => outline.forEach(([x,z]) => pos.push(x * factor, y, z * (.96 + factor * .04))));
      for (let j=0;j<rings.length-1;j++) for(let i=0;i<n;i++){const a=j*n+i,b=j*n+(i+1)%n;ind.push(a,b,a+n,b,b+n,a+n);}
      // Outline runs clockwise from the bow; side winding faces outward.
      const mesh=g.mesh(name,pos,ind,mat,root); mesh.material!.backFaceCulling=false; return mesh;
    };
    layer('curved copper keel', [[-.35,.62],[.02,.83],[.28,.94]], p.redHull);
    layer('flared navy hull', [[.28,.94],[.72,1],[1.08,1.01]], p.navy);
    const positions = [0,1.06,0,...outline.flatMap(([x,z])=>[x,1.06,z])], indices:number[]=[];
    for(let i=0;i<outline.length;i++) indices.push(0,1+i,1+(i+1)%outline.length);
    g.mesh('continuous main deck',positions,indices,p.wood,root).material!.backFaceCulling=false;
    const rim = outline.map(([x,z])=>new Vector3(x*1.015,1.09,z)); rim.push(rim[0]);
    g.finish(MeshBuilder.CreateTube('cream gunwale',{path:rim,radius:.055,tessellation:8},this.scene),p.cream,root);
    for (let i=0;i<outline.length;i++) {
      const [x,z]=outline[i]; g.beam('railing stanchion',new Vector3(x,1.1,z),new Vector3(x,1.49,z),.019,p.cream,root);
    }
    for (const height of [1.3,1.49]) g.finish(MeshBuilder.CreateTube('deck handrail',{path:rim.map(v=>new Vector3(v.x,height,v.z)),radius:.015,tessellation:6},this.scene),p.cream,root);
    // Aft superstructure, three decks and wraparound wheelhouse glazing.
    g.box('lower cabin',0,1.53,-2.7,2.23,.92,2.2,p.cream,root,.13);
    g.box('upper cabin',0,2.22,-2.85,1.96,.72,1.72,p.white,root,.13);
    g.box('wheelhouse',0,2.84,-2.64,1.88,.58,1.33,p.cream,root,.11);
    g.box('bridge roof',0,3.18,-2.64,2.16,.12,1.62,p.white,root,.055);
    for (const x of [-.64,0,.64]) g.box('front bridge window',x,2.87,-1.966,.49,.31,.022,p.glass,root,.025);
    for(const side of [-1,1]) {
      for(const z of [-3.05,-2.55]) g.box('side bridge window',side*.946,2.87,z,.022,.31,.36,p.glass,root,.016);
      for(const z of [-3.35,-2.72,-2.15]) { const port=g.cylinder('porthole frame',side*1.13,1.57,z,.108,.035,p.steel,root);port.rotation.z=Math.PI/2;const glass=g.cylinder('porthole',side*1.152,1.57,z,.075,.04,p.glass,root);glass.rotation.z=Math.PI/2; }
      const life=g.torus('lifering',side*1.17,2.1,-3.1,.4,.09,p.orange,root);life.rotation.z=Math.PI/2;
      for(const z of [-1.4,1.1,2.6]) {const tire=g.torus('ship fender',side*1.49,.7,z,.4,.14,p.black,root);tire.rotation.z=Math.PI/2;}
    }
    g.cylinder('funnel',.5,3.52,-3.05,.22,.7,p.yellow,root);g.cylinder('funnel cap',.5,3.92,-3.05,.245,.11,p.navy,root);
    g.beam('mast',new Vector3(-.22,3.2,-2.55),new Vector3(-.22,4.45,-2.55),.033,p.cream,root);
    g.beam('mast crossbar',new Vector3(-.8,4.03,-2.55),new Vector3(.4,4.03,-2.55),.025,p.cream,root);
    g.sphere('mast lantern',-.22,4.48,-2.55,.065,.08,.065,p.emissive,root);
    const cargoRoot=new TransformNode('cargo',this.scene);cargoRoot.parent=root;
    const colors=[p.coral,p.yellow,p.blue,p.cargoCream];
    for(let row=0;row<2;row++)for(let col=0;col<2;col++) {const c=this.container('aboard container',colors[(row+col+variant)%4],.9);c.parent=cargoRoot;c.position.set((col-.5)*1.16,1.09,.02+row*2.28);}
    // Merge only fixed superstructure; cargo remains independently visible while unloading.
    for(const mesh of cargoRoot.getChildMeshes()) mesh.metadata={noMerge:true};
    batch(root,name); return {root,cargo:cargoRoot};
  }

  crane(name: string) {
    const root=new TransformNode(name,this.scene),g=this.g,p=this.p;
    g.box('crane foundation',0,.16,0,1.8,.32,1.8,p.darkStone,root,.1);
    g.box('tapered pedestal',0,1.05,0,1.02,1.75,1.08,p.orange,root,.13);
    g.cylinder('slewing ring',0,1.98,0,.72,.25,p.steel,root);
    batch(root,name+' base');
    const turret=new TransformNode('rotating crane',this.scene);turret.parent=root;
    g.box('crane engine',.3,2.42,.05,1.63,.7,1.13,p.orange,turret,.12);
    g.box('counterweight',.92,2.49,.06,.45,.69,1.25,p.orangeDark,turret,.06);
    g.box('operator cab',-.16,2.7,.77,.84,1.05,.71,p.orange,turret,.12);
    g.box('cab windshield',-.16,2.84,1.137,.65,.56,.03,p.glass,turret,.04);
    g.box('cab side glazing',-.59,2.84,.81,.027,.55,.43,p.glass,turret,.02);
    const base=new Vector3(-.3,2.65,0),elbow=new Vector3(-1.65,6.75,0),tip=new Vector3(-4.35,5.15,0);
    for(const z of [-.2,.2]) {
      g.beam('lifting boom',base.add(new Vector3(0,0,z)),elbow.add(new Vector3(0,0,z)),.19,p.orange,turret);
      g.beam('outer jib',elbow.add(new Vector3(0,0,z)),tip.add(new Vector3(0,0,z)),.135,p.orange,turret);
      g.beam('hydraulic piston',new Vector3(.2,2.7,z),new Vector3(-1.24,5.44,z),.078,p.steel,turret);
      g.beam('tension cable',new Vector3(.7,2.91,z),elbow.add(new Vector3(0,0,z)),.019,p.black,turret);
    }
    for(const point of [base,elbow,tip]) {const hub=g.cylinder('boom pivot',point.x,point.y,point.z,.25,.55,p.orangeDark,turret);hub.rotation.x=Math.PI/2;}
    batch(turret,name+' boom');
    const hoist=new TransformNode('moving hoist',this.scene);hoist.parent=turret;hoist.position.set(-4.35,2.95,0);
    const cargo=this.container('suspended cargo',p.coral,.9);cargo.parent=hoist;cargo.position.set(0,-1.5,0);
    for(const x of [-.43,.43])for(const z of [-.97,.97])g.beam('sling',new Vector3(0,0,0),new Vector3(x,-.6,z),.022,p.black,hoist);
    g.sphere('hook block',0,.12,0,.13,.19,.12,p.yellow,hoist);
    const cable=g.cylinder('hoist cable',-4.35,4.1,0,.023,1,p.black,turret);
    cable.scaling.y=2.05;
    return {root,turret,hoist,cable,cargo};
  }

  warehouse() {
    const root=new TransformNode('barrel roof warehouse',this.scene),g=this.g,p=this.p;
    g.box('warehouse masonry',0,1.7,0,8.6,3.4,6.1,p.cream,root,.09);
    // Front roller door, framed in pale metal, with a deep dark loading bay.
    g.box('open loading bay',0,1.22,3.066,3.45,2.44,.06,p.black,root,.025);
    for(const x of [-1.83,1.83])g.box('door jamb',x,1.3,3.15,.19,2.6,.16,p.white,root,.018);
    g.box('roller housing',0,2.68,3.15,3.82,.2,.2,p.steel,root,.035);
    for(const x of [-3.6,3.6])for(let i=0;i<4;i++)g.box('siding seam',x,1.6,-2.9+i*1.9,.035,3.1,.045,p.edge,root,.005);
    const pos:number[]=[],ind:number[]=[]; const count=32;
    for(const z of [-3.16,3.16])for(let i=0;i<=count;i++){const t=i/count*Math.PI;pos.push(Math.cos(t)*4.55,3.32+Math.sin(t)*2.1,z);}
    for(let i=0;i<count;i++)ind.push(i,i+1,i+count+1,i+1,i+count+2,i+count+1);
    g.mesh('curved zinc roof',pos,ind,p.roof,root).material!.backFaceCulling=false;
    for(let k=0;k<=16;k++){const z=-3.19+k*.399;const path=[];for(let i=0;i<=32;i++){const t=i/32*Math.PI;path.push(new Vector3(Math.cos(t)*4.57,3.34+Math.sin(t)*2.1,z));}g.finish(MeshBuilder.CreateTube('roof standing seam',{path,radius:.018,tessellation:5},this.scene),p.steel,root);}
    for(const z of [-3.2,3.2]){
      const points=[0,3.31,z];for(let i=0;i<=32;i++){const t=i/32*Math.PI;points.push(Math.cos(t)*4.48,3.31+Math.sin(t)*2.04,z);}const ids=[];for(let i=1;i<=32;i++)ids.push(0,i,i+1);g.mesh('arched facade',points,ids,p.cream,root).material!.backFaceCulling=false;
      const path=[];for(let i=0;i<=32;i++){const t=i/32*Math.PI;path.push(new Vector3(Math.cos(t)*4.54,3.34+Math.sin(t)*2.1,z));}g.finish(MeshBuilder.CreateTube('roof rim',{path,radius:.055,tessellation:8},this.scene),p.white,root);
    }
    for(let j=0;j<3;j++){const path=[];for(let i=0;i<=20;i++){const x=-.62+i*.062;path.push(new Vector3(x,3.97+j*.13+Math.sin(i/20*Math.PI*2)*.09,3.225));}g.finish(MeshBuilder.CreateTube('harbor wave emblem',{path,radius:.028,tessellation:6},this.scene),p.blue,root);}
    batch(root,'warehouse');return root;
  }

  tree(seed: number, size = 1) {
    const root=new TransformNode('coastal tree',this.scene),g=this.g,p=this.p,r=seedRandom(seed);
    g.cylinder('trunk',0,.95,0,.17,1.9,p.wood,root,.09);
    for(let i=0;i<9;i++){const a=r()*Math.PI*2,d=r()*.7,x=Math.cos(a)*d,z=Math.sin(a)*d,y=1.65+r()*1.1;
      g.beam('branch',new Vector3(0,.75,0),new Vector3(x,y,z),.045,p.wood,root);
      const leaf=[p.leaf,p.leafLight,p.leafDark][i%3];
      for(let j=0;j<3;j++)g.sphere('foliage crown',x+(r()-.5)*.45,y+(r()-.5)*.3,z+(r()-.5)*.45,.47+r()*.22,.45+r()*.25,.49+r()*.2,leaf,root);
    }
    batch(root,'tree');root.scaling.setAll(size);return root;
  }

  rock(seed:number,size=1){
    const r=seedRandom(seed),mesh=MeshBuilder.CreateIcoSphere('weathered coastal rock',{radius:1,subdivisions:2,flat:false},this.scene);
    const positions=mesh.getVerticesData('position')!;for(let i=0;i<positions.length;i+=3){const f=.94+.09*Math.sin(positions[i]*5+seed)*Math.cos(positions[i+1]*4+positions[i+2]*3);positions[i]*=f;positions[i+1]*=f;positions[i+2]*=f;}mesh.updateVerticesData('position',positions);mesh.scaling.set(size,size*(.6+r()*.4),size*(.8+r()*.5));mesh.rotation.set(r()*.5,r()*6,r()*.3);this.g.finish(mesh,this.p.stone);return mesh;
  }

  forklift() {
    const root=new TransformNode('forklift',this.scene),g=this.g,p=this.p;
    g.box('forklift chassis',0,.43,0,.85,.55,1.28,p.yellow,root,.12);
    for(const x of [-.47,.47])for(const z of [-.39,.39]){const w=g.cylinder('wheel',x,.26,z,.25,.19,p.black,root);w.rotation.z=Math.PI/2;}
    for(const x of [-.38,.38])for(const z of [-.43,.33])g.beam('cab frame',new Vector3(x,.7,z),new Vector3(x,1.5,z),.035,p.black,root);
    g.box('forklift canopy',0,1.54,-.03,.94,.09,1.04,p.yellow,root,.04);
    for(const x of [-.3,.3]){g.box('mast',x,1.03,.79,.08,1.78,.1,p.steel,root,.01);g.box('fork',x,.12,1.1,.1,.09,.9,p.steel,root,.01);}
    g.box('seat',0,.83,-.08,.43,.15,.47,p.black,root,.05);batch(root,'forklift');return root;
  }
}
