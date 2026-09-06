// interrogate the d59 queue-time gate against the CURRENT on-disk state
// (archive: soundcloud 293 + existing flickermood file) — answers, with live
// evidence: (1) does overwrite_targets treat the archived url as safe? (2)
// does a real composer click still open the confirm modal anyway?
const path = require("path");
const { execSync } = require("child_process");
const { launchAndAttach, evalAsync, sleep } = require("./cdp.cjs");

(async () => {
  const exe = path.resolve(__dirname, "../../src-tauri/target/debug/ytdlp-gui.exe");
  const { ws } = await launchAndAttach(exe, 9333);
  await sleep(2500);
  const invoke = (cmd, args) =>
    evalAsync(ws, `window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args ?? {})})`);

  const res = await invoke("overwrite_targets", {
    urls: ["https://soundcloud.com/forss/flickermood"],
    playlistSingle: true,
    skipDownloaded: true,
  }).catch((e) => "ERR " + e.message);
  console.log("gate(archived, skip=on):", JSON.stringify(res));

  // now the real composer click path, exactly as s20 does it
  const set = await evalAsync(ws, `(() => {
    const i = document.querySelector('.card-b textarea');
    if (!i) return 'no-composer';
    const p = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    p.call(i, 'https://soundcloud.com/forss/flickermood');
    i.dispatchEvent(new Event('input', { bubbles: true }));
    return 'set';
  })()`);
  console.log("composer set:", set);
  await sleep(300);
  evalAsync(ws, `(() => { const b = [...document.querySelectorAll('.card button')].find(x => x.textContent.trim() === 'queue downloads'); if (!b) return 'no-btn'; b.click(); return 'clicked'; })()`).catch(() => "click-err");
  await sleep(6000);
  // m7-b: the gate's confirm is the in-app modal now — probe the dom
  const dialog = await evalAsync(ws, `(() => { const d = document.querySelector('[data-testid="confirm-dialog"]'); return d ? 'modal-visible: ' + d.querySelector('.cdlg-title')?.textContent?.trim() : 'no modal in dom'; })()`).catch((e) => "(probe failed) " + e.message);
  console.log("dialog probe after click:", dialog);
  const jobs = await invoke("queue_list").catch((e) => "ERR " + e.message);
  const f = (Array.isArray(jobs) ? jobs : []).filter((j) => j.url.includes("flickermood"));
  console.log("flickermood jobs:", JSON.stringify(f.map((j) => ({ id: j.id, state: j.state, skipped: j.skipped }))));
  process.exit(0);
})().catch((e) => { console.error("FATAL", e); process.exit(1); });
