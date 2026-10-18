# krill

A generator for long ambient pieces made by a pond of alien creatures. Each creature is built from
bytebent engines (Throat, Dolphin, mouth-tube), rolls every sound from its own ranges, and takes
turns, answers and copies the others. The pond renders to a WAV file.

Status: **prototype, batch 04 of 09**. Creatures render on their own to WAV; ponds come next.

- `design.md`: what krill is and how it works
- `plan.md`: build batches for the prototype
- `tests.md`: what's been tested and the results, with screenshots

## Layout

- `vendor/`: unmodified copies of the Throat, Dolphin and mouth-tube reference engines, with
  their source commits in `vendor/VERSIONS.md`
- `src/`: krill itself, plain JavaScript that runs in Node and in the browser
- `tests/`: Node tests
- `tools/`: command-line tools
- `examples/`: example creatures and ponds

## Commands

Needs Node 18 or newer. No packages to install.

```sh
node tests/run.js                 # all tests (optional filter: node tests/run.js roll)
node tools/score.js examples/creatures/glassfin.krill-creature.json --minutes 2
node tools/render.js examples/creatures/moanback.krill-creature.json --minutes 5   # → renders/*.wav
node tools/bench.js               # render speed per example creature
node tools/calibrate.js           # species loudness (for the Level calibration in src/voice.js)
```

`tools/score.js` prints a creature's score as text: every call and unit with its time, pitch and
parameter values. Options: `--seed N`, `--minutes M`, `--key "D minor"` (or `--free`),
`--json` for the raw score.

`tools/render.js` renders a creature on its own to a 48 kHz WAV, streamed to disk, so any length
works. Same options as `score.js`, plus `--bits 16|24`, `--level dB`, `--fade-in S`,
`--fade-out S` and `--out file.wav`. The WAV carries the seed, settings, creature and engine
commits in a `krll` chunk.

## Licence note

The vendored engines come from bytebent repositories that are public under the AGPLv3 note in
their READMEs. Krill follows the same terms.
