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

/// d64: the archive↔history asymmetry report. `ids_in_archive` counts the
/// parseable entries; `rows_backfilled` counts history rows that were
/// created (archive id with no db row — previously invisible); `rows_without_url`
/// counts rows that can never be re-downloaded from the ui (imported ids).
/// `archive_missing` entries listed in the archive whose db row claims a
/// file that no longer exists are surfaced in the ui, never pruned.
#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ReconcileReport {
    pub ids_in_archive: u64,
    pub rows_backfilled: u64,
    pub rows_without_url: u64,
}

/// d64: reconcile the download archive against the history db — run on the
/// settings-configured archive (or the default location). backfills missing
/// history rows from archive ids (engine skips them silently today: an
/// archived-but-unrecorded download shows as "already downloaded" with no
/// trace); the reverse asymmetry self-heals (a db row without an archive
/// entry re-downloads and the engine re-appends). idempotent.
#[tauri::command]
pub fn archive_reconcile(
    db: tauri::State<'_, Arc<Db>>,
    settings: tauri::State<'_, crate::settings::SettingsHandle>,
) -> AppResult<ReconcileReport> {
    let path = crate::store::archive_path_from_settings_with(&settings.get());
    let text = match std::fs::read_to_string(&path) {
        Ok(t) => t,
        // no archive yet is a healthy empty state, not an error
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(ReconcileReport::default()),
        Err(e) => return Err(e.into()),
    };
    let ids_in_archive = text
        .lines()
        .filter(|l| {
            let l = l.trim();
            !l.is_empty()
                && !l.starts_with('#')
                && l.split_once(' ')
                    .is_some_and(|(a, b)| !a.trim().is_empty() && !b.trim().is_empty())
        })
        .count() as u64;
    let rows_backfilled = db.backfill_history_from_archive(&text)? as u64;
    let rows_without_url = db.history_rows_without_url()?;
    Ok(ReconcileReport {
        ids_in_archive,
        rows_backfilled,
        rows_without_url,
    })
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
