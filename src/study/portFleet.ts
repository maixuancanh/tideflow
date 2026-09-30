import { buildResourceSchedule, portResource, sampleResourceJob } from './resourceSchedule';
import type { ResourceJob, ResourceReservation, ResourceSchedule, ResourceScheduleOptions } from './resourceSchedule';

/** Data owned by one port, never a global vehicle pool. Times use scene seconds. */
export interface PortFleetTrip {
  readonly id: string;
  readonly berth: number;
  readonly schedule: ResourceSchedule;
}
export interface PortFleetState {
  readonly portId: string;
  readonly truckCount: number;
  readonly routeId: string;
  readonly trips: readonly PortFleetTrip[];
}
export interface PortFleetRequest {
  readonly id: string;
  readonly berth: number;
  readonly cargoCount: number;
  readonly earliest: number;
}
export type PortFleetRates = Pick<ResourceScheduleOptions, 'dockRate' | 'yardRate' | 'yardCount' | 'truckRate' | 'secondsPerPoseTick'>;

export function createPortFleet(portId: string, truckCount: number): PortFleetState {
  portResource(portId, 'outbound-lane');
  if (!Number.isInteger(truckCount) || truckCount < 1 || truckCount > 8) throw new RangeError('Invalid truck count');
  return Object.freeze({ portId, truckCount, routeId: `port:${encodeURIComponent(portId)}/fleet-circuit`, trips: Object.freeze([]) });
}

/** FIFO append. Replaying a command cannot dispatch a second copy of its trucks. */
export function enqueuePortTrip(fleet: PortFleetState, request: PortFleetRequest, rates: PortFleetRates = {}): PortFleetState {
  if (fleet.trips.some(trip => trip.id === request.id)) return fleet;
  if (!request.id.trim()) throw new RangeError('Trip ID must not be empty');
  if (!Number.isInteger(request.berth) || request.berth < 0 || request.berth > 2) throw new RangeError('Invalid berth');
  if (!Number.isFinite(request.earliest) || request.earliest < 0) throw new RangeError('Invalid start time');
  const reservations: ResourceReservation[] = fleet.trips.flatMap(trip => [...trip.schedule.reservations]);
  const last = fleet.trips.at(-1)?.schedule.jobs.at(-1);
  const schedule = buildResourceSchedule(request.cargoCount, {
    ...rates, portId: fleet.portId, truckCount: fleet.truckCount, berth: request.berth,
    earliest: Math.max(request.earliest, last?.approachAt ?? 0), reservations,
  });
  return Object.freeze({ ...fleet, trips: Object.freeze([...fleet.trips, Object.freeze({ id: request.id, berth: request.berth, schedule })]) });
}

/** Increasing equipment changes future dispatches only; live assignments stay valid. */
export function increasePortFleet(fleet: PortFleetState, truckCount: number): PortFleetState {
  createPortFleet(fleet.portId, truckCount);
  if (truckCount < fleet.truckCount) throw new RangeError('Cannot remove vehicles from an active port fleet');
  return Object.freeze({ ...fleet, truckCount });
}

export function portTruckId(portId: string, truck: number): string {
  if (!Number.isInteger(truck) || truck < 0) throw new RangeError('Invalid truck index');
  return portResource(portId, `truck:${truck}`);
}

/** Exactly one pose owner per physical truck. Idle trucks remain inside this port's garage. */
export function samplePortFleet(fleet: PortFleetState, time: number) {
  if (!Number.isFinite(time)) throw new RangeError('Invalid fleet time');
  return Array.from({ length: fleet.truckCount }, (_, truck) => {
    let active: { trip: PortFleetTrip; job: ResourceJob } | undefined;
    for (const trip of fleet.trips) for (const job of trip.schedule.jobs) {
      if (job.truck !== truck || time < job.approachAt || time >= job.truckReturnedAt) continue;
      if (active) throw new Error(`Overlapping assignments for ${portTruckId(fleet.portId, truck)}`);
      active = { trip, job };
    }
    return { id: portTruckId(fleet.portId, truck), portId: fleet.portId, truck,
      routeId: fleet.routeId, tripId: active?.trip.id, berth: active?.trip.berth,
      job: active?.job, pose: active ? sampleResourceJob(active.job, time) : undefined };
  });
}
