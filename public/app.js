import {
  MODES, buildTrie, generateGame, isAdjacent, scoreWord, totalPoints,
  planBot, botSkill, updateProfile, DEFAULT_PROFILE, rivalRate, updatePace,
} from "./engine.js";
import {
  analyzeRound, updateSpotting, buildLessons, pickHintTarget, hintStep, hitRate,
  weakestPatterns, HINT_COSTS, pickStarter, starterMessage,
  relation, unfoundRelatives, familyHint,
} from "./coach.js";
import { define } from "./define.js";

// Shown on the home screen so it's easy to tell which version is running.
// Bump together with VERSION in sw.js.
const APP_VERSION = "8";

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

let settings = load("wg.settings", { size: "4", duration: "120", challenge: "even", starter: "15", classic: "off" });
let profile = load("wg.profile", { ...DEFAULT_PROFILE, spot: {}, bestPct: {} });
let trie = null;
let game = null;


// ---------- Screens ----------

function show(id) {
  for (const s of document.querySelectorAll(".screen")) s.classList.toggle("active", s.id === id);
  window.scrollTo(0, 0);
}

// ---------- Home ----------

const CHALLENGE_LABEL = { relaxed: "Relaxed", even: "Even", tough: "Tough" };

function renderHome() {
  const n = settings.size;
  $("settings-summary").textContent = [
    `${n}×${n}`,
    clock(settings.duration),
    `Rival: ${CHALLENGE_LABEL[settings.challenge]}${settings.classic === "on" ? ", classic" : ""}`,
    settings.starter === "off" ? "Hints: off" : `Hints: ${settings.starter}s`,
  ].join(" · ");
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
    <div class="stat"><b>${profile.best[settings.size] || 0}</b><span>Best score ${settings.size}×${settings.size}</span></div>
    <div class="stat"><b>${formatPct(profile.bestPct?.[pctKey(settings.size, settings.duration)])}</b><span>Best % ${settings.size}×${settings.size} · ${clock(settings.duration)}</span></div>`;
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
  const sizeKey = Number(settings.size);
  const { size, minLen } = MODES[sizeKey];
  const duration = Number(settings.duration);
  const { board, words } = generateGame(sizeKey, trie);
  const skill = mode === "rival" ? botSkill(profile, sizeKey, settings.challenge, duration) : 0;

  game = {
    mode, sizeKey, size, minLen, duration, board, words,
    found: [], foundSet: new Set(), score: 0,
    plan: mode === "rival" ? planBot(words, skill, duration, Math.random, { maxRate: rivalRate(profile, sizeKey, settings.challenge) }) : [],
    botIdx: 0, botScore: 0,
    classic: mode === "rival" && settings.classic === "on", // shared words cancel at the end
    elapsed: 0, resumedAt: 0, running: false, over: false,
    path: [], tracing: false, flashTimer: 0,
    hint: null, hintsUsed: 0, hintCost: 0, assisted: new Set(), lastFindAt: 0,
    starter: null, starterAt: 0,
    families: [], family: null,
  };

  renderTiles($("board"), board, size);
  $("found").innerHTML = "";
  $("scores").classList.toggle("solo", mode !== "rival");
  $("rival-box").querySelector(".who").textContent = game.classic ? "Rival · classic" : "Rival";
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
    if (n === 0) { ov.hidden = true; done(); return; }
    big.textContent = n;
    big.style.animation = "none"; void big.offsetWidth; big.style.animation = "";
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

function pctKey(size, duration) {
  return `${size}-${duration}`;
}

function formatPct(p) {
  return p ? `${p.toFixed(1)}%` : "—";
}

function clock(sec) {
  sec = Number(sec);
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
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

// After a dry spell (the "Hints start after" setting), highlight the opening tiles of a
// few unfound words (free). If still stuck, extend the opening by a tile.
const STARTER_EXTEND = 12;
// If you find a word with relatives, don't come back to any of them within this many
// seconds, *and* you've gone quiet (the "Hints start after" delay, or 15 s when that
// is off), the Coach points back at it. It lapses after the same time without progress.
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
    state = "bad"; pts = "too short";
  } else if (game.foundSet.has(word)) {
    state = "dup"; pts = "already found";
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
  } else {
    state = "bad"; pts = "not a word";
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

  const { mode, sizeKey, duration, score, botScore, words, foundSet, assisted } = game;
  const available = totalPoints(words.keys());
  // Only words the Rival actually reached before time ran out.
  game.botWords = new Set(game.plan.slice(0, game.botIdx).map((p) => p.word));
  // Classic Boggle: words both players found score for neither.
  const shared = game.classic ? [...foundSet].filter((w) => game.botWords.has(w)) : [];
  const sharedPts = totalPoints(shared);
  const youFinal = score - sharedPts;
  const rivalFinal = botScore - sharedPts;
  const result = mode === "rival" ? (youFinal > rivalFinal ? "win" : youFinal < rivalFinal ? "loss" : "tie") : null;
  const before = botSkill(profile, sizeKey, settings.challenge, duration);
  // Hinted rounds would skew the Rival's read on your level, so only unassisted modes feed it.
  if (mode !== "train") {
    profile = updateProfile(profile, { sizeKey, durationSec: duration, playerPoints: score, available, result });
  }
  // Best % completed, per board size and round length. Only words found without help count.
  const soloPct = available ? (totalPoints([...foundSet].filter((w) => !assisted.has(w))) / available) * 100 : 0;
  const key = pctKey(sizeKey, duration);
  const newBestPct = soloPct > 0 && soloPct > (profile.bestPct?.[key] ?? 0);
  if (newBestPct) profile.bestPct = { ...profile.bestPct, [key]: soloPct };
  profile = updatePace(profile, sizeKey, foundSet.size - assisted.size, duration);
  const byTag = analyzeRound(words, foundSet, assisted, trie);
  profile.spot = updateSpotting(profile.spot || {}, byTag);
  save("wg.profile", profile);
  const after = botSkill(profile, sizeKey, settings.challenge, duration);
  renderLessons(buildLessons(words, foundSet, byTag, profile.spot));

  const titles = { win: "You beat the Rival!", loss: "Rival takes this one", tie: "Dead heat!" };
  $("result-title").textContent = titles[result] ?? (mode === "train" ? "Training round" : "Time!");
  const pct = available ? (totalPoints(foundSet) / available) * 100 : 0;
  let sub = `${plural(game.found.length, "word")} of ${words.size} · ${pct.toFixed(1)}% of the board's points`;
  if (result) {
    const d = Math.round((after - before) * 100);
    sub += d > 0 ? " · Rival levels up" : d < 0 ? " · Rival eases off" : "";
  }
  if (game.classic) {
    sub += shared.length
      ? ` · Classic rules: ${plural(shared.length, "shared word")} cancelled (−${sharedPts} each)`
      : " · Classic rules: no shared words";
  }
  if (newBestPct) sub += ` · New best: ${formatPct(soloPct)} completed!`;
  $("result-sub").textContent = sub;
  $("result-scores").innerHTML = result
    ? `<div><b style="color:var(--accent)">${youFinal}</b><span>You</span></div>
       <div><b style="color:var(--rival)">${rivalFinal}</b><span>Rival</span></div>`
    : mode === "train"
    ? `<div><b style="color:var(--accent)">${score}</b><span>Points</span></div>
       <div><b>${foundSet.size - assisted.size}</b><span>Found solo</span></div>
       <div><b style="color:var(--bad)">${game.hintCost ? `−${game.hintCost}` : 0}</b><span>${plural(game.hintsUsed, "hint")}</span></div>`
    : `<div><b style="color:var(--accent)">${score}</b><span>Points</span></div>
       <div><b>${available}</b><span>Available</span></div>`;

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
    if (game.mode === "rival") legend = game.classic ? "• = the Rival found it too (cancelled, scores 0)" : "• = the Rival found it too";
    if (game.mode === "train" && game.assisted.size) legend = "• = found with help (hint or starter)";
  } else if (tab === "rival") {
    list = [...botWords];
    legend = game.classic ? "• = you found it too (cancelled, scores 0)" : "• = you found it too";
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
    const cancelled = game.classic && tab !== "missed" && foundSet.has(w) && botWords.has(w);
    const cls = ["word-row", other.has(w) ? "both" : "", words.get(w).tier > 1 ? "rare" : "", cancelled ? "cancelled" : ""].join(" ");
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
$("open-settings").addEventListener("click", () => show("settings"));
$("close-settings").addEventListener("click", () => { renderHome(); show("home"); });
$("play-train").addEventListener("click", () => startGame("train"));
$("play-rival").addEventListener("click", () => startGame("rival"));
$("play-free").addEventListener("click", () => startGame("free"));

// ---------- Easter egg ----------
// Off by default. Tapping the home logo 5 times toggles it for this device.
// Once on, it only counts time with the app open at night (10 pm – 5 am), per night:
//   15 min: the photo and message (dismissable)
//   30 min: a second message (dismissable)
//   40 min: a bedtime message and the app is locked until 5 am
// The night's count and the lock reset at 5 am. Tapping the bedtime message 5 times
// disarms the egg and lifts the lock (an escape hatch in case the clock is wrong).

const NIGHT_START = 22; // 10 pm
const MORNING = 5; // 5 am
const EGG_STAGES = [
  { at: 15 * 60, msg: "Angie, you've been a naughty girl and you need to be punished." },
  { at: 30 * 60, msg: "Is this really better than the sex you could be having right now?" },
  { at: 40 * 60, msg: "Sorry, you can't control yourself but it's time for bed", lock: true },
];
const EGG_OFF = { on: false, night: "", seconds: 0, stage: 0 };

// Test mode for trying the egg by day: add ?eggtest to the address of a local copy.
// It's always "night", 1 second counts as 1 minute, it starts armed, and it keeps its
// own state so real progress is untouched. Ignored on the real site.
const EGG_TEST = new URLSearchParams(location.search).has("eggtest") && location.hostname !== "shoesole.github.io";
const EGG_KEY = EGG_TEST ? "wg.egg.test" : "wg.egg";
const EGG_DEFAULT = EGG_TEST ? { ...EGG_OFF, on: true } : EGG_OFF;
const TICK_MS = EGG_TEST ? 1000 : 5000;
const TICK_COUNTS = EGG_TEST ? 60 : 5; // seconds of "night" each tick adds
let eggTaps = [];

// The evening a moment belongs to (10 pm – 5 am counts as one night), or null by day.
function nightOf(d) {
  if (EGG_TEST) return "test night";
  const h = d.getHours();
  if (h >= NIGHT_START) return d.toDateString();
  if (h < MORNING) {
    const prev = new Date(d);
    prev.setDate(d.getDate() - 1);
    return prev.toDateString();
  }
  return null;
}

function fiveTaps() {
  const now = Date.now();
  eggTaps = [...eggTaps.filter((t) => now - t < 3000), now];
  if (eggTaps.length < 5) return false;
  eggTaps = [];
  return true;
}

document.querySelector(".logo").addEventListener("click", () => {
  if (!fiveTaps()) return;
  const on = !load(EGG_KEY, EGG_DEFAULT).on;
  save(EGG_KEY, { ...EGG_OFF, on });
  toast(on ? "Surprise armed" : "Surprise off");
});

$("egg-msg").addEventListener("click", () => {
  if (!$("egg").classList.contains("locked") || !fiveTaps()) return;
  save(EGG_KEY, EGG_OFF);
  $("egg").hidden = true;
  $("egg").classList.remove("locked");
  toast("Surprise off");
});

function toast(msg) {
  const el = $("toast");
  el.textContent = msg;
  el.hidden = false;
  setTimeout(() => { el.hidden = true; }, 1800);
}

// Each message can have an optional picture, chosen on the phone and kept only in its
// IndexedDB, never in the app's files.
function idb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("wg", 1);
    req.onupgradeneeded = () => req.result.createObjectStore("files");
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function idbDo(mode, fn) {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const req = fn(db.transaction("files", mode).objectStore("files"));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
const getPic = (n) => idbDo("readonly", (s) => s.get(`egg-pic-${n}`)).catch(() => null);
const setPic = (n, blob) => idbDo("readwrite", (s) => s.put(blob, `egg-pic-${n}`));
const removePic = (n) => idbDo("readwrite", (s) => s.delete(`egg-pic-${n}`));

const picUrls = {};
function blobUrl(key, blob) {
  if (picUrls[key]) URL.revokeObjectURL(picUrls[key]);
  picUrls[key] = blob ? URL.createObjectURL(blob) : null;
  return picUrls[key];
}

async function showEggStage(stage) {
  const s = EGG_STAGES[stage - 1];
  pause(); // don't let the round clock run while it's up
  const img = $("egg-img");
  const blob = await getPic(stage);
  img.hidden = !blob; // no picture chosen: text only
  if (blob) img.src = blobUrl("show", blob);
  $("egg-msg").textContent = s.msg;
  $("egg-close").hidden = !!s.lock;
  $("egg").classList.toggle("locked", !!s.lock);
  $("egg").hidden = false;
}

function eggTick(countTime) {
  const egg = load(EGG_KEY, EGG_DEFAULT);
  if (!egg.on) return;
  const night = nightOf(new Date());
  if (night !== egg.night) {
    // Daytime, or a new night: reset, and lift last night's lock.
    Object.assign(egg, { night: night ?? "", seconds: 0, stage: 0 });
    if ($("egg").classList.contains("locked")) {
      $("egg").hidden = true;
      $("egg").classList.remove("locked");
    }
  }
  if (night) {
    const locked = egg.stage >= EGG_STAGES.length;
    if (locked && $("egg").hidden) showEggStage(egg.stage); // reopened during a locked night
    if (countTime && !locked) {
      egg.seconds += TICK_COUNTS;
      const next = EGG_STAGES[egg.stage];
      if (egg.seconds >= next.at) {
        egg.stage++;
        showEggStage(egg.stage);
      }
    }
  }
  save(EGG_KEY, egg);
  if (EGG_TEST) $("egg-test-time").textContent = `${Math.round(egg.seconds / 60)} min tonight${egg.on ? "" : " (disarmed)"}`;
}

setInterval(() => { if (!document.hidden) eggTick(true); }, TICK_MS);

if (EGG_TEST) {
  $("egg-test").hidden = false;
  $("egg-test-restart").addEventListener("click", () => {
    save(EGG_KEY, EGG_DEFAULT);
    $("egg").hidden = true;
    $("egg").classList.remove("locked");
    eggTick(false);
  });
}
document.addEventListener("visibilitychange", () => { if (!document.hidden) eggTick(false); });
eggTick(false);

$("egg-close").addEventListener("click", () => { $("egg").hidden = true; });

// Hidden setup: 5 quick taps on the version text, only on an armed phone.
$("version").addEventListener("click", () => {
  if (!fiveTaps() || !load(EGG_KEY, EGG_DEFAULT).on) return;
  openEggSetup();
});

async function openEggSetup() {
  for (const slot of document.querySelectorAll(".pic-slot")) {
    const n = slot.dataset.slot;
    const blob = await getPic(n);
    const preview = slot.querySelector(".pic-preview");
    preview.hidden = !blob;
    if (blob) preview.src = blobUrl(`slot${n}`, blob);
    slot.querySelector(".pic-status").textContent = blob ? "" : "No picture";
    slot.querySelector(".pic-remove").hidden = !blob;
  }
  $("egg-setup").hidden = false;
}

for (const slot of document.querySelectorAll(".pic-slot")) {
  const n = slot.dataset.slot;
  slot.querySelector("input[type=file]").addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    try {
      await setPic(n, file);
      openEggSetup();
    } catch {
      slot.querySelector(".pic-status").textContent = "Couldn't save that one. Try a smaller picture.";
    }
  });
  slot.querySelector(".pic-remove").addEventListener("click", async () => { await removePic(n).catch(() => {}); openEggSetup(); });
}
$("setup-close").addEventListener("click", () => { $("egg-setup").hidden = true; });

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
