/* configLoader.js — shared config loader with deep-merge.
 * Always fetches config.json first, then merges any localStorage
 * override on top so new config fields are never wiped. */
(function (root) {
  'use strict';
  var STORAGE_KEY = 'metroConfigOverride';

  function deepMerge(base, over) {
    if (over == null || typeof over !== 'object') return base;
    if (typeof base !== 'object' || base === null || Array.isArray(base)) return over;
    var result = {};
    var keys = Object.keys(base);
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      if (Array.isArray(base[k])) {
        result[k] = (k in over && Array.isArray(over[k])) ? over[k] : base[k];
      } else if (typeof base[k] === 'object' && base[k] !== null) {
        result[k] = deepMerge(base[k], (k in over) ? over[k] : {});
      } else {
        result[k] = (k in over) ? over[k] : base[k];
      }
    }
    var overKeys = Object.keys(over);
    for (var j = 0; j < overKeys.length; j++) {
      if (!(overKeys[j] in result)) result[overKeys[j]] = over[overKeys[j]];
    }
    return result;
  }

  root.loadConfig = function loadConfig() {
    return fetch('config.json')
      .then(function (res) { return res.json(); })
      .then(function (base) {
        var saved = null;
        try { saved = localStorage.getItem(STORAGE_KEY); } catch (e) { /* private browsing */ }
        if (saved) {
          try { return deepMerge(base, JSON.parse(saved)); }
          catch (e) { console.warn('Saved config corrupt, using defaults', e); }
        }
        return base;
      });
  };

  root.CONFIG_STORAGE_KEY = STORAGE_KEY;
})(typeof self !== 'undefined' ? self : this);
