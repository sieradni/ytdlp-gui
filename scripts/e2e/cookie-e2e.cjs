// live check: cookies-from-browser chrome → DPAPI failure must return the
// rewritten firefox/edge guidance (m7 close-out). drives the composer's
// real cookie <select> inside the expanded advanced panel.
const path = require("path");
const { launchAndAttach, evalAsync, sleep } = require("./cdp.cjs");
// staged binaries live in the e2e sandbox profile (same contract as run.cjs)
process.env.YTDLP_GUI_DATA_DIR = process.env.YTDLP_GUI_DATA_DIR || path.join(require("os").tmpdir(), "ytdlp-gui-e2e");
(async () => {
  const exe = path.resolve(__dirname, "../../src-tauri/target/debug/ytdlp-gui.exe");
  const { ws, pid } = await launchAndAttach(exe, 9333);
  await sleep(2500);
  await evalAsync(ws, `(() => {
    [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'later')?.click();
    return 'ok';
  })()`);
  await sleep(400);
  // open advanced
  await evalAsync(ws, `(() => {
    const adv = [...document.querySelectorAll('button')].find(b => b.textContent.trim().startsWith('advanced'));
    if (adv && !adv.textContent.includes('▴')) adv.click();
    return 'adv';
  })()`);
  await sleep(400);
  // the cookie kind select is the one with the "from browser…" option
  const r1 = await evalAsync(ws, `(() => {
    const sel = [...document.querySelectorAll('select')].find(s => [...s.options].some(o => o.textContent.includes('from browser')));
    if (!sel) return 'no-cookie-kind-select';
    const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
    setter.call(sel, 'frombrowser');
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    return 'kind-set';
  })()`);
  console.log("kind:", r1);
  await sleep(400);
  // the browser select appears next to it — the one whose options are browser names
  const r2 = await evalAsync(ws, `(() => {
    const sel = [...document.querySelectorAll('select')].find(s => [...s.options].some(o => o.value === 'brave'));
    if (!sel) return 'no-browser-select';
    const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
    setter.call(sel, 'chrome');
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    return 'browser-set:' + sel.value;
  })()`);
  console.log("browser:", r2);
  await sleep(300);
  // verify the preview shows the flag
  console.log("preview:", await evalAsync(ws, `document.querySelector('.cmd-preview')?.textContent?.includes('--cookies-from-browser chrome')`));
  await evalAsync(ws, `(() => {
    const ta = document.querySelector('.card-b textarea');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, 'https://www.youtube.com/watch?v=jNQXAC9IVRw');
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    return 'typed';
  })()`);
  await sleep(300);
  // skip downloaded off
  await evalAsync(ws, `(() => {
    const t = document.querySelector('label.toggle input');
    if (t && t.checked) t.click();
    return 'skip-off';
  })()`);
  await sleep(200);
  console.log("queue:", await evalAsync(ws, `(() => {
    const b = [...document.querySelectorAll('button')].find(b => b.textContent.includes('queue downloads'));
    b?.click(); return b ? 'clicked' : 'no-btn';
  })()`));
  let err = null;
  for (let i = 0; i < 50; i++) {
    await sleep(1500);
    const st = await evalAsync(ws, `(() => {
      const rows = [...document.querySelectorAll('tr.qrow')];
      if (!rows.length) return null;
      const meta = rows[0].querySelector('.t-meta');
      return meta ? meta.textContent : null;
    })()`);
    if (st && (st.includes("decrypt") || st.includes("firefox"))) { err = st; break; }
    if (st && st.includes("done")) { err = "UNEXPECTED DONE"; break; }
  }
  console.log("RESULT:", err ? err.slice(0, 420) : "no rewritten error in 75s");
  try { process.kill(pid); } catch {}
  process.exit(0);
})().catch((e) => { console.error("probe failed:", e); process.exit(1); });
