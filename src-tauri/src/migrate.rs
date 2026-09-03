//! v1 migration (§11, D43): discover legacy `ytdlp_gui_config.json` +
//! `downloaded.txt` beside the old exe / in the cwd (D32: v1 stays untouched —
//! nothing is deleted or relocated). The archive import is **in place** (D43):
//! the file keeps living at the user's path and its ids seed the history db.
//!
//! composer option mapping ("migrated v1", §11 table) is a pure function so it
//! is unit-testable without touching the filesystem.

use std::path::PathBuf;

use serde::Serialize;

use crate::engine::args::{
    AudioFormat, DlType, JobOptions, PlaylistMode, VideoAudioPref, VideoContainer,
};
use crate::error::AppResult;

/// what the migration found on this machine. absent fields = nothing to
/// migrate (the ui shows nothing in that case).
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrationReport {
    /// composer initial values derived from the v1 config ("migrated v1").
    #[serde(default)]
    pub migrated_options: Option<JobOptions>,
    /// was a v1 config found and applied to the stored settings?
    pub config_applied: bool,
    /// v1 values with no v2 equivalent — dropped, never guessed (honest ui).
    pub dropped_keys: Vec<String>,
    /// ids seeded into history from the archive.
    pub history_seeded: u64,
    /// archive now pointed at the v1 file in place (D43).
    pub archive_path: Option<String>,
    /// v1 binary paths — offered as custom binaries in the wizard (D40),
    /// never auto-applied.
    pub v1_ytdlp_path: Option<String>,
    pub v1_ffmpeg_path: Option<String>,
}

/// search order: beside the v1 exe, then the process cwd (§11). in dev,
/// current_exe is target/debug — the repo root (cwd) holds the real file.
fn candidate_dirs() -> Vec<PathBuf> {
    let mut v = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            v.push(dir.to_path_buf());
        }
    }
    if let Ok(cwd) = std::env::current_dir() {
        v.push(cwd);
    }
    v
}

/// the discovered v1 config + archive paths, or None when nothing exists.
/// v1's archive lives beside the old exe (gui.py: `os.path.dirname(
/// ytdlp_path) + "downloaded.txt"`), which is the config dir in practice.
fn discover() -> Option<(serde_json::Value, PathBuf)> {
    for dir in candidate_dirs() {
        let config_path = dir.join("ytdlp_gui_config.json");
        let Ok(text) = std::fs::read_to_string(&config_path) else {
            continue;
        };
        let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) else {
            continue;
        };
        return Some((value, dir.join("downloaded.txt")));
    }
    None
}

/// pure mapping: v1 config values → v2 composer defaults. unknown values are
/// reported as dropped keys instead of guessed — the v2 defaults stand.
pub fn map_config(cfg: &serde_json::Value) -> (JobOptions, Vec<String>) {
    let mut opts = JobOptions::default();
    let mut dropped = Vec::new();
    let s = |k: &str| cfg.get(k).and_then(|v| v.as_str());
    let b = |k: &str| cfg.get(k).and_then(|v| v.as_bool());

    match s("format_type") {
        Some("Audio") | None => {}
        Some("Video") => opts.dl_type = DlType::Video,
        Some(other) => dropped.push(format!("format_type={other}")),
    }
    match s("audio_codec") {
        Some("none (keep original)") | None => {}
        Some("mp3") => opts.audio_format = AudioFormat::Mp3,
        Some("m4a") => opts.audio_format = AudioFormat::M4a,
        Some("opus") => opts.audio_format = AudioFormat::Opus,
        Some("flac") => opts.audio_format = AudioFormat::Flac,
        Some("vorbis") => opts.audio_format = AudioFormat::Vorbis,
        Some("alac") => opts.audio_format = AudioFormat::Alac,
        // v2 exposes mka/mp4 as remux containers; the mapping is 1:1.
        Some("mka") => opts.audio_format = AudioFormat::Mka,
        Some("mp4") => opts.audio_format = AudioFormat::Mp4Container,
        Some(other) => dropped.push(format!("audio_codec={other}")),
    }
    match s("video_res") {
        Some("Best") | None => {}
        Some(res @ ("4320p" | "2160p" | "1440p" | "1080p" | "720p" | "480p" | "360p")) => {
            opts.max_resolution = res.to_owned();
        }
        Some(other) => dropped.push(format!("video_res={other}")),
    }
    match s("video_ext") {
        Some("mp4") | None => {}
        Some("mkv") => opts.container = VideoContainer::Mkv,
        Some("webm") => opts.container = VideoContainer::Webm,
        Some(other) => dropped.push(format!("video_ext={other}")),
    }
    match s("video_audio_pref") {
        Some("Best Audio (Default)") | None => {}
        Some("Highly Compatible (AAC/M4A)") => {
            opts.audio_pref = VideoAudioPref::Aac;
        }
        Some(other) => dropped.push(format!("video_audio_pref={other}")),
    }
    if let Some(use_archive) = b("use_archive") {
        opts.skip_downloaded = use_archive;
    }
    // playlists: v2 composer default is "single video only". v1's
    // download_playlists + playlist_limit (0 = all) map onto all / first-n.
    if b("download_playlists") == Some(true) {
        match cfg.get("playlist_limit").and_then(|v| v.as_i64()) {
            Some(0) | None => opts.playlist_mode = PlaylistMode::All,
            Some(n) if n > 0 => {
                opts.playlist_mode = PlaylistMode::FirstN;
                opts.playlist_n = u32::try_from(n).unwrap_or(u32::MAX);
            }
            Some(n) => dropped.push(format!("playlist_limit={n}")),
        }
    }

    (opts, dropped)
}

/// run the migration against the stored settings + history db. the composer
/// defaults (if a config was found) come back through `composer_defaults`.
pub fn apply(
    db: &crate::store::Db,
    settings: &mut crate::settings::Settings,
    composer_defaults: &mut Option<JobOptions>,
) -> AppResult<MigrationReport> {
    let Some((cfg, archive)) = discover() else {
        return Ok(MigrationReport::default());
    };

    let mut report = MigrationReport::default();
    let s = |k: &str| cfg.get(k).and_then(|v| v.as_str()).map(str::to_owned);

    // settings-level: output_dir (§11 table row 1)
    if let Some(dir) = s("output_dir").filter(|d| !d.trim().is_empty()) {
        settings.destination = Some(dir);
    }

    // composer initial values ("migrated v1")
    let (opts, dropped) = map_config(&cfg);
    report.dropped_keys = dropped;
    report.migrated_options = Some(opts.clone());
    *composer_defaults = Some(opts);

    // archive in place (D43) + ids seeded into history either way
    if archive.is_file() {
        report.archive_path = Some(archive.to_string_lossy().into_owned());
        settings.archive_path = report.archive_path.clone();
        let text = std::fs::read_to_string(&archive).unwrap_or_default();
        report.history_seeded = db.seed_history_from_archive(&text)? as u64;
    }

    // v1 binaries → custom-binary offer in the wizard (§11 table row 4)
    if let Some(p) = s("ytdlp_path").filter(|p| std::path::Path::new(p).is_file()) {
        report.v1_ytdlp_path = Some(p);
    }
    if let Some(p) = s("ffmpeg_path").filter(|p| std::path::Path::new(p).is_file()) {
        report.v1_ffmpeg_path = Some(p);
    }

    report.config_applied = true;
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg(json: &str) -> serde_json::Value {
        serde_json::from_str(json).unwrap()
    }

    #[test]
    fn absent_keys_map_to_defaults() {
        let (opts, dropped) = map_config(&cfg("{}"));
        assert_eq!(opts, JobOptions::default());
        assert!(dropped.is_empty());
    }

    #[test]
    fn v1_default_values_map_cleanly() {
        // gui.py's own fallbacks (first run before the user ever saves)
        let (opts, dropped) = map_config(&cfg(r#"{
            "format_type": "Audio", "audio_codec": "opus",
            "video_res": "Best", "video_ext": "mp4",
            "video_audio_pref": "Best Audio (Default)",
            "use_archive": true, "download_playlists": true, "playlist_limit": 0
        }"#));
        assert!(dropped.is_empty());
        assert_eq!(opts.dl_type, DlType::Audio);
        assert_eq!(opts.audio_format, AudioFormat::Opus);
        assert_eq!(opts.max_resolution, "best");
        assert_eq!(opts.container, VideoContainer::Mp4);
        assert_eq!(opts.audio_pref, VideoAudioPref::Opus);
        assert!(opts.skip_downloaded);
        assert_eq!(opts.playlist_mode, PlaylistMode::All);
    }

    #[test]
    fn video_and_aac_pref_map() {
        let (opts, dropped) = map_config(&cfg(r#"{
            "format_type": "Video", "video_res": "1080p", "video_ext": "mkv",
            "video_audio_pref": "Highly Compatible (AAC/M4A)",
            "audio_codec": "none (keep original)"
        }"#));
        assert!(dropped.is_empty());
        assert_eq!(opts.dl_type, DlType::Video);
        assert_eq!(opts.max_resolution, "1080p");
        assert_eq!(opts.container, VideoContainer::Mkv);
        assert_eq!(opts.audio_pref, VideoAudioPref::Aac);
        assert_eq!(opts.audio_format, AudioFormat::Best);
    }

    #[test]
    fn playlist_limit_n_maps_to_first_n() {
        let (opts, _) = map_config(&cfg(
            r#"{ "download_playlists": true, "playlist_limit": 25 }"#,
        ));
        assert_eq!(opts.playlist_mode, PlaylistMode::FirstN);
        assert_eq!(opts.playlist_n, 25);
        // playlists off → single, regardless of limit
        let (opts2, _) = map_config(&cfg(
            r#"{ "download_playlists": false, "playlist_limit": 25 }"#,
        ));
        assert_eq!(opts2.playlist_mode, PlaylistMode::Single);
    }

    #[test]
    fn unknown_values_are_dropped_not_guessed() {
        let (opts, dropped) = map_config(&cfg(r#"{
            "format_type": "Both", "audio_codec": "aac", "video_res": "8k",
            "video_ext": "avi", "video_audio_pref": "Surround"
        }"#));
        // every unmapped field keeps its v2 default
        assert_eq!(opts.dl_type, DlType::Audio);
        assert_eq!(opts.audio_format, AudioFormat::Best);
        assert_eq!(opts.max_resolution, "best");
        assert_eq!(opts.container, VideoContainer::Mp4);
        assert_eq!(opts.audio_pref, VideoAudioPref::Opus);
        assert_eq!(dropped.len(), 5);
        assert!(dropped.iter().any(|d| d.contains("format_type=Both")));
        assert!(dropped.iter().any(|d| d.contains("audio_codec=aac")));
        assert!(dropped.iter().any(|d| d.contains("video_res=8k")));
        assert!(dropped.iter().any(|d| d.contains("video_ext=avi")));
        assert!(dropped
            .iter()
            .any(|d| d.contains("video_audio_pref=Surround")));
    }
}
