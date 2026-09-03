//! job commands (§7): queue add/stop/retry/remove/list, pause/resume.

use std::sync::Arc;

use serde::Serialize;

use crate::engine::args::JobOptions;
use crate::engine::queue::Job;
use crate::error::AppResult;

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
#[tauri::command]
pub fn job_add(
    handle: tauri::State<'_, QueueHandle>,
    settings: tauri::State<'_, crate::settings::SettingsHandle>,
    urls: Vec<String>,
    options: JobOptions,
    destination: Option<String>,
) -> AppResult<AddFeedback> {
    let dest = destination
        .or(settings.get().destination)
        .unwrap_or_else(|| {
            dirs::download_dir()
                .map(|p| p.to_string_lossy().into_owned())
                .unwrap_or_else(|| std::env::temp_dir().to_string_lossy().into_owned())
        });
    let (jobs, invalid, dupes) = handle.0.add_urls(&urls, &options, &dest)?;
    Ok(AddFeedback {
        jobs,
        invalid,
        duplicates_skipped: dupes,
    })
}

#[tauri::command]
pub fn job_stop(handle: tauri::State<'_, QueueHandle>, id: String) -> AppResult<()> {
    handle.0.stop(&id)
}

#[tauri::command]
pub fn job_retry(handle: tauri::State<'_, QueueHandle>, id: String) -> AppResult<()> {
    handle.0.retry(&id)
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
