// Core game logic: dice, board generation, dictionary trie, solver, scoring, bot.
// Plain ES module with no DOM access so it runs in the browser and in node tests.

// Classic 16-dice set (1987+ edition). "Q" is rolled as the "Qu" tile.
const DICE_4 = [
  "AAEEGN", "ABBJOO", "ACHOPS", "AFFKPS", "AOOTTW", "CIMOTU", "DEILRX", "DELRVY",
  "DISTTY", "EEGHNW", "EEINSU", "EHRTVW", "EIOSST", "ELRTTY", "HIMNUQ", "HLNNRZ",
];

// Big Boggle 25-dice set.
const DICE_5 = [
  "AAAFRS", "AAEEEE", "AAFIRS", "ADENNN", "AEEEEM", "AEEGMU", "AEGMNN", "AFIRSY",
  "BJKQXZ", "CCENST", "CEIILT", "CEILPT", "CEIPST", "DDHNOT", "DHHLOR", "DHLNOR",
  "DHLNOR", "EIIITT", "EMOTTT", "ENSSSU", "FIPRSY", "GORRVW", "IPRRRY", "NOOTUW",
  "OOOTTU",
];

export const MODES = {
  4: { size: 4, dice: DICE_4, minLen: 3 },
  5: { size: 5, dice: DICE_5, minLen: 4 },
};

// ---------- Randomness ----------

// Small seedable PRNG (mulberry32) so tests are reproducible.
export function makeRng(seed = (Math.random() * 2 ** 32) >>> 0) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(arr, rng) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// ---------- Dictionary ----------

// Trie node: { k: {letter: node}, t: tier } where t is set only on word ends.
// Tiers: 0 very common, 1 common, 2 known, 3 obscure.
export function buildTrie(text) {
  const root = { k: {} };
  let count = 0;
  for (const line of text.split("\n")) {
    if (line.length < 4) continue;
    const tier = line.charCodeAt(0) - 48;
    let node = root;
    for (let i = 1; i < line.length; i++) {
      const ch = line[i];
      node = node.k[ch] || (node.k[ch] = { k: {} });
    }
    node.t = tier;
    count++;
  }
  root.count = count;
  return root;
}

// ---------- Board ----------

export function rollBoard(sizeKey, rng = Math.random) {
  const { dice } = MODES[sizeKey];
  return shuffle(dice.slice(), rng).map((die) => {
    const face = die[Math.floor(rng() * 6)].toLowerCase();
    return face === "q" ? "qu" : face;
  });
}

export function neighbors(size) {
  const out = [];
  for (let i = 0; i < size * size; i++) {
    const r = Math.floor(i / size), c = i % size, list = [];
    for (let dr = -1; dr <= 1; dr++)
      for (let dc = -1; dc <= 1; dc++) {
        if (!dr && !dc) continue;
        const rr = r + dr, cc = c + dc;
        if (rr >= 0 && rr < size && cc >= 0 && cc < size) list.push(rr * size + cc);
      }
    out.push(list);
  }
  return out;
}

export function isAdjacent(size, a, b) {
  const dr = Math.abs(Math.floor(a / size) - Math.floor(b / size));
  const dc = Math.abs((a % size) - (b % size));
  return a !== b && dr <= 1 && dc <= 1;
}

// Returns Map(word -> { tier, path }) of every dictionary word on the board.
export function solve(board, trie, minLen) {
  const size = Math.round(Math.sqrt(board.length));
  const adj = neighbors(size);
  const found = new Map();
  const used = new Array(board.length).fill(false);
  const path = [];

  function walk(node, i, word) {
    for (const ch of board[i]) {
      node = node.k[ch];
      if (!node) return;
    }
    word += board[i];
    used[i] = true;
    path.push(i);
    if (node.t !== undefined && word.length >= minLen && !found.has(word)) {
      found.set(word, { tier: node.t, path: path.slice() });
    }
    for (const j of adj[i]) if (!used[j]) walk(node, j, word);
    used[i] = false;
    path.pop();
  }

  for (let i = 0; i < board.length; i++) walk(trie, i, "");
  return found;
}

// Classic Boggle scoring.
export function scoreWord(word) {
  const n = word.length;
  if (n <= 4) return 1;
  if (n === 5) return 2;
  if (n === 6) return 3;
  if (n === 7) return 5;
  return 11;
}

export function totalPoints(words) {
  let s = 0;
  for (const w of words) s += scoreWord(w);
  return s;
}

// Roll boards until one is fun: enough findable, common words.
export function generateGame(sizeKey, trie, rng = Math.random) {
  const { minLen } = MODES[sizeKey];
  const minCommon = sizeKey === 4 ? 30 : 45;
  let best = null;
  for (let attempt = 0; attempt < 40; attempt++) {
    const board = rollBoard(sizeKey, rng);
    const words = solve(board, trie, minLen);
    let common = 0;
    for (const { tier } of words.values()) if (tier <= 1) common++;
    if (!best || common > best.common) best = { board, words, common };
    if (common >= minCommon) break;
  }
  return best;
}

// ---------- Bot ----------

// How likely a player is to spot a word, by commonness tier and length.
const TIER_WEIGHT = [1, 0.5, 0.18, 0.04];
function lengthWeight(n) {
  return [0, 0, 0, 1, 0.95, 0.75, 0.5, 0.3][n] ?? 0.15;
}

// Pick the words the bot will "find" this round and when it finds them.
// skill: target fraction of the board's total available points.
export function planBot(words, skill, durationSec, rng = Math.random) {
  const all = [...words.entries()];
  const available = totalPoints(words.keys());
  // A little round-to-round variance so the bot isn't robotic.
  const target = available * skill * (0.85 + rng() * 0.3);

  // Weighted random ordering (Efraimidis–Spirakis): findable words tend to come first.
  const keyed = all.map(([word, { tier }]) => {
    const w = TIER_WEIGHT[tier] * lengthWeight(word.length);
    return { word, key: Math.pow(rng(), 1 / w) };
  });
  keyed.sort((a, b) => b.key - a.key);

  const picks = [];
  let pts = 0;
  for (const { word } of keyed) {
    if (pts >= target) break;
    picks.push(word);
    pts += scoreWord(word);
  }

  // Spread finds over the round: steady pace with a slight early burst,
  // mirroring how people find easy words first.
  const plan = picks.map((word, i) => {
    const base = (i + 0.5) / Math.max(picks.length, 1);
    const jitter = (rng() - 0.5) * 0.15;
    const frac = Math.min(0.97, Math.max(0.03, Math.pow(base, 1.15) + jitter));
    return { word, at: frac * durationSec };
  });
  plan.sort((a, b) => a.at - b.at);
  return plan;
}

// ---------- Adaptive difficulty ----------

// The player model is the fraction of available points they typically earn.
// The bot aims for that level times a "pressure" factor that nudges up after
// the player wins and down after they lose, targeting roughly even matches.
export const DEFAULT_PROFILE = {
  skill: { 4: 0.12, 5: 0.08 }, // estimated player fraction of available points
  pressure: 1.0,
  games: 0,
  wins: 0,
  losses: 0,
  ties: 0,
  best: { 4: 0, 5: 0 },
  history: [],
};

export const CHALLENGE = { relaxed: 0.85, even: 1.0, tough: 1.15 };

export function botSkill(profile, sizeKey, challenge = "even") {
  const s = profile.skill[sizeKey] * profile.pressure * (CHALLENGE[challenge] ?? 1);
  return Math.min(0.9, Math.max(0.02, s));
}

// Update the profile after a round. result: "win" | "loss" | "tie" | null (free play).
export function updateProfile(profile, { sizeKey, playerPoints, available, result }) {
  const p = structuredCloneSafe(profile);
  const frac = available > 0 ? playerPoints / available : 0;
  // Faster learning early on, steadier once we know the player.
  const alpha = p.games < 5 ? 0.45 : 0.25;
  p.skill[sizeKey] = Math.max(0.01, p.skill[sizeKey] + alpha * (frac - p.skill[sizeKey]));
  if (result) {
    p.games++;
    if (result === "win") { p.wins++; p.pressure *= 1.04; }
    else if (result === "loss") { p.losses++; p.pressure *= 0.96; }
    else p.ties++;
    p.pressure = Math.min(1.5, Math.max(0.6, p.pressure));
  }
  p.best[sizeKey] = Math.max(p.best[sizeKey] || 0, playerPoints);
  p.history = [...p.history, { t: Date.now(), sizeKey, playerPoints, available, result }].slice(-100);
  return p;
}

function structuredCloneSafe(o) {
  return JSON.parse(JSON.stringify(o));
}
