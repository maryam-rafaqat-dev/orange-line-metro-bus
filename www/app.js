

const LOCAL_STORAGE_KEY = 'metroConfigOverride';

/* Config ko load karta hai: pehle localStorage (Settings page se
   saved), agar wo na ho to config.json (default) */
async function loadConfig(){
  const saved = localStorage.getItem(LOCAL_STORAGE_KEY);
  if (saved) {
    try { return JSON.parse(saved); }
    catch(e){ console.warn('Saved config corrupt, falling back to config.json', e); }
  }
  const res = await fetch('config.json');
  return await res.json();
}

let CONFIG = null;   /* poori app ke liye globally available, loadConfig() ke baad set hota hai */

function fitToScreen(){
  const app = document.getElementById('app');
  if(!app) return;
  const DESIGN_W = 1920, DESIGN_H = 1080;
  const scale = Math.max(window.innerWidth / DESIGN_W, window.innerHeight / DESIGN_H);
  const left  = (window.innerWidth  - DESIGN_W * scale) / 2;
  const top   = (window.innerHeight - DESIGN_H * scale) / 2;
  app.style.transform = `translate(${left}px, ${top}px) scale(${scale})`;
}
window.addEventListener('resize', fitToScreen);
window.addEventListener('orientationchange', fitToScreen);
document.addEventListener('DOMContentLoaded', fitToScreen);
fitToScreen();

/* STATE (config load hone ke baad populate hote hain) */
let ALL_STOPS, WIN, N_STOPS;
let route, curIdx=0, dir='fwd', winStart=0, busState='at', pendingIdx=-1, tripCount=0;

/* ════════════════════════════════════════
   TIMETABLE
════════════════════════════════════════ */
function getTripDepMinutes() {
  const routeMin = (N_STOPS - 1) * CONFIG.timing.minPerStop;
  const cycleMin = routeMin + CONFIG.timing.tripGap;
  const fwdBase  = CONFIG.timing.fwdFirstDep.h * 60 + CONFIG.timing.fwdFirstDep.m;
  const revBase  = CONFIG.timing.revFirstDep.h * 60 + CONFIG.timing.revFirstDep.m;

  if (dir === 'fwd') {
    const n = Math.floor(tripCount / 2);
    return fwdBase + n * cycleMin * 2;
  } else {
    const n = Math.floor(tripCount / 2);
    return revBase + n * cycleMin * 2;
  }
}

function arrivalTime(stopIndex) {
  const dep = getTripDepMinutes();
  const tot = dep + stopIndex * CONFIG.timing.minPerStop;
  const h   = Math.floor(tot / 60) % 24;
  const m   = tot % 60;
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
}

/* TICKER */
function buildTicker() {
  const inn = document.getElementById('ticker-inner');
  inn.innerHTML = '';
  for (let r = 0; r < 3; r++) {
    CONFIG.ticker.forEach(t => {
      const d = document.createElement('div');
      d.className = 'ti' + (t.fare ? ' ti-fare' : '');
      d.innerHTML =
        `<span class="ti-ic">${t.ic}</span>` +
        `<span class="ti-ur urdu">${t.ur}${t.num?':':''}</span>` +
        (t.num?`<span class="ti-num${t.fare?' ti-num-fare':''}">${t.num}</span>`:'') +
        `<span class="ti-en">${t.en}</span><span class="ti-sep">◆</span>`;
      inn.appendChild(d);
    });
  }
}
function runTicker() {
  const inner = document.getElementById('ticker-inner');
  let x=0,last=null;
  (function step(ts){
    if(!last)last=ts;
    x -= CONFIG.timing.tickerSpeed*(ts-last)/1000;
    last=ts;
    if(Math.abs(x)>=inner.scrollWidth/2) x=0;
    inner.style.transform=`translateX(${x}px)`;
    requestAnimationFrame(step);
  })(0);
}

/* WINDOW */
function calcWin(){
  winStart=Math.max(0,Math.min(route.length-WIN,curIdx-2));
  return route.slice(winStart,winStart+WIN);
}

/* BUS OVERLAY */
let busEl=null;
function ensureBus(){
  if(!busEl){
    busEl=document.createElement('div');
    busEl.id='bus-overlay';
    busEl.innerHTML=`<img src="orange_line_metro_bus_v2.svg" alt="bus"
      style="width:100%;height:100%;display:block;
             filter:drop-shadow(0 3px 10px rgba(232,98,10,.85));">`;
    document.body.appendChild(busEl);
  }
  return busEl;
}
function circleCentre(gi){
  const el=document.querySelector(`.rn[data-gi="${gi}"] .rn-ripple-wrap,.rn[data-gi="${gi}"] .rn-circle`);
  if(!el)return null;
  const b=el.getBoundingClientRect();
  return{x:b.left+b.width/2,y:b.top+b.height/2};
}
function snapBus(x,y){
  const b=ensureBus();
  b.style.transition='none';
  b.style.left=x+'px'; b.style.top=y+'px';
}
function slideBus(x,y,ms){
  const b=ensureBus();
  b.getBoundingClientRect();
  b.style.transition=`left ${ms}ms cubic-bezier(0.3,0,0.2,1),top ${ms}ms cubic-bezier(0.3,0,0.2,1)`;
  b.style.left=x+'px'; b.style.top=y+'px';
}

/* ════════════════════════════════════════
   RENDER WINDOW
════════════════════════════════════════ */
function renderWindow(){
  const win=calcWin();
  const track=document.getElementById('rstops');
  track.innerHTML='';

  win.forEach((s,slot)=>{
    const gi=winStart+slot;

    const stopNum=dir==='fwd'
      ? String(gi+1).padStart(2,'0')
      : String(N_STOPS-gi).padStart(2,'0');

    const time=arrivalTime(gi);

    let cls;
    if(busState==='moving'){
      if     (gi<curIdx)             cls='rn done';
      else if(gi===curIdx)           cls='rn moving-from';
      else if(gi===pendingIdx)       cls='rn moving-to';
      else if(gi-pendingIdx===1)     cls='rn nxt1';
      else if(gi-pendingIdx<=3)      cls='rn nxt2';
      else if(gi===route.length-1)   cls='rn destination';
      else                           cls='rn upcoming';
    } else {
      const diff=gi-curIdx;
      if     (gi===curIdx)           cls='rn current';
      else if(gi<curIdx)             cls='rn done';
      else if(gi===route.length-1)   cls='rn destination';
      else if(diff===1)              cls='rn nxt1';
      else if(diff<=3)               cls='rn nxt2';
      else                           cls='rn upcoming';
    }

    let topBadge;
    if(gi<curIdx){
      topBadge=`<div class="rn-eta rn-eta-done">✓ ${time}</div>`;
    } else if(gi===curIdx && busState==='at'){
      topBadge=`<div class="rn-eta rn-eta-cur">${time}</div>`;
    } else if(gi===curIdx && busState==='moving'){
      topBadge=`<div class="rn-eta rn-eta-done">✓ ${time}</div>`;
    } else if(gi===pendingIdx && busState==='moving'){
      topBadge=`<div class="rn-eta rn-eta-moving">→ ${time}</div>`;
    } else {
      topBadge=`<div class="rn-eta rn-eta-ahead">${time}</div>`;
    }

    const inner=`<span class="rn-stop-num">${stopNum}</span>`;

    const showRipple=
      (busState==='at'     && gi-curIdx===1)||
      (busState==='moving' && gi-pendingIdx===1);

    const circleBlock=showRipple
      ?`<div class="rn-ripple-wrap">
          <span class="rn-ripple r1"></span>
          <span class="rn-ripple r2"></span>
          <span class="rn-ripple r3"></span>
          <div class="rn-circle">${inner}</div>
        </div>`
      :`<div class="rn-circle">${inner}</div>`;

    const node=document.createElement('div');
    node.className=cls;
    node.dataset.gi=gi;
    node.innerHTML=topBadge+circleBlock+
      `<div class="rn-en">${s.en}</div>`+
      `<div class="rn-ur urdu">${s.ur}</div>`;
    track.appendChild(node);
  });

  const banner=document.getElementById('dir-banner');
  if(banner){
    const ref=busState==='moving'?pendingIdx:curIdx;
    const from=dir==='fwd' ? ALL_STOPS[0].en : ALL_STOPS[ALL_STOPS.length-1].en;
    const to=dir==='fwd'   ? ALL_STOPS[ALL_STOPS.length-1].en : ALL_STOPS[0].en;
    banner.innerHTML=
      `<span class="banner-txt">${from} → ${to} &nbsp;(Stop ${ref+1} / ${route.length})</span>`;
    banner.style.color=dir==='fwd'?'var(--or3)':'var(--bl)';
  }
}

/* UPDATE CARDS */
function updateCards(idx){
  const cur=route[idx];
  const nxt=idx<route.length-1?route[idx+1]:null;
  document.getElementById('cur-en').textContent=cur.en;
  document.getElementById('cur-ur').textContent=cur.ur;
  document.getElementById('nxt-en').textContent=nxt?nxt.en:'—';
  document.getElementById('nxt-ur').textContent=nxt?nxt.ur:'';
  document.getElementById('dir-arrow').textContent='▶';
  document.getElementById('eta-n').textContent=nxt?CONFIG.timing.minPerStop:'—';
  const e1=document.getElementById('cur-time');
  const e2=document.getElementById('nxt-time');
  if(e1) e1.textContent=arrivalTime(idx);
  if(e2) e2.textContent=nxt?arrivalTime(idx+1):'';
}

/* MAIN CYCLE */
function runCycle(){
  busState='at';
  renderWindow();
  requestAnimationFrame(()=>{
    const pos=circleCentre(curIdx);
    if(pos)snapBus(pos.x,pos.y);
  });

  setTimeout(()=>{
    if(curIdx>=route.length-1){
      tripCount++;
      dir=dir==='fwd'?'rev':'fwd';
      route=dir==='rev'?[...ALL_STOPS].reverse():[...ALL_STOPS];
      curIdx=0;winStart=0;pendingIdx=-1;
      updateCards(0);runCycle();return;
    }
    pendingIdx=curIdx+1;
    busState='moving';
    updateCards(pendingIdx);
    renderWindow();
    const target=circleCentre(pendingIdx);
    if(!target){
      curIdx=pendingIdx;pendingIdx=-1;busState='at';
      updateCards(curIdx);runCycle();return;
    }
    slideBus(target.x,target.y,CONFIG.timing.slideToNext);
    setTimeout(()=>{
      curIdx=pendingIdx;pendingIdx=-1;busState='at';
      const fin=circleCentre(curIdx);
      if(fin)snapBus(fin.x,fin.y);
      renderWindow();updateCards(curIdx);runCycle();
    },CONFIG.timing.slideToNext+100);
  },CONFIG.timing.waitAtStation);
}

/* CLOCK */
function tickClock(){
  const now=new Date();
  const p=n=>String(n).padStart(2,'0');
  const D=['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const M=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  document.getElementById('clock').textContent=
    `${p(now.getHours())}:${p(now.getMinutes())}:${p(now.getSeconds())}`;
  document.getElementById('cdate').textContent=
    `${D[now.getDay()]}, ${now.getDate()} ${M[now.getMonth()]} ${now.getFullYear()}`;
}

/* HEADER TEXT (ab config se aata hai, HTML me hardcoded nahi) */
function applyHeaderText(){
  const titleEl = document.getElementById('hdr-title-text');
  if(titleEl) titleEl.textContent = CONFIG.header.titleEn;
  const fromEl = document.getElementById('hdr-route-from');
  if(fromEl) fromEl.textContent = CONFIG.header.routeFromUr;
  const toEl = document.getElementById('hdr-route-to');
  if(toEl) toEl.textContent = CONFIG.header.routeToUr;
}

/* CSS COLOR VARS */
function applyColors(){
  const s=document.documentElement.style, c=CONFIG.colors;
  s.setProperty('--or',   c.orange);
  s.setProperty('--or2',  c.orangeLight);
  s.setProperty('--or3',  c.orangeDark);
  s.setProperty('--red',  c.red);
  s.setProperty('--gr',   c.green);
  s.setProperty('--gr2',  c.greenLight);
  s.setProperty('--bl',   c.blue);
  s.setProperty('--dest', c.dest);
  s.setProperty('--line-s', c.lineOrangeStart);
  s.setProperty('--line-e', c.lineOrangeEnd);
}

/* ════════════════════════════════════════
   LIVE MODE — real backend data via liveFeed.js
   ────────────────────────────────────────
   When CONFIG.backend.enabled is true, the display is driven by the vehicle's
   real position instead of the local simulation (runCycle). liveFeed.js does
   the networking and hands us a normalized snapshot; the functions below map
   that snapshot onto the SAME render layer the simulation uses (renderWindow /
   updateCards / the bus overlay), so nothing in the GUI changes.

   Resilience rule: the simulation is a fallback ONLY when the backend is
   unconfigured or never becomes live. Once we have shown real data, a later
   drop surfaces a status badge and freezes the last real state — we never
   silently animate a fake bus, which would mislead passengers.
════════════════════════════════════════ */
let liveEverLive = false;   /* have we ever rendered a real snapshot? */
let liveBusPlaced = false;  /* first bus placement snaps; later ones slide */
let liveGraceTimer = null;

function ensureLiveBadge(){
  let el = document.getElementById('live-badge');
  if(!el){
    el = document.createElement('div');
    el.id = 'live-badge';
    el.style.cssText =
      'position:fixed;left:14px;bottom:14px;z-index:9999;padding:4px 10px;'+
      'border-radius:12px;font:600 12px/1 Arial,sans-serif;color:#fff;'+
      'letter-spacing:.5px;opacity:.85;transition:background .3s;';
    document.body.appendChild(el);
  }
  return el;
}

function setLiveStatus(status){
  const el = ensureLiveBadge();
  const map = {
    connecting: ['CONNECTING', '#6B7280'],
    live:       ['● LIVE',      '#16A34A'],
    stale:      ['STALE',       '#B54800'],
    offline:    ['OFFLINE',     '#CC1000']
  };
  const [txt, bg] = map[status] || map.offline;
  el.textContent = txt;
  el.style.background = bg;
}

/* Map one normalized snapshot onto the existing render globals + layer. */
function applyLiveState(state){
  if(liveGraceTimer){ clearTimeout(liveGraceTimer); liveGraceTimer = null; }
  liveEverLive = true;

  ALL_STOPS = state.stops.map(s => ({ en: s.en, ur: s.ur || '' }));
  N_STOPS   = ALL_STOPS.length;
  route     = ALL_STOPS;

  if(state.moving && state.nextIndex != null){
    curIdx    = state.atIndex;
    pendingIdx = state.nextIndex;
    busState  = 'moving';
  } else {
    curIdx    = state.atIndex;
    pendingIdx = -1;
    busState  = 'at';
  }

  renderWindow();
  /* Cards mirror the simulation's convention: while moving, the approached
     stop is shown as "current". */
  updateCards(busState === 'moving' ? pendingIdx : curIdx);

  /* Live ETA overrides the simulation's fixed minPerStop; '—' when unknown. */
  const etaEl = document.getElementById('eta-n');
  if(etaEl) etaEl.textContent = (state.etaMinutes == null ? '—' : state.etaMinutes);

  placeLiveBus();
}

/* Position the bus overlay on the active circle after the DOM has painted. */
function placeLiveBus(){
  requestAnimationFrame(() => {
    const idx = (busState === 'moving' && pendingIdx >= 0) ? pendingIdx : curIdx;
    const c = circleCentre(idx);
    if(!c) return;
    if(liveBusPlaced){ slideBus(c.x, c.y, 700); }
    else { snapBus(c.x, c.y); liveBusPlaced = true; }
  });
}

function startLiveMode(){
  const b = CONFIG.backend;
  ensureBus();
  setLiveStatus('connecting');

  const feed = MetroLiveFeed.create({
    apiBaseUrl:     b.apiBaseUrl,
    gtfsBaseUrl:    b.gtfsBaseUrl,
    agencyId:       b.agencyId,
    vehicleId:      b.vehicleId,
    token:          b.token || null,
    fallbackStops:  CONFIG.stops,
    pollIntervalMs: b.pollIntervalMs || 4000,
    onState:        applyLiveState,
    onStatus:       setLiveStatus
  });
  feed.start();

  /* If the backend never delivers a live snapshot within the grace window
     (misconfiguration, network down, wrong vehicleId), fall back to the demo
     simulation so a freshly-deployed screen is never blank. */
  const grace = b.fallbackAfterMs || 20000;
  liveGraceTimer = setTimeout(() => {
    if(!liveEverLive){
      feed.stop();
      setLiveStatus('offline');
      ensureBus(); runCycle();
    }
  }, grace);
}

/* ════════════════════════════════════════
   BOOT — config load hone ke baad hi app start hoti hai
════════════════════════════════════════ */
async function boot(){
  CONFIG = await loadConfig();

  ALL_STOPS = CONFIG.stops;
  WIN       = 7;
  N_STOPS   = ALL_STOPS.length;
  route     = [...ALL_STOPS];

  applyColors();
  applyHeaderText();
  buildTicker();
  runTicker();
  updateCards(curIdx);
  tickClock();
  setInterval(tickClock,1000);

  /* Live backend when configured and the adapter is present; otherwise the
     original local simulation (demo mode). */
  if(CONFIG.backend && CONFIG.backend.enabled && window.MetroLiveFeed){
    setTimeout(startLiveMode, 400);
  } else {
    setTimeout(()=>{ensureBus();runCycle();},400);
  }
}

document.addEventListener('DOMContentLoaded', boot);
