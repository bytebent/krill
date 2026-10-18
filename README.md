# krill

A generator for long ambient pieces made by a pond of alien creatures. Each creature is built from
bytebent engines (Throat, Dolphin, mouth-tube), rolls every sound from its own ranges, and takes
turns, answers and copies the others. The pond renders to a WAV file.

Status: **prototype, batch 10 of 11**. Pond, creature and visualizer pages work; the listening round is next.

- `design.md`: what krill is and how it works
- `plan.md`: build batches for the prototype
- `tests.md`: what's been tested and the results, with screenshots

## Creature page

Open `pages/creature.html` in a current browser, straight from disk (no server needed). Design a
creature, press **Call** (or Space) to hear one call, **Signature** for its signature call, and
**Render 60 s solo** for a WAV. **Save** downloads a `.krill-creature.json`; **Load** or drag a
file onto the page to open one. The four examples are under **Examples**. The page remembers the
creature you were working on.

## Pond page

Open `pages/pond.html` (keep it next to `creature.html`). Put creatures in up to six slots, set
each lane to talk or ignore the others and its loudness range, then the key, talk and output
settings. The sketch on top shows the whole piece as you change things; **Preview** renders up to
the first 10 minutes in the page to play. **Export…** asks for the length, fades and bits and
saves the WAV with its pond file next to it (`krill_<seed>_<length>.wav` and
`.krill-pond.json`). In Chrome and Edge it streams to disk, so any length works; in Safari and
Firefox it goes up to 30 minutes, and longer pieces use `node tools/render.js <pond file>`.
Dropping a krill WAV on the page (or **Load…**) opens the pond it was made from. **Edit** on a
slot opens that creature on the creature page.

## Visualizer page

Open `pages/visualizer.html` (next to the other two, or press **Visualizer** on the pond page). It
opens the pond you were working on and plays it live: each creature is a scope of its own voice,
placed left to right as you hear it, sized by how loud its call is, and gone when it's silent.
Answers draw a white line, copies a dotted one. **Ring**, **Line** or **X/Y** picks how the
scopes draw (X/Y plots each voice against itself a quarter period later, so tones draw loops). **Pond length** or **Endless**
(six hours) picks how long it plays. **Load…** (or drop a file) opens a pond file or a krill
WAV; a WAV plays as itself, with the pond running silently alongside for the pictures, and the
player's own controls can seek.

The pages are built from `pages/src/` with `node tools/build-pages.js`; rebuild after changing
`src/`, `vendor/` or `pages/src/`. `node tools/check-pages.js` drives it in headless Chromium.

## Layout

- `src/parts.js`: the sources and bodies a creature can be built from; add new engines here
- `vendor/`: unmodified copies of the Throat, Dolphin and mouth-tube reference engines, with
  their source commits in `vendor/VERSIONS.md`
- `src/`: krill itself, plain JavaScript that runs in Node and in the browser
- `pages/`: the built pages; `pages/src/`: their sources (templates, kit, page scripts, render
  worker, the visualizer's AudioWorklet player)
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
