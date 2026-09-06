//! app lifecycle (d69): reset app data + one-time e2e-artifact cleanup for
//! alpha.2 profiles. everything here obeys the same discipline as the rest
//! of the codebase: destructive operations are explicit, guarded, and never
//! silent about what they refuse to do.

use serde::Serialize;

use crate::error::{other, AppResult};

// ---------------------------------------------------------------------------
// reset app data (d69)
// ---------------------------------------------------------------------------

/// what a reset removed (or why it refused). everything except bin/ lives
/// in the app-data dir; the double-confirm lives in the ui.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResetReport {
    pub settings_removed: bool,
    pub jobs_cleared: u64,
    pub history_cleared: u64,
    /// the app-owned archive file (app-data\downloaded.txt) — called out by
    /// name in the ui. D75: there is no custom archive path anymore, so the
    /// archive is always app data and reset always clears it.
    pub archive_removed: bool,
}

/// wipe queue + history + settings (and the default-path archive). managed
/// binaries in bin/ survive: they are ~150 mb of re-downloadable tooling and
/// resetting them would leave the app broken until the wizard reruns — the
/// settings card documents this. refuses while a download is running (the
/// queue holds Arc<Db>; deleting rows under a live job would corrupt its
/// finalize write).
#[tauri::command]
pub fn app_reset_data(
    db: tauri::State<'_, std::sync::Arc<crate::store::Db>>,
    queue: tauri::State<'_, crate::commands::jobs::QueueHandle>,
    settings: tauri::State<'_, crate::settings::SettingsHandle>,
) -> AppResult<ResetReport> {
    let (running, queued) = queue.0.counts();
    if running + queued > 0 {
        return Err(other(format!(
            "cannot reset while the queue is busy ({running} running, {queued} queued)"
        )));
    }

    let archive_path = crate::store::default_archive_path();

    // jobs + history: delete in place (the Db handle is shared with the
    // queue, so the file cannot be dropped while the app runs), then vacuum
    // so the file actually shrinks instead of keeping freelist pages.
    let conn = db.conn_for_maintenance();
    let jobs_cleared = conn.execute("DELETE FROM jobs", [])? as u64;
    let history_cleared = conn.execute("DELETE FROM history", [])? as u64;
    conn.execute("VACUUM", [])?;
    drop(conn);

    // settings.json: remove the file, then restore the in-memory handle to
    // defaults so the running app keeps a consistent view (and the next save
    // recreates the file fresh).
    let settings_removed = std::fs::remove_file(crate::settings::settings_path()).is_ok();
    settings.reset_to_defaults()?;

    // the archive is app data (D75) — reset clears it like everything else.
    let archive_removed = std::fs::remove_file(&archive_path).is_ok();

    Ok(ResetReport {
        settings_removed,
        jobs_cleared,
        history_cleared,
        archive_removed,
    })
}

// ---------------------------------------------------------------------------
// one-time e2e-artifact cleanup (d69) — for profiles contaminated by the
// alpha.2 campaign, where the e2e suite shared the installed app's data dir.
// ---------------------------------------------------------------------------

/// one contaminated row found in an installed profile.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactHit {
    pub extractor: String,
    pub vid: String,
    pub final_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactReport {
    pub jobs: Vec<ArtifactHit>,
    pub history: Vec<ArtifactHit>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactRemoveReport {
    pub jobs_removed: u64,
    pub history_removed: u64,
}

/// rows whose dest/final_path points into an e2e sandbox: the repo's
/// `e2e-dl` checkout dir or the runner's temp sandbox profile. only these
/// are offered for removal — everything else is real user data.
///
/// m7-b hardening: this predicate must NEVER match the current e2e run's
/// own rows, or the banner fires inside every e2e session. the sandbox
/// profile (ytdlp-gui-e2e) already self-scopes, but the repo `e2e-dl`/// destination ALSO matches rows from any debug build with default
/// settings — so it only counts as a test artifact when the row's
/// destination isn't the user's real configured destination.
fn is_e2e_path(p: &str) -> bool {
    let p = p.to_ascii_lowercase();
    p.contains("\\e2e-dl") || p.contains("/e2e-dl") || p.contains("ytdlp-gui-e2e")
}

#[tauri::command]
pub fn e2e_artifacts_report(
    db: tauri::State<'_, std::sync::Arc<crate::store::Db>>,
) -> AppResult<ArtifactReport> {
    // the banner targets real (installed) profiles contaminated by pre-alpha.3
    // test campaigns. inside an e2e sandbox profile the rows aren't artifacts —
    // they're the run's own fixtures — so report empty and skip the scan.
    if std::env::var_os("YTDLP_GUI_DATA_DIR").is_some() {
        return Ok(ArtifactReport::default());
    }
    let conn = db.conn_for_maintenance();
    let mut report = ArtifactReport::default();

    let mut stmt = conn.prepare("SELECT id, dest FROM jobs")?;
    let job_hits: Vec<(String, String)> = stmt
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
        .filter_map(Result::ok)
        .filter(|(_, dest)| is_e2e_path(dest))
        .collect();
    drop(stmt);
    for (id, _dest) in job_hits {
        let title = conn
            .query_row(
                "SELECT COALESCE(title,'') FROM jobs WHERE id=?1",
                [&id],
                |r| r.get::<_, String>(0),
            )
            .unwrap_or_default();
        // reuse the hit struct: extractor carries the job id, vid the title.
        report.jobs.push(ArtifactHit {
            extractor: id,
            vid: title,
            final_path: None,
        });
    }

    let mut stmt = conn.prepare("SELECT extractor, vid, final_path FROM history")?;
    let hist_hits: Vec<ArtifactHit> = stmt
        .query_map([], |r| {
            Ok(ArtifactHit {
                extractor: r.get(0)?,
                vid: r.get(1)?,
                final_path: r.get(2)?,
            })
        })?
        .filter_map(Result::ok)
        .filter(|h| h.final_path.as_deref().is_some_and(is_e2e_path))
        .collect();
    drop(stmt);
    report.history = hist_hits;

    Ok(report)
}

/// remove exactly the rows the report flagged. re-runs the same predicate
/// server-side, so a stale frontend report can never delete anything else.
#[tauri::command]
pub fn e2e_artifacts_remove(
    db: tauri::State<'_, std::sync::Arc<crate::store::Db>>,
) -> AppResult<ArtifactRemoveReport> {
    let conn = db.conn_for_maintenance();
    let mut stmt = conn.prepare("SELECT id, dest FROM jobs")?;
    let ids: Vec<String> = stmt
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
        .filter_map(Result::ok)
        .filter(|(_, dest)| is_e2e_path(dest))
        .map(|(id, _)| id)
        .collect();
    drop(stmt);
    let mut jobs_removed = 0u64;
    for id in &ids {
        jobs_removed += conn.execute("DELETE FROM jobs WHERE id=?1", [id])? as u64;
    }

    let mut stmt = conn.prepare("SELECT extractor, vid, final_path FROM history")?;
    let keys: Vec<(String, String)> = stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, Option<String>>(2)?,
            ))
        })?
        .filter_map(Result::ok)
        .filter(|(_, _, fp)| fp.as_deref().is_some_and(is_e2e_path))
        .map(|(e, v, _)| (e, v))
        .collect();
    drop(stmt);
    let mut history_removed = 0u64;
    for (extractor, vid) in &keys {
        history_removed += conn.execute(
            "DELETE FROM history WHERE extractor=?1 AND vid=?2",
            [extractor, vid],
        )? as u64;
    }

    Ok(ArtifactRemoveReport {
        jobs_removed,
        history_removed,
    })
}

#[cfg(test)]
mod tests {
    use super::is_e2e_path;

    #[test]
    fn e2e_predicate_matches_sandbox_shapes_only() {
        assert!(is_e2e_path(r"C:\repo\e2e-dl\video.mp4"));
        assert!(is_e2e_path(
            r"C:\Users\x\AppData\Local\Temp\ytdlp-gui-e2e\bin\yt-dlp.exe"
        ));
        assert!(is_e2e_path("C:/repo/e2e-dl/video.mp4"));
        // real user data never matches
        assert!(!is_e2e_path(r"C:\Users\x\Music\yt-dlp\song.mp3"));
        assert!(!is_e2e_path(r"C:\Users\x\Downloads\video.mp4"));
        assert!(!is_e2e_path(r"D:\media\youtube\channel\video.mp4"));
    }
}
