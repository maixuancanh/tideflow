import { overlaps, rectangle, supported, type Pose } from './collisionAudit';
import { BERTH_POSES, WAITING_POSES, ShipTraffic, planShipRoute } from './shipNavigation';
import { buildResourceSchedule, sampleResourceJob, type ResourceJob } from './resourceSchedule';

export type AuditIssue={name:string,samples:number,firstSecond:number};
export function auditTruckRoute(options:{truckCount:number,dockRate:number,yardRate:number,yardCount?:number,pose:(truck:number,t:number)=>Pose,obstacles:{name:string,pose:Pose,halfWidth:number,halfDepth:number}[]}) {
  const schedule=buildResourceSchedule(8,options),issues=new Map<string,AuditIssue>();
  const hit=(name:string,time:number)=>{const old=issues.get(name);if(old)old.samples++;else issues.set(name,{name,samples:1,firstSecond:time});};
  const boxes=options.obstacles.map(o=>({...o,box:rectangle(o.pose,-o.halfWidth,o.halfWidth,-o.halfDepth,o.halfDepth)}));
  const frames=Math.ceil(schedule.duration/.05);
  for(let frame=0;frame<=frames;frame++){
    const time=Math.min(frame*.05,schedule.duration);
    const states=Array.from({length:options.truckCount},(_,truck)=>{
      const job:ResourceJob|undefined=schedule.jobs.filter(j=>j.truck===truck&&time>=j.approachAt).at(-1);
      const sample=job?sampleResourceJob(job,time):undefined;
      const p=options.pose(truck,sample?.truckT??-4);
      // Forks protrude even with no load. Cargo has a wider footprint than chassis.
      const body=rectangle(p,-1.25,1.25,-1.85,1.85);
      const carrying=sample?.carrying??false;
      const forks=[-.72,.72].map(x=>rectangle(p,x-.09,x+.09,carrying?1.5:.6,carrying?4.5:1.8));
      // Container authored long axis is X, at vehicle local Z=3; empty carriage retracts to 40%.
      const cargo=carrying?rectangle(p,-2.45,2.45,1.95,4.05):null;
      return {active:sample?.truckActive??false,footprints:cargo?[body,...forks,cargo]:[body,...forks]};
    });
    for(let i=0;i<states.length;i++){
      const own=states[i].footprints;
      if(own.some(p=>!supported(p)))hit(`Forklift ${i+1} crossed the apron edge`,time);
      for(const obstacle of boxes)if(own.some(p=>overlaps(p,obstacle.box)))hit(`Forklift ${i+1} / ${obstacle.name}`,time);
      for(let j=i+1;j<states.length;j++)if(own.some(a=>states[j].footprints.some(b=>overlaps(a,b))))hit(`Forklift ${i+1} / forklift ${j+1}`,time);
    }
  }
  return {frames:frames+1,duration:schedule.duration,issues:[...issues.values()]};
}
/** Independent traffic copies; no render scene, session or live navigation mutations. */
export function auditShipRoutes(berth:number,names:readonly string[]){
  const results:{ship:string,scenario:string,ok:boolean}[]=[];
  for(let index=0;index<names.length;index++){
    const waiting=WAITING_POSES.filter((_,i)=>i!==index);
    results.push({ship:names[index],scenario:'entering berth, four vessels waiting',ok:!!planShipRoute(WAITING_POSES[index],BERTH_POSES[berth],waiting)});
    const traffic=new ShipTraffic();
    traffic.ships.forEach((s,i)=>{s.pose={...(i===index?BERTH_POSES[berth]:WAITING_POSES[i])};s.phase=i===index?'docked':'waiting';});
    results.push({ship:names[index],scenario:'departing berth, four vessels waiting',ok:traffic.depart(index)});
    const occupiedBerths=BERTH_POSES.filter((_,i)=>i!==berth);
    const crowded=waiting.map((pose,i)=>i<occupiedBerths.length?occupiedBerths[i]:pose);
    results.push({ship:names[index],scenario:'entering berth, two other berths occupied',ok:!!planShipRoute(WAITING_POSES[index],BERTH_POSES[berth],crowded)});
    let other=0;traffic.ships.forEach((s,i)=>{s.route=null;s.phase=i===index?'docked':other<occupiedBerths.length?'docked':'waiting';s.pose={...(i===index?BERTH_POSES[berth]:crowded[other++])};});
    results.push({ship:names[index],scenario:'departing berth, two other berths occupied',ok:traffic.depart(index)});
    const timeout=new ShipTraffic();timeout.ships.forEach((s,i)=>{s.pose={...WAITING_POSES[i]};s.phase='waiting';s.waitSince=0;});timeout.update(0,15);
    results.push({ship:names[index],scenario:'leaves the waiting area after 15s',ok:timeout.ships[index].expired&&timeout.depart(index)});
  }
  return results;
}
