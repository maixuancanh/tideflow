/** Deterministic scene-clock schedule. Rates affect only the named machine.
 * Pose coordinates match operations.ts; these numbers are animation coordinates,
 * never elapsed seconds. Calendars exclude shared areas, not arbitrary geometry.
 */
export interface ResourceScheduleOptions {
  truckCount: number;
  /** Stable port identity. Every vehicle and lane calendar is local to this port. */
  portId?: string;
  /** Append a berth to the shared scene-clock resource calendar. */
  berth?: number;
  earliest?: number;
  reservations?: readonly ResourceReservation[];
  dockRate?: number;
  yardRate?: number;
  yardCount?: number;
  truckRate?: number;
  secondsPerPoseTick?: number;
}

export type LocalHarborResource = 'dock' | 'yard' | 'garage-throat' | 'outbound-lane' | 'receiving-queue' | 'receiving-lane' | 'yard-bay' | 'return-lane' | `truck:${number}` | `yard:${number}` | `dock:${number}` | `receiving-lane:${number}` | `receiving-queue:${number}`;
export type HarborResource = LocalHarborResource | `port:${string}/${LocalHarborResource}`;
export function portResource(portId: string | undefined, resource: LocalHarborResource): HarborResource {
  if (portId === undefined) return resource;
  if (!portId.trim()) throw new RangeError('Port ID must not be empty');
  return `port:${encodeURIComponent(portId)}/${resource}`;
}
export function isPortResource(resource: HarborResource, portId: string): boolean {
  return resource.startsWith(`port:${encodeURIComponent(portId)}/`);
}
export interface ResourceReservation {
  readonly resource: HarborResource;
  readonly job: number;
  readonly start: number;
  readonly end: number;
}
export interface ResourceJob {
  readonly index: number;
  readonly truck: number;
  readonly yard: number;
  readonly approachAt: number;
  readonly queueAt: number;
  readonly dockAt: number;
  readonly liftedAt: number;
  readonly dockReleasedAt: number;
  readonly dockResetAt: number;
  readonly yardArrivedAt: number;
  readonly yardAt: number;
  readonly yardLiftedAt: number;
  readonly truckClearAt: number;
  readonly placedAt: number;
  readonly yardResetAt: number;
  readonly truckReturnedAt: number;
  readonly completedAt: number;
  readonly wait: Readonly<{ dispatch: number; truck: number; yard: number }>;
}
export interface ResourceSchedule {
  readonly portId?: string;
  readonly jobs: readonly ResourceJob[];
  readonly reservations: readonly ResourceReservation[];
  readonly truckCount: number;
  readonly duration: number;
  readonly dockReleasedAt: number;
}

const positive = (value: number | undefined, fallback: number, name: string) => {
  const result = value ?? fallback;
  if (!Number.isFinite(result) || result <= 0) throw new RangeError(`${name} must be positive and finite`);
  return result;
};

/** All resources are reserved before a trip starts. Trucks rotate in index order.
 * The dock never leaves cargo on an absent truck, and the truck stays underneath
 * the yard crane until its lift reaches the existing clear-height keyframe.
 */
export function buildResourceSchedule(count: number, options: ResourceScheduleOptions): ResourceSchedule {
  if (!Number.isInteger(count) || count < 0 || count > 108) throw new RangeError('Invalid cargo count');
  if (!Number.isInteger(options.truckCount) || options.truckCount < 1 || options.truckCount > 8) throw new RangeError('Invalid truck count');
  const yardCount = options.yardCount ?? 1;
  if (!Number.isInteger(yardCount) || yardCount < 1 || yardCount > 2) throw new RangeError('Invalid yard crane count');
  const tick = positive(options.secondsPerPoseTick, .28, 'secondsPerPoseTick');
  const dockTick = tick / positive(options.dockRate, 1, 'dockRate');
  const yardTick = tick / positive(options.yardRate, 1, 'yardRate');
  const truckTick = tick / positive(options.truckRate, 1, 'truckRate');
  const prior = [...(options.reservations ?? [])].filter(slot => options.portId === undefined
    ? !slot.resource.startsWith('port:') : isPortResource(slot.resource, options.portId));
  const jobs: ResourceJob[] = [], reservations: ResourceReservation[] = [...prior];
  const earliest = Math.max(0, options.earliest ?? 0);
  const resource = (name: LocalHarborResource) => portResource(options.portId, name);
  const dockResource = resource(options.berth === undefined ? 'dock' : `dock:${options.berth}`);
  // All berths in one port share the fleet circuit and its FIFO queue.
  // Only the dock cranes have independent berth calendars.
  const laneResource = resource(options.portId !== undefined || options.berth === undefined ? 'receiving-lane' : `receiving-lane:${options.berth}`);
  const queueResource = resource(options.portId !== undefined || options.berth === undefined ? 'receiving-queue' : `receiving-queue:${options.berth}`);
  const previousTruckJobs = prior.filter(slot => slot.resource.startsWith(options.portId === undefined ? 'truck:' : `port:${encodeURIComponent(options.portId)}/truck:`)).length;
  const truckFree = Array<number>(options.truckCount).fill(0);
  const yardFree = Array<number>(yardCount).fill(0);
  let dockFree = 0;

  for (let index = 0; index < count; index++) {
    let best: { job: ResourceJob; slots: ResourceReservation[] } | undefined;
    // Stable round robin prevents repeated use of the first free truck while
    // equally capable trucks remain visually idle. Wait for this truck if busy.
    for (const truck of [(previousTruckJobs + index) % options.truckCount]) {
      let approachAt = Math.max(earliest, truckFree[truck]);
      let dockAt = Math.max(dockFree, approachAt + 4 * truckTick);
      // Approach and bay admission have independent calendars, so a vehicle can queue
      // while its predecessor receives cargo and clears the shared return crossing.
      // Existing calendars are finite; no sampling, random retry or wall clock.
      for (let attempt = 0; ; attempt++) {
        if (attempt > reservations.length * 4 + 16) throw new Error('Resource schedule did not converge');
        const queueAt = approachAt + 1.9 * truckTick;
        const dockReleasedAt = dockAt + 2 * dockTick;
        const yardArrivedAt = dockReleasedAt + 1.3 * truckTick;
        // Pick the least-loaded yard crane. This keeps the two cranes
        // independent while retaining deterministic FIFO tie-breaking.
        const yard = yardFree.reduce((best, free, i) => free < yardFree[best] - 1e-9 ? i : best, 0);
        const yardAt = Math.max(yardArrivedAt, yardFree[yard]);
        const truckClearAt = yardAt + .7 * yardTick;
        const placedAt = yardAt + 1.95 * yardTick;
        const yardResetAt = yardAt + 2.4 * yardTick;
        const dockResetAt = dockAt + 4 * dockTick;
        const truckReturnedAt = truckClearAt + 3.3 * truckTick;
        const job: ResourceJob = {
          index, truck, yard, approachAt, queueAt, dockAt, liftedAt: dockAt + .35 * dockTick,
          dockReleasedAt, dockResetAt, yardArrivedAt, yardAt,
          yardLiftedAt: yardAt + .25 * yardTick, truckClearAt, placedAt,
          yardResetAt, truckReturnedAt,
          completedAt: Math.max(dockResetAt, yardResetAt, truckReturnedAt),
          wait: { dispatch: Math.max(0, dockAt - Math.max(dockFree, 4 * truckTick)),
            truck: 2 * dockTick + Math.max(0, yardAt - yardArrivedAt) + .7 * yardTick,
            yard: Math.max(0, yardAt - yardArrivedAt) },
        };
        const slot = (name: HarborResource, start: number, end: number): ResourceReservation => ({ resource: name.startsWith('port:') ? name : resource(name as LocalHarborResource), job: index, start, end });
        const slots: ResourceReservation[] = [
          slot(dockResource, dockAt, dockResetAt), slot(`yard:${yard}`, yardAt, yardResetAt),
          slot(`truck:${truck}`, approachAt, truckReturnedAt),
          slot('garage-throat', approachAt, approachAt + 1.35 * truckTick),
          slot('garage-throat', truckClearAt + 1.8 * truckTick, truckReturnedAt),
          // The next vehicle can approach the single queue position while the
          // previous truck receives cargo. It enters the bay only after that
          // predecessor has cleared the shared return crossing and garage throat.
          slot('outbound-lane', approachAt + 1.35 * truckTick, approachAt + 1.9 * truckTick),
          slot('outbound-lane', truckClearAt + 1.8 * truckTick, truckReturnedAt),
          slot(queueResource, approachAt + 1.35 * truckTick, dockAt),
          slot(laneResource, dockAt - .7 * truckTick, truckReturnedAt),
          slot('yard-bay', yardArrivedAt, truckClearAt + .8 * truckTick),
          slot('return-lane', truckClearAt + .8 * truckTick, truckClearAt + 1.8 * truckTick),
        ];
        let shift = 0, approachShift = 0;
        for (const proposed of slots) for (const existing of reservations) {
          if (proposed.resource === existing.resource && proposed.start < existing.end - 1e-9 && existing.start < proposed.end - 1e-9) {
            if (proposed.resource === resource(`truck:${truck}`) || proposed.resource === queueResource || proposed.resource === resource('garage-throat') && proposed.start === approachAt || proposed.resource === resource('outbound-lane') && proposed.start === approachAt + 1.35 * truckTick) approachShift = Math.max(approachShift, existing.end - proposed.start);
            else shift = Math.max(shift, existing.end - proposed.start);
          }
        }
        if (shift > 1e-9 || approachShift > 1e-9) { approachAt += approachShift > 1e-9 ? approachShift + 1e-8 : 0; dockAt = Math.max(dockAt + (shift > 1e-9 ? shift + 1e-8 : 0), approachAt + 4 * truckTick); continue; }
        if (!best || job.placedAt < best.job.placedAt - 1e-9 || Math.abs(job.placedAt - best.job.placedAt) < 1e-9 && truck < best.job.truck) best = { job, slots };
        break;
      }
    }
    if (!best) throw new Error('No truck available');
    jobs.push(Object.freeze({ ...best.job, wait: Object.freeze(best.job.wait) }));
    reservations.push(...best.slots.map(slot => Object.freeze(slot)));
    dockFree = best.job.dockResetAt; yardFree[best.job.yard] = best.job.yardResetAt;
    truckFree[best.job.truck] = best.job.truckReturnedAt;
  }
  return Object.freeze({ portId: options.portId, jobs: Object.freeze(jobs), reservations: Object.freeze(reservations.slice(prior.length)), truckCount: options.truckCount,
    duration: Math.max(0, ...jobs.map(job => job.completedAt)),
    dockReleasedAt: Math.max(0, ...jobs.map(job => job.dockReleasedAt)) });
}

const remap = (time: number, from: number, to: number, low: number, high: number) =>
  low + (high - low) * Math.max(0, Math.min(1, (time - from) / (to - from)));

export type CargoPhase = 'aboard' | 'dock' | 'truck' | 'yard' | 'stored';
/** Pass each separate t directly to its original pose function. Cargo ownership
 * changes only at the same authored contact keyframes (.35, 2, 4.25, 5.95).
 */
export function sampleResourceJob(job: ResourceJob, elapsed: number) {
  const dockT = remap(elapsed, job.dockAt, job.dockResetAt, 0, 4);
  const yardT = remap(elapsed, job.yardAt, job.yardResetAt, 4, 6.4);
  const queueAt = job.queueAt ?? job.approachAt + (job.dockAt - job.approachAt) * 1.9 / 4;
  const finalApproachAt = job.dockAt - (queueAt - job.approachAt) / 1.9 * .7;
  const truckT = elapsed < queueAt ? remap(elapsed, job.approachAt, queueAt, -4, -2.1)
    : elapsed < finalApproachAt ? -2.1
    : elapsed < job.dockAt ? remap(elapsed, finalApproachAt, job.dockAt, -.7, 0)
    : elapsed < job.dockReleasedAt ? 0
    : elapsed < job.yardArrivedAt ? remap(elapsed, job.dockReleasedAt, job.yardArrivedAt, 2, 3.3)
    : elapsed < job.truckClearAt ? 3.3
    : remap(elapsed, job.truckClearAt, job.truckReturnedAt, 4.7, 8);
  const cargoPhase: CargoPhase = elapsed < job.liftedAt ? 'aboard' : elapsed < job.dockReleasedAt ? 'dock'
    : elapsed < job.yardLiftedAt ? 'truck' : elapsed < job.placedAt ? 'yard' : 'stored';
  return { dockT, yardT, truckT, cargoPhase,
    carrying: cargoPhase === 'truck',
    truckActive: elapsed >= job.approachAt && elapsed < job.truckReturnedAt,
    yardWaiting: elapsed >= job.yardArrivedAt && elapsed < job.yardAt };
}

/** Busy/held time includes a truck holding cargo underneath a crane. Separate
 * truckMovingSeconds prevents displaying this as productive driving utilization.
 * Reports are bounded to this trip and remain stable after it ends.
 */
export function resourceTelemetry(schedule: ResourceSchedule, elapsed = schedule.duration) {
  const horizon = Math.max(0, Math.min(Number.isFinite(elapsed) ? elapsed : 0, schedule.duration));
  const resourceSeconds: Record<string, number> = {};
  for (const slot of schedule.reservations) resourceSeconds[slot.resource] = (resourceSeconds[slot.resource] ?? 0) + Math.max(0, Math.min(horizon, slot.end) - slot.start);
  const utilization: Record<string, number> = {};
  for (const [resource, busy] of Object.entries(resourceSeconds)) utilization[resource] = horizon > 0 ? busy / horizon : 0;
  let truckMovingSeconds = 0, truckWaitingSeconds = 0, yardWaitingSeconds = 0;
  const portion = (start: number, end: number) => Math.max(0, Math.min(horizon, end) - start);
  for (const job of schedule.jobs) {
    const queueAt = job.queueAt ?? job.approachAt + (job.dockAt - job.approachAt) * 1.9 / 4;
    const finalApproachAt = job.dockAt - (queueAt - job.approachAt) / 1.9 * .7;
    truckMovingSeconds += portion(job.approachAt, queueAt) + portion(finalApproachAt, job.dockAt) + portion(job.dockReleasedAt, job.yardArrivedAt) + portion(job.truckClearAt, job.truckReturnedAt);
    truckWaitingSeconds += portion(queueAt, finalApproachAt) + portion(job.dockAt, job.dockReleasedAt) + portion(job.yardArrivedAt, job.truckClearAt);
    yardWaitingSeconds += portion(job.yardArrivedAt, job.yardAt);
  }
  return { elapsed: horizon, totalSeconds: schedule.duration, completed: schedule.jobs.filter(job => job.placedAt <= horizon).length,
    resourceSeconds, utilization, truckMovingSeconds, truckWaitingSeconds, yardWaitingSeconds,
    dispatchWaitingSeconds: schedule.jobs.reduce((sum, job) => sum + Math.max(0, Math.min(job.wait.dispatch, horizon - (job.dockAt - job.wait.dispatch))), 0),
    fleetUtilization: horizon > 0 ? (truckMovingSeconds + truckWaitingSeconds) / (horizon * schedule.truckCount) : 0 };
}



