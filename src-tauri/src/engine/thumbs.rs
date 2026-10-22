//! d93 row thumbnails: a tiny app-data cache of images keyed by the
//! download identity (`<extractor> <vid>`), wired into the queue at two
//! moments:
//!
//! - **fetching** (remote art): the identity is known before any bytes move,
//!   so the row can show artwork while it downloads. a lookup-table url
//!   covers youtube with zero extra yt-dlp invocations (the dominant case);
//!   every other extractor falls back to one cheap `--print %(thumbnail)s`
//!   probe — same shape as the identity probe (D44), capped at 30 s.
//! - **done** (local art): the finished file is probed with the
//!   already-managed ffprobe (the D45 pattern: no network, seconds caps,
//!   every failure degrades to None). embedded cover art wins for audio, a
//!   decoded video frame for video — it matches the file the user actually
//!   got, and it works offline.
//!
//! every artifact is a small png inside the app-data dir; nothing is ever
//! written next to the user's downloads, and nothing here can fail a job —
//! callers treat every error as "no thumbnail" (D30 discipline: a
//! convenience recovery, not a dependency).

use std::path::{Path, PathBuf};

use tokio::io::AsyncWriteExt;

/// cache root: `<app-data>/thumbs/`. one dir, files named `<key>.png`
/// (sanitized; see `sanitize_key`).
pub fn cache_dir() -> PathBuf {
    crate::binaries::manager::app_data_dir().join("thumbs")
}

/// sanitize the identity key into a single filename component: whitespace
/// becomes `_`, and separators / windows-invalid characters are dropped.
/// the filename never has to decode back to the key — it only has to be
/// unique and stable (an exotic vid with a `/` must not escape the dir).
fn sanitize_key(key: &str) -> String {
    key.chars()
        .map(|c| if c.is_whitespace() { '_' } else { c })
        .filter(|c| !matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|'))
        .collect()
}

/// the cached png for an identity — the caller checks `is_file()` to decide
/// freshness (a vanished cache entry re-fetches on the next queue).
pub fn cache_path(key: &str) -> PathBuf {
    cache_dir().join(format!("{}.png", sanitize_key(key)))
}

/// a cached thumb is considered current for this long. done-sweeps rewrite
/// the file when they find better (local) art, so this only bounds
/// re-fetching of remote art for rows that never finish (stopped/errored)
/// and repeat queueing.
const MAX_AGE_SECS: u64 = 30 * 24 * 3600;

pub fn cache_fresh(key: &str) -> bool {
    let p = cache_path(key);
    p.is_file()
        && p.metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|m| m.elapsed().ok())
            .is_some_and(|age| age.as_secs() < MAX_AGE_SECS)
}

/// hard cap on any single thumbnail fetch: metadata probes can stall on
/// bot-gated sites, and the prefetch is a background nicety.
const FETCH_TIMEOUT_SECS: u64 = 30;

// ---------------------------------------------------------------------------
// youtube fast path: `https://i.ytimg.com/vi/<id>/<name>.jpg` is a stable
// public lookup table — no yt-dlp round-trip needed for the dominant case.
// maxresdefault often 404s, so the fetch falls back down the list;
// hqdefault (480x360) always exists for a live video.
// ---------------------------------------------------------------------------

const YT_THUMB_NAMES: [&str; 4] = ["maxresdefault", "hqdefault", "mqdefault", "default"];

pub fn is_youtube(extractor: &str) -> bool {
    extractor.eq_ignore_ascii_case("youtube")
}

fn youtube_urls(vid: &str) -> Vec<String> {
    YT_THUMB_NAMES
        .iter()
        .map(|n| format!("https://i.ytimg.com/vi/{vid}/{n}.jpg"))
        .collect()
}

// ---------------------------------------------------------------------------
// generic extractor art: one --print probe (same flags as the identity probe,
// D44: print only, never -J; cookies flow through when configured — the same
// D84 reasoning as the identity probe: a bot-gated url needs them to even
// answer).
// ---------------------------------------------------------------------------

/// resolve `%(thumbnail)s` for any url. returns None on any failure —
/// the row simply renders without art.
async fn probe_thumbnail_url(
    url: &str,
    cookies: Option<&crate::engine::args::CookieSource>,
) -> Option<String> {
    use crate::engine::args::{CookieKind, CookieSource};
    let mut argv: Vec<String> = vec![
        "yt-dlp".into(),
        "--no-warnings".into(),
        "--skip-download".into(),
        "--no-playlist".into(),
        "--print".into(),
        "%(thumbnail)s".into(),
    ];
    if let Some(CookieSource {
        kind,
        browser,
        file,
    }) = cookies
    {
        match kind {
            CookieKind::FromBrowser => {
                if let Some(browser) = browser.as_deref() {
                    argv.push("--cookies-from-browser".into());
                    argv.push(browser.to_owned());
                }
            }
            CookieKind::File => {
                if let Some(file) = file.as_deref() {
                    argv.push("--cookies".into());
                    argv.push(file.to_owned());
                }
            }
            CookieKind::None => {}
        }
    }
    if let Ok(m) = crate::binaries::manager::load_manifest() {
        if let Some(p) =
            crate::binaries::manager::resolve_tool_path(&m, crate::binaries::sources::Tool::YtDlp)
        {
            argv[0] = p.to_string_lossy().into_owned();
        }
    }
    argv.push(url.to_owned());

    let mut child = crate::engine::process::spawn(&argv).ok()?;
    let mut rx = crate::engine::process::stream_lines(&mut child).ok()?;
    let mut found: Option<String> = None;
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(FETCH_TIMEOUT_SECS);
    while found.is_none() {
        let now = tokio::time::Instant::now();
        if now >= deadline {
            break;
        }
        match tokio::time::timeout(deadline - now, rx.recv()).await {
            Ok(Some((true, line))) => {
                let t = line.trim();
                if t.starts_with("http://") || t.starts_with("https://") {
                    found = Some(t.to_owned());
                }
            }
            Ok(Some((false, _))) => continue, // stderr noise
            Ok(None) => break,
            Err(_) => break, // deadline
        }
    }
    let _ = child.kill().await;
    let _ = child.inner.wait().await;
    found
}

// ---------------------------------------------------------------------------
// download + write
// ---------------------------------------------------------------------------

fn http() -> Option<reqwest::Client> {
    reqwest::ClientBuilder::new()
        .timeout(std::time::Duration::from_secs(FETCH_TIMEOUT_SECS))
        .build()
        .ok()
}

/// fetch `url`, decode through ffmpeg (size normalization + validation),
/// write to `dest` atomically. the decode pass also proves the response
/// actually was an image — error pages and garbage never reach the cache.
async fn fetch_to_png(client: &reqwest::Client, url: &str, dest: &Path) -> Option<()> {
    let resp = client.get(url).send().await.ok()?;
    if !resp.status().is_success() {
        return None;
    }
    // thumbnails are ~10-100 kb; a cap keeps a hostile/broken response from
    // ballooning the cache.
    let bytes = resp.bytes().await.ok()?;
    if !(64..=8 * 1024 * 1024).contains(&bytes.len()) {
        return None;
    }
    decode_to_png(&bytes, dest).await
}

/// ffmpeg decode + scale to a 320px-wide png (rows render at ~64 px; a
/// 320px source keeps the hover card crisp without bloating the cache).
/// in-place tmp + rename so a crash mid-write can never leave a truncated
/// png that looks cached. stdin is written from a task while the output is
/// collected concurrently — the same child both reads and writes.
async fn decode_to_png(bytes: &[u8], dest: &Path) -> Option<()> {
    let ffmpeg = ffmpeg_path()?;
    let mut cmd = tokio::process::Command::new(ffmpeg);
    cmd.args([
        "-v",
        "error",
        "-i",
        "pipe:0",
        "-frames:v",
        "1",
        "-vf",
        "scale='min(320,iw)':-2",
        "-f",
        "image2",
        "pipe:1",
    ])
    .stdin(std::process::Stdio::piped())
    .stdout(std::process::Stdio::piped())
    .stderr(std::process::Stdio::null());
    crate::engine::probe::no_window(&mut cmd);

    let mut child = cmd.spawn().ok()?;
    let mut stdin = child.stdin.take()?;
    let mut stdout = child.stdout.take()?;
    let input = bytes.to_vec();
    let writer = tokio::spawn(async move {
        let _ = stdin.write_all(&input).await;
        // drop closes the pipe → ffmpeg finalizes the decode
    });
    let mut png = Vec::new();
    let read_ok = tokio::time::timeout(
        std::time::Duration::from_secs(15),
        tokio::io::AsyncReadExt::read_to_end(&mut stdout, &mut png),
    )
    .await
    .ok()?
    .is_ok();
    let status = child.wait().await.ok()?;
    let _ = writer.await;
    if !read_ok || !status.success() || png.is_empty() {
        return None;
    }
    atomic_write(dest, &png)
}

fn ffmpeg_path() -> Option<PathBuf> {
    let p = crate::binaries::manager::bin_dir().join("ffmpeg.exe");
    p.is_file().then_some(p)
}

fn ffprobe_path() -> Option<PathBuf> {
    let p = crate::binaries::manager::bin_dir().join("ffprobe.exe");
    p.is_file().then_some(p)
}

/// tmp + persist rename in the same dir (atomic on same-volume windows).
fn atomic_write(dest: &Path, bytes: &[u8]) -> Option<()> {
    if let Some(dir) = dest.parent() {
        std::fs::create_dir_all(dir).ok()?;
    }
    let tmp = dest.with_extension("png.tmp");
    std::fs::write(&tmp, bytes).ok()?;
    std::fs::rename(&tmp, dest).ok()
}

// ---------------------------------------------------------------------------
// entry points (called from queue.rs)
// ---------------------------------------------------------------------------

/// ensure the cached art for a job identity exists: fresh cache wins;
/// youtube ids use the lookup table; anything else runs one print probe.
/// returns the cache path on success.
///
/// `key` is the full identity key (`<extractor> <vid>`), `vid` the bare id.
pub async fn ensure_remote_art(
    key: &str,
    vid: &str,
    url: &str,
    extractor: &str,
    cookies: Option<&crate::engine::args::CookieSource>,
) -> Option<PathBuf> {
    if cache_fresh(key) {
        return Some(cache_path(key));
    }
    let client = http()?;
    let dest = cache_path(key);
    if is_youtube(extractor) {
        for u in youtube_urls(vid) {
            if fetch_to_png(&client, &u, &dest).await.is_some() {
                return Some(dest);
            }
        }
        // youtube's lookup table should never miss for a resolved id; do
        // not fall through to a probe that would return the same base url.
        return None;
    }
    // a non-youtube caller without a url (playlist item-thumb path) has no
    // way to probe — refuse instead of launching yt-dlp against nothing.
    if url.trim().is_empty() {
        return None;
    }
    let thumb_url = probe_thumbnail_url(url, cookies).await?;
    if thumb_url.is_empty() {
        return None;
    }
    fetch_to_png(&client, &thumb_url, &dest).await.map(|_| dest)
}

/// best local art for a finished file: embedded cover art first (audio
/// truth), else the frame at 25% (video truth; avoids the fade-in black
/// first frame). returns the freshly written cache path.
pub async fn ensure_local_art(key: &str, file: &Path) -> Option<PathBuf> {
    let dest = cache_path(key);
    let ffprobe = ffprobe_path()?;
    if !file.is_file() {
        return None;
    }

    // ---- 1) embedded cover art? (attached_pic disposition on a video
    //         stream; covers m4a/mp3/flac/mkv attachments) ----
    if let Some(stream_idx) = cover_stream_index(&ffprobe, file).await {
        if extract_stream_png(&ffmpeg_path()?, file, stream_idx, &dest)
            .await
            .is_some()
        {
            return Some(dest);
        }
    }

    // ---- 2) video frame at 25% (0 would be the fade-in black; the end
    //         risks credits — a quarter in is the classic thumbnail) ----
    if let Some(duration) = duration_secs(&ffprobe, file).await {
        let at = (duration * 0.25).max(0.0);
        if frame_png(&ffmpeg_path()?, file, at, &dest).await.is_some() {
            return Some(dest);
        }
    }
    None
}

/// find a stream with disposition.attached_pic=1 (cover art).
async fn cover_stream_index(ffprobe: &Path, file: &Path) -> Option<usize> {
    #[derive(serde::Deserialize)]
    struct Streams {
        #[serde(default)]
        streams: Vec<Stream>,
    }
    #[derive(serde::Deserialize)]
    struct Stream {
        index: usize,
        #[serde(default)]
        disposition: Disposition,
    }
    #[derive(serde::Deserialize, Default)]
    struct Disposition {
        #[serde(default, rename = "attached_pic")]
        attached_pic: i32,
    }

    let out = run_capture(
        ffprobe,
        &[
            "-v".into(),
            "error".into(),
            "-print_format".into(),
            "json".into(),
            "-show_streams".into(),
            file.to_string_lossy().into_owned(),
        ],
    )
    .await?;
    let parsed: Streams = serde_json::from_slice(&out).ok()?;
    parsed
        .streams
        .into_iter()
        .find(|s| s.disposition.attached_pic != 0)
        .map(|s| s.index)
}

/// decode stream `index` (the attached_pic) to png.
async fn extract_stream_png(ffmpeg: &Path, file: &Path, index: usize, dest: &Path) -> Option<()> {
    let spec = format!("{index}");
    let out = run_capture(
        ffmpeg,
        &[
            "-v".to_owned(),
            "error".to_owned(),
            "-i".to_owned(),
            file.to_string_lossy().into_owned(),
            "-map".to_owned(),
            format!("0:{spec}"),
            "-frames:v".to_owned(),
            "1".to_owned(),
            "-f".to_owned(),
            "image2".to_owned(),
            "pipe:1".to_owned(),
        ],
    )
    .await?;
    if out.is_empty() {
        return None;
    }
    atomic_write(dest, &out)
}

/// grab a video frame at `at` seconds as png.
async fn frame_png(ffmpeg: &Path, file: &Path, at: f64, dest: &Path) -> Option<()> {
    let ss = format!("{at:.3}");
    let out = run_capture(
        ffmpeg,
        &[
            "-v".to_owned(),
            "error".to_owned(),
            "-ss".to_owned(),
            ss,
            "-i".to_owned(),
            file.to_string_lossy().into_owned(),
            "-frames:v".to_owned(),
            "1".to_owned(),
            "-f".to_owned(),
            "image2".to_owned(),
            "pipe:1".to_owned(),
        ],
    )
    .await?;
    if out.is_empty() {
        return None;
    }
    atomic_write(dest, &out)
}

/// ffprobe format duration (decimal-string seconds), the D45 probe shape.
async fn duration_secs(ffprobe: &Path, file: &Path) -> Option<f64> {
    #[derive(serde::Deserialize)]
    struct FfFormat {
        duration: Option<String>,
    }
    #[derive(serde::Deserialize)]
    struct Out {
        #[serde(default)]
        format: Option<FfFormat>,
    }
    let out = run_capture(
        ffprobe,
        &[
            "-v".into(),
            "error".into(),
            "-print_format".into(),
            "json".into(),
            "-show_format".into(),
            file.to_string_lossy().into_owned(),
        ],
    )
    .await?;
    let parsed: Out = serde_json::from_slice(&out).ok()?;
    parsed
        .format?
        .duration?
        .trim()
        .parse::<f64>()
        .ok()
        .filter(|d| d.is_finite() && *d > 0.0)
}

/// bounded helper: run a tool, capture stdout, CREATE_NO_WINDOW, 10 s cap.
async fn run_capture(exe: &Path, args: &[String]) -> Option<Vec<u8>> {
    let mut cmd = tokio::process::Command::new(exe);
    cmd.args(args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null());
    crate::engine::probe::no_window(&mut cmd);
    let child = cmd.spawn().ok()?;
    let out = tokio::time::timeout(std::time::Duration::from_secs(10), child.wait_with_output())
        .await
        .ok()?
        .ok()?;
    out.status.success().then_some(out.stdout)
}

/// wipe the cache (d69 reset). returns removed files.
pub fn clear_cache() -> usize {
    let mut n = 0;
    if let Ok(rd) = std::fs::read_dir(cache_dir()) {
        for e in rd.filter_map(Result::ok) {
            let p = e.path();
            if p.is_file() && std::fs::remove_file(&p).is_ok() {
                n += 1;
            }
        }
    }
    n
}

/// cache-wide stats for diagnostics (settings page's thumbnails row).
pub fn cache_stats() -> (usize, u64) {
    let mut n = 0usize;
    let mut bytes = 0u64;
    if let Ok(rd) = std::fs::read_dir(cache_dir()) {
        for e in rd.filter_map(Result::ok) {
            if e.path().extension().is_some_and(|x| x == "png") {
                n += 1;
                bytes += e.metadata().map(|m| m.len()).unwrap_or(0);
            }
        }
    }
    (n, bytes)
}

/// sequential prefetch for history rows lacking art (d93). one row at a
/// time, each failure-tolerant; capped by the caller so a page-1 visit
/// never turns into a crawl of a 2k-entry library. items are
/// (extractor, vid, url) — url may be empty (imported ids): youtube still
/// resolves off the lookup table, others are skipped honestly.
pub async fn prefetch_history(
    items: Vec<(String, String, String)>,
    max: usize,
) -> Vec<(String, String, String)> {
    let mut done = Vec::new();
    for (i, item) in items.into_iter().enumerate() {
        if i >= max {
            break;
        }
        let (ref ex, ref vid, ref url) = item;
        let key = format!("{ex} {vid}");
        if cache_fresh(&key) {
            done.push(item);
            continue;
        }
        let use_url = if is_youtube(ex) { "" } else { url.as_str() };
        if use_url.is_empty() {
            continue;
        }
        if ensure_remote_art(&key, vid, use_url, ex, None)
            .await
            .is_some()
        {
            done.push(item);
        }
    }
    done
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_key_is_stable_and_stays_in_dir() {
        assert_eq!(sanitize_key("youtube jNQXAC9IVRw"), "youtube_jNQXAC9IVRw");
        assert_eq!(sanitize_key("youtube some id"), "youtube_some_id");
        // separators and windows-invalid chars are dropped — they cannot
        // escape the cache dir; whitespace maps to _
        assert_eq!(sanitize_key("bc:bandcamp/../x*?\"<>|"), "bcbandcamp..x");
        assert_eq!(sanitize_key("soundcloud some/id"), "soundcloud_someid");
        assert_eq!(sanitize_key("youtube "), "youtube_");
    }

    #[test]
    fn youtube_url_shape() {
        let urls = youtube_urls("jNQXAC9IVRw");
        assert_eq!(
            urls[0],
            "https://i.ytimg.com/vi/jNQXAC9IVRw/maxresdefault.jpg"
        );
        assert_eq!(urls[3], "https://i.ytimg.com/vi/jNQXAC9IVRw/default.jpg");
    }

    #[test]
    fn cache_path_is_inside_cache_dir() {
        let p = cache_path("youtube jNQXAC9IVRw");
        assert!(p.starts_with(cache_dir()));
        assert!(p.to_string_lossy().ends_with("youtube_jNQXAC9IVRw.png"));
    }
}
