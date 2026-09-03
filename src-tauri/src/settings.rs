//! settings store (§7 settingsGet/settingsSave). m2 keeps it minimal —
//! persistence for the wizard ("don't ask again") and defaults the tools
//! card needs; download defaults arrive with m3 (§6 settings page).

use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::error::AppResult;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    /// wizard was completed or deferred — don't auto-open it again.
    #[serde(default)]
    pub wizard_dismissed: bool,
    /// default destination for the m3 composer (persists from settings page).
    #[serde(default)]
    pub destination: Option<String>,
    /// concurrent downloads (default 2, §5).
    #[serde(default)]
    pub concurrency: Option<u32>,
    /// downloaded.txt location (defaults to app-data, §5.3).
    #[serde(default)]
    pub archive_path: Option<String>,
    /// §11 migration is one-shot: once applied, later launches never re-read
    /// the v1 config (that would clobber post-migration v2 settings changes).
    #[serde(default)]
    pub migrated_from_v1: bool,
}

fn settings_path() -> PathBuf {
    super::binaries::manager::app_data_dir().join("settings.json")
}

pub fn load() -> Settings {
    std::fs::read_to_string(settings_path())
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

/// atomic save (autosave per D24 writes on every change).
pub fn save(s: &Settings) -> AppResult<()> {
    let path = settings_path();
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_string_pretty(s)?)?;
    std::fs::rename(&tmp, &path)?;
    Ok(())
}

/// tauri-managed handle so commands share one canonical snapshot.
#[derive(Default)]
pub struct SettingsHandle(pub Mutex<Settings>);

impl SettingsHandle {
    pub fn get(&self) -> Settings {
        self.0.lock().map(|g| g.clone()).unwrap_or_default()
    }

    pub fn set(&self, s: Settings) -> AppResult<()> {
        save(&s)?;
        if let Ok(mut g) = self.0.lock() {
            *g = s;
        }
        Ok(())
    }
}
