/* GPS Tracker — DOM-free module (works in Node and browser).
   Processes GPS fixes → detects current stop, next stop, direction,
   segment progress. Includes a GPS simulator for browser testing.

   Usage (browser):  GpsTracker.create({ stops, arriveRadiusM, ... })
   Usage (Node):     const GpsTracker = require('./gpsTracker.js');  */
(function(root, factory){
  if(typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.GpsTracker = factory();
})(typeof self !== 'undefined' ? self : this, function(){
  'use strict';

  var DEG2RAD = Math.PI / 180;
  var R_EARTH = 6371000;

  /* Approximate test coordinates along the Orange Line corridor (Islamabad).
     FOR SIMULATOR TESTING ONLY — not real station positions. */
  var TEST_COORDS = [
    { lat: 33.7100, lng: 73.0580 },
    { lat: 33.6980, lng: 73.0440 },
    { lat: 33.6870, lng: 73.0290 },
    { lat: 33.6750, lng: 73.0150 },
    { lat: 33.6630, lng: 73.0020 },
    { lat: 33.6500, lng: 72.9880 },
    { lat: 33.6160, lng: 72.8980 }
  ];

  function haversineM(lat1, lng1, lat2, lng2){
    var dLat = (lat2 - lat1) * DEG2RAD;
    var dLng = (lng2 - lng1) * DEG2RAD;
    var a = Math.sin(dLat/2) * Math.sin(dLat/2) +
            Math.cos(lat1 * DEG2RAD) * Math.cos(lat2 * DEG2RAD) *
            Math.sin(dLng/2) * Math.sin(dLng/2);
    return R_EARTH * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  function nearestStop(lat, lng, stops){
    var best = -1, bestD = Infinity;
    for(var i = 0; i < stops.length; i++){
      if(stops[i].lat == null || stops[i].lng == null) continue;
      var d = haversineM(lat, lng, stops[i].lat, stops[i].lng);
      if(d < bestD){ bestD = d; best = i; }
    }
    return { index: best, distance: bestD };
  }

  /* Project point onto line segment A→B, return fraction 0..1 */
  function projectOnSegment(lat, lng, sA, sB){
    var dLat = sB.lat - sA.lat;
    var dLng = sB.lng - sA.lng;
    var lenSq = dLat * dLat + dLng * dLng;
    if(lenSq === 0) return 0;
    var t = ((lat - sA.lat) * dLat + (lng - sA.lng) * dLng) / lenSq;
    return Math.max(0, Math.min(1, t));
  }

  /* ═══ TRACKER ═══ */
  function create(opts){
    var stops      = opts.stops;
    var arriveR    = opts.arriveRadiusM || 50;
    var departR    = opts.departRadiusM || 80;
    var maxSpeedMs = (opts.maxSpeedKmh || 120) / 3.6;
    var onState    = opts.onState;

    var status       = 'unknown';
    var lastStopFwd  = -1;
    var direction    = 'unknown';
    var visitHistory = [];
    var prevFix      = null;

    function deriveDir(){
      if(visitHistory.length < 2) return direction;
      var a = visitHistory[visitHistory.length - 2];
      var b = visitHistory[visitHistory.length - 1];
      return b > a ? 'fwd' : 'rev';
    }

    function buildState(progress){
      var d = (direction === 'unknown') ? 'fwd' : direction;
      var routeStops = d === 'rev' ? stops.slice().reverse() : stops.slice();
      var rIdx = d === 'rev' ? stops.length - 1 - lastStopFwd : lastStopFwd;
      var isMoving = status === 'moving' || status === 'departed';
      var nextR = (rIdx < routeStops.length - 1) ? rIdx + 1 : null;
      return {
        direction: d,
        directionKnown: direction !== 'unknown',
        atIndex: rIdx,
        nextIndex: nextR,
        moving: isMoving,
        progress: progress || 0,
        stops: routeStops.map(function(s){ return { en: s.en, ur: s.ur || '' }; })
      };
    }

    function emit(progress){
      if(onState) onState(buildState(progress));
    }

    function feed(fix){
      if(prevFix && fix.timestamp != null && prevFix.timestamp != null){
        var dt = (fix.timestamp - prevFix.timestamp) / 1000;
        if(dt > 0.5){
          var d = haversineM(prevFix.lat, prevFix.lng, fix.lat, fix.lng);
          if((d / dt) > maxSpeedMs) return;
        }
      }
      prevFix = { lat: fix.lat, lng: fix.lng, timestamp: fix.timestamp };

      var n = nearestStop(fix.lat, fix.lng, stops);
      if(n.index < 0) return;

      if(status === 'unknown'){
        lastStopFwd = n.index;
        visitHistory = [lastStopFwd];
        status = n.distance <= arriveR ? 'at' : 'moving';
        emit(0);
        return;
      }

      if(status === 'at'){
        var dCur = haversineM(fix.lat, fix.lng,
          stops[lastStopFwd].lat, stops[lastStopFwd].lng);
        if(dCur > departR){
          status = 'departed';
          if(direction === 'fwd' && lastStopFwd === stops.length - 1){
            direction = 'rev'; visitHistory = [lastStopFwd];
          } else if(direction === 'rev' && lastStopFwd === 0){
            direction = 'fwd'; visitHistory = [lastStopFwd];
          }
        }
        emit(0);
        return;
      }

      if(n.distance <= arriveR && n.index !== lastStopFwd){
        status = 'at';
        lastStopFwd = n.index;
        visitHistory.push(lastStopFwd);
        direction = deriveDir();
        emit(0);
        return;
      }

      status = 'moving';
      var nextFwd;
      if(direction === 'fwd'){
        nextFwd = Math.min(lastStopFwd + 1, stops.length - 1);
      } else if(direction === 'rev'){
        nextFwd = Math.max(lastStopFwd - 1, 0);
      } else {
        var dP = lastStopFwd > 0 && stops[lastStopFwd - 1].lat != null
          ? haversineM(fix.lat, fix.lng, stops[lastStopFwd - 1].lat, stops[lastStopFwd - 1].lng)
          : Infinity;
        var dN = lastStopFwd < stops.length - 1 && stops[lastStopFwd + 1].lat != null
          ? haversineM(fix.lat, fix.lng, stops[lastStopFwd + 1].lat, stops[lastStopFwd + 1].lng)
          : Infinity;
        nextFwd = dP < dN ? lastStopFwd - 1 : lastStopFwd + 1;
      }

      var sA = stops[lastStopFwd];
      var sB = stops[nextFwd];
      var prog = (sA.lat != null && sB.lat != null)
        ? projectOnSegment(fix.lat, fix.lng, sA, sB) : 0;
      emit(prog);
    }

    function reset(){
      status = 'unknown'; lastStopFwd = -1; direction = 'unknown';
      visitHistory = []; prevFix = null;
    }

    return {
      feed: feed,
      reset: reset,
      getInternals: function(){
        return { status: status, lastStopFwd: lastStopFwd,
                 direction: direction, visitHistory: visitHistory.slice() };
      }
    };
  }

  /* ═══ GPS SIMULATOR ═══
     Generates fake GPS fixes moving along the route at a given speed.
     Uses TEST_COORDS for any stop with null lat/lng. */
  function resolveCoords(stops){
    return stops.map(function(s, i){
      if(s.lat != null && s.lng != null) return { lat: s.lat, lng: s.lng };
      if(i < TEST_COORDS.length) return { lat: TEST_COORDS[i].lat, lng: TEST_COORDS[i].lng };
      var base = TEST_COORDS[TEST_COORDS.length - 1];
      return { lat: base.lat - 0.01 * (i - TEST_COORDS.length + 1),
               lng: base.lng - 0.01 * (i - TEST_COORDS.length + 1) };
    });
  }

  function createSimulator(opts){
    var coords   = resolveCoords(opts.stops);
    var speedKmh = opts.speedKmh || 30;
    var dwellMs  = opts.dwellMs  || 3000;
    var onFix    = opts.onFix;
    var tickMs   = opts.tickMs   || 1000;

    var curStop    = 0;
    var simDir     = 1;
    var progress   = 0;
    var dwelling   = true;
    var dwellLeft  = dwellMs;
    var timer      = null;

    function nextIdx(){ return curStop + simDir; }

    function segDist(){
      var ni = nextIdx();
      if(ni < 0 || ni >= coords.length) return 0;
      return haversineM(coords[curStop].lat, coords[curStop].lng,
                        coords[ni].lat,      coords[ni].lng);
    }

    function emitPos(){
      var lat, lng, ni = nextIdx();
      if(dwelling || ni < 0 || ni >= coords.length){
        lat = coords[curStop].lat; lng = coords[curStop].lng;
      } else {
        lat = coords[curStop].lat + (coords[ni].lat - coords[curStop].lat) * progress;
        lng = coords[curStop].lng + (coords[ni].lng - coords[curStop].lng) * progress;
      }
      if(onFix) onFix({
        lat: lat, lng: lng, accuracy: 5,
        speed: dwelling ? 0 : (speedKmh / 3.6),
        timestamp: Date.now()
      });
    }

    function tick(){
      if(dwelling){
        dwellLeft -= tickMs;
        if(dwellLeft > 0){ emitPos(); return; }
        dwelling = false;
        progress = 0;
        if(curStop >= coords.length - 1) simDir = -1;
        else if(curStop <= 0) simDir = 1;
      }

      var dist = segDist();
      if(dist === 0){ emitPos(); return; }
      progress += (speedKmh / 3.6) * (tickMs / 1000) / dist;

      if(progress >= 1){
        curStop = nextIdx();
        progress = 0;
        dwelling = true;
        dwellLeft = dwellMs;
      }

      emitPos();
    }

    function start(){
      if(timer) return;
      emitPos();
      timer = setInterval(tick, tickMs);
    }

    function stop(){
      if(timer){ clearInterval(timer); timer = null; }
    }

    return { start: start, stop: stop };
  }

  return {
    create:           create,
    createSimulator:  createSimulator,
    TEST_COORDS:      TEST_COORDS,
    _haversineM:      haversineM,
    _nearestStop:     nearestStop,
    _projectOnSegment: projectOnSegment
  };
});
