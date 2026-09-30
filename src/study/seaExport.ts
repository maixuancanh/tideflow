import { BERTH_POSES, type ShipTraffic } from './shipNavigation';

export type SeaExportPhase = 'pending' | 'arriving' | 'waiting' | 'inbound' | 'loading' | 'exit-queued' | 'departing' | 'completed' | 'cancelled';
export type SeaExportOptions = {
  /** Only set after restoring this export's navigator checkpoint into its slot. */
  resume?:boolean;
  /** Persisted physical loading completion; economic settlement remains external. */
  loaded?:boolean;
};

const leases = new WeakMap<ShipTraffic, Set<number>>();

/**
 * Reserves an existing vessel slot for an outbound cargo order. The parent must
 * exclude this slot from import spawning, import expiry and import unloading.
 * Call tick(now) after traffic.update(dt, now). Export waiting uses the same
 * 15 second expiry but must be excluded from import penalties. Only the parent
 * advances traffic, renders cargo, persists the reservation and settles NS.
 */
export function createSeaExport(traffic:ShipTraffic,index:number,berth:number,options:SeaExportOptions={}) {
  if(!Number.isInteger(index)||index<0||index>=traffic.ships.length)throw new RangeError('Invalid export vessel slot');
  if(!Number.isInteger(berth)||berth<0||berth>=BERTH_POSES.length)throw new RangeError('Invalid export berth');
  const ship=traffic.ships[index];
  const owned=leases.get(traffic)??new Set<number>();
  if(owned.has(index))throw new Error('Vessel slot already belongs to an export');
  if(!options.resume&&ship.phase!=='empty'&&ship.phase!=='gone')throw new Error('Export requires an idle vessel slot');
  if(options.resume&&ship.berth!==null&&ship.berth!==berth)throw new Error('Restored export berth does not match navigator');
  if(options.loaded&&!options.resume)throw new Error('Loaded export requires a restored navigator');
  if(options.loaded&&ship.phase!=='docked'&&ship.phase!=='departing'&&ship.phase!=='gone')throw new Error('Loaded export navigator is not at or leaving its berth');
  leases.set(traffic,owned);owned.add(index);

  let started=options.resume===true&&ship.phase!=='empty';
  let loaded=options.loaded===true;
  let timedOut=options.resume===true&&ship.expired&&!loaded;
  let entryBlocked=false;
  let nextAttempt=-Infinity;
  let completed=started&&ship.phase==='gone';
  let disposed=false;
  const release=()=>{owned.delete(index);if(!owned.size)leases.delete(traffic);};
  if(completed)release();

  function phase():SeaExportPhase {
    if(completed)return timedOut?'cancelled':'completed';
    if(!started)return 'pending';
    switch(ship.phase){
      case 'entering':return 'arriving';
      case 'waiting':return timedOut?'exit-queued':'waiting';
      case 'inbound':return 'inbound';
      case 'docked':return loaded?'exit-queued':'loading';
      case 'departing':return 'departing';
      default:return 'pending';
    }
  }

  function tick(now:number) {
    if(disposed||completed||!Number.isFinite(now))return phase();
    if(started&&ship.phase==='waiting'&&ship.expired)timedOut=true;
    if(started&&ship.phase==='gone'){completed=true;release();return phase();}
    if(now<nextAttempt)return phase();
    nextAttempt=now+.5;
    if(!started){
      if(ship.phase!=='empty'&&ship.phase!=='gone')return phase();
      started=traffic.spawn(index);
      entryBlocked=!started;
    }else if(ship.phase==='waiting'){
      if(timedOut)traffic.depart(index);
      else traffic.requestBerth(index,berth);
    }else if(ship.phase==='docked'&&loaded){
      // Retried when another route temporarily owns the exit; never teleport.
      traffic.depart(index);
    }
    return phase();
  }

  return {
    index,berth,tick,
    get phase(){return phase();},
    get ready(){return !disposed&&!completed&&started&&ship.phase==='docked'&&!loaded;},
    get loaded(){return loaded;},
    get completed(){return completed;},
    get blocked(){return entryBlocked||(started&&ship.blocked);},
    get expired(){return timedOut;},
    get cancelled(){return completed&&timedOut;},
    get opacity(){return started?traffic.opacity(index):0;},
    get pose(){return {...ship.pose};},
    /** Call after the last reserved container is physically attached to the ship. */
    finishLoading(){
      if(disposed||completed)return false;
      if(loaded)return true;
      if(!started||ship.phase!=='docked')return false;
      loaded=true;nextAttempt=-Infinity;return true;
    },
    snapshot(){return {index,berth,started,loaded,completed,timedOut,phase:phase()};},
    /** Scene teardown only. It does not remove the ship or settle/cancel an order. */
    dispose(){disposed=true;release();},
  };
}

export type SeaExport = ReturnType<typeof createSeaExport>;
