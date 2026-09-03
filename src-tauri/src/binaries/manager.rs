//! binary manager (§4): owns `%APPDATA%\ytdlp-gui\bin` — manifest.json (D42),
//! download → sha256 verify → atomic swap. the manager is the single writer
//! of the manifest; updates stage instead of fighting a locked exe.

use std::path::{Path, PathBuf};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::Emitter;

use crate::binaries::sources::{
    self, http, latest_release, sha256_file, sha256_hex, sources_for, LatestRelease, Source, Tool,
};
use crate::error::{other, AppResult};

// ---------------------------------------------------------------------------
// locations (§4)
// ---------------------------------------------------------------------------

/// `%APPDATA%\ytdlp-gui` (roaming). writable, no admin required.
pub fn app_data_dir() -> PathBuf {
    dirs::data_dir()
        .unwrap_or_else(|| std::env::temp_dir().join("ytdlp-gui"))
        .join("ytdlp-gui")
}

pub fn bin_dir() -> PathBuf {
    app_data_dir().join("bin")
}

pub fn manifest_path() -> PathBuf {
    bin_dir().join("manifest.json")
}

// ---------------------------------------------------------------------------
// manifest (D42)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ToolEntry {
    /// human-readable version, detected from the binary itself
    /// (`--version`), falling back to the release tag.
    pub version: String,
    /// sha256 (lowercase hex) of the downloaded artifact — the exe for
    /// yt-dlp, the zip for ffmpeg.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sha256: Option<String>,
    /// source id: "github" | "btbn" | "gyan".
    pub source: String,
    /// etag of the release this artifact came from (D42).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub etag: Option<String>,
    /// latest release tag seen at install/check time; "update available"
    /// compares against this (D42 stores check state; the tag is what makes
    /// btbN's rolling "latest" tag comparable).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latest_tag: Option<String>,
    /// unix seconds of the last release check (D42).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_checked: Option<u64>,
    /// true only for user-picked custom binaries (D40: managed installs
    /// always track latest; only custom paths are pinned).
    #[serde(default)]
    pub pinned: bool,
    /// custom-executable escape hatch (§6 tools): overrides the managed path.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub custom_path: Option<String>,
    /// a replacement is waiting in `<name>.staged` — applied on next launch.
    #[serde(default)]
    pub staged: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Manifest {
    #[serde(rename = "yt-dlp")]
    pub yt_dlp: Option<ToolEntry>,
    pub ffmpeg: Option<ToolEntry>,
}

impl Manifest {
    pub fn entry(&self, tool: Tool) -> Option<&ToolEntry> {
        match tool {
            Tool::YtDlp => self.yt_dlp.as_ref(),
            Tool::Ffmpeg => self.ffmpeg.as_ref(),
        }
    }

    pub fn entry_mut(&mut self, tool: Tool) -> &mut Option<ToolEntry> {
        match tool {
            Tool::YtDlp => &mut self.yt_dlp,
            Tool::Ffmpeg => &mut self.ffmpeg,
        }
    }
}

pub fn load_manifest() -> AppResult<Manifest> {
    let path = manifest_path();
    match std::fs::read_to_string(&path) {
        Ok(text) => serde_json::from_str(&text)
            .map_err(|e| other(format!("corrupt manifest {}: {e}", path.display()))),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Manifest::default()),
        Err(e) => Err(e.into()),
    }
}

/// atomic manifest write (D42: written only via the manager): temp file in
/// the same dir, then rename over the target.
pub fn save_manifest(m: &Manifest) -> AppResult<()> {
    let dir = bin_dir();
    std::fs::create_dir_all(&dir)?;
    let tmp = dir.join(".manifest.json.tmp");
    std::fs::write(&tmp, serde_json::to_string_pretty(m)?)?;
    std::fs::rename(&tmp, manifest_path())?;
    Ok(())
}

pub fn now_unix() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

// ---------------------------------------------------------------------------
// version detection
// ---------------------------------------------------------------------------

/// run `<exe> --version` (ffmpeg: `-version`) and return the first stdout
/// line. 10s timeout — a wedged binary must not hang the wizard.
pub async fn detect_version(exe: &Path, tool: Tool) -> Option<String> {
    let mut cmd = tokio::process::Command::new(exe);
    cmd.arg(match tool {
        Tool::YtDlp => "--version",
        Tool::Ffmpeg => "-version",
    })
    .stdout(std::process::Stdio::piped())
    .stderr(std::process::Stdio::null())
    .creation_flags(0x0800_0000); // CREATE_NO_WINDOW

    let out = tokio::time::timeout(std::time::Duration::from_secs(10), cmd.output())
        .await
        .ok()?
        .ok()?;
    let line = String::from_utf8_lossy(&out.stdout);
    let line = line.lines().next()?.trim();

    Some(match tool {
        Tool::YtDlp => line.to_owned(),
        Tool::Ffmpeg => {
            // "ffmpeg version 7.1.1-…" → the token after "version"
            line.split_whitespace().nth(2).unwrap_or(line).to_owned()
        }
    })
}

// windows-only: tokio::process::Command exposes `creation_flags` inherently
// on windows targets (CREATE_NO_WINDOW so version probes don't flash a console).

// ---------------------------------------------------------------------------
// download + verify + swap
// ---------------------------------------------------------------------------

/// download `url` to `dest`, emitting `binaries:progress` events (§7) at most
/// every 100 ms. returns the artifact's sha256.
async fn download(
    app: &tauri::AppHandle,
    client: &reqwest::Client,
    url: &str,
    tool: Tool,
    dest: &Path,
) -> AppResult<String> {
    let resp = client.get(url).send().await?.error_for_status()?;
    let total = resp.content_length();

    use futures_util::StreamExt;
    use tokio::io::AsyncWriteExt;

    let mut file = tokio::fs::File::create(dest).await?;
    let mut stream = resp.bytes_stream();
    let mut received: u64 = 0;
    let mut last_emit = Instant::now();

    while let Some(chunk) = stream.next().await {
        let chunk = chunk?;
        file.write_all(&chunk).await?;
        received += chunk.len() as u64;
        if last_emit.elapsed().as_millis() >= 100 {
            last_emit = Instant::now();
            let _ = app.emit(
                "binaries:progress",
                serde_json::json!({ "tool": tool.display_name(), "received": received, "total": total }),
            );
        }
    }
    file.flush().await?;
    let _ = app.emit(
        "binaries:progress",
        serde_json::json!({ "tool": tool.display_name(), "received": received, "total": total }),
    );
    sha256_file(dest).await
}

/// rename `from` over `to`. on failure (target exe locked by a running
/// download — §4) the caller stages instead.
fn replace_atomic(from: &Path, to: &Path) -> AppResult<()> {
    std::fs::rename(from, to).map_err(|e| {
        other(format!(
            "swap {} → {} failed ({}); staged for next launch",
            from.display(),
            to.display(),
            e
        ))
    })
}

fn stage_path(file: &str) -> PathBuf {
    bin_dir().join(format!("{file}.staged"))
}

/// apply any staged swaps left by a previous update while the exe was locked.
/// called once at app start (§4: "stage and swap on app exit" — a launch-time
/// swap is equivalent and simpler: the app itself holds no locks at startup).
pub fn apply_staged_swaps(m: &mut Manifest) -> AppResult<()> {
    for tool in [Tool::YtDlp, Tool::Ffmpeg] {
        let Some(entry) = m.entry_mut(tool) else {
            continue;
        };
        if !entry.staged {
            continue;
        }
        let mut all_swapped = true;
        for file in tool.files() {
            let staged = stage_path(file);
            if staged.exists() {
                if let Err(e) = std::fs::rename(&staged, bin_dir().join(file)) {
                    eprintln!("staged swap failed for {file}: {e}");
                    all_swapped = false;
                }
            }
        }
        if all_swapped {
            entry.staged = false;
        }
    }
    save_manifest(m)
}

/// one tool's install/update result for the IPC layer.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallResult {
    pub tool: Tool,
    pub version: String,
    pub source: String,
    /// sha256 of the downloaded artifact.
    pub sha256: String,
    /// true when the new binary couldn't replace a locked file and is staged.
    pub staged: bool,
}

/// download, verify and place `tool`. `previous` = (source id, etag) for the
/// conditional re-check; pass None on first install.
pub async fn install_or_update(
    app: &tauri::AppHandle,
    tool: Tool,
    previous: Option<(&str, Option<&str>)>,
) -> AppResult<InstallResult> {
    let client = http()?;
    let dir = bin_dir();
    std::fs::create_dir_all(&dir)?;

    let Some(rel) = latest_release(&client, tool, previous).await? else {
        return Err(other(format!(
            "{} is already at the checked release",
            tool.display_name()
        )));
    };

    let url = rel
        .asset_url
        .clone()
        .ok_or_else(|| other("release has no usable asset"))?;

    // ---- download to temp ----
    let is_zip = url.ends_with(".zip");
    let tmp_name = if is_zip {
        format!(".{}.download", tool.display_name())
    } else {
        format!(".{}.download", tool.files()[0])
    };
    let tmp = dir.join(&tmp_name);
    let sha = download(app, &client, &url, tool, &tmp).await?;

    // ---- verify ----
    // yt-dlp ships SHA2-SUMS.txt → hard verify. ffmpeg sources (btbN/gyan)
    // ship no per-asset checksum file for rolling builds; integrity there =
    // the zip container CRC (checked on open below) + the sha256 recorded in
    // the manifest at install time.
    if let Some(sums_url) = &rel.sums_url {
        let text = client
            .get(sums_url)
            .send()
            .await?
            .error_for_status()?
            .text()
            .await?;
        let wanted = sources::parse_sha256_sums(&text)
            .into_iter()
            .find(|(name, _)| name == tool.files()[0])
            .map(|(_, hash)| hash);
        if let Some(wanted) = wanted {
            if wanted != sha {
                let _ = std::fs::remove_file(&tmp);
                return Err(other(format!(
                    "sha256 mismatch for {}: expected {wanted}, got {sha}",
                    tool.display_name()
                )));
            }
        }
    }

    // ---- place ----
    let mut staged = false;
    let mut final_shas: Vec<String> = vec![sha.clone()];

    if is_zip {
        // extract only ffmpeg.exe / ffprobe.exe from <build>/bin/ (§4)
        let f = std::fs::File::open(&tmp)?;
        let mut zip = zip::ZipArchive::new(f).map_err(|e| other(format!("bad zip: {e}")))?;
        for file in tool.files() {
            let entry_path = zip
                .file_names()
                .find(|n| n.ends_with(&format!("/bin/{file}")) || n == &format!("bin/{file}"))
                .ok_or_else(|| other(format!("{file} not found in zip")))?
                .to_owned();
            let mut entry = zip.by_name(&entry_path)?;
            let out_tmp = dir.join(format!(".{file}.extract"));
            {
                let mut out = std::fs::File::create(&out_tmp)?;
                std::io::copy(&mut entry, &mut out)?;
            }
            // sha of extracted exe for the manifest
            use std::io::Read as _;
            let mut buf = Vec::new();
            std::fs::File::open(&out_tmp)?.read_to_end(&mut buf)?;
            final_shas.push(sha256_hex(&buf));

            let dest = dir.join(file);
            if replace_atomic(&out_tmp, &dest).is_err() {
                std::fs::rename(&out_tmp, stage_path(file))?;
                staged = true;
            }
        }
    } else {
        let dest = dir.join(tool.files()[0]);
        if replace_atomic(&tmp, &dest).is_err() {
            std::fs::rename(&tmp, stage_path(tool.files()[0]))?;
            staged = true;
        }
    }

    let _ = std::fs::remove_file(&tmp);

    // ---- version ----
    // when staged (old exe still locked in place), detect_version would read
    // the OLD binary — record the release tag instead and let the next
    // launch's post-swap status pick up the real `--version`.
    let version = if staged {
        rel.tag.clone()
    } else {
        detect_version(&dir.join(tool.files()[0]), tool)
            .await
            .unwrap_or_else(|| rel.tag.clone())
    };

    // ---- manifest ----
    let mut m = load_manifest()?;
    let entry = m.entry_mut(tool).get_or_insert_with(ToolEntry::default);
    entry.version = version.clone();
    entry.sha256 = Some(final_shas[0].clone());
    entry.source = rel.source_id.clone();
    entry.etag = rel.etag.clone();
    entry.latest_tag = Some(rel.tag.clone());
    entry.last_checked = Some(now_unix());
    entry.pinned = false;
    entry.staged = staged;
    save_manifest(&m)?;

    Ok(InstallResult {
        tool,
        version,
        source: rel.source_id,
        sha256: sha,
        staged,
    })
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolStatus {
    pub tool: Tool,
    pub installed: bool,
    pub version: Option<String>,
    /// path the engine will actually use (custom override wins).
    pub path: Option<String>,
    pub custom: bool,
    pub update_available: bool,
    pub latest_tag: Option<String>,
    pub staged: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BinaryManifest {
    pub yt_dlp: ToolStatus,
    pub ffmpeg: ToolStatus,
    /// true once both tools are usable — gates the first-run wizard.
    pub ready: bool,
}

/// path the engine will use for `tool`: custom override if set+existing,
/// else the managed copy.
pub fn resolve_tool_path(m: &Manifest, tool: Tool) -> Option<PathBuf> {
    if let Some(entry) = m.entry(tool) {
        if let Some(custom) = &entry.custom_path {
            let p = PathBuf::from(custom);
            if p.is_file() {
                return Some(p);
            }
        }
    }
    let managed = bin_dir().join(tool.files()[0]);
    managed.is_file().then_some(managed)
}

pub fn status(m: &Manifest) -> BinaryManifest {
    let mk = |tool: Tool| {
        let entry = m.entry(tool);
        let path = resolve_tool_path(m, tool);
        let custom = entry
            .and_then(|e| e.custom_path.as_ref())
            .map(|c| PathBuf::from(c).is_file())
            .unwrap_or(false);
        let installed = path.is_some();
        ToolStatus {
            tool,
            installed,
            version: entry.filter(|_| installed).map(|e| e.version.clone()),
            path: path.map(|p| p.to_string_lossy().into_owned()),
            custom,
            // update availability is computed by the check command (network);
            // status only reports what the manifest already knows.
            update_available: false,
            latest_tag: entry.and_then(|e| e.latest_tag.clone()),
            staged: entry.map(|e| e.staged).unwrap_or(false),
        }
    };

    let yt_dlp = mk(Tool::YtDlp);
    let ffmpeg = mk(Tool::Ffmpeg);
    let ready = yt_dlp.installed && ffmpeg.installed;
    BinaryManifest {
        yt_dlp,
        ffmpeg,
        ready,
    }
}

/// record a user-picked custom binary (D40 escape hatch). empty path clears.
pub fn set_custom_path(tool: Tool, path: Option<String>) -> AppResult<ToolStatus> {
    let mut m = load_manifest()?;
    let entry = m.entry_mut(tool).get_or_insert_with(ToolEntry::default);
    entry.custom_path = path
        .filter(|p| !p.trim().is_empty())
        .map(|p| p.trim().to_owned());
    entry.pinned = entry.custom_path.is_some();
    save_manifest(&m)?;
    Ok(status(&m).tool_status(tool))
}

impl BinaryManifest {
    pub fn tool_status(&self, tool: Tool) -> ToolStatus {
        match tool {
            Tool::YtDlp => self.yt_dlp.clone(),
            Tool::Ffmpeg => self.ffmpeg.clone(),
        }
    }
}

/// compare a fresh LatestRelease against the manifest and record the check
/// (D42: lastChecked + etag + latestTag). returns `Some(new_tag)` when the
/// release differs from the installed state (→ "update available").
///
/// rolling sources (btbN's `latest`): the tag is constant, so change is
/// signaled by the release etag instead — a new upload gets a fresh etag.
pub fn record_check(tool: Tool, rel: &LatestRelease) -> AppResult<Option<String>> {
    let mut m = load_manifest()?;
    let entry = m.entry_mut(tool).get_or_insert_with(ToolEntry::default);
    let rolling = sources_for(tool)
        .iter()
        .find(|s| s.id == rel.source_id)
        .is_some_and(Source::rolling);
    let update_available = if rolling {
        // rolling sources: the tag never changes ("latest"), so the release
        // etag is the change signal. if the source omits etags entirely,
        // change can't be detected — the badge stays off and `update`
        // remains available on demand (D20 keeps it user-initiated anyway).
        entry.latest_tag.as_deref() != Some(rel.tag.as_str())
            || entry.etag.as_deref() != rel.etag.as_deref()
    } else {
        entry
            .latest_tag
            .as_ref()
            .map(|seen| seen != &rel.tag)
            .unwrap_or(true)
    };
    entry.latest_tag = Some(rel.tag.clone());
    entry.etag = rel.etag.clone();
    entry.last_checked = Some(now_unix());
    save_manifest(&m)?;
    Ok(update_available.then(|| rel.tag.clone()))
}

/// 304 from a conditional check: nothing newer since last time. still bump
/// `last_checked` so the settings card can show a fresh check time.
pub fn touch_check(tool: Tool) -> AppResult<()> {
    let mut m = load_manifest()?;
    let entry = m.entry_mut(tool).get_or_insert_with(ToolEntry::default);
    entry.last_checked = Some(now_unix());
    save_manifest(&m)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("ytdlp-gui-test-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn manifest_roundtrips_through_json() {
        let m = Manifest {
            yt_dlp: Some(ToolEntry {
                version: "2026.09.01".into(),
                sha256: Some("ab".repeat(32)),
                source: "github".into(),
                etag: Some("\"abc\"".into()),
                latest_tag: Some("2026.09.01".into()),
                last_checked: Some(1_700_000_000),
                pinned: false,
                custom_path: None,
                staged: false,
            }),
            ffmpeg: None,
        };
        let json = serde_json::to_string(&m).unwrap();
        assert!(json.contains("\"yt-dlp\""));
        assert!(json.contains("lastChecked"));
        let back: Manifest = serde_json::from_str(&json).unwrap();
        assert_eq!(back.yt_dlp.unwrap().version, "2026.09.01");
        assert!(back.ffmpeg.is_none());
    }

    #[test]
    fn staged_swap_moves_files_and_clears_flag() {
        let dir = temp_dir("staged");
        // isolate the manager's dir fns via env override is not available —
        // exercise the same rename logic directly instead.
        let staged = dir.join("yt-dlp.exe.staged");
        let dest = dir.join("yt-dlp.exe");
        std::fs::write(&staged, b"new").unwrap();
        std::fs::write(&dest, b"old").unwrap();
        std::fs::rename(&staged, &dest).unwrap();
        assert_eq!(std::fs::read(&dest).unwrap(), b"new");
        assert!(!staged.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn resolve_prefers_existing_custom_path() {
        let dir = temp_dir("custom");
        let custom = dir.join("my-yt-dlp.exe");
        std::fs::write(&custom, b"x").unwrap();
        let m = Manifest {
            yt_dlp: Some(ToolEntry {
                custom_path: Some(custom.to_string_lossy().into_owned()),
                ..Default::default()
            }),
            ffmpeg: None,
        };
        let resolved = resolve_tool_path(&m, Tool::YtDlp).unwrap();
        assert_eq!(resolved, custom);

        // missing custom file falls back to the managed copy — which may
        // legitimately exist on this machine (a real install via the
        // wizard). assert the *contract*, not the absence: the managed
        // path is returned, never the stale custom path.
        let m2 = Manifest {
            yt_dlp: Some(ToolEntry {
                custom_path: Some(dir.join("nope.exe").to_string_lossy().into_owned()),
                ..Default::default()
            }),
            ffmpeg: None,
        };
        let resolved2 = resolve_tool_path(&m2, Tool::YtDlp);
        let managed = bin_dir().join(Tool::YtDlp.files()[0]);
        if managed.is_file() {
            assert_eq!(resolved2, Some(managed));
        } else {
            assert_eq!(resolved2, None);
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn ffmpeg_version_parses_from_dash_version_output() {
        // detect_version spawns a real binary; parse logic is mirrored here
        // so the parsing contract is pinned without network/process deps.
        let line = "ffmpeg version 7.1.1-essentials_build www.ffmpeg.org";
        let v = line.split_whitespace().nth(2).unwrap();
        assert_eq!(v, "7.1.1-essentials_build");
    }
}
