# manual e2e checklist (§10, m6 exit criterion)

run before every release tag. each scenario lists the steps and the exact
expected result. a scenario is green only when the expected result is observed
in the real app (`pnpm tauri dev` or an installed build) — never inferred from
code reading.

coverage preamble: the rust unit suites (59 tests) cover the parser, the
options→argv builder, checksum parsing, and intake normalization; the ts/vitest
layer §10 sketched was never built (note below). this checklist therefore
covers the integration surfaces units cannot reach: real yt-dlp processes,
real network, real filesystem, real ipc.

automated runner: `node scripts/e2e/run.cjs` drives these scenarios in the
real app over cdp (see `--list`). `--smoke` runs the youtube-independent
subset (S9/S10/S12/S14/S18/S19) — use it when youtube is bot-gating the
machine; a full run still requires youtube scenarios to be runnable.

## prerequisites

- managed binaries installed (first-run wizard or settings → tools), or
  staged manually per the m2 installer flow.
- a known-safe test video (the classic `jNQXAC9IVRw` probe) and a small
  public playlist are enough for most scenarios.
- for the moved-file scenario: download one file, then rename/move it in
  explorer before the reveal check.

## scenarios

| # | scenario | steps | expected result |
|---|---|---|---|
| 1 | single video | queue one video url (enter or button), default video options | job runs fetching → downloading → post → done; file exists at destination; green accent + one-shot row flash; history gains a row with title/size/duration |
| 2 | playlist | queue a playlist url with "entire playlist" | items-done/total counter appears (`3/12`), bar tracks items done, per-item skips/downloads both count |
| 3 | first-n | same playlist, "first n" with n=2 | exactly 2 items downloaded; counter shows `2/2` at the end |
| 4 | duplicate of archived item | re-queue scenario 1's url with skip-downloaded on | job ends done/skipped almost instantly — log says "already downloaded — skipping (archive)", no re-download, no duplicate history row |
| 5 | duplicate while queued | paste the same url into a second queued job before the first resolves | second job ends duplicate with the "already queued/running" note (D18/D33) |
| 6 | stopped → retry resume | stop a large download mid-flight, then retry | stop lands in stopped (not error), `.part` kept; retry resumes from partials (bytes continue, not restart) |
| 7 | moved file locate… | move a downloaded file, then click 📁 in history | reveal fails gracefully → row offers locate… → picking the new path relinks history and reveal works |
| 8 | re-download uses composer (D19) | set composer to audio/opus, then history ↻ on any video row | the queued job's argv preview/actual argv contains opus mapping — never the old video options (works from the history tab too, D52) |
| 9 | intranet / garbage url | queue `http://192.168.1.1/x` and `not a url` | garbage is rejected at intake with a per-line reason; intranet is accepted and errors at fetch with the engine's message — intake is lenient (D28) |
| 10 | soundcloud / bandcamp audio | queue one audio url from either site, audio mode | `-f ba/b` falls back cleanly on single-format sources; audio lands with correct extension |
| 11 | webm container warning | video mode + webm container | the amber warning is visible before queueing; download still works |
| 12 | age-gated / unavailable | queue a private/deleted video | job ends error with yt-dlp's reason in the row meta, expandable output, and the hover card shows the error |
| 13 | enter / shift+enter (D58) | composer: type url, press enter; then paste two lines, put cursor between them, shift+enter | enter queues and clears accepted lines; shift+enter inserts a newline without queueing |
| 14 | ctrl+v / F5 | press ctrl+v anywhere; F5 on history | ctrl+v jumps to home and focuses the composer; F5 reloads history rows |
| 15 | pause never kills (D34) | pause the queue while a job downloads | running job keeps downloading; no new jobs dispatch; resume resumes dispatch |
| 16 | restart normalization (D35) | download two jobs, kill the app mid-run, relaunch | running/post jobs are stopped, queued stay queued, nothing auto-resumes; history intact |
| 17 | app update path (post-key) | after the minisign key ships, tag v0.0.1 and launch the installed previous build | banner appears with the new version; update & restart installs and relaunches; settings version shows the new runtime version |
| 18 | re-download overwrite gate (D59) | with a downloaded file present, set composer options, history ↻ on its row: cancel the "file already exists" dialog, then repeat and accept | cancel: nothing queues, "re-download cancelled" hint shows; accept: new job with `--force-overwrites` runs clean and the file's mtime advances |
| 19 | queue-time overwrite gate (D59/D60) | paste a url whose file already exists in the destination, press queue: cancel the dialog, then repeat and accept | cancel: nothing queues, "queueing cancelled" feedback shows; accept: job queued with `--force-overwrites`, runs clean, mtime advances. a slow/unreachable url must never stall the queue click (2.5s probe cap, D60) |
| 20 | archived duplicate skips (D61/D63, no youtube) | queue a soundcloud url with skip-downloaded on, let it finish, queue it again | second queue ends done/skipped instantly ("already in downloaded archive"), the file's mtime is untouched, and no overwrite dialog fires (the D60 archive-aware branch must never ask when the engine would skip cleanly) |
| 21 | archive↔db reconciliation (D64) | history → "reconcile archive" after appending a fake `e2efake <id>` line to downloaded.txt | report shows +1 row backfilled ("source url unknown"); a second reconcile backfills nothing (idempotent); no archive line or history row is ever pruned |

## notes

- scenario 17 is only runnable once the D56 flip is done (key + secrets +
  createUpdaterArtifacts). before that, the settings row's check-now just
  reports the endpoint state — also an expected result.
- history size/duration/format columns are filled at runtime since the D45
  close-out (ffprobe at finalize + file-extension format); rows downloaded by
  older builds keep "—" until re-downloaded (in-place upsert by identity).
