/*
 * Smoke + unit test for www/liveFeed.js — run against the local backend:
 *   node scripts/liveFeed.smoke.cjs
 *
 * Verifies (1) the GTFS sequence→index math and (2) a real end-to-end poll
 * against the running Fleet Management stack in authoritative (token) mode.
 * Requires Node 18+ (global fetch) and the backend up on :8086 / :8087.
 */
const MetroLiveFeed = require('../www/liveFeed.js');

const API = process.env.API_BASE || 'http://localhost:8086';
const GTFS = process.env.GTFS_BASE || 'http://localhost:8087';
const AGENCY = process.env.AGENCY_ID || '00000000-0000-0000-0000-000000000001';
const VEHICLE = process.env.VEHICLE_ID || '2f8f1b2c-7f93-4d6a-a7f4-9e41bd56a4c1';

let failures = 0;
function check(name, cond) {
  console.log((cond ? 'PASS' : 'FAIL') + ' — ' + name);
  if (!cond) failures++;
}

// ---- 1. unit: derivePosition -------------------------------------------------
const d = MetroLiveFeed._derivePosition;
check('STOPPED_AT seq3 → at index 2, next 3, not moving',
  JSON.stringify(d(3, 'STOPPED_AT', 7)) === JSON.stringify({ atIndex: 2, nextIndex: 3, moving: false }));
check('IN_TRANSIT_TO seq3 → at index 1, next 2, moving',
  JSON.stringify(d(3, 'IN_TRANSIT_TO', 7)) === JSON.stringify({ atIndex: 1, nextIndex: 2, moving: true }));
check('STOPPED_AT at terminus (seq7 of 7) → next null',
  d(7, 'STOPPED_AT', 7).nextIndex === null);
check('IN_TRANSIT_TO seq1 clamps atIndex to 0',
  d(1, 'IN_TRANSIT_TO', 7).atIndex === 0);

// ---- 2. end-to-end: real poll -----------------------------------------------
async function login() {
  const res = await fetch(API + '/api/v1/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agency_id: 'CMTA', employee_id: 'ADM001', pin: '1234' })
  });
  if (!res.ok) throw new Error('login failed HTTP ' + res.status);
  return (await res.json()).access_token;
}

async function main() {
  let token;
  try { token = await login(); } catch (e) { console.log('WARN — login failed, skipping live test:', e.message); return; }
  check('login returned a token', !!token && token.length > 20);

  const snapshots = [];
  const feed = MetroLiveFeed.create({
    apiBaseUrl: API, gtfsBaseUrl: GTFS, agencyId: AGENCY, vehicleId: VEHICLE,
    token: token, fallbackStops: [], pollIntervalMs: 2500,
    onState: (s) => snapshots.push(s),
    onStatus: (st) => console.log('   status:', st)
  });

  feed.start();
  await new Promise((r) => setTimeout(r, 7000)); // ~2-3 ticks
  feed.stop();

  check('received at least one live snapshot', snapshots.length > 0);
  if (snapshots.length) {
    const s = snapshots[snapshots.length - 1];
    console.log('   latest snapshot:', JSON.stringify({
      tripId: s.tripId, atIndex: s.atIndex, nextIndex: s.nextIndex,
      moving: s.moving, etaMinutes: s.etaMinutes, stops: s.stops.length,
      atStop: s.stops[s.atIndex] && s.stops[s.atIndex].en
    }, null, 0));
    check('snapshot has a non-empty ordered stop list', Array.isArray(s.stops) && s.stops.length > 1);
    check('atIndex is within the stop list', s.atIndex >= 0 && s.atIndex < s.stops.length);
    check('every stop has an English name', s.stops.every((x) => typeof x.en === 'string' && x.en.length > 0));
  }
}

main().then(() => {
  console.log(failures === 0 ? '\nALL CHECKS PASSED' : '\n' + failures + ' CHECK(S) FAILED');
  process.exit(failures === 0 ? 0 : 1);
}).catch((e) => { console.error('ERROR', e); process.exit(1); });
