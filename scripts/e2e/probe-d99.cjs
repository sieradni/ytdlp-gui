// d99 live probe — the expando transcript is yt-dlp's own output: the
// engine's `__X__` protocol prints are parsed for state but never written to
// the job log, while progress, item tracking and the cancel cleanup keep
// working. drives the REAL debug app (vite dev server on :1420).
//
//   1. queue the 10-track tycho album rate-limited, let 2 tracks land.
//   2. expand the running row: job.output must contain real yt-dlp lines and
//      no `__`-prefixed protocol line, and the DOM log must agree.
//   3. counts/percent still update (the parse still runs on every line).
//   4. cancel mid-track: cleanup message present, no `.part` left, kept files
//      == records, and the transcript is still protocol-free.
const path = require("path");
const fs = require("fs");
const os = require("os");
const { execSync } = require("child_process");
const { launchAndAttach, evalAsync, sleep } = require("./cdp.cjs");

const SB = path.join(os.tmpdir(), "d99-sandbox");
const DL = path.join(os.tmpdir(), "d99-dl");
const realBin = path.join(process.env.APPDATA || "", "ytdlp-gui", "bin");
const exe = path.resolve(__dirname, "../../src-tauri/target/debug/ytdlp-gui.exe");
const PORT = 9457;
const ALBUM = "https://tycho.bandcamp.com/album/dive";

const kill = () => {
  try { execSync("taskkill //IM ytdlp-gui.exe //F 2>nul", { shell: "cmd.exe", stdio: "ignore" }); } catch {}
};
const files = () => (fs.existsSync(DL) ? fs.readdirSync(DL) : []);
const audio = () => files().filter((f) => f.endsWith(".mp3") && !f.includes(".temp."));
const partials = () => files().filter((f) => /\.(part|ytdl|temp)$/.test(f) || f.includes(".temp."));

const opts = {
  dlType: "audio", audioFormat: "mp3", coverMode: "none", coverW: 640, coverH: 640,
  maxResolution: "best", container: "mp4", audioPref: "opus",
  playlistMode: "all", playlistN: 10, skipDownloaded: true, overwrite: false,
  cookies: { kind: "none", browser: null, file: null },
  subtitleLangs: [], autoCaptions: false, sponsorblock: [],
  extraArgs: ["--limit-rate", "120k", "--progress-delta", "1"],
  outputTemplate: null,
};

let failures = 0;
function check(label, ok, detail = "") {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}
const protocolLines = (out) => out.filter((l) => /^\s*__[A-Z]__/.test(l));

(async () => {
  kill();
  await sleep(1200);
  fs.rmSync(SB, { recursive: true, force: true });
  fs.rmSync(DL, { recursive: true, force: true });
  for (const d of [SB, DL, path.join(SB, "bin")]) fs.mkdirSync(d, { recursive: true });
  for (const f of fs.readdirSync(realBin)) {
    if (/yt-dlp|ffmpe|ffprobe/.test(f)) fs.copyFileSync(path.join(realBin, f), path.join(SB, "bin", f));
  }
  fs.writeFileSync(
    path.join(SB, "settings.json"),
    JSON.stringify({
      wizardDismissed: true, destination: DL, concurrency: 1, composeOpts: null, migratedFromV1: true,
    }),
  );

  process.env.YTDLP_GUI_DATA_DIR = SB;
  const { ws } = await launchAndAttach(exe, PORT);
  const ev = (expr) => evalAsync(ws, expr);
  for (let i = 0; i < 30; i++) {
    await sleep(500);
    if ((await ev(`!!window.__TAURI_INTERNALS__`).catch(() => false)) === true) break;
  }
  const invoke = (cmd, args) =>
    `window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args ?? {})})`;
  const job = (id) =>
    ev(`(async () => (await window.__TAURI_INTERNALS__.invoke("queue_list", {})).find(j => j.id === ${JSON.stringify(id)}))()`);

  const fb = await ev(invoke("job_add", { urls: [ALBUM], options: opts, destination: DL }));
  const id = fb.jobs[0].id;
  console.log("queued", id);

  const t0 = Date.now();
  while (Date.now() - t0 < 240000) {
    if (audio().length >= 2) break;
    await sleep(300);
  }
  // expand the live row
  await ev(`(() => { const r = document.querySelector("tr.qrow[data-status='downloading'],tr.qrow[data-status='post']");
    r?.querySelector(".t-title")?.click(); return true; })()`);
  await sleep(1500);

  const running = await job(id);
  const runOut = running.output ?? [];
  console.log("running log sample:\n" + runOut.slice(-6).map((l) => "    " + l).join("\n"));
  check("the running transcript has yt-dlp output", runOut.length > 0, `${runOut.length} lines`);
  check(
    "no __P__/__V__/__C__ protocol line in the running transcript",
    protocolLines(runOut).length === 0,
    protocolLines(runOut).slice(0, 3).join(" | "),
  );
  check(
    "the transcript carries yt-dlp's own output (after_move filepaths)",
    runOut.some((l) => /\.mp3\s*$/.test(l) && /[\\/]/.test(l)),
    runOut.join(" | ").slice(0, 120),
  );
  check(
    "parse still drives state without the protocol lines in the log",
    running.pct != null || running.itemsTotal != null,
    `pct=${running.pct} ${running.itemsDone}/${running.itemsTotal} title=${running.title}`,
  );
  const domLog = await ev(`(() => document.querySelector(".logwrap")?.textContent ?? "")()`);
  check("the rendered log panel has no protocol noise", !/__[A-Z]__/.test(domLog), domLog.slice(0, 80));

  // cancel mid-track
  await ev(`(() => { const r = document.querySelector("tr.qrow[data-status='downloading'],tr.qrow[data-status='post']");
    const b = [...(r?.querySelectorAll("button") ?? [])].find(b => /^(stop|cancel)/.test(b.title ?? ""));
    b?.click(); return b?.title; })()`);
  const t1 = Date.now();
  let stopped;
  while (Date.now() - t1 < 30000) {
    stopped = await job(id);
    if (stopped.state === "stopped") break;
    await sleep(300);
  }
  const stopOut = stopped.output ?? [];
  console.log("stopped log tail:\n" + stopOut.slice(-5).map((l) => "    " + l).join("\n"));
  check("state is stopped", stopped.state === "stopped", stopped.state);
  check("cleanup message is still logged", stopOut.some((l) => /cancelled mid-track — removed/.test(l)));
  check(
    "cancel still removes the unfinished track",
    partials().length === 0,
    files().join(" | "),
  );
  check(
    "kept tracks == records",
    audio().length === (stopped.items ?? []).length && (stopped.itemsDone ?? -1) === audio().length,
    `${audio().length} files · ${(stopped.items ?? []).length} records · ${stopped.itemsDone}/${stopped.itemsTotal}`,
  );
  check(
    "the stopped transcript is still protocol-free",
    protocolLines(stopOut).length === 0,
    protocolLines(stopOut).slice(0, 3).join(" | "),
  );
  check("the transcript survived the cancel (it is not empty)", stopOut.length > 3, `${stopOut.length} lines`);
  // the whole point: a multi-minute run used to log one `__P__` line per
  // second. real output is a handful of lines.
  check("no per-second spam (a few real lines for a multi-minute run)", stopOut.length <= 15, `${stopOut.length} lines`);

  // visual evidence: the expanded, stopped row's transcript (real output only)
  try {
    if (!(await ev(`!!document.querySelector(".logwrap")`))) {
      await ev(`document.querySelector("tr.qrow[data-status='stopped'] .t-title")?.click();`);
      await sleep(700);
    }
    await ev(`document.querySelector(".logwrap")?.scrollIntoView({ block: "center" });`);
    await sleep(500);
    const shot = await ws.call("Page.captureScreenshot", { format: "png" });
    const out = path.join(__dirname, "../../.d99-log.png");
    fs.writeFileSync(out, Buffer.from(shot.data, "base64"));
    console.log("screenshot:", out);
  } catch (e) {
    console.log("screenshot skipped:", e.message);
  }

  console.log(failures === 0 ? "\nD99 PROBE PASS" : `\nD99 PROBE FAIL (${failures})`);
  kill();
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => {
  console.error("PROBE FAILED:", e.stack || e.message);
  kill();
  process.exit(1);
});
