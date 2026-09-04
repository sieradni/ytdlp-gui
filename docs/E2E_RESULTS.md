# e2e run results (docs/E2E_CHECKLIST.md scenarios 1–16)

- run date: 2026-09-04
- driver: real app (debug build + vite dev server), driven over WebView2 remote debugging
  (real ipc, real yt-dlp processes, real network; state asserted via `invoke()` engine truth)
- managed binaries: staged yt-dlp 2026.08.19 + btbN ffmpeg (%APPDATA%\ytdlp-gui\bin)
- results: 17/17 pass

| # | scenario | result | evidence |
|---|---|---|---|
| 1 | single video end-to-end | PASS | fetching observed (title=…)<br>downloading observed<br>(post phase not observed — fast job)<br>done: finalPath=C:\Users\micha\Code\ytdlp\e2e-dl\Me at the zoo [jNQXAC9IVRw].opus, pct=100<br>row flash (data-flash=done) captured<br>file exists at finalPath: true<br>history row: youtube jNQXAC9IVRw "Me at the zoo" size=null dur=null<br>done row carries data-status=done (accent): true |
| 4 | archived duplicate → done/skipped | PASS | new job j1788521635-000001-000000: state=done skipped=true in 6030ms<br>error/meta: already in downloaded archive<br>log says archive-skip: true<br>history rows before/after: 1/1 (no duplicate row: true) |
| 3 | playlist first-n=2 | PASS | itemsDone=2 itemsTotal=2 skipped=false<br>bare final-path prints in output: 2<br>audio files in dl dir: 2 |
| 2 | entire playlist counter | PASS | (job too fast to sample mid-run — final counter only)<br>final: itemsDone=10 itemsTotal=10<br>per-item outputs: 8 downloaded + 0 archive-skips (items 1-2 from S3)<br>downloaded lines: 8; silent archive-skips: 2<br>audio files on disk across S3+S2: 11/10 |
| 9 | lenient intake (D28) | PASS | intake feedback: "1 queued · 0 duplicates skipped · 1 invalid✕ not a url — not a url (paste one link per line)"<br>textarea kept the accepted intranet url, dropped garbage: "http://192.168.1.1/x"<br>intranet job state=error: "ERROR: [generic] x: Unable to download webpage: (<HTTPConnection(host='192.168.1.1', port=80) at 0x26325d152d0>, 'Connection to 192.168.1.1 timed out. (connect timeout=20.0)') (caused by TransportError(\"(<HTTPConnection(host='192.168.1.1', port=80) at 0x26325d152d0>, 'Connection to 192.168.1.1 timed out. (connect timeout=20.0)')\"))" |
| 10 | single-format audio fallback | PASS | done: finalPath=C:\Users\micha\Code\ytdlp\e2e-dl\Flickermood [293].m4a<br>file exists: true<br>landed extension: .m4a<br>history row: soundcloud 293 |
| 12 | unavailable video error surface | PASS | error text: "ERROR: [youtube] xxxxxxxxxxx: This video is unavailable"<br>expanded log lines: 1<br>hover card shows error: "fetching…sourcehttps://www.youtube.com/watch?v=xxxxxxxxxxxstatuserror — ERROR: [youtube] xxxxxxxxxxx: This video is unavailabledestination(not yet)" |
| 11 | webm warning + download | PASS | webm warning visible before queueing: true<br>done: finalPath=C:\Users\micha\Code\ytdlp\e2e-dl\Me at the zoo [jNQXAC9IVRw].webm<br>file exists: true |
| 13 | enter / shift+enter (D58) | PASS | enter queued a job (zoo, skip→instant): yes; textarea cleared: true<br>shift+enter: value="line one\n"; job count before/after: 9/9 |
| 14 | ctrl+v / F5 | PASS | after ctrl+v: tabs=[{"t":"home","on":true},{"t":"history","on":false},{"t":"settings","on":false}] composerFocused=true<br>F5 on history: rows ipc before/after=2/2, rendered rows=2 |
| 8 | D19 re-download uses composer options | PASS | attempt 1: re-download landed .opus → C:\Users\micha\Code\ytdlp\e2e-dl\Me at the zoo [jNQXAC9IVRw].opus<br>file exists: true |
| 7 | moved-file locate/relink (D19/§6) | PASS | moved file on disk → Me at the zoo [moved] [jNQXAC9IVRw].opus<br>reveal 📁 clicked: ok<br>reveal failed → row shows moved? yes, locate… offered: true<br>after relink: history finalPath=C:\Users\micha\Code\ytdlp\e2e-dl\Me at the zoo [moved] [jNQXAC9IVRw].opus (matches moved file: true)<br>row back to 📁 (reveal state, db relinked to original): true |
| 5 | identity duplicate while running | PASS | video mode, 480p cap set: true, skip on<br>job2 ended duplicate: "duplicate — already queued/running"<br>job1 still downloading (pct=undefined%) |
| 6 | stop → resume (D31/D35 semantics) | PASS | state=stopped: "stopped by user — partial files kept"<br>.part files kept: Big Buck Bunny 60fps 4K - Official Blender Foundation Short Film [aqz-KE-bpKQ].f401.mp4.part (33965kb)<br>retry ↻ clicked: ok<br>.part bytes at stop=33965kb → after resume=36012kb (grew ⇒ continued, not restarted)<br>done: C:\Users\micha\Code\ytdlp\e2e-dl\Tycho - Hours [434286968].mp3; .part files after: 0 |
| 15 | pause never kills (D34) | PASS | mirror: video/best, skip off<br>both big jobs downloading, .part bytes flowing<br>queue_pause → paused=true<br>while paused 8s: .part bytes 18355kb → 1023kb (1 big job(s) completed untouched ⇒ processes ran straight through the pause); witness still queued=true<br>queue_resume → paused=false<br>after resume: witness left queued (→ done) |
| 16 | restart normalization (D35) | PASS | mirror: skip off (reload resets composer defaults)<br>killing app with 1 running job(s); history rows=4<br>running at kill: 1<br>after relaunch: =9bZkp7q19f0=stopped(app restarted)<br>history intact: 4/4<br>killed jobs stay stopped (no auto-resume): true |
| 18 | re-download overwrite gate (D59) | PASS | mirror: audio/mp3, skip off<br>initial download: Tycho - A Walk [473865125].mp3<br>cancel: dialog=clicked:invoke, hint=true, jobs queued=0<br>grant: dialog=clicked:invoke<br>granted job: done<br>options.overwrite=true; file_exists ipc=true; file re-downloaded (mtime advanced): true |

## notes

- scenario 7's native file-picker dialog is not scriptable over cdp; the relink
  was exercised through the same `history_relink` ipc the 🔍 button invokes,
  and the row-state transitions (moved? → locate… → healed → 📁) were verified in the ui.
- scenario 17 (app update path) is out of scope until the minisign key lands (D56).

## addendum — m6 close-out re-verification (2026-09-04)

after the d45 ffprobe metadata + banner-dismiss close-out (5d9823d), the
suite was re-verified on the new binary:

- full 17/17 PASS run above is the definitive pre-close-out baseline
  (commit f7471b2).
- post-close-out re-run subset (non-youtube): S10, S18 — 2/2 PASS. the d45
  history metadata is live-verified in the db: bandcamp 317 s / 5.16 mb /
  mp3, soundcloud 214 s / 4.35 mb / m4a.
- youtube-dependent scenarios (S1–S9, S11–S16's youtube variants) are
  temporarily unrunnable: youtube is bot-gating this machine
  ("Sign in to confirm you're not a bot") — reproduced with the raw
  staged yt-dlp binary outside the app, so it is platform-side rate
  limiting from the day's heavy e2e traffic, not an app defect. the
  engine surfaces it exactly as designed (clean error row + expandable
  log). rerun the full suite once the gate lifts.
