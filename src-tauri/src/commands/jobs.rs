//! job commands (§7): queue add/stop/retry/remove/list, pause/resume.

use std::sync::Arc;

use serde::Serialize;

use crate::engine::args::JobOptions;
use crate::engine::queue::Job;
use crate::error::AppResult;
use crate::store::archive_contains;

/// tauri-managed handle to the engine queue.
pub struct QueueHandle(pub Arc<crate::engine::queue::JobQueue>);

impl QueueHandle {
    pub fn new(q: Arc<crate::engine::queue::JobQueue>) -> Self {
        QueueHandle(q)
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AddFeedback {
    pub jobs: Vec<Job>,
    /// (line, reason) per rejected url (§5.2 feedback card).
    pub invalid: Vec<(String, String)>,
    pub duplicates_skipped: usize,
}

/// `jobAdd(urls, options): Job[]` — lenient intake happens in Rust (§5.2);
/// the feedback card gets per-line reasons for invalid lines.
/// the destination fallback chain (d78: per-job → setting → windows
/// downloads), shared by job_add and the settings page's effective-path
/// display — one function so the ui can never disagree with the engine.
fn resolve_destination(
    destination: Option<String>,
    settings: &crate::settings::Settings,
) -> String {
    destination
        .or_else(|| settings.destination.clone())
        .filter(|d| !d.trim().is_empty())
        .unwrap_or_else(|| {
            dirs::download_dir()
                .map(|p| p.to_string_lossy().into_owned())
                .unwrap_or_else(|| std::env::temp_dir().to_string_lossy().into_owned())
        })
}

#[tauri::command]
pub fn job_add(
    handle: tauri::State<'_, QueueHandle>,
    settings: tauri::State<'_, crate::settings::SettingsHandle>,
    urls: Vec<String>,
    options: JobOptions,
    destination: Option<String>,
) -> AppResult<AddFeedback> {
    let dest = resolve_destination(destination, &settings.get());
    let (jobs, invalid, dupes) = handle.0.add_urls(&urls, &options, &dest)?;
    Ok(AddFeedback {
        jobs,
        invalid,
        duplicates_skipped: dupes,
    })
}

/// d81: the destination downloads actually land in when nothing is set —
/// settings populates its output-folder field with this instead of showing
/// an empty box (the user should see the real path, not a guess).
#[tauri::command]
pub fn effective_destination(
    settings: tauri::State<'_, crate::settings::SettingsHandle>,
) -> String {
    resolve_destination(None, &settings.get())
}

#[tauri::command]
pub fn job_stop(handle: tauri::State<'_, QueueHandle>, id: String) -> AppResult<()> {
    handle.0.stop(&id)
}

/// d88: retry means "queue this url again, exactly as queueing it now
/// would" — the frontend passes the composer's LIVE options and destination
/// (resolved through the same fallback chain as job_add). the old retry
/// re-queued the job's frozen options json, so changing cookies/format/
/// destination and pressing retry silently repeated the failed attempt
/// verbatim. the engine sweeps the original destination's partial artifacts
/// when the destination changed; the archive logic is run_job's own.
#[tauri::command]
pub fn job_retry_options(
    handle: tauri::State<'_, QueueHandle>,
    settings: tauri::State<'_, crate::settings::SettingsHandle>,
    id: String,
    options: JobOptions,
    destination: Option<String>,
) -> AppResult<()> {
    let dest = resolve_destination(destination, &settings.get());
    handle.0.retry_with_options(&id, &options, &dest)
}

#[tauri::command]
pub fn job_remove(handle: tauri::State<'_, QueueHandle>, id: String) -> AppResult<()> {
    handle.0.remove(&id)
}

/// `queueList(): Job[]` — restore on app start + polling fallback.
#[tauri::command]
pub fn queue_list(handle: tauri::State<'_, QueueHandle>) -> AppResult<Vec<Job>> {
    handle.0.list()
}

/// d60: which of these urls would overwrite an existing file if queued now.
/// identity comes from the metadata memo (network only on a cold url), and
/// only the `[<id>]` filename pattern is scanned — the engine cannot know
/// yt-dlp's format suffix pre-run, so this is an over-approximation: any
/// file named "* [<id>].*" in the destination counts. playlists are
/// honestly excluded (yt-dlp's --download-archive already covers re-runs).
#[tauri::command]
pub async fn overwrite_targets(
    memo: tauri::State<'_, crate::commands::metadata::Memo>,
    settings: tauri::State<'_, crate::settings::SettingsHandle>,
    urls: Vec<String>,
    playlist_single: bool,
    skip_downloaded: bool,
) -> AppResult<Vec<OverwriteTarget>> {
    // playlist jobs are honestly excluded: their identity is the playlist,
    // per-item files are covered by yt-dlp's --download-archive on re-runs,
    // and predicting item filenames would be a guess.
    if !playlist_single {
        return Ok(Vec::new());
    }
    let dest = settings
        .get()
        .destination
        .or_else(|| dirs::download_dir().map(|p| p.to_string_lossy().into_owned()))
        .unwrap_or_else(|| std::env::temp_dir().to_string_lossy().into_owned());
    let dir = std::path::Path::new(&dest);
    let existing: Vec<String> = if dir.is_dir() {
        std::fs::read_dir(dir)
            .map(|rd| {
                rd.filter_map(|e| e.ok())
                    .map(|e| e.file_name().to_string_lossy().into_owned())
                    .collect()
            })
            .unwrap_or_default()
    } else {
        Vec::new()
    };

    let mut out = Vec::new();
    for url in urls {
        let url = url.trim().to_owned();
        if url.is_empty() {
            continue;
        }
        // single-video semantics (--no-playlist) match playlist_single mode
        let probe = crate::commands::metadata::resolve_memoized(&memo, &url).await;
        let identity = match probe {
            Err(_) => continue, // unresolvable = engine will error anyway
            Ok(identity) => identity,
        };
        // if the engine's archive pre-check will skip this anyway, queueing
        // is safe (no download, no postprocessors) — no dialog needed
        if skip_downloaded
            && archive_contains(
                &crate::store::default_archive_path(),
                &identity.extractor,
                &identity.id,
            )
        {
            continue;
        }
        let marker = format!(" [{}]", identity.id);
        let hit = existing
            .iter()
            .any(|f| f.contains(&marker) && !f.ends_with(".part"));
        if hit {
            let name = existing
                .iter()
                .find(|f| f.contains(&marker) && !f.ends_with(".part"))
                .cloned()
                .unwrap_or_default();
            out.push(OverwriteTarget {
                url,
                name,
                dest: dest.clone(),
            });
        }
    }
    Ok(out)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OverwriteTarget {
    pub url: String,
    /// the existing file's name (for the dialog text).
    pub name: String,
    pub dest: String,
}

/// both return the resulting paused state so the ui button renders truth
/// after restarts or concurrent clicks (D34).
#[tauri::command]
pub fn queue_pause(handle: tauri::State<'_, QueueHandle>) -> AppResult<bool> {
    handle.0.pause();
    Ok(handle.0.is_paused())
}

#[tauri::command]
pub fn queue_resume(handle: tauri::State<'_, QueueHandle>) -> AppResult<bool> {
    handle.0.resume();
    Ok(handle.0.is_paused())
}
