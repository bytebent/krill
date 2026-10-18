# krill

A generator for long ambient pieces made by a pond of alien creatures. Each creature is built from
bytebent engines (Throat, Dolphin, mouth-tube), rolls every sound from its own ranges, and takes
turns, answers and copies the others. The pond renders to a WAV file.

Status: **prototype, batch 03 of 09**. Creatures and single-creature scores work; no audio yet.

- `design.md`: what krill is and how it works
- `plan.md`: build batches for the prototype

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
```

`tools/score.js` prints a creature's score as text: every call and unit with its time, pitch and
parameter values. Options: `--seed N`, `--minutes M`, `--key "D minor"` (or `--free`),
`--json` for the raw score.

## Licence note

The vendored engines come from bytebent repositories that are public under the AGPLv3 note in
their READMEs. Krill follows the same terms.
