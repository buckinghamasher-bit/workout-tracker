import { useState, useEffect, useRef } from "react";
import * as XLSX from "xlsx";
import { LineChart, Line, XAxis, YAxis, Tooltip, Legend, ResponsiveContainer } from "recharts";

const STORAGE_KEY = "iron-log-data";
const AUTH_KEY = "iron-log-auth";

const DEFAULT_CREDENTIALS = { username: "Asher26", password: "Hello1234" };

function getCredentials() {
  try {
    const raw = localStorage.getItem(AUTH_KEY);
    if (raw) return JSON.parse(raw);
  } catch {}
  return { ...DEFAULT_CREDENTIALS };
}

function saveCredentials(creds) {
  try { localStorage.setItem(AUTH_KEY, JSON.stringify(creds)); } catch {}
}

const SET_CATEGORIES = ["Warm Up Set", "Working Set"];
const DIFFICULTIES = ["Easy", "Medium", "Difficult", "Extremely Difficult"];

const DEFAULT_ROUTINES = [
  { id: "r1", name: "Push", exercises: [] },
  { id: "r2", name: "Pull", exercises: [] },
  { id: "r3", name: "Legs", exercises: [] },
  { id: "r4", name: "Upper", exercises: [] },
  { id: "r5", name: "Lower", exercises: [] },
  { id: "r6", name: "Full Body", exercises: [] },
];

function formatDate(iso) {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}
function formatDateShort(iso) {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
function formatTime(seconds) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}
function uid() {
  return "_" + Math.random().toString(36).slice(2);
}
function avg(arr) {
  if (!arr.length) return null;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}
function round1(n) {
  return Math.round(n * 10) / 10;
}



function migrateData(raw) {
  let d = JSON.parse(raw);
  if (d.routines && typeof d.routines[0] === "string") {
    const nameToId = {};
    d.routines = d.routines.map(name => {
      const id = "r" + uid();
      nameToId[name] = id;
      return { id, name, exercises: [] };
    });
    d.sessions = (d.sessions || []).map(s => ({ ...s, routineId: nameToId[s.routine] || s.routine }));
  }
  d.routines = (d.routines || []).map(r => ({ exercises: [], ...r }));
  // Ensure benchmarks array exists
  if (!d.benchmarks) d.benchmarks = [];
  if (!d.schedule) d.schedule = { Sun: null, Mon: null, Tue: null, Wed: null, Thu: null, Fri: null, Sat: null };
  return d;
}

const EMPTY_DATA = {
  routines: DEFAULT_ROUTINES,
  sessions: [],
  benchmarks: [],
  schedule: { Sun: null, Mon: null, Tue: null, Wed: null, Thu: null, Fri: null, Sat: null }
};

const initialData = () => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return migrateData(raw);
  } catch {}
  return EMPTY_DATA;
};

function getPrevSession(sessions, routineId) {
  return sessions.find(s => s.routineId === routineId) || null;
}

function getPrevSetData(prevSession, exerciseName, setIndex) {
  if (!prevSession || !exerciseName) return null;
  const ex = prevSession.exercises.find(
    e => e.name.trim().toLowerCase() === exerciseName.trim().toLowerCase()
  );
  if (!ex || !ex.sets[setIndex]) return null;
  return ex.sets[setIndex];
}

// Round to nearest 5 lbs if above 20 lbs, otherwise return as-is (floored to 1)
function roundWeight(n) {
  if (n > 20) return Math.round(n / 5) * 5 || 5;
  return Math.max(5, Math.round(n));
}
// Keep roundUpTo5 as alias for backward compat (now uses roundWeight logic)
function roundUpTo5(n) {
  return roundWeight(n);
}

// Get all historical sets for a given exercise name + set index across sessions (newest first)
function getSetHistory(sessions, exerciseName, setIndex) {
  const name = exerciseName.trim().toLowerCase();
  return sessions.reduce((acc, session) => {
    const ex = session.exercises.find(e => e.name.trim().toLowerCase() === name);
    if (!ex || !ex.sets[setIndex]) return acc;
    const s = ex.sets[setIndex];
    const w = parseFloat(s.weight);
    const r = parseFloat(s.reps);
    if (!isNaN(w) && w > 0) acc.push({ weight: w, reps: isNaN(r) ? null : r, difficulty: s.difficulty || null });
    return acc;
  }, []);
}

// Suggest weight for a working set given its history and template reps.
// Rule: weight only increases (+5 lbs) when the previous session logged
// "Difficult" AND hit >= template reps at that weight.
// All other cases hold or reduce weight.
function suggestWeight(sessions, exerciseName, setIndex, templateReps) {
  const history = getSetHistory(sessions, exerciseName, setIndex);
  if (!history.length) return null;

  const latest = history[0]; // newest first
  if (!latest.difficulty) return null;

  const w = latest.weight;
  const tmplReps = parseFloat(templateReps);
  const hitTemplateReps = !isNaN(tmplReps) && latest.reps !== null && latest.reps >= tmplReps;

  // The only condition that triggers a weight increase:
  // previous set was "Difficult" AND reps met the template target
  if (latest.difficulty === "Difficult" && hitTemplateReps) return roundWeight(w + 5);

  // Difficult but didn't hit template reps → hold weight, keep working at it
  if (latest.difficulty === "Difficult" && !hitTemplateReps) return roundWeight(w);

  // Too hard → reduce to give a chance to hit reps at "Difficult"
  if (latest.difficulty === "Extremely Difficult") return Math.max(5, roundUpTo5(w * 0.75));

  // Too easy (Easy or Medium) → hold weight; these ratings mean the
  // stimulus wasn't right, not that weight should jump — the user should
  // reassess effort rather than auto-escalate
  return roundWeight(w);
}

// Get the first working set weight for a given exercise in a session
function getFirstWorkingSetWeight(session, exerciseName) {
  if (!session) return null;
  const name = exerciseName.trim().toLowerCase();
  const ex = session.exercises.find(e => e.name.trim().toLowerCase() === name);
  if (!ex) return null;
  for (const s of ex.sets) {
    if (s.category === "Working Set") {
      const w = parseFloat(s.weight);
      if (!isNaN(w) && w > 0) return w;
    }
  }
  return null;
}

// Suggest weight for a warm-up set.
// Target: keep warm-up easy relative to first working set.
// Base ratio starts at 50% of first working set.
// Adapts up/down based on past warm-up difficulty ratings to converge on "Easy".
function suggestWarmupWeight(sessions, exerciseName, setIndex, currentSessionExercises) {
  const name = exerciseName.trim().toLowerCase();

  // Anchor: first working set weight from the most recent completed session only.
  // We never look at the current session — warm-ups are done before working sets,
  // so live working set entries cannot inform warm-up suggestions in the same session.
  const firstWorkingWeight = sessions.length
    ? getFirstWorkingSetWeight(sessions[0], exerciseName)
    : null;
  if (!firstWorkingWeight) return null;

  // Gather history of this warm-up set's difficulty ratings (newest first)
  const warmupHistory = getSetHistory(sessions, exerciseName, setIndex);

  // Base ratio: start at 50% of first working set
  // Each session we adjust based on difficulty feedback to converge on "Easy"
  // Target: difficulty === "Easy". Score each session's difficulty:
  //   Easy (target) → no change needed
  //   Medium → too hard, reduce ratio
  //   Difficult / Extremely Difficult → way too hard, reduce more
  //   (Warm-up should never be pushed harder, so we ignore upward pressure)

  const INITIAL_RATIO = 0.50;

  if (!warmupHistory.length) {
    // No history yet — use 50% of first working set
    return Math.max(5, roundUpTo5(firstWorkingWeight * INITIAL_RATIO));
  }

  // Compute adaptive ratio from historical warmup difficulty
  // Walk history oldest→newest accumulating ratio adjustments
  const historyOldFirst = [...warmupHistory].reverse();
  let ratio = INITIAL_RATIO;

  for (const h of historyOldFirst) {
    if (!h.difficulty) continue;
    if (h.difficulty === "Easy") {
      // On target — nudge ratio up very slightly to not leave too much on the table
      ratio = Math.min(ratio + 0.02, 0.70);
    } else if (h.difficulty === "Medium") {
      // A bit too hard — pull back
      ratio = Math.max(ratio - 0.04, 0.25);
    } else if (h.difficulty === "Difficult") {
      // Too hard for a warm-up — pull back more
      ratio = Math.max(ratio - 0.08, 0.20);
    } else if (h.difficulty === "Extremely Difficult") {
      // Way too hard — significant reduction
      ratio = Math.max(ratio - 0.15, 0.15);
    }
  }

  return Math.max(5, roundUpTo5(firstWorkingWeight * ratio));
}

// Get avg weight of warm-up sets for an exercise in a session
function getWarmupAvgWeight(session, exerciseName) {
  if (!session) return null;
  const name = exerciseName.trim().toLowerCase();
  const ex = session.exercises.find(e => e.name.trim().toLowerCase() === name);
  if (!ex) return null;
  const weights = ex.sets
    .filter(s => s.category === "Warm Up Set")
    .map(s => parseFloat(s.weight))
    .filter(n => !isNaN(n) && n > 0);
  return weights.length ? avg(weights) : null;
}

// Get history of drop sets for a given exercise (newest first, all sessions)
function getDropSetHistory(sessions, exerciseName) {
  const name = exerciseName.trim().toLowerCase();
  const result = [];
  for (const session of sessions) {
    const ex = session.exercises.find(e => e.name.trim().toLowerCase() === name);
    if (!ex) continue;
    const sessionDrops = [];
    for (const s of ex.sets) {
      if (!s.dropSets) continue;
      for (const ds of s.dropSets) {
        const w = parseFloat(ds.weight);
        const r = parseFloat(ds.reps);
        if (!isNaN(w) && w > 0) {
          sessionDrops.push({ weight: w, reps: isNaN(r) ? null : r, difficulty: ds.difficulty || null });
        }
      }
    }
    if (sessionDrops.length) result.push(sessionDrops);
  }
  return result; // array of sessions, each an array of drop sets
}

// Suggest weight and reps for a drop set.
// Target: weight in warm-up range, reps converging to "Extremely Difficult".
function suggestDropSet(sessions, exerciseName, currentSessionExercises, dropIndex, currentDropSets) {
  const name = exerciseName.trim().toLowerCase();

  // Anchor: avg warm-up weight from current session or most recent historical
  let warmupWeight = null;
  if (currentSessionExercises) {
    const ex = currentSessionExercises.find(e => e.name.trim().toLowerCase() === name);
    if (ex) {
      const weights = ex.sets
        .filter(s => s.category === "Warm Up Set")
        .map(s => parseFloat(s.weight))
        .filter(n => !isNaN(n) && n > 0);
      if (weights.length) warmupWeight = avg(weights);
    }
  }
  if (!warmupWeight) {
    for (const session of sessions) {
      warmupWeight = getWarmupAvgWeight(session, exerciseName);
      if (warmupWeight) break;
    }
  }
  if (!warmupWeight) return null;

  const allHistory = getDropSetHistory(sessions, exerciseName); // array of sessions

  // For D2+: weight must always decrease vs predecessor; reps adapt via difficulty history
  if (dropIndex > 0) {
    // Get predecessor weight ceiling — from live entry or historical
    const predLive = currentDropSets && currentDropSets[dropIndex - 1];
    const predLiveW = predLive ? parseFloat(predLive.weight) : NaN;
    const predLiveR = predLive ? parseFloat(predLive.reps) : NaN;

    // Historical predecessor weight (same drop index - 1, most recent session)
    let predHistW = NaN;
    if (allHistory.length) {
      const h = allHistory[0][dropIndex - 1];
      if (h) predHistW = parseFloat(h.weight) || NaN;
    }

    // Ceiling: the predecessor's actual weight (live preferred, else historical)
    const predCeilingW = (!isNaN(predLiveW) && predLiveW > 0) ? predLiveW
                       : (!isNaN(predHistW) && predHistW > 0) ? predHistW
                       : warmupWeight * 0.9; // safe fallback slightly below warmup

    // Get this drop set's own historical data at this index (newest first)
    const diffScores = { "Easy": -3, "Medium": -2, "Difficult": -1, "Extremely Difficult": 0 };
    const thisDropHistory = allHistory.slice(0, 3).map(sess => sess[dropIndex]).filter(Boolean);
    const scored = thisDropHistory.filter(h => h.difficulty).map(h => diffScores[h.difficulty] !== undefined ? diffScores[h.difficulty] : -1);
    const avgDiffScore = scored.length ? scored.reduce((a, b) => a + b, 0) / scored.length : -1;

    // Compute base weight from this drop set's own history if available, else start at 80% of predecessor
    const ownLatest = thisDropHistory[0];
    let baseW = (ownLatest && ownLatest.weight > 0) ? ownLatest.weight : roundUpTo5(predCeilingW * 0.80);

    // Adjust reps direction based on difficulty, but weight always decreases
    // Weight adjustments: converge toward Extremely Difficult but never exceed predecessor
    let sugWeight;
    if (avgDiffScore >= -0.5) {
      // On target (Extremely Difficult) — micro-increment reps only; hold weight
      sugWeight = roundWeight(baseW);
    } else if (avgDiffScore >= -1.5) {
      // Difficult but not extreme — small weight increase, still capped below predecessor
      sugWeight = Math.min(roundWeight(baseW + 5), predCeilingW - 5);
    } else if (avgDiffScore >= -2.5) {
      // Medium — moderate weight increase, capped
      sugWeight = Math.min(roundUpTo5(baseW * 1.10), predCeilingW - 5);
    } else {
      // Easy — bigger weight increase, still capped
      sugWeight = Math.min(roundUpTo5(baseW * 1.20), predCeilingW - 5);
    }
    // Hard enforce: suggested weight must always be strictly less than predecessor
    sugWeight = Math.min(sugWeight, Math.max(roundWeight(predCeilingW) - 5, 5));
    sugWeight = roundWeight(Math.max(sugWeight, 5)); // floor at 5 lbs, ensure rounded

    // Reps: start from this drop set's own history, then adjust for weight change
    const baseReps = (ownLatest && ownLatest.reps > 0) ? ownLatest.reps
                   : (!isNaN(predLiveR) && predLiveR > 0) ? predLiveR
                   : 10;

    const weightRatio = baseW > 0 ? sugWeight / baseW : 1;
    let sugReps = baseReps;
    if (weightRatio > 1.01) {
      // Weight went up → reps come down
      sugReps = Math.max(1, Math.round(baseReps * Math.pow(weightRatio, -1.5)));
    } else if (avgDiffScore >= -0.5 && weightRatio <= 1.01) {
      // Weight held at Extremely Difficult → nudge reps up
      sugReps = Math.min(baseReps + 1, 20);
    } else if (avgDiffScore <= -2 && weightRatio <= 1.01) {
      // Too easy with same weight → bump reps more
      sugReps = Math.min(baseReps + 2, 20);
    }

    return { weight: roundWeight(Math.max(5, sugWeight)), reps: sugReps };
  }

  // D1: anchor to warm-up weight (existing logic)
  // Baseline reps: warm-up set whose weight is closest to warmupWeight
  function getWarmupBaseReps() {
    const sources = currentSessionExercises
      ? [{ exercises: currentSessionExercises }, ...sessions.map(s => ({ exercises: s.exercises }))]
      : sessions.map(s => ({ exercises: s.exercises }));
    for (const src of sources) {
      const ex = (src.exercises || []).find(e => e.name && e.name.trim().toLowerCase() === name);
      if (!ex) continue;
      const warmupSets = ex.sets.filter(s => s.category === "Warm Up Set");
      if (!warmupSets.length) continue;
      const best = warmupSets
        .map(s => ({ reps: parseFloat(s.reps), weight: parseFloat(s.weight) }))
        .filter(s => !isNaN(s.reps) && s.reps > 0 && !isNaN(s.weight) && s.weight > 0)
        .sort((a, b) => Math.abs(a.weight - warmupWeight) - Math.abs(b.weight - warmupWeight))[0];
      if (best) return best.reps;
    }
    return null;
  }

  const warmupBaseReps = getWarmupBaseReps();

  if (!allHistory.length) {
    return { weight: Math.max(5, roundUpTo5(warmupWeight)), reps: warmupBaseReps || 10 };
  }

  const flatRecent = allHistory.slice(0, 3).flat();
  const diffScores = { "Easy": -3, "Medium": -2, "Difficult": -1, "Extremely Difficult": 0 };
  const scored = flatRecent.filter(h => h.difficulty).map(h => diffScores[h.difficulty] !== undefined ? diffScores[h.difficulty] : -1);
  const avgDiffScore = scored.length ? scored.reduce((a, b) => a + b, 0) / scored.length : -1;

  const latestSession = allHistory[0];
  const latest = latestSession[0];
  let sugWeight = latest.weight;

  if (avgDiffScore >= -0.5) sugWeight = roundWeight(sugWeight + 2.5);
  else if (avgDiffScore >= -1.5) sugWeight = roundWeight(sugWeight + 5);
  else if (avgDiffScore >= -2.5) sugWeight = roundUpTo5(sugWeight * 1.15);
  else sugWeight = roundUpTo5(sugWeight * 1.25);

  const baseReps = (latest.reps !== null && latest.reps > 0) ? latest.reps : (warmupBaseReps || 10);
  const weightRatio = latest.weight > 0 ? sugWeight / latest.weight : 1;
  let sugReps = baseReps;

  if (weightRatio > 1.01) sugReps = Math.max(1, Math.round(baseReps * Math.pow(weightRatio, -1.5)));
  if (avgDiffScore <= -2 && weightRatio <= 1.01) sugReps = Math.min(baseReps + 2, 20);

  return { weight: roundWeight(Math.max(5, sugWeight)), reps: sugReps };
}

// For a given exercise name, collect working-set averages per session (chronological)// For a given exercise name, collect working-set averages per session (chronological)
function getBenchmarkHistory(sessions, exerciseName) {
  const name = exerciseName.trim().toLowerCase();
  // sessions are stored newest-first, so reverse for chronological order
  return [...sessions].reverse().reduce((acc, session) => {
    const ex = session.exercises.find(e => e.name.trim().toLowerCase() === name);
    if (!ex) return acc;
    const workingSets = ex.sets.filter(s => s.category === "Working Set");
    if (!workingSets.length) return acc;
    const weights = workingSets.map(s => parseFloat(s.weight)).filter(n => !isNaN(n));
    const reps = workingSets.map(s => parseFloat(s.reps)).filter(n => !isNaN(n));
    if (!weights.length && !reps.length) return acc;
    acc.push({
      date: session.date,
      label: formatDateShort(session.date),
      weight: weights.length ? round1(avg(weights)) : null,
      reps: reps.length ? round1(avg(reps)) : null,
    });
    return acc;
  }, []);
}

// Latest working-set averages for a given exercise name
function getLatestWorkingSetAvg(sessions, exerciseName) {
  const name = exerciseName.trim().toLowerCase();
  for (const session of sessions) {
    const ex = session.exercises.find(e => e.name.trim().toLowerCase() === name);
    if (!ex) continue;
    const workingSets = ex.sets.filter(s => s.category === "Working Set");
    if (!workingSets.length) continue;
    const weights = workingSets.map(s => parseFloat(s.weight)).filter(n => !isNaN(n));
    const reps = workingSets.map(s => parseFloat(s.reps)).filter(n => !isNaN(n));
    return {
      date: session.date,
      weight: weights.length ? round1(avg(weights)) : null,
      reps: reps.length ? round1(avg(reps)) : null,
    };
  }
  return null;
}


const THEME_STORAGE_KEY = "iron-log-theme";

const THEMES = {
  dark: {
    name: "Dark",
    app: "#0c0c0e",
    surface: "#111113",
    surfaceAlt: "#1a1a1d",
    border: "#2a2a2e",
    borderSubtle: "#1e1e22",
    header: "rgba(12,12,14,0.92)",
    primaryText: "#e8e4dc",
    mutedText: "#e8e4dc",
    subtleText: "#aaa",
    accent: "#c8ff00",
    accentDim: "#111a00",
    accentBorder: "#c8ff0033",
    workingTarget: "#4a9eff",
    warmupTarget: "#ff9f43",
    dropTarget: "#ff4d9e",
    prevText: "#4a7a00",
    prevBadge: "#3a6600",
    inputBg: "#0c0c0e",
    inputBorder: "#222",
    dangerText: "#ff6666",
    dangerBg: "#2a0000",
    dangerBorder: "#550000",
  },
  light: {
    name: "Light",
    app: "#f4f3ef",
    surface: "#ffffff",
    surfaceAlt: "#ebebeb",
    border: "#d0cfc9",
    borderSubtle: "#e0dfd9",
    header: "rgba(244,243,239,0.94)",
    primaryText: "#1a1a1c",
    mutedText: "#111",
    subtleText: "#333",
    accent: "#3d7a00",
    accentDim: "#f0fae0",
    accentBorder: "#3d7a0033",
    workingTarget: "#1a6fd4",
    warmupTarget: "#c97000",
    dropTarget: "#c4006e",
    inputBg: "#f9f8f5",
    inputBorder: "#ccc",
    dangerText: "#cc0000",
    dangerBg: "#fff0f0",
    dangerBorder: "#ffaaaa",
  },
  midnight: {
    name: "Midnight",
    app: "#070b14",
    surface: "#0d1117",
    surfaceAlt: "#161b22",
    border: "#21262d",
    borderSubtle: "#161b22",
    header: "rgba(7,11,20,0.95)",
    primaryText: "#cdd9e5",
    mutedText: "#cdd9e5",
    subtleText: "#aab8c2",
    accent: "#58a6ff",
    accentDim: "#0d1f33",
    accentBorder: "#58a6ff33",
    workingTarget: "#3fb950",
    warmupTarget: "#e3b341",
    dropTarget: "#f78166",
    inputBg: "#070b14",
    inputBorder: "#21262d",
    dangerText: "#f85149",
    dangerBg: "#1c1010",
    dangerBorder: "#6e2020",
  },
};

const initialTheme = () => {
  try {
    const raw = localStorage.getItem(THEME_STORAGE_KEY);
    if (raw && THEMES[raw]) return THEMES[raw];
  } catch {}
  return THEMES.dark;
};

const initialThemeKey = () => {
  try {
    const raw = localStorage.getItem(THEME_STORAGE_KEY);
    if (raw && THEMES[raw]) return raw;
  } catch {}
  return "dark";
};

export default function App() {
  const [data, setData] = useState(initialData);
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [loginUsername, setLoginUsername] = useState("");
  const [loginPassword, setLoginPassword] = useState("");
  const [loginError, setLoginError] = useState("");
  const [themeKey, setThemeKey] = useState(initialThemeKey);
  const [showSettings, setShowSettings] = useState(false);
  const [settingsTab, setSettingsTab] = useState("theme"); // "theme" | "account"
  const [newUsername, setNewUsername] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [accountMsg, setAccountMsg] = useState("");
  const theme = THEMES[themeKey] || THEMES.dark;
  const [view, setView] = useState("home");
  const [editingRoutine, setEditingRoutine] = useState(null);
  const [activeRoutine, setActiveRoutine] = useState(null);
  const [currentSession, setCurrentSession] = useState(null);
  const [selectedSession, setSelectedSession] = useState(null);
  const [newRoutineName, setNewRoutineName] = useState("");
  const [showAddRoutine, setShowAddRoutine] = useState(false);
  const [renamingId, setRenamingId] = useState(null);
  const [renameValue, setRenameValue] = useState("");
  const [showDiscardConfirm, setShowDiscardConfirm] = useState(false);
  const [deleteConfirmId, setDeleteConfirmId] = useState(null);
  const [pendingNav, setPendingNav] = useState(null);
  const [restRunning, setRestRunning] = useState(false);
  const [restElapsed, setRestElapsed] = useState(0);
  const [lastSetRef, setLastSetRef] = useState(null); // {exId, si} of last touched set
  const [activeBenchmark, setActiveBenchmark] = useState(null); // name string
  const [scheduleEditing, setScheduleEditing] = useState(false);
  const [manualEntry, setManualEntry] = useState(null); // {routineId, date, exercises}
  const [activeSetModal, setActiveSetModal] = useState(null); // {exId, si, isDropSet, di}
  const [lastCompletedKey, setLastCompletedKey] = useState(null); // "exId:si" of last completed set
  const [restSnapshot, setRestSnapshot] = useState({}); // {key: elapsed} snapshots after each set
  const [setDraft, setSetDraft] = useState({}); // draft values while modal open
  const [notesModal, setNotesModal] = useState(null); // { context: "tmpl"|"log", exId, si, value }
  const [notesDraft, setNotesDraft] = useState("");
  const timerRef = useRef(null);

  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(data)); } catch {}
  }, [data]);

  useEffect(() => {
    if (restRunning) {
      timerRef.current = setInterval(() => {
        setRestElapsed(s => s + 1);
      }, 1000);
    } else {
      clearInterval(timerRef.current);
    }
    return () => clearInterval(timerRef.current);
  }, [restRunning]);

  function getRoutineName(routineId) {
    const r = data.routines.find(r => r.id === routineId);
    return r ? r.name : routineId;
  }

  function safeNav(target) {
    if (currentSession) {
      setPendingNav(target);
      setShowDiscardConfirm(true);
    } else {
      setView(target);
    }
  }

  function discardSession() {
    setCurrentSession(null);
    setRestRunning(false);
    setRestElapsed(0);
    setShowDiscardConfirm(false);
    setView(pendingNav || "home");
    setPendingNav(null);
  }

  // ── ROUTINE TEMPLATE EDITING ─────────────────────────────────────────────

  function openEditRoutine(routine) {
    setEditingRoutine(JSON.parse(JSON.stringify(routine)));
    setView("editRoutine");
  }

  function saveRoutineTemplate() {
    setData(d => ({ ...d, routines: d.routines.map(r => r.id === editingRoutine.id ? editingRoutine : r) }));
    setEditingRoutine(null);
    setView("home");
  }

  function tmplAddExercise() {
    setEditingRoutine(r => ({
      ...r,
      exercises: [...r.exercises, { id: uid(), name: "", category: "Working Set", allowDropSets: true, sets: [{ reps: "", rest: "", notes: "", category: "Working Set" }] }]
    }));
  }

  function tmplToggleDropSets(exId) {
    setEditingRoutine(r => ({
      ...r,
      exercises: r.exercises.map(e => e.id === exId ? { ...e, allowDropSets: !e.allowDropSets } : e)
    }));
  }

  function tmplUpdateExName(exId, name) {
    setEditingRoutine(r => ({ ...r, exercises: r.exercises.map(e => e.id === exId ? { ...e, name } : e) }));
  }

  function tmplRemoveExercise(exId) {
    setEditingRoutine(r => ({ ...r, exercises: r.exercises.filter(e => e.id !== exId) }));
  }

  function tmplMoveExercise(exId, dir) {
    setEditingRoutine(r => {
      const exs = [...r.exercises];
      const i = exs.findIndex(e => e.id === exId);
      const j = i + dir;
      if (j < 0 || j >= exs.length) return r;
      [exs[i], exs[j]] = [exs[j], exs[i]];
      return { ...r, exercises: exs };
    });
  }

  function tmplAddSet(exId) {
    setEditingRoutine(r => ({
      ...r,
      exercises: r.exercises.map(e =>
        e.id === exId ? { ...e, sets: [...e.sets, { reps: "", rest: "", notes: "", category: e.category || "Working Set" }] } : e
      )
    }));
  }

  function tmplUpdateSet(exId, si, field, value) {
    setEditingRoutine(r => ({
      ...r,
      exercises: r.exercises.map(e =>
        e.id === exId ? { ...e, sets: e.sets.map((s, i) => i === si ? { ...s, [field]: value } : s) } : e
      )
    }));
  }

  function tmplRemoveSet(exId, si) {
    setEditingRoutine(r => ({
      ...r,
      exercises: r.exercises.map(e =>
        e.id === exId ? { ...e, sets: e.sets.filter((_, i) => i !== si) } : e
      )
    }));
  }

  // ── SESSION LOGGING ──────────────────────────────────────────────────────

  function startSession(routine) {
    const exercises = routine.exercises.map(e => ({
      ...e,
      id: uid(),
      sets: e.sets.map(s => ({ ...s, weight: "" }))
    }));
    setActiveRoutine(routine);
    setCurrentSession({ routineId: routine.id, date: new Date().toISOString(), exercises });
    setView("log");
  }

  function sessionUpdateExName(exId, name) {
    setCurrentSession(s => ({ ...s, exercises: s.exercises.map(e => e.id === exId ? { ...e, name } : e) }));
  }

  function sessionUpdateSet(exId, si, field, value) {
    setLastSetRef({ exId, si });
    setCurrentSession(s => ({
      ...s,
      exercises: s.exercises.map(e =>
        e.id === exId ? { ...e, sets: e.sets.map((set, i) => i === si ? { ...set, [field]: value } : set) } : e
      )
    }));
  }

  function openSetModal(exId, si, isDropSet = false, di = null) {
    // Stop rest timer - snapshot elapsed onto the PREVIOUS completed set key
    if (restRunning && restElapsed > 0 && lastCompletedKey) {
      const mins = Math.floor(restElapsed / 60);
      const secs = restElapsed % 60;
      const formatted = mins + ":" + String(secs).padStart(2, "0");
      setRestSnapshot(prev => ({ ...prev, [lastCompletedKey]: restElapsed }));
      // Write rest to the PREVIOUS set (the one that was just completed)
      const parts = lastCompletedKey.split(":");
      const prevExId = parts[0];
      const prevSi = parseInt(parts[1]);
      const isDrop = parts[2] && parts[2].startsWith("d");
      const prevDi = isDrop ? parseInt(parts[2].slice(1)) : null;
      if (isDrop) sessionUpdateDropSet(prevExId, prevSi, prevDi, "rest", formatted);
      else sessionUpdateSet(prevExId, prevSi, "rest", formatted);
      setRestRunning(false);
      setRestElapsed(0);
    }
    // Load current values into draft
    const ex = currentSession && currentSession.exercises.find(e => e.id === exId);
    if (!ex) return;
    let current;
    if (isDropSet) {
      current = ex.sets[si] && ex.sets[si].dropSets && ex.sets[si].dropSets[di] || {};
    } else {
      current = ex.sets[si] || {};
    }
    setSetDraft({
      reps: current.reps || "",
      weight: current.weight || "",
      difficulty: current.difficulty || "",
      notes: current.notes || "",
      dropSets: (current.dropSets || []).map(ds => ({...ds})),
    });
    setActiveSetModal({ exId, si, isDropSet, di });
  }

  function completeSet() {
    const { exId, si, isDropSet, di } = activeSetModal;
    const key = isDropSet ? exId + ":" + si + ":d" + di : exId + ":" + si;
    if (isDropSet) {
      Object.entries(setDraft).forEach(([field, value]) => {
        if (field !== "dropSets") sessionUpdateDropSet(exId, si, di, field, value);
      });
    } else {
      const { dropSets, ...mainFields } = setDraft;
      Object.entries(mainFields).forEach(([field, value]) => {
        sessionUpdateSet(exId, si, field, value);
      });
      // Save drop sets wholesale
      setCurrentSession(s => ({
        ...s,
        exercises: s.exercises.map(e =>
          e.id === exId ? {
            ...e,
            sets: e.sets.map((set, i) => i === si ? { ...set, dropSets: dropSets || [] } : set)
          } : e
        )
      }));
    }
    setActiveSetModal(null);
    setLastCompletedKey(key);
    setRestSnapshot(prev => ({ ...prev, [key]: 0 }));
    setRestElapsed(0);
    setRestRunning(true);
  }

  function sessionAddDropSet(exId, si) {
    setCurrentSession(s => ({
      ...s,
      exercises: s.exercises.map(e =>
        e.id === exId ? {
          ...e,
          sets: e.sets.map((set, i) => i === si ? {
            ...set,
            dropSets: [...(set.dropSets || []), { id: uid(), reps: "", weight: "", difficulty: "", notes: "" }]
          } : set)
        } : e
      )
    }));
  }

  function sessionUpdateDropSet(exId, si, di, field, value) {
    setCurrentSession(s => ({
      ...s,
      exercises: s.exercises.map(e =>
        e.id === exId ? {
          ...e,
          sets: e.sets.map((set, i) => i === si ? {
            ...set,
            dropSets: (set.dropSets || []).map((ds, d) => d === di ? { ...ds, [field]: value } : ds)
          } : set)
        } : e
      )
    }));
  }

  function sessionRemoveDropSet(exId, si, di) {
    setCurrentSession(s => ({
      ...s,
      exercises: s.exercises.map(e =>
        e.id === exId ? {
          ...e,
          sets: e.sets.map((set, i) => i === si ? {
            ...set,
            dropSets: (set.dropSets || []).filter((_, d) => d !== di)
          } : set)
        } : e
      )
    }));
  }

  function completeSession() {
    const session = { ...currentSession, id: Date.now() };
    setData(d => ({ ...d, sessions: [session, ...d.sessions] }));
    setCurrentSession(null);
    setRestRunning(false);
    setRestElapsed(0);
    setShowDiscardConfirm(false);
    setView("home");
  }

  function startRestTimer() {
    setRestElapsed(0);
    setRestRunning(true);
  }

  function stopRestTimer() {
    setRestRunning(false);
    // Write elapsed time to the last-touched set's rest field
    if (lastSetRef && restElapsed > 0) {
      const mins = Math.floor(restElapsed / 60);
      const secs = restElapsed % 60;
      const formatted = mins + ":" + String(secs).padStart(2, "0");
      sessionUpdateSet(lastSetRef.exId, lastSetRef.si, "rest", formatted);
    }
    setRestElapsed(0);
  }

  function deleteSession(id) {
    setData(d => ({ ...d, sessions: d.sessions.filter(s => s.id !== id) }));
    setDeleteConfirmId(null);
    if (view === "session") setView("history");
  }

  // ── ROUTINE MANAGEMENT ───────────────────────────────────────────────────

  function addRoutine() {
    const name = newRoutineName.trim();
    if (!name || data.routines.find(r => r.name === name)) return;
    setData(d => ({ ...d, routines: [...d.routines, { id: "r" + uid(), name, exercises: [] }] }));
    setNewRoutineName("");
    setShowAddRoutine(false);
  }

  function confirmRename(id) {
    const name = renameValue.trim();
    if (!name || data.routines.find(r => r.name === name && r.id !== id)) { setRenamingId(null); return; }
    setData(d => ({ ...d, routines: d.routines.map(r => r.id === id ? { ...r, name } : r) }));
    setRenamingId(null);
  }

  function setThemePreset(key) {
    setThemeKey(key);
    try { localStorage.setItem(THEME_STORAGE_KEY, key); } catch {}
  }

  // ── AUTH ─────────────────────────────────────────────────────────────────

  function handleLogin() {
    const creds = getCredentials();
    if (loginUsername === creds.username && loginPassword === creds.password) {
      setIsLoggedIn(true);
      setLoginError("");
      setLoginUsername("");
      setLoginPassword("");
    } else {
      setLoginError("Incorrect username or password.");
    }
  }

  function handleLogout() {
    setIsLoggedIn(false);
    setShowSettings(false);
  }

  function handleSaveAccount() {
    const creds = getCredentials();
    const updatedCreds = { ...creds };
    let changed = false;

    if (newUsername.trim() && newUsername.trim() !== creds.username) {
      updatedCreds.username = newUsername.trim();
      changed = true;
    }
    if (newPassword) {
      if (newPassword !== confirmPassword) {
        setAccountMsg("Passwords do not match.");
        return;
      }
      updatedCreds.password = newPassword;
      changed = true;
    }
    if (!changed) { setAccountMsg("No changes made."); return; }
    saveCredentials(updatedCreds);
    setNewUsername("");
    setNewPassword("");
    setConfirmPassword("");
    setAccountMsg("Saved successfully.");
    setTimeout(() => setAccountMsg(""), 3000);
  }

  // ── MANUAL SESSION ENTRY ────────────────────────────────────────────────

  function initManualEntry() {
    const today = new Date().toISOString().slice(0, 10);
    setManualEntry({ routineId: data.routines[0] && data.routines[0].id || "", date: today, exercises: [] });
  }

  function meSetRoutine(routineId) {
    const routine = data.routines.find(r => r.id === routineId);
    const exercises = routine ? routine.exercises.map(e => ({
      id: uid(), name: e.name,
      sets: []
    })) : [];
    setManualEntry(m => ({ ...m, routineId, exercises }));
  }

  function meAddSet(exId) {
    setManualEntry(m => ({
      ...m,
      exercises: m.exercises.map(e => e.id === exId ? {
        ...e,
        sets: [...e.sets, { id: uid(), category: "Working Set", reps: "", weight: "", difficulty: "", dropSets: [] }]
      } : e)
    }));
  }

  function meUpdateSet(exId, si, field, value) {
    setManualEntry(m => ({
      ...m,
      exercises: m.exercises.map(e => e.id === exId ? {
        ...e,
        sets: e.sets.map((s, i) => i === si ? { ...s, [field]: value } : s)
      } : e)
    }));
  }

  function meRemoveSet(exId, si) {
    setManualEntry(m => ({
      ...m,
      exercises: m.exercises.map(e => e.id === exId ? {
        ...e,
        sets: e.sets.filter((_, i) => i !== si)
      } : e)
    }));
  }

  function meAddDropSet(exId, si) {
    setManualEntry(m => ({
      ...m,
      exercises: m.exercises.map(e => e.id === exId ? {
        ...e,
        sets: e.sets.map((s, i) => i === si ? {
          ...s,
          dropSets: [...(s.dropSets || []), { id: uid(), reps: "", weight: "", difficulty: "" }]
        } : s)
      } : e)
    }));
  }

  function meUpdateDropSet(exId, si, di, field, value) {
    setManualEntry(m => ({
      ...m,
      exercises: m.exercises.map(e => e.id === exId ? {
        ...e,
        sets: e.sets.map((s, i) => i === si ? {
          ...s,
          dropSets: (s.dropSets || []).map((ds, d) => d === di ? { ...ds, [field]: value } : ds)
        } : s)
      } : e)
    }));
  }

  function meRemoveDropSet(exId, si, di) {
    setManualEntry(m => ({
      ...m,
      exercises: m.exercises.map(e => e.id === exId ? {
        ...e,
        sets: e.sets.map((s, i) => i === si ? {
          ...s,
          dropSets: (s.dropSets || []).filter((_, d) => d !== di)
        } : s)
      } : e)
    }));
  }

  function saveManualEntry() {
    if (!manualEntry.routineId) return;
    const session = {
      id: Date.now(),
      routineId: manualEntry.routineId,
      date: new Date(manualEntry.date + "T12:00:00").toISOString(),
      exercises: manualEntry.exercises.map(ex => ({
        ...ex,
        sets: ex.sets.map(s => ({ ...s, rest: "" }))
      }))
    };
    setData(d => ({ ...d, sessions: [session, ...d.sessions].sort((a, b) => new Date(b.date) - new Date(a.date)) }));
    setManualEntry(null);
    setView("history");
  }

  // ── EXPORT ──────────────────────────────────────────────────────────────

  function exportToExcel() {
    const wb = XLSX.utils.book_new();

    // Sort sessions oldest first for the workbook
    const sorted = [...data.sessions].sort((a, b) => new Date(a.date) - new Date(b.date));

    sorted.forEach((session, idx) => {
      const routineName = getRoutineName(session.routineId);
      const dateStr = new Date(session.date).toLocaleDateString("en-US", { year: "numeric", month: "2-digit", day: "2-digit" }).replace(/\//g, "-");
      const sheetName = (dateStr + " " + routineName).slice(0, 31); // Excel sheet name max 31 chars

      const rows = [["Exercise", "Set #", "Category", "Reps", "Weight (lbs)", "Difficulty", "Notes", "Rest"]];

      session.exercises.forEach(ex => {
        ex.sets.forEach((s, si) => {
          rows.push([
            ex.name || "",
            si + 1,
            s.category || "",
            s.reps || "",
            s.weight || "",
            s.difficulty || "",
            s.notes || "",
            s.rest || "",
          ]);

        });
      });

      const ws = XLSX.utils.aoa_to_sheet(rows);

      // Style header row width
      ws["!cols"] = [
        { wch: 22 }, { wch: 8 }, { wch: 14 }, { wch: 6 },
        { wch: 14 }, { wch: 20 }, { wch: 30 }, { wch: 8 }
      ];

      XLSX.utils.book_append_sheet(wb, ws, sheetName);
    });

    XLSX.writeFile(wb, "IronLog_Sessions.xlsx");
  }

  // ── BENCHMARKS ───────────────────────────────────────────────────────────

  function removeBenchmark(name) {
    setData(d => ({ ...d, benchmarks: d.benchmarks.filter(b => b !== name) }));
    if (activeBenchmark === name) setActiveBenchmark(null);
  }

  const recentSessions = data.sessions.slice(0, 50);
  const prevSession = activeRoutine ? getPrevSession(data.sessions, activeRoutine.id) : null;

  const CHART_WEIGHT_COLOR = theme.benchmarkStat;
  const CHART_REPS_COLOR = theme.workingTarget;

  const T = theme; // convenience alias

  if (!isLoggedIn) {
    return (
      <div style={{...S.app, background: theme.app, color: theme.primaryText, display: "flex", alignItems: "center", justifyContent: "center", minHeight: "100vh"}}>
        <div style={{...S.loginBox, background: theme.surface, borderColor: theme.border}}>
          <div style={{textAlign: "center", marginBottom: 28}}>
            <span style={{fontSize: 28, color: T.accent}}>⬡</span>
            <div style={{...S.logoText, color: theme.primaryText, fontSize: 16, letterSpacing: "0.2em", marginTop: 8}}>IRON LOG</div>
          </div>
          <div style={S.setModalField}>
            <label style={{...S.setModalLabel, color: theme.mutedText}}>USERNAME</label>
            <input
              style={{...S.setModalInput, background: theme.inputBg, borderColor: loginError ? theme.dangerText : theme.border, color: theme.primaryText, fontSize: 16, padding: "12px 14px"}}
              placeholder="Username"
              value={loginUsername}
              onChange={e => { setLoginUsername(e.target.value); setLoginError(""); }}
              onKeyDown={e => e.key === "Enter" && handleLogin()}
              autoFocus
            />
          </div>
          <div style={S.setModalField}>
            <label style={{...S.setModalLabel, color: theme.mutedText}}>PASSWORD</label>
            <input
              type="password"
              style={{...S.setModalInput, background: theme.inputBg, borderColor: loginError ? theme.dangerText : theme.border, color: theme.primaryText, fontSize: 16, padding: "12px 14px"}}
              placeholder="Password"
              value={loginPassword}
              onChange={e => { setLoginPassword(e.target.value); setLoginError(""); }}
              onKeyDown={e => e.key === "Enter" && handleLogin()}
            />
          </div>
          {loginError && <div style={{fontSize: 12, color: theme.dangerText, marginBottom: 12, textAlign: "center"}}>{loginError}</div>}
          <button style={{...S.completeBtn, background: T.accent, color: theme.app, width: "100%", padding: 14, fontSize: 14}} onClick={handleLogin}>
            Sign In
          </button>
        </div>
      </div>
    );
  }

  return (
    <div style={{...S.app, background: theme.app, color: theme.primaryText}}>
      <div style={S.grain} />

      <header style={{...S.header, background: theme.header, borderColor: theme.borderSubtle}}>
        <div style={S.headerInner}>
          <button style={S.logoBtn} onClick={() => safeNav("home")}>
            <span style={{...S.logoMark, color: T.accent}}>⬡</span>
            <span style={{...S.logoText, color: theme.primaryText}}>IRON LOG</span>
          </button>
          <nav style={S.nav}>
            <button style={["home","editRoutine","routines"].includes(view) ? {...S.navActive, color: T.accent} : {...S.navBtn, color: theme.mutedText}} onClick={() => safeNav("home")}>Train</button>
            <button style={["history","session","addSession"].includes(view) ? {...S.navActive, color: T.accent} : {...S.navBtn, color: theme.mutedText}} onClick={() => safeNav("history")}>History</button>
            <button style={view === "schedule" ? {...S.navActive, color: T.accent} : {...S.navBtn, color: theme.mutedText}} onClick={() => safeNav("schedule")}>Schedule</button>
            <button style={view === "stats" ? {...S.navActive, color: T.accent} : {...S.navBtn, color: theme.mutedText}} onClick={() => safeNav("stats")}>Stats</button>
            <button style={{...S.settingsBtn, color: theme.mutedText}} onClick={() => setShowSettings(true)} title="Theme">⚙</button>
          </nav>
        </div>
      </header>

      <main style={S.main}>

        {/* ── HOME ── */}
        {view === "home" && (() => { const todayKey = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"][new Date().getDay()]; const todayRoutineId = data.schedule && data.schedule[todayKey] || null; const todayRoutine = todayRoutineId && todayRoutineId !== "rest" ? data.routines.find(r => r.id === todayRoutineId) : null; const isTodayRest = todayRoutineId === "rest"; return (
            <div>
              <div style={{...S.heroLabel, color: T.accent}}>TODAY&#39;S WORKOUT</div>

              {/* Today's scheduled routine */}
              {todayRoutine ? (
                <div style={{...S.todayCard, background: theme.surface, borderColor: T.accentBorder}}>
                  <div style={S.todayCardTop}>
                    <div>
                      <div style={{fontSize: 10, color: theme.mutedText, letterSpacing: "0.15em", marginBottom: 4}}>SCHEDULED</div>
                      <div style={{fontSize: 28, fontWeight: 900, color: theme.primaryText, fontFamily: "'Georgia',serif"}}>{todayRoutine.name}</div>
                      <div style={{fontSize: 11, color: theme.mutedText, marginTop: 4}}>{todayRoutine.exercises.length} exercise{todayRoutine.exercises.length !== 1 ? "s" : ""}</div>
                    </div>
                    <button style={{...S.completeBtn, background: T.accent, color: theme.app, fontSize: 13, padding: "12px 20px"}} onClick={() => startSession(todayRoutine)}>
                      Start ▶
                    </button>
                  </div>
                </div>
              ) : isTodayRest ? (
                <div style={{...S.todayCard, background: theme.surface, borderColor: theme.borderSubtle}}>
                  <div style={{fontSize: 24, fontWeight: 900, color: theme.primaryText, fontFamily: "'Georgia',serif", marginBottom: 4}}>Rest Day 🛌</div>
                  <div style={{fontSize: 12, color: theme.mutedText}}>Recovery is part of the program.</div>
                </div>
              ) : (
                <div style={{...S.todayCard, background: theme.surface, borderColor: theme.borderSubtle}}>
                  <div style={{fontSize: 16, fontWeight: 700, color: theme.mutedText, marginBottom: 8}}>No workout scheduled today</div>
                  <button style={{fontSize: 12, color: T.accent, background: "none", border: "none", cursor: "pointer", padding: 0, fontFamily: "'DM Mono',monospace", letterSpacing: "0.08em"}} onClick={() => setView("schedule")}>Set up your schedule →</button>
                </div>
              )}

              {/* Manage Routines button */}
              <button style={{...S.manageRoutinesBtn, background: theme.surface, borderColor: theme.border, color: theme.primaryText}} onClick={() => setView("routines")}>
                Manage Routines
              </button>


            </div>
          );
        })()}

        {/* ── ROUTINES ── */}
        {view === "routines" && (
          <div>
            <button style={{...S.backBtn, color: theme.mutedText}} onClick={() => setView("home")}>← Back</button>
            <div style={{...S.heroLabel, color: T.accent}}>MANAGE</div>
            <h1 style={{...S.heroTitle, color: theme.primaryText}}>Routines</h1>
            <div style={S.routineGrid}>
              {data.routines.map(r => (
                <div key={r.id}>
                  {renamingId === r.id ? (
                    <div style={{...S.renameCard, background: theme.surface, borderColor: theme.border}}>
                      <input style={{...S.renameInput, color: theme.primaryText, borderColor: theme.accent}} value={renameValue}
                        onChange={e => setRenameValue(e.target.value)}
                        onKeyDown={e => { if (e.key === "Enter") confirmRename(r.id); if (e.key === "Escape") setRenamingId(null); }}
                        autoFocus />
                      <div style={S.renameActions}>
                        <button style={{...S.renameSave, background: T.accent, color: theme.app}} onClick={() => confirmRename(r.id)}>✓ Save</button>
                        <button style={{...S.renameCancel, color: theme.mutedText, background: theme.surfaceAlt, borderColor: theme.border}} onClick={() => setRenamingId(null)}>✕</button>
                      </div>
                    </div>
                  ) : (
                    <div style={{...S.routineCard, background: theme.surface, borderColor: theme.border}}>
                      <button style={{...S.routinePlayBtn, color: theme.primaryText}} onClick={() => startSession(r)}>
                        <span style={S.routineIcon}>▶</span>
                        <span style={{...S.routineName, color: theme.primaryText}}>{r.name}</span>
                        <span style={{...S.routineCount, color: theme.mutedText}}>{r.exercises.length} exercise{r.exercises.length !== 1 ? "s" : ""}</span>
                      </button>
                      <div style={{...S.routineActions, borderColor: theme.borderSubtle}}>
                        <button style={{...S.routineActionBtn, color: theme.mutedText, borderColor: theme.borderSubtle}} onClick={() => openEditRoutine(r)}>Edit</button>
                        <button style={{...S.routineActionBtn, borderRight: "none", color: theme.mutedText}} onClick={() => { setRenamingId(r.id); setRenameValue(r.name); }}>Rename</button>
                      </div>
                    </div>
                  )}
                </div>
              ))}
              <button style={{...S.addRoutineCard, borderColor: theme.border}} onClick={() => setShowAddRoutine(v => !v)}>
                <span style={{...S.addIcon, color: T.accent}}>+</span>
                <span style={{...S.addLabel, color: theme.mutedText}}>New Routine</span>
              </button>
            </div>
            {showAddRoutine && (
              <div style={S.addRoutineRow}>
                <input style={{...S.textInput, background: theme.surface, borderColor: theme.border, color: theme.primaryText}} placeholder="Routine name..." value={newRoutineName}
                  onChange={e => setNewRoutineName(e.target.value)}
                  onKeyDown={e => e.key === "Enter" && addRoutine()} autoFocus />
                <button style={{...S.confirmBtn, background: T.accent, color: theme.app}} onClick={addRoutine}>Add</button>
              </div>
            )}
          </div>
        )}

        {/* ── EDIT ROUTINE TEMPLATE ── */}
        {view === "editRoutine" && editingRoutine && (
          <div>
            <button style={{...S.backBtn, color: theme.mutedText}} onClick={() => setView("routines")}>← Back</button>
            <div style={{...S.heroLabel, color: T.accent}}>ROUTINE TEMPLATE</div>
            <h2 style={{...S.logTitle, color: theme.primaryText}}>{editingRoutine.name}</h2>
            <p style={{...S.templateHint, color: theme.mutedText}}>Define exercises and default sets. Set the category for each individual set.</p>

            {editingRoutine.exercises.length === 0 && (
              <div style={{...S.emptyTemplate, color: theme.mutedText}}>No exercises yet — add one below.</div>
            )}

            {editingRoutine.exercises.map((ex, ei) => (
              <div key={ex.id} style={{...S.exerciseCard, background: theme.surface, borderColor: theme.borderSubtle}}>
                <div style={S.exHeader}>
                  <span style={{...S.exNum, color: T.accent}}>#{ei + 1}</span>
                  <input style={{...S.exNameInput, color: theme.primaryText, borderColor: theme.border, background: "transparent"}} placeholder="Exercise name..."
                    value={ex.name} onChange={e => tmplUpdateExName(ex.id, e.target.value)} />
                  <div style={S.exMoveGroup}>
                    <button style={{...S.moveBtn, color: theme.mutedText, background: theme.surfaceAlt}} onClick={() => tmplMoveExercise(ex.id, -1)} disabled={ei === 0}>↑</button>
                    <button style={{...S.moveBtn, color: theme.mutedText, background: theme.surfaceAlt}} onClick={() => tmplMoveExercise(ex.id, 1)} disabled={ei === editingRoutine.exercises.length - 1}>↓</button>
                  </div>
                  <button style={{...S.removeBtn, color: theme.mutedText}} onClick={() => tmplRemoveExercise(ex.id)}>✕</button>
                </div>

                <label style={S.dropSetToggleRow}>
                  <input
                    type="checkbox"
                    checked={ex.allowDropSets !== false}
                    onChange={() => tmplToggleDropSets(ex.id)}
                    style={S.dropSetCheckbox}
                  />
                  <span style={{...S.dropSetToggleLabel, color: theme.mutedText}}>Allow drop sets</span>
                </label>

                <div style={S.setHeaderRowTemplate}>
                  <span style={{...S.setHeaderCell, color: theme.mutedText}}>Set</span>
                  <span style={{...S.setHeaderCell, color: theme.mutedText}}>CATEGORY</span>
                  <span style={{...S.setHeaderCell, color: theme.mutedText}}>Reps</span>
                  <span style={{...S.setHeaderCell, color: theme.mutedText}}>Rest</span>
                  <span style={{...S.setHeaderCell, color: theme.mutedText}}>Notes</span>
                  <span style={{...S.setHeaderCell, color: theme.mutedText}}></span>
                </div>

                {ex.sets.map((set, si) => (
                  <div key={si} style={S.setRowTemplate}>
                    <span style={{...S.setNum, color: theme.mutedText}}>{si + 1}</span>
                    <select style={{...S.setCatSelectSmall, background: theme.inputBg, borderColor: theme.border, color: theme.primaryText, fontWeight: 600}} value={set.category || "Working Set"} onChange={e => tmplUpdateSet(ex.id, si, "category", e.target.value)}>
                      {SET_CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
                    </select>
                    <input style={{...S.setInput, background: theme.inputBg, borderColor: theme.inputBorder, color: theme.primaryText, fontWeight: 600}} placeholder="—" value={set.reps} onChange={e => tmplUpdateSet(ex.id, si, "reps", e.target.value)} inputMode="numeric" />
                    <input style={{...S.setInput, background: theme.inputBg, borderColor: theme.inputBorder, color: theme.primaryText, fontWeight: 600}} placeholder="—" value={set.rest} onChange={e => tmplUpdateSet(ex.id, si, "rest", e.target.value)} />
                    <button style={set.notes ? {...S.notesBtnFilled, color: T.accent, background: theme.accentDim, borderColor: T.accentBorder} : {...S.notesBtn, color: theme.primaryText, background: theme.surface, borderColor: theme.border}} onClick={() => { setNotesModal({ context: "tmpl", exId: ex.id, si }); setNotesDraft(set.notes || ""); }}>{set.notes ? "📝" : "+"} Notes</button>
                    <button style={{...S.removeSetBtn, color: theme.mutedText}} onClick={() => tmplRemoveSet(ex.id, si)}>–</button>
                  </div>
                ))}
                <button style={{...S.addSetBtn, color: theme.mutedText}} onClick={() => tmplAddSet(ex.id)}>+ Add Set</button>
              </div>
            ))}

            <button style={S.addExBtn} onClick={tmplAddExercise}>+ Add Exercise</button>
            <div style={S.saveTemplateRow}>
              <button style={{...S.saveTemplateBtn, background: T.accent, color: theme.app}} onClick={saveRoutineTemplate}>Save Template</button>
            </div>
          </div>
        )}

        {/* ── LOG SESSION ── */}
        {view === "log" && currentSession && (
          <div>
            <div style={S.logHeader}>
              <div>
                <div style={{...S.heroLabel, color: T.accent}}>LOGGING</div>
                <h2 style={{...S.logTitle, color: theme.primaryText}}>{activeRoutine && activeRoutine.name}</h2>
                <div style={{...S.logDate, color: theme.mutedText}}>{formatDate(currentSession.date)}</div>
                {prevSession && <div style={{...S.prevLabel, color: theme.mutedText}}>PREV: {formatDate(prevSession.date)}</div>}
              </div>
              <button style={{...S.completeBtn, background: theme.accent, color: theme.app}} onClick={completeSession}>Complete Session</button>
            </div>

            {(() => { let globalSetIndex = 0; return currentSession.exercises.map((ex, ei) => (
              <div key={ex.id} style={{...S.exerciseCard, background: theme.surface, borderColor: theme.borderSubtle}}>
                <div style={S.exHeader}>
                  <span style={{...S.exNum, color: T.accent}}>#{ei + 1}</span>
                  <span style={{...S.exLogName, color: theme.primaryText}}>{ex.name || "Exercise"}</span>

                </div>

                {ex.sets.map((set, si) => {
                  const thisGlobalIndex = globalSetIndex++;
                  const prev = getPrevSetData(prevSession, ex.name, si);
                  const cat = set.category || ex.category;
                  const isWorking = cat === "Working Set";
                  const tmplEx = activeRoutine && activeRoutine.exercises.find(e => e.name.trim().toLowerCase() === ex.name.trim().toLowerCase());
                  const tmplReps = tmplEx && tmplEx.sets[si] && tmplEx.sets[si].reps || "";
                  const suggestedWeight = ex.name
                    ? isWorking
                      ? suggestWeight(data.sessions, ex.name, si, tmplReps)
                      : suggestWarmupWeight(data.sessions, ex.name, si, currentSession && currentSession.exercises)
                    : null;
                  const isDone = !!(set.reps || set.weight);
                  const catColor = cat === "Working Set" ? T.workingBadge : T.warmupBadge;
                  // Rest display between sets: show after previous set if completed, skip before first set
                  const prevKey = si > 0 ? ex.id + ":" + (si - 1)
                    : ei > 0 ? (() => { const pex = currentSession.exercises[ei - 1]; return pex && pex.sets && pex.sets.length ? pex.id + ":" + (pex.sets.length - 1) : null; })()
                    : null;
                  const isFirstSetEver = thisGlobalIndex === 0;
                  const prevSetDone = prevKey && (() => {
                    const [pExId, pSi] = prevKey.split(":");
                    const pEx = currentSession.exercises.find(e => e.id === pExId);
                    const pSet = pEx && pEx.sets && pEx.sets[parseInt(pSi)];
                    return !!(pSet && (pSet.reps || pSet.weight));
                  })();
                  const snapshotElapsed = prevKey && restSnapshot[prevKey];
                  const isCurrentlyResting = restRunning && lastCompletedKey === prevKey;
                  return (
                    <div key={si}>
                      {!isFirstSetEver && prevSetDone && (
                        <div style={{...S.restBetweenSets, background: isCurrentlyResting ? theme.accentDim : theme.surfaceAlt, borderColor: isCurrentlyResting ? T.accentBorder : theme.borderSubtle}}>
                          <span style={{fontSize: 9, color: isCurrentlyResting ? T.accent : theme.mutedText, fontWeight: 700, letterSpacing: "0.1em"}}>REST</span>
                          <span style={{fontSize: 18, fontWeight: 900, color: isCurrentlyResting ? T.accent : theme.mutedText}}>
                            {isCurrentlyResting ? formatTime(restElapsed) : snapshotElapsed ? formatTime(snapshotElapsed) : "—"}
                          </span>
                        </div>
                      )}
                      <button style={{...S.setRowSummary, background: isDone ? theme.accentDim : theme.inputBg, borderColor: isDone ? T.accentBorder : theme.border}} onClick={() => openSetModal(ex.id, si)}>
                        <span style={S.setRowSummaryLeft}>
                          <span style={{...S.setNumLabel, color: theme.mutedText}}>{si + 1}</span>
                          <span style={{fontSize: 7, color: catColor, fontWeight: 700, letterSpacing: "0.04em"}}>{cat === "Working Set" ? "Wrk" : "Wup"}</span>
                        </span>
                        <span style={S.setRowSummaryData}>
                          {isDone ? (
                            <>
                              <span style={{...S.setRowSummaryVal, color: theme.primaryText}}>{set.reps || "—"} reps</span>
                              <span style={{...S.setRowSummaryVal, color: theme.primaryText}}>{set.weight || "—"} lbs</span>
                              
                              {set.difficulty && <span style={{fontSize: 10, color: theme.mutedText}}>{set.difficulty}</span>}
                            </>
                          ) : (
                            <>
                              {suggestedWeight && <span style={{fontSize: 11, color: isWorking ? T.workingTarget : T.warmupTarget}}>Target: {tmplReps ? tmplReps + " reps - " : ""}{suggestedWeight} lbs</span>}
                              {!suggestedWeight && <span style={{fontSize: 11, color: theme.mutedText}}>Tap to log</span>}
                            </>
                          )}
                        </span>
                        <span style={{...S.setRowSummaryIcon, color: isDone ? T.accent : theme.mutedText}}>{isDone ? "✓" : "›"}</span>
                      </button>
                      {/* Drop set summary — nested under parent set when completed */}
                      {isWorking && isDone && (set.dropSets || []).length > 0 && (
                        <div style={{marginLeft: 40, marginTop: -4, marginBottom: 6}}>
                          {(set.dropSets || []).map((ds, di) => (
                            <div key={di} style={{display: "flex", alignItems: "center", gap: 8, padding: "5px 12px", borderLeft: "2px solid " + T.dropTarget + "55", marginLeft: 8, marginBottom: 2}}>
                              <span style={{fontSize: 9, color: T.dropBadge, fontWeight: 700, minWidth: 24}}>D{di + 1}</span>
                              {(ds.reps || ds.weight) ? (
                                <span style={{fontSize: 12, color: theme.mutedText}}>{ds.reps || "—"} reps - {ds.weight || "—"} lbs{ds.difficulty ? " - " + ds.difficulty : ""}</span>
                              ) : (
                                <span style={{fontSize: 11, color: theme.mutedText, fontStyle: "italic"}}>not logged</span>
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            ));
            })()}
          </div>
        )}

        {/* ── HISTORY ── */}
        {view === "history" && (
          <div>
            <div style={{display: "flex", justifyContent: "space-between", alignItems: "flex-end", marginBottom: 0}}>
              <div>
                <div style={{...S.heroLabel, color: T.accent}}>YOUR PROGRESS</div>
                <h1 style={{...S.heroTitle, color: theme.primaryText, marginBottom: 16}}>Session<br />History</h1>
              </div>
              <div style={{display: "flex", gap: 8, alignItems: "flex-end"}}>
                {data.sessions.length > 0 && (
                  <button style={{...S.addSessionBtn, background: theme.surface, color: theme.primaryText, border: "1px solid " + theme.border}} onClick={exportToExcel}>
                    Export
                  </button>
                )}
                <button style={{...S.addSessionBtn, background: T.accent, color: theme.app}} onClick={() => { initManualEntry(); setView("addSession"); }}>
                  + Add Session
                </button>
              </div>
            </div>
            {data.sessions.length === 0 ? (
              <div style={{...S.empty, color: theme.mutedText}}>No sessions yet. Start training!</div>
            ) : recentSessions.map(s => (
              <div key={s.id} style={{...S.historyRow}}>
                <button style={{...S.historyCard, background: theme.surface, borderColor: theme.borderSubtle}} onClick={() => { setSelectedSession(s); setView("session"); }}>
                  <div>
                    <div style={{...S.historyRoutine, color: theme.primaryText}}>{getRoutineName(s.routineId)}</div>
                    <div style={{...S.historyMeta, color: theme.mutedText}}>{formatDate(s.date)} - {s.exercises.length} exercise{s.exercises.length !== 1 ? "s" : ""} - {s.exercises.reduce((a, e) => a + e.sets.length, 0)} sets</div>
                  </div>
                  <span style={{...S.chevron, color: theme.mutedText}}>›</span>
                </button>
                <button style={{...S.deleteBtn, color: theme.mutedText, background: theme.surface, borderColor: theme.borderSubtle}} onClick={() => setDeleteConfirmId(s.id)} title="Delete">🗑</button>
              </div>
            ))}
          </div>
        )}

        {/* ── ADD SESSION ── */}
        {view === "addSession" && manualEntry && (
          <div>
            <button style={{...S.backBtn, color: theme.mutedText}} onClick={() => { setManualEntry(null); setView("history"); }}>Back</button>
            <div style={{...S.heroLabel, color: T.accent}}>MANUAL ENTRY</div>
            <h1 style={{...S.heroTitle, color: theme.primaryText, fontSize: "clamp(28px,6vw,48px)"}}>Add Session</h1>

            {/* Date + Routine */}
            <div style={{display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 20}}>
              <div>
                <div style={{...S.setModalLabel, color: theme.mutedText, marginBottom: 6}}>DATE</div>
                <input type="date" style={{...S.textInput, background: theme.surface, borderColor: theme.border, color: theme.primaryText, width: "100%", boxSizing: "border-box"}}
                  value={manualEntry.date}
                  onChange={e => setManualEntry(m => ({ ...m, date: e.target.value }))} />
              </div>
              <div>
                <div style={{...S.setModalLabel, color: theme.mutedText, marginBottom: 6}}>ROUTINE</div>
                <select style={{...S.scheduleSelect, background: theme.surface, borderColor: theme.border, color: theme.primaryText}}
                  value={manualEntry.routineId}
                  onChange={e => meSetRoutine(e.target.value)}>
                  <option value="">Select...</option>
                  {data.routines.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
                </select>
              </div>
            </div>

            {/* Exercises */}
            {manualEntry.exercises.map((ex, ei) => (
              <div key={ex.id} style={{...S.exerciseCard, background: theme.surface, borderColor: theme.borderSubtle, marginBottom: 16}}>
                <div style={{...S.exViewHeader, marginBottom: 12}}>
                  <span style={{...S.exNum, color: T.accent}}>#{ei + 1}</span>
                  <span style={{...S.exViewName, color: theme.primaryText}}>{ex.name}</span>
                </div>

                {ex.sets.map((s, si) => {
                  const isWorking = s.category === "Working Set";
                  return (
                    <div key={s.id || si} style={{marginBottom: 12}}>
                      {/* Set header row */}
                      <div style={{display: "flex", alignItems: "center", gap: 8, marginBottom: 8}}>
                        <span style={{...S.setNumLabel, color: theme.mutedText, minWidth: 20}}>{si + 1}</span>
                        <select style={{...S.setCatSelectSmall, background: theme.inputBg, borderColor: theme.border, color: theme.primaryText, flex: 1}}
                          value={s.category}
                          onChange={e => meUpdateSet(ex.id, si, "category", e.target.value)}>
                          {SET_CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
                        </select>
                        <button style={{...S.removeSetBtn, color: theme.mutedText}} onClick={() => meRemoveSet(ex.id, si)}>✕</button>
                      </div>
                      {/* Reps / Weight / Difficulty */}
                      <div style={{display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, marginBottom: 6}}>
                        <div>
                          <div style={{fontSize: 9, color: theme.mutedText, fontWeight: 700, letterSpacing: "0.1em", marginBottom: 4}}>REPS</div>
                          <input style={{...S.setInput, background: theme.inputBg, borderColor: theme.border, color: theme.primaryText}} type="number" inputMode="numeric" placeholder="0" value={s.reps} onChange={e => meUpdateSet(ex.id, si, "reps", e.target.value)} />
                        </div>
                        <div>
                          <div style={{fontSize: 9, color: theme.mutedText, fontWeight: 700, letterSpacing: "0.1em", marginBottom: 4}}>WEIGHT</div>
                          <input style={{...S.setInput, background: theme.inputBg, borderColor: theme.border, color: theme.primaryText}} type="number" inputMode="decimal" placeholder="0" value={s.weight} onChange={e => meUpdateSet(ex.id, si, "weight", e.target.value)} />
                        </div>
                        <div>
                          <div style={{fontSize: 9, color: theme.mutedText, fontWeight: 700, letterSpacing: "0.1em", marginBottom: 4}}>DIFF</div>
                          <select style={{...S.diffSelect, background: theme.inputBg, borderColor: theme.border, color: s.difficulty ? theme.primaryText : theme.mutedText, width: "100%"}}
                            value={s.difficulty}
                            onChange={e => meUpdateSet(ex.id, si, "difficulty", e.target.value)}>
                            <option value="">—</option>
                            {DIFFICULTIES.map(d => <option key={d} value={d}>{d}</option>)}
                          </select>
                        </div>
                      </div>

                      {/* Drop sets for working sets */}
                      {isWorking && (s.dropSets || []).map((ds, di) => (
                        <div key={ds.id || di} style={{marginLeft: 20, paddingLeft: 10, borderLeft: "2px solid " + T.dropTarget + "55", marginBottom: 6}}>
                          <div style={{display: "flex", alignItems: "center", gap: 6, marginBottom: 6}}>
                            <span style={{fontSize: 9, color: T.dropBadge, fontWeight: 700, minWidth: 24}}>D{di + 1}</span>
                            <button style={{...S.removeSetBtn, color: theme.mutedText, marginLeft: "auto"}} onClick={() => meRemoveDropSet(ex.id, si, di)}>✕</button>
                          </div>
                          <div style={{display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8}}>
                            <div>
                              <div style={{fontSize: 9, color: theme.mutedText, fontWeight: 700, letterSpacing: "0.1em", marginBottom: 4}}>REPS</div>
                              <input style={{...S.setInput, background: theme.inputBg, borderColor: theme.border, color: theme.primaryText}} type="number" inputMode="numeric" placeholder="0" value={ds.reps} onChange={e => meUpdateDropSet(ex.id, si, di, "reps", e.target.value)} />
                            </div>
                            <div>
                              <div style={{fontSize: 9, color: theme.mutedText, fontWeight: 700, letterSpacing: "0.1em", marginBottom: 4}}>WEIGHT</div>
                              <input style={{...S.setInput, background: theme.inputBg, borderColor: theme.border, color: theme.primaryText}} type="number" inputMode="decimal" placeholder="0" value={ds.weight} onChange={e => meUpdateDropSet(ex.id, si, di, "weight", e.target.value)} />
                            </div>
                            <div>
                              <div style={{fontSize: 9, color: theme.mutedText, fontWeight: 700, letterSpacing: "0.1em", marginBottom: 4}}>DIFF</div>
                              <select style={{...S.diffSelect, background: theme.inputBg, borderColor: theme.border, color: ds.difficulty ? theme.primaryText : theme.mutedText, width: "100%"}}
                                value={ds.difficulty}
                                onChange={e => meUpdateDropSet(ex.id, si, di, "difficulty", e.target.value)}>
                                <option value="">—</option>
                                {DIFFICULTIES.map(d => <option key={d} value={d}>{d}</option>)}
                              </select>
                            </div>
                          </div>
                        </div>
                      ))}
                      {isWorking && (
                        <button style={{...S.addDropSetBtn, color: T.dropTarget, borderColor: T.dropTarget, marginTop: 4}} onClick={() => meAddDropSet(ex.id, si)}>+ Drop Set</button>
                      )}
                    </div>
                  );
                })}

                <button style={{...S.addSetBtn, color: T.accent}} onClick={() => meAddSet(ex.id)}>+ Add Set</button>
              </div>
            ))}

            {manualEntry.exercises.length > 0 && (
              <button style={{...S.completeBtn, background: T.accent, color: theme.app, width: "100%", padding: 16, fontSize: 14, marginTop: 8}} onClick={saveManualEntry}>
                Save Session
              </button>
            )}
            {!manualEntry.routineId && (
              <div style={{...S.empty, color: theme.mutedText}}>Select a routine above to begin.</div>
            )}
          </div>
        )}

        {/* ── SESSION DETAIL ── */}
        {view === "session" && selectedSession && (
          <div>
            <div style={S.sessionDetailHeader}>
              <button style={{...S.backBtn, color: theme.mutedText}} onClick={() => setView("history")}>← Back</button>
              <button style={{...S.deleteSessionBtn, color: theme.dangerText, borderColor: theme.dangerBorder}} onClick={() => setDeleteConfirmId(selectedSession.id)}>Delete Entry</button>
            </div>
            <div style={{...S.heroLabel, color: T.accent}}>{getRoutineName(selectedSession.routineId)}</div>
            <h2 style={{...S.heroTitle, color: theme.primaryText}}>{formatDate(selectedSession.date)}</h2>
            {selectedSession.exercises.map((ex, ei) => (
              <div key={ex.id} style={{...S.exerciseCard, background: theme.surface, borderColor: theme.borderSubtle}}>
                <div style={S.exViewHeader}>
                  <span style={{...S.exNum, color: T.accent}}>#{ei + 1}</span>
                  <span style={{...S.exViewName, color: theme.primaryText}}>{ex.name || "Unnamed Exercise"}</span>

                </div>
                <div style={S.setHeaderRowView}>
                  <span style={{...S.setHeaderCell, color: theme.mutedText}}>Set</span>
                  <span style={{...S.setHeaderCell, color: theme.mutedText}}>Reps</span>
                  <span style={{...S.setHeaderCell, color: theme.mutedText}}>Weight</span>
                  <span style={{...S.setHeaderCell, color: theme.mutedText}}>Rest</span>
                  <span style={{...S.setHeaderCell, color: theme.mutedText}}>Notes</span>
                </div>
                {ex.sets.map((set, si) => {
                  const cat = set.category || ex.category;
                  return (
                    <div key={si}>
                      <div style={S.setRowView}>
                        <span style={{...S.setNum, color: theme.mutedText}}>
                          <span style={{...S.setNumLabel, color: theme.mutedText}}>{si + 1}</span>
                          {cat && <span style={cat === "Working Set" ? {...S.setCatWorking, color: T.workingBadge} : {...S.setCatWarmup, color: T.warmupBadge}}>{cat === "Working Set" ? "Wrk" : "Wup"}</span>}
                        </span>
                        <span style={{...S.setCell, color: theme.primaryText}}>{set.reps || "—"}</span>
                        <span style={{...S.setCell, color: theme.primaryText}}>{set.weight || "—"}</span>
                        <span style={{...S.setCell, color: theme.primaryText}}>{set.rest || "—"}</span>
                        <span style={{...S.setCellWide, color: theme.primaryText}}>{set.notes || "—"}</span>
                      </div>
                      {(set.dropSets || []).map((ds, di) => (
                        <div key={di} style={S.setRowView}>
                          <span style={{...S.setNum, color: theme.mutedText}}>
                            <span style={{...S.setNumLabel, color: theme.mutedText}}>D{di + 1}</span>
                            <span style={{...S.setCatDrop, color: T.dropBadge}}>Drp</span>
                          </span>
                          <span style={{...S.setCell, color: theme.primaryText}}>{ds.reps || "—"}</span>
                          <span style={{ ...S.setCell, color: "#ff4d9e" }}>{ds.weight || "—"}</span>
                          <span style={{...S.setCell, color: theme.primaryText}}>—</span>
                          <span style={{...S.setCellWide, color: theme.primaryText}}>{ds.difficulty || "—"}</span>
                        </div>
                      ))}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        )}

        {/* ── SCHEDULE ── */}
        {view === "schedule" && (
          <div>
            <div style={{display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 0}}>
              <div>
                <div style={{...S.heroLabel, color: T.accent}}>WEEKLY PLAN</div>
                <h1 style={{...S.heroTitle, color: theme.primaryText, marginBottom: 16}}>Schedule</h1>
              </div>
              {!scheduleEditing ? (
                <button style={{...S.scheduleEditBtn, borderColor: theme.border, color: theme.mutedText, background: theme.surface}} onClick={() => setScheduleEditing(true)}>
                  Edit
                </button>
              ) : (
                <button style={{...S.scheduleEditBtn, borderColor: T.accentBorder, color: theme.app, background: T.accent, fontWeight: 700}} onClick={() => setScheduleEditing(false)}>
                  Done ✓
                </button>
              )}
            </div>
            {scheduleEditing && (
              <div style={{fontSize: 11, color: theme.mutedText, marginBottom: 16, letterSpacing: "0.03em"}}>
                Assign routines to each day, then tap Done to lock in your schedule.
              </div>
            )}
            <div style={S.scheduleGrid}>
              {["Sun","Mon","Tue","Wed","Thu","Fri","Sat"].map(day => {
                const fullDay = {Sun:"Sunday",Mon:"Monday",Tue:"Tuesday",Wed:"Wednesday",Thu:"Thursday",Fri:"Friday",Sat:"Saturday"}[day];
                const todayIdx = new Date().getDay();
                const dayIdx = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"].indexOf(day);
                const isToday = dayIdx === todayIdx;
                const routineId = data.schedule && data.schedule[day] || null;
                const routine = routineId && routineId !== "rest" ? data.routines.find(r => r.id === routineId) : null;
                const isRest = routineId === "rest";
                return (
                  <div key={day} style={{...S.scheduleDay, background: isToday ? theme.accentDim : theme.surface, borderColor: isToday ? T.accentBorder : theme.borderSubtle, opacity: scheduleEditing ? 1 : 1}}>
                    <div style={S.scheduleDayHeader}>
                      <div style={{display: "flex", alignItems: "center", gap: 8}}>
                        <span style={{...S.scheduleDayName, color: isToday ? T.accent : theme.primaryText}}>{fullDay}</span>
                        {isToday && <span style={{fontSize: 8, color: T.accent, fontWeight: 700, letterSpacing: "0.1em", background: T.accentBorder, padding: "2px 6px", borderRadius: 3}}>TODAY</span>}
                      </div>
                      {!scheduleEditing && routine && (
                        <span style={{fontSize: 10, color: theme.mutedText}}>{routine.exercises.length} ex</span>
                      )}
                    </div>

                    {scheduleEditing ? (
                      <select
                        style={{...S.scheduleSelect, background: theme.inputBg, borderColor: routine ? T.accentBorder : theme.border, color: routine ? theme.primaryText : theme.mutedText}}
                        value={routineId || ""}
                        onChange={e => {
                          const val = e.target.value;
                          setData(d => ({ ...d, schedule: { ...(d.schedule || {}), [day]: val || null } }));
                        }}
                      >
                        <option value="">— Unscheduled —</option>
                        <option value="rest">Rest Day</option>
                        {data.routines.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
                      </select>
                    ) : (
                      <div style={{display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 4}}>
                        <span style={{fontSize: 14, fontWeight: 700, color: isRest ? theme.mutedText : routine ? theme.primaryText : theme.mutedText, fontStyle: (!routineId) ? "italic" : "normal"}}>
                          {isRest ? "Rest 🛌" : routine ? routine.name : "Unscheduled"}
                        </span>
                        {routine && isToday && (
                          <button style={{...S.scheduleStartBtn, background: T.accent, color: theme.app}} onClick={() => {
                            const r = data.routines.find(r2 => r2.id === routineId);
                            if (r) {
                              const exercises = r.exercises.map(e => ({...e, id: uid(), sets: e.sets.map(s => ({...s, weight: ""}))}));
                              setActiveRoutine(r);
                              setCurrentSession({ routineId: r.id, date: new Date().toISOString(), exercises });
                              setView("log");
                            }
                          }}>Start ▶</button>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* ── STATS ── */}
        {view === "stats" && (
          <div>
            <div style={{...S.heroLabel, color: T.accent}}>STATS</div>
            <h1 style={{...S.heroTitle, color: theme.primaryText}}>Personal Records</h1>

            {data.benchmarks.length === 0 && (
              <div style={{...S.empty, color: theme.mutedText}}>No personal records yet. Add an exercise to track.</div>
            )}

            {data.benchmarks.map(name => {
              const latest = getLatestWorkingSetAvg(data.sessions, name);
              const isActive = activeBenchmark === name;
              const history = isActive ? getBenchmarkHistory(data.sessions, name) : [];

              return (
                <div key={name} style={{...S.benchmarkCard, background: theme.surface, borderColor: theme.borderSubtle}}>
                  <div style={S.benchmarkHeader}>
                    <button style={{...S.benchmarkToggle, color: theme.primaryText}} onClick={() => setActiveBenchmark(isActive ? null : name)}>
                      <div style={{...S.benchmarkName, color: theme.primaryText}}>{name}</div>
                      {latest ? (
                        <div style={S.benchmarkStats}>
                          <span style={S.benchmarkStat}>
                            <span style={{...S.benchmarkStatLabel, color: theme.mutedText}}>Weight</span>
                            <span style={{...S.benchmarkStatValue, color: T.benchmarkStat}}>{latest.weight !== null && latest.weight !== undefined ? latest.weight : "—"}</span>
                          </span>
                          <span style={{...S.benchmarkDivider, color: theme.mutedText}}>·</span>
                          <span style={S.benchmarkStat}>
                            <span style={{...S.benchmarkStatLabel, color: theme.mutedText}}>Reps</span>
                            <span style={{...S.benchmarkStatValue, color: T.benchmarkStat}}>{latest.reps !== null && latest.reps !== undefined ? latest.reps : "—"}</span>
                          </span>
                          <span style={{...S.benchmarkDivider, color: theme.mutedText}}>·</span>
                          <span style={{...S.benchmarkDate, color: theme.mutedText}}>{formatDateShort(latest.date)}</span>
                        </div>
                      ) : (
                        <div style={{...S.benchmarkNoData, color: theme.mutedText}}>No working sets logged yet</div>
                      )}
                    </button>
                    <button style={{...S.benchmarkRemoveBtn, color: theme.mutedText, borderColor: theme.borderSubtle}} onClick={() => removeBenchmark(name)}>✕</button>
                  </div>

                  {isActive && history.length > 0 && (
                    <div style={S.chartWrap}>
                      <ResponsiveContainer width="100%" height={200}>
                        <LineChart data={history} margin={{ top: 8, right: 8, left: -20, bottom: 0 }}>
                          <XAxis dataKey="label" tick={{ fill: theme.mutedText, fontSize: 10 }} axisLine={false} tickLine={false} />
                          <YAxis yAxisId="weight" tick={{ fill: theme.mutedText, fontSize: 10 }} axisLine={false} tickLine={false} />
                          <YAxis yAxisId="reps" orientation="right" tick={{ fill: theme.mutedText, fontSize: 10 }} axisLine={false} tickLine={false} />
                          <Tooltip
                            contentStyle={{ background: theme.surface, border: "1px solid " + theme.border, borderRadius: 6, fontSize: 11, color: theme.primaryText }}
                            labelStyle={{ color: theme.mutedText, marginBottom: 4 }}
                            itemStyle={{ color: "#e8e4dc" }}
                          />
                          <Legend wrapperStyle={{ fontSize: 10, color: theme.mutedText, paddingTop: 8 }} />
                          <Line yAxisId="weight" type="monotone" dataKey="weight" name="Weight" stroke={CHART_WEIGHT_COLOR} strokeWidth={2} dot={{ fill: CHART_WEIGHT_COLOR, r: 3 }} connectNulls />
                          <Line yAxisId="reps" type="monotone" dataKey="reps" name="Reps" stroke={CHART_REPS_COLOR} strokeWidth={2} dot={{ fill: CHART_REPS_COLOR, r: 3 }} connectNulls />
                        </LineChart>
                      </ResponsiveContainer>
                    </div>
                  )}
                  {isActive && history.length === 0 && (
                    <div style={{...S.chartEmpty, color: theme.mutedText, borderColor: theme.borderSubtle}}>Not enough data to display a chart yet.</div>
                  )}
                </div>
              );
            })}

            {(() => {
              const allExercises = [...new Set(
                data.routines.flatMap(r => r.exercises.map(e => e.name.trim())).filter(Boolean)
              )].filter(name => !data.benchmarks.includes(name));
              return allExercises.length > 0 ? (
                <div style={{...S.addBenchmarkRow, background: theme.surface, borderColor: theme.border}}>
                  <span style={{...S.addBenchmarkLabel, color: theme.mutedText}}>TRACK EXERCISE</span>
                  <select style={{...S.benchmarkSelect, background: theme.inputBg, borderColor: theme.border, color: theme.primaryText}} value="" onChange={e => {
                    const name = e.target.value;
                    if (name) { setData(d => ({ ...d, benchmarks: [...d.benchmarks, name] })); }
                  }}>
                    <option value="">Select exercise...</option>
                    {allExercises.map(name => <option key={name} value={name}>{name}</option>)}
                  </select>
                </div>
              ) : null;
            })()}
          </div>
        )}
      </main>

      {/* ── NOTES MODAL ── */}
      {notesModal && (
        <div style={S.modalOverlay}>
          <div style={{...S.notesModalBox, background: theme.surface, borderColor: theme.border}}>
            <div style={{...S.modalTitle, color: theme.primaryText}}>Set Notes</div>
            <textarea
              style={{...S.notesTextarea, background: theme.inputBg, borderColor: theme.border, color: theme.primaryText}}
              placeholder="Add notes for this set..."
              value={notesDraft}
              onChange={e => setNotesDraft(e.target.value)}
              autoFocus
            />
            <div style={S.modalActions}>
              <button style={{...S.confirmBtn, background: T.accent, color: theme.app}} onClick={() => {
                if (notesModal.context === "tmpl") tmplUpdateSet(notesModal.exId, notesModal.si, "notes", notesDraft);
                else sessionUpdateSet(notesModal.exId, notesModal.si, "notes", notesDraft);
                setNotesModal(null);
              }}>Save</button>
              <button style={{...S.modalCancel, color: theme.mutedText, background: theme.surfaceAlt, borderColor: theme.border}} onClick={() => setNotesModal(null)}>Discard</button>
            </div>
          </div>
        </div>
      )}

      {/* ── SETTINGS / THEME MODAL ── */}
      {showSettings && (
        <div style={S.modalOverlay}>
          <div style={{...S.notesModalBox, background: theme.surface, borderColor: theme.border}}>
            {/* Tab switcher */}
            <div style={{display: "flex", gap: 4, marginBottom: 20, borderBottom: "1px solid " + theme.borderSubtle, paddingBottom: 12}}>
              {["theme", "account"].map(tab => (
                <button key={tab} style={{...S.settingsTabBtn, background: settingsTab === tab ? theme.surfaceAlt : "none", color: settingsTab === tab ? theme.primaryText : theme.mutedText, borderColor: settingsTab === tab ? theme.border : "transparent"}} onClick={() => { setSettingsTab(tab); setAccountMsg(""); }}>
                  {tab === "theme" ? "Theme" : "Account"}
                </button>
              ))}
            </div>

            {settingsTab === "theme" && (
              <div>
                <div style={{...S.modalTitle, color: theme.primaryText, marginBottom: 16}}>Theme</div>
                <div style={S.themeGrid}>
                  {Object.entries(THEMES).map(([key, t]) => (
                    <button key={key} style={{...S.themePresetBtn, background: t.app, border: themeKey === key ? "2px solid " + t.accent : "1px solid " + t.border}} onClick={() => setThemePreset(key)}>
                      <div style={S.themePreviewDots}>
                        <span style={{...S.themePreviewDot, background: t.accent}} />
                        <span style={{...S.themePreviewDot, background: t.workingTarget}} />
                        <span style={{...S.themePreviewDot, background: t.warmupTarget}} />
                        <span style={{...S.themePreviewDot, background: t.dropTarget}} />
                      </div>
                      <span style={{fontSize: 12, color: t.primaryText, fontWeight: themeKey === key ? 700 : 400}}>{t.name}</span>
                      {themeKey === key && <span style={{fontSize: 10, color: t.accent, letterSpacing: "0.1em"}}>ACTIVE</span>}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {settingsTab === "account" && (
              <div>
                <div style={{...S.modalTitle, color: theme.primaryText, marginBottom: 16}}>Account</div>
                <div style={{fontSize: 11, color: theme.mutedText, marginBottom: 16}}>Signed in as <strong style={{color: theme.primaryText}}>{getCredentials().username}</strong></div>
                <div style={S.setModalField}>
                  <label style={{...S.setModalLabel, color: theme.mutedText}}>NEW USERNAME</label>
                  <input style={{...S.textInput, background: theme.inputBg, borderColor: theme.border, color: theme.primaryText, width: "100%", boxSizing: "border-box"}} placeholder="Leave blank to keep current" value={newUsername} onChange={e => setNewUsername(e.target.value)} />
                </div>
                <div style={S.setModalField}>
                  <label style={{...S.setModalLabel, color: theme.mutedText}}>NEW PASSWORD</label>
                  <input type="password" style={{...S.textInput, background: theme.inputBg, borderColor: theme.border, color: theme.primaryText, width: "100%", boxSizing: "border-box"}} placeholder="Leave blank to keep current" value={newPassword} onChange={e => setNewPassword(e.target.value)} />
                </div>
                <div style={{...S.setModalField, marginBottom: 16}}>
                  <label style={{...S.setModalLabel, color: theme.mutedText}}>CONFIRM PASSWORD</label>
                  <input type="password" style={{...S.textInput, background: theme.inputBg, borderColor: theme.border, color: theme.primaryText, width: "100%", boxSizing: "border-box"}} placeholder="Confirm new password" value={confirmPassword} onChange={e => setConfirmPassword(e.target.value)} />
                </div>
                {accountMsg && <div style={{fontSize: 12, color: accountMsg.includes("success") ? T.accent : theme.dangerText, marginBottom: 12}}>{accountMsg}</div>}
                <button style={{...S.confirmBtn, background: T.accent, color: theme.app, width: "100%", marginBottom: 10}} onClick={handleSaveAccount}>Save Changes</button>
                <button style={{...S.modalCancel, color: theme.dangerText, borderColor: theme.dangerBorder, background: theme.dangerBg, width: "100%"}} onClick={handleLogout}>Sign Out</button>
              </div>
            )}

            <div style={{...S.modalActions, marginTop: 20}}>
              <button style={{...S.confirmBtn, background: theme.accent, color: theme.app}} onClick={() => setShowSettings(false)}>Done</button>
            </div>
          </div>
        </div>
      )}

      {/* ── SET MODAL ── */}
      {activeSetModal && currentSession && (() => {
        const { exId, si, isDropSet, di } = activeSetModal;
        const ex = currentSession.exercises.find(e => e.id === exId);
        if (!ex) return null;
        const set = isDropSet ? ex.sets[si] && ex.sets[si].dropSets && ex.sets[si].dropSets[di] : ex.sets[si];
        if (!set) return null;
        const cat = isDropSet ? "Drop Set" : (set.category || ex.category);
        const isWorking = cat === "Working Set";
        const tmplEx = activeRoutine && activeRoutine.exercises.find(e => e.name.trim().toLowerCase() === ex.name.trim().toLowerCase());
        const tmplReps = tmplEx && tmplEx.sets[si] && tmplEx.sets[si].reps || "";
        const suggestedWeight = isDropSet
          ? suggestDropSet(data.sessions, ex.name, currentSession && currentSession.exercises, di, ex.sets[si] && ex.sets[si].dropSets)
          : (ex.name ? (isWorking ? suggestWeight(data.sessions, ex.name, si, tmplReps) : suggestWarmupWeight(data.sessions, ex.name, si, currentSession && currentSession.exercises)) : null);
        const prev = isDropSet ? null : getPrevSetData(prevSession, ex.name, si);
        const catColor = cat === "Working Set" ? T.workingBadge : cat === "Drop Set" ? T.dropBadge : T.warmupBadge;
        const targetColor = cat === "Working Set" ? T.workingTarget : cat === "Drop Set" ? T.dropTarget : T.warmupTarget;
        return (
          <div style={S.modalOverlay} key="setmodal">
            <div style={{...S.setModalBox, background: theme.surface, borderColor: theme.border}}>
              {/* Header */}
              <div style={S.setModalHeader}>
                <div>
                  <div style={{fontSize: 11, color: theme.mutedText, letterSpacing: "0.1em", marginBottom: 2}}>{ex.name}</div>
                  <div style={{display: "flex", alignItems: "center", gap: 8}}>
                    <span style={{fontSize: 22, fontWeight: 900, color: theme.primaryText, fontFamily: "'Georgia',serif"}}>Set {si + 1}{isDropSet ? ` - Drop ${di + 1}` : ""}</span>
                    <span style={{fontSize: 10, color: catColor, fontWeight: 700, letterSpacing: "0.08em", background: catColor + "22", padding: "2px 6px", borderRadius: 3}}>{cat}</span>
                  </div>
                </div>
                <button style={{background: "none", border: "none", color: theme.mutedText, cursor: "pointer", fontSize: 20, padding: 4}} onClick={() => setActiveSetModal(null)}>✕</button>
              </div>

              {/* Target & Previous */}
              {(suggestedWeight || prev) && (
                <div style={{...S.setModalContext, borderColor: theme.borderSubtle}}>
                  {suggestedWeight && (
                    <div style={S.setModalContextRow}>
                      <span style={{fontSize: 10, color: targetColor, fontWeight: 700, letterSpacing: "0.1em"}}>TARGET</span>
                      <span style={{fontSize: 16, fontWeight: 800, color: targetColor}}>{isDropSet ? suggestedWeight.weight : suggestedWeight} lbs{tmplReps && !isDropSet ? "  -  " + tmplReps + " reps" : ""}{isDropSet && suggestedWeight.reps ? "  -  " + suggestedWeight.reps + " reps" : ""}</span>
                    </div>
                  )}
                  {prev && (
                    <div style={S.setModalContextRow}>
                      <span style={{fontSize: 10, color: theme.mutedText, fontWeight: 700, letterSpacing: "0.1em"}}>PREVIOUS</span>
                      <span style={{fontSize: 14, color: theme.primaryText}}>{prev.weight || "—"} lbs  -  {prev.reps || "—"} reps{prev.rest ? "  -  " + prev.rest + " rest" : ""}</span>
                    </div>
                  )}
                </div>
              )}

              {/* Inputs */}
              <div style={S.setModalInputs}>
                <div style={S.setModalField}>
                  <label style={{...S.setModalLabel, color: theme.mutedText}}>Reps</label>
                  <input style={{...S.setModalInput, background: theme.inputBg, borderColor: theme.border, color: theme.primaryText}} type="number" inputMode="numeric" placeholder="0" value={setDraft.reps} onChange={e => setSetDraft(d => ({...d, reps: e.target.value}))} autoFocus />
                </div>
                <div style={S.setModalField}>
                  <label style={{...S.setModalLabel, color: theme.mutedText}}>Weight (lbs)</label>
                  <input style={{...S.setModalInput, background: theme.inputBg, borderColor: theme.border, color: theme.primaryText}} type="number" inputMode="decimal" placeholder="0" value={setDraft.weight} onChange={e => setSetDraft(d => ({...d, weight: e.target.value}))} />
                </div>
              </div>

              <div style={S.setModalField}>
                <label style={{...S.setModalLabel, color: theme.mutedText}}>Difficulty</label>
                <select style={{...S.setModalInput, background: theme.inputBg, borderColor: theme.border, color: setDraft.difficulty ? theme.primaryText : theme.mutedText, padding: "14px 12px"}} value={setDraft.difficulty} onChange={e => setSetDraft(d => ({...d, difficulty: e.target.value}))}>
                  <option value="">Select difficulty...</option>
                  {DIFFICULTIES.map(d => <option key={d} value={d}>{d}</option>)}
                </select>
              </div>

              <div style={S.setModalField}>
                <label style={{...S.setModalLabel, color: theme.mutedText}}>Notes</label>
                <textarea style={{...S.notesTextarea, background: theme.inputBg, borderColor: theme.border, color: theme.primaryText, minHeight: 64, marginBottom: 0}} placeholder="Optional notes..." value={setDraft.notes} onChange={e => setSetDraft(d => ({...d, notes: e.target.value}))} />
              </div>

              {!isDropSet && cat === "Working Set" && tmplEx && tmplEx.allowDropSets !== false && (
                <div style={{marginTop: 8, paddingTop: 16, borderTop: "1px solid " + theme.borderSubtle}}>
                  <div style={{fontSize: 10, color: T.dropTarget, fontWeight: 700, letterSpacing: "0.12em", marginBottom: 10}}>DROP SETS</div>
                  {(setDraft.dropSets || []).map((ds, di) => {
                    const dSug = ex.name ? suggestDropSet(data.sessions, ex.name, currentSession && currentSession.exercises, di, setDraft.dropSets) : null;
                    return (
                      <div key={di} style={{background: theme.inputBg, borderRadius: 8, padding: "12px", marginBottom: 8, border: "1px solid " + T.dropTarget + "44"}}>
                        <div style={{display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8}}>
                          <span style={{fontSize: 11, color: T.dropTarget, fontWeight: 700}}>Drop {di + 1}</span>
                          {dSug && <span style={{fontSize: 10, color: T.dropTarget}}>Target: {dSug.reps} reps - {dSug.weight} lbs</span>}
                          <button style={{background: "none", border: "none", color: theme.mutedText, cursor: "pointer", fontSize: 14, padding: "0 4px"}} onClick={() => setSetDraft(d => ({...d, dropSets: d.dropSets.filter((_, i) => i !== di)}))}>✕</button>
                        </div>
                        <div style={{display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 8}}>
                          <div>
                            <div style={{fontSize: 9, color: theme.mutedText, fontWeight: 700, letterSpacing: "0.1em", marginBottom: 4}}>REPS</div>
                            <input style={{...S.setInput, background: theme.surface, borderColor: theme.border, color: theme.primaryText, fontWeight: 700, fontSize: 16}} type="number" inputMode="numeric" placeholder="0" value={ds.reps} onChange={e => setSetDraft(d => ({...d, dropSets: d.dropSets.map((s, i) => i === di ? {...s, reps: e.target.value} : s)}))} />
                          </div>
                          <div>
                            <div style={{fontSize: 9, color: theme.mutedText, fontWeight: 700, letterSpacing: "0.1em", marginBottom: 4}}>WEIGHT (lbs)</div>
                            <input style={{...S.setInput, background: theme.surface, borderColor: theme.border, color: theme.primaryText, fontWeight: 700, fontSize: 16}} type="number" inputMode="decimal" placeholder="0" value={ds.weight} onChange={e => setSetDraft(d => ({...d, dropSets: d.dropSets.map((s, i) => i === di ? {...s, weight: e.target.value} : s)}))} />
                          </div>
                        </div>
                        <select style={{...S.diffSelect, background: theme.surface, borderColor: theme.border, color: ds.difficulty ? theme.primaryText : theme.mutedText, width: "100%", padding: "8px"}} value={ds.difficulty || ""} onChange={e => setSetDraft(d => ({...d, dropSets: d.dropSets.map((s, i) => i === di ? {...s, difficulty: e.target.value} : s)}))}>
                          <option value="">Difficulty...</option>
                          {DIFFICULTIES.map(d => <option key={d} value={d}>{d}</option>)}
                        </select>
                      </div>
                    );
                  })}
                  <button style={{...S.addDropSetBtn, color: T.dropTarget, borderColor: T.dropTarget, width: "100%", padding: "10px", marginBottom: 4, textAlign: "center"}} onClick={() => setSetDraft(d => ({...d, dropSets: [...(d.dropSets || []), {id: uid(), reps: "", weight: "", difficulty: "", notes: ""}]}))}>
                    + Add Drop Set
                  </button>
                </div>
              )}

              <button style={{...S.completeBtn, background: T.accent, color: theme.app, width: "100%", marginTop: 16, padding: 16, fontSize: 14}} onClick={completeSet}>
                Complete Set ✓
              </button>
            </div>
          </div>
        );
      })()}

      {/* ── DELETE CONFIRM MODAL ── */}
      {deleteConfirmId && (
        <div style={S.modalOverlay}>
          <div style={{...S.modalBox, background: theme.surface, borderColor: theme.border}}>
            <div style={{...S.modalTitle, color: theme.primaryText}}>Delete this entry?</div>
            <div style={{...S.modalBody, color: theme.mutedText}}>This workout record will be permanently removed from your history.</div>
            <div style={S.modalActions}>
              <button style={{...S.modalDiscard, background: theme.dangerBg, borderColor: theme.dangerBorder, color: theme.dangerText}} onClick={() => deleteSession(deleteConfirmId)}>Delete</button>
              <button style={{...S.modalCancel, color: theme.mutedText, background: theme.surfaceAlt, borderColor: theme.border}} onClick={() => setDeleteConfirmId(null)}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      {/* ── DISCARD CONFIRM MODAL ── */}
      {showDiscardConfirm && (
        <div style={S.modalOverlay}>
          <div style={{...S.modalBox, background: theme.surface, borderColor: theme.border}}>
            <div style={{...S.modalTitle, color: theme.primaryText}}>Discard session?</div>
            <div style={{...S.modalBody, color: theme.mutedText}}>This session has not been saved. Your progress will be lost.</div>
            <div style={S.modalActions}>
              <button style={{...S.modalDiscard, background: theme.dangerBg, borderColor: theme.dangerBorder, color: theme.dangerText}} onClick={discardSession}>Discard</button>
              <button style={{...S.modalCancel, color: theme.mutedText, background: theme.surfaceAlt, borderColor: theme.border}} onClick={() => { setShowDiscardConfirm(false); setPendingNav(null); }}>Keep going</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const S = {
  app: { minHeight: "100vh", background: "#0c0c0e", color: "#e8e4dc", fontFamily: "'DM Mono','Courier New',monospace", position: "relative", overflowX: "hidden" },
  grain: { position: "fixed", inset: 0, zIndex: 0, pointerEvents: "none", backgroundImage: `url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noise'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noise)' opacity='0.04'/%3E%3C/svg%3E")`, backgroundRepeat: "repeat", backgroundSize: "128px" },
  header: { borderBottom: "1px solid #222", background: "rgba(12,12,14,0.92)", backdropFilter: "blur(12px)", position: "sticky", top: 0, zIndex: 10 },
  headerInner: { maxWidth: 720, margin: "0 auto", padding: "14px 20px", display: "flex", alignItems: "center", justifyContent: "space-between" },
  logoBtn: { background: "none", border: "none", cursor: "pointer", display: "flex", alignItems: "center", gap: 8 },
  logoMark: { fontSize: 20, color: "#c8ff00" },
  logoText: { fontSize: 13, fontWeight: 700, letterSpacing: "0.18em", color: "#e8e4dc" },
  nav: { display: "flex", gap: 4 },
  navBtn: { background: "none", border: "none", cursor: "pointer", color: "#666", fontSize: 12, fontWeight: 600, letterSpacing: "0.1em", padding: "6px 10px", borderRadius: 4 },
  navActive: { background: "#1a1a1d", border: "none", cursor: "pointer", color: "#c8ff00", fontSize: 12, letterSpacing: "0.1em", padding: "6px 10px", borderRadius: 4, fontWeight: 700 },
  main: { maxWidth: 720, margin: "0 auto", padding: "32px 20px 80px", position: "relative", zIndex: 1 },
  heroLabel: { fontSize: 10, letterSpacing: "0.25em", color: "#c8ff00", fontWeight: 700, marginBottom: 8 },
  heroTitle: { fontSize: "clamp(36px,8vw,64px)", fontWeight: 900, lineHeight: 1.05, margin: "0 0 32px", fontFamily: "'Georgia',serif", color: "#e8e4dc" },

  routineGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))", gap: 12, marginBottom: 20 },
  routineCard: { background: "#111113", border: "1px solid #2a2a2e", borderRadius: 8, overflow: "hidden" },
  routinePlayBtn: { display: "flex", flexDirection: "column", gap: 6, padding: "16px 16px 10px", width: "100%", background: "none", border: "none", cursor: "pointer", textAlign: "left", color: "#e8e4dc" },
  routineIcon: { color: "#c8ff00", fontSize: 11 },
  routineName: { fontSize: 14, fontWeight: 700, letterSpacing: "0.05em" },
  routineCount: { fontSize: 10, color: "#555", letterSpacing: "0.08em", fontWeight: 600 },
  routineActions: { display: "flex", borderTop: "1px solid #1e1e22" },
  routineActionBtn: { flex: 1, background: "none", border: "none", borderRight: "1px solid #1e1e22", cursor: "pointer", color: "#555", fontSize: 11, fontWeight: 700, letterSpacing: "0.1em", padding: "8px 0", fontFamily: "'DM Mono',monospace" },

  renameCard: { background: "#111113", border: "1px solid #c8ff0055", borderRadius: 8, padding: "14px 12px", display: "flex", flexDirection: "column", gap: 10 },
  renameInput: { background: "transparent", border: "none", borderBottom: "1px solid #c8ff00", color: "#e8e4dc", fontSize: 14, fontWeight: 700, outline: "none", padding: "4px 0", width: "100%", fontFamily: "'DM Mono',monospace" },
  renameActions: { display: "flex", gap: 6 },
  renameSave: { background: "#c8ff00", border: "none", borderRadius: 4, color: "#0c0c0e", fontSize: 11, fontWeight: 700, padding: "5px 12px", cursor: "pointer" },
  renameCancel: { background: "#1e1e22", border: "none", borderRadius: 4, color: "#888", fontSize: 11, padding: "5px 10px", cursor: "pointer" },

  addRoutineCard: { background: "transparent", border: "1px dashed #333", borderRadius: 8, padding: "20px 16px", cursor: "pointer", color: "#555", display: "flex", flexDirection: "column", gap: 8, textAlign: "left" },
  addIcon: { fontSize: 18, color: "#c8ff00" },
  addLabel: { fontSize: 13, letterSpacing: "0.05em" },
  addRoutineRow: { display: "flex", gap: 8, marginBottom: 16 },
  textInput: { flex: 1, background: "#111113", border: "1px solid #333", borderRadius: 6, padding: "10px 14px", color: "#e8e4dc", fontSize: 13, outline: "none", fontFamily: "'DM Mono',monospace" },
  confirmBtn: { background: "#c8ff00", border: "none", borderRadius: 6, padding: "10px 18px", cursor: "pointer", fontSize: 12, fontWeight: 700, color: "#0c0c0e" },

  recentSection: { marginTop: 40 },
  sectionLabel: { fontSize: 10, letterSpacing: "0.25em", color: "#555", fontWeight: 700, marginBottom: 12 },
  recentCard: { display: "flex", alignItems: "center", justifyContent: "space-between", width: "100%", background: "#111113", border: "1px solid #1e1e22", borderRadius: 8, padding: "14px 16px", cursor: "pointer", marginBottom: 8, textAlign: "left" },
  recentRoutine: { fontSize: 13, fontWeight: 700, color: "#e8e4dc", marginBottom: 2 },
  recentDate: { fontSize: 11, color: "#555", fontWeight: 600 },
  chevron: { color: "#444", fontSize: 20 },

  templateHint: { fontSize: 11, color: "#555", lineHeight: 1.6, margin: "0 0 24px", letterSpacing: "0.03em" },
  emptyTemplate: { color: "#444", fontSize: 13, padding: "20px 0", letterSpacing: "0.05em" },
  saveTemplateRow: { marginTop: 24 },
  saveTemplateBtn: { background: "#c8ff00", border: "none", borderRadius: 6, padding: "12px 28px", cursor: "pointer", fontSize: 12, fontWeight: 700, letterSpacing: "0.1em", color: "#0c0c0e" },

  categoryRow: { display: "flex", alignItems: "center", gap: 10, marginBottom: 14 },
  categoryLabel: { fontSize: 9, letterSpacing: "0.2em", color: "#555", fontWeight: 700, flexShrink: 0 },
  categorySelect: { background: "#0c0c0e", border: "1px solid #2a2a2e", borderRadius: 4, color: "#e8e4dc", fontSize: 11, padding: "5px 10px", outline: "none", fontFamily: "'DM Mono',monospace", cursor: "pointer" },

  catBadgeWorking: { fontSize: 9, letterSpacing: "0.1em", background: "#111a00", color: "#c8ff00", border: "1px solid #c8ff0033", borderRadius: 3, padding: "2px 6px", flexShrink: 0 },
  catBadgeWarmup: { fontSize: 9, letterSpacing: "0.1em", background: "#0a1520", color: "#4a9eff", border: "1px solid #4a9eff33", borderRadius: 3, padding: "2px 6px", flexShrink: 0 },

  logHeader: { display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 24 },
  logTitle: { fontSize: 36, fontWeight: 900, margin: "0 0 4px", fontFamily: "'Georgia',serif", color: "#e8e4dc" },
  logDate: { fontSize: 11, color: "#555", letterSpacing: "0.1em", fontWeight: 600 },
  prevLabel: { fontSize: 9, color: "#3a5a00", letterSpacing: "0.15em", marginTop: 4, fontWeight: 700 },
  completeBtn: { background: "#c8ff00", border: "none", borderRadius: 6, padding: "10px 16px", cursor: "pointer", fontSize: 11, fontWeight: 700, letterSpacing: "0.08em", color: "#0c0c0e", alignSelf: "flex-start", whiteSpace: "nowrap" },
  saveBtn: { background: "#c8ff00", border: "none", borderRadius: 6, padding: "10px 20px", cursor: "pointer", fontSize: 11, fontWeight: 700, color: "#0c0c0e", alignSelf: "flex-start" },

  modalOverlay: { position: "fixed", inset: 0, background: "rgba(0,0,0,0.75)", zIndex: 100, display: "flex", alignItems: "center", justifyContent: "center", padding: 24 },
  modalBox: { background: "#111113", border: "1px solid #2a2a2e", borderRadius: 12, padding: "28px 24px", maxWidth: 360, width: "100%" },
  modalTitle: { fontSize: 16, fontWeight: 700, color: "#e8e4dc", marginBottom: 10, fontFamily: "'Georgia',serif" },
  modalBody: { fontSize: 12, color: "#666", lineHeight: 1.6, marginBottom: 24 },
  modalActions: { display: "flex", gap: 10 },
  modalDiscard: { flex: 1, background: "#2a0000", border: "1px solid #550000", borderRadius: 6, color: "#ff6666", fontSize: 12, fontWeight: 700, padding: "10px", cursor: "pointer", letterSpacing: "0.08em" },
  modalCancel: { flex: 1, background: "#1a1a1d", border: "1px solid #2a2a2e", borderRadius: 6, color: "#aaa", fontSize: 12, padding: "10px", cursor: "pointer" },

  restBanner: { background: "#111a00", border: "1px solid #c8ff0033", borderRadius: 8, padding: "12px 16px", display: "flex", alignItems: "center", gap: 12, marginBottom: 12 },
  restLabel: { fontSize: 10, letterSpacing: "0.2em", color: "#c8ff00", fontWeight: 700 },
  restTime: { fontSize: 24, fontWeight: 900, color: "#c8ff00", flex: 1 },
  restStop: { background: "none", border: "none", color: "#555", cursor: "pointer", fontSize: 16 },
  restButtons: { display: "flex", alignItems: "center", gap: 8, marginBottom: 24, flexWrap: "wrap" },
  restHint: { fontSize: 10, color: "#444", fontWeight: 600, letterSpacing: "0.1em", marginRight: 4 },
  restBtn: { background: "#111113", border: "1px solid #2a2a2e", borderRadius: 4, padding: "5px 10px", color: "#888", fontSize: 11, cursor: "pointer", fontFamily: "'DM Mono',monospace" },

  exerciseCard: { background: "#111113", border: "1px solid #1e1e22", borderRadius: 10, padding: "16px", marginBottom: 16 },
  exHeader: { display: "flex", alignItems: "center", gap: 8, marginBottom: 10 },
  exNum: { fontSize: 11, color: "#c8ff00", fontWeight: 700, width: 24, flexShrink: 0 },
  exNameInput: { flex: 1, background: "transparent", border: "none", borderBottom: "1px solid #333", padding: "4px 0", color: "#e8e4dc", fontSize: 14, fontWeight: 700, outline: "none", fontFamily: "'DM Mono',monospace", minWidth: 0 },
  exLogName: { flex: 1, fontSize: 14, fontWeight: 700, color: "#e8e4dc", minWidth: 0 },
  exMoveGroup: { display: "flex", gap: 2, flexShrink: 0 },
  moveBtn: { background: "#1a1a1d", border: "none", borderRadius: 3, color: "#555", cursor: "pointer", fontSize: 11, padding: "3px 6px", fontFamily: "'DM Mono',monospace" },
  exViewHeader: { display: "flex", alignItems: "center", gap: 8, marginBottom: 14 },
  exViewName: { fontSize: 14, fontWeight: 700, color: "#e8e4dc", flex: 1 },
  removeBtn: { background: "none", border: "none", color: "#444", cursor: "pointer", fontSize: 14, padding: 4, flexShrink: 0 },

  setHeaderRowTemplate: { display: "grid", gridTemplateColumns: "20px 1.4fr 0.5fr 0.5fr 0.7fr 20px", gap: 6, marginBottom: 6 },
  setRowTemplate: { display: "grid", gridTemplateColumns: "20px 1.4fr 0.5fr 0.5fr 0.7fr 20px", gap: 6, marginBottom: 6, alignItems: "center" },
  setHeaderRowLog: { display: "grid", gridTemplateColumns: "40px 0.7fr 0.7fr 0.7fr 1fr 0.8fr", gap: 6, marginBottom: 6 },
  restBetweenSets: { display: "flex", alignItems: "center", justifyContent: "center", gap: 10, padding: "6px 14px", borderRadius: 6, border: "1px solid", margin: "2px 0", transition: "all 0.3s" },
  setRowSummary: { display: "flex", alignItems: "center", gap: 10, width: "100%", border: "1px solid", borderRadius: 8, padding: "12px 14px", cursor: "pointer", marginBottom: 6, textAlign: "left" },
  setRowSummaryLeft: { display: "flex", flexDirection: "column", alignItems: "center", minWidth: 32, flexShrink: 0 },
  setRowSummaryData: { flex: 1, display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" },
  setRowSummaryVal: { fontSize: 14, fontWeight: 700 },
  setRowSummaryMeta: { fontSize: 11 },
  setRowSummaryIcon: { fontSize: 18, flexShrink: 0 },
  setModalBox: { border: "1px solid", borderRadius: 14, padding: "24px 20px", maxWidth: 480, width: "100%", maxHeight: "90vh", overflowY: "auto" },
  setModalHeader: { display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 16 },
  setModalContext: { borderTop: "1px solid", borderBottom: "1px solid", padding: "12px 0", marginBottom: 16, display: "flex", flexDirection: "column", gap: 10 },
  setModalContextRow: { display: "flex", flexDirection: "column", gap: 3 },
  setModalInputs: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12 },
  setModalField: { display: "flex", flexDirection: "column", gap: 6, marginBottom: 12 },
  setModalLabel: { fontSize: 10, fontWeight: 700, letterSpacing: "0.15em" },
  setModalInput: { border: "1px solid", borderRadius: 8, padding: "14px 12px", fontSize: 20, fontWeight: 700, outline: "none", fontFamily: "'DM Mono',monospace", width: "100%", boxSizing: "border-box" },
  setRowLog: { display: "grid", gridTemplateColumns: "40px 0.7fr 0.7fr 0.7fr 1fr 0.8fr", gap: 6, alignItems: "center" },
  prevRow: { display: "grid", gridTemplateColumns: "40px 0.7fr 0.7fr 0.7fr 1fr 0.8fr", gap: 6, alignItems: "center", marginBottom: 8, marginTop: 3 },
  dropSetToggleRow: { display: "flex", alignItems: "center", gap: 8, marginBottom: 12, cursor: "pointer" },
  dropSetCheckbox: { width: 14, height: 14, accentColor: "#c8ff00", cursor: "pointer", flexShrink: 0 },
  dropSetToggleLabel: { fontSize: 11, color: "#666", letterSpacing: "0.08em" },
  dropSetIndent: { paddingLeft: 10 },
  suggestRowDrop: { display: "grid", gridTemplateColumns: "40px 0.7fr 0.7fr 0.7fr 1fr 0.8fr", gap: 6, alignItems: "center", marginBottom: 2, marginTop: 3 },
  suggestBadgeDrop: { fontSize: 8, color: "#ff4d9e", fontWeight: 700, letterSpacing: "0.1em", textAlign: "center" },
  suggestWeightDrop: { fontSize: 12, color: "#ff4d9e", fontWeight: 700, textAlign: "center" },
  dropSetRow: { display: "grid", gridTemplateColumns: "40px 0.7fr 0.7fr 0.7fr 1fr 0.8fr", gap: 6, alignItems: "center", marginBottom: 4 },
  dropSetNum: { display: "flex", flexDirection: "column", alignItems: "center" },
  setCatDrop: { fontSize: 8, letterSpacing: "0.08em", color: "#ff4d9e", fontWeight: 700, marginTop: 2 },
  addDropSetRow: { display: "flex", justifyContent: "flex-end", marginBottom: 6 },
  addDropSetBtn: { background: "none", border: "1px solid #2a1020", borderRadius: 4, color: "#ff4d9e", fontSize: 10, padding: "4px 10px", cursor: "pointer", letterSpacing: "0.08em", fontFamily: "'DM Mono',monospace" },
  suggestBadgeWarm: { fontSize: 8, color: "#ff9f43", fontWeight: 700, letterSpacing: "0.1em", textAlign: "center" },
  suggestWeightWarm: { fontSize: 12, color: "#ff9f43", fontWeight: 700, textAlign: "center" },
  suggestRow: { display: "grid", gridTemplateColumns: "40px 0.7fr 0.7fr 0.7fr 1fr 0.8fr", gap: 6, alignItems: "center", marginBottom: 2, marginTop: 3 },
  suggestBadge: { fontSize: 8, color: "#4a9eff", fontWeight: 700, letterSpacing: "0.1em", textAlign: "center" },
  suggestCell: { fontSize: 11, color: "#2a5a7a", textAlign: "center" },
  suggestWeight: { fontSize: 12, color: "#4a9eff", fontWeight: 700, textAlign: "center" },
  prevBadge: { fontSize: 8, color: "#3a6600", fontWeight: 700, letterSpacing: "0.1em", textAlign: "center" },
  prevCell: { fontSize: 11, color: "#4a7a00", textAlign: "center" },
  prevCellWide: { fontSize: 10, color: "#4a7a00" },
  setHeaderRowView: { display: "grid", gridTemplateColumns: "28px 1fr 1fr 1fr 2fr", gap: 6, marginBottom: 6 },
  setRowView: { display: "grid", gridTemplateColumns: "28px 1fr 1fr 1fr 2fr", gap: 6, marginBottom: 6, alignItems: "center" },

  setHeaderCell: { fontSize: 9, letterSpacing: "0.15em", color: "#444", fontWeight: 700 },
  setNum: { fontSize: 11, color: "#555", textAlign: "center" },
  setInput: { background: "#0c0c0e", border: "1px solid #222", borderRadius: 4, padding: "6px 8px", color: "#e8e4dc", fontSize: 13, outline: "none", fontFamily: "'DM Mono',monospace", width: "100%", boxSizing: "border-box" },
  setInputWide: { background: "#0c0c0e", border: "1px solid #222", borderRadius: 4, padding: "6px 8px", color: "#e8e4dc", fontSize: 12, outline: "none", fontFamily: "'DM Mono',monospace", width: "100%", boxSizing: "border-box" },
  setCell: { fontSize: 13, color: "#aaa", textAlign: "center" },
  setCellWide: { fontSize: 12, color: "#888" },
  setNumLabel: { display: "block", fontSize: 11, color: "#555", fontWeight: 600 },
  setCatWorking: { display: "block", fontSize: 7, letterSpacing: "0.04em", color: "#c8ff00", fontWeight: 700, marginTop: 1 },
  setCatWarmup: { display: "block", fontSize: 7, letterSpacing: "0.04em", color: "#4a9eff", fontWeight: 700, marginTop: 1 },
  setCatSelectSmall: { background: "#0c0c0e", border: "1px solid #2a2a2e", borderRadius: 4, color: "#e8e4dc", fontSize: 10, padding: "5px 6px", outline: "none", fontFamily: "'DM Mono',monospace", cursor: "pointer", width: "100%" },
  removeSetBtn: { background: "none", border: "none", color: "#444", cursor: "pointer", fontSize: 16, padding: 0, lineHeight: 1 },
  addSetBtn: { background: "none", border: "none", color: "#555", cursor: "pointer", fontSize: 12, padding: "8px 0 0", letterSpacing: "0.1em" },
  addExBtn: { width: "100%", background: "#111113", border: "1px dashed #333", borderRadius: 8, padding: 16, cursor: "pointer", color: "#c8ff00", fontSize: 12, fontWeight: 700, letterSpacing: "0.1em", fontFamily: "'DM Mono',monospace", marginTop: 4 },

  historyRow: { display: "flex", alignItems: "stretch", gap: 6, marginBottom: 10 },
  historyCard: { flex: 1, display: "flex", alignItems: "center", justifyContent: "space-between", background: "#111113", border: "1px solid #1e1e22", borderRadius: 8, padding: "16px", cursor: "pointer", textAlign: "left" },
  deleteBtn: { background: "#111113", border: "1px solid #1e1e22", borderRadius: 8, padding: "0 14px", cursor: "pointer", fontSize: 15, color: "#444", flexShrink: 0 },
  sessionDetailHeader: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 0 },
  deleteSessionBtn: { background: "none", border: "1px solid #2a0000", borderRadius: 6, color: "#ff6666", fontSize: 11, padding: "6px 14px", cursor: "pointer", letterSpacing: "0.08em", marginBottom: 20 },
  historyRoutine: { fontSize: 14, fontWeight: 700, color: "#e8e4dc", marginBottom: 4 },
  historyMeta: { fontSize: 11, color: "#555", fontWeight: 600, letterSpacing: "0.05em" },
  backBtn: { background: "none", border: "none", color: "#666", cursor: "pointer", fontSize: 12, letterSpacing: "0.1em", padding: "0 0 20px", display: "block" },
  empty: { color: "#444", fontSize: 14, padding: "40px 0" },
  todayCard: { border: "1px solid", borderRadius: 12, padding: "20px", marginBottom: 16 },
  todayCardTop: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 },
  manageRoutinesBtn: { display: "block", width: "100%", border: "1px solid", borderRadius: 10, padding: "16px", cursor: "pointer", textAlign: "left", fontSize: 14, fontWeight: 700, fontFamily: "'DM Mono',monospace", marginBottom: 16, letterSpacing: "0.05em" },
  addSessionBtn: { border: "none", borderRadius: 6, padding: "8px 16px", fontSize: 12, fontWeight: 700, cursor: "pointer", letterSpacing: "0.08em", alignSelf: "flex-end", marginBottom: 8, flexShrink: 0 },
  scheduleGrid: { display: "flex", flexDirection: "column", gap: 8, marginBottom: 24 },
  scheduleDay: { border: "1px solid", borderRadius: 10, padding: "14px 16px" },
  scheduleDayHeader: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 },
  scheduleDayName: { fontSize: 14, fontWeight: 700 },
  scheduleSelect: { width: "100%", border: "1px solid", borderRadius: 6, padding: "10px 12px", fontSize: 13, outline: "none", fontFamily: "'DM Mono',monospace", cursor: "pointer" },
  scheduleEditBtn: { border: "1px solid", borderRadius: 6, padding: "8px 16px", fontSize: 12, cursor: "pointer", letterSpacing: "0.08em", fontFamily: "'DM Mono',monospace", marginTop: 8, flexShrink: 0 },
  scheduleStartBtn: { border: "none", borderRadius: 6, padding: "8px 18px", fontSize: 11, fontWeight: 700, cursor: "pointer", letterSpacing: "0.08em" },
  settingsBtn: { background: "none", border: "none", cursor: "pointer", color: "#555", fontSize: 16, padding: "6px 8px", lineHeight: 1 },
  loginBox: { border: "1px solid", borderRadius: 14, padding: "32px 28px", width: "100%", maxWidth: 360, boxSizing: "border-box" },
  settingsTabBtn: { flex: 1, border: "1px solid", borderRadius: 6, padding: "7px 12px", cursor: "pointer", fontSize: 12, fontWeight: 600, fontFamily: "'DM Mono',monospace", letterSpacing: "0.06em" },
  themeGrid: { display: "flex", flexDirection: "row", gap: 12, flexWrap: "wrap" },
  themePresetBtn: { flex: "1 1 120px", borderRadius: 10, padding: "16px 12px", cursor: "pointer", display: "flex", flexDirection: "column", gap: 10, alignItems: "center", transition: "border 0.15s" },
  themePreviewDots: { display: "flex", gap: 6 },
  themePreviewDot: { width: 12, height: 12, borderRadius: "50%" },

  // Benchmarks
  benchmarkCard: { background: "#111113", border: "1px solid #1e1e22", borderRadius: 10, marginBottom: 12, overflow: "hidden" },
  benchmarkHeader: { display: "flex", alignItems: "stretch" },
  benchmarkToggle: { flex: 1, background: "none", border: "none", cursor: "pointer", textAlign: "left", padding: "16px", color: "#e8e4dc" },
  benchmarkName: { fontSize: 14, fontWeight: 700, letterSpacing: "0.05em", marginBottom: 6 },
  benchmarkStats: { display: "flex", alignItems: "center", gap: 8 },
  benchmarkStat: { display: "flex", alignItems: "baseline", gap: 4 },
  benchmarkStatLabel: { fontSize: 9, letterSpacing: "0.15em", color: "#555", fontWeight: 700 },
  benchmarkStatValue: { fontSize: 16, fontWeight: 900, color: "#c8ff00" },
  benchmarkDivider: { color: "#333", fontSize: 14 },
  benchmarkDate: { fontSize: 10, color: "#444" },
  benchmarkNoData: { fontSize: 11, color: "#444", letterSpacing: "0.05em" },
  benchmarkRemoveBtn: { background: "none", border: "none", borderLeft: "1px solid #1e1e22", color: "#333", cursor: "pointer", padding: "0 16px", fontSize: 14, flexShrink: 0 },
  chartWrap: { padding: "4px 8px 16px", borderTop: "1px solid #1a1a1d" },
  chartEmpty: { padding: "12px 16px 16px", fontSize: 11, color: "#444", borderTop: "1px solid #1a1a1d" },
  diffSelect: { background: "#0c0c0e", border: "1px solid #2a2a2e", borderRadius: 4, color: "#555", fontSize: 10, padding: "5px 4px", outline: "none", fontFamily: "'DM Mono',monospace", cursor: "pointer", width: "100%" },
  diffSelectFilled: (d) => ({ background: "#0c0c0e", border: "1px solid " + (d === "Easy" ? "#4a9eff44" : d === "Medium" ? "#c8ff0044" : d === "Difficult" ? "#ff8c0044" : "#ff444444"), borderRadius: 4, color: d === "Easy" ? "#4a9eff" : d === "Medium" ? "#c8ff00" : d === "Difficult" ? "#ff8c00" : "#ff4444", fontSize: 10, padding: "5px 4px", outline: "none", fontFamily: "'DM Mono',monospace", cursor: "pointer", width: "100%" }),
  notesBtn: { background: "#111113", border: "1px solid #2a2a2e", borderRadius: 4, color: "#555", fontSize: 10, padding: "5px 6px", cursor: "pointer", fontFamily: "'DM Mono',monospace", overflow: "hidden", textOverflow: "ellipsis", width: "100%" },
  notesBtnFilled: { background: "#111a00", border: "1px solid #c8ff0044", borderRadius: 4, color: "#c8ff00", fontSize: 10, padding: "5px 6px", cursor: "pointer", fontFamily: "'DM Mono',monospace", overflow: "hidden", textOverflow: "ellipsis", width: "100%" },
  notesModalBox: { background: "#111113", border: "1px solid #2a2a2e", borderRadius: 12, padding: "28px 24px", maxWidth: 480, width: "100%" },
  notesTextarea: { width: "100%", minHeight: 160, background: "#0c0c0e", border: "1px solid #333", borderRadius: 6, color: "#e8e4dc", fontSize: 14, padding: "12px", outline: "none", fontFamily: "'DM Mono',monospace", resize: "vertical", boxSizing: "border-box", lineHeight: 1.6, marginBottom: 16 },
  addBenchmarkRow: { display: "flex", alignItems: "center", gap: 12, marginTop: 16, padding: "14px 16px", background: "#111113", border: "1px dashed #333", borderRadius: 8 },
  addBenchmarkLabel: { fontSize: 9, letterSpacing: "0.2em", color: "#555", fontWeight: 700, flexShrink: 0 },
  benchmarkSelect: { flex: 1, background: "#0c0c0e", border: "1px solid #2a2a2e", borderRadius: 4, color: "#e8e4dc", fontSize: 12, padding: "7px 10px", outline: "none", fontFamily: "'DM Mono',monospace", cursor: "pointer" },
};
