//! d45 runtime metadata: duration + size of a finished file, probed with
//! the app-managed ffprobe (§4 already ships it beside ffmpeg — yt-dlp only
//! ever needs ffmpeg, so ffprobe is otherwise idle). runs only at job
//! finalization on a local file — no network, no extra yt-dlp invocations,
//! CREATE_NO_WINDOW, 5s cap. every failure degrades to `None` (history keeps
//! rendering "—", exactly as before): a convenience recovery, not a
//! dependency (D30 discipline).
//!
//! the format column is deliberately NOT ffprobe's format_name: for mp4 it
//! reports "mov,mp4,m4a,3gp,3g2,mj2" and for webm "matroska,webm" — muxer
//! registries, not what the user got. the file's own extension is the
//! honest answer and is derived at the call site.

use std::path::Path;

use serde::Deserialize;

/// windows-only: CREATE_NO_WINDOW so the probe never flashes a console
/// (same pattern as process.rs).
#[cfg(windows)]
fn no_window(cmd: &mut tokio::process::Command) {
    cmd.creation_flags(0x0800_0000);
}

#[cfg(not(windows))]
fn no_window(_cmd: &mut tokio::process::Command) {}

#[derive(Debug, Clone, Default)]
pub struct FileMeta {
    pub duration_sec: Option<u32>,
    pub size_bytes: Option<u64>,
}

#[derive(Debug, Deserialize)]
struct FfprobeOut {
    #[serde(default)]
    format: Option<FfFormat>,
}

#[derive(Debug, Deserialize)]
struct FfFormat {
    /// decimal-string seconds, e.g. "19.176000"
    duration: Option<String>,
    /// integer-string bytes ("N/A" only for pipes; we probe real files)
    size: Option<String>,
}

/// the app-managed ffprobe — absent in exotic layouts, callers treat that
/// as "no metadata".
fn ffprobe_path() -> Option<std::path::PathBuf> {
    let p = crate::binaries::manager::bin_dir().join("ffprobe.exe");
    p.is_file().then_some(p)
}

/// probe a finished file. the timeout caps a hung ffprobe at 5s (local
/// files probe in <100ms).
pub async fn probe_file(path: &Path) -> Option<FileMeta> {
    let exe = ffprobe_path()?;
    if !path.is_file() {
        return None;
    }
    let mut cmd = tokio::process::Command::new(exe);
    cmd.args([
        "-v",
        "error",
        "-print_format",
        "json",
        "-show_format",
        path.to_string_lossy().as_ref(),
    ]);
    no_window(&mut cmd);
    let out = cmd.output();

    let out = match tokio::time::timeout(std::time::Duration::from_secs(5), out).await {
        Ok(Ok(o)) if o.status.success() => o,
        _ => return None,
    };
    let parsed: FfprobeOut = serde_json::from_slice(&out.stdout).ok()?;
    let f = parsed.format?;

    let duration_sec = f
        .duration
        .as_deref()
        .and_then(|d| d.trim().parse::<f64>().ok())
        .map(|s| s.round() as u32);
    let size_bytes = f.size.as_deref().and_then(|s| s.trim().parse::<u64>().ok());

    Some(FileMeta {
        duration_sec,
        size_bytes,
    })
}

/// display format for the history row: the file's own extension, lowercased
/// (see module header for why this beats ffprobe's format_name).
pub fn format_label(path: &str) -> Option<String> {
    Path::new(path)
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .filter(|e| !e.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn format_label_from_extension() {
        assert_eq!(
            format_label("C:\\music\\Song.opus").as_deref(),
            Some("opus")
        );
        assert_eq!(format_label("/tmp/video.WEBM").as_deref(), Some("webm"));
        assert_eq!(format_label("no-extension"), None);
    }
}
