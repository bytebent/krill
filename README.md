# krill

A generator for long ambient pieces made by a pond of alien creatures. Each creature is built from
bytebent engines (Throat, Dolphin, mouth-tube), rolls every sound from its own ranges, and takes
turns, answers and copies the others. The pond renders to a WAV file.

Status: **prototype, batch 07 of 09**. Ponds render to WAV from the command line; the pond page is next.

- `design.md`: what krill is and how it works
- `plan.md`: build batches for the prototype
- `tests.md`: what's been tested and the results, with screenshots

## Creature page

Open `pages/creature.html` in a current browser, straight from disk (no server needed). Design a
creature, press **Call** (or Space) to hear one call, **Signature** for its signature call, and
**Render 60 s solo** for a WAV. **Save** downloads a `.krill-creature.json`; **Load** or drag a
file onto the page to open one. The four examples are under **Examples**. The page remembers the
creature you were working on.

The page is built from `pages/src/` with `node tools/build-pages.js`; rebuild after changing
`src/`, `vendor/` or `pages/src/`. `node tools/check-pages.js` drives it in headless Chromium.

## Layout

- `src/parts.js`: the sources and bodies a creature can be built from; add new engines here
- `vendor/`: unmodified copies of the Throat, Dolphin and mouth-tube reference engines, with
  their source commits in `vendor/VERSIONS.md`
- `src/`: krill itself, plain JavaScript that runs in Node and in the browser
- `pages/`: the built pages; `pages/src/`: their sources (template, kit, page script, worker)
- `tests/`: Node tests
- `tools/`: command-line tools
- `examples/`: example creatures and ponds

## Commands

Needs Node 18 or newer. No packages to install.

```sh
node tests/run.js                 # all tests (optional filter: node tests/run.js roll)
node tools/score.js examples/creatures/glassfin.krill-creature.json --minutes 2
node tools/render.js examples/ponds/first-pond.krill-pond.json            # a whole pond → renders/*.wav
node tools/render.js examples/creatures/moanback.krill-creature.json --minutes 5   # one creature
node tools/bench.js               # render speed per example creature
node tools/calibrate.js           # species loudness (for the Level calibration in src/voice.js)
```

`tools/score.js` prints a creature's score as text: every call and unit with its time, pitch and
parameter values. Options: `--seed N`, `--minutes M`, `--key "D minor"` (or `--free`),
`--json` for the raw score.

`tools/render.js` renders a pond (`.krill-pond.json`) or a creature on its own to a 48 kHz WAV,
streamed to disk, so any length works. A pond uses its own seed, key, length and output settings
unless an option overrides them. Same options as `score.js`, plus `--bits 16|24`, `--level dB`, `--fade-in S`,
`--fade-out S` and `--out file.wav`. The WAV carries the seed, settings, creature and engine
commits in a `krll` chunk.

## Licence note

The vendored engines come from bytebent repositories that are public under the AGPLv3 note in
their READMEs. Krill follows the same terms.
