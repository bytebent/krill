# krill · design

A generator that makes long ambient pieces from a pond of alien creatures. Each creature is a
voice built from bytebent engines (Throat, Dolphin, mouth-tube). Every sound it makes is rolled
fresh from its own ranges, Krell-patch style, and the creatures take turns, answer each other and
copy each other's calls. The result is rendered to a WAV file.

Labels: **[Decided]** you chose it, **[Proposed]** suggested and not yet confirmed, **[Open]**
still to decide, **[Later]** agreed to leave out of the prototype.

---

## 1. What it is

- A **standalone generator** that makes the whole soundscape. Nothing is added to Throat, Dolphin
  or mouth-tube themselves. [Decided]
- It **reuses the existing JS reference engines** rather than rebuilding them. [Decided]
- **Audio out only.** No MIDI output, no reverb. [Decided]
- **Prototype renders a WAV file of a chosen length.** It does not play live. [Decided]
- Name: **krill** (lowercase, like bytebent), working name. [Decided]

## 2. Principles

- **Character comes from ranges.** A creature isn't a fixed sound; it's the space of sounds it is
  allowed to make. Narrow ranges make a predictable animal, wide ones a strange one.
- **Organic parts, alien whole.** Each engine sounds like a body. The combinations (a pulse train
  through a mouth, a larynx at whistle pitch, a tract longer than any animal) don't exist in nature.
- **Conversation over noise.** Turn-taking, answers and copied motifs are what make it sound like
  life rather than random notes.
- **Silence is allowed.** A pond can go quiet. Long pieces need space.
- **Repeatable.** Same files, same settings, same seed: the same WAV, bit for bit.
- **Plain, short, a little dry** copy, matching the bytebent voice.
- **Efficient, never sloppy.** Nothing inactive is computed: see §7.3. [Decided]

## 3. Creatures

### 3.1 Species
A creature is a **source**, with or without a **mouth**. [Decided: some creatures have no mouth]

| Species | Source | Mouth | Character |
|---|---|---|---|
| Bare Dolphin | Dolphin | — | Clicks, burst pulses, whistles straight from the phonic lips |
| Bare Throat | Throat | — | Raw glottal buzz, thin and insect-like |
| Throat + tube | Throat | mouth-tube | Voiced creature that moves through vowels |
| Dolphin + tube | Dolphin | mouth-tube | Talking cetacean |

### 3.2 Ranges
Every engine parameter the creature uses has a **min and max**. Each unit (§3.3) rolls a value
inside the range. Setting min equal to max locks a parameter. [Decided]

- Applies to all Throat, Dolphin and mouth-tube parameters that shape sound (Breathy, Creaky,
  Rate, Register, Biphon, tongue position, Jaw, Lips, Length…). [Decided]
- Housekeeping parameters are fixed by Krill, not ranged: engines run in **mono mode**, Volume is
  set by the creature's Level, Dolphin's LFOs are off, mouth-tube's Mix is 100%. [Proposed]
- The tongue position is a **region drawn on the vowel pad** rather than two separate ranges. [Proposed]
- Each parameter can also **Morph**: roll a start and an end value and move between them over the
  unit, so a single cry can slide from "oo" to "ah" or from clicks into a whistle. Morph is a
  per-creature amount (0 = static units, 1 = every unit moves). [Proposed]

### 3.3 Call grammar
[Decided: calls have structure, covering one long cry, a long call made of short ones, a small blip]

- A **unit** is one sound: one note on the engine, with its rolled parameters and pitch.
- A **call** is 1 to N units with gaps between them.
- Between calls the creature **rests**.

| Control | Range | Meaning |
|---|---|---|
| Units per call | 1–32 (range) | 1 = single cry; 8–12 = chattering train |
| Unit length | 20 ms–20 s (range) | |
| Gap | 0–5 s (range) | Silence between units in a call; 0 = legato |
| Legato | on/off | Units glide into each other without re-attacking |
| Evolve | Steady · Rise · Fall · Arc · Wander | How units change across one call (pitch and parameter positions) |
| Evolve amount | 0–1 | How far they move |
| Rest | 0.5 s–5 min (range) | Silence between this creature's calls |
| Envelope | Attack, Release ranges | Passed to the engine's ADSR (Sustain fixed at 1) |

### 3.4 Pitch
- **Pitch range**: lowest and highest note (MIDI numbers, so everything stays in human hearing). [Decided]
- Each unit has an **anchor** (where it starts and settles) and an optional **Contour** in
  semitones (range), which the engine glides through. Dolphin's own whistle Shape/Sweep still
  apply on top. [Proposed]
- Key behaviour is set by the pond (§5.3).
- **Dolphin pitch** is the note the engine receives, as on the Dolphin bench: pulse rates follow it
  (Key track) and the whistle sounds **Size octaves above it** (small = up to 4 octaves higher).
  The creature page will show both the note and the whistle pitch.

### 3.5 Signature
- Each creature has a **signature call**, generated from its **creature seed** and its ranges, and
  shown on the creature page. **Re-roll signature** picks a new creature seed. [Proposed]
- **Signature** amount (0–1): how often its calls are its own signature rather than a fresh roll.
- **Variation** (0–1): how much a signature call changes each time it's repeated. Low keeps it
  recognisable, like a dolphin's signature whistle. [Proposed]

### 3.6 Manner
| Control | Meaning |
|---|---|
| Talkative | How readily it starts a call when the floor is free |
| Responsive | How readily it answers another creature's call |
| Mimicry | When it answers, odds it copies (and mutates) the call it heard instead of making its own |
| Home pan | Its place in the stereo field, L–R |
| Wander | How far and how fast it drifts around home |
| Level | Its volume in the mix |

### 3.7 Names
Every creature has a **name**, stored in its file and shown in slots. **Dice** next to the name
suggests a random one (e.g. "Glassfin", "Moanback"). [Decided: names needed for presets]

## 4. Motifs and imitation
[Decided: turn-taking and imitation]

- Every call is stored as a **motif**: per unit its length, gap, pitch step and each parameter's
  **position inside the caller's range** (0–1), not the raw value.
- Copying a motif maps those positions into the **copier's own ranges**. So a copy is the copier
  doing the caller's gesture in its own voice: same shape, different animal. [Proposed]
- Pitch is copied as **steps** (scale degrees in key mode, semitones in free mode), transposed into
  the copier's pitch range.
- **Mutation**: each copy changes one or more elements (a step, a length, a unit added or dropped).
- The pond keeps a short memory of recent motifs. A motif that keeps getting copied spreads; one
  nobody repeats fades out. Over a long piece the pond develops a **dialect**.
- A single creature in the pond imitates itself: it varies its own signature. [Decided: one creature works]

## 5. The pond

### 5.1 Slots
- **1 to 6 slots**, each holding one creature file. One creature alone is valid. [Decided]
- Each slot owns a stripe colour in stripe order: 1 green, 2 yellow, 3 orange, 4 red, 5 purple, 6 blue. [Decided]
- The same creature file may be loaded into several slots; each gets its own random stream.

### 5.2 Turn-taking: the floor
- A creature that is calling **holds the floor**.
- When a call ends, another creature may **answer** after a response gap (pond range). Who answers
  is weighted by each creature's Responsive value.
- **Overlap** (pond, 0–1): 0 = strict turns, nobody starts while the floor is held; 1 = everyone
  calls freely. In between, interruptions become more likely.
- If nobody answers and nobody is talkative enough to start, the pond goes quiet.

### 5.3 Key modes
[Decided: two modes]

- **In key**: Root and Scale (Major, Minor, Dorian, Phrygian, Lydian, Mixolydian, Pentatonic major,
  Pentatonic minor, Whole tone, Chromatic). Every anchor pitch snaps to the scale. Contours,
  glides and whistle sweeps move freely between anchors. Burst-pulse rates fast enough to be heard
  as pitch also snap; slow clicks are rhythm and don't. Dolphin's Whistle transpose and the end of
  a whistle Sweep snap too, and Size moves the whistle by whole octaves only (Size mode is held at
  Octaves). Copied motifs move by scale degree, so they stay in key.
- **Free**: continuous pitch, no quantising.
- **Harmonise** (button, In key only): anchors prefer consonant intervals (3rds, 5ths, 6ths,
  octaves) with whatever is sounding at that moment. [Decided]
- Automated key changes: [Later, far future]

### 5.4 Panning
[Decided: voices vary in panning]

- Each creature sits at its Home pan and wanders around it (§3.6). **Width** (pond) scales all positions.
- Answers lean toward the **side opposite the caller**, so conversations move across the field. [Proposed]
- Equal-power panning of each mono creature into stereo. No reverb. [Decided]
- Distance cue (quieter and duller when a creature drifts "away"): [Later]

### 5.5 Eras
- **Era length** (pond): how often the pond's overall state takes a slow random step.
- Each step drifts global **Density** (a multiplier on everyone's Talkative and Rest) and a global
  **Register** offset (± a few semitones, in scale steps in key mode). [Decided: this simple drift
  is in v0.1, and moods will extend it later]
- This is what keeps a 40-minute piece moving. Per-creature **moods** (slowly shifting ranges)
  come later and slot in between ranges and the roll. [Later]

### 5.6 Output
- Stereo, 48 kHz, **24-bit WAV** (16-bit option, with seeded dither so it stays repeatable). [Proposed]
- **Level** control and a lookahead peak limiter on the master (ceiling -1 dBFS, 2.7 ms lookahead,
  300 ms recovery) so many creatures at once can't clip. Below the ceiling it leaves the sound
  exactly as it is. No normalising, because long renders are streamed to disk. [Proposed]
- **Calibrated Level.** Each species is calibrated so a creature at Level 0 calls at about
  -20 dBFS RMS. Without it, Dolphin through a tube is about 30 dB louder than bare Dolphin, and
  Level would mean something different per species. `tools/calibrate.js` measures it.
- **Fade in / fade out** lengths for the start and end of the piece. [Proposed]

## 6. Seeds and repeatability
[Decided: seeds so pieces can be remade]

| Seed | Lives in | Controls |
|---|---|---|
| **Pond seed** | Pond file | The whole piece |
| **Slot stream** | Derived: pond seed + slot number + slot re-roll count | That slot's choices. **↻** on a slot re-rolls only that creature; the others stay identical |
| **Creature seed** | Creature file | Its signature call, the same in every pond |

- Rendering is deterministic and independent of chunk size.
- The WAV name carries the seed and length (`krill_48213_20m.wav`), and the WAV stores the pond
  file and engine versions in a text chunk, so a file always says what made it. [Proposed]

## 7. How it works

Two stages, kept apart on purpose. [Proposed]

1. **Score.** The conductor runs the whole piece as decisions only, with no audio: who calls when,
   every unit's pitch and parameter values, pans, motifs. This is fast (well under a second for an
   hour) and deterministic.
2. **Audio.** Each creature's units are played on its own engine instances, panned and mixed in
   fixed blocks, and streamed to the WAV.

Why: the pond page can draw the whole piece as a **sketch** before any audio is rendered, re-rolls
are instant, and imitation works on motifs rather than on audio analysis.

```
creature files ─┐
pond settings ──┴─► conductor (floor · turns · motifs · key · eras) ─► score
score ─► per creature: engine (Throat | Dolphin) ─► [mouth-tube] ─► pan ─┐
                                                                         ├─► mix ─► limiter ─► WAV
                                                                   ... ──┘
```

### 7.1 Engines
- Copies of the reference engines live in `vendor/` with their source commit recorded in
  `vendor/VERSIONS.md`. Updating them is a deliberate step, so changes in Throat or Dolphin never
  silently change an old pond. [Decided]

| Engine | Source | Interface used |
|---|---|---|
| Throat | `bytebent/throat` `reference/throat-engine.js` | `new ThroatEngine(sr, seed)`, `setParam`, `noteOn/noteOff`, `process(out, n)` (mono) |
| Dolphin | `bytebent/dolphin` `reference/dolphin-engine.js` | `new DolphinEngine(sr, seed)`, `setParam`, `noteOn/noteOff`, `setBend`, `process(L, R, n)` |
| mouth-tube | `bytebent/mouth-tube` `reference/mouth-tube.js` | `new MouthTube(sr)`, `setParam`, `process(inL, inR, outL, outR, n)` |

- One engine instance per creature, mono mode. Dolphin's stereo is summed to mono before the
  tube and the panner; the tube runs one channel only. [Decided]
- **Pitch**: the engine holds one note and Krill moves it every 32-sample block with Throat's
  Transpose + Detune (±25 st) or Dolphin's bend (range set to ±48 st), so contours, legato glides
  and free-mode cents are exact. A line that goes further re-bases onto a new held note in the
  same block, with no jump. Engine Glide stays at 0.
- **Headroom**: Throat and Dolphin run at -12 dB and the tube's input at -24 dB and its Output at
  -18 dB, with the same amount added back in the voice. Dolphin and mouth-tube clamp their output
  at ±1, and the tube can add 20 dB or more of peak gain on clicks; this keeps every engine at
  least 6 dB clear of its clamp (tested for the examples). The voice reports the engine peak.
- Parameter changes inside a unit (Morph) are sent once per 32-sample block, which the engines
  already smooth.
- A creature that is silent and whose tail has decayed is skipped, so resting creatures cost
  almost nothing.
- Measured with `tools/bench.js` (48 kHz, Node): while calling, a bare Throat costs about 26 ms
  per second of audio, bare Dolphin 31 ms, Throat + tube 62 ms, Dolphin + tube 88 ms. Asleep, a
  creature costs nothing. Six tubed creatures all calling at once would still render at about
  twice real time; the examples alone render 30–290× real time.

### 7.2 Where it renders
[Decided]

- **Browser** (the pages): previews up to about **10 minutes**, rendered in a Web Worker and played
  back from memory, with a progress bar and a download.
- **Node command** for full lengths: `node tools/render.js my.krill-pond.json --minutes 45`.
  Same code, so the same seed gives the same file. Writes the WAV to disk in chunks (60 minutes is
  about 1 GB at 24-bit, too much to hold in a browser).

## 8. Files
[Decided: creatures and ponds are saveable files, versioned]

### 8.1 Creature: `<name>.krill-creature.json`
```json
{
  "format": "krill-creature",
  "version": 1,
  "name": "Glassfin",
  "seed": 9071,
  "source": "dolphin",
  "mouth": false,
  "pitch": { "low": 60, "high": 84, "contour": [-3, 7] },
  "ranges": {
    "dolphin.register": [0.6, 1.0],
    "dolphin.biphon":   [0.0, 0.4],
    "dolphin.rate":     [-3, -1]
  },
  "morph": 0.3,
  "call": {
    "units": [1, 4], "unitLength": [0.4, 2.5], "gap": [0.05, 0.4], "legato": false,
    "evolve": "arc", "evolveAmount": 0.4, "rest": [4, 30],
    "attack": [0.01, 0.2], "release": [0.2, 1.5]
  },
  "signature": { "amount": 0.4, "variation": 0.2 },
  "manner": { "talkative": 0.4, "responsive": 0.7, "mimicry": 0.5,
              "pan": -0.4, "wander": 0.3, "level": -6 }
}
```
- Parameters not listed take the engine default, locked.
- Unknown keys are kept on save. Older `version`s are migrated on load.

### 8.2 Pond: `<name>.krill-pond.json`
```json
{
  "format": "krill-pond",
  "version": 1,
  "seed": 48213,
  "slots": [
    { "creature": { "...": "full creature, embedded" }, "rerolls": 0 },
    null, null, null, null, null
  ],
  "pitch": { "mode": "key", "root": "D", "scale": "minor", "harmonise": true },
  "talk": { "overlap": 0.2, "response": [0.3, 2.5], "eraLength": 120 },
  "space": { "width": 0.8 },
  "output": { "minutes": 20, "bits": 24, "level": -3, "fadeIn": 5, "fadeOut": 20 }
}
```
- Creatures are **embedded**, so a pond file alone is enough to re-render a piece even if the
  creature files later change. [Proposed]

## 9. Pages
The look follows open-stemmy: one window on the dotted desk, the black LCD always first, etched
panels with an LED in each legend, gel buttons, Lucida Grande, Monaco only on the LCD. All the
stripe colours are available. [Decided]

### 9.1 Creature page
Larger than the pond page, because of the number of parameters, and **one long page** with all
panels stacked, no tabs. [Decided] Uses the source's own colours: Throat red/blue, Dolphin blue,
mouth-tube purple.

```
┌─ ▢ ═════  [≡] krill · creature · Glassfin [🎲]  ═════ [Pond] ─┐
│ ┌──────────────────────── LCD ───────────────────────────────┐ │
│ │ spectrogram of the last call · tube shape when it has one     │ │
│ │ CALL 3 UNITS · 4.2 s · SEED 9071                              │ │
│ └───────────────────────────────────────────────────────────────┘ │
│ ┌─ ● Species ──────┐ ┌─ ● Pitch ─────────────────────────────┐ │
│ │ Throat / Dolphin │ │ ═[■━━━━■]═ Range   ═[■━■]═ Contour   │ │
│ │ Mouth  on / off   │ │                                       │ │
│ └───────────────────┘ └───────────────────────────────────────┘ │
│ ┌─ ● Source (ranges) ───────────────────────────────────────────┐ │
│ │ one two-handled slider per engine parameter, in the engine's  │ │
│ │ own groups; double-click locks (min = max)                    │ │
│ └───────────────────────────────────────────────────────────────┘ │
│ ┌─ ● Mouth (ranges) ────────────────────────────────────────────┐ │
│ │ vowel pad with a drawn region · Tip Jaw Lips Round Nasal      │ │
│ │ Length Damping                       (greyed out with no mouth)│ │
│ └───────────────────────────────────────────────────────────────┘ │
│ ┌─ ● Call ─────────────────┐ ┌─ ● Signature ─┐ ┌─ ● Manner ────┐ │
│ │ Units Unit length Gap    │ │ Amount        │ │ Talkative     │ │
│ │ Legato Evolve Rest       │ │ Variation     │ │ Responsive    │ │
│ │ Attack Release Morph     │ │ (Re-roll)     │ │ Mimicry Pan   │ │
│ └──────────────────────────┘ └───────────────┘ │ Wander Level  │ │
│                                                └───────────────┘ │
│ (Call)  (Signature)  (Render 60 s solo)          Save…  Load…    │
└──────────────────────────────────────────────────────────────────┘
```
- **Call** renders and plays one fresh call; **Signature** plays the signature call.
- **Render 60 s solo** renders the creature alone in a one-slot pond and offers the WAV.
- Changing a range doesn't re-roll anything until the next Call.

### 9.2 Pond page
```
┌─ ▢ ═════════  [≡] krill · pond · v0.1  ═════════ [Creature] ─┐
│ ┌──────────────────────── LCD ─────────────────────────────┐ │
│ │ 1 ▁▁▃▇▅▁▁▁▁▁▁▂▃▁▁▁▁▁▁▁▁▅▇▃▁▁   one lane per slot           │ │
│ │ 2 ▁▁▁▁▁▁▁▅▇▆▂▁▁▁▁▁▁▁▁▁▁▁▁▁▁   calls in the slot colour     │ │
│ │ 3 ▁▁▁▁▁▁▁▁▁▁▁▁▁▁▃▃▃▃▁▁▁▁▁▁   copies outlined, linked      │ │
│ │ L ·····●··········●··●····· R  pan over time                │ │
│ │ SEED 48213 · D MINOR · 20:00 · RENDER 37%                   │ │
│ └─────────────────────────────────────────────────────────────┘ │
│ ┌─ ● Slots ─────────────────────────────────────────────────┐ │
│ │ ●1 Glassfin   Dolphin        ↻ ✕   ●4 (empty)  Load…       │ │
│ │ ●2 Moanback   Throat + tube  ↻ ✕   ●5 (empty)  Load…       │ │
│ │ ●3 Ticker     Dolphin + tube ↻ ✕   ●6 (empty)  Load…       │ │
│ └────────────────────────────────────────────────────────────┘ │
│ ┌─ ● Pitch ────────┐ ┌─ ● Talk ────────┐ ┌─ ● Space · Output ─┐ │
│ │ In key / Free    │ │ Overlap         │ │ Width              │ │
│ │ Root  Scale      │ │ Response        │ │ Level  Bits        │ │
│ │ [Harmonise]      │ │ Era length      │ │ Fade in / out      │ │
│ └──────────────────┘ └─────────────────┘ └────────────────────┘ │
│ Seed 48213 [🎲]   Length 20:00   (Render preview)   Save… Load…  │
└──────────────────────────────────────────────────────────────────┘
```
- The **sketch** in the LCD updates instantly from the score whenever anything changes; audio
  renders only on **Render preview**.
- Lengths above the preview limit show the Node command to run instead, with the pond file to save.
- Clicking a creature's name opens it on the creature page.

### 7.3 Efficiency rules
[Decided: don't compute what isn't active]

- **Score stage**: a creature is compiled once into flat arrays. Locked parameters are written
  once, never rolled. Morph, Evolve, mutation and harmonise code paths are skipped entirely when
  their amount is 0 or they're off. Mouth parameters don't exist for a creature without a mouth.
- **Audio stage** (batch 04 on): a creature with nothing sounding and a decayed tail is not
  processed at all, including its tube. Parameters are sent to an engine only when their value
  changes, once per 32-sample block at most. Dolphin's LFOs stay off, so they cost nothing.
  The tube runs one channel, not two.
- **Pages**: the LCD redraws only when something changed, and slows down for "reduce motion".
  The sketch is recomputed only when a setting that affects the score changes. Hidden panels
  (Mouth with no mouth) don't update.
- Speed is measured, not assumed: `tools/bench.js` (from batch 04) reports render speed per species
  so regressions show up.

### 7.4 Pitch in the score
The score stores pitch as **fractional MIDI notes** (60.37 = C4 plus 37 cents). The audio stage
splits that into the engine's whole note plus Detune in cents. Contours are a start and an end
pitch per unit; the audio stage moves between them.

## 10. Later
- **Moods**: per-creature ranges that drift slowly over a piece.
- **Live nudging**: poke a creature to call, freeze the current mood. Needs the live plugin.
- **Automated key changes** between eras.
- **Distance cue** in panning.
- **Birth and departure**: creatures joining and leaving the pond over time.
- **Plugin**: C++ port and JUCE wrapper, real-time instead of render.
- **Fricative noise stream** from Throat into the tube, if mouth-tube gains it.

## 11. Open
None at the moment.
