import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { buildTrie, solve, makeRng, MODES } from "../public/engine.js";
import { generateMasteryBoard, masteryStats, shouldPreferLong, pickMasteryTarget, masteryHint, LONG } from "../public/mastery.js";

const trie = buildTrie(readFileSync(new URL("../public/words.txt", import.meta.url), "utf8"));
const common = (words) => [...words].filter(([, v]) => v.tier <= 1).map(([w]) => w);

// Boards land in the band: meaty but finishable, with long words to find.
for (const [size, lo, hi, minLong] of [[4, 40, 70, 2], [5, 70, 120, 5]]) {
  const t = Date.now();
  for (let seed = 1; seed <= 15; seed++) {
    const { board, words } = generateMasteryBoard(size, trie, makeRng(seed));
    const c = common(words);
    assert.ok(c.length >= lo && c.length <= hi, `${size}x${size} seed ${seed}: ${c.length} common`);
    assert.ok(c.filter((w) => w.length >= LONG).length >= minLong);
    assert.equal(board.length, size * size);
  }
  console.log(`${size}x${size} mastery boards OK, ${Math.round((Date.now() - t) / 15)}ms each`);
}

// Goal math: common words only, ceil(goal × total), long-word rule, obscure words as bonus.
const { words } = generateMasteryBoard(4, trie, makeRng(4));
const c = common(words);
const shortC = c.filter((w) => w.length < LONG), longC = c.filter((w) => w.length >= LONG);
const opts = { goalPct: 0.8, longReq: true, minLen: 3 };
const goal = Math.ceil(0.8 * c.length);
let found = new Set(shortC.slice(0, goal));
let st = masteryStats(words, found, opts);
assert.equal(st.total, c.length);
assert.equal(st.goalCount, goal);
if (shortC.length >= goal) {
  assert.ok(st.countMet && !st.longMet && !st.goalMet, "count met but no long word yet");
  assert.ok(shouldPreferLong(words, found, st), "hints should steer to long words");
  const tgt = pickMasteryTarget(words, found, {}, trie, { preferLong: true }, makeRng(1));
  assert.ok(tgt.word.length >= LONG, `long target, got ${tgt.word}`);
}
found = new Set([...shortC.slice(0, goal - 1), longC[0]]);
st = masteryStats(words, found, opts);
assert.ok(st.goalMet && st.longMet);
assert.ok(masteryStats(words, new Set(shortC.slice(0, goal)), { ...opts, longReq: false }).goalMet, "long rule off");
const rare = [...words].find(([, v]) => v.tier > 1)?.[0];
if (rare) assert.equal(masteryStats(words, new Set([rare]), opts).bonus, 1);
const ladderTotal = st.ladder.reduce((a, b) => a + b.total, 0);
assert.equal(ladderTotal, c.length);
console.log("ladder:", st.ladder.map((b) => `${b.label}:${b.found}/${b.total}`).join(" "));

// Hints build on your words first: a relative of a found word is preferred.
const rb = ["r","a","t","e", "g","x","x","s", "x","x","x","x", "x","x","x","x"];
const rw = solve(rb, trie, 3);
const t1 = pickMasteryTarget(rw, new Set(["rate"]), {}, trie, {}, makeRng(2));
assert.equal(t1.focus, "family");
assert.equal(t1.root, "rate");
const steps = [0, 1, 2, 3].map((lv) => masteryHint(t1, lv, rb, rw.get(t1.word).path, rw, new Set(["rate"]), trie));
console.log(`target ${t1.word}:`, steps.map((s) => s.msg).join(" | "));
assert.match(steps[0].msg, /RATE/);
assert.deepEqual(steps[1].starter, rw.get(t1.word).path.slice(0, 2));
assert.ok(steps[2].msg.startsWith("Shape:"));
assert.ok(steps[3].reveal);
assert.deepEqual(steps[3].guide, rw.get(t1.word).path);

// "Contains" clue: a found 4+ letter word inside a longer word (not at an end).
const cb = ["x","s","t","o", "x","x","x","n", "x","x","e","x", "x","x","x","x"]; // made-up shape test
const fakeWords = new Map([["stone", { tier: 0, path: [1,2,3,7,10] }], ["astoned", { tier: 1, path: [0,1,2,3,7,10,11] }]]);
const t2 = pickMasteryTarget(fakeWords, new Set(["stone"]), {}, trie, {}, makeRng(1));
assert.equal(t2.focus, "contains");
assert.match(masteryHint(t2, 0, cb, fakeWords.get("astoned").path, fakeWords, new Set(["stone"]), trie).msg, /7-letter word with STONE inside it/);
// Short roots (3 letters) don't trigger "contains", or ATE would match everything.
const t3 = pickMasteryTarget(new Map([["donated", { tier: 1, path: [0,1,2,3,4,5,6] }]]), new Set(["ate"]), {}, trie, {}, makeRng(1));
assert.notEqual(t3.focus, "contains");

// Pattern clues give a count of what's left.
const ingWords = new Map([["sing", { tier: 0, path: [0,1,2,3] }], ["ringing", { tier: 0, path: [4,5,6,7,8,9,10] }], ["singing", { tier: 0, path: [0,1,2,3,8,9,10] }]]);
const msg = masteryHint({ word: "singing", focus: "ing", root: null }, 0, Array(16).fill("x"), [0,1,2,3,8,9,10], ingWords, new Set(), trie).msg;
assert.match(msg, /^2 words still end in -ING\.$/, msg); // SING itself doesn't count: "s" isn't a stem

// Nothing left to hint at.
assert.equal(pickMasteryTarget(new Map([["yare", { tier: 2, path: [0, 1, 2, 3] }]]), new Set(), {}, trie), null);
console.log("mastery tests passed");
