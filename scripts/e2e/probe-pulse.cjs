// standalone probe — the resolving-stage indicator, measured LIVE in the real
// app window (no css theatre, no mocked store).
//
// two questions:
//   (a) which element is the indicator? a fetching row is inspected for every
//       running animation in the subtree — the `.progress[data-indeterminate]`
//       sliver, or something the engine's per-second tick drives.
//   (b) how fast does it cycle, and is it being restarted? `animationstart`
//       count + `startTime` drift across a window that spans several
//       per-second fetch ticks answers both: a restarted animation restarts
//       its clock; a re-mounted element loses its marker attribute.
//
// the row is held in `fetching` by a local url whose socket is never
// answered, so the identity probe blocks instead of settling.
const path = require("path");
const http = require("http");
const { launchAndAttach, evalAsync, sleep } = require("./cdp.cjs");

const CDP_PORT = 9444;
const SLOW_PORT = 8799;
const PROFILE = path.resolve(__dirname, "../../src-tauri/target/probe-pulse-webview");

/** page-side measurement: sample every 80 ms, record geometry, the animation
 * clock, and which per-second labels landed while we watched. */
const measure = (ms) => `(async () => {
  const track = document.querySelector('.progress[data-indeterminate]');
  if (!track) return { error: 'no indeterminate bar on screen' };
  const el = track.firstElementChild;
  // marker + listeners exist only on THIS node; a react remount loses both
  el.dataset.pulseProbe = 'p1';
  let starts = 0, iterations = 0, cancels = 0;
  el.addEventListener('animationstart', () => starts++);
  el.addEventListener('animationiteration', () => iterations++);
  el.addEventListener('animationcancel', () => cancels++);
  const row = track.closest('.qrow');
  const subtree = row.getAnimations({ subtree: true }).map((a) => ({
    name: a.animationName,
    target: (a.effect && a.effect.target && (a.effect.target.className || a.effect.target.tagName)) || '?',
  }));
  const t0 = performance.now();
  const samples = [];
  for (;;) {
    const t = performance.now() - t0;
    const a = el.getAnimations()[0] || null;
    const cs = getComputedStyle(el);
    const tr = el.getBoundingClientRect();
    const tk = track.getBoundingClientRect();
    samples.push({
      t: Math.round(t),
      x: Math.round((tr.left - tk.left) * 10) / 10,
      w: Math.round(tr.width * 10) / 10,
      trackW: Math.round(tk.width * 10) / 10,
      transform: cs.transform,
      name: cs.animationName,
      dur: cs.animationDuration,
      iters: cs.animationIterationCount,
      startTime: a ? Math.round(a.startTime) : null,
      currentTime: a && a.currentTime != null ? Math.round(a.currentTime) : null,
      // how many sweeps the engine itself says it has run — a shortened
      // duration on an infinite loop shows up here as ~100k per second
      iteration: a && a.effect ? Math.round(a.effect.getComputedTiming().currentIteration) : null,
      state: a ? a.playState : null,
      label: row.querySelector('.numm') ? row.querySelector('.numm').textContent : null,
    });
    if (t >= ${ms}) break;
    await new Promise((r) => setTimeout(r, 80));
  }
  return {
    sameNode: el.dataset.pulseProbe === 'p1',
    starts, iterations, cancels,
    subtree,
    indeterminateBars: document.querySelectorAll('.progress[data-indeterminate]').length,
    samples,
  };
})()`;

/** derive the visible cadence from the sampled x positions: a wrap (the sliver
 * jumping back left) is one completed cycle. */
function summarise(r) {
  if (!r || r.error) return r;
  const wraps = [];
  for (let i = 1; i < r.samples.length; i++) {
    if (r.samples[i].x < r.samples[i - 1].x - 5) wraps.push(r.samples[i].t);
  }
  const span = r.samples[r.samples.length - 1].t - r.samples[0].t;
  const periods = [];
  for (let i = 1; i < wraps.length; i++) periods.push(wraps[i] - wraps[i - 1]);
  const labels = [...new Set(r.samples.map((s) => s.label))];
  const startTimes = [...new Set(r.samples.map((s) => s.startTime))];
  return {
    sameNode: r.sameNode,
    subtreeAnimations: r.subtree,
    indeterminateBars: r.indeterminateBars,
    animationName: r.samples[0].name,
    dur: r.samples[0].dur,
    iters: r.samples[0].iters,
    observedSubmit: `${span}ms`,
    sweepCycles: wraps.length,
    cyclesPerSecond: +(wraps.length / (span / 1000)).toFixed(2),
    measuredPeriodMs: periods.length ? Math.round(periods.reduce((a, b) => a + b, 0) / periods.length) : null,
    animationstarts: r.starts,
    animationiterations: r.iterations,
    animationcancels: r.cancels,
    uniqueStartTimes: startTimes,
    iterationDelta: r.samples[0].iteration != null && r.samples[r.samples.length - 1].iteration != null
      ? r.samples[r.samples.length - 1].iteration - r.samples[0].iteration
      : null,
    labelsWhileWatching: labels,
    xRange: [Math.min(...r.samples.map((s) => s.x)), Math.max(...r.samples.map((s) => s.x))],
    distinctX: new Set(r.samples.map((s) => s.x)).size,
    trackW: r.samples[0].trackW,
    sliverW: r.samples[0].w,
  };
}

(async () => {
  // 1. a url that never answers: yt-dlp blocks on the read, so the row sits in
  // `fetching` for as long as the probe needs (the engine's 90 s watchdog is
  // the only thing that ends it).
  const slow = http.createServer(() => {
    /* deliberately no response, no end */
  });
  await new Promise((r) => slow.listen(SLOW_PORT, "127.0.0.1", r));

  const exe = path.resolve(__dirname, "../../src-tauri/target/debug/ytdlp-gui.exe");
  // the user's own window (if open) owns the shared webview2 profile, and a
  // second process inherits its browser args — no debug port for us. a private
  // profile gives this instance its own browser process, and leaves the
  // running app untouched.
  process.env.WEBVIEW2_USER_DATA_FOLDER = PROFILE;
  const { ws, child } = await launchAndAttach(exe, CDP_PORT);
  await sleep(3000);
  console.log(
    "page:",
    JSON.stringify(
      await evalAsync(ws, `({ href: location.href, title: document.title, rows: document.querySelectorAll('.qrow').length })`),
    ),
  );
  const invoke = (cmd, args) =>
    evalAsync(ws, `window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args ?? {})})`);

  const media = await evalAsync(
    ws,
    `({ reduce: matchMedia('(prefers-reduced-motion: reduce)').matches, dur: getComputedStyle(document.documentElement).animationDuration })`,
  );
  console.log("host prefers-reduced-motion:", JSON.stringify(media));

  await invoke("queue_pause");
  const fb = await invoke("job_add", {
    urls: [`http://127.0.0.1:${SLOW_PORT}/never-answers`],
    options: {
      dlType: "audio", audioFormat: "best", coverMode: "square", coverW: 640, coverH: 640,
      maxResolution: "best", container: "mp4", audioPref: "opus", playlistMode: "single", playlistN: 10,
      skipDownloaded: false, overwrite: false, cookies: { kind: "none", browser: null, file: null },
      subtitleLangs: [], autoCaptions: false, sponsorblock: [], extraArgs: [], outputTemplate: null,
    },
    destination: null,
  });
  const id = fb.jobs[0].id;
  console.log("queued:", id);
  await invoke("queue_resume");

  // wait for the row to be on screen AND indeterminate
  let ready = false;
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    const st = await evalAsync(
      ws,
      `(() => { const r = document.querySelector('.qrow[data-status="fetching"]'); return r ? (r.querySelector('.progress[data-indeterminate]') ? 'pulse' : 'fetching-no-pulse') : 'none'; })()`,
    );
    if (st === "pulse") { ready = true; break; }
    if (st === "fetching-no-pulse") console.log("fetching row without an indeterminate bar");
  }
  if (!ready) {
    console.log("row never reached the resolving stage with a pulse");
    process.exit(1);
  }

  // ---- A: whatever the machine really renders (windows "animation effects"
  // off reports reduce, so this IS the state the user sees)
  const asIs = summarise(await evalAsync(ws, measure(3200)));
  console.log("A. as the machine reports it  :", JSON.stringify(asIs));

  // ---- B: normal motion, emulated on the same live row
  await ws.call("Emulation.setEmulatedMedia", {
    media: "",
    features: [{ name: "prefers-reduced-motion", value: "no-preference" }],
  });
  await sleep(500);
  const normal = summarise(await evalAsync(ws, measure(3400)));
  console.log("B. normal motion (emulated)  :", JSON.stringify(normal));

  // ---- C: back to the host setting, geometry checked for visibility
  await ws.call("Emulation.setEmulatedMedia", { media: "", features: [] });
  await sleep(500);
  const reduced = summarise(await evalAsync(ws, measure(2400)));
  const geom = await evalAsync(
    ws,
    `(() => {
      const track = document.querySelector('.progress[data-indeterminate]');
      const el = track.firstElementChild;
      const tr = el.getBoundingClientRect(), tk = track.getBoundingClientRect();
      return {
        insideTrack: tr.left >= tk.left - 0.5 && tr.right <= tk.right + 0.5,
        visible: tr.width > 0 && getComputedStyle(el).opacity !== '0' && getComputedStyle(el).visibility !== 'hidden',
        leftOffset: Math.round((tr.left - tk.left) * 10) / 10,
        rightGap: Math.round((tk.right - tr.right) * 10) / 10,
        trackW: Math.round(tk.width), sliverW: Math.round(tr.width),
        transform: getComputedStyle(el).transform,
      };
    })()`,
  );
  console.log("C. reduced motion (host)     :", JSON.stringify(reduced));
  console.log("C. reduced-motion geometry   :", JSON.stringify(geom));

  // cleanup: stop and remove only the row this probe made
  try { await invoke("job_stop", { id }); } catch { /* may have settled */ }
  try { await invoke("job_remove", { id }); } catch { /* may already be gone */ }
  slow.close();
  // this instance's private webview profile is ours to release — otherwise the
  // next run finds the profile taken and gets no debug port
  try { child.kill(); } catch { /* already gone */ }
  process.exit(0);
})().catch((e) => {
  console.error("probe failed:", e.message);
  process.exit(1);
});
