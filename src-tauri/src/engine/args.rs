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
    /// re-download onto an existing file must be explicit (D59): default
    /// false keeps yt-dlp's "has already been downloaded" skip; history's
    /// ↻ sets true only after a user confirms overwriting the old file.
    pub overwrite: bool,
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
            overwrite: false,
            cookies: CookieSource::default(),
            subtitle_langs: Vec::new(),
            auto_captions: false,
            sponsorblock: Vec::new(),
            extra_args: Vec::new(),
            output_template: None,
        }
    }
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
    // per-item playlist index print (e2e find, 2026-09-03): the console
    // "[download] Downloading item N of M" line is SUPPRESSED when a
    // download: progress-template is active, so the parser never saw a
    // total. this print fires per item on a different output branch and
    // delivers index|effective-total|full-playlist-size; n_entries is the
    // one to display (already clamped by --playlist-end for first-n).
    // single videos print NA — the engine ignores those.
    "--print",
    "pre_process:__I__%(playlist_index)s|%(n_entries)s|%(playlist_count)s",
    // playlist-level total print: fires ONCE per playlist run even when
    // every item is archive-skipped (e2e find: pre_process doesn't fire for
    // skips, so a fully-archived playlist would otherwise end with no
    // counter at all). %(playlist_count)s is the FULL size; __I__ refines.
    "--print",
    "playlist:__T__%(playlist_count)s",
];

/// build the argv for one job. `archive` = Some(path) when skip-downloaded is
/// on. `dest` is the download dir. `ffmpeg_dir` = Some(dir) points yt-dlp at
/// the app-managed ffmpeg (M2's managed copy is not on PATH; without this
/// every re-encode/remux/thumbnail job fails to find ffmpeg). argv[0] is the
/// program name ("yt-dlp").
pub fn build_argv(
    opts: &JobOptions,
    dest: &str,
    archive: Option<&str>,
    ffmpeg_dir: Option<&str>,
) -> AppResult<Vec<String>> {
    let mut argv = vec!["yt-dlp".to_owned()];
    argv.extend(ENGINE_FLAGS.iter().map(|s| s.to_string()));

    if let Some(dir) = ffmpeg_dir {
        argv.push("--ffmpeg-location".into());
        argv.push(dir.into());
    }

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
            // ba/b: bestaudio normally; fall back to best single-file when
            // the source has no audio-only stream (generic direct mp4/mp3
            // links, some bandcamp/soundcloud items). youtube etc. always
            // hit the ba branch, so this only widens compatibility.
            argv.push("ba/b".into());
            argv.push("-x".into());
            if opts.audio_format != AudioFormat::Best {
                argv.push("--audio-format".into());
                argv.push(audio_format_str(opts.audio_format).into());
            }
            // d88: wav cannot hold embedded art and yt-dlp does not skip
            // quietly — it ERRORS the whole job in postprocessing
            // ("Supported filetypes for thumbnail embedding are: …") and
            // scatters .webp/.png sidecars (live-verified 2026-09-06, same
            // failure class as webm above; alac lands as m4a and embeds
            // fine, as does the default best→opus target). the composer
            // warns "cover art will be skipped"; the engine must actually
            // skip.
            if opts.audio_format != AudioFormat::Wav {
                push_cover_args(&mut argv, opts.cover_mode, opts.cover_w, opts.cover_h)?;
            }
        }
        DlType::Video => {
            let cap = height_filter(&opts.max_resolution);
            // d90: the container constrains the stream selection, not just the
            // merger. webm (Matroska subset) can hold ONLY vp8/vp9/av1 video
            // and vorbis/opus audio — the old unfiltered `ba` picked the
            // highest-bitrate audio, which on youtube is the 256k m4a (aac):
            // yt-dlp then tried to merge aac into webm and ffmpeg failed the
            // whole job with the cryptic "Postprocessing: Conversion failed!"
            // (live-reproduced 2026-09-07: bbb 1080p, f399 + f258.m4a →
            // .temp.webm debris). webm jobs therefore select webm-native
            // streams with NO unfiltered fallback — an unresolvable request
            // errors honestly ("requested format not available") instead of
            // failing at the merge. mp4/mkv are permissive containers: any
            // stream pair remuxes, so the old chain stays.
            let (bv, ba, single) = match opts.container {
                VideoContainer::Webm => (
                    format!("bv*[ext=webm]{cap}"),
                    "ba[ext=webm]".to_string(),
                    "b[ext=webm]".to_string(),
                ),
                _ => (
                    format!("bv*{cap}"),
                    match opts.audio_pref {
                        VideoAudioPref::Opus => "ba".to_string(),
                        VideoAudioPref::Aac => "ba[ext=m4a]".to_string(),
                    },
                    "b".to_string(),
                ),
            };
            // d90: webm has no unfiltered fallback — every leg keeps its ext
            // filters, or the merge fails post-hoc with the cryptic error the
            // d90 comment above documents. the aac pref's second-chance leg
            // (dropping [ext=m4a]) is likewise webm-forbidden.
            let fmt = if cap.is_empty() {
                match opts.container {
                    VideoContainer::Webm => format!("{bv}+{ba}/{single}"),
                    _ => format!("{bv}+{ba}/{bv}+ba/{single}"),
                }
            } else {
                match opts.container {
                    // no /b tail for webm: an unfiltered single-format fallback
                    // could serve h264-in-mp4 straight into the doomed webm merge
                    VideoContainer::Webm => format!("{bv}+{ba}/{single}{cap}"),
                    _ => format!("{bv}+{ba}/{bv}+ba/{single}{cap}/b"),
                }
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
            // webm cannot hold embedded cover art (yt-dlp's thumbnail
            // embedder supports mp3/mkv/ogg/opus/flac/m4a/mp4 only) — the
            // composer warns "cover art will be skipped", so the engine must
            // actually skip. live-verified e2e 2026-09-03: emitting
            // --embed-thumbnail for a webm target makes yt-dlp ERROR in
            // postprocessing ("Supported filetypes for thumbnail embedding
            // are: …") instead of skipping, killing the whole job.
            if opts.container != VideoContainer::Webm {
                push_cover_args(&mut argv, opts.cover_mode, opts.cover_w, opts.cover_h)?;
            }
        }
    }

    // metadata embed is part of the identity of a "finished" download in the
    // mockup's preview; keep parity with it.
    argv.push("--embed-metadata".into());

    // D59: with the target file present, yt-dlp skips the download AND every
    // postprocessor, then --embed-metadata runs its metadata pass over the
    // cover-tagged file — which errors for opus ("Postprocessing: Conversion
    // failed!", 0-byte .temp file, live-reproduced in e2e). the ui gates
    // overwrite behind an explicit confirm; when granted, yt-dlp redownloads
    // and re-embeds from scratch instead of skip-then-fail.
    if opts.overwrite {
        argv.push("--force-overwrites".into());
    }

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

/// full download argv: build_argv + the url appended LAST — after any user
/// extra_args, so a user flag that takes a value can never swallow the url
/// and leave yt-dlp with zero positional arguments (exit 2). regression:
/// the engine previously passed build_argv's output straight to spawn and
/// every download failed with "You must provide at least one URL" — found
/// live by the e2e checklist run (2026-09-03); the TS argv preview is a
/// separate builder, which is why nothing else caught it.
pub fn build_download_argv(
    opts: &JobOptions,
    url: &str,
    dest: &str,
    archive: Option<&str>,
    ffmpeg_dir: Option<&str>,
) -> AppResult<Vec<String>> {
    let mut argv = build_argv(opts, dest, archive, ffmpeg_dir)?;
    argv.push(url.to_owned());
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
        let argv = build_argv(&base_audio(), r"C:\dl", None, None).unwrap();
        let s = argv.join(" ");
        assert!(s.contains("--newline"));
        assert!(s.contains("--progress"));
        assert!(s.contains("--no-simulate"));
        assert!(s.contains("download:__P__"));
        assert!(s.contains("after_move:filepath"));
        assert!(s.contains("--no-playlist"));
        assert!(s.contains(r"-P C:\dl"));
        assert!(s.contains("-f ba/b"));
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
        let argv = build_argv(&o, r"C:\dl", Some(r"C:\arch\downloaded.txt"), None).unwrap();
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
        let argv = build_argv(&o, r"C:\dl", None, None).unwrap();
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
        let argv = build_argv(&o, r"C:\dl", None, None).unwrap();
        let s = argv.join(" ");
        assert!(s.contains("-f bv*+ba/bv*+ba/b"));
    }

    #[test]
    fn playlist_modes() {
        let mut o = base_audio();
        o.playlist_mode = PlaylistMode::All;
        // no --playlist-* flags in All mode (the __I__ print's template
        // fields mention playlist_*, but those aren't flags)
        assert!(!build_argv(&o, "d", None, None)
            .unwrap()
            .iter()
            .any(|a| a.starts_with("--playlist")));
        o.playlist_mode = PlaylistMode::FirstN;
        o.playlist_n = 25;
        let argv = build_argv(&o, "d", None, None).unwrap();
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
        let argv = build_argv(&o, "d", None, None).unwrap();
        assert!(argv.contains(&"--merge-output-format".to_owned()));
        assert!(argv.contains(&"webm".to_owned()));
    }

    #[test]
    fn d90_webm_selects_only_webm_native_streams() {
        // live-reproduced failure (2026-09-07): the old unfiltered `ba` picked
        // youtube's 256k m4a; merging aac into webm errored the whole job with
        // the cryptic "Postprocessing: Conversion failed!". every webm leg
        // must carry ext filters — no unfiltered fallback survives.
        let mut o = base_audio();
        o.dl_type = DlType::Video;
        o.container = VideoContainer::Webm;
        o.max_resolution = "1080p".into();
        o.audio_pref = VideoAudioPref::Aac; // even an aac pref cannot buy aac-in-webm
        o.cover_mode = CoverMode::None;
        let argv = build_argv(&o, "d", None, None).unwrap();
        let s = argv.join(" ");
        assert!(
            s.contains("-f bv*[ext=webm][height<=1080]+ba[ext=webm]/b[ext=webm][height<=1080]"),
            "{s}"
        );
        assert!(
            !s.contains("ext=m4a"),
            "aac pref must not leak into a webm job: {s}"
        );
        // the unfiltered tails (/bv*+ba/b) of the permissive chain must be gone
        assert!(!s.contains("-f bv*+ba "), "{s}");
    }

    #[test]
    fn d90_webm_best_has_no_fallback_chain_leak() {
        let mut o = base_audio();
        o.dl_type = DlType::Video;
        o.container = VideoContainer::Webm;
        o.cover_mode = CoverMode::None;
        let argv = build_argv(&o, "d", None, None).unwrap();
        let s = argv.join(" ");
        assert!(
            s.contains("-f bv*[ext=webm]+ba[ext=webm]/b[ext=webm]"),
            "{s}"
        );
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
        let argv = build_argv(&o, "d", None, None).unwrap();
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
        let argv = build_argv(&o, "d", None, None).unwrap();
        assert!(argv
            .join(" ")
            .contains("ThumbnailsConvertor+ffmpeg_o:-c:v png -vf scale=800:450"));
    }

    #[test]
    fn custom_cover_zero_size_rejected() {
        let mut o = base_audio();
        o.cover_mode = CoverMode::Custom;
        o.cover_w = 0;
        assert!(build_argv(&o, "d", None, None).is_err());
    }

    #[test]
    fn first_n_clamps_to_one() {
        let mut o = base_audio();
        o.playlist_mode = PlaylistMode::FirstN;
        o.playlist_n = 0;
        let argv = build_argv(&o, "d", None, None).unwrap();
        let i = argv.iter().position(|a| a == "--playlist-end").unwrap();
        assert_eq!(argv[i + 1], "1");
    }

    #[test]
    fn wav_target_skips_cover_args_d88() {
        // live-verified 2026-09-06: yt-dlp ERRORS the whole job in
        // postprocessing when --embed-thumbnail targets wav ("Supported
        // filetypes for thumbnail embedding are: …") and leaves .webp/.png
        // debris — the engine must not emit the flag for wav (alac lands as
        // m4a and embeds fine; webm is guarded in the video branch).
        let mut o = base_audio();
        o.audio_format = AudioFormat::Wav;
        let argv = build_argv(&o, r"C:\dl", None, None).unwrap();
        let s = argv.join(" ");
        assert!(!s.contains("--embed-thumbnail"));
        assert!(!s.contains("ThumbnailsConvertor"));
        // conversion still requested, art silently absent
        assert!(s.contains("--audio-format wav"));

        // control: the same options on opus keep the embed (the default
        // best target resolves to opus on youtube)
        let mut o2 = base_audio();
        o2.audio_format = AudioFormat::Opus;
        let s2 = build_argv(&o2, r"C:\dl", None, None).unwrap().join(" ");
        assert!(s2.contains("--embed-thumbnail"));
    }

    #[test]
    fn ffmpeg_location_points_yt_dlp_at_managed_ffmpeg() {
        // regression: the managed ffmpeg is not on PATH — without
        // --ffmpeg-location every re-encode/remux/thumbnail job fails.
        let argv = build_argv(&base_audio(), r"C:\dl", None, Some(r"C:\bin")).unwrap();
        let s = argv.join(" ");
        assert!(s.contains(r"--ffmpeg-location C:\bin"));
        // absent managed ffmpeg → no flag (custom yt-dlp may find its own)
        let argv2 = build_argv(&base_audio(), r"C:\dl", None, None).unwrap();
        assert!(!argv2.join(" ").contains("--ffmpeg-location"));
    }

    #[test]
    fn download_argv_appends_url_last_after_user_extras() {
        // regression for the e2e-launched "no url" break: the url must be
        // the final argument, even when user extra_args end the argv.
        let mut o = base_audio();
        o.extra_args = vec!["--verbose".into()];
        let argv = build_download_argv(&o, "https://example.com/v", "d", None, None).unwrap();
        assert_eq!(argv.last().unwrap(), "https://example.com/v");
    }

    #[test]
    fn overwrite_flag_requires_opt_in_and_flips_to_force_overwrites() {
        // D59: default is yt-dlp's native "already downloaded" skip (no
        // --force-overwrites); the explicit overwrite grant flips the flag so
        // the job redownloads + re-embeds instead of skip-then-fail
        // (--embed-metadata over a cover-tagged opus errors, e2e-reproduced).
        let argv = build_argv(&base_audio(), "d", None, None).unwrap();
        assert!(!argv.join(" ").contains("--force-overwrites"));
        let mut o = base_audio();
        o.overwrite = true;
        let argv2 = build_argv(&o, "d", None, None).unwrap();
        assert!(argv2.contains(&"--force-overwrites".to_string()));
    }
}
