# Word Grid

A Boggle-style word game for iPhone (installable web app), with no ads. Two modes:

- **Mastery**: an untimed board. Find a share of the common words (80% by default), with
  hints only when you ask.
- **Race the Rival**: race a bot that adapts to your level.
- **Free Play**: just you and the clock.

Every mode ends with 2–3 short lessons built from that board. The home screen tracks
your best % completed (share of the board's points found without help) for each board
size and round length, alongside your best score. Tap any word on the
results screen to see its path on the board and its definition (from Wiktionary;
inflections like "plural of bet" also show the base word's meaning).

## Mastery (`mastery.js`)

No timer. The goal is a share of the board's **common** words (Settings → Mastery → Goal:
60/70/80/90%, default 80). With **Long word** on (default), the goal also needs at least
one 6+ letter word. Obscure words are accepted and shown as a bonus but never required.

- Boards are picked to be a real workout: 40–70 common words with at least 2 long ones on
  4×4, 70–120 with at least 5 on 5×5.
- The panel shows progress toward the goal and a word-length ladder (3/4/5/6/7+).
- Leaving a board (✕) saves it; the home screen offers to resume. **Done** ends it.
- "Goal reached!" appears once; you can keep going or finish.

**Hints** come only when you tap Hint, and each tap counts. Each one steps up:
Clue → Starting letters (outlined) → Shape (first/last letters, key letters glowing) →
Show me (the word is revealed with its meaning and counts toward the goal). Clues build on
what you've found first: relatives ("RATE can grow"), anagrams ("Rearrange STOP"), or a
found word inside a longer one ("a 7-letter word with STONE inside it"); then your weak
patterns with a count ("2 words still end in -ING"). Once most short words are found, or
only the long-word requirement is left, hints steer to long words.

Mastery keeps its own spotting profile and history (boards mastered, hints used), and
stays out of the timed stats (Rival skill and pace, best score, best %).

## Coach analysis (`coach.js`)

Each common word on a board is tagged by the pattern that unlocks it: relatives of words
you found, endings (-S, -ING, -ED…), beginnings (RE-, UN-…), letter pairs (TH, ST…), long
words and vowel starts. Each pattern's hit rate is compared with your own overall rate, so
"weak" means weaker than your usual. Timed rounds feed the home screen's "Work on" panel
and the lessons after each round.

## How the Rival adapts

After every round, the game updates an estimate of the share of each board's available
points you usually earn. The coach aims for that share, times a "pressure" factor that
rises 4% after each of your wins and falls 4% after each loss, so matches stay close.
The Relaxed / Even / Tough setting scales the result by 0.85 / 1.0 / 1.15.
The coach prefers common, shorter words (it uses SCOWL commonness tiers) and finds them
gradually over the round, as a person would.

## Settings

All settings live on their own screen (Settings › on the home screen): board size,
round length, Mastery goal and long-word rule, Rival difficulty and Classic rules.

## Layout

- `public/`: the whole app (static files, no build step)
  - `engine.js`: dice, solver, scoring, Rival bot, adaptation (no DOM)
  - `coach.js`: pattern tagging, spotting profile, lessons, hint highlighting (no DOM)
  - `mastery.js`: Mastery boards, progress and goal, hint targeting and steps (no DOM)
  - `define.js`: word definitions from Wiktionary's REST API, cached in localStorage
  - `app.js`: UI, touch tracing, timer, results
  - `words.txt`: dictionary (built, do not edit by hand)
  - `sw.js`: offline support (network-first). **Bump `VERSION` here and `APP_VERSION` in `app.js` whenever anything in `public/` changes.**
- `scripts/build_dict.py`: rebuilds `words.txt` from `data/` (ENABLE + SCOWL, gitignored)
- `test/`: `node test/engine.test.mjs && node test/coach.test.mjs && node test/mastery.test.mjs && node test/define.test.mjs`

## Run locally

    cd public && python3 -m http.server 8000

**Classic rules** (Settings → Rival, off by default): as in real Boggle, words you and
the Rival both find score for neither player. Scores are settled when time runs out;
shared words show struck-through points on the results screen.

## How the Rival stays human

The Rival's points target comes from your skill (above), but its speed is capped by
yours: the game tracks your own words-per-second (finds without help), and the Rival
may find about 25% more words than you, scaled by its level and the Relaxed/Even/Tough
setting, never more than one per second. Each find also takes time to spot and trace
(0.6 s + 0.1 s per letter, ±15%), so it can't burst through a rich board.

## Word lists and definitions

- Definitions: Wiktionary (CC BY-SA), fetched live when you tap a word.

- ENABLE word list (enable1.txt): public domain.
- SCOWL (commonness tiers): see CREDITS.txt for the copyright and permission notice.
