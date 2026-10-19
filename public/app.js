import {
  MODES, buildTrie, generateGame, isAdjacent, scoreWord, totalPoints, solve,
  planBot, updateProfile, DEFAULT_PROFILE, rivalRate, rivalSkill, updatePace,
  getLadder, freshLadder, updateLadder, ladderProgress,
} from "./engine.js";
import { analyzeRound, updateSpotting, buildLessons, hitRate, weakestPatterns } from "./coach.js";
import { generateMasteryBoard, masteryStats, shouldPreferLong, pickMasteryTarget, masteryHint, HINT_STEPS } from "./mastery.js";
import { define } from "./define.js";

// Shown on the home screen so it's easy to tell which version is running.
// Bump together with VERSION in sw.js.
const APP_VERSION = "10";

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

let settings = load("wg.settings", { size: "4", duration: "120", challenge: "even", classic: "off", goal: "80", longword: "on" });
let profile = load("wg.profile", { ...DEFAULT_PROFILE, spot: {}, bestPct: {}, spotMastery: {}, mastery: [] });
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
    `Mastery Mode: ${settings.goal}%${settings.longword === "on" ? " + long word" : ""}`,
  ].join(" · ");
  for (const seg of document.querySelectorAll(".seg")) {
    const key = seg.dataset.setting;
    for (const b of seg.children) b.classList.toggle("on", b.dataset.value === settings[key]);
  }
  const ladder = getLadder(profile, settings.size);
  const level = ladder.level;
  $("rival-sub").textContent = trie
    ? `Level ${level} · ${ladderStatus(ladder)}`
    : "A bot that adapts to your level";
  $("reset-rival").textContent = `Reset ${settings.size}×${settings.size} Rival level (now ${level})`;
  $("status").hidden = !!trie;
  $("play-mastery").disabled = $("play-rival").disabled = $("play-free").disabled = !trie;
  const saved = loadMastery();
  $("mastery-sub").textContent = saved
    ? `Resume your board · ${saved.found.length} words found so far`
    : `Untimed · find ${settings.goal}% of the common words · hints when you ask`;
  const boards = profile.mastery ?? [];
  const recent = boards.slice(-5);
  const avgHints = recent.length ? (recent.reduce((a, b) => a + b.hints, 0) / recent.length).toFixed(1) : "—";

  const { wins, losses, ties } = profile;
  $("stats").innerHTML = `
    <div class="stat"><b>${wins}–${losses}${ties ? `–${ties}` : ""}</b><span>vs Rival</span></div>
    <div class="stat"><b>${level}</b><span>Rival level ${settings.size}×${settings.size}</span></div>
    <div class="stat"><b>${profile.best[settings.size] || 0}</b><span>Best score ${settings.size}×${settings.size}</span></div>
    <div class="stat"><b>${formatPct(profile.bestPct?.[pctKey(settings.size, settings.duration)])}</b><span>Best % ${settings.size}×${settings.size} · ${clock(settings.duration)}</span></div>
    <div class="stat"><b>${boards.filter((b) => b.goalMet).length}</b><span>Boards mastered</span></div>
    <div class="stat"><b>${avgHints}</b><span>Avg hints, ${recent.length === 1 ? "last board" : `last ${recent.length || 5} boards`}</span></div>`;
  renderSpotting();
}

// The player's weakest patterns, from timed rounds (Mastery keeps its own).
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

function newGameState(mode, sizeKey, board, words, extra = {}) {
  const { size, minLen } = MODES[sizeKey];
  return {
    mode, sizeKey, size, minLen, board, words, duration: 0,
    found: [], foundSet: new Set(), score: 0,
    plan: [], botIdx: 0, botScore: 0, classic: false,
    elapsed: 0, resumedAt: 0, running: false, over: false,
    path: [], tracing: false, flashTimer: 0,
    hint: null, hintsUsed: 0, assisted: new Set(),
    ...extra,
  };
}

// One line on where you stand on the Rival ladder.
function ladderStatus(ladder) {
  const p = ladderProgress(ladder);
  if (p.placement) return `placement: ${plural(p.placement, "game")} left`;
  const record = `${p.wins}–${p.losses}${p.ties ? `–${p.ties}` : ""} at this level`;
  if (!p.wins && !p.losses && !p.ties) return "win 3 of your next 5 to level up";
  return p.toPromote ? `${record} · ${plural(p.toPromote, "more win")} to level up` : record;
}

function startGame(mode) {
  if (mode === "mastery") return startMastery();
  const sizeKey = Number(settings.size);
  const duration = Number(settings.duration);
  const { board, words } = generateGame(sizeKey, trie);
  if (mode === "rival" && !profile.ladder?.[sizeKey]) {
    // Pin the starting level now, so this round's result can't shift it.
    profile.ladder = { ...profile.ladder, [sizeKey]: getLadder(profile, sizeKey) };
    save("wg.profile", profile);
  }
  const level = getLadder(profile, sizeKey).level;
  const skill = mode === "rival" ? rivalSkill(level, sizeKey, settings.challenge, duration) : 0;
  game = newGameState(mode, sizeKey, board, words, {
    duration, level,
    plan: mode === "rival" ? planBot(words, skill, duration, Math.random, { maxRate: rivalRate(level, settings.challenge) }) : [],
    classic: mode === "rival" && settings.classic === "on", // shared words cancel at the end
  });
  setupGameScreen();
  countdown(() => {
    game.running = true;
    game.resumedAt = performance.now();
    requestAnimationFrame(tick);
  });
}

function setupGameScreen() {
  const mastery = game.mode === "mastery";
  renderTiles($("board"), game.board, game.size);
  $("found").innerHTML = "";
  for (const w of game.found) addChip(w, false, game.assisted.has(w));
  $("game").classList.toggle("mastery", mastery);
  $("scores").hidden = mastery;
  $("mastery-panel").hidden = !mastery;
  $("hint-row").hidden = !mastery;
  $("pause").textContent = mastery ? "Done" : "❚❚";
  $("pause").classList.toggle("text-btn", mastery);
  $("scores").classList.toggle("solo", game.mode !== "rival");
  $("rival-box").querySelector(".who").textContent = game.classic ? "Rival · classic" : "Rival";
  if (mastery) restoreHintUi();
  updateHud();
  setCurrent("", "");
  show("game");
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

let lastSave = 0;
function tick() {
  if (!game || !game.running) return;
  const t = elapsed();

  if (game.mode === "mastery") {
    // Untimed: no end, just keep the elapsed time saved now and then.
    if (performance.now() - lastSave > 10000) saveMastery();
    requestAnimationFrame(tick);
    return;
  }

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

  updateHud(t);
  if (t >= game.duration) return endGame();
  requestAnimationFrame(tick);
}

function updateHud(t = 0) {
  if (game.mode === "mastery") return updateMasteryHud();
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
  sec = Math.floor(Number(sec));
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
}

function plural(n, w) {
  return `${n} ${w}${n === 1 ? "" : "s"}`;
}

// Mastery has no clock to protect, so pausing just stops counting time and saves;
// it picks back up by itself when the app is visible again.
function pause() {
  if (!game || !game.running) return;
  game.elapsed = elapsed();
  game.running = false;
  cancelTrace();
  if (game.mode === "mastery") return saveMastery();
  $("paused").hidden = false;
}

function resume() {
  if (!game || game.running || game.over) return;
  $("paused").hidden = true;
  game.running = true;
  game.resumedAt = performance.now();
  requestAnimationFrame(tick);
}

// Resume Mastery when nothing is in the way (app visible, on the board, no pop-up).
function resumeMasteryIfClear() {
  if (game?.mode === "mastery" && !document.hidden && $("game").classList.contains("active")
      && $("egg").hidden && $("goal").hidden) resume();
}

$("pause").addEventListener("click", () => (game?.mode === "mastery" ? finishMastery() : pause()));
$("resume").addEventListener("click", resume);
document.addEventListener("visibilitychange", () => {
  if (document.hidden) pause();
  else resumeMasteryIfClear();
});
$("quit").addEventListener("click", () => {
  if (!game) return;
  if (game.mode === "mastery") {
    // Leaving a Mastery board keeps it; it's there to resume from the home screen.
    pause();
    game = null;
    renderHome();
    show("home");
    toast("Board saved. Resume it anytime.");
    return;
  }
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

// ---------- Mastery ----------

const MASTERY_KEY = "wg.mastery";

function loadMastery() {
  try {
    const m = JSON.parse(localStorage.getItem(MASTERY_KEY));
    return m && Array.isArray(m.board) ? m : null;
  } catch { return null; }
}
function clearMastery() {
  try { localStorage.removeItem(MASTERY_KEY); } catch {}
}
function saveMastery() {
  if (game?.mode !== "mastery" || game.over) return;
  lastSave = performance.now();
  const h = game.hint;
  save(MASTERY_KEY, {
    v: 1, sizeKey: game.sizeKey, board: game.board, found: game.found, assisted: [...game.assisted],
    hintsUsed: game.hintsUsed, elapsed: elapsed(), goalPct: game.goalPct, longReq: game.longReq,
    goalShown: game.goalShown,
    hint: h ? { word: h.target.word, focus: h.target.focus, root: h.target.root, level: h.level } : null,
  });
}

function startMastery() {
  const saved = loadMastery();
  if (saved) {
    // Rebuild from the saved board and size (not the current settings).
    const { minLen } = MODES[saved.sizeKey];
    const words = solve(saved.board, trie, minLen);
    const found = saved.found.filter((w) => words.has(w));
    game = newGameState("mastery", saved.sizeKey, saved.board, words, {
      found, foundSet: new Set(found), assisted: new Set(saved.assisted.filter((w) => words.has(w))),
      hintsUsed: saved.hintsUsed || 0, elapsed: saved.elapsed || 0,
      goalPct: saved.goalPct, longReq: saved.longReq, goalShown: !!saved.goalShown,
    });
    const h = saved.hint;
    if (h && words.has(h.word) && !game.foundSet.has(h.word)) {
      game.hint = { target: { word: h.word, focus: h.focus, root: h.root }, level: h.level, path: words.get(h.word).path };
    }
  } else {
    const sizeKey = Number(settings.size);
    const { board, words } = generateMasteryBoard(sizeKey, trie);
    game = newGameState("mastery", sizeKey, board, words, {
      goalPct: Number(settings.goal) / 100, longReq: settings.longword === "on", goalShown: false,
    });
  }
  setupGameScreen();
  saveMastery();
  game.running = true;
  game.resumedAt = performance.now();
  requestAnimationFrame(tick);
}

function masteryNow() {
  return masteryStats(game.words, game.foundSet, { goalPct: game.goalPct, longReq: game.longReq, minLen: game.minLen });
}

function updateMasteryHud() {
  const st = masteryNow();
  $("timer").textContent = `${st.found} / ${st.total}`;
  $("timer").classList.remove("low");
  $("m-fill").style.width = `${Math.min(100, st.pct * 100)}%`;
  $("m-goal").style.left = `${(st.goalCount / Math.max(1, st.total)) * 100}%`;
  $("m-bar").classList.toggle("met", st.goalMet);
  const long = game.longReq && !st.longMet ? " · plus one 6+ letter word" : "";
  $("m-text").textContent = st.goalMet
    ? `Goal reached · ${Math.round(st.pct * 100)}% of the common words`
    : `Goal: ${st.goalCount} words (${Math.round(game.goalPct * 100)}%)${long}`;
  $("m-extra").textContent = `${plural(game.hintsUsed, "hint")}${st.bonus ? ` · ${st.bonus} bonus` : ""}`;
  $("m-ladder").innerHTML = st.ladder.map((b) =>
    `<span class="rung${b.found === b.total ? " done" : ""}"><b>${b.label}</b> ${b.found}/${b.total}</span>`).join("");
}

// ---------- Mastery hints (only when asked) ----------

function showHintTiles({ starter = [], glow = [], guide = [] }) {
  for (const el of boardEl.children) {
    const i = Number(el.dataset.i);
    el.classList.toggle("starter", starter.includes(i));
    el.classList.toggle("starter-first", i === starter[0]);
    el.classList.toggle("glow", glow.includes(i));
    el.classList.toggle("guide", guide.includes(i));
  }
}

function setHintButton() {
  const h = game.hint;
  const next = h ? h.level + 1 : 0;
  $("hint-btn").innerHTML = `Hint <span id="hint-cost">· ${HINT_STEPS[Math.min(next, HINT_STEPS.length - 1)]}</span>`;
}

function hintStepNow() {
  const h = game.hint;
  return masteryHint(h.target, h.level, game.board, h.path, game.words, game.foundSet, trie);
}

// Redraw the current hint (after resuming a saved board).
function restoreHintUi() {
  if (game.hint && game.hint.level >= 0) {
    const step = hintStepNow();
    showHintTiles(step);
    setHintMsg(step.msg, true);
  } else {
    showHintTiles({});
    setHintMsg("Stuck? Ask for a hint. Each one counts.", false);
  }
  setHintButton();
}

function setHintMsg(text, active) {
  $("hint-msg").textContent = text;
  $("hint-msg").classList.toggle("active", active);
}

function spotForHints() {
  // Mastery's own profile once it has some history; until then, the timed one.
  return (profile.spotMastery?.all?.seen ?? 0) >= 20 ? profile.spotMastery : profile.spot;
}

$("hint-btn").addEventListener("click", async () => {
  if (!game?.running || game.mode !== "mastery") return;
  if (!game.hint) {
    const st = masteryNow();
    const target = pickMasteryTarget(game.words, game.foundSet, spotForHints(), trie,
      { preferLong: shouldPreferLong(game.words, game.foundSet, st) });
    if (!target) return setHintMsg("You've found every common word on this board!", true);
    game.hint = { target, level: -1, path: game.words.get(target.word).path };
  }
  const h = game.hint;
  h.level++;
  game.hintsUsed++;
  const step = hintStepNow();
  showHintTiles(step);
  setHintMsg(step.msg, true);
  if (step.reveal) {
    const word = h.target.word;
    acceptWord(word, { assisted: true });
    // Add the meaning when it arrives; fail quietly offline.
    define(word).then((d) => {
      if (d && $("hint-msg").textContent.startsWith(`Here it is: ${word.toUpperCase()}`)) {
        setHintMsg(`Here it is: ${word.toUpperCase()} (${d.pos}): ${d.text}`, true);
      }
    }).catch(() => {});
  } else {
    setHintButton();
    saveMastery();
  }
  updateHud();
});

// ---------- Finding words ----------

// Every newly found word goes through here, whether swiped or revealed by a hint.
function acceptWord(word, { assisted = false } = {}) {
  game.found.push(word);
  game.foundSet.add(word);
  game.score += scoreWord(word);
  game.lastFindAt = elapsed();
  if (assisted) game.assisted.add(word);
  if (game.hint?.target.word === word) {
    // Found the hinted word (or it was shown): it counts as found with help.
    game.assisted.add(word);
    const revealed = assisted;
    game.hint = null;
    if (!revealed) {
      showHintTiles({});
      setHintMsg("That's the one. Nice.", false);
    }
    setHintButton();
  }
  addChip(word, true, game.assisted.has(word));
  updateHud(elapsed());
  if (game.mode === "mastery") {
    saveMastery();
    const st = masteryNow();
    if (st.goalMet && !game.goalShown) {
      game.goalShown = true;
      saveMastery();
      showGoal(st);
    }
  }
}

function showGoal(st) {
  pause();
  $("goal-text").textContent =
    `${st.found} of ${st.total} common words (${Math.round(st.pct * 100)}%) · ${plural(game.hintsUsed, "hint")} · ${clock(elapsed())}`;
  $("goal").hidden = false;
}
$("goal-keep").addEventListener("click", () => { $("goal").hidden = true; resumeMasteryIfClear(); });
$("goal-finish").addEventListener("click", () => { $("goal").hidden = true; endGame(); });

function finishMastery() {
  const st = masteryNow();
  if (!st.goalMet && !confirm(`Finish this board? You've found ${st.found} of the ${st.goalCount} words in your goal.`)) return;
  endGame();
}

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
  const pts = word.length >= game.minLen && !state && game.mode !== "mastery" ? `+${scoreWord(word)}` : "";
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
  if (game.mode === "mastery" && !game.hint) showHintTiles({}); // clear a revealed word's glow
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
    pts = game.mode === "mastery" ? "" : `+${scoreWord(word)}`;
    acceptWord(word);
  } else {
    state = "bad"; pts = "not a word";
  }
  renderPath(state);
  setCurrent(word, pts, state);
  game.flashTimer = setTimeout(() => { if (game && !game.tracing) { game.path = []; renderPath(); } }, 450);
}

function addChip(word, animate = true, helped = false) {
  const chip = document.createElement("span");
  chip.className = `chip${animate ? " new" : ""}${helped ? " helped" : ""}`;
  chip.textContent = word;
  $("found").prepend(chip);
}

// ---------- Results ----------

function endGame() {
  if (game.mode === "mastery") game.elapsed = elapsed();
  game.running = false;
  game.over = true;
  cancelTrace();
  if (game.mode === "mastery") return endMastery();

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
  profile = updateProfile(profile, { sizeKey, durationSec: duration, playerPoints: score, available, result });
  // Rival ladder: classic-rules games count like any other, using the final scores.
  let ladderChange = 0, ladderAfter = null;
  if (result) {
    const { ladder, change } = updateLadder(getLadder(profile, sizeKey), { result, you: youFinal, rival: rivalFinal });
    profile.ladder = { ...profile.ladder, [sizeKey]: ladder };
    ladderChange = change;
    ladderAfter = ladder;
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
  renderLessons(buildLessons(words, foundSet, byTag, profile.spot));

  const titles = { win: "You beat the Rival!", loss: "Rival takes this one", tie: "Dead heat!" };
  $("result-title").textContent = titles[result] ?? "Time!";
  const pct = available ? (totalPoints(foundSet) / available) * 100 : 0;
  let sub = `${plural(game.found.length, "word")} of ${words.size} · ${pct.toFixed(1)}% of the board's points`;
  if (result) {
    sub += ladderChange >= 2 ? ` · Big jump! Rival moves up to level ${ladderAfter.level}`
      : ladderChange > 0 ? ` · You proved it. Rival moves up to level ${ladderAfter.level}`
      : ladderChange < 0 ? ` · Rival drops to level ${ladderAfter.level}`
      : ` · Level ${ladderAfter.level}: ${ladderStatus(ladderAfter)}`;
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
    : `<div><b style="color:var(--accent)">${score}</b><span>Points</span></div>
       <div><b>${available}</b><span>Available</span></div>`;

  showResults(700);
}

function showResults(delay) {
  $("tab-rival").hidden = game.mode !== "rival";
  renderTiles($("mini-board"), game.board, game.size);
  ensureMiniTrace();
  showPath([]);
  hideDefinition();
  selectTab("yours");
  setTimeout(() => show("results"), delay);
}

// Mastery's summary. It's untimed, so it stays out of the timed stats (Rival skill
// and pace, best score, best %) and keeps its own spotting profile.
function endMastery() {
  const { words, foundSet, assisted } = game;
  const st = masteryNow();
  clearMastery();
  const byTag = analyzeRound(words, foundSet, assisted, trie);
  profile.spotMastery = updateSpotting(profile.spotMastery || {}, byTag);
  const longest = [...foundSet].sort((a, b) => b.length - a.length)[0] || "";
  profile.mastery = [...(profile.mastery ?? []), {
    t: Date.now(), sizeKey: game.sizeKey, total: st.total, found: st.found, goal: game.goalPct,
    goalMet: st.goalMet, hints: game.hintsUsed, secs: Math.round(game.elapsed), longest,
  }].slice(-50);
  save("wg.profile", profile);
  renderLessons(buildLessons(words, foundSet, byTag, profile.spotMastery));

  $("result-title").textContent = st.goalMet ? "Board mastered!" : "Board finished";
  let sub = `${st.found} of ${st.total} common words · ${plural(game.hintsUsed, "hint")} · ${clock(game.elapsed)}`;
  if (longest) sub += ` · longest: ${longest.toUpperCase()}`;
  if (st.bonus) sub += ` · ${st.bonus} bonus ${st.bonus === 1 ? "word" : "words"}`;
  $("result-sub").textContent = sub;
  $("result-scores").innerHTML = `
    <div><b style="color:var(--accent)">${Math.round(st.pct * 100)}%</b><span>Common words</span></div>
    <div><b>${game.hintsUsed}</b><span>Hints</span></div>
    <div><b>${clock(game.elapsed)}</b><span>Time</span></div>`;
  showResults(300);
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
    if (game.mode === "mastery" && game.assisted.size) legend = "• = found with a hint or shown to you";
    if (game.mode === "rival") legend = game.classic ? "• = the Rival found it too (cancelled, scores 0)" : "• = the Rival found it too";
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
    : tab === "yours" && game.mode === "mastery" ? game.assisted
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
$("reset-rival").addEventListener("click", () => {
  const n = settings.size;
  if (!confirm(`Reset the ${n}×${n} Rival? You'll play 5 placement games to find your level again. Your win/loss record is kept.`)) return;
  profile.ladder = { ...profile.ladder, [n]: freshLadder(profile, n) };
  save("wg.profile", profile);
  renderHome();
  toast(`${n}×${n} Rival reset`);
});
$("close-settings").addEventListener("click", () => { renderHome(); show("home"); });
$("play-mastery").addEventListener("click", () => startGame("mastery"));
$("play-rival").addEventListener("click", () => startGame("rival"));
$("play-free").addEventListener("click", () => startGame("free"));

// ---------- Easter egg ----------
// Off by default. Tapping the home logo 5 times arms it on this device and opens its
// picture screen (which can also turn it off).
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
const tapLog = {}; // separate counters, so taps in one place never count toward another

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

function fiveTaps(where) {
  const now = Date.now();
  const taps = [...(tapLog[where] ?? []).filter((t) => now - t < 3000), now];
  tapLog[where] = taps.length >= 5 ? [] : taps;
  return taps.length >= 5;
}

// 5 quick taps on the logo: arms the surprise (if it isn't already) and opens its
// picture screen, which also has the button to turn it off.
document.querySelector(".logo").addEventListener("click", () => {
  if (!fiveTaps("logo")) return;
  if (!load(EGG_KEY, EGG_DEFAULT).on) {
    save(EGG_KEY, { ...EGG_OFF, on: true });
    toast("Surprise armed");
  }
  openEggSetup();
});

$("setup-off").addEventListener("click", () => {
  save(EGG_KEY, EGG_OFF); // pictures stay saved for next time
  $("egg-setup").hidden = true;
  toast("Surprise off");
});

$("egg-msg").addEventListener("click", () => {
  if (!$("egg").classList.contains("locked") || !fiveTaps("bedtime")) return;
  save(EGG_KEY, EGG_OFF);
  $("egg").hidden = true;
  $("egg").classList.remove("locked");
  toast("Surprise off");
  resumeMasteryIfClear();
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
      resumeMasteryIfClear();
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
    resumeMasteryIfClear();
  });
}
document.addEventListener("visibilitychange", () => { if (!document.hidden) eggTick(false); });
eggTick(false);

$("egg-close").addEventListener("click", () => { $("egg").hidden = true; resumeMasteryIfClear(); });

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

window.__wgStarted = true;
$("version").textContent = `Version ${APP_VERSION}`;
renderHome();
fetch("words.txt")
  .then((r) => r.text())
  .then((text) => {
    trie = buildTrie(text);
    renderHome();
  })
  .catch(() => { $("status").textContent = "Couldn't load the dictionary. Close the app and open it again."; });

if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost")) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}
