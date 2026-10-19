# Vendored engines

Unmodified copies of the bytebent reference engines. Krill never edits these files; to update one,
copy the new version in, change its row here, and re-run the tests. A changed engine can change
how old ponds sound, so update deliberately.

| File | Repo | Source path | Commit | Commit date |
|---|---|---|---|---|
| `throat-engine.js` | `bytebent/throat` | `reference/throat-engine.js` | `5bdde405a390299172f038781c9eaed9793f82a2` | 2026-10-17 |
| `dolphin-engine.js` | `bytebent/dolphin` | `reference/dolphin-engine.js` | `8d8a8e926c234afe09e54cfdae78d69ff674a548` | 2026-10-18 |
| `mouth-tube.js` | `bytebent/mouth-tube` | `reference/mouth-tube.js` | `9be36dec62c48c0b7573e5e78147eaf43c07419b` | 2026-10-18 |
| `syrinx-engine.js` | `bytebent/syrinx` | `reference/syrinx-engine.js` | `701f706e92afefaa544ef22f722774e18eeb406e` | 2026-10-19 |
| `syrinx-maps.js` | `bytebent/syrinx` | `reference/syrinx-maps.js` | `701f706e92afefaa544ef22f722774e18eeb406e` | 2026-10-19 |
| `beak-tube.js` | `bytebent/beak-tube` | `reference/beak-tube.js` | `10b865ed231f70ccbb6b4566dea22973cb8060cc` | 2026-10-19 |

Syrinx (batch 08 of 11) and beak-tube (batch 05 of 08) are prototypes that are still changing; on the
`krill-birds-v1` branch they are frozen at the commits above. `syrinx-engine.js` loads `syrinx-maps.js`
from the same folder in Node; in the browser the map file must be loaded first.

`tests/engines-test.js` checks each file's SHA-256 against `vendor/hashes.json`, so an accidental
edit fails the tests.
