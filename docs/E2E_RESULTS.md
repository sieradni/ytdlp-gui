# e2e run results (docs/E2E_CHECKLIST.md scenarios 1–16)

- run date: 2026-09-04
- driver: real app (debug build + vite dev server), driven over WebView2 remote debugging
  (real ipc, real yt-dlp processes, real network; state asserted via `invoke()` engine truth)
- managed binaries: staged yt-dlp 2026.08.19 + btbN ffmpeg (%APPDATA%\ytdlp-gui\bin)
- results: 2/2 pass

| # | scenario | result | evidence |
|---|---|---|---|
| 10 | single-format audio fallback | PASS | done: finalPath=C:\Users\micha\Code\ytdlp\e2e-dl\Flickermood [293].m4a<br>file exists: true<br>landed extension: .m4a<br>history row: soundcloud 293 |
| 18 | re-download overwrite gate (D59) | PASS | mirror: audio/mp3, skip off<br>initial download: Tycho - A Walk [473865125].mp3<br>cancel: dialog=clicked:invoke, hint=true, jobs queued=0<br>grant: dialog=clicked:invoke<br>granted job: done<br>options.overwrite=true; file_exists ipc=true; file re-downloaded (mtime advanced): true |

## notes

- scenario 7's native file-picker dialog is not scriptable over cdp; the relink
  was exercised through the same `history_relink` ipc the 🔍 button invokes,
  and the row-state transitions (moved? → locate… → healed → 📁) were verified in the ui.
- scenario 17 (app update path) is out of scope until the minisign key lands (D56).
