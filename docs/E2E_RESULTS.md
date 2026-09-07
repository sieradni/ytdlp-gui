# e2e run results (docs/E2E_CHECKLIST.md scenarios 1–16)

- run date: 2026-09-07
- driver: real app (debug build + vite dev server), driven over WebView2 remote debugging
  (real ipc, real yt-dlp processes, real network; state asserted via `invoke()` engine truth)
- managed binaries: staged yt-dlp + btbN ffmpeg (copied into the e2e sandbox bin/)
- results: 10/10 pass

| # | scenario | result | evidence |
|---|---|---|---|
| 9 | lenient intake (D28) | PASS | intake feedback: "1 queued · 0 duplicates skipped · 1 invalid✕ not a url — not a url (paste one link per line)"<br>textarea kept the accepted intranet url, dropped garbage: "http://192.168.1.1/x"<br>intranet job state=error: "ERROR: [generic] x: Unable to download webpage: (<HTTPConnection(host='192.168.1.1', port=80) at 0x1130cce52d0>, 'Connection to 192.168.1.1 timed out. (connect timeout=20.0)') (caused by TransportError(\"(<HTTPConnection(host='192.168.1.1', port=80) at 0x1130cce52d0>, 'Connection to 192.168.1.1 timed out. (connect timeout=20.0)')\"))" |
| 10 | single-format audio fallback | PASS | done: finalPath=C:\Users\micha\Code\ytdlp\e2e-dl\Flickermood [293].m4a<br>file exists: true<br>landed extension: .m4a<br>history row: soundcloud 293 |
| 12 | unavailable video error surface | PASS | error text: "ERROR: [soundcloud] forss/this-track-does-not-exist-xyz: Unable to download JSON metadata: HTTP Error 404: Not Found (caused by <HTTPError 404: Not Found>)"<br>expanded log lines: 2<br>hover card shows error: "fetching…sourcehttps://soundcloud.com/forss/this-track-does-not-exist-xyzstatuserror — ERROR: [soundcloud] forss/this-track-does-not-exist-xyz: Unable to downlo" |
| 14 | ctrl+v / F5 | PASS | after ctrl+v: tabs=[{"t":"home","on":true},{"t":"history","on":false},{"t":"settings","on":false}] composerFocused=true<br>F5 on history: rows ipc before/after=4/4, rendered rows=4 |
| 18 | re-download overwrite gate (D59) | PASS | mirror: audio/mp3, skip off<br>initial download: Tycho - A Walk [473865125].mp3<br>cancel: dialog=resolved-ok, hint=true, jobs queued=0<br>grant: dialog=resolved-ok<br>granted job: done<br>options.overwrite=true; file_exists ipc=true; file re-downloaded (mtime advanced): true |
| 19 | queue-time overwrite gate (D59) | PASS | mirror: audio/mp3, skip off<br>initial download: Tycho - A Walk [473865125].mp3<br>cancel: dialog=resolved-ok, feedback=true, jobs queued=0<br>grant: dialog=resolved-ok<br>granted job: done<br>options.overwrite=true; file re-downloaded (mtime advanced): true |
| 20 | archived duplicate → done/skipped, no re-download, no dialog | PASS | queue done in 3393ms skipped=true (already in downloaded archive) |
| 21 | archive→history backfill + idempotence (d64) | PASS | backfilled 0 → 1 (+1), rowsWithoutUrl=4, row.url=null<br>after cleanup: rowsBackfilled=0 (per-call count; 0 = idempotent) |
| 22 | reset app data (d69): guarded wipe, bin kept, report matches disk | PASS | queue rows before: 7 (busy: 0)<br>busy-guard: n/a (queue idle)<br>report: jobs=7 history=6 settings=true archive=true customArchive=undefined<br>after: queue=0 history=0 settings.json=removed downloaded.txt=removed bin kept=true |
| 23 | archive import merge/replace (d75) | PASS | merge: imported=2 archiveAdded=2 path=app-data<br>replace: archiveAdded=2; default-mode: imported=0 added=0<br>settings.archivePath=null |

## notes

- scenario 7's native file-picker dialog is not scriptable over cdp; the relink
  was exercised through the same `history_relink` ipc the 🔍 button invokes,
  and the row-state transitions (moved? → locate… → healed → 📁) were verified in the ui.
- scenario 17 (app update path) is out of scope until the minisign key lands (D56).
