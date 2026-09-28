import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { buildTrie, solve, scoreWord, generateGame, planBot, makeRng, totalPoints,
  DEFAULT_PROFILE, updateProfile, botSkill, isAdjacent } from "../public/engine.js";

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

// Adaptation: a player who keeps winning pushes the bot up.
let p = DEFAULT_PROFILE;
const s0 = botSkill(p, 4);
for (let i = 0; i < 6; i++) p = updateProfile(p, { sizeKey: 4, playerPoints: 60, available: 400, result: "win" });
assert.ok(botSkill(p, 4) > s0);
console.log(`bot skill ${s0.toFixed(3)} -> ${botSkill(p, 4).toFixed(3)} after 6 wins at 15%`);
// Round length: shorter rounds mean a lower target, and learning is length-neutral.
assert.ok(botSkill(DEFAULT_PROFILE, 4, "even", 90) < botSkill(DEFAULT_PROFILE, 4, "even", 180));
const q90 = updateProfile(DEFAULT_PROFILE, { sizeKey: 4, durationSec: 90, playerPoints: 12, available: 100, result: null });
const q180 = updateProfile(DEFAULT_PROFILE, { sizeKey: 4, durationSec: 180, playerPoints: 12, available: 100, result: null });
assert.ok(q90.skill[4] > q180.skill[4]); // same points in less time = more skilled
console.log("all tests passed");
