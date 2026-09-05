// standalone d61/d64 probe — no suite state involved. observes the fetch
// phase for a bot-gated-style url against the real app, fresh process.
const path = require("path");
const { launchAndAttach, evalAsync, sleep } = require("./cdp.cjs");

(async () => {
  const exe = path.resolve(__dirname, "../../src-tauri/target/debug/ytdlp-gui.exe");
  const { ws } = await launchAndAttach(exe, 9333);
  await sleep(2500);
  const invoke = (cmd, args) =>
    evalAsync(ws, `window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args ?? {})})`);

  await invoke("queue_pause");
  // one fresh zoo job (paused → stays queued; identity probe NOT running yet)
  const fb = await invoke("job_add", {
    urls: ["https://www.youtube.com/watch?v=jNQXAC9IVRw"],
    options: { dlType: "audio", audioFormat: "best", coverMode: "square", coverW: 640, coverH: 640,
      maxResolution: "best", container: "mp4", audioPref: "opus", playlistMode: "single", playlistN: 10,
      skipDownloaded: false, overwrite: false, cookies: { kind: "none", browser: null, file: null },
      subtitleLangs: [], autoCaptions: false, sponsorblock: [], extraArgs: [], outputTemplate: null },
    destination: null,
  });
  const id = fb.jobs[0].id;
  console.log("queued (paused):", id);

  // resume → fetch starts
  await invoke("queue_resume");
  const t0 = Date.now();
  let fetchedAt = null, doneAt = null, dupAt = null;
  for (let i = 0; i < 120; i++) {
    await sleep(500);
    const j = (await invoke("queue_list")).find((j) => j.id === id);
    if (!j) continue;
    const dt = ((Date.now() - t0) / 1000).toFixed(1);
    if (j.state === "fetching" && fetchedAt === null) { fetchedAt = Date.now(); console.log(`t+${dt}s fetching`); }
    if (j.state === "downloading" && doneAt === null) { doneAt = Date.now(); if (fetchedAt) console.log(`fetch took ${((doneAt - fetchedAt) / 1000).toFixed(1)}s`); console.log(`t+${dt}s downloading`); }
    if (j.state === "duplicate" && dupAt === null) { dupAt = Date.now(); console.log(`t+${dt}s duplicate: ${j.error}`); }
    if (["done", "error", "duplicate", "stopped"].includes(j.state) && (doneAt || dupAt)) break;
    if (["done", "error", "stopped"].includes(j.state)) { console.log(`t+${dt}s terminal: ${j.state}`); break; }
  }
  console.log("RESULT:", JSON.stringify({ fetchMsObserved: fetchedAt !== null, tookMs: doneAt ? doneAt - t0 : null }));
  process.exit(0);
})().catch((e) => { console.error("probe failed:", e.message); process.exit(1); });
