//! binary management commands (§7). thin wrappers: logic lives in
//! `binaries::manager`, so everything is unit-testable without tauri.

use tauri::Emitter;

use crate::binaries::manager::{self, BinaryManifest, InstallResult, ToolStatus};
use crate::binaries::sources::{self, Tool};
use crate::error::AppResult;

/// `binariesStatus(): BinaryManifest` — what's installed, versions, staged
/// swaps; `ready` gates the first-run wizard. also applies any swaps staged
/// by a previous update while an exe was locked (§4).
#[tauri::command]
pub fn binaries_status() -> AppResult<BinaryManifest> {
    let mut m = manager::load_manifest()?;
    manager::apply_staged_swaps(&mut m)?;
    Ok(manager::status(&m))
}

/// `binariesInstall(): StreamedProgress` — first-run download of both tools
/// (yt-dlp + ffmpeg). emits `binaries:progress` per tool while downloading.
#[tauri::command]
pub async fn binaries_install(app: tauri::AppHandle) -> AppResult<Vec<InstallResult>> {
    let mut results = Vec::new();
    for tool in [Tool::YtDlp, Tool::Ffmpeg] {
        let m = manager::load_manifest()?;
        let previous = m.entry(tool).map(|e| (e.source.clone(), e.etag.clone()));
        let prev_ref = previous.as_ref().map(|(s, e)| (s.as_str(), e.as_deref()));
        results.push(manager::install_or_update(&app, tool, prev_ref).await?);
    }
    Ok(results)
}

/// `binariesUpdate(tool)` — user-initiated only (D20: the UI never calls this
/// automatically for ffmpeg; yt-dlp's scheduled check only sets a badge).
/// the etag is deliberately NOT replayed here: `binaries_check_latest` just
/// recorded it, and an explicit update click must never 304 into an error —
/// it (re)fetches the release and reinstalls unconditionally.
#[tauri::command]
pub async fn binaries_update(app: tauri::AppHandle, tool: Tool) -> AppResult<InstallResult> {
    manager::install_or_update(&app, tool, None).await
}

/// `binariesCheckLatest(tool): LatestInfo` — one conditional github query.
/// never downloads anything; refreshes the settings badge (D20, D42).
#[tauri::command]
pub async fn binaries_check_latest(app: tauri::AppHandle, tool: Tool) -> AppResult<ToolStatus> {
    let client = sources::http()?;
    let m = manager::load_manifest()?;
    let previous = m.entry(tool).map(|e| (e.source.clone(), e.etag.clone()));
    let prev_ref = previous.as_ref().map(|(s, e)| (s.as_str(), e.as_deref()));

    // 304 = nothing newer since last check — a healthy result, not an error.
    // single api call either way (unauthenticated github rate limit is 60/h).
    let rel = match sources::latest_release(&client, tool, prev_ref).await? {
        None => {
            manager::touch_check(tool)?;
            return Ok(manager::status(&manager::load_manifest()?).tool_status(tool));
        }
        Some(rel) => rel,
    };

    let update_available = manager::record_check(tool, &rel)?.is_some();
    if update_available {
        let _ = app.emit(
            "update:available",
            serde_json::json!({ "tool": tool.display_name(), "to": rel.tag }),
        );
    }
    Ok(manager::status(&manager::load_manifest()?).tool_status(tool))
}

/// custom-executable escape hatch (D40): empty string clears the override.
#[tauri::command]
pub fn binaries_set_custom_path(tool: Tool, path: Option<String>) -> AppResult<ToolStatus> {
    manager::set_custom_path(tool, path)
}
