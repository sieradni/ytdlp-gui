//! history commands (§7): list/search, archive import (D43), relink.

use std::path::PathBuf;
use std::sync::Arc;

use serde::Serialize;

use crate::error::{other, AppResult};
use crate::store::Db;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveImportResult {
    pub ids_imported: usize,
    /// where the archive now lives (unchanged in-place by default, D43).
    pub archive_path: String,
}

#[tauri::command]
pub fn history_list(
    db: tauri::State<'_, Arc<Db>>,
    filter: Option<String>,
) -> AppResult<Vec<crate::store::HistoryRow>> {
    db.list_history(filter.as_deref())
}

/// `historyImportArchive(path)` (D43): "import v1…" never moves the user's
/// file — default points settings at its existing path (read/write in
/// place), optional copy into app-data. ids are seeded into history either
/// way. `copy: true` copies the file into app-data first.
#[tauri::command]
pub fn history_import_archive(
    db: tauri::State<'_, Arc<Db>>,
    settings: tauri::State<'_, crate::settings::SettingsHandle>,
    path: String,
    copy: Option<bool>,
) -> AppResult<ArchiveImportResult> {
    let src = PathBuf::from(&path);
    if !src.is_file() {
        return Err(other(format!("no such archive: {path}")));
    }

    let final_path = if copy.unwrap_or(false) {
        let dest = crate::store::default_archive_path();
        std::fs::copy(&src, &dest)?;
        dest
    } else {
        src.clone()
    };

    // ids seeded into the history db either way (D43)
    let text = std::fs::read_to_string(&src)?;
    let n = db.seed_history_from_archive(&text)?;

    // settings now point at the archive (in place or the app-data copy)
    let mut s = settings.get();
    s.archive_path = Some(final_path.to_string_lossy().into_owned());
    settings.set(s)?;

    Ok(ArchiveImportResult {
        ids_imported: n,
        archive_path: final_path.to_string_lossy().into_owned(),
    })
}

/// D59: server-side existence probe so the re-download confirm gate can
/// check the history row's file without giving the renderer fs access (the
/// dialog plugin opens pickers, it does not probe). returns false for an
/// empty/missing path — the gate must not fire on rows without a file.
#[tauri::command]
pub fn file_exists(path: String) -> bool {
    !path.is_empty() && std::path::Path::new(&path).is_file()
}

/// `historyRelink(id, path)` — locate… / clear-path for moved files (§6).
/// `id` is "extractor vid" as shown in the ui.
#[tauri::command]
pub fn history_relink(
    db: tauri::State<'_, Arc<Db>>,
    id: String,
    path: Option<String>,
) -> AppResult<()> {
    let Some((extractor, vid)) = id.split_once(' ') else {
        return Err(other("expected id of the form `<extractor> <vid>`"));
    };
    db.relink_history(extractor, vid, path.as_deref())
}
