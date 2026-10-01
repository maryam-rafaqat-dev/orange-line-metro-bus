/* GPS provider — wraps Capacitor Geolocation (Android) with
   navigator.geolocation fallback (browser / Live Server testing).
   Exposes window.GeoProvider with startWatch / stopWatch / requestPermission. */
(function(root){
  'use strict';

  var _watchId = null;
  var _lastFix = null;
  var _lastFixTime = 0;
  var _statusCb = null;
  var _statusTimer = null;
  var NO_FIX_MS = 30000;

  function capGeo(){
    try { return root.Capacitor && root.Capacitor.Plugins && root.Capacitor.Plugins.Geolocation; }
    catch(e){ return null; }
  }

  function setStatus(accuracy){
    _lastFixTime = Date.now();
    if(!_statusCb) return;
    _statusCb(accuracy <= 30 ? 'ok' : 'weak');
  }

  function checkNoFix(){
    if(_statusCb && Date.now() - _lastFixTime > NO_FIX_MS) _statusCb('nofix');
  }

  function requestPermission(){
    var geo = capGeo();
    if(geo){
      return geo.requestPermissions().then(function(r){
        return r.location === 'granted' || r.coarseLocation === 'granted';
      }).catch(function(){ return false; });
    }
    return Promise.resolve(true);
  }

  function startWatch(onPosition, onStatus, minAccuracyM){
    _statusCb = onStatus;
    _lastFixTime = Date.now();
    _statusTimer = setInterval(checkNoFix, 5000);
    onStatus('searching');

    var geo = capGeo();
    var opts = { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 };

    if(geo){
      geo.watchPosition(opts, function(pos, err){
        if(err || !pos || !pos.coords) return;
        var c = pos.coords;
        if(c.accuracy > minAccuracyM) return;
        _lastFix = { lat: c.latitude, lng: c.longitude, accuracy: c.accuracy,
                     speed: c.speed, timestamp: pos.timestamp };
        setStatus(c.accuracy);
        onPosition(_lastFix);
      }).then(function(id){ _watchId = id; });
    } else if(navigator.geolocation){
      _watchId = navigator.geolocation.watchPosition(
        function(pos){
          var c = pos.coords;
          if(c.accuracy > minAccuracyM) return;
          _lastFix = { lat: c.latitude, lng: c.longitude, accuracy: c.accuracy,
                       speed: c.speed, timestamp: pos.timestamp };
          setStatus(c.accuracy);
          onPosition(_lastFix);
        },
        function(err){
          if(err.code === 1) onStatus('denied');
        },
        opts
      );
    } else {
      onStatus('unsupported');
    }
  }

  function stopWatch(){
    if(_statusTimer){ clearInterval(_statusTimer); _statusTimer = null; }
    if(_watchId != null){
      var geo = capGeo();
      if(geo) geo.clearWatch({ id: _watchId });
      else if(navigator.geolocation) navigator.geolocation.clearWatch(_watchId);
      _watchId = null;
    }
    _statusCb = null;
  }

  root.GeoProvider = {
    requestPermission: requestPermission,
    startWatch: startWatch,
    stopWatch: stopWatch,
    getLastFix: function(){ return _lastFix; }
  };
})(typeof self !== 'undefined' ? self : this);
