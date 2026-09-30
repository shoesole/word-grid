# Word Grid

A Boggle-style word game for iPhone (installable web app), with no ads. Two modes:

- **Train with the Coach**: hints when you're stuck (each costs points), lessons after each round.
- **Race the Rival**: race a bot that adapts to your level.
- **Free Play**: just you and the clock.

Every mode ends with 2–3 short lessons built from that board.

## How the Coach trains you (`coach.js`)

Each common word on a board is tagged by the pattern that unlocks it:

- relatives of words you found (RATE → RATES, GRATE; STOP → POTS)
- endings (-S, -ING, -ED, -ER, -EST, -LY) and beginnings (RE-, UN-, …)
- letter pairs (TH, ST, CH, …)
- long words and words that start with a vowel

Each pattern's hit rate is compared with your own overall rate in the same rounds, so
"weak" means weaker than your usual, not simply a hard pattern or a short round.
That relative score (your "spotting profile", shown on the home screen)
decides what the lessons cover and which word a hint points you toward.

**Starters (free):** after a dry spell (the "Starter after" setting: Off / 10 / 15 / 25 s,
default 15), the Coach outlines the opening tiles of a few
unfound common words ("SH starts 3 words you haven't found"), choosing openings tied to
your weak patterns. If you're still stuck 12 s later, it adds a third tile ("SHO…").
Words found from a starter score normally but don't count toward your profile.
Tapping Hint while a starter is showing points at one of its words.

**Family reminders (free):** when you find a word that has common relatives on the
board (ZONE → ZONES, ZONAL) and don't come back to any of them within 25 s, the Coach
steps in once you've also gone quiet (the "Starter after" delay, or 15 s if starters
are off). It glows the tiles that extend your word and says how to get the rest:
"You found ZONE. 2 more words are related: add the glowing letter or look for a word
inside it." It lapses after 25 s without progress. Relatives found from it don't count
toward your profile.

Hints step up in detail and cost points: pattern cue (−1) → starting tile (−1)
→ shape plus key letters (−1) → full path (−2). Words found with a hint don't count
toward your profile.

## How the Rival adapts

After every round, the game updates an estimate of the share of each board's available
points you usually earn. The coach aims for that share, times a "pressure" factor that
rises 4% after each of your wins and falls 4% after each loss, so matches stay close.
The Relaxed / Even / Tough setting scales the result by 0.85 / 1.0 / 1.15.
The coach prefers common, shorter words (it uses SCOWL commonness tiers) and finds them
gradually over the round, as a person would.

## Layout

- `public/`: the whole app (static files, no build step)
  - `engine.js`: dice, solver, scoring, Rival bot, adaptation (no DOM)
  - `coach.js`: pattern tagging, spotting profile, lessons, hints (no DOM)
  - `app.js`: UI, touch tracing, timer, results
  - `words.txt`: dictionary (built, do not edit by hand)
  - `sw.js`: offline cache. **Bump `VERSION` whenever anything in `public/` changes.**
- `scripts/build_dict.py`: rebuilds `words.txt` from `data/` (ENABLE + SCOWL, gitignored)
- `test/`: `node test/engine.test.mjs && node test/coach.test.mjs`

## Run locally

    cd public && python3 -m http.server 8000

## Word lists

- ENABLE word list (enable1.txt): public domain.
- SCOWL (commonness tiers): see CREDITS.txt for the copyright and permission notice.
