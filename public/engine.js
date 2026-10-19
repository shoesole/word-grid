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

// Seconds a person needs to spot and trace a word: longer words take longer.
function findGap(word, rng) {
  return (0.6 + 0.1 * word.length) * (0.85 + rng() * 0.3);
}

// Pick the words the bot will "find" this round and when it finds them.
// skill:   target fraction of the board's total available points.
// maxRate: most words per second it may find (keeps rich boards human-paced).
export function planBot(words, skill, durationSec, rng = Math.random, { maxRate = 1 } = {}) {
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

  const maxWords = Math.max(3, Math.floor(maxRate * durationSec));
  const picks = [];
  let pts = 0;
  for (const { word } of keyed) {
    if (pts >= target || picks.length >= maxWords) break;
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

  // No superhuman bursts: each find needs time to spot and trace. Finds that would
  // spill past the end of the round are dropped.
  const paced = [];
  let prev = 1.5; // nobody finds a word the instant the board appears
  for (const { word, at } of plan) {
    const t = Math.max(at, prev + findGap(word, rng));
    if (t > durationSec - 0.5) break;
    paced.push({ word, at: t });
    prev = t;
  }
  return paced;
}

// ---------- Adaptive difficulty ----------

// `skill` estimates the fraction of a board's points the player earns (per 2-minute
// round). The Rival itself plays on a fixed ladder of levels (below); the estimate is
// only used to place a player on that ladder the first time.
export const DEFAULT_PROFILE = {
  skill: { 4: 0.12, 5: 0.08 }, // estimated player fraction of available points in 120s
  pace: { 4: 0.15, 5: 0.15 }, // player's own words per second (found without help)
  pressure: 1.0,
  games: 0,
  wins: 0,
  losses: 0,
  ties: 0,
  best: { 4: 0, 5: 0 },
  history: [],
};

export const CHALLENGE = { relaxed: 0.85, even: 1.0, tough: 1.15 };

// Points found grow a bit less than linearly with time (easy words go first).
function timeFactor(durationSec) {
  return Math.pow(durationSec / 120, 0.8);
}

// Update the profile after a round. result: "win" | "loss" | "tie" | null (free play).
export function updateProfile(profile, { sizeKey, durationSec = 120, playerPoints, available, result }) {
  const p = structuredCloneSafe(profile);
  const frac = available > 0 ? playerPoints / available / timeFactor(durationSec) : 0;
  // Faster learning early on, steadier once we know the player.
  const alpha = p.games < 5 ? 0.45 : 0.25;
  p.skill[sizeKey] = Math.max(0.01, p.skill[sizeKey] + alpha * (frac - p.skill[sizeKey]));
  if (result) {
    p.games++;
    if (result === "win") p.wins++;
    else if (result === "loss") p.losses++;
    else p.ties++;
  }
  p.best[sizeKey] = Math.max(p.best[sizeKey] || 0, playerPoints);
  p.history = [...p.history, { t: Date.now(), sizeKey, durationSec, playerPoints, available, result }].slice(-100);
  return p;
}

// ---------- Rival ladder ----------
// Each level is a fixed opponent, about 8% stronger than the one below, with its own
// ladder per board size. You move up by proving it: 60% of your last 10 games at a
// level (at least 5 played; ties count half), like winning a best-of-5 series.
// Three blowouts in a row skip a level. Your first 5 games place you, 2 levels a step.
// You only drop after a real slump: 25% or less over at least 8 games at the level.

export const LADDER = {
  window: 10, minGames: 5, promote: 0.6,
  demote: 0.25, demoteMin: 8,
  placement: 5, dominant: 1.5, dominantRun: 3,
  min: 1, max: 40,
};

// Share of a 2-minute board's points the Rival aims for at a level.
export function levelStrength(level, sizeKey) {
  return 0.12 * Math.pow(1.08, level - 12) * (Number(sizeKey) === 5 ? 0.67 : 1);
}

// Most words per second it may find at a level (keeps rich boards human-paced).
function levelRate(level) {
  return 0.06 * Math.pow(1.07, level);
}

export function rivalSkill(level, sizeKey, challenge = "even", durationSec = 120) {
  const s = levelStrength(level, sizeKey) * timeFactor(durationSec) * (CHALLENGE[challenge] ?? 1);
  return Math.min(0.9, Math.max(0.02, s));
}

export function rivalRate(level, challenge = "even") {
  return Math.min(1, Math.max(0.08, levelRate(level) * (CHALLENGE[challenge] ?? 1)));
}

const clampLevel = (l) => Math.min(LADDER.max, Math.max(LADDER.min, Math.round(l)));

// Starting level: wherever the old adaptive Rival was, or the default for a new player.
export function placementLevel(profile, sizeKey) {
  const skill = profile.skill?.[sizeKey] ?? DEFAULT_PROFILE.skill[sizeKey];
  const current = skill * (profile.pressure ?? 1);
  const base = levelStrength(12, sizeKey);
  return clampLevel(12 + Math.log(current / base) / Math.log(1.08));
}

// The ladder for one board size, created on first use.
export function getLadder(profile, sizeKey) {
  const existing = profile.ladder?.[sizeKey];
  if (existing) return existing;
  const played = (profile.history ?? []).filter((h) => h.sizeKey === Number(sizeKey) && h.result).length;
  return { level: placementLevel(profile, sizeKey), games: [], since: 0, run: 0, placement: Math.max(0, LADDER.placement - played) };
}

export function freshLadder(profile, sizeKey) {
  return { level: placementLevel({ ...profile, skill: DEFAULT_PROFILE.skill, pressure: 1 }, sizeKey), games: [], since: 0, run: 0, placement: LADDER.placement };
}

const points = (r) => (r === "win" ? 1 : r === "tie" ? 0.5 : 0);

// Record one Rival game. Returns the new ladder and how many levels it moved.
export function updateLadder(ladder, { result, you, rival }) {
  const l = { ...ladder, games: [...ladder.games, points(result)].slice(-LADDER.window), since: ladder.since + 1 };
  const dominant = result === "win" && you >= LADDER.dominant * Math.max(rival, 1);
  l.run = dominant ? (ladder.run ?? 0) + 1 : 0;
  let change = 0;
  if (l.placement > 0) {
    l.placement--;
    change = result === "win" ? 2 : result === "loss" ? -2 : 0;
  } else {
    const rate = l.games.reduce((a, b) => a + b, 0) / l.games.length;
    if (l.run >= LADDER.dominantRun) change = 2;
    else if (result === "win" && l.games.length >= LADDER.minGames && rate >= LADDER.promote) change = 1; // promotions happen on a win
    else if (l.games.length >= LADDER.demoteMin && rate <= LADDER.demote) change = -1;
  }
  if (change) {
    const level = clampLevel(l.level + change);
    change = level - l.level;
    if (change) Object.assign(l, { level, games: [], since: 0, run: 0 });
  }
  return { ladder: l, change };
}

// Record at the current level, and the fewest more wins that could move it up
// (it may take a few more games than that, since 5 games are needed).
export function ladderProgress(ladder) {
  const wins = ladder.games.filter((g) => g === 1).length;
  const ties = ladder.games.filter((g) => g === 0.5).length;
  const losses = ladder.games.length - wins - ties;
  let toPromote = null;
  if (!ladder.placement && ladder.level < LADDER.max) {
    for (let more = 1; more <= LADDER.window; more++) {
      for (let w = 1; w <= more; w++) {
        // Best case for those games: losses first, then the wins (the last game is a win).
        const recent = [...ladder.games, ...Array(more - w).fill(0), ...Array(w).fill(1)].slice(-LADDER.window);
        const rate = recent.reduce((a, b) => a + b, 0) / recent.length;
        if (recent.length >= LADDER.minGames && rate >= LADDER.promote && (toPromote === null || w < toPromote)) toPromote = w;
      }
    }
  }
  return { wins, losses, ties, toPromote, placement: ladder.placement };
}

// Learn the player's pace from any round: words found without help per second.
export function updatePace(profile, sizeKey, soloWords, durationSec) {
  const p = structuredCloneSafe(profile);
  p.pace = { ...DEFAULT_PROFILE.pace, ...p.pace };
  const rate = durationSec > 0 ? soloWords / durationSec : 0;
  p.pace[sizeKey] += 0.3 * (rate - p.pace[sizeKey]);
  return p;
}

function structuredCloneSafe(o) {
  return JSON.parse(JSON.stringify(o));
}
