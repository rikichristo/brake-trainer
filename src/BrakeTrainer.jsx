import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";

/* ============================================================
   BRAKE TRAINER
   Reference-trace following for sim racing pedal boxes.
   Reads a real wheel/pedal set over the Gamepad API, scrolls a
   reference lap past a playhead, records the driver's inputs and
   scores the match per channel with per-corner fault detection.
   ============================================================ */

const HZ = 50;                 // reference + capture sample rate
const LOOKBACK = 2.2;          // seconds of trace visible behind the playhead
const LOOKAHEAD = 5.0;         // seconds of trace visible ahead of it
const LEADIN = 4.0;            // roll-in before the lap starts
const PLAYHEAD = LOOKBACK / (LOOKBACK + LOOKAHEAD);

/* Black and white, with colour reserved for information.
   `ui` is the accent for anything you press or that is selected — white, so
   the interface reads as one thing. `good` / `warn` / `bad` stay for the
   traces and the fault colouring, where green against red is the whole point
   of looking at the screen. Greys are neutral rather than green-tinted, so
   white actually looks white next to them. */
const C = {
  bg: "#000000",
  panel: "#0a0a0a",
  panel2: "#141414",
  line: "#262626",
  ref: "#ffffff",
  ui: "#ffffff",
  good: "#7ee0a3",
  warn: "#e3b45a",
  bad: "#ff6b5e",
  text: "#ffffff",
  dim: "#8f8f8f",
  dimmer: "#575757",
};

/* ------------------------------------------------------------
   Persistence. Calibration, feel and the run log have to survive a
   reload, so localStorage is the real store and memory is only a
   fallback for when it throws — a private window, or blocked site
   data. Every read and write is wrapped, because either can fail.
   ------------------------------------------------------------ */
const mem = new Map();
const store = {
  get(k) {
    if (mem.has(k)) return mem.get(k);
    try {
      const s = localStorage.getItem(k);
      if (s != null) { const v = JSON.parse(s); mem.set(k, v); return v; }
    } catch { /* unavailable */ }
    return null;
  },
  set(k, v) {
    mem.set(k, v);
    try { localStorage.setItem(k, JSON.stringify(v)); return true; }
    catch { return false; }   // quota exceeded, or storage blocked
  },
  remove(k) {
    mem.delete(k);
    try { localStorage.removeItem(k); } catch { /* unavailable */ }
  },
};

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const idx = (t) => Math.round(t * HZ);

/* ------------------------------------------------------------
   THE ACCOUNT SIDE
   VCASO Performance drivers, in Riki's own Supabase project. Everything
   here is optional by design: if the CDN script never loaded, or the rig
   is off the internet, `cloud.ready()` is false and the app falls back
   to the local profiles it has always had. A sim rig in a garage with no
   connection must still be able to run a drill.
   ------------------------------------------------------------ */
/* Where the real thing lives. A copy of this page opened from anywhere else
   — a claude.ai artifact preview, a file on the desktop — is sandboxed or has
   the wrong origin, so it cannot reach the server at all. That is not a fault
   to report as an error; it is a fact to say plainly, with the right link. */
const LIVE_URL = "https://rikichristo.github.io/brake-trainer/";
const LIVE_HOST = "rikichristo.github.io";

function previewOnly() {
  if (typeof location === "undefined") return false;
  const h = location.hostname;
  if (!h) return true;                                  // opened as a file
  if (h === LIVE_HOST) return false;
  if (h === "localhost" || h === "127.0.0.1") return false;
  return true;
}

/* A browser reports a blocked or dropped request as a bare TypeError —
   "Load failed" in Safari, "Failed to fetch" in Chrome. Shown raw that reads
   like a bug in the app, and tells the driver nothing they can act on. */
const netMessage = (e) => {
  const m = String((e && e.message) || e || "");
  if (/load failed|failed to fetch|networkerror|network ?request ?failed|ERR_/i.test(m)) {
    return previewOnly()
      ? `This is a preview copy and it cannot reach the server. Open ${LIVE_URL} and sign in there.`
      : "Could not reach the server. Check your connection and try again.";
  }
  return m;
};

const SUPA_URL = "https://bqvygaqvwmakbrxnllws.supabase.co";
const SUPA_KEY = "sb_publishable_M8zD44AbCWO1rjBdWVbGJA_lfRLKvwz";
const DRIVER_DOMAIN = "drivers.rikichristo.com";
/* Riki's own login predates the drivers domain, so it is spelled out
   rather than guessed. */
const HANDLE_ALIAS = { riki: "riki@rikichristo.com" };

const emailFor = (raw) => {
  const h = String(raw || "").trim().toLowerCase();
  if (HANDLE_ALIAS[h]) return HANDLE_ALIAS[h];
  return h.includes("@") ? h : `${h}@${DRIVER_DOMAIN}`;
};
const handleFrom = (email) => String(email || "").split("@")[0];

let _sb = null;
function client() {
  if (_sb) return _sb;
  const lib = typeof window !== "undefined" ? window.supabase : null;
  if (!lib || !lib.createClient) return null;
  try {
    _sb = lib.createClient(SUPA_URL, SUPA_KEY, {
      auth: { persistSession: true, autoRefreshToken: true },
    });
  } catch { return null; }
  return _sb;
}

const cloud = {
  ready() { return !!client(); },

  async session() {
    const sb = client(); if (!sb) return null;
    try { const { data } = await sb.auth.getSession(); return data?.session ?? null; }
    catch { return null; }
  },

  async signIn(handle, password) {
    const sb = client(); if (!sb) throw new Error("offline");
    const { data, error } = await sb.auth.signInWithPassword({
      email: emailFor(handle), password,
    });
    if (error) throw error;
    return data.session;
  },

  async signOut() { const sb = client(); if (sb) { try { await sb.auth.signOut(); } catch { /* already gone */ } } },

  /* The profile says whether this driver has been let in yet, and whether
     they want to appear on the board. */
  async profile() {
    const sb = client(); if (!sb) return null;
    const { data: u } = await sb.auth.getUser();
    if (!u?.user) return null;
    const { data, error } = await sb.from("bt_profiles")
      .select("id,handle,full_name,role,approved,on_leaderboard")
      .eq("id", u.user.id).maybeSingle();
    if (error) throw error;
    if (data) return data;
    /* Signed in with a hub login that has never opened the trainer. Make
       the row, unapproved, so Riki sees them in the queue. */
    const handle = handleFrom(u.user.email);
    const ins = {
      id: u.user.id, handle,
      full_name: u.user.user_metadata?.full_name || handle,
      role: "driver", approved: false,
    };
    const { data: made } = await sb.from("bt_profiles").insert(ins).select().maybeSingle();
    return made ?? { ...ins, on_leaderboard: true };
  },

  async setOnLeaderboard(on) {
    const sb = client(); if (!sb) return;
    const { data: u } = await sb.auth.getUser();
    if (!u?.user) return;
    const { error } = await sb.from("bt_profiles")
      .update({ on_leaderboard: !!on }).eq("id", u.user.id);
    if (error) throw error;
  },

  async changePassword(password) {
    const sb = client(); if (!sb) throw new Error("offline");
    const { error } = await sb.auth.updateUser({ password });
    if (error) throw error;
  },

  /* Anyone may ask, signed out. The table only accepts a pending row. */
  async requestAccess({ fullName, contact, wantedHandle, note }) {
    const sb = client(); if (!sb) throw new Error("offline");
    const { error } = await sb.from("bt_access_requests").insert({
      full_name: fullName, contact, wanted_handle: wantedHandle, note,
    });
    if (error) {
      if (/duplicate|unique/i.test(error.message)) {
        throw new Error("You have already asked — Riki has it. He will message you.");
      }
      throw error;
    }
  },

  async pendingRequests() {
    const sb = client(); if (!sb) return [];
    const { data, error } = await sb.from("bt_access_requests")
      .select("id,full_name,contact,wanted_handle,note,created_at")
      .eq("status", "pending").order("created_at", { ascending: true });
    if (error) throw error;
    return data ?? [];
  },

  async callAccess(body) {
    const sb = client(); if (!sb) throw new Error("offline");
    const { data: s } = await sb.auth.getSession();
    const token = s?.session?.access_token;
    if (!token) throw new Error("Sign in again.");
    const res = await fetch(`${SUPA_URL}/functions/v1/bt-access`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: SUPA_KEY,
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(out.error || `Failed (${res.status}).`);
    return out;
  },

  approve: (requestId, handle, fullName) =>
    cloud.callAccess({ action: "approve", requestId, handle, fullName }),
  decline: (requestId) => cloud.callAccess({ action: "decline", requestId }),
  newPassword: (userId) => cloud.callAccess({ action: "reset", userId }),

  async drivers() {
    const sb = client(); if (!sb) return [];
    const { data, error } = await sb.from("bt_profiles")
      .select("id,handle,full_name,role,approved,on_leaderboard")
      .order("handle");
    if (error) throw error;
    return data ?? [];
  },

  async setApproved(id, approved) {
    const sb = client(); if (!sb) return;
    const { error } = await sb.from("bt_profiles").update({ approved }).eq("id", id);
    if (error) throw error;
  },

  /* Calibration, feel and preferences, so a driver's rig settings and
     personal bests follow them to whatever machine they sit at. */
  async pullSettings() {
    const sb = client(); if (!sb) return null;
    const { data: u } = await sb.auth.getUser();
    if (!u?.user) return null;
    const { data, error } = await sb.from("bt_settings")
      .select("data").eq("user_id", u.user.id).maybeSingle();
    if (error) throw error;
    return data?.data ?? null;
  },

  async pushSettings(payload) {
    const sb = client(); if (!sb) return false;
    const { data: u } = await sb.auth.getUser();
    if (!u?.user) return false;
    const { error } = await sb.from("bt_settings")
      .upsert({ user_id: u.user.id, data: payload }, { onConflict: "user_id" });
    return !error;
  },

  async logRun({ lap, drill, result, record, mode }) {
    const sb = client(); if (!sb) return false;
    const { data: u } = await sb.auth.getUser();
    if (!u?.user) return false;
    const m = lap.meta ?? {};
    const { error } = await sb.from("bt_runs").insert({
      user_id: u.user.id,
      lap_id: `${lap.id ?? ""}:${drill.id}`,
      lap_label: `${m.car ?? ""} · ${m.track ?? ""} · ${drill.name}`,
      category: m.category ?? "", car: m.car ?? "", track: m.track ?? "",
      mode,
      overall: result.overall,
      brake: Math.round(result.channels.brake.score),
      throttle: mode === "brake" ? null : Math.round(result.channels.throttle.score),
      steer: mode === "brake" ? null : Math.round(result.channels.steer.score),
      seconds: Math.round((lap.dur ?? 0) * 100) / 100,
      clip_seconds: Math.round((result.clipSeconds ?? 0) * 100) / 100,
      faults: result.notes.map((n) => ({ title: n.title, zone: n.zone })),
      trace: JSON.stringify(record),
    });
    return !error;
  },

  async myRuns(limit = 200) {
    const sb = client(); if (!sb) return [];
    const { data: u } = await sb.auth.getUser();
    if (!u?.user) return [];
    const { data, error } = await sb.from("bt_runs")
      .select("id,user_id,lap_id,lap_label,mode,overall,brake,throttle,steer,seconds,created_at")
      .order("created_at", { ascending: false }).limit(limit);
    if (error) throw error;
    return data ?? [];
  },

  async runBody(id) {
    const sb = client(); if (!sb) return null;
    const { data, error } = await sb.from("bt_runs").select("trace").eq("id", id).maybeSingle();
    if (error) throw error;
    try { return data?.trace ? JSON.parse(data.trace) : null; } catch { return null; }
  },

  async board(lapId = null) {
    const sb = client(); if (!sb) return [];
    const { data, error } = await sb.rpc("bt_leaderboard", { p_lap: lapId });
    if (error) throw error;
    return data ?? [];
  },

  async boardOverall() {
    const sb = client(); if (!sb) return [];
    const { data, error } = await sb.rpc("bt_leaderboard_overall");
    if (error) throw error;
    return data ?? [];
  },
};

/* ------------------------------------------------------------
   REFERENCE LAPS
   Real telemetry, logged on this rig and exported from iRacing.
   Channels arrive as base64 bytes: 0.4% of full scale, finer than
   anyone holds a pedal, and a tenth the size of JSON numbers.
   LAP_DATA is injected at build time by pack.py.
   ------------------------------------------------------------ */
const LAP_DATA = __LAP_DATA__;

function decodeU8(b64, lo, hi) {
  const bin = atob(b64);
  const n = bin.length;
  const out = new Float32Array(n);
  const step = (hi - lo) / 255;
  for (let i = 0; i < n; i++) out[i] = lo + bin.charCodeAt(i) * step;
  return out;
}

const CATEGORIES = {
  f4: { key: "f4", name: "Formula 4", note: "Lower peak pressures and longer zones. Patient throttle pickup out of the slow corners." },
  f3: { key: "f3", name: "Formula 3", note: "More downforce, so Copse and Becketts go flat. Later, harder, shorter braking everywhere else." },
  f2: { key: "f2", name: "Formula 2", note: "No laps logged yet. Record a session in an F2-class car and it will appear here." },
  gt: { key: "gt", name: "GT", note: "No laps logged yet. Import a GT session and it will appear here. Expect a different shape to the formula cars: heavier car, longer zones, and a flatter peak you can lean on for longer." },
};
const CATEGORY_ORDER = ["f4", "f3", "f2", "gt"];

/* Decode once; the arrays are read every frame during a session. */
const LAPS = LAP_DATA.map((rec) => {
  const lap = {
    id: rec.id,
    meta: rec,
    n: rec.n,
    dur: rec.n / rec.hz,
    brake: decodeU8(rec.brake, 0, 1),
    throttle: decodeU8(rec.throttle, 0, 1),
    steer: decodeU8(rec.steer, -1, 1),
    speed: decodeU8(rec.speed, 0, 320),
    dist: decodeU8(rec.dist, 0, 1),
    zones: rec.zones,
    markers: rec.zones.map((z) => ({ n: z.n, name: z.name, t: z.t })),
  };
  return lap;
});

/* Corner names the driver has corrected, kept per reference lap. The packed
   data carries my best reading of where the braking zones fall; where that
   is a guess the zones ship numbered, and whoever knows the circuit names
   them once here. */
const zoneNamesKey = (lapId) => `bt:zonenames:${lapId}`;
const loadZoneNames = (lapId) => store.get(zoneNamesKey(lapId)) ?? {};

function applyZoneNames(lap) {
  const custom = loadZoneNames(lap.id);
  if (!Object.keys(custom).length) return lap;
  lap.zones = lap.zones.map((z, i) => (custom[i] ? { ...z, name: custom[i] } : z));
  lap.markers = lap.zones.map((z) => ({ n: z.n, name: z.name, t: z.t }));
  return lap;
}

function setZoneName(lapId, i, name) {
  const custom = loadZoneNames(lapId);
  const clean = String(name).trim().slice(0, 28);
  if (clean) custom[i] = clean; else delete custom[i];
  store.set(zoneNamesKey(lapId), custom);
}


/* ------------------------------------------------------------
   Imported laps, kept
   An imported reference is as much a part of the trainer as the ones
   compiled in, so it survives a reload. Channels are packed to bytes,
   the same way the built-in laps are, which keeps a lap near 30 KB
   rather than the few hundred its raw numbers would take.
   ------------------------------------------------------------ */
/* VCASO Performance, inlined so the mark travels with the page: the
   standalone file and the artifact have no sibling image to fetch. */
const VCASO_LOGO = "data:image/png;base64,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";

const SAVED_LAPS_KEY = "bt:laps";

const loadSavedLapRecords = () => {
  const v = store.get(SAVED_LAPS_KEY);
  return Array.isArray(v) ? v : [];
};

function packLap(lap) {
  const m = lap.meta ?? {};
  return {
    id: lap.id, category: m.category ?? "other",
    car: m.car ?? "Imported", track: m.track ?? lap.id, config: m.config ?? "",
    driver: m.driver ?? "", lapTime: m.lapTime ?? lap.dur, lap: m.lap ?? null,
    trackM: m.trackM ?? null, hz: HZ, n: lap.n, imported: true,
    note: m.note ?? "", source: m.source ?? "",
    brake: encodeU8(lap.brake, 0, 1),
    throttle: encodeU8(lap.throttle, 0, 1),
    steer: encodeU8(lap.steer, -1, 1),
    speed: encodeU8(lap.speed ?? new Float32Array(lap.n), 0, 320),
    dist: encodeU8(lap.dist ?? new Float32Array(lap.n), 0, 1),
    zones: lap.zones ?? [],
  };
}

function unpackLap(rec) {
  return {
    id: rec.id,
    meta: { ...rec, imported: true },
    n: rec.n, dur: rec.n / HZ,
    brake: decodeU8(rec.brake, 0, 1),
    throttle: decodeU8(rec.throttle, 0, 1),
    steer: decodeU8(rec.steer, -1, 1),
    speed: decodeU8(rec.speed, 0, 320),
    dist: decodeU8(rec.dist, 0, 1),
    zones: rec.zones ?? [],
    markers: (rec.zones ?? []).map((z) => ({ n: z.n, name: z.name, t: z.t })),
  };
}

/* Returns false when the browser refused the write, so the caller can say
   so rather than letting the lap quietly vanish on the next reload. */
function saveLapRecord(rec) {
  const kept = loadSavedLapRecords().filter((r) => r.id !== rec.id);
  kept.push(rec);
  return store.set(SAVED_LAPS_KEY, kept);
}

function deleteSavedLap(id) {
  store.set(SAVED_LAPS_KEY, loadSavedLapRecords().filter((r) => r.id !== id));
  store.remove(`bt:zonenames:${id}`);
}

const lapsIn = (cat) => LAPS.filter((l) => l.meta.category === cat);
const lapById = (id) => LAPS.find((l) => l.id === id) ?? LAPS[0];

const lapLabel = (l) => `${l.meta.track}`;
const lapSub = (l) => `${l.meta.car} · ${fmtLapTime(l.meta.lapTime)}`;

function fmtLapTime(s) {
  const m = Math.floor(s / 60);
  const r = s - m * 60;
  return m > 0 ? `${m}:${r.toFixed(3).padStart(6, "0")}` : `${r.toFixed(3)}s`;
}

/* ------------------------------------------------------------
   DRILLS
   A drill is a view of a lap. "Full lap" plays it end to end.
   "Corners only" drops the straights, which are dead air to
   follow, and leaves a gap between each corner instead.
   ------------------------------------------------------------ */
const LEAD_IN = 2.5;   // seconds of approach shown before the brake point
const RUN_OUT = 1.5;   // seconds held after the throttle is back
const GAP = 3.0;       // quiet seconds between corners

/* Where a corner is finished: throttle back up and staying up. */
function cornerEnd(lap, fromIdx) {
  const limit = Math.min(lap.n - 1, fromIdx + idx(6));
  const hold = idx(0.3);
  for (let i = fromIdx; i <= limit; i++) {
    let ok = true;
    for (let k = 0; k < hold && i + k <= limit; k++) {
      if (lap.throttle[i + k] < 0.9) { ok = false; break; }
    }
    if (ok) return i;
  }
  return limit;
}

function cornerSpan(lap, z) {
  const brakeStart = idx(z.t);
  const brakeEnd = idx(z.t + z.dur);
  const a = Math.max(0, brakeStart - idx(LEAD_IN));
  const b = Math.min(lap.n - 1, cornerEnd(lap, brakeEnd) + idx(RUN_OUT));
  return [a, b];
}

/* Concatenate the corners of a lap, separated by a neutral gap.
   `scored` marks the real content so the gaps never count toward a
   score, and `markers` are rebuilt against the stitched timeline. */
function stitchCorners(lap, zones) {
  // Corners that run into one another — Village into The Loop, Brooklands
  // into Luffield — are one continuous piece of driving. Their spans
  // overlap, so cutting a gap between them would repeat the overlap and
  // break up a sequence the driver takes as a single complex.
  const groups = [];
  for (const z of zones) {
    const span = cornerSpan(lap, z);
    const last = groups[groups.length - 1];
    if (last && span[0] - last.span[1] < idx(1.0)) {
      last.span[1] = Math.max(last.span[1], span[1]);
      last.zones.push(z);
    } else {
      groups.push({ span, zones: [z] });
    }
  }

  const spans = groups.map((g) => g.span);
  const gapN = idx(GAP);
  let total = 0;
  for (const [a, b] of spans) total += b - a + 1;
  total += gapN * Math.max(0, spans.length - 1);

  const out = {
    id: `${lap.id}:corners`,
    meta: lap.meta,
    n: total,
    dur: total / HZ,
    brake: new Float32Array(total),
    throttle: new Float32Array(total),
    steer: new Float32Array(total),
    speed: new Float32Array(total),
    dist: new Float32Array(total),
    scored: new Uint8Array(total),
    zones: [],
    markers: [],
  };

  let w = 0;
  groups.forEach(({ span: [a, b], zones: zs }, k) => {
    for (const z of zs) {
      const t = (w + (idx(z.t) - a)) / HZ;
      out.markers.push({ n: z.n, name: z.name, t });
      out.zones.push({ ...z, t });
    }
    for (let i = a; i <= b; i++, w++) {
      out.brake[w] = lap.brake[i];
      out.throttle[w] = lap.throttle[i];
      out.steer[w] = lap.steer[i];
      out.speed[w] = lap.speed[i];
      out.dist[w] = lap.dist[i];
      out.scored[w] = 1;
    }
    if (k < groups.length - 1) {
      // Neutral gap: off the brakes, flat in a straight line, nothing scored.
      for (let g = 0; g < gapN; g++, w++) {
        out.throttle[w] = 1;
        out.speed[w] = lap.speed[b];
        out.dist[w] = lap.dist[b];
      }
    }
  });
  return out;
}

function sliceLap(lap, a, b, id) {
  const n = b - a + 1;
  const sub = {
    id, meta: lap.meta, n, dur: n / HZ,
    brake: lap.brake.slice(a, b + 1),
    throttle: lap.throttle.slice(a, b + 1),
    steer: lap.steer.slice(a, b + 1),
    speed: lap.speed.slice(a, b + 1),
    dist: lap.dist.slice(a, b + 1),
    markers: lap.markers.filter((m) => idx(m.t) >= a && idx(m.t) <= b)
      .map((m) => ({ ...m, t: m.t - a / HZ })),
  };
  if (lap.scored) sub.scored = lap.scored.slice(a, b + 1);
  sub.zones = (lap.zones ?? []).filter((z) => idx(z.t) >= a && idx(z.t) <= b)
    .map((z) => ({ ...z, t: z.t - a / HZ }));
  return sub;
}

function makeDrills(lap) {
  const out = [
    { id: "corners", name: "Corners only", sub: `${lap.zones.length} braking zones, no straights` },
    { id: "full", name: "Full lap", sub: fmtLapTime(lap.meta.lapTime) },
  ];
  for (const z of lap.zones) {
    const [a, b] = cornerSpan(lap, z);
    out.push({
      id: `z${z.n ?? z.at}`,
      name: z.name,
      sub: `${Math.round(z.peak * 100)}% peak · ${z.speedIn}→${z.speedMin} km/h`,
      a, b,
    });
  }
  return out;
}

function buildDrill(lap, drill) {
  if (drill.id === "full") return lap;
  if (drill.id === "corners") return stitchCorners(lap, lap.zones);
  return sliceLap(lap, drill.a, drill.b, `${lap.id}:${drill.id}`);
}

/* ------------------------------------------------------------
   ANALYSIS
   ------------------------------------------------------------ */
/* Braking zones, as a driver would count them. Trail-braking into a complex
   dips below the threshold repeatedly, so plain thresholding splits one
   corner into several fragments; spans closer than `join` are merged, and
   what survives has to be long enough and hard enough to be a braking point
   rather than a dab. Matches the thresholds the telemetry importer uses. */
function findZones(ref, { thr = 0.05, minLen = 0.4, join = 1.0, minPeak = 0.12 } = {}) {
  const spans = []; let start = -1;
  for (let i = 0; i < ref.length; i++) {
    if (ref[i] > thr && start < 0) start = i;
    else if (ref[i] <= thr && start >= 0) { spans.push([start, i]); start = -1; }
  }
  if (start >= 0) spans.push([start, ref.length - 1]);

  const merged = [];
  for (const sp of spans) {
    const last = merged[merged.length - 1];
    if (last && (sp[0] - last[1]) / HZ < join) last[1] = sp[1];
    else merged.push([sp[0], sp[1]]);
  }

  return merged.filter(([a, b]) => {
    if ((b - a) / HZ < minLen) return false;
    let pk = 0;
    for (let i = a; i <= b; i++) if (ref[i] > pk) pk = ref[i];
    return pk >= minPeak;
  });
}

/* Only score where something is actually happening. A full lap is 85%
   zero brake; without a mask everyone scores 95 for doing nothing. */
function buildMask(lap, channel) {
  const n = lap.n;
  const m = new Uint8Array(n);
  const zones = findZones(lap.brake);
  const dilate = (a, b, pad) => {
    for (let i = Math.max(0, a - pad); i < Math.min(n, b + pad); i++) m[i] = 1;
  };
  if (channel === "brake") for (const [a, b] of zones) dilate(a, b, idx(1.0));
  else if (channel === "throttle") for (const [a, b] of zones) dilate(a, b, idx(2.2));
  else {
    let s = -1;
    for (let i = 0; i < n; i++) {
      const on = Math.abs(lap.steer[i]) > 0.04;
      if (on && s < 0) s = i;
      else if (!on && s >= 0) { dilate(s, i, idx(0.5)); s = -1; }
    }
    if (s >= 0) dilate(s, n - 1, idx(0.5));
  }
  let count = 0; for (let i = 0; i < n; i++) count += m[i];
  if (count < n * 0.05) m.fill(1);
  // A stitched corners-only drill carries quiet gaps between corners.
  // Nothing happens there, so nothing there should count either way.
  if (lap.scored) for (let i = 0; i < n; i++) if (!lap.scored[i]) m[i] = 0;
  return m;
}

function maskedMAE(ref, drv, mask, lag = 0) {
  let s = 0, c = 0;
  for (let i = 0; i < ref.length; i++) {
    if (!mask[i]) continue;
    const j = i + lag;
    if (j < 0 || j >= drv.length) continue;
    s += Math.abs(ref[i] - drv[j]); c++;
  }
  return c ? s / c : 0;
}

/* Positive lag = driver is late. */
function bestLag(ref, drv, mask, maxMs = 400) {
  const L = Math.round((maxMs / 1000) * HZ);
  let best = { lag: 0, mae: Infinity };
  for (let l = -L; l <= L; l++) {
    const e = maskedMAE(ref, drv, mask, l);
    if (e < best.mae) best = { lag: l, mae: e };
  }
  return best;
}

const WEIGHT = { brake: 0.45, throttle: 0.30, steer: 0.25 };

/* The laziest possible input on each channel: never brake, never steer,
   sit flat on the throttle. Scoring against this baseline rather than a
   fixed constant means 100 is a perfect match and 0 is "no better than
   not trying", on every track and every drill length. */
const NULL_INPUT = { brake: 0, throttle: 1, steer: 0 };

function maskedMAEConst(ref, k, mask) {
  let s = 0, c = 0;
  for (let i = 0; i < ref.length; i++) if (mask[i]) { s += Math.abs(ref[i] - k); c++; }
  return c ? s / c : 0;
}
function baselineFor(lap, ch, mask) {
  return Math.max(0.04, maskedMAEConst(lap[ch], NULL_INPUT[ch], mask));
}
const toScore = (mae, base) => clamp(100 * (1 - mae / base), 0, 100);

/* Did the driver do anything at all on this channel? Guards the lag search
   from returning a meaningless boundary value on an empty trace. */
function activity(drv, ch, mask) {
  let s = 0, c = 0;
  for (let i = 0; i < drv.length; i++) if (mask[i]) { s += Math.abs(drv[i] - NULL_INPUT[ch]); c++; }
  return c ? s / c : 0;
}

function analyse(lap, cap, opts = {}) {
  const channels = {};
  for (const ch of ["brake", "throttle", "steer"]) {
    const mask = buildMask(lap, ch);
    const base = baselineFor(lap, ch, mask);
    const raw = maskedMAE(lap[ch], cap[ch], mask, 0);
    const live = activity(cap[ch], ch, mask) > 0.02;
    const bl = live ? bestLag(lap[ch], cap[ch], mask) : { lag: 0, mae: raw };
    channels[ch] = {
      score: toScore(raw, base),
      shapeScore: toScore(bl.mae, base),
      mae: raw,
      lagMs: (bl.lag / HZ) * 1000,
      idle: !live,
    };
  }
  /* Weighted geometric mean rather than a plain average. Averaging lets a
     driver who never touches the brake still score 55, by being flawless
     on the two channels that take no effort on a brake drill. Blending
     geometrically makes the channels multiply, so a missing one drags the
     whole score down; the floor of 1 keeps it finite. For a run that is
     merely uneven rather than absent, the two agree within a point.

     Brake-only drills weight the brake alone. The other two still get
     measured, so the numbers are there in the log, but a driver whose hands
     are off the wheel on purpose must not be marked down for it. */
  const weights = opts.brakeOnly ? { brake: 1 } : WEIGHT;
  const overall = Math.exp(
    Object.keys(weights).reduce(
      (s, k) => s + weights[k] * Math.log(Math.max(1, channels[k].score)), 0)
  );

  const zones = analyseZones(lap, cap);
  return { overall: Math.round(overall), channels, zones,
           brakeOnly: !!opts.brakeOnly,
           clipSeconds: opts.clipSeconds ?? 0,
           notes: makeNotes(channels, zones, opts) };
}

/* A crossing only counts if it holds for `sustain` samples. Without this,
   a single noisy sample from a load cell reads as a brake application and
   throws the whole timing measurement out by most of a second. */
function firstCross(arr, from, to, level, sustain = 4) {
  const end = Math.min(arr.length - 1, to);
  for (let i = Math.max(0, from); i <= end; i++) {
    if (arr[i] < level) continue;
    let held = true;
    for (let k = 1; k < sustain; k++) {
      if (i + k > end || arr[i + k] < level) { held = false; break; }
    }
    if (held) return i;
  }
  return -1;
}
function peakIn(arr, from, to) {
  let p = -Infinity, at = from;
  for (let i = Math.max(0, from); i <= Math.min(arr.length - 1, to); i++) if (arr[i] > p) { p = arr[i]; at = i; }
  return { peak: p, at };
}

/* Counts genuine changes of direction, not encoder jitter. Smooths over
   100 ms first, then only accepts a reversal once the trace has retraced
   past a hysteresis band from its last extreme. A clean corner returns 1:
   one turn in, one unwind. Anything above 3 is the driver sawing at it. */
function countReversals(arr, from, to, hyst = 0.05) {
  if (to - from < 6) return 0;
  const sm = [];
  for (let i = from; i <= to; i++) {
    let s = 0, c = 0;
    for (let k = -2; k <= 2; k++) {
      const j = i + k;
      if (j >= from && j <= to) { s += arr[j]; c++; }
    }
    sm.push(s / c);
  }
  let dir = 0, ext = sm[0], n = 0;
  for (const v of sm) {
    if ((dir >= 0 && v > ext) || (dir <= 0 && v < ext)) ext = v;
    if (dir >= 0 && v < ext - hyst) { if (dir > 0) n++; dir = -1; ext = v; }
    else if (dir <= 0 && v > ext + hyst) { if (dir < 0) n++; dir = 1; ext = v; }
  }
  return n;
}

function analyseZones(lap, cap) {
  const pad = idx(1.0);
  return findZones(lap.brake).map(([a, b], k) => {
    const marker = lap.markers.reduce((best, m) => {
      const d = Math.abs(idx(m.t) - a);
      return !best || d < best.d ? { ...m, d } : best;
    }, null);
    const name = marker && marker.d < idx(1.5) ? `T${marker.n} ${marker.name}` : `Zone ${k + 1}`;

    const refP = peakIn(lap.brake, a, b);
    const drvP = peakIn(cap.brake, a - pad, b + pad);
    // A light zone like Copse peaks around 20%, so a flat 5% trigger would
    // call a reasonable attempt "no braking". Scale the threshold to the zone.
    const trig = Math.max(0.05, refP.peak * 0.2);
    const refOn = firstCross(lap.brake, a - 2, b, trig, 2);
    // Search a tighter window than the scoring pad: an application a full
    // second either side belongs to a neighbouring corner, not this one.
    const drvOn = firstCross(cap.brake, a - idx(0.7), b + idx(0.4), trig);
    const bpDelta = drvOn < 0 ? null : (drvOn - refOn) / HZ;
    const silent = drvP.peak < 0.02;

    // how fast pressure is built: time from application to 80% of own peak
    const rate = (arr, on, peak) => {
      if (on < 0 || peak <= 0.05) return null;
      const hit = firstCross(arr, on, on + idx(1.5), peak * 0.8);
      return hit < 0 ? null : (hit - on) / HZ;
    };
    const refRate = rate(lap.brake, refOn, refP.peak);
    const drvRate = rate(cap.brake, drvOn, drvP.peak);

    // trail release: where does pressure fall below 15% of peak
    const relEnd = (arr, at, peak) => {
      for (let i = at; i < Math.min(arr.length, b + pad); i++) if (arr[i] < peak * 0.15) return i;
      return b;
    };
    const refRel = (relEnd(lap.brake, refP.at, refP.peak) - refP.at) / HZ;
    const drvRel = drvP.peak > 0.05 ? (relEnd(cap.brake, drvP.at, drvP.peak) - drvP.at) / HZ : 0;

    // throttle pickup after the zone
    const refThr = firstCross(lap.throttle, b, b + idx(3), 0.5);
    const drvThr = firstCross(cap.throttle, b, b + idx(3), 0.5);
    const thrDelta = refThr < 0 || drvThr < 0 ? null : (drvThr - refThr) / HZ;

    // steering peak + mid-corner corrections
    const sSign = lap.steer[Math.min(lap.n - 1, refP.at + idx(0.6))] >= 0 ? 1 : -1;
    const sAbs = (arr, f, t) => peakIn(Array.from({ length: t - f + 1 }, (_, i) => arr[f + i] * sSign), 0, t - f).peak;
    const refS = sAbs(lap.steer, a, Math.min(lap.n - 1, b + idx(1.5)));
    const drvS = sAbs(cap.steer, a, Math.min(lap.n - 1, b + idx(1.5)));
    const corrections = countReversals(cap.steer, a, Math.min(lap.n - 1, b + idx(1.5)));

    const mask = new Uint8Array(lap.n);
    for (let i = Math.max(0, a - pad); i < Math.min(lap.n, b + pad); i++) mask[i] = 1;

    return {
      name, a, b, t: a / HZ, silent,
      refPeak: refP.peak, drvPeak: Math.max(0, drvP.peak),
      bpDelta, refRate, drvRate, refRel, drvRel, thrDelta,
      refSteer: refS, drvSteer: drvS, corrections,
      score: Math.round(toScore(maskedMAE(lap.brake, cap.brake, mask, 0), baselineFor(lap, "brake", mask))),
    };
  });
}

function makeNotes(channels, zones, opts = {}) {
  const notes = [];
  const push = (sev, zone, title, detail) => notes.push({ sev, zone, title, detail });

  for (const z of zones) {
    if (z.silent) {
      push(2, z.name, "You missed this braking zone",
        `Nothing came through on the brake channel against a target peak of ${Math.round(z.refPeak * 100)}%. If you did press the pedal, the mapping has come loose — recalibrate from the garage.`);
      continue; // every other measurement here would be noise
    }
    if (z.bpDelta === null) {
      push(1.6, z.name, "Far too light to register",
        `Your peak was ${Math.round(z.drvPeak * 100)}% against a target of ${Math.round(z.refPeak * 100)}%. Treat this as a proper brake application, not a lift.`);
      continue;
    }

    const pd = z.drvPeak - z.refPeak;
    if (pd < -0.08) push(Math.abs(pd), z.name, "Not enough peak pressure",
      `You reached ${Math.round(z.drvPeak * 100)}% against a target of ${Math.round(z.refPeak * 100)}%. The first third of the zone is where the lap time is — hit it harder, then release earlier to compensate.`);
    else if (pd > 0.12) push(pd * 0.8, z.name, "Overshooting the peak",
      `${Math.round(z.drvPeak * 100)}% against ${Math.round(z.refPeak * 100)}%. Over-pressure here is what triggers lock-ups and kills rotation on entry.`);

    if (z.bpDelta > 0.12) push(z.bpDelta * 1.6, z.name, "Late on the pedal",
      `Application ${(z.bpDelta * 1000).toFixed(0)} ms after the reference. You are chasing the shape rather than leading it — start the movement as the trace reaches the playhead, not after.`);
    else if (z.bpDelta < -0.15) push(Math.abs(z.bpDelta) * 1.2, z.name, "Early on the pedal",
      `Application ${Math.abs(z.bpDelta * 1000).toFixed(0)} ms before the reference.`);

    if (z.refRate && z.drvRate && z.drvRate > z.refRate * 1.8 && z.drvRate - z.refRate > 0.12)
      push((z.drvRate - z.refRate) * 2, z.name, "Initial hit too soft",
        `You take ${z.drvRate.toFixed(2)} s to build pressure against ${z.refRate.toFixed(2)} s. The reference is close to a step input, not a squeeze.`);

    if (z.refRel > 0.25 && z.drvRel < z.refRel * 0.6)
      push((z.refRel - z.drvRel) * 1.5, z.name, "Releasing too fast",
        `Your trail phase lasts ${z.drvRel.toFixed(2)} s against ${z.refRel.toFixed(2)} s. Bleed the pressure off to the apex instead of dropping it.`);

    /* On a brake-only drill the throttle and the wheel are off the screen and
       nobody is being asked to use them, so commenting on either would be
       marking work that was never set. */
    if (!opts.brakeOnly) {
      if (z.thrDelta !== null && z.thrDelta > 0.18)
        push(z.thrDelta, z.name, "Slow to pick the throttle up",
          `${(z.thrDelta * 1000).toFixed(0)} ms later than the reference to reach half throttle.`);

      const sd = z.drvSteer - z.refSteer;
      if (sd > 0.15) push(sd, z.name, "Too much steering angle",
        `Peak of ${Math.round(z.drvSteer * 100)}% against ${Math.round(z.refSteer * 100)}%. Extra lock scrubs speed and usually means you arrived too fast.`);
      else if (sd < -0.15) push(Math.abs(sd) * 0.8, z.name, "Not enough steering angle",
        `Peak of ${Math.round(z.drvSteer * 100)}% against ${Math.round(z.refSteer * 100)}%.`);

      if (z.corrections >= 3) push(0.10 + z.corrections * 0.04, z.name, "Steering corrections mid-corner",
        `${z.corrections} changes of direction where the reference has one continuous arc. Sawing at the wheel here usually means the entry speed was wrong rather than the hands.`);
    }
  }

  /* A pedal held past full scale reads as a flat top, and every shape
     measurement in this report is then being taken against a trace the rig
     could not draw. Say so first: it is a setup fault, not a driving one,
     and leaving it uncorrected makes the rest of the advice misleading. */
  if (opts.clipSeconds > 0.3) {
    push(5, "Your rig", "Brake pedal is pinning at 100%",
      `The pedal sat at full scale for ${opts.clipSeconds.toFixed(1)} s, so the top of your hardest stops was cut off flat and could not match any shape. Raise the brake range on the Feel screen until the hardest stop reaches full scale without flattening, then run it again — the brake score below is understated until you do.`);
  }

  if (!channels.brake.idle && channels.brake.lagMs > 90 && zones.length > 1)
    push(channels.brake.lagMs / 400, "Whole session", "Consistent reaction delay",
      `Your brake trace sits ${channels.brake.lagMs.toFixed(0)} ms behind throughout. Correcting timing alone would lift brake from ${Math.round(channels.brake.score)} to ${Math.round(channels.brake.shapeScore)}.`);

  return notes.sort((a, b) => b.sev - a.sev).slice(0, 8);
}


/* ------------------------------------------------------------
   Telemetry import
   ------------------------------------------------------------ */

/* Corner names by distance from the start/finish line. A track that is not
   listed still imports; its zones are numbered instead of named. */
const TRACK_CORNERS = {
  "Silverstone Circuit": [
    [120, 380, 1, "Abbey"], [520, 700, 2, "Farm"], [700, 900, 3, "Village"],
    [900, 1100, 4, "The Loop"], [1100, 1450, 5, "Aintree"],
    [1700, 1950, 6, "Brooklands"], [1950, 2250, 7, "Luffield"],
    [2300, 2650, 8, "Woodcote"], [2800, 3080, 9, "Copse"],
    [3300, 3560, 10, "Maggotts"], [3560, 3850, 11, "Becketts"],
    [3850, 4150, 13, "Chapel"], [4700, 5050, 15, "Stowe"],
    [5200, 5450, 16, "Vale"], [5450, 5750, 17, "Club"],
  ],
};

/* iRacing's car names, mapped to the class the driver trains as. */
const CAR_CATEGORY = {
  "FIA F4": "f4",
  "Super Formula Lights 324": "f3",
};

function resampleTo(src, a, b, hzIn, nOut) {
  const out = new Float32Array(nOut);
  const nIn = b - a;
  for (let i = 0; i < nOut; i++) {
    const x = (i / HZ) * hzIn;
    const j = Math.floor(x), f = x - j;
    const p = a + Math.min(nIn - 1, j), q = a + Math.min(nIn, j + 1);
    out[i] = src[p] * (1 - f) + src[q] * f;
  }
  return out;
}

function smoothInPlace(v, w) {
  const copy = Float32Array.from(v);
  for (let i = 0; i < v.length; i++) {
    let s = 0, c = 0;
    for (let k = -w; k <= w; k++) {
      const j = i + k;
      if (j >= 0 && j < v.length) { s += copy[j]; c++; }
    }
    v[i] = s / c;
  }
  return v;
}

/* ------------------------------------------------------------
   iRacing .ibt reader

   Layout, little-endian:
     header 112 B  ver, status, tickRate, sessionInfoUpdate, sessionInfoLen,
                   sessionInfoOffset, numVars, varHeaderOffset, numBuf, bufLen,
                   2 pad ints, then 4 x varBuf{tickCount, bufOffset, 2 pad}
     varHeader 144 B each  type, offset, count, countAsTime+3pad,
                           name[32], desc[64], unit[32]
     samples       fixed records of bufLen bytes from varBuf[0].bufOffset
   ------------------------------------------------------------ */
const IBT_TYPE = { 0: 1, 1: 1, 2: 4, 3: 4, 4: 4, 5: 8 }; // type -> byte width

function ibtStr(dv, off, len) {
  let s = "";
  for (let i = 0; i < len; i++) {
    const c = dv.getUint8(off + i);
    if (c === 0) break;
    s += String.fromCharCode(c);
  }
  return s;
}

function readIBT(buf) {
  const dv = new DataView(buf);
  const h = {
    ver: dv.getInt32(0, true),
    tickRate: dv.getInt32(8, true),
    siLen: dv.getInt32(16, true),
    siOffset: dv.getInt32(20, true),
    numVars: dv.getInt32(24, true),
    varHeaderOffset: dv.getInt32(28, true),
    bufLen: dv.getInt32(36, true),
    bufOffset: dv.getInt32(52, true),
  };
  if (h.tickRate <= 0 || h.numVars <= 0 || h.bufLen <= 0) {
    throw new Error("Not a readable .ibt file.");
  }

  const vars = {};
  for (let i = 0; i < h.numVars; i++) {
    const b = h.varHeaderOffset + i * 144;
    const type = dv.getInt32(b, true);
    const offset = dv.getInt32(b + 4, true);
    const name = ibtStr(dv, b + 16, 32);
    vars[name] = { type, offset };
  }

  const nSamples = Math.max(0, Math.floor((buf.byteLength - h.bufOffset) / h.bufLen));
  if (nSamples < h.tickRate * 10) {
    throw new Error("That .ibt holds less than ten seconds of running.");
  }

  const readers = {
    0: (o) => dv.getInt8(o), 1: (o) => dv.getUint8(o),
    2: (o) => dv.getInt32(o, true), 3: (o) => dv.getUint32(o, true),
    4: (o) => dv.getFloat32(o, true), 5: (o) => dv.getFloat64(o, true),
  };

  /* Pull named channels in one pass. */
  function channels(names) {
    const picks = [];
    for (const n of names) {
      const v = vars[n];
      if (v && IBT_TYPE[v.type]) picks.push([n, v.offset, readers[v.type]]);
    }
    const out = {};
    for (const [n] of picks) out[n] = new Float64Array(nSamples);
    for (let s = 0; s < nSamples; s++) {
      const rec = h.bufOffset + s * h.bufLen;
      for (const [n, off, rd] of picks) out[n][s] = rd(rec + off);
    }
    return out;
  }

  const yaml = ibtStr(dv, h.siOffset, Math.min(h.siLen, 400000));
  return { header: h, vars, nSamples, hz: h.tickRate, yaml, channels };
}

function ibtMeta(yaml) {
  const one = (k, text) => {
    const m = new RegExp(k + ":\\s*(.+)").exec(text);
    return m ? m[1].trim() : null;
  };
  const meta = {
    track: one("TrackDisplayName", yaml),
    config: one("TrackConfigName", yaml),
    length: one("TrackLength", yaml),
  };
  const idxM = /DriverCarIdx:\s*(\d+)/.exec(yaml);
  if (idxM) {
    const want = idxM[1];
    for (const block of yaml.split("\n - CarIdx: ").slice(1)) {
      if (block.split("\n")[0].trim() === want) {
        meta.driver = one("UserName", block);
        meta.car = one("CarScreenName", block);
        break;
      }
    }
  }
  return meta;
}

/* A reference lap must be a flying lap: full distance, on track throughout,
   and never slowing to a crawl. In- and out-laps cover the distance too but
   contain a pit stop, and a lap with a spin dips to walking pace mid-lap.
   Either would teach the wrong shape. */
function ibtBestLap(d, hz, trackM) {
  const lapCh = d.Lap, dist = d.LapDist, speed = d.Speed, onTrack = d.IsOnTrack;
  const n = lapCh.length;
  const spans = [];
  let start = 0;
  for (let i = 1; i < n; i++) {
    if (lapCh[i] !== lapCh[start]) { spans.push([lapCh[start], start, i - 1]); start = i; }
  }
  spans.push([lapCh[start], start, n - 1]);

  const good = [];
  for (const [num, a, b] of spans) {
    if (b - a < hz * 30) continue;
    let ok = true;
    for (let i = a; i < b; i += 10) if (!onTrack[i]) { ok = false; break; }
    if (!ok) continue;
    const covered = dist[b] - dist[a];
    if (trackM && (covered < trackM * 0.9 || covered > trackM * 1.02)) continue;
    let vMin = Infinity;
    for (let i = a; i <= b; i++) { const v = speed[i] * 3.6; if (v < vMin) vMin = v; }
    if (vMin < 40) continue;
    good.push({ lap: num, a, b, dur: (b - a + 1) / hz });
  }
  if (!good.length) throw new Error("No clean flying lap in that file — every lap has a stop or an off.");
  good.sort((x, y) => x.dur - y.dur);
  return good[0];
}


/* Turn the best flying lap of an .ibt into a reference lap. */
function parseIBT(buf, filename, category) {
  const t = readIBT(buf);
  const meta = ibtMeta(t.yaml);
  const trackM = meta.length ? parseFloat(meta.length) * 1000 : null;
  const d = t.channels(["Lap", "LapDist", "Speed", "IsOnTrack",
                        "Brake", "Throttle", "SteeringWheelAngle"]);
  const best = ibtBestLap(d, t.hz, trackM);
  const nOut = Math.floor(best.dur * HZ);

  const brake = smoothInPlace(resampleTo(d.Brake, best.a, best.b, t.hz, nOut), 2);
  const throttle = smoothInPlace(resampleTo(d.Throttle, best.a, best.b, t.hz, nOut), 2);
  const steerRad = smoothInPlace(resampleTo(d.SteeringWheelAngle, best.a, best.b, t.hz, nOut), 2);
  const speed = resampleTo(d.Speed, best.a, best.b, t.hz, nOut);
  const distM = resampleTo(d.LapDist, best.a, best.b, t.hz, nOut);
  for (let i = 0; i < nOut; i++) {
    brake[i] = clamp(brake[i], 0, 1);
    throttle[i] = clamp(throttle[i], 0, 1);
    speed[i] *= 3.6;
  }

  /* iRacing reports steering in radians, positive left. Scale to the car's
     working range, not its outright maximum: one hairpin or a correction
     would otherwise squash the whole lap into the middle of the display. */
  const mags = Array.from(steerRad, Math.abs).sort((x, y) => x - y);
  const p98 = mags[Math.min(mags.length - 1, Math.floor(mags.length * 0.98))];
  const lock = Math.max(0.5, Math.ceil(p98 * 1.1 * 10) / 10);
  const steer = new Float32Array(nOut);
  for (let i = 0; i < nOut; i++) steer[i] = clamp(-steerRad[i] / lock, -1, 1);

  const table = TRACK_CORNERS[meta.track];
  const zones = findZones(brake).map(([a, b], k) => {
    let peak = 0, vMin = Infinity;
    for (let i = a; i <= b; i++) {
      if (brake[i] > peak) peak = brake[i];
      if (speed[i] < vMin) vMin = speed[i];
    }
    const at = Math.round(distM[a]);
    let n = k + 1, name = `Zone ${k + 1}`;
    if (table) {
      const hit = table.find(([lo, hi]) => at >= lo && at <= hi);
      if (hit) { n = hit[2]; name = hit[3]; }
    }
    return {
      n, name, t: a / HZ, dur: (b - a) / HZ, peak, at,
      speedIn: Math.round(speed[a]), speedMin: Math.round(vMin),
    };
  });
  if (!zones.length) throw new Error("No braking zones found in that lap.");

  const dist = new Float32Array(nOut);
  if (trackM) for (let i = 0; i < nOut; i++) dist[i] = distM[i] / trackM;

  const car = meta.car || "Unknown car";
  return {
    id: `ibt:${filename}`,
    meta: {
      category: category || CAR_CATEGORY[car] || "other",
      car, track: meta.track || filename, config: meta.config || "",
      driver: meta.driver || "", lapTime: best.dur, lap: best.lap,
      trackM, hz: HZ, imported: true, source: filename,
    },
    n: nOut, dur: nOut / HZ,
    brake, throttle, steer, speed, dist, zones,
    markers: zones.map((z) => ({ n: z.n, name: z.name, t: z.t })),
  };
}

/* ------------------------------------------------------------
   CSV / JSON import

   Real car loggers name their channels nothing like iRacing does, time
   them in formats that are not plain numbers, and log pressures in bar
   rather than a percentage. This reads what the file actually says
   instead of expecting one house style, and when it cannot find a
   channel it says which headers it did find rather than importing an
   empty lap that silently draws nothing.
   ------------------------------------------------------------ */

/* Exact header names, checked first. */
const CH_ALIASES = {
  time: ["time", "t", "times", "timestamp", "elapsed", "sessiontime", "lapcurrentlaptime", "laptime"],
  brake: ["brake", "brakepos", "brakepress", "brakepressure", "brakepct", "brakeposition",
          "brk", "pbrakef", "brakefront", "brakepedal", "pbrake", "brakeforce"],
  throttle: ["throttle", "throttlepos", "throttlepct", "throttleposition", "rpedal", "apedal",
             "gas", "accelerator", "accel", "thr", "pedalpos", "rthrottle"],
  steer: ["steer", "steering", "steerangle", "steeringangle", "stgangle", "steeringwheelangle",
          "wheel", "steerpos", "astg", "steerdeg"],
  speed: ["speed", "carspeed", "vcar", "gpsspeed", "groundspeed", "vehiclespeed", "vehspeed"],
  dist: ["lapdistance", "lapdist", "distance", "dist", "slap", "distanceonlap", "sdistance"],
};

/* Looser fallbacks, tried only if no exact name matched. Order matters:
   brake claims its column before throttle looks for "pedal", so a file
   with both BrakePedal and rPedal resolves the way a human would read it. */
const CH_KEYWORDS = {
  brake: ["brake", "brk"],
  throttle: ["throttle", "pedal", "gas", "accel"],
  steer: ["steer", "stg", "wheel"],
  time: ["time"],
  speed: ["speed", "vcar"],
  dist: ["dist", "lap"],
};

const normHeader = (h) =>
  String(h).replace(/^﻿/, "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");

function resolveColumns(headers) {
  const taken = new Set();
  const found = {};
  const order = ["time", "brake", "throttle", "steer", "speed", "dist"];

  for (const ch of order) {
    let hit = -1;
    for (const alias of CH_ALIASES[ch]) {
      const i = headers.findIndex((h, k) => h === alias && !taken.has(k));
      if (i >= 0) { hit = i; break; }
    }
    if (hit < 0) {
      for (const key of CH_KEYWORDS[ch] ?? []) {
        const i = headers.findIndex((h, k) => h.includes(key) && !taken.has(k));
        if (i >= 0) { hit = i; break; }
      }
    }
    if (hit >= 0) { found[ch] = hit; taken.add(hit); }
  }
  return found;
}

/* A time column may be a plain number, or clock-ish with colons. Two
   fields are ambiguous — 1:30 is as readable as minutes:seconds as it is
   seconds:hundredths — so the file decides, not a guess: whichever
   reading implies a believable sample rate wins. */
function parseTimeColumn(raw) {
  const parts = raw.map((s) => String(s ?? "").trim().split(":"));
  const depth = parts[0].length;

  if (depth === 1) {
    const v = raw.map((s) => parseFloat(s));
    const span = v[v.length - 1] - v[0];
    // milliseconds, if the span is implausibly large for seconds
    const scale = span > 3000 ? 0.001 : 1;
    return { seconds: v.map((x) => (x - v[0]) * scale), note: scale === 1 ? "seconds" : "milliseconds" };
  }

  const nums = parts.map((p) => p.map(Number));
  if (nums.some((p) => p.some((x) => !isFinite(x)))) return null;

  if (depth === 3) {
    const s = nums.map((p) => p[0] * 3600 + p[1] * 60 + p[2]);
    return { seconds: s.map((x) => x - s[0]), note: "h:mm:ss" };
  }

  if (depth === 2) {
    const asMinSec = nums.map((p) => p[0] * 60 + p[1]);
    const asSecHun = nums.map((p) => p[0] + p[1] / 100);
    const rate = (arr) => {
      const span = arr[arr.length - 1] - arr[0];
      return span > 0 ? (arr.length - 1) / span : 0;
    };
    const rMin = rate(asMinSec), rSec = rate(asSecHun);
    const sane = (r) => r >= 2 && r <= 2000;
    // A second field above 59 cannot be seconds, so that settles it outright.
    const over59 = nums.some((p) => p[1] > 59);
    let pick, note;
    if (over59) { pick = asSecHun; note = "seconds:hundredths"; }
    else if (sane(rSec) && !sane(rMin)) { pick = asSecHun; note = "seconds:hundredths"; }
    else if (sane(rMin) && !sane(rSec)) { pick = asMinSec; note = "minutes:seconds"; }
    else { pick = asSecHun; note = "seconds:hundredths"; }
    return { seconds: pick.map((x) => x - pick[0]), note };
  }
  return null;
}

const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];

function parseTelemetry(text, filename, category = "other") {
  let headers, rowsRaw;

  const trimmed = text.replace(/^﻿/, "").trim();
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    const j = JSON.parse(trimmed);
    const arr = Array.isArray(j) ? j : j.samples;
    if (!Array.isArray(arr) || !arr.length) throw new Error("No sample rows in that JSON.");
    headers = Object.keys(arr[0]).map(normHeader);
    rowsRaw = arr.map((o) => Object.values(o));
  } else {
    const lines = trimmed.split(/\r?\n/).filter((l) => l.trim());
    if (lines.length < 3) throw new Error("That file has no data rows.");
    const first = lines[0];
    const delim = first.includes("\t") ? "\t" : first.includes(";") ? ";"
                : first.includes(",") ? "," : /\s{2,}/.test(first) ? /\s+/ : ",";
    headers = first.split(delim).map(normHeader);
    rowsRaw = lines.slice(1).map((l) => l.split(delim));
  }

  const col = resolveColumns(headers);
  const shown = headers.filter(Boolean).join(", ");
  const missing = ["brake", "throttle", "steer"].filter((c) => col[c] === undefined);
  if (missing.length) {
    throw new Error(
      `Could not find ${missing.join(", ")} in that file. ` +
      `Its columns are: ${shown}. Rename the ones that hold those channels, or send me the file.`
    );
  }
  if (col.time === undefined) {
    throw new Error(`No time column found. Its columns are: ${shown}.`);
  }

  const num = (r, c) => {
    const v = parseFloat(String(r[c] ?? "").replace(/[^0-9eE+\-.]/g, ""));
    return isFinite(v) ? v : NaN;
  };

  const timeStrings = rowsRaw.map((r) => r[col.time]);
  const parsedTime = parseTimeColumn(timeStrings);
  if (!parsedTime) throw new Error(`Could not read the time column (e.g. "${timeStrings[0]}").`);

  let rows = rowsRaw.map((r, i) => ({
    t: parsedTime.seconds[i],
    brake: num(r, col.brake),
    throttle: num(r, col.throttle),
    steer: num(r, col.steer),
    speed: col.speed !== undefined ? num(r, col.speed) : NaN,
    dist: col.dist !== undefined ? num(r, col.dist) : NaN,
  })).filter((r) => isFinite(r.t) && isFinite(r.brake) && isFinite(r.throttle) && isFinite(r.steer));

  if (rows.length < 50) throw new Error(`Only ${rows.length} usable rows after reading the file.`);

  /* A session file holds several laps, separated by the distance counter
     dropping back to zero. Train against one lap, so take the longest
     complete one rather than replaying an entire run. */
  let lapNote = "whole file";
  if (col.dist !== undefined && rows.some((r) => isFinite(r.dist))) {
    const cuts = [0];
    for (let i = 1; i < rows.length; i++) {
      if (isFinite(rows[i].dist) && isFinite(rows[i - 1].dist)
          && rows[i].dist < rows[i - 1].dist - 200) cuts.push(i);
    }
    cuts.push(rows.length);
    if (cuts.length > 2) {
      let best = null;
      for (let k = 0; k < cuts.length - 1; k++) {
        const seg = rows.slice(cuts[k], cuts[k + 1]);
        if (seg.length < 50) continue;
        const covered = Math.max(...seg.map((r) => r.dist)) - Math.min(...seg.map((r) => r.dist));
        if (!best || seg.length > best.seg.length) best = { seg, covered };
      }
      if (best) {
        rows = best.seg;
        lapNote = `one lap of ${Math.round(best.covered)} m`;
      }
    }
  }

  const t0 = rows[0].t;
  rows.forEach((r) => { r.t -= t0; });
  const dur = rows[rows.length - 1].t;
  if (!(dur > 2)) throw new Error("That file covers less than two seconds.");
  const srcHz = (rows.length - 1) / dur;

  /* Scaling. A logger reports throttle as a percentage that can read past
     100, and brake as pressure in bar with no fixed ceiling, so both are
     scaled against the lap's own working maximum: full means as hard as
     this driver went on this lap.

     Brake takes the true peak, not a percentile. A percentile looks safer
     but clips the top off the hardest stops — exactly the moment the
     trainer exists to teach — and a flat-topped reference is a shape the
     driver cannot match because the car never made it. The only thing a
     percentile guards against is a single spike, so guard against that
     directly: fall back only when the peak stands well clear of the rest
     of the data, which is what a spike actually looks like. */
  const absSorted = (k) => rows.map((r) => Math.abs(r[k])).sort((a, b) => a - b);
  const bSorted = absSorted("brake");
  const bMax = bSorted[bSorted.length - 1];
  const bNear = pct(bSorted, 0.999);
  const bPeak = (bNear > 0 && bMax / bNear > 1.25) ? bNear : bMax;
  const thPeak = pct(absSorted("throttle"), 0.995);
  const sPeak = pct(absSorted("steer"), 0.98) * 1.1;

  const bDiv = bPeak > 1.5 ? bPeak : 1;
  const thDiv = thPeak > 1.5 ? thPeak : 1;
  const sDiv = sPeak > 1.5 ? sPeak : Math.max(0.5, sPeak);

  const n = Math.floor(dur * HZ);
  const brake = new Float32Array(n), throttle = new Float32Array(n);
  const steer = new Float32Array(n), speed = new Float32Array(n), dist = new Float32Array(n);

  let j = 0;
  for (let i = 0; i < n; i++) {
    const tt = i / HZ;
    while (j < rows.length - 2 && rows[j + 1].t < tt) j++;
    const A = rows[j], B = rows[j + 1] ?? rows[j];
    const f = B.t === A.t ? 0 : clamp((tt - A.t) / (B.t - A.t), 0, 1);
    const mix = (k) => (A[k] ?? 0) * (1 - f) + (B[k] ?? 0) * f;
    brake[i] = clamp(mix("brake") / bDiv, 0, 1);
    throttle[i] = clamp(mix("throttle") / thDiv, 0, 1);
    steer[i] = clamp(mix("steer") / sDiv, -1, 1);
    speed[i] = isFinite(A.speed) ? mix("speed") : 0;
    dist[i] = isFinite(A.dist) ? mix("dist") : 0;
  }

  const distMax = Math.max(...dist);
  const haveDist = distMax > 10;

  const zones = findZones(brake).map(([a, b], k) => {
    let peak = 0, vMin = Infinity, vIn = speed[a];
    for (let i = a; i <= b; i++) {
      if (brake[i] > peak) peak = brake[i];
      if (speed[i] < vMin) vMin = speed[i];
    }
    return {
      n: k + 1, name: `Zone ${k + 1}`, t: a / HZ, dur: (b - a) / HZ, peak,
      at: haveDist ? Math.round(dist[a]) : Math.round((a / HZ) * 10),
      speedIn: Math.round(vIn) || 0,
      speedMin: isFinite(vMin) ? Math.round(vMin) : 0,
    };
  });
  if (!zones.length) {
    throw new Error(
      "No braking zones found. The brake channel read " +
      `${bPeak.toFixed(1)} at its peak — check that column really is the brake.`
    );
  }

  const distNorm = new Float32Array(n);
  if (haveDist) for (let i = 0; i < n; i++) distNorm[i] = dist[i] / distMax;

  const label = filename.replace(/\.[^.]+$/, "");
  const units = bPeak > 1.5
    ? `brake 0–${Math.round(bPeak)}${bPeak < bMax ? " (one spike ignored)" : " peak"}`
    : "brake already 0–1";

  return {
    id: `import:${label}`,
    meta: {
      category, car: "Imported", track: label, config: "", driver: "",
      lapTime: dur, hz: HZ, imported: true, source: filename,
      note: `${Math.round(srcHz)} Hz, ${parsedTime.note}, ${lapNote}, ${units}`,
    },
    n, dur, brake, throttle, steer, speed, dist: distNorm, zones,
    markers: zones.map((z) => ({ n: z.n, name: z.name, t: z.t })),
  };
}

/* ------------------------------------------------------------
   Input device
   ------------------------------------------------------------ */
/* Each channel carries its own device, because a real rig rarely puts them
   on one. Heusinkveld, Asetek and Simucube pedals enumerate as a separate
   HID device from the wheelbase, so brake and steering live on different
   gamepads and have to be mapped and read independently.
   Shape per channel: { padId, padIndex, axis, rest, full } */
const BLANK_CAL = { brake: null, throttle: null, steer: null };
const CHANNELS = ["brake", "throttle", "steer"];

function padsNow() {
  return navigator.getGamepads ? Array.from(navigator.getGamepads()).filter(Boolean) : [];
}

/* A device can come back at a different index after a reconnect, so match on
   index and id together first, then fall back to the id alone. */
function resolvePad(pads, m) {
  if (!m) return null;
  return pads.find((p) => p.index === m.padIndex && p.id === m.padId)
    ?? pads.find((p) => p.id === m.padId)
    ?? null;
}

/* Returns null when the device that owns this channel is not connected,
   which is different from a pedal resting at zero. */
function readAxis(pads, m, signed) {
  const pad = resolvePad(pads, m);
  if (!pad) return null;
  const raw = pad.axes[m.axis] ?? 0;
  const span = m.full - m.rest;
  if (Math.abs(span) < 0.05) return 0;
  const v = (raw - m.rest) / span;
  return signed ? clamp(v, -1, 1) : clamp(v, 0, 1);
}

const calMapped = (cal) => CHANNELS.every((k) => cal[k]);
const calDevices = (cal) => [...new Set(CHANNELS.filter((k) => cal[k]).map((k) => cal[k].padId))];
const calMissing = (cal, pads) =>
  [...new Set(CHANNELS.filter((k) => cal[k] && !resolvePad(pads, cal[k])).map((k) => cal[k].padId))];

/* How the rig's raw travel is mapped onto the trace.

   steerGain exists because a wheelbase set to 1080 degrees needs half a turn
   to reach a lock the reference car reached in 70 degrees, which feels slow
   and vague however quick the code is. Raising the gain means less rotation
   for the same trace movement.

   brakeCurve shapes pedal travel. A load cell is not linear in the way a
   driver feels pressure, and the reference channel is the car's own brake
   signal, so a correction is sometimes needed to make equal effort read as
   an equal number. 1.00 is untouched; below 1 makes the first part of the
   travel register more, above 1 less.

   brakeRange sets how much pressure counts as 100%. Calibration records
   whatever was pressed on the day, and chasing a reference tends to go
   harder than that — past which the trace pins flat at the top and the
   peak shape disappears, which is the one shape that matters most here.
   Raising the range asks for more pressure before full scale, so the peak
   has somewhere to go. */
const BLANK_FEEL = { steerGain: 1.0, brakeCurve: 1.0, steerDeadzone: 0.0, brakeRange: 1.0 };

function useInputDevice(cal, keyboard, feel = BLANK_FEEL) {
  const keys = useRef({});
  const kb = useRef({ brake: 0, throttle: 0, steer: 0 });
  const lastT = useRef(performance.now());

  useEffect(() => {
    const down = (e) => {
      if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", " "].includes(e.key)) e.preventDefault();
      keys.current[e.key] = true;
    };
    const up = (e) => { keys.current[e.key] = false; };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => { window.removeEventListener("keydown", down); window.removeEventListener("keyup", up); };
  }, []);

  return useCallback(() => {
    if (keyboard) {
      const now = performance.now();
      const dt = clamp((now - lastT.current) / 1000, 0, 0.05);
      lastT.current = now;
      const k = keys.current;
      const to = (cur, target, rate) => {
        const d = target - cur;
        return cur + clamp(d, -rate * dt, rate * dt);
      };
      kb.current.brake = to(kb.current.brake, k["ArrowDown"] || k["s"] ? 1 : 0, 3.2);
      kb.current.throttle = to(kb.current.throttle, k["ArrowUp"] || k["w"] ? 1 : 0, 3.2);
      const st = (k["ArrowRight"] || k["d"] ? 1 : 0) - (k["ArrowLeft"] || k["a"] ? 1 : 0);
      kb.current.steer = to(kb.current.steer, st, 2.6);
      return { ...kb.current };
    }
    const pads = padsNow();
    const b = readAxis(pads, cal.brake, false);
    const t = readAxis(pads, cal.throttle, false);
    const s = readAxis(pads, cal.steer, true);

    let steer = s ?? 0;
    const dz = feel.steerDeadzone ?? 0;
    if (dz > 0) {
      const m = Math.abs(steer);
      steer = m <= dz ? 0 : Math.sign(steer) * ((m - dz) / (1 - dz));
    }
    steer = clamp(steer * (feel.steerGain ?? 1), -1, 1);

    let brake = (b ?? 0) / Math.max(0.2, feel.brakeRange ?? 1);
    const g = feel.brakeCurve ?? 1;
    if (g !== 1) brake = Math.pow(clamp(brake, 0, 1), g);
    // Report the pedal pinning at full scale: the shape is being lost, and
    // the driver should see that rather than wonder why the peak is flat.
    const clipping = brake >= 0.999;
    brake = clamp(brake, 0, 1);

    return {
      brake, throttle: t ?? 0, steer, clipping,
      lost: b === null || t === null || s === null,
    };
  }, [cal, keyboard, feel]);
}

/* ------------------------------------------------------------
   RUN LOG
   Every completed session is kept: who drove it, against which
   reference, what it scored, and both traces in full so a run can
   be reopened and compared later. Records are written as files so
   they can be shared off this machine, and kept in the browser so
   the logbook is there on the next visit.
   ------------------------------------------------------------ */
const RUNS_KEY = "bt:runs";
const RUN_FORMAT = 1;

function encodeU8(arr, lo, hi) {
  const n = arr.length;
  const bytes = new Uint8Array(n);
  const span = hi - lo;
  for (let i = 0; i < n; i++) {
    bytes[i] = clamp(Math.round(((arr[i] - lo) / span) * 255), 0, 255);
  }
  // String.fromCharCode blows the argument limit on long laps, so chunk it.
  let s = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < n; i += CHUNK) s += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  return btoa(s);
}

function runRecord({ driver, lap, drill, result, cap, feel }) {
  const m = lap.meta ?? {};
  return {
    v: RUN_FORMAT,
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    driver: (driver && driver.name) || "Unnamed",
    driverId: (driver && driver.id) || null,
    savedAt: new Date().toISOString(),
    reference: {
      car: m.car ?? "", track: m.track ?? "", config: m.config ?? "",
      refDriver: m.driver ?? "", lapTime: m.lapTime ?? null,
      category: m.category ?? "", lapId: lap.id ?? "",
    },
    drill: { id: drill.id, name: drill.name },
    hz: HZ, n: lap.n, dur: lap.dur,
    feel: { ...feel },
    overall: result.overall,
    channels: {
      brake: { ...result.channels.brake },
      throttle: { ...result.channels.throttle },
      steer: { ...result.channels.steer },
    },
    zones: result.zones.map((z) => ({
      name: z.name, n: z.n, t: z.t,
      refPeak: z.refPeak, drvPeak: z.drvPeak,
      bpDelta: z.bpDelta, thrDelta: z.thrDelta,
      refSteer: z.refSteer, drvSteer: z.drvSteer,
      corrections: z.corrections, score: z.score,
    })),
    notes: result.notes.map((nt) => ({ title: nt.title, zone: nt.zone, detail: nt.detail })),
    ref: {
      brake: encodeU8(lap.brake, 0, 1),
      throttle: encodeU8(lap.throttle, 0, 1),
      steer: encodeU8(lap.steer, -1, 1),
    },
    drv: {
      brake: encodeU8(cap.brake, 0, 1),
      throttle: encodeU8(cap.throttle, 0, 1),
      steer: encodeU8(cap.steer, -1, 1),
    },
    scored: lap.scored ? encodeU8(lap.scored, 0, 1) : null,
  };
}

/* The index is what the logbook lists: small, so it always fits. */
const runSummary = (r) => ({
  id: r.id, driver: r.driver, savedAt: r.savedAt,
  car: r.reference.car, track: r.reference.track,
  drill: r.drill.name, overall: r.overall, dur: r.dur,
  brake: Math.round(r.channels.brake.score),
  throttle: Math.round(r.channels.throttle.score),
  steer: Math.round(r.channels.steer.score),
});

function loadRunIndex() {
  const v = store.get(RUNS_KEY);
  return Array.isArray(v) ? v : [];
}

/* Full records are kept per run under their own key. Traces are bulky, so
   when the browser refuses a write the oldest bodies are dropped until it
   fits — the index entry survives, so the score history is never lost. */
function saveRun(rec) {
  const index = loadRunIndex();
  index.unshift(runSummary(rec));

  let wroteBody = store.set(`bt:run:${rec.id}`, rec);
  if (!wroteBody) {
    for (let i = index.length - 1; i >= 0 && !wroteBody; i--) {
      if (index[i].id === rec.id) continue;
      store.remove(`bt:run:${index[i].id}`);
      index[i].dropped = true;
      wroteBody = store.set(`bt:run:${rec.id}`, rec);
    }
  }
  store.set(RUNS_KEY, index.slice(0, 500));
  return wroteBody;
}

const loadRun = (id) => store.get(`bt:run:${id}`);

function deleteRun(id) {
  store.remove(`bt:run:${id}`);
  store.set(RUNS_KEY, loadRunIndex().filter((r) => r.id !== id));
}

/* ---- files ---- */
function safeName(s) {
  return String(s).replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "run";
}

function download(name, text, mime) {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = name;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

const runFileName = (r, ext) =>
  [safeName(r.driver), safeName(r.reference.car), safeName(r.drill.name),
   r.savedAt.slice(0, 16).replace(/[:T]/g, "-")].join("_") + "." + ext;

function runToCSV(rec) {
  const dec = (b64, lo, hi) => decodeU8(b64, lo, hi);
  const rb = dec(rec.ref.brake, 0, 1), rt = dec(rec.ref.throttle, 0, 1), rs = dec(rec.ref.steer, -1, 1);
  const db = dec(rec.drv.brake, 0, 1), dt = dec(rec.drv.throttle, 0, 1), ds = dec(rec.drv.steer, -1, 1);
  const sc = rec.scored ? dec(rec.scored, 0, 1) : null;
  const head = [
    `# Brake Trainer run`, `# driver,${rec.driver}`, `# saved,${rec.savedAt}`,
    `# reference,${rec.reference.car} ${rec.reference.track} ${rec.reference.config}`,
    `# reference lap,${rec.reference.lapTime ?? ""}s by ${rec.reference.refDriver}`,
    `# drill,${rec.drill.name}`, `# overall,${rec.overall}`,
    `# brake,${rec.channels.brake.score.toFixed(1)}`,
    `# throttle,${rec.channels.throttle.score.toFixed(1)}`,
    `# steering,${rec.channels.steer.score.toFixed(1)}`,
    `# brake lag ms,${rec.channels.brake.lagMs.toFixed(0)}`,
    "time,ref_brake,drv_brake,ref_throttle,drv_throttle,ref_steer,drv_steer,scored",
  ];
  const rows = [];
  for (let i = 0; i < rec.n; i++) {
    rows.push([
      (i / rec.hz).toFixed(2),
      rb[i].toFixed(4), db[i].toFixed(4),
      rt[i].toFixed(4), dt[i].toFixed(4),
      rs[i].toFixed(4), ds[i].toFixed(4),
      sc ? (sc[i] > 0.5 ? 1 : 0) : 1,
    ].join(","));
  }
  return head.concat(rows).join("\n");
}

function parseRunFile(text) {
  const r = JSON.parse(text);
  if (!r || r.v !== RUN_FORMAT || !r.ref || !r.drv) {
    throw new Error("That is not a Brake Trainer run file.");
  }
  return r;
}

const fmtWhen = (iso) => {
  const d = new Date(iso);
  if (isNaN(d)) return iso;
  return d.toLocaleString(undefined, {
    day: "numeric", month: "short", hour: "2-digit", minute: "2-digit",
  });
};

/* ============================================================
   UI
   ============================================================ */
export default function BrakeTrainer() {
  const [screen, setScreen] = useState("boot");
  const [driver, setDriver] = useState(null);   // { id, name, cloud? }
  const [account, setAccount] = useState(null); // bt_profiles row when signed in
  const [cat, setCat] = useState(LAPS[0]?.meta.category ?? "f4");
  const [lapId, setLapId] = useState(LAPS[0]?.id ?? "");
  const [drillId, setDrillId] = useState("corners");
  const [cal, setCal] = useState(BLANK_CAL);
  const [feel, setFeel] = useState(BLANK_FEEL);
  const [brakeOnly, setBrakeOnly] = useState(false);
  const [viewing, setViewing] = useState(null);
  const [keyboard, setKeyboard] = useState(false);
  const [imported, setImported] = useState(() => loadSavedLapRecords().map(unpackLap));
  const [lapWarn, setLapWarn] = useState("");
  const [result, setResult] = useState(null);
  const [bests, setBests] = useState({});
  const [syncNote, setSyncNote] = useState("");

  /* Calibration belongs to the rig, not the driver: the axes are wherever
     this machine's hardware puts them, whoever is sitting in it. Feel and
     personal bests belong to the driver, so they are keyed per profile. */
  useEffect(() => {
    const c = store.get("bt:cal");
    if (c) setCal(c);
  }, []);

  /* A session may already be live from last time — the token is kept by the
     Supabase client, exactly as the hub does it, so a driver signs in once on
     their own machine and not again every evening. */
  useEffect(() => {
    let gone = false;
    (async () => {
      if (!cloud.ready()) { if (!gone) setScreen("signin"); return; }
      const s = await cloud.session();
      if (gone) return;
      if (!s) { setScreen("signin"); return; }
      try {
        const prof = await cloud.profile();
        if (gone) return;
        if (!prof) { setScreen("signin"); return; }
        await adoptAccount(prof);
      } catch {
        if (!gone) setScreen("signin");
      }
    })();
    return () => { gone = true; };
  }, []);

  /* Taking on a signed-in identity: the driver becomes their account, and
     their settings come down from the server so the rig they are sitting at
     feels like their own even if they have never used it before. */
  const adoptAccount = useCallback(async (prof) => {
    setAccount(prof);
    if (!prof.approved) { setScreen("waiting"); return; }
    const who = { id: prof.id, name: prof.full_name || prof.handle, cloud: true };
    setDriver(who);
    let remote = null;
    try { remote = await cloud.pullSettings(); } catch { /* use what is local */ }
    const localFeel = store.get(`bt:feel:${prof.id}`) ?? {};
    const localBests = store.get(`bt:bests:${prof.id}`) ?? {};
    setFeel({ ...BLANK_FEEL, ...localFeel, ...(remote?.feel ?? {}) });
    setBests({ ...localBests, ...(remote?.bests ?? {}) });
    setBrakeOnly(!!(remote?.brakeOnly ?? store.get(`bt:brakeOnly:${prof.id}`)));
    /* Calibration only travels if this machine has none of its own; the axes
       on someone else's rig are not the axes on this one. */
    if (remote?.cal && !store.get("bt:cal")) setCal(remote.cal);
    setScreen("garage");
  }, []);

  useEffect(() => {
    if (!driver || driver.cloud) return;   // cloud profiles load above
    setFeel({ ...BLANK_FEEL, ...(store.get(`bt:feel:${driver.id}`) ?? {}) });
    setBests(store.get(`bt:bests:${driver.id}`) ?? {});
    setBrakeOnly(!!store.get(`bt:brakeOnly:${driver.id}`));
  }, [driver]);

  /* One place that writes a driver's state to both sides. Local first, since
     it must work with no connection; the server is best-effort on top. */
  const persist = useCallback((patch) => {
    if (!driver) return;
    if (patch.feel !== undefined) store.set(`bt:feel:${driver.id}`, patch.feel);
    if (patch.bests !== undefined) store.set(`bt:bests:${driver.id}`, patch.bests);
    if (patch.brakeOnly !== undefined) store.set(`bt:brakeOnly:${driver.id}`, patch.brakeOnly);
    if (!driver.cloud || !cloud.ready()) return;
    cloud.pushSettings({
      feel: patch.feel ?? feel,
      bests: patch.bests ?? bests,
      brakeOnly: patch.brakeOnly ?? brakeOnly,
      cal: patch.cal ?? cal,
    }).catch(() => setSyncNote("Your settings are saved on this machine but did not reach the server."));
  }, [driver, feel, bests, brakeOnly, cal]);

  const all = useMemo(() => [...LAPS, ...imported], [imported]);
  const [nameRev, setNameRev] = useState(0);   // bump to re-read custom names
  const fullLap = useMemo(
    () => applyZoneNames(all.find((l) => l.id === lapId) ?? all[0]),
    [all, lapId, nameRev]
  );
  const drills = useMemo(() => makeDrills(fullLap), [fullLap]);
  const drill = drills.find((d) => d.id === drillId) ?? drills[0];
  const lap = useMemo(() => buildDrill(fullLap, drill), [fullLap, drill]);

  /* A brake-only run is a different drill from the same reference, so its
     scores must not be compared with a full run's. The best is keyed by mode
     too, and so is the leaderboard row. */
  const bestKey = `${fullLap.id}:${drill.id}${brakeOnly ? ":brake" : ""}`;
  const label = `${fullLap.meta.car} · ${fullLap.meta.track} · ${drill.name}`
    + (brakeOnly ? " · brake only" : "");

  const finish = useCallback(async (cap, clipSeconds = 0) => {
    const r = analyse(lap, cap, { clipSeconds, brakeOnly });
    // Snapshot the capture: the buffers are reused on the next run.
    const frozen = {
      brake: Float32Array.from(cap.brake),
      throttle: Float32Array.from(cap.throttle),
      steer: Float32Array.from(cap.steer),
    };
    const rec = runRecord({ driver, lap, drill, result: r, cap: frozen, feel });
    rec.brakeOnly = brakeOnly;
    const kept = saveRun(rec);
    setResult({ ...r, lap, cap: frozen, label, saved: rec, kept });
    if (!bests[bestKey] || r.overall > bests[bestKey]) {
      const nb = { ...bests, [bestKey]: r.overall };
      setBests(nb);
      persist({ bests: nb });
    }
    /* The log on the server is what makes a run visible to Riki and what
       feeds the board. It is deliberately not awaited into the UI: a dropped
       connection must not lose the driver their result, which is already
       saved on this machine. */
    if (driver?.cloud && cloud.ready()) {
      const mode = brakeOnly ? "brake" : "full";
      cloud.logRun({ lap: fullLap, drill, result: r, record: rec, mode })
        .then((ok) => { if (!ok) setSyncNote("This run is saved here but did not reach the server."); })
        .catch(() => setSyncNote("This run is saved here but did not reach the server."));
    }
    setScreen("results");
  }, [lap, fullLap, label, bests, bestKey, driver, drill, feel, brakeOnly, persist]);

  const saveCal = (c) => { setCal(c); store.set("bt:cal", c); persist({ cal: c }); };
  const saveFeel = (f) => { setFeel(f); persist({ feel: f }); };
  const saveBrakeOnly = (v) => { setBrakeOnly(v); persist({ brakeOnly: v }); };

  const leaveAccount = useCallback(async () => {
    await cloud.signOut();
    setAccount(null); setDriver(null); setResult(null); setSyncNote("");
    setScreen("signin");
  }, []);

  return (
    <div className="bt-root">
      <Styles />
      {screen === "boot" && (
        <div className="login"><p className="muted">Loading…</p></div>
      )}
      {screen === "signin" && (
        <SignIn onSignedIn={adoptAccount} onLocal={() => setScreen("local")} />
      )}
      {screen === "local" && (
        <DriverSelect onPick={(d) => { setDriver(d); setScreen("garage"); }}
          onBack={cloud.ready() ? () => setScreen("signin") : null} />
      )}
      {screen === "waiting" && account && (
        <Waiting account={account} onSignOut={leaveAccount}
          onRecheck={async () => {
            try { const p = await cloud.profile(); if (p) await adoptAccount(p); } catch { /* stay put */ }
          }} />
      )}
      {screen === "account" && (
        <Account account={account}
          onLeaderboard={async (on) => {
            setAccount((a) => ({ ...a, on_leaderboard: on }));
            try { await cloud.setOnLeaderboard(on); }
            catch {
              setSyncNote("Could not change that just now.");
              setAccount((a) => ({ ...a, on_leaderboard: !on }));
            }
          }}
          onSignOut={leaveAccount} onBack={() => setScreen("garage")} />
      )}
      {screen === "requests" && <Requests onBack={() => setScreen("garage")} />}
      {screen === "board" && (
        <Leaderboard lapKey={`${fullLap.id}:${drill.id}`} lapLabel={label}
          onBack={() => setScreen("garage")} />
      )}
      {screen === "garage" && (
        <Garage
          driver={driver} account={account} syncNote={syncNote}
          brakeOnly={brakeOnly} setBrakeOnly={saveBrakeOnly}
          onAccount={driver?.cloud ? () => setScreen("account") : null}
          onRequests={account?.role === "coach" ? () => setScreen("requests") : null}
          onBoard={driver?.cloud ? () => setScreen("board") : null}
          onSwitchDriver={driver?.cloud ? leaveAccount
            : () => { setDriver(null); setScreen(cloud.ready() ? "signin" : "local"); }}
          cat={cat} setCat={setCat}
          all={all} lapId={fullLap.id} setLapId={setLapId} fullLap={fullLap}
          drills={drills} drillId={drill.id} setDrillId={setDrillId} lap={lap}
          cal={cal} keyboard={keyboard} setKeyboard={setKeyboard}
          best={bests[bestKey]} onFeel={() => setScreen("feel")}
          onLogbook={() => setScreen("logbook")}
          onRenameZone={(i, nm) => { setZoneName(fullLap.id, i, nm); setNameRev((v) => v + 1); }}
          onImport={(l) => {
            const kept = saveLapRecord(packLap(l));
            setImported((p) => [...p.filter((x) => x.id !== l.id), l]);
            setLapId(l.id);
            setDrillId("corners");
            setLapWarn(kept ? "" :
              `${l.meta.track} is loaded, but this browser refused to store it — ` +
              `it will be gone on the next reload. Delete some saved runs from the Logbook and import it again.`);
          }}
          lapWarn={lapWarn}
          onDeleteLap={(id) => {
            deleteSavedLap(id);
            setImported((p) => p.filter((x) => x.id !== id));
            if (lapId === id) { setLapId(LAPS[0]?.id ?? ""); setDrillId("corners"); }
            setLapWarn("");
          }}
          onCalibrate={() => setScreen("calibrate")}
          onStart={() => setScreen("run")}
        />
      )}
      {screen === "logbook" && (
        <Logbook driver={driver}
          onOpen={(rec) => { setViewing(rec); setScreen("saved"); }}
          onBack={() => setScreen("garage")} />
      )}
      {screen === "saved" && viewing && (
        <SavedRun rec={viewing} onBack={() => setScreen("logbook")} />
      )}
      {screen === "feel" && (
        <Feel cal={cal} feel={feel} setFeel={saveFeel} keyboard={keyboard}
          onDone={() => setScreen("garage")} />
      )}
      {screen === "calibrate" && (
        <Calibrate cal={cal} onSave={(c) => { saveCal(c); setScreen("garage"); }} onCancel={() => setScreen("garage")} />
      )}
      {screen === "run" && (
        <Run lap={lap} cal={cal} keyboard={keyboard} feel={feel} label={label}
          brakeOnly={brakeOnly}
          onFinish={finish} onAbort={() => setScreen("garage")} />
      )}
      {screen === "results" && result && (
        <Results r={result} best={bests[bestKey]} saved={result.saved}
          onRetry={() => setScreen("run")} onGarage={() => setScreen("garage")} />
      )}
    </div>
  );
}

/* A single brake trace flowing through a small window above the sign-in.
   The full-screen version of this was too busy to read a form through —
   traces behind the writing is noise, a contained strip is a detail. One
   line only, with a soft fill under it and the edges faded so it reads as
   something passing through rather than something cut off.

   Cheap on purpose: two-pixel steps, one path, no shadows. Frozen for
   anyone who has asked their system for reduced motion. */
function TraceStrip() {
  const cvs = useRef(null);

  useEffect(() => {
    const c = cvs.current;
    const lap = LAPS[0];
    if (!c || !lap) return;

    const reduce = typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    let raf = 0, t = 0, W = 0, H = 0, dpr = 1;

    const resize = () => {
      dpr = Math.min(2, window.devicePixelRatio || 1);
      W = c.clientWidth || 1;
      H = c.clientHeight || 1;
      c.width = Math.round(W * dpr);
      c.height = Math.round(H * dpr);
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(c);

    const draw = () => {
      const x = c.getContext("2d");
      if (!x) return;
      x.setTransform(dpr, 0, 0, dpr, 0, 0);
      x.clearRect(0, 0, W, H);

      const pad = 4;
      const bot = H - pad;
      const h = H - pad * 2;
      /* Sixteen seconds of lap across the strip. Enough that there is
         usually a shape on screen rather than flat baseline, while a braking
         event is still wide enough to read as a shape rather than a spike. */
      const span = 16;
      const at = (i) => {
        const tt = (t + (i / W) * span) % lap.dur;
        return bot - (lap.brake[idx(tt)] ?? 0) * h;
      };

      const STEP = 2;
      x.fillStyle = "#ffffff";
      x.globalAlpha = 0.07;
      x.beginPath();
      x.moveTo(0, bot);
      for (let i = 0; i <= W; i += STEP) x.lineTo(i, at(i));
      x.lineTo(W, bot);
      x.closePath();
      x.fill();

      x.globalAlpha = 0.9;
      x.strokeStyle = "#ffffff";
      x.lineWidth = 1.6;
      x.lineJoin = "round";
      x.lineCap = "round";
      x.beginPath();
      for (let i = 0; i <= W; i += STEP) {
        const y = at(i);
        i === 0 ? x.moveTo(i, y) : x.lineTo(i, y);
      }
      x.stroke();

      x.globalAlpha = 0.14;
      x.lineWidth = 1;
      x.beginPath();
      x.moveTo(0, bot + 0.5);
      x.lineTo(W, bot + 0.5);
      x.stroke();
      x.globalAlpha = 1;

      if (!reduce) {
        t += 0.026;
        raf = requestAnimationFrame(draw);
      }
    };

    draw();
    return () => { cancelAnimationFrame(raf); ro.disconnect(); };
  }, []);

  return <canvas ref={cvs} className="trace-strip" aria-hidden="true" />;
}

/* ---------------- Sign in ----------------
   The front door of the product. A driver's username is their first name;
   the password is the one Riki sent them. The traces behind it are a real
   lap of his, flowing past — the thing they are about to try to match. */
function SignIn({ onSignedIn, onLocal }) {
  const [handle, setHandle] = useState("");
  const [pass, setPass] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [asking, setAsking] = useState(false);

  const preview = previewOnly();
  const offline = !cloud.ready() || preview;

  const submit = async (e) => {
    e.preventDefault();
    if (!handle.trim() || !pass) return;
    setBusy(true); setErr("");
    try {
      await cloud.signIn(handle, pass);
      const prof = await cloud.profile();
      if (!prof) throw new Error("Signed in, but your profile would not load. Try again.");
      await onSignedIn(prof);
    } catch (e2) {
      const m = String(e2?.message || e2);
      setErr(/invalid login|credentials/i.test(m)
        ? "That username or password didn't match. Try again."
        : netMessage(e2));
      setBusy(false);
    }
  };

  if (asking) return <RequestAccess onBack={() => setAsking(false)} />;

  return (
    <div className="signin">
      <div className="signin-inner narrow">
        <img src={VCASO_LOGO} alt="VCASO Performance" className="vcaso-logo big" />
        <h1 className="display-name">Brake Trainer</h1>
        <TraceStrip />
        <p className="lede centre">
          {preview
            ? "This is a preview copy, so it cannot sign you in or reach the leaderboard."
            : offline
              ? "This machine is offline, so signing in is unavailable. You can still train with a local profile."
              : "Sign in with the username and password Riki gave you."}
        </p>

        {preview && (
          <div className="preview-note">
            <p>The real thing is here:</p>
            <a className="btn primary wide" href={LIVE_URL} target="_blank" rel="noreferrer">
              Open the Brake Trainer
            </a>
            <p className="fine centre">
              Worth bookmarking — pedals only work there too.
            </p>
          </div>
        )}

        {!offline && (
          <form onSubmit={submit} className="card-form">
            <label className="lbl">Username
              <input className="field" type="text" value={handle} autoComplete="username"
                autoCapitalize="none" autoCorrect="off" spellCheck="false"
                placeholder="e.g. reza" onChange={(e) => setHandle(e.target.value)} required />
            </label>
            <label className="lbl">Password
              <input className="field" type="password" value={pass} autoComplete="current-password"
                onChange={(e) => setPass(e.target.value)} required />
            </label>
            {err && <div className="err">{err}</div>}
            <button className="btn primary wide" type="submit" disabled={busy}>
              {busy ? "Signing in…" : "Sign in"}
            </button>
          </form>
        )}

        <div className="signin-alt">
          {!offline && (
            <button className="link" onClick={() => setAsking(true)}>
              No login yet? Ask Riki for access
            </button>
          )}
          <button className="link" onClick={onLocal}>
            Train on this device without an account
          </button>
        </div>
        <p className="fine centre">
          Forgotten your password? Message Riki and he will send you a new one.
        </p>
      </div>
    </div>
  );
}

/* Anyone may ask. The row lands in Riki's queue unapproved, and he sends a
   password back himself — nothing here can grant its own access. */
function RequestAccess({ onBack }) {
  const [f, setF] = useState({ fullName: "", contact: "", wantedHandle: "", note: "" });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [sent, setSent] = useState(false);
  const set = (k) => (e) => setF((p) => ({ ...p, [k]: e.target.value }));

  const submit = async (e) => {
    e.preventDefault();
    if (!f.fullName.trim()) return;
    setBusy(true); setErr("");
    try {
      await cloud.requestAccess({
        fullName: f.fullName.trim(),
        contact: f.contact.trim(),
        wantedHandle: f.wantedHandle.trim().toLowerCase(),
        note: f.note.trim(),
      });
      setSent(true);
    } catch (e2) { setErr(netMessage(e2)); setBusy(false); }
  };

  if (sent) {
    return (
      <div className="signin">
        <div className="signin-inner narrow">
          <img src={VCASO_LOGO} alt="VCASO Performance" className="vcaso-logo" />
          <h1 className="h1 centre">Asked</h1>
          <p className="lede centre">
            Riki has your name. When he approves you he will message you a username
            and a password, and you sign in here with those.
          </p>
          <button className="btn wide" onClick={onBack}>Back to sign in</button>
        </div>
      </div>
    );
  }

  return (
    <div className="signin">
      <div className="signin-inner narrow">
        <img src={VCASO_LOGO} alt="VCASO Performance" className="vcaso-logo" />
        <h1 className="display-name sm">Ask for access</h1>
        <p className="lede centre">
          Riki approves drivers one at a time. Leave your name and how to reach you.
        </p>
        <form onSubmit={submit} className="card-form">
          <label className="lbl">Your name
            <input className="field" value={f.fullName} onChange={set("fullName")}
              placeholder="First and last name" required maxLength={80} />
          </label>
          <label className="lbl">How should Riki reach you?
            <input className="field" value={f.contact} onChange={set("contact")}
              placeholder="Discord handle, email or phone" maxLength={160} />
          </label>
          <label className="lbl">Username you would like <span className="hint">optional</span>
            <input className="field" value={f.wantedHandle} onChange={set("wantedHandle")}
              placeholder="e.g. reza" autoCapitalize="none" spellCheck="false" maxLength={40} />
          </label>
          <label className="lbl">Anything else <span className="hint">optional</span>
            <textarea className="field" rows={3} value={f.note} onChange={set("note")}
              placeholder="Which series you race, what you want to work on" maxLength={500} />
          </label>
          {err && <div className="err">{err}</div>}
          <button className="btn primary wide" type="submit" disabled={busy}>
            {busy ? "Sending…" : "Send the request"}
          </button>
        </form>
        <div className="signin-alt">
          <button className="link" onClick={onBack}>Back to sign in</button>
        </div>
      </div>
    </div>
  );
}

/* Signed in, but Riki has not let them into the trainer yet. */
function Waiting({ account, onRecheck, onSignOut }) {
  const [busy, setBusy] = useState(false);
  const first = String(account.full_name || account.handle).split(" ")[0];
  return (
    <div className="signin">
      <div className="signin-inner narrow">
        <img src={VCASO_LOGO} alt="VCASO Performance" className="vcaso-logo" />
        <h1 className="h1 centre">Not yet, {first}</h1>
        <p className="lede centre">
          Your login works, but Riki has not switched the brake trainer on for you
          yet. He can see you in his list. Message him if it is urgent.
        </p>
        <button className="btn primary wide" disabled={busy}
          onClick={async () => { setBusy(true); await onRecheck(); setBusy(false); }}>
          {busy ? "Checking…" : "Check again"}
        </button>
        <div className="signin-alt">
          <button className="link" onClick={onSignOut}>Sign out</button>
        </div>
      </div>
    </div>
  );
}

/* ---------------- Account ---------------- */
function Account({ account, onLeaderboard, onSignOut, onBack }) {
  const [pw, setPw] = useState("");
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  const change = async (e) => {
    e.preventDefault();
    if (pw.length < 8) { setErr("Make it at least 8 characters."); return; }
    setBusy(true); setErr(""); setMsg("");
    try {
      await cloud.changePassword(pw);
      setPw(""); setMsg("Password changed. Use the new one next time.");
    } catch (e2) { setErr(String(e2?.message || e2)); }
    setBusy(false);
  };

  return (
    <div className="cal">
      <div className="topbar">
        <h1 className="wordmark sm">Account</h1>
        <button className="btn sm" onClick={onBack}>Back to garage</button>
      </div>

      <div className="panelbox">
        <h2 className="h2">Signed in as</h2>
        <p className="big-name">{account?.full_name || account?.handle}</p>
        <p className="fine">
          Username <span className="num">{account?.handle}</span>
          {account?.role === "coach" ? " · coach" : ""}
        </p>
      </div>

      <div className="panelbox">
        <h2 className="h2">Leaderboard</h2>
        <label className="check big-check">
          <input type="checkbox" checked={!!account?.on_leaderboard}
            onChange={(e) => onLeaderboard(e.target.checked)} />
          Show my name and scores on the leaderboard
        </label>
        <p className="fine">
          Turn this off and you disappear from every board for everyone. Your runs
          are still saved and Riki can still see them — this only controls whether
          other drivers see you ranked.
        </p>
      </div>

      <div className="panelbox">
        <h2 className="h2">Change your password</h2>
        <form onSubmit={change} className="inline-form">
          <input className="field" type="password" value={pw} minLength={8}
            autoComplete="new-password" placeholder="New password, 8 characters or more"
            onChange={(e) => setPw(e.target.value)} />
          <button className="btn" type="submit" disabled={busy || pw.length < 8}>
            {busy ? "Changing…" : "Change"}
          </button>
        </form>
        {msg && <p className="ok-note">{msg}</p>}
        {err && <div className="err">{err}</div>}
        <p className="fine">
          Worth doing once, so the password Riki messaged you is no longer the one
          that opens your account.
        </p>
      </div>

      <div className="cal-actions">
        <button className="btn" onClick={onSignOut}>Sign out</button>
      </div>
    </div>
  );
}

/* ---------------- Access requests (coach only) ----------------
   Approving creates the login server-side and hands back a password once.
   It is never stored in readable form, so if this screen is closed before
   it is copied, the only way back is to issue a new one. */
function Requests({ onBack }) {
  const [rows, setRows] = useState(null);
  const [drivers, setDrivers] = useState([]);
  const [err, setErr] = useState("");
  const [busyId, setBusyId] = useState("");
  const [issued, setIssued] = useState(null);
  const [handles, setHandles] = useState({});
  const [copied, setCopied] = useState(false);

  const suggest = (name, wanted) =>
    wanted || String(name).trim().toLowerCase().split(/\s+/)[0].replace(/[^a-z0-9]/g, "");

  const load = useCallback(async () => {
    setErr("");
    try {
      const [r, d] = await Promise.all([cloud.pendingRequests(), cloud.drivers()]);
      setRows(r);
      setDrivers(d);
      setHandles(Object.fromEntries(r.map((x) => [x.id, suggest(x.full_name, x.wanted_handle)])));
    } catch (e) { setErr(String(e?.message || e)); setRows([]); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const approve = async (row) => {
    const handle = (handles[row.id] || "").trim().toLowerCase();
    if (!/^[a-z][a-z0-9]{1,19}$/.test(handle)) {
      setErr("Username must start with a letter, then letters or numbers only, 2 to 20 characters.");
      return;
    }
    setBusyId(row.id); setErr("");
    try {
      const out = await cloud.approve(row.id, handle, row.full_name);
      setIssued({ handle: out.handle, password: out.password, name: row.full_name, existed: out.existed });
      setCopied(false);
      await load();
    } catch (e) { setErr(String(e?.message || e)); }
    setBusyId("");
  };

  const decline = async (row) => {
    setBusyId(row.id); setErr("");
    try { await cloud.decline(row.id); await load(); }
    catch (e) { setErr(String(e?.message || e)); }
    setBusyId("");
  };

  const reissue = async (d) => {
    setBusyId(d.id); setErr("");
    try {
      const out = await cloud.newPassword(d.id);
      setIssued({ handle: out.handle, password: out.password, name: d.full_name || d.handle, reissued: true });
      setCopied(false);
    } catch (e) { setErr(String(e?.message || e)); }
    setBusyId("");
  };

  const copy = async (text) => {
    try { await navigator.clipboard.writeText(text); setCopied(true); }
    catch { setCopied(false); }
  };

  if (issued) {
    const message =
      "Brake Trainer is ready for you.\n\n" +
      "Open: https://rikichristo.github.io/brake-trainer/\n" +
      `Username: ${issued.handle}\n` +
      `Password: ${issued.password}\n\n` +
      "Change the password once you are in, under Account.";
    return (
      <div className="cal">
        <div className="topbar">
          <h1 className="wordmark sm">{issued.reissued ? "New password" : "Approved"}</h1>
          <button className="btn sm" onClick={() => setIssued(null)}>Back to the list</button>
        </div>
        <div className="panelbox">
          <h2 className="h2">{issued.name}</h2>
          <p className="lede">
            Send this to them now. The password is not stored anywhere readable, so
            once you leave this screen the only option is to issue a new one.
          </p>
          <pre className="issued num">{message}</pre>
          <div className="cal-actions">
            <button className="btn primary" onClick={() => copy(message)}>
              {copied ? "Copied" : "Copy the message"}
            </button>
            <button className="btn" onClick={() => copy(issued.password)}>Copy just the password</button>
          </div>
          {issued.existed && (
            <p className="fine">
              That username already existed, so their old password has been replaced
              by this one.
            </p>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="cal">
      <div className="topbar">
        <h1 className="wordmark sm">Access requests</h1>
        <div className="dock-actions">
          <button className="btn sm" onClick={load}>Refresh</button>
          <button className="btn sm" onClick={onBack}>Back to garage</button>
        </div>
      </div>

      {err && <div className="err">{err}</div>}

      {rows === null && <p className="lede">Loading…</p>}
      {rows && rows.length === 0 && (
        <p className="lede">
          Nobody is waiting. Requests appear here when a driver asks from the sign-in
          screen, with their name and how to reach them.
        </p>
      )}

      {rows && rows.length > 0 && (
        <ul className="reqs">
          {rows.map((r) => (
            <li className="req" key={r.id}>
              <div className="req-main">
                <span className="req-name">{r.full_name}</span>
                {r.contact && <span className="req-contact">{r.contact}</span>}
                {r.note && <p className="req-note">{r.note}</p>}
                <span className="fine">
                  Asked {new Date(r.created_at).toLocaleDateString()} at{" "}
                  {new Date(r.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                </span>
              </div>
              <div className="req-act">
                <label className="lbl tight">Username
                  <input className="field sm" value={handles[r.id] ?? ""}
                    autoCapitalize="none" spellCheck="false"
                    onChange={(e) => setHandles((p) => ({ ...p, [r.id]: e.target.value }))} />
                </label>
                <button className="btn primary sm" disabled={busyId === r.id}
                  onClick={() => approve(r)}>
                  {busyId === r.id ? "Working…" : "Approve"}
                </button>
                <button className="btn sm" disabled={busyId === r.id} onClick={() => decline(r)}>
                  Decline
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <div className="block">
        <h2 className="h2">Everyone with a trainer login</h2>
        <table className="tbl">
          <thead>
            <tr><th>Driver</th><th>Username</th><th>Trainer</th><th>Board</th><th /></tr>
          </thead>
          <tbody>
            {drivers.map((d) => (
              <tr key={d.id}>
                <td>{(d.full_name || d.handle) + (d.role === "coach" ? " · coach" : "")}</td>
                <td className="num dim">{d.handle}</td>
                <td>
                  <label className="check">
                    <input type="checkbox" checked={!!d.approved}
                      onChange={async (e) => {
                        const on = e.target.checked;
                        setDrivers((p) => p.map((x) => (x.id === d.id ? { ...x, approved: on } : x)));
                        try { await cloud.setApproved(d.id, on); }
                        catch (e2) {
                          setErr(String(e2?.message || e2));
                          setDrivers((p) => p.map((x) => (x.id === d.id ? { ...x, approved: !on } : x)));
                        }
                      }} />
                    in
                  </label>
                </td>
                <td className="dim">{d.on_leaderboard ? "shown" : "hidden"}</td>
                <td className="log-act">
                  <button className="btn sm" disabled={busyId === d.id} onClick={() => reissue(d)}>
                    New password
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="fine">
          Turning someone off here blocks the trainer for them immediately, without
          touching their hub login.
        </p>
      </div>
    </div>
  );
}

/* ---------------- Leaderboard ---------------- */
function Leaderboard({ lapKey, lapLabel, onBack }) {
  const [tab, setTab] = useState("lap");
  const [lapRows, setLapRows] = useState(null);
  const [allRows, setAllRows] = useState(null);
  const [err, setErr] = useState("");

  useEffect(() => {
    let gone = false;
    (async () => {
      try {
        const [a, b] = await Promise.all([cloud.board(lapKey), cloud.boardOverall()]);
        if (gone) return;
        setLapRows(a); setAllRows(b);
      } catch (e) {
        if (!gone) { setErr(String(e?.message || e)); setLapRows([]); setAllRows([]); }
      }
    })();
    return () => { gone = true; };
  }, [lapKey]);

  const rows = tab === "lap" ? lapRows : allRows;

  return (
    <div className="cal">
      <div className="topbar">
        <h1 className="wordmark sm">Leaderboard</h1>
        <button className="btn sm" onClick={onBack}>Back to garage</button>
      </div>

      <div className="cats">
        <button className={`cat ${tab === "lap" ? "on" : ""}`} onClick={() => setTab("lap")}>
          This drill
        </button>
        <button className={`cat ${tab === "all" ? "on" : ""}`} onClick={() => setTab("all")}>
          All round
        </button>
      </div>
      <p className="cat-note">
        {tab === "lap"
          ? lapLabel
          : "Each driver's average of their best score on every drill they have run."}
      </p>

      {err && <div className="err">{err}</div>}
      {rows === null && <p className="lede">Loading…</p>}

      {rows && rows.length === 0 && (
        <p className="lede">
          {tab === "lap" ? "No scores on this drill yet. Be the first." : "No scores yet."}
        </p>
      )}

      {rows && rows.length > 0 && (
        <table className="tbl board">
          <thead>
            {tab === "lap" ? (
              <tr><th>#</th><th>Driver</th><th>Best</th><th>Runs</th><th>Last</th></tr>
            ) : (
              <tr><th>#</th><th>Driver</th><th>Average</th><th>Best</th><th>Drills</th><th>Runs</th></tr>
            )}
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={`${r.display_name}-${i}`} className={r.is_me ? "me" : ""}>
                <td className="num dim">{i + 1}</td>
                <td>{(r.display_name || "Driver") + (r.is_me ? " · you" : "")}</td>
                {tab === "lap" ? (
                  <>
                    <td className="num">{Math.round(r.best)}</td>
                    <td className="num dim">{r.runs}</td>
                    <td className="dim">{new Date(r.last_at).toLocaleDateString()}</td>
                  </>
                ) : (
                  <>
                    <td className="num">{Number(r.avg_best).toFixed(1)}</td>
                    <td className="num dim">{Math.round(r.best)}</td>
                    <td className="num dim">{r.laps}</td>
                    <td className="num dim">{r.runs}</td>
                  </>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <p className="fine">
        Only drivers who have left themselves on the board appear here. Anyone can
        turn that off under Account without losing their own history.
      </p>
    </div>
  );
}

/* ---------------- Driver profiles ----------------
   A profile, not an account. Nothing here is a security boundary: this page
   runs from a file on the machine in front of you, so there is no server to
   check a password against and anyone holding the file holds the data. What
   a profile does is keep each driver's feel settings, personal bests and run
   history apart, and stamp every run with who drove it. */
const DRIVERS_KEY = "bt:drivers";
const LAST_DRIVER_KEY = "bt:lastDriver";

const loadDrivers = () => {
  const v = store.get(DRIVERS_KEY);
  return Array.isArray(v) ? v : [];
};

function addDriver(name) {
  const clean = String(name).trim().slice(0, 32);
  const drivers = loadDrivers();
  const existing = drivers.find((d) => d.name.toLowerCase() === clean.toLowerCase());
  if (existing) return existing;
  const d = { id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`, name: clean };
  store.set(DRIVERS_KEY, [...drivers, d]);
  return d;
}

function removeDriver(id) {
  store.set(DRIVERS_KEY, loadDrivers().filter((d) => d.id !== id));
  store.remove(`bt:feel:${id}`);
  store.remove(`bt:bests:${id}`);
}

function DriverSelect({ onPick, onBack = null }) {
  const [drivers, setDrivers] = useState(() => loadDrivers());
  const [name, setName] = useState("");
  const [adding, setAdding] = useState(() => loadDrivers().length === 0);
  const cvs = useRef(null);

  const pick = (d) => { store.set(LAST_DRIVER_KEY, d.id); onPick(d); };
  const create = () => {
    if (!name.trim()) return;
    const d = addDriver(name);
    setDrivers(loadDrivers());
    setName(""); setAdding(false);
    pick(d);
  };

  useEffect(() => {
    const lap = LAPS[0];
    const c = cvs.current; if (!c || !lap) return;
    let raf, t = 0;
    const draw = () => {
      const dpr = window.devicePixelRatio || 1;
      const w = c.clientWidth, h = c.clientHeight;
      c.width = w * dpr; c.height = h * dpr;
      const x = c.getContext("2d");
      x.setTransform(dpr, 0, 0, dpr, 0, 0);
      x.clearRect(0, 0, w, h);
      const span = 14;
      x.lineWidth = 1.5;
      x.strokeStyle = "rgba(255,255,255,0.5)";
      x.beginPath();
      for (let i = 0; i <= w; i++) {
        const tt = (t + (i / w) * span) % lap.dur;
        const v = lap.brake[idx(tt)] ?? 0;
        const y = h - 6 - v * (h - 14);
        i === 0 ? x.moveTo(i, y) : x.lineTo(i, y);
      }
      x.stroke();
      t += 0.02;
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div className="signin">
      <div className="signin-inner">
        <img src={VCASO_LOGO} alt="VCASO Performance" className="vcaso-logo" />
        <canvas ref={cvs} className="signin-trace" />
        <h1 className="wordmark">Brake Trainer</h1>
        <p className="lede">
          Follow the reference trace with your own pedals. The screen shows what a
          real lap looked like; your job is to put the same shape underneath it.
        </p>
        {drivers.length > 0 && (
          <ul className="list drivers">
            {drivers.map((d) => (
              <li key={d.id}>
                <button className="item" onClick={() => pick(d)}>
                  <span className="item-name">{d.name}</span>
                  <span className="item-sub num">
                    {loadRunIndex().filter((r) => r.driver === d.name).length} runs
                  </span>
                </button>
                <button className="x" title={`Remove ${d.name}`}
                  onClick={() => { removeDriver(d.id); setDrivers(loadDrivers()); }}>×</button>
              </li>
            ))}
          </ul>
        )}

        {adding ? (
          <div className="row">
            <input
              className="field" value={name} placeholder="Driver name" autoFocus
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && create()}
            />
            <button className="btn primary" disabled={!name.trim()} onClick={create}>Start</button>
            {drivers.length > 0 && (
              <button className="btn ghost" onClick={() => { setAdding(false); setName(""); }}>Cancel</button>
            )}
          </div>
        ) : (
          <button className="btn ghost wide" onClick={() => setAdding(true)}>Add a driver</button>
        )}

        <p className="fine">
          A profile keeps each driver's settings, bests and run history separate,
          and stamps every run with who drove it. It is not a password — anyone
          who can open this page can open any profile. Nothing here leaves this
          machine, so there is no leaderboard and Riki cannot see these runs.
          Sign in with an account for that.
        </p>
        {onBack && (
          <div className="signin-alt">
            <button className="link" onClick={onBack}>Sign in with an account instead</button>
          </div>
        )}
      </div>
    </div>
  );
}

/* ---------------- Garage ---------------- */
function Garage({
  driver, account, syncNote, onSwitchDriver, cat, setCat, all, lapId, setLapId, fullLap,
  drills, drillId, setDrillId, lap, cal, keyboard, setKeyboard, best, onImport, lapWarn,
  onDeleteLap, brakeOnly, setBrakeOnly, onCalibrate, onFeel, onLogbook, onRenameZone,
  onAccount, onRequests, onBoard, onStart,
}) {
  const [pending, setPending] = useState(0);
  const [pads, setPads] = useState([]);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState("");
  const [confirmDel, setConfirmDel] = useState(null);
  const fileRef = useRef(null);

  useEffect(() => {
    const scan = () => {
      const list = navigator.getGamepads ? Array.from(navigator.getGamepads()).filter(Boolean) : [];
      setPads(list.map((p) => ({ index: p.index, id: p.id, axes: p.axes.length })));
    };
    scan();
    const iv = setInterval(scan, 800);
    window.addEventListener("gamepadconnected", scan);
    return () => { clearInterval(iv); window.removeEventListener("gamepadconnected", scan); };
  }, []);

  /* Riki asked to be told when someone requests access. Without an email
     provider wired up that means showing him the count wherever he already
     looks, so the garage carries it and refreshes while the page is open. */
  useEffect(() => {
    if (account?.role !== "coach" || !cloud.ready()) return;
    let gone = false;
    const check = async () => {
      try { const r = await cloud.pendingRequests(); if (!gone) setPending(r.length); }
      catch { /* offline, leave the count alone */ }
    };
    check();
    const iv = setInterval(check, 60000);
    return () => { gone = true; clearInterval(iv); };
  }, [account?.role]);

  const mapped = calMapped(cal);
  const missing = mapped ? calMissing(cal, pads) : [];
  const linked = mapped && missing.length === 0;
  const ready = linked || keyboard;
  const devNames = mapped ? calDevices(cal).map(shortId) : [];
  const cats = CATEGORY_ORDER.map((k) => CATEGORIES[k]);
  const lapList = all.filter((l) => l.meta.category === cat);

  const handleFile = async (f) => {
    if (!f) return;
    setErr(""); setBusy(`Reading ${f.name}…`);
    // Let the browser paint the busy line before the parse blocks the thread.
    await new Promise((r) => setTimeout(r, 30));
    try {
      const isIbt = /\.ibt$/i.test(f.name);
      const l = isIbt
        ? parseIBT(await f.arrayBuffer(), f.name, null)
        : parseTelemetry(await f.text(), f.name, cat);
      onImport(l);
    } catch (e) {
      setErr(e.message || "Could not read that file.");
    } finally {
      setBusy("");
    }
  };

  return (
    <div className="garage">
      <img src={VCASO_LOGO} alt="VCASO Performance" className="vcaso-logo top" />
      <header className="top">
        <span className="wordmark sm">Brake Trainer</span>
        <div className="dock-actions">
          {onBoard && <button className="btn ghost sm" onClick={onBoard}>Leaderboard</button>}
          {onRequests && (
            <button className="btn ghost sm" onClick={onRequests}>
              Requests{pending > 0 ? ` (${pending})` : ""}
            </button>
          )}
          {onAccount && <button className="btn ghost sm" onClick={onAccount}>Account</button>}
          <button className="who-btn" onClick={onSwitchDriver}>
            {driver?.name}
            <span className="who-sub">{driver?.cloud ? "sign out" : "switch driver"}</span>
          </button>
        </div>
      </header>
      {syncNote && <p className="err">{syncNote}</p>}

      <div className="cats">
        {cats.map((c) => {
          const n = all.filter((l) => l.meta.category === c.key).length;
          return (
            <button key={c.key} className={`cat ${cat === c.key ? "on" : ""} ${n ? "" : "empty"}`}
              onClick={() => {
                setCat(c.key);
                const first = all.find((l) => l.meta.category === c.key);
                if (first) { setLapId(first.id); setDrillId("corners"); }
              }}>
              {c.name}
            </button>
          );
        })}
      </div>
      <p className="cat-note">{CATEGORIES[cat].note}</p>

      {lapList.length === 0 ? (
        <div className="empty">
          <h2 className="h1">No laps in this class yet</h2>
          <p className="lede">
            Drive a session in an {CATEGORIES[cat].name} car and export the telemetry,
            or import a lap from another source below.
          </p>
          <button className="btn ghost" onClick={() => fileRef.current?.click()}>Import telemetry</button>
          <input ref={fileRef} type="file" accept=".ibt,.csv,.txt,.json,.tsv" className="hidden"
            onChange={(e) => handleFile(e.target.files?.[0])} />
          {busy && <p className="fine">{busy}</p>}
          {err && <p className="err">{err}</p>}
        </div>
      ) : (
      <div className="cols">
        <section className="col">
          <h2 className="h2">Reference lap</h2>
          <ul className="list">
            {lapList.map((l) => (
              <li key={l.id}>
                <button className={`item ${lapId === l.id ? "on" : ""}`}
                  onClick={() => { setLapId(l.id); setDrillId("corners"); }}>
                  <span className="item-name">{lapLabel(l)}</span>
                  <span className="item-sub num">{fmtLapTime(l.meta.lapTime)}</span>
                </button>
                {l.meta.imported && (
                  <button className={`x ${confirmDel === l.id ? "armed" : ""}`}
                    title={`Remove ${lapLabel(l)}`}
                    onClick={() => {
                      if (confirmDel === l.id) { onDeleteLap(l.id); setConfirmDel(null); }
                      else setConfirmDel(l.id);
                    }}>
                    {confirmDel === l.id ? "sure?" : "\u00d7"}
                  </button>
                )}
              </li>
            ))}
          </ul>
          <p className="fine">
            {fullLap.meta.imported
              ? `Imported · ${fullLap.meta.note ?? ""}`
              : `${fullLap.meta.driver}, ${fullLap.meta.car}` +
                (fullLap.meta.config ? ` · ${fullLap.meta.config}` : "")}
          </p>
          {lapWarn && <p className="err">{lapWarn}</p>}
          <button className="btn ghost wide" disabled={!!busy} onClick={() => fileRef.current?.click()}>Import telemetry (.ibt, CSV, JSON)</button>
          <input ref={fileRef} type="file" accept=".ibt,.csv,.txt,.json,.tsv" className="hidden"
            onChange={(e) => handleFile(e.target.files?.[0])} />
          {busy && <p className="fine">{busy}</p>}
          {err && <p className="err">{err}</p>}
        </section>

        <section className="col">
          <h2 className="h2">Session</h2>
          <ul className="list">
            {drills.map((d) => (
              <li key={d.id}>
                <button className={`item ${drillId === d.id ? "on" : ""}`} onClick={() => setDrillId(d.id)}>
                  <span className="item-name">{d.name}</span>
                  <span className="item-sub">{d.sub}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>

        <section className="col wide-col">
          <h2 className="h2">Reference</h2>
          <TracePreview lap={lap} />
          <div className="meta">
            <span className="num">{lap.dur.toFixed(0)}s</span>
            <span className="num">{(lap.zones ?? []).length || findZones(lap.brake).length} braking zones</span>
            {best !== undefined && <span className="num best">Best {best}</span>}
          </div>
          {(fullLap.zones ?? []).length > 0 && (
            <div className="corners">
              <p className="fine" style={{ margin: "14px 0 8px" }}>
                Braking zones, in lap order. Rename any that are wrong — the name sticks.
              </p>
              {fullLap.zones.map((z, i) => (
                <div className="corner-row" key={i}>
                  <span className="corner-at num">{z.at}m</span>
                  <input
                    className="corner-name" defaultValue={z.name}
                    id={`zone-${fullLap.id}-${i}`}
                    onBlur={(e) => { if (e.target.value !== z.name) onRenameZone(i, e.target.value); }}
                    onKeyDown={(e) => { if (e.key === "Enter") e.target.blur(); }}
                  />
                  <span className="corner-peak num">{Math.round(z.peak * 100)}%</span>
                  <span className="corner-sp num">{z.speedIn}&rarr;{z.speedMin}</span>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
      )}

      <footer className="dock">
        <div className="dev">
          <span className={`dot ${ready ? "live" : ""}`} />
          <div>
            <div className="dev-name">
              {linked ? devNames.join("  +  ")
                : missing.length ? `${missing.map(shortId).join(" and ")} not connected`
                : keyboard ? "Keyboard practice mode"
                : "No pedals linked"}
            </div>
            <div className="dev-sub">
              {linked ? `Brake, throttle and steering mapped across ${devNames.length} device${devNames.length > 1 ? "s" : ""}`
                : missing.length ? "Reconnect it, or recalibrate to map the controls again"
                : pads.length ? `${pads.length} device${pads.length > 1 ? "s" : ""} detected — needs mapping`
                : "Press a pedal or button to wake the wheelbase"}
            </div>
          </div>
        </div>
        <div className="dock-actions">
          <label className="check" title="Hide the throttle and steering traces and score the brake alone">
            <input type="checkbox" checked={!!brakeOnly}
              onChange={(e) => setBrakeOnly(e.target.checked)} />
            <span>Brake only</span>
          </label>
          <label className="check">
            <input type="checkbox" checked={keyboard} onChange={(e) => setKeyboard(e.target.checked)} />
            <span>Keyboard</span>
          </label>
          <button className="btn ghost" onClick={onLogbook}>Logbook</button>
          <button className="btn ghost" disabled={!linked && !keyboard} onClick={onFeel}>Feel</button>
          <button className="btn ghost" onClick={onCalibrate}>{linked ? "Recalibrate" : "Link pedals"}</button>
          <button className="btn primary" disabled={!ready} onClick={onStart}>Run session</button>
        </div>
      </footer>
    </div>
  );
}

function TracePreview({ lap }) {
  const cvs = useRef(null);
  useEffect(() => {
    const c = cvs.current; if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth, h = c.clientHeight;
    c.width = w * dpr; c.height = h * dpr;
    const x = c.getContext("2d");
    x.setTransform(dpr, 0, 0, dpr, 0, 0);
    x.clearRect(0, 0, w, h);
    const lanes = [
      { arr: lap.brake, signed: false, y: 0, h: h * 0.42 },
      { arr: lap.throttle, signed: false, y: h * 0.46, h: h * 0.24 },
      { arr: lap.steer, signed: true, y: h * 0.74, h: h * 0.26 },
    ];
    for (const L of lanes) {
      x.beginPath();
      for (let i = 0; i <= w; i++) {
        const s = Math.floor((i / w) * (lap.n - 1));
        const v = L.signed ? (L.arr[s] + 1) / 2 : L.arr[s];
        const y = L.y + L.h - v * L.h;
        i === 0 ? x.moveTo(i, y) : x.lineTo(i, y);
      }
      x.strokeStyle = "rgba(255,255,255,0.72)";
      x.lineWidth = 1.25;
      x.stroke();
      x.lineTo(w, L.y + L.h); x.lineTo(0, L.y + L.h); x.closePath();
      x.fillStyle = "rgba(255,255,255,0.05)";
      x.fill();
    }
  }, [lap]);
  return <canvas ref={cvs} className="preview" />;
}

/* ---------------- Feel ----------------
   Tuning the rig against the reference, with the controls live so a change
   can be judged by hand rather than by number. */
function Feel({ cal, feel, setFeel, keyboard, onDone }) {
  const read = useInputDevice(cal, keyboard, feel);
  const [v, setV] = useState({ brake: 0, throttle: 0, steer: 0 });
  const [raw, setRaw] = useState({ steer: 0, brake: 0 });

  useEffect(() => {
    let raf;
    const loop = () => {
      setV(read());
      const pads = padsNow();
      setRaw({
        steer: readAxis(pads, cal.steer, true) ?? 0,
        brake: readAxis(pads, cal.brake, false) ?? 0,
      });
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [read, cal]);

  const set = (k, n) => setFeel({ ...feel, [k]: n });
  const Bar = ({ label, value, signed, sub }) => (
    <div className="feel-row">
      <span className="feel-label">{label}</span>
      <div className="feel-track">
        {signed && <div className="feel-mid" />}
        <div className="feel-fill" style={signed
          ? { left: `${Math.min(50, 50 + value * 50)}%`, width: `${Math.abs(value) * 50}%` }
          : { left: 0, width: `${clamp(value, 0, 1) * 100}%` }} />
      </div>
      <span className="feel-val num">{signed ? (value * 100).toFixed(0) : `${(value * 100).toFixed(0)}%`}</span>
      <span className="feel-sub num">{sub}</span>
    </div>
  );

  return (
    <div className="cal">
      <header className="top">
        <span className="wordmark sm">Feel</span>
        <button className="btn primary sm" onClick={onDone}>Done</button>
      </header>

      <div className="cal-body">
        <div className="cal-left">
          <h2 className="h2">Steering ratio</h2>
          <p className="lede">
            Your wheelbase turns through a far bigger angle than the car the
            reference came from. Raise this until a corner takes about the
            amount of lock it would take in the car — the trace should reach
            full height without you winding on half a turn.
          </p>
          <div className="slider">
            <input type="range" min="0.5" max="4" step="0.05" id="steerGain"
              value={feel.steerGain}
              onChange={(e) => set("steerGain", Number(e.target.value))} />
            <span className="num">{feel.steerGain.toFixed(2)}×</span>
          </div>

          <h2 className="h2" style={{ marginTop: 26 }}>Brake range</h2>
          <p className="lede">
            How much pressure counts as 100%. If your peak goes flat along the
            top of the trace, you are pressing harder than calibration recorded
            and the shape is being cut off — raise this until the hardest stop
            reaches full scale without flattening. Press the brake as hard as
            you would at the end of a straight and watch the bar below.
          </p>
          <div className="slider">
            <input type="range" min="0.6" max="2.5" step="0.05" id="brakeRange"
              value={feel.brakeRange}
              onChange={(e) => set("brakeRange", Number(e.target.value))} />
            <span className="num">{feel.brakeRange.toFixed(2)}×</span>
          </div>

          <h2 className="h2" style={{ marginTop: 26 }}>Brake response</h2>
          <p className="lede">
            A load cell does not read the way pressure feels, and the reference
            is the car's own brake signal. Below 1.00 makes the first part of
            the travel count for more; above 1.00 for less. Leave it at 1.00
            unless the numbers disagree with your feet.
          </p>
          <div className="slider">
            <input type="range" min="0.5" max="2" step="0.05" id="brakeCurve"
              value={feel.brakeCurve}
              onChange={(e) => set("brakeCurve", Number(e.target.value))} />
            <span className="num">{feel.brakeCurve.toFixed(2)}</span>
          </div>

          <h2 className="h2" style={{ marginTop: 26 }}>Steering deadzone</h2>
          <div className="slider">
            <input type="range" min="0" max="0.1" step="0.005" id="steerDeadzone"
              value={feel.steerDeadzone}
              onChange={(e) => set("steerDeadzone", Number(e.target.value))} />
            <span className="num">{(feel.steerDeadzone * 100).toFixed(1)}%</span>
          </div>

          <div className="cal-actions">
            <button className="btn ghost" onClick={() => setFeel(BLANK_FEEL)}>Reset to default</button>
          </div>
        </div>

        <div className="cal-right">
          <h2 className="h2">Live</h2>
          <Bar label="Brake" value={v.brake}
            sub={v.clipping ? "AT FULL SCALE" : `raw ${raw.brake.toFixed(2)}`} />
          {v.clipping && (
            <p className="err">
              Pinned at 100% — anything harder than this is being cut off.
              Raise the brake range until it stops.
            </p>
          )}
          <Bar label="Throttle" value={v.throttle} sub="" />
          <Bar label="Steering" value={v.steer} signed sub={`raw ${raw.steer.toFixed(2)}`} />
          <p className="fine">
            Turn the wheel the amount you would through a medium corner. If the
            steering bar barely moves, raise the ratio. If it pins to the end
            before your hands have gone anywhere, lower it.
          </p>
        </div>
      </div>
    </div>
  );
}

/* ---------------- Calibration ---------------- */
const STEPS = [
  { key: "wake", label: "Wake everything up", help: "Press each pedal to the floor once, and press a button on the wheel. A browser hides a controller until it sends its first input, and pedals wired to their own board stay invisible until then. Every device you use has to be listed on the right before the next step." },
  { key: "rest", label: "Hands and feet off", help: "Let the wheel centre and both pedals return. This records the resting position of every axis on every device." },
  { key: "brake", label: "Press the brake fully", help: "Press it all the way down and let it back up. On a load cell, use the pressure you would actually reach at the end of a straight — that value becomes your 100%. You do not need to hold it while you click." },
  { key: "throttle", label: "Press the throttle fully", help: "All the way to the stop, then release." },
  { key: "steer", label: "Turn the wheel fully right", help: "All the way to the lock you use in the sim, then back to centre. Use full lock — this value sets what counts as 100% steering." },
];

/* Some boards report a hat switch or an unused channel in the axes array with
   values outside -1..1. They are not analog controls, so they never win the
   "what moved most" test. */
const isAnalog = (v) => Number.isFinite(v) && Math.abs(v) <= 1.05;

const shortId = (id) => (id || "").replace(/\s*\((Vendor|STANDARD).*$/i, "").trim().slice(0, 44) || "Unnamed device";
const ROLE_LABEL = { brake: "brake", throttle: "throttle", steer: "steering" };

function Calibrate({ cal, onSave, onCancel }) {
  const [step, setStep] = useState(0);
  const [rest, setRest] = useState(null);
  const [draft, setDraft] = useState(BLANK_CAL);
  const [devices, setDevices] = useState([]);
  const [hint, setHint] = useState("");
  const [candidate, setCandidate] = useState(null);
  const live = useRef([]);

  /* Each step records the furthest an axis travelled from its baseline while
     the step was open, not wherever it happens to sit when the button is
     clicked. Holding a pedal flat with one foot while reaching for the mouse
     is awkward, and letting go first should not throw the reading away. */
  const peaks = useRef({});
  const restRef = useRef(null);
  const stepRef = useRef(0);
  useEffect(() => { restRef.current = rest; }, [rest]);
  useEffect(() => { stepRef.current = step; peaks.current = {}; setCandidate(null); }, [step]);

  // Every connected device is polled at once — the control being pressed
  // may be on any of them, and the rig decides, not the app.
  useEffect(() => {
    let raf, frame = 0;
    const loop = () => {
      const list = padsNow().map((p) => ({ index: p.index, id: p.id, axes: Array.from(p.axes) }));
      live.current = list;

      const base = restRef.current;
      const s = STEPS[stepRef.current];
      if (base && s && s.key !== "wake" && s.key !== "rest") {
        for (const d of list) {
          const b = base.find((r) => r.index === d.index && r.id === d.id);
          if (!b) continue;
          const k = d.index + "|" + d.id;
          let arr = peaks.current[k];
          if (!arr) arr = peaks.current[k] = d.axes.map(() => null);
          for (let i = 0; i < d.axes.length; i++) {
            if (!isAnalog(d.axes[i]) || !isAnalog(b.axes[i])) continue;
            const delta = Math.abs(d.axes[i] - b.axes[i]);
            if (!arr[i] || delta > arr[i].delta) {
              arr[i] = { delta, full: d.axes[i], rest: b.axes[i], padIndex: d.index, padId: d.id, axis: i };
            }
          }
        }
      }

      if (frame++ % 3 === 0) {
        setDevices(list);
        setCandidate(bestPeak());
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  /* The strongest movement seen so far this step, ignoring axes already
     claimed by an earlier one. */
  const bestPeak = () => {
    let best = null;
    for (const arr of Object.values(peaks.current)) {
      for (const p of arr) {
        if (!p) continue;
        if (CHANNELS.some((k) => draftRef.current[k]
          && draftRef.current[k].padIndex === p.padIndex
          && draftRef.current[k].axis === p.axis)) continue;
        if (!best || p.delta > best.delta) best = p;
      }
    }
    return best;
  };

  const draftRef = useRef(draft);
  useEffect(() => { draftRef.current = draft; }, [draft]);

  const reset = () => {
    setStep(0); setRest(null); setDraft(BLANK_CAL); setHint("");
    peaks.current = {}; setCandidate(null);
  };

  const capture = () => {
    const cur = live.current;
    if (!cur.length) return;
    const s = STEPS[step];

    if (s.key === "wake") { setStep(step + 1); setHint(""); return; }

    if (s.key === "rest") {
      setRest(cur.map((d) => ({ index: d.index, id: d.id, axes: [...d.axes] })));
      setStep(step + 1); setHint("");
      return;
    }
    if (!rest) return;

    /* A device that first appears partway through has no resting position on
       record, and its axes are being held away from rest right now, so there
       is nothing to measure against. This is the usual reason a pedal set on
       its own board goes undetected: the browser only reveals it when a pedal
       is pressed, which is after the baseline was taken. */
    const unseen = cur.filter((d) => !rest.some((r) => r.index === d.index && r.id === d.id));
    if (unseen.length) {
      setHint(`${shortId(unseen[0].id)} only appeared just now, so its resting position was never recorded. Start over — this time press every pedal during the first step.`);
      return;
    }

    /* The furthest travel seen since this step opened — not whatever the axis
       happens to read at this instant. Axes already claimed are skipped rather
       than flagged as a conflict: a foot resting on the throttle while the
       wheel is turned is normal, and would otherwise outvote the real control. */
    const best = bestPeak();

    if (!best || best.delta < 0.18) {
      setHint("Nothing moved far enough. Press the control all the way to its stop — you can let go again before clicking.");
      return;
    }
    setDraft((p) => ({
      ...p,
      [s.key]: { padIndex: best.padIndex, padId: best.padId, axis: best.axis, rest: best.rest, full: best.full },
    }));
    setHint(""); setStep(step + 1);
  };

  const done = step >= STEPS.length;
  const mappedDevices = calDevices(draft);

  return (
    <div className="cal">
      <header className="top">
        <span className="wordmark sm">Link your pedals</span>
        <button className="btn ghost sm" onClick={onCancel}>Back</button>
      </header>

      {devices.length === 0 ? (
        <div className="empty">
          <h2 className="h1">Nothing detected yet</h2>
          <p className="lede">
            Browsers hide a wheel or pedal set until it sends its first input.
            Press a pedal or a wheel button now and it will appear here.
          </p>
          <p className="fine">
            Pedals on their own USB connection show up as a second device, which is normal.
            Chrome also needs the page on https, localhost, or a local file.
          </p>
        </div>
      ) : (
        <div className="cal-body">
          <div className="cal-left">
            <ol className="steps">
              {STEPS.map((s, i) => (
                <li key={s.key} className={`step ${i === step ? "on" : ""} ${i < step ? "did" : ""}`}>
                  <span className="step-n num">{i + 1}</span>
                  <div>
                    <div className="step-label">{s.label}</div>
                    {i === step && <div className="step-help">{s.help}</div>}
                    {i === step && s.key !== "wake" && s.key !== "rest" && (
                      <div className={`step-live ${candidate && candidate.delta >= 0.18 ? "ok" : ""}`}>
                        {candidate && candidate.delta >= 0.18
                          ? `Got it — ${shortId(candidate.padId)}, axis ${candidate.axis}, travel ${candidate.delta.toFixed(2)}`
                          : candidate
                            ? `Only ${candidate.delta.toFixed(2)} of travel so far — press it further`
                            : "Waiting for movement"}
                      </div>
                    )}
                    {i === step && s.key === "wake" && (
                      <div className="step-help">
                        {devices.length} device{devices.length === 1 ? "" : "s"} visible: {devices.map((d) => shortId(d.id)).join(", ")}
                      </div>
                    )}
                    {i < step && s.key === "wake" && (
                      <div className="step-help">{devices.length} device{devices.length === 1 ? "" : "s"} visible</div>
                    )}
                    {i < step && s.key === "rest" && (
                      <div className="step-help">Baseline recorded across {rest ? rest.length : 0} device{rest && rest.length === 1 ? "" : "s"}</div>
                    )}
                    {i < step && draft[s.key] && (
                      <div className="step-help">
                        {shortId(draft[s.key].padId)}
                        <span className="num"> · axis {draft[s.key].axis} · {draft[s.key].rest.toFixed(2)} → {draft[s.key].full.toFixed(2)}</span>
                      </div>
                    )}
                  </div>
                </li>
              ))}
            </ol>

            {hint && <p className="err">{hint}</p>}

            <div className="cal-actions">
              {!done && (
                <button className="btn primary" onClick={capture}>
                  {STEPS[step].key === "wake" ? "Everything is listed" : "Record this position"}
                </button>
              )}
              {done && <button className="btn primary" onClick={() => onSave(draft)}>Save mapping</button>}
              {step > 0 && <button className="btn ghost" onClick={reset}>Start over</button>}
            </div>

            {done && mappedDevices.length > 1 && (
              <p className="fine">
                Mapped across {mappedDevices.length} devices: {mappedDevices.map(shortId).join(" and ")}.
                Both need to be connected for a session to run.
              </p>
            )}
          </div>

          <div className="cal-right">
            <h2 className="h2">What the browser sees</h2>
            {devices.map((d) => (
              <div key={`${d.index}:${d.id}`} className="dev-block">
                <div className="dev-head">
                  <span className="dev-title">{shortId(d.id)}</span>
                  <span className="dev-count num">{d.axes.length} axes</span>
                </div>
                <div className="axes">
                  {d.axes.map((v, i) => {
                    const role = CHANNELS.find((k) => draft[k] && draft[k].padIndex === d.index && draft[k].axis === i);
                    return (
                      <div key={i} className={`axis ${role ? "mapped" : ""}`}>
                        <span className="axis-n num">{i}</span>
                        <div className="axis-bar"><div className="axis-fill" style={{ left: `${((clamp(v, -1, 1) + 1) / 2) * 100}%` }} /></div>
                        <span className="axis-v num">{v.toFixed(2)}</span>
                        <span className="axis-role">{role ? ROLE_LABEL[role] : ""}</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
            <p className="fine">
              Press each control and watch which bar moves. You do not need to know
              which device is which — recording picks up whichever axis moves.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

/* ---------------- Run ---------------- */
function Run({ lap, cal, keyboard, feel, label, brakeOnly = false, onFinish, onAbort }) {
  const cvs = useRef(null);
  const wrap = useRef(null);
  const readInput = useInputDevice(cal, keyboard, feel);
  const [paused, setPaused] = useState(false);
  const pausedRef = useRef(false);
  const [hud, setHud] = useState({ t: -LEADIN, live: 100, corner: "", fps: 0, frameMs: 0, clip: false });
  const [unfocused, setUnfocused] = useState(false);

  /* A browser throttles animation hard when its window is not focused — on a
     rig with the sim on one screen and this on another, that alone reads as
     heavy input lag. Say so rather than letting it feel like a slow app. */
  useEffect(() => {
    const check = () => setUnfocused(document.hidden || !document.hasFocus());
    check();
    const iv = setInterval(check, 400);
    for (const e of ["focus", "blur", "visibilitychange"]) window.addEventListener(e, check);
    return () => {
      clearInterval(iv);
      for (const e of ["focus", "blur", "visibilitychange"]) window.removeEventListener(e, check);
    };
  }, []);

  const cap = useRef({
    brake: new Float32Array(lap.n),
    throttle: new Float32Array(lap.n),
    steer: new Float32Array(lap.n),
  });
  const lastIdx = useRef(-1);
  const ema = useRef(0);
  const clipSamples = useRef(0);

  useEffect(() => { pausedRef.current = paused; }, [paused]);

  useEffect(() => {
    const k = (e) => {
      if (e.key === "Escape") onAbort();
      if (e.key === " ") { e.preventDefault(); setPaused((p) => !p); }
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onAbort]);

  useEffect(() => {
    const c = cvs.current;
    let raf, t = -LEADIN, last = performance.now(), lastHud = 0;
    let W = 0, H = 0, dpr = 1, fps = 60, frameMs = 0;

    const resize = () => {
      dpr = window.devicePixelRatio || 1;
      W = wrap.current.clientWidth; H = wrap.current.clientHeight;
      c.width = W * dpr; c.height = H * dpr;
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(wrap.current);

    /* Brake-only hands the whole canvas to one trace. The point of hiding the
       other two is not just to clear the screen: a brake shape drawn three
       times taller is a shape you can actually see yourself missing. */
    const lanes = () => {
      const pad = 18, gap = 16;
      if (brakeOnly) {
        return [{ key: "brake", label: "Brake", y: pad, h: H - pad * 2, signed: false }];
      }
      const usable = H - pad * 2 - gap * 2;
      const bh = usable * 0.44, th = usable * 0.28, sh = usable * 0.28;
      return [
        { key: "brake", label: "Brake", y: pad, h: bh, signed: false },
        { key: "throttle", label: "Throttle", y: pad + bh + gap, h: th, signed: false },
        { key: "steer", label: "Steering", y: pad + bh + gap + th + gap, h: sh, signed: true },
      ];
    };

    const errColor = (e) => (e < 0.06 ? C.good : e < 0.15 ? C.warn : C.bad);

    const draw = (now, inp) => {
      const x = c.getContext("2d");
      x.setTransform(dpr, 0, 0, dpr, 0, 0);
      x.fillStyle = C.bg;
      x.fillRect(0, 0, W, H);

      const span = LOOKBACK + LOOKAHEAD;
      const t0 = now - LOOKBACK;
      const tx = (tt) => ((tt - t0) / span) * W;
      const px = tx(now);

      for (const L of lanes()) {
        const vy = (v) => L.y + L.h - (L.signed ? (v + 1) / 2 : v) * L.h;

        // lane frame
        x.strokeStyle = C.line; x.lineWidth = 1;
        x.beginPath(); x.moveTo(0, L.y + L.h + 0.5); x.lineTo(W, L.y + L.h + 0.5); x.stroke();
        if (L.signed) {
          x.strokeStyle = "rgba(255,255,255,0.08)";
          x.beginPath(); x.moveTo(0, vy(0)); x.lineTo(W, vy(0)); x.stroke();
        } else {
          x.strokeStyle = "rgba(255,255,255,0.06)";
          for (const f of [0.25, 0.5, 0.75]) { x.beginPath(); x.moveTo(0, vy(f)); x.lineTo(W, vy(f)); x.stroke(); }
        }

        // reference trace
        const i0 = Math.max(0, idx(t0)), i1 = Math.min(lap.n - 1, idx(t0 + span));
        const stroke = (from, to, style, width, alpha) => {
          if (to <= from) return;
          x.beginPath();
          for (let i = from; i <= to; i++) {
            const X = tx(i / HZ), Y = vy(lap[L.key][i]);
            i === from ? x.moveTo(X, Y) : x.lineTo(X, Y);
          }
          x.globalAlpha = alpha; x.strokeStyle = style; x.lineWidth = width;
          x.stroke(); x.globalAlpha = 1;
        };
        const nowI = clamp(idx(now), i0, i1);
        stroke(i0, nowI, C.ref, 1.5, 0.3);
        stroke(nowI, i1, C.ref, 2, 1);

        // faint fill under the upcoming reference so the shape reads at a glance
        if (i1 > nowI) {
          x.beginPath();
          x.moveTo(tx(nowI / HZ), vy(0));
          for (let i = nowI; i <= i1; i++) x.lineTo(tx(i / HZ), vy(lap[L.key][i]));
          x.lineTo(tx(i1 / HZ), vy(0));
          x.closePath();
          x.fillStyle = "rgba(255,255,255,0.06)";
          x.fill();
        }

        /* Driver trace, coloured by instantaneous error. Error hovering near
           a colour boundary used to flip almost every sample, giving one
           stroke per sample and hundreds of draw calls a frame. Collect the
           three colours into three paths instead and stroke each once. */
        const from = Math.max(0, i0), to = Math.min(lastIdx.current, i1);
        if (to > from) {
          const paths = [new Path2D(), new Path2D(), new Path2D()];
          const scale = L.signed ? 2 : 1;
          let prevBand = -1;
          for (let i = from; i <= to; i++) {
            const e = Math.abs(lap[L.key][i] - cap.current[L.key][i]) / scale;
            const band = e < 0.06 ? 0 : e < 0.15 ? 1 : 2;
            const X = tx(i / HZ), Y = vy(cap.current[L.key][i]);
            if (band !== prevBand) {
              // Start the new colour at the previous point so the line stays joined.
              if (prevBand >= 0 && i > from) {
                paths[band].moveTo(tx((i - 1) / HZ), vy(cap.current[L.key][i - 1]));
                paths[band].lineTo(X, Y);
              } else {
                paths[band].moveTo(X, Y);
              }
              prevBand = band;
            } else {
              paths[band].lineTo(X, Y);
            }
          }
          x.lineWidth = 2.5; x.lineCap = "round"; x.lineJoin = "round";
          const cols = [C.good, C.warn, C.bad];
          for (let b = 0; b < 3; b++) { x.strokeStyle = cols[b]; x.stroke(paths[b]); }
        }

        // live cursor
        const dv = inp[L.key];
        const rv = now >= 0 && now <= lap.dur ? lap[L.key][clamp(idx(now), 0, lap.n - 1)] : 0;
        const e = Math.abs(rv - dv) / (L.signed ? 2 : 1);
        x.beginPath(); x.arc(px, vy(dv), 5, 0, Math.PI * 2);
        x.fillStyle = errColor(e); x.fill();
        x.beginPath(); x.arc(px, vy(rv), 3.5, 0, Math.PI * 2);
        x.strokeStyle = C.ref; x.lineWidth = 1.5; x.stroke();

        // lane name + numbers
        x.fillStyle = C.dim; x.font = "12px ui-sans-serif, system-ui, sans-serif";
        x.fillText(L.label, 10, L.y + 14);
        x.fillStyle = errColor(e);
        x.font = "600 13px ui-monospace, SFMono-Regular, Menlo, monospace";
        const shown = L.signed ? `${(dv * 100).toFixed(0)}` : `${(dv * 100).toFixed(0)}%`;
        x.fillText(shown, W - 92, L.y + 14);
        x.fillStyle = C.dim;
        x.fillText(L.signed ? `${(rv * 100).toFixed(0)}` : `${(rv * 100).toFixed(0)}%`, W - 44, L.y + 14);
      }

      // corner markers ahead
      for (const m of lap.markers) {
        if (m.t < t0 || m.t > t0 + span) continue;
        const X = tx(m.t);
        x.strokeStyle = X > px ? "rgba(255,255,255,0.22)" : "rgba(255,255,255,0.08)";
        x.setLineDash([3, 5]); x.lineWidth = 1;
        x.beginPath(); x.moveTo(X, 8); x.lineTo(X, H - 8); x.stroke();
        x.setLineDash([]);
        x.fillStyle = X > px ? C.dim : C.dimmer;
        x.font = "11px ui-sans-serif, system-ui, sans-serif";
        x.fillText(`T${m.n} ${m.name}`, X + 5, H - 6);
      }

      // playhead
      x.strokeStyle = "rgba(255,255,255,0.85)"; x.lineWidth = 1.5;
      x.beginPath(); x.moveTo(px, 4); x.lineTo(px, H - 4); x.stroke();
    };

    const loop = (nowMs) => {
      const dt = Math.min(0.05, (nowMs - last) / 1000);
      last = nowMs;
      if (!pausedRef.current) t += dt;

      const inp = readInput();

      if (t >= 0 && t <= lap.dur) {
        if (inp.clipping) clipSamples.current++;
        const i = clamp(idx(t), 0, lap.n - 1);
        const prev = lastIdx.current;
        if (i > prev) {
          for (let j = Math.max(0, prev + 1); j <= i; j++) {
            const f = prev < 0 ? 1 : (j - prev) / (i - prev);
            for (const k of ["brake", "throttle", "steer"]) {
              const a = prev < 0 ? inp[k] : cap.current[k][prev];
              cap.current[k][j] = a + (inp[k] - a) * f;
            }
          }
          lastIdx.current = i;
        }
        const eB = Math.abs(lap.brake[i] - inp.brake);
        const eT = Math.abs(lap.throttle[i] - inp.throttle);
        const eS = Math.abs(lap.steer[i] - inp.steer) / 2;
        const inst = clamp(100 * (1 - (eB * 0.45 + eT * 0.3 + eS * 0.25) / 0.3), 0, 100);
        ema.current = ema.current * 0.96 + inst * 0.04;
      }

      const drawStart = performance.now();
      draw(t, inp);
      /* What a frame actually costs, smoothed. If this climbs, the screen is
         genuinely behind the hands rather than merely feeling that way. */
      frameMs = frameMs * 0.9 + (performance.now() - drawStart) * 0.1;
      fps = fps * 0.9 + (1 / Math.max(0.0005, dt)) * 0.1;

      // The canvas carries the fast-moving information. React only needs the
      // HUD numbers a few times a second, so keep it out of the frame budget.
      if (nowMs - lastHud > 120) {
        lastHud = nowMs;
        const nextM = lap.markers.find((m) => m.t > t);
        setHud({
          t, live: Math.round(ema.current),
          corner: nextM ? `T${nextM.n} ${nextM.name}` : "",
          fps: Math.round(fps), frameMs, clip: inp.clipping,
        });
      }

      if (t >= lap.dur) { onFinish(cap.current, clipSamples.current / Math.max(1, fps)); return; }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => { cancelAnimationFrame(raf); ro.disconnect(); };
  }, [lap, readInput, onFinish, brakeOnly]);

  const pre = hud.t < 0;
  return (
    <div className="run">
      <div className="run-top">
        <span className="run-label">{label}</span>
        <div className="run-stats">
          <span className="num big">{Math.max(0, hud.t).toFixed(1)}<span className="unit">/{lap.dur.toFixed(0)}s</span></span>
          <span className="num big live">{hud.live}<span className="unit">match</span></span>
        </div>
        <button className="btn ghost sm" onClick={onAbort}>End</button>
      </div>
      <div className="run-canvas" ref={wrap}><canvas ref={cvs} /></div>
      <div className="run-bottom">
        <span className="next">{hud.corner && `Next: ${hud.corner}`}</span>
        <span className={`perf num ${hud.fps && hud.fps < 50 ? "slow" : ""}`}>
          {hud.fps} fps · {hud.frameMs.toFixed(1)} ms/frame
        </span>
        <span className="fine">Space pauses · Esc ends the session</span>
      </div>
      {hud.clip && !pre && (
        <div className="warnbar">
          Brake pinned at 100% — the top of your peak is being cut off.
          Raise the brake range on the Feel screen.
        </div>
      )}
      {unfocused && !pre && (
        <div className="warnbar">
          This window is not focused, so the browser is slowing the display down.
          Click the page to get full speed back.
        </div>
      )}
      {pre && (
        <div className="countdown">
          <span className="cd-num num">{Math.ceil(-hud.t)}</span>
          <span className="cd-text">Watch the trace come in from the right. Match it as it crosses the line.</span>
        </div>
      )}
      {paused && <div className="countdown"><span className="cd-text">Paused — space to resume</span></div>}
    </div>
  );
}

/* ---------------- Logbook ---------------- */
function Logbook({ driver, onOpen, onBack }) {
  const [index, setIndex] = useState(() => loadRunIndex());
  const [who, setWho] = useState(driver?.name ?? "all");
  const [err, setErr] = useState("");
  const fileRef = useRef(null);

  const drivers = [...new Set(index.map((r) => r.driver))];
  const rows = who === "all" ? index : index.filter((r) => r.driver === who);

  const refresh = () => setIndex(loadRunIndex());

  const open = (id) => {
    const rec = loadRun(id);
    if (!rec) { setErr("That run's traces were cleared to make room. The scores above are all that is left of it."); return; }
    onOpen(rec);
  };

  const exportAll = () => {
    const full = index.map((r) => loadRun(r.id)).filter(Boolean);
    download(`brake-trainer-logbook_${new Date().toISOString().slice(0, 10)}.json`,
      JSON.stringify({ v: RUN_FORMAT, exported: new Date().toISOString(), runs: full }),
      "application/json");
  };

  const importFile = async (f) => {
    if (!f) return;
    try {
      const text = await f.text();
      const j = JSON.parse(text);
      const list = Array.isArray(j.runs) ? j.runs : [j];
      let n = 0;
      for (const r of list) {
        if (r && r.v === RUN_FORMAT && r.ref && r.drv) { saveRun(r); n++; }
      }
      if (!n) throw new Error("No runs in that file.");
      refresh();
      setErr("");
    } catch (e) { setErr(e.message || "Could not read that file."); }
  };

  return (
    <div className="results">
      <header className="top">
        <span className="wordmark sm">Logbook</span>
        <div className="dock-actions">
          <button className="btn ghost" onClick={() => fileRef.current?.click()}>Import runs</button>
          <input ref={fileRef} type="file" accept=".json" className="hidden"
            onChange={(e) => importFile(e.target.files?.[0])} />
          <button className="btn ghost" disabled={!index.length} onClick={exportAll}>Export all</button>
          <button className="btn primary" onClick={onBack}>Back</button>
        </div>
      </header>

      {drivers.length > 1 && (
        <div className="cats" style={{ marginBottom: 14 }}>
          <button className={`cat ${who === "all" ? "on" : ""}`} onClick={() => setWho("all")}>
            Everyone
          </button>
          {drivers.map((d) => (
            <button key={d} className={`cat ${who === d ? "on" : ""}`} onClick={() => setWho(d)}>{d}</button>
          ))}
        </div>
      )}

      {err && <p className="err">{err}</p>}

      {rows.length === 0 ? (
        <div className="empty">
          <h2 className="h1">No runs yet</h2>
          <p className="lede">
            Every session you finish is saved here automatically, with both traces
            kept so it can be reopened and compared. Run files from another rig can
            be brought in with Import runs.
          </p>
        </div>
      ) : (
        <table className="tbl log">
          <thead>
            <tr>
              <th>When</th><th>Driver</th><th>Reference</th><th>Session</th>
              <th>Brake</th><th>Throttle</th><th>Steering</th><th>Score</th><th></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className={r.dropped ? "dropped" : ""}>
                <td className="num dim">{fmtWhen(r.savedAt)}</td>
                <td>{r.driver}</td>
                <td className="z-name">{r.car}<span className="dim"> · {r.track}</span></td>
                <td className="dim">{r.drill}</td>
                <td className="num">{r.brake}</td>
                <td className="num">{r.throttle}</td>
                <td className="num">{r.steer}</td>
                <td className="num" style={{ color: r.overall > 75 ? C.text : r.overall > 50 ? C.warn : C.bad }}>
                  {r.overall}
                </td>
                <td className="log-act">
                  <button className="btn ghost sm" disabled={r.dropped} onClick={() => open(r.id)}>Open</button>
                  <button className="btn ghost sm" onClick={() => { deleteRun(r.id); refresh(); }}>Delete</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <p className="fine">
        Runs are stored in this browser on this machine. Export them to a file to
        move them, or to send them to someone else.
      </p>
    </div>
  );
}

/* A saved run, reopened. The traces come back from the file rather than from
   a session that just happened, so this is a read-only view of the record. */
function SavedRun({ rec, onBack }) {
  const lap = useMemo(() => ({
    n: rec.n, dur: rec.dur,
    brake: decodeU8(rec.ref.brake, 0, 1),
    throttle: decodeU8(rec.ref.throttle, 0, 1),
    steer: decodeU8(rec.ref.steer, -1, 1),
    markers: (rec.zones ?? []).map((z) => ({ n: z.n, name: z.name, t: z.t })),
    zones: rec.zones ?? [],
  }), [rec]);
  const cap = useMemo(() => ({
    brake: decodeU8(rec.drv.brake, 0, 1),
    throttle: decodeU8(rec.drv.throttle, 0, 1),
    steer: decodeU8(rec.drv.steer, -1, 1),
  }), [rec]);

  const r = {
    overall: rec.overall, channels: rec.channels, zones: rec.zones,
    notes: rec.notes, lap, cap,
    label: `${rec.driver} · ${rec.reference.car} · ${rec.drill.name}`,
  };
  return <Results r={r} best={undefined} saved={rec} onRetry={null} onGarage={onBack} />;
}

/* ---------------- Results ---------------- */
function Results({ r, best, saved, onRetry, onGarage }) {
  const cvs = useRef(null);

  useEffect(() => {
    const c = cvs.current; if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth, h = c.clientHeight;
    c.width = w * dpr; c.height = h * dpr;
    const x = c.getContext("2d");
    x.setTransform(dpr, 0, 0, dpr, 0, 0);
    x.fillStyle = C.bg; x.fillRect(0, 0, w, h);
    const { lap, cap } = r;
    const X = (i) => (i / (lap.n - 1)) * w;
    const Y = (v) => h - 4 - v * (h - 12);

    x.beginPath();
    for (let i = 0; i < lap.n; i++) { const px = X(i), py = Y(lap.brake[i]); i ? x.lineTo(px, py) : x.moveTo(px, py); }
    x.strokeStyle = "rgba(255,255,255,0.8)"; x.lineWidth = 1.4; x.stroke();

    let segStart = 0;
    const col = (i) => { const e = Math.abs(lap.brake[i] - cap.brake[i]); return e < 0.06 ? C.good : e < 0.15 ? C.warn : C.bad; };
    let cur = col(0);
    for (let i = 1; i < lap.n; i++) {
      const cc = col(i);
      if (cc !== cur || i === lap.n - 1) {
        x.beginPath();
        for (let j = segStart; j <= i; j++) { const px = X(j), py = Y(cap.brake[j]); j === segStart ? x.moveTo(px, py) : x.lineTo(px, py); }
        x.strokeStyle = cur; x.lineWidth = 1.8; x.stroke();
        segStart = i; cur = cc;
      }
    }
    x.fillStyle = C.dimmer; x.font = "10px ui-sans-serif, system-ui, sans-serif";
    for (const m of lap.markers) x.fillText(`T${m.n}`, X(idx(m.t)) + 2, 11);
  }, [r]);

  const ch = r.channels;
  const isBest = best !== undefined && r.overall >= best;

  return (
    <div className="results">
      <header className="top">
        <span className="wordmark sm">{r.label}</span>
        <div className="dock-actions">
          {saved && (
            <>
              <button className="btn ghost" onClick={() => download(runFileName(saved, "json"), JSON.stringify(saved), "application/json")}>
                Save run file
              </button>
              <button className="btn ghost" onClick={() => download(runFileName(saved, "csv"), runToCSV(saved), "text/csv")}>
                Export traces
              </button>
            </>
          )}
          <button className="btn ghost" onClick={onGarage}>{onRetry ? "Change session" : "Back to logbook"}</button>
          {onRetry && <button className="btn primary" onClick={onRetry}>Run again</button>}
        </div>
      </header>

      <div className="res-hero">
        <div className="score">
          <span className="score-num num">{r.overall}</span>
          <span className="score-of">out of 100</span>
          {isBest && <span className="pb">Personal best</span>}
        </div>
        <div className="bars">
          {(r.brakeOnly
            ? [["Brake", ch.brake, 100]]
            : [["Brake", ch.brake, 45], ["Throttle", ch.throttle, 30], ["Steering", ch.steer, 25]]
          ).map(([n, c, wt]) => (
            <div key={n} className="bar-row">
              <span className="bar-name">{n}</span>
              <div className="bar"><div className="bar-fill" style={{ width: `${c.score}%` }} /></div>
              <span className="bar-v num">{Math.round(c.score)}</span>
              <span className="bar-w num">{wt}% of total</span>
            </div>
          ))}
          <p className="fine">
            Brake timing costs you {Math.max(0, Math.round(ch.brake.shapeScore - ch.brake.score))} points.
            Your pedal trace runs {ch.brake.lagMs >= 0 ? "behind" : "ahead of"} the reference by {Math.abs(ch.brake.lagMs).toFixed(0)} ms on average.
          </p>
        </div>
      </div>

      <section className="block">
        <h2 className="h2">Brake channel across the session</h2>
        <canvas ref={cvs} className="overlay" />
        <p className="fine">White is the reference. Your trace is green where it matches, red where it does not.</p>
      </section>

      <div className="res-cols">
        <section className="block">
          <h2 className="h2">What to fix first</h2>
          {r.notes.length === 0 ? (
            <p className="lede">Nothing significant flagged. Move to a faster category or a longer session.</p>
          ) : (
            <ul className="notes">
              {r.notes.map((n, i) => (
                <li key={i} className="note">
                  <div className="note-head">
                    <span className="note-title">{n.title}</span>
                    <span className="note-zone num">{n.zone}</span>
                  </div>
                  <p className="note-detail">{n.detail}</p>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="block">
          <h2 className="h2">Braking zones</h2>
          <table className="tbl">
            <thead>
              <tr><th>Zone</th><th>Peak</th><th>Target</th><th>Timing</th><th>Match</th></tr>
            </thead>
            <tbody>
              {r.zones.map((z, i) => (
                <tr key={i}>
                  <td className="z-name">{z.name}</td>
                  <td className="num">{Math.round(z.drvPeak * 100)}%</td>
                  <td className="num dim">{Math.round(z.refPeak * 100)}%</td>
                  <td className="num">{z.bpDelta === null ? "—" : `${z.bpDelta > 0 ? "+" : ""}${(z.bpDelta * 1000).toFixed(0)}ms`}</td>
                  <td className="num" style={{ color: z.score > 75 ? C.text : z.score > 50 ? C.warn : C.bad }}>{z.score}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </div>
    </div>
  );
}

/* ---------------- Styles ---------------- */
function Styles() {
  return (
    <style>{`
.bt-root{
  --bg:${C.bg}; --panel:${C.panel}; --panel2:${C.panel2}; --line:${C.line};
  --text:${C.text}; --dim:${C.dim}; --dimmer:${C.dimmer};
  --ui:${C.ui}; --good:${C.good}; --warn:${C.warn}; --bad:${C.bad};
  background:var(--bg); color:var(--text); min-height:100vh;
  font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
  font-size:15px; line-height:1.5; -webkit-font-smoothing:antialiased;
}
.bt-root *{box-sizing:border-box;}
.bt-root .num{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; font-variant-numeric:tabular-nums; letter-spacing:-0.01em;}
.bt-root button:focus-visible,.bt-root input:focus-visible,.bt-root select:focus-visible{outline:2px solid var(--ui); outline-offset:2px;}
.hidden{display:none;}

.wordmark{font-family:"Michroma","Eurostile","Bank Gothic",ui-sans-serif,system-ui,sans-serif;
  font-size:23px; font-weight:400; letter-spacing:.1em; text-transform:uppercase; margin:0 0 16px;}
.wordmark.sm{font-size:13px; font-weight:400; letter-spacing:.11em; margin:0;}
.h1{font-size:24px; font-weight:600; letter-spacing:-0.02em; margin:0 0 10px;}
.h2{font-size:13px; font-weight:500; color:var(--dim); margin:0 0 12px;}
.lede{color:var(--dim); max-width:56ch; margin:0 0 20px;}
.fine{color:var(--dimmer); font-size:12.5px; max-width:64ch; margin:12px 0 0;}
.err{color:var(--bad); font-size:13px; margin-top:10px; line-height:1.45;
  background:#2a1512; border-left:2px solid var(--bad); padding:11px 14px; border-radius:12px;}

.btn{border:1px solid var(--line); background:transparent; color:var(--text);
  padding:9px 18px; border-radius:999px; font-size:14px; cursor:pointer; font-family:inherit;
  transition:border-color .12s, background .12s;}
.btn:hover:not(:disabled){border-color:var(--ui);}
.btn:disabled{opacity:.32; cursor:not-allowed;}
.btn.primary{background:var(--ui); border-color:var(--ui); color:#000; font-weight:600;}
.btn.primary:hover:not(:disabled){background:#e4e4e4; border-color:#e4e4e4;}
.btn.sm{padding:5px 11px; font-size:13px;}
.btn.wide{width:100%; margin-top:10px;}
.field{background:var(--panel2); border:1px solid var(--line); color:var(--text);
  padding:10px 14px; border-radius:12px; font-size:14px; font-family:inherit; width:100%;}
.field::placeholder{color:var(--dimmer);}

/* sign in */
.signin{min-height:100vh; display:flex; align-items:center; justify-content:center; padding:24px;}
.signin-inner{width:100%; max-width:560px;}
.vcaso-logo{display:block;height:28px;width:auto;margin:0 auto 28px}
.vcaso-logo.top{display:block!important;flex:none;align-self:center;width:96px!important;height:auto!important;margin:6px auto 14px}
.signin-trace{width:100%; height:64px; display:block; margin-bottom:28px; opacity:.85;}
.drivers{margin-bottom:12px;}
.drivers li{display:flex; align-items:stretch; gap:6px;}
.drivers li .item{flex:1;}
.x{background:transparent; border:1px solid var(--line); color:var(--dimmer);
  min-width:34px; padding:0 8px; border-radius:999px; cursor:pointer; font-size:16px;
  line-height:1; font-family:inherit;}
.x.armed{color:var(--bad); border-color:var(--bad); font-size:12px;}
.x:hover{color:var(--bad); border-color:#3d4442;}
.who-btn{background:transparent; border:0; color:var(--text); font:inherit; font-size:14px;
  cursor:pointer; padding:0; display:flex; flex-direction:column; align-items:flex-end; gap:1px;}
.who-sub{color:var(--dimmer); font-size:11.5px;}
.who-btn:hover .who-sub{color:var(--dim);}
.row{display:flex; gap:10px;}
.row .field{flex:1;}

/* garage */
.garage{min-height:100vh; display:flex; flex-direction:column; padding:22px 26px 0;}
.top{display:flex; align-items:center; justify-content:space-between; gap:16px;
  padding-bottom:18px; border-bottom:1px solid var(--line); margin-bottom:20px;}
.who{color:var(--dim); font-size:14px;}
.cats{display:flex; gap:6px; flex-wrap:wrap;}
.cat{background:transparent; border:1px solid var(--line); color:var(--dim);
  padding:7px 18px; border-radius:999px; font-size:14px; cursor:pointer; font-family:inherit;}
.cat.on{border-color:var(--ui); color:var(--ui); background:rgba(255,255,255,0.06);}
.cat.empty{opacity:.45;}
.cat-note{color:var(--dimmer); font-size:13px; margin:10px 0 22px;}

.cols{display:grid; grid-template-columns:1fr 1fr 1.5fr; gap:26px; flex:1; align-items:start;}
.list{list-style:none; margin:0; padding:0; display:flex; flex-direction:column; gap:4px;}
.item{width:100%; text-align:left; background:var(--panel); border:1px solid transparent;
  border-left:2px solid var(--line); color:var(--text); padding:11px 14px; cursor:pointer;
  font-family:inherit; display:flex; justify-content:space-between; align-items:baseline; gap:12px;
  transition:border-color .12s, background .12s;}
.item:hover{background:var(--panel2);}
.item.on{border-left-color:var(--ui); background:var(--panel2);}
.item-name{font-size:14.5px;}
.item-sub{color:var(--dimmer); font-size:12.5px;}
.preview{width:100%; height:190px; display:block; background:var(--panel); border:1px solid var(--line);}
.meta{display:flex; gap:18px; margin-top:10px; font-size:12.5px; color:var(--dimmer);}
.meta .best{color:var(--ui);}

.dock{display:flex; align-items:center; justify-content:space-between; gap:20px; flex-wrap:wrap;
  border-top:1px solid var(--line); margin-top:26px; padding:16px 0 22px;}
.dev{display:flex; align-items:center; gap:12px;}
.dot{width:8px; height:8px; border-radius:50%; background:var(--bad); flex:none;}
.dot.live{background:var(--ui);}
.dev-name{font-size:14px;}
.dev-sub{font-size:12.5px; color:var(--dimmer);}
.dock-actions{display:flex; align-items:center; gap:10px;}
.check{display:flex; align-items:center; gap:7px; color:var(--dim); font-size:13.5px; cursor:pointer;}

/* calibration */
.cal{min-height:100vh; padding:22px 26px;}
.empty{max-width:52ch; padding-top:40px;}
.cal-body{display:grid; grid-template-columns:1.1fr 1fr; gap:36px;}
.steps{list-style:none; margin:22px 0 0; padding:0; display:flex; flex-direction:column; gap:2px;}
.step{display:flex; gap:14px; padding:13px 14px; border-left:2px solid var(--line); background:var(--panel);}
.step.on{border-left-color:var(--ui); background:var(--panel2);}
.step.did{opacity:.55;}
.step-n{color:var(--dimmer); font-size:13px; width:14px; flex:none;}
.step-label{font-size:14.5px;}
.step-help{color:var(--dimmer); font-size:12.5px; margin-top:4px; max-width:44ch;}
.step-live{font-size:12.5px; margin-top:6px; color:var(--dim);
  font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;}
.step-live.ok{color:var(--ui);}
.cal-actions{display:flex; gap:10px; margin-top:20px;}
.dev-block{margin-bottom:18px;}
.dev-head{display:flex; justify-content:space-between; align-items:baseline; gap:12px;
  padding-bottom:7px; margin-bottom:9px; border-bottom:1px solid var(--line);}
.dev-title{font-size:13.5px;}
.dev-count{font-size:11.5px; color:var(--dimmer);}
.cal-right{min-width:0;}
.slider{display:flex; align-items:center; gap:14px; margin-top:10px;}
.slider input[type=range]{flex:1; accent-color:var(--ui); background:transparent;}
.slider .num{font-size:13px; width:56px; text-align:right; color:var(--text);}
.feel-row{display:grid; grid-template-columns:72px 1fr 50px 76px; align-items:center;
  gap:11px; margin-bottom:9px;}
.feel-label{font-size:13.5px; color:var(--dim);}
.feel-track{height:9px; background:var(--panel2); border-radius:5px; position:relative; overflow:hidden;}
.feel-mid{position:absolute; left:50%; top:0; width:1px; height:100%; background:#2f3634;}
.feel-fill{position:absolute; top:0; height:100%; background:var(--ui); border-radius:5px;}
.feel-val{font-size:13px; text-align:right;}
.feel-sub{font-size:11.5px; color:var(--dimmer);}
.tbl.log td,.tbl.log th{padding-right:14px;}
.tbl.log tr.dropped{opacity:.5;}
.log-act{display:flex; gap:6px; justify-content:flex-end;}
.corners{margin-top:4px;}
.corner-row{display:grid; grid-template-columns:56px 1fr 44px 74px; gap:9px;
  align-items:center; margin-bottom:3px;}
.corner-at{font-size:11.5px; color:var(--dimmer); text-align:right;}
.corner-name{background:transparent; border:1px solid transparent; color:var(--text);
  font:inherit; font-size:13.5px; padding:3px 6px; border-radius:8px; min-width:0;}
.corner-name:hover{border-color:var(--line);}
.corner-name:focus{border-color:var(--ui); background:var(--panel2); outline:none;}
.corner-peak{font-size:12px; color:var(--dim); text-align:right;}
.corner-sp{font-size:11.5px; color:var(--dimmer); text-align:right;}
.perf{font-size:12px; color:var(--dimmer);}
.perf.slow{color:var(--warn);}
.warnbar{position:absolute; left:0; right:0; bottom:0; padding:11px 22px;
  background:#3a2b14; color:#f0d9a8; font-size:13.5px; text-align:center;}
.axes{display:flex; flex-direction:column; gap:5px;}
.axis{display:grid; grid-template-columns:22px 1fr 46px 62px; align-items:center; gap:10px;}
.axis-n{color:var(--dimmer); font-size:12px;}
.axis-bar{height:5px; background:var(--panel2); position:relative; border-radius:3px;}
.axis-fill{position:absolute; top:-2px; width:3px; height:9px; background:var(--dim); border-radius:2px; transform:translateX(-1px);}
.axis.mapped .axis-fill{background:var(--ui);}
.axis-v{font-size:12px; color:var(--dim); text-align:right;}
.axis-role{font-size:11.5px; color:var(--ui);}

/* run */
.run{height:100vh; display:flex; flex-direction:column; background:var(--bg); position:relative;}
.run-top{display:flex; align-items:center; justify-content:space-between; gap:20px; padding:14px 22px;}
.run-label{color:var(--dim); font-size:14px;}
.run-stats{display:flex; gap:28px; align-items:baseline;}
.big{font-size:26px; font-weight:600;}
.big.live{color:var(--ui);}
.unit{font-size:12px; color:var(--dimmer); margin-left:4px; font-weight:400;}
.run-canvas{flex:1; min-height:0; padding:0 22px;}
.run-canvas canvas{width:100%; height:100%; display:block;}
.run-bottom{display:flex; justify-content:space-between; padding:10px 22px 16px; font-size:13px; color:var(--dim);}
.run-bottom .fine{margin:0;}
.countdown{position:absolute; inset:0; display:flex; flex-direction:column; align-items:center;
  justify-content:center; gap:14px; background:rgba(0,0,0,.72); pointer-events:none;}
.cd-num{font-size:88px; font-weight:600; line-height:1;}
.cd-text{color:var(--dim); font-size:14px; max-width:44ch; text-align:center;}

/* results */
.results{min-height:100vh; padding:22px 26px 40px;}
.res-hero{display:grid; grid-template-columns:auto 1fr; gap:52px; align-items:center; padding:12px 0 34px;}
.score{display:flex; flex-direction:column;}
.score-num{font-size:92px; font-weight:600; line-height:.92; letter-spacing:-0.04em;}
.score-of{color:var(--dimmer); font-size:13px; margin-top:8px;}
.pb{color:var(--ui); font-size:13px; margin-top:6px;}
.bars{display:flex; flex-direction:column; gap:10px; max-width:640px;}
.bar-row{display:grid; grid-template-columns:74px 1fr 36px 90px; align-items:center; gap:12px;}
.bar-name{font-size:14px; color:var(--dim);}
.bar{height:6px; background:var(--panel2); border-radius:3px; overflow:hidden;}
.bar-fill{height:100%; background:var(--ui);}
.bar-v{font-size:14px; text-align:right;}
.bar-w{font-size:11.5px; color:var(--dimmer);}

.block{border-top:1px solid var(--line); padding-top:20px; margin-top:26px;}
.overlay{width:100%; height:150px; display:block; border:1px solid var(--line);}
.res-cols{display:grid; grid-template-columns:1.15fr 1fr; gap:34px;}
.notes{list-style:none; margin:0; padding:0; display:flex; flex-direction:column; gap:2px;}
.note{background:var(--panel); border-left:2px solid var(--warn); padding:13px 16px;}
.note:first-child{border-left-color:var(--bad);}
.note-head{display:flex; justify-content:space-between; gap:14px; align-items:baseline;}
.note-title{font-size:14.5px; font-weight:500;}
.note-zone{font-size:12px; color:var(--dim); flex:none;}
.note-detail{color:var(--dim); font-size:13.5px; margin:6px 0 0; max-width:62ch;}
.tbl{width:100%; border-collapse:collapse; font-size:13.5px;}
.tbl th{text-align:right; color:var(--dimmer); font-weight:400; font-size:12px; padding:0 0 9px; border-bottom:1px solid var(--line);}
.tbl th:first-child{text-align:left;}
.tbl td{padding:9px 0; border-bottom:1px solid var(--panel2); text-align:right;}
.tbl td:first-child{text-align:left;}
.z-name{color:var(--text);}
.tbl .dim{color:var(--dimmer);}

.preview-note{border:1px solid var(--line); border-left:2px solid var(--warn);
  border-radius:16px; background:var(--panel); padding:16px 18px; margin:4px 0 8px;}
.preview-note p{margin:0 0 10px; color:var(--dim); font-size:14px; text-align:center;}
.preview-note a{display:block; text-decoration:none;}
.preview-note .fine{margin:10px 0 0;}

/* the front door */
.vcaso-logo.big{height:34px; margin:0 auto 22px;}

/* Michroma is the closest widely available face to the VCASO wordmark —
   same squared, wide, geometric letterforms — so the product name reads as
   part of the mark rather than as a caption under it. Falls back to the
   nearest grotesques if the webfont never loads. */
.display-name{font-family:"Michroma","Eurostile","Bank Gothic",ui-sans-serif,
  system-ui,-apple-system,sans-serif;
  font-weight:400; font-size:17px; letter-spacing:.11em; text-transform:uppercase;
  text-align:center; margin:0 0 20px; line-height:1.4;}
.display-name.sm{font-size:14px; letter-spacing:.1em;}

/* the trace, in its own window */
.trace-strip{width:100%; height:64px; display:block; margin:0 0 24px;
  -webkit-mask-image:linear-gradient(90deg,transparent,#000 14%,#000 86%,transparent);
  mask-image:linear-gradient(90deg,transparent,#000 14%,#000 86%,transparent);}

/* Three buttons and a name do not fit beside the title on a phone, and the
   overflow pushed "sign out" off the right edge where it could not be
   reached. Let the row wrap instead. */
@media (max-width:760px){
  .top{flex-wrap:wrap; row-gap:12px;}
  .top .dock-actions{width:100%; justify-content:flex-start; flex-wrap:wrap; gap:8px;}
  .top .who-btn{margin-left:auto; text-align:right;}
  .cat{padding:7px 14px; font-size:13.5px;}
}

@media (max-width:620px){
  .vcaso-logo.big{height:28px; margin-bottom:18px;}
  .display-name{font-size:14px; letter-spacing:.09em;}
  .trace-strip{height:54px; margin-bottom:20px;}
}

/* accounts, requests and the board */
.topbar{display:flex; align-items:center; justify-content:space-between; gap:16px;
  padding-bottom:16px; margin-bottom:20px; border-bottom:1px solid var(--line);}
.centre{text-align:center;}
.signin-inner.narrow{max-width:380px;}
.muted{color:var(--dim);}
.login{min-height:100vh; display:flex; align-items:center; justify-content:center; padding:24px;}
.card-form{display:grid; gap:12px; border:1px solid var(--line); border-radius:16px;
  background:var(--panel); padding:18px; margin-top:4px;}
.lbl{display:grid; gap:5px; font-size:13px; color:var(--dim);}
.lbl.tight{gap:3px; font-size:12px;}
.hint{color:var(--dimmer); font-size:11.5px;}
.signin-alt{display:flex; flex-direction:column; align-items:center; gap:8px; margin-top:16px;}
.link{background:none; border:none; padding:2px 4px; color:var(--dim); font:inherit;
  font-size:13px; cursor:pointer; text-decoration:underline; text-underline-offset:3px;
  text-decoration-color:var(--line);}
.link:hover{color:var(--text); text-decoration-color:var(--dim);}
.panelbox{border:1px solid var(--line); border-radius:16px; background:var(--panel);
  padding:18px; margin-bottom:16px; max-width:660px;}
.big-name{font-size:21px; font-weight:600; letter-spacing:-0.01em; margin:0 0 6px;}
.big-check{font-size:14.5px; color:var(--text);}
.inline-form{display:flex; gap:8px; align-items:center; max-width:460px;}
.inline-form .field{flex:1;}
.ok-note{color:var(--ui); font-size:13px; margin:10px 0 0;}
.issued{background:var(--bg); border:1px solid var(--line); border-radius:12px;
  padding:14px; font-size:13px; line-height:1.6; white-space:pre-wrap; word-break:break-word;
  color:var(--text); margin:0 0 16px; max-width:52ch;}
.field.sm{padding:6px 12px; font-size:13px; width:132px; border-radius:999px;}

.reqs{list-style:none; margin:0 0 8px; padding:0; display:flex; flex-direction:column; gap:8px;}
.req{display:flex; justify-content:space-between; align-items:flex-start; gap:22px;
  flex-wrap:wrap; border:1px solid var(--line); border-left:2px solid var(--warn);
  border-radius:14px; background:var(--panel); padding:15px 17px;}
.req-main{display:flex; flex-direction:column; gap:3px; min-width:0;}
.req-name{font-size:16px; font-weight:600;}
.req-contact{font-size:13.5px; color:var(--ui);}
.req-note{color:var(--dim); font-size:13.5px; margin:5px 0 0; max-width:54ch;}
.req-act{display:flex; align-items:flex-end; gap:8px; flex-wrap:wrap;}

.tbl.board td{padding:10px 0;}
.tbl.board tr.me td{color:var(--ui); font-weight:600;}
.tbl .dim{color:var(--dimmer);}

@media (max-width:620px){
  .req{flex-direction:column; gap:12px;}
  .req-act{align-items:stretch;}
}

@media (max-width:900px){
  .cols,.cal-body,.res-cols{grid-template-columns:1fr;}
  .res-hero{grid-template-columns:1fr; gap:24px;}
  .score-num{font-size:64px;}
  .bar-row{grid-template-columns:64px 1fr 32px;}
  .bar-w{display:none;}
}
@media (prefers-reduced-motion:reduce){ .bt-root *{transition:none !important;} }
`}</style>
  );
}
