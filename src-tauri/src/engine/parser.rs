//! structured extraction from yt-dlp's stdout/stderr (§5, D45): progress from
//! the `__P__` template (with a regex fallback), post-processing states,
//! final paths, errors, playlist item boundaries.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ParsedLine {
    /// download progress for the current item.
    Progress {
        downloaded: u64,
        total: Option<u64>,
        speed_bps: Option<f64>,
        eta_sec: Option<u64>,
    },
    /// yt-dlp reported an explicit percentage (fallback path).
    ProgressPercent(f64),
    /// a finished item's final filepath (--print after_move:filepath).
    FinalPath(String),
    /// per-item title extracted from output (D45: runtime metadata).
    Title(String),
    /// a playlist item started: `[download] <id>: ...` destination lines.
    ItemStart { id: String },
    /// yt-dlp's playlist counter: `[download] Downloading item 3 of 12`.
    /// authoritative for the total; items done are counted from ItemStart.
    PlaylistCounter { done: u32, total: u32 },
    /// destination line: `Destination: …` / `[Merger] …` (post-processing).
    Destination(String),
    /// fragment/stream stage line that still counts as downloading.
    Stage(&'static str),
    /// an error line (ERROR: …). job continues if more items remain.
    Error(String),
    /// anything else worth showing in the expando row.
    Line(String),
}

/// parse one stdout line.
pub fn parse_line(raw: &str) -> ParsedLine {
    let line = raw.trim_end();
    let t = line.trim_start();

    if t.starts_with("ERROR:") || t.starts_with("error:") {
        return ParsedLine::Error(line.to_owned());
    }

    // ---- progress template: `download:__P__a|b|c|d` → "a|b|c|d" ----
    if let Some(rest) = t.strip_prefix("download:") {
        if let Some(vals) = rest.strip_prefix("__P__") {
            return parse_template_fields(vals);
        }
    }

    // ---- --print after_move:filepath output (bare path line) ----
    if looks_like_path(t) {
        return ParsedLine::FinalPath(t.to_owned());
    }

    // ---- playlist counter: `[download] Downloading item N of M` ----
    if let Some(rest) = t.strip_prefix("[download] Downloading item ") {
        let mut it = rest.split_whitespace();
        // "N of M"
        let done = it.next().and_then(|v| v.parse::<u32>().ok());
        let total = it
            .next()
            .filter(|w| *w == "of")
            .and_then(|_| it.next())
            .and_then(|v| v.parse::<u32>().ok());
        if let (Some(done), Some(total)) = (done, total) {
            return ParsedLine::PlaylistCounter { done, total };
        }
    }

    // ---- [download] Destination: / [Merger] / [ExtractAudio] etc ----
    if let Some(rest) = t.strip_prefix("[download] Destination:") {
        return ParsedLine::Destination(rest.trim().to_owned());
    }
    for tag in [
        "[Merger]",
        "[ExtractAudio]",
        "[EmbedThumbnail]",
        "[Metadata]",
        "[VideoRemuxer]",
        "[ThumbnailsConvertor]",
    ] {
        if let Some(rest) = t.strip_prefix(tag) {
            let rest = rest.trim();
            if let Some(dest) = rest.strip_prefix("Destination:") {
                return ParsedLine::Destination(dest.trim().to_owned());
            }
            return ParsedLine::Stage(stage_name(tag));
        }
    }

    // ---- title: `[download] <id>: <title>` (item start; D45 runtime title) —
    //      distinguished from plain progress by lacking digits+% ----
    if t.starts_with("[download]") {
        if let Some(rest) = t.strip_prefix("[download]") {
            let rest = rest.trim();
            // `[download]  42.1% of …` / `[download] 100% of …` (fallback)
            if let Some(pct) = parse_percent_line(rest) {
                return ParsedLine::ProgressPercent(pct);
            }
            if rest.contains('%') {
                return ParsedLine::Line(line.to_owned());
            }
            // `[download] abc123: Some Title`
            if let Some((id, _title)) = rest.split_once(": ") {
                let id = id.trim();
                if !id.is_empty() && id.len() <= 64 {
                    return ParsedLine::ItemStart { id: id.to_owned() };
                }
            }
            return ParsedLine::Line(line.to_owned());
        }
    }

    // ---- generic Destination: (e.g. from --print-less paths) ----
    if let Some(rest) = t.strip_prefix("Destination:") {
        return ParsedLine::Destination(rest.trim().to_owned());
    }

    // ---- metadata lines: `Title: …` etc from verbose output ----
    if let Some(title) = t.strip_prefix("Title: ") {
        return ParsedLine::Title(title.trim().to_owned());
    }

    ParsedLine::Line(line.to_owned())
}

fn parse_template_fields(vals: &str) -> ParsedLine {
    let mut it = vals.split('|');
    let downloaded = it.next().and_then(|v| v.trim().parse::<u64>().ok());
    let total = it.next().and_then(|v| v.trim().parse::<u64>().ok());
    let speed = it.next().and_then(|v| v.trim().parse::<f64>().ok());
    let eta = it.next().and_then(|v| v.trim().parse::<u64>().ok());
    match downloaded {
        Some(d) => ParsedLine::Progress {
            downloaded: d,
            total,
            speed_bps: speed,
            eta_sec: eta,
        },
        // template emitted but fields empty (e.g. post-processing phase)
        None => ParsedLine::Line(format!("download:{vals}")),
    }
}

/// `[download]  42.1% of ~ 1.20GiB at 10.80MiB/s ETA 01:11`
fn parse_percent_line(rest: &str) -> Option<f64> {
    let pct_token = rest.split_whitespace().next()?;
    if pct_token.ends_with('%') {
        return pct_token.trim_end_matches('%').parse::<f64>().ok();
    }
    None
}

fn stage_name(tag: &str) -> &'static str {
    match tag {
        "[Merger]" => "post",
        "[ExtractAudio]" => "post",
        "[EmbedThumbnail]" => "post",
        "[Metadata]" => "post",
        "[VideoRemuxer]" => "post",
        "[ThumbnailsConvertor]" => "post",
        _ => "download",
    }
}

/// conservative path heuristic for `--print after_move:filepath` output:
/// contains a path separator or drive letter, no spaces-percent signature.
fn looks_like_path(t: &str) -> bool {
    if t.is_empty() || t.len() > 400 {
        return false;
    }
    (t.starts_with("\\\\?\\")
        || t.contains('\\')
        || t.contains('/')
        || (t.as_bytes().get(1) == Some(&b':')))
        && !t.starts_with('[')
        && !t.starts_with("ERROR")
        && !t.starts_with("WARNING")
        && !t.contains("%)")
}

/// classify a line as user-facing severity for the expando row coloring.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LineKind {
    Progress,
    Info,
    Error,
}

pub fn classify(raw: &str) -> LineKind {
    match parse_line(raw) {
        ParsedLine::Progress { .. } | ParsedLine::ProgressPercent(_) => LineKind::Progress,
        ParsedLine::Error(_) => LineKind::Error,
        _ => LineKind::Info,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn template_progress_fields() {
        let p = parse_line("download:__P__42152704|104857600|11272189.47|47");
        match p {
            ParsedLine::Progress {
                downloaded,
                total,
                speed_bps,
                eta_sec,
            } => {
                assert_eq!(downloaded, 42_152_704);
                assert_eq!(total, Some(104_857_600));
                assert_eq!(speed_bps, Some(11_272_189.47));
                assert_eq!(eta_sec, Some(47));
            }
            other => panic!("wrong parse: {other:?}"),
        }
    }

    #[test]
    fn template_progress_no_total() {
        match parse_line("download:__P__1000|NA|NA|NA") {
            ParsedLine::Progress {
                downloaded, total, ..
            } => {
                assert_eq!(downloaded, 1000);
                assert_eq!(total, None);
            }
            other => panic!("wrong parse: {other:?}"),
        }
    }

    #[test]
    fn percent_fallback() {
        match parse_line("[download]  42.1% of ~ 1.20GiB at 10.80MiB/s ETA 01:11") {
            ParsedLine::ProgressPercent(p) => assert!((p - 42.1).abs() < 1e-9),
            other => panic!("wrong parse: {other:?}"),
        }
    }

    #[test]
    fn final_path_detection() {
        match parse_line(r"C:\Users\you\Downloads\Sunset [ab12].webm") {
            ParsedLine::FinalPath(p) => assert!(p.ends_with(".webm")),
            other => panic!("wrong parse: {other:?}"),
        }
    }

    #[test]
    fn error_line() {
        match parse_line("ERROR: [youtube] abc123: Private video. Sign in if you have access.") {
            ParsedLine::Error(e) => assert!(e.contains("Private video")),
            other => panic!("wrong parse: {other:?}"),
        }
    }

    #[test]
    fn item_start_vs_progress() {
        match parse_line("[download] abc123def45: Sunset Timelapse 4K") {
            ParsedLine::ItemStart { id } => assert_eq!(id, "abc123def45"),
            other => panic!("wrong parse: {other:?}"),
        }
    }

    #[test]
    fn playlist_counter_line() {
        match parse_line("[download] Downloading item 3 of 12") {
            ParsedLine::PlaylistCounter { done, total } => {
                assert_eq!((done, total), (3, 12));
            }
            other => panic!("wrong parse: {other:?}"),
        }
        // malformed counters stay plain lines, never mis-parse
        assert!(matches!(
            parse_line("[download] Downloading item x of 12"),
            ParsedLine::Line(_)
        ));
        assert!(matches!(
            parse_line("[download] Downloading item 3 of"),
            ParsedLine::Line(_) | ParsedLine::ItemStart { .. }
        ));
    }

    #[test]
    fn archive_skip_line_reads_as_item_start() {
        // skipped items are "processed" for items-done counting (D33)
        match parse_line("[download] abc123: Has already been recorded in the archive") {
            ParsedLine::ItemStart { id } => assert_eq!(id, "abc123"),
            other => panic!("wrong parse: {other:?}"),
        }
    }

    #[test]
    fn merger_is_post_stage() {
        match parse_line("[Merger] Merging formats into \"out.mp4\"") {
            ParsedLine::Stage(s) => assert_eq!(s, "post"),
            other => panic!("wrong parse: {other:?}"),
        }
    }

    #[test]
    fn destination_line() {
        match parse_line("[download] Destination: C:\\dl\\video.f616.mp4") {
            ParsedLine::Destination(d) => assert!(d.ends_with(".mp4")),
            other => panic!("wrong parse: {other:?}"),
        }
    }

    #[test]
    fn classify_kinds() {
        assert_eq!(classify("download:__P__1|2|3|4"), LineKind::Progress);
        assert_eq!(classify("ERROR: nope"), LineKind::Error);
        assert_eq!(classify("[download] Sleeping…"), LineKind::Info);
    }
}
