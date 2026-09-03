//! binary sources (§4): yt-dlp from github releases, ffmpeg from btbN with
//! gyan.dev as fallback (D4). all free sources — $0 budget (D2).

use serde::{Deserialize, Serialize};

use crate::error::{other, AppError, AppResult};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Tool {
    #[serde(rename = "yt-dlp")]
    YtDlp,
    Ffmpeg,
}

impl Tool {
    pub fn display_name(self) -> &'static str {
        match self {
            Tool::YtDlp => "yt-dlp",
            Tool::Ffmpeg => "ffmpeg",
        }
    }

    /// names of the files the app owns for this tool inside `bin/` (§4).
    pub fn files(self) -> &'static [&'static str] {
        match self {
            Tool::YtDlp => &["yt-dlp.exe"],
            Tool::Ffmpeg => &["ffmpeg.exe", "ffprobe.exe"],
        }
    }
}

/// one downloadable source for a tool. ffmpeg has two (D4); yt-dlp one.
#[derive(Debug, Clone, Copy)]
pub struct Source {
    /// value stored in the manifest's `source` field.
    pub id: &'static str,
    repo: &'static str,
    /// asset name in `/releases/latest` (exact for `suffix: None`); for
    /// `suffix: Some(s)` assets are matched by `name.ends_with(s)` — gyan
    /// names its zips per release tag (`ffmpeg-9.0.1-essentials_build.zip`),
    /// so no stable exact name exists to match.
    asset: &'static str,
    suffix: Option<&'static str>,
}

impl Source {
    /// does this release asset belong to this source?
    pub fn asset_matches(&self, name: &str) -> bool {
        name == self.asset || self.suffix.is_some_and(|s| name.ends_with(s))
    }

    /// rolling sources re-publish one release (same tag) with new assets
    /// (btbN's `latest`); tag comparison can never signal change for them —
    /// the release etag is the change signal instead.
    pub fn rolling(&self) -> bool {
        self.id == "btbn"
    }
}

pub const YT_DLP_SOURCES: &[Source] = &[Source {
    id: "github",
    repo: "yt-dlp/yt-dlp",
    asset: "yt-dlp.exe",
    suffix: None,
}];

pub const FFMPEG_SOURCES: &[Source] = &[
    // btbN win64-gpl primary (D4). `latest` tag = daily master build.
    Source {
        id: "btbn",
        repo: "BtbN/FFmpeg-Builds",
        asset: "ffmpeg-master-latest-win64-gpl.zip",
        suffix: None,
    },
    // gyan.dev release-essentials fallback (D4). real version tags; asset
    // name embeds the version, matched by suffix.
    Source {
        id: "gyan",
        repo: "GyanD/codexffmpeg",
        asset: "ffmpeg-<tag>-essentials_build.zip",
        suffix: Some("-essentials_build.zip"),
    },
];

pub fn sources_for(tool: Tool) -> &'static [Source] {
    match tool {
        Tool::YtDlp => YT_DLP_SOURCES,
        Tool::Ffmpeg => FFMPEG_SOURCES,
    }
}

/// result of a successful `GET /releases/latest` (D42 etag flow).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LatestRelease {
    pub tag: String,
    pub source_id: String,
    /// file to download (the exe itself for yt-dlp, a zip for ffmpeg).
    pub asset_url: Option<String>,
    /// direct sha256 sums file when the release ships one (yt-dlp does).
    pub sums_url: Option<String>,
    /// release-level etag; stored in the manifest and replayed with
    /// If-None-Match so routine checks cost one 304 (D42).
    pub etag: Option<String>,
}

/// http client configured once (rustls per the §2 stack — no openssl).
pub fn http() -> AppResult<reqwest::Client> {
    Ok(reqwest::ClientBuilder::new()
        .user_agent(concat!("ytdlp-gui/", env!("CARGO_PKG_VERSION")))
        .build()?)
}

/// query one source's `/releases/latest`, replaying `etag` via If-None-Match.
/// Ok(None) on 304 — nothing newer than what the manifest already records.
async fn latest_from_source(
    client: &reqwest::Client,
    src: &Source,
    etag: Option<&str>,
) -> AppResult<Option<LatestRelease>> {
    let url = format!("https://api.github.com/repos/{}/releases/latest", src.repo);
    let mut req = client
        .get(&url)
        .header("Accept", "application/vnd.github+json");
    if let Some(tag) = etag {
        req = req.header("If-None-Match", tag);
    }
    let resp = req.send().await?;

    if resp.status() == reqwest::StatusCode::NOT_MODIFIED {
        return Ok(None);
    }
    let status = resp.status();
    if !status.is_success() {
        return Err(other(format!(
            "github api for {} returned {status}",
            src.repo
        )));
    }
    let etag = resp
        .headers()
        .get("etag")
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned);
    let json: serde_json::Value = resp.json().await?;
    let tag = json["tag_name"]
        .as_str()
        .ok_or_else(|| other("release json missing tag_name"))?
        .to_owned();

    let (mut asset_url, mut sums_url) = (None, None);
    if let Some(assets) = json["assets"].as_array() {
        for a in assets {
            let name = a["name"].as_str().unwrap_or("");
            let Some(dl) = a["browser_download_url"].as_str() else {
                continue;
            };
            if src.asset_matches(name) {
                asset_url = Some(dl.to_owned());
            } else if name == "SHA2-SUMS.txt" {
                sums_url = Some(dl.to_owned());
            }
        }
    }

    Ok(Some(LatestRelease {
        tag,
        source_id: src.id.to_owned(),
        asset_url,
        sums_url,
        etag,
    }))
}

/// walk a tool's sources in priority order (D4) until one answers. an etag is
/// only replayed against the source that produced it (fallback switch
/// invalidates it). stops at the first source with a usable release.
pub async fn latest_release(
    client: &reqwest::Client,
    tool: Tool,
    previous: Option<(&str, Option<&str>)>,
) -> AppResult<Option<LatestRelease>> {
    let mut last_err: Option<AppError> = None;
    for src in sources_for(tool) {
        let etag = previous
            .filter(|(sid, _)| *sid == src.id)
            .and_then(|(_, et)| et);
        match latest_from_source(client, src, etag).await {
            Ok(Some(rel)) => {
                if rel.asset_url.is_some() {
                    return Ok(Some(rel));
                }
                // release answered but lacks the asset we need: try next source
                last_err = Some(other(format!(
                    "{} release {rel:?} has no {} asset",
                    src.id,
                    tool.display_name()
                )));
            }
            Ok(None) => return Ok(None), // 304 from the matching source
            Err(e) => last_err = Some(e),
        }
    }
    Err(last_err.unwrap_or_else(|| other("no source configured")))
}

/// parse a yt-dlp `SHA2-SUMS.txt` style file into (filename, sha256-hex) pairs.
/// lines look like `<hash>  <name>` (two spaces), possibly with `*` before the
/// name for binary mode. tolerant of extra whitespace and comments.
pub fn parse_sha256_sums(text: &str) -> Vec<(String, String)> {
    text.lines()
        .filter_map(|line| {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') {
                return None;
            }
            let (hash, name) = line.split_once(char::is_whitespace)?;
            let hash = hash.trim();
            let name = name.trim().trim_start_matches('*').trim();
            if hash.len() != 64 || !hash.bytes().all(|b| b.is_ascii_hexdigit()) {
                return None;
            }
            if name.is_empty() {
                return None;
            }
            Some((name.to_owned(), hash.to_ascii_lowercase()))
        })
        .collect()
}

/// sha256 of a byte slice as lowercase hex.
pub fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::Digest;
    let mut h = sha2::Sha256::new();
    h.update(bytes);
    hex::encode(h.finalize())
}

/// sha256 of a file, streamed in 64k chunks (ffmpeg zips are ~90 mb).
pub async fn sha256_file(path: &std::path::Path) -> AppResult<String> {
    use sha2::Digest;
    use tokio::io::AsyncReadExt;

    let mut file = tokio::fs::File::open(path).await?;
    let mut hasher = sha2::Sha256::new();
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        let n = file.read(&mut buf).await?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hex::encode(hasher.finalize()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_ytdlp_sums_format() {
        let text = "# SHA256 checksums generated by yt-dlp\n\
                    3a7bd3e2360a3d29eea436fcfb7e44c735d117c42d1c1835420b6b9942af4cb3  yt-dlp.exe\n\
                    deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef *SHA2-SUMS.txt\n";
        let sums = parse_sha256_sums(text);
        assert_eq!(sums.len(), 2);
        assert_eq!(
            sums[0],
            (
                "yt-dlp.exe".to_owned(),
                "3a7bd3e2360a3d29eea436fcfb7e44c735d117c42d1c1835420b6b9942af4cb3".to_owned()
            )
        );
        assert_eq!(sums[1].0, "SHA2-SUMS.txt"); // binary-mode `*` stripped
        assert_eq!(sums[1].1, "deadbeef".repeat(8));
    }

    #[test]
    fn rejects_garbage_lines() {
        let text = "nothash file\n\
                    1234  tooshort\n\
                    \n\
                    GARBAGE!! extra\n\
                    abc def\n";
        assert!(parse_sha256_sums(text).is_empty());
    }

    #[test]
    fn sha256_hex_matches_known_vector() {
        assert_eq!(
            sha256_hex(b"hello world"),
            "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9"
        );
    }

    #[test]
    fn d4_source_priority_is_btbn_then_gyan() {
        let ids: Vec<&str> = FFMPEG_SOURCES.iter().map(|s| s.id).collect();
        assert_eq!(ids, ["btbn", "gyan"]);
        assert!(FFMPEG_SOURCES[0]
            .asset
            .starts_with("ffmpeg-master-latest-win64-gpl"));
    }

    #[test]
    fn gyan_suffix_matches_real_asset_names() {
        let gyan = &FFMPEG_SOURCES[1];
        // live names observed from the github api (2026-09)
        assert!(gyan.asset_matches("ffmpeg-9.0.1-essentials_build.zip"));
        assert!(gyan.asset_matches("ffmpeg-7.1.1-essentials_build.zip"));
        assert!(!gyan.asset_matches("ffmpeg-9.0.1-full_build.zip"));
        assert!(!gyan.asset_matches("ffmpeg-9.0.1-essentials_build.zip.sig"));
        // btbn + yt-dlp stay exact-match
        assert!(FFMPEG_SOURCES[0].asset_matches("ffmpeg-master-latest-win64-gpl.zip"));
        assert!(!FFMPEG_SOURCES[0].asset_matches("ffmpeg-master-latest-win64-gpl-shared.zip"));
    }

    #[test]
    fn only_btbn_is_rolling() {
        assert!(FFMPEG_SOURCES[0].rolling());
        assert!(!FFMPEG_SOURCES[1].rolling());
        assert!(!YT_DLP_SOURCES[0].rolling());
    }

    #[test]
    fn tool_files_cover_manifest_needs() {
        assert_eq!(Tool::YtDlp.files(), &["yt-dlp.exe"]);
        assert_eq!(Tool::Ffmpeg.files(), &["ffmpeg.exe", "ffprobe.exe"]);
    }
}
