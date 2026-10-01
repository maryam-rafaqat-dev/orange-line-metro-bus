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

      // ═══ Full integration: simulator → tracker ═══
      var gpsStates = [];
      var tracker = T.create({
        stops, arriveRadiusM: 100, departRadiusM: 200, maxSpeedKmh: 800,
        onState: s => gpsStates.push(JSON.parse(JSON.stringify(s)))
      });
      var sim3 = T.createSimulator({
        stops, speedKmh: 600, dwellMs: 100, tickMs: 50,
        onFix: f => tracker.feed(f)
      });

      sim3.start();
      setTimeout(() => {
        sim3.stop();
        check('integration: tracker received states from simulator',
          gpsStates.length > 5, 'count=' + gpsStates.length);

        check('integration: saw moving state',
          gpsStates.some(s => s.moving));

        var uniqueStops = new Set(gpsStates.map(s => s.atIndex)).size;
        check('integration: visited multiple stops',
          uniqueStops > 1, 'unique=' + uniqueStops);

        check('integration: detected fwd direction',
          gpsStates.some(s => s.direction === 'fwd' && s.directionKnown));

        console.log('\n' + (failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'));
        process.exit(failures === 0 ? 0 : 1);
      }, 15000);
    }, 500);
  }, 2000);
}
