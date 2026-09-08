# e2e run results (docs/E2E_CHECKLIST.md scenarios 1–16)

- run date: 2026-09-08
- driver: real app (debug build + vite dev server), driven over WebView2 remote debugging
  (real ipc, real yt-dlp processes, real network; state asserted via `invoke()` engine truth)
- managed binaries: staged yt-dlp + btbN ffmpeg (copied into the e2e sandbox bin/)
- results: 22/22 pass

| # | scenario | result | evidence |
|---|---|---|---|
| 1 | single video end-to-end | PASS | fetching observed (title=…)<br>downloading observed<br>(post phase not observed — fast job)<br>done: finalPath=C:\Users\micha\Code\ytdlp\e2e-dl\Me at the zoo [jNQXAC9IVRw].opus, pct=100<br>row flash (data-flash=done) captured<br>file exists at finalPath: true<br>history row: youtube jNQXAC9IVRw "Me at the zoo" size=464027 dur=19<br>done row carries data-status=done (accent): true |
| 4 | archived duplicate → done/skipped | PASS | new job j1788856194-000001-000000: state=done skipped=true in 5227ms<br>error/meta: already in downloaded archive<br>log says archive-skip: true<br>history rows before/after: 1/1 (no duplicate row: true) |
| 3 | playlist first-n=2 | PASS | itemsDone=2 itemsTotal=2 skipped=false<br>bare final-path prints in output: 2<br>audio files in dl dir: 2 |
| 2 | entire playlist counter | PASS | (job too fast to sample mid-run — final counter only)<br>final: itemsDone=10 itemsTotal=10<br>per-item outputs: 10 downloaded + 0 archive-skips (items 1-2 from S3)<br>downloaded lines: 10; silent archive-skips: 0<br>audio files on disk across S3+S2: 11/10 |
| 9 | lenient intake (D28) | PASS | intake feedback: "1 queued · 0 duplicates skipped · 1 invalid✕ not a url — not a url (paste one link per line)"<br>textarea kept the accepted intranet url, dropped garbage: "http://192.168.1.1/x"<br>intranet job state=error: "ERROR: [generic] x: Unable to download webpage: (<HTTPConnection(host='192.168.1.1', port=80) at 0x1d777c052d0>, 'Connection to 192.168.1.1 timed out. (connect timeout=20.0)') (caused by TransportError(\"(<HTTPConnection(host='192.168.1.1', port=80) at 0x1d777c052d0>, 'Connection to 192.168.1.1 timed out. (connect timeout=20.0)')\"))" |
| 10 | single-format audio fallback | PASS | mirror: audio/best, skip off, playlistMode=single, overwrite off, cover off<br>done: finalPath=C:\Users\micha\Code\ytdlp\e2e-dl\Flickermood [293].m4a<br>file exists: true<br>landed extension: .m4a<br>history row: soundcloud 293 |
| 12 | unavailable video error surface | PASS | error text: "ERROR: [soundcloud] forss/this-track-does-not-exist-xyz: Unable to download JSON metadata: HTTP Error 404: Not Found (caused by <HTTPError 404: Not Found>)"<br>expanded log lines: 2<br>hover card shows error: "fetching…sourcehttps://soundcloud.com/forss/this-track-does-not-exist-xyzstatuserror — ERROR: [soundcloud] forss/this-track-does-not-exist-xyz: Unable to downlo" |
| 11 | webm warning + download | PASS | webm warning visible before queueing: true<br>done: finalPath=C:\Users\micha\Code\ytdlp\e2e-dl\Me at the zoo [jNQXAC9IVRw].webm<br>file exists: true |
| 13 | enter / shift+enter (D58) | PASS | enter queued a job: yes; textarea cleared: yes<br>shift+enter: value="line one\n"; job count before/after: 2/2 |
| 14 | ctrl+v / F5 | PASS | after ctrl+v: tabs=[{"t":"home","on":true},{"t":"history","on":false},{"t":"settings","on":false}] composerFocused=true<br>F5 on history: rows ipc before/after=1/1, rendered rows=1 |
| 8 | D19 re-download uses composer options | PASS | attempt 1: re-download landed .opus → C:\Users\micha\Code\ytdlp\e2e-dl\Me at the zoo [jNQXAC9IVRw].opus<br>file exists: true |
| 7 | moved-file locate/relink (D19/§6) | PASS | moved file on disk → Me at the zoo [moved] [jNQXAC9IVRw].opus<br>reveal 📁 clicked: ok<br>reveal failed → row shows moved? yes, locate… offered: true<br>after relink: history finalPath=C:\Users\micha\Code\ytdlp\e2e-dl\Me at the zoo [moved] [jNQXAC9IVRw].opus (matches moved file: true)<br>row back to 📁 (reveal state, db relinked to original): true |
| 5 | identity duplicate while running | PASS | video mode, 480p cap set, skip on, cookies=firefox<br>job2 ended duplicate: "duplicate — already queued/running"<br>job1 downloading (pct=undefined) |
| 6 | stop → resume (D31/D35 semantics) | PASS | mirror: video/1080p, skip off, cookies=firefox (stopped bbb row cleared)<br>state=stopped: "stopped by user — partial files kept"<br>.part files kept: Big Buck Bunny 60fps 4K - Official Blender Foundation Short Film [aqz-KE-bpKQ].f399.mp4.part (37853kb)<br>retry ↻ clicked: ok<br>.part bytes at stop=37853kb → after resume=49677kb (grew ⇒ continued, not restarted)<br>done: C:\Users\micha\Code\ytdlp\e2e-dl\Big Buck Bunny 60fps 4K - Official Blender Foundation Short Film [aqz-KE-bpKQ].mp4; .part files after: 0 |
| 15 | pause never kills (D34) | PASS | mirror: video/1080p, skip off<br>prior bbb/gangnam rows cleared + files deleted (no phantom skip)<br>bbb downloading, .part bytes flowing, witness queued<br>queue_pause → paused=true<br>while paused 8s: .part bytes 81414kb → 0kb (1 big job(s) completed untouched ⇒ processes ran straight through the pause); witness still queued=true<br>queue_resume → paused=false<br>after resume: witness left queued (→ fetching) |
| 16 | restart normalization (D35) | PASS | mirror: skip off, cookies=firefox (reload resets composer defaults)<br>killing app with 1 running job(s); history rows=1<br>running at kill: 1<br>after relaunch: =9bZkp7q19f0=stopped(app restarted)<br>history intact: 1/1<br>killed jobs stay stopped (no auto-resume): true |
| 18 | re-download overwrite gate (D59) | PASS | mirror: audio/mp3, skip off<br>initial download: Tycho - A Walk [473865125].mp3<br>cancel: dialog=resolved-ok, hint=true, jobs queued=0<br>grant: dialog=resolved-ok<br>granted job: done<br>options.overwrite=true; file_exists ipc=true; file re-downloaded (mtime advanced): true |
| 19 | queue-time overwrite gate (D59) | PASS | mirror: audio/mp3, skip off, playlistMode=single, overwrite off (s3/s18 leaks pinned)<br>initial download: Tycho - A Walk [473865125].mp3<br>cancel: dialog=resolved-ok, feedback=true, jobs queued=0<br>grant: dialog=resolved-ok<br>granted job: done<br>options.overwrite=true; file re-downloaded (mtime advanced): true |
| 20 | archived duplicate → done/skipped, no re-download, no dialog | PASS | queue done in 19589ms skipped=false (no error)<br>archive line appended: soundcloud 293<br>file present: Flickermood [293].mp3<br>re-queue: skipped=true, file untouched=true |
| 21 | archive→history backfill + idempotence (d64) | PASS | backfilled 0 → 1 (+1), rowsWithoutUrl=1, row.url=null<br>after cleanup: rowsBackfilled=0 (per-call count; 0 = idempotent) |
| 23 | archive import merge/replace (d75) | PASS | merge: imported=2 archiveAdded=2 path=app-data<br>replace: archiveAdded=2; default-mode: imported=0 added=0<br>settings.archivePath=null |
| 22 | reset app data (d69): guarded wipe, bin kept, report matches disk | PASS | queue rows before: 5 (busy: 0)<br>busy-guard: n/a (queue idle)<br>report: jobs=5 history=6 settings=true archive=true customArchive=undefined<br>after: queue=0 history=0 settings.json=removed downloaded.txt=removed bin kept=true |

## notes

- scenario 7's native file-picker dialog is not scriptable over cdp; the relink
  was exercised through the same `history_relink` ipc the 🔍 button invokes,
  and the row-state transitions (moved? → locate… → healed → 📁) were verified in the ui.
- scenario 17 (app update path) is out of scope until the minisign key lands (D56).
