//! d93 thumbnail commands: bounded history prefetch + cache stats.
//!
//! the engine writes thumbs at run time (fetch-phase remote art, done-phase
//! local art); these commands only serve the history page's backfill —
//! rows written before d93, or stopped/errored jobs whose fetch never ran.
//! the renderer has no fs access, so everything routes through here.

use serde::Serialize;

use crate::error::AppResult;

/// backfill art for history rows lacking it. `items` are
/// `(extractor, vid, url)` triples; rows with an empty url (imported ids)
/// are skipped honestly — youtube is the exception (lookup-table art needs
/// no url). sequential, capped by `max` (the ui passes 24), and every
/// failure is tolerated: the returned list names only rows that got art.
/// idempotent: rows whose cache entry is already fresh are counted as done
/// without any network.
#[tauri::command]
pub async fn thumbs_prefetch_history(
    items: Vec<(String, String, String)>,
    max: Option<u32>,
) -> AppResult<Vec<(String, String, String)>> {
    let max = max.unwrap_or(24).clamp(1, 48) as usize;
    Ok(crate::engine::thumbs::prefetch_history(items, max).await)
}

/// cache shape for the settings page's diagnostics row.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThumbsStats {
    pub entries: usize,
    pub bytes: u64,
}

#[tauri::command]
pub fn thumbs_stats() -> ThumbsStats {
    let (entries, bytes) = crate::engine::thumbs::cache_stats();
    ThumbsStats { entries, bytes }
}
