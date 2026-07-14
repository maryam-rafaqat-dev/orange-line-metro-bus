/*
 * Real-browser end-to-end test for the live PID (Playwright + Chromium).
 *   node scripts/pid.e2e.cjs
 *
 * Serves www/ and drives the actual page in a real rendering engine so that
 * things jsdom cannot check are verified: bus-overlay placement (needs real
 * layout), a non-null ETA, a moving bus across polls, and public (tokenless)
 * mode. Screenshots are written to the scratchpad dir passed as $SHOT_DIR.
 * Requires the backend stack running on :8086 / :8087.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { chromium } = require('playwright');

const WWW = path.join(__dirname, '..', 'www');
const PORT = 8799;
const API = 'http://localhost:8086';
const GTFS = 'http://localhost:8087';
const AGENCY = '00000000-0000-0000-0000-000000000001';
const VEHICLE = '2f8f1b2c-7f93-4d6a-a7f4-9e41bd56a4c1';
const TRIP = 'f1000000-0000-0000-0000-000000000002';
const SHOT_DIR = process.env.SHOT_DIR || '.';

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json',
  '.css': 'text/css', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg' };

let failures = 0;
const check = (name, cond, extra) => {
  console.log((cond ? 'PASS' : 'FAIL') + ' — ' + name + (extra != null ? '  (' + extra + ')' : ''));
  if (!cond) failures++;
};

function serve() {
  return http.createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split('?')[0]);
    const file = path.join(WWW, rel === '/' ? 'index.html' : rel);
    fs.readFile(file, (err, buf) => {
      if (err) { res.writeHead(404); res.end('nf'); return; }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      res.end(buf);
    });
  }).listen(PORT);
}

/** Replace the vehicle's latest position with a fresh one (now, given seq/status). */
function pushPosition(seq, status) {
  const sql =
    "insert into vehicle_positions (time, vehicle_id, trip_id, route_id, location, bearing, speed, " +
    "odometer, current_stop_sequence, current_status, congestion_level, occupancy_status, " +
    "occupancy_percentage, schedule_relationship, is_valid) select now(), vehicle_id, trip_id, " +
    "route_id, location, bearing, speed, odometer, " + seq + ", '" + status + "', congestion_level, " +
    "occupancy_status, occupancy_percentage, schedule_relationship, is_valid from vehicle_positions " +
    "where vehicle_id='" + VEHICLE + "' order by time desc limit 1;";
  execSync('docker exec fms-timescaledb psql -U user -d fleet_management -c "' + sql + '"', { stdio: 'ignore' });
}

async function login() {
  const res = await fetch(API + '/api/v1/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agency_id: 'CMTA', employee_id: 'ADM001', pin: '1234' })
  });
  return (await res.json()).access_token;
}

async function busPos(page) {
  return page.evaluate(() => {
    const b = document.getElementById('bus-overlay');
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { left: Math.round(r.left), top: Math.round(r.top), w: Math.round(r.width) };
  });
}
const txt = (page, id) => page.evaluate((i) => (document.getElementById(i) || {}).textContent || '', id);

async function loadWith(page, cfgOverride) {
  await page.addInitScript((cfg) => {
    localStorage.setItem('metroConfigOverride', JSON.stringify(cfg));
  }, cfgOverride);
  await page.goto('http://localhost:' + PORT + '/index.html', { waitUntil: 'load' });
}

async function main() {
  const server = serve();
  const token = await login();
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });

  const baseCfg = JSON.parse(fs.readFileSync(path.join(WWW, 'config.json'), 'utf8'));
  const liveCfg = Object.assign({}, baseCfg, {
    backend: { enabled: true, apiBaseUrl: API, gtfsBaseUrl: GTFS, agencyId: AGENCY,
      vehicleId: VEHICLE, token: token, pollIntervalMs: 2000, fallbackAfterMs: 15000 }
  });

  // ---- Test A: authoritative live mode, bus placement, non-null ETA --------
  // STOPPED_AT seq1 → next stop is seq2, which the predictor DOES include.
  // The positions feed updates instantly but the ETA feed regenerates every
  // ~10s, so wait until BOTH agree before loading the page — otherwise the
  // page can momentarily derive a next stop the ETA feed hasn't published yet.
  pushPosition(1, 'STOPPED_AT');
  process.stdout.write('   waiting for positions+ETA feeds to converge on seq1... ');
  for (let i = 0; i < 20; i++) {
    const feed = await (await fetch(GTFS + '/gtfs-rt/trip-updates')).json();
    const e = (feed.entity || []).find((x) => x.trip_update && x.trip_update.trip.trip_id === TRIP);
    const hasSeq2 = e && (e.trip_update.stop_time_update || []).some((u) => u.stop_sequence === 2);
    if (hasSeq2) { console.log('ready'); break; }
    await new Promise((r) => setTimeout(r, 2000));
  }
  const pageA = await ctx.newPage();
  await loadWith(pageA, liveCfg);
  await pageA.waitForFunction(() =>
    (document.getElementById('live-badge') || {}).textContent === '● LIVE', { timeout: 15000 });

  // The gtfs-rt ETA feed regenerates every ~10s; wait for the ring to show a
  // number rather than reading it on the first poll.
  await pageA.waitForFunction(() =>
    /^\d+$/.test(((document.getElementById('eta-n') || {}).textContent || '').trim()),
    { timeout: 25000 }).catch(() => {});

  const posA = await busPos(pageA);
  const etaA = await txt(pageA, 'eta-n');
  const curA = await txt(pageA, 'cur-en');
  await pageA.screenshot({ path: path.join(SHOT_DIR, 'pid-live-A.png') });
  console.log('A: cur=%j eta=%j bus=%j', curA, etaA, posA);

  check('A: live badge reached LIVE', true);
  check('A: bus overlay is placed at real (non-zero) coordinates',
    !!posA && (posA.left > 0 || posA.top > 0) && posA.w > 0, JSON.stringify(posA));
  check('A: current stop name populated from backend', curA.length > 0, curA);
  check('A: ETA ring shows a number (not "—")', /^\d+$/.test(etaA.trim()), etaA);

  // ---- Test B: bus moves when the vehicle advances -------------------------
  const beforeB = await busPos(pageA);
  pushPosition(3, 'STOPPED_AT');                     // jump ahead two stops
  await pageA.waitForTimeout(3500);                  // ~2 polls
  const afterB = await busPos(pageA);
  const curB = await txt(pageA, 'cur-en');
  await pageA.screenshot({ path: path.join(SHOT_DIR, 'pid-live-B.png') });
  console.log('B: curBefore->curAfter bus %j -> %j (cur now %j)', beforeB, afterB, curB);
  check('B: bus overlay moved after the vehicle advanced',
    !!beforeB && !!afterB && (beforeB.left !== afterB.left || beforeB.top !== afterB.top));

  // ---- Test C: public (tokenless) mode uses config.stops names ------------
  const publicCfg = Object.assign({}, baseCfg, {
    backend: { enabled: true, apiBaseUrl: API, gtfsBaseUrl: GTFS, agencyId: AGENCY,
      vehicleId: VEHICLE, token: '', pollIntervalMs: 2000, fallbackAfterMs: 15000 }
  });
  pushPosition(2, 'STOPPED_AT');
  const pageC = await ctx.newPage();
  await loadWith(pageC, publicCfg);
  await pageC.waitForFunction(() =>
    (document.getElementById('live-badge') || {}).textContent === '● LIVE', { timeout: 15000 });
  const curC = await txt(pageC, 'cur-en');
  await pageC.screenshot({ path: path.join(SHOT_DIR, 'pid-live-C-public.png') });
  const configNames = baseCfg.stops.map((s) => s.en);
  console.log('C: public-mode cur=%j', curC);
  check('C: public mode reaches LIVE and renders a config.stops name',
    curC.length > 0 && configNames.includes(curC), curC);

  await browser.close();
  server.close();
}

main().then(() => {
  console.log(failures === 0 ? '\nALL E2E CHECKS PASSED' : '\n' + failures + ' E2E CHECK(S) FAILED');
  process.exit(failures === 0 ? 0 : 1);
}).catch((e) => { console.error('ERROR', e); process.exit(1); });
