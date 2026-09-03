pub mod binaries;
pub mod history;
pub mod jobs;
pub mod metadata;

use serde::Serialize;
use std::sync::atomic::{AtomicU64, Ordering};

use crate::error::AppResult;
use crate::settings::{Settings, SettingsHandle};

// ---------------------------------------------------------------------------
// ping — m1 typed-ipc probe, kept until the shell probe is removed
// ---------------------------------------------------------------------------

pub struct PingState {
    pub count: AtomicU64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Pong {
    pub message: String,
    pub ping_count: u64,
}

#[tauri::command]
pub fn ping(state: tauri::State<'_, PingState>, message: Option<String>) -> AppResult<Pong> {
    let count = state.count.fetch_add(1, Ordering::SeqCst) + 1;
    Ok(Pong {
        message: format!("pong: {}", message.as_deref().unwrap_or("(none)")),
        ping_count: count,
    })
}

// ---------------------------------------------------------------------------
// settings (§7) — autosave per D24: the frontend saves on every change
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn settings_get(state: tauri::State<'_, SettingsHandle>) -> Settings {
    state.get()
}

#[tauri::command]
pub fn settings_save(
    state: tauri::State<'_, SettingsHandle>,
    queue: tauri::State<'_, jobs::QueueHandle>,
    settings: Settings,
) -> AppResult<()> {
    // concurrency applies live (§5: configurable in settings → downloads)
    let concurrency = settings.concurrency;
    state.set(settings)?;
    if let Some(n) = concurrency {
        queue.0.set_concurrency(n as usize);
    }
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppPaths {
    pub archive_path: String,
    pub bin_dir: String,
}

/// paths the settings page and history footer link to (§4/§6).
#[tauri::command]
pub fn app_paths() -> AppPaths {
    AppPaths {
        archive_path: crate::store::archive_path_from_settings()
            .to_string_lossy()
            .into_owned(),
        bin_dir: crate::binaries::manager::bin_dir()
            .to_string_lossy()
            .into_owned(),
    }
}

// ---------------------------------------------------------------------------
// migration status (§11): what the v1 migration found at this launch — the
// wizard offers the v1 binaries as custom copies; the composer adopts the
// migrated defaults. None when no v1 config exists.
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn migration_status(
    state: tauri::State<'_, Option<crate::migrate::MigrationReport>>,
) -> Option<crate::migrate::MigrationReport> {
    state.inner().clone()
}

// ---------------------------------------------------------------------------
// appVersion (§7)
// ---------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppVersions {
    pub app: String,
    pub yt_dlp: Option<String>,
    pub ffmpeg: Option<String>,
}

#[tauri::command]
pub fn app_version(app: tauri::AppHandle) -> AppResult<AppVersions> {
    let m = crate::binaries::manager::load_manifest()?;
    let version_of =
        |tool: crate::binaries::sources::Tool| m.entry(tool).map(|e| e.version.clone());
    Ok(AppVersions {
        app: app.package_info().version.to_string(),
        yt_dlp: version_of(crate::binaries::sources::Tool::YtDlp),
        ffmpeg: version_of(crate::binaries::sources::Tool::Ffmpeg),
    })
}
