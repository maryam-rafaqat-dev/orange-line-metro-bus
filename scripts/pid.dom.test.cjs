/*
 * DOM-execution test for the live PID integration.
 *   node scripts/pid.dom.test.cjs
 *
 * Loads the real index.html + liveFeed.js + app.js in a jsdom window with a
 * real fetch, points CONFIG.backend at the running backend in authoritative
 * mode, and asserts the actual on-screen elements update with live data.
 * Requires the backend up and a FRESH position for the test vehicle (the
 * runner inserts one before invoking this).
 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const API = 'http://localhost:8086';
const GTFS = 'http://localhost:8087';
const AGENCY = '00000000-0000-0000-0000-000000000001';
const VEHICLE = '2f8f1b2c-7f93-4d6a-a7f4-9e41bd56a4c1';

let failures = 0;
const check = (name, cond, extra) => {
  console.log((cond ? 'PASS' : 'FAIL') + ' — ' + name + (extra ? '  (' + extra + ')' : ''));
  if (!cond) failures++;
};

async function login() {
  const res = await fetch(API + '/api/v1/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agency_id: 'CMTA', employee_id: 'ADM001', pin: '1234' })
  });
  return (await res.json()).access_token;
}

async function main() {
  const www = path.join(__dirname, '..', 'www');
  const token = await login();
  check('obtained backend token', !!token);

  // Build the test config: real config + backend enabled in authoritative mode.
  const cfg = JSON.parse(fs.readFileSync(path.join(www, 'config.json'), 'utf8'));
  cfg.backend = {
    enabled: true, apiBaseUrl: API, gtfsBaseUrl: GTFS, agencyId: AGENCY,
    vehicleId: VEHICLE, token: token, pollIntervalMs: 2500, fallbackAfterMs: 15000
  };

  // Load index.html but strip the external <script src> tags — we inject the
  // real files ourselves so they execute in-process against our fetch.
  let html = fs.readFileSync(path.join(www, 'index.html'), 'utf8')
    .replace(/<script src="liveFeed.js"><\/script>/, '')
    .replace(/<script src="app.js"><\/script>/, '');

  const dom = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true, url: 'http://localhost/' });
  const { window } = dom;
  window.fetch = fetch;                       // real fetch → real backend
  window.AbortController = AbortController;
  // Serve config via the same localStorage override the Settings page uses.
  window.localStorage.setItem('metroConfigOverride', JSON.stringify(cfg));

  const inject = (file) => {
    const s = window.document.createElement('script');
    s.textContent = fs.readFileSync(path.join(www, file), 'utf8');
    window.document.body.appendChild(s);
  };
  inject('liveFeed.js');
  inject('app.js');

  check('liveFeed adapter exposed on window', typeof window.MetroLiveFeed === 'object');

  // DOMContentLoaded already fired during construction, so kick boot() directly.
  await window.boot();

  // Wait for a couple of live polls.
  await new Promise((r) => setTimeout(r, 7000));

  const txt = (id) => (window.document.getElementById(id) || {}).textContent || '';
  const curEn = txt('cur-en');
  const nxtEn = txt('nxt-en');
  const badge = txt('live-badge');

  console.log('   cur-en=%j  nxt-en=%j  eta-n=%j  badge=%j', curEn, nxtEn, txt('eta-n'), badge);

  check('live badge shows LIVE', /LIVE/.test(badge), badge);
  check('current-stop name populated from backend', curEn.length > 0, curEn);
  check('next-stop name populated from backend', nxtEn.length > 0, nxtEn);

  // Cross-check the rendered name really is one of the backend trip's stops.
  const stRes = await fetch(API + '/api/v1/trips/f1000000-0000-0000-0000-000000000002/stop-times', {
    headers: { Authorization: 'Bearer ' + token }
  });
  const backendNames = (await stRes.json()).map((s) => s.stop_name);
  check('rendered current stop is a real backend stop', backendNames.includes(curEn),
    'backend stops: ' + backendNames.join(', '));

  window.close();
}

main().then(() => {
  console.log(failures === 0 ? '\nALL CHECKS PASSED' : '\n' + failures + ' CHECK(S) FAILED');
  process.exit(failures === 0 ? 0 : 1);
}).catch((e) => { console.error('ERROR', e); process.exit(1); });
