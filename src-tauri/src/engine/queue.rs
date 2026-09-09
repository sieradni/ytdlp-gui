//! job queue (§5): states Queued → Fetching → Downloading → Post →
//! Done | Stopped | Error (no Canceled — D31). one job per URL (D33).
//! pause stops dispatching but never kills running processes (D34).
//! restart maps running/post → stopped, fetching → queued (D35).

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex as StdMutex};

use serde::Serialize;
use tauri::Emitter;
use tokio::sync::{mpsc, Mutex as TokioMutex};

use crate::engine::args::{build_download_argv, CookieKind, JobOptions, PlaylistMode};
use crate::engine::parser::{parse_line, ParsedLine};
use crate::engine::process;
use crate::error::{other, AppResult};
use crate::store::{archive_append, archive_contains, default_archive_path, Db, JobRow};

/// directory holding the app-managed ffmpeg (§4). passed to yt-dlp via
/// `--ffmpeg-location` — the managed copy is not on PATH.
fn ffmpeg_dir() -> Option<String> {
    let dir = crate::binaries::manager::bin_dir().join("ffmpeg.exe");
    dir.is_file()
        .then(|| dir.parent().map(|p| p.to_string_lossy().into_owned()))
        .flatten()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum JobState {
    Queued,
    Fetching,
    Downloading,
    Post,
    Done,
    Stopped,
    Error,
    /// resolved identity already queued/running or archived — no work done.
    Duplicate,
}

impl JobState {
    pub fn as_str(self) -> &'static str {
        match self {
            JobState::Queued => "queued",
            JobState::Fetching => "fetching",
            JobState::Downloading => "downloading",
            JobState::Post => "post",
            JobState::Done => "done",
            JobState::Stopped => "stopped",
            JobState::Error => "error",
            JobState::Duplicate => "duplicate",
        }
    }

    fn from_str(s: &str) -> Self {
        match s {
            "fetching" => JobState::Fetching,
            "downloading" => JobState::Downloading,
            "post" => JobState::Post,
            "done" => JobState::Done,
            "stopped" => JobState::Stopped,
            "error" => JobState::Error,
            "duplicate" => JobState::Duplicate,
            _ => JobState::Queued,
        }
    }

    /// remove ✕ is allowed for queued/stopped/error/done (§6: "while
    /// downloading: stop first, then remove").
    pub fn is_removable(state: &str) -> bool {
        !matches!(state, "downloading" | "post")
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Job {
    pub id: String,
    pub url: String,
    pub state: JobState,
    pub title: Option<String>,
    pub format: Option<String>,
    pub final_path: Option<String>,
    pub pct: Option<f64>,
    pub speed_bps: Option<f64>,
    pub eta_sec: Option<u64>,
    pub error: Option<String>,
    pub skipped: bool,
    /// playlist progress (D33): items done / total. null = single video or
    /// no counter line seen yet.
    pub items_done: Option<u32>,
    pub items_total: Option<u32>,
    /// recent output lines for the expandable row (§6).
    pub output: Vec<String>,
    pub created_at: i64,
}

impl Job {
    fn from_row(row: &JobRow, output: Vec<String>) -> Self {
        Job {
            id: row.id.clone(),
            url: url_of_options(&row.options),
            state: JobState::from_str(&row.state),
            title: row.title.clone(),
            format: row.format.clone(),
            final_path: row.final_path.clone(),
            pct: row.pct,
            speed_bps: row.speed_bps,
            eta_sec: row.eta_sec,
            error: row.error.clone(),
            skipped: row.skipped,
            items_done: row.items_done,
            items_total: row.items_total,
            output,
            created_at: row.created_at,
        }
    }
}

/// the options json embeds the url under "url" (stored alongside composer
/// options so a retry re-runs the same job; D19: with current settings at
/// re-download time, which the composer supplies fresh).
fn options_with_url(opts: &JobOptions, url: &str) -> String {
    let mut v = serde_json::to_value(opts).unwrap_or(serde_json::Value::Null);
    if let serde_json::Value::Object(map) = &mut v {
        map.insert("url".into(), serde_json::Value::String(url.to_owned()));
    }
    serde_json::to_string(&v).unwrap_or_else(|_| "{}".into())
}

fn url_of_options(options: &str) -> String {
    serde_json::from_str::<serde_json::Value>(options)
        .ok()
        .and_then(|v| v.get("url").and_then(|u| u.as_str()).map(str::to_owned))
        .unwrap_or_default()
}

fn options_of(options: &str) -> JobOptions {
    serde_json::from_str(options).unwrap_or_default()
}

/// d88: the retry row mutation, pure so it is testable without an app
/// handle. state machine reset + the options/dest swap (url preserved from
/// the old options json — retry never changes what is downloaded, only how
/// and where). title is deliberately KEPT: the probe already paid for it
/// and the row keeps its name while it waits to dispatch again.
fn apply_retry_to_row(row: &mut JobRow, opts: &JobOptions, dest: &str) {
    row.options = options_with_url(opts, &url_of_options(&row.options));
    row.dest = dest.to_owned();
    row.state = "queued".into();
    row.pct = None;
    row.speed_bps = None;
    row.eta_sec = None;
    row.format = None;
    row.final_path = None;
    row.skipped = false;
    row.items_done = None;
    row.items_total = None;
    row.error = None;
    row.updated_at = crate::store::now_unix();
}

// ---------------------------------------------------------------------------
// queue
// ---------------------------------------------------------------------------

struct QueueInner {
    paused: bool,
    concurrency: usize,
    /// stop-channel per running job.
    running: HashMap<String, mpsc::UnboundedSender<()>>,
    /// resolved `<extractor> <id>` identities of queued+running jobs (D37).
    identities: HashSet<String>,
    /// normalized urls currently queued/running (add-time dedupe).
    urls: HashSet<String>,
}

/// add_urls feedback: (queued jobs, invalid (line, reason) pairs, dupes).
pub type AddFeedbackParts = (Vec<Job>, Vec<(String, String)>, usize);

pub struct JobQueue {
    app: tauri::AppHandle,
    db: Arc<Db>,
    inner: StdMutex<QueueInner>,
    /// rolling log lines per job, capped (memory only; the db keeps state).
    logs: StdMutex<HashMap<String, Vec<String>>>,
    dispatcher_alive: AtomicBool,
    /// managed yt-dlp path (M2 integration), refreshed per resolve.
    yt_dlp_path: TokioMutex<Option<PathBuf>>,
}

impl JobQueue {
    pub fn new(app: tauri::AppHandle, db: Arc<Db>) -> Arc<Self> {
        let concurrency = crate::settings::load().concurrency.unwrap_or(2).max(1) as usize;
        let q = Arc::new(JobQueue {
            app,
            db,
            inner: StdMutex::new(QueueInner {
                paused: false,
                concurrency,
                running: HashMap::new(),
                identities: HashSet::new(),
                urls: HashSet::new(),
            }),
            logs: StdMutex::new(HashMap::new()),
            dispatcher_alive: AtomicBool::new(false),
            yt_dlp_path: TokioMutex::new(None),
        });
        q.start_dispatcher();
        q
    }

    // ----- introspection for commands -----

    pub fn list(&self) -> AppResult<Vec<Job>> {
        let rows = self.db.list_jobs()?;
        let logs = self.logs.lock().expect("logs lock");
        Ok(rows
            .iter()
            .map(|r| {
                let out = logs.get(&r.id).cloned().unwrap_or_default();
                Job::from_row(r, out)
            })
            .collect())
    }

    pub fn is_paused(&self) -> bool {
        self.inner.lock().expect("queue lock").paused
    }

    /// (active, queued) for the tab-bar engine status (§6 chrome, D25).
    pub fn counts(&self) -> (usize, usize) {
        let inner = self.inner.lock().expect("queue lock");
        let queued = inner.urls.len().saturating_sub(inner.running.len());
        (inner.running.len(), queued)
    }

    // ----- add (§5.2 lenient intake, D28) -----

    /// returns (queued jobs, invalid lines with reasons, duplicates skipped).
    /// url-level dedupe at add time; identity-level dedupe at fetch (D37).
    pub fn add_urls(
        &self,
        urls: &[String],
        opts: &JobOptions,
        dest: &str,
    ) -> AppResult<AddFeedbackParts> {
        let mut jobs = Vec::new();
        let mut invalid = Vec::new();
        let mut dupes = 0usize;
        let now = crate::store::now_unix();

        for raw in urls {
            match normalize_url(raw) {
                NormalizeResult::Blank => {}
                NormalizeResult::Invalid { line, reason } => invalid.push((line, reason)),
                NormalizeResult::Ok(url) => {
                    let is_dup = {
                        let mut inner = self.inner.lock().expect("queue lock");
                        if inner.urls.contains(&url) {
                            true
                        } else {
                            inner.urls.insert(url.clone());
                            false
                        }
                    };
                    if is_dup {
                        dupes += 1;
                        continue;
                    }

                    let seq = jobs.len() + invalid.len() + dupes;
                    // id must be unique across batches: j<unix>-<seq> alone
                    // collides when two add_urls calls land in the same
                    // second — the db insert then fails and the url stays
                    // marked in `inner.urls` forever (an un-retryable ghost
                    // "duplicate"). add a per-batch counter.
                    static BATCH: std::sync::atomic::AtomicU64 =
                        std::sync::atomic::AtomicU64::new(0);
                    let batch = BATCH.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                    let id = format!("j{now}-{batch:06}-{seq:06}");
                    let row = JobRow {
                        id: id.clone(),
                        options: options_with_url(opts, &url),
                        dest: dest.to_owned(),
                        state: "queued".into(),
                        title: None,
                        format: None,
                        final_path: None,
                        vid: None,
                        pct: None,
                        speed_bps: None,
                        eta_sec: None,
                        error: None,
                        skipped: false,
                        items_done: None,
                        items_total: None,
                        created_at: now,
                        updated_at: now,
                    };
                    self.db.insert_job(&row)?;
                    jobs.push(Job::from_row(&row, Vec::new()));
                }
            }
        }

        self.emit_queue_changed();
        Ok((jobs, invalid, dupes))
    }

    // ----- lifecycle (§6) -----

    /// stop ■: kill the child, keep .part files → Stopped (D31).
    pub fn stop(&self, id: &str) -> AppResult<()> {
        let tx = self
            .inner
            .lock()
            .expect("queue lock")
            .running
            .get(id)
            .cloned();
        if let Some(tx) = tx {
            let _ = tx.send(());
            Ok(())
        } else {
            Err(other("job is not running"))
        }
    }

    /// retry ↻ (stopped/error) with the user's CURRENT composer options and
    /// destination (d88). the old behavior re-queued the job's frozen options
    /// json — counterintuitive: toggling cookies or changing the format, then
    /// pressing retry, silently repeated the failed attempt verbatim. the
    /// frontend passes the live composer state here; retry therefore means
    /// "queue this url again, exactly as queueing it now would".
    ///
    /// destination swap: the ORIGINAL destination's partial artifacts (.part/
    /// .ytdl) are swept so the abandoned folder keeps no dead anchor; the
    /// finished file there is never touched (the user moved, not deleted —
    /// deleting a finished download is an explicit history action).
    /// title/format/pct reset with the state machine; the archive is not
    /// consulted here — run_job's own pre-check/yt-dlp archive semantics
    /// apply unchanged on the new attempt.
    pub fn retry_with_options(&self, id: &str, opts: &JobOptions, dest: &str) -> AppResult<()> {
        let mut rows = self.db.list_jobs()?;
        let Some(row) = rows.iter_mut().find(|r| r.id == id) else {
            return Err(other("no such job"));
        };
        if !matches!(row.state.as_str(), "stopped" | "error") {
            return Err(other("only stopped or error jobs can be retried"));
        }
        let old_dest = row.dest.clone();
        apply_retry_to_row(row, opts, dest);
        // d88: the old destination must not keep this job's stale download
        // anchor once the job re-points elsewhere. vid may not be known (the
        // job died during fetch) — no marker, nothing to sweep, no harm.
        if let Some(vid) = &row.vid {
            let old = std::path::Path::new(&old_dest);
            if old.is_dir() && old != std::path::Path::new(dest) {
                crate::store::sweep_job_artifacts(old, vid, true, true);
            }
        }
        self.db.update_job(id, row)?;
        self.emit_queue_changed();
        Ok(())
    }

    /// remove ✕: queued/stopped/error/done → drop entry. never touches
    /// files, history, or archive (§6). while downloading: stop first.
    pub fn remove(&self, id: &str) -> AppResult<()> {
        let rows = self.db.list_jobs()?;
        let Some(row) = rows.iter().find(|r| r.id == id) else {
            return Err(other("no such job"));
        };
        if !JobState::is_removable(&row.state) {
            return Err(other("stop the job before removing it"));
        }
        let url = url_of_options(&row.options);
        self.db.delete_job(id)?;
        self.logs.lock().expect("logs lock").remove(id);
        let mut inner = self.inner.lock().expect("queue lock");
        inner.running.remove(id);
        inner.urls.remove(&url);
        drop(inner);
        self.emit_queue_changed();
        Ok(())
    }

    /// queue pause (D34): dispatcher stops starting new items; running
    /// processes keep running.
    pub fn pause(&self) {
        self.inner.lock().expect("queue lock").paused = true;
        self.emit_queue_changed();
    }

    pub fn resume(&self) {
        self.inner.lock().expect("queue lock").paused = false;
        self.emit_queue_changed();
    }

    pub fn set_concurrency(&self, n: usize) {
        self.inner.lock().expect("queue lock").concurrency = n.max(1);
    }

    /// managed yt-dlp path, refreshed before each resolve (M2 integration).
    pub async fn refresh_yt_dlp_path(&self) {
        let m = crate::binaries::manager::load_manifest().ok();
        let p = m.and_then(|m| {
            crate::binaries::manager::resolve_tool_path(&m, crate::binaries::sources::Tool::YtDlp)
        });
        *self.yt_dlp_path.lock().await = p;
    }

    // ----- dispatcher -----

    fn start_dispatcher(self: &Arc<Self>) {
        if self.dispatcher_alive.swap(true, Ordering::SeqCst) {
            return;
        }
        let q = Arc::clone(self);
        // tauri's global runtime, NOT bare tokio::spawn: the dispatcher is
        // started from JobQueue::new inside the tauri setup hook, which runs
        // on the main thread outside any tokio reactor context — a bare
        // tokio::spawn panics there ("no reactor running") and killed the
        // app on launch. found by the e2e checklist run (2026-09-03).
        tauri::async_runtime::spawn(async move {
            loop {
                tokio::time::sleep(std::time::Duration::from_millis(150)).await;
                let next = {
                    let inner = q.inner.lock().expect("queue lock");
                    if inner.paused || inner.running.len() >= inner.concurrency {
                        None
                    } else {
                        // oldest queued first (insertion order, §6 default)
                        q.db.list_jobs()
                            .ok()
                            .and_then(|rows| rows.into_iter().find(|r| r.state == "queued"))
                            .map(|r| (r.id, r.options, r.dest))
                    }
                };
                if let Some((id, options, dest)) = next {
                    let q2 = Arc::clone(&q);
                    let (tx, rx) = mpsc::unbounded_channel();
                    q.inner
                        .lock()
                        .expect("queue lock")
                        .running
                        .insert(id.clone(), tx);
                    tokio::spawn(async move {
                        q2.run_job(id, options, dest, rx).await;
                    });
                }
            }
        });
    }

    // ----- job execution -----

    async fn run_job(
        &self,
        id: String,
        options_json: String,
        dest: String,
        mut stop_rx: mpsc::UnboundedReceiver<()>,
    ) {
        let opts = options_of(&options_json);
        let url = url_of_options(&options_json);

        // ---- fetching: resolve identity (D44 — --print only, never -J) ----
        // d61: the fetch phase gets a watchdog (90 s) and live stderr — a
        // bot-gate or geo-block becomes visible within seconds instead of a
        // frozen "fetching" row with no feedback.
        self.set_state(&id, JobState::Fetching).await;
        self.refresh_yt_dlp_path().await;

        let yt_dlp = self.yt_dlp_path().await;
        // "resolving… Ns" ticker: a lightweight per-second job:update while
        // the probe runs, so the row shows liveness. aborted the moment the
        // resolve settles (either branch).
        let fetch_started = std::time::Instant::now();
        let ticker = {
            let app = self.app.clone();
            let tid = id.clone();
            tokio::spawn(async move {
                loop {
                    tokio::time::sleep(std::time::Duration::from_secs(1)).await;
                    let _ = app.emit(
                        "job:update",
                        serde_json::json!({
                            "id": tid, "state": "fetching",
                            "fetchMs": fetch_started.elapsed().as_millis() as u64,
                        }),
                    );
                }
            })
        };
        let identity = tokio::select! {
            // d61: 90 s watchdog — a wedged probe (stalled socket, hung
            // extractor) must never freeze a row in "fetching" forever. the
            // kill_on_drop child dies with the future; the error reads like
            // a human message, not a timeout stack.
            r = tokio::time::timeout(
                std::time::Duration::from_secs(FETCH_WATCHDOG_SECS),
                resolve_identity(yt_dlp.as_deref(), &url, &opts, |line: &str| {
                    // d61: the probe's stderr streams live into the expando —
                    // this is where yt-dlp explains a blocked url.
                    self.push_log(&id, line.to_owned());
                    let _ = self.app.emit(
                        "job:log",
                        serde_json::json!({ "id": id, "line": line, "kind": "info" }),
                    );
                }),
            ) => {
                match r {
                    Ok(res) => res,
                    Err(_) => Err(other(format!(
                        "could not resolve the url within {FETCH_WATCHDOG_SECS} s — check the url and your connection"
                    ))),
                }
            }
            _ = stop_rx.recv() => {
                ticker.abort();
                self.finalize(&id, JobState::Stopped, Some("stopped by user".into())).await;
                self.cleanup_running(&id, &url, None);
                return;
            }
        };
        ticker.abort();

        let identity = match identity {
            Ok(i) => i,
            Err(e) => {
                // finalize() pushes the message into the job's log buffer, so
                // the expando carries the reason once the frontend pulls
                // queue_list (the store reloads on terminal job:update —
                // found by the e2e checklist, S12). fetch-phase errors get
                // the same rewrites as run-phase errors (the cookie decrypt
                // failure surfaces HERE, during the identity probe).
                let msg = rewrite_cookie_error(&rewrite_botgate_error(&e.to_string()));
                self.finalize(&id, JobState::Error, Some(msg)).await;
                self.cleanup_running(&id, &url, None);
                return;
            }
        };

        // ---- dedupe (D18/D37) + archive skip (D17/D41) ----
        // the key drives dedupe and the archive; the identity itself stays
        // alive for the history write and the probe title (D54).
        let identity_key: Option<String> = identity.as_ref().map(|i| i.key());

        // d88: persist the resolved id on the row as soon as it is known —
        // retry's old-destination sweep and finalize's sidecar sweep are both
        // keyed on it, and both must work even if the job dies later (stop,
        // crash, fetch error on a later attempt).
        if let Some(key) = &identity_key {
            if key
                .split_once(' ')
                .map(|(_, v)| !v.is_empty())
                .unwrap_or(false)
            {
                let vid = key.split_once(' ').map(|(_, v)| v.to_owned());
                let mut row = self.row(&id);
                if row.vid.is_none() {
                    row.vid = vid;
                    row.updated_at = crate::store::now_unix();
                    self.save_row(&row);
                }
            }
        }

        if let Some(key) = &identity_key {
            // lock scope is minimal — no awaits while the guard lives
            let duplicate = {
                let mut inner = self.inner.lock().expect("queue lock");
                if inner.identities.contains(key) {
                    true
                } else {
                    inner.identities.insert(key.clone());
                    false
                }
            };
            if duplicate {
                self.finalize(
                    &id,
                    JobState::Duplicate,
                    Some("duplicate — already queued/running".into()),
                )
                .await;
                self.cleanup_running(&id, &url, None);
                return;
            }

            // pre-check the archive for single-video jobs only (D53, D54):
            // playlist ids never appear in the archive, so checking them is
            // meaningless — within-playlist skipping is yt-dlp's native
            // --download-archive behavior.
            let is_playlist = identity.as_ref().is_some_and(|i| i.is_playlist);
            if !is_playlist && archive_precheck_applies(opts.skip_downloaded, opts.overwrite) {
                // d91: an explicit overwrite grant (or a d63 force
                // re-download, which carries both flags) must not be
                // second-guessed by the archive pre-check — the user just
                // confirmed they want a fresh download. the archive-append
                // below stays idempotent either way, so the archive never
                // drifts.
                let (ex, vid) = key.split_once(' ').expect("identity key shape");
                let arch = default_archive_path();
                if archive_contains(&arch, ex, vid) {
                    self.push_log(&id, "already downloaded — skipping (archive)".into());
                    let mut row = self.row(&id);
                    row.state = "done".into();
                    row.skipped = true;
                    row.error = Some("already in downloaded archive".into());
                    row.updated_at = crate::store::now_unix();
                    self.save_row(&row);
                    self.emit_update(&row);
                    self.cleanup_running(&id, &url, Some(key));
                    self.emit_queue_changed();
                    return;
                }
            }

            // D45: the probe title is the earliest reliable display name —
            // surface it immediately (download output only carries titles in
            // verbose mode, so until now jobs showed their url).
            if let Some(t) = identity.as_ref().and_then(|i| i.title.clone()) {
                let mut row = self.row(&id);
                if row.title.is_none() {
                    row.title = Some(t);
                    row.updated_at = crate::store::now_unix();
                    self.save_row(&row);
                    let _ = self.app.emit(
                        "job:update",
                        serde_json::json!({ "id": id, "state": "fetching", "title": row.title }),
                    );
                }
            }

            // d89: no engine-side overwrite REFUSAL here, deliberately. a
            // hard gate would over-ask: the "* [<id>].*" match is an
            // over-approximation (a queue for the webm container would be
            // refused because an .opus sibling exists), and yt-dlp itself
            // never overwrites without --force-overwrites. instead the skip
            // is REVEALED: the done branch marks the row skipped with an
            // actionable message when yt-dlp's "has already been downloaded"
            // skip fired without explicit overwrite consent — no silent
            // done-with-no-bytes-moved rows (D62), no blocked container
            // changes. the composer's D60 dialog remains the consent surface.
        }

        // ---- downloading ----
        // the archive is passed even when the identity is known-new: within
        // a playlist job yt-dlp itself skips ids the archive already holds
        // (D41 — a half-downloaded playlist resumes where it left off).
        let archive_flag: Option<String> = if opts.skip_downloaded {
            Some(default_archive_path().to_string_lossy().into_owned())
        } else {
            None
        };
        let mut argv = match build_download_argv(
            &opts,
            &url,
            &dest,
            archive_flag.as_deref(),
            ffmpeg_dir().as_deref(),
        ) {
            Ok(a) => a,
            Err(e) => {
                self.finalize(&id, JobState::Error, Some(e.to_string()))
                    .await;
                self.cleanup_running(&id, &url, identity_key.as_deref());
                return;
            }
        };
        if let Some(p) = self.yt_dlp_path().await {
            argv[0] = p.to_string_lossy().into_owned();
        }

        self.set_state(&id, JobState::Downloading).await;
        let outcome = self.spawn_and_stream(&id, &argv, &mut stop_rx).await;

        // ---- finalize ----
        match outcome {
            RunOutcome::Stopped => {
                self.finalize(
                    &id,
                    JobState::Stopped,
                    Some("stopped by user — partial files kept".into()),
                )
                .await;
            }
            RunOutcome::Error(msg) => {
                let msg = rewrite_cookie_error(&rewrite_botgate_error(
                    &rewrite_skip_existing_error(&msg),
                ));
                self.finalize(&id, JobState::Error, Some(msg)).await;
            }
            RunOutcome::Done {
                final_path,
                title,
                items_done,
                items_total,
                skipped_existing,
            } => {
                // d62: done means evidence. the after_move:filepath print can
                // be swallowed (hostile titles defeat any heuristic; custom
                // templates may not print it) — recover the target by scanning
                // the destination for the resolved `[<id>]` marker before the
                // history write, so a completed download can never land as a
                // metadata-less ghost row.
                let is_playlist = identity.as_ref().is_some_and(|i| i.is_playlist);
                // d86: the printed after_move:filepath goes through the
                // child's stdio — before utf-8 mode it could not carry
                // non-ascii and delivered mangled text (the filename on disk
                // was always correct; windows file APIs are wide). a mangled
                // "final" path pointing at nothing is worse than none, so
                // verify the print against the filesystem; the id-marker
                // recovery scan below still applies to single videos.
                let final_path = final_path.filter(|p| std::path::Path::new(p).exists());
                let final_path = if is_playlist || final_path.is_some() {
                    final_path
                } else {
                    let dest = self.row(&id).dest;
                    let recovered = identity_key
                        .as_deref()
                        .and_then(|k| k.split_once(' ').map(|(_, vid)| vid))
                        .and_then(|vid| find_final_path_by_id(&dest, vid));
                    if let Some(p) = &recovered {
                        self.push_log(
                            &id,
                            format!("final path recovered from destination scan: {p}"),
                        );
                    }
                    recovered
                };
                // playlist display title comes from the resolve probe (the
                // download output's own title lines don't cover playlists)
                let title = title.or_else(|| identity.as_ref().and_then(|i| i.title.clone()));
                // engine archive-write rule (§5.2): the engine appends
                // `<extractor> <id>` itself after success — idempotent, so
                // archive/history/file can't drift when yt-dlp errors late.
                // playlist jobs are exempt (D54): the playlist id is not an
                // archive entry (yt-dlp wrote the per-item ids itself via
                // --download-archive) and one history row can't represent
                // every item.
                if let (Some(key), false) = (&identity_key, is_playlist) {
                    if let Some((ex, vid)) = key.split_once(' ') {
                        if let Err(e) = archive_append(&default_archive_path(), ex, vid) {
                            self.push_log(&id, format!("archive write failed: {e}"));
                        }
                        // history metadata write (§5.3). d45: duration/size
                        // are recovered at runtime from the finished file via
                        // the app-managed ffprobe (no network, 5s cap, all
                        // failures → None); format is the file's own
                        // extension (ffprobe's format_name is a muxer
                        // registry, not what the user got).
                        let meta = match &final_path {
                            Some(p) => tokio::time::timeout(
                                std::time::Duration::from_secs(8),
                                crate::engine::probe::probe_file(std::path::Path::new(p)),
                            )
                            .await
                            .unwrap_or(None),
                            None => None,
                        };
                        let h = crate::store::HistoryRow {
                            extractor: ex.to_owned(),
                            vid: vid.to_owned(),
                            url: Some(url.clone()),
                            title: title.clone().or_else(|| self.row(&id).title),
                            channel: None,
                            duration_sec: meta.as_ref().and_then(|m| m.duration_sec).map(i64::from),
                            size_bytes: meta
                                .as_ref()
                                .and_then(|m| m.size_bytes)
                                .and_then(|v| i64::try_from(v).ok()),
                            format: final_path
                                .as_deref()
                                .and_then(crate::engine::probe::format_label),
                            final_path: final_path.clone(),
                            error: None,
                            downloaded_at: crate::store::now_unix(),
                        };
                        if let Err(e) = self.db.upsert_history(&h) {
                            self.push_log(&id, format!("history write failed: {e}"));
                        }
                    }
                }
                let mut row = self.row(&id);
                row.state = "done".into();
                row.pct = Some(100.0);
                row.speed_bps = None;
                row.eta_sec = None;
                // final playlist counts (D33) — write them unconditionally so
                // the throttled db flush can never lose the last item. on an
                // exit-0 playlist run every selected item was processed
                // (downloaded or archive-skipped — item failures exit
                // non-zero), so the done-count closes to the total; this also
                // repairs the all-skipped case where skips produce no
                // parsable per-item lines (e2e find, 2026-09-03).
                if is_playlist {
                    if let Some(total) = items_total.or(row.items_total) {
                        row.items_total = Some(total);
                        row.items_done = Some(total);
                        if items_done.unwrap_or(0) == 0 {
                            self.push_log(
                                &id,
                                format!("all {total} items were already in the archive"),
                            );
                        }
                    }
                } else {
                    row.items_done = items_done.or(row.items_done);
                    row.items_total = items_total.or(row.items_total);
                }
                if final_path.is_some() {
                    row.final_path = final_path;
                }
                if row.title.is_none() {
                    row.title = title;
                }
                // d89: reveal the file-exists skip — done must never pretend
                // bytes moved (D62). the composer's D60 dialog is the consent
                // surface; when a queue lands here anyway (probe raced out,
                // api path, container change), the row says so and names the
                // exact recourse instead of a silent no-op.
                if skipped_existing && !is_playlist && !opts.overwrite {
                    row.skipped = true;
                    row.error = Some(
                        "already downloaded — file left as-is. to replace it: open history and press ↻ (re-download), or delete the existing file first".into(),
                    );
                    self.push_log(
                        &id,
                        "yt-dlp skipped the download: the target file already exists (D89)".into(),
                    );
                }
                row.updated_at = crate::store::now_unix();
                self.save_row(&row);
                self.emit_update(&row);
                // d85: finalize() fires queue:changed but the done path didn't
                // — a frontend that missed the job:update burst (laptop sleep,
                // webview stall) kept a stale "fetching" row forever, because
                // nothing ever asked it to re-pull. same belt-and-braces as
                // the other terminal paths.
                self.emit_queue_changed();
            }
        }
        self.cleanup_running(&id, &url, identity_key.as_deref());
    }

    /// spawn yt-dlp, stream lines, drive per-job state; returns the outcome.
    async fn spawn_and_stream(
        &self,
        id: &str,
        argv: &[String],
        stop_rx: &mut mpsc::UnboundedReceiver<()>,
    ) -> RunOutcome {
        let mut child = match process::spawn(argv) {
            Ok(c) => c,
            Err(e) => return RunOutcome::Error(format!("spawn failed: {e}")),
        };
        let mut rx = match process::stream_lines(&mut child) {
            Ok(r) => r,
            Err(e) => {
                let _ = child.kill().await;
                return RunOutcome::Error(format!("stream failed: {e}"));
            }
        };

        let mut last_error: Option<String> = None;
        let mut final_path: Option<String> = None;
        let mut title: Option<String> = None;
        let mut last_emit = std::time::Instant::now();
        let mut last_db = std::time::Instant::now();
        // playlist progress (D54): total from the counter line; items done
        // counted from per-item COMPLETIONS (after_move:filepath prints once
        // per downloaded item — verified live 2026-09; item-start lines don't
        // exist for downloads) plus archive-skipped items. count in a local
        // set of ids so the 200ms emit-throttle can't double-count.
        let mut items_done: u32 = 0;
        let mut items_total: Option<u32> = None;
        let mut seen_items: std::collections::HashSet<String> = std::collections::HashSet::new();
        let mut last_items_db = std::time::Instant::now();
        // d89: single-job file-exists skip — yt-dlp prints "has already been
        // downloaded" and exits 0 without touching the file. (playlist skips
        // are per-item truth and flow through PlaylistSkip instead.)
        let mut skipped_existing = false;

        loop {
            tokio::select! {
                _ = stop_rx.recv() => {
                    child.kill().await;
                    return RunOutcome::Stopped;
                }
                line = rx.recv() => {
                    let Some((_is_stdout, raw)) = line else {
                        // both streams closed — reap the exit status
                        let status = child.inner.wait().await;
                        let items_done = (items_done > 0).then_some(items_done);
                        return match status {
                            Ok(s) if s.success() => RunOutcome::Done {
                                final_path,
                                title,
                                items_done,
                                items_total,
                                skipped_existing,
                            },
                            Ok(s) => RunOutcome::Error(
                                last_error.unwrap_or_else(|| format!("yt-dlp exited with {s}")),
                            ),
                            Err(e) => RunOutcome::Error(format!("wait failed: {e}")),
                        };
                    };

                    // expando row (§6) — every line, capped; frontend mirrors it
                    let kind = crate::engine::parser::classify(&raw);
                    self.push_log(id, raw.clone());
                    if raw.contains("has already been downloaded") {
                        skipped_existing = true;
                    }
                    let _ = self.app.emit(
                        "job:log",
                        serde_json::json!({ "id": id, "line": raw, "kind": kind }),
                    );

                    match parse_line(&raw) {
                        ParsedLine::Progress { downloaded, total, total_estimate, speed_bps, eta_sec } => {
                            // d92: exact total wins, then the estimate — one of
                            // the two is always NA (site-dependent), so this
                            // covers both families.
                            let effective_total = total.or(total_estimate);
                            let pct = match (downloaded, effective_total) {
                                (d, Some(t)) if t > 0 => Some((d as f64 / t as f64) * 100.0),
                                _ => None,
                            };
                            if last_emit.elapsed().as_millis() >= 200 {
                                last_emit = std::time::Instant::now();
                                let _ = self.app.emit(
                                    "job:update",
                                    serde_json::json!({
                                        "id": id, "state": "downloading",
                                        "pct": pct, "speedBps": speed_bps, "etaSec": eta_sec,
                                    }),
                                );
                            }
                            if last_db.elapsed().as_millis() >= 500 {
                                last_db = std::time::Instant::now();
                                let mut row = self.row(id);
                                row.pct = pct;
                                row.speed_bps = speed_bps;
                                row.eta_sec = eta_sec;
                                row.updated_at = crate::store::now_unix();
                                self.save_row(&row);
                            }
                        }
                        ParsedLine::ProgressPercent(p) => {
                            if last_emit.elapsed().as_millis() >= 200 {
                                last_emit = std::time::Instant::now();
                                let _ = self.app.emit(
                                    "job:update",
                                    serde_json::json!({ "id": id, "state": "downloading", "pct": p }),
                                );
                            }
                        }
                        ParsedLine::Title(t) => {
                            title = Some(t.clone());
                            let _ = self.app.emit(
                                "job:update",
                                serde_json::json!({ "id": id, "state": "downloading", "title": t }),
                            );
                        }
                        ParsedLine::FinalPath(p) => {
                            // one print per downloaded item → playlist item
                            // completion (D54). single videos overwrite
                            // harmlessly; playlists accumulate per item.
                            if seen_items.insert(p.clone()) {
                                final_path = Some(p);
                                items_done = items_done.saturating_add(1);
                                if last_emit.elapsed().as_millis() >= 200 {
                                    last_emit = std::time::Instant::now();
                                    let _ = self.app.emit(
                                        "job:update",
                                        serde_json::json!({
                                            "id": id, "state": "downloading",
                                            "itemsDone": items_done, "itemsTotal": items_total,
                                        }),
                                    );
                                }
                            }
                        }
                        ParsedLine::PlaylistItemIndex { total, .. } => {
                            // per-item print (e2e find, 2026-09-03): sets the
                            // effective total (n_entries, already clamped for
                            // first-n). fires BEFORE each item's completion, so
                            // NO count reset here — that would zero done items
                            // on every new item.
                            if items_total != Some(total) {
                                items_total = Some(total);
                                let _ = self.app.emit(
                                    "job:update",
                                    serde_json::json!({
                                        "id": id, "state": "downloading",
                                        "itemsDone": items_done, "itemsTotal": total,
                                    }),
                                );
                            }
                        }
                        ParsedLine::PlaylistTotal { total } => {
                            // playlist-level print: the FIRST total signal, and
                            // the only one when every item is archive-skipped
                            // (pre_process doesn't fire for skips). __I__
                            // refines per item, so never clobber a refined value.
                            if items_total.is_none() {
                                items_total = Some(total);
                                let _ = self.app.emit(
                                    "job:update",
                                    serde_json::json!({
                                        "id": id, "state": "downloading",
                                        "itemsDone": items_done, "itemsTotal": total,
                                    }),
                                );
                            }
                        }
                        ParsedLine::PlaylistSkip { .. } => {
                            // archive-skipped items count as processed (D54)
                            items_done = items_done.saturating_add(1);
                            if last_emit.elapsed().as_millis() >= 200 {
                                last_emit = std::time::Instant::now();
                                let _ = self.app.emit(
                                    "job:update",
                                    serde_json::json!({
                                        "id": id, "state": "downloading",
                                        "itemsDone": items_done, "itemsTotal": items_total,
                                    }),
                                );
                            }
                            if last_items_db.elapsed().as_millis() >= 500 {
                                last_items_db = std::time::Instant::now();
                                let mut row = self.row(id);
                                row.items_done = Some(items_done);
                                row.items_total = items_total;
                                row.updated_at = crate::store::now_unix();
                                self.save_row(&row);
                            }
                        }
                        ParsedLine::Destination(_) | ParsedLine::ItemStart { .. } => {}
                        ParsedLine::Stage("post") => {
                            self.set_state(id, JobState::Post).await;
                        }
                        ParsedLine::Stage(_) => {}
                        ParsedLine::Error(e) => {
                            last_error = Some(e);
                        }
                        ParsedLine::Line(_) => {}
                    }
                }
            }
        }
    }

    // ----- helpers -----

    async fn yt_dlp_path(&self) -> Option<PathBuf> {
        self.yt_dlp_path.lock().await.clone()
    }

    fn row(&self, id: &str) -> JobRow {
        self.db
            .list_jobs()
            .ok()
            .and_then(|rows| rows.into_iter().find(|r| r.id == id))
            .unwrap_or_else(|| JobRow {
                id: id.to_owned(),
                options: "{}".into(),
                dest: String::new(),
                state: "queued".into(),
                title: None,
                format: None,
                final_path: None,
                vid: None,
                pct: None,
                speed_bps: None,
                eta_sec: None,
                error: None,
                skipped: false,
                items_done: None,
                items_total: None,
                created_at: 0,
                updated_at: 0,
            })
    }

    fn save_row(&self, row: &JobRow) {
        let _ = self.db.update_job(&row.id, row);
    }

    async fn set_state(&self, id: &str, state: JobState) {
        let mut row = self.row(id);
        row.state = state.as_str().into();
        row.updated_at = crate::store::now_unix();
        self.save_row(&row);
        let _ = self.app.emit(
            "job:update",
            serde_json::json!({ "id": id, "state": state.as_str() }),
        );
        self.emit_queue_changed();
    }

    async fn finalize(&self, id: &str, state: JobState, msg: Option<String>) {
        // the log line MUST land before the event/reload: the frontend pulls
        // queue_list the moment it sees the terminal job:update, and a row
        // read between save_row and push_log showed an empty expando for
        // fetch-phase errors (s9, full-suite find 2026-09-04).
        if let Some(ref m) = msg {
            self.push_log(id, m.clone());
        }
        let mut row = self.row(id);
        row.state = state.as_str().into();
        row.error = msg.clone();
        row.speed_bps = None;
        row.eta_sec = None;
        row.updated_at = crate::store::now_unix();
        self.save_row(&row);
        // d88: postprocessor debris cleanup — after the row save (fresh vid
        // visible) and before the terminal event (the frontend pull must see
        // the post-sweep destination).
        self.sweep_terminal_sidecars(id);
        let _ = self.app.emit(
            "job:update",
            serde_json::json!({ "id": id, "state": state.as_str(), "error": msg }),
        );
        self.emit_queue_changed();
    }

    fn emit_update(&self, row: &JobRow) {
        let _ = self.app.emit(
            "job:update",
            serde_json::json!({
                "id": row.id, "state": row.state,
                "pct": row.pct, "title": row.title,
                "finalPath": row.final_path, "error": row.error,
            }),
        );
    }

    /// d88: after a terminal state, remove this job's thumbnail sidecars from
    /// the destination when a real target for the id exists beside them — a
    /// crashed/aborted postprocessor otherwise leaves `Title [vid].webp/png`
    /// debris forever (live-verified: a wav target errors in
    /// ThumbnailsConvertor AFTER writing both webp and png; the .wav itself
    /// stays and so does the debris). evidence rule: sweep only when a
    /// marker-matching non-image, non-partial file exists — otherwise there
    /// is no finished target and the images may be the only artifact.
    /// partials are deliberately KEPT: a stop can precede finalize, and an
    /// in-place retry must be able to resume them (yt-dlp contract).
    fn sweep_terminal_sidecars(&self, id: &str) {
        let row = self.row(id);
        let Some(vid) = row.vid.as_deref().filter(|v| !v.is_empty()) else {
            return;
        };
        let dest = std::path::Path::new(&row.dest);
        let marker = format!(" [{vid}]");
        let has_target = std::fs::read_dir(dest)
            .ok()
            .map(|rd| {
                rd.filter_map(|e| e.ok()).any(|e| {
                    let name = e.file_name().to_string_lossy().into_owned();
                    name.contains(&marker)
                        && !name.ends_with(".part")
                        && !name.ends_with(".ytdl")
                        && !name.ends_with(".temp")
                        && !name.ends_with(".webp")
                        && !name.ends_with(".png")
                        && !name.ends_with(".jpg")
                        && !name.ends_with(".jpeg")
                })
            })
            .unwrap_or(false);
        if has_target {
            crate::store::sweep_job_artifacts(dest, vid, false, true);
        }
    }

    fn cleanup_running(&self, id: &str, url: &str, identity: Option<&str>) {
        let mut inner = self.inner.lock().expect("queue lock");
        inner.running.remove(id);
        inner.urls.remove(url);
        if let Some(key) = identity {
            inner.identities.remove(key);
        }
        drop(inner);
        self.emit_queue_changed();
    }

    fn push_log(&self, id: &str, line: String) {
        let mut logs = self.logs.lock().expect("logs lock");
        let v = logs.entry(id.to_owned()).or_default();
        v.push(line);
        if v.len() > 500 {
            let drop = v.len() - 500;
            v.drain(0..drop);
        }
    }

    /// engine status event for the tab bar (§6 chrome, D25).
    pub fn emit_queue_changed(&self) {
        let (active, queued) = self.counts();
        let _ = self.app.emit(
            "queue:changed",
            serde_json::json!({ "active": active, "queued": queued }),
        );
    }
}

enum RunOutcome {
    Done {
        final_path: Option<String>,
        title: Option<String>,
        /// final playlist counts (D33) — flushed once at completion so the
        /// last item is never lost to the throttled 500 ms db write.
        items_done: Option<u32>,
        items_total: Option<u32>,
        /// d89: yt-dlp printed "has already been downloaded" — the run moved
        /// no bytes and left the existing file as-is.
        skipped_existing: bool,
    },
    Stopped,
    Error(String),
}

// ---------------------------------------------------------------------------
// url intake + identity resolve
// ---------------------------------------------------------------------------

#[derive(Debug)]
enum NormalizeResult {
    Blank,
    Invalid { line: String, reason: String },
    Ok(String),
}

/// §5.2 (D28): no host validation — intranet/localhost/vanity hosts must be
/// accepted. flag only obvious non-links: inner whitespace (paste accident)
/// or a single bare word with no dot (a scheme-less paste would still be a
/// valid intranet host with a dot, which we must accept).
fn normalize_url(raw: &str) -> NormalizeResult {
    let t = raw.trim();
    if t.is_empty() {
        return NormalizeResult::Blank;
    }
    if t.chars().any(char::is_whitespace) {
        return NormalizeResult::Invalid {
            line: t.to_owned(),
            reason: "not a url (paste one link per line)".into(),
        };
    }
    if t.starts_with("http://") || t.starts_with("https://") {
        return NormalizeResult::Ok(t.to_owned());
    }
    if !t.contains('.') {
        return NormalizeResult::Invalid {
            line: t.to_owned(),
            reason: "not a url".into(),
        };
    }
    NormalizeResult::Ok(format!("https://{t}"))
}

/// a resolved job identity (D18): `<extractor> <id>` is the key the archive,
/// history and queue-dedupe all share. playlist urls resolve to the
/// PLAYLIST's id (playlist_id), not the first item's — verified live
/// 2026-09: `--print %(id)s` on a playlist emits the first entry's id, which
/// would poison dedupe/history/archive for multi-item jobs.
#[derive(Debug, Clone)]
struct Identity {
    extractor: String,
    id: String,
    /// true when the url resolved as a playlist (playlist_id present).
    is_playlist: bool,
    /// display title from the probe (playlist title, or the video's title).
    title: Option<String>,
}

impl Identity {
    fn key(&self) -> String {
        format!("{} {}", self.extractor, self.id)
    }
}

/// resolve the job identity via `--print` only (D44: never -J at queue
/// time), no download. playlist urls probe with --flat-playlist (one entry
/// is enough — we only need the playlist id, not the entries).
/// d61: `on_stderr` receives every stderr line while the probe runs so the
/// ui can show why a fetch is slow (bot-gates print here within seconds).
async fn resolve_identity(
    yt_dlp: Option<&std::path::Path>,
    url: &str,
    opts: &JobOptions,
    on_stderr: impl FnMut(&str),
) -> AppResult<Option<Identity>> {
    let mut argv: Vec<String> = vec![
        yt_dlp
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_else(|| "yt-dlp".to_owned()),
        "--no-warnings".into(),
        "--skip-download".into(),
        "--flat-playlist".into(),
        "--print".into(),
        "%(extractor)s|%(playlist_id)s|%(id)s|%(playlist_title)s".into(),
        "--print".into(),
        "TITLE:%(title)s".into(),
    ];
    if opts.playlist_mode == PlaylistMode::Single {
        argv.push("--no-playlist".into());
    } else {
        // one entry is enough — playlist_id/playlist_title come on the first
        // line regardless; keeps the probe O(1) on huge playlists.
        argv.push("--playlist-items".into());
        argv.push("1".into());
    }
    // d84: cookies apply to the identity probe too — a bot-gated url without
    // cookies fails the FETCH with the auth wall before the download (which
    // would have carried the flag) ever runs. same flags, same source.
    match opts.cookies.kind {
        CookieKind::FromBrowser => {
            if let Some(browser) = opts.cookies.browser.as_deref() {
                argv.push("--cookies-from-browser".into());
                argv.push(browser.to_owned());
            }
        }
        CookieKind::File => {
            if let Some(file) = opts.cookies.file.as_deref() {
                argv.push("--cookies".into());
                argv.push(file.to_owned());
            }
        }
        CookieKind::None => {}
    }
    argv.push(url.to_owned());

    let mut child = process::spawn(&argv)?;
    let mut rx = process::stream_lines(&mut child)?;
    let mut resolved: Option<Identity> = None;
    let mut errored: Option<String> = None;
    let mut on_stderr = on_stderr;

    // first non-empty stdout line: `extractor|playlist_id|id|playlist_title`;
    // single videos add a second line `TITLE:<title>`.
    while resolved.is_none() {
        match rx.recv().await {
            Some((true, line)) => {
                let t = line.trim();
                if t.is_empty() {
                    continue;
                }
                let mut it = t.split('|');
                let ex = it.next().unwrap_or("").trim();
                let pl_id = it.next().unwrap_or("").trim();
                let vid = it.next().unwrap_or("").trim();
                let pl_title = it
                    .next()
                    .map(str::trim)
                    .filter(|s| !s.is_empty() && *s != "NA");
                if ex.is_empty() || vid.is_empty() {
                    continue;
                }
                let is_playlist = !pl_id.is_empty() && pl_id != "NA";
                let id = if is_playlist { pl_id } else { vid };
                let mut identity = Identity {
                    extractor: ex.to_owned(),
                    id: id.to_owned(),
                    is_playlist,
                    title: pl_title.map(str::to_owned),
                };
                // single videos carry their title on a second print line.
                // REGRESSION FIX (2026-09-08): the old code did a blocking
                // recv() here, trusting the TITLE: line to be the NEXT line.
                // print writes are line-buffered and stdout/stderr share the
                // merged channel — a stderr line can interleave, and the
                // block-recv then ATE the TITLE line and left the job
                // titleless ("fetching…" forever in the hover card). scan
                // forward instead, skipping stderr noise, under an absolute
                // 500 ms grace: the identity itself is already complete, so
                // a missing probe title only costs the display name (the
                // run-phase output still sets one).
                if !is_playlist {
                    let deadline =
                        std::time::Instant::now() + std::time::Duration::from_millis(500);
                    loop {
                        let now = std::time::Instant::now();
                        if now >= deadline {
                            break;
                        }
                        match tokio::time::timeout(deadline - now, rx.recv()).await {
                            Ok(Some((true, l2))) => {
                                if let Some(t2) = l2.trim().strip_prefix("TITLE:") {
                                    let t2 = t2.trim();
                                    if !t2.is_empty() && t2 != "NA" {
                                        identity.title = Some(t2.to_owned());
                                    }
                                    break;
                                }
                                // some other stdout line — keep scanning
                                // until TITLE, the deadline, or close
                            }
                            Ok(Some((false, _))) => continue, // stderr noise
                            Ok(None) => break,                // channel closed
                            Err(_) => break,                  // grace exhausted
                        }
                    }
                }
                resolved = Some(identity);
                break;
            }
            Some((false, line)) => {
                let t = line.trim();
                on_stderr(t);
                if t.starts_with("ERROR:") {
                    errored = Some(t.to_owned());
                    break;
                }
            }
            None => break,
        }
    }
    let _ = child.kill().await;
    let _ = child.inner.wait().await;

    match (resolved, errored) {
        (Some(i), _) => Ok(Some(i)),
        (None, Some(e)) => Err(other(e)),
        (None, None) => Err(other("could not resolve identity (no output from yt-dlp)")),
    }
}

/// d61: the fetch phase's watchdog. yt-dlp's own connect timeout can be ~20 s
/// per attempt across retries; 90 s covers slow-but-alive extractions while
/// guaranteeing no row can sit in "fetching" forever.
const FETCH_WATCHDOG_SECS: u64 = 90;

/// d62: recover a finished single-video target by scanning the destination
/// for yt-dlp's `[<id>]` filename marker (the output template's identity
/// token). used when the after_move:filepath print was swallowed — a done
/// job without a recorded path is a trust defect, not a cosmetic one.
/// skips .part/.temp artifacts; newest mtime wins (re-download case).
fn find_final_path_by_id(dest: &str, vid: &str) -> Option<String> {
    let marker = format!(" [{vid}]");
    let dir = std::path::Path::new(dest);
    if !dir.is_dir() || vid.is_empty() {
        return None;
    }
    std::fs::read_dir(dir)
        .ok()?
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().ok().is_some_and(|t| t.is_file()))
        .filter(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            name.contains(&marker)
                && !name.ends_with(".part")
                && !name.ends_with(".temp")
                && !name.ends_with(".ytdl")
        })
        .filter_map(|e| {
            let mtime = e.metadata().ok()?.modified().ok()?;
            Some((mtime, e.path().to_string_lossy().into_owned()))
        })
        .max_by_key(|(mtime, _)| *mtime)
        .map(|(_, path)| path)
}

/// public wrapper for the metadata memo (same normalization as intake).
pub fn normalize_url_public(raw: &str) -> String {
    match normalize_url(raw) {
        NormalizeResult::Ok(u) => u,
        _ => raw.trim().to_owned(),
    }
}

/// d59 hardening: a fresh queue onto an EXISTING target is unreachable by
/// the history gate (the file isn't linked to any row yet) — yt-dlp then
/// skips the download AND the postprocessors, and the always-on
/// --embed-metadata pass fails on a cover-tagged file with the cryptic
/// "Postprocessing: Conversion failed!" (e2e-reproduced). rewrite the error
/// into the action the user actually needs. matching only this specific
/// signature keeps genuine conversion failures honest.
fn rewrite_skip_existing_error(msg: &str) -> String {
    let lower = msg.to_lowercase();
    if lower.contains("has already been downloaded") && lower.contains("conversion failed") {
        "the target file already exists and yt-dlp skipped the download, so its post-processors ran on the old file and failed. re-download with “overwrite” from history (↻), move the existing file, or change the output template.".into()
    } else {
        msg.to_owned()
    }
}

/// d60: youtube's bot-gate reads like an app failure ("ERROR: [youtube] …:
/// Sign in to confirm you're not a bot") — it is an auth wall, and the fix
/// already exists in the ui (composer → advanced → cookies). the guidance
/// LEADS (d84): the t-meta row ellipsizes, so anything appended after
/// yt-dlp's multi-sentence error is truncated away — the user must see the
/// action first, raw yt-dlp text in the expando.
fn rewrite_botgate_error(msg: &str) -> String {
    let lower = msg.to_lowercase();
    if lower.contains("sign in to confirm") || lower.contains("confirm you're not a bot") {
        format!(
            "youtube wants a sign-in for this video — set cookies (composer → advanced → cookies → from browser) and queue again · {msg}"
        )
    } else {
        msg.to_owned()
    }
}

/// m7 close-out: browser-cookie decryption failures are the single most
/// likely dead end after a bot-gate (chrome ≥127 app-bound encryption on
/// windows cannot be decrypted by yt-dlp). live-verified message on this
/// machine: "ERROR: Failed to decrypt with DPAPI. See <yt-dlp issue 10927>".
/// rewrite it into the actual guidance instead of a crypto error — leading
/// (d84), for the same truncation reason as the bot-gate rewrite.
fn rewrite_cookie_error(msg: &str) -> String {
    let lower = msg.to_lowercase();
    if lower.contains("failed to decrypt with dpapi")
        || lower.contains("failed to decrypt cookie")
        || (lower.contains("cookies") && lower.contains("could not be decrypted"))
    {
        format!(
            "this browser's cookie store could not be decrypted (chrome ≥127 encrypts them in a way yt-dlp cannot read) — use firefox or edge as the cookie source (composer → advanced → cookies), or export a cookies.txt file · {msg}"
        )
    } else {
        msg.to_owned()
    }
}

/// d91: the archive pre-check must yield to an explicit overwrite grant —
/// the user just confirmed they want a fresh download; the engine must not
/// second-guess that with a silent archive skip. pure function, test-pinned.
fn archive_precheck_applies(skip_downloaded: bool, overwrite: bool) -> bool {
    skip_downloaded && !overwrite
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn archive_precheck_yields_to_overwrite_d91() {
        // plain queue: pre-check applies
        assert!(archive_precheck_applies(true, false));
        // d63 force re-download (↻): skipDownloaded=false, overwrite=true
        assert!(!archive_precheck_applies(false, true));
        // a granted overwrite dialog with skip on: the grant wins — no silent
        // archive skip after an explicit "overwrite" confirm
        assert!(!archive_precheck_applies(true, true));
        // skip off, no overwrite: nothing to pre-check
        assert!(!archive_precheck_applies(false, false));
    }

    #[test]
    fn skip_existing_rewrite_matches_only_the_full_signature() {
        let real = "ERROR: Postprocessing: Conversion failed! (caused by ffprobe/ffmpeg)\n[download] Me at the zoo [jNQXAC9IVRw].opus has already been downloaded";
        assert!(rewrite_skip_existing_error(real).starts_with("the target file already exists"));
        // a genuine conversion failure (no skip line) stays untouched
        let genuine = "ERROR: Postprocessing: Conversion failed!";
        assert_eq!(rewrite_skip_existing_error(genuine), genuine);
        // a bare skip (archive hit) stays untouched
        let bare = "[download] x.opus has already been downloaded";
        assert_eq!(rewrite_skip_existing_error(bare), bare);
    }

    #[test]
    fn botgate_rewrite_leads_with_the_fix() {
        let real = "ERROR: [youtube] jNQXAC9IVRw: Sign in to confirm you're not a bot. Use --cookies-from-browser or --cookies for the authentication.";
        let out = rewrite_botgate_error(real);
        // d84: guidance FIRST — the t-meta row ellipsizes, so a trailing fix
        // after yt-dlp's wall of text never survives on screen
        assert!(out.starts_with("youtube wants a sign-in"));
        assert!(out.contains("advanced → cookies → from browser"));
        assert!(out.ends_with(real));
        // non-auth errors stay untouched
        let other = "ERROR: [generic] x: Unable to download webpage";
        assert_eq!(rewrite_botgate_error(other), other);
    }

    #[test]
    fn cookie_decrypt_rewrite_matches_the_live_dpapi_message() {
        // verbatim from a real run against chrome ≥127 on this machine
        // (2026-09): the app-bound encryption failure yt-dlp cannot bypass.
        let real = "ERROR: Failed to decrypt with DPAPI. See  https://github.com/yt-dlp/yt-dlp/issues/10927  for more info";
        let out = rewrite_cookie_error(real);
        assert!(out.starts_with("this browser's cookie store could not be decrypted"));
        assert!(out.contains("firefox or edge"));
        assert!(out.ends_with(real));
        // the yt-dlp in-decryption warning variant matches too
        let warn = "ERROR: failed to decrypt cookie (AES-GCM) because the MAC check failed. Possibly the key is wrong?";
        assert!(rewrite_cookie_error(warn).contains("firefox or edge"));
        // unrelated errors stay untouched
        let other = "ERROR: [generic] x: Unable to download webpage";
        assert_eq!(rewrite_cookie_error(other), other);
    }

    #[test]
    fn intake_normalizes_scheme_less_and_flags_non_links() {
        match normalize_url("  youtube.com/watch?v=x  ") {
            NormalizeResult::Ok(u) => assert_eq!(u, "https://youtube.com/watch?v=x"),
            other => panic!("wrong: {other:?}"),
        }
        match normalize_url("https://youtu.be/x") {
            NormalizeResult::Ok(u) => assert_eq!(u, "https://youtu.be/x"),
            other => panic!("wrong: {other:?}"),
        }
        // intranet/localhost/vanity must be accepted (D28)
        match normalize_url("http://localhost:8080/v") {
            NormalizeResult::Ok(u) => assert_eq!(u, "http://localhost:8080/v"),
            other => panic!("wrong: {other:?}"),
        }
        match normalize_url("myserver.local/v") {
            NormalizeResult::Ok(u) => assert_eq!(u, "https://myserver.local/v"),
            other => panic!("wrong: {other:?}"),
        }
        // blank + obvious non-links
        assert!(matches!(normalize_url("   "), NormalizeResult::Blank));
        match normalize_url("this is not a url") {
            NormalizeResult::Invalid { reason, .. } => {
                assert!(reason.contains("one link per line"))
            }
            other => panic!("wrong: {other:?}"),
        }
        match normalize_url("justaword") {
            NormalizeResult::Invalid { .. } => {}
            other => panic!("wrong: {other:?}"),
        }
    }

    #[test]
    fn options_json_roundtrip_keeps_url() {
        let opts = JobOptions::default();
        let json = options_with_url(&opts, "https://youtu.be/x");
        assert_eq!(url_of_options(&json), "https://youtu.be/x");
        assert_eq!(options_of(&json), opts);
    }

    #[test]
    fn retry_swaps_options_and_resets_run_fields_keeps_url_and_title_d88() {
        let old = JobOptions {
            cookies: crate::engine::args::CookieSource::default(),
            ..JobOptions::default()
        };
        let mut row = JobRow {
            id: "j1".into(),
            options: options_with_url(&old, "https://youtu.be/x"),
            dest: r"C:\old".into(),
            state: "error".into(),
            title: Some("kept title".into()),
            format: Some("opus".into()),
            final_path: Some(r"C:\old\t [x].opus".into()),
            vid: Some("x".into()),
            pct: Some(41.0),
            speed_bps: Some(999.0),
            eta_sec: Some(12),
            error: Some("boom".into()),
            skipped: true,
            items_done: Some(1),
            items_total: Some(2),
            created_at: 1,
            updated_at: 1,
        };
        let new = JobOptions {
            cookies: crate::engine::args::CookieSource {
                kind: crate::engine::args::CookieKind::FromBrowser,
                browser: Some("firefox".into()),
                file: None,
            },
            audio_format: crate::engine::args::AudioFormat::Flac,
            ..JobOptions::default()
        };
        apply_retry_to_row(&mut row, &new, r"C:\new");
        // url and title survive; everything run-shaped resets
        assert_eq!(url_of_options(&row.options), "https://youtu.be/x");
        assert_eq!(options_of(&row.options).cookies, new.cookies);
        assert_eq!(
            options_of(&row.options).audio_format,
            crate::engine::args::AudioFormat::Flac
        );
        assert_eq!(row.dest, r"C:\new");
        assert_eq!(row.state, "queued");
        assert_eq!(row.title.as_deref(), Some("kept title"));
        assert!(row.pct.is_none() && row.error.is_none() && row.final_path.is_none());
        assert!(!row.skipped && row.items_done.is_none() && row.items_total.is_none());
        // the resolved id persists — retry's old-dest sweep keys on it
        assert_eq!(row.vid.as_deref(), Some("x"));
    }

    #[test]
    fn final_path_recovery_scans_destination_for_id_marker() {
        let dir = std::env::temp_dir().join(format!(
            "ytdlp-gui-test-d62-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        // the done file, a leftover part, and an unrelated file
        std::fs::write(dir.join("Me at the zoo [jNQXAC9IVRw].opus"), b"x").unwrap();
        std::fs::write(dir.join("Me at the zoo [jNQXAC9IVRw].opus.part"), b"x").unwrap();
        std::fs::write(dir.join("other [zzzzzzzzzzz].m4a"), b"x").unwrap();
        let hit = find_final_path_by_id(&dir.to_string_lossy(), "jNQXAC9IVRw");
        assert!(
            hit.as_ref()
                .is_some_and(|p| p.ends_with("[jNQXAC9IVRw].opus")),
            "got {hit:?}"
        );
        // unknown id → none; empty id → none; missing dir → none
        assert!(find_final_path_by_id(&dir.to_string_lossy(), "nope").is_none());
        assert!(find_final_path_by_id(&dir.to_string_lossy(), "").is_none());
        assert!(find_final_path_by_id("Z:/definitely/not/here", "x").is_none());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn removability_matrix_matches_spec() {
        assert!(!JobState::is_removable("downloading"));
        assert!(!JobState::is_removable("post"));
        for s in [
            "queued",
            "stopped",
            "error",
            "done",
            "fetching",
            "duplicate",
        ] {
            assert!(JobState::is_removable(s), "{s} should be removable");
        }
    }

    #[test]
    fn state_strings_roundtrip() {
        for s in [
            JobState::Queued,
            JobState::Fetching,
            JobState::Downloading,
            JobState::Post,
            JobState::Done,
            JobState::Stopped,
            JobState::Error,
            JobState::Duplicate,
        ] {
            assert_eq!(JobState::from_str(s.as_str()), s);
        }
    }
}
