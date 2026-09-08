// d88 live probe — retry semantics in the real app.
//
// phase 1: launch once on a fresh sandbox so the schema exists, then kill.
// phase 2: seed history.db with a STOPPED job (dest=oldDir, vid known —
//          simulating an attempt that got past fetch), plant a fake .part
//          + .webp in oldDir, relaunch, drive the composer to a NEW dest +
//          cookies-from-browser + wav, click the row's retry button.
// asserts: old dir loses the partial+sidecar; the retried run downloads to
//          the new dir as .wav (cookies adopted → fetch passes the bot-gate;
//          wav adopted → the file extension; d88 guard → job completes, no
//          .webp/.png debris anywhere); the composer shows the wav warn.
const path = require("path");
const fs = require("fs");
const os = require("os");
const { execSync } = require("child_process");
const { launchAndAttach, evalAsync, sleep } = require("./cdp.cjs");

const SB = path.join(os.tmpdir(), "d88-sandbox");
const oldDir = path.join(os.tmpdir(), "d88-old");
const newDir = path.join(os.tmpdir(), "d88-new");
const realBin = path.join(process.env.APPDATA || "", "ytdlp-gui", "bin");
const exe = path.resolve(__dirname, "../../src-tauri/target/debug/ytdlp-gui.exe");
const URL_ZOO = "https://www.youtube.com/watch?v=jNQXAC9IVRw";

const kill = () => { try { execSync("taskkill //IM ytdlp-gui.exe //F 2>nul", { shell: "cmd.exe", stdio: "ignore" }); } catch {} };
const j = (p) => JSON.stringify(p).replace(/\\/g, "\\\\");

// react-controlled inputs need the native value setter
const SETTER_JS = `
const setInput = (el, v) => {
  const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
  s.call(el, v);
  el.dispatchEvent(new Event("input", { bubbles: true }));
};
const setSel = (el, v) => {
  const s = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value").set;
  s.call(el, v);
  el.dispatchEvent(new Event("change", { bubbles: true }));
};
`;

async function main() {
  kill();
  await sleep(1500);
  fs.rmSync(SB, { recursive: true, force: true });
  for (const d of [SB, oldDir, newDir, path.join(SB, "bin")]) fs.mkdirSync(d, { recursive: true });
  for (const f of fs.readdirSync(realBin)) {
    if (/yt-dlp|ffmpe|ffprobe/.test(f)) fs.copyFileSync(path.join(realBin, f), path.join(SB, "bin", f));
  }
  fs.writeFileSync(
    path.join(SB, "settings.json"),
    JSON.stringify({ wizardDismissed: true, destination: oldDir, composeOpts: null }),
  );

  // phase 1 — schema creation
  process.env.YTDLP_GUI_DATA_DIR = SB;
  let session = await launchAndAttach(exe, 9333);
  await sleep(2500);
  kill();
  await sleep(1500);

  // seed the stopped job (vid known — the d88 sweep depends on it)
  execSync(
    `python "${path.join(__dirname, "seed-d88.py")}" "${SB}" "${oldDir}" "${URL_ZOO}"`,
    { stdio: "inherit" },
  );
  fs.writeFileSync(path.join(oldDir, "Me at the zoo [jNQXAC9IVRw].opus.part"), "partial");
  fs.writeFileSync(path.join(oldDir, "Me at the zoo [jNQXAC9IVRw].webp"), "sidecar");
  console.log("old dir before:", fs.readdirSync(oldDir));

  // phase 2 — the real test
  session = await launchAndAttach(exe, 9333);
  const { ws, pid } = session;
  const ev = (expr) => evalAsync(ws, expr);
  // wait for the app to be interactive (composer mounted + ipc alive)
  for (let i = 0; i < 30; i++) {
    await sleep(500);
    const ready = await ev(`!!window.__TAURI_INTERNALS__ && document.querySelectorAll("select").length > 0`).catch(() => "no");
    if (ready === true) break;
  }

  // drive the composer through the real DOM: new dest + cookies + wav
  const setup = await ev(`(async () => {
    ${SETTER_JS}
    // destination (the composer's dest field)
    const destInput = [...document.querySelectorAll("input")].find(i => i.placeholder && i.placeholder.includes("downloads folder"));
    if (!destInput) return "no-dest-input";
    setInput(destInput, ${j(newDir)});
    await new Promise(r => setTimeout(r, 250));
    // open advanced
    const advBtn = [...document.querySelectorAll("button")].find(b => b.textContent.trim().startsWith("advanced"));
    if (advBtn) advBtn.click();
    await new Promise(r => setTimeout(r, 300));
    // cookies: from browser (browser auto-defaults to firefox since d84)
    const cookieSel = [...document.querySelectorAll("select")].find(s => [...s.options].some(o => o.value === "frombrowser"));
    if (!cookieSel) return "no-cookie-select";
    setSel(cookieSel, "frombrowser");
    await new Promise(r => setTimeout(r, 250));
    // audio format: wav
    const fmtSel = [...document.querySelectorAll("select")].find(s => [...s.options].some(o => o.value === "wav"));
    if (!fmtSel) return "no-format-select";
    setSel(fmtSel, "wav");
    await new Promise(r => setTimeout(r, 350));
    const warn = document.querySelector(".warn");
    return "ok; warn=" + (warn ? warn.textContent : "none");
  })()`);
  console.log("composer setup:", setup);

  // click the seeded row's retry button
  const click = await ev(`(() => {
    const btn = [...document.querySelectorAll("tr button.iconbtn")].find(b => (b.title || "").startsWith("retry"));
    if (!btn) return "no-retry-btn";
    btn.click();
    return "clicked";
  })()`);
  console.log("retry click:", click);

  // poll until terminal
  let state = "", info = "";
  for (let i = 0; i < 60; i++) {
    await sleep(700);
    const snap = await ev(`(async () => {
      const { invoke } = window.__TAURI_INTERNALS__;
      const jobs = await invoke("queue_list");
      const row = jobs.find(x => x.id === "j-seed");
      return row ? JSON.stringify({ state: row.state, error: row.error, tail: (row.output || []).slice(-2) }) : "gone";
    })()`);
    try {
      const parsed = JSON.parse(snap.replace(/^"|"$/g, "").replace(/\\"/g, '"'));
      state = parsed.state; info = parsed;
    } catch { state = snap; }
    if (["done", "error", "stopped", "duplicate"].includes(state)) break;
  }
  console.log("final state:", state, "| tail:", JSON.stringify(info.tail ?? []));
  if (info.error) console.log("error text:", info.error);

  console.log("old dir after:", fs.readdirSync(oldDir));
  console.log("new dir after:", fs.readdirSync(newDir));

  const oldOk = !fs.readdirSync(oldDir).some((f) => f.endsWith(".part") || f.endsWith(".webp"));
  const newFiles = fs.readdirSync(newDir);
  const wavThere = newFiles.some((f) => f.endsWith(".wav") && f.includes("[jNQXAC9IVRw]"));
  const noDebris = !newFiles.some((f) => /\.(webp|png|jpg|jpeg)$/i.test(f) && f.includes("[jNQXAC9IVRw]"));
  console.log(`RESULTS: sweepOld=${oldOk} wavLanded=${wavThere} noDebris=${noDebris} state=${state}`);

  kill();
  process.exit(oldOk && wavThere && noDebris && state === "done" ? 0 : 1);
}

main().catch((e) => { console.error("PROBE ERROR", e); process.exit(1); });
