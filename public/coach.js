// Training coach: classifies words by the pattern that unlocks them, tracks the
// player's hit rate per pattern, builds post-round lessons and picks hints.
// No DOM access, so it runs in node tests too.

import { scoreWord } from "./engine.js";

// Patterns we teach. Labels read as "<n> words with ___" / "Work on ___".
export const TAGS = {
  family: "relatives of words you found",
  s: "plurals and -S",
  ing: "-ING", ed: "-ED", er: "-ER", est: "-EST", ly: "-LY",
  re: "RE-", un: "UN-", de: "DE-", dis: "DIS-", out: "OUT-", over: "OVER-", pre: "PRE-",
  th: "TH", ch: "CH", sh: "SH", st: "ST", ck: "CK", ph: "PH", wh: "WH", qu: "QU",
  long: "6+ letter words",
  vowel: "vowel starts",
};
const SUFFIXES = ["ing", "est", "ed", "er", "ly"];
const PREFIXES = ["over", "dis", "out", "pre", "re", "un", "de"];
const DIGRAPHS = ["th", "ch", "sh", "st", "ck", "ph", "wh", "qu"];

// Patterns so broad they teach less; they need a bigger gap to win a lesson.
const BROAD = { vowel: 0.4, long: 0.6 };

// Only words most people know are worth teaching; obscure ones stay optional.
export const TEACHABLE_TIER = 1;

export function isWord(trie, w) {
  let node = trie;
  for (const ch of w) {
    node = node.k[ch];
    if (!node) return false;
  }
  return node.t !== undefined;
}

const sorted = (w) => [...w].sort().join("");

// "Relatives": one word is the other plus letters on either end (RATE/RATES/GRATE),
// or the two are anagrams (STOP/POTS).
export function relation(a, b) {
  if (a === b) return null;
  if (a.length !== b.length) {
    const [short, long] = a.length < b.length ? [a, b] : [b, a];
    if (long.startsWith(short) || long.endsWith(short)) return "extend";
    return null;
  }
  return sorted(a) === sorted(b) ? "anagram" : null;
}

// Pattern tags for a word, independent of what the player found.
export function patternTags(word, trie) {
  const tags = [];
  for (const suf of SUFFIXES) {
    if (word.endsWith(suf) && word.length - suf.length >= 3) { tags.push(suf); break; }
  }
  if (word.endsWith("s") && !word.endsWith("ss") && isWord(trie, word.slice(0, -1))) tags.push("s");
  for (const pre of PREFIXES) {
    const rest = word.slice(pre.length);
    if (word.startsWith(pre) && rest.length >= 3 && isWord(trie, rest)) { tags.push(pre); break; }
  }
  for (const d of DIGRAPHS) if (word.includes(d)) tags.push(d);
  if (word.length >= 6) tags.push("long");
  if (/^[aeiou]/.test(word)) tags.push("vowel");
  return tags;
}

function relativesIn(word, pool) {
  const out = [];
  for (const other of pool) if (relation(word, other)) out.push(other);
  return out;
}

// Break a finished round down by pattern. `assisted` words (found with a hint)
// count as available but not as independent finds.
export function analyzeRound(words, foundSet, assisted, trie) {
  const byTag = {};
  const add = (tag, word, hit) => {
    const t = byTag[tag] || (byTag[tag] = { found: [], missed: [] });
    (hit ? t.found : t.missed).push(word);
  };
  for (const [word, { tier }] of words) {
    if (tier > TEACHABLE_TIER) continue;
    const hit = foundSet.has(word) && !assisted.has(word);
    const tags = patternTags(word, trie);
    const others = [...foundSet].filter((f) => f !== word);
    if (relativesIn(word, others).length) tags.push("family");
    add("all", word, hit);
    for (const tag of tags) add(tag, word, hit);
  }
  return byTag;
}

// Rolling per-pattern stats. Older rounds fade out so recent play matters most.
// `expected` is how many finds the player's overall rate that round predicted for the
// pattern, so hit/expected measures the pattern against the player's own norm. That
// keeps hard patterns, short rounds and big boards from all looking like weaknesses.
const WINDOW = 80;
export function updateSpotting(spot, byTag) {
  const next = { ...spot };
  const all = byTag.all;
  const allCount = all ? all.found.length + all.missed.length : 0;
  const roundRate = allCount ? all.found.length / allCount : 0;
  for (const [tag, { found, missed }] of Object.entries(byTag)) {
    const prev = next[tag];
    const s = prev && prev.expected !== undefined ? { ...prev } : { seen: 0, hit: 0, expected: 0 };
    const count = found.length + missed.length;
    s.seen += count;
    s.hit += found.length;
    s.expected += count * roundRate;
    if (s.seen > WINDOW) {
      const k = WINDOW / s.seen;
      s.seen *= k;
      s.hit *= k;
      s.expected *= k;
    }
    next[tag] = s;
  }
  return next;
}

// Smoothed absolute hit rate; unknown patterns sit at 0.5.
export function hitRate(spot, tag) {
  const s = spot?.[tag];
  return s ? (s.hit + 1) / (s.seen + 2) : 0.5;
}

// Hit rate relative to the player's own overall rate: 1 = typical for you,
// below 1 = a weak spot. Unknown patterns sit at 1.
const PRIOR = 2;
export function strength(spot, tag) {
  const s = spot?.[tag];
  if (!s || s.expected === undefined) return 1;
  return (s.hit + PRIOR) / (s.expected + PRIOR);
}

// Patterns the player misses more than usual, once there's enough evidence.
export function weakestPatterns(spot, n = 3, minSeen = 6) {
  return Object.keys(TAGS)
    .filter((tag) => (spot?.[tag]?.seen ?? 0) >= minSeen && strength(spot, tag) < 0.9)
    .map((tag) => ({ tag, label: TAGS[tag], rate: hitRate(spot, tag), strength: strength(spot, tag) }))
    .sort((a, b) => a.strength - b.strength)
    .slice(0, n);
}

// How much a pattern needs work, 0 (a strength) to ~1 (never spotted).
const need = (spot, tag) => Math.max(0, 1.2 - Math.min(strength(spot, tag), 1.2));

const byValue = (a, b) => scoreWord(b) - scoreWord(a) || a.localeCompare(b);

// Two or three short, specific takeaways from the round just played.
export function buildLessons(words, foundSet, byTag, spot) {
  const lessons = [];
  const shown = new Set();
  const teachable = [...words.entries()].filter(([, v]) => v.tier <= TEACHABLE_TIER).map(([w]) => w);
  const missed = teachable.filter((w) => !foundSet.has(w));

  // 1. Word family: the found word with the most missed relatives.
  let bestRoot = null, bestRel = [];
  for (const f of foundSet) {
    const rel = relativesIn(f, missed);
    if (rel.length > bestRel.length) { bestRoot = f; bestRel = rel; }
  }
  if (bestRel.length >= 2) {
    const list = bestRel.sort(byValue).slice(0, 6);
    list.forEach((w) => shown.add(w));
    lessons.push({
      kind: "family",
      title: "Word family",
      text: `You found ${bestRoot.toUpperCase()}. Its relatives were right there too. Once you find a word, try adding letters to either end and rearranging it.`,
      words: list,
      root: bestRoot,
    });
  }

  // 2. Pattern: the pattern with the most misses, weighted toward long-term weak spots.
  const candidates = Object.entries(byTag)
    .filter(([tag, t]) => tag !== "all" && tag !== "family" && t.missed.length >= 2)
    .map(([tag, t]) => ({ tag, t, score: t.missed.length * (0.3 + need(spot, tag)) * (BROAD[tag] ?? 1) }))
    .sort((a, b) => b.score - a.score);
  if (candidates.length) {
    const { tag, t } = candidates[0];
    const list = t.missed.filter((w) => !shown.has(w)).sort(byValue).slice(0, 6);
    list.forEach((w) => shown.add(w));
    const total = t.found.length + t.missed.length;
    lessons.push({
      kind: "pattern",
      tag,
      title: `Spot the ${TAGS[tag]}`,
      text: `This board had ${total} common ${total === 1 ? "word" : "words"} with ${TAGS[tag]}. You found ${t.found.length}. ${tipFor(tag)}`,
      words: list,
    });
  }

  // 3. The one that got away: the most valuable common word you missed.
  const big = missed.filter((w) => !shown.has(w)).sort(byValue)[0];
  if (big && scoreWord(big) >= 2) {
    lessons.push({
      kind: "big",
      title: "The one that got away",
      text: `${big.toUpperCase()} was worth ${scoreWord(big)} points.`,
      words: [big],
    });
  }
  return lessons;
}

function tipFor(tag) {
  if (["ing", "ed", "er", "est", "ly"].includes(tag)) return `Find the ${TAGS[tag]} tiles first, then work backwards from them.`;
  if (tag === "s") return "Every S next to a word you found is a free point.";
  if (TAGS[tag].endsWith("-")) return `Start at the ${TAGS[tag].slice(0, -1)} and look for a word after it.`;
  if (tag === "long") return "Long words usually hide a short word plus an ending. Build outward from it.";
  if (tag === "vowel") return "Try starting a word on each vowel, not just the consonants.";
  return `When you see ${TAGS[tag]} side by side, treat them as a single tile.`;
}

// ---------- Hints ----------

// Choose the word to hint toward: a common word in the player's weakest pattern,
// preferring medium lengths and relatives of words already found (it teaches the habit).
export function pickHintTarget(words, foundSet, spot, trie, rng = Math.random) {
  let best = null;
  for (const tierCap of [TEACHABLE_TIER, 2]) {
    for (const [word, { tier }] of words) {
      if (tier > tierCap || foundSet.has(word)) continue;
      const tags = patternTags(word, trie);
      const rel = relativesIn(word, foundSet);
      if (rel.length) tags.push("family");
      let focus = tags.length
        ? tags.reduce((a, b) => (need(spot, b) * (BROAD[b] ?? 1) > need(spot, a) * (BROAD[a] ?? 1) ? b : a))
        : null;
      // Relatives of found words teach the most reusable habit, so they win close calls.
      if (rel.length && strength(spot, "family") <= strength(spot, focus) + 0.15) focus = "family";
      const weakness = focus ? need(spot, focus) * (BROAD[focus] ?? 1) : 0.1;
      const lenFit = word.length >= 4 && word.length <= 6 ? 1 : 0.6;
      const score = (weakness + (rel.length ? 0.15 : 0)) * lenFit + rng() * 0.15;
      if (!best || score > best.score) best = { word, focus, root: rel[0] ?? null, score };
    }
    if (best) break;
  }
  return best;
}

export const HINT_COSTS = [1, 1, 1, 2];

// Tiles on `path` that spell characters [start, end) of the word (a Qu tile spans two).
function tilesForRange(board, path, start, end) {
  const out = [];
  let pos = 0;
  for (const i of path) {
    const len = board[i].length;
    if (pos < end && pos + len > start) out.push(i);
    pos += len;
  }
  return out;
}

// Character range in the word that the focus pattern refers to.
function focusRange(word, focus, root) {
  if (focus === "family" && root && relation(word, root) === "extend" && root.length < word.length) {
    const at = word.startsWith(root) ? 0 : word.length - root.length;
    return [at, at + root.length];
  }
  if (focus === "s") return [word.length - 1, word.length];
  if (SUFFIXES.includes(focus)) return [word.length - focus.length, word.length];
  if (PREFIXES.includes(focus)) return [0, focus.length];
  if (DIGRAPHS.includes(focus)) {
    const at = word.indexOf(focus);
    return [at, at + focus.length];
  }
  return null;
}

// What hint number `level` (0–3) shows. Hints go from a vague pattern cue to showing the path.
export function hintStep(target, level, board, path) {
  const { word, focus, root } = target;
  const n = word.length;
  const cost = HINT_COSTS[level];
  if (level === 0) {
    let msg = `There's a ${n}-letter word you haven't found.`;
    if (focus === "family" && root) {
      msg = relation(word, root) === "anagram"
        ? `Rearrange ${root.toUpperCase()}.`
        : `${root.toUpperCase()} has a relative. Add letters to one end.`;
    } else if (focus === "s") msg = "Add an S to something.";
    else if (SUFFIXES.includes(focus)) msg = `There's a word ending in ${TAGS[focus]}.`;
    else if (PREFIXES.includes(focus)) msg = `There's a word starting with ${TAGS[focus]}.`;
    else if (DIGRAPHS.includes(focus)) msg = `Find a word with ${TAGS[focus]}.`;
    else if (focus === "long") msg = `There's a ${n}-letter word hiding.`;
    else if (focus === "vowel") msg = "A word starts on a vowel.";
    return { cost, msg, pulse: [], glow: [], guide: [] };
  }
  if (level === 1) {
    return { cost, msg: `It starts here and has ${n} letters.`, pulse: [path[0]], glow: [], guide: [] };
  }
  if (level === 2) {
    const range = focusRange(word, focus, root);
    const glow = range ? tilesForRange(board, path, ...range) : [];
    const shape = word[0].toUpperCase() + " _".repeat(n - 2) + " " + word[n - 1].toUpperCase();
    return { cost, msg: `Shape: ${shape}`, pulse: [path[0]], glow, guide: [] };
  }
  return { cost, msg: "Follow the glow.", pulse: [path[0]], glow: [], guide: path.slice() };
}
