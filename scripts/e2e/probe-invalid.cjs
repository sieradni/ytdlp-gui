// standalone probe — "errors are invisible": the intake verdict and the row
// that fails later, measured in the real app window.
//
// checks, in order:
//   1. pressing enter shows a verdict in the same frame (pending), and the
//      final verdict renders DIRECTLY under the textarea (adjacent), not at
//      the bottom of the card
//   2. the rejection is announced (role=alert), red-toned, names the line and
//      the reason, and puts the rejected text back in the box
//   3. the verdict can be dismissed, and typing clears it
//   4. a link that passes intake but cannot resolve surfaces on its queue row
const path = require("path");
const { launchAndAttach, evalAsync, sleep, pressKey } = require("./cdp.cjs");

const CDP_PORT = 9446;
const PROFILE = path.resolve(__dirname, "../../src-tauri/target/probe-invalid-webview");

const SCAN = `(() => {
  const ta = document.querySelector('textarea');
  const box = document.querySelector('.intake');
  const pane = document.querySelector('main.scrollpane');
  const r = box ? box.getBoundingClientRect() : null;
  const tr = ta ? ta.getBoundingClientRect() : null;
  return {
    t: Math.round(performance.now()),
    text: box ? box.innerText.replace(/\\n+/g, ' | ').slice(0, 260) : null,
    tone: box ? box.getAttribute('data-tone') : null,
    role: box ? box.getAttribute('role') : null,
    rect: r ? { top: Math.round(r.top), bottom: Math.round(r.bottom), h: Math.round(r.height) } : null,
    gapBelowTextarea: r && tr ? Math.round(r.top - tr.bottom) : null,
    viewportH: innerHeight,
    fullyVisible: r ? r.top >= 0 && r.bottom <= innerHeight : null,
    scrollTop: pane ? Math.round(pane.scrollTop) : null,
    textareaValue: ta ? ta.value : null,
    ariaInvalid: ta ? ta.getAttribute('aria-invalid') : null,
    queueBusy: (() => { const b = [...document.querySelectorAll('.btn.primary')][0]; return b ? { label: b.textContent.trim(), disabled: b.disabled } : null; })(),
  };
})()`;

/** real enter: one keyDown carrying the text (the app prevents its default),
 * then keyUp. a separate `char` dispatch would bypass preventDefault and
 * insert a newline the user never typed. */
async function pressEnter(ws) {
  const k = { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 };
  await ws.call("Input.dispatchKeyEvent", { type: "keyDown", ...k, text: "\r", unmodifiedText: "\r" });
  await ws.call("Input.dispatchKeyEvent", { type: "keyUp", ...k });
}

async function enter(ws, text) {
  await evalAsync(ws, `(() => { const ta = document.querySelector('textarea'); ta.focus(); ta.select(); return 1; })()`);
  await ws.call("Input.insertText", { text });
  // the enter handler reads committed react state, and insertText updates the
  // DOM before react commits — wait on the composer's own counter (derived
  // from state) so the probe cannot race the commit and prove nothing
  await sleep(300); // a human types, then presses enter — never in one tick
  const want = text.split(/[\n,;]+/).filter((l) => l.trim()).length;
  const wantHint = `${want} ${want === 1 ? "url" : "urls"}`;
  for (let i = 0; i < 30; i++) {
    const hint = await evalAsync(
      ws,
      `[...document.querySelectorAll('.hint')].map((h) => h.textContent.trim()).find((t) => /^\\d+ urls?$/.test(t)) || null`,
    );
    if (hint === wantHint) break;
    await sleep(50);
  }
  const t0 = await evalAsync(ws, `performance.now()`);
  await pressEnter(ws);
  return t0;
}

(async () => {
  const exe = path.resolve(__dirname, "../../src-tauri/target/debug/ytdlp-gui.exe");
  process.env.WEBVIEW2_USER_DATA_FOLDER = PROFILE;
  const { ws, child } = await launchAndAttach(exe, CDP_PORT);
  await sleep(2500);
  for (let i = 0; i < 40; i++) {
    if (await evalAsync(ws, `!!document.querySelector('textarea')`)) break;
    await sleep(250);
  }
  const out = {};

  // ---- 1. immediate verdict + placement
  const t0 = await enter(ws, "not a link");
  const trail = [];
  let pendingAt = null;
  for (let i = 0; i < 60; i++) {
    await sleep(100);
    const s = await evalAsync(ws, SCAN);
    const dt = Math.round(s.t - t0);
    trail.push({ dt, tone: s.tone, gap: s.gapBelowTextarea, text: s.text ? s.text.slice(0, 70) : null, btn: s.queueBusy && s.queueBusy.label });
    if (pendingAt === null && s.text) pendingAt = dt;
    if (s.tone === null && s.text && /invalid|couldn't/.test(s.text) === false) break;
    if (s.role === "alert" && s.text) break;
  }
  const first = await evalAsync(ws, SCAN);
  out.immediacy = { pendingAtMs: pendingAt, trail: trail.slice(0, 6) };
  out.verdict = first;

  // ---- 2. adjacency with the advanced section open (the old surface's
  // below-the-card placement is exactly what pushed it off-screen)
  await evalAsync(ws, `(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim().startsWith('advanced')); b.click(); return 1; })()`);
  await sleep(200);
  const advancedOpen = await evalAsync(ws, SCAN);
  out.withAdvancedOpen = { gapBelowTextarea: advancedOpen.gapBelowTextarea, fullyVisible: advancedOpen.fullyVisible, text: advancedOpen.text ? advancedOpen.text.slice(0, 60) : null };

  // ---- 3. dismiss + typing clears
  await evalAsync(ws, `(() => { const x = document.querySelector('.intake-x'); if (x) x.click(); return !!x; })()`);
  await sleep(150);
  out.dismissWorks = (await evalAsync(ws, `!document.querySelector('.intake')`)) === true;

  await enter(ws, "not a link");
  await sleep(2200);
  const beforeTyping = await evalAsync(ws, `!!document.querySelector('.intake')`);
  await evalAsync(ws, `document.querySelector('textarea').focus()`);
  await ws.call("Input.insertText", { text: "x" });
  await sleep(250);
  out.typingClearsVerdict = { verdictBefore: beforeTyping, verdictAfter: await evalAsync(ws, `!!document.querySelector('.intake')`) };

  // ---- 4. a link that passes intake but cannot resolve
  await evalAsync(ws, `(() => { const ta = document.querySelector('textarea'); ta.focus(); ta.select(); return 1; })()`);
  await ws.call("Input.dispatchKeyEvent", { type: "keyDown", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 });
  await ws.call("Input.dispatchKeyEvent", { type: "keyUp", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 });
  // the app's db persists across runs, so an error row from an earlier probe
  // would satisfy the selector before THIS submission finished — and moving on
  // mid-flight would race the next step against the busy latch. baseline first.
  const errBefore = await evalAsync(ws, `document.querySelectorAll('.qrow[data-status="error"]').length`);
  await enter(ws, "https://ytdlp-pulse-probe.invalid/watch?v=x");
  let rowErr = null;
  for (let i = 0; i < 80; i++) {
    await sleep(400);
    rowErr = await evalAsync(
      ws,
      `(() => {
        if (document.querySelectorAll('.qrow[data-status="error"]').length <= ${errBefore}) return null;
        const row = document.querySelector('.qrow[data-status="error"]');
        if (!row) return null;
        const meta = row.querySelector('.t-meta');
        const cell = meta ? meta.getBoundingClientRect() : null;
        return {
          meta: meta ? meta.textContent.slice(0, 160) : null,
          truncated: meta ? meta.scrollWidth > meta.clientWidth : null,
          title: meta ? meta.getAttribute('title') : null,
          progress: row.querySelector('.numm') ? row.querySelector('.numm').textContent : null,
          visible: cell ? cell.top >= 0 && cell.bottom <= innerHeight : null,
        };
      })()`,
    );
    if (rowErr) break;
  }
  out.failedRow = rowErr ?? "no error row appeared within 32s";

  // ---- 5. the verdict tells the whole story of ONE paste: the same url twice
  // is a notice (the second line is not a failure), and a mixed paste keeps
  // only the rejected line and queues the rest.
  await enter(ws, "https://ytdlp-pulse-probe.invalid/watch?v=dup\nhttps://ytdlp-pulse-probe.invalid/watch?v=dup");
  await sleep(3200);
  out.duplicateNotice = await evalAsync(ws, SCAN);

  await enter(ws, "not a link\nhttps://ytdlp-pulse-probe.invalid/watch?v=mix");
  await sleep(3200);
  out.mixed = await evalAsync(ws, SCAN);

  try { child.kill(); } catch { /* already gone */ }
  console.log(JSON.stringify(out, null, 2));
  process.exit(0);
})().catch((e) => {
  console.error("probe failed:", e.message);
  process.exit(1);
});
