/*
 * liveFeed.js — Real-time data adapter for the Orange Line Metro PID.
 *
 * Responsibility (single): turn the Fleet Management backend's real-time
 * feeds into ONE normalized snapshot describing where *this* vehicle is, and
 * hand that snapshot to a callback. It performs NO DOM work — app.js owns all
 * rendering. Keeping this module DOM-free makes it unit-testable under Node
 * (see scripts/liveFeed.smoke.mjs) and keeps the render layer untouched.
 *
 * Data sources (verified against the running backend):
 *   1. GET {apiBaseUrl}/api/v1/gtfs-rt/vehicle-positions?agency_id=…  (PUBLIC)
 *        → live current_stop_sequence + current_status + trip_id per vehicle.
 *   2. GET {apiBaseUrl}/api/v1/trips/{tripId}/stop-times  (REQUIRES token)
 *        → authoritative ordered stops (names + direction). Used only when a
 *          token is configured; otherwise we fall back to config.stops.
 *   3. GET {gtfsBaseUrl}/gtfs-rt/trip-updates  (PUBLIC)
 *        → per-stop predicted arrival times (ETA).
 *
 * Modes:
 *   • Authoritative (token set): stop list comes from stop-times, so the route
 *     order and direction are always correct for the active trip.
 *   • Public (no token): stop names come from the caller-supplied fallbackStops
 *     (the PID's own config.stops), mapped by stop_sequence order.
 *
 * The adapter is defensive: per-request timeouts, no overlapping polls,
 * exponential backoff on failure, explicit 429 (rate-limit) handling, and a
 * staleness guard so a frozen backend surfaces as "stale" rather than a lie.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;          // Node (tests)
  } else {
    root.MetroLiveFeed = api;       // Browser
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var DEFAULTS = {
    pollIntervalMs: 4000,   // gentle — the api-gateway rate-limits aggressive polling
    requestTimeoutMs: 6000,
    staleAfterMs: 60000,    // position older than this ⇒ treat vehicle as not live
    maxBackoffMs: 60000
  };

  // ---- small helpers -------------------------------------------------------

  function RateLimitError(retryAfterMs) {
    this.name = 'RateLimitError';
    this.retryAfterMs = retryAfterMs;
    this.message = 'rate limited';
  }
  RateLimitError.prototype = Object.create(Error.prototype);

  /**
   * fetch JSON with an abortable timeout. Throws RateLimitError on 429 and a
   * plain Error on any other non-2xx or network/parse failure.
   */
  function fetchJson(url, opts) {
    opts = opts || {};
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, opts.timeoutMs || DEFAULTS.requestTimeoutMs);
    var headers = {};
    if (opts.token) headers['Authorization'] = 'Bearer ' + opts.token;

    return fetch(url, { headers: headers, signal: controller.signal })
      .then(function (res) {
        if (res.status === 429) {
          var ra = parseInt(res.headers.get('Retry-After') || '', 10);
          throw new RateLimitError(isNaN(ra) ? null : ra * 1000);
        }
        if (!res.ok) throw new Error('HTTP ' + res.status + ' for ' + url);
        return res.json();
      })
      .finally(function () { clearTimeout(timer); });
  }

  // ---- normalization -------------------------------------------------------

  /**
   * Translate a GTFS current_stop_sequence (1-based) + current_status into the
   * PID's model of "which stop are we at / heading to".
   *
   * GTFS semantics:
   *   STOPPED_AT   seq=S → stopped at stop S.
   *   IN_TRANSIT_TO / INCOMING_AT seq=S → between S-1 and S, heading to S.
   *
   * Returns 0-based indices. atIndex is the stop the bus is at or last left;
   * nextIndex is where it is heading (null at the terminus).
   */
  function derivePosition(stopSequence, status, stopCount) {
    var moving = status !== 'STOPPED_AT';
    var atIndex, nextIndex;
    if (!moving) {
      atIndex = stopSequence - 1;
      nextIndex = atIndex + 1 < stopCount ? atIndex + 1 : null;
    } else {
      // heading to stopSequence ⇒ last-left is stopSequence-1 (1-based)
      atIndex = stopSequence - 2;
      nextIndex = stopSequence - 1;
    }
    if (atIndex < 0) atIndex = 0;                 // clamp: heading to first stop
    if (nextIndex !== null && nextIndex >= stopCount) nextIndex = null;
    return { atIndex: atIndex, nextIndex: nextIndex, moving: moving };
  }

  // ---- the adapter ---------------------------------------------------------

  /**
   * create(options) → { start(), stop() }
   *
   * options:
   *   apiBaseUrl     string  api-gateway origin, e.g. "http://host:8086"
   *   gtfsBaseUrl    string  gtfs-rt-server origin, e.g. "http://host:8087"
   *   agencyId       string  agency UUID
   *   vehicleId      string  the UUID of the bus this screen belongs to
   *   token          string? optional JWT; enables authoritative stop-times
   *   fallbackStops  array   [{en, ur}] used for names when no token (and for
   *                          Urdu labels, which the backend does not carry)
   *   pollIntervalMs number?
   *   onState(snapshot)   called with a normalized snapshot on every good poll
   *   onStatus(status)    'connecting' | 'live' | 'stale' | 'offline'
   */
  function create(options) {
    var cfg = Object.assign({}, DEFAULTS, options);
    var running = false;
    var timer = null;
    var backoffMs = cfg.pollIntervalMs;
    var lastStatus = null;

    // Cache the authoritative stop list per trip so we don't refetch it every
    // tick (stop lists are static for the life of a trip).
    var tripStopsCache = { tripId: null, stops: null };

    // Urdu lookup built from the caller's config stops (backend has no Urdu).
    var urduByEn = {};
    (cfg.fallbackStops || []).forEach(function (s) {
      if (s && s.en) urduByEn[normalizeName(s.en)] = s.ur || '';
    });

    function normalizeName(s) { return String(s || '').trim().toLowerCase(); }
    function urduFor(en) { return urduByEn[normalizeName(en)] || ''; }

    function emitStatus(status) {
      if (status !== lastStatus) {
        lastStatus = status;
        if (cfg.onStatus) { try { cfg.onStatus(status); } catch (e) { /* callback owns its errors */ } }
      }
    }

    function positionsUrl() {
      return cfg.apiBaseUrl + '/api/v1/gtfs-rt/vehicle-positions?agency_id=' + encodeURIComponent(cfg.agencyId);
    }
    function stopTimesUrl(tripId) {
      return cfg.apiBaseUrl + '/api/v1/trips/' + encodeURIComponent(tripId) + '/stop-times';
    }
    function tripUpdatesUrl() {
      return cfg.gtfsBaseUrl + '/gtfs-rt/trip-updates';
    }

    /** Resolve the ordered stop list for a trip (authoritative or fallback). */
    function resolveStops(tripId) {
      if (tripStopsCache.tripId === tripId && tripStopsCache.stops) {
        return Promise.resolve(tripStopsCache.stops);
      }
      // Public mode: no token ⇒ use the PID's own configured stop list.
      if (!cfg.token) {
        var fromConfig = (cfg.fallbackStops || []).map(function (s, i) {
          return { en: s.en, ur: s.ur || '', seq: i + 1 };
        });
        tripStopsCache = { tripId: tripId, stops: fromConfig };
        return Promise.resolve(fromConfig);
      }
      // Authoritative mode: stop-times gives real names + direction for THIS trip.
      return fetchJson(stopTimesUrl(tripId), { token: cfg.token, timeoutMs: cfg.requestTimeoutMs })
        .then(function (rows) {
          var stops = (rows || []).map(function (st) {
            return { en: st.stop_name, ur: urduFor(st.stop_name), seq: st.stop_sequence };
          });
          tripStopsCache = { tripId: tripId, stops: stops };
          return stops;
        });
    }

    /** ETA in whole minutes to the stop at 1-based `targetSeq`, or null. */
    function fetchEtaMinutes(tripId, targetSeq) {
      if (targetSeq == null) return Promise.resolve(null);
      return fetchJson(tripUpdatesUrl(), { timeoutMs: cfg.requestTimeoutMs })
        .then(function (feed) {
          var entities = (feed && feed.entity) || [];
          for (var i = 0; i < entities.length; i++) {
            var tu = entities[i].trip_update;
            if (!tu || !tu.trip || tu.trip.trip_id !== tripId) continue;
            var updates = tu.stop_time_update || [];
            for (var j = 0; j < updates.length; j++) {
              if (updates[j].stop_sequence === targetSeq && updates[j].arrival && updates[j].arrival.time) {
                var secs = updates[j].arrival.time - Math.floor(Date.now() / 1000);
                return secs > 0 ? Math.round(secs / 60) : 0;
              }
            }
          }
          return null;
        })
        .catch(function () { return null; }); // ETA is best-effort; never fail the tick over it
    }

    /** One poll cycle: positions → stops → eta → onState. */
    function tick() {
      if (!running) return;
      emitStatus(lastStatus || 'connecting');

      fetchJson(positionsUrl(), { timeoutMs: cfg.requestTimeoutMs })
        .then(function (feed) {
          var entities = (feed && feed.entity) || [];
          var pos = null;
          for (var i = 0; i < entities.length; i++) {
            if (entities[i].vehicle_id === cfg.vehicleId) { pos = entities[i]; break; }
          }
          if (!pos) { emitStatus('offline'); return null; }               // vehicle not in service
          if (isStale(pos.time)) { emitStatus('stale'); return null; }
          if (!pos.trip_id || pos.current_stop_sequence == null) {
            emitStatus('offline'); return null;                            // deadhead / no trip
          }

          return resolveStops(pos.trip_id).then(function (stops) {
            if (!stops || !stops.length) { emitStatus('offline'); return null; }
            var place = derivePosition(pos.current_stop_sequence, pos.current_status, stops.length);
            var targetSeq = place.nextIndex != null ? stops[place.nextIndex].seq : null;

            return fetchEtaMinutes(pos.trip_id, targetSeq).then(function (etaMin) {
              emitStatus('live');
              if (cfg.onState) {
                cfg.onState({
                  vehicleId: cfg.vehicleId,
                  tripId: pos.trip_id,
                  stops: stops,
                  atIndex: place.atIndex,
                  nextIndex: place.nextIndex,
                  moving: place.moving,
                  etaMinutes: etaMin,
                  updatedAt: pos.time
                });
              }
            });
          });
        })
        .then(function () { backoffMs = cfg.pollIntervalMs; schedule(cfg.pollIntervalMs); })
        .catch(function (err) {
          if (err && err.name === 'RateLimitError') {
            var wait = err.retryAfterMs || Math.min(backoffMs * 2, cfg.maxBackoffMs);
            emitStatus('offline');
            schedule(wait);
          } else {
            emitStatus('offline');
            backoffMs = Math.min(backoffMs * 2, cfg.maxBackoffMs);
            schedule(backoffMs);
          }
        });
    }

    function isStale(iso) {
      var t = Date.parse(iso);
      if (isNaN(t)) return false; // if we can't parse it, don't punish the row
      return (Date.now() - t) > cfg.staleAfterMs;
    }

    function schedule(delay) {
      if (!running) return;
      timer = setTimeout(tick, delay);
    }

    return {
      start: function () {
        if (running) return;
        running = true;
        emitStatus('connecting');
        tick();
      },
      stop: function () {
        running = false;
        if (timer) { clearTimeout(timer); timer = null; }
      }
    };
  }

  return { create: create, _derivePosition: derivePosition };
});
