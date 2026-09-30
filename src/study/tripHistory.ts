import { resourceTelemetry, sampleResourceJob, type ResourceSchedule } from './resourceSchedule';
import { createReplayScenario, runReplay } from './replaySeed';
import { createReplayScene } from './replayScene';

export interface RecordedTrip {
  version:1; id:string; chain:string; berth:number; recordedAt:string; batchIds:string[];
  cargo:Array<{id:string;batchId?:string;symbol:string;address:string;chain?:string;priority?:number;eventAt?:string;provenance?:import('./cargoFeed').SourceProvenance}>;
  rulesVersion?:string; schedule:ResourceSchedule; ns:number; waitSeconds:number;
}
const phaseNames={aboard:'On vessel',dock:'Berth crane',truck:'On forklift',yard:'Yard crane',stored:'Stored in yard'};
const finite=(value:unknown):value is number=>typeof value==='number'&&Number.isFinite(value)&&value>=0;
function isRecordedTrip(value:unknown):value is RecordedTrip{
  const t=value as RecordedTrip|undefined,s=t?.schedule;
  if(!t||t.version!==1||typeof t.id!=='string'||typeof t.chain!=='string'||!Number.isInteger(t.berth)||t.berth<0||t.berth>2||typeof t.recordedAt!=='string'||!finite(t.ns)||!finite(t.waitSeconds))return false;
  if(!Array.isArray(t.batchIds)||!t.batchIds.every(id=>typeof id==='string')||!Array.isArray(t.cargo)||t.cargo.length>8||!t.cargo.every(c=>c&&typeof c.id==='string'&&typeof c.symbol==='string'&&typeof c.address==='string'&&(c.priority===undefined||finite(c.priority))))return false;
  if(!s||!finite(s.duration)||!Number.isInteger(s.truckCount)||s.truckCount<1||s.truckCount>8||!Array.isArray(s.jobs)||s.jobs.length!==t.cargo.length||!Array.isArray(s.reservations))return false;
  const times=['approachAt','dockAt','liftedAt','dockReleasedAt','dockResetAt','yardArrivedAt','yardAt','yardLiftedAt','truckClearAt','placedAt','yardResetAt','truckReturnedAt','completedAt'] as const;
  return s.jobs.every((j,i)=>j&&j.index===i&&Number.isInteger(j.truck)&&j.truck>=0&&j.truck<s.truckCount&&times.every(k=>finite(j[k])&&j[k]<=s.duration)&&j.wait&&finite(j.wait.dispatch)&&finite(j.wait.truck)&&finite(j.wait.yard))
    &&s.reservations.every(r=>r&&typeof r.resource==='string'&&finite(r.start)&&finite(r.end)&&r.end>=r.start&&r.end<=s.duration);
}

/** Independent read-only Babylon replay. Never calls an economic transition or
 * reuses the live meshes. Opening it pauses scene time. */
export function mountTripHistory(onChange:(trips:RecordedTrip[])=>void,uiRoot:ParentNode=document){
  let trips:RecordedTrip[]=[],playing=false,frame=0,previous=0;
  const button=document.createElement('button');button.textContent='Voyage log';
  uiRoot.querySelector('.controls')!.append(button);
  const dialog=document.createElement('dialog');dialog.className='tideflow-modal';dialog.setAttribute('aria-label','Voyage log and replay');
  dialog.style.cssText='width:min(680px,85vw);max-height:80vh;overflow:auto;border:0;border-radius:16px;background:#f5edda;color:#173c42;padding:24px;pointer-events:auto';
  const title=document.createElement('h2');title.textContent='Voyage replay';
  const note=document.createElement('p');note.textContent='Replay a recorded voyage. Live operations pause during replay. Drag to orbit; scroll to zoom.';
  const canvas=document.createElement('canvas');canvas.setAttribute('aria-label','Independent 3D replay scene');canvas.style.cssText='display:block;width:100%;height:340px;touch-action:none;border-radius:10px';
  const renderStatus=document.createElement('p');renderStatus.setAttribute('role','status');
  let replay:ReturnType<typeof createReplayScene>|undefined,loadedSchedule:ResourceSchedule|undefined;
  function openRenderer(){if(!replay)try{replay=createReplayScene(canvas);}catch{renderStatus.textContent='Could not initialize WebGL. Progress details are still available below.';}replay?.setVisible(true);draw();}
  const select=document.createElement('select');select.setAttribute('aria-label','Completed voyage');select.style.width='100%';
  const summary=document.createElement('p'),source=document.createElement('details'),sourceTitle=document.createElement('summary'),sourceBody=document.createElement('pre');
  sourceTitle.textContent='Manifest and container source';sourceBody.style.cssText='white-space:pre-wrap;overflow-wrap:anywhere';source.append(sourceTitle,sourceBody);
  const slider=document.createElement('input');slider.type='range';slider.min='0';slider.step='.01';slider.value='0';slider.style.width='100%';slider.setAttribute('aria-label','Timeline position');
  const timestamp=document.createElement('p'),rows=document.createElement('div');
  const play=document.createElement('button');play.textContent='Replay';
  const seedInput=document.createElement('input');seedInput.type='text';seedInput.placeholder='Replay seed';seedInput.value='1';seedInput.setAttribute('aria-label','Replay seed');seedInput.style.marginLeft='12px';seedInput.style.width='110px';
  const seedReplay=document.createElement('button');seedReplay.textContent='Create replay seed';seedReplay.title='Create a read-only replay schedule from the immutable manifest';seedReplay.style.marginLeft='8px';
  const close=document.createElement('button');close.className='modal-close';close.textContent='×';close.setAttribute('aria-label','Close record');
  dialog.append(title,note,select,summary,source,canvas,renderStatus,slider,timestamp,rows,play,seedInput,seedReplay,close);document.body.append(dialog);
  const chosen=()=>trips.find(t=>t.id===select.value);
  let challenge:ReturnType<typeof createReplayScenario>|undefined, attempt:ReturnType<typeof runReplay>|undefined;
  const orderRows=document.createElement('div'), allocation=document.createElement('div'), result=document.createElement('p');
  const truckInput=document.createElement('input'),dockInput=document.createElement('input'),yardInput=document.createElement('input');
  for(const [input,label,min,max,value] of [[truckInput,'Forklift',4,8,4],[dockInput,'Berth crane level',0,3,0],[yardInput,'Yard crane level',0,3,0]] as const){input.type='number';input.min=String(min);input.max=String(max);input.value=String(value);input.style.width='48px';const field=document.createElement('label');field.textContent=label+' ';field.append(input);allocation.append(field);}
  const run=document.createElement('button');run.textContent='Run scenario';
  const instruction=document.createElement('p');instruction.textContent='Four-point simulation budget: each added forklift or crane level costs one point. Reorder with ↑. Locked Nansen priorities are preserved; records without priority use a 1–3 fallback seed. Order affects yard priority, not total throughput.';
  dialog.insertBefore(instruction,close);dialog.insertBefore(orderRows,close);dialog.insertBefore(allocation,close);dialog.insertBefore(run,close);dialog.insertBefore(result,close);
  let order:string[]=[];
  function drawOrder(){orderRows.replaceChildren();order.forEach((id,i)=>{const u=challenge!.units.find(u=>u.id===id)!;const row=document.createElement('p');row.textContent=`${i+1}. ${u.symbol} · priority ${u.priority} (${u.prioritySource==='recorded-nansen'?'Nansen locked':'fallback seed · record has no priority'}) `;const up=document.createElement('button');up.textContent='↑';up.disabled=i===0;up.setAttribute('aria-label',`Move ${u.symbol} up`);up.onclick=()=>{[order[i-1],order[i]]=[order[i],order[i-1]];drawOrder();};row.append(up);orderRows.append(row);});}
  function execute(){if(!challenge)return;try{stop();attempt=runReplay(challenge,order,{truckCount:Number(truckInput.value),dockLevel:Number(dockInput.value),yardLevel:Number(yardInput.value)});const baseline=runReplay(challenge,challenge.units.map(u=>u.id),{truckCount:4,dockLevel:0,yardLevel:0});result.textContent=`Spent ${attempt.spent}/4 · time ${attempt.schedule.duration.toFixed(2)}s (baseline ${baseline.schedule.duration.toFixed(2)}s) · truck wait ${attempt.telemetry.truckWaitingSeconds.toFixed(2)}s (baseline ${baseline.telemetry.truckWaitingSeconds.toFixed(2)}s) · weighted priority completion ${attempt.priorityCompletion.toFixed(2)}s (baseline ${baseline.priorityCompletion.toFixed(2)}s). Lower is better. NS +0.`;slider.max=String(attempt.schedule.duration);slider.value='0';draw();}catch(e){attempt=undefined;slider.max=String(chosen()?.schedule.duration??0);slider.value="0";draw();result.textContent=(e as Error).message;}}
  run.onclick=execute;allocation.hidden=instruction.hidden=run.hidden=true;
  function draw(){
    const trip=chosen();rows.replaceChildren();
    play.disabled=slider.disabled=seedReplay.disabled=!trip;
    canvas.hidden=!trip;
    if(!trip){summary.textContent='No completed voyage.';sourceBody.textContent='';timestamp.textContent='';replay?.setVisible(false);return;}
    const schedule=attempt?.schedule??trip.schedule,cargo=attempt?.units??trip.cargo;
    const time=Number(slider.value),telemetry=resourceTelemetry(schedule);
    if(replay){if(loadedSchedule!==schedule){replay.load({schedule,cargo,chain:trip.chain,berth:trip.berth});loadedSchedule=schedule;}replay.setVisible(dialog.open);replay.sample(time);}
    summary.textContent=`${attempt?"REPLAY seed "+challenge!.seed+" · NS +0 · ":"History · "}${trip.cargo.length} ${trip.cargo.length===1?"container":"containers"} · ${attempt?0:trip.ns} NS ${attempt?"(no payment)":"received"} · handling ${schedule.duration.toFixed(1)}s · vessel wait ${trip.waitSeconds.toFixed(1)}s · truck wait ${telemetry.truckWaitingSeconds.toFixed(1)}s · yard crane wait ${telemetry.yardWaitingSeconds.toFixed(1)}s.`;
    sourceBody.textContent=`${challenge?"Replay hash: "+challenge.manifestHash+" · rules: "+challenge.replayRulesVersion+" · source rules: "+challenge.rulesVersion+"\n":""}${trip.recordedAt}\nChain: ${trip.chain}\nManifest: ${trip.id}\nBatch: ${trip.batchIds.join(', ')}\n${trip.cargo.map(c=>c.symbol+' · '+c.address+(c.priority===undefined?' · priority not recorded; replay seed uses fallback':' · Nansen priority locked: '+c.priority)+(c.provenance?'\n  '+c.provenance.endpoint+' · '+c.provenance.transactionHash+' · '+c.eventAt+' · read '+c.provenance.observedAt:'')).join('\n')}`;
    timestamp.textContent=`${time.toFixed(1)} / ${schedule.duration.toFixed(1)} seconds`;
    schedule.jobs.forEach((job,i)=>{const row=document.createElement('p');const sample=sampleResourceJob(job,time);row.textContent=`${i+1}. ${cargo[i]?.symbol??'Container'} · Forklift ${job.truck+1} · ${phaseNames[sample.cargoPhase]}`;row.style.cssText='padding:8px;background:#e2dfcb;border-radius:6px;margin:6px 0';rows.append(row);});
  }
  function stop(){playing=false;cancelAnimationFrame(frame);play.textContent='Replay';}
  function tick(now:number){if(!playing||!dialog.open)return;const trip=chosen();if(!trip)return stop();const duration=attempt?.schedule.duration??trip.schedule.duration;slider.value=String(Math.min(duration,Number(slider.value)+(now-previous)/1000));previous=now;draw();if(Number(slider.value)>=duration)return stop();frame=requestAnimationFrame(tick);}
  function selectTrip(){stop();allocation.hidden=instruction.hidden=run.hidden=true;challenge=undefined;attempt=undefined;order=[];orderRows.replaceChildren();result.textContent="";slider.max=String(chosen()?.schedule.duration??0);slider.value='0';draw();}
  function refresh(){const selected=select.value;select.replaceChildren();for(const trip of [...trips].reverse()){const option=document.createElement('option');option.value=trip.id;option.textContent=`${trip.chain} · berth ${trip.berth+1} · ${trip.cargo.length} ${trip.cargo.length===1?"container":"containers"} · ${new Date(trip.recordedAt).toLocaleTimeString('en-US')}`;select.append(option);}if(trips.some(t=>t.id===selected))select.value=selected;selectTrip();}
  select.onchange=selectTrip;slider.oninput=()=>{stop();draw();};
  play.onclick=()=>{if(playing)return stop();if(Number(slider.value)>=Number(slider.max))slider.value='0';playing=true;previous=performance.now();play.textContent='Pause';frame=requestAnimationFrame(tick);};
  seedReplay.onclick=()=>{
    const trip=chosen();if(!trip)return;
    allocation.hidden=instruction.hidden=run.hidden=false;attempt=undefined;
    challenge=createReplayScenario({batchIds:trip.batchIds,seed:seedInput.value||'1',chain:trip.chain,capturedAt:trip.recordedAt,rulesVersion:trip.rulesVersion??'unknown-source',cargo:trip.cargo});
    order=challenge.units.map(u=>u.id);drawOrder();execute();
  };
  button.onclick=()=>{refresh();dialog.show();openRenderer();};close.onclick=()=>dialog.close();dialog.addEventListener('click',event=>{if(event.target===dialog)dialog.close();});dialog.onclose=()=>{stop();replay?.setVisible(false);};
  return {
    open(id:string){refresh();if(!trips.some(t=>t.id===id))return;select.value=id;selectTrip();dialog.show();openRenderer();},
    get paused(){return dialog.open;},
    dispose(){stop();replay?.dispose();dialog.remove();button.remove();},
    restore(value:unknown){trips=Array.isArray(value)?value.filter(isRecordedTrip).slice(-3):[];refresh();return structuredClone(trips);},
    record(trip:RecordedTrip){
      if(trips.some(t=>t.id===trip.id))return;
      const copy=structuredClone(trip),origin=Math.min(0,...copy.schedule.jobs.map(j=>j.approachAt));
      // Concurrent schedules use the scene clock. Persist a trip-local clock so
      // replay does not wait through every earlier minute of the live session.
      const start=copy.schedule.jobs.length?Math.min(...copy.schedule.jobs.map(j=>j.approachAt)):origin;
      if(start>0){
        const fields=['approachAt','queueAt','dockAt','liftedAt','dockReleasedAt','dockResetAt','yardArrivedAt','yardAt','yardLiftedAt','truckClearAt','placedAt','yardResetAt','truckReturnedAt','completedAt'] as const;
        copy.schedule={...copy.schedule,duration:copy.schedule.duration-start,dockReleasedAt:copy.schedule.dockReleasedAt-start,
          jobs:copy.schedule.jobs.map(job=>{const shifted={...job};for(const key of fields)if(Number.isFinite(shifted[key]))Object.assign(shifted,{[key]:Math.max(0,shifted[key]-start)});return shifted;}),
          reservations:copy.schedule.reservations.map(r=>({...r,start:Math.max(0,r.start-start),end:Math.max(0,r.end-start)}))};
      }
      trips=[...trips,copy].slice(-3);refresh();onChange(structuredClone(trips));
    },
  };
}
