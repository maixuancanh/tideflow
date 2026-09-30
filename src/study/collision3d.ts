/** Continuous convex-box collision on a normalized frame interval [0, 1].
 * Babylon bounding-box corners retain orientation (unlike world AABBs).
 * Corner motion is linear between frames. A speed bound drives conservative
 * advancement, so objects cannot tunnel through one another between samples.
 */
export type Point3 = Readonly<{x:number;y:number;z:number}>;
export type Box3 = readonly Point3[];
export interface MotionBox { id:string; owner:string; previous:Box3; current:Box3; }
export interface Contact3 { a:string; b:string; fraction:number; uncertain:boolean; }
const sub=(a:Point3,b:Point3):Point3=>({x:a.x-b.x,y:a.y-b.y,z:a.z-b.z});
const dot=(a:Point3,b:Point3)=>a.x*b.x+a.y*b.y+a.z*b.z;
const cross=(a:Point3,b:Point3):Point3=>({x:a.y*b.z-a.z*b.y,y:a.z*b.x-a.x*b.z,z:a.x*b.y-a.y*b.x});
const length=(p:Point3)=>Math.hypot(p.x,p.y,p.z);
const mix=(a:Box3,b:Box3,t:number):Box3=>a.map((p,i)=>({x:p.x+(b[i].x-p.x)*t,y:p.y+(b[i].y-p.y)*t,z:p.z+(b[i].z-p.z)*t}));
// Corner order is deliberately ours, independent of Babylon's vertex order.
const edges=(p:Box3)=>[sub(p[1],p[0]),sub(p[2],p[0]),sub(p[4],p[0])];
function separation(a:Box3,b:Box3){
  const ea=edges(a),eb=edges(b);
  const axes=[cross(ea[0],ea[1]),cross(ea[1],ea[2]),cross(ea[2],ea[0]),cross(eb[0],eb[1]),cross(eb[1],eb[2]),cross(eb[2],eb[0]),...ea.flatMap(x=>eb.map(y=>cross(x,y)))];
  let gap=-Infinity;
  for(const axis of axes){const n=length(axis);if(n<1e-12)continue;
    const pa=a.map(p=>dot(p,axis)/n),pb=b.map(p=>dot(p,axis)/n);
    gap=Math.max(gap,Math.min(...pb)-Math.max(...pa),Math.min(...pa)-Math.max(...pb));
  }
  return gap;
}
function sweptOverlap(a:MotionBox,b:MotionBox){
  for(const key of ['x','y','z'] as const){
    const av=[...a.previous,...a.current].map(p=>p[key]),bv=[...b.previous,...b.current].map(p=>p[key]);
    if(Math.max(...av)<Math.min(...bv)||Math.max(...bv)<Math.min(...av))return false;
  }
  return true;
}
export function continuousBoxContact(a:MotionBox,b:MotionBox,tolerance=.002):Contact3|null{
  if(a.owner===b.owner||!sweptOverlap(a,b))return null;
  if([a.previous,a.current,b.previous,b.current].some(p=>p.length!==8||p.some(v=>![v.x,v.y,v.z].every(Number.isFinite))))throw new RangeError('Collision boxes require eight finite corners');
  const speed=Math.max(...a.current.map((p,i)=>length(sub(p,a.previous[i]))))+Math.max(...b.current.map((p,i)=>length(sub(p,b.previous[i]))));
  let t=0;
  for(let iteration=0;iteration<96;iteration++){
    const gap=separation(mix(a.previous,a.current,t),mix(b.previous,b.current,t));
    if(gap<=tolerance)return {a:a.id,b:b.id,fraction:t,uncertain:gap>0};
    if(speed<1e-12||gap>speed*(1-t)+tolerance)return null;
    const step=(gap-tolerance*.5)/speed;
    if(step<1e-9)return {a:a.id,b:b.id,fraction:t,uncertain:true};
    t+=step;if(t>1)return null;
  }
  // Never report an exhausted solver as clear.
  return {a:a.id,b:b.id,fraction:t,uncertain:true};
}
export class ContinuousCollisionWorld {
  private previous=new Map<string,Box3>();
  public frames=0;
  public pairChecks=0;
  reset(){this.previous.clear();this.frames=0;this.pairChecks=0;}
  step(boxes:readonly {id:string;owner:string;corners:Box3}[],ignore:(a:string,b:string)=>boolean=()=>false){
    const motion=boxes.map(b=>({id:b.id,owner:b.owner,previous:this.previous.get(b.id)??b.corners,current:b.corners}));
    const contacts:Contact3[]=[];
    for(let i=0;i<motion.length;i++)for(let j=i+1;j<motion.length;j++){
      const a=motion[i],b=motion[j];if(a.owner===b.owner||ignore(a.id,b.id))continue;
      // Resting pairs are unchanged; keep checking when either object moves.
      const moved=(m:MotionBox)=>m.current.some((p,k)=>length(sub(p,m.previous[k]))>1e-7);
      if(this.frames>0&&!moved(a)&&!moved(b))continue;
      this.pairChecks++;const contact=continuousBoxContact(a,b);if(contact)contacts.push(contact);
    }
    this.previous=new Map(boxes.map(b=>[b.id,b.corners]));this.frames++;return contacts;
  }
}
