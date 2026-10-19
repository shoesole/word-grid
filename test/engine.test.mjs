import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { buildTrie, solve, scoreWord, generateGame, planBot, makeRng, totalPoints,
  DEFAULT_PROFILE, updateProfile, isAdjacent, rivalRate, rivalSkill, LADDER,
  getLadder, freshLadder, updateLadder, ladderProgress, placementLevel } from "../public/engine.js";

const t0 = Date.now();
const trie = buildTrie(readFileSync(new URL("../public/words.txt", import.meta.url), "utf8"));
console.log(`trie: ${trie.count} words in ${Date.now() - t0}ms`);

// Hand-checked board: c-a-t-s along the top row, plus t-a-x dipping into row 2.
const b1 = ["c","a","t","s", "x","x","x","x", "x","x","x","x", "x","x","x","x"];
assert.deepEqual([...solve(b1, trie, 3).keys()].sort(), ["cat", "cats", "tax"]);

// Qu tile counts as two letters but one tile; tiles can't be reused.
const b2 = ["qu","i","t","e", "x","x","x","x", "x","x","x","x", "x","x","x","x"];
const w2 = solve(b2, trie, 3);
assert.ok(w2.has("quit") && w2.has("quite"), [...w2.keys()].join());
assert.deepEqual(w2.get("quit").path, [0, 1, 2]);
const b3 = ["t","o","x","x", "x","x","x","x", "x","x","x","x", "x","x","x","x"];
assert.ok(!solve(b3, trie, 3).has("toot")); // would need to reuse tiles

assert.equal(isAdjacent(4, 0, 5), true);
assert.equal(isAdjacent(4, 3, 4), false); // row wrap is not adjacent
assert.deepEqual(["cat","cats","house","houses","general","generals"].map(scoreWord), [1,1,2,3,5,11]);

// Generated boards should be playable and the bot should land near its target.
const rng = makeRng(42);
for (const size of [4, 5]) {
  let t = Date.now(), sumWords = 0, sumPts = 0, sumBot = 0, n = 20;
  for (let i = 0; i < n; i++) {
    const g = generateGame(size, trie, rng);
    const avail = totalPoints(g.words.keys());
    const plan = planBot(g.words, 0.1, 180, rng);
    sumWords += g.words.size; sumPts += avail; sumBot += totalPoints(plan.map(p => p.word)) / avail;
    for (let k = 1; k < plan.length; k++) assert.ok(plan[k].at >= plan[k-1].at);
  }
  console.log(`${size}x${size}: avg ${Math.round(sumWords/n)} words, ${Math.round(sumPts/n)} pts, ` +
    `bot frac@0.10=${(sumBot/n).toFixed(3)}, ${Math.round((Date.now()-t)/n)}ms/game`);
}

// Sample bot words at a casual skill level: should look like normal words.
const g = generateGame(4, trie, makeRng(7));
console.log("board:", g.board.join(" "));
console.log("bot words:", planBot(g.words, 0.1, 180, makeRng(1)).map(p => p.word).join(", "));

// Round length: shorter rounds mean a lower target.
assert.ok(rivalSkill(12, 4, "even", 90) < rivalSkill(12, 4, "even", 180));
const q90 = updateProfile(DEFAULT_PROFILE, { sizeKey: 4, durationSec: 90, playerPoints: 12, available: 100, result: null });
const q180 = updateProfile(DEFAULT_PROFILE, { sizeKey: 4, durationSec: 180, playerPoints: 12, available: 100, result: null });
assert.ok(q90.skill[4] > q180.skill[4]); // same points in less time = more skilled
// Human pacing: word cap from maxRate, and realistic gaps between finds.
const rich = generateGame(5, trie, makeRng(5));
const paced = planBot(rich.words, 0.9, 120, makeRng(3), { maxRate: 0.3 });
assert.ok(paced.length <= 36, `${paced.length} words`);
const fast = planBot(rich.words, 0.9, 120, makeRng(3), { maxRate: 5 });
assert.ok(fast[0].at >= 1.5);
for (let k = 1; k < fast.length; k++) {
  assert.ok(fast[k].at - fast[k - 1].at >= (0.6 + 0.1 * fast[k].word.length) * 0.85 - 1e-9, "gap too short");
}
assert.ok(fast.every((p) => p.at <= 119.5));
// Speed is fixed per level, rises with level, and never tops 1 word/sec.
assert.ok(rivalRate(20) > rivalRate(10));
assert.equal(rivalRate(40, "tough"), 1);

// ---------- Ladder ----------
const W = { result: "win", you: 20, rival: 18 }, L = { result: "loss", you: 15, rival: 20 };
const T = { result: "tie", you: 15, rival: 15 }, BIG = { result: "win", you: 40, rival: 15 };
const play = (lad, ...games) => { let total = 0; for (const g of games) { const r = updateLadder(lad, g); lad = r.ladder; total += r.change; } return { lad, total }; };
const settled = { level: 15, games: [], since: 0, run: 0, placement: 0 };

// One win does nothing; a loss right after doesn't knock you down.
let r = play(settled, W);
assert.equal(r.total, 0);
r = play(r.lad, L);
assert.equal(r.total, 0);
assert.equal(r.lad.level, 15);
// 3 of 5 (60%) promotes, and the record starts over at the new level.
r = play(settled, W, L, W, L, W);
assert.equal(r.total, 1);
assert.deepEqual(r.lad.games, []);
// 2 of 5 doesn't; ties count half (W W T L L = 2.5/5 = 50%).
assert.equal(play(settled, W, L, W, L, L).total, 0);
assert.equal(play(settled, W, W, T, L, L).total, 0);
// Three blowouts in a row skip a level (+2) on the 3rd.
r = play(settled, BIG, BIG);
assert.equal(r.total, 0);
assert.equal(play(r.lad, BIG).total, 2);
// A blowout run broken by a close win doesn't count as a run, and 3 games is under the 5-game minimum.
assert.equal(play(settled, BIG, BIG, W).total, 0);
// Slump: no drop until 8 games at the level, then only one level at ≤25%.
r = play(settled, L, L, L, L, L, L, L);
assert.equal(r.total, 0, "7 straight losses: still no drop");
r = play(r.lad, L);
assert.equal(r.total, -1);
assert.equal(r.lad.level, 14);
// 3 wins in 8 (37.5%) is not a slump.
assert.equal(play(settled, W, L, L, W, L, L, W, L).total, 0);
// Placement: first 5 games move 2 levels at a time, either way.
const newbie = freshLadder(DEFAULT_PROFILE, 4);
assert.equal(newbie.placement, 5);
r = play(newbie, W, W, L);
assert.equal(r.lad.level, newbie.level + 2);
assert.equal(r.lad.placement, 2);
// Levels stay within 1–40.
assert.equal(play({ ...settled, level: 1 }, ...Array(8).fill(L)).lad.level, 1);
// Progress: wins needed to level up.
assert.equal(ladderProgress(play(settled, W).lad).toPromote, 2); // W + L L W W = 3 of 5
assert.equal(ladderProgress(play(settled, W, L).lad).toPromote, 2); // W L + L W W
// Promotion happens on a win: W W W L then L is 3 of 5, but no promotion until the next win.
r = play(settled, W, W, W, L, L);
assert.equal(r.total, 0);
assert.equal(play(r.lad, W).total, 1);
const pr = ladderProgress(play(settled, W, W, L).lad);
assert.deepEqual([pr.wins, pr.losses, pr.toPromote], [2, 1, 1]); // W W L + L W
// Existing players carry over: placement starts at their old Rival strength, no placement games.
const veteran = { ...DEFAULT_PROFILE, skill: { 4: 0.15, 5: 0.08 }, pressure: 1.1,
  history: Array.from({ length: 12 }, () => ({ sizeKey: 4, result: "win" })) };
const vl = getLadder(veteran, 4);
assert.equal(vl.placement, 0);
assert.ok(vl.level > placementLevel(DEFAULT_PROFILE, 4), `veteran level ${vl.level}`);
assert.equal(getLadder(veteran, 5).placement, 5); // never played 5x5
console.log(`ladder OK; veteran placed at level ${vl.level}`);
console.log("all tests passed");
