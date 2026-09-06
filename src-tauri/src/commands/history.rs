//! history commands (§7): list/search, archive import (D43/D75), relink,
//! reconcile (D64).

use std::path::PathBuf;
use std::sync::Arc;

use serde::Serialize;

use crate::error::{other, AppResult};
use crate::store::Db;

/// d75 import semantics — the user picks per import:
/// - `merge` (default): union — the app archive keeps all its entries and
///   gains the imported file's entries it was missing.
/// - `replace`: the app archive's content is replaced by the imported file.
///   history rows are never deleted (the db is a superset record); the
///   replaced entries simply stop counting as "already downloaded".
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ArchiveImportMode {
    Merge,
    Replace,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveImportResult {
    /// rows actually ADDED to the history db (not the raw line count — a
    /// re-import reports 0 new).
    pub ids_imported: usize,
    /// entries the app-owned archive gained (merge) or now holds (replace).
    pub archive_added: usize,
    /// where the app-owned archive lives (always app-data, D75).
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

/// d64/d75: sync history from the app-owned archive. backfills missing
/// history rows from archive ids (an archived-but-unrecorded download shows
/// as "already downloaded" with no trace); the reverse asymmetry self-heals
/// (a db row without an archive entry re-downloads and the engine
/// re-appends). idempotent. run on the app-owned archive only — D75 removed
/// the settings-configured archive path.
#[tauri::command]
pub fn archive_reconcile(db: tauri::State<'_, Arc<Db>>) -> AppResult<ReconcileReport> {
    let path = crate::store::default_archive_path();
    let text = match std::fs::read_to_string(&path) {
        Ok(t) => t,
        // no archive yet is a healthy empty state, not an error
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(ReconcileReport::default()),
        Err(e) => return Err(e.into()),
    };
    let ids_in_archive = crate::store::count_archive_ids(&path);
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

/// d75: export the app-owned archive to a user-chosen path — the sanctioned
/// way to hand the archive to other tools or keep a backup. the app copy
/// is never removed or moved; exporting is a pure copy.
#[tauri::command]
pub fn archive_export(dest: String) -> AppResult<usize> {
    let src = crate::store::default_archive_path();
    let text = std::fs::read_to_string(&src).unwrap_or_default();
    if text.trim().is_empty() {
        return Err(other("the archive is empty — nothing to export yet"));
    }
    let n = crate::store::count_archive_ids(&src);
    std::fs::write(&dest, &text)?;
    Ok(n as usize)
}

/// `historyImportArchive(path, mode)` (D75, superseding the D43 in-place
/// behavior): the app owns exactly one archive at app-data\downloaded.txt
/// and NEVER points its engine at the user's picked file — importing the
/// user's file as the live archive made "open archive" open a foreign file
/// and put the user's own download history outside the app's data dir.
/// instead the file is read, merged or replaced into the app archive, and
/// its ids seeded into history. the user's file is never modified.
#[tauri::command]
pub fn history_import_archive(
    db: tauri::State<'_, Arc<Db>>,
    path: String,
    mode: Option<ArchiveImportMode>,
) -> AppResult<ArchiveImportResult> {
    let src = PathBuf::from(&path);
    if !src.is_file() {
        return Err(other(format!("no such archive: {path}")));
    }
    let text = std::fs::read_to_string(&src)?;
    let dest = crate::store::default_archive_path();

    let archive_added = match mode.unwrap_or(ArchiveImportMode::Merge) {
        ArchiveImportMode::Merge => crate::store::merge_into_archive(&dest, &text)?,
        ArchiveImportMode::Replace => {
            // history rows are never deleted (the db is a superset record);
            // replaced entries just stop counting as already-downloaded.
            if let Some(dir) = dest.parent() {
                std::fs::create_dir_all(dir)?;
            }
            std::fs::write(&dest, &text)?;
            crate::store::count_archive_ids(&dest) as usize
        }
    };

    let ids_imported = db.seed_history_from_archive(&text)?;

    Ok(ArchiveImportResult {
        ids_imported,
        archive_added,
        archive_path: dest.to_string_lossy().into_owned(),
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
