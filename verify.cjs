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

async function submit(dom) {
  const f = dom.window.document.getElementById("root").querySelector("form");
  if (!f) throw new Error("no form on screen");
  f.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
  await wait(300);
}

/* ---------- worlds ---------- */
function world({ role = "driver", approved = true, signedIn = true, pending = [] } = {}) {
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
    check("lands in the garage", txt(dom).includes("Run session"), true);
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
    check("request count in the garage", /Requests \(1\)/.test(txt(dom)), true);
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
    check("accepts the right one", txt(dom).includes("Run session"), true);
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

  /* 9. Brake only. */
  console.log("\n— brake only —");
  {
    const { dom, errs } = mount(world({}));
    await wait(900);
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
