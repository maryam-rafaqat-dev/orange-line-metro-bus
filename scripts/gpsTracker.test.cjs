/*
 * Unit tests for gpsTracker.js — run with:  node scripts/gpsTracker.test.cjs
 * No backend, no browser, no GPS required.
 */
const T = require('../www/gpsTracker.js');

let failures = 0;
const check = (name, cond, extra) => {
  console.log((cond ? 'PASS' : 'FAIL') + ' — ' + name + (extra != null ? '  (' + extra + ')' : ''));
  if (!cond) failures++;
};

const stops = T.TEST_COORDS.map((c, i) => ({ en: 'S' + i, ur: '', lat: c.lat, lng: c.lng }));

// Helper: interpolate between two stops at fraction t (0..1)
function lerp(sA, sB, t){
  return { lat: sA.lat + (sB.lat - sA.lat) * t, lng: sA.lng + (sB.lng - sA.lng) * t };
}

// ═══ Haversine ═══
const d1 = T._haversineM(33.71, 73.058, 33.698, 73.044);
check('haversine: ~1.8km between test stops 0 and 1', d1 > 1700 && d1 < 2000, d1.toFixed(0) + 'm');

check('haversine: same point = 0', T._haversineM(33.71, 73.058, 33.71, 73.058) === 0);

// ═══ Nearest stop ═══
const n0 = T._nearestStop(33.7100, 73.0580, stops);
check('nearestStop: exact match → index 0', n0.index === 0 && n0.distance < 1);

check('nearestStop: exact match → index 3',
  T._nearestStop(stops[3].lat, stops[3].lng, stops).index === 3);

// ═══ Project on segment ═══
check('project: at start → ~0',
  T._projectOnSegment(stops[0].lat, stops[0].lng, stops[0], stops[1]) < 0.05);

check('project: at end → ~1',
  T._projectOnSegment(stops[1].lat, stops[1].lng, stops[0], stops[1]) > 0.95);

var pm = T._projectOnSegment(
  (stops[0].lat + stops[1].lat) / 2, (stops[0].lng + stops[1].lng) / 2,
  stops[0], stops[1]);
check('project: midpoint → ~0.5', pm > 0.3 && pm < 0.7, pm.toFixed(3));

// ═══ Arrival detection ═══
{
  const states = [];
  const tr = T.create({
    stops, arriveRadiusM: 100, departRadiusM: 200, maxSpeedKmh: 200,
    onState: s => states.push(JSON.parse(JSON.stringify(s)))
  });
  tr.feed({ lat: stops[0].lat, lng: stops[0].lng, timestamp: 0 });
  check('arrival: first fix at stop 0 → at, not moving',
    states.length === 1 && !states[0].moving && states[0].atIndex === 0);
}

// ═══ Departure hysteresis ═══
{
  const states = [];
  const tr = T.create({
    stops, arriveRadiusM: 100, departRadiusM: 250, maxSpeedKmh: 200,
    onState: s => states.push(JSON.parse(JSON.stringify(s)))
  });

  tr.feed({ lat: stops[0].lat, lng: stops[0].lng, timestamp: 0 });
  check('hysteresis: at stop 0', !states[0].moving);

  // ~145m away (past arriveR=100 but inside departR=250) — 30s later
  var p1 = lerp(stops[0], stops[1], 0.08);
  tr.feed({ lat: p1.lat, lng: p1.lng, timestamp: 30000 });
  check('hysteresis: 145m away → still "at" (inside departR)',
    tr.getInternals().status === 'at');

  // ~370m away (past departR=250) — 60s later
  var p2 = lerp(stops[0], stops[1], 0.20);
  tr.feed({ lat: p2.lat, lng: p2.lng, timestamp: 90000 });
  var st = tr.getInternals().status;
  check('hysteresis: 370m away → departed',
    st === 'departed' || st === 'moving', 'status=' + st);
}

// ═══ Direction: forward ═══
{
  const states = [];
  const tr = T.create({
    stops, arriveRadiusM: 100, departRadiusM: 200, maxSpeedKmh: 200,
    onState: s => states.push(JSON.parse(JSON.stringify(s)))
  });

  tr.feed({ lat: stops[0].lat, lng: stops[0].lng, timestamp: 0 });
  check('direction: after one stop → unknown', !states[0].directionKnown);

  // Depart stop 0 (30s later, ~370m away toward stop 1)
  var dp = lerp(stops[0], stops[1], 0.20);
  tr.feed({ lat: dp.lat, lng: dp.lng, timestamp: 30000 });

  // Midway (60s later)
  var mp = lerp(stops[0], stops[1], 0.50);
  tr.feed({ lat: mp.lat, lng: mp.lng, timestamp: 60000 });

  // Arrive at stop 1 (90s later)
  tr.feed({ lat: stops[1].lat, lng: stops[1].lng, timestamp: 90000 });
  var last = states[states.length - 1];
  check('direction: stop 0 → stop 1 = fwd',
    last.direction === 'fwd' && last.directionKnown, 'dir=' + last.direction);
}

// ═══ Direction: reverse ═══
{
  const states = [];
  const tr = T.create({
    stops, arriveRadiusM: 100, departRadiusM: 200, maxSpeedKmh: 200,
    onState: s => states.push(JSON.parse(JSON.stringify(s)))
  });

  tr.feed({ lat: stops[3].lat, lng: stops[3].lng, timestamp: 0 });
  var dp = lerp(stops[3], stops[2], 0.20);
  tr.feed({ lat: dp.lat, lng: dp.lng, timestamp: 30000 });
  var mp = lerp(stops[3], stops[2], 0.50);
  tr.feed({ lat: mp.lat, lng: mp.lng, timestamp: 60000 });
  tr.feed({ lat: stops[2].lat, lng: stops[2].lng, timestamp: 90000 });
  var last = states[states.length - 1];
  check('direction: stop 3 → stop 2 = rev',
    last.direction === 'rev', 'dir=' + last.direction);
}

// ═══ Terminus flip ═══
{
  const states = [];
  const tr = T.create({
    stops, arriveRadiusM: 100, departRadiusM: 200, maxSpeedKmh: 200,
    onState: s => states.push(JSON.parse(JSON.stringify(s)))
  });

  // Establish fwd direction: stop 5 → stop 6
  tr.feed({ lat: stops[5].lat, lng: stops[5].lng, timestamp: 0 });
  var dp1 = lerp(stops[5], stops[6], 0.15);
  tr.feed({ lat: dp1.lat, lng: dp1.lng, timestamp: 30000 });
  var mp1 = lerp(stops[5], stops[6], 0.50);
  tr.feed({ lat: mp1.lat, lng: mp1.lng, timestamp: 120000 });
  tr.feed({ lat: stops[6].lat, lng: stops[6].lng, timestamp: 240000 });

  var atTerminus = states[states.length - 1];
  check('terminus: arrived at last stop (fwd)',
    atTerminus.direction === 'fwd' && atTerminus.atIndex === 6,
    'atIndex=' + atTerminus.atIndex + ' dir=' + atTerminus.direction);

  // Depart terminus — 60s later, 300m back toward stop 5
  var dp2 = lerp(stops[6], stops[5], 0.04);
  tr.feed({ lat: dp2.lat, lng: dp2.lng, timestamp: 300000 });
  check('terminus: departed last stop → direction flipped to rev',
    tr.getInternals().direction === 'rev', 'dir=' + tr.getInternals().direction);
}

// ═══ Jump filter ═══
{
  const states = [];
  const tr = T.create({
    stops, arriveRadiusM: 100, departRadiusM: 200, maxSpeedKmh: 120,
    onState: s => states.push(JSON.parse(JSON.stringify(s)))
  });

  tr.feed({ lat: stops[0].lat, lng: stops[0].lng, timestamp: 0 });
  var before = states.length;
  // Jump 50km in 2 seconds → 90000 km/h → must be ignored
  tr.feed({ lat: stops[0].lat + 0.5, lng: stops[0].lng, timestamp: 2000 });
  check('jump filter: 50km in 2s ignored', states.length === before);
}

// ═══ Progress along segment ═══
{
  const states = [];
  const tr = T.create({
    stops, arriveRadiusM: 50, departRadiusM: 100, maxSpeedKmh: 200,
    onState: s => states.push(JSON.parse(JSON.stringify(s)))
  });

  tr.feed({ lat: stops[0].lat, lng: stops[0].lng, timestamp: 0 });

  // Depart (past 100m departR)
  var dp = lerp(stops[0], stops[1], 0.10);
  tr.feed({ lat: dp.lat, lng: dp.lng, timestamp: 30000 });

  // Midway
  var mp = lerp(stops[0], stops[1], 0.50);
  tr.feed({ lat: mp.lat, lng: mp.lng, timestamp: 60000 });
  var midState = states[states.length - 1];
  check('progress: midway between stops → ~0.5',
    midState.moving && midState.progress > 0.3 && midState.progress < 0.7,
    'moving=' + midState.moving + ' progress=' + (midState.progress != null ? midState.progress.toFixed(3) : 'undef'));
}

// ═══ Start between stations (seeking state) ═══
{
  const states = [];
  const tr = T.create({
    stops, arriveRadiusM: 50, departRadiusM: 100, maxSpeedKmh: 200,
    onState: s => states.push(JSON.parse(JSON.stringify(s)))
  });

  // 70% between stop 2 and stop 3 — nearest is stop 3, ~558m away
  var p70 = lerp(stops[2], stops[3], 0.70);
  tr.feed({ lat: p70.lat, lng: p70.lng, timestamp: 0 });
  check('between: first fix between stops → seeking',
    tr.getInternals().status === 'seeking');

  // 80% — still approaching stop 3, ~372m away
  var p80 = lerp(stops[2], stops[3], 0.80);
  tr.feed({ lat: p80.lat, lng: p80.lng, timestamp: 30000 });
  check('between: approaching → still seeking',
    tr.getInternals().status === 'seeking');

  // Arrive at stop 3 (exact position)
  tr.feed({ lat: stops[3].lat, lng: stops[3].lng, timestamp: 60000 });
  check('between: arrival at stop 3 detected',
    tr.getInternals().status === 'at' && tr.getInternals().lastStopFwd === 3);

  // Depart stop 3, travel to stop 4
  var dp = lerp(stops[3], stops[4], 0.10);
  tr.feed({ lat: dp.lat, lng: dp.lng, timestamp: 90000 });
  var mp = lerp(stops[3], stops[4], 0.50);
  tr.feed({ lat: mp.lat, lng: mp.lng, timestamp: 120000 });
  tr.feed({ lat: stops[4].lat, lng: stops[4].lng, timestamp: 150000 });
  var last = states[states.length - 1];
  check('between: stop 3 → stop 4 = fwd',
    last.atIndex === 4 && last.direction === 'fwd' && last.directionKnown);
}

// ═══ resolveStops ═══
{
  var nullStops2 = stops.map(function(s){ return { en: s.en, ur: s.ur, lat: null, lng: null }; });
  var resolved = T.resolveStops(nullStops2);
  check('resolveStops: fills null coords from TEST_COORDS',
    resolved[0].lat === T.TEST_COORDS[0].lat && resolved[0].lng === T.TEST_COORDS[0].lng);
  check('resolveStops: keeps en name',
    resolved[0].en === 'S0');
  var partialNull = stops.map(function(s, i){
    return i === 2 ? { en: s.en, ur: s.ur, lat: null, lng: null } : s;
  });
  var resolved2 = T.resolveStops(partialNull);
  check('resolveStops: only fills null, keeps real coords',
    resolved2[0].lat === stops[0].lat && resolved2[2].lat === T.TEST_COORDS[2].lat);
}

// ═══ Full route integration (sync, 30 km/h, fake timestamps) ═══
{
  function genRoute(coords, speedKmh, dwellMs, tickMs, t0){
    var fixes = [], t = t0 || 0;
    for(var i = 0; i < coords.length; i++){
      var dTicks = Math.max(1, Math.ceil(dwellMs / tickMs));
      for(var d = 0; d < dTicks; d++){
        fixes.push({ lat: coords[i].lat, lng: coords[i].lng, timestamp: t, accuracy: 5 });
        t += tickMs;
      }
      if(i < coords.length - 1){
        var dist = T._haversineM(coords[i].lat, coords[i].lng, coords[i+1].lat, coords[i+1].lng);
        var steps = Math.max(1, Math.round((dist / (speedKmh / 3.6)) / (tickMs / 1000)));
        for(var s = 1; s <= steps; s++){
          var f = s / steps;
          fixes.push({
            lat: coords[i].lat + (coords[i+1].lat - coords[i].lat) * f,
            lng: coords[i].lng + (coords[i+1].lng - coords[i].lng) * f,
            timestamp: t, accuracy: 5
          });
          t += tickMs;
        }
      }
    }
    return { fixes: fixes, endTime: t };
  }

  var allStates = [];
  var tr = T.create({
    stops, arriveRadiusM: 100, departRadiusM: 200, maxSpeedKmh: 200,
    onState: function(s){ allStates.push(JSON.parse(JSON.stringify(s))); }
  });

  var coords = stops.map(function(s){ return { lat: s.lat, lng: s.lng }; });
  var revCoords = coords.slice().reverse();

  var fwd = genRoute(coords, 30, 10000, 5000, 0);
  var rev = genRoute(revCoords, 30, 10000, 5000, fwd.endTime);
  var allFixes = fwd.fixes.concat(rev.fixes);
  allFixes.forEach(function(fix){ tr.feed(fix); });

  var fwdVisits = new Set();
  var revVisits = new Set();
  var sawFwd = false, sawRev = false, sawTerminus = false;

  allStates.forEach(function(s){
    if(s.direction === 'fwd' && s.directionKnown){ sawFwd = true; fwdVisits.add(s.atIndex); }
    if(s.direction === 'rev' && s.directionKnown){ sawRev = true; revVisits.add(s.atIndex); }
  });

  for(var i = 0; i < allStates.length - 1; i++){
    if(allStates[i].atIndex === 6 && !allStates[i].moving && allStates[i].direction === 'fwd'){
      for(var j = i + 1; j < allStates.length; j++){
        if(allStates[j].direction === 'rev' && allStates[j].directionKnown){
          sawTerminus = true; break;
        }
      }
      if(sawTerminus) break;
    }
  }

  check('full-route: forward → visited stops (>=6 with known dir)',
    fwdVisits.size >= 6, 'fwd stops=' + fwdVisits.size);
  check('full-route: detected fwd direction', sawFwd);
  check('full-route: terminus flip fwd → rev', sawTerminus);
  check('full-route: reverse → visited stops (>=6)',
    revVisits.size >= 6, 'rev stops=' + revVisits.size);
  check('full-route: detected rev direction', sawRev);
}

// ═══ Simulator ═══
{
  const fixes = [];
  const sim = T.createSimulator({
    stops, speedKmh: 30, dwellMs: 100, tickMs: 50,
    onFix: f => fixes.push({ lat: f.lat, lng: f.lng })
  });

  sim.start();
  setTimeout(() => {
    sim.stop();
    check('simulator: produced fixes', fixes.length > 10, 'count=' + fixes.length);
    check('simulator: starts at stop 0',
      Math.abs(fixes[0].lat - T.TEST_COORDS[0].lat) < 0.001);

    var first = fixes[0], last = fixes[fixes.length - 1];
    check('simulator: position changes over time',
      Math.abs(first.lat - last.lat) > 0.0001 || Math.abs(first.lng - last.lng) > 0.0001);

    // ═══ Simulator with null coordinates ═══
    var nullStops = stops.map(s => ({ en: s.en, ur: '', lat: null, lng: null }));
    var fixes2 = [];
    var sim2 = T.createSimulator({
      stops: nullStops, speedKmh: 30, dwellMs: 100, tickMs: 50,
      onFix: f => fixes2.push(f)
    });
    sim2.start();
    setTimeout(() => {
      sim2.stop();
      check('simulator null coords: uses TEST_COORDS fallback',
        fixes2.length > 0 && Math.abs(fixes2[0].lat - T.TEST_COORDS[0].lat) < 0.001);

      console.log('\n' + (failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'));
      process.exit(failures === 0 ? 0 : 1);
    }, 500);
  }, 2000);
}
