# krill · build plan

Prototype: two browser pages and a Node render command that turn creature and pond files into a
WAV. No plugin yet. Design: `design.md`.

Each batch ends with passing tests and a commit authored as
`bytebent <bytebent@users.noreply.github.com>`. Nothing moves to the next batch until you've
checked the one before where it says **You**.

## Layout

```
vendor/            copied engines + VERSIONS.md (source commits)
src/               krill code, plain JS, runs in browser and Node
  version.js       krill version and engine commits, written into every WAV
  engines.js       the vendored engines in Node and the browser
  rng.js           seeded random streams (pond seed → slot streams)
  creature.js      creature format: defaults, validation, migration, names
  scales.js        scales, snapping, harmonise
  roll.js          one creature: ranges → units → calls, signature
  conductor.js     floor, turns, answers, motifs, mimicry, eras → score
  voice.js         score → audio for one creature (engine, tube, pan)
  mixer.js         all voices → stereo, limiter, fades
  wav.js           streaming WAV writer, info chunk
pages/             creature.html, pond.html (+ shared kit css/js, render worker)
tools/score.js     prints a creature's solo score as text
tools/render.js    Node render command
tools/bench.js     render speed per example
tools/calibrate.js measures species loudness for the Level calibration
tests/             Node tests
examples/          a few creatures and ponds for testing
```

## Batches

| # | Batch | Contents | Check | State |
|---|---|---|---|---|
| 01 | **Setup** | Repo layout, `vendor/` engines with recorded commits, `README.md`, `.gitignore`, test runner, engine smoke test (each engine loads in Node and renders). | Tests | Done |
| 02 | **Creature format** | `creature.js`: schema, defaults, ranges for every engine parameter, lock (min = max), validation, migration, keep unknown keys, name generator. Example creatures for each species. | Tests | Done |
| 03 | **One creature, score** | `rng.js`, `scales.js`, `roll.js`: unit rolls, Morph, call grammar, Evolve, rests, pitch anchors and contours, key snapping, signature and variation. Text dump of a score. | Tests: determinism, ranges respected, key snapping | Done |
| 04 | **One creature, audio** | `voice.js`, `mixer.js`, `wav.js`, first `tools/render.js`: a one-slot pond renders to WAV. Silent-creature skip, block-size independence, limiter, fades, info chunk. | **You:** listen to the example creatures | Built, waiting for your ears |
| 05 | **Creature page** | Window, LCD (spectrogram, tube shape), range sliders, vowel-pad region, call and signature panels, manner, names, Call / Signature playback via the render worker, Render 60 s solo, Save / Load. | Headless browser check · **You:** design a few creatures | |
| 06 | **Conductor** | `conductor.js`: floor, Overlap, response gaps, Talkative / Responsive, motifs stored as range positions, copying into the copier's ranges, mutation, motif memory, harmonise, opposite-side answers, eras, slot re-rolls. | Tests: turn rules, determinism, one-creature pond | |
| 07 | **Pond render** | Multi-slot rendering in `tools/render.js` with progress, CPU and timing report, long renders streamed to disk. | Tests · **You:** a 20-minute render | |
| 08 | **Pond page** | Slots, sketch view from the score, Pitch / Talk / Space panels, preview render up to 10 min, download, Save / Load pond, the Node command shown for longer pieces. | Headless browser check · **You** | |
| 09 | **Listening round** | Tuning defaults and ranges from what you hear; fix what sounds wrong. | **You** | |

## Not in the prototype
Moods, live nudging, automated key changes, distance cue, creatures joining and leaving,
C++ / JUCE plugin. See `design.md` §10.
