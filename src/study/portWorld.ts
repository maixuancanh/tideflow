import { hullHitsQuay, type Point, type Pose } from './collisionAudit';
import { BERTH_POSES, WAITING_POSES, ShipTraffic, sampleRoute, type Navigator, type Route } from './shipNavigation';

export type PortId = 'coral' | 'jade';
export type PortLocation = {id:PortId;x:number;z:number};
/** Entire authored port, forklift paths and local ship fairway translate together. */
// Authored shore envelope is 48 m wide; leave 5 m of water between islands.
export const PORT_SHORE_WIDTH=48;
export const PORT_GAP=5;
export const PORT_LOCATIONS:Readonly<Record<PortId,Readonly<PortLocation>>> = {
  coral:{id:'coral',x:0,z:0},
  jade:{id:'jade',x:PORT_SHORE_WIDTH+PORT_GAP,z:0},
};
export type PortCapacity = {freeSlots:number;queueLength:number;enabled:boolean};
type RegisteredPort = {location:PortLocation;traffic:ShipTraffic;capacity:PortCapacity};
export type ArrivalAssignment = {portId:PortId;shipIndex:number;traffic:ShipTraffic};

export function toWorldPose(portId:PortId,pose:Pose):Pose {
  const offset=PORT_LOCATIONS[portId];return {...pose,x:pose.x+offset.x,z:pose.z+offset.z};
}
export function toPortPose(portId:PortId,pose:Pose):Pose {
  const offset=PORT_LOCATIONS[portId];return {...pose,x:pose.x-offset.x,z:pose.z-offset.z};
}
export function worldBerthPoses(portId:PortId){return BERTH_POSES.map(p=>toWorldPose(portId,p));}
export function worldWaitingPoses(portId:PortId){return WAITING_POSES.map(p=>toWorldPose(portId,p));}
export function worldRoute(portId:PortId,route:Route):Route {
  return {...route,origin:toWorldPose(portId,route.origin),poses:route.poses.map(p=>toWorldPose(portId,p)),segments:route.segments.map(s=>({...s}))};
}

/**
 * Shared sea coordinator. ShipTraffic continues using its original local coordinates;
 * only hull queries are translated. Each port retains its own ships, waiting clocks,
 * berth ownership and routes. No forklift or crane state is shared by this registry.
 */
export class PortWorld {
  private readonly ports=new Map<PortId,RegisteredPort>();
  private rotation=0;
  private batches=new Map<string,PortId>();
  batchAvailable(id:string,portId:PortId){const owner=this.batches.get(id);return owner===undefined||owner===portId;}
  reserveBatches(ids:string[],portId:PortId){if(ids.some(id=>!this.batchAvailable(id,portId)))return false;for(const id of ids)this.batches.set(id,portId);return true;}
  releaseBatches(ids:string[],portId:PortId){for(const id of ids)if(this.batches.get(id)===portId)this.batches.delete(id);}
  recordAssignment(portId:PortId){const ids=[...this.ports.keys()].sort((a,b)=>PORT_LOCATIONS[a].x-PORT_LOCATIONS[b].x);this.rotation=(ids.indexOf(portId)+1)%ids.length;}


  createTraffic(portId:PortId):ShipTraffic {
    const existing=this.ports.get(portId);if(existing)return existing.traffic;
    const traffic=new ShipTraffic({
      obstacles:()=>this.otherVessels(portId),
      reservations:()=>this.otherReservations(portId),
      quayCollision:polygon=>this.hitsAnyQuay(portId,polygon),
    });
    this.ports.set(portId,{location:{...PORT_LOCATIONS[portId]},traffic,capacity:{freeSlots:0,queueLength:0,enabled:false}});
    return traffic;
  }

  setCapacity(portId:PortId,capacity:PortCapacity){
    this.createTraffic(portId);
    this.ports.get(portId)!.capacity={
      enabled:capacity.enabled,
      freeSlots:Number.isFinite(capacity.freeSlots)?Math.max(0,Math.floor(capacity.freeSlots)):0,
      queueLength:Number.isFinite(capacity.queueLength)?Math.max(0,Math.floor(capacity.queueLength)):0,
    };
  }

  /** Caller passes space after its outstanding manifests have been reserved. */
  choosePort(cargoCount:number,shipIndex?:number,queueOnly=false):PortId|null {
    if(!Number.isFinite(cargoCount)||cargoCount<1||cargoCount>8)return null;
    const ports=[...this.ports.values()].sort((a,b)=>a.location.x-b.location.x);
    if(!ports.length)return null;
    const ranked=ports.map((port,index)=>{
      const ships=port.traffic.ships;
      const freeBerths=BERTH_POSES.length-ships.filter(s=>s.berth!==null&&s.phase!=='empty'&&s.phase!=='gone').length;
      const seaQueue=ships.filter(s=>s.phase==='entering'||s.phase==='waiting'||s.phase==='inbound').length;
      const canSpawn=shipIndex===undefined?ships.some(s=>s.phase==='empty'||s.phase==='gone'):
        !!ships[shipIndex]&&(ships[shipIndex].phase==='empty'||ships[shipIndex].phase==='gone');
      return {port,index,freeBerths,load:port.capacity.queueLength+seaQueue,canSpawn};
    }).filter(({port,canSpawn})=>port.capacity.enabled&&(queueOnly||port.capacity.freeSlots>=cargoCount)&&canSpawn);
    ranked.sort((a,b)=>a.load-b.load||b.freeBerths-a.freeBerths||
      ((a.index-this.rotation+ports.length)%ports.length)-((b.index-this.rotation+ports.length)%ports.length));
    return ranked[0]?.port.location.id??null;
  }

  /** Called by a port's scene when a live manifest is ready for its ship slot. */
  spawnForPort(portId:PortId,shipIndex:number,cargoCount:number):boolean {
    if(this.choosePort(cargoCount,shipIndex)!==portId)return false;
    const port=this.ports.get(portId)!;
    if(!port.traffic.spawn(shipIndex))return false;
    const ids=[...this.ports.values()].sort((a,b)=>a.location.x-b.location.x).map(p=>p.location.id);
    this.rotation=(ids.indexOf(portId)+1)%ids.length;
    // Immediately reserve room so a second scene cannot consume the same room
    // before its next capacity synchronization.
    port.capacity.freeSlots=Math.max(0,port.capacity.freeSlots-cargoCount);
    return true;
  }

  /** Alternate dispatcher when the caller owns the incoming manifest queue. */
  spawn(shipIndex:number,cargoCount:number):ArrivalAssignment|null {
    const portId=this.choosePort(cargoCount,shipIndex);
    if(!portId||!this.spawnForPort(portId,shipIndex,cargoCount))return null;
    return {portId,shipIndex,traffic:this.ports.get(portId)!.traffic};
  }

  snapshot(){return [...this.ports.values()].map(port=>({portId:port.location.id,capacity:{...port.capacity},ships:port.traffic.snapshot()}));}

  private translate(source:PortId,target:PortId,pose:Pose){return toPortPose(target,toWorldPose(source,pose));}
  private visible(ship:Navigator){return ship.phase!=='empty'&&ship.phase!=='gone';}
  private otherVessels(target:PortId):Pose[]{
    const obstacles:Pose[]=[];
    for(const [id,port] of this.ports)if(id!==target)for(const ship of port.traffic.ships)
      if(this.visible(ship))obstacles.push(this.translate(id,target,ship.pose));
    return obstacles;
  }
  private otherReservations(target:PortId):Pose[]{
    const reservations:Pose[]=[];
    for(const [id,port] of this.ports)if(id!==target)for(const ship of port.traffic.ships){
      if(!this.visible(ship)||!ship.route)continue;
      for(let d=ship.distance;d<ship.route.length;d+=.35)reservations.push(this.translate(id,target,sampleRoute(ship.route,d)));
      reservations.push(this.translate(id,target,sampleRoute(ship.route,ship.route.length)));
    }
    return reservations;
  }
  private hitsAnyQuay(source:PortId,polygon:Point[]):boolean {
    const origin=PORT_LOCATIONS[source];
    // Registered ports are physical obstacles even while full/disabled for arrivals.
    for(const port of this.ports.values()){
      const local:Point[]=polygon.map(([x,z])=>[x+origin.x-port.location.x,z+origin.z-port.location.z]);
      if(hullHitsQuay(local))return true;
    }
    return false;
  }
}
