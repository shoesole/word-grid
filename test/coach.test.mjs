import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { buildTrie, solve, generateGame, makeRng } from "../public/engine.js";
import { patternTags, relation, analyzeRound, updateSpotting, hitRate, weakestPatterns,
  buildLessons, pickHintTarget, hintStep, strength } from "../public/coach.js";

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

// Hints: target is unfound and common; steps escalate and the last shows the full path.
const target = pickHintTarget(g.words, found, spot, trie, makeRng(1));
assert.ok(!found.has(target.word) && g.words.get(target.word).tier <= 1);
const path = g.words.get(target.word).path;
const steps = [0, 1, 2, 3].map((lv) => hintStep(target, lv, g.board, path));
console.log("hint target:", target.word, `(${target.focus}${target.root ? ", root " + target.root : ""})`);
steps.forEach((s, i) => console.log(`  L${i} -${s.cost}: ${s.msg}`, s.glow.length ? `glow ${s.glow}` : ""));
assert.equal(steps[1].pulse[0], path[0]);
assert.deepEqual(steps[3].guide, path);

// Family hint for an extension highlights the root's tiles.
const board = ["r","a","t","e", "x","x","x","s", "x","x","x","x", "x","x","x","x"];
const words = solve(board, trie, 3);
const t2 = { word: "rates", focus: "family", root: "rate" };
assert.match(hintStep(t2, 0, board, words.get("rates").path).msg, /RATE has a relative/);
assert.deepEqual(hintStep(t2, 2, board, words.get("rates").path).glow, [0, 1, 2, 3]);

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
console.log("coach tests passed");
