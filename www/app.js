/* loadConfig and CONFIG_STORAGE_KEY are provided by configLoader.js */

let CONFIG = null;

/* Responsive: pick how many stations fit in the route track */
function calcAdaptiveWin(){
  var track = document.getElementById('rtrack');
  if(!track || track.clientWidth === 0) return Math.min(7, N_STOPS || 7);
  var win = Math.floor(track.clientWidth / 140);
  /* Clamp 3–N_STOPS, prefer odd so current station centres */
  win = Math.max(3, Math.min(N_STOPS || 7, win));
  if(win > 3 && win % 2 === 0) win--;
  return win;
}

/* Responsive: debounced resize handler — updates WIN & re-snaps bus */
var _resizeTimer = null;
function handleResize(){
  if(!CONFIG) return;
  clearTimeout(_resizeTimer);
  _resizeTimer = setTimeout(function(){
    var newWin = calcAdaptiveWin();
    if(newWin !== WIN){
      WIN = newWin;
      renderWindow();
    }
    /* Double-rAF waits for layout reflow before reading circle positions */
    requestAnimationFrame(function(){
      requestAnimationFrame(function(){
        /* ISSUE 5: midway bus on resize when live-moving */
        if(isLiveMode && busState === 'moving' && pendingIdx >= 0){
          var from = circleCentre(curIdx);
          var to = circleCentre(pendingIdx);
          if(from && to){
            snapBus((from.x + to.x) / 2, (from.y + to.y) / 2);
            return;
          }
        }
        var gi = busState === 'moving' ? pendingIdx : curIdx;
        var pos = circleCentre(gi);
        if(pos) snapBus(pos.x, pos.y);
      });
    });
  }, 150);
}
window.addEventListener('resize', handleResize);
window.addEventListener('orientationchange', function(){ setTimeout(handleResize, 200); });

/* STATE */
let ALL_STOPS, WIN, N_STOPS;
let route, curIdx=0, dir='fwd', winStart=0, busState='at', pendingIdx=-1, tripCount=0;
var isLiveMode = false;
var _demoTimers = [];
var demoFallbackActive = false;

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
/* Responsive: centre current stop for any WIN value */
function calcWin(){
  winStart=Math.max(0,Math.min(route.length-WIN,curIdx-Math.floor(WIN/2)));
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

    /* ISSUE 2: live mode shows status markers, demo shows timetable times */
    let topBadge;
    if(isLiveMode){
      if(gi<curIdx){
        topBadge='<div class="rn-eta rn-eta-done">✓</div>';
      } else if(gi===curIdx && busState==='at'){
        topBadge='<div class="rn-eta rn-eta-cur">●</div>';
      } else if(gi===curIdx && busState==='moving'){
        topBadge='<div class="rn-eta rn-eta-done">✓</div>';
      } else if(gi===pendingIdx && busState==='moving'){
        topBadge='<div class="rn-eta rn-eta-moving">→</div>';
      } else {
        topBadge='<div class="rn-eta rn-eta-ahead">—</div>';
      }
    } else {
      const time=arrivalTime(gi);
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

  /* ISSUE 2: only set demo timetable times when not in live mode */
  if(!isLiveMode){
    document.getElementById('eta-n').textContent=nxt?CONFIG.timing.minPerStop:'—';
    const e1=document.getElementById('cur-time');
    const e2=document.getElementById('nxt-time');
    if(e1) e1.textContent=arrivalTime(idx);
    if(e2) e2.textContent=nxt?arrivalTime(idx+1):'';
  }
}

/* MAIN CYCLE — ISSUE 6: track timers so demo can be stopped cleanly */
function runCycle(){
  busState='at';
  renderWindow();
  requestAnimationFrame(()=>{
    const pos=circleCentre(curIdx);
    if(pos)snapBus(pos.x,pos.y);
  });

  var t1=setTimeout(()=>{
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
    var t2=setTimeout(()=>{
      curIdx=pendingIdx;pendingIdx=-1;busState='at';
      const fin=circleCentre(curIdx);
      if(fin)snapBus(fin.x,fin.y);
      renderWindow();updateCards(curIdx);runCycle();
    },CONFIG.timing.slideToNext+100);
    _demoTimers.push(t2);
  },CONFIG.timing.waitAtStation);
  _demoTimers.push(t1);
}

function stopDemoCycle(){
  _demoTimers.forEach(clearTimeout);
  _demoTimers = [];
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

/* HEADER TEXT */
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

   Resilience: if the backend never becomes live, fall back to demo but keep
   retrying. Once a real snapshot arrives, stop the demo cycle and switch back
   to live. A later drop surfaces a status badge and freezes the last state.
════════════════════════════════════════ */
let liveEverLive = false;
let liveBusPlaced = false;
let liveGraceTimer = null;
var _liveFeed = null;

function ensureLiveBadge(){
  let el = document.getElementById('live-badge');
  if(!el){
    el = document.createElement('div');
    el.id = 'live-badge';
    el.style.cssText =
      'position:absolute;right:10px;top:2px;z-index:9999;padding:4px 10px;'+
      'border-radius:12px;font:600 12px/1 Arial,sans-serif;color:#fff;'+
      'letter-spacing:.5px;opacity:.85;transition:background .3s;';
    var sec = document.getElementById('prog-sec');
    if(sec) sec.appendChild(el);
    else document.body.appendChild(el);
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

  /* ISSUE 6: switching back from demo fallback to live */
  if(demoFallbackActive){
    stopDemoCycle();
    demoFallbackActive = false;
  }
  isLiveMode = true;

  /* Build lists from the snapshot — the backend may have a different stop
     list than config.json (different count, names, or direction). */
  dir = state.direction || 'fwd';
  route = state.stops.map(function(s){ return { en: s.en, ur: s.ur || '' }; });
  /* ALL_STOPS = forward order (for banner from/to text) */
  ALL_STOPS = dir === 'rev' ? [...route].reverse() : [...route];

  /* Recalculate WIN if stop count changed */
  var prevN = N_STOPS;
  N_STOPS = route.length;
  if(N_STOPS !== prevN) WIN = calcAdaptiveWin();

  if(state.moving && state.nextIndex != null){
    curIdx    = state.atIndex;
    pendingIdx = state.nextIndex;
    busState  = 'moving';
  } else {
    curIdx    = state.atIndex;
    pendingIdx = -1;
    busState  = 'at';
  }

  try {
    renderWindow();
    updateCards(busState === 'moving' ? pendingIdx : curIdx);
  } catch(err){
    console.error('applyLiveState render failed:', err);
    return;
  }

  /* Mark success only after rendering completes without error */
  liveEverLive = true;
  document.getElementById('app').classList.add('live-active');

  /* ISSUE 2: live ETA overrides demo timetable */
  var etaEl = document.getElementById('eta-n');
  if(etaEl) etaEl.textContent = (state.etaMinutes == null ? '—' : state.etaMinutes);
  var e2 = document.getElementById('nxt-time');
  if(e2){
    if(state.etaMinutes != null){
      var arr = new Date(Date.now() + state.etaMinutes * 60000);
      e2.textContent = 'ETA ' + String(arr.getHours()).padStart(2,'0') + ':' + String(arr.getMinutes()).padStart(2,'0');
    } else { e2.textContent = ''; }
  }

  placeLiveBus();
}

/* ISSUE 5: place bus midway between stations when moving */
function placeLiveBus(){
  requestAnimationFrame(() => {
    if(busState === 'moving' && pendingIdx >= 0){
      var from = circleCentre(curIdx);
      var to = circleCentre(pendingIdx);
      if(from && to){
        var mx = (from.x + to.x) / 2;
        var my = (from.y + to.y) / 2;
        if(liveBusPlaced){ slideBus(mx, my, 700); }
        else { snapBus(mx, my); liveBusPlaced = true; }
        return;
      }
    }
    var idx = curIdx;
    var c = circleCentre(idx);
    if(!c) return;
    if(liveBusPlaced){ slideBus(c.x, c.y, 700); }
    else { snapBus(c.x, c.y); liveBusPlaced = true; }
  });
}

function startLiveMode(){
  const b = CONFIG.backend;
  ensureBus();
  setLiveStatus('connecting');

  _liveFeed = MetroLiveFeed.create({
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
  _liveFeed.start();

  /* ISSUE 6: fall back to demo but keep retrying — the feed is NOT stopped,
     so when the backend recovers, applyLiveState stops the demo cycle. */
  const grace = b.fallbackAfterMs || 20000;
  liveGraceTimer = setTimeout(() => {
    if(!liveEverLive){
      setLiveStatus('offline');
      demoFallbackActive = true;
      isLiveMode = false;
      document.getElementById('app').classList.remove('live-active');
      ensureBus(); runCycle();
    }
  }, grace);
}

/* ════════════════════════════════════════
   BOOT
════════════════════════════════════════ */
async function boot(){
  CONFIG = await loadConfig();

  ALL_STOPS = CONFIG.stops;
  N_STOPS   = ALL_STOPS.length;
  route     = [...ALL_STOPS];
  /* Responsive: adapt visible station count to available width */
  WIN       = calcAdaptiveWin();

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
