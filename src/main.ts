import './style.css';
import { buildWorld } from './world';
import { HarborGame } from './game';

const ui=document.querySelector<HTMLDivElement>('#ui')!;
ui.innerHTML='<div class="loading"><strong>FLOW HARBOR</strong><span>Preparing the waterfront…</span></div>';
const icons={route:'<path d="m3 10 18-7-7 18-3-7-8-4Z"/><path d="m11 14 5-6"/>',unload:'<path d="M5 20V6l7-3 5 8M5 7l12 4M17 11v5M14 20v-4h6v4Z"/><path d="M2 21h7M5 3v3"/>',upgrade:'<path d="m12 3 2 3 4 .5.5 4 3 2-3 2-.5 4-4 .5-2 3-2-3-4-.5-.5-4-3-2 3-2 .5-4 4-.5Z"/><circle cx="12" cy="12" r="3"/>',camera:'<path d="M4 8h4l2-3h4l2 3h4v12H4Z"/><circle cx="12" cy="14" r="4"/>',pause:'<path d="M8 5v14M16 5v14"/>',help:'<circle cx="12" cy="12" r="9"/><path d="M9 9a3 3 0 1 1 4 3c-1 .5-1 1-1 2M12 17v.1"/>',reset:'<path d="M4 10a8 8 0 1 1 1 8M4 4v6h6"/>'};
const svg=(key:keyof typeof icons)=>`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[key]}</svg>`;

async function start(){
  await new Promise<void>(resolve=>requestAnimationFrame(()=>resolve()));
  const world=buildWorld(document.querySelector<HTMLCanvasElement>('#harbor')!);
  const game=new HarborGame(world);
  ui.innerHTML=`
    <header class="top"><div class="brand"><h1>FLOW HARBOR</h1><p><i class="dot"></i> PRACTICE HARBOR · LOCAL DEMO</p></div><div class="stats"><div class="stat"><small>DELIVERED</small><strong id="delivered">0 / 8</strong></div><div class="stat"><small>HARBOR CREDITS</small><strong id="credits">180</strong></div><div class="stat"><small>SHIFT 01</small><strong id="clock">00:00</strong></div><button id="pause" class="round" aria-label="Pause game">${svg('pause')}</button></div></header>
    <div class="left-tools"><button id="camera" class="round" aria-label="Reset camera">${svg('camera')}</button><button id="help-button" class="round" aria-label="How to play">${svg('help')}</button><button id="reset" class="round" aria-label="Start a new shift">${svg('reset')}</button></div>
    <section class="yard" aria-label="Cargo yard"><div class="eyebrow">CARGO YARD</div><div class="yard-line"><span>Storage</span><strong id="storage">12 / 24</strong></div><div class="meter"><span id="meter" style="width:50%"></span></div><button id="dispatch">Dispatch 8 inland →</button></section>
    <div class="fleet" aria-label="Select vessel"><button class="vessel selected" data-vessel="0"><strong>MV Coral</strong><small><span id="state0">Docked · 01</span><span id="cargo0">4 cargo</span></small></button><button class="vessel" data-vessel="1"><strong>MV Mariner</strong><small><span id="state1">Awaiting berth</span><span id="cargo1">4 cargo</span></small></button></div>
    <div class="bottom"><div id="toast" class="toast" role="status"></div><div class="berths" id="berths"><button data-berth="0">01 · Occupied</button><button data-berth="1">02 · Open</button><button data-berth="2">03 · Open</button></div><nav class="toolbar" aria-label="Harbor actions"><button id="route">${svg('route')}<span>ROUTE</span></button><button id="unload" class="primary">${svg('unload')}<span>UNLOAD</span></button><button id="upgrade">${svg('upgrade')}<span>UPGRADE · 120</span></button></nav></div>
    <div class="camera-hint">Drag to orbit · Scroll to zoom<span>Right-drag to pan · H for help</span></div>
    <section id="help" class="help" hidden aria-label="How to play"><h2>A working waterfront.</h2><p>Unload eight containers safely to finish your practice shift.</p><ol><li>Select <b>MV Coral</b> and choose <b>UNLOAD</b>.</li><li>Select <b>MV Mariner</b>, then choose an open berth.</li><li>When it docks, select <b>UNLOAD</b>. Dispatch cargo inland if the yard fills up.</li></ol><p><b>Practice mode:</b> all cargo and credits are simulated. This build does not connect to Nansen, your wallet, or real trades.</p><button id="close-help">Back to harbor</button></section>`;
  const el=(id:string)=>document.getElementById(id)!;
  function render(){
    el('delivered').textContent=`${game.delivered} / 8`;el('credits').textContent=game.credits.toString();el('storage').textContent=`${game.storage} / ${game.capacity}`;el('meter').style.width=`${game.storage/game.capacity*100}%`;el('toast').textContent=game.toast;
    document.querySelectorAll<HTMLButtonElement>('[data-vessel]').forEach((b,i)=>{b.classList.toggle('selected',i===game.selected);b.setAttribute('aria-pressed',String(i===game.selected));const v=game.vessels[i];el('state'+i).textContent=v.state==='waiting'?'Awaiting berth':v.state.charAt(0).toUpperCase()+v.state.slice(1)+(v.berth===null?'':` · 0${v.berth+1}`);el('cargo'+i).textContent=v.cargo+' cargo';});
    document.querySelectorAll<HTMLButtonElement>('[data-berth]').forEach((b,i)=>{const occupied=game.vessels.some(v=>v.berth===i);b.textContent=`0${i+1} · ${occupied?'Occupied':'Open'}`;b.disabled=occupied||game.vessels[game.selected].state!=='waiting'||game.paused||game.completed;});
    (el('unload') as HTMLButtonElement).disabled=game.vessels[game.selected].state!=='docked'||game.paused||game.completed;
    (el('upgrade') as HTMLButtonElement).disabled=game.credits<120||game.paused||game.completed;
    (el('dispatch') as HTMLButtonElement).disabled=game.storage===0||game.paused||game.completed;
    (el('route') as HTMLButtonElement).disabled=game.vessels[game.selected].state!=='waiting'||game.paused||game.completed;
    el('pause').setAttribute('aria-label',game.paused?'Resume game':'Pause game');el('pause').setAttribute('aria-pressed',String(game.paused));el('pause').innerHTML=game.paused?'<span>▶</span>':svg('pause');
  }
  game.changed=render;render();
  document.querySelectorAll<HTMLButtonElement>('[data-vessel]').forEach(b=>b.onclick=()=>game.select(Number(b.dataset.vessel)));
  document.querySelectorAll<HTMLButtonElement>('[data-berth]').forEach(b=>b.onclick=()=>game.route(Number(b.dataset.berth)));
  el('unload').onclick=()=>game.unload();el('upgrade').onclick=()=>game.upgrade();el('dispatch').onclick=()=>game.dispatch();el('route').onclick=()=>game.notice('Choose berth 01, 02 or 03 above to set your route.');el('pause').onclick=()=>game.pause();el('reset').onclick=()=>game.reset();el('camera').onclick=()=>world.resetCamera();
  const showHelp=()=>{el('help').hidden=!el('help').hidden;};el('help-button').onclick=showHelp;el('close-help').onclick=showHelp;
  window.addEventListener('keydown',e=>{if(e.target instanceof HTMLButtonElement)return;if(e.key.toLowerCase()==='h')showHelp();if(e.code==='Space'){e.preventDefault();game.pause();}if(e.key==='Escape')el('help').hidden=true;});
  let visualTime=0;world.engine.runRenderLoop(()=>{const dt=Math.min(world.engine.getDeltaTime()/1000,.05);game.update(dt);if(!game.paused&&!game.completed)visualTime+=dt;world.update(visualTime,game.selected,game.paused);el('clock').textContent=`${Math.floor(game.time/60).toString().padStart(2,'0')}:${Math.floor(game.time%60).toString().padStart(2,'0')}`;world.scene.render();});
  window.addEventListener('resize',()=>world.engine.resize());
  // Read-only diagnostics for local visual inspection; no secrets or external wallet state.
  Object.assign(window,{harbor:{world,game}});
}
start().catch(error=>{console.error(error);ui.innerHTML='<div class="loading"><strong>Harbor unavailable</strong><span>The 3D renderer could not start. Reload in a browser with WebGL enabled.</span></div>';});
