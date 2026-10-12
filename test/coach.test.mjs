import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { buildTrie, solve, generateGame, makeRng } from "../public/engine.js";
import { patternTags, relation, analyzeRound, updateSpotting, hitRate, weakestPatterns,
  buildLessons, strength, focusTiles } from "../public/coach.js";

const trie = buildTrie(readFileSync(new URL("../public/words.txt", import.meta.url), "utf8"));

// Pattern tagging.
assert.deepEqual(patternTags("rates", trie), ["s"]);
assert.ok(patternTags("resting", trie).includes("ing") && patternTags("resting", trie).includes("st"));
assert.ok(patternTags("redo", trie).length === 0); // "do" is too short to count as RE- + word
assert.ok(patternTags("retell", trie).includes("re"));
assert.ok(!patternTags("red", trie).includes("ed")); // stem too short
assert.ok(patternTags("other", trie).includes("vowel") && patternTags("other", trie).includes("th"));

// Relatives.
assert.equal(relation("rate", "rates"), "extend");
assert.equal(relation("grate", "rate"), "extend");
assert.equal(relation("stop", "pots"), "anagram");
assert.equal(relation("stop", "stoop"), null);

// Round analysis + lessons on a real board.
const g = generateGame(4, trie, makeRng(3));
const common = [...g.words].filter(([, v]) => v.tier <= 1).map(([w]) => w);
const found = new Set(common.filter((w) => w.length === 4).slice(0, 4));
const byTag = analyzeRound(g.words, found, new Set(), trie);
assert.equal(byTag.all.found.length, found.size);
const spot = updateSpotting({}, byTag);
assert.ok(spot.all.seen === common.length);
const lessons = buildLessons(g.words, found, byTag, spot);
console.log("board:", g.board.join(" "), "| found:", [...found].join(", "));
for (const l of lessons) console.log(` [${l.kind}] ${l.title}: ${l.text}\n    -> ${l.words.join(", ")}`);
assert.ok(lessons.length >= 1);
for (const l of lessons) for (const w of l.words) assert.ok(g.words.has(w) && !found.has(w));

// Assisted finds don't count as hits.
const assisted = analyzeRound(g.words, found, found, trie);
assert.equal(assisted.all.found.length, 0);

// Weakness is relative to the player's own overall rate.
const round = (counts) => Object.fromEntries(Object.entries(counts).map(([tag, [hit, n]]) =>
  [tag, { found: Array(hit).fill("w"), missed: Array(n - hit).fill("w") }]));
let even = {};
for (let i = 0; i < 5; i++) even = updateSpotting(even, round({ all: [4, 20], ing: [1, 5], long: [1, 5], s: [1, 5] }));
assert.deepEqual(weakestPatterns(even), []); // 20% everywhere: nothing stands out

let short = {}, long = {};
for (let i = 0; i < 5; i++) {
  short = updateSpotting(short, round({ all: [2, 20], ing: [1, 10] })); // 90s round: 10% overall
  long = updateSpotting(long, round({ all: [8, 20], ing: [4, 10] }));  // 180s round: 40% overall
}
assert.ok(Math.abs(strength(short, "ing") - strength(long, "ing")) < 0.1, "same relative skill, any round length");

let weak = {};
for (let i = 0; i < 5; i++) weak = updateSpotting(weak, round({ all: [8, 40], ing: [0, 8], long: [1, 6], s: [2, 10] }));
assert.equal(weakestPatterns(weak)[0].tag, "ing");
assert.ok(hitRate(weak, "ing") < hitRate(weak, "s"));

// Profiles saved before `expected` existed start fresh instead of misreading.
assert.equal(strength({ ing: { seen: 10, hit: 1 } }, "ing"), 1);

// Hint highlighting uses the target's own path.
const board = ["r","a","t","e", "x","x","x","s", "x","x","x","x", "x","x","x","x"];
const words = solve(board, trie, 3);
assert.deepEqual(focusTiles({ word: "rates", focus: "family", root: "rate" }, board, words.get("rates").path), [0, 1, 2, 3]);
assert.deepEqual(focusTiles({ word: "rates", focus: "s" }, board, words.get("rates").path), [7]);
// PIE from the player's screenshot: PIES runs through the *other* E (tile 9), so that's what glows.
const pieBoard = ["u","n","y","w", "p","i","e","h", "y","e","b","d", "i","t","s","n"];
const pieWords = solve(pieBoard, trie, 3);
assert.deepEqual(focusTiles({ word: "pies", focus: "family", root: "pie" }, pieBoard, pieWords.get("pies").path), [4, 5, 9]);
// "Contains": the found word's tiles inside a longer word.
assert.deepEqual(focusTiles({ word: "ab" + "rate" + "s", focus: "contains", root: "rate" }, ["a","b","r","a","t","e","s"], [0,1,2,3,4,5,6]), [2, 3, 4, 5]);
console.log("coach tests passed");