import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { buildTrie, solve, generateGame, makeRng } from "../public/engine.js";
import { patternTags, relation, analyzeRound, updateSpotting, hitRate, weakestPatterns,
  buildLessons, pickHintTarget, hintStep, strength,
  pickStarter, starterLetters, starterMessage, unfoundRelatives, familyHint } from "../public/coach.js";

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
// Starters: an opening shared by several unfound words; extending narrows to 3 tiles.
const st = pickStarter(g.words, found, spot, trie, { rng: makeRng(2) });
assert.equal(st.tiles.length, 2);
for (const w of st.words) {
  assert.deepEqual(g.words.get(w).path.slice(0, 2), st.tiles);
  assert.ok(!found.has(w));
}
const st3 = pickStarter(g.words, found, spot, trie, { tiles: 3, within: st, rng: makeRng(2) });
if (st3) {
  assert.deepEqual(st3.tiles.slice(0, 2), st.tiles);
  assert.ok(st3.words.every((w) => st.words.includes(w)));
}
console.log("starter:", starterMessage(g.board, st, found), st.words.join(", "),
  st3 ? `| then ${starterLetters(g.board, st3)}: ${st3.words.join(", ")}` : "");
// Hints can be limited to the starter's words.
const limited = pickHintTarget(g.words, found, spot, trie, makeRng(1), new Set(st.words));
assert.ok(st.words.includes(limited.word));
// SH on a hand-built board: S-H begins SHE, SHOE, SHOT... (tiles 0,1).
const shBoard = ["s","h","o","t", "x","e","x","x", "x","x","x","x", "x","x","x","x"];
const shWords = solve(shBoard, trie, 3);
const sh = pickStarter(shWords, new Set(), {}, trie, { rng: makeRng(1) });
assert.equal(starterLetters(shBoard, sh), "SH");
// Family reminders: unfound common relatives of a found word.
const rb = ["r","a","t","e", "x","x","x","s", "x","x","x","x", "x","x","x","x"];
const rw = solve(rb, trie, 3);
const rel = unfoundRelatives("rate", rw, new Set(["rate"]));
assert.ok(rel.includes("rates") && !rel.includes("rate"), rel.join());
// RODE on the board from the player's screenshot: ERODE extends it at the E beside the R.
const rodeBoard = ["h","a","w","x", "w","h","t","k", "o","r","o","e", "n","e","i","d"];
const rodeWords = solve(rodeBoard, trie, 3);
const rodeRel = unfoundRelatives("rode", rodeWords, new Set(["rode"]));
const fh = familyHint("rode", rodeRel, rodeWords, new Set(["rode"]), rodeBoard);
console.log("family:", rodeRel.join(", "), "->", fh.msg, "glow", fh.extendTiles);
assert.ok(rodeRel.includes("erode"));
assert.ok(fh.extendTiles.includes(13)); // the E below-left of R
assert.match(fh.msg, /^You found RODE\. \d+ more words are related: .*glowing letter/);
assert.ok(!fh.extendTiles.some((i) => rodeWords.get("rode").path.includes(i)));
assert.deepEqual(fh.altTiles, []); // ERODE extends the very tiles used

// PIE from the player's screenshot: PIES and PIETY need the *other* E (below the I).
const pieBoard = ["u","n","y","w", "p","i","e","h", "y","e","b","d", "i","t","s","n"];
const pieWords = solve(pieBoard, trie, 3);
const pieFound = new Set(["piney","pied","pin","set","ties","bets","bet","tie","yet","pie"]);
const pieWordsPath = { ...pieWords.get("pie") };
pieWords.set("pie", { ...pieWordsPath, path: [4, 5, 6] }); // the tracing the player used
const pie = familyHint("pie", unfoundRelatives("pie", pieWords, pieFound), pieWords, pieFound, pieBoard);
console.log("family:", pie.msg, "glow", pie.extendTiles, "outline", pie.altTiles);
assert.deepEqual(pie.altTiles, [9]);
assert.deepEqual([...pie.extendTiles].sort((a, b) => a - b), [13, 14]);
assert.match(pie.msg, /Trace PIE through the outlined E first\.$/);
console.log("coach tests passed");
