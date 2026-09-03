//! typed options → yt-dlp argv (§5 hard rules: argv built from a typed
//! struct, never through a shell). semantics verified against yt-dlp 2026
//! (§5.2). the frontend command preview mirrors these rules (tests pin both).

use serde::{Deserialize, Serialize};

use crate::error::{other, AppResult};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DlType {
    Audio,
    Video,
}

/// §5.2 audio convert-to set (optgroups in the ui mirror this).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AudioFormat {
    Best,
    Mp3,
    M4a,
    Opus,
    Vorbis,
    Flac,
    Alac,
    Wav,
    Mka,
    Mp4Container,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CoverMode {
    Square,
    Original,
    Custom,
    None,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PlaylistMode {
    Single,
    All,
    FirstN,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum VideoContainer {
    Mp4,
    Mkv,
    Webm,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum VideoAudioPref {
    Opus,
    Aac,
}

/// cookies source (D38): never persisted — held in memory per job only.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct CookieSource {
    pub kind: CookieKind,
    /// browser name when kind = FromBrowser.
    pub browser: Option<String>,
    /// cookies.txt path when kind = File.
    pub file: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CookieKind {
    None,
    FromBrowser,
    File,
}

impl Default for CookieSource {
    fn default() -> Self {
        CookieSource {
            kind: CookieKind::None,
            browser: None,
            file: None,
        }
    }
}

/// the typed composer state — what the ui holds, what a job stores, what the
/// argv builder consumes. one shape everywhere (D19: re-download reuses it).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct JobOptions {
    pub dl_type: DlType,
    pub audio_format: AudioFormat,
    pub cover_mode: CoverMode,
    pub cover_w: u32,
    pub cover_h: u32,
    pub max_resolution: String, // "best" | "4320p" | …
    pub container: VideoContainer,
    pub audio_pref: VideoAudioPref,
    pub playlist_mode: PlaylistMode,
    pub playlist_n: u32,
    pub skip_downloaded: bool,
    pub after_download: AfterDownload,
    pub move_target: Option<String>,
    pub cookies: CookieSource,
    /// subtitle languages, empty = none (D39).
    pub subtitle_langs: Vec<String>,
    pub auto_captions: bool,
    /// sponsorblock categories; empty = off (D39).
    pub sponsorblock: Vec<String>,
    pub extra_args: Vec<String>,
    pub output_template: Option<String>,
}

impl Default for JobOptions {
    fn default() -> Self {
        JobOptions {
            dl_type: DlType::Audio,
            audio_format: AudioFormat::Best,
            cover_mode: CoverMode::Square,
            cover_w: 640,
            cover_h: 640,
            max_resolution: "best".into(),
            container: VideoContainer::Mp4,
            audio_pref: VideoAudioPref::Opus,
            playlist_mode: PlaylistMode::Single,
            playlist_n: 10,
            skip_downloaded: true,
            after_download: AfterDownload::Keep,
            move_target: None,
            cookies: CookieSource::default(),
            subtitle_langs: Vec::new(),
            auto_captions: false,
            sponsorblock: Vec::new(),
            extra_args: Vec::new(),
            output_template: None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AfterDownload {
    Keep,
    Move,
}

/// engine-owned fixed flags (§5 invocation rules). always present.
/// `--print` implies `--quiet --simulate` (yt-dlp man), so a downloading job
/// must pass `--no-simulate --progress` explicitly or nothing downloads and
/// no progress is printed.
const ENGINE_FLAGS: &[&str] = &[
    "--newline",
    "--progress",
    "--no-simulate",
    "--progress-template",
    "download:__P__%(progress.downloaded_bytes)s|%(progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.eta)s",
    "--print",
    "after_move:filepath",
];

/// build the argv for one job. `archive` = Some(path) when skip-downloaded is
/// on. `dest` is the download dir. argv[0] is the program name ("yt-dlp").
pub fn build_argv(opts: &JobOptions, dest: &str, archive: Option<&str>) -> AppResult<Vec<String>> {
    let mut argv = vec!["yt-dlp".to_owned()];
    argv.extend(ENGINE_FLAGS.iter().map(|s| s.to_string()));

    if let Some(arch) = archive {
        argv.push("--download-archive".into());
        argv.push(arch.into());
    }

    match opts.playlist_mode {
        PlaylistMode::Single => argv.push("--no-playlist".into()),
        PlaylistMode::All => {}
        PlaylistMode::FirstN => {
            argv.push("--playlist-end".into());
            argv.push(opts.playlist_n.max(1).to_string());
        }
    }

    argv.push("-P".into());
    argv.push(dest.into());

    match opts.dl_type {
        DlType::Audio => {
            argv.push("-f".into());
            argv.push("ba".into());
            argv.push("-x".into());
            if opts.audio_format != AudioFormat::Best {
                argv.push("--audio-format".into());
                argv.push(audio_format_str(opts.audio_format).into());
            }
            push_cover_args(&mut argv, opts.cover_mode, opts.cover_w, opts.cover_h)?;
        }
        DlType::Video => {
            let cap = height_filter(&opts.max_resolution);
            let audio = match opts.audio_pref {
                VideoAudioPref::Opus => "",
                VideoAudioPref::Aac => "[ext=m4a]",
            };
            let fmt = if cap.is_empty() {
                format!("bv*+ba{audio}/bv*+ba/b")
            } else {
                format!("bv*{cap}+ba{audio}/bv*{cap}+ba/b{cap}/b")
            };
            argv.push("-f".into());
            argv.push(fmt);
            argv.push("--merge-output-format".into());
            argv.push(
                match opts.container {
                    VideoContainer::Mp4 => "mp4",
                    VideoContainer::Mkv => "mkv",
                    VideoContainer::Webm => "webm",
                }
                .into(),
            );
            push_cover_args(&mut argv, opts.cover_mode, opts.cover_w, opts.cover_h)?;
        }
    }

    // metadata embed is part of the identity of a "finished" download in the
    // mockup's preview; keep parity with it.
    argv.push("--embed-metadata".into());

    if !opts.subtitle_langs.is_empty() {
        argv.push("--sub-langs".into());
        argv.push(opts.subtitle_langs.join(","));
        argv.push("--write-subs".into());
    }
    if opts.auto_captions {
        argv.push("--write-auto-subs".into());
    }
    if !opts.sponsorblock.is_empty() {
        argv.push("--sponsorblock-remove".into());
        argv.push(opts.sponsorblock.join(","));
    }
    if let Some(tpl) = &opts.output_template {
        argv.push("-o".into());
        argv.push(tpl.clone());
    }

    // D38: cookies are passed per invocation, held in memory only.
    match opts.cookies.kind {
        CookieKind::None => {}
        CookieKind::FromBrowser => {
            argv.push("--cookies-from-browser".into());
            argv.push(
                opts.cookies
                    .browser
                    .clone()
                    .ok_or_else(|| other("cookies-from-browser selected but no browser set"))?,
            );
        }
        CookieKind::File => {
            argv.push("--cookies".into());
            argv.push(
                opts.cookies
                    .file
                    .clone()
                    .ok_or_else(|| other("cookies file selected but no path set"))?,
            );
        }
    }

    // user-owned, passed as-is (§7 security: still argv, never a shell).
    argv.extend(opts.extra_args.iter().cloned());

    Ok(argv)
}

fn audio_format_str(f: AudioFormat) -> &'static str {
    match f {
        AudioFormat::Mp3 => "mp3",
        AudioFormat::M4a => "m4a",
        AudioFormat::Opus => "opus",
        AudioFormat::Vorbis => "vorbis",
        AudioFormat::Flac => "flac",
        AudioFormat::Alac => "alac",
        AudioFormat::Wav => "wav",
        AudioFormat::Mka => "mka",
        // remux to mp4 container of an audio-only stream
        AudioFormat::Mp4Container => "mp4",
        AudioFormat::Best => unreachable!("handled by caller"),
    }
}

fn height_filter(res: &str) -> String {
    if res == "best" || res.is_empty() {
        return String::new();
    }
    let h = res.trim_end_matches('p');
    format!("[height<={h}]")
}

/// cover art → `--embed-thumbnail` + ppa convertor args (§5.2).
/// square: crop to square png; custom: scale=W:H; original: plain embed.
fn push_cover_args(argv: &mut Vec<String>, mode: CoverMode, w: u32, h: u32) -> AppResult<()> {
    match mode {
        CoverMode::None => {}
        CoverMode::Original => argv.push("--embed-thumbnail".into()),
        CoverMode::Square => {
            argv.push("--embed-thumbnail".into());
            argv.push("--ppa".into());
            argv.push("ThumbnailsConvertor+ffmpeg_o:-c:v png -vf crop=ih".into());
        }
        CoverMode::Custom => {
            if w == 0 || h == 0 {
                return Err(other("custom cover size needs width and height"));
            }
            argv.push("--embed-thumbnail".into());
            argv.push("--ppa".into());
            argv.push(format!(
                "ThumbnailsConvertor+ffmpeg_o:-c:v png -vf scale={w}:{h}"
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base_audio() -> JobOptions {
        JobOptions::default()
    }

    #[test]
    fn audio_default_argv() {
        let argv = build_argv(&base_audio(), r"C:\dl", None).unwrap();
        let s = argv.join(" ");
        assert!(s.contains("--newline"));
        assert!(s.contains("--progress"));
        assert!(s.contains("--no-simulate"));
        assert!(s.contains("download:__P__"));
        assert!(s.contains("after_move:filepath"));
        assert!(s.contains("--no-playlist"));
        assert!(s.contains(r"-P C:\dl"));
        assert!(s.contains("-f ba"));
        assert!(s.contains("-x"));
        assert!(s.contains("--embed-metadata"));
        // no conversion when Best
        assert!(!s.contains("--audio-format"));
        // cover square default
        assert!(s.contains("--embed-thumbnail"));
        assert!(s.contains("crop=ih"));
    }

    #[test]
    fn audio_reencode_and_archive() {
        let mut o = base_audio();
        o.audio_format = AudioFormat::Flac;
        o.skip_downloaded = true;
        let argv = build_argv(&o, r"C:\dl", Some(r"C:\arch\downloaded.txt")).unwrap();
        let s = argv.join(" ");
        assert!(s.contains("--audio-format flac"));
        assert!(s.contains(r"--download-archive C:\arch\downloaded.txt"));
    }

    #[test]
    fn video_resolution_cap_and_aac_pref() {
        let mut o = base_audio();
        o.dl_type = DlType::Video;
        o.max_resolution = "1080p".into();
        o.audio_pref = VideoAudioPref::Aac;
        o.container = VideoContainer::Mkv;
        o.cover_mode = CoverMode::None;
        let argv = build_argv(&o, r"C:\dl", None).unwrap();
        let s = argv.join(" ");
        assert!(
            s.contains("-f bv*[height<=1080]+ba[ext=m4a]/bv*[height<=1080]+ba/b[height<=1080]/b")
        );
        assert!(s.contains("--merge-output-format mkv"));
        assert!(!s.contains("--embed-thumbnail"));
    }

    #[test]
    fn video_best_has_no_height_filter() {
        let mut o = base_audio();
        o.dl_type = DlType::Video;
        o.cover_mode = CoverMode::None;
        let argv = build_argv(&o, r"C:\dl", None).unwrap();
        let s = argv.join(" ");
        assert!(s.contains("-f bv*+ba/bv*+ba/b"));
    }

    #[test]
    fn playlist_modes() {
        let mut o = base_audio();
        o.playlist_mode = PlaylistMode::All;
        assert!(!build_argv(&o, "d", None)
            .unwrap()
            .iter()
            .any(|a| a.contains("playlist")));
        o.playlist_mode = PlaylistMode::FirstN;
        o.playlist_n = 25;
        let argv = build_argv(&o, "d", None).unwrap();
        let i = argv.iter().position(|a| a == "--playlist-end").unwrap();
        assert_eq!(argv[i + 1], "25");
    }

    #[test]
    fn webm_container_flag_present_even_with_cover_skipped_upstream() {
        // webm ⇒ cover forced to none by the ui (warning); engine just obeys
        let mut o = base_audio();
        o.dl_type = DlType::Video;
        o.container = VideoContainer::Webm;
        o.cover_mode = CoverMode::None;
        let argv = build_argv(&o, "d", None).unwrap();
        assert!(argv.contains(&"--merge-output-format".to_owned()));
        assert!(argv.contains(&"webm".to_owned()));
    }

    #[test]
    fn cookies_and_extras_and_template() {
        let mut o = base_audio();
        o.cover_mode = CoverMode::None;
        o.cookies = CookieSource {
            kind: CookieKind::FromBrowser,
            browser: Some("firefox".into()),
            file: None,
        };
        o.subtitle_langs = vec!["en".into(), "de".into()];
        o.auto_captions = true;
        o.sponsorblock = vec!["sponsor".into(), "intro".into()];
        o.extra_args = vec!["--verbose".into()];
        o.output_template = Some("%(title)s [%(id)s].%(ext)s".into());
        let argv = build_argv(&o, "d", None).unwrap();
        let s = argv.join(" ");
        assert!(s.contains("--cookies-from-browser firefox"));
        assert!(s.contains("--sub-langs en,de"));
        assert!(s.contains("--write-subs"));
        assert!(s.contains("--write-auto-subs"));
        assert!(s.contains("--sponsorblock-remove sponsor,intro"));
        assert!(s.ends_with("--verbose"));
        assert!(s.contains("-o %(title)s [%(id)s].%(ext)s"));
    }

    #[test]
    fn custom_cover_scale() {
        let mut o = base_audio();
        o.cover_mode = CoverMode::Custom;
        o.cover_w = 800;
        o.cover_h = 450;
        let argv = build_argv(&o, "d", None).unwrap();
        assert!(argv
            .join(" ")
            .contains("ThumbnailsConvertor+ffmpeg_o:-c:v png -vf scale=800:450"));
    }

    #[test]
    fn custom_cover_zero_size_rejected() {
        let mut o = base_audio();
        o.cover_mode = CoverMode::Custom;
        o.cover_w = 0;
        assert!(build_argv(&o, "d", None).is_err());
    }

    #[test]
    fn first_n_clamps_to_one() {
        let mut o = base_audio();
        o.playlist_mode = PlaylistMode::FirstN;
        o.playlist_n = 0;
        let argv = build_argv(&o, "d", None).unwrap();
        let i = argv.iter().position(|a| a == "--playlist-end").unwrap();
        assert_eq!(argv[i + 1], "1");
    }
}
