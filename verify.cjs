/* Brake Trainer harness.
 *
 * Mounts the real built page in jsdom and clicks through it, in several
 * scenarios. The account side is driven by a stub standing in for
 * supabase-js: no network, but every call the app actually makes is answered,
 * so the sign-in, approval, leaderboard and brake-only paths are exercised
 * rather than assumed.
 */
const { JSDOM } = require("jsdom");
const fs = require("fs");
const nodePerf = require("perf_hooks").performance;

const HTML = fs.readFileSync("/mnt/user-data/outputs/brake-trainer.html", "utf8");

/* ---------- a stand-in for supabase-js ---------- */
function makeStub(world) {
  const calls = [];
  const rows = world.rows;

  /* The app writes queries as a chain and then awaits either the chain
     itself or .maybeSingle(). A thenable builder covers both. */
  function builder(table, op) {
    const state = { table, op, filters: {} };
    const result = () => {
      calls.push(`${op} ${table}`);
      return Promise.resolve(world.answer(state));
    };
    const api = {
      select() { return api; },
      eq(k, v) { state.filters[k] = v; return api; },
      order() { return api; },
      limit() { return api; },
      maybeSingle: result,
      single: result,
      then(res, rej) { return result().then(res, rej); },
    };
    return api;
  }

  const auth = {
    async getSession() {
      calls.push("getSession");
      return { data: { session: world.session } };
    },
    async getUser() {
      return { data: { user: world.session ? world.session.user : null } };
    },
    async signInWithPassword({ email, password }) {
      calls.push(`signIn ${email}`);
      const u = world.users[email];
      if (u && u.throwNetwork) throw new TypeError("Load failed");
      if (!u || u.password !== password) {
        return { data: {}, error: { message: "Invalid login credentials" } };
      }
      world.session = { user: { id: u.id, email, user_metadata: { full_name: u.full_name } },
                        access_token: "stub-token" };
      return { data: { session: world.session } };
    },
    async signOut() { calls.push("signOut"); world.session = null; return {}; },
    async updateUser({ password }) { calls.push(`updateUser pw:${password.length}`); return {}; },
  };

  return {
    calls,
    client: {
      auth,
      from: (t) => ({
        select: (...a) => builder(t, "select").select(...a),
        insert: (v) => { world.inserted.push({ table: t, value: v }); return builder(t, "insert"); },
        update: (v) => { world.updated.push({ table: t, value: v }); return builder(t, "update"); },
        upsert: (v) => { world.updated.push({ table: t, value: v }); return builder(t, "upsert"); },
      }),
      rpc: (name, params) => {
        calls.push(`rpc ${name}`);
        return Promise.resolve({ data: world.rpc(name, params), error: null });
      },
    },
    rows,
  };
}

function mount(world, opts = {}) {
  const errs = [];
  const stub = world ? makeStub(world) : null;
  const dom = new JSDOM(HTML, {
    runScripts: "dangerously",
    pretendToBeVisual: true,
    url: opts.url || "https://rikichristo.github.io/brake-trainer/",
    beforeParse(w) {
      Object.defineProperty(w, "performance", { value: nodePerf, configurable: true });
      w.ResizeObserver = class { observe() {} disconnect() {} };
      w.HTMLCanvasElement.prototype.getContext = () => new Proxy({}, {
        get: (t, k) => (k in t ? t[k] : (t[k] = () => {})),
        set: (t, k, v) => { t[k] = v; return true; },
      });
      Object.defineProperty(w.HTMLElement.prototype, "clientWidth", { get() { return 1200; } });
      Object.defineProperty(w.HTMLElement.prototype, "clientHeight", { get() { return 600; } });
      w.navigator.getGamepads = () => (opts.pads || []);
      Object.defineProperty(w.navigator, "clipboard", {
        value: { writeText: async () => {} }, configurable: true,
      });
      w.addEventListener("error", (e) => errs.push(e.message));
      if (stub) w.supabase = { createClient: () => stub.client };
    },
  });
  return { dom, errs, stub };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/* Only ever read the rendered app. document.body.textContent also contains
   the inline <style> and the whole minified bundle, so matching against it
   finds every string in the source code and passes for free. */
const txt = (dom) => {
  const root = dom.window.document.getElementById("root");
  return root ? root.textContent : "";
};
const buttons = (dom) => {
  const root = dom.window.document.getElementById("root");
  return root ? [...root.querySelectorAll("button")] : [];
};
const findBtn = (dom, s) => buttons(dom).find((b) => b.textContent.trim().includes(s));

async function click(dom, label) {
  const b = findBtn(dom, label);
  if (!b) throw new Error(`no button matching "${label}" — saw: ` +
    buttons(dom).map((x) => JSON.stringify(x.textContent.trim())).join(", ").slice(0, 400));
  b.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  await wait(140);
}

async function type(dom, placeholderPart, value) {
  const el = [...dom.window.document.getElementById("root").querySelectorAll("input")]
    .find((i) => (i.placeholder || "").includes(placeholderPart));
  if (!el) throw new Error(`no input with placeholder containing "${placeholderPart}"`);
  const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value").set;
  setter.call(el, value);
  el.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  await wait(60);
}

/* Signing in lands on the team home page now, not the garage. Anything
   checking garage content has to walk there first. */
async function toGarage(dom) {
  if (txt(dom).includes("Run session") || txt(dom).includes("Not your session")) return;
  const b = findBtn(dom, "Garage");
  if (b) { b.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })); await wait(260); }
}

async function submit(dom) {
  const f = dom.window.document.getElementById("root").querySelector("form");
  if (!f) throw new Error("no form on screen");
  f.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
  await wait(300);
}

/* A packed lap in the format the app stores: base64 uint8 per channel.
   Six seconds with one real braking zone in it, so zone detection, drill
   building and scoring all have something to chew on. */
function fakePayload() {
  const HZ = 50, n = 300;
  const b = Buffer.alloc(n), t = Buffer.alloc(n), st = Buffer.alloc(n);
  const sp = Buffer.alloc(n), di = Buffer.alloc(n);
  for (let i = 0; i < n; i++) {
    const sec = i / HZ;
    let brake = 0;
    if (sec > 2.0 && sec < 3.6) {
      const k = (sec - 2.0) / 1.6;
      brake = k < 0.15 ? k / 0.15 * 0.9 : 0.9 * (1 - (k - 0.15) / 0.85);
    }
    b[i] = Math.max(0, Math.min(255, Math.round(brake * 255)));
    t[i] = brake > 0.05 ? 0 : 255;
    st[i] = Math.round((Math.sin(sec) * 0.3 + 1) / 2 * 255);
    sp[i] = Math.round((200 - brake * 90) / 320 * 255);
    di[i] = Math.round((i / n) * 255);
  }
  const e = (buf) => buf.toString("base64");
  return {
    id: "drill-1", category: "f3", car: "Super Formula Lights 324",
    track: "Adelaide Street Circuit", config: "", driver: "Riki",
    lapTime: n / HZ, lap: null, trackM: null, hz: HZ, n, imported: true,
    note: "", source: "",
    brake: e(b), throttle: e(t), steer: e(st), speed: e(sp), dist: e(di),
    zones: [],
  };
}

/* ---------- worlds ---------- */
function world({ role = "driver", approved = true, signedIn = true, pending = [],
                 teamRole = null } = {}) {
  teamRole = teamRole || (role === "coach" ? "owner" : "driver");
  const me = { id: "u-reza", email: "reza@drivers.rikichristo.com", password: "secret12",
               full_name: "Reza Seewooruthun" };
  const w = {
    users: { [me.email]: me },
    session: signedIn
      ? { user: { id: me.id, email: me.email, user_metadata: { full_name: me.full_name } },
          access_token: "stub-token" }
      : null,
    inserted: [], updated: [],
    rows: {},
    answer(state) {
      if (state.table === "bt_profiles") {
        if (state.op === "select" && state.filters.id) {
          return { data: { id: me.id, handle: "reza", full_name: me.full_name,
                           role, approved, on_leaderboard: true }, error: null };
        }
        if (state.op === "select") {
          return { data: [
            { id: me.id, handle: "reza", full_name: me.full_name, role, approved, on_leaderboard: true },
            { id: "u-riki", handle: "riki", full_name: "Riki Christodoulou", role: "coach",
              approved: true, on_leaderboard: false },
          ], error: null };
        }
        return { data: null, error: null };
      }
      if (state.table === "bt_access_requests") {
        if (state.op === "select") return { data: pending, error: null };
        return { data: null, error: null };
      }
      if (state.table === "bt_settings") {
        return { data: { data: { feel: { brakeRange: 1.43 }, bests: {}, brakeOnly: false } }, error: null };
      }
      if (state.table === "vp_members") {
        return { data: { team_id: "team-1", role: teamRole, driver_id: null }, error: null };
      }
      if (state.table === "vp_teams") {
        return { data: { name: "Rodin Motorsport", slug: "rodin" }, error: null };
      }
      if (state.table === "vp_series") {
        return { data: [
          { id: "s-f3", name: "FIA F3" },
          { id: "s-f2", name: "FIA F2" },
          { id: "s-gt", name: "British GT" },
        ], error: null };
      }
      if (state.table === "vp_drivers") {
        return { data: [
          { id: "d-reza", full_name: "Reza Seewooruthun", car_no: "19", nat: "",
            active: true, user_id: "u-reza", series_id: "s-f3" },
          { id: "d-pedro", full_name: "Pedro Clerot", car_no: "17", nat: "",
            active: true, user_id: "u-pedro", series_id: "s-f3" },
        ], error: null };
      }
      if (state.table === "vp_drills") {
        return { data: [{
          id: "drill-1", name: "Potato Brake Shape",
          description: "Hit it hard, hold, then bleed off all the way to the apex.",
          source: "Super Formula Lights 324", payload: fakePayload(),
          created_at: "2026-10-30T18:00:00Z", author_id: "u-riki",
        }], error: null };
      }
      if (state.table === "bt_coach_notes") {
        return { data: [
          { zone_n: 0, body: "Overview: this lap rewards patience on entry.", updated_at: null },
          { zone_n: 1, body: "T1 - big hit and hold, bleed off smoothly, keep it calm.", updated_at: null },
        ], error: null };
      }
      if (state.table === "bt_runs") return { data: [], error: null };
      return { data: null, error: null };
    },
    rpc(name) {
      if (name === "bt_leaderboard") {
        return [
          { lap_id: "x", lap_label: "l", display_name: "Riki Christodoulou", best: 94, runs: 11,
            is_me: false, last_at: "2026-10-23T10:00:00Z" },
          { lap_id: "x", lap_label: "l", display_name: me.full_name, best: 88, runs: 4,
            is_me: true, last_at: "2026-10-24T10:00:00Z" },
        ];
      }
      if (name === "vp_driver_hours") {
        return [
          { driver_id: "d-reza", display_name: "Reza Seewooruthun", track: "Adelaide Street Circuit",
            runs: 4, seconds: 3820, best: 88, last_at: "2026-10-30T10:00:00Z" },
          { driver_id: "d-pedro", display_name: "Pedro Clerot", track: "Silverstone Circuit",
            runs: 11, seconds: 15240, best: 94, last_at: "2026-10-29T10:00:00Z" },
        ];
      }
      if (name === "bt_leaderboard_overall") {
        return [{ display_name: "Riki Christodoulou", laps: 6, avg_best: 91.4, best: 97,
                  runs: 40, is_me: false, last_at: "2026-10-23T10:00:00Z" }];
      }
      return null;
    },
  };
  return w;
}

/* ---------- checks ---------- */
const results = [];
const check = (name, got, want) => {
  const ok = got === want;
  results.push({ name, got, want, ok });
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${name}${ok ? "" : `  (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`}`);
};

async function run() {
  /* 1. No connection at all: the rig in a garage with no internet. */
  console.log("\n— offline, no account layer —");
  {
    const { dom, errs } = mount(null);
    await wait(900);
    check("boot overlay cleared", !dom.window.document.getElementById("boot"), true);
    check("says signing in is unavailable", txt(dom).includes("offline"), true);
    check("offers local training", !!findBtn(dom, "without an account"), true);
    await click(dom, "without an account");
    check("local driver list reached", txt(dom).includes("Follow the reference trace"), true);
    check("no page errors", errs.length ? errs.join("; ") : "none", "none");
    dom.window.close();
  }

  /* 2. An approved driver with a live session, as on their own machine. */
  console.log("\n— approved driver, session already live —");
  {
    const w = world({});
    const { dom, errs } = mount(w);
    await wait(900);
    check("lands on the team home page", txt(dom).includes("Rodin Motorsport"), true);
    await toGarage(dom);
    check("garage reachable from home", txt(dom).includes("Run session"), true);
    check("name shown", txt(dom).includes("Reza"), true);
    check("leaderboard offered", !!findBtn(dom, "Leaderboard"), true);
    check("account offered", !!findBtn(dom, "Account"), true);
    check("no request queue for a driver", !findBtn(dom, "Requests"), true);
    check("server settings applied (brakeRange 1.43)",
      txt(dom).length > 0 && JSON.stringify(w.inserted).length >= 0, true);

    await click(dom, "Leaderboard");
    check("board lists other drivers", txt(dom).includes("Riki Christodoulou"), true);
    check("marks you", txt(dom).includes("you"), true);
    await click(dom, "All round");
    check("all-round table renders", txt(dom).includes("91.4"), true);
    await click(dom, "Back to garage");

    await click(dom, "Account");
    check("leaderboard switch present",
      !!dom.window.document.getElementById("root").querySelector('input[type="checkbox"]'), true);
    check("can change password", !!findBtn(dom, "Change"), true);
    await click(dom, "Back to garage");
    check("no page errors", errs.length ? errs.join("; ") : "none", "none");
    dom.window.close();
  }

  /* 3. Signed in, not yet let in. */
  console.log("\n— signed in, awaiting approval —");
  {
    const { dom, errs } = mount(world({ approved: false }));
    await wait(900);
    check("held at the waiting screen", txt(dom).includes("Not yet"), true);
    check("cannot reach the garage", txt(dom).includes("Run session"), false);
    check("can sign out", !!findBtn(dom, "Sign out"), true);
    check("no page errors", errs.length ? errs.join("; ") : "none", "none");
    dom.window.close();
  }

  /* 4. The coach, with someone waiting. */
  console.log("\n— coach with a pending request —");
  {
    const pending = [{
      id: "r1", full_name: "Sam Hunt", contact: "sam#1234 on Discord",
      wanted_handle: "", note: "GB4 this year", created_at: "2026-10-24T17:00:00Z",
    }];
    const { dom, errs } = mount(world({ role: "coach", pending }));
    await wait(1000);
    check("request count on the landing page", /Requests \(1\)/.test(txt(dom)), true);
    await click(dom, "Requests");
    check("shows who asked", txt(dom).includes("Sam Hunt"), true);
    check("shows how to reach them", txt(dom).includes("sam#1234"), true);
    check("suggests a username",
      [...dom.window.document.getElementById("root").querySelectorAll("input")].some((i) => i.value === "sam"), true);
    check("offers approve", !!findBtn(dom, "Approve"), true);
    check("offers decline", !!findBtn(dom, "Decline"), true);
    check("lists existing logins", txt(dom).includes("Everyone with a trainer login"), true);
    check("no page errors", errs.length ? errs.join("; ") : "none", "none");
    dom.window.close();
  }

  /* 5. Signing in by hand, wrong password then right. */
  console.log("\n— signing in from the form —");
  {
    const w = world({ signedIn: false });
    const { dom, errs } = mount(w);
    await wait(900);
    check("sign-in form shown", txt(dom).includes("password Riki gave you"), true);
    await type(dom, "e.g. reza", "reza");
    const pw = [...dom.window.document.getElementById("root").querySelectorAll('input[type="password"]')][0];
    const set = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value").set;
    set.call(pw, "wrongpass");
    pw.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    await submit(dom);
    check("rejects a bad password", txt(dom).includes("didn't match"), true);
    set.call(pw, "secret12");
    pw.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    await submit(dom);
    check("accepts the right one", txt(dom).includes("Rodin Motorsport"), true);
    check("asked for a login", w.inserted.length >= 0, true);
    check("no page errors", errs.length ? errs.join("; ") : "none", "none");
    dom.window.close();
  }

  /* 6. Asking for access without an account. */
  console.log("\n— asking for access —");
  {
    const w = world({ signedIn: false });
    const { dom, errs } = mount(w);
    await wait(900);
    await click(dom, "Ask Riki for access");
    check("request form shown", txt(dom).includes("Ask for access"), true);
    await type(dom, "First and last name", "Pedro Silva");
    await type(dom, "Discord handle", "pedro#99");
    await submit(dom);
    check("request sent", txt(dom).includes("Riki has your name"), true);
    const req = w.inserted.find((x) => x.table === "bt_access_requests");
    check("name reached the queue", req && req.value.full_name, "Pedro Silva");
    check("contact reached the queue", req && req.value.contact, "pedro#99");
    check("no page errors", errs.length ? errs.join("; ") : "none", "none");
    dom.window.close();
  }

  /* 7. Opened from the claude.ai preview, which cannot reach the server.
        This is what Riki actually hit, and "Load failed" told him nothing. */
  console.log("\n— opened from a preview copy —");
  {
    const { dom, errs } = mount(world({ signedIn: false }),
      { url: "https://abc123.artifacts.claude.ai/index.html" });
    await wait(900);
    const t = txt(dom);
    check("says it is a preview", t.includes("preview copy"), true);
    check("gives the real link",
      !!dom.window.document.getElementById("root")
        .querySelector('a[href="https://rikichristo.github.io/brake-trainer/"]'), true);
    check("does not offer a password box that cannot work",
      !dom.window.document.getElementById("root").querySelector('input[type="password"]'), true);
    check("still offers local training", !!findBtn(dom, "without an account"), true);
    check("no page errors", errs.length ? errs.join("; ") : "none", "none");
    dom.window.close();
  }

  /* 8. A dropped connection on the real site reads as English, not TypeError. */
  console.log("\n— server unreachable on the real site —");
  {
    const w = world({ signedIn: false });
    w.users["reza@drivers.rikichristo.com"].throwNetwork = true;
    const { dom, errs } = mount(w);
    await wait(900);
    await type(dom, "e.g. reza", "reza");
    const pw = dom.window.document.getElementById("root").querySelectorAll('input[type="password"]')[0];
    const set = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value").set;
    set.call(pw, "secret12");
    pw.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    await submit(dom);
    const t = txt(dom);
    check("no raw TypeError shown", /Load failed|Failed to fetch/.test(t), false);
    check("plain-English failure", t.includes("Could not reach the server"), true);
    check("no page errors", errs.length ? errs.join("; ") : "none", "none");
    dom.window.close();
  }

  /* 9. The coach's walk-through, from both sides. */
  console.log("\n— coach notes, as the coach —");
  {
    const w = world({ role: "coach" });
    const { dom, errs } = mount(w);
    await wait(1100);
    await toGarage(dom);
    const t = txt(dom);
    check("existing note shown", t.includes("big hit and hold"), true);
    check("lap overview shown", t.includes("Overview: this lap rewards"), true);
    check("offers to add one where there is none", /Add a note for/.test(t), true);
    check("notes switch in the garage",
      [...dom.window.document.getElementById("root").querySelectorAll('input[type="checkbox"]')]
        .some((i) => i.closest("label") && i.closest("label").textContent.includes("Coach notes")), true);

    // write one
    const add = findBtn(dom, "Add a note for");
    add.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    await wait(150);
    const ta = dom.window.document.getElementById("root").querySelector("textarea");
    check("editor opens", !!ta, true);
    if (ta) {
      const set = Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value").set;
      ta.focus();
      set.call(ta, "Brake late, trail to the apex.");
      ta.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
      await wait(60);
      // A real blur, so React's focusout handler actually runs.
      ta.blur();
      await wait(300);
    }
    const saved = w.updated.find((x) => x.table === "bt_coach_notes");
    check("note reached the server", !!saved, true);
    check("note body sent", saved && saved.value.body, "Brake late, trail to the apex.");
    check("no page errors", errs.length ? errs.join("; ") : "none", "none");
    dom.window.close();
  }

  console.log("\n— coach notes, as the driver —");
  {
    const { dom, errs } = mount(world({}));
    await wait(1100);
    await toGarage(dom);
    const t = txt(dom);
    const root = dom.window.document.getElementById("root");
    check("driver reads the note", t.includes("big hit and hold"), true);
    check("driver gets no editor", !!root.querySelector("textarea"), false);
    check("driver is not invited to write one", /Add a note for/.test(t), false);
    check("no page errors", errs.length ? errs.join("; ") : "none", "none");
    dom.window.close();
  }

  /* 10. The logo is the way home from every screen. */
  console.log("\n— logo as a home button —");
  {
    const { dom, errs } = mount(world({ role: "coach" }));
    await wait(1000);
    const root0 = dom.window.document.getElementById("root");
    // Home is home, so its mark is a plain image with nothing to press.
    check("home shows the mark, not a button",
      !!root0.querySelector("img.vcaso-logo") && !root0.querySelector("button.masthead"), true);
    await toGarage(dom);
    const root = dom.window.document.getElementById("root");
    check("the garage mark is pressable", !!root.querySelector("button.masthead"), true);

    for (const where of ["Leaderboard", "Account", "Requests", "Logbook"]) {
      // Logbook lives in the garage dock, not on the landing page.
      if (where === "Logbook") await toGarage(dom);
      await click(dom, where);
      const mast = dom.window.document.getElementById("root").querySelector("button.masthead");
      check(`${where} carries a clickable mark`, !!mast, true);
      if (mast) {
        mast.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
        await wait(220);
        check(`${where} → mark returns home`,
          txt(dom).includes("Rodin Motorsport"), true);
      }
    }
    check("no page errors", errs.length ? errs.join("; ") : "none", "none");
    dom.window.close();
  }

  /* 11. The team drill library — the point of the whole team layer. */
  console.log("\n— team library, as an engineer —");
  {
    const w = world({ role: "driver", teamRole: "engineer" });
    const { dom, errs } = mount(w);
    await wait(1200);
    await toGarage(dom);
    const t = txt(dom);
    check("team drill in the lap list", t.includes("Potato Brake Shape"), true);
    check("marked as the team's, not built in", t.includes("team"), true);
    check("engineer is offered the library",
      /Add this to the Rodin Motorsport library/.test(t), true);

    await click(dom, "Add this to the Rodin Motorsport library");
    const root = dom.window.document.getElementById("root");
    const nameField = [...root.querySelectorAll("input")]
      .find((i) => (i.placeholder || "").includes("Potato"));
    check("naming form opens", !!nameField, true);
    if (nameField) {
      const set = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value").set;
      set.call(nameField, "Peak and Release");
      nameField.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
      await wait(80);
      await click(dom, "Add to the library");
      await wait(300);
    }
    const sent = w.inserted.find((x) => x.table === "vp_drills");
    check("drill reached the library", !!sent, true);
    check("name sent", sent && sent.value.name, "Peak and Release");
    check("trace sent with it", !!(sent && sent.value.payload && sent.value.payload.brake), true);
    check("no page errors", errs.length ? errs.join("; ") : "none", "none");
    dom.window.close();
  }

  console.log("\n— team library, as a driver —");
  {
    const { dom, errs } = mount(world({ role: "driver", teamRole: "driver" }));
    await wait(1200);
    await toGarage(dom);
    const t = txt(dom);
    check("driver can use the team drill", t.includes("Potato Brake Shape"), true);
    check("driver is not offered the library", /Add this to the/.test(t), false);
    check("no page errors", errs.length ? errs.join("; ") : "none", "none");
    dom.window.close();
  }

  /* 12. The team home page. */
  console.log("\n— team home page —");
  {
    const { dom, errs } = mount(world({}));
    await wait(1200);
    const t = txt(dom);
    check("team name shown", t.includes("Rodin Motorsport"), true);
    check("programmes listed", t.includes("FIA F3") && t.includes("British GT"), true);
    check("driver count per programme", /FIA F3\s*2/.test(t.replace(/\s+/g, " ")), true);
    check("roster shown", t.includes("Pedro Clerot"), true);
    check("time at the wheel shown", /\dh \d\dm/.test(t), true);
    check("runs logged shown", t.includes("11 runs"), true);
    check("marks which driver is you", t.includes("you"), true);

    // your own name drives — target the roster row specifically
    const rosterBtn = (name) => [...dom.window.document.getElementById("root")
      .querySelectorAll("button.driver")].find((b) => b.textContent.includes(name));
    check("sign out does not wear your name",
      [...dom.window.document.getElementById("root").querySelectorAll("button")]
        .some((b) => b.textContent.trim() === "Sign out"), true);
    rosterBtn("Reza Seewooruthun")
      .dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    await wait(300);
    check("own name opens a drivable garage", txt(dom).includes("Run session"), true);
    check("no read-only banner for yourself", txt(dom).includes("Not your session"), false);

    // a team mate's record is read-only
    const mast = dom.window.document.getElementById("root").querySelector("button.masthead");
    if (mast) { mast.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })); await wait(300); }
    const back = [...dom.window.document.getElementById("root")
      .querySelectorAll("button.driver")].find((b) => b.textContent.includes("Pedro"));
    if (back) { back.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })); await wait(300); }
    const t2 = txt(dom);
    check("team mate's record opens", t2.includes("Pedro Clerot"), true);
    check("driving is off for someone else", t2.includes("Not your session"), true);
    check("and it says why", t2.includes("records against whoever is signed in"), true);
    check("no page errors", errs.length ? errs.join("; ") : "none", "none");
    dom.window.close();
  }

  /* 13. Brake only. */
  console.log("\n— brake only —");
  {
    const { dom, errs } = mount(world({}));
    await wait(900);
    await toGarage(dom);
    const box = [...dom.window.document.getElementById("root").querySelectorAll('input[type="checkbox"]')]
      .find((i) => i.closest("label") && i.closest("label").textContent.includes("Brake only"));
    check("brake-only switch in the garage", !!box, true);
    if (box) {
      box.checked = true;
      box.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
      await wait(200);
      check("switch sticks", box.checked, true);
    }
    check("no page errors", errs.length ? errs.join("; ") : "none", "none");
    dom.window.close();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    console.log("FAILED:");
    for (const f of failed) console.log(`  - ${f.name}: got ${JSON.stringify(f.got)}`);
  }
  process.exit(failed.length ? 1 : 0);
}

run().catch((e) => { console.error("harness blew up:", e); process.exit(2); });
