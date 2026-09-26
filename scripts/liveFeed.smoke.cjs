/*
 * Smoke + unit test for www/liveFeed.js — run against the local backend:
 *   node scripts/liveFeed.smoke.cjs
 *
 * Verifies (1) the GTFS sequence→index math, (2) the direction derivation
 * logic, and (3) a real end-to-end poll against the running Fleet Management
 * stack in authoritative (token) mode.
 *
 * Unit checks (1 + 2) run WITHOUT a backend — only the live e2e (3) needs it.
 * Requires Node 18+ (global fetch) for the live section.
 *
 * Credentials come from environment variables (see .env.example).
 */
const MetroLiveFeed = require('../www/liveFeed.js');

const API      = process.env.API_BASE          || 'http://localhost:8086';
const GTFS     = process.env.GTFS_BASE         || 'http://localhost:8087';
const AGENCY   = process.env.AGENCY_ID         || '';
const VEHICLE  = process.env.VEHICLE_ID        || '';
const AGENCY_CODE  = process.env.TEST_AGENCY_CODE  || '';
const EMPLOYEE_ID  = process.env.TEST_EMPLOYEE_ID  || '';
const PIN          = process.env.TEST_PIN          || '';

let failures = 0;
function check(name, cond) {
  console.log((cond ? 'PASS' : 'FAIL') + ' — ' + name);
  if (!cond) failures++;
}

// ---- 1. unit: derivePosition ------------------------------------------------
const d = MetroLiveFeed._derivePosition;
check('STOPPED_AT seq3 → at index 2, next 3, not moving',
  JSON.stringify(d(3, 'STOPPED_AT', 7)) === JSON.stringify({ atIndex: 2, nextIndex: 3, moving: false }));
check('IN_TRANSIT_TO seq3 → at index 1, next 2, moving',
  JSON.stringify(d(3, 'IN_TRANSIT_TO', 7)) === JSON.stringify({ atIndex: 1, nextIndex: 2, moving: true }));
check('STOPPED_AT at terminus (seq7 of 7) → next null',
  d(7, 'STOPPED_AT', 7).nextIndex === null);
check('IN_TRANSIT_TO seq1 clamps atIndex to 0',
  d(1, 'IN_TRANSIT_TO', 7).atIndex === 0);

// ---- 2. unit: deriveDirection -----------------------------------------------
const dd = MetroLiveFeed._deriveDirection;
var cfgStops = [
  { en: 'Faiz Ahmed Faiz Station', ur: '' },
  { en: 'NHA Station', ur: '' },
  { en: 'Islamabad International Airport', ur: '' }
];
check('direction: first stop matches config[0] → fwd',
  dd([{ en: 'Faiz Ahmed Faiz Station' }], cfgStops) === 'fwd');
check('direction: first stop matches config[last] → rev',
  dd([{ en: 'Islamabad International Airport' }], cfgStops) === 'rev');
check('direction: case-insensitive match → fwd',
  dd([{ en: 'faiz ahmed faiz station' }], cfgStops) === 'fwd');
check('direction: unrecognised first stop defaults to fwd',
  dd([{ en: 'Unknown Station' }], cfgStops) === 'fwd');
check('direction: empty stops array defaults to fwd',
  dd([], cfgStops) === 'fwd');
check('direction: empty fallback defaults to fwd',
  dd([{ en: 'Faiz Ahmed Faiz Station' }], []) === 'fwd');

// ---- 3. end-to-end: real poll -----------------------------------------------
async function login() {
  if (!AGENCY_CODE || !EMPLOYEE_ID || !PIN) return null;
  var res = await fetch(API + '/api/v1/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agency_id: AGENCY_CODE, employee_id: EMPLOYEE_ID, pin: PIN })
  });
  if (!res.ok) throw new Error('login failed HTTP ' + res.status);
  return (await res.json()).access_token;
}

async function main() {
  if (!AGENCY || !VEHICLE || !AGENCY_CODE) {
    console.log('SKIP — live e2e test: set AGENCY_ID, VEHICLE_ID, TEST_AGENCY_CODE, TEST_EMPLOYEE_ID, TEST_PIN in env');
    return;
  }

  var token;
  try { token = await login(); } catch (e) { console.log('WARN — login failed, skipping live test:', e.message); return; }
  if (!token) { console.log('SKIP — credentials not set, skipping live test'); return; }
  check('login returned a token', !!token && token.length > 20);

  var snapshots = [];
  var feed = MetroLiveFeed.create({
    apiBaseUrl: API, gtfsBaseUrl: GTFS, agencyId: AGENCY, vehicleId: VEHICLE,
    token: token, fallbackStops: [], pollIntervalMs: 2500,
    onState: function (s) { snapshots.push(s); },
    onStatus: function (st) { console.log('   status:', st); }
  });

  feed.start();
  await new Promise(function (r) { setTimeout(r, 7000); }); // ~2-3 ticks
  feed.stop();

  check('received at least one live snapshot', snapshots.length > 0);
  if (snapshots.length) {
    var s = snapshots[snapshots.length - 1];
    console.log('   latest snapshot:', JSON.stringify({
      tripId: s.tripId, atIndex: s.atIndex, nextIndex: s.nextIndex,
      moving: s.moving, etaMinutes: s.etaMinutes, stops: s.stops.length,
      direction: s.direction,
      atStop: s.stops[s.atIndex] && s.stops[s.atIndex].en
    }, null, 0));
    check('snapshot has a non-empty ordered stop list', Array.isArray(s.stops) && s.stops.length > 1);
    check('snapshot includes direction', s.direction === 'fwd' || s.direction === 'rev');
    check('atIndex is within the stop list', s.atIndex >= 0 && s.atIndex < s.stops.length);
    check('every stop has an English name', s.stops.every(function (x) { return typeof x.en === 'string' && x.en.length > 0; }));
  }
}

main().then(function () {
  console.log(failures === 0 ? '\nALL CHECKS PASSED' : '\n' + failures + ' CHECK(S) FAILED');
  process.exit(failures === 0 ? 0 : 1);
}).catch(function (e) { console.error('ERROR', e); process.exit(1); });
