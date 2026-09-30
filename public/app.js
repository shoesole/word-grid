import {
  MODES, buildTrie, generateGame, isAdjacent, scoreWord, totalPoints,
  planBot, botSkill, updateProfile, DEFAULT_PROFILE,
} from "./engine.js";
import {
  analyzeRound, updateSpotting, buildLessons, pickHintTarget, hintStep, hitRate,
  weakestPatterns, HINT_COSTS, pickStarter, starterMessage,
  relation, unfoundRelatives, familyHint,
} from "./coach.js";
import { define } from "./define.js";

// Shown on the home screen so it's easy to tell which version is running.
// Bump together with VERSION in sw.js.
const APP_VERSION = "6";

const $ = (id) => document.getElementById(id);
const GAP = 3; // board gap in % of width, must match .board { gap } in styles.css

// ---------- Persistence (localStorage can be unavailable; never let it break the game) ----------

function load(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? { ...fallback, ...JSON.parse(raw) } : structuredClone(fallback);
  } catch {
    return structuredClone(fallback);
  }
}
function save(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
}

let settings = load("wg.settings", { size: "4", duration: "120", challenge: "even", sound: "on", starter: "15" });
let profile = load("wg.profile", { ...DEFAULT_PROFILE, spot: {} });
let trie = null;
let game = null;

// ---------- Sound ----------

let audio = null;
function unlockAudio() {
  if (audio) {
    // iOS suspends audio when the app is backgrounded; revive it on the next gesture.
    if (audio.state !== "running") audio.resume().catch(() => {});
    return;
  }
  try {
    audio = new (window.AudioContext || window.webkitAudioContext)();
  } catch {}
}
function beep(freq, dur = 0.06, type = "sine", vol = 0.08, delay = 0) {
  if (!audio || settings.sound !== "on") return;
  const t = audio.currentTime + delay;
  const osc = audio.createOscillator();
  const gain = audio.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(vol, t);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(gain).connect(audio.destination);
  osc.start(t);
  osc.stop(t + dur + 0.02);
}
const sfx = {
  tile: (n) => beep(420 + n * 45, 0.05, "triangle", 0.05),
  good: () => { beep(660, 0.08, "sine", 0.09); beep(990, 0.12, "sine", 0.09, 0.07); },
  dup: () => beep(440, 0.1, "sine", 0.06),
  bad: () => beep(150, 0.14, "square", 0.04),
  rival: () => beep(330, 0.05, "sine", 0.025),
  end: () => { beep(523, 0.12); beep(392, 0.12, "sine", 0.08, 0.12); beep(262, 0.25, "sine", 0.08, 0.24); },
};

// ---------- Screens ----------

function show(id) {
  for (const s of document.querySelectorAll(".screen")) s.classList.toggle("active", s.id === id);
  window.scrollTo(0, 0);
}

// ---------- Home ----------

function renderHome() {
  for (const seg of document.querySelectorAll(".seg")) {
    const key = seg.dataset.setting;
    for (const b of seg.children) b.classList.toggle("on", b.dataset.value === settings[key]);
  }
  const level = Math.round(botSkill(profile, settings.size, settings.challenge, Number(settings.duration)) * 100);
  $("rival-sub").textContent = trie
    ? `Adapts to you · rival level ${level}`
    : "Loading dictionary…";
  $("play-train").disabled = $("play-rival").disabled = $("play-free").disabled = !trie;

  const { wins, losses, ties } = profile;
  $("stats").innerHTML = `
    <div class="stat"><b>${wins}–${losses}${ties ? `–${ties}` : ""}</b><span>vs Rival</span></div>
    <div class="stat"><b>${level}</b><span>Rival level</span></div>
    <div class="stat"><b>${profile.best[settings.size] || 0}</b><span>Best ${settings.size}×${settings.size}</span></div>`;
  renderSpotting();
}

// The player's weakest patterns, from every mode's rounds.
function renderSpotting() {
  const weak = weakestPatterns(profile.spot);
  if (!weak.length) { $("spotting").innerHTML = ""; return; }
  const row = (label, rate) => {
    const pct = Math.round(rate * 100);
    return `<div class="spot-row"><span>${label}</span><span class="spot-bar"><i style="width:${pct}%"></i></span><span class="pct">${pct}%</span></div>`;
  };
  const cap = (t) => t[0].toUpperCase() + t.slice(1);
  $("spotting").innerHTML =
    `<h3>How much you spot (common words)</h3>` +
    row("All common words", hitRate(profile.spot, "all")) +
    `<h3 style="margin-top:12px">Work on (below your usual)</h3>` +
    weak.map((w) => row(cap(w.label), w.rate)).join("");
}

for (const seg of document.querySelectorAll(".seg")) {
  seg.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    settings[seg.dataset.setting] = b.dataset.value;
    save("wg.settings", settings);
    unlockAudio();
    renderHome();
  });
}

// ---------- Board rendering ----------

function renderTiles(el, board, size) {
  el.style.setProperty("--n", size);
  el.innerHTML = board
    .map((t, i) => `<div class="tile${t === "qu" ? " qu" : ""}" data-i="${i}">${t === "qu" ? "Qu" : t}</div>`)
    .join("");
}

// Tile centre in board-percent units (0–100), accounting for the grid gap.
function tileCenter(i, size) {
  const w = (100 - GAP * (size - 1)) / size;
  return [(i % size) * (w + GAP) + w / 2, Math.floor(i / size) * (w + GAP) + w / 2];
}

function drawTrace(svg, line, path, size) {
  svg.setAttribute("viewBox", "0 0 100 100");
  line.setAttribute("stroke-width", (100 / size) * 0.12);
  line.setAttribute("points", path.map((i) => tileCenter(i, size).join(",")).join(" "));
}

// ---------- Game ----------

function startGame(mode) {
  unlockAudio();
  const sizeKey = Number(settings.size);
  const { size, minLen } = MODES[sizeKey];
  const duration = Number(settings.duration);
  const { board, words } = generateGame(sizeKey, trie);
  const skill = mode === "rival" ? botSkill(profile, sizeKey, settings.challenge, duration) : 0;

  game = {
    mode, sizeKey, size, minLen, duration, board, words,
    found: [], foundSet: new Set(), score: 0,
    plan: mode === "rival" ? planBot(words, skill, duration) : [],
    botIdx: 0, botScore: 0,
    elapsed: 0, resumedAt: 0, running: false, over: false,
    path: [], tracing: false, flashTimer: 0,
    hint: null, hintsUsed: 0, hintCost: 0, assisted: new Set(), lastFindAt: 0,
    starter: null, starterAt: 0,
    families: [], family: null,
  };

  renderTiles($("board"), board, size);
  $("found").innerHTML = "";
  $("scores").classList.toggle("solo", mode !== "rival");
  $("hint-row").hidden = mode !== "train";
  resetHintUi("Stuck? A hint costs a point or two.");
  updateHud();
  setCurrent("", "");
  show("game");
  countdown(() => {
    game.running = true;
    game.resumedAt = performance.now();
    requestAnimationFrame(tick);
  });
}

function countdown(done) {
  const ov = $("countdown");
  const big = $("count-big");
  let n = 3;
  ov.hidden = false;
  const step = () => {
    if (!game) return;
    if (n === 0) { ov.hidden = true; beep(880, 0.15, "sine", 0.08); done(); return; }
    big.textContent = n;
    big.style.animation = "none"; void big.offsetWidth; big.style.animation = "";
    beep(440, 0.08, "sine", 0.06);
    n--;
    setTimeout(step, 650);
  };
  step();
}

function elapsed() {
  return game.elapsed + (game.running ? (performance.now() - game.resumedAt) / 1000 : 0);
}

function tick() {
  if (!game || !game.running) return;
  const t = elapsed();

  // Rival finds words on its schedule.
  let bumped = false;
  while (game.botIdx < game.plan.length && game.plan[game.botIdx].at <= t) {
    game.botScore += scoreWord(game.plan[game.botIdx].word);
    game.botIdx++;
    bumped = true;
  }
  if (bumped) {
    sfx.rival();
    const box = $("rival-box");
    box.classList.remove("bump"); void box.offsetWidth; box.classList.add("bump");
  }

  if (game.mode === "train") nudge(t);

  updateHud(t);
  if (t >= game.duration) return endGame();
  requestAnimationFrame(tick);
}

function updateHud(t = 0) {
  const left = Math.max(0, Math.ceil(game.duration - t));
  const timer = $("timer");
  timer.textContent = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`;
  timer.classList.toggle("low", left <= 10);
  $("you-score").textContent = game.score;
  $("you-count").textContent = plural(game.found.length, "word");
  $("rival-score").textContent = game.botScore;
  $("rival-count").textContent = plural(game.botIdx, "word");
}

function plural(n, w) {
  return `${n} ${w}${n === 1 ? "" : "s"}`;
}

function pause() {
  if (!game || !game.running) return;
  game.elapsed = elapsed();
  game.running = false;
  cancelTrace();
  $("paused").hidden = false;
}

function resume() {
  if (!game || game.running || game.over) return;
  $("paused").hidden = true;
  game.running = true;
  game.resumedAt = performance.now();
  requestAnimationFrame(tick);
}

$("pause").addEventListener("click", pause);
$("resume").addEventListener("click", resume);
document.addEventListener("visibilitychange", () => { if (document.hidden) pause(); });
$("quit").addEventListener("click", () => {
  if (!game) return;
  const wasRunning = game.running;
  pause();
  if (confirm("Quit this round? It won't count.")) {
    game = null;
    $("paused").hidden = true;
    $("countdown").hidden = true;
    renderHome();
    show("home");
  } else if (wasRunning) {
    resume();
  }
});

// ---------- Hints (training mode) ----------

// After a dry spell (the "Starter after" setting), highlight the opening tiles of a
// few unfound words (free). If still stuck, extend the opening by a tile.
const STARTER_EXTEND = 12;
// If you find a word with relatives, don't come back to any of them within this many
// seconds, *and* you've gone quiet (the "Starter after" delay, or 15 s when starters
// are off), the Coach points back at it. It lapses after the same time without progress.
const FAMILY_REMIND = 25;

function quietNeeded() {
  return settings.starter === "off" ? 15 : Number(settings.starter);
}

function stuckDelay() {
  return Number(settings.starter);
}

function nudge(t) {
  if (game.hint) return; // a paid hint is already guiding
  if (familyNudge(t) || settings.starter === "off") return;
  if (!game.starter && t - game.lastFindAt >= stuckDelay()) {
    const s = pickStarter(game.words, game.foundSet, profile.spot, trie);
    if (s) setStarter(s, t);
    else game.lastFindAt = t; // every common word found; don't search again every frame
    $("hint-btn").classList.add("ready");
  } else if (game.starter && !game.starter.final && t - Math.max(game.lastFindAt, game.starterAt) >= STARTER_EXTEND) {
    const s = game.starter.tiles.length < 3 && pickStarter(game.words, game.foundSet, profile.spot, trie, { tiles: 3, within: game.starter });
    if (s) setStarter({ ...s, final: true }, t);
    else game.starter.final = true;
  }
}

// Returns true while a family reminder owns the nudge slot.
function familyNudge(t) {
  const f = game.family;
  if (f) {
    if (t - Math.max(f.shownAt, f.progressAt) >= FAMILY_REMIND) {
      clearFamily();
      $("hint-msg").textContent = "Stuck? A hint costs a point or two.";
      $("hint-msg").classList.remove("active");
    }
    return !!game.family;
  }
  // Only step in when you're stuck, not while you're finding other words.
  if (t - game.lastFindAt < quietNeeded()) return false;
  // Most recent abandoned family first: it's freshest in mind.
  const due = game.families.filter((p) => !p.done && t - p.at >= FAMILY_REMIND).pop();
  if (!due) return false;
  due.done = true;
  const relatives = unfoundRelatives(due.root, game.words, game.foundSet);
  if (!relatives.length) return false;
  clearStarter();
  game.family = { root: due.root, words: relatives, shownAt: t, progressAt: t };
  showFamilyMessage();
  beep(600, 0.1, "sine", 0.05);
  return true;
}

function clearFamily() {
  game.family = null;
  for (const el of boardEl.children) el.classList.remove("family", "family-alt");
}

// Glow the tiles where the found word can be extended; say how to get the rest.
function showFamilyMessage() {
  if (!game.family) return;
  const { root, words } = game.family;
  const { msg, extendTiles, altTiles } = familyHint(root, words, game.words, game.foundSet, game.board);
  for (const el of boardEl.children) {
    const i = Number(el.dataset.i);
    el.classList.toggle("family", extendTiles.includes(i));
    el.classList.toggle("family-alt", altTiles.includes(i));
  }
  if (game.hint) return;
  $("hint-msg").textContent = msg;
  $("hint-msg").classList.add("active");
}

// Track word families as words are found: start a timer for a new family,
// cancel it if the player comes back to it, and credit reminder-assisted finds.
function trackFamilies(word, t) {
  let related = false;
  for (const p of game.families) {
    if (relation(word, p.root)) { p.done = true; related = true; }
  }
  const f = game.family;
  if (f?.words.includes(word)) {
    game.assisted.add(word);
    f.progressAt = t;
    if (f.words.every((w) => game.foundSet.has(w))) {
      clearFamily();
      if (!game.hint) $("hint-msg").textContent = "Whole family found. Nice.";
    } else {
      showFamilyMessage();
    }
  } else if (!related && unfoundRelatives(word, game.words, game.foundSet).length) {
    game.families.push({ root: word, at: t, done: false });
  }
}

function setStarter(starter, t) {
  game.starter = starter;
  game.starterAt = t;
  for (const el of boardEl.children) {
    const i = Number(el.dataset.i);
    el.classList.toggle("starter", starter.tiles.includes(i));
    el.classList.toggle("starter-first", i === starter.tiles[0]);
  }
  showStarterMessage();
  beep(600, 0.1, "sine", 0.05);
}

function clearStarter() {
  game.starter = null;
  for (const el of boardEl.children) el.classList.remove("starter", "starter-first");
}

function showStarterMessage() {
  if (!game.starter || game.hint) return;
  $("hint-msg").textContent = starterMessage(game.board, game.starter, game.foundSet);
  $("hint-msg").classList.add("active");
}

function resetHintUi(msg) {
  $("hint-btn").classList.remove("ready");
  $("hint-btn").disabled = false;
  $("hint-cost").textContent = `−${HINT_COSTS[0]}`;
  $("hint-msg").textContent = msg;
  $("hint-msg").classList.remove("active");
  showHintTiles({ pulse: [], glow: [], guide: [] });
}

function showHintTiles({ pulse, glow, guide }) {
  for (const el of boardEl.children) {
    const i = Number(el.dataset.i);
    el.classList.toggle("pulse", pulse.includes(i));
    el.classList.toggle("glow", glow.includes(i));
    el.classList.toggle("guide", guide.includes(i));
  }
}

$("hint-btn").addEventListener("click", () => {
  if (!game?.running || game.mode !== "train") return;
  unlockAudio();
  if (!game.hint) {
    // While a family reminder or starter is showing, hints point at one of its words.
    const only = game.family ? new Set(game.family.words) : game.starter ? new Set(game.starter.words) : null;
    const target = pickHintTarget(game.words, game.foundSet, profile.spot, trie, Math.random, only);
    if (!target) { $("hint-msg").textContent = "You've found every common word!"; return; }
    game.hint = { target, level: -1, path: game.words.get(target.word).path };
  }
  const h = game.hint;
  if (h.level >= HINT_COSTS.length - 1) return;
  h.level++;
  const step = hintStep(h.target, h.level, game.board, h.path);
  game.score -= step.cost;
  game.hintCost += step.cost;
  game.hintsUsed++;
  showHintTiles(step);
  $("hint-btn").classList.remove("ready");
  $("hint-msg").textContent = step.msg;
  $("hint-msg").classList.add("active");
  const next = HINT_COSTS[h.level + 1];
  $("hint-cost").textContent = next ? `−${next}` : "";
  $("hint-btn").disabled = !next;
  beep(740, 0.08, "sine", 0.06);
  updateHud(elapsed());
});

// ---------- Tracing ----------

const boardEl = $("board");

function tileAt(x, y) {
  const rect = boardEl.getBoundingClientRect();
  const { size } = game;
  const px = ((x - rect.left) / rect.width) * 100;
  const py = ((y - rect.top) / rect.height) * 100;
  const w = (100 - GAP * (size - 1)) / size;
  const col = Math.round((px - w / 2) / (w + GAP));
  const row = Math.round((py - w / 2) / (w + GAP));
  if (col < 0 || row < 0 || col >= size || row >= size) return -1;
  const i = row * size + col;
  const [cx, cy] = tileCenter(i, size);
  // A hit circle smaller than the tile lets diagonal swipes pass corners cleanly.
  return Math.hypot(px - cx, py - cy) <= (w + GAP) * 0.42 ? i : -1;
}

function visit(i) {
  const { path } = game;
  if (i < 0 || i === path[path.length - 1]) return;
  if (i === path[path.length - 2]) {
    path.pop(); // slide back to undo
  } else if (!path.includes(i) && (path.length === 0 || isAdjacent(game.size, path[path.length - 1], i))) {
    path.push(i);
    sfx.tile(path.length);
  } else {
    return;
  }
  renderPath();
}

function renderPath(state = "") {
  const { path, board, size } = game;
  const sel = new Set(path);
  for (const el of boardEl.children) el.classList.toggle("sel", sel.has(Number(el.dataset.i)));
  boardEl.classList.remove("good", "dup", "bad");
  if (state) boardEl.classList.add(state);
  drawTrace($("trace"), $("trace-line"), path, size);
  const word = path.map((i) => board[i]).join("");
  const pts = word.length >= game.minLen && !state ? `+${scoreWord(word)}` : "";
  if (!state) setCurrent(word, pts);
}

function setCurrent(word, pts, state = "") {
  const el = $("current");
  el.className = `current ${state}`;
  if (state === "bad") { void el.offsetWidth; }
  $("current-word").textContent = word;
  $("current-pts").textContent = pts;
}

let lastPt = null;
function handleMove(e) {
  if (!game?.tracing) return;
  const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
  for (const ev of events.length ? events : [e]) {
    // Interpolate between samples so fast swipes can't skip a tile.
    if (lastPt) {
      const dx = ev.clientX - lastPt[0], dy = ev.clientY - lastPt[1];
      const steps = Math.ceil(Math.hypot(dx, dy) / 6);
      for (let s = 1; s < steps; s++) visit(tileAt(lastPt[0] + (dx * s) / steps, lastPt[1] + (dy * s) / steps));
    }
    visit(tileAt(ev.clientX, ev.clientY));
    lastPt = [ev.clientX, ev.clientY];
  }
}

boardEl.addEventListener("pointerdown", (e) => {
  if (!game?.running) return;
  e.preventDefault();
  unlockAudio();
  clearTimeout(game.flashTimer);
  boardEl.setPointerCapture(e.pointerId);
  game.tracing = true;
  game.path = [];
  lastPt = null;
  handleMove(e);
});
boardEl.addEventListener("pointermove", handleMove);
boardEl.addEventListener("pointerup", finishTrace);
boardEl.addEventListener("pointercancel", cancelTrace);
// Stop iOS from scrolling/bouncing while swiping on the game screen.
$("game").addEventListener("touchmove", (e) => { if (!e.target.closest(".found")) e.preventDefault(); }, { passive: false });

function cancelTrace() {
  if (!game) return;
  game.tracing = false;
  game.path = [];
  renderPath();
}

function finishTrace() {
  if (!game?.tracing) return;
  game.tracing = false;
  const word = game.path.map((i) => game.board[i]).join("");
  if (game.path.length <= 1) return cancelTrace();

  let state, pts = "";
  if (word.length < game.minLen) {
    state = "bad"; pts = "too short"; sfx.bad();
  } else if (game.foundSet.has(word)) {
    state = "dup"; pts = "already found"; sfx.dup();
  } else if (game.words.has(word)) {
    state = "good";
    const p = scoreWord(word);
    pts = `+${p}`;
    game.found.push(word);
    game.foundSet.add(word);
    game.score += p;
    game.lastFindAt = elapsed();
    if (game.hint?.target.word === word) {
      game.assisted.add(word);
      game.hint = null;
      resetHintUi("That's the one. Hint cost already paid.");
    } else {
      $("hint-btn").classList.remove("ready");
    }
    if (game.mode === "train") trackFamilies(word, game.lastFindAt);
    if (game.starter?.words.includes(word)) {
      game.assisted.add(word);
      if (game.starter.words.every((w) => game.foundSet.has(w))) {
        clearStarter();
        if (!game.hint) $("hint-msg").textContent = "Got them all. Nice.";
      } else {
        showStarterMessage();
      }
    }
    addChip(word);
    updateHud(elapsed());
    sfx.good();
  } else {
    state = "bad"; pts = "not a word"; sfx.bad();
  }
  renderPath(state);
  setCurrent(word, pts, state);
  game.flashTimer = setTimeout(() => { if (game && !game.tracing) { game.path = []; renderPath(); } }, 450);
}

function addChip(word) {
  const chip = document.createElement("span");
  chip.className = "chip new";
  chip.textContent = word;
  $("found").prepend(chip);
}

// ---------- Results ----------

function endGame() {
  game.running = false;
  game.over = true;
  cancelTrace();
  sfx.end();

  const { mode, sizeKey, duration, score, botScore, words, foundSet, assisted } = game;
  const available = totalPoints(words.keys());
  const result = mode === "rival" ? (score > botScore ? "win" : score < botScore ? "loss" : "tie") : null;
  const before = botSkill(profile, sizeKey, settings.challenge, duration);
  // Hinted rounds would skew the Rival's read on your level, so only unassisted modes feed it.
  if (mode !== "train") {
    profile = updateProfile(profile, { sizeKey, durationSec: duration, playerPoints: score, available, result });
  }
  const byTag = analyzeRound(words, foundSet, assisted, trie);
  profile.spot = updateSpotting(profile.spot || {}, byTag);
  save("wg.profile", profile);
  const after = botSkill(profile, sizeKey, settings.challenge, duration);
  renderLessons(buildLessons(words, foundSet, byTag, profile.spot));

  const titles = { win: "You beat the Rival!", loss: "Rival takes this one", tie: "Dead heat!" };
  $("result-title").textContent = titles[result] ?? (mode === "train" ? "Training round" : "Time!");
  const pct = available ? Math.round((totalPoints(foundSet) / available) * 100) : 0;
  let sub = `${plural(game.found.length, "word")} of ${words.size} · ${pct}% of the board's points`;
  if (result) {
    const d = Math.round((after - before) * 100);
    sub += d > 0 ? " · Rival levels up" : d < 0 ? " · Rival eases off" : "";
  }
  $("result-sub").textContent = sub;
  $("result-scores").innerHTML = result
    ? `<div><b style="color:var(--accent)">${score}</b><span>You</span></div>
       <div><b style="color:var(--rival)">${botScore}</b><span>Rival</span></div>`
    : mode === "train"
    ? `<div><b style="color:var(--accent)">${score}</b><span>Points</span></div>
       <div><b>${foundSet.size - assisted.size}</b><span>Found solo</span></div>
       <div><b style="color:var(--bad)">${game.hintCost ? `−${game.hintCost}` : 0}</b><span>${plural(game.hintsUsed, "hint")}</span></div>`
    : `<div><b style="color:var(--accent)">${score}</b><span>Points</span></div>
       <div><b>${available}</b><span>Available</span></div>`;

  game.botWords = new Set(game.plan.map((p) => p.word));
  $("tab-rival").hidden = mode !== "rival";
  renderTiles($("mini-board"), game.board, game.size);
  ensureMiniTrace();
  showPath([]);
  hideDefinition();
  selectTab("yours");
  setTimeout(() => show("results"), 700);
}

function renderLessons(lessons) {
  $("lessons").innerHTML = lessons.map((l) => `
    <div class="lesson">
      <h3>${l.title}</h3>
      <p>${l.text}</p>
      <div class="chips">${l.words.map((w) => `<button class="chip" data-w="${w}">${w}</button>`).join("")}</div>
    </div>`).join("");
}

$("lessons").addEventListener("click", (e) => {
  const b = e.target.closest(".chip");
  if (!b) return;
  for (const r of document.querySelectorAll("#word-list .active, #lessons .active")) r.classList.remove("active");
  b.classList.add("active");
  showPath(game.words.get(b.dataset.w).path);
  showDefinition(b.dataset.w);
});

// ---------- Definitions ----------

let defSeq = 0;

function hideDefinition() {
  defSeq++;
  $("definition").hidden = true;
  $("mini-hint").hidden = false;
}

// Build with textContent: definitions come from an outside site.
function defLine(word, pos, text) {
  const line = document.createElement("div");
  const b = document.createElement("b");
  b.textContent = word.toUpperCase();
  const p = document.createElement("span");
  p.className = "def-pos";
  p.textContent = pos;
  line.append(b, " ", p);
  if (text) {
    const t = document.createElement("div");
    t.className = "def-text";
    t.textContent = text;
    line.append(t);
  }
  return line;
}

async function showDefinition(word) {
  const seq = ++defSeq;
  const el = $("definition");
  $("mini-hint").hidden = true;
  el.hidden = false;
  el.replaceChildren(defLine(word, "looking up…"));
  let d, failed = false;
  try { d = await define(word); } catch { failed = true; }
  if (seq !== defSeq) return; // a newer tap won
  if (failed) return el.replaceChildren(defLine(word, "", "Couldn't reach the dictionary. Check your connection and tap again."));
  if (!d) return el.replaceChildren(defLine(word, "", "No dictionary entry found for this one."));
  el.replaceChildren(defLine(word, d.pos, d.text));
  if (d.base) {
    const base = defLine(d.base.word, d.base.pos, d.base.text);
    base.className = "def-base";
    el.append(base);
  }
}

function ensureMiniTrace() {
  if ($("mini-trace")) return;
  $("mini-board").insertAdjacentHTML("afterend",
    `<svg class="trace" id="mini-trace" aria-hidden="true"><polyline id="mini-line" points=""/></svg>`);
}

function showPath(path) {
  const set = new Set(path);
  for (const el of $("mini-board").children) {
    const i = Number(el.dataset.i);
    el.classList.toggle("sel", set.has(i));
    el.classList.toggle("start", i === path[0]);
  }
  drawTrace($("mini-trace"), $("mini-line"), path, game.size);
}

function selectTab(tab) {
  for (const b of $("tabs").children) b.classList.toggle("active", b.dataset.tab === tab);
  const { words, foundSet, botWords } = game;
  let list, legend = "";
  if (tab === "yours") {
    list = [...foundSet];
    if (game.mode === "rival") legend = "• = the Rival found it too";
    if (game.mode === "train" && game.assisted.size) legend = "• = found with help (hint or starter)";
  } else if (tab === "rival") {
    list = [...botWords];
    legend = "• = you found it too";
  } else {
    list = [...words.keys()].filter((w) => !foundSet.has(w));
    legend = "Faded words are obscure. The Coach never counts them, so don't sweat those.";
  }
  list.sort((a, b) => scoreWord(b) - scoreWord(a) || a.localeCompare(b));

  const other = tab === "rival" ? foundSet
    : tab === "yours" && game.mode === "rival" ? botWords
    : tab === "yours" && game.mode === "train" ? game.assisted
    : new Set();
  const rows = list.map((w) => {
    const cls = ["word-row", other.has(w) ? "both" : "", words.get(w).tier > 1 ? "rare" : ""].join(" ");
    return `<button class="${cls}" data-w="${w}"><span class="w">${w}</span><span class="pts">${scoreWord(w)}</span></button>`;
  });
  $("word-list").innerHTML =
    (legend ? `<div class="legend">${legend}</div>` : "") +
    (rows.join("") || `<div class="legend">Nothing here.</div>`);
}

$("tabs").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (b) { selectTab(b.dataset.tab); showPath([]); hideDefinition(); }
});
$("word-list").addEventListener("click", (e) => {
  const b = e.target.closest(".word-row");
  if (!b) return;
  for (const r of document.querySelectorAll("#word-list .active, #lessons .active")) r.classList.remove("active");
  b.classList.add("active");
  showPath(game.words.get(b.dataset.w).path);
  showDefinition(b.dataset.w);
});
$("again").addEventListener("click", () => startGame(game.mode));
$("home-btn").addEventListener("click", () => { renderHome(); show("home"); });
$("play-train").addEventListener("click", () => startGame("train"));
$("play-rival").addEventListener("click", () => startGame("rival"));
$("play-free").addEventListener("click", () => startGame("free"));

// ---------- Easter egg ----------
// Off by default. Tapping the home logo 5 times toggles it for this device.
// Once on, it pops up after 20 minutes of time with the app open, at most once a day.

const EGG_AFTER = 20 * 60;
let eggTaps = [];

document.querySelector(".logo").addEventListener("click", () => {
  const now = Date.now();
  eggTaps = [...eggTaps.filter((t) => now - t < 3000), now];
  if (eggTaps.length < 5) return;
  eggTaps = [];
  const on = !load("wg.egg", { on: false }).on;
  save("wg.egg", { on, day: "", seconds: 0, shown: false });
  toast(on ? "Surprise armed" : "Surprise off");
});

function toast(msg) {
  const el = $("toast");
  el.textContent = msg;
  el.hidden = false;
  setTimeout(() => { el.hidden = true; }, 1800);
}

setInterval(() => {
  if (document.hidden) return;
  const egg = load("wg.egg", { on: false });
  if (!egg.on) return;
  const today = new Date().toDateString();
  if (egg.day !== today) Object.assign(egg, { day: today, seconds: 0, shown: false });
  if (egg.shown) return;
  egg.seconds += 5;
  if (egg.seconds >= EGG_AFTER) {
    egg.shown = true;
    showEgg();
  }
  save("wg.egg", egg);
}, 5000);

function showEgg() {
  pause(); // don't let the round clock run while it's up
  $("egg-img").src = "egg.gif";
  $("egg").hidden = false;
}

$("egg-close").addEventListener("click", () => { $("egg").hidden = true; });

// ---------- Boot ----------

$("version").textContent = `Version ${APP_VERSION}`;
renderHome();
fetch("words.txt")
  .then((r) => r.text())
  .then((text) => {
    trie = buildTrie(text);
    renderHome();
  })
  .catch(() => { $("rival-sub").textContent = "Couldn't load the dictionary. Reload to try again."; });

if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost")) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}
