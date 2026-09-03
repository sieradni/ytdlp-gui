pub mod binaries;

use serde::Serialize;
use std::sync::atomic::{AtomicU64, Ordering};

use crate::error::AppResult;
use crate::settings::{Settings, SettingsHandle};

// ---------------------------------------------------------------------------
// ping — m1 typed-ipc probe, kept until m3 replaces it with real status
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
pub fn settings_save(state: tauri::State<'_, SettingsHandle>, settings: Settings) -> AppResult<()> {
    state.set(settings)
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
