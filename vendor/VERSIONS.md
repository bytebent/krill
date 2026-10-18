# Vendored engines

Unmodified copies of the bytebent reference engines. Krill never edits these files; to update one,
copy the new version in, change its row here, and re-run the tests. A changed engine can change
how old ponds sound, so update deliberately.

| File | Repo | Source path | Commit | Commit date |
|---|---|---|---|---|
| `throat-engine.js` | `bytebent/throat` | `reference/throat-engine.js` | `5bdde405a390299172f038781c9eaed9793f82a2` | 2026-10-17 |
| `dolphin-engine.js` | `bytebent/dolphin` | `reference/dolphin-engine.js` | `8d8a8e926c234afe09e54cfdae78d69ff674a548` | 2026-10-18 |
| `mouth-tube.js` | `bytebent/mouth-tube` | `reference/mouth-tube.js` | `9be36dec62c48c0b7573e5e78147eaf43c07419b` | 2026-10-18 |

`tests/engines-test.js` checks each file's SHA-256 against `vendor/hashes.json`, so an accidental
edit fails the tests.
