/*
 * krill · version and engine provenance, written into every rendered WAV.
 * tests/audio-test.js checks the commits here match vendor/VERSIONS.md.
 */
(function (root) {
  'use strict';
  const api = {
    KRILL: '0.1.0-birds.1',
    ENGINES: {
      throat: '5bdde405a390299172f038781c9eaed9793f82a2',
      dolphin: '8d8a8e926c234afe09e54cfdae78d69ff674a548',
      'mouth-tube': '9be36dec62c48c0b7573e5e78147eaf43c07419b',
      syrinx: '701f706e92afefaa544ef22f722774e18eeb406e',
      'beak-tube': '10b865ed231f70ccbb6b4566dea22973cb8060cc',
    },
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else (root.Krill = root.Krill || {}).version = api;
})(typeof self !== 'undefined' ? self : this);
