// d97 live probe — cancelling a playlist cleans up after itself, and finished
// tracks can be deleted (one, or a selection) from the row's track list.
//
// drives the REAL debug app (vite dev server must be up on :1420) against a
// per-probe sandbox:
//   1. queue the 10-track tycho album rate-limited, let 3 tracks land, press
//      the row's ■ while track 4 is mid-download.
//   2. assert: no `.part`/`.ytdl` left behind, the 3 finished files and their
//      records stay, the row reads `3/total` (never a stray byte percent),
//      and the message names the cleanup.
//   3. expand the row, select two tracks, cancel the confirm once (files must
//      survive), then delete them for real.
//   4. delete the last track from its row ✕; the playlist row is left with no
//      tracks, no files and no archive lines.
const path = require("path");
const fs = require("fs");
const os = require("os");
const { execSync } = require("child_process");
const { launchAndAttach, evalAsync, sleep } = require("./cdp.cjs");

const SB = path.join(os.tmpdir(), "d97-sandbox");
const DL = path.join(os.tmpdir(), "d97-dl");
const realBin = path.join(process.env.APPDATA || "", "ytdlp-gui", "bin");
const exe = path.resolve(__dirname, "../../src-tauri/target/debug/ytdlp-gui.exe");
const PORT = 9447;
const ALBUM = "https://tycho.bandcamp.com/album/dive";

const kill = () => {
  try { execSync("taskkill //IM ytdlp-gui.exe //F 2>nul", { shell: "cmd.exe", stdio: "ignore" }); } catch {}
};
const files = () => (fs.existsSync(DL) ? fs.readdirSync(DL) : []);
const audio = () => files().filter((f) => f.endsWith(".mp3"));
const partials = () => files().filter((f) => /\.(part|ytdl|temp)$/.test(f));
const archive = () =>
  fs.existsSync(path.join(SB, "downloaded.txt"))
    ? fs.readFileSync(path.join(SB, "downloaded.txt"), "utf8").trim().split("\n").filter(Boolean)
    : [];

const opts = {
  dlType: "audio", audioFormat: "mp3", coverMode: "none", coverW: 640, coverH: 640,
  maxResolution: "best", container: "mp4", audioPref: "opus",
  playlistMode: "all", playlistN: 10, skipDownloaded: true, overwrite: false,
  cookies: { kind: "none", browser: null, file: null },
  subtitleLangs: [], autoCaptions: false, sponsorblock: [],
  extraArgs: ["--limit-rate", "300k", "--progress-delta", "2"],
  outputTemplate: null,
};

let failures = 0;
function check(label, ok, detail = "") {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

(async () => {
  kill();
  await sleep(1200);
  fs.rmSync(SB, { recursive: true, force: true });
  fs.rmSync(DL, { recursive: true, force: true });
  for (const d of [SB, DL, path.join(SB, "bin")]) fs.mkdirSync(d, { recursive: true });
  for (const f of fs.readdirSync(realBin)) {
    if (/yt-dlp|ffmpe|ffprobe/.test(f)) fs.copyFileSync(path.join(realBin, f), path.join(SB, "bin", f));
  }
  // migratedFromV1 stops the dev cwd's ytdlp_gui_config.json from seeding the
  // composer mid-probe (the repo root carries one for migration testing).
  fs.writeFileSync(
    path.join(SB, "settings.json"),
    JSON.stringify({
      wizardDismissed: true,
      destination: DL,
      concurrency: 1,
      composeOpts: null,
      migratedFromV1: true,
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

  // ---- cancel before start: a queued playlist has no process to signal, so
  // ■ must cancel it in place (it used to answer "job is not running").
  await ev(invoke("queue_pause"));
  const early = await ev(invoke("job_add", { urls: [ALBUM], options: opts, destination: DL }));
  // the row appears through the queue:changed reload, not the ipc call
  for (let i = 0; i < 20; i++) {
    await sleep(400);
    if (await ev(`!!document.querySelector('tr.qrow[data-status="queued"]')`)) break;
  }
  const earlyClick = await ev(`(() => {
    const r = [...document.querySelectorAll("tr.qrow")].find(x => x.dataset.status === "queued");
    if (!r) return "no queued row";
    const b = [...r.querySelectorAll("button")].find(b => (b.title ?? "").startsWith("cancel"));
    if (!b) return "no cancel button";
    b.click();
    return b.title;
  })()`);
  check("a queued playlist offers cancel, not stop", /will not start/.test(earlyClick ?? ""), earlyClick);
  await sleep(1000);
  const earlyRow = await ev(`(async () => (await window.__TAURI_INTERNALS__.invoke("queue_list", {}))
    .find(j => j.id === ${JSON.stringify(early.jobs[0].id)}))()`);
  check(
    "cancel on a queued playlist lands in stopped",
    earlyRow.state === "stopped" && /before it started/.test(earlyRow.error ?? ""),
    `${earlyRow.state} · ${earlyRow.error}`,
  );
  check("it never downloaded anything", files().length === 0, files().join(", "));
  await ev(invoke("queue_resume"));

  const fb = await ev(invoke("job_add", { urls: [ALBUM], options: opts, destination: DL }));
  const id = fb.jobs[0].id;
  console.log("queued", id);

  // wait for 3 finished tracks and one mid-flight partial
  const t0 = Date.now();
  while (Date.now() - t0 < 240000) {
    if (audio().length >= 3 && partials().length > 0) break;
    await sleep(500);
  }
  console.log("before stop:", files().join(" | "));

  const clicked = await ev(`(() => {
    const r = [...document.querySelectorAll("tr.qrow")].find(x => ["downloading","post"].includes(x.dataset.status));
    if (!r) return "no active row";
    const b = [...r.querySelectorAll("button")].find(b => /^(stop|cancel)/.test(b.title ?? ""));
    if (!b) return "no stop button";
    b.click();
    return b.title;
  })()`);
  check("row ■ clicked while a track is in flight", /removes the unfinished track/.test(clicked ?? ""), clicked);

  await sleep(6000);
  const row = await ev(`(async () => (await window.__TAURI_INTERNALS__.invoke("queue_list", {}))
    .find(j => j.id === ${JSON.stringify(id)}))()`);
  const names = files();
  console.log("after stop:", names.join(" | "));

  check("no .part/.ytdl left behind", partials().length === 0, partials().join(", "));
  check("the 3 finished tracks stayed", audio().length === 3, `${audio().length} mp3`);
  check("state is stopped", row.state === "stopped", row.state);
  check(
    "message names the cleanup",
    /unfinished track removed/.test(row.error ?? "") && /3 kept/.test(row.error ?? ""),
    row.error,
  );
  check("item records match the files", row.items.length === 3, `${row.items.length} records`);
  check("counts are tracks, not bytes", row.itemsDone === 3 && row.itemsTotal >= 3, `${row.itemsDone}/${row.itemsTotal}`);
  check("no byte percent left on the row", row.pct == null, String(row.pct));
  check("archive kept the finished tracks", archive().length === 3, archive().join(", "));

  // ---- open the track list
  await ev(`(() => { const r = document.querySelector("tr.qrow[data-status='stopped']"); r.querySelector(".t-title").click(); return true; })()`);
  await sleep(900);
  const listed = await ev(`(() => [...document.querySelectorAll(".itemlist-row")].map(r => ({
    checks: r.querySelectorAll("input.itemlist-check").length,
    del: !!r.querySelector(".itemlist-del"),
    title: r.querySelector(".itemlist-title")?.textContent ?? "",
  })))()`);
  check("every finished track has a checkbox and a delete control",
    listed.length === 3 && listed.every((r) => r.checks === 1 && r.del), JSON.stringify(listed));

  // a real pointer over the first track reveals its ✕ (css :hover), so the
  // captured frame shows the affordance as a user sees it.
  try {
    await ev(`document.querySelector("tr.log-row")?.scrollIntoView({ block: "center" })`);
    await sleep(400);
    const box = await ev(`(() => { const r = document.querySelector(".itemlist-row").getBoundingClientRect(); return { x: r.left + r.width - 24, y: r.top + r.height / 2 }; })()`);
    await ws.call("Input.dispatchMouseEvent", { type: "mouseMoved", x: box.x, y: box.y });
    const shot = await ws.call("Page.captureScreenshot", { format: "png" });
    const out = path.join(os.tmpdir(), "d97-tracks.png");
    fs.writeFileSync(out, Buffer.from(shot.data, "base64"));
    console.log("screenshot:", out);
  } catch (e) {
    console.log("screenshot skipped:", e.message);
  }

  // ---- multi-select delete, with a cancelled confirm first. selection
  // survives a cancelled confirm (deliberate — the user may retry), so only
  // click boxes that are still unchecked.
  const clickDel = (indices) =>
    ev(`(() => {
      const rows = [...document.querySelectorAll(".itemlist-row")];
      ${JSON.stringify(indices)}.forEach(i => {
        const c = rows[i]?.querySelector("input.itemlist-check");
        if (c && !c.checked) c.click();
      });
      const b = [...document.querySelectorAll(".itemlist-h button")].find(b => b.textContent.includes("delete selected"));
      if (!b) return "no batch button";
      b.click();
      return b.textContent.trim();
    })()`);
  const batchLabel = await clickDel([0, 1]);
  check("selecting two tracks offers a batch delete", /delete selected \(2\)/.test(batchLabel ?? ""), batchLabel);
  await sleep(500);
  check("delete is gated by the app confirm", (await ev("window.__cdlg?.state ?? 'none'")) === "open");
  await ev(`document.querySelector('[data-dialog-action="cancel"]').click()`);
  await sleep(700);
  check("cancelling the confirm keeps every file", audio().length === 3, `${audio().length} mp3`);

  await clickDel([0, 1]);
  await sleep(500);
  await ev(`document.querySelector('[data-dialog-action="confirm"]').click()`);
  await sleep(2500);
  const afterBatch = await ev(`(async () => (await window.__TAURI_INTERNALS__.invoke("queue_list", {}))
    .find(j => j.id === ${JSON.stringify(id)}))()`);
  check("two files deleted, one kept", audio().length === 1, files().join(", "));
  check("two records removed, one kept", afterBatch.items.length === 1, `${afterBatch.items.length} records`);
  check("counts follow the remaining records", afterBatch.itemsDone === 1, `${afterBatch.itemsDone}/${afterBatch.itemsTotal}`);
  check("archive dropped only the deleted tracks", archive().length === 1, archive().join(", "));

  // ---- delete the last one from its own row
  await ev(`(() => { document.querySelector(".itemlist-del")?.click(); return true; })()`);
  await sleep(500);
  await ev(`document.querySelector('[data-dialog-action="confirm"]').click()`);
  await sleep(2000);
  const empty = await ev(`(async () => (await window.__TAURI_INTERNALS__.invoke("queue_list", {}))
    .find(j => j.id === ${JSON.stringify(id)}))()`);
  check("last track deleted from disk", audio().length === 0, files().join(", "));
  check("no track records left", empty.items.length === 0 && empty.itemsDone === 0, JSON.stringify({ items: empty.items.length, done: empty.itemsDone }));
  check("archive is empty again", archive().length === 0, archive().join(", "));

  console.log(failures === 0 ? "\nD97 PROBE PASS" : `\nD97 PROBE FAIL (${failures})`);
  kill();
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => {
  console.error("PROBE FAILED:", e.message);
  kill();
  process.exit(1);
});
