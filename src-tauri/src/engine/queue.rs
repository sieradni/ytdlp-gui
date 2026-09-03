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

use crate::engine::args::{build_argv, JobOptions, PlaylistMode};
use crate::engine::parser::{parse_line, ParsedLine};
use crate::engine::process;
use crate::error::{other, AppResult};
use crate::store::{archive_append, archive_contains, archive_path_from_settings, Db, JobRow};

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

    /// retry ↻ (stopped/error): re-queue same options; yt-dlp resumes
    /// partials. if the archive already holds the identity, the job ends
    /// Done/skipped on next run (§6 — correct and expected).
    pub fn retry(&self, id: &str) -> AppResult<()> {
        let mut rows = self.db.list_jobs()?;
        let Some(row) = rows.iter_mut().find(|r| r.id == id) else {
            return Err(other("no such job"));
        };
        if !matches!(row.state.as_str(), "stopped" | "error") {
            return Err(other("only stopped or error jobs can be retried"));
        }
        row.state = "queued".into();
        row.pct = None;
        row.speed_bps = None;
        row.eta_sec = None;
        row.updated_at = crate::store::now_unix();
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
        tokio::spawn(async move {
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
        self.set_state(&id, JobState::Fetching).await;
        self.refresh_yt_dlp_path().await;

        let yt_dlp = self.yt_dlp_path().await;
        let identity = tokio::select! {
            r = resolve_identity(yt_dlp.as_deref(), &url, &opts) => r,
            _ = stop_rx.recv() => {
                self.finalize(&id, JobState::Stopped, Some("stopped by user".into())).await;
                self.cleanup_running(&id, &url, None);
                return;
            }
        };

        let identity = match identity {
            Ok(i) => i,
            Err(e) => {
                self.finalize(&id, JobState::Error, Some(e.to_string()))
                    .await;
                self.cleanup_running(&id, &url, None);
                return;
            }
        };

        // ---- dedupe (D18/D37) + archive skip (D17/D41) ----
        // the key drives dedupe and the archive; the identity itself stays
        // alive for the history write and the probe title (D54).
        let identity_key: Option<String> = identity.as_ref().map(|i| i.key());

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
            if !is_playlist && opts.skip_downloaded {
                let (ex, vid) = key.split_once(' ').expect("identity key shape");
                let arch = archive_path_from_settings();
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
        }

        // ---- downloading ----
        // the archive is passed even when the identity is known-new: within
        // a playlist job yt-dlp itself skips ids the archive already holds
        // (D41 — a half-downloaded playlist resumes where it left off).
        let archive_flag: Option<String> = if opts.skip_downloaded {
            Some(archive_path_from_settings().to_string_lossy().into_owned())
        } else {
            None
        };
        let mut argv = match build_argv(
            &opts,
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
                self.finalize(&id, JobState::Error, Some(msg)).await;
            }
            RunOutcome::Done {
                final_path,
                title,
                items_done,
                items_total,
            } => {
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
                let is_playlist = identity.as_ref().is_some_and(|i| i.is_playlist);
                if let (Some(key), false) = (&identity_key, is_playlist) {
                    if let Some((ex, vid)) = key.split_once(' ') {
                        if let Err(e) = archive_append(&archive_path_from_settings(), ex, vid) {
                            self.push_log(&id, format!("archive write failed: {e}"));
                        }
                        // history metadata write (§5.3): title/path now;
                        // duration/size/formats fill in as D45 parsing grows.
                        let h = crate::store::HistoryRow {
                            extractor: ex.to_owned(),
                            vid: vid.to_owned(),
                            url: Some(url.clone()),
                            title: title.clone().or_else(|| self.row(&id).title),
                            channel: None,
                            duration_sec: None,
                            size_bytes: None,
                            format: None,
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
                // the throttled db flush can never lose the last item.
                row.items_done = items_done.or(row.items_done);
                row.items_total = items_total.or(row.items_total);
                if final_path.is_some() {
                    row.final_path = final_path;
                }
                if row.title.is_none() {
                    row.title = title;
                }
                row.updated_at = crate::store::now_unix();
                self.save_row(&row);
                self.emit_update(&row);
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
                    let _ = self.app.emit(
                        "job:log",
                        serde_json::json!({ "id": id, "line": raw, "kind": kind }),
                    );

                    match parse_line(&raw) {
                        ParsedLine::Progress { downloaded, total, speed_bps, eta_sec } => {
                            let pct = match (downloaded, total) {
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
                        ParsedLine::PlaylistCounter { done: _, total } => {
                            // counter's N is the item being fetched now; items
                            // done comes from our own count, total from here.
                            items_total = Some(total);
                            // the counter line announces the total before item
                            // 1 — reset our count so a resumed playlist's old
                            // count doesn't leak into this run.
                            seen_items.clear();
                            items_done = 0;
                            if last_emit.elapsed().as_millis() >= 200 {
                                last_emit = std::time::Instant::now();
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
        let mut row = self.row(id);
        row.state = state.as_str().into();
        row.error = msg.clone();
        row.speed_bps = None;
        row.eta_sec = None;
        row.updated_at = crate::store::now_unix();
        self.save_row(&row);
        let _ = self.app.emit(
            "job:update",
            serde_json::json!({ "id": id, "state": state.as_str(), "error": msg }),
        );
        if let Some(m) = msg {
            self.push_log(id, m);
        }
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
async fn resolve_identity(
    yt_dlp: Option<&std::path::Path>,
    url: &str,
    opts: &JobOptions,
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
    argv.push(url.to_owned());

    let mut child = process::spawn(&argv)?;
    let mut rx = process::stream_lines(&mut child)?;
    let mut resolved: Option<Identity> = None;
    let mut errored: Option<String> = None;

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
                // single videos carry their title on a second print line
                if !is_playlist {
                    if let Some((true, l2)) = rx.recv().await {
                        if let Some(t2) = l2.trim().strip_prefix("TITLE:") {
                            let t2 = t2.trim();
                            if !t2.is_empty() && t2 != "NA" {
                                identity.title = Some(t2.to_owned());
                            }
                        }
                    }
                }
                resolved = Some(identity);
                break;
            }
            Some((false, line)) => {
                let t = line.trim();
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

/// public wrapper for the metadata memo (same normalization as intake).
pub fn normalize_url_public(raw: &str) -> String {
    match normalize_url(raw) {
        NormalizeResult::Ok(u) => u,
        _ => raw.trim().to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
