import type { HarborOperationalSummary } from './harborSession';

/** Observed scene seconds; advice never promises an unmeasured upgrade benefit. */
export function mountOperationSummary(read:()=>HarborOperationalSummary|undefined,uiRoot:ParentNode=document){
  const button=document.createElement('button');button.textContent='Operations summary';
  uiRoot.querySelector('.controls')!.append(button);
  const dialog=document.createElement('dialog');dialog.className='tideflow-modal';dialog.setAttribute('aria-label','Operations summary');
  dialog.style.cssText='width:min(600px,85vw);max-height:80vh;overflow:auto;border:0;border-radius:16px;padding:24px;background:#f5edda;color:#173c42;pointer-events:auto';
  const title=document.createElement('h2');title.textContent='Operations summary';
  const body=document.createElement('p');body.style.whiteSpace='pre-line';
  const recommendation=document.createElement('p'),note=document.createElement('p'),close=document.createElement('button');close.className='modal-close';close.textContent='×';close.setAttribute('aria-label','Close manage');close.onclick=()=>dialog.close();
  dialog.append(title,body,recommendation,note,close);
  dialog.addEventListener('pointerdown',event=>{if(event.target===dialog)dialog.close();});document.body.append(dialog);
  button.onclick=()=>{
    const s=read();if(!s){body.textContent='Connecting session data.';recommendation.textContent='';note.textContent='';dialog.showModal();return;}
    const sec=(n:number)=>`${n.toFixed(1)} seconds`;
    body.textContent=`Completed ${s.completedTrips} voyages · cancelled ${s.lostTrips} voyages · exported ${s.exportedUnits} containers\nNS earned ${s.nsWon} · NS spent ${s.nsLost}\nVessel wait before service: ${sec(s.vesselWaitSeconds)}\nTruck holding/waiting for crane: ${sec(s.truckWaitSeconds)}\nBerth crane truck/lane wait: ${sec(s.craneWaitSeconds)}\nYard crane truck wait: ${sec(s.yardCraneQueueSeconds)}\nYard space unavailable for waiting vessel: ${sec(s.yardFullSeconds)}`;
    recommendation.textContent=s.yardFullSeconds>=5?'Prioritize standard exports to free yard space; consider upgrading the harbor if this continues.':s.measuredTrips<3?'At least 3 measured voyages are needed before recommending equipment.':s.yardCraneQueueSeconds>s.handlingSeconds*.1?'Containers are queued before the yard crane; consider upgrading the yard crane.':s.craneWaitSeconds>s.handlingSeconds*.15?'Berth cranes wait for trucks or shared lanes. Consider more trucks when space allows.':s.truckWaitSeconds>s.handlingSeconds*.5?'Trucks spend significant time waiting for cranes. Upgrade the busiest berth crane and compare later voyages.':'No clear bottleneck found for an equipment purchase.';
    note.textContent=`Metrics since ${new Date(s.metricsSince).toLocaleString('en-US')} · ${s.measuredTrips} measured voyages. Vessel/truck/crane time only counts after voyages complete; older voyages without metrics are not inferred. Yard is measured during active play, saved periodically; a recent interval may be lost after an abrupt close. NS spent is the actual deduction and excludes equipment purchases. Recommendations use measurements, not projected capacity gains.`;
    dialog.showModal();
  };dialog.addEventListener('click',event=>{if(event.target===dialog)dialog.close();});
  return {get paused(){return dialog.open;}};
}
