# M7 plan — "first real install" feedback: root causes + no-compromises redesign

source: the user installed v2.0.0-alpha.2 via the NSIS installer and used it for real.
this plan is the deliverable of the review round; **no code changes yet**. each item lists
the root cause found in code (file:line where useful), the no-compromises fix, and the
acceptance test. new decisions get D-numbers and migrate into V2_DESIGN.md when the
phase lands.

---

## 0. quick answers to the direct questions

| question | answer |
|---|---|
| cookies from browser — how does it work? | the app passes `--cookies-from-browser <name>` to yt-dlp, which reads the browser's local cookie store directly — no manual export. it works today (the flag is wired and unit-tested). caveats: chrome ≥127 uses app-bound cookie encryption on windows that yt-dlp cannot always decrypt (firefox/edge are the reliable paths); the plan adds a targeted error rewrite so a decryption failure points at the exact problem instead of a generic ERROR. |
| install when the app already exists? | NSIS currentUser install upgrades in place: same install dir, appdata (history.db, downloaded.txt, managed bins) untouched. needs an explicit e2e on a clean VM + docs (§0 of the plan), because we never tested it. |
| what happens on uninstall? | today: the uninstaller removes program files only — the managed binaries (~150 mb), history.db and downloaded.txt all survive silently. m7 adds an uninstaller choice: remove app data (with the archive explicitly called out), never touching the user's downloads folder. |
| items in archive but not in the db? | the engine skips them silently on queue (done/skipped) and no history row exists — invisible. m7 adds archive→history backfill (§A4). |
| items in the db but not in the archive? | the engine re-downloads on the next queue and appends the id itself — self-healing, no data loss. documented + covered by a test. |

---

## 1. root-cause table (every reported symptom)

| # | symptom | root cause in code | fix (section) |
|---|---|---|---|
| 1 | installer "browse" is a compact tree, hard to navigate | tauri's NSIS template uses the legacy `SHBrowseForFolder` tree picker on the install-dir page | §B1: installer hook → vista `IFileDialog` folder picker |
| 2 | "old test data" in the installed app | dev and installed builds share one appdata dir (`identifier`-derived); the 60+ e2e runs seeded the production profile | §B4: dev/e2e builds use a separate data dir; settings gets "reset app data" |
| 3 | hover card flashes away unless pinned on title | `Row` uses `onMouseOver`/`onMouseOut` which **bubble** from every child `<td>` — moving between cells fires out/over pairs that clear the card | §C3: rebuild hovercard with non-bubbling enter/leave + portal + grace period |
| 4 | ffmpeg "version" N-126404-g1818e5d965b-20260904 | that *is* btbN's rolling build id (git hash + date); we display it raw | §C6: parse to "nightly 2026-09-04" + build hash on hover |
| 5 | badge says update always available | **etag compared across sources**: after an update served by the *fallback* source (gyan), the manifest stores gyan's etag; the next check queries btbN with it → 200 (different etag) → permanent badge. same class of bug can hit yt-dlp if its fallback ever serves | §A5: track `(source_id, etag)` pairs; compare only within the same source |
| 6 | yt-dlp "update available" but version number the same | staged swap: on windows the running exe is locked → new build sits in `staged` until relaunch; the row shows old binary version + badge, with no explanation that a relaunch completes it | §A5/C6: staged state made loud ("restart to finish"), version row always probes the real binary |
| 7 | "number displays broken — right side, then another on the left" | `ToolRow` is a flex-wrap row of variable-length strings; long build ids wrap mid-row so version/badge/staged fragments land on different lines, plus queue numerics mix alignments | §C1: tabular-nums + fixed definition-list layout everywhere numbers render |
| 8 | stuck on "fetching" forever | `resolve_identity` (queue.rs:1054) has **no timeout** — an unreachable host waits on yt-dlp's own ~20 s connect timeout (or hangs indefinitely on a stalled socket); stderr is not streamed live during fetch, so the row looks frozen with no feedback | §A1: fetch watchdog (90 s, cancelable), live stderr streaming into the expando, "resolving… Ns" state |
| 9 | green + 100% while showing "fetching" | UI state is patched from partial events (`stores/queue.ts`: `pct: p.pct ?? j.pct`, `state: p.state ?? j.state`) — a stale `fetching` event can land after the terminal reload and downgrade the visible state while pct stays 100 | §A1: the frontend derives state only from authoritative db-row snapshots (monotonic by `updated_at`); events only *trigger* reloads |
| 10 | file downloaded, but "no metadata, no location recorded" | two compounding paths: (a) `after_move:filepath` output that fails the `looks_like_path` heuristic (parser.rs:206 — e.g. titles containing `%)`) silently drops `final_path`; (b) with `final_path=None` the ffprobe metadata pass never runs → history row all-null. the job still shows done/100% | §A2: done-without-evidence is impossible — dest glob fallback for the output template's `[id]` pattern; history row always written with at least url/title/dest; parser hardened + unit-tested against real titles |
| 11 | ↻ re-download with archive "does nothing" | engine pre-checks the archive *before* overwrite matters: `archive_contains` → done/skipped short-circuit (queue.rs:489) — the D59 confirm dialog promises a fresh download the engine then refuses | §A3: ↻ = **force re-download** (per-job archive bypass + `--force-overwrites`); archive file itself stays idempotent. "respect archive" remains the composer default |
| 12 | can't highlight text | `body { user-select: none }` with only inputs/logs/cmd-preview opted back in | §C4: invert the policy — selectable by default, `user-select: none` only on chrome (buttons, tabs, sort headers); double-click-to-copy on paths |
| 13 | "import v1" → just import downloaded.txt | agree: the wizard's v1 section conflates two things; the config mapping helped one user once | §A4: wizard drops the v1 block (silent one-shot archive seeding per D43 stays); history page gets an explicit "import archive…" action |
| 14 | tab bar too tall | `h-11` (44 px) + large paddings | §C2: 32 px bar, tighter type, active indicator |
| 15 | no "open in explorer" for queue items | actions matrix (D29) only ever wired reveal for history; queue rows have stop/retry/remove/chevron | §C7: reveal action on any row whose file exists (done/skipped + hovercard path click) |
| 16 | white flash on resize | webview paints before css: `html` has no background (only `body` does), window background not configured | §C8: `backgroundColor` in tauri.conf + `html { background: var(--bg) }` |
| 17 | command preview: no color coding, no grouping | current preview is one flat dim string (cmdPreview.ts) | §C5: two-tier highlighted preview (user intent vs engine plumbing), collapsible, copy button |

the meta-finding: **every "app is lying" symptom (6, 7, 8, 9, 10, 11) is a trust defect, not a
cosmetic one** — the state model and the update model each have one place where the UI shows a
plausible-but-false value. m7's theme is *truthfulness*: the engine, the db, and the screen must
never disagree.

---

## 2. the phases (strict order)

### phase A — engine truth (the trust fixes)

**A1 — fetch phase honesty (D61)**
- `resolve_identity` gets a 90 s watchdog (tokio timeout; canceled probe = killed child);
  a probe that times out finalizes the job as error with "could not resolve in 90 s — check
  the url / your connection", never a frozen row.
- during fetch, yt-dlp's **stderr streams live** into the expando (currently only the final
  ERROR line survives). a bot-gate or geo-block is visible within seconds.
- the queue row shows `resolving… Ns` (engine emits a lightweight ticker event) with the
  existing stop button active.
- **acceptance**: e2e S-new: queue an unroutable host → row shows live stderr → errors inside
  the watchdog with a readable message. S12 (dead link) asserts the same.

**A2 — done means evidence (D62)**
- engine done-path: if `final_path` is None, glob `dest` for the output template's
  `[<id>]` pattern (single video) before giving up.
- history write on done **always** happens: url + title + destination at minimum;
  duration/size/format stay best-effort ffprobe (D45) — but a null metadata row must still
  exist and render, with a "locate…" affordance since there's no path.
- parser: `looks_like_path` rejects fewer real paths (strip trailing `%)` cases, test with
  real-world titles containing parentheses/percent).
- **acceptance**: unit tests pin the parser against captured outputs with hostile titles;
  e2e asserts a done job always produces a history row with a resolvable path.

**A3 — re-download semantics (D63)**
- history ↻ on an existing file → D59 confirm → queues with `skip_downloaded: false` **and**
  `overwrite: true` for that job only (engine: the archive pre-check is skipped; the archive
  file is still appended idempotently — no drift).
- composer queue unchanged (archive-respecting default); the two intents are named in the ui:
  ↻ says "force re-download".
- **acceptance**: e2e S18 extended: granted re-download actually re-downloads (mtime advances)
  even though the identity is in the archive — currently impossible, pinned.

**A4 — archive ↔ history reconciliation (D64)**
- one engine command `archive_reconcile()`: backfills history rows from archive entries
  missing in the db (`extractor id`, no metadata, flagged "imported"), and reports archive
  entries whose downloads vanished (never auto-prunes).
- history page: "import archive…" (explicit, replaces the wizard's v1 framing; silent D43
  seeding stays for first run) + an archive-health line (n entries · m imported · k missing).
- **acceptance**: unit tests over a synthetic downloaded.txt; e2e scenario covers backfill +
  engine-skip of an imported id.

**A5 — update model truth (D65)**
- manifest tracks per-source `(source_id, etag)`; `record_check` compares only when the
  queried source matches the one the artifact came from — kills the perpetual badge.
- version display: yt-dlp = its real version; ffmpeg = parsed `nightly 2026-09-04`
  (hash on hover/tooltip). staged state renders as a first-class step: "restart to finish
  update", and the row's version always reflects the **binary on disk** (probe), never a
  recorded string that can drift.
- **acceptance**: manager unit test: gyan-served update + btbN check → no badge. e2e: staged
  flow shows the restart step and clears after relaunch.

### phase B — installer & lifecycle (the first-five-minutes fixes)

**B1 — modern folder picker (D66)**: tauri nsis `installerHooks` replaces the directory
page's `SHBrowseForFolder` tree with the vista `IFileDialog`; verified on a clean win VM
(solo + custom-dir installs).

**B2 — reinstall/upgrade semantics (D67)**: documented + e2e: install alpha.2 → install
alpha.3 over it → appdata preserved, binaries managed dir intact, no duplicate entries.

**B3 — honest uninstall (D68)**: uninstaller asks once: "also remove app data (history,
archive, managed yt-dlp/ffmpeg ~150 mb)?" — default **keep** (D32 spirit: never destroy
user data silently), explicit opt-in to remove; the user's downloads folder is never touched.

**B4 — dev/prod data separation (D69)**: dev + e2e builds run against
`com.ytdlp-gui.app.dev` (debug_assertions / env override), so the campaign's test data can
never appear in an installed app again. settings → app gets "reset app data…" (archive
called out by name, double-confirm). existing installed-profile test data: the shipped
alpha.2 users get a one-time prompt offering to clear e2e artifacts (rows whose dest is the
e2e dir).

### phase C — the design pass (attractive, no compromises)

**C1 — numeric & layout discipline**: every number renders in `tabular-nums`, fixed-width
context; tool rows become a definition-list (name / version / status / actions as stable
columns) so nothing wraps into fake "second numbers"; alignment audit across queue, history,
settings.

**C2 — slim tab bar**: 32 px, tighter type, amber active underline; engine status inline,
quieter. sort/actions density on the queue card header revisited.

**C3 — hovercard rebuilt**: non-bubbling `mouseenter`/`mouseleave`, rendered in a portal,
stays while the pointer is on the card, 300 ms grace before hiding, reveal + copy-path
actions on the card itself. the "flashes away" bug is structurally gone, not patched.

**C4 — selection policy (D70)**: selectable by default everywhere content shows (titles,
urls, paths, versions, logs, hovercards, cmd preview); `user-select: none` only on
interactive chrome. double-click a path → copies it. this matches the app's "data is yours"
stance.

**C5 — command preview, redesigned**: two visually separated tiers —
  *what you asked for* (format, destination, playlist, cookies, subtitles — the flags that
  change your result) and *engine plumbing* (progress template, prints, archive internals —
  collapsed behind "show engine details"). amber = user flags, dim = plumbing, green =
  values, red = destructive (`--force-overwrites`). argument order note added (order among
  these flags doesn't matter; the preview shows the actual argv so it's always exact).
  copy button. snapshot-tested against args.rs mirrors as today.

**C6 — tools & updates surfaces unified**: one card pattern for yt-dlp / ffmpeg / app:
version truth (binary probe), channel (stable vs nightly), last checked, check, update,
staged step — replacing today's ad-hoc row fragments. the app-update banner and settings
row share the same component; no version string is ever hardcoded or duplicated.

**C7 — queue row actions**: reveal-in-explorer whenever the file exists (done, skipped, or
error-with-file), plus on the hovercard; keeps D29's glyph language.

**C8 — resize flash**: `backgroundColor` on the tauri window + `html` background token —
no white flash during resize/startup.

### phase D — verification & docs

- new decisions D61–D70 land in V2_DESIGN.md with rationale; the root-cause table above is
  the changelog seed.
- e2e: new scenarios (fetch watchdog, force re-download, reconcile, staged-update) +
  S18/S19 updates; smoke suite stays youtube-independent.
- gates: fmt/clippy/tests/tsc/build; installer work verified on a clean VM; a fresh
  `v2.0.0-alpha.3` tag proves CI end-to-end again.

## 3. sequencing & sizing

| phase | scope | risk |
|---|---|---|
| A1+ A2 | engine + store + parser | the behavioral core; e2e-heavy |
| A3 + A4 | engine commands + history ui | moderate; ui-light |
| A5 | binaries manager + toolrow | small code, big trust win |
| B4 | config seam + settings | small; do early — explains symptom 2 |
| B1–B3 | nsis hooks + docs + VM testing | medium; independent of A |
| C1–C8 | css + components | large surface, low risk; the visible payoff |
| D | docs + e2e + tag | continuous |

proposed commit series: `A1`, `A2`, `A3+A4`, `A5`, `B4`, `B1-B3`, `C1-C4`, `C5-C8`, docs+tag.
