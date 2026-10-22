// Mastery mode: an untimed board where the goal is to find a share of the common
// words, with hints only on request. No DOM access, so it runs in node tests too.

import { MODES, solve, rollBoard } from "./engine.js";
import { patternTags, relation, strength, focusTiles, TAGS, TEACHABLE_TIER } from "./coach.js";

// Boards that are a real workout but still finishable.
const BANDS = {
  4: { minCommon: 40, maxCommon: 70, minLong: 2 },
  5: { minCommon: 70, maxCommon: 120, minLong: 5 },
};
export const LONG = 6; // letters that count as a "long word"

const isCommon = (v) => v.tier <= TEACHABLE_TIER;

export function generateMasteryBoard(sizeKey, trie, rng = Math.random) {
  const band = BANDS[sizeKey];
  const { minLen } = MODES[sizeKey];
  let best = null;
  for (let attempt = 0; attempt < 400; attempt++) {
    const board = rollBoard(sizeKey, rng);
    const words = solve(board, trie, minLen);
    let common = 0, long = 0;
    for (const [w, v] of words) if (isCommon(v)) { common++; if (w.length >= LONG) long++; }
    const fits = common >= band.minCommon && common <= band.maxCommon && long >= band.minLong;
    if (fits) return { board, words };
    // Fallback: the board closest to the band.
    const miss = Math.max(0, band.minCommon - common) + Math.max(0, common - band.maxCommon) + 10 * Math.max(0, band.minLong - long);
    if (!best || miss < best.miss) best = { board, words, miss };
  }
  return { board: best.board, words: best.words };
}

// Length buckets for the ladder: 3/4/5/6/7+ on 4×4, 4/5/6/7+ on 5×5.
function bucketOf(word, minLen) {
  return Math.min(Math.max(word.length, minLen), 7);
}

// Everything the progress display and goal check need. The target is set by the
// board's common words, but every word you find counts toward it, uncommon ones too
// (`bonus` is how many of your finds are uncommon). So `found` can pass `total`.
export function masteryStats(words, foundSet, { goalPct, longReq, minLen }) {
  let total = 0, found = 0, bonus = 0, longTotal = 0, longFound = 0;
  const ladder = new Map();
  for (let n = minLen; n <= 7; n++) ladder.set(n, { label: n === 7 ? "7+" : String(n), found: 0, total: 0, left: 0 });
  for (const [w, v] of words) {
    const has = foundSet.has(w);
    const common = isCommon(v);
    if (!common && !has) continue;
    const b = ladder.get(bucketOf(w, minLen));
    if (has) { found++; b.found++; if (!common) bonus++; }
    if (common) { total++; b.total++; if (!has) b.left++; }
    if (w.length >= LONG) { if (common) longTotal++; if (has) longFound++; }
  }
  const goalCount = Math.ceil(goalPct * total);
  const longMet = !longReq || longTotal === 0 || longFound > 0;
  return {
    total, found, bonus, goalCount, longMet,
    pct: total ? found / total : 0,
    countMet: found >= goalCount,
    goalMet: found >= goalCount && longMet,
    ladder: [...ladder.values()].filter((b) => b.total > 0 || b.found > 0),
  };
}

// Short words mostly done, or the long-word requirement is all that's left:
// time to steer hints toward long words.
export function shouldPreferLong(words, foundSet, stats) {
  if (stats.countMet && !stats.longMet) return true;
  let short = 0, shortFound = 0;
  for (const [w, v] of words) {
    if (!isCommon(v) || w.length > 5) continue;
    short++;
    if (foundSet.has(w)) shortFound++;
  }
  return short > 0 && shortFound / short >= 0.7;
}

const weakness = (spot, tag) => Math.max(0, 1.2 - Math.min(strength(spot, tag), 1.2));

// A found word (4+ letters) sitting inside a longer unfound word, not at an end
// (ends are "relatives"): STONE inside ASTONED.
function containingRoot(word, foundSet) {
  let best = null;
  for (const f of foundSet) {
    if (f.length < 4 || word.length < f.length + 2 || !word.includes(f) || relation(word, f)) continue;
    if (!best || f.length > best.length) best = f;
  }
  return best;
}

// The word the next hint is about. Prefers words you can reach from what you've
// already found (relatives, words containing yours), then your weak patterns,
// then long words when it's time for them.
export function pickMasteryTarget(words, foundSet, spot, trie, { preferLong = false } = {}, rng = Math.random) {
  let best = null;
  for (const [word, v] of words) {
    if (!isCommon(v) || foundSet.has(word)) continue;
    let root = null, focus = null, fromYours = 0;
    for (const f of foundSet) {
      if (relation(word, f) && (!root || f.length > root.length)) root = f;
    }
    if (root) { focus = "family"; fromYours = 0.6; }
    else if (word.length >= LONG && (root = containingRoot(word, foundSet))) { focus = "contains"; fromYours = 0.5; }
    else {
      const tags = patternTags(word, trie);
      focus = tags.length ? tags.reduce((a, b) => (weakness(spot, b) > weakness(spot, a) ? b : a)) : null;
    }
    const lengthFit = preferLong ? (word.length >= LONG ? 1 : 0) : (word.length >= 4 && word.length <= 6 ? 0.2 : 0);
    const score = 0.3 + fromYours + (focus && focus !== "family" && focus !== "contains" ? weakness(spot, focus) * 0.5 : 0)
      + lengthFit + rng() * 0.2;
    if (!best || score > best.score) best = { word, focus, root, score };
  }
  return best;
}

export const HINT_STEPS = ["Clue", "Starting letters", "Shape", "Show me"];

function remainingWith(tag, words, foundSet, trie) {
  let n = 0;
  for (const [w, v] of words) if (isCommon(v) && !foundSet.has(w) && patternTags(w, trie).includes(tag)) n++;
  return n;
}

// What hint step `level` (0–3) shows for the target.
//   0 Clue: built from your words or a pattern, with how many are left
//   1 Starting letters: the first two tiles outlined
//   2 Shape: first and last letters, key letters glowing
//   3 Show me: the word is revealed (the caller adds it as found-with-help)
export function masteryHint(target, level, board, path, words, foundSet, trie) {
  const { word, focus, root } = target;
  const n = word.length;
  const W = (s) => s.toUpperCase();
  if (level === 0) {
    let msg = `There's a ${n}-letter word you haven't found.`;
    if (focus === "family" && root) {
      const kind = relation(word, root);
      msg = kind === "anagram" ? `Rearrange ${W(root)}.`
        : word.length > root.length ? `${W(root)} can grow. Add letters to one end.`
        : `There's a shorter word hiding inside ${W(root)}.`;
    } else if (focus === "contains" && root) {
      msg = `There's a ${n}-letter word with ${W(root)} inside it.`;
    } else if (focus) {
      const left = remainingWith(focus, words, foundSet, trie);
      const label = TAGS[focus];
      const many = left !== 1;
      if (["ing", "ed", "er", "est", "ly"].includes(focus)) msg = `${many ? `${left} words still end` : "One word still ends"} in ${label}.`;
      else if (label.endsWith("-")) msg = `${many ? `${left} words still start` : "One word still starts"} with ${label}.`;
      else if (focus === "s") msg = `${many ? `${left} plurals or -S words are` : "One plural or -S word is"} still out there.`;
      else if (focus === "long") msg = `There's a ${n}-letter word still out there.`;
      else if (focus === "vowel") msg = `There's a ${n}-letter word starting on a vowel.`;
      else msg = `${many ? `${left} words with` : "One word with"} ${label} ${many ? "are" : "is"} still out there.`;
    }
    return { msg, starter: [], glow: [], guide: [], reveal: false };
  }
  if (level === 1) {
    return { msg: `It starts with these letters and has ${n} letters.`, starter: path.slice(0, 2), glow: [], guide: [], reveal: false };
  }
  if (level === 2) {
    const shape = W(word[0]) + " _".repeat(n - 2) + " " + W(word[n - 1]);
    return { msg: `Shape: ${shape}`, starter: path.slice(0, 1), glow: focusTiles(target, board, path), guide: [], reveal: false };
  }
  return { msg: `Here it is: ${W(word)}.`, starter: [], glow: [], guide: path.slice(), reveal: true };
}
