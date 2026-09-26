# PID ↔ Fleet Backend Integration

The Passenger Information Display (PID) can run in two ways:

- **Demo mode** (default): a self-contained simulation drives the bus along
  `config.stops` using a fixed timetable. No network. This is the original
  behaviour and is unchanged.
- **Live mode**: the display is driven by the vehicle's *real* position from
  the Fleet Management backend.

Live mode is switched on entirely through configuration — no code change.

## Enabling live mode

Set the `backend` block in `www/config.json` (or via the **Settings page**):

```json
"backend": {
  "enabled": true,
  "apiBaseUrl": "http://<host>:8086",
  "gtfsBaseUrl": "http://<host>:8087",
  "agencyId": "<agency-uuid>",
  "vehicleId": "<this-bus-uuid>",
  "token": "<optional-jwt>",
  "pollIntervalMs": 4000,
  "fallbackAfterMs": 20000
}
```

| Field | Meaning |
|-------|---------|
| `enabled` | `true` → live mode; `false` → demo simulation |
| `apiBaseUrl` | api-gateway origin (positions feed, stop-times) |
| `gtfsBaseUrl` | gtfs-rt-server origin (ETA / trip-updates) |
| `agencyId` | agency UUID that owns the vehicle |
| `vehicleId` | UUID of the bus this screen belongs to |
| `token` | optional JWT — see modes below |
| `pollIntervalMs` | how often to poll (kept gentle; the gateway rate-limits) |
| `fallbackAfterMs` | if no live data arrives within this window, fall back to demo |

### Settings page

The Settings page (`settings.html`) has a **Live Backend** section where all
the fields above can be configured, including a show/hide toggle for the
JWT token. It also includes `tripGap` in the Timing section. Changes saved
on the Settings page are written to localStorage and deep-merged over
`config.json` on the next page load — new config.json fields are never wiped
by an older override.

## How it works

```
vehicle-positions feed ──► current_stop_sequence + current_status + trip_id
        │                   + direction_id (when available)
        │
        ├─(token) trips/{id}/stop-times ──► authoritative stop names + direction
        └─(no token) config.stops        ──► names from local config
        │
gtfs-rt trip-updates ──► ETA to the next stop
        │
        ▼
liveFeed.js emits a normalized snapshot ──► app.js maps it onto the existing
renderWindow() / updateCards() / bus overlay. The GUI layer is untouched.
```

- **`www/liveFeed.js`** — DOM-free data adapter (network + normalization).
  Unit-testable under Node.
- **`www/app.js`** — `applyLiveState()` maps a snapshot onto the existing
  render globals; `startLiveMode()` / `boot()` choose live vs demo.
- **`www/configLoader.js`** — shared config loading with deep-merge, used by
  both `app.js` and `settings.html`.

### Modes

- **Authoritative (token set):** stop names and direction come from the trip's
  `stop-times`, so they are always correct for the active trip. If `direction_id`
  is not present on the vehicle entity, direction is derived by comparing the
  trip's first stop name against `config.stops[0]` / `config.stops[last]`.
- **Public (no token):** uses only public feeds; stop names come from
  `config.stops`. Requires `direction_id` on the vehicle entity so stops
  can be ordered correctly for forward and reverse trips. If direction cannot
  be determined, the feed emits `offline` status rather than guessing.

### Direction handling

The snapshot emitted by `liveFeed.js` includes a `direction` field (`'fwd'`
or `'rev'`). In `app.js`, `applyLiveState()` keeps `ALL_STOPS` in the
forward (config) order and sets `route` in travel order — exactly the same
convention the demo simulation uses, so numbering, banner and colour behave
identically.

### Resilience

- If the backend never becomes live within the grace window, the display
  falls back to demo mode but **keeps retrying** the live feed in the
  background. When a live snapshot arrives, the demo cycle is stopped and
  the display switches back to live mode automatically.
- A small status badge (bottom-left) shows `LIVE` / `STALE` / `OFFLINE`.
- Once real data has been shown, a later drop surfaces the status badge and
  freezes the last real state — the PID never silently animates a fake bus,
  which would mislead passengers.

### Live vs demo display differences

- **Time badges on the route track:** demo mode shows timetable times; live
  mode shows status markers (✓ done, ● current, → approaching, — upcoming).
- **Current/next stop cards:** demo mode shows timetable arrival times; live
  mode clears the current-stop time and shows `ETA HH:MM` on the next-stop
  card when the backend provides an ETA.
- **Bus overlay placement:** when the bus is moving in live mode, it is placed
  midway between the current and next station circles rather than at the next
  station.

## Known limitations / backend dependencies

- **ETA for the immediately-approached stop** can be `null` (shown as `—`):
  the backend `PredictArrivals` excludes the stop equal to the current stop
  sequence. Tracked separately on the backend.
- **Auth:** the positions and trip-updates feeds are public, but `stop-times`
  requires a JWT. A dedicated read-only *display* credential should be issued
  for production rather than reusing a driver/admin token.
- **CORS:** the backend must allow the PID's origin (local dev returns `*`).

## Android WebView and http:// backends

When the PID is packaged as an Android app via Capacitor, the WebView enforces
**mixed-content blocking**: a page served from a local `https://` or
`capacitor://` origin cannot make `fetch()` calls to an `http://` backend.
The requests will silently fail, and the display will fall back to demo mode.

**Two options:**

1. **HTTPS on the backend (recommended):** deploy the Fleet Management
   api-gateway and gtfs-rt-server behind a TLS reverse proxy (nginx, Caddy,
   etc.). Set `apiBaseUrl` / `gtfsBaseUrl` to the `https://` URLs. This is
   the safest and most reliable approach.

2. **Allow cleartext traffic in Android (development only):**
   - Add `android:usesCleartextTraffic="true"` to the `<application>` tag in
     `android/app/src/main/AndroidManifest.xml`.
   - Optionally set `server.cleartext: true` in `capacitor.config.json`
     (Capacitor 5+).
   - **Trade-off:** this disables Android's transport security for all
     network requests from the app, not just the backend. Do NOT ship this
     to production. It is acceptable for local development and testing only.

We deliberately do NOT change these files in the repository — the decision
is deployment-specific.

## Tests

All live tests require the backend stack running locally (see the
fleet-management-service docker compose) and environment variables set.

### Environment variables

Copy `.env.example` to `.env` and fill in real values. The test scripts
read from these variables (with empty-string defaults — tests skip
gracefully when credentials are not set):

| Variable | Used by | Purpose |
|----------|---------|---------|
| `API_BASE` | all | api-gateway origin |
| `GTFS_BASE` | all | gtfs-rt-server origin |
| `TEST_AGENCY_CODE` | all | login agency code (e.g. `CMTA`) |
| `TEST_EMPLOYEE_ID` | all | login employee ID |
| `TEST_PIN` | all | login PIN |
| `AGENCY_ID` | all | agency UUID |
| `VEHICLE_ID` | all | vehicle UUID |
| `TRIP_ID` | e2e, dom | trip UUID for cross-checks |
| `SHOT_DIR` | e2e | screenshot output directory |

### Running tests

```bash
# Unit tests only (derivePosition + deriveDirection) — NO backend needed:
node scripts/liveFeed.smoke.cjs

# With backend (requires .env):
npm run test:livefeed   # adapter unit + live smoke test (Node)
npm run test:pid-dom    # full DOM execution of the page in live mode (jsdom)
npm run test:e2e        # real-browser E2E: bus placement, moving bus, ETA,
                        # public mode (Playwright + Chromium)
```

The E2E test requires Chromium: `npx playwright install chromium`.

The E2E test proved a real-browser-only issue that Node clients cannot see:
the ETA feed must be CORS-enabled on the gtfs-rt-server (fixed backend-side).
