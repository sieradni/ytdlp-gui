# ytdlp-gui v2 — Design Document

Status: **Implementation spec** — UI direction approved (mockup M0.5). No app code written yet.
Scope: full rewrite of `gui.py` (Tkinter v1) as a modern Windows desktop app.
v1 stays untouched and working until v2 reaches feature parity.

---

## 0. Decision Log (complete — nothing left open)

All decisions below are **final** unless explicitly marked otherwise. If any conflict
with earlier text in this document, this log wins.

| # | Decision | Choice | Reasoning |
|---|----------|--------|-----------|
| D1 | App name / id | `ytdlp-gui`, product id `com.ytdlp-gui.app` | Same as repo name |
| D2 | Budget | $0 | Free sources only: GitHub Releases, BtbN, GitHub-Actions CI |
| D3 | Signing | Unsigned NSIS for now | SmartScreen "unknown publisher" accepted; revisit post-GA |
| D4 | FFmpeg source | BtbN win64-gpl, gyan.dev fallback | Both free, reliable |
| D5 | Package manager | pnpm | — |
| D6 | Stack | Tauri 2 + React 18 + TS + Vite, Tailwind + shadcn/ui, Zustand + TanStack Query | Small installer, native WebView2, typed IPC |
| D7 | Theming | **Dark-only.** No theme switcher | User decision |
| D8 | Logo | None | User decision |
| D9 | Tray icon / minimize-to-tray | **Cut** | User decision |
| D10 | Clipboard watching | **Cut** | User decision |
| D11 | Pop-up input | None in primary flow; composer is inline | User decision |
| D12 | Navigation | **Top tabs** (home / history / settings) — no sidebar | User decision; fixes vertical-scroll bug |
| D13 | Font | **Cascadia Mono everywhere**, incl. body/labels/buttons. Fallbacks: JetBrains Mono, Consolas | Terminal-heritage identity |
| D14 | Case | **All-lowercase** UI copy | User decision |
| D15 | Accent | **Amber** `#e8a33d`; green only for success; red only for errors/destructive. No blue | User decision (rejected blue graphite v1 mockup) |
| D16 | Presets | **Cut** from v2.0. "Migrated v1" maps old config keys onto composer initial values | User decision |
| D17 | Archive role | Source of truth for skip logic, stays plain `downloaded.txt`; SQLite = metadata only | Cross-compat with yt-dlp CLI & v1; §5.3 |
| D18 | Dedupe identity | yt-dlp's `extractor id` pair, **never** the URL string | Same video = many urls; §5.2 |
| D19 | History re-download | Always uses **current** composer settings + destination, never stored path | One mental model; immune to manual moves |
| D20 | FFmpeg updates | Manual only (check + user-initiated update), same flow as yt-dlp but never automatic | 90 MB surprise downloads are hostile |
| D21 | Queue table columns | No status/format columns. Status = accent bar; format in hover details card; sort menu preserves sorting by hidden columns | De-clutter |
| D22 | Queue sizing | Fixed-height container (~400px), internal vertical scroll, table never overflows horizontally: `table-layout: fixed`, ellipsized titles, progressive column hiding | User decisions |
| D23 | Scrollbars | Custom slim (2px thumb, amber on hover) on all scroll containers | User decision |
| D24 | Settings | **Autosave** on change; no save button; inline "saved ✓" flash | User decision |
| D25 | Versions in tab bar | Removed; versions live only in Settings → tools. Tab bar right = engine status only | User decision |
| D26 | Page headers | None on history/settings; search lives in history card header with explicit button | User decision |
| D27 | Copy cleanups | Label vs hint distinction (labels near-white, weight 600). Removed: "any selection other than…" sentence, "audio default: square png cover" hint. Renamed: "already downloaded" → **"skip downloaded"**, hint "(shared with yt-dlp cli & v1)" → "(downloaded archive)" | User decisions |
| D28 | Composer input validation | **Lenient at queue-time** (§5.2); strict identity checks only at metadata-resolve time | Avoids rejecting valid non-standard hosts |
| D29 | Buttons/actions | Larger glyph buttons (14px), sticky-right in both tables, never clipped or covering fields | User decisions |
| D30 | Update architecture | App updates via Tauri updater (unsigned ok); tool updates via app-managed download/verify/atomic-swap; `yt-dlp -U` **not** used for managed copies | §4 |
| D31 | Stopped vs Error | Distinct states. Stop keeps `.part` files | §6 lifecycle |
| D32 | v1 repo handling | `gui.py` untouched during migration; remove at v2 GA | — |
| D33 | Playlist execution | Batch = one job per URL at queue time. A playlist URL under "entire playlist" or "first n" = one job whose yt-dlp invocation naturally downloads all its items (progress = items done / total). A single job never spans multiple URLs. | Predictable progress, per-item stop/retry scope |
| D34 | Queue pause semantics | Pause = dispatcher stops starting new items; running yt-dlp processes are **not** killed. Resume restarts dispatch. Row-level ■ is the only way to interrupt a running item. | "Pause" that kills in-flight work surprises users; matches download-manager convention |
| D35 | App-restart behavior | On launch: running/post jobs → `Stopped`; queued stay queued. The app does **not** auto-resume anything. | After an update/reboot, silent background downloading is hostile |
| D36 | Filename collisions | Rely on yt-dlp defaults (`--no-overwrites`-style behavior + auto ` (1)` suffixing); surfaced in hover card when it happens. No custom collision UI in v2.0. | yt-dlp already solves this; custom schemes add scope |
| D37 | Simultaneous add dedupe | In-flight `Fetching` items also participate: while resolution is pending, a second identical URL joins/batches with it rather than resolving twice. `metadataResolve` memoized per URL. | Duplicate adds can arrive before first resolve finishes |
| D38 | Cookies UX | Cookie source = dropdown per advanced panel: none / from browser (list) / cookies.txt file picker. Never persisted (existing rule). | "Cookies" alone was too vague to implement |
| D39 | Subtitles/SponsorBlock fields | Subtitles: language multi-entry (default none) + "auto captions" toggle (`--write-auto-subs`). SponsorBlock: categories multi-select, default off (`--sponsorblock-remove` only when set). | Implementable without guessing |
| D40 | yt-dlp/FFmpeg version pinning | Managed installs track **latest** release. Only pin: user-picked custom binaries. No version chooser for managed tools in v2.0. | Pinning managed versions is scope without a user |
| D41 | Playlists + skip-downloaded | Archive skipping applies **inside** playlist jobs too (yt-dlp native `--download-archive` behavior) — a half-downloaded playlist resumes, skipping completed items. Consistent with the archive write rule. | Major playlist use case; already how yt-dlp works |
| D42 | Manifest layout | `manifest.json` (§4) also stores `pinned` flag, `lastChecked` timestamp, and `etag`. Written only via the manager (atomic). | Single owner for binary state |
| D43 | Archive import semantics | "import v1…" never moves the user's file: default = point settings at its existing path (read/write in place); optional copy into app-data. Ids seeded into history DB either way. | Silently relocating a user's hand-maintained archive is hostile |
| D44 | `-J` fetch policy | **No interactive format picker.** No `--dump-single-json` at queue time; per-item identity = `--print id` only. Rich metadata (title, etc.) parsed from download output; sizes shown only after yt-dlp reports them. | M0's picker was cut with presets (D16); fewer pre-flight fetches |
| D45 | Metadata & formats | Everything D44 forgoes is recovered at runtime, not pre-flight: titles/formats parsed from yt-dlp's own output (`--print` / progress lines); hover card shows exactly what the engine knows at that moment. A later format listing is an additive `-J` on demand, never required for queueing. Implemented (m6 close-out): history's size/duration come from a 5s-capped ffprobe of the finished file at finalize (the app already manages `ffprobe.exe` beside ffmpeg; no network); format is the file's own extension — ffprobe's `format_name` is a muxer registry ("mov,mp4,m4a,…"), not what the user got. Failures degrade to "—" exactly as before. | Consistency with D44 without losing information |
| D46 | Rolling sources (btbN) | BtbN's `latest` is a rolling release (tag literally "latest", assets re-uploaded daily), so tag comparison can never signal change; the **release etag is the change signal** for rolling sources. gyan assets are matched by `-essentials_build.zip` suffix (names embed the version tag). Never compare a tool tag against the installed version string in UI. | Verified live against the GitHub API (2026-09) |
| D47 | check/update semantics | `check` = one conditional api call; 304 is a healthy "nothing newer" result (never surfaced as an error) and only bumps lastChecked. A recording check stores the etag, so **`update` never replays the etag** — an explicit click reinstalls unconditionally. When staged (locked exe), version records the release tag (detect_version would read the old binary); next launch's post-swap status picks up the real `--version`. | check→update 304 bug found in M2 review |
| D48 | ffmpeg discovery by the engine | Every downloading job passes `--ffmpeg-location <bin-dir>` when the managed ffmpeg exists. Verified live (2026-09): yt-dlp already searches its **own directory** for ffmpeg, so the default layout (ffmpeg.exe adjacent to yt-dlp.exe) works without the flag — but a **custom yt-dlp path** (D40) pointing at a copy without its own ffmpeg would fail all post-processing. The flag closes that hole and is harmless otherwise. | M3 review + live E2E |
| D49 | "move to…" cut from v2.0 | The after-download move UI was never functional (options existed in the type but `build_argv` consumed neither field). Rather than ship a dead control, **cut it**: downloads always stay in the destination, and history's 📁/locate… covers relocation afterward. Revisit as a real post-download move if a user asks. | M3 review: dead code beats fake feature |
| D50 | Stop must kill the process **tree** | On Windows, `kill()` on yt-dlp alone leaves spawned ffmpeg/ffprobe alive holding the stdout/stderr pipes — the job never observes stream close and hangs in `downloading` forever. Stop uses `taskkill /T /F` (tree kill) with a plain kill fallback. | Found in M3 review |
| D51 | Job ids are globally unique | `j<unix>-<seq>` collided across batches added within the same second; the second batch's inserts failed while their urls stayed marked in the in-memory set — un-retryable "ghost duplicates". Ids are now `j<unix>-<batch>-<seq>`. | Found in M3 review |
| D52 | Re-download reads the live composer | D19's "current composer settings" is implemented literally: history's ↻ queues with the composer's current option state (module-level mirror) and lets `job_add` apply the stored destination; if home was never opened it falls back to defaults + stored destination. | M3 review: previous code always used defaults, violating D19 |
| D53 | Within-playlist archive pre-check | The pre-resolution archive check only applies to single-video jobs. For playlist urls it is skipped — playlist expansion and per-item archive skipping are delegated to yt-dlp via the always-passed `--download-archive` (D41). Pre-checking a playlist id against the archive is meaningless (the playlist is never itself an archive entry). | M3 review |
| D54 | Playlist progress counting | Playlist jobs show `items done / total` (D33). Verified live (2026-09): `total` comes from yt-dlp's `[download] Downloading item N of M` line; **item completions are counted from `--print after_move:filepath` output (one print per downloaded item)** — yt-dlp emits no per-item start line for downloads — plus `[download] <id>: … has already been recorded in the archive` skip lines (processed = downloaded + skipped). Counts dedupe through a per-run set of ids and flush to the db at completion so the throttled writes can't lose the last item. The queue bar tracks items-done on playlist jobs; the current-item byte percent is secondary. Playlist identity resolves to the **playlist's own id** (`%(playlist_id)s`, live-verified — `%(id)s` on a playlist emits the first entry's id, which would poison dedupe/history/archive); the pre-resolution archive check stays single-video-only (D53), playlist jobs skip the engine archive-append, and the resolve-probe title (playlist title / video title) surfaces at fetch time. | M4 + live fixes in M4 review |
| D55 | Migration is one-shot | The v1 migration runs once, gated by a `migrated_from_v1` settings flag. Re-running it on every launch would clobber post-migration v2 settings changes with stale v1 values. The discovered v1 binaries are **offered** (wizard offer, D40) — never auto-adopted; the archive import is in-place (D43) and history seeding is idempotent, so it is safe to leave the v1 files where they are. The flag must round-trip through the frontend settings type too — a save that drops the field would re-trigger the migration on next launch. | M4 implementation + M4 review |
| D56 | Updater config is release-time | The plugin only parses the minisign pubkey inside `verify_signature` during an actual install (verified in tauri-plugin-updater source, 2026-09) — a placeholder key therefore cannot break startup or update **checks**; it would only make every future **install** fail signature decode, surfaced as the settings row's error hint (D57). RESOLVED (M7 close-out): the real minisign keypair now exists (private key + password live in `~/.tauri/` on the operator machine, encrypted), the **base64 public key** is pinned in `tauri.conf.json`, `createUpdaterArtifacts` is `true`, and the `TAURI_SIGNING_PRIVATE_KEY` secret holds the **raw key text** — not base64 (the bundler decodes base64 itself; a base64'd key fails with "Missing encoded key in secret key" — caught in a live signing round-trip before any tag could fail). Sign-verify pairing proven locally via key-ID match before any tag. | M5 implementation → M7 close-out |
| D57 | Auto-check is fire-and-forget | The app polls the updater on launch (4 s delay) + every 6 h and on the settings "check now" button; every failure (offline, endpoint 404 in dev) degrades to the settings row's error hint — never a modal, never a crash (D30: the updater is a convenience, not a dependency). Install is always user-initiated: banner or settings button → download with visible progress → `relaunch()`. | M5 implementation |
| D58 | Enter queues, shift+enter newlines | §6's "enter queues" is implemented only in the composer's url textarea: enter submits, shift+enter inserts a newline (the composer is multiline; a global enter-to-queue would fight text inputs everywhere). IME compositions (`isComposing`) and an empty composer are no-ops. Acceptance feedback reuses the existing queued/duplicates/invalid summary. | M6 implementation |
| D59 | Re-download over an existing file is gated | A re-download onto an existing target is a silent-corruption trap, not a convenience: yt-dlp skips the download AND the postprocessors when the file exists, then the engine's always-on `--embed-metadata` still runs its pass over the cover-tagged file — which fails for opus (e2e live-reproduced: "Postprocessing: Conversion failed!", 0-byte `.temp.opus`). So `job_add` gained `overwrite` (→ `--force-overwrites`) and the History ↻ handler probes the row's last known file server-side (`file_exists`): present → a native warning dialog ("overwrite"/"cancel"; cancel lands as a hint per D57, not a modal error) gates the queue; absent → re-download proceeds silently. The probe is exact-path, so a different composer format (different resolved target) never over-asks. Scenario S18 verifies both branches in the real app by clicking the app-owned confirm modal (D70). The gate cannot cover a *fresh* queue onto an existing unlinked file, so the engine also rewrites that one error signature (skip line + "Conversion failed!") into the actionable instruction instead of surfacing the cryptic postprocessor message. | M6 implementation |

| D60 | The overwrite gate never stalls the queue, and never blocks the engine | The queue-time gate (composer) probes identity at click time; a slow or unreachable url would stall the click for yt-dlp's full connect timeout (~20s) with zero feedback (e2e-reproduced: the D28 lenient-intake scenario's intranet url). So the probe is raced with a 2.5s cap — unresolvable-in-time = queue unguarded, and the engine reports the real error per D28. The gate is also archive-aware: a single url already in the download archive with skip-downloaded on will be skipped instantly by the engine anyway, so no dialog fires. Playlists are excluded (archive already dedupes them); probe failure degrades to unguarded. | M6 upgrades |
| D61 | Fetch is observable and bounded | Identity resolution (the `fetching` state) previously had no timeout: an unreachable host hung on yt-dlp's own connect timeout with the row showing nothing ("stuck on fetching forever"). Now the probe runs under a 90 s watchdog that stop-honors (a stop during fetch kills the probe child immediately via the tree-kill path), stderr streams live into the row's expando while the probe runs (bot-gates become visible within seconds), and the row shows a `resolving… Ns` ticker. The frontend also patches job events monotonically — a late `fetching` event can no longer downgrade a visible `done` row (the "green 100% while fetching" lie). | M7 phase A |
| D62 | Done means evidence | A job must never finalize `done` without a recorded final path. `after_move:filepath` output that failed the parser's path heuristic silently dropped `final_path`, and without a path the ffprobe metadata pass never ran — the app reported success with no location and no metadata (live-reproduced from the alpha install). The engine now falls back to a destination glob for `* [<id>].*` files at finalization; if the path is still unrecoverable the job's log says so explicitly. | M7 phase A |
| D63 | ↻ (re-download) forces, archive stays the default | The engine's archive pre-check short-circuits before `--force-overwrites` could ever matter, so history's re-download was a silent no-op for archived items. ↻ now queues per-job with `skip_downloaded: false` + `overwrite: true` — an explicit "force re-download" — while composer queues keep archive semantics. | M7 phase A |
| D64 | Archive↔history reconciliation is visible, never silent | Items in the archive but not the db (imports, manual edits, pre-v2 downloads) are backfilled into history by `archive_reconcile` (idempotent; url-less rows render "source url unknown"). Items in the db but not the archive self-heal: the engine re-appends on the next successful download. No row or archive line is ever pruned automatically. | M7 phase A |
| D65 | Update truth per tool | The perpetual "update available" badge came from comparing a gyan-sourced installed etag against btbN's next check (etags are per-source; cross-source comparison is always "different"). Etag recording is now per-source, and rolling builds display their parsed nightly tag (`N-126404-g…` → "nightly N-126404") instead of a raw hash string. The staged-swap state (exe locked on Windows: new binary waiting for restart) is a first-class visible step in the tools row rather than a silent "same version". | M7 phase A |
| D66 | The install folder picker is the modern one | The NSIS stock directory page's browse button opens the pre-XP `SHBrowseForFolder` tree, which made browsing to a folder genuinely hard. The shipped custom template opens the Vista `IFileDialog` (`FOS_PICKFOLDERS`) directly when the directory page appears (cancel falls through to the stock page; passive/silent flows skip the dialog entirely). Template is a vendored copy of the pinned tauri-cli 2.11.4 NSIS template — re-derive from the exact CLI version when bumping. | M7 phase B |
| D67 | Upgrade-over-existing is the upgrade path | Installing a new build over an existing one upgrades in place (same per-user install dir, NSIS reinstall page offers uninstall-then-install), and never touches the app profile: settings, history, archive and managed binaries all survive. Version lives in all three manifests and moves together. | M7 phase B |
| D68 | Uninstall asks about data exactly once, and defaults to keeping it | The uninstaller gains a page after the confirm step: keep app data (recommended default) or also remove it — history, downloaded.txt, managed yt-dlp/ffmpeg ~150 mb. Downloads folders are never touched. Silent uninstalls keep data; `/S /REMOVEDATA` opts out explicitly. Passive and update-mode uninstalls never prompt (the in-app updater restarts without questions). | M7 phase B |
| D69 | Dev data can never reach a user's profile | Debug builds, tests and the e2e suite resolve app data to `ytdlp-gui-dev` / the runner's `YTDLP_GUI_DATA_DIR` sandbox, so the alpha.2 campaign contamination (e2e rows visible in an installed app) is structurally impossible. Settings gets an explicit, double-confirmed "reset app data" (bin/ always survives; a custom archive path is never deleted). Profiles contaminated before alpha.3 get a one-time, click-gated cleanup banner on the history page. | M7 phase B |
| D70 | No OS-owned dialogs in the app's UX | Every confirmation is the app-owned modal (in-app, token-styled, amber warning accents, two-note WebAudio chime, Escape/backdrop-cancel, focus on the safe button, reduced-motion silent) — replacing the D59-era native rfd task dialog, which was off-brand, unthemed, and automatable only by fragile PowerShell UIA. Drivers resolve from page-side ground truth (`window.__cdlg`, id-scoped and durable after resolution — the slot must never be cleared before a driver can read it) plus a capped lifecycle log (`window.__cdlgLog`); S18/S19 click the modal directly. | M7 phase B |
| D71 | Content is selectable, chrome is not | `user-select: none` on body was inverted: text is selectable by default everywhere content shows (titles, urls, paths, versions, logs, command preview, hovercards) and only interactive chrome opts out (buttons, tabs, row actions, column headers, labels). A path double-clicked in the hovercard copies it. Matches the app's "data is yours" stance. | M7 phase C |
| D72 | Numbers never reflow; the preview is tiered truth | Numeric cells render in tabular-nums fixed-width contexts and the tool rows are name / version+actions / message (the version cell never reflows when a badge appears — the "number on both sides" bug). The command preview classifies the real argv into two tiers — user-chosen flags (amber, always visible) vs engine plumbing (dim, collapsed behind "show engine details"), values green, destructive red — walked from the actual argv so it can never drift from what runs. The hovercard is a real interaction surface: it stays while the pointer is on it, hides after a 300 ms grace, and carries reveal/copy actions. | M7 phase C |
| D73 | Cookie-decryption failures name the actual fix | A browser-cookie run that dies with a decryption error (chrome ≥127 app-bound encryption; live-verbatim message pinned by test: "Failed to decrypt with DPAPI") is rewritten at both error surfaces (identity probe and run phase) to state the cause and the working alternatives: firefox or edge as the cookie source, or an exported cookies.txt. The original error text is preserved verbatim as the prefix — never replaced — so the log stays greppable. Closes the m7-plan promise from the original symptom list. | M7 close-out |
| D74 | The installer asks only questions that have real answers | Found by the alpha.4 upgrade walkthrough: (1) the stock "recommended to uninstall" reinstall page framed a normal upgrade as a warning and offered a bare "Do not uninstall" with no upside — the installer now auto-replaces older versions in place without showing that page at all (it remains for same-version repair and downgrades, which are real choices), with rewritten strings that name both options honestly; (2) the directory picker (which pre-opened a blank NSIS page before the Vista IFileDialog) no longer appears on upgrades — an upgrade installs where the old version lives, and only fresh installs pick a location; (3) the uninstaller's stock "Delete the application data" checkbox was removed — the custom data page is the single place that decision is made, and its radios now explain *why* each choice exists (keep = reattach on next install, nothing re-downloaded; remove = deliberate full reset, tools re-download). App-data location is fixed at %APPDATA%\ytdlp-gui regardless of program dir. | alpha.4 user feedback |
| D75 | The app owns its archive; the user imports and exports | The settings-configured archive path is retired: the engine, reconcile, and reset all use exactly one archive at app-data\downloaded.txt, and the app never points at (or modifies) a user file again — the old import made "open archive" open the picked foreign file and put the live archive outside the app's data dir. Import copies: merge (union, default) or replace (archive takes the imported contents; history rows are never deleted), chosen in an in-app two-option dialog. Export writes a copy to a chosen path. Legacy custom paths are one-time union-merged into the app archive at startup and the setting cleared. Reconcile stays as "sync history from archive" for hand edits. Import/backfill are transactional (a 2k-entry import took ~10 s of per-row fsyncs; now milliseconds). | alpha.5 user feedback |
| D76 | History is bounded like the queue | The table scrolls in a fixed-height container with a sticky header; the action bar lives outside the scroll region, so footer buttons are reachable on a 2k-entry history instead of an unbounded page pushing them off-screen. | alpha.5 user feedback |
| D77 | Settings tells the truth at human granularity | The app card is label/value rows (the old form grid dropped a hint div into the label column). ffmpeg's manifest version is re-normalized at read time — legacy raw strings like `N-126404-g818e5d965b-20260904` display as `nightly 2026-09-04` (pinned by test on the live-verbatim string); btbN's literal tag "latest" renders as "rolling release (btbn)" instead of `latest: latest`. The update hint speaks user language ("manual, downloads and installs in-app, nothing runs on its own") — sha-256/atomic-swap mechanics are implementation, not affordance. | alpha.5 user feedback |
| D78 | Destination precedence is stated where it is used | One rule — per-job (home) → setting → Windows Downloads — appears as the effective-default placeholder in the composer (home shows its fallback) and as the settings hint; the composer placeholder names the fallback instead of leaving the field silently empty. "Playlists expand" is reworded to "playlist urls fetch multiple items". | alpha.5 user feedback |
| D79 | Scroll affordances are grabbable; nothing ends flush | Scrollbars: 11 px, higher-contrast thumb, amber hover (8 px was too thin to press). The page pane gets a hairline top border so it reads as a deliberate scroll region, and pages keep 44 px bottom padding so the last card never looks cut off. | alpha.5 user feedback |
| D80 | Global shortcuts yield to text fields | The global ctrl+v→composer shortcut ignores keystrokes whose target is an input/textarea/contenteditable — pasting into history search (or any field) pastes; the shortcut still fires everywhere else. | alpha.5 user feedback |
| D81 | Every shown value answers a real question; nothing shown that doesn't | Alpha.5 feedback round: (1) the ffmpeg "latest" line shows the checked release's **publish date** (`latest: nightly 2026-09-05`) — btbN's tag is literally "latest", which identifies nothing; the date is stored in the manifest at check time. (2) The "checking and updating are manual…" sentence is gone — the behavior is discoverable, the disclaimer was noise. (3) The archive row is a **reveal** button showing the real path, not prose about import/export. (4) The output-folder field is **never empty**: it shows the effective destination (setting, or the windows-downloads fallback — the same `resolve_destination` the engine uses, so the ui cannot disagree with reality), with a full explorer browse button. (5) Update checks happen **on launch only** — the 6 h interval was removed (a download manager needs no background poller; "check now" is right there). (6) License is Apache-2.0 (`LICENSE` + manifest metadata). (7) Jargon trimmed: "playlist urls fetch multiple items" and "order of flags doesn't matter" removed — the ui shows what things are, not defenses of them. | alpha.6 user feedback |
| D82 | Wheel scrolling glides | Native windows wheel scrolling jumps ~100 px per notch with no glide — position is illegible in long lists. Wheel deltas accumulate into a scroll target eased at 16%/frame (~0.4 s per notch; EASE is the tuning knob, 0.10 floaty ↔ 0.20 snappy, settled by live A/B demo). Nested containers chain at their edges (inner list hands off to the page pane); ctrl+wheel zoom, scrollbar drags, keyboard, and page-mode deltas stay native. Deliberately NOT gated on prefers-reduced-motion: the demo machine reports reduce (windows animation effects off) and that same flag silently muted the dialog chime — an os flag must not disable a core interaction feel; decorative fades and the chime keep honoring it. | alpha.7 user feedback |
| D83 | Child-process lines are byte-safe; queue clicks are instant | Two live-reported defects, one root cause each. (1) **“could not resolve identity (no output from yt-dlp)”**: yt-dlp on windows writes stderr in the console codepage — the bot-gate ERROR carries a cp1252 apostrophe (0x92 in “you're”), which is invalid utf-8. `AsyncBufReadExt::lines()` silently DROPS such lines (iteration just ends), so every ERROR diagnosis was unreachable and the probe reported “no output”. The line pump is now byte-level with `String::from_utf8_lossy` per line (U+FFFD for the bad byte, line and its actionable tail preserved) — pinned by a test that pumps the verbatim captured bot-gate bytes through a real pipe. (2) **“queueing takes a while to clear the input”**: the d60 overwrite gate probed single-video urls inline on the queue click (a full yt-dlp round-trip on memo-cold urls, capped at 2.5 s). The probe is now pre-warmed 500 ms after typing stops (memoized, so the click-time call resolves in ~0 ms) and the click's own race cap drops to 1.2 s — a cold gate can hold a click for about a second at most, and the engine still reports the truth per D28 when it races out. | alpha.7 user feedback |
| D84 | Tooltips you must mean; error guidance leads; cookies actually apply | Three alpha.8 findings. (1) **Hover card** fired at 350 ms anywhere on the row — drive-by pointer crossings popped it. Dwell is now 700 ms and the trigger area is the row's text cell only (title+meta); grace on leave 450 ms. (2) **Error guidance was invisible**: the app rewrites bot-gate/cookie-decrypt errors with a fix, but appended it AFTER yt-dlp's multi-sentence message — and the queue row's meta line ellipsizes, so the fix was truncated away. Rewrites now LEAD with the action (“youtube wants a sign-in for this video — set cookies … ”) and keep the raw error after a separator. (3) **Cookies never applied**: switching the composer to “from browser…” left `browser=null` (the dropdown only sets its value on change, while displaying firefox) — no flag in the preview and none at run time; and the fetch-phase identity probe omitted the cookie flags entirely, so a bot-gated url failed before the download (which had them) ever ran. Mode select now completes itself (firefox default), the probe carries the same flags as the download, and firefox cookies are live-verified past the bot-gate through the managed yt-dlp. | alpha.8 user feedback |
**Explicitly removed from the plan** (do not implement): theme switching, clipboard
watching, minimize-to-tray, logo, presets editor, LogDrawer component (replaced by
per-row expandable output), sidebar navigation, save button in settings, blue accents,
light theme, status/format columns in queue table.

---

## 1. Goals & Non-Goals

**Goals**

- Modern, clean, minimal, informative UI — dark-only, all-monospace, amber-accented.
- Keep 100% of v1 functionality: audio/video modes, full codec/re-encode/remux set,
  resolution cap, container, cover art, archive, playlist handling, FFmpeg location,
  console output, config persistence, cookies/subtitles/SponsorBlock/extra args.
- Self-managed yt-dlp + FFmpeg: first-run setup, verification, 1-click updates.
- 1-click app auto-updates (unsigned Tauri updater).
- Clean packaging: NSIS installer, CI-built artifacts.
- Config + archive migration from v1.

**Non-Goals (v2.0)**

- macOS/Linux builds (architecture keeps them easy to add).
- Account-authenticated/DRM downloading.
- Torrent/SFTP/aria2c.
- Presets system (D16).
- Re-encoding the audio track of a merged video file (not a first-class yt-dlp
  feature; power users use Extra args).
- URL-string dedupe (D18).

---

## 2. Stack

| Layer     | Choice                                   | Why |
|-----------|------------------------------------------|-----|
| Shell     | **Tauri 2** (Rust)                       | ~5 MB installer, WebView2 preinstalled on Win10/11, built-in updater |
| Backend   | Rust commands (thin)                     | Spawn/parse yt-dlp streams, file management |
| Frontend  | **React 18 + TypeScript + Vite**         | Rich ecosystem, typed IPC |
| UI kit    | Tailwind CSS + shadcn/ui                 | Fast, themable via CSS tokens |
| State     | Zustand (UI) + TanStack Query (async)    | Small, composable |
| Storage   | SQLite via `rusqlite` (bundled)          | History metadata; §5.3 |
| Packaging | NSIS + Tauri updater                     | Standard, small, auto-update |

Rust crates: `tokio`, `reqwest` (rustls), `serde`/`serde_json`, `sha2`, `zip`,
`rusqlite`, `thiserror`, `tauri-plugin-{updater,dialog,shell,single-instance,notification}`.

**Typeface**: bundle **Cascadia Mono** with the app (do not rely on system fonts);
CSS `@font-face`, weights 400/600/700. Fallback stack: `"Cascadia Mono",
"JetBrains Mono", Consolas, monospace`.

---

## 3. Project Layout

```
ytdlp-gui/
├─ src-tauri/
│  ├─ src/
│  │  ├─ main.rs / lib.rs        # app setup, plugins, state
│  │  ├─ commands/
│  │  │  ├─ binaries.rs          # status/install/update yt-dlp & ffmpeg
│  │  │  ├─ jobs.rs              # queue: add/stop/retry/remove, list, pause
│  │  │  ├─ metadata.rs          # --print id resolve (D44: no -J at queue time)
│  │  │  ├─ settings.rs          # load/save (autosave), migrate v1 config
│  │  │  └─ history.rs           # SQLite history, archive import
│  │  ├─ engine/
│  │  │  ├─ process.rs           # tokio process wrapper, line streaming
│  │  │  ├─ parser.rs            # structured progress + error extraction
│  │  │  ├─ args.rs              # typed options → yt-dlp argv (no shell!)
│  │  │  └─ queue.rs             # job queue, concurrency, retry, persistence
│  │  ├─ binaries/
│  │  │  ├─ sources.rs           # release urls, checksums (yt-dlp / BtbN / gyan)
│  │  │  └─ manager.rs           # manifest, sha256 verify, atomic swap
│  │  └─ store/                  # sqlite migrations + repos
│  ├─ capabilities/default.json
│  └─ tauri.conf.json
├─ src/                          # React app
│  ├─ pages/ (Home, History, Settings)     # three tabs only
│  ├─ components/ (Composer, QueueTable, SortMenu, HoverCard, ExpandoRow, …)
│  ├─ lib/ipc.ts                 # typed invoke/listen wrappers
│  └─ stores/
├─ mockup/index.html             # approved UI reference (M0.5)
└─ .github/workflows/release.yml
```

---

## 4. Binary Management

GUIs in this space (Stacher, Parabolic) don't ship/trust bundled copies; they
download and own binaries in an app directory. We follow that.

**Locations** (writable, no admin):

```
%APPDATA%\ytdlp-gui\bin\yt-dlp.exe
%APPDATA%\ytdlp-gui\bin\ffmpeg.exe / ffprobe.exe
%APPDATA%\ytdlp-gui\bin\manifest.json
```

**Sources**

- yt-dlp: `github.com/yt-dlp/yt-dlp/releases/latest` → `yt-dlp.exe`, verified
  against the release's `SHA2-SUMS.txt` (SHA256).
- FFmpeg: BtbN `ffmpeg-master-latest-win64-gpl.zip` (gyan.dev release-essentials
  fallback). Extract only `ffmpeg.exe`/`ffprobe.exe`.

**First-run wizard** (overlay, not a pop-up window)

1. Detect existing `yt-dlp`/`ffmpeg` on PATH → offer "use my own copies".
2. Otherwise one-click "download yt-dlp & ffmpeg" with live progress.
3. Write `manifest.json`:

```json
{ "yt-dlp": { "version": "2026.09.01", "sha256": "…", "source": "github" },
  "ffmpeg": { "version": "7.1.1",      "sha256": "…", "source": "btbn"  } }
```

**Update flow**

- Launch + every 6h: `GET releases/latest` with `If-None-Match` (ETag); compare
  to manifest → amber badge in Settings → tools.
- Update = download to temp → SHA256 verify → **atomic rename** over old exe.
  If exe locked (download running), stage and swap on app exit.
- FFmpeg: identical flow but **user-initiated only** ("check" shows latest tag
  beside installed version; "update" fetches when asked) — never automatic (D20).
- `yt-dlp -U` not used for managed copies (D30). Custom-executable escape hatch:
  point at scoop/PATH binaries; version shown via `--version`.

---

## 5. Download Engine

**Invocation hard rules**

- Never `shell = true`; argv built from a typed struct → injection-immune.
- One `tokio::process::Command` per job; stdout line-streamed to parser.
- Progress: `--newline --progress-template
  "download:__P__%(progress.downloaded_bytes)s|%(progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.eta)s"`
  (+ regex fallback on `[download] NN.N%`).
- Final path: `--print after_move:filepath`.
- Identity: `--print id`, resolved once per item (memoized, D37) → §5.2 dedupe.

**Queue model**

- Job states: `Queued → Fetching → Downloading → Post → Done | Stopped | Error`.
  **No `Canceled` state** — user stop = `Stopped`.
- Concurrency default 2, configurable (Settings → downloads).
- Global pause/resume of the queue; per-item stop/retry/remove (§6 lifecycle).
- Queue persists across app restarts (SQLite jobs table); `Fetching` items resume
  as `Queued` on restart.

### 5.2 Format semantics & URL intake (verified against yt-dlp, 2026)

**URL intake (lenient — D28)**

- Drop blank lines. Prepend `https://` to scheme-less pastes (yt-dlp accepts these).
- Flag only obvious non-links ("this is not a url") — those lines are **kept in the
  box** for fixing; the feedback card lists each invalid line with its reason.
- **No host validation.** Intranet/localhost/vanity hosts must be accepted.
- Feedback summary: `n queued · n duplicates skipped · n invalid`, invalid lines
  listed individually with reasons.

**Identity & dedupe (D18)**

- A video's canonical identity is yt-dlp's `<extractor> <id>` pair — the exact
  string format of `downloaded.txt` lines.
- Resolved **once per item at metadata-fetch time** (`yt-dlp --print id`): compared
  against the archive (already downloaded → skip) and against in-queue/running ids
  (→ duplicate-skip). New items render as `fetching…` while this resolves.
- Two different url strings (`youtu.be/x`, `youtube.com/watch?v=x`) → same id →
  duplicate. UI, archive, and DB all key on this pair.

**Playlists** — verified: default yt-dlp behavior for `watch?v=…&list=…` is to
download the **entire playlist**. UI is a 3-state segmented control:
**single video only** (`--no-playlist`) / **entire playlist** (no flag) /
**first n…** (`--playlist-end N` — first N items **from the start of the playlist,
in playlist order**, not from the clicked video). Hint states this explicitly.

**Archive** — read + write: consults `downloaded.txt` before each item, appends
completions after. Label: "skip downloaded"; hint: "record in downloaded archive".
**Archive-writing rule**: the engine appends `<extractor> <id>` itself after each
successful job (idempotent, same line format yt-dlp writes). Never rely solely on
yt-dlp's post-run write — this prevents archive/history/file drift when yt-dlp
errors after a successful download.

**Convert to (audio) — full yt-dlp set.** Rule stated in the UI once via
optgroups; **no** inline "any selection converts" sentence (D27):

- *no conversion*: **keep original** — no post-processing.
- *re-encode (ffmpeg)*: mp3, m4a/aac, opus, vorbis, flac, alac, wav.
- *remux (lossless, instant)*: mka container, mp4 container (stream copy).

Notes are site-agnostic (SoundCloud/Bandcamp serve other native formats —
lossless targets are legitimate there): flac/alac/wav warn "quality is limited
by the source — lossless on bandcamp, lossy on youtube (~130–160k). bigger file,
not better sound".

**Video**

- Max resolution: best/4320p/…/360p → caps `bv*[height<=H]+ba/b[height<=H]/b`.
- Container mp4/webm/mkv. webm ⇒ **warning**: "webm can't embed thumbnails —
  cover art will be skipped".
- "audio in video" = which native audio **stream** gets merged, NOT a codec
  list: opus (smaller; some players can't decode) vs aac (universal).
  Other sites serve different streams → yt-dlp falls back to best available.
  No re-encoding of merged video audio in v2.0 (Non-Goals).
- **Best** = yt-dlp default smart selection, highest-ranked video + audio merged
  via FFmpeg (`bv*+ba/b`).

**Cover art** — one shape-aware control: Audio default = **square**; Video
default = **original shape**. Options: square / original / **custom w×h**
(two px inputs → `scale=W:H` postprocessor args) / none. webm overrides to none
with the warning above. The old "audio default: square png cover" hint is
**removed** from the UI (D27).

**History, re-download, manually moved files**

- History stores the **last known** final path.
- **Re-download (↻) = new job with CURRENT composer settings + destination**
  (D19). One mental model: "what queue would do if I pasted this url now".
- **Show in folder** opens the stored path; if missing → "moved?" state with
  **locate…** (re-link) or clear-path. The app never follows files silently.
- Remove from queue never touches files, history, or archive.

### 5.3 Storage: downloaded.txt + SQLite (decision & tradeoffs)

- `downloaded.txt` — plain yt-dlp archive format — remains **source of truth for
  skip logic** (D17): cross-compatible with yt-dlp CLI/scripts/v1, user-inspectable,
  trivially editable (with the in-app warning that editing changes what counts as
  already downloaded), zero migration risk. Corruption cost: a re-download.
- `history.db` (SQLite) — **metadata only**: title, channel/uploader, duration,
  size, format, final path, error text, timestamps. Powers history search/sort.
  Corruption cost: history cosmetics only.
- Why not DB-only: yt-dlp only understands the text archive; DB-only would need
  intercepting every invocation (incl. manual CLI use) to stay consistent.
- Why a DB at all: rich per-download attributes a text file can't hold, at
  near-zero cost via `rusqlite`.
- Reconciliation: DB rows keyed by `extractor+id`; a rescan can rebuild DB rows
  from downloaded.txt where files still exist.

---

## 6. UI/UX Specification (final — matches approved mockup `mockup/index.html`)

**Design principles**: dark-only; clean; minimal; functional; maximally
informative without overwhelming; everything in the info hierarchy, nothing
hidden in modals in the primary flow; consistent all-monospace identity.

**Visual language**

- One typeface: **Cascadia Mono** everywhere (D13). **All-lowercase copy** (D14).
- Palette (warm charcoal): `--bg #0d0f12 · --bg-1 #14171b · --bg-2 #1c2127 ·
  --bg-3 #262d35 · --border #2b333c · --text #e8eaed · --muted #939ca8 ·
  --faint #626c78`. Accent **amber `#e8a33d`** (active tab, primary buttons,
  progress, toggles, scrollbar hover); green `#3fb950` success only; red
  `#e5534b` errors/destructive only. Soft variants at ~14% alpha for chip
  backgrounds. No blue.
- **Form labels** (left column: destination, type, convert to, cover art,
  playlists, skip downloaded…) = `--text`, weight 600. **Hints** = `--faint`,
  11px. This distinction is deliberate (D27).
- Sharp edges (4px max radius), 1px borders, dense rows, subtle hover tint.
- **Custom scrollbars** on every scroll container: 2px thumb, bg-3 track,
  amber on hover — including history's horizontal scroll (D23).
- Alternates via tokens only: Nord-slate+cyan, Rosé Pine kept as future options.
  No theme switcher ships (D7).

**Chrome**

- **Top tab bar**: home / history / settings (lowercase mono, amber active-tab
  underline). Right side: **engine status only** ("2 active · 1 queued" /
  "engine idle"). **No tool versions here** (D25). No page headers on
  history/settings (D26).
- Status bar / footer: none.

**Home**

1. **add downloads card** (always visible, inline — no pop-up, D11):
   - URLs textarea (multi-line). Lenient intake per §5.2; feedback card reports
     `n queued · n duplicates skipped · n invalid` with per-line reasons;
     accepted lines clear, invalid lines stay for fixing.
   - **destination**: path input + folder-picker button. (The "after
     download: move to…" control was cut — D49: never implemented, dead
     surface. History's show-in-folder/locate… covers relocation after the
     fact.)
   - **type**: audio | video segmented control; contextual rows:
     - audio → **convert to** (optgroup select per §5.2) + per-format note line
       (hidden entirely when empty, no phantom row) + **cover art**.
     - video → **max resolution**, **container** (+ webm warning), **audio in
       video**, cover art (original-shape default).  - **playlists**: 3-state segmented control (§5.2) + `n` input for "first n…"
    + hint. **skip downloaded**: toggle + "record in downloaded archive" hint.
   - **advanced ▾** disclosure: cookies (D38: none / from browser / cookies.txt
     — never persisted), subtitles (D39), sponsorblock (D39), extra args
     (warned: passed as-is), output template.
   - **Batching (D33)**: one job per URL. A playlist url = one job covering all
     its items; progress shows items-done/total. Duplicate handling per §5.2.
   - **live command preview**: exact argv as it will run, rebuilt on every
     change, click-to-copy. The primary transparency mechanism.
   - Buttons: **queue downloads** (primary), clear.
2. **queue card**: header row with pause, clear done, sort menu, clear all.
   Fixed-height container (~400px), internal vertical scroll, sticky headers.
   Stress-tested to stay bounded at 1000+ rows.
   - **Columns**: `#` · item · progress (bar + %) · speed · eta · actions.
     **No status column** — status is a 3px **accent bar** on the row's left
     edge (amber = downloading/post/fetching, green = done, red = error, gray =
     queued/stopped). **No format column** — format lives in the hover card.
   - **Titles ellipsized**; column widths via `table-layout: fixed` + colgroup:
     # 34px · item flex (cap ~40%) · progress 150px · speed 72px · eta 56px ·
     actions ~104px. **Narrow windows hide columns progressively — speed/eta
     drop first (progress is never hidden)**; below 560px: # / item / progress /
     actions. Horizontal overflow must never occur.
   - **Actions** (contextual, sticky-right, 14px glyphs, never clipped and never
     covering fields): ■ stop (downloading/post/queued) · ↻ retry
     (stopped/error) · ✕ remove (queued/stopped/error/done; disabled while
     downloading) · ▸ output (expand).
   - **Expandable output row**: per-item yt-dlp output, mono, scrollable,
     copyable. Replaces any log drawer.
   - **Hover details card** (600ms delay, never triggers over action buttons):
     full title, source url, format id, final path (word-broken), error text
     when present — clamped to viewport.
   - **Sort menu** (header button): queue order / title / format / status /
     progress / speed / eta + asc/desc. Visible headers stay click-to-sort and
     in sync; hidden-column sorts (format/status) live in the menu only.

**Sorting — all tables**

- Header click cycles **asc ▲ → desc ▼ → default (no glyph)**; default =
  insertion order (queue) / newest first (history). Full cycle always restores
  the original order.
- Sort is a **live view**: new items insert at their sorted position; progress
  updates re-evaluate under the active sort; ties break stably by insertion
  sequence. Implementation: single derived-list selector (`useMemo`), stored
  order never mutated.

**Item lifecycle**

- `Queued → Fetching → Downloading → Post → Done | Stopped | Error`.
- **Stop** ■: kill child process, keep `.part` files → `Stopped` (not Error).
- **Retry** ↻ (stopped/error): re-queue same options; yt-dlp resumes partials.
  If the archive already contains the id from an earlier completion, job ends
  Done/skipped — correct and expected.
- **Remove** ✕: queued/stopped/error/done → drop entry (files, history,
  archive untouched). While downloading: stop first, then remove.
- **Queue pause** (D34): stops dispatching new items; running processes keep
  running. Resume restarts dispatch.
- **App restart** (D35): running/post → `Stopped`; queued stay queued; nothing
  auto-resumes. Queue persists across restarts (SQLite jobs table);
  `Fetching` items resume as `Queued`.

**History** — no page header. Card header: search input + explicit **search**
button. Sortable table: title/channel/uploader · size · duration · downloaded ·
sticky-right actions 📁 (show in folder / locate… if moved) · ↻ re-download
(= new job with current settings/destination, D19). Horizontal scroll with the
custom scrollbar; actions always visible (sticky). Footer: **open archive** +
**import v1…** + warning "editing downloaded.txt changes what counts as already
downloaded".

**Settings** — no page header, no save button (D24 — autosave, "saved ✓" flash).
Flat cards:
- **tools**: yt-dlp row (installed version, **check**, **update**) · ffmpeg row
  (same) · custom-executables escape hatch (path inputs, `--version` shown) ·
  replay first-run wizard link.
- **downloads**: default destination, concurrency (default 2), archive path +
  **open archive** + edit warning + import v1.
- (App-updates row lives in tools; no About tab.)

**First-run wizard**: overlay with progress bars + sha256 verification +
"use my own copies" option; replayable from Settings → tools.

**Keyboard/UX polish**: Ctrl+V focuses composer; Enter queues; F5 refreshes
history; `prefers-reduced-motion` respected; completion feedback in-place.

---

## 7. IPC Contract

**Commands** (typed via serde, all `Result<T, AppError>`)

```ts
binariesStatus(): BinaryManifest
binariesInstall(): StreamedProgress            // first-run download
binariesUpdate(tool: "yt-dlp" | "ffmpeg"): UpdateResult
binariesCheckLatest(tool): LatestInfo
jobAdd(urls: string[], options: JobOptions): Job[]   // lenient intake in Rust
jobStop(id), jobRetry(id), jobRemove(id)
queuePause(), queueResume()
queueList(): Job[]                              // restore on app start
metadataResolve(url): { extractor, id, title? }  // --print id (dedupe key)
settingsGet(), settingsSave(s)                   // autosave calls save
historyList(filter), historyImportArchive(path), historyRelink(id, path)
archiveOpen()                                    // reveal downloaded.txt
appVersion(): { app, ytDlp, ffmpeg }
```

**Events** (Rust → frontend)

```ts
"job:update"   { id, state, pct?, speedBps?, etaSec?, title? }
"job:log"      { id, line }
"queue:changed"{ active, queued }
"binaries:progress" { tool, received, total }
"update:available"  { tool | "app", from, to }
```

**Security**

- Strict CSP; capabilities grant only needed plugin permissions.
- FS writes scoped to output dir + app-data; metadata paths sanitized.
- Args never through a shell; intake per §5.2 (scheme normalize, non-link flag).
- Cookies: exported browser session cookies are **sensitive** — held in memory
  per job only, never persisted by the app.
- Extra args: user-owned; passed as-is with an inline warning.

---

## 8. App Auto-Update (1-click)

- `tauri-plugin-updater` + `tauri-plugin-process`; minisign keypair (private in
  GitHub secret, public in `tauri.conf.json`). Unsigned installers are fine;
  the updater itself authenticates via minisign (D30).
- CI attaches `*.nsis.zip` + `latest.json` to GitHub Releases; app polls on
  launch + 6h → in-app banner → "update & restart".
- NSIS replaces the app while running; managed binaries in app-data untouched.

---

## 9. CI/CD

- `release.yml` on tag `v*`: tauri-action builds NSIS, signs updater artifacts,
  creates GH Release with `latest.json`. cargo + pnpm caching.
  - **proven live** (v2.0.0-alpha.2, 2026-09-04): full NSIS build on
    windows-latest, installer attached, prerelease flag keeps
    `releases/latest` (the future updater endpoint) clean (404).
    run #1 exposed a real pipeline bug before any user could: pnpm 11
    defaults `strictDepBuilds: true` and replaced `onlyBuiltDependencies`
    with the `allowBuilds` map — the old key was silently unread and the
    frozen-lockfile install hard-errored on esbuild's postinstall.
    migrated to `allowBuilds`, pinned CI to pnpm 11.25.0, reproduced
    locally via `pnpm install --frozen-lockfile`, re-tagged green (9m39s).
- Optional nightly build artifact for testers.
- Quality gates: `cargo clippy -D warnings`, `cargo fmt --check`, `tsc --noEmit`,
  ESLint/Prettier.

## 10. Testing

- Rust unit: `parser.rs` (progress/error lines), `args.rs` (snapshot: options →
  argv), `binaries/sources.rs` (checksum parsing), intake normalization.
- TS (Vitest + Testing Library): queue reducer (sort cycle restores default,
  live re-sort, stable ties), composer → argv preview parity with `args.rs`
  snapshots, lifecycle transitions.
- Manual E2E per release: single video · playlist · first-n · duplicate of
  archived item · stopped→retry resume · moved file locate… · intranet url ·
  soundcloud/bandcamp audio · webm container warning · age-gated/unavailable.

## 11. Config Migration (v1 → v2)

On first run, look for legacy `ytdlp_gui_config.json` next to old exe and in
app-data:

| v1 key | v2 target |
|---|---|
| `output_dir` | settings default destination |
| `format_type`, `audio_codec`, `video_res`, `video_ext`, `video_audio_pref` | composer initial values ("migrated v1") |
| `use_archive`, `download_playlists`, `playlist_limit` | composer initial values |
| `ytdlp_path`, `ffmpeg_path` | offered as custom binaries in first-run wizard (verified against a real config, 2026-09: yt-dlp is stored as a **file**, ffmpeg as a **directory** — the value goes straight to `--ffmpeg-location`, which accepts a dir; the offer checks existence accordingly) |
| `downloaded.txt` beside the **v1 yt-dlp.exe** | imported: archive path pointed at it (or copied into app-data); ids also seeded into history DB. verified against gui.py + a real config — the archive lives at `dirname(ytdlp_path)/downloaded.txt`, not beside the config file; the config dir is only a fallback. `format` / `playlist_range` / `template` are reported as unmapped, never silently ignored |

## 12. Milestones

| # | Deliverable | Exit criteria |
|---|---|---|
| M0 | UI mockup | **Done — approved** (`mockup/index.html`, M0.5) |
| M1 | Scaffold + shell | **Done** — Tauri 2 + React runs; top tabs; Cascadia bundled; palette tokens; strict CSP; typed IPC ping |
| M2 | Binary manager | **Done** — first-run wizard installs + sha256-verifies yt-dlp/FFmpeg; ETag check; atomic swap update |
| M3 | Queue parity | **Done** — §5 engine + composer + queue table (accent bars, sort menu, lifecycle, expandable output, hover card); SQLite history writes; archive read+write rule |
| M4 | Metadata + migration | **Done** — `--print id` dedupe; v1 config + archive migration (D43) |
| M5 | Update & packaging | **Done** — NSIS + 1-click app update + tool updates in Settings; CI release on tag |
| M6 | Polish | **Done** — keyboard shortcuts, reduced motion, E2E checklist green |
| M7 | First real install | **Done** — engine truth (D61–D65), installer & lifecycle (D66–D69), app-owned dialogs (D70), design pass (D71–D72); live-verified installer upgrade/uninstall + e2e suite (`docs/M7_PLAN.md`) |

Order note: M3 engine work (process wrapper, parser, args) can start in parallel
with M2 — they are independent.

---

## 13. Historical reference

- Original v1: `gui.py` (Tkinter) — kept untouched until v2 GA.
- Approved mockup: `mockup/index.html` (M0.5) — canonical visual reference.
  Earlier iterations (blue-graphite sidebar M0.1, rounded graphite M0.2,
  amber sidebar M0.3/M0.4) are superseded; their review feedback is folded
  into the decision log above.
