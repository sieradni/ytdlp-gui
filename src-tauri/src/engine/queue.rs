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
use crate::engine::thumbs::cache_fresh;
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
    /// d93: thumbnail cache path (app-data png). set once the identity
    /// resolves (remote art), may be replaced at done (local art).
    pub thumb: Option<String>,
    pub pct: Option<f64>,
    pub speed_bps: Option<f64>,
    pub eta_sec: Option<u64>,
    pub error: Option<String>,
    pub skipped: bool,
    /// playlist progress (D33): items done / total. null = single video or
    /// no counter line seen yet.
    pub items_done: Option<u32>,
    pub items_total: Option<u32>,
    /// d94: per-item records for playlist jobs (id/title/path/status),
    /// written at completion. empty for single videos.
    pub items: Vec<crate::store::JobItem>,
    /// recent output lines for the expandable row (§6).
    pub output: Vec<String>,
    pub created_at: i64,
}

impl Job {
    fn from_row(row: &JobRow, output: Vec<String>, items: Vec<crate::store::JobItem>) -> Self {
        Job {
            id: row.id.clone(),
            url: url_of_options(&row.options),
            state: JobState::from_str(&row.state),
            title: row.title.clone(),
            format: row.format.clone(),
            final_path: row.final_path.clone(),
            thumb: row.thumb.clone(),
            pct: row.pct,
            speed_bps: row.speed_bps,
            eta_sec: row.eta_sec,
            error: row.error.clone(),
            skipped: row.skipped,
            items_done: row.items_done,
            items_total: row.items_total,
            // d94: per-item records (playlist jobs) — empty for single videos
            items,
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

/// d97: outcome of deleting tracks from a playlist job (the ui reports the
/// count; `remaining` is authoritative, not inferred from the event).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemDeleteResult {
    pub deleted: usize,
    pub files_removed: usize,
    pub remaining: Vec<crate::store::JobItem>,
}

/// d97: the row mutation after tracks were deleted — pure so it is testable.
/// counts stay truthful (remaining records; the playlist's total is not
/// rewritten — 9 of 10 is the truth after one track is gone) and the row's
/// reveal path never points at a file that was just deleted.
fn apply_item_deletion(
    row: &mut JobRow,
    remaining: &[crate::store::JobItem],
    deleted_paths: &HashSet<String>,
) {
    row.items_done = Some(remaining.len() as u32);
    if row
        .final_path
        .as_ref()
        .is_some_and(|p| deleted_paths.contains(p))
    {
        row.final_path = remaining.iter().rev().find_map(|it| it.path.clone());
    }
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

impl QueueInner {
    /// d96: the dispatcher's gate-check + slot-claim step, as ONE method on
    /// the guarded state. the e2e TOCTOU (S15, 2026-09-28): the old
    /// dispatcher checked `paused` in one lock scope and inserted into
    /// `running` in a second, so queue_pause() could interleave between
    /// them — a job decided at the pause instant still started. with the
    /// claim expressed here, the dispatcher can only run it while holding
    /// the lock: a job either starts wholly before the pause or waits for
    /// resume (D34's contract). `oldest_queued` is the db's oldest "queued"
    /// row, or None when the queue is empty.
    fn claim_next(
        &mut self,
        oldest_queued: Option<JobRow>,
    ) -> Option<(String, String, String, mpsc::UnboundedReceiver<()>)> {
        if self.paused || self.running.len() >= self.concurrency {
            return None;
        }
        oldest_queued.map(|r| {
            let (tx, rx) = mpsc::unbounded_channel();
            self.running.insert(r.id.clone(), tx);
            (r.id, r.options, r.dest, rx)
        })
    }
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
                // d94: playlist jobs carry their per-item records; the db
                // hits only fire for jobs that ever had items (empty result
                // for single videos is one indexed primary-key query).
                let items = self.db.list_job_items(&r.id).unwrap_or_default();
                Job::from_row(r, out, items)
            })
            .collect())
    }

    /// d94: per-item records for one job (playlist tracks). empty for
    /// single videos.
    pub fn list_items(&self, id: &str) -> AppResult<Vec<crate::store::JobItem>> {
        self.db.list_job_items(id)
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
                        thumb: None,
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
                    jobs.push(Job::from_row(&row, Vec::new(), Vec::new()));
                }
            }
        }

        self.emit_queue_changed();
        Ok((jobs, invalid, dupes))
    }

    // ----- lifecycle (§6) -----

    /// stop ■: kill the child, keep .part files → Stopped (D31). a queued job
    /// has no child to signal, so it is cancelled in place (d97) — the row
    /// never runs, stays retryable, and its url is free to queue again.
    pub fn stop(&self, id: &str) -> AppResult<()> {
        // the lock is held across the queued-cancel decision for the same
        // reason the dispatcher's claim is atomic (D96): a job that is being
        // claimed right now must not be marked stopped underneath the run.
        let mut inner = self.inner.lock().expect("queue lock");
        if let Some(tx) = inner.running.get(id).cloned() {
            drop(inner);
            let _ = tx.send(());
            return Ok(());
        }
        let rows = self.db.list_jobs()?;
        let Some(row) = rows.iter().find(|r| r.id == id) else {
            return Err(other("no such job"));
        };
        if row.state != "queued" {
            return Err(other("job is not running"));
        }
        let mut row = row.clone();
        row.state = "stopped".into();
        row.error = Some("cancelled before it started".into());
        row.updated_at = crate::store::now_unix();
        self.save_row(&row);
        inner.urls.remove(&url_of_options(&row.options));
        drop(inner);
        let _ = self.app.emit(
            "job:update",
            serde_json::json!({ "id": id, "state": "stopped", "error": row.error }),
        );
        self.emit_queue_changed();
        Ok(())
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
        // d94: the previous attempt's item records must not outlive their
        // run — a retried job rebuilds them (or shows none until it does).
        let _ = self.db.delete_job_items(id);
        self.emit_queue_changed();
        Ok(())
    }

    /// d97: delete finished tracks from a playlist job — the file on disk,
    /// the archive entry (so a retry downloads it again) and the item record.
    /// the rest of the playlist, its counts and its other files are untouched.
    /// refused while the job is running: the live run rewrites the item list
    /// at the stop/done boundary and would resurrect a deleted record.
    pub fn delete_items(&self, id: &str, vids: &[String]) -> AppResult<ItemDeleteResult> {
        let rows = self.db.list_jobs()?;
        let Some(row) = rows.iter().find(|r| r.id == id) else {
            return Err(other("no such job"));
        };
        if !JobState::is_removable(&row.state) {
            return Err(other("cancel the playlist before deleting tracks"));
        }
        let items = self.db.list_job_items(id)?;
        if items.is_empty() {
            return Err(other("this job has no tracks"));
        }
        let mut matched = 0usize;
        let mut deleted = 0usize;
        let mut files_removed = 0usize;
        let mut deleted_paths: HashSet<String> = HashSet::new();
        let mut remaining: Vec<crate::store::JobItem> = Vec::new();
        for it in items {
            if !vids.iter().any(|v| v == &it.vid) {
                remaining.push(it);
                continue;
            }
            matched += 1;
            if let Some(p) = &it.path {
                let path = std::path::Path::new(p);
                if path.is_file() {
                    if std::fs::remove_file(path).is_err() {
                        // locked/in use: keep the track AND its record — the
                        // ui must never claim a file is gone while it is still
                        // on disk.
                        remaining.push(it);
                        continue;
                    }
                    files_removed += 1;
                    deleted_paths.insert(p.clone());
                }
            }
            // the archive line is yt-dlp's per-item record; dropping it makes
            // the deleted track downloadable again instead of silently skipped.
            let _ = crate::store::archive_remove_vids(
                &default_archive_path(),
                std::slice::from_ref(&it.vid),
            );
            let _ = self.db.delete_job_item(id, &it.vid);
            deleted += 1;
        }
        if matched == 0 {
            return Err(other("no matching tracks"));
        }
        if deleted == 0 {
            return Err(other("could not delete the track — the file may be in use"));
        }
        let mut row = self.row(id);
        apply_item_deletion(&mut row, &remaining, &deleted_paths);
        self.save_row(&row);
        let _ = self.app.emit(
            "job:update",
            serde_json::json!({
                "id": id,
                "items": &remaining,
                "itemsDone": row.items_done,
                "itemsTotal": row.items_total,
                "finalPath": row.final_path,
            }),
        );
        self.emit_queue_changed();
        Ok(ItemDeleteResult {
            deleted,
            files_removed,
            remaining,
        })
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
        let _ = self.db.delete_job_items(id);
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
                // gate check and slot claim are ONE atomic step under the
                // lock: with the claim in a second acquisition, pause()
                // could interleave between the check and the insert and a
                // job decided at the pause instant still started (TOCTOU
                // e2e S15 caught live 2026-09-28 — the paused witness
                // dispatched microseconds before paused=true landed).
                // linearized: a job either starts wholly before the pause
                // or waits for resume (D34's contract). pinned by the
                // dispatcher test below.
                let next = {
                    let mut inner = q.inner.lock().expect("queue lock");
                    // the db read stays inside the same critical section:
                    // claim_next verifies the gate and reserves the slot
                    // atomically with the oldest-queued pick (d96; a db
                    // read under the lock is fine — no awaits, no
                    // re-entrancy).
                    let oldest =
                        q.db.list_jobs()
                            .ok()
                            .and_then(|rows| rows.into_iter().find(|r| r.state == "queued"));
                    inner.claim_next(oldest)
                };
                if let Some((id, options, dest, rx)) = next {
                    let q2 = Arc::clone(&q);
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
                    // d93: an archive-skip is a done row — it deserves art too.
                    // the file's location is unknown from here, so the remote
                    // probe runs (fresh-cache check keeps repeats free); when
                    // a later real download lands, its done-sweep replaces
                    // this with locally extracted art.
                    {
                        let app = self.app.clone();
                        let db = Arc::clone(&self.db);
                        let id2 = id.clone();
                        let key = key.to_owned();
                        let (ex, vid) = key
                            .split_once(' ')
                            .map(|(a, b)| (a.to_owned(), b.to_owned()))
                            .unwrap_or_default();
                        let url2 = url.clone();
                        let ex2 = ex.clone();
                        let cookies = opts.cookies.clone();
                        tauri::async_runtime::spawn(async move {
                            if let Some(p) = crate::engine::thumbs::ensure_remote_art(
                                &key,
                                &vid,
                                &url2,
                                &ex2,
                                Some(&cookies),
                            )
                            .await
                            {
                                let ps = p.to_string_lossy().into_owned();
                                let _ = db.set_job_thumb(&id2, Some(&ps));
                                let _ = db.set_history_thumb(&ex, &vid, Some(&ps));
                                let _ = app.emit(
                                    "job:update",
                                    serde_json::json!({ "id": id2, "thumb": ps }),
                                );
                            }
                        });
                    }
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

            // d93: remote artwork — the identity is known before any bytes
            // move, so the row can show art while it downloads. youtube
            // resolves off the i.ytimg lookup table (zero yt-dlp cost); other
            // extractors run one --print probe in the background. every
            // failure degrades to "no thumbnail"; nothing can fail the job.
            if let Some(i) = identity.as_ref() {
                if !cache_fresh(&i.key()) {
                    let app = self.app.clone();
                    let db = Arc::clone(&self.db);
                    let id2 = id.clone();
                    let key = i.key();
                    let vid = i.id.clone();
                    let url2 = url.clone();
                    let ex = i.extractor.clone();
                    let cookies = opts.cookies.clone();
                    tauri::async_runtime::spawn(async move {
                        if let Some(p) = crate::engine::thumbs::ensure_remote_art(
                            &key,
                            &vid,
                            &url2,
                            &ex,
                            Some(&cookies),
                        )
                        .await
                        {
                            let _ = db.set_job_thumb(&id2, Some(&p.to_string_lossy()));
                            let _ = app.emit(
                                "job:update",
                                serde_json::json!({ "id": id2, "thumb": p.to_string_lossy() }),
                            );
                        }
                    });
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
        let outcome = self
            .spawn_and_stream(
                &id,
                &argv,
                &mut stop_rx,
                identity
                    .as_ref()
                    .map(|i| (i.is_playlist, i.extractor.as_str())),
            )
            .await;

        // ---- finalize ----
        match outcome {
            RunOutcome::Stopped { removed, kept } => {
                // d97: a cancelled playlist cleaned up after itself, so its
                // message names what happened instead of promising debris.
                // single videos keep their partials for retry-resume (D31).
                let is_playlist = identity.as_ref().is_some_and(|i| i.is_playlist);
                let msg = if is_playlist {
                    // short enough for the row's one-line meta: the count
                    // also reads in the progress cell and the track header.
                    let mut m = String::from("cancelled");
                    if removed > 0 {
                        m.push_str(" — unfinished track removed");
                    }
                    match kept {
                        0 => {}
                        1 => m.push_str(" · 1 kept"),
                        n => m.push_str(&format!(" · {n} kept")),
                    }
                    m
                } else {
                    "stopped by user — partial files kept".into()
                };
                self.finalize(&id, JobState::Stopped, Some(msg)).await;
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
                items: run_items,
                channel: run_channel,
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
                            title: title.clone().or_else(|| self.row(&id).title), // d94: the channel print finally feeds the dead
                            // column (upsert COALESCE keeps an older value)
                            channel: run_channel.clone(),
                            duration_sec: meta.as_ref().and_then(|m| m.duration_sec).map(i64::from),
                            size_bytes: meta
                                .as_ref()
                                .and_then(|m| m.size_bytes)
                                .and_then(|v| i64::try_from(v).ok()),
                            format: final_path
                                .as_deref()
                                .and_then(crate::engine::probe::format_label),
                            final_path: final_path.clone(),
                            // d93: null here — the done-sweep below sets the
                            // thumb after local extraction (and COALESCE in
                            // upsert_history keeps any existing value).
                            thumb: None,
                            error: None,
                            downloaded_at: crate::store::now_unix(),
                        };
                        if let Err(e) = self.db.upsert_history(&h) {
                            self.push_log(&id, format!("history write failed: {e}"));
                        }
                    }
                }
                // d94: playlist jobs now leave a trace too — a playlist-level
                // history row (D54 kept the per-item archive writes; this adds
                // the missing playlist record, so history shows playlists and
                // their re-download affordance works). counts come from the
                // run; the row's ✕-remove stays archive-noop (yt-dlp owns the
                // per-item archive entries).
                if is_playlist {
                    if let Some(key) = &identity_key {
                        if let Some((ex, vid)) = key.split_once(' ') {
                            let h = crate::store::HistoryRow {
                                extractor: ex.to_owned(),
                                vid: vid.to_owned(),
                                url: Some(url.clone()),
                                title: title.clone().or_else(|| self.row(&id).title),
                                channel: run_channel.clone(),
                                duration_sec: None,
                                size_bytes: None,
                                // count every processed item (done + skipped):
                                // a fully-archived replay downloads nothing but
                                // still ran 10 tracks — "0 items" would lie.
                                format: Some(format!("playlist · {} items", run_items.len())),
                                final_path: None,
                                thumb: None, // the fetch-phase art already cached; COALESCE keeps it
                                error: None,
                                downloaded_at: crate::store::now_unix(),
                            };
                            if let Err(e) = self.db.upsert_history(&h) {
                                self.push_log(&id, format!("history write failed: {e}"));
                            }
                        }
                    }
                }
                // d94: persist the run's per-item records (playlist jobs) and
                // extract local art for each item that produced a real file.
                // playlist-gated: singles never produce track records (their
                // art is handled by the final_path sweep above).
                if is_playlist && !run_items.is_empty() {
                    let items = {
                        let mut v: Vec<crate::store::JobItem> = run_items;
                        v.sort_by_key(|it| it.idx);
                        v
                    };
                    let _ = self.db.replace_job_items(&id, &items);
                    let _ = self.app.emit(
                        "job:update",
                        serde_json::json!({
                            "id": id,
                            "items": self.db.list_job_items(&id).unwrap_or_default(),
                        }),
                    );
                    for it in items.iter().filter(|it| it.status == "done") {
                        if let (Some(path), Some((ex, vid))) = (
                            &it.path,
                            identity_key.as_deref().and_then(|k| k.split_once(' ')),
                        ) {
                            let app = self.app.clone();
                            let db = Arc::clone(&self.db);
                            let id2 = id.clone();
                            let path = path.clone();
                            let idx = it.idx;
                            let item_key = format!("{ex} p{vid}i{idx}");
                            tauri::async_runtime::spawn(async move {
                                if let Some(p) = crate::engine::thumbs::ensure_local_art(
                                    &item_key,
                                    std::path::Path::new(&path),
                                )
                                .await
                                {
                                    let _ = db.set_job_thumb(&id2, Some(&p.to_string_lossy()));
                                    let _ = app.emit(
                                        "job:update",
                                        serde_json::json!({ "id": id2, "thumb": p.to_string_lossy() }),
                                    );
                                }
                            });
                        }
                    }
                }
                // d93: local art — prefer what the FINISHED file carries
                // (embedded cover for audio, a real frame for video). this
                // matches the actual download, unlike remote art, and works
                // offline. runs off-thread; failure keeps the remote thumb.
                if let Some(path) = &final_path {
                    let app = self.app.clone();
                    let db = Arc::clone(&self.db);
                    let id2 = id.clone();
                    let key = identity_key.clone();
                    let path = path.clone();
                    tauri::async_runtime::spawn(async move {
                        if let Some(k) = key {
                            if let Some(p) = crate::engine::thumbs::ensure_local_art(
                                &k,
                                std::path::Path::new(&path),
                            )
                            .await
                            {
                                let ps = p.to_string_lossy().into_owned();
                                let _ = db.set_job_thumb(&id2, Some(&ps));
                                if let Some((ex, vid)) = k.split_once(' ') {
                                    let _ = db.set_history_thumb(ex, vid, Some(&ps));
                                }
                                let _ = app.emit(
                                    "job:update",
                                    serde_json::json!({ "id": id2, "thumb": ps }),
                                );
                            }
                        }
                    });
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
    /// `playlist` = (is_playlist, extractor): d94's per-item records and
    /// item-thumb surface only apply to playlist jobs.
    async fn spawn_and_stream(
        &self,
        id: &str,
        argv: &[String],
        stop_rx: &mut mpsc::UnboundedReceiver<()>,
        playlist: Option<(bool, &str)>,
    ) -> RunOutcome {
        // d97: the cancel sweep's time floor — every file this run writes is
        // at or after it, so a finished file from an earlier download of the
        // same id (older mtime) can never be mistaken for an artifact.
        let run_started = std::time::SystemTime::now();
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
        // d94: per-item records for playlist jobs (the ui's expando shows
        // the tracks) + the run's channel (first item's, feeds history).
        // a map so the 200ms emit-throttle can't duplicate ids.
        let mut collected_items: std::collections::HashMap<String, crate::store::JobItem> =
            std::collections::HashMap::new();
        let mut last_channel: Option<String> = None;
        let mut last_item_vid: Option<String> = None;
        // d97: the item STARTED but not yet finished — the one a cancel
        // interrupts. set by the __V__ print (pre_process), unlike
        // last_item_vid which only exists in verbose runs.
        let mut current_item_vid: Option<String> = None;
        // d94: a __N__ title that arrives before any __I__ (single videos)
        // parks here until the item identity is known.
        let mut last_pending_title: Option<String> = None;

        loop {
            tokio::select! {
                _ = stop_rx.recv() => {
                    child.kill().await;
                    let mut removed = 0usize;
                    let mut kept = 0usize;
                    // d97: a cancelled playlist does not leave the interrupted
                    // track behind. the tree is already dead (kill awaited), so
                    // nothing can write the files again; the sweep is scoped to
                    // the __V__ id and to files this run wrote.
                    if playlist.is_some_and(|(is_pl, _)| is_pl) {
                        if let Some(vid) = current_item_vid.as_deref() {
                            let dest = self.row(id).dest;
                            removed = crate::store::sweep_inflight_item(
                                std::path::Path::new(&dest),
                                vid,
                                run_started,
                            );
                            if removed > 0 {
                                self.push_log(
                                    id,
                                    format!("cancelled mid-track — removed {removed} partial file(s)"),
                                );
                            }
                        }
                        // d94/ADVERSARIAL-REVIEW: a stopped playlist keeps the
                        // records of items that FINISHED (real path) or were
                        // ARCHIVE-SKIPPED (status=skipped — they never get a
                        // path but were genuinely processed); the unfinished
                        // item is dropped — the list must never claim a file
                        // that isn't there.
                        let finished: Vec<crate::store::JobItem> = collected_items
                            .into_values()
                            .filter(|it| it.path.is_some() || it.status == "skipped")
                            .collect();
                        kept = finished.len();
                        let _ = self.db.replace_job_items(id, &finished);
                        // d97: the cancel boundary owns the playlist counts.
                        // the throttled run writes never persist them, which is
                        // why a stopped playlist used to fall back to the
                        // interrupted track's byte percent with no denominator.
                        let mut row = self.row(id);
                        row.items_done = Some(kept as u32);
                        row.items_total = items_total.or(row.items_total);
                        row.pct = None;
                        row.speed_bps = None;
                        row.eta_sec = None;
                        row.updated_at = crate::store::now_unix();
                        self.save_row(&row);
                        let _ = self.app.emit(
                            "job:update",
                            serde_json::json!({
                                "id": id,
                                "items": self.db.list_job_items(id).unwrap_or_default(),
                                "itemsDone": kept,
                                "itemsTotal": row.items_total,
                                "pct": null,
                                "speedBps": null,
                                "etaSec": null,
                            }),
                        );
                    }
                    return RunOutcome::Stopped { removed, kept };
                }
                line = rx.recv() => {
                    let Some((_is_stdout, raw)) = line else {
                        // both streams closed — reap the exit status
                        let status = child.inner.wait().await;
                        let items_done = (items_done > 0).then_some(items_done);
                        let run_items: Vec<crate::store::JobItem> =
                            collected_items.into_values().collect();
                        return match status {
                            Ok(s) if s.success() => RunOutcome::Done {
                                final_path,
                                title,
                                items_done,
                                items_total,
                                skipped_existing,
                                items: run_items,
                                channel: last_channel,
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
                                // d94/ADVERSARIAL-REVIEW: the item's vid comes
                                // from the FILENAME's `[<id>]` marker (the
                                // engine's own output-template token), never
                                // from "last seen item-start" — a fast track
                                // whose metadata lagged would otherwise attach
                                // its file to the wrong (next) item.
                                let item_vid = std::path::Path::new(&p)
                                    .file_stem()
                                    .and_then(|s| s.to_str())
                                    .and_then(|stem| {
                                        stem.rsplit(" [")
                                            .next()
                                            .and_then(|tail| tail.strip_suffix(']'))
                                            .filter(|v| {
                                                !v.is_empty()
                                                    && v.len() <= 64
                                                    && v.chars().all(|c| {
                                                        c.is_ascii_alphanumeric()
                                                            || c == '-'
                                                            || c == '_'
                                                    })
                                            })
                                            .map(str::to_owned)
                                    })
                                    .or_else(|| last_item_vid.clone())
                                    .unwrap_or_default();
                                // records are playlist-only: a single video's
                                // marker-derived entry would write pointless
                                // job_items rows and flash a "tracks" section
                                // in its expando (the existing single-video
                                // final_path art sweep already covers singles).
                                if playlist.is_some_and(|(is_pl, _)| is_pl) && !item_vid.is_empty() {
                                    let next_idx = collected_items.len() as u32 + 1;
                                    let entry = collected_items.entry(item_vid.clone()).or_insert(crate::store::JobItem {
                                        idx: next_idx,
                                        vid: item_vid.clone(),
                                        title: None,
                                        path: None,
                                        status: "done".into(),
                                    });
                                    entry.path = Some(p.clone());
                                    entry.status = "done".into();
                                    if entry.title.is_none() {
                                        entry.title = last_pending_title.take();
                                    }
                                    // IMMEDIATE emission (not throttled): the
                                    // track list must reflect reality as lines
                                    // land; a fast track between two 200ms
                                    // samples is otherwise invisible.
                                    let _ = self.app.emit(
                                        "job:update",
                                        serde_json::json!({
                                            "id": id, "state": "downloading",
                                            "itemsDone": items_done.saturating_add(1),
                                            "itemsTotal": items_total,
                                            "itemTitle": entry.title,
                                            "item": entry.clone(),
                                        }),
                                    );
                                }
                                final_path = Some(p.clone());
                                // d94: playlist jobs point their row's reveal
                                // affordance at the item's real file.
                                if playlist.is_some_and(|(is_pl, _)| is_pl) {
                                    let mut row = self.row(id);
                                    row.final_path = Some(p.clone());
                                    row.updated_at = crate::store::now_unix();
                                    self.save_row(&row);
                                }
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
                        ParsedLine::PlaylistSkip { id: skip_id, title: skip_title } => {
                            // archive-skipped items count as processed (D54);
                            // d94: recorded with their title — the skip line is
                            // the only per-item signal these items produce.
                            let next_idx = collected_items.len() as u32 + 1;
                            collected_items.entry(skip_id.clone()).or_insert(crate::store::JobItem {
                                idx: next_idx,
                                vid: skip_id.clone(),
                                title: skip_title.clone(),
                                path: None,
                                status: "skipped".into(),
                            });
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
                        ParsedLine::Channel { channel, uploader } => {
                            // d94: the run's uploader — youtube fills channel,
                            // bandcamp fills uploader (live-verified); prefer
                            // channel. single videos flow here too.
                            if last_channel.is_none() {
                                last_channel = Some(channel.or(uploader).unwrap_or_default());
                                if last_channel.as_deref() == Some("") {
                                    last_channel = None;
                                }
                            }
                        }
                        ParsedLine::ItemVid(vid) => {
                            // d97: the item is starting — remember it so a
                            // cancel can clean up exactly this track.
                            current_item_vid = Some(vid);
                        }
                        ParsedLine::ItemTitle(item_title) => {
                            // d94: per-item title from the engine's __N__ print
                            // — the ONLY per-item title signal in normal runs
                            // (the verbose-gated `[download] <id>: <title>`
                            // line never appears without -v). the item's vid
                            // is not known yet (it arrives with the file path),
                            // so the title parks until then; the emission is
                            // IMMEDIATE — a fast track between two throttled
                            // samples must still show what is playing.
                            last_pending_title = Some(item_title.clone());
                            let _ = self.app.emit(
                                "job:update",
                                serde_json::json!({
                                    "id": id, "state": "downloading", "itemTitle": item_title,
                                }),
                            );
                        }
                        ParsedLine::ItemStart { id: start_id, title } => {
                            // verbose-mode per-item line — a valid item start
                            // when it appears (-v); absent in normal runs.
                            last_item_vid = Some(start_id.clone());
                            let next_idx = collected_items.len() as u32 + 1;
                            let entry = collected_items.entry(start_id.clone()).or_insert(crate::store::JobItem {
                                idx: next_idx,
                                vid: start_id.clone(),
                                title: title.clone().or_else(|| last_pending_title.take()),
                                path: None,
                                status: "done".into(),
                            });
                            if entry.title.is_none() {
                                if let Some(t) = title.clone().or_else(|| last_pending_title.take()) {
                                    entry.title = Some(t);
                                }
                            }
                            let _ = self.app.emit(
                                "job:update",
                                serde_json::json!({
                                    "id": id, "state": "downloading",
                                    "itemsDone": items_done, "itemsTotal": items_total,
                                    "itemTitle": entry.title,
                                }),
                            );
                        }
                        ParsedLine::Destination(_) => {}
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
                thumb: None,
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
        row.thumb = None;
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
        /// d94: per-item records (playlist jobs) + the run's channel.
        items: Vec<crate::store::JobItem>,
        channel: Option<String>,
    },
    Stopped {
        /// files swept for the interrupted track (d97)
        removed: usize,
        /// finished/skipped tracks the cancel preserved
        kept: usize,
    },
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
            thumb: Some(r"C:\data\thumbs\youtube_x.png".into()),
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

    /// d97: deleting tracks keeps the row truthful — the count is what is
    /// left, and the reveal path moves off a file that is now gone.
    #[test]
    fn item_deletion_recounts_and_moves_the_reveal_path_d97() {
        let items = [
            crate::store::JobItem {
                idx: 1,
                vid: "a".into(),
                title: None,
                path: Some(r"C:\dl\a.mp3".into()),
                status: "done".into(),
            },
            crate::store::JobItem {
                idx: 2,
                vid: "b".into(),
                title: None,
                path: Some(r"C:\dl\b.mp3".into()),
                status: "done".into(),
            },
            crate::store::JobItem {
                idx: 3,
                vid: "c".into(),
                title: None,
                path: None,
                status: "skipped".into(),
            },
        ];
        let mut row = d96_row("j");
        row.items_done = Some(3);
        row.items_total = Some(10);
        row.final_path = Some(r"C:\dl\b.mp3".into());

        // delete the track the row was pointing at
        let mut deleted = HashSet::new();
        deleted.insert(r"C:\dl\b.mp3".to_owned());
        let remaining = vec![items[0].clone(), items[2].clone()];
        apply_item_deletion(&mut row, &remaining, &deleted);
        assert_eq!(
            row.items_done,
            Some(2),
            "records left, not the original run size"
        );
        assert_eq!(
            row.items_total,
            Some(10),
            "playlist size stays the playlist size"
        );
        assert_eq!(row.final_path.as_deref(), Some(r"C:\dl\a.mp3"));

        // deleting a track that was not the reveal target leaves it alone
        let before = row.final_path.clone();
        apply_item_deletion(&mut row, &remaining, &HashSet::new());
        assert_eq!(row.final_path, before);

        // no finished track left → no reveal target
        let only_skipped = vec![items[2].clone()];
        let mut gone: HashSet<String> = HashSet::new();
        gone.insert(r"C:\dl\a.mp3".to_owned());
        apply_item_deletion(&mut row, &only_skipped, &gone);
        assert_eq!(row.final_path, None);
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

    /// d96 pin: the paused gate and the slot claim are one atomic step —
    /// `queue_pause()` (which flips the same bool under the same lock) can
    /// never interleave between "gate open" and "slot taken". the old
    /// two-acquisition shape let a job start AT the pause instant (e2e
    /// S15 caught it live); this method makes that shape unrepresentable
    /// from the dispatcher, and these asserts pin the semantics.
    fn d96_row(id: &str) -> JobRow {
        JobRow {
            id: id.into(),
            options: options_with_url(&JobOptions::default(), "https://youtu.be/x"),
            dest: r"C:\dl".into(),
            state: "queued".into(),
            title: None,
            format: None,
            final_path: None,
            vid: None,
            thumb: None,
            pct: None,
            speed_bps: None,
            eta_sec: None,
            error: None,
            skipped: false,
            items_done: None,
            items_total: None,
            created_at: 1,
            updated_at: 1,
        }
    }

    #[test]
    fn claim_next_refuses_when_paused_d96() {
        let mut inner = QueueInner {
            paused: true,
            concurrency: 2,
            running: HashMap::new(),
            identities: HashSet::new(),
            urls: HashSet::new(),
        };
        // paused with a queued job and free slots: NOTHING claims — pause()
        // landing before the dispatcher's lock acquire must hold forever
        // (until resume), not just until the next lock round.
        assert!(inner.claim_next(Some(d96_row("j1"))).is_none());
        assert!(inner.running.is_empty());
        inner.paused = false;
        // resume → the same claim now goes through
        let claimed = inner.claim_next(Some(d96_row("j1")));
        assert!(claimed.is_some());
        assert_eq!(inner.running.len(), 1);
    }

    #[test]
    fn claim_next_refuses_at_concurrency_d96() {
        let mut inner = QueueInner {
            paused: false,
            concurrency: 1,
            running: HashMap::new(),
            identities: HashSet::new(),
            urls: HashSet::new(),
        };
        let first = inner.claim_next(Some(d96_row("j1"))).expect("first claim");
        assert_eq!(first.0, "j1");
        // slots full: no second claim, even with another queued row
        assert!(inner.claim_next(Some(d96_row("j2"))).is_none());
        assert_eq!(inner.running.len(), 1);
        drop(first); // receiver dropped — the run loop owns it in real life
    }

    #[test]
    fn claim_next_empty_queue_claims_nothing_d96() {
        let mut inner = QueueInner {
            paused: false,
            concurrency: 2,
            running: HashMap::new(),
            identities: HashSet::new(),
            urls: HashSet::new(),
        };
        assert!(inner.claim_next(None).is_none());
        assert!(inner.running.is_empty());
    }
}
