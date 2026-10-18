/*
 * krill · access to the vendored engines in Node and in the browser.
 * In the browser the engine files must be loaded first (they define ThroatEngine, DolphinEngine
 * and MouthTube on the global object).
 */
(function (root) {
  'use strict';
  const inNode = typeof module !== 'undefined' && module.exports;
  const api = inNode ? {
    ThroatEngine: require('../vendor/throat-engine.js').ThroatEngine,
    DolphinEngine: require('../vendor/dolphin-engine.js').DolphinEngine,
    MouthTube: require('../vendor/mouth-tube.js').MouthTube,
  } : {
    ThroatEngine: root.ThroatEngine, DolphinEngine: root.DolphinEngine, MouthTube: root.MouthTube,
  };
  api.BLOCK = 32;            // all three engines work in 32-sample blocks; krill drives them in step
  if (inNode) module.exports = api;
  else (root.Krill = root.Krill || {}).engines = api;
})(typeof self !== 'undefined' ? self : this);
