//! e2e checklist runner (docs/E2E_CHECKLIST.md scenarios 1-16).
//! drives the REAL tauri app (debug build + vite dev server) over cdp —
//! real ipc, real yt-dlp processes, real network. assertions poll engine
//! truth via in-page `invoke()` (window.__TAURI_INTERNALS__.invoke), NOT
//! dom scraping; dom is only used to perform ui actions and verify ui-only
//! surfaces (warnings, feedback, hover card, flash).
//!
//! usage: node scripts/e2e/run.cjs [--only 1,4,13] [--smoke] [--list]
//! --only selects GROUPS (a group runs all its scenarios on a fresh
//! sandbox — chains like s8←s11 are group-internal state); --smoke skips
//! youtube-tagged scenarios (bot-gate). results print as a table and are
//! written to docs/E2E_RESULTS.md.

const fs = require("fs");
const path = require("path");
const { launchAndAttach, waitFor, evalAsync: rawEval, sleep, pressKey } = require("./cdp.cjs");

/** retrying evaluate: the vite dev client reloads the page at least once
 * shortly after launch, which throws "page threw" from any in-flight eval.
 * ui-driving and read-only evals are idempotent, so retry with bundle
 * re-injection. */
async function evalAsync(ws, expr, retries = 5) {
  for (let i = 0; ; i++) {
    try {
      return await rawEval(ws, expr);
    } catch (e) {
      const retryable = /page threw|timed out|context/i.test(e.message);
      if (i >= retries || !retryable) throw e;
      await sleep(700);
      try { await ensureBundle(); } catch { /* still reloading */ }
    }
  }
}

const PORT = 9333;
const ROOT = path.resolve(__dirname, "../..");
const EXE = path.resolve(ROOT, "src-tauri/target/debug/ytdlp-gui.exe");

// d91 harness redesign: PER-GROUP SANDBOXES. the suite's entire flake class
// (leftover duplicate rows blocking d33, stale done jobs poisoning waitJob,
// dialogs from earlier scenarios' files, persisted composeOpts leaking
// across boundaries) came from one root cause: every scenario shared one
// data dir + one destination, so each scenario had to defensively clean up
// after every other. the redesign gives each *group* of scenarios a fresh
// profile (YTDLP_GUI_DATA_DIR) and destination; scenarios inside a group
// share state only where the test claim genuinely chains (s3→s2's archive
// counter, s1→s4's archived duplicate, s6→s15's bbb, s18→s19's a-walk).
// every group starts from a wiped sandbox + seeded settings + a fresh app
// process — no scenario can see another group's leftovers, ever.
//
// the app resolves app_data_dir() from YTDLP_GUI_DATA_DIR (manager.rs), and
// every store path funnels through it — the override is total.
let DATA_DIR = ""; // reassigned per group before launch
let DL_DIR = ""; // <repo>/e2e-dl/<group> — per group
const DATA_DIR_SQL = () => DATA_DIR.replace(/\\/g, "/"); // python -c paths want forward slashes
const LEGACY_PROFILE = process.env.APPDATA + "\\\\ytdlp-gui";

// scenario groups: shared state ONLY where a claim genuinely chains.
//   download-core — s1 downloads zoo; s4 re-queues it (archive skip); s3
//     downloads tycho items 1-2; s2 re-runs the album (counter 10/10).
//   intake-errors — no youtube; garbage/intranet/soundcloud/dead-url.
//   options-contract — zoo-based webm/d19/relink + keyboard shortcuts.
//   lifecycle — concurrency/stop/pause/restart on the big bbb job.
//   gates-archive — bandcamp gates + archive import/reconcile + reset last.
const GROUPS = [
  { name: "download-core", scenarios: [1, 4, 3, 2] },
  { name: "intake-errors", scenarios: [9, 10, 12] },
  { name: "options-contract", scenarios: [11, 13, 14, 8, 7] },
  { name: "lifecycle", scenarios: [5, 6, 15, 16] },
  { name: "gates-archive", scenarios: [18, 19, 20, 21, 23, 22] },
];

// stable, live test targets (probed 2026-09 with the staged yt-dlp 2026.08.19)
const ZOO = "https://www.youtube.com/watch?v=jNQXAC9IVRw"; // 19s, ~2MB
const ZOO_SHORT = "https://youtu.be/jNQXAC9IVRw"; // same video, different url (S5)
const TYCHO = "https://tycho.bandcamp.com/album/dive"; // 10-track album
const SC_FLICKER = "https://soundcloud.com/forss/flickermood"; // single-format audio
const GARBAGE = "not a url";
const INTRANET = "http://192.168.1.1/x";
const DEAD = "https://soundcloud.com/forss/this-track-does-not-exist-xyz"; // 404 (de-youtube: platform-independent)
const DESPACITO_W = "https://www.youtube.com/watch?v=kJQP7kiw5Fk";
const DESPACITO_S = "https://youtu.be/kJQP7kiw5Fk"; // same video, different url (S5)
const GANGNAM = "https://www.youtube.com/watch?v=9bZkp7q19f0";
const BBB = "https://www.youtube.com/watch?v=aqz-KE-bpKQ"; // 4k, big/slow (S15/16)

// source manifest (d60 close-out): platform dependency per scenario.
// youtube bot-gates under load (platform-side, reproduced with the raw
// binary), so --smoke runs every scenario NOT tagged youtube — the
// CI-runnable core that needs no youtube at all.
const SOURCE = {
  1: "youtube", 4: "youtube", 3: "youtube", 2: "youtube", 9: "other",
  10: "other", 12: "other", 11: "youtube", 13: "youtube", 14: "other",
  8: "youtube", 7: "youtube", 5: "youtube", 6: "youtube", 15: "youtube",
  16: "youtube", 18: "other",  19: "other", 20: "other", 21: "none", 22: "none",
  23: "none",
};

// ---------------------------------------------------------------------------
// page-side helper bundle (injected once per page load)
// ---------------------------------------------------------------------------
const BUNDLE = `(() => {
  const $$ = (s) => [...document.querySelectorAll(s)];
  window.__e2e = {
    ipc: (cmd, args) => window.__TAURI_INTERNALS__.invoke(cmd, args ?? {}),
    tabs: () => $$('.tab-btn').map(b => ({ t: b.textContent.trim(), on: b.classList.contains('active') })),
    goto: (name) => { const b = $$('.tab-btn').find(x => x.textContent.trim() === name); if (!b) return false; b.click(); return true; },
    composer: () => document.querySelector('.card-b textarea'),
    focusComposer: () => { const el = document.querySelector('.card-b textarea'); if (!el) return false; el.focus(); return true; },
    clickText: (sel, txt, exact, token) => { const el = $$(sel).find(e => exact ? e.textContent.trim() === txt : e.textContent.trim().includes(txt)); if (!el) return false; if (token) { window.__e2e.clicks = window.__e2e.clicks || {}; if (window.__e2e.clicks[token]) return 'already'; window.__e2e.clicks[token] = 1; } el.click(); return true; },
    setSelect: (finder, value) => { const el = $$('.card select').find(finder); if (!el) return false; el.value = value; el.dispatchEvent(new Event('change', { bubbles: true })); return true; },
    containerSelect: () => $$('.card select').find(s => [...s.options].some(o => o.value === 'webm')) ?? null,
    firstNInput: () => $$('.card input[type=text]').find(i => i.style.width === '54px') ?? null,
    skipToggle: () => $$('.card label.toggle input')[0] ?? null,
    anyWarn: (needle) => $$('.card .warn').some(w => w.textContent.toLowerCase().includes(needle)),
    feedbackText: () => { const d = $$('.card-b > div').find(x => x.textContent.includes('invalid')); return d ? d.textContent : null; },
    rows: () => $$('tr.qrow').map(r => ({ status: r.dataset.status, flash: r.dataset.flash ?? null, title: r.querySelector('.t-title')?.textContent ?? '', meta: r.querySelector('.t-meta')?.textContent ?? '' })),
    rowByMeta: (needle) => $$('tr.qrow').find(r => r.querySelector('.t-meta')?.textContent.includes(needle) || r.querySelector('.t-title')?.textContent.includes(needle)) ?? null,
    clickRowBtn: (row, title) => { if (!row) return false; const b = [...row.nextElementSibling?.querySelectorAll('button') ?? [], ...row.querySelectorAll('button')].find(x => x.title === title); if (!b) return false; b.click(); return true; },
    expandRow: (row) => { if (!row) return false; const t = row.querySelector('.t-title'); if (!t) return false; t.click(); return true; },
    hoverRow: (row) => { if (!row) return false; row.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); return true; },
    hoverCard: () => document.querySelector('.hovercard-shown')?.textContent ?? null,
    flashSeen: () => $$('tr.qrow[data-flash="done"]').length > 0,
    key: (sel, key, opts = {}) => { const el = typeof sel === 'string' ? document.querySelector(sel) : sel; if (!el) return false; el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ctrlKey: !!opts.ctrl, shiftKey: !!opts.shift })); return true; },
    activeIsComposer: () => document.activeElement === document.querySelector('.card-b textarea'),
    clearComposer: () => { const b = $$('.card button.ghost').find(x => x.textContent.trim() === 'clear'); if (!b) return false; b.click(); return true; },
    queueRowsMeta: () => $$('tr.qrow .t-meta').map(m => m.textContent),
    // drive composer controls then VERIFY against the react-rendered dom
    // (classes/values derive from the same opts state that feeds the D19
    // mirror history's re-download consumes). a plain fire-and-forget dom
    // edit can silently no-op across react remounts / vite reloads — s15/s16
    // queued with stale options in round 5. note: importing Composer.tsx to
    // read currentOptions does NOT work — vite hmr means the dynamic import
    // resolves to a second module instance whose mirror never updates
    // (verified live, round 5 probes).
    applyOpts: async (partial) => {
      const $$ = (s) => [...document.querySelectorAll(s)];
      const zzz = (ms) => new Promise((r) => setTimeout(r, ms));
      try {
        if (partial.dlType !== undefined) {
          const b = $$('.card .seg button').find((x) => x.textContent.trim() === partial.dlType);
          if (!b) return 'no-' + partial.dlType + '-seg';
          if (!b.classList.contains('on')) {
            b.click();
            await zzz(200);
            if (!b.classList.contains('on')) return 'seg-no-commit';
          }
        }
        const audioMode = $$('.card .seg button').find((x) => x.textContent.trim() === 'audio')?.classList.contains('on');
        const finders = {
          audioFormat: audioMode ? (s) => [...s.options].some((o) => o.value === 'mp4container') : null,
          maxResolution: (s) => [...s.options].some((o) => o.value === '2160p'),
          container: (s) => [...s.options].some((o) => o.value === 'webm'),
          audioPref: (s) => s.options.length === 2 && s.options[0].value === 'opus',
        };
        for (const key of Object.keys(finders)) {
          if (partial[key] === undefined) continue;
          const f = finders[key];
          if (!f) return key + '-select-only-exists-in-audio-mode';
          const el = $$('.card select').find(f);
          if (!el) return 'no-' + key + '-select';
          if (el.value !== partial[key]) {
            el.value = partial[key];
            el.dispatchEvent(new Event('change', { bubbles: true }));
            await zzz(150);
            if (el.value !== partial[key]) return key + '-no-commit';
          }
        }
        if (partial.skipDownloaded !== undefined) {
          const t = $$('.card label.toggle input')[0];
          if (!t) return 'no-skip-toggle';
          if (t.checked !== partial.skipDownloaded) {
            t.click();
            await zzz(150);
            if (t.checked !== partial.skipDownloaded) return 'skip-no-commit';
          }
        }
        // d90: playlistMode / coverMode support — the mirror-verify promise
        // ("fails fast instead of silently no-oping") must cover every field
        // setOpts accepts, or a pin like s19's playlistMode=single is a silent
        // lie (found live, d90-g round: s3's leak survived the "pin").
        // overwrite deliberately has NO branch: the composer has no overwrite
        // control (it is per-action only — the d60 dialog grant or history's
        // ↻). a pin passing overwrite:true used to click toggle[1], which is
        // the ADVANCED panel's autoCaptions checkbox — corrupting state.
        if (partial.playlistMode !== undefined) {
          const label = partial.playlistMode === 'single' ? 'single video only' : partial.playlistMode === 'all' ? 'entire playlist' : 'first n…';
          const b = $$('.card .seg button').find((x) => x.textContent.trim() === label);
          if (!b) return 'no-playlist-seg-' + partial.playlistMode;
          if (!b.classList.contains('on')) {
            b.click();
            await zzz(200);
            if (!b.classList.contains('on')) return 'playlistMode-no-commit';
          }
        }
        if (partial.coverMode !== undefined) {
          const sel = $$('.card select').find((s) => [...s.options].some((o) => ['square', 'original', 'custom', 'none'].includes(o.value)));
          if (!sel) return 'no-cover-select';
          if (sel.value !== partial.coverMode) {
            const sp = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
            sp.call(sel, partial.coverMode);
            sel.dispatchEvent(new Event('change', { bubbles: true }));
            await zzz(150);
            if (sel.value !== partial.coverMode) return 'cover-no-commit';
          }
        }
        // d84/d88: cookies live in the advanced panel — open it first
        if (partial.cookies !== undefined) {
          const advBtn = $$('button').find((b) => b.textContent.trim().startsWith('advanced'));
          if (!advBtn) return 'no-advanced-btn';
          // panel open? probe for the cookie select; click the toggle if not
          let cookieSel = $$('.card select').find((s) => [...s.options].some((o) => o.value === 'frombrowser'));
          if (!cookieSel) { advBtn.click(); await zzz(250); }
          cookieSel = $$('.card select').find((s) => [...s.options].some((o) => o.value === 'frombrowser'));
          if (!cookieSel) return 'no-cookie-select';
          const want = partial.cookies;
          const val = want.kind === 'frombrowser' ? 'frombrowser' : want.kind === 'file' ? 'file' : 'none';
          if (cookieSel.value !== val) {
            // react writes through the native setter — a plain .value
            // assignment renders but never reaches state (verified live:
            // the queued job then carried cookies=none, found 2026-09-06)
            const sp = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
            sp.call(cookieSel, val);
            cookieSel.dispatchEvent(new Event('change', { bubbles: true }));
            await zzz(200);
            if (cookieSel.value !== val) return 'cookie-kind-no-commit';
          }
          if (val === 'frombrowser' && want.browser) {
            const bsel = $$('.card select').find((s) => [...s.options].some((o) => ['firefox', 'chrome', 'edge', 'brave'].includes(o.value)));
            if (!bsel) return 'no-browser-select';
            // react writes through the native setter — a plain .value
            // assignment renders but doesn't reach state (verified live:
            // the preview never showed the flag without this)
            const p = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
            p.call(bsel, want.browser);
            bsel.dispatchEvent(new Event('change', { bubbles: true }));
            await zzz(200);
            if (bsel.value !== want.browser) return 'browser-no-commit';
          }
        }
        return 'ok';
      } catch (e) { return 'applyOpts threw: ' + e.message; }
    },
  };
  return true;
})()`;

// ---------------------------------------------------------------------------
// node-side helpers
// ---------------------------------------------------------------------------
let ws;
const results = [];

function record(n, name, pass, details) {
  results.push({ n, name, pass, details });
  console.log(`  ${pass ? "PASS" : "FAIL"}  [S${n}] ${name}`);
  for (const d of details) console.log(`        · ${d}`);
}

/** poll an ipc call until pred(value) is truthy */
async function waitIpc(cmd, pred, { timeoutMs = 30000, everyMs = 400, label = "" } = {}) {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < timeoutMs) {
    try {
      await ensureBundle();
      const v = await evalAsync(ws, `window.__e2e.ipc(${JSON.stringify(cmd)})`);
      last = v;
      if (pred(v)) return v;
    } catch (e) {
      last = `eval error: ${e.message}`;
    }
    await sleep(everyMs);
  }
  throw new Error(`waitIpc timeout (${timeoutMs}) ${cmd} ${label} — last=${JSON.stringify(last)?.slice(0, 400)}`);
}

async function jobs() {
  await ensureBundle();
  return evalAsync(ws, `window.__e2e.ipc('queue_list')`);
}
async function history() {
  await ensureBundle();
  return evalAsync(ws, `window.__e2e.ipc('history_list')`);
}
async function jobBy(urLSubstring) {
  const js = await jobs();
  return js.filter((j) => j.url.includes(urLSubstring));
}

/** wait until a job matching urlSub reaches state; returns the job.
 * notAfter (unix s) restricts the match to jobs created after that moment —
 * queue_list includes FINISHED jobs forever, and stale done/fetching rows
 * from earlier scenarios (or previous runs sharing the profile) poison a
 * bare url+state match: s5 matched a stale row's `fetching` state and
 * stalled 150s, cascading into s15/s16 (full-suite find, 2026-09-04). */
async function waitJob(urlSub, state, timeoutMs = 60000, everyMs = 400, notAfter = null) {
  const match = (j) => j.url.includes(urlSub) && j.state === state && (notAfter == null || j.createdAt > notAfter);
  return waitIpc(
    "queue_list",
    (v) => v.some(match),
    { timeoutMs, everyMs, label: `url~${urlSub} state=${state}` },
  ).then(() => jobs().then((js) => js.find(match)));
}

/** queue url(s) through the composer ui and press the button (not enter).
 * insertText drives react's onChange; the native-setter fallback covers any
 * event-synthesis gap. the textarea is CLEARED first — scenarios leave text
 * behind (s9 keeps the accepted intranet url by design; s10 appended to it
 * and fetched both). */
/** queue via the composer and auto-answer the d60 dialog if it fires.
 * scenarios that legitimately re-download onto an existing file (s11's
 * container change, s15's re-queues, s16's relaunch re-queue) used to pass
 * a bogus `overwrite: true` pin — the composer has no such control (it is
 * per-action only), and the pin instead clicked the advanced panel's
 * autoCaptions toggle (found live, d90-g round). the honest way: queue,
 * then grant the dialog the engine logic would ask for. */
async function queueViaComposerOverwrite(url) {
  const t0 = Date.now();
  await queueViaComposer(url);
  const typed = Date.now();
  // grant the d60 dialog only if it actually opened — a short presence poll,
  // not answerDialog's full 8s timeout (no-dialog is the common case).
  const opened = await evalUntil(`(() => document.querySelector('[data-testid="confirm-dialog"]') ? 'yes' : 'pending')()`, { timeoutMs: 4000, everyMs: 200, label: "d60 dialog" }).catch(() => "no");
  if (opened === "yes") {
    await evalAsync(ws, `(() => { const b = document.querySelector('[data-testid="confirm-dialog"] [data-dialog-action="confirm"]'); if (b) { b.click(); return 'ok'; } return 'no-btn'; })()`);
    await sleep(300);
  }
  // d91 diagnostics: S15's BBB queue landed 139s after the click in one round
  // — this stamps every phase so the stall is attributable from the log.
  console.log(`    [qvc] ${url.slice(-24)} typed=${typed - t0}ms dialog=${opened} total=${Date.now() - t0}ms`);
}

async function queueViaComposer(url) {
  await evalAsync(ws, `(() => { const i = window.__e2e.composer(); if (!i) throw new Error('composer not found — wrong page?'); const p = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; p.call(i, ''); i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  await sleep(100);
  await evalAsync(ws, `window.__e2e.focusComposer()`);
  await ws.call("Input.insertText", { text: url });
  await sleep(150);
  const got = await evalAsync(ws, `window.__e2e.composer()?.value ?? ''`);
  if (!got.includes(url.slice(8, 40))) {
    // fallback: set + dispatch like a real edit
    await evalAsync(ws, `(() => { const i = window.__e2e.composer(); if (!i) throw new Error('composer not found — wrong page?'); const p = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; p.call(i, ${JSON.stringify(url)}); i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    await sleep(120);
  }
  // d91: the click MUST land — a silent false (button not found) turned S15's
  // BBB queue into a no-op that looked like a 139s stall downstream. assert
  // the click AND that the composer consumed the text (cleared on success,
  // kept when the d60 gate holds it for the dialog).
  const clicked = await evalAsync(ws, `window.__e2e.clickText('.card button.primary', 'queue downloads', true)`);
  if (clicked !== true) throw new Error(`queue click never landed (button not found) for ${url.slice(-24)}`);
  await sleep(250);
}

/** run a scenario fn, catching failures into the results table.
 * the bundle is re-injected per scenario — the page can reload between
 * scenarios, which would silently drop window.__e2e. every scenario also
 * returns home first: several scenarios leave the app on another tab, and
 * composer evals on the wrong page fail with "illegal invocation"
 * (documented in docs/E2E_RESULTS.md). */
async function scenario(n, name, fn) {
  console.log(`\n=== S${n}: ${name} ===`);
  try {
    await evalAsync(ws, `window.__e2e.goto('home') ? 'ok' : 'no-home-tab'`);
    await sleep(200);
    await ensureBundle();
    await fn();
  } catch (e) {
    record(n, name, false, [`threw: ${e.message}`]);
    // failure dump: page + recent job states at throw time — the single
    // most useful artifact for diagnosing a red run after the fact
    try {
      const page = await evalAsync(ws, `document.querySelector('.tab-btn.active')?.textContent.trim()`);
      const js = await jobs();
      const recent = js.slice(-6).map((j) => `${j.id.slice(-6)}=${j.state}${j.error ? ":" + j.error.slice(0, 50) : ""}`).join(" | ");
      console.log(`        dump: page=${page} recent=[${recent}]`);
    } catch {
      console.log("        dump: unavailable (app likely gone)");
    }
  }
}

async function injectBundle() {
  await rawEval(ws, BUNDLE);
}

/** the vite dev client can reload the page shortly after launch, wiping
 * window.__e2e — every helper self-heals by re-injecting when it's gone. */
async function ensureBundle() {
  const t = await evalAsync(ws, `typeof window.__e2e`);
  if (t !== "object") await injectBundle();
}

/** in-group d33 cleanup: remove terminal rows for a url so a later scenario
 * in the SAME group can re-queue it. this is the one legitimate cross-
 * scenario interaction left: s6's done bbb row owns its url, and s15/s16
 * genuinely re-download it. terminal only — a running row must never be
 * yanked (that is what stop is for). */
async function clearTerminalJobs(urlSub) {
  const rows = await jobs();
  for (const j of rows.filter((x) => (x.url ?? "").includes(urlSub) && !["fetching", "downloading", "post", "queued"].includes(x.state))) {
    await evalAsync(ws, `window.__e2e.ipc('job_remove', { id: ${JSON.stringify(j.id)} }).catch(() => {})`);
  }
}

// ---------------------------------------------------------------------------
// scenarios
// ---------------------------------------------------------------------------

/** poll until an in-page predicate eval returns truthy. blind sleeps race
 * react mounts (s8's silent no-op cascade) — every ui step that returns
 * false must be awaited through this, not trusted. */
async function evalUntil(expr, { timeoutMs = 15000, everyMs = 250, label = "" } = {}) {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < timeoutMs) {
    last = await evalAsync(ws, expr);
    // retry on falsy AND on string sentinels that describe intermediate
    // states — sentinels are truthy, so ('no-row'/'pending'/'NOBTN:…') used
    // to short-circuit the poll on its first probe: every "polled" step was
    // single-shot in disguise (the entire solo-vs-full flake family traced
    // here, e2e round 8).
    const pending = last == null || last === false || last === "false"
      || (typeof last === "string" && (last === "pending" || last.startsWith("no-") || last.startsWith("NOBTN:")));
    if (!pending) return last;
    await sleep(everyMs);
  }
  throw new Error(`evalUntil timeout (${timeoutMs}) ${label} — last=${JSON.stringify(last)}`);
}

/** drive composer controls and VERIFY via the live D19 mirror — a silent
 * dom no-op queued stale options in rounds 4/5; this fails fast instead. */
async function setOpts(partial) {
  // retried: applyOpts can run before the composer has mounted (fresh app
  // boot hydration in s16) — a single-shot call reported no-skip-toggle and
  // poisoned the scenario (found live, e2e round 8).
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < 15000) {
    last = await evalAsync(ws, `window.__e2e.applyOpts(${JSON.stringify(partial)})`);
    if (last === "ok") return last;
    await sleep(300);
  }
  throw new Error(`setComposer failed: ${JSON.stringify(last)}`);
}

const S = {};

// 1 — single video, app defaults (audio/best), real download
S[1] = async () => {
  const details = [];
  let flashSeen = false;
  // watch for the one-shot flash while the job runs
  const flashPoll = (async () => {
    for (let i = 0; i < 200; i++) {
      try {
        if (await evalAsync(ws, `window.__e2e.flashSeen()`)) { flashSeen = true; return; }
      } catch { /* page busy */ }
      await sleep(200);
    }
  })();

  // the bot-gate: youtube walls cookieless fetches on this network
  // (intermittent — some runs pass without). s6/s8 proved firefox cookies
  // clear it; the suite's foundation download uses them too. this is
  // authentication for the environment, not a change to the claim: s1 still
  // tests app-defaults download behavior.
  await setOpts({ cookies: { kind: "frombrowser", browser: "firefox", file: null } });
  await queueViaComposer(ZOO);
  const q = await waitJob("jNQXAC9IVRw", "fetching", 20000);
  details.push(`fetching observed (title=${q.title ?? "…"})`);
  await waitJob("jNQXAC9IVRw", "downloading", 20000);
  details.push("downloading observed");
  await waitJob("jNQXAC9IVRw", "post", 30000).catch(() => details.push("(post phase not observed — fast job)"));
  const done = await waitJob("jNQXAC9IVRw", "done", 60000);
  clearInterval(flashPoll);
  details.push(`done: finalPath=${done.finalPath}, pct=${done.pct}`);
  if (flashSeen) details.push("row flash (data-flash=done) captured");
  const file = done.finalPath && fs.existsSync(done.finalPath);
  details.push(`file exists at finalPath: ${file}`);
  const hist = await history();
  const row = hist.find((h) => (h.url ?? "").includes("jNQXAC9IVRw"));
  details.push(`history row: ${row ? `${row.extractor} ${row.vid} "${row.title}" size=${row.sizeBytes} dur=${row.durationSec}` : "MISSING"}`);
  const acc = await evalAsync(ws, `window.__e2e.rows().some(r => r.status === 'done')`);
  details.push(`done row carries data-status=done (accent): ${acc}`);
  record(1, "single video end-to-end", !!(done.finalPath && file && row && acc), details);
};

// 4 — duplicate of archived item re-queues to done/skipped, no re-download
S[4] = async () => {
  const details = [];
  // composer state is SET here, never inherited: s3 leaves the skip toggle
  // wherever the playlist run left it, and an inherited skip-off made s4
  // re-download instead of skipping (found live). under the d59 gate a
  // skip-off re-queue of an existing file opens the native overwrite dialog,
  // which an unattended run never answers — the job then never queues.
  await setOpts({ dlType: "video", maxResolution: "480p", skipDownloaded: true });
  const before = (await history()).length;
  // capture pre-existing jobs for this url — waitJob must match a NEW job,
  // not the stale done record from S1 (queue_list includes finished jobs)
  const priorIds = new Set((await jobBy("jNQXAC9IVRw")).map((j) => j.id));
  const t0 = Date.now();
  await queueViaComposer(ZOO);
  const done = await waitIpc(
    "queue_list",
    (v) => v.some((j) => j.url.includes("jNQXAC9IVRw") && !priorIds.has(j.id) && j.state === "done"),
    // the d60 gate resolves identity at click time — a slow probe can take
    // ~20s on a bad network day before the job even exists; the done wait
    // must not start its clock after that (s4 timeout, full-suite find)
    { timeoutMs: 60000, everyMs: 300, label: "new zoo job done" },
  ).then((v) => v.find((j) => j.url.includes("jNQXAC9IVRw") && !priorIds.has(j.id) && j.state === "done"));
  const elapsed = Date.now() - t0;
  details.push(`new job ${done.id}: state=done skipped=${done.skipped} in ${elapsed}ms`);
  details.push(`error/meta: ${done.error ?? "(none)"}`);
  const logHit = done.output.some((l) => l.toLowerCase().includes("skipping (archive)"));
  details.push(`log says archive-skip: ${logHit}`);
  const after = (await history()).length;
  details.push(`history rows before/after: ${before}/${after} (no duplicate row: ${before === after})`);
  record(4, "archived duplicate → done/skipped", done.skipped === true && elapsed < 20000 && before === after && logHit, details);
};

// 3 — playlist first n=2 (runs BEFORE S2 so items 1-2 download fresh)
S[3] = async () => {
  const details = [];
  // playlist legs never archive-skip per-item in the pre-check (identity is
  // the playlist), but the toggle still leaks to later scenarios — s4 reads
  // it. set it here so s4's skip-on precondition is explicit, not inherited.
  await setOpts({ skipDownloaded: false });
  await evalAsync(ws, `window.__e2e.clickText('.card .seg button', 'entire playlist', true)`);
  await evalAsync(ws, `window.__e2e.clickText('.card .seg button', 'first n…', true)`);
  const inp = await evalAsync(ws, `window.__e2e.firstNInput() ? 'ok' : null`);
  if (!inp) throw new Error("first-n input not found");
  await evalAsync(ws, `(() => { const i = window.__e2e.firstNInput(); const p = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; p.call(i, '2'); i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  await queueViaComposer(TYCHO);
  const done = await waitJob("tycho.bandcamp.com", "done", 120000, 500);
  details.push(`itemsDone=${done.itemsDone} itemsTotal=${done.itemsTotal} skipped=${done.skipped}`);
  // after_move:filepath prints the bare path value — count path-shaped lines
  const finals = done.output.filter((l) => !l.startsWith("[") && /[\\/]/.test(l) && l.length > 8).length;
  details.push(`bare final-path prints in output: ${finals}`);
  const files = fs.existsSync(DL_DIR) ? fs.readdirSync(DL_DIR).filter((f) => f.toLowerCase().endsWith(".mp3") || f.toLowerCase().endsWith(".m4a") || f.toLowerCase().endsWith(".flac")) : [];
  details.push(`audio files in dl dir: ${files.length}`);
  record(3, "playlist first-n=2", done.itemsDone === 2 && done.itemsTotal === 2, details);
};

// 2 — entire playlist: second pass over the album (items 1-2 already in the
// archive from S3) — yt-dlp skips those, downloads 3-10, counter shows 10/10
// with per-item skips + downloads BOTH counted (D54).
S[2] = async () => {
  const details = [];
  await evalAsync(ws, `window.__e2e.clickText('.card .seg button', 'entire playlist', true)`);
  const priorIds = new Set((await jobBy("tycho.bandcamp.com")).map((j) => j.id));
  await queueViaComposer(TYCHO);
  const isNew = (j) => j.url.includes("tycho") && !priorIds.has(j.id);
  // sample the counter mid-run
  let midSample = null;
  try {
    await waitIpc("queue_list", (v) => {
      const j = v.find((x) => isNew(x) && x.itemsTotal != null && (x.itemsDone ?? 0) >= 2 && x.state !== "done");
      if (j) { midSample = j; return true; }
      return false;
    }, { timeoutMs: 120000, everyMs: 300, label: "mid counter" });
  } catch { /* may run too fast to catch mid */ }
  if (midSample) details.push(`mid-run counter: ${midSample.itemsDone}/${midSample.itemsTotal} (state=${midSample.state})`);
  else details.push("(job too fast to sample mid-run — final counter only)");
  const done = await waitIpc("queue_list", (v) => v.some((x) => isNew(x) && x.state === "done"), { timeoutMs: 240000, everyMs: 500, label: "new tycho done" })
    .then((v) => v.find(isNew));
  details.push(`final: itemsDone=${done.itemsDone} itemsTotal=${done.itemsTotal}`);
  const skips = done.output.filter((l) => l.includes("has already been recorded in the archive") || l.includes("has already been downloaded")).length;
  const dls = done.output.filter((l) => !l.startsWith("[") && /[\\/]/.test(l) && l.length > 8).length;
  details.push(`per-item outputs: ${dls} downloaded + ${skips} archive-skips (items 1-2 from S3)`);
  // engine truth: counter closed to 10/10. per-item lines only exist for
  // DOWNLOADS — yt-dlp prints nothing for archive-skips under the engine's
  // progress-template (e2e find 2026-09-03), so the visible split here is
  // "8 downloaded + 2 silent skips"; the done-closure guarantees the
  // 10/10. tangible check: the album is fully on disk across both runs.
  const dlsReported = dls;
  const silentSkips = 10 - dlsReported;
  details.push(`downloaded lines: ${dlsReported}; silent archive-skips: ${silentSkips}`);
  const audioOnDisk = fs.existsSync(DL_DIR)
    ? fs.readdirSync(DL_DIR).filter((f) => /\.(mp3|m4a|flac|opus)$/i.test(f)).length
    : 0;
  details.push(`audio files on disk across S3+S2: ${audioOnDisk}/10`);
  record(2, "entire playlist counter", done.itemsDone === 10 && done.itemsTotal === 10 && audioOnDisk >= 10, details);
};

// 9 — lenient intake: garbage rejected at intake, intranet accepted + errors at fetch
S[9] = async () => {
  const details = [];
  // stale-feedback trap (found live): the previous scenario's feedback card
  // ("… 0 invalid") is still on screen, and any predicate matching the word
  // "invalid" resolves instantly on it — before this scenario's click has
  // even fired. clear the composer first, which also clears the feedback.
  await evalAsync(ws, `window.__e2e.clearComposer()`);
  await sleep(200);
  // d33: a leftover intranet job from an earlier run would make this add a
  // duplicate no-op — remove it first.
  for (const j of await jobBy("192.168.1.1")) {
    await evalAsync(ws, `window.__e2e.ipc('job_remove', { id: ${JSON.stringify(j.id)} })`);
  }
  await evalAsync(ws, `window.__e2e.focusComposer()`);
  await ws.call("Input.insertText", { text: `${GARBAGE}\n${INTRANET}` });
  await sleep(150);
  await evalAsync(ws, `window.__e2e.clickText('.card button.primary', 'queue downloads', true)`);
  // the queue-time gate (D59) probes identity with a 2.5s cap before queueing
  // — poll for the feedback instead of a single-shot read (which predates the
  // gate and read too early). the predicate must match THIS run's verdict
  // ("1 invalid"), not just any feedback card.
  const fb = await evalUntil(`(() => { const t = window.__e2e.feedbackText(); return t && t.includes("1 invalid") && t.includes(${JSON.stringify(GARBAGE)}) ? t : "pending"; })()`, { timeoutMs: 15000, everyMs: 300, label: "intake feedback (s9)" }).catch(() => null);
  details.push(`intake feedback: ${JSON.stringify(fb)}`);
  const textareaVal = await evalAsync(ws, `window.__e2e.composer()?.value ?? ''`);
  details.push(`textarea kept the accepted intranet url, dropped garbage: ${JSON.stringify(textareaVal)}`);
  const err = await waitJob("192.168.1.1", "error", 60000, 500);
  details.push(`intranet job state=error: ${JSON.stringify(err.error)}`);
  const fbOk = fb && fb.includes("1 invalid") && fb.includes(GARBAGE);
  const errOk = err.error && /unsupported|error|unable|no video|failed/i.test(err.error);
  record(9, "lenient intake (D28)", !!(fbOk && errOk && textareaVal.includes("192.168.1.1") && !textareaVal.includes(GARBAGE)), details);
};

// 10 — soundcloud single-format audio with -f ba/b fallback
S[10] = async () => {
  const details = [];
  // pin the composer state: the full suite's persisted composeOpts (d86)
  // leak into un-setOpts'd scenarios — a leftover playlistMode/cookies/
  // cover combo can stall the queue click on the d60 dialog (d90-final:
  // the click landed, no job row appeared, and the dump showed a stale
  // webm-thumbnail error row from the leaked state).
  await setOpts({ dlType: "audio", audioFormat: "best", skipDownloaded: false, playlistMode: "single", coverMode: "none" });
  details.push("mirror: audio/best, skip off, playlistMode=single, overwrite off, cover off");
  await queueViaComposer(SC_FLICKER);
  // evidence on stall: if no job lands, was a d60 dialog holding the queue?
  const stalled = await waitIpc("queue_list", (v) => v.some((j) => (j.url ?? "").includes("soundcloud.com/forss/flickermood")), { timeoutMs: 20000, everyMs: 300, label: "flickermood queued" }).then(() => false).catch(() => true);
  if (stalled) {
    const cdlg = await evalAsync(ws, `JSON.stringify(window.__cdlg ?? null)`);
    const fb = await evalAsync(ws, `[...document.querySelectorAll('.card div')].map(h => h.textContent).filter(t => t.includes('queued') || t.includes('invalid') || t.includes('duplicate')).join(' | ') || 'none'`);
    details.push(`stall evidence: cdlg=${cdlg} feedback=${JSON.stringify(fb)}`);
    throw new Error("flickermood job never queued — evidence above");
  }
  const done = await waitJob("soundcloud.com/forss/flickermood", "done", 120000, 500);
  details.push(`done: finalPath=${done.finalPath}`);
  const file = done.finalPath && fs.existsSync(done.finalPath);
  details.push(`file exists: ${file}`);
  const ext = done.finalPath ? path.extname(done.finalPath) : "?";
  details.push(`landed extension: ${ext}`);
  const hist = await history();
  const row = hist.find((h) => (h.url ?? "").includes("flickermood"));
  details.push(`history row: ${row ? `${row.extractor} ${row.vid}` : "MISSING"}`);
  record(10, "single-format audio fallback", !!(file && row), details);
};

// 12 — unavailable video: error with yt-dlp reason, expandable output, hover card
S[12] = async () => {
  const details = [];
  await queueViaComposer(DEAD);
  const err = await waitJob("this-track-does-not-exist-xyz", "error", 60000, 400);
  details.push(`error text: ${JSON.stringify(err.error)}`);
  const row = await evalAsync(ws, `window.__e2e.rowByMeta('this-track-does-not-exist-xyz') ? 'found' : null`);
  // expand output
  // expand via the row's dedicated "output" chevron (title="output"),
  // not a synthetic .t-title click (react didn't register those reliably)
  await evalAsync(ws, `(() => { const r = [...document.querySelectorAll('tr.qrow')].find(x => x.querySelector('.t-meta')?.textContent.includes('this-track-does-not-exist-xyz')); if (!r) return false; const b = [...r.querySelectorAll('button')].find(b => b.title === 'output'); if (!b) return false; b.click(); return true; })()`);
  await sleep(300);
  const logLines = await evalAsync(ws, `(() => { const r = [...document.querySelectorAll('tr.qrow')].find(x => x.querySelector('.t-meta')?.textContent.includes('this-track-does-not-exist-xyz')); return r && r.nextElementSibling?.classList.contains('log-row') ? r.nextElementSibling.querySelectorAll('.logwrap > div').length : 0; })()`);
  details.push(`expanded log lines: ${logLines}`);
  // hover card — d84: the trigger is the text cell (td 2), not the whole row
  await evalAsync(ws, `(() => { const r = [...document.querySelectorAll('tr.qrow')].find(x => x.querySelector('.t-meta')?.textContent.includes('this-track-does-not-exist-xyz')); if (r) r.querySelector('td:nth-child(2)')?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); return true; })()`);
  await sleep(900);
  const card = await evalAsync(ws, `window.__e2e.hoverCard()`);
  details.push(`hover card shows error: ${card ? JSON.stringify(card.slice(0, 160)) : "MISSING"}`);
  record(12, "unavailable video error surface", !!(err.error && logLines > 0 && card && card.includes(err.error.slice(0, 30))), details);
};

// 11 — webm container warning appears BEFORE queueing; download still works
S[11] = async () => {
  const details = [];
  // video + webm container + skip off — driven and VERIFIED via the d19
  // mirror (single-shot evals no-op silently at scenario boundaries).
  // the old waitJob(url, "done") matched ANY done zoo job — s1/s4 leave done
  // rows behind, and the round-11 evidence line (.opus on the webm scenario)
  // proves the match was s1's stale job: a false pass. assert the scenario's
  // actual claim: a NEW job landing a .webm file.
  // overwrite on: the zoo .opus from s1/s8 exists in the destination, and
  // the d60 dialog (which matches any * [<id>].*) would block the queue
  // click — the scenario's claim is the webm container + its warning, and
  // d89 reveals file-skips honestly rather than silently no-oping.
  // cookies: youtube's bot-gate now bites plain video queues too (d90 round).
  await setOpts({ dlType: "video", container: "webm", skipDownloaded: false, cookies: { kind: "frombrowser", browser: "firefox", file: null } });
  const priorIds = new Set((await jobBy("jNQXAC9IVRw")).map((j) => j.id));
  const warn = await evalUntil(`(() => window.__e2e.anyWarn('webm') ? 'yes' : 'pending')()`, { timeoutMs: 8000, label: "webm warning" });
  details.push(`webm warning visible before queueing: ${warn === "yes"}`);
  await queueViaComposerOverwrite(ZOO);
  const doneList = await waitIpc("queue_list", (v) => v.some((j) => j.url.includes("jNQXAC9IVRw") && !priorIds.has(j.id) && j.state === "done" && (j.finalPath ?? "").endsWith(".webm") && !(j.error ?? "")), { timeoutMs: 90000, everyMs: 500, label: "new .webm done" });
  const doneJob = doneList.find((j) => j.url.includes("jNQXAC9IVRw") && !priorIds.has(j.id) && (j.finalPath ?? "").endsWith(".webm"));
  details.push(`done: finalPath=${doneJob.finalPath}`);
  const file = fs.existsSync(doneJob.finalPath);
  details.push(`file exists: ${file}`);
  record(11, "webm warning + download", !!(warn === "yes" && file), details);
};

// 13 — enter queues + clears; shift+enter inserts newline, does not queue.
// uses REAL cdp key events (Input.dispatchKeyEvent): a synthetic
// KeyboardEvent has no default action, so shift+enter could never insert
// the newline — the runner mistook harness physics for an app defect.
S[13] = async () => {
  const details = [];
  // the url is unique per run on purpose: a reused url trips the
  // one-job-per-url guard (d33 — found live: a leftover zoo job turned
  // enter into an all-duplicates no-op) and a reused destination trips the
  // d60 overwrite confirm nobody answers. the keyboard claim needs neither
  // — example.com resolves as a direct media link and errors at fetch,
  // which is fine: the claim is the keyboard contract, not the download.
  const url = `https://example.com/d58-${Date.now()}.mp4`;
  await evalAsync(ws, `window.__e2e.focusComposer()`);
  await ws.call("Input.insertText", { text: url });
  await sleep(150);
  await pressKey(ws, { key: "Enter", code: "Enter", keyCode: 13, text: "\r" });
  await sleep(400);
  // the scenario's claim is the D58 KEYBOARD contract: enter queues + clears
  // the textarea. what the engine then does with the url is its business.
  const queuedJob = await waitIpc("queue_list", (v) => v.some((j) => j.url === url), { timeoutMs: 15000, everyMs: 300, label: "enter queued a job" }).catch(() => null);
  // the clear can legitimately lag the queue: when the d60 gate's confirm
  // fires (example.com can resolve as a direct link to an existing dest),
  // the clear waits for the dialog answer. poll, don't snapshot (d90 round).
  const cleared = await evalUntil(`(() => (window.__e2e.composer()?.value ?? 'x') === '' ? 'yes' : 'pending')()`, { timeoutMs: 8000, everyMs: 300, label: "textarea cleared" }).catch(() => "no");
  details.push(`enter queued a job: ${queuedJob ? "yes" : "no"}; textarea cleared: ${cleared}`);
  // shift+enter: two lines, no queue
  const countAfterEnter = (await jobs()).length;
  await evalAsync(ws, `window.__e2e.focusComposer()`);
  await ws.call("Input.insertText", { text: "line one" });
  await sleep(100);
  await pressKey(ws, { key: "Enter", code: "Enter", keyCode: 13, text: "\r", modifiers: 8 });
  await sleep(300);
  const val = await evalAsync(ws, `window.__e2e.composer()?.value ?? ''`);
  const countAfterShift = (await jobs()).length;
  details.push(`shift+enter: value=${JSON.stringify(val)}; job count before/after: ${countAfterEnter}/${countAfterShift}`);
  await evalAsync(ws, `window.__e2e.clearComposer()`);
  // cleanup: the d58 job is a fetch-error by design — remove it so later
  // scenarios see a tidy queue
  const d58jobs = await jobBy(url);
  for (const j of d58jobs) {
    await evalAsync(ws, `window.__e2e.ipc('job_remove', { id: ${JSON.stringify(j.id)} })`);
  }
  record(13, "enter / shift+enter (D58)", !!(queuedJob && cleared === "yes" && countAfterEnter === countAfterShift && val.includes("\n")), details);
};

// 14 — ctrl+v jumps home + focuses composer; F5 reloads history
S[14] = async () => {
  const details = [];
  await evalAsync(ws, `window.__e2e.goto('history')`);
  await sleep(300);
  await evalAsync(ws, `document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'v', ctrlKey: true, bubbles: true, cancelable: true }))`);
  await sleep(300);
  const tabs = await evalAsync(ws, `JSON.stringify(window.__e2e.tabs())`);
  const focused = await evalAsync(ws, `window.__e2e.activeIsComposer()`);
  details.push(`after ctrl+v: tabs=${tabs} composerFocused=${focused}`);
  await evalAsync(ws, `window.__e2e.goto('history')`);
  await sleep(400);
  const histBefore = (await history()).length;
  await evalAsync(ws, `document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'F5', bubbles: true, cancelable: true }))`);
  await sleep(400);
  const histAfter = (await history()).length;
  const rowsRendered = await evalAsync(ws, `document.querySelectorAll('.card table tbody tr').length`);
  details.push(`F5 on history: rows ipc before/after=${histBefore}/${histAfter}, rendered rows=${rowsRendered}`);
  record(14, "ctrl+v / F5", !!(focused && tabs.includes('"home"') && histBefore === histAfter && rowsRendered > 0), details);
};

// 8 — history re-download uses the composer's CURRENT options (D19/D52)
S[8] = async () => {
  const details = [];
  const sweepZooFiles = async () => {
    // remove pre-existing final files: with the target present, yt-dlp skips
    // the download AND extractaudio, and the engine's always-on --embed-metadata
    // then runs ffmpeg's ogg muxer over the cover-tagged opus — which ffmpeg
    // refuses ("Unsupported codec id in stream 1") → "Postprocessing:
    // Conversion failed!" + 0-byte .temp.opus (reproduced live, e2e finding:
    // re-download onto an existing cover-tagged opus errors at the yt-dlp
    // layer; the scenario deletes it to test the D19 options contract itself).
    for (const f of fs.existsSync(DL_DIR) ? fs.readdirSync(DL_DIR) : []) {
      if (f.includes("jNQXAC9IVRw") && !f.endsWith(".part")) { // any zoo artifact — s1 can land .webm or .opus (format availability fluctuates)
        fs.rmSync(path.join(DL_DIR, f), { force: true });
      }
    }
    // the same edge from an unexpected destination: an earlier run (or the v1
    // migration adopting v1's download dir) can leave a cover-tagged .opus at
    // whatever destination the app resolves — re-download onto it errors
    // (existing-target edge, reproduced live). the ipc command is the truth,
    // not the seeded setting.
    try {
      const dest = await evalAsync(ws, `window.__e2e.ipc('settings_get').then(s => s.destination)`);
      if (dest && fs.existsSync(dest)) {
        for (const f of fs.readdirSync(dest)) {
          if (f.includes("jNQXAC9IVRw") && !f.endsWith(".part")) { // any zoo artifact — s1 can land .webm or .opus (format availability fluctuates)
            fs.rmSync(path.join(dest, f), { force: true });
          }
        }
      }
    } catch { /* settings_get unavailable — sweep below still applies */ }
  };
  // the whole setup→click→verify cycle is one retry unit: a vite dev reload
  // between setOpts and the click resets the D19 mirror to defaults
  // (skipDownloaded: true) — the re-download was then archive-skipped and the
  // wait matched nothing (round 11: clicked=true, job done, "already in
  // downloaded archive"). every attempt re-asserts the mirror; a skipped or
  // errored attempt is removed and retried.
  let done = null;
  let attemptsLog = [];
  for (let attempt = 1; attempt <= 3 && !done; attempt++) {
    await ensureBundle();
    // setup is itself retryable: s8 runs directly after s14's F5 (real page
    // reload), and the composer may still be unmounted when the segment poll
    // expires ("no-audio-seg", found live) — a thrown setOpts here used to
    // unwind the whole attempt loop.
    let set = false;
    for (let r = 0; r < 3 && !set; r++) {
      // d88: cookies are part of the D19 mirror now — without them the
      // re-download dies at fetch on a bot-gated network before any
      // options contract is exercised (found live, 2026-09-06).
      try { await setOpts({ dlType: "audio", audioFormat: "opus", skipDownloaded: false, cookies: { kind: "frombrowser", browser: "firefox", file: null } }); set = true; }
      catch { await sleep(2500); await ensureBundle(); }
    }
    if (!set) { details.push(`attempt ${attempt}: composer never mounted for setOpts`); continue; }
    await evalUntil(`(() => { window.__e2e.goto('history'); return document.querySelector('.tab-btn.active')?.textContent.trim() === 'history' ? 'ok' : 'pending'; })()`, { timeoutMs: 8000, label: `history active (s8 a${attempt})` });
    // D33 quiescence: an in-flight job with the same identity rejects the
    // re-download as duplicate (round 5).
    await waitIpc("queue_list", (v) => v.every((j) => !["fetching", "downloading", "post"].includes(j.state)), { timeoutMs: 90000, everyMs: 400, label: "queue quiet before ↻" });
    await sweepZooFiles();
    const priorIds = new Set((await jobBy("jNQXAC9IVRw")).map((j) => j.id));
    // click ↻ (title mentions current composer settings) on the zoo row —
    // self-healing navigation: a reload can remount home, whose queue rows
    // match the same url text with different buttons (round 9's NOBTN dump).
    // the per-attempt token keeps a lost-response retry from clicking twice.
    const clicked = await evalUntil(`(() => { if (!document.querySelector('.tab-btn.active')?.textContent.trim().includes('history')) return 'pending'; const r = [...document.querySelectorAll('.card table tbody tr')].find(x => x.textContent.includes('jNQXAC9IVRw') || x.textContent.includes('Me at the zoo')); if (!r) return 'no-row'; const b = [...r.querySelectorAll('button')].find(b => (b.title ?? '').startsWith('download again')); if (!b) return 'pending'; window.__e2e.clicks = window.__e2e.clicks || {}; if (window.__e2e.clicks['s8-redl-' + ${attempt}]) return 'pending'; window.__e2e.clicks['s8-redl-' + ${attempt}] = 1; b.click(); return true; })()`, { timeoutMs: 12000, everyMs: 300, label: `↻ click a${attempt}` }).catch(() => null);
    if (!clicked) { details.push(`attempt ${attempt}: click never landed`); await ensureBundle(); continue; }
    // match only a NEW job — s1 already left a done job for this url, and
    // queue_list includes finished jobs (an unfixed match is a false pass)
    let result = null;
    try {
      result = await waitIpc("queue_list", (v) => {
        const nz = v.filter((j) => j.url.includes("jNQXAC9IVRw") && !priorIds.has(j.id));
        return nz.some((j) => (j.state === "done" && (j.finalPath ?? "").endsWith(".opus")) || j.state === "error" || (j.state === "done" && j.skipped));
      }, { timeoutMs: 120000, everyMs: 500, label: "re-download outcome" });
    } catch { result = null; }
    if (!result) { details.push(`attempt ${attempt}: no job outcome within 120s`); continue; }
    const nz = result.filter((j) => j.url.includes("jNQXAC9IVRw") && !priorIds.has(j.id));
    const okJob = nz.find((j) => j.state === "done" && (j.finalPath ?? "").endsWith(".opus") && !j.skipped && !(j.error ?? ""));
    const badJob = nz.find((j) => j.state === "error" || (j.state === "done" && j.skipped));
    if (okJob) { done = okJob; details.push(`attempt ${attempt}: re-download landed .opus → ${okJob.finalPath}`); break; }
    if (badJob) {
      attemptsLog.push(`${badJob.state}${badJob.error ? ": " + badJob.error.slice(0, 60) : ""}`);
      details.push(`attempt ${attempt}: ${badJob.state}${badJob.error ? " — " + badJob.error.slice(0, 80) : ""} → removing + retrying with re-asserted mirror`);
      await evalAsync(ws, `window.__e2e.ipc('job_remove', { id: ${JSON.stringify(badJob.id)} })`);
      await sleep(500);
    }
  }
  if (!done) {
    const q = await jobs();
    const zoo = q.filter((j) => j.url.includes("jNQXAC9IVRw")).map((j) => `${j.id.slice(-6)}=${j.state}${j.error ? " err=" + j.error.slice(0, 60) : ""}`);
    const hist = await history();
    const zooRows = hist.filter((h) => h.vid === "jNQXAC9IVRw").map((h) => `${h.finalPath?.split("\\").pop()} url=${h.url ? "yes" : "NO"}`);
    throw new Error(`re-download never landed .opus in 3 attempts (attempts: ${attemptsLog.join("; ") || "none"}) || per-attempt: [${details.join(" ; ")}] || zooJobs=[${zoo.join(" | ")}] zooHistory=[${zooRows.join("; ")}]`);
  }
  details.push(`file exists: ${fs.existsSync(done.finalPath)}`);
  record(8, "D19 re-download uses composer options", !!(done && fs.existsSync(done.finalPath)), details);
};

// 7 — moved file: reveal fails → moved? + locate… → relink restores reveal
S[7] = async () => {
  const details = [];
  // verified navigation (same lesson as s8: an unchecked goto can leave the
  // queue table mounted and starve the reveal-click poll below).
  await evalUntil(`(() => { window.__e2e.goto('history'); return document.querySelector('.tab-btn.active')?.textContent.trim() === 'history' ? 'ok' : 'pending'; })()`, { timeoutMs: 8000, label: "history tab active (s7)" });
  // pre-clean: if a previous attempt left the row in moved state or relinked
  // to the [moved] path, restore db + disk to the original name first — the
  // scenario must start from a KNOWN-normal row (a stale moved? state or a
  // missed click silently starves the poll below; found live, e2e round 6).
  const pre = await history();
  const preRow = pre.find((h) => h.vid === "jNQXAC9IVRw");
  if (preRow && !preRow.finalPath.includes("[moved]")) {
    // already normal
  } else if (preRow) {
    const orig = preRow.finalPath.replace(" [moved]", "");
    if (fs.existsSync(preRow.finalPath)) fs.renameSync(preRow.finalPath, orig);
    await evalAsync(ws, `window.__e2e.ipc('history_relink', { id: 'youtube jNQXAC9IVRw', path: ${JSON.stringify(orig)} })`);
    await sleep(300);
  }
  // find the opus row's file on disk, move it (simulating explorer move).
  // fails FAST if s8 replaced the zoo row (webm/opus swap) — no cascade.
  const hist = await history();
  const row = hist.find((h) => (h.finalPath ?? "").endsWith(".opus"));
  if (!row || !fs.existsSync(row.finalPath)) {
    const formats = hist.filter((h) => h.vid === "jNQXAC9IVRw").map((h) => h.finalPath);
    throw new Error(`opus file missing (s8 left: ${JSON.stringify(formats)})`);
  }
  const newPath = row.finalPath.replace("Me at the zoo", "Me at the zoo [moved]");
  fs.renameSync(row.finalPath, newPath);
  details.push(`moved file on disk → ${path.basename(newPath)}`);
  // click 📁 (show in folder) — reveal should fail (file gone), row flips to
  // moved?. VERIFIED click via evalUntil: a single-shot eval can fire while
  // the row hasn't rendered (round 6: clicked=false went unnoticed, the
  // flag never flipped, and the poll starved).
  const clicked = await evalUntil(`(() => { window.__e2e.clicks = window.__e2e.clicks || {}; if (window.__e2e.clicks['s7-reveal']) return 'already'; const r = [...document.querySelectorAll('.card table tbody tr')].find(x => x.textContent.includes('Me at the zoo')); if (!r) return 'false'; const b = [...r.querySelectorAll('button')].find(b => (b.title ?? '').startsWith('show in folder')); if (!b) return 'false'; window.__e2e.clicks['s7-reveal'] = 1; b.click(); return 'ok'; })()`, { label: "reveal click", timeoutMs: 15000 });
  details.push(`reveal 📁 clicked: ${clicked}`);
  // the reveal-failure → flag flip is async (plugin round-trip; explorer
  // spawn can be slow on a cold session) — poll generously, don't sleep.
  // ALSO SELF-HEALING: a vite dev-client reload remounts history (losing the
  // moved? component state and the bundle) — isolated probes prove the
  // mechanism is deterministic (~150ms) when the page stays mounted, so a
  // vanished flag after a remount is re-driven, not starved (found live:
  // locate read null for 8s while the row existed before and after).
  let movedFlag = "no";
  let locateOffered = false;
  for (let attempt = 1; attempt <= 3 && !locateOffered; attempt++) {
    await ensureBundle();
    await evalUntil(`(() => { window.__e2e.goto('history'); return document.querySelector('.tab-btn.active')?.textContent.trim() === 'history' ? 'ok' : 'pending'; })()`, { timeoutMs: 8000, label: `history active (s7 a${attempt})` });
    const ok = await evalUntil(`(() => { const r = [...document.querySelectorAll('.card table tbody tr')].find(x => x.textContent.includes('Me at the zoo')); return r ? (r.textContent.includes('moved?') ? 'yes' : 'pending') : null; })()`, { label: `moved? flag a${attempt}`, timeoutMs: 12000 }).catch(() => null);
    if (ok === "yes") {
      movedFlag = "yes";
      locateOffered = await evalUntil(`(() => { const r = [...document.querySelectorAll('.card table tbody tr')].find(x => x.textContent.includes('Me at the zoo')); return r ? ([...r.querySelectorAll('button')].some(b => (b.title ?? '').startsWith('locate'))) : null; })()`, { label: `locate offered a${attempt}`, timeoutMs: 8000 }).catch(() => false);
      if (!locateOffered) {
        // flag is on but the button read raced a re-render — one clean re-read
        // after a remount-verify; if the page was reloaded the loop re-drives.
        await sleep(400);
        await ensureBundle();
      }
    } else {
      // page remounted (flag lost) or reveal raced — re-click reveal for this
      // attempt (token per attempt: a lost-response retry never double-fires).
      // goto is verified INSIDE this step too: a reload between the attempt's
      // navigation and here remounts home → no history row → 'false' forever
      // (round 10). failure here is recoverable — the next attempt re-drives.
      await evalUntil(`(() => { window.__e2e.goto('history'); if (document.querySelector('.tab-btn.active')?.textContent.trim() !== 'history') return 'pending'; window.__e2e.clicks = window.__e2e.clicks || {}; const t = 's7-reveal-' + ${attempt}; if (window.__e2e.clicks[t]) return 'already'; const r = [...document.querySelectorAll('.card table tbody tr')].find(x => x.textContent.includes('Me at the zoo')); if (!r) return 'pending'; const b = [...r.querySelectorAll('button')].find(b => (b.title ?? '').startsWith('show in folder')); if (!b) return 'pending'; window.__e2e.clicks[t] = 1; b.click(); return 'ok'; })()`, { label: `reveal re-click a${attempt}`, timeoutMs: 10000 }).catch(() => null);
    }
  }
  if (!locateOffered) throw new Error(`moved?/locate never both visible after 3 attempts (movedFlag=${movedFlag})`);
  details.push(`reveal failed → row shows moved? ${movedFlag}, locate… offered: ${locateOffered}`);
  // native file dialog is not scriptable over cdp — exercise the same
  // handler's ipc (history_relink) directly and verify the row heals
  await evalAsync(ws, `window.__e2e.ipc('history_relink', { id: 'youtube jNQXAC9IVRw', path: ${JSON.stringify(newPath)} })`);
  await sleep(400);
  const healed = await history();
  const healedRow = healed.find((h) => h.vid === "jNQXAC9IVRw");
  details.push(`after relink: history finalPath=${healedRow.finalPath} (matches moved file: ${healedRow.finalPath === newPath})`);
  // restore disk + db to the original state so later scenarios (and reruns)
  // start clean: rename back, relink, remount, expect the normal 📁 row.
  fs.renameSync(newPath, row.finalPath);
  await evalAsync(ws, `window.__e2e.ipc('history_relink', { id: 'youtube jNQXAC9IVRw', path: ${JSON.stringify(row.finalPath)} })`);
  // fresh history mount before the final check: the "moved?" flag is
  // component state that only the native-dialog path clears, and the dialog
  // is not scriptable over cdp. a REMOUNT reads db truth only — exactly what
  // a user sees when they revisit the page (found by the e2e checklist).
  await evalAsync(ws, `window.__e2e.goto('home') ? 'ok' : 'no'`);
  await sleep(250);
  await evalAsync(ws, `window.__e2e.goto('history') ? 'ok' : 'no'`);
  await sleep(600);
  const backToReveal = await evalAsync(ws, `(() => { const r = [...document.querySelectorAll('.card table tbody tr')].find(x => x.textContent.includes('Me at the zoo')); return r ? [...r.querySelectorAll('button')].some(b => (b.title ?? '').startsWith('show in folder')) : null; })()`);
  details.push(`row back to 📁 (reveal state, db relinked to original): ${backToReveal}`);
  record(7, "moved-file locate/relink (D19/§6)", !!(clicked === "ok" && movedFlag === "yes" && locateOffered && healedRow.finalPath === newPath && backToReveal), details);
};

// 5 + 6 — identity duplicate while running (concurrency=2), then stop→resume
S[5] = async () => {
  const details = [];
  // composer state is set, not inherited (see s4): video/480p + skip ON,
  // mirror-verified through applyOpts instead of trust-me dom pokes.
  // cookies: youtube's bot-gate bites cookieless queues on this network
  // (d91 round: despacito errored at fetch) — same environment-auth as s1.
  await setOpts({ dlType: "video", maxResolution: "480p", skipDownloaded: true, cookies: { kind: "frombrowser", browser: "firefox", file: null } });
  details.push("video mode, 480p cap set, skip on, cookies=firefox");
  // job1 via composer (watch?v=)
  await queueViaComposer(DESPACITO_W);
  await waitJob("kJQP7kiw5Fk", "downloading", 45000, 400).catch(async () => {
    await waitJob("kJQP7kiw5Fk", "fetching", 20000, 300);
  });
  // job2 seconds later via composer (youtu.be short link — different url, same identity)
  await queueViaComposer(DESPACITO_S);
  const dup = await waitJob("youtu.be/kJQP7kiw5Fk", "duplicate", 45000, 400);
  details.push(`job2 ended duplicate: ${JSON.stringify(dup.error)}`);
  let j1 = (await jobBy("watch?v=kJQP7kiw5Fk")).find((j) => j.state === "downloading" || j.state === "post");
  if (!j1) {
    // job1 finished between queueing job2 and this read — then the duplicate
    // is archive-flavored (skip line), which still proves one-identity rules.
    j1 = (await jobBy("watch?v=kJQP7kiw5Fk")).find((j) => j.state === "done" && j.skipped);
  }
  details.push(`job1 ${j1?.state ?? "?"} (pct=${j1?.pct?.toFixed?.(1)})`);
  // determinism: stop job1 so later scenarios start quiescent regardless of
  // how long despacito runs (an inherited running job stalled s15/s16 once).
  if (j1 && ["downloading", "post", "fetching"].includes(j1.state)) {
    await evalAsync(ws, `(() => { const r = [...document.querySelectorAll('tr.qrow')].find(x => x.textContent.includes('kJQP7kiw5Fk')); const b = r && [...r.querySelectorAll('button')].find(b => (b.title ?? '').startsWith('stop')); if (b) { b.click(); return 'stopped'; } return 'no-btn'; })()`);
    await waitIpc("queue_list", (v) => v.some((j) => j.url.includes("watch?v=kJQP7kiw5Fk") && ["stopped", "done"].includes(j.state)), { timeoutMs: 20000, label: "job1 quiesced (s5)" }).catch(() => {});
  }
  record(5, "identity duplicate while running", !!(dup.error && dup.error.includes("duplicate") && j1), details);
};

S[6] = async () => {
  const details = [];
  // bbb at 1080p: big/slow enough to stop mid-flight with certainty — 480p
  // finished in ~4s at local disk speed, racing the stop click (round 3),
  // while "best" pulled the 4k stream (~1.4gb per attempt) and ENOSPC'd a
  // nearly-full disk into fake "Conversion failed!" postprocessing errors
  // (d88 full-suite round 2026-09-07). stop is triggered by .part byte
  // growth, not a timer, so the resolution only sets the window width.
  // d84/d88: youtube's bot-gate comes and goes by ip — mirror-verified
  // cookies-from-browser makes the scenario deterministic (live-verified
  // 2026-09-06: the same url resolves with cookies, errors without).
  // s6's stopped bbb row still owns the url (d33: one-job-per-url across
  // ALL states — live-verified truth, d90 full round). s15 needs both
  // slots, so clear the stopped row first (✕ keeps files + history).
  // NOTE: must be an async IIFE — a bare `await` inside a plain eval
  // expression is a SyntaxError that evalAsync retries then the .catch
  // swallows (found live, d90-final round: the row survived, the duplicate
  // came back).
  await evalAsync(ws, `(async () => { const rows = await window.__e2e.ipc('queue_list'); const id = rows.find(j => (j.url ?? '').includes('aqz-KE-bpKQ') && ['stopped','error','done','duplicate'].includes(j.state))?.id; if (id) await window.__e2e.ipc('job_remove', { id }); return id ?? 'none'; })()`).catch(() => null);
  await sleep(400);
  await setOpts({ dlType: "video", maxResolution: "1080p", skipDownloaded: false, cookies: { kind: "frombrowser", browser: "firefox", file: null } });
  details.push("mirror: video/1080p, skip off, cookies=firefox (stopped bbb row cleared)");
  const priorIds = new Set((await jobBy("aqz-KE-bpKQ")).map((j) => j.id));
  await queueViaComposerOverwrite(BBB);
  await waitIpc("queue_list", (v) => v.some((j) => j.url.includes("aqz-KE-bpKQ") && !priorIds.has(j.id) && j.state === "downloading"), { timeoutMs: 90000, everyMs: 300, label: "bbb running" });
  // stop ■ once bytes actually flow (wide window — btbN best is hundreds of mb)
  const partsAt = () => fs.existsSync(DL_DIR) ? fs.readdirSync(DL_DIR).filter((f) => f.includes(".part")).map((f) => ({ f, s: fs.statSync(path.join(DL_DIR, f)).size })) : [];
  const sumAt = (list) => list.reduce((a, p) => a + p.s, 0);
  for (let i = 0; i < 200 && sumAt(partsAt()) < 15 * 1024 * 1024; i++) await sleep(250);
  const stopped = await evalUntil(`(() => { const r = [...document.querySelectorAll('tr.qrow')].find(x => x.dataset.status === 'downloading' && x.textContent.includes('aqz-KE-bpKQ')); if (!r) return 'false'; const b = [...r.querySelectorAll('button')].find(b => (b.title ?? '').startsWith('stop')); if (!b) return 'false'; b.click(); return 'ok'; })()`, { label: "stop click" });
  const st = await waitIpc("queue_list", (v) => v.some((j) => j.url.includes("aqz-KE-bpKQ") && !priorIds.has(j.id) && j.state === "stopped"), { timeoutMs: 30000, everyMs: 300, label: "stopped" }).then((v) => v.find((j) => !priorIds.has(j.id) && j.state === "stopped"));
  details.push(`state=stopped: ${JSON.stringify(st.error)}`);
  // .part kept?
  const parts = partsAt();
  details.push(`.part files kept: ${parts.map((p) => `${p.f} (${Math.round(p.s / 1024)}kb)`).join(", ") || "NONE"}`);
  // retry ↻ — resume evidence: the .part GROWS (bytes continued, not restarted)
  const sizeAtStop = parts.reduce((a, p) => a + p.s, 0);
  // stopped rows carry the error string in meta, not the url — match by the
  // title cell, which the engine fills from the probe/download output
  const retried = await evalUntil(`(() => { const r = [...document.querySelectorAll('tr.qrow')].find(x => x.dataset.status === 'stopped' && x.querySelector('.t-title')?.textContent.toLowerCase().includes('buck bunny')); if (!r) return 'false'; const b = [...r.querySelectorAll('button')].find(b => (b.title ?? '').startsWith('retry')); if (!b) return 'false'; b.click(); return 'ok'; })()`, { label: "retry click", timeoutMs: 20000 });
  details.push(`retry ↻ clicked: ${retried}`);
  let sizeAfterResume = 0;
  await waitIpc("queue_list", (v) => {
    const j = v.find((x) => x.url.includes("aqz-KE-bpKQ") && !priorIds.has(x.id) && x.state === "downloading");
    if (!j) return false;
    const parts2 = partsAt();
    sizeAfterResume = parts2.reduce((a, p) => a + p.s, 0);
    return sizeAfterResume > sizeAtStop;
  }, { timeoutMs: 60000, everyMs: 400, label: "resume evidence" });
  details.push(`.part bytes at stop=${Math.round(sizeAtStop / 1024)}kb → after resume=${Math.round(sizeAfterResume / 1024)}kb (grew ⇒ continued, not restarted)`);
  const done = await waitIpc("queue_list", (v) => v.some((x) => x.url.includes("aqz-KE-bpKQ") && !priorIds.has(x.id) && x.state === "done"), { timeoutMs: 420000, everyMs: 1000, label: "bbb done" }).then((v) => v.find((x) => !priorIds.has(x.id) && x.state === "done"));
  const partsAfter = partsAt();
  details.push(`done: ${done.finalPath}; .part files after: ${partsAfter.length}`);
  record(6, "stop → resume (D31/D35 semantics)", !!(stopped && st.error && parts.length > 0 && sizeAfterResume > sizeAtStop && done.finalPath && fs.existsSync(done.finalPath) && partsAfter.length === 0), details);
};

// 15 — pause never kills (D34): running keep downloading, queued wait.
// disk truth over ipc pct: yt-dlp's template reports NA totals for many
// streams, so pct can stay null mid-download — .part byte growth is the
// honest "processes still alive" signal (e2e finding 2026-09-03).
S[15] = async () => {
  const details = [];
  // two 1080p jobs fill both slots (slow enough to survive the pause
  // window, without the 4k disk footprint that enospc'd the d88 round);
  // skip off so archived identities re-download. setOpts
  // verifies via the D19 mirror — a vite reload at the scenario boundary
  // reset the composer to audio defaults (round 5) and the 5MB .part gate
  // could never fire.
  // overwrite on (see s11): the zoo .opus exists; the witness must actually
  // download after resume, not reveal a d89 skip. cookies: BOTH big jobs are
  // youtube — the gate bit one mid-suite (d90 round) and running.length===2
  // could never fire.
  await setOpts({ dlType: "video", maxResolution: "1080p", skipDownloaded: false, cookies: { kind: "frombrowser", browser: "firefox", file: null } });
  details.push("mirror: video/1080p, skip off");
  // s6's terminal bbb/gangnam rows own their urls (d33); this scenario
  // genuinely re-downloads both, so clear the terminal rows in-group.
  await clearTerminalJobs("aqz-KE-bpKQ");
  await clearTerminalJobs("9bZkp7q19f0");
  // AND delete their finished files: without --force-overwrites yt-dlp skips
  // an existing complete file ("has already been downloaded") — the job sits
  // in `downloading` for its whole metadata phase with ZERO bytes, reports
  // done@100, and the byte gate starves forever (found live, d91 solo round:
  // both jobs 'downloading' 19-25s, parts=0mb the entire window, BBB done@100
  // onto s6's leftover 156mb file). deleting the files makes both downloads
  // real, which is what the d34 evidence needs.
  const priorGang = new Set((await jobBy("9bZkp7q19f0")).map((j) => j.id));
  const priorBbb = new Set((await jobBy("aqz-KE-bpKQ")).map((j) => j.id));
  for (const vid of ["aqz-KE-bpKQ", "9bZkp7q19f0"]) {
    for (const f of fs.existsSync(DL_DIR) ? fs.readdirSync(DL_DIR).filter((f) => f.includes(`[${vid}]`)) : []) {
      fs.rmSync(path.join(DL_DIR, f), { force: true });
    }
  }
  details.push("prior bbb/gangnam rows cleared + files deleted (no phantom skip)");
  const partsAt = () => fs.existsSync(DL_DIR) ? fs.readdirSync(DL_DIR).filter((f) => f.includes(".part")).map((f) => ({ f, s: fs.statSync(path.join(DL_DIR, f)).size })) : [];
  const sumAt = (list) => list.reduce((a, p) => a + p.s, 0);
  // gate the pause on DISK TRUTH, not a state flag: the FIRST big job (bbb)
  // must be downloading WITH bytes flowing. a state-only gate can fire during
  // yt-dlp's metadata phase — no bytes flow yet, and the 8s window would show
  // 0→0 (e2e round 4). d91 round 4 diagnosis: requiring BOTH big jobs to write
  // can never fire — bbb's real transfer is ~4s (156mb at ~37mb/s) while
  // gangnam's metadata phase runs ~13s, so their byte windows never align.
  // gate on bbb writing alone: gangnam (queued 2nd) holds slot 2, so the
  // witness stays queued — exactly the "no new dispatch while paused" moment.
  // start the watcher BEFORE queuing: at 17 mb/s a 1080p job can finish inside
  // the ~10s of mirror-verified setOpts + queueViaComposer round-trips, and a
  // watcher that starts after dispatch never sees the window (d90-final).
  const t15 = Date.now();
  let lastSnap = "";
  const bbbWriting = waitIpc("queue_list", (v) => {
    const bbb = v.find((j) => j.url.includes("aqz-KE-bpKQ") && !priorBbb.has(j.id));
    // d91 diagnostic: log state transitions only (not every poll) so the
    // byte behavior stays observable without flooding the run log
    const snap = v.filter((j) => (j.url.includes("aqz-KE-bpKQ") || j.url.includes("9bZkp7q19f0")) && !priorBbb.has(j.id) && !priorGang.has(j.id)).map((j) => `${j.url.slice(-14)}=${j.state}${j.pct != null ? "@" + j.pct.toFixed(0) : ""}`).join(" ") + ` | parts=${sumAt(partsAt()) >> 20}mb`;
    if (snap && snap !== lastSnap) {
      console.log(`    [s15-watch ${String(Math.round((Date.now() - t15) / 1000)).padStart(3)}s] ${snap}`);
      lastSnap = snap;
    }
    return !!bbb && bbb.state === "downloading" && sumAt(partsAt()) >= 1 * 1024 * 1024;
  }, { timeoutMs: 150000, everyMs: 300, label: "bbb downloading + bytes flowing" });
  // queue order: bbb first (its transfer gates the pause), gangnam second
  // (holds slot 2 so the witness can't dispatch), witness last (must still be
  // 'queued' when the pause fires).
  await queueViaComposerOverwrite(BBB);
  await queueViaComposerOverwrite(GANGNAM);
  await queueViaComposerOverwrite(ZOO); // the queued witness
  await bbbWriting;
  details.push("bbb downloading, .part bytes flowing, witness queued");
  // pause — direct ipc (queue_pause is an idempotent setter, safe to retry):
  // round 9 showed the dom button can be ABSENT right after a vite reload
  // (store unhydrated, loaded=false) while the engine + ipc work fine; and
  // d34's contract is the disk evidence (processes untouched), not the
  // button. keep the returned paused flag as extra evidence.
  const pausedFlag = await evalAsync(ws, `window.__e2e.ipc('queue_pause')`);
  details.push(`queue_pause → paused=${pausedFlag}`);
  const pausedState = (await jobs()).some((j) => j.state === "queued");
  const before1 = sumAt(partsAt());
  await sleep(8000);
  const after1 = sumAt(partsAt());
  const witness = (await jobs()).find((j) => j.url.includes("jNQXAC9IVRw") && j.state === "queued");
  // a big job reaching done DURING the window is the strongest D34 proof:
  // its yt-dlp+ffmpeg ran untouched straight through the pause (found live:
  // at ~17MB/s both jobs finish mid-window — the .part sum hits 0, which
  // "bytes must grow" cannot distinguish from a kill; completion can).
  const bigDone = (await jobs()).filter((j) => ((j.url.includes("aqz-KE-bpKQ") && !priorBbb.has(j.id)) || (j.url.includes("9bZkp7q19f0") && !priorGang.has(j.id))) && j.state === "done" && !(j.error ?? ""));
  const untouched = after1 > before1 || bigDone.length > 0;
  details.push(`while paused 8s: .part bytes ${Math.round(before1 / 1024)}kb → ${Math.round(after1 / 1024)}kb (${after1 > before1 ? "grew ⇒ running processes untouched" : `${bigDone.length} big job(s) completed untouched ⇒ processes ran straight through the pause`}); witness still queued=${!!witness}`);
  // resume — direct ipc, same rationale
  const resumedFlag = await evalAsync(ws, `window.__e2e.ipc('queue_resume')`);
  details.push(`queue_resume → paused=${resumedFlag}`);
  const zooDispatched = await waitIpc("queue_list", (v) => v.some((j) => j.url.includes("jNQXAC9IVRw") && j.state !== "queued"), { timeoutMs: 30000, everyMs: 300, label: "zoo dispatched after resume" });
  details.push(`after resume: witness left queued (→ ${zooDispatched.find((j) => j.url.includes("jNQXAC9IVRw"))?.state})`);
  record(15, "pause never kills (D34)", !!(pausedFlag === true && witness && untouched), details);
};

// 16 — restart normalization (D35): kill mid-run, relaunch, verify mapping
S[16] = async () => {
  const details = [];
  // a vite reload at the scenario boundary resets the composer to defaults
  // (skip ON) — round 5's re-queues were instantly archive-skipped. mirror-
  // verified skip-off makes S16 self-sufficient. overwrite on: s15 may have
  // completed the bbb final — without --force-overwrites yt-dlp's file-skip
  // fires instantly and the kill has nothing running (the final-file check
  // is independent of the archive toggle).
  await setOpts({ skipDownloaded: false, cookies: { kind: "frombrowser", browser: "firefox", file: null } });
  details.push("mirror: skip off, cookies=firefox (reload resets composer defaults)");
  // s15 may have left terminal bbb rows owning the url (d33) — clear them so
  // the re-queue below can actually run (in-group state, not a hack).
  await clearTerminalJobs("aqz-KE-bpKQ");
  // ensure at least one job is still running right before the kill; if the
  // big jobs finished, re-queue BBB (skip is off — re-download ok)
  let running = (await jobs()).filter((j) => j.state === "downloading" || j.state === "post");
  if (running.length === 0) {
    // transient youtube failures happen (round 4's re-queue died in fetch);
    // retry until a job actually reaches downloading
    for (let attempt = 0; attempt < 3 && running.length === 0; attempt++) {
      await queueViaComposerOverwrite(BBB);
      try {
        running = await waitIpc("queue_list", (v) => v.some((j) => j.url.includes("aqz-KE-bpKQ") && j.state === "downloading"), { timeoutMs: 90000, everyMs: 300, label: `re-running BBB (attempt ${attempt + 1})` });
      } catch {
        const failed = (await jobBy("aqz-KE-bpKQ")).filter((j) => j.state === "error");
        for (const j of failed) await evalAsync(ws, `window.__e2e.ipc('job_remove', { id: ${JSON.stringify(j.id)} })`);
      }
    }
    if (running.length === 0) throw new Error("bbb never reached downloading after 3 attempts");
  }
  const histBefore = (await history()).length;
  details.push(`killing app with ${running.length} running job(s); history rows=${histBefore}`);
  // hard-kill the app process (simulates crash). only jobs RUNNING at kill
  // time normalize to stopped — finished jobs from earlier scenarios share
  // the same urls and must not be swept into the assertion.
  const runningIds = new Set((await jobs()).filter((j) => j.state === "downloading" || j.state === "post").map((j) => j.id));
  details.push(`running at kill: ${[...runningIds].length}`);
  const { execSync } = require("child_process");
  execSync("taskkill /IM ytdlp-gui.exe /F", { stdio: "ignore" });
  await sleep(1500);
  // wait until the debug port is actually FREE — a lingering webview2 host
  // would serve a dead page and launchAndAttach would silently bind to it
  await waitFor(ws, `true`, { timeoutMs: 1000, everyMs: 100 }).catch(() => {}); // drain old socket
  const net2 = require("net");
  for (let i = 0; i < 30; i++) {
    const free = await new Promise((res) => {
      const p = net2.connect(PORT, "127.0.0.1");
      p.on("connect", () => { p.destroy(); res(false); });
      p.on("error", () => res(true));
    });
    if (free) break;
    await sleep(500);
  }
  // relaunch
  const relaunched = await launchAndAttach(EXE, PORT);
  ws = relaunched.ws;
  // wait for hydration before injecting — the fresh webview loads the page
  // asynchronously, and an early bundle lands on a blank document
  await waitFor(ws, "document.querySelectorAll('.tab-btn').length >= 3 && window.__TAURI_INTERNALS__ ? true : null", { timeoutMs: 60000, everyMs: 400 });
  await sleep(1500);
  await injectBundle();
  await ws.call("Runtime.enable").catch(() => {}); // console events for the log
  await sleep(800);
  await injectBundle();
  const after = await jobs();
  const normalized = after.filter((j) => runningIds.has(j.id));
  details.push(`after relaunch: ${normalized.map((j) => `${j.url.slice(-12)}=${j.state}(${j.error ?? "-"})`).join(", ")}`);
  // D35 contract: running/post at kill → stopped("app restarted"); fetching →
  // queued. a job that crossed into DONE before the kill landed stays done
  // ("done" is terminal — normalization must not touch it). so the assertion
  // is: no killed job is left in a running/post state, and every non-done
  // killed job is stopped with the restart marker (found live: a fast
  // finisher legitimately completed during the kill window).
  const badState = normalized.filter((j) => ["fetching", "downloading", "post"].includes(j.state));
  const wronglyResumed = normalized.some((j) => j.state === "downloading");
  const nonDone = normalized.filter((j) => j.state !== "done");
  const allStopped = nonDone.length > 0 && nonDone.every((j) => j.state === "stopped" && (j.error ?? "").includes("app restarted"));
  const histAfter = (await history()).length;
  details.push(`history intact: ${histBefore}/${histAfter}`);
  // a job that was RUNNING at kill must not auto-resume; a job that was only
  // queued legitimately dispatches on relaunch (the witness does exactly that)
  const autoResumed = after.some((j) => runningIds.has(j.id) && j.state === "downloading");
  details.push(`killed jobs stay stopped (no auto-resume): ${!autoResumed}`);
  record(16, "restart normalization (D35)", !!(allStopped && badState.length === 0 && histAfter >= histBefore && !autoResumed), details);
};

// 17 — re-download overwrite gate (D59): a re-download onto an existing
// history file must ask first; cancelling queues nothing, granting queues a
// job with options.overwrite=true that redownloads cleanly (the ungated
// legacy behavior errored: skip-then-embed-metadata over a cover-tagged opus
// → "Postprocessing: Conversion failed!", 0-byte .temp, e2e-reproduced).
// uses bandcamp (youtube is bot-gated under e2e load); the gate is the
// app-owned confirm modal (D70) — answered by DOM click on its buttons.
S[18] = async () => {
  const details = [];
  const URL_ = "https://tycho.bandcamp.com/track/a-walk";
  // the gate opens the in-app confirm modal ("file already exists",
  // buttons "overwrite"/"cancel") — answerDialog clicks it by
  // data-dialog-action and resolves from the dialog's own ground truth.
  // composer: audio/mp3, skip OFF (a-walk is archived by earlier scenarios)
  await setOpts({ dlType: "audio", audioFormat: "mp3", skipDownloaded: false });
  details.push("mirror: audio/mp3, skip off");
  // step 1: ensure a clean initial download exists
  let prior = new Set((await jobs()).map((j) => j.id));
  let base = (await jobs()).find((j) => j.url.includes("tycho.bandcamp.com/track/a-walk") && j.state === "done" && !(j.error ?? ""));
  if (!base) {
    await evalUntil(`(() => { window.__e2e.goto('home'); return document.querySelector('.tab-btn.active')?.textContent.trim() === 'home' ? 'ok' : 'pending'; })()`, { timeoutMs: 8000, label: "home active (s18)" });
    await queueViaComposer(URL_);
    for (let i = 0; i < 90; i++) {
      const js = await jobs();
      const nz = js.filter((j) => !prior.has(j.id));
      if (nz.length && ["done", "error"].includes(nz[0].state)) { base = nz[0]; break; }
      await sleep(1000);
    }
    if (!base) throw new Error("initial download never finished");
    prior = new Set((await jobs()).map((j) => j.id));
  }
  if (base.state !== "done" || (base.error ?? "")) throw new Error(`initial download not clean: ${base.state} ${base.error ?? ""}`);
  const target = base.finalPath;
  if (!fs.existsSync(target)) throw new Error(`initial file missing: ${target}`);
  const mtime0 = fs.statSync(target).mtimeMs;
  details.push(`initial download: ${path.basename(target)}`);
  // layer probe: does a DIRECT confirmDialog call (fresh import) render the
  // modal inside the harness page? separates "host/mount broken" from
  // "the page's module instance broken".
  const clickRedl = async () => {
    await evalUntil(`(() => { window.__e2e.goto('history'); return document.querySelector('.tab-btn.active')?.textContent.trim() === 'history' ? 'ok' : 'pending'; })()`, { timeoutMs: 8000, label: "history active (s18)" });
    return evalUntil(`(() => { const r = [...document.querySelectorAll('.card table tbody tr')].find(x => x.textContent.includes('A Walk')); if (!r) return 'pending'; const b = [...r.querySelectorAll('button')].find(b => (b.title ?? '').startsWith('download again')); if (!b) return 'pending'; b.click(); return 'ok'; })()`, { timeoutMs: 12000, everyMs: 300, label: "↻ click (s18)" });
  };
  // step 2a: cancel — the confirm modal must fire, be answered 'cancel',
  // queue nothing, and render the cancel hint (the hint is the POSITIVE
  // signal the gate actually executed: it renders only after ask() returned
  // false, so a never-fired gate fails here too)
  const ansA = await answerDialog("cancel", clickRedl);
  const hint = await evalUntil(`(() => [...document.querySelectorAll('.hint')].some(h => h.textContent.includes('re-download cancelled')) ? 'ok' : 'pending')()`, { timeoutMs: 8000, everyMs: 300, label: "cancel hint (s18)" }).catch(() => "timeout");
  await sleep(800);
  let after = await jobs();
  const newAfterCancel = after.filter((j) => !prior.has(j.id));
  details.push(`cancel: dialog=${ansA}, hint=${hint === "ok"}, jobs queued=${newAfterCancel.length}`);
  const cancelOk = (ansA === "resolved-ok" || ansA === "gone") && hint === "ok" && newAfterCancel.length === 0;
  prior = new Set(after.map((j) => j.id));
  // step 2b: grant — new job with overwrite=true finishing clean
  const ansB = await answerDialog("overwrite", clickRedl);
  details.push(`grant: dialog=${ansB}`);
  let j2 = null;
  for (let i = 0; i < 90; i++) {
    const js = await jobs();
    const nz = js.filter((j) => !prior.has(j.id));
    if (nz.length && ["done", "error", "duplicate"].includes(nz[0].state)) { j2 = nz[0]; break; }
    await sleep(1000);
  }
  if (!j2) {
    // evidence, never throw: dump the stuck state before failing the record
    const stuck = await jobs();
    const stuckState = stuck.filter((j) => !prior.has(j.id)).map((j) => `${j.id.slice(-6)}:${j.state}:${(j.error ?? "").slice(0, 40)}`).join(", ") || "no new jobs";
    let probe = "probe-fail";
    try {
      probe = await evalAsync(ws, `(() => { const d = document.querySelector('[data-testid="confirm-dialog"]'); return d ? 'modal-visible: ' + d.querySelector('.cdlg-title')?.textContent?.trim() : 'no modal in dom'; })()`);
    } catch { }
    details.push(`TIMEOUT: new jobs=[${stuckState}], dialog ${probe}`);
    record(18, "re-download overwrite gate (D59)", false, details);
    return;
  }
  details.push(`granted job: ${j2.state}${j2.error ? " — " + j2.error.slice(0, 60) : ""}`);
  const existsIpc = await evalAsync(ws, `window.__e2e.ipc('file_exists', { path: ${JSON.stringify(target)} })`);
  // the real assertion: the job's PERSISTED options carry overwrite=true
  // (queue_list doesn't expose options; the db does)
  let ow = "?";
  try {
    ow = require("child_process").execSync(
      `python -c "import sqlite3,json;con=sqlite3.connect(r'${DATA_DIR_SQL()}/history.db');r=con.execute('select options from jobs where id=?',('${j2.id}',)).fetchone();print(str(json.loads(r[0]).get('overwrite')).lower())"`,
      { encoding: "utf8" },
    ).trim();
  } catch { ow = "db-err"; }
  const mtime1 = fs.existsSync(target) ? fs.statSync(target).mtimeMs : 0;
  details.push(`options.overwrite=${ow}; file_exists ipc=${existsIpc}; file re-downloaded (mtime advanced): ${mtime1 > mtime0}`);
  record(18, "re-download overwrite gate (D59)", !!(cancelOk && ansB === "resolved-ok" && j2.state === "done" && !(j2.error ?? "") && ow === "true" && existsIpc === true && mtime1 > mtime0), details);
};

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

/** answer the in-app confirm dialog (ConfirmDialog, m7-b — replaced the
 * native rfd task dialog and its powershell UIA automation — both gone).
 * the gate flow is: snap the current request id, let the caller trigger the action that
 * opens the dialog, wait for a NEWER request, click, then resolve from the
 * page's own published ground truth (window.__cdlg.state). the id scoping
 * is load-bearing: the dialog opens ~3ms after the trigger (file_exists ipc
 * precedes it) and a tick racing that window would misread a stale slot as
 * "no dialog" (s18's week-long flake, root-caused 2026-09-05). never trust
 * the click's return value — a lost CDP response re-runs the eval on an
 * already-closed modal and would report "pending" forever. outcomes:
 * resolved-ok | resolved-mismatch(name) | gone (slot cleared without a
 * newer request) | NO-dialog-<name> on timeout (ticks + dom in console). */
const answerDialog = async (name, trigger, timeoutMs = 15000) => {
  const before = await evalAsync(ws, `window.__cdlg?.id ?? 0`);
  await trigger();
  const action = name === "cancel" ? "cancel" : "confirm";
  const ticks = [];
  const wantOk = action === "confirm";
  try {
    // id-scoped ground-truth poll: wait for a request NEWER than the
    // pre-trigger snapshot, click it, then resolve from the page's own
    // state. "gone" with a NEWER id means the slot cleared before our
    // click landed (a race lost is still a real resolution — the caller's
    // outcome assertions judge whether that outcome was the wanted one).
    const t0 = Date.now();
    let seenNewer = false;
    for (;;) {
      let v = null;
      try {
        v = await evalAsync(ws, `(() => { const g = window.__cdlg, sn = ${seenNewer};
          if (!g || g.id <= ${before}) return sn ? 'gone-after-newer' : 'waiting';
          if (g.state === 'resolved') return g.ok === ${wantOk} ? 'resolved-ok' : 'resolved-mismatch';
          const d = document.querySelector('[data-testid="confirm-dialog"]');
          if (!d) return 'open-no-dom';
          const b = d.querySelector('[data-dialog-action="${action}"]');
          if (!b) return 'open-no-btn';
          b.click(); return 'clicked'; })()`);
      } catch (te) {
        ticks.push({ at: Date.now() - t0, threw: String(te).slice(0, 140) });
        throw te;
      }
      ticks.push({ at: Date.now() - t0, v });
      if (v === "resolved-ok" || v === "resolved-mismatch") return String(v);
      if (v === "gone-after-newer") return "gone";
      if (v !== "waiting") seenNewer = true;
      if (Date.now() - t0 >= timeoutMs) throw new Error(`evalUntil timeout (${timeoutMs}) confirm dialog → ${name} — ticks=${JSON.stringify(ticks)}`);
      await sleep(100);
    }
  } catch (e) {
    // evidence, never silence: what did the page look like when the modal
    // never came up? (overlay present? hints already rendered? exception?)
    const dom = await evalAsync(ws, `(() => ({ overlay: !!document.querySelector('[data-testid="confirm-overlay"]'), cdlg: window.__cdlg ?? null, last: window.__cdlgLast ?? null, appTail: document.querySelector('.app')?.outerHTML.slice(-300), hints: [...document.querySelectorAll('.hint')].map(h => h.textContent.slice(0, 40)), page: document.querySelector('.tab-btn.active')?.textContent?.trim() }))()`).catch((ee) => ({ probeErr: String(ee).slice(0, 80) }));
    console.error(`answerDialog(${name}) timeout: last=${String(e).slice(0, 240)} dom=${JSON.stringify(dom)}`);
    return `NO-dialog-${name}`;
  }
};

S[19] = async () => {
  const details = [];
  const URL_ = "https://tycho.bandcamp.com/track/a-walk";
  // queue-TIME gate (upgrade 1): the composer resolves identity at queue time
  // (memoized D37 probe), finds an existing [id] file in the destination, and
  // presents the same dialog as history's gate — uniform D59 coverage.
  // playlists are excluded by design (the archive already dedupes them).
  // d86 persists composeOpts and s3's first-n leak (d90 full round) made the
  // gate silently exclude itself — pin the mode back explicitly. overwrite
  // must be pinned FALSE too: s18 runs immediately before and its dialog
  // grants persist overwrite=true, which makes this gate skip itself the
  // same way (found live, d90-final round).
  await setOpts({ dlType: "audio", audioFormat: "mp3", skipDownloaded: false, playlistMode: "single" });
  details.push("mirror: audio/mp3, skip off, playlistMode=single, overwrite off (s3/s18 leaks pinned)");
  // warm the backend identity memo before the legs: s16 relaunches the app,
  // so the memo is cold and a cold bandcamp probe (~1-2s) misses even the
  // raised 2.5s dialog cap — the legs then assert a dialog that never opens.
  // found in the d88 full-suite round (2026-09-07).
  await evalAsync(ws, `window.__e2e.ipc('overwrite_targets', { urls: [${JSON.stringify(URL_)}], playlistSingle: true, skipDownloaded: false }).catch(() => [])`);
  // ensure a clean initial download exists (same pattern as s18)
  let prior = new Set((await jobs()).map((j) => j.id));
  let base = (await jobs()).find((j) => j.url.includes("tycho.bandcamp.com/track/a-walk") && j.state === "done" && !(j.error ?? ""));
  if (!base) {
    await evalUntil(`(() => { window.__e2e.goto('home'); return document.querySelector('.tab-btn.active')?.textContent.trim() === 'home' ? 'ok' : 'pending'; })()`, { timeoutMs: 8000, label: "home active (s19)" });
    await queueViaComposer(URL_);
    for (let i = 0; i < 90; i++) {
      const js = await jobs();
      const nz = js.filter((j) => !prior.has(j.id));
      if (nz.length && ["done", "error"].includes(nz[0].state)) { base = nz[0]; break; }
      await sleep(1000);
    }
    if (!base) throw new Error("initial download never finished");
    prior = new Set((await jobs()).map((j) => j.id));
  }
  if (base.state !== "done" || (base.error ?? "")) throw new Error(`initial download not clean: ${base.state} ${base.error ?? ""}`);
  const target = base.finalPath;
  if (!fs.existsSync(target)) throw new Error(`initial file missing: ${target}`);
  const mtime0 = fs.statSync(target).mtimeMs;
  details.push(`initial download: ${path.basename(target)}`);
  const queueAgain = async () => {
    await evalUntil(`(() => { window.__e2e.goto('home'); return document.querySelector('.tab-btn.active')?.textContent.trim() === 'home' ? 'ok' : 'pending'; })()`, { timeoutMs: 8000, label: "home active (s19)" });
    await queueViaComposer(URL_);
  };
  // step 1: cancel — dialog fires on QUEUE click, cancel queues nothing and
  // renders the composer's overwrite-cancelled feedback (the positive signal
  // that the queue-time gate executed)
  const ansA = await answerDialog("cancel", queueAgain);
  const hint = await evalUntil(`(() => [...document.querySelectorAll('.card div')].some(h => h.textContent.includes('queueing cancelled')) ? 'ok' : 'pending')()`, { timeoutMs: 8000, everyMs: 300, label: "cancel feedback (s19)" }).catch(() => "timeout");
  await sleep(800);
  let after = await jobs();
  const newAfterCancel = after.filter((j) => !prior.has(j.id));
  details.push(`cancel: dialog=${ansA}, feedback=${hint === "ok"}, jobs queued=${newAfterCancel.length}`);
  const cancelOk = (ansA === "resolved-ok" || ansA === "gone") && hint === "ok" && newAfterCancel.length === 0;
  prior = new Set(after.map((j) => j.id));
  // step 2: grant — job queued with overwrite=true, finishes clean
  const ansB = await answerDialog("overwrite", queueAgain);
  details.push(`grant: dialog=${ansB}`);
  let j2 = null;
  for (let i = 0; i < 90; i++) {
    const js = await jobs();
    const nz = js.filter((j) => !prior.has(j.id));
    if (nz.length && ["done", "error", "duplicate"].includes(nz[0].state)) { j2 = nz[0]; break; }
    await sleep(1000);
  }
  if (!j2) {
    const stuck = await jobs();
    const stuckState = stuck.filter((j) => !prior.has(j.id)).map((j) => `${j.id.slice(-6)}:${j.state}:${(j.error ?? "").slice(0, 40)}`).join(", ") || "no new jobs";
    let probe = "probe-fail";
    try {
      probe = await evalAsync(ws, `(() => { const d = document.querySelector('[data-testid="confirm-dialog"]'); return d ? 'modal-visible: ' + d.querySelector('.cdlg-title')?.textContent?.trim() : 'no modal in dom'; })()`);
    } catch { }
    details.push(`TIMEOUT: new jobs=[${stuckState}], dialog ${probe}`);
    record(19, "queue-time overwrite gate (D59)", false, details);
    return;
  }
  details.push(`granted job: ${j2.state}${j2.error ? " — " + j2.error.slice(0, 60) : ""}`);
  // the real assertion: the job's PERSISTED options carry overwrite=true
  let ow = "?";
  try {
    ow = require("child_process").execSync(
      `python -c "import sqlite3,json;con=sqlite3.connect(r'${DATA_DIR_SQL()}/history.db');r=con.execute('select options from jobs where id=?',('${j2.id}',)).fetchone();print(str(json.loads(r[0]).get('overwrite')).lower())"`,
      { encoding: "utf8" },
    ).trim();
  } catch { ow = "db-err"; }
  const mtime1 = fs.existsSync(target) ? fs.statSync(target).mtimeMs : 0;
  details.push(`options.overwrite=${ow}; file re-downloaded (mtime advanced): ${mtime1 > mtime0}`);
  record(19, "queue-time overwrite gate (D59)", !!(cancelOk && ansB === "resolved-ok" && j2.state === "done" && !(j2.error ?? "") && ow === "true" && mtime1 > mtime0), details);
};

/** wipe one group's sandbox (all persisted state except the staged managed
 * binaries). every group launch must start deterministic — this is the whole
 * point of the d91 redesign: no group can see another group's leftovers. */
function wipeState(dir) {
  if (fs.existsSync(dir)) {
    for (const f of fs.readdirSync(dir)) {
      if (f === "bin") continue;
      fs.rmSync(path.join(dir, f), { recursive: true, force: true });
    }
  }
  const dl = path.join(ROOT, "e2e-dl");
  fs.rmSync(dl, { recursive: true, force: true });

  // the sandbox has no bin/ — provision the staged managed binaries from the
  // legacy profile (exactly what the installer wizard would have placed).
  // settings.json is seeded AFTER this so a stale sandbox manifest.json is
  // left alone (the manager is its single writer).
  const binDst = path.join(dir, "bin");
  if (!fs.existsSync(path.join(binDst, "yt-dlp.exe"))) {
    const binSrc = path.join(LEGACY_PROFILE, "bin");
    fs.mkdirSync(binDst, { recursive: true });
    for (const f of ["yt-dlp.exe", "ffmpeg.exe", "ffprobe.exe", "manifest.json"]) {
      const src = path.join(binSrc, f);
      if (fs.existsSync(src)) fs.copyFileSync(src, path.join(binDst, f));
    }
  }
}

/** seed settings.json before launch — a run must not depend on leftover
 * state from whatever ran before it (found live: a pre-run cleanup deleted
 * settings.json, the app booted its default destination, and s8's re-download
 * landed in ~/Music instead of the e2e dir, resurrecting the existing-target
 * error edge the scenario had already fixed). */
function seedSettings(dir) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "settings.json"),
    // d86: composeOpts must seed EMPTY here — a leftover composeOpts from an
    // earlier round (e.g. cookies=firefox from a manual probe) silently
    // reseeds the composer every launch and makes "cookies off" scenarios
    // nondeterministic (found live, 2026-09-06: S13 queued with the
    // previous round's firefox cookies and hit a cookie decrypt error).
    JSON.stringify({ destination: DL_DIR, concurrency: 2, wizardDismissed: true, migratedFromV1: true, composeOpts: null }, null, 2),
  );
}

async function main() {
  // singleton guard: a second runner attached to the same debug port
  // interleaves scenarios with the first — silently corrupting both runs.
  const net = require("net");
  await new Promise((resolve, reject) => {
    const probe = net.connect(PORT, "127.0.0.1");
    probe.on("connect", () => {
      probe.destroy();
      reject(new Error(`something is already listening on :${PORT} — another runner or app instance is alive`));
    });
    probe.on("error", () => resolve());
  });
  if (process.argv.includes("--list")) {
    for (const n of [1, 4, 3, 2, 9, 10, 12, 11, 13, 14, 8, 7, 5, 6, 15, 16, 18, 19, 20, 21])
      console.log(`S${n}	${SOURCE[n]}	${SCEN_NAMES[n]}`);
    return;
  }
  const only = process.argv.includes("--only")
    ? process.argv[process.argv.indexOf("--only") + 1].split(",").map(Number)
    : null;
  let order = [1, 4, 3, 2, 9, 10, 12, 11, 13, 14, 8, 7, 5, 6, 15, 16, 18, 19, 20, 21, 23, 22];
  if (process.argv.includes("--smoke")) order = order.filter((n) => SOURCE[n] !== "youtube");
  const toRun = only ? order.filter((n) => only.includes(n)) : order;
  if (toRun.length === 0) {
    console.log("no scenarios selected" + (process.argv.includes("--smoke") ? " (smoke excludes youtube-tagged scenarios; youtube is bot-gating this machine?)" : ""));
    return;
  }

  // d91: each selected scenario runs inside its GROUP, and a group runs its
  // full scenario list (fresh sandbox). chains like s8 needing s11's zoo
  // history row are group-internal state — running a lone member solo would
  // break the chain, so --only selects GROUPS, not lone scenarios. use
  // --smoke to skip the youtube-tagged ones.
  const groupsToRun = GROUPS
    .filter((g) => toRun.some((n) => g.scenarios.includes(n)))
    .map((g) => ({
      ...g,
      scenarios: process.argv.includes("--smoke") ? g.scenarios.filter((n) => SOURCE[n] !== "youtube") : g.scenarios,
    }))
    .filter((g) => g.scenarios.length > 0);

  // the runner drives the app over cdp — a stale exe silently tests
  // yesterday's build (found live after a clippy-only compile). abort when
  // any tracked source file is newer than the debug binary.
  const { execSync } = require("child_process");
  try {
    const exeM = fs.statSync(EXE).mtimeMs;
    const repoRoot = path.join(__dirname, "../..");
    const stale = execSync("git ls-files", { encoding: "utf8", cwd: repoRoot })
      .split("\n")
      .filter((f) => /\.rs$/.test(f) || f.includes("capabilities") || f.includes("tauri.conf"))
      .filter((f) => {
        const p = path.join(repoRoot, f);
        return fs.existsSync(p) && fs.statSync(p).mtimeMs > exeM;
      });
    if (stale.length) {
      console.error(`ABORT: ${stale.length} rust/capability file(s) newer than the debug exe — run: cargo build --manifest-path src-tauri/Cargo.toml`);
      console.error("  e.g. " + stale.slice(0, 4).join(", "));
      process.exit(3);
    }
  } catch { /* outside a git checkout or exe missing — launch will report */ }

  console.log(`e2e groups: ${groupsToRun.map((g) => `${g.name}[${g.scenarios.join(",")}]`).join("  ")}`);
  for (const g of groupsToRun) {
    await runGroup(g);
  }

  // results table + doc
  const passCount = results.filter((r) => r.pass).length;
  console.log(`\n======== RESULTS: ${passCount}/${results.length} PASS ========`);
  for (const r of results) {
    console.log(`S${String(r.n).padStart(2)}  ${r.pass ? "PASS" : "FAIL"}  ${r.name}`);
  }
  writeResultsDoc();
  // s16 leaves orphaned yt-dlp children (the app died, not them) — reap them
  try { require("child_process").execSync("taskkill /IM yt-dlp.exe /F", { stdio: "ignore" }); } catch { /* none running */ }
  process.exit(0);
}

/** run one scenario group: wipe its sandbox, seed settings, launch a fresh
 * app, attach, then run the group's scenarios in order. the app is killed
 * on group exit so the next group's launch is clean (no port/webview reuse). */
async function runGroup(group) {
  DATA_DIR = path.join(require("os").tmpdir(), `ytdlp-gui-e2e-${group.name}`);
  DL_DIR = path.join(ROOT, "e2e-dl");
  process.env.YTDLP_GUI_DATA_DIR = DATA_DIR; // launchAndAttach spreads process.env
  console.log(`\n######## group ${group.name}: sandbox=${DATA_DIR} dest=${DL_DIR}`);
  wipeState(DATA_DIR);
  seedSettings(DATA_DIR);
  const { ws: socket } = await launchAndAttach(EXE, PORT);
  ws = socket;
  // page errors are evidence: surface the webview's console into the run log
  socket.on("event", (m) => {
    if (m.method === "Runtime.consoleAPICalled" && ["error", "warning"].includes(m.params.type)) {
      console.error(`[page:${m.params.type}]`, (m.params.args ?? []).map((a) => a.value ?? a.description ?? "").join(" ").slice(0, 300));
    }
  });
  try {
    await sleep(1200);
    await injectBundle();
    // wait for react hydration + the one late vite reload to settle before
    // any ui interaction (the reload wipes injected bundles)
    await waitFor(ws, "document.querySelectorAll('.tab-btn').length >= 3 && window.__TAURI_INTERNALS__ ? true : null", { timeoutMs: 60000, everyMs: 400 });
    await injectBundle();
    await sleep(4000);
    await injectBundle();
    console.log(`attached (${group.name}). running scenarios:`, group.scenarios.join(", "));
    for (const n of group.scenarios) {
      await scenario(n, SCEN_NAMES[n], S[n]);
    }
  } finally {
    // s16 kills the app itself; a kill here is harmless then. always kill so
    // the next group's port probe is clean.
    try { require("child_process").execSync("taskkill /IM ytdlp-gui.exe /F", { stdio: "ignore" }); } catch { /* already gone */ }
    await sleep(2000);
  }
}

// 20 — archived-duplicate skip semantic, no youtube (d61 close-out):
// soundcloud flickermood queues → downloads → its id lands in the archive;
// the re-queue must end done/skipped WITHOUT re-downloading (file mtime
// untouched) and WITHOUT the d59 overwrite dialog — the gate's archive-aware
// branch must never ask when the engine would skip cleanly. (if the gate
// regresses, the unattended dialog blocks the wait until timeout: the failure
// shape names the cause.) runs green on fresh state, solo, or after s10.
S[20] = async () => {
  const details = [];
  await setOpts({ dlType: "audio", skipDownloaded: true });
  const arch = path.join(DATA_DIR, "downloaded.txt");
  const archLine = () => fs.existsSync(arch) ? fs.readFileSync(arch, "utf8").split(/\r?\n/).map((l) => l.trim()).find((l) => l.startsWith("soundcloud ")) : null;
  const priorIds = new Set((await jobBy("flickermood")).map((j) => j.id));
  const t0 = Date.now();
  await queueViaComposer(SC_FLICKER);
  // whichever way the archive sat before this scenario, the queue must end
  // done quickly: freshly downloaded (archive line appended now) or already
  // archived (engine pre-check). both prove "archived ⇒ no second download".
  const isFlicker = (j) => j.url.includes("flickermood");
  const done = await waitIpc("queue_list", (v) => v.some((j) => isFlicker(j) && !priorIds.has(j.id) && j.state === "done"), { timeoutMs: 120000, everyMs: 300, label: "flickermood done (s20)" })
    .then((v) => v.find((j) => isFlicker(j) && !priorIds.has(j.id) && j.state === "done")); // filter the find too — unfiltered, it matched s18/s19's tycho rows (found live, full smoke)
  const ms = Date.now() - t0;
  details.push(`queue done in ${ms}ms skipped=${done.skipped} (${done.error ?? "no error"})`);
  if (!done.skipped) {
    const line = archLine();
    if (!line) throw new Error("fresh download did not append an archive line");
    details.push(`archive line appended: ${line}`);
  }
  if (done.finalPath && fs.existsSync(done.finalPath)) {
    details.push(`file present: ${path.basename(done.finalPath)}`);
  }
  // pre-archived state: the skip happened in the engine's pre-check before
  // any download, so there is no fresh file to stat — skip the mtime check
  // (asserting it would re-download what --fresh deliberately keeps).
  if (!fs.existsSync(done.finalPath)) {
    record(20, "archived duplicate → done/skipped, no re-download, no dialog", done.skipped === true, details);
    return;
  }
  const mtime0 = fs.statSync(done.finalPath).mtimeMs;
  await queueViaComposer(SC_FLICKER);
  const again = await waitIpc("queue_list", (v) => v.some((j) => isFlicker(j) && !priorIds.has(j.id) && j.id !== done.id && j.state === "done"), { timeoutMs: 120000, everyMs: 300, label: "re-queue done (s20)" }).then((v) => v.find((j) => isFlicker(j) && !priorIds.has(j.id) && j.id !== done.id && j.state === "done")); // filtered find + 120s: the gate's probe can legally take ~90s under throttle
  const untouched = fs.statSync(done.finalPath).mtimeMs === mtime0;
  details.push(`re-queue: skipped=${again.skipped}, file untouched=${untouched}`);
  record(20, "archived duplicate → done/skipped, no re-download, no dialog", again.skipped === true && untouched, details);
};

// 21 — archive↔db reconciliation (d64), zero network: a fake id appended to
// the archive is backfilled into history (+1, url-less row — visible, not
// silent); removing it proves idempotence (second run backfills nothing).
// the imported row is left in history deliberately: it renders "source url
// unknown" and the next --fresh wipe clears it.
S[21] = async () => {
  const details = [];
  const arch = path.join(DATA_DIR, "downloaded.txt");
  const call = () => evalAsync(ws, `window.__e2e.ipc('archive_reconcile')`);
  // per-run fake id: a leftover imported row from an earlier run would make
  // INSERT OR IGNORE skip the backfill (found live) — uniqueness makes the
  // scenario self-contained instead of state-dependent.
  const FAKE = "e2eFAKE" + Date.now();
  const before = await call();
  fs.mkdirSync(path.dirname(arch), { recursive: true });
  fs.appendFileSync(arch, `\ne2efake ${FAKE}\n`);
  const rep = await call();
  const rows = await history();
  const imported = rows.find((h) => h.vid === FAKE);
  details.push(`backfilled ${before.rowsBackfilled} → ${rep.rowsBackfilled} (+${rep.rowsBackfilled - before.rowsBackfilled}), rowsWithoutUrl=${rep.rowsWithoutUrl}, row.url=${imported?.url ?? "null"}`);
  const lines = fs.readFileSync(arch, "utf8").split(/\r?\n/).filter((l) => l.trim() !== "" && !l.includes("e2eFAKE"));
  fs.writeFileSync(arch, lines.join("\n") + "\n");
  const rep2 = await call();
  details.push(`after cleanup: rowsBackfilled=${rep2.rowsBackfilled} (per-call count; 0 = idempotent)`);
  record(21, "archive→history backfill + idempotence (d64)", rep.rowsBackfilled - before.rowsBackfilled === 1 && !!imported && imported.url == null && rep2.rowsBackfilled === 0, details);
};

// d69: reset app data — guarded, double-confirmed in the ui, and (this being
// the engine-truth contract) truthful about what it removed. runs last: it
// wipes the sandbox profile, which is also what makes it self-verifying.
S[22] = async () => {
  const details = [];
  const queueBefore = await evalAsync(ws, `window.__e2e.ipc('queue_list')`);
  const busy = queueBefore.filter((j) => ["fetching", "downloading", "post"].includes(j.state));
  details.push(`queue rows before: ${queueBefore.length} (busy: ${busy.length})`);

  // the refusal probe is only safe while actually busy — an idle-queue call
  // is not refused, it PERFORMS the reset (found live: the probe wiped the
  // rows and the real call below saw a no-op).
  if (busy.length > 0) {
    const refused = await evalAsync(ws, `window.__e2e.ipc('app_reset_data').then(() => 'allowed', (e) => String(e))`);
    details.push(`busy-guard: refused while busy: ${String(refused).slice(0, 90)}`);
    if (!String(refused).includes("busy")) {
      record(22, "reset app data (d69)", false, [...details, "reset was ALLOWED while the queue was busy — guard broken"]);
      return;
    }
  } else {
    details.push("busy-guard: n/a (queue idle)");
  }

  // drain to idle so the reset can proceed (stop any stragglers, wait for
  // the engine to settle — the same quiescence discipline as s5/s15)
  if (busy.length > 0) {
    for (const j of busy) await evalAsync(ws, `window.__e2e.ipc('job_stop', { id: ${JSON.stringify(j.id)} }).catch(() => {})`);
    await evalUntil(
      `window.__e2e.ipc('queue_list').then(v => v.every(j => !["fetching","downloading","post"].includes(j.state)))`,
      { timeoutMs: 120000, everyMs: 500, label: "queue idle (s22)" },
    );
  }

  const rep = await evalAsync(ws, `window.__e2e.ipc('app_reset_data')`);
  const jobsAfter = await evalAsync(ws, `window.__e2e.ipc('queue_list')`);
  const histAfter = await evalAsync(ws, `window.__e2e.ipc('history_list')`);
  const settingsAfter = fs.existsSync(path.join(DATA_DIR, "settings.json")) ? null : "removed";
  const archiveAfter = fs.existsSync(path.join(DATA_DIR, "downloaded.txt")) ? null : "removed";
  const binKept = fs.existsSync(path.join(DATA_DIR, "bin", "yt-dlp.exe"));
  details.push(`report: jobs=${rep.jobsCleared} history=${rep.historyCleared} settings=${rep.settingsRemoved} archive=${rep.archiveRemoved} customArchive=${rep.archiveWasCustom}`);
  details.push(`after: queue=${jobsAfter.length} history=${histAfter.length} settings.json=${settingsAfter} downloaded.txt=${archiveAfter} bin kept=${binKept}`);

  const noop = rep.jobsCleared === 0; // both wipes ran earlier in this run
  record(22, "reset app data (d69): guarded wipe, bin kept, report matches disk",
    jobsAfter.length === 0 && histAfter.length === 0 && settingsAfter === "removed" && binKept &&
      (noop || rep.jobsCleared === queueBefore.length),
    details);
};

// 23 — archive import semantics (d75), zero network: merge unions into the
// app-owned archive (picked file untouched); replace swaps the archive's
// contents without deleting history rows; a re-import reports 0 new.
S[23] = async () => {
  const details = [];
  const arch = path.join(DATA_DIR, "downloaded.txt");
  // per-run unique ids — the scenario must be self-contained against prior
  // runs' leftovers in the shared sandbox profile (the S21 lesson).
  const T = Date.now();
  const A = `e2eA${T}`, B = `e2eB${T}`, C = `e2eC${T}`;
  // a foreign "picked" file OUTSIDE the data dir — the app must never
  // point settings/engine at it, never modify it.
  const picked = path.join(DATA_DIR, "..", `e2e-import-${T}.txt`);
  const call = (mode) => evalAsync(
    ws,
    `window.__e2e.ipc('history_import_archive', { path: ${JSON.stringify(picked)}${mode ? `, mode: '${mode}'` : ""} })`,
  );
  fs.writeFileSync(picked, `e2esrc ${A}\ne2esrc ${B}\n`);
  // merge: the app archive gains exactly the picked file's 2 entries
  const r1 = await call("merge");
  const afterMerge = fs.readFileSync(arch, "utf8");
  details.push(`merge: imported=${r1.idsImported} archiveAdded=${r1.archiveAdded} path=${r1.archivePath === arch ? "app-data" : r1.archivePath}`);
  // an app-side entry enters the archive + history (reconcile), then the
  // same file re-imports: union keeps both sides, counts only new (0).
  fs.appendFileSync(arch, `e2eapp ${C}\n`);
  await evalAsync(ws, `window.__e2e.ipc('archive_reconcile')`);
  const r2 = await call("merge");
  const afterMerge2 = fs.readFileSync(arch, "utf8");
  const pickedUntouched = fs.readFileSync(picked, "utf8") === `e2esrc ${A}\ne2esrc ${B}\n`;
  // replace: archive takes ONLY the picked file's content; history keeps
  // its rows (never deleted) — the app-side entry remains a history row.
  const r3 = await call("replace");
  const afterReplace = fs.readFileSync(arch, "utf8");
  const hist = await history();
  const cccRow = hist.find((h) => h.vid === C);
  // default mode (no arg) = merge; re-import of the same file adds nothing
  const r4 = await call();
  details.push(`replace: archiveAdded=${r3.archiveAdded}; default-mode: imported=${r4.idsImported} added=${r4.archiveAdded}`);
  const s = await evalAsync(ws, `window.__e2e.ipc('settings_get')`);
  details.push(`settings.archivePath=${JSON.stringify(s.archivePath)}`);
  fs.rmSync(picked, { force: true });
  record(23, "archive import merge/replace (d75)",
    r1.archiveAdded === 2 && afterMerge.includes(`e2esrc ${A}`) &&
      r2.archiveAdded === 0 && afterMerge2.includes(`e2eapp ${C}`) && pickedUntouched &&
      r3.archiveAdded === 2 && afterReplace.includes(`e2esrc ${A}`) && !afterReplace.includes(`e2eapp ${C}`) &&
      !!cccRow &&
      r4.idsImported === 0 && r4.archiveAdded === 0 &&
      (s.archivePath == null || s.archivePath === ""),
    details);
};

const SCEN_NAMES = {
  1: "single video end-to-end",
  2: "entire playlist counter",
  3: "playlist first-n=2",
  4: "archived duplicate → done/skipped",
  5: "identity duplicate while running",
  6: "stop → resume (D31/D35 semantics)",
  7: "moved-file locate/relink",
  8: "D19 re-download uses composer options",
  9: "lenient intake (D28)",
  10: "single-format audio fallback",
  11: "webm warning + download",
  12: "unavailable video error surface",
  13: "enter / shift+enter (D58)",
  14: "ctrl+v / F5",
  15: "pause never kills (D34)",
  16: "restart normalization (D35)",
  18: "re-download overwrite gate (D59)",
  19: "queue-time overwrite gate (D59)",
  20: "archived duplicate skips (no youtube)",
  21: "archive↔db reconciliation (D64)",
  22: "reset app data (D69)",
  23: "archive import merge/replace (D75)",
};

function writeResultsDoc() {
  const date = new Date().toISOString().slice(0, 10);
  const lines = [
    "# e2e run results (docs/E2E_CHECKLIST.md scenarios 1–16)",
    "",
    `- run date: ${date}`,
    "- driver: real app (debug build + vite dev server), driven over WebView2 remote debugging",
    "  (real ipc, real yt-dlp processes, real network; state asserted via `invoke()` engine truth)",
    "- managed binaries: staged yt-dlp + btbN ffmpeg (copied into the e2e sandbox bin/)",
    `- results: ${results.filter((r) => r.pass).length}/${results.length} pass`,
    "",
    "| # | scenario | result | evidence |",
    "|---|---|---|---|",
    ...results.map((r) => `| ${r.n} | ${r.name} | ${r.pass ? "PASS" : "FAIL"} | ${(r.details ?? []).join("<br>")?.replace(/\|/g, "\\|") ?? ""} |`),
    "",
    "## notes",
    "",
    "- scenario 7's native file-picker dialog is not scriptable over cdp; the relink",
    "  was exercised through the same `history_relink` ipc the 🔍 button invokes,",
    "  and the row-state transitions (moved? → locate… → healed → 📁) were verified in the ui.",
    "- scenario 17 (app update path) is out of scope until the minisign key lands (D56).",
  ];
  fs.writeFileSync(path.resolve(__dirname, "../../docs/E2E_RESULTS.md"), lines.join("\n") + "\n");
  console.log("wrote docs/E2E_RESULTS.md");
}

main().catch((e) => {
  console.error("runner crashed:", e);
  if (results.length) writeResultsDoc();
  process.exit(1);
});
