# PID ↔ Fleet Backend Integration

The Passenger Information Display (PID) can run in two ways:

- **Demo mode** (default): a self-contained simulation drives the bus along
  `config.stops` using a fixed timetable. No network. This is the original
  behaviour and is unchanged.
- **Live mode**: the display is driven by the vehicle's *real* position from
  the Fleet Management backend.

Live mode is switched on entirely through configuration — no code change.

## Enabling live mode

Set the `backend` block in `www/config.json` (or via the Settings page override):

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

## How it works

```
vehicle-positions feed ──► current_stop_sequence + current_status + trip_id
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

### Modes

- **Authoritative (token set):** stop names and direction come from the trip's
  `stop-times`, so they are always correct for the active trip.
- **Public (no token):** uses only public feeds; stop names come from
  `config.stops`. Requires `config.stops` to match the route's stop order.

### Resilience

- The simulation is a fallback **only** when the backend is unconfigured or
  never becomes live. Once real data has been shown, a later drop surfaces a
  status badge (`STALE` / `OFFLINE`) and freezes the last real state — the PID
  never silently animates a fake bus, which would mislead passengers.
- A small status badge (bottom-left) shows `LIVE` / `STALE` / `OFFLINE`.

## Known limitations / backend dependencies

- **ETA for the immediately-approached stop** can be `null` (shown as `—`):
  the backend `PredictArrivals` excludes the stop equal to the current stop
  sequence. Tracked separately on the backend.
- **Auth:** the positions and trip-updates feeds are public, but `stop-times`
  requires a JWT. A dedicated read-only *display* credential should be issued
  for production rather than reusing a driver/admin token.
- **CORS:** the backend must allow the PID's origin (local dev returns `*`).

## Tests

All require the backend stack running locally (see the fleet-management-service
docker compose). `test:e2e` additionally needs Chromium:
`npx playwright install chromium`.

```bash
npm run test:livefeed   # adapter unit + live smoke test (Node)
npm run test:pid-dom    # full DOM execution of the page in live mode (jsdom)
npm run test:e2e        # real-browser E2E: bus placement, moving bus, ETA,
                        # public mode (Playwright + Chromium)
```

The E2E test proved a real-browser-only issue that Node clients cannot see:
the ETA feed must be CORS-enabled on the gtfs-rt-server (fixed backend-side).
