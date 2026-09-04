# e2e run results (docs/E2E_CHECKLIST.md scenarios 1–16)

- run date: 2026-09-04
- driver: real app (debug build + vite dev server), driven over WebView2 remote debugging
  (real ipc, real yt-dlp processes, real network; state asserted via `invoke()` engine truth)
- managed binaries: staged yt-dlp 2026.08.19 + btbN ffmpeg (%APPDATA%\ytdlp-gui\bin)
- results: 6/6 pass

| # | scenario | result | evidence |
|---|---|---|---|
| 9 | lenient intake (D28) | PASS | intake feedback: "1 queued · 0 duplicates skipped · 1 invalid✕ not a url — not a url (paste one link per line)"<br>textarea kept the accepted intranet url, dropped garbage: "http://192.168.1.1/x"<br>intranet job state=error: "ERROR: [generic] x: Unable to download webpage: (<HTTPConnection(host='192.168.1.1', port=80) at 0x21f4ac31240>, 'Connection to 192.168.1.1 timed out. (connect timeout=20.0)') (caused by TransportError(\"(<HTTPConnection(host='192.168.1.1', port=80) at 0x21f4ac31240>, 'Connection to 192.168.1.1 timed out. (connect timeout=20.0)')\"))" |
| 10 | single-format audio fallback | PASS | done: finalPath=C:\Users\micha\Code\ytdlp\e2e-dl\Flickermood [293].m4a<br>file exists: true<br>landed extension: .m4a<br>history row: soundcloud 293 |
| 12 | unavailable video error surface | PASS | error text: "ERROR: [soundcloud] forss/this-track-does-not-exist-xyz: Unable to download JSON metadata: HTTP Error 404: Not Found (caused by <HTTPError 404: Not Found>)"<br>expanded log lines: 1<br>hover card shows error: "fetching…sourcehttps://soundcloud.com/forss/this-track-does-not-exist-xyzstatuserror — ERROR: [soundcloud] forss/this-track-does-not-exist-xyz: Unable to downlo" |
| 14 | ctrl+v / F5 | PASS | after ctrl+v: tabs=[{"t":"home","on":true},{"t":"history","on":false},{"t":"settings","on":false}] composerFocused=true<br>F5 on history: rows ipc before/after=1/1, rendered rows=1 |
| 18 | re-download overwrite gate (D59) | PASS | mirror: audio/mp3, skip off<br>initial download: Tycho - A Walk [473865125].mp3<br>cancel: dialog=clicked:invoke, hint=true, jobs queued=0<br>grant: dialog=clicked:invoke<br>granted job: done<br>options.overwrite=true; file_exists ipc=true; file re-downloaded (mtime advanced): true |
| 19 | queue-time overwrite gate (D59) | PASS | mirror: audio/mp3, skip off<br>initial download: Tycho - A Walk [473865125].mp3<br>cancel: dialog=clicked:invoke, feedback=true, jobs queued=0<br>grant: dialog=clicked:invoke<br>granted job: done<br>options.overwrite=true; file re-downloaded (mtime advanced): true |

## notes

- scenario 7's native file-picker dialog is not scriptable over cdp; the relink
  was exercised through the same `history_relink` ipc the 🔍 button invokes,
  and the row-state transitions (moved? → locate… → healed → 📁) were verified in the ui.
- scenario 17 (app update path) is out of scope until the minisign key lands (D56).


---

## addendum — upgrades round (2026-09-04, later)

youtube is bot-gating this machine (transient, confirmed via manual
yt-dlp outside the app), so the youtube-tagged scenarios could not run
this round. instead the suite's new `--smoke` mode (all
youtube-independent scenarios) ran green, and two new gate scenarios
were added and verified through the real native rfd dialog:

| # | scenario | result | evidence |
|---|---|---|---|
| 18 | re-download overwrite gate (D59) | PASS | cancel: dialog=clicked:invoke, hint=true, jobs queued=0; grant: job done, options.overwrite=true (db), mtime advanced |
| 19 | queue-time overwrite gate (D59/D60) | PASS | cancel: dialog=clicked:invoke, "queueing cancelled" feedback, jobs queued=0; grant: job done, options.overwrite=true, mtime advanced |

smoke subset S9/S10/S12/S14 also green this round (S9 after the D60 fix:
the queue-time gate stalled the queue click ~20s on the unreachable
intranet url — now raced with a 2.5s cap; the D28 feedback/textarea
assertions had to poll, a pre-gate single-shot read was stale by design).

**release-pipeline proof (upgrade 4):** tag v2.0.0-alpha.2 — release run
#1 failed at the pnpm 11 strictDepBuilds gate (allowBuilds migration +
CI pnpm pin, reproduced locally), re-tag run passed in 9m39s with the
NSIS installer attached and prerelease keeping `releases/latest` clean.
