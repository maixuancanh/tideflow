import { hullHitsQuay, overlaps, rectangle, type Point, type Pose } from './collisionAudit';

// Metres and scene seconds. +X is the authored bow, Babylon yaw turns it towards -Z.
export const TURN_RADIUS = 16;
export const WAIT_SECONDS = 15;
const STEP = .35;
const mod = (v:number) => (v % (Math.PI*2) + Math.PI*2) % (Math.PI*2);
export const angleDelta = (a:number,b:number) => Math.atan2(Math.sin(b-a),Math.cos(b-a));
export const hull = (p:Pose) => rectangle(p,-10.2,10.7,-3.25,3.25);
export const WAITING_POSES:Pose[] = [
  {x:-45,z:55,a:Math.PI/2},{x:45,z:55,a:Math.PI/2},
  {x:-80,z:65,a:Math.PI/2},{x:80,z:65,a:Math.PI/2},{x:0,z:100,a:Math.PI/2},
];
export const BERTH_POSES:Pose[] = [{x:-24,z:10.5,a:Math.PI/2},{x:6.5,z:10.5,a:Math.PI/2},{x:20.5,z:10.5,a:Math.PI/2}];
type Segment = {length:number,curve:number,reverse?:boolean};
export type Route = {poses:Pose[],length:number,segments:Segment[],origin:Pose};

function advance(p:Pose,d:number,k:number):Pose {
  if(Math.abs(k)<1e-9)return {x:p.x+Math.cos(p.a)*d,z:p.z-Math.sin(p.a)*d,a:p.a};
  const a=p.a+k*d;
  return {x:p.x+(Math.sin(a)-Math.sin(p.a))/k,z:p.z+(Math.cos(a)-Math.cos(p.a))/k,a};
}
function makeRoute(origin:Pose,segments:Segment[]):Route {
  const poses=[{...origin}];let p={...origin};
  for(const s of segments){const n=Math.ceil(s.length/STEP);for(let i=0;i<n;i++){p=advance(p,s.length/n*(s.reverse?-1:1),s.curve);poses.push(p);}}
  return {poses,length:segments.reduce((n,s)=>n+s.length,0),segments,origin};
}
export function sampleRoute(route:Route,distance:number):Pose {
  let p={...route.origin},left=Math.max(0,Math.min(route.length,distance));
  for(const s of route.segments){const d=Math.min(left,s.length);p=advance(p,d*(s.reverse?-1:1),s.curve);left-=d;if(left<=1e-9)break;}return p;
}
// Four tangent-circle families. Long arcs are allowed offshore; no independent yaw interpolation.
function candidates(from:Pose,to:Pose):Route[] {
  const dx=to.x-from.x,dy=to.z-from.z,d=Math.hypot(dx,dy)/TURN_RADIUS,theta=Math.atan2(dy,dx);
  const a=mod(-from.a-theta),b=mod(-to.a-theta),sa=Math.sin(a),sb=Math.sin(b),ca=Math.cos(a),cb=Math.cos(b),cab=Math.cos(a-b);
  const paths:{turns:number[],values:number[]}[]=[];
  let p2=2+d*d-2*cab+2*d*(sa-sb);
  if(p2>=0){const t=Math.atan2(cb-ca,d+sa-sb);paths.push({turns:[-1,0,-1],values:[mod(-a+t),Math.sqrt(p2),mod(b-t)]});}
  p2=2+d*d-2*cab+2*d*(-sa+sb);
  if(p2>=0){const t=Math.atan2(ca-cb,d-sa+sb);paths.push({turns:[1,0,1],values:[mod(a-t),Math.sqrt(p2),mod(-b+t)]});}
  p2=-2+d*d+2*cab+2*d*(sa+sb);
  if(p2>=0){const p=Math.sqrt(p2),t=Math.atan2(-ca-cb,d+sa+sb)-Math.atan2(-2,p);paths.push({turns:[-1,0,1],values:[mod(-a+t),p,mod(-b+t)]});}
  p2=d*d-2+2*cab-2*d*(sa+sb);
  if(p2>=0){const p=Math.sqrt(p2),t=Math.atan2(ca+cb,d-sa-sb)-Math.atan2(2,p);paths.push({turns:[1,0,-1],values:[mod(a-t),p,mod(b-t)]});}
  return paths.map(p=>makeRoute(from,p.values.map((v,i)=>({length:v*TURN_RADIUS,curve:p.turns[i]/TURN_RADIUS}))));
}
export type QuayCollision = (polygon:Point[])=>boolean;
export function routeSafe(route:Route,obstacles:Pose[]=[],quayCollision:QuayCollision=hullHitsQuay):boolean {
  const boxes=obstacles.map(hull);
  return route.poses.every(p=>{const box=hull(p);return !quayCollision(box)&&!boxes.some((other,i)=>Math.abs(obstacles[i].x-p.x)<23&&Math.abs(obstacles[i].z-p.z)<23&&overlaps(box,other));});
}
export function planShipRoute(from:Pose,to:Pose,obstacles:Pose[]=[],quayCollision:QuayCollision=hullHitsQuay):Route|null {
  const direct=candidates(from,to).sort((a,b)=>a.length-b.length);
  for(const r of direct)if(routeSafe(r,obstacles,quayCollision))return r;
  // Detour nodes lie seaward of the harbor, never over the apron or warehouse.
  for(const z of [85,115])for(const x of [-65,0,65])for(const a of [0,Math.PI]){
    const via={x,z,a};
    const first=candidates(from,via).sort((a,b)=>a.length-b.length).find(r=>routeSafe(r,obstacles,quayCollision));
    if(!first)continue;
    const second=candidates(via,to).sort((a,b)=>a.length-b.length).find(r=>routeSafe(r,obstacles,quayCollision));
    if(second)return makeRoute(from,[...first.segments,...second.segments]);
  }
  return null;
}

export type ShipPhase='empty'|'entering'|'waiting'|'inbound'|'docked'|'departing'|'gone';
export type Navigator={phase:ShipPhase,pose:Pose,speed:number,distance:number,route:Route|null,waitSince:number,expired:boolean,blocked:boolean,berth:number|null};
export type NavigationEnvironment={
  /** Other harbors' vessels, already transformed into this harbor's coordinates. */
  obstacles?:()=>Pose[];
  /** Other harbors' remaining swept routes in this harbor's coordinates. */
  reservations?:()=>Pose[];
  /** All owned harbor shorelines, tested in this harbor's coordinates. */
  quayCollision?:QuayCollision;
};
export class ShipTraffic {
  constructor(private readonly environment:NavigationEnvironment={}){}
  readonly ships:Navigator[]=WAITING_POSES.map(p=>({phase:'empty',pose:{...p,z:165},speed:0,distance:0,route:null,waitSince:Infinity,expired:false,blocked:false,berth:null}));
  snapshot(){return this.ships.map(({route,waitSince,...ship})=>({...ship,waitSince:Number.isFinite(waitSince)?waitSince:null,route:route?{origin:route.origin,segments:route.segments}:null}));}
  restore(index:number,value:unknown){
    if(!value||typeof value!=='object')return false;
    const v=value as any,pose=(p:any)=>p&&['x','z','a'].every(k=>typeof p[k]==='number'&&Number.isFinite(p[k]));
    if(!['empty','entering','waiting','inbound','docked','departing','gone'].includes(v.phase)||!pose(v.pose)||!Number.isFinite(v.speed)||v.speed<0||!Number.isFinite(v.distance)||v.distance<0||!(v.waitSince===null||Number.isFinite(v.waitSince)))return false;
    let route:Route|null=null;
    if(v.route){if(!pose(v.route.origin)||!Array.isArray(v.route.segments)||v.route.segments.length>100||!v.route.segments.every((s:any)=>Number.isFinite(s.length)&&s.length>0&&s.length<2000&&Number.isFinite(s.curve)))return false;route=makeRoute(v.route.origin,v.route.segments);if(v.distance>route.length+.01)return false;}
    Object.assign(this.ships[index],{phase:v.phase,pose:{...v.pose},speed:v.speed,distance:v.distance,route,waitSince:v.waitSince??Infinity,expired:v.expired===true,blocked:v.blocked===true,berth:Number.isInteger(v.berth)&&v.berth>=0&&v.berth<3?v.berth:null});return true;
  }
  private obstacles(index:number){return [...this.ships.filter((s,i)=>i!==index&&s.phase!=='empty'&&s.phase!=='gone').map(s=>s.pose),...(this.environment.obstacles?.()??[])];}
  private reservations(index:number){
    const obstacles=this.obstacles(index);
    this.ships.forEach((other,i)=>{
      if(i===index||!other.route)return;
      for(let d=other.distance;d<other.route.length;d+=.35)obstacles.push(sampleRoute(other.route,d));
      obstacles.push(sampleRoute(other.route,other.route.length));
    });return [...obstacles,...(this.environment.reservations?.()??[])];
  }
  private assign(index:number,route:Route,phase:ShipPhase){
    const s=this.ships[index];s.route=route;s.distance=0;s.speed=0;s.phase=phase;s.blocked=false;
  }
  spawn(index:number){
    const s=this.ships[index];if(s.phase!=='empty'&&s.phase!=='gone')return false;
    s.pose={...WAITING_POSES[index],z:165};s.expired=false;s.waitSince=Infinity;s.berth=null;
    const r=makeRoute(s.pose,[{length:165-WAITING_POSES[index].z,curve:0}]);
    if(!routeSafe(r,this.reservations(index),this.environment.quayCollision))return false;
    this.assign(index,r,'entering');return true;
  }
  requestBerth(index:number,berth:number){
    const s=this.ships[index];if(s.phase!=='waiting'||s.expired)return false;
    // Swept route reservations below protect the actual fairway, independently per route.
    if(this.ships.some((o,i)=>i!==index&&o.berth===berth&&o.phase!=='gone'&&o.phase!=='empty'))return false;
    const r=planShipRoute(s.pose,BERTH_POSES[berth],this.reservations(index),this.environment.quayCollision);
    if(!r){s.blocked=true;return false;}s.berth=berth;this.assign(index,r,'inbound');return true;
  }
  depart(index:number){
    const s=this.ships[index];if(s.phase!=='waiting'&&s.phase!=='docked')return false;
    // A timed-out waiting vessel keeps its expired state, but yields the exit
    // to the docked vessel rather than starting a long maneuver in front of it.
    if(s.phase==='waiting'&&this.ships.some((o,i)=>i!==index&&o.phase==='docked'))return false;
    // Swept route reservations below protect the actual fairway, independently per route.
    // An offshore arrival need not lock an unrelated exit. Reserve its entire
    // remaining swept path, rather than only testing its current position.
    const obstacles=this.reservations(index);
    // Back straight out of the narrow basin; stop before engaging forward propulsion.
    const reverse=s.phase==='docked'?makeRoute(s.pose,[{length:42,curve:0,reverse:true}]):null;
    if(reverse&&!routeSafe(reverse,obstacles,this.environment.quayCollision)){s.blocked=true;return false;}
    const from=reverse?sampleRoute(reverse,reverse.length):s.pose;
    const exit={x:WAITING_POSES[index].x<0?-105:105,z:165,a:-Math.PI/2};
    const onward=planShipRoute(from,exit,obstacles,this.environment.quayCollision);
    if(!onward){s.blocked=true;return false;}
    this.assign(index,makeRoute(s.pose,[...(reverse?.segments??[]),...onward.segments]),'departing');return true;
  }
  update(dt:number,now:number){
    // Bound substeps so a slow frame cannot skip over another hull.
    const bounded=Math.min(Math.max(dt,0),1),steps=Math.max(1,Math.ceil(bounded/.04)),h=bounded/steps;
    for(let step=0;step<steps;step++)for(let i=0;i<this.ships.length;i++){
      const s=this.ships[i],r=s.route;if(!r)continue;
      const remaining=r.length-s.distance;
      const reverseEnd=r.segments[0]?.reverse?r.segments[0].length:0;
      const brakingDistance=reverseEnd&&s.distance<reverseEnd-1e-5?Math.min(remaining,reverseEnd-s.distance):remaining;
      const maxSpeed=s.distance<reverseEnd?3:9;
      const desired=Math.min(maxSpeed,Math.sqrt(2*1.8*brakingDistance));
      s.speed+=Math.max(-1.8*h,Math.min(1.8*h,desired-s.speed));
      let next=Math.min(r.length,s.distance+s.speed*h);
      if(s.distance<reverseEnd&&next>=reverseEnd-.015){next=reverseEnd;s.speed=0;}
      const p=sampleRoute(r,next);
      if((this.environment.quayCollision??hullHitsQuay)(hull(p))||this.obstacles(i).some(o=>overlaps(hull(p),hull(o)))){s.speed=0;s.blocked=true;continue;}
      s.blocked=false;s.pose=p;s.distance=next;
      if(remaining<.015){s.pose=sampleRoute(r,r.length);s.route=null;s.speed=0;
        if(s.phase==='entering'){s.phase='waiting';s.waitSince=now;}
        else if(s.phase==='inbound')s.phase='docked';else s.phase='gone';
      }
    }
    for(const s of this.ships)if(s.phase==='waiting'&&now-s.waitSince>=WAIT_SECONDS)s.expired=true;
  }
  opacity(index:number){const s=this.ships[index];if(s.phase==='empty'||s.phase==='gone')return 0;const u=Math.max(0,Math.min(1,(s.pose.z-110)/55));return 1-u*u*(3-2*u);}
}

