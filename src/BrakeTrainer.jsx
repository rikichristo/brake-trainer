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

const C = {
  bg: "#000000",
  panel: "#0d0f0e",
  panel2: "#141817",
  line: "#232827",
  ref: "#ffffff",
  good: "#7ee0a3",
  warn: "#e3b45a",
  bad: "#ff6b5e",
  text: "#f2f5f4",
  dim: "#7b8481",
  dimmer: "#4a5250",
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
};
const CATEGORY_ORDER = ["f4", "f3", "f2"];

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

function analyse(lap, cap) {
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
     merely uneven rather than absent, the two agree within a point. */
  const overall = Math.exp(
    Object.keys(WEIGHT).reduce(
      (s, k) => s + WEIGHT[k] * Math.log(Math.max(1, channels[k].score)), 0)
  );

  const zones = analyseZones(lap, cap);
  return { overall: Math.round(overall), channels, zones, notes: makeNotes(channels, zones) };
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

function makeNotes(channels, zones) {
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
     this driver went on this lap. A high percentile rather than the
     outright peak, so one spike does not flatten everything else. */
  const absSorted = (k) => rows.map((r) => Math.abs(r[k])).sort((a, b) => a - b);
  const bPeak = pct(absSorted("brake"), 0.995);
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
  const units = bPeak > 1.5 ? `brake scaled from 0–${Math.round(bPeak)}` : "brake already 0–1";

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
   travel register more, above 1 less. */
const BLANK_FEEL = { steerGain: 1.0, brakeCurve: 1.0, steerDeadzone: 0.0 };

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

    let brake = b ?? 0;
    const g = feel.brakeCurve ?? 1;
    if (g !== 1) brake = Math.pow(clamp(brake, 0, 1), g);

    return {
      brake, throttle: t ?? 0, steer,
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
  const [screen, setScreen] = useState("signin");
  const [driver, setDriver] = useState(null);   // { id, name }
  const [cat, setCat] = useState(LAPS[0]?.meta.category ?? "f4");
  const [lapId, setLapId] = useState(LAPS[0]?.id ?? "");
  const [drillId, setDrillId] = useState("corners");
  const [cal, setCal] = useState(BLANK_CAL);
  const [feel, setFeel] = useState(BLANK_FEEL);
  const [viewing, setViewing] = useState(null);
  const [keyboard, setKeyboard] = useState(false);
  const [imported, setImported] = useState(() => loadSavedLapRecords().map(unpackLap));
  const [lapWarn, setLapWarn] = useState("");
  const [result, setResult] = useState(null);
  const [bests, setBests] = useState({});

  /* Calibration belongs to the rig, not the driver: the axes are wherever
     this machine's hardware puts them, whoever is sitting in it. Feel and
     personal bests belong to the driver, so they are keyed per profile. */
  useEffect(() => {
    const c = store.get("bt:cal");
    if (c) setCal(c);
  }, []);

  useEffect(() => {
    if (!driver) return;
    setFeel({ ...BLANK_FEEL, ...(store.get(`bt:feel:${driver.id}`) ?? {}) });
    setBests(store.get(`bt:bests:${driver.id}`) ?? {});
  }, [driver]);

  const all = useMemo(() => [...LAPS, ...imported], [imported]);
  const [nameRev, setNameRev] = useState(0);   // bump to re-read custom names
  const fullLap = useMemo(
    () => applyZoneNames(all.find((l) => l.id === lapId) ?? all[0]),
    [all, lapId, nameRev]
  );
  const drills = useMemo(() => makeDrills(fullLap), [fullLap]);
  const drill = drills.find((d) => d.id === drillId) ?? drills[0];
  const lap = useMemo(() => buildDrill(fullLap, drill), [fullLap, drill]);
  const bestKey = `${fullLap.id}:${drill.id}`;
  const label = `${fullLap.meta.car} · ${fullLap.meta.track} · ${drill.name}`;

  const finish = useCallback(async (cap) => {
    const r = analyse(lap, cap);
    // Snapshot the capture: the buffers are reused on the next run.
    const frozen = {
      brake: Float32Array.from(cap.brake),
      throttle: Float32Array.from(cap.throttle),
      steer: Float32Array.from(cap.steer),
    };
    const rec = runRecord({ driver, lap, drill, result: r, cap: frozen, feel });
    const kept = saveRun(rec);
    setResult({ ...r, lap, cap: frozen, label, saved: rec, kept });
    if (!bests[bestKey] || r.overall > bests[bestKey]) {
      const nb = { ...bests, [bestKey]: r.overall };
      setBests(nb); store.set(`bt:bests:${driver.id}`, nb);
    }
    setScreen("results");
  }, [lap, label, bests, bestKey, driver, drill, feel]);

  const saveCal = (c) => { setCal(c); store.set("bt:cal", c); };
  const saveFeel = (f) => { setFeel(f); if (driver) store.set(`bt:feel:${driver.id}`, f); };

  return (
    <div className="bt-root">
      <Styles />
      {screen === "signin" && (
        <DriverSelect onPick={(d) => { setDriver(d); setScreen("garage"); }} />
      )}
      {screen === "garage" && (
        <Garage
          driver={driver} onSwitchDriver={() => { setDriver(null); setScreen("signin"); }} cat={cat} setCat={setCat}
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
          onFinish={finish} onAbort={() => setScreen("garage")} />
      )}
      {screen === "results" && result && (
        <Results r={result} best={bests[bestKey]} saved={result.saved}
          onRetry={() => setScreen("run")} onGarage={() => setScreen("garage")} />
      )}
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

function DriverSelect({ onPick }) {
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
          who can open this page can open any profile. Each rig keeps its own
          profiles and history; runs travel between them as files, through the
          logbook.
        </p>
      </div>
    </div>
  );
}

/* ---------------- Garage ---------------- */
function Garage({
  driver, onSwitchDriver, cat, setCat, all, lapId, setLapId, fullLap, drills, drillId, setDrillId, lap,
  cal, keyboard, setKeyboard, best, onImport, lapWarn, onDeleteLap,
  onCalibrate, onFeel, onLogbook, onRenameZone, onStart,
}) {
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
      <header className="top">
        <span className="wordmark sm">Brake Trainer</span>
        <button className="who-btn" onClick={onSwitchDriver}>
          {driver?.name}<span className="who-sub">switch driver</span>
        </button>
      </header>

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
          <Bar label="Brake" value={v.brake} sub={`raw ${raw.brake.toFixed(2)}`} />
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
function Run({ lap, cal, keyboard, feel, label, onFinish, onAbort }) {
  const cvs = useRef(null);
  const wrap = useRef(null);
  const readInput = useInputDevice(cal, keyboard, feel);
  const [paused, setPaused] = useState(false);
  const pausedRef = useRef(false);
  const [hud, setHud] = useState({ t: -LEADIN, live: 100, corner: "", fps: 0, frameMs: 0 });
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

    const lanes = () => {
      const pad = 18, gap = 16;
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
          fps: Math.round(fps), frameMs,
        });
      }

      if (t >= lap.dur) { onFinish(cap.current); return; }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => { cancelAnimationFrame(raf); ro.disconnect(); };
  }, [lap, readInput, onFinish]);

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
                <td className="num" style={{ color: r.overall > 75 ? C.good : r.overall > 50 ? C.warn : C.bad }}>
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
          {[["Brake", ch.brake, 45], ["Throttle", ch.throttle, 30], ["Steering", ch.steer, 25]].map(([n, c, wt]) => (
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
                  <td className="num" style={{ color: z.score > 75 ? C.good : z.score > 50 ? C.warn : C.bad }}>{z.score}</td>
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
  --good:${C.good}; --warn:${C.warn}; --bad:${C.bad};
  background:var(--bg); color:var(--text); min-height:100vh;
  font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
  font-size:15px; line-height:1.5; -webkit-font-smoothing:antialiased;
}
.bt-root *{box-sizing:border-box;}
.bt-root .num{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; font-variant-numeric:tabular-nums; letter-spacing:-0.01em;}
.bt-root button:focus-visible,.bt-root input:focus-visible,.bt-root select:focus-visible{outline:2px solid var(--good); outline-offset:2px;}
.hidden{display:none;}

.wordmark{font-size:34px; font-weight:600; letter-spacing:-0.03em; margin:0 0 14px;}
.wordmark.sm{font-size:16px; font-weight:600; letter-spacing:-0.01em; margin:0;}
.h1{font-size:24px; font-weight:600; letter-spacing:-0.02em; margin:0 0 10px;}
.h2{font-size:13px; font-weight:500; color:var(--dim); margin:0 0 12px;}
.lede{color:var(--dim); max-width:56ch; margin:0 0 20px;}
.fine{color:var(--dimmer); font-size:12.5px; max-width:64ch; margin:12px 0 0;}
.err{color:var(--bad); font-size:13px; margin-top:10px; line-height:1.45;
  background:#2a1512; border-left:2px solid var(--bad); padding:10px 12px; border-radius:2px;}

.btn{border:1px solid var(--line); background:transparent; color:var(--text);
  padding:9px 16px; border-radius:3px; font-size:14px; cursor:pointer; font-family:inherit;
  transition:border-color .12s, background .12s;}
.btn:hover:not(:disabled){border-color:#3d4442;}
.btn:disabled{opacity:.32; cursor:not-allowed;}
.btn.primary{background:var(--good); border-color:var(--good); color:#04120a; font-weight:600;}
.btn.primary:hover:not(:disabled){background:#96e9b5; border-color:#96e9b5;}
.btn.sm{padding:5px 11px; font-size:13px;}
.btn.wide{width:100%; margin-top:10px;}
.field{background:var(--panel2); border:1px solid var(--line); color:var(--text);
  padding:9px 12px; border-radius:3px; font-size:14px; font-family:inherit; width:100%;}
.field::placeholder{color:var(--dimmer);}

/* sign in */
.signin{min-height:100vh; display:flex; align-items:center; justify-content:center; padding:24px;}
.signin-inner{width:100%; max-width:560px;}
.signin-trace{width:100%; height:64px; display:block; margin-bottom:28px; opacity:.85;}
.drivers{margin-bottom:12px;}
.drivers li{display:flex; align-items:stretch; gap:6px;}
.drivers li .item{flex:1;}
.x{background:transparent; border:1px solid var(--line); color:var(--dimmer);
  min-width:34px; padding:0 8px; border-radius:3px; cursor:pointer; font-size:16px;
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
  padding:7px 18px; border-radius:3px; font-size:14px; cursor:pointer; font-family:inherit;}
.cat.on{border-color:var(--text); color:var(--text);}
.cat.empty{opacity:.45;}
.cat-note{color:var(--dimmer); font-size:13px; margin:10px 0 22px;}

.cols{display:grid; grid-template-columns:1fr 1fr 1.5fr; gap:26px; flex:1; align-items:start;}
.list{list-style:none; margin:0; padding:0; display:flex; flex-direction:column; gap:4px;}
.item{width:100%; text-align:left; background:var(--panel); border:1px solid transparent;
  border-left:2px solid var(--line); color:var(--text); padding:11px 14px; cursor:pointer;
  font-family:inherit; display:flex; justify-content:space-between; align-items:baseline; gap:12px;
  transition:border-color .12s, background .12s;}
.item:hover{background:var(--panel2);}
.item.on{border-left-color:var(--good); background:var(--panel2);}
.item-name{font-size:14.5px;}
.item-sub{color:var(--dimmer); font-size:12.5px;}
.preview{width:100%; height:190px; display:block; background:var(--panel); border:1px solid var(--line);}
.meta{display:flex; gap:18px; margin-top:10px; font-size:12.5px; color:var(--dimmer);}
.meta .best{color:var(--good);}

.dock{display:flex; align-items:center; justify-content:space-between; gap:20px; flex-wrap:wrap;
  border-top:1px solid var(--line); margin-top:26px; padding:16px 0 22px;}
.dev{display:flex; align-items:center; gap:12px;}
.dot{width:8px; height:8px; border-radius:50%; background:var(--bad); flex:none;}
.dot.live{background:var(--good);}
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
.step.on{border-left-color:var(--good); background:var(--panel2);}
.step.did{opacity:.55;}
.step-n{color:var(--dimmer); font-size:13px; width:14px; flex:none;}
.step-label{font-size:14.5px;}
.step-help{color:var(--dimmer); font-size:12.5px; margin-top:4px; max-width:44ch;}
.step-live{font-size:12.5px; margin-top:6px; color:var(--dim);
  font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;}
.step-live.ok{color:var(--good);}
.cal-actions{display:flex; gap:10px; margin-top:20px;}
.dev-block{margin-bottom:18px;}
.dev-head{display:flex; justify-content:space-between; align-items:baseline; gap:12px;
  padding-bottom:7px; margin-bottom:9px; border-bottom:1px solid var(--line);}
.dev-title{font-size:13.5px;}
.dev-count{font-size:11.5px; color:var(--dimmer);}
.cal-right{min-width:0;}
.slider{display:flex; align-items:center; gap:14px; margin-top:10px;}
.slider input[type=range]{flex:1; accent-color:var(--good); background:transparent;}
.slider .num{font-size:13px; width:56px; text-align:right; color:var(--text);}
.feel-row{display:grid; grid-template-columns:72px 1fr 50px 76px; align-items:center;
  gap:11px; margin-bottom:9px;}
.feel-label{font-size:13.5px; color:var(--dim);}
.feel-track{height:9px; background:var(--panel2); border-radius:5px; position:relative; overflow:hidden;}
.feel-mid{position:absolute; left:50%; top:0; width:1px; height:100%; background:#2f3634;}
.feel-fill{position:absolute; top:0; height:100%; background:var(--good); border-radius:5px;}
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
  font:inherit; font-size:13.5px; padding:3px 6px; border-radius:3px; min-width:0;}
.corner-name:hover{border-color:var(--line);}
.corner-name:focus{border-color:var(--good); background:var(--panel2); outline:none;}
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
.axis.mapped .axis-fill{background:var(--good);}
.axis-v{font-size:12px; color:var(--dim); text-align:right;}
.axis-role{font-size:11.5px; color:var(--good);}

/* run */
.run{height:100vh; display:flex; flex-direction:column; background:var(--bg); position:relative;}
.run-top{display:flex; align-items:center; justify-content:space-between; gap:20px; padding:14px 22px;}
.run-label{color:var(--dim); font-size:14px;}
.run-stats{display:flex; gap:28px; align-items:baseline;}
.big{font-size:26px; font-weight:600;}
.big.live{color:var(--good);}
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
.pb{color:var(--good); font-size:13px; margin-top:6px;}
.bars{display:flex; flex-direction:column; gap:10px; max-width:640px;}
.bar-row{display:grid; grid-template-columns:74px 1fr 36px 90px; align-items:center; gap:12px;}
.bar-name{font-size:14px; color:var(--dim);}
.bar{height:6px; background:var(--panel2); border-radius:3px; overflow:hidden;}
.bar-fill{height:100%; background:var(--good);}
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
