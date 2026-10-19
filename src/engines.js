/*
 * krill · access to the vendored engines in Node and in the browser.
 * In the browser the engine files must be loaded first (they define ThroatEngine, DolphinEngine,
 * MouthTube, SyrinxMap + SyrinxEngine and BeakTube on the global object).
 */
(function (root) {
  'use strict';
  const inNode = typeof module !== 'undefined' && module.exports;
  const api = inNode ? {
    ThroatEngine: require('../vendor/throat-engine.js').ThroatEngine,
    DolphinEngine: require('../vendor/dolphin-engine.js').DolphinEngine,
    MouthTube: require('../vendor/mouth-tube.js').MouthTube,
    SyrinxEngine: require('../vendor/syrinx-engine.js').SyrinxEngine,     // finds syrinx-maps.js next to it
    BeakTube: require('../vendor/beak-tube.js').BeakTube,
  } : {
    ThroatEngine: root.ThroatEngine, DolphinEngine: root.DolphinEngine, MouthTube: root.MouthTube,
    SyrinxEngine: root.SyrinxEngine, BeakTube: root.BeakTube,
  };
  api.BLOCK = 32;            // all five engines work in 32-sample blocks; krill drives them in step
  if (inNode) module.exports = api;
  else (root.Krill = root.Krill || {}).engines = api;
})(typeof self !== 'undefined' ? self : this);
