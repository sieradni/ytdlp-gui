# changelog

user-visible changes per release. releases are tagged `v2.0.0-alpha.N` until GA;
older tags predate this file and carry no entry (see the release assets).

## v2.0.0-alpha.15 — 2026-10-21

playlist track list polish (no behaviour change)

- **the per-track delete is always visible.** it used to sit at the same 35%
  opacity this app uses for a *disabled* action (history's unreachable ↻), so
  it read as unavailable until you happened to hover the row.
- **track rows respond like every other row**: hover highlight, and selected
  tracks keep a tint so a multi-selection is legible at a glance. an icon
  action that is briefly unavailable (during a delete) now dims like a
  disabled button instead of still lighting up.
- **an emptied playlist keeps its track list** with "tracks (0 downloaded)" and
  "no tracks left — a retry downloads them again", instead of collapsing to a
  bare log and a `0/10` row with no explanation.
- **the `n/total` count survives a narrow window.** below 760px the queue table
  was hiding its progress column (where a playlist's count lives) and keeping a
  lone, empty `eta`; it now drops speed/eta as intended, and the history table
  keeps its own columns.

## v2.0.0-alpha.14 — 2026-10-21

### playlists clean up after themselves

- **cancelling a running playlist removes the unfinished track.** ■ now deletes
  the interrupted track's artifacts (`.part`, `.ytdl`, merged-but-unconverted
  container, sidecars) from the destination instead of leaving them behind.
  finished tracks keep their files.
- **the row stops lying about progress.** a cancelled playlist reads `n/total`
  (e.g. `3/10`) instead of a stray byte percentage from the track that never
  completed, and the message says what happened
  ("cancelled — unfinished track removed · 3 kept").
- **delete finished tracks, one at a time or in bulk.** expand a playlist row,
  tick tracks and press "delete selected", or use the ✕ on a single track: the
  file leaves disk, its archive entry goes with it (so a retry downloads it
  again) and the row's counters follow. gated by the app's confirm dialog, and
  refused while the job is still running.
- **a queued job can be cancelled.** ■ used to answer "job is not running" and
  leave the row queued; it now cancels in place and frees the url for
  re-queueing. the button names what it does per state.
- single-video cancels still keep their `.part`, so retry resumes where it
  stopped (unchanged behaviour).
