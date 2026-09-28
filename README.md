# Word Grid

A Boggle-style word game for iPhone (installable web app), with no ads. Two modes:

- **Play the Coach**: race a bot that adapts to your level.
- **Free Play**: just you and the clock.

## How the coach adapts

After every round, the game updates an estimate of the share of each board's available
points you usually earn. The coach aims for that share, times a "pressure" factor that
rises 4% after each of your wins and falls 4% after each loss, so matches stay close.
The Relaxed / Even / Tough setting scales the result by 0.85 / 1.0 / 1.15.
The coach prefers common, shorter words (it uses SCOWL commonness tiers) and finds them
gradually over the round, as a person would.

## Layout

- `public/`: the whole app (static files, no build step)
  - `engine.js`: dice, solver, scoring, bot, adaptation (no DOM)
  - `app.js`: UI, touch tracing, timer, results
  - `words.txt`: dictionary (built, do not edit by hand)
  - `sw.js`: offline cache. **Bump `VERSION` whenever anything in `public/` changes.**
- `scripts/build_dict.py`: rebuilds `words.txt` from `data/` (ENABLE + SCOWL, gitignored)
- `test/engine.test.mjs`: `node test/engine.test.mjs`

## Run locally

    cd public && python3 -m http.server 8000

## Word lists

- ENABLE2K word list: public domain.
- SCOWL (commonness tiers): Copyright 2000-2018 Kevin Atkinson; used under its permissive license.
