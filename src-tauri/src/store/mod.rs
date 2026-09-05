//! sqlite storage (§5.3): history.db is metadata only — downloaded.txt stays
//! the source of truth for skip logic (D17). jobs persist across restarts
//! (§5 queue model) with D35 restart semantics applied at load.

use std::path::Path;
use std::sync::Mutex;

use rusqlite::Connection;

use crate::error::AppResult;

pub struct Db(Mutex<Connection>);

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobRow {
    pub id: String,
    /// composer options (json).
    pub options: String,
    pub dest: String,
    /// queued | fetching | downloading | post | done | stopped | error
    pub state: String,
    pub title: Option<String>,
    pub format: Option<String>,
    pub final_path: Option<String>,
    pub pct: Option<f64>,
    pub speed_bps: Option<f64>,
    pub eta_sec: Option<u64>,
    pub error: Option<String>,
    /// duplicate-skip marker (§5.2): done without side effects.
    #[serde(default)]
    pub skipped: bool,
    /// playlist progress (D33): items done / total for the running job.
    /// null for single-video jobs (or older yt-dlp that prints no counter).
    #[serde(default)]
    pub items_done: Option<u32>,
    #[serde(default)]
    pub items_total: Option<u32>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryRow {
    pub extractor: String,
    pub vid: String,
    /// source url, kept for re-download (D19: current settings + destination).
    pub url: Option<String>,
    pub title: Option<String>,
    pub channel: Option<String>,
    pub duration_sec: Option<i64>,
    pub size_bytes: Option<i64>,
    pub format: Option<String>,
    pub final_path: Option<String>,
    pub error: Option<String>,
    pub downloaded_at: i64,
}

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  options TEXT NOT NULL,
  dest TEXT NOT NULL,
  state TEXT NOT NULL,
  title TEXT,
  format TEXT,
  final_path TEXT,
  pct REAL,
  speed_bps REAL,
  eta_sec INTEGER,
  error TEXT,
  skipped INTEGER NOT NULL DEFAULT 0,
  items_done INTEGER,
  items_total INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS history (
  extractor TEXT NOT NULL,
  vid TEXT NOT NULL,
  url TEXT,
  title TEXT,
  channel TEXT,
  duration_sec INTEGER,
  size_bytes INTEGER,
  format TEXT,
  final_path TEXT,
  error TEXT,
  downloaded_at INTEGER NOT NULL,
  PRIMARY KEY (extractor, vid)
);
"#;

impl Db {
    pub fn open(path: &Path) -> AppResult<Self> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let conn = Connection::open(path)?;
        conn.execute_batch(SCHEMA)?;
        ensure_columns(&conn);
        Ok(Db(Mutex::new(conn)))
    }

    #[cfg(test)]
    pub fn open_in_memory() -> AppResult<Self> {
        let conn = Connection::open_in_memory()?;
        conn.execute_batch(SCHEMA)?;
        ensure_columns(&conn);
        Ok(Db(Mutex::new(conn)))
    }

    fn conn(&self) -> std::sync::MutexGuard<'_, Connection> {
        self.0.lock().expect("db mutex poisoned")
    }

    /// exclusive handle for maintenance (d69 reset / artifact cleanup):
    /// same mutex as every other accessor, exposed for multi-statement
    /// destructive work (DELETE + VACUUM) that must run as one unit.
    pub fn conn_for_maintenance(&self) -> std::sync::MutexGuard<'_, Connection> {
        self.conn()
    }

    // ----- jobs -----

    pub fn insert_job(&self, j: &JobRow) -> AppResult<()> {
        self.conn().execute(
            "INSERT INTO jobs (id, options, dest, state, title, format, final_path, pct, speed_bps, eta_sec, error, skipped, items_done, items_total, created_at, updated_at)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16)",
            rusqlite::params![
                j.id, j.options, j.dest, j.state, j.title, j.format, j.final_path,
                j.pct, j.speed_bps, j.eta_sec.map(|v| v as i64), j.error,
                j.skipped as i64, j.items_done.map(|v| v as i64), j.items_total.map(|v| v as i64),
                j.created_at, j.updated_at
            ],
        )?;
        Ok(())
    }

    pub fn update_job(&self, id: &str, j: &JobRow) -> AppResult<()> {
        self.conn().execute(
            "UPDATE jobs SET options=?2, dest=?3, state=?4, title=?5, format=?6, final_path=?7, pct=?8, speed_bps=?9, eta_sec=?10, error=?11, skipped=?12, items_done=?13, items_total=?14, updated_at=?15 WHERE id=?1",
            rusqlite::params![
                id, j.options, j.dest, j.state, j.title, j.format, j.final_path,
                j.pct, j.speed_bps, j.eta_sec.map(|v| v as i64), j.error,
                j.skipped as i64, j.items_done.map(|v| v as i64), j.items_total.map(|v| v as i64),
                j.updated_at
            ],
        )?;
        Ok(())
    }

    /// list jobs in insertion order (queue order default, §6).
    pub fn list_jobs(&self) -> AppResult<Vec<JobRow>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT id, options, dest, state, title, format, final_path, pct, speed_bps, eta_sec, error, skipped, items_done, items_total, created_at, updated_at
             FROM jobs ORDER BY created_at ASC, rowid ASC",
        )?;
        let rows = stmt
            .query_map([], row_to_job)?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    pub fn delete_job(&self, id: &str) -> AppResult<()> {
        self.conn().execute("DELETE FROM jobs WHERE id=?1", [id])?;
        Ok(())
    }

    /// D35: on launch, running/post jobs → Stopped, fetching → Queued.
    /// nothing auto-resumes.
    pub fn normalize_after_restart(&self) -> AppResult<()> {
        let now = now_unix();
        let conn = self.conn();
        conn.execute(
            "UPDATE jobs SET state='stopped', error='app restarted', updated_at=?1
             WHERE state IN ('downloading','post')",
            [now],
        )?;
        conn.execute(
            "UPDATE jobs SET state='queued', updated_at=?1 WHERE state='fetching'",
            [now],
        )?;
        Ok(())
    }

    // ----- history (metadata only, §5.3) -----

    pub fn upsert_history(&self, h: &HistoryRow) -> AppResult<()> {
        self.conn().execute(
            "INSERT INTO history (extractor, vid, url, title, channel, duration_sec, size_bytes, format, final_path, error, downloaded_at)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)
             ON CONFLICT(extractor, vid) DO UPDATE SET
               url=COALESCE(excluded.url, url),
               title=COALESCE(excluded.title, title),
               channel=COALESCE(excluded.channel, channel),
               duration_sec=COALESCE(excluded.duration_sec, duration_sec),
               size_bytes=COALESCE(excluded.size_bytes, size_bytes),
               format=COALESCE(excluded.format, format),
               final_path=COALESCE(excluded.final_path, final_path),
               error=COALESCE(excluded.error, error),
               downloaded_at=excluded.downloaded_at",
            rusqlite::params![
                h.extractor, h.vid, h.url, h.title, h.channel, h.duration_sec, h.size_bytes,
                h.format, h.final_path, h.error, h.downloaded_at
            ],
        )?;
        Ok(())
    }

    /// history list, newest first; filter is a substring match on
    /// title/channel/extractor+id/final_path (§6 history search). IFNULL so
    /// rows with NULL fields aren't silently dropped by LIKE semantics.
    pub fn list_history(&self, filter: Option<&str>) -> AppResult<Vec<HistoryRow>> {
        let conn = self.conn();
        let like = filter
            .map(|f| format!("%{}%", f.replace(['%', '_'], "")))
            .unwrap_or_else(|| "%".to_owned());
        let mut stmt = conn.prepare(
            "SELECT extractor, vid, url, title, channel, duration_sec, size_bytes, format, final_path, error, downloaded_at
             FROM history
             WHERE IFNULL(title,'') LIKE ?1 OR IFNULL(channel,'') LIKE ?1
                OR extractor || ' ' || vid LIKE ?1 OR IFNULL(final_path,'') LIKE ?1
             ORDER BY downloaded_at DESC",
        )?;
        let rows = stmt
            .query_map([&like], row_to_history)?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    /// re-link a moved file (§6 history: locate… / clear-path).
    pub fn relink_history(&self, extractor: &str, vid: &str, path: Option<&str>) -> AppResult<()> {
        self.conn().execute(
            "UPDATE history SET final_path=?3 WHERE extractor=?1 AND vid=?2",
            rusqlite::params![extractor, vid, path],
        )?;
        Ok(())
    }

    /// D43: seed history ids from a downloaded.txt-style archive
    /// (`<extractor> <id>` lines). returns the number of ids imported.
    pub fn seed_history_from_archive(&self, text: &str) -> AppResult<usize> {
        let now = now_unix();
        let mut n = 0;
        let conn = self.conn();
        for line in text.lines() {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            let Some((extractor, vid)) = line.split_once(' ') else {
                continue;
            };
            let (extractor, vid) = (extractor.trim(), vid.trim());
            if extractor.is_empty() || vid.is_empty() {
                continue;
            }
            conn.execute(
                "INSERT OR IGNORE INTO history (extractor, vid, downloaded_at) VALUES (?1,?2,?3)",
                rusqlite::params![extractor, vid, now],
            )?;
            n += 1;
        }
        Ok(n)
    }

    /// d64 archive→history reconciliation, phase 1 of `archive_reconcile`:
    /// every archive id missing from history becomes an imported row (only
    /// when it is genuinely absent — idempotent across re-runs). returns the
    /// number of rows added.
    pub fn backfill_history_from_archive(&self, text: &str) -> AppResult<usize> {
        let now = now_unix();
        let conn = self.conn();
        let mut added = 0;
        for line in text.lines() {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            let Some((extractor, vid)) = line.split_once(' ') else {
                continue;
            };
            let (extractor, vid) = (extractor.trim(), vid.trim());
            if extractor.is_empty() || vid.is_empty() {
                continue;
            }
            let present: i64 = conn.query_row(
                "SELECT COUNT(*) FROM history WHERE extractor=?1 AND vid=?2",
                rusqlite::params![extractor, vid],
                |r| r.get(0),
            )?;
            if present > 0 {
                continue;
            }
            conn.execute(
                "INSERT INTO history (extractor, vid, downloaded_at) VALUES (?1,?2,?3)",
                rusqlite::params![extractor, vid, now],
            )?;
            added += 1;
        }
        Ok(added)
    }

    /// d64 phase 2: which history rows have no url recorded (imported ids
    /// only)? these render "source url unknown" in the ui — the report is
    /// what makes the asymmetry visible instead of silent.
    pub fn history_rows_without_url(&self) -> AppResult<u64> {
        let n: i64 = self.conn().query_row(
            "SELECT COUNT(*) FROM history WHERE url IS NULL OR url=''",
            [],
            |r| r.get(0),
        )?;
        Ok(n.max(0) as u64)
    }
}

fn row_to_job(row: &rusqlite::Row<'_>) -> rusqlite::Result<JobRow> {
    Ok(JobRow {
        id: row.get(0)?,
        options: row.get(1)?,
        dest: row.get(2)?,
        state: row.get(3)?,
        title: row.get(4)?,
        format: row.get(5)?,
        final_path: row.get(6)?,
        pct: row.get(7)?,
        speed_bps: row.get(8)?,
        eta_sec: row.get::<_, Option<i64>>(9)?.map(|v| v.max(0) as u64),
        error: row.get(10)?,
        skipped: row.get::<_, i64>(11)? != 0,
        items_done: row.get::<_, Option<i64>>(12)?.map(|v| v.max(0) as u32),
        items_total: row.get::<_, Option<i64>>(13)?.map(|v| v.max(0) as u32),
        created_at: row.get(14)?,
        updated_at: row.get(15)?,
    })
}

fn row_to_history(row: &rusqlite::Row<'_>) -> rusqlite::Result<HistoryRow> {
    Ok(HistoryRow {
        extractor: row.get(0)?,
        vid: row.get(1)?,
        url: row.get(2)?,
        title: row.get(3)?,
        channel: row.get(4)?,
        duration_sec: row.get(5)?,
        size_bytes: row.get(6)?,
        format: row.get(7)?,
        final_path: row.get(8)?,
        error: row.get(9)?,
        downloaded_at: row.get(10)?,
    })
}

pub fn now_unix() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

pub fn db_path() -> std::path::PathBuf {
    crate::binaries::manager::app_data_dir().join("history.db")
}

/// columns added after the schema first shipped (m4): ALTER TABLE for
/// databases created by older builds. CREATE TABLE IF NOT EXISTS above
/// covers fresh installs; this covers the in-place upgrade path.
fn ensure_columns(conn: &Connection) {
    let existing: std::collections::HashSet<String> = {
        let mut stmt = conn
            .prepare("SELECT name FROM pragma_table_info('jobs')")
            .expect("pragma jobs");
        let names = stmt
            .query_map([], |r| r.get::<_, String>(0))
            .expect("pragma query")
            .filter_map(Result::ok)
            .collect();
        names
    };
    for (col, ddl) in [
        (
            "items_done",
            "ALTER TABLE jobs ADD COLUMN items_done INTEGER",
        ),
        (
            "items_total",
            "ALTER TABLE jobs ADD COLUMN items_total INTEGER",
        ),
    ] {
        if !existing.contains(col) {
            if let Err(e) = conn.execute_batch(ddl) {
                eprintln!("history.db: adding column {col} failed: {e}");
            }
        }
    }
}

/// does the archive file contain `<extractor> <vid>`? (D17: downloaded.txt is
/// the skip source of truth; consult before queueing a resolved identity).
/// extractor matching is case-insensitive: yt-dlp's writer emits `soundcloud`
/// while probe surfaces print `Soundcloud` — a case-sensitive match silently
/// missed real entries (found live, e2e s20). video ids stay exact.
pub fn archive_contains(archive_path: &Path, extractor: &str, vid: &str) -> bool {
    match std::fs::read_to_string(archive_path) {
        Ok(text) => text.lines().any(|l| {
            let l = l.trim();
            match l.split_once(' ') {
                Some((ex, id)) => ex.eq_ignore_ascii_case(extractor) && id == vid,
                None => false,
            }
        }),
        Err(_) => false,
    }
}

/// append an `<extractor> <id>` line to the archive (engine write rule, §5.2:
/// the engine appends itself after each successful job — idempotent).
pub fn archive_append(archive_path: &Path, extractor: &str, vid: &str) -> AppResult<()> {
    use std::io::Write;
    if let Some(dir) = archive_path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    if archive_contains(archive_path, extractor, vid) {
        return Ok(()); // idempotent
    }
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(archive_path)?;
    writeln!(f, "{extractor} {vid}")?;
    Ok(())
}

/// default archive location (§4 layout): app-data\downloaded.txt.
pub fn default_archive_path() -> std::path::PathBuf {
    crate::binaries::manager::app_data_dir().join("downloaded.txt")
}

pub fn archive_path_from_settings() -> std::path::PathBuf {
    crate::settings::load()
        .archive_path
        .map(std::path::PathBuf::from)
        .unwrap_or_else(default_archive_path)
}

/// same, from an in-memory settings value (for callers already holding the
/// handle's snapshot — avoids a second disk read mid-command).
pub fn archive_path_from_settings_with(s: &crate::settings::Settings) -> std::path::PathBuf {
    s.archive_path
        .clone()
        .map(std::path::PathBuf::from)
        .unwrap_or_else(default_archive_path)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn job(id: &str, state: &str) -> JobRow {
        JobRow {
            id: id.into(),
            options: "{}".into(),
            dest: r"C:\dl".into(),
            state: state.into(),
            title: None,
            format: None,
            final_path: None,
            pct: None,
            speed_bps: None,
            eta_sec: None,
            error: None,
            skipped: false,
            items_done: None,
            items_total: None,
            created_at: 1,
            updated_at: 1,
        }
    }

    #[test]
    fn jobs_roundtrip_and_order() {
        let db = Db::open_in_memory().unwrap();
        db.insert_job(&job("a", "queued")).unwrap();
        db.insert_job(&job("b", "downloading")).unwrap();
        let all = db.list_jobs().unwrap();
        assert_eq!(all.len(), 2);
        assert_eq!(all[0].id, "a");

        let mut b = job("b", "done");
        b.final_path = Some(r"C:\dl\x.mp4".into());
        b.pct = Some(100.0);
        db.update_job("b", &b).unwrap();
        let all = db.list_jobs().unwrap();
        assert_eq!(all[1].state, "done");
        assert_eq!(all[1].final_path.as_deref(), Some(r"C:\dl\x.mp4"));

        db.delete_job("a").unwrap();
        assert_eq!(db.list_jobs().unwrap().len(), 1);
    }

    #[test]
    fn restart_normalization_matches_d35() {
        let db = Db::open_in_memory().unwrap();
        db.insert_job(&job("run", "downloading")).unwrap();
        db.insert_job(&job("post", "post")).unwrap();
        db.insert_job(&job("fetch", "fetching")).unwrap();
        db.insert_job(&job("q", "queued")).unwrap();
        db.insert_job(&job("done", "done")).unwrap();
        db.normalize_after_restart().unwrap();
        let states: Vec<(String, String)> = db
            .list_jobs()
            .unwrap()
            .into_iter()
            .map(|j| (j.id, j.state))
            .collect();
        assert_eq!(
            states,
            vec![
                ("run".into(), "stopped".into()),
                ("post".into(), "stopped".into()),
                ("fetch".into(), "queued".into()),
                ("q".into(), "queued".into()),
                ("done".into(), "done".into()),
            ]
        );
    }

    #[test]
    fn history_upsert_and_search() {
        let db = Db::open_in_memory().unwrap();
        db.upsert_history(&HistoryRow {
            extractor: "youtube".into(),
            vid: "abc".into(),
            url: Some("https://youtu.be/abc".into()),
            title: Some("Sunset Timelapse".into()),
            channel: Some("Noscope".into()),
            duration_sec: Some(45),
            size_bytes: Some(1024),
            format: Some("2160p webm".into()),
            final_path: Some(r"C:\dl\sunset.webm".into()),
            error: None,
            downloaded_at: 100,
        })
        .unwrap();
        // second entry, then filter
        db.upsert_history(&HistoryRow {
            extractor: "youtube".into(),
            vid: "def".into(),
            url: Some("https://youtube.com/watch?v=def".into()),
            title: Some("Lecture 12".into()),
            channel: Some("MIT OCW".into()),
            duration_sec: None,
            size_bytes: None,
            format: None,
            final_path: None,
            error: None,
            downloaded_at: 200,
        })
        .unwrap();
        assert_eq!(db.list_history(None).unwrap().len(), 2);
        let hits = db.list_history(Some("lecture")).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].vid, "def");
        // newest first
        assert_eq!(db.list_history(None).unwrap()[0].vid, "def");

        // relink
        db.relink_history("youtube", "def", Some(r"D:\new\lec.mp4"))
            .unwrap();
        assert_eq!(
            db.list_history(Some("lecture")).unwrap()[0]
                .final_path
                .as_deref(),
            Some(r"D:\new\lec.mp4")
        );
    }

    #[test]
    fn archive_seed_imports_id_lines_only() {
        let db = Db::open_in_memory().unwrap();
        let text = "youtube abc123\n\
                    youtube def456\n\
                    # comment\n\
                    notapair\n\
                    vimeo 99887766\n";
        let n = db.seed_history_from_archive(text).unwrap();
        assert_eq!(n, 3);
        assert_eq!(db.list_history(None).unwrap().len(), 3);
    }

    #[test]
    fn backfill_is_idempotent_and_reports_only_new_rows_d64() {
        let db = Db::open_in_memory().unwrap();
        let text = "youtube abc123\nyoutube def456\n# c\nbadline\n";
        assert_eq!(db.backfill_history_from_archive(text).unwrap(), 2);
        // re-run: nothing new
        assert_eq!(db.backfill_history_from_archive(text).unwrap(), 0);
        // an existing row (even url-less, from D43 seeding) is never duplicated
        assert_eq!(
            db.backfill_history_from_archive("youtube abc123\n")
                .unwrap(),
            0
        );
        let rows = db.list_history(None).unwrap();
        assert_eq!(rows.len(), 2);
        // imported rows carry no url — the ui's "paste the url" affordance
        assert!(rows.iter().all(|r| r.url.is_none()));
        assert_eq!(db.history_rows_without_url().unwrap(), 2);
    }

    #[test]
    fn archive_append_is_idempotent() {
        let dir = std::env::temp_dir().join(format!("yg-arch-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("downloaded.txt");
        archive_append(&p, "youtube", "abc").unwrap();
        archive_append(&p, "youtube", "abc").unwrap();
        archive_append(&p, "youtube", "def").unwrap();
        let text = std::fs::read_to_string(&p).unwrap();
        assert_eq!(text.lines().count(), 2);
        assert!(archive_contains(&p, "youtube", "abc"));
        assert!(!archive_contains(&p, "youtube", "zzz"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn archive_contains_is_case_insensitive_on_extractor() {
        // real shapes: the engine writes `soundcloud` (via %(extractor)s)
        // while probe surfaces print `Soundcloud` (via %(extractor_key)s) —
        // a case-sensitive match silently missed the entry (found live,
        // e2e s20, d59 gate false-positive).
        let dir = std::env::temp_dir().join(format!("yg-arch-ci-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("downloaded.txt");
        std::fs::write(&p, "soundcloud 293\nyoutube jNQXAC9IVRw\n").unwrap();
        assert!(archive_contains(&p, "Soundcloud", "293"));
        assert!(archive_contains(&p, "SOUNDCLOUD", "293"));
        assert!(archive_contains(&p, "soundcloud", "293"));
        assert!(archive_contains(&p, "YouTube", "jNQXAC9IVRw"));
        // video id stays exact — no sloppy matching
        assert!(!archive_contains(&p, "soundcloud", "29"));
        assert!(!archive_contains(&p, "vimeo", "293"));
        // malformed lines (no space) never match
        std::fs::write(&p, "garbage\n").unwrap();
        assert!(!archive_contains(&p, "garbage", ""));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn job_counter_columns_roundtrip() {
        // m4: items_done/items_total — insert + update + read back
        let db = Db::open_in_memory().unwrap();
        let mut j = job("c", "downloading");
        j.items_done = Some(3);
        j.items_total = Some(12);
        db.insert_job(&j).unwrap();
        let got = db.list_jobs().unwrap().remove(0);
        assert_eq!((got.items_done, got.items_total), (Some(3), Some(12)));

        j.items_done = Some(4);
        db.update_job("c", &j).unwrap();
        let got = db.list_jobs().unwrap().remove(0);
        assert_eq!(got.items_done, Some(4));
        assert_eq!(got.items_total, Some(12));
    }

    #[test]
    fn ensure_columns_upgrades_pre_m4_databases() {
        // simulate a database created before items_done/items_total existed:
        // create the old-schema table, then open through Db::open and verify
        // the counter columns work.
        let dir = std::env::temp_dir().join(format!("yg-mig-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("history.db");
        {
            let conn = rusqlite::Connection::open(&path).unwrap();
            conn.execute_batch(
                "CREATE TABLE jobs (
                    id TEXT PRIMARY KEY, options TEXT NOT NULL, dest TEXT NOT NULL,
                    state TEXT NOT NULL, title TEXT, format TEXT, final_path TEXT,
                    pct REAL, speed_bps REAL, eta_sec INTEGER, error TEXT,
                    skipped INTEGER NOT NULL DEFAULT 0,
                    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
                );",
            )
            .unwrap();
        }
        let db = Db::open(&path).unwrap();
        let mut j = job("old", "queued");
        j.items_done = Some(1);
        j.items_total = Some(5);
        db.insert_job(&j).unwrap();
        let got = db.list_jobs().unwrap().remove(0);
        assert_eq!((got.items_done, got.items_total), (Some(1), Some(5)));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
