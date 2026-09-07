# e2e run results (docs/E2E_CHECKLIST.md scenarios 1–16)

- run date: 2026-09-07
- driver: real app (debug build + vite dev server), driven over WebView2 remote debugging
  (real ipc, real yt-dlp processes, real network; state asserted via `invoke()` engine truth)
- managed binaries: staged yt-dlp + btbN ffmpeg (copied into the e2e sandbox bin/)
- results: 3/3 pass

| # | scenario | result | evidence |
|---|---|---|---|
| 21 | archive→history backfill + idempotence (d64) | PASS | backfilled 0 → 1 (+1), rowsWithoutUrl=1, row.url=null<br>after cleanup: rowsBackfilled=0 (per-call count; 0 = idempotent) |
| 22 | reset app data (d69): guarded wipe, bin kept, report matches disk | PASS | queue rows before: 9 (busy: 0)<br>busy-guard: n/a (queue idle)<br>report: jobs=9 history=2 settings=true archive=true customArchive=undefined<br>after: queue=0 history=0 settings.json=removed downloaded.txt=removed bin kept=true |
| 23 | archive import merge/replace (d75) | PASS | merge: imported=2 archiveAdded=2 path=app-data<br>replace: archiveAdded=2; default-mode: imported=0 added=0<br>settings.archivePath=null |

## notes

- scenario 7's native file-picker dialog is not scriptable over cdp; the relink
  was exercised through the same `history_relink` ipc the 🔍 button invokes,
  and the row-state transitions (moved? → locate… → healed → 📁) were verified in the ui.
- scenario 17 (app update path) is out of scope until the minisign key lands (D56).
