//! `metadataResolve(url)` (§7): `--print id` probe (D44) with per-url
//! memoization (D37) so duplicate adds can't resolve twice.

use std::collections::HashMap;
use std::sync::Mutex;

use serde::Serialize;

use crate::error::AppResult;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedIdentity {
    pub extractor: String,
    pub id: String,
    pub title: Option<String>,
}

/// process-wide memo: url → resolved identity (or sticky error).
#[derive(Default)]
pub struct Memo(pub Mutex<HashMap<String, Result<ResolvedIdentity, String>>>);

#[tauri::command]
pub async fn metadata_resolve(
    memo: tauri::State<'_, Memo>,
    url: String,
) -> AppResult<ResolvedIdentity> {
    // normalize like intake does so youtu.be/x and youtube.com/watch?v=x
    // share a memo slot only if identical strings — identity dedupe happens
    // on the resolved pair anyway (D18), the memo is just a network saver.
    let key = crate::engine::queue::normalize_url_public(&url);

    if let Some(cached) = memo.0.lock().expect("memo lock").get(&key).cloned() {
        return cached.map_err(crate::error::other);
    }

    let result = probe(&key).await;
    let out = result.clone();
    memo.0.lock().expect("memo lock").insert(key, out);
    result.map_err(crate::error::other)
}

async fn probe(url: &str) -> Result<ResolvedIdentity, String> {
    let mut argv: Vec<String> = vec![
        "yt-dlp".into(),
        "--no-warnings".into(),
        "--print".into(),
        "%(extractor_key)s %(id)s".into(),
        "--print".into(),
        "%(title)s".into(),
        "--skip-download".into(),
        "--no-playlist".into(),
        url.to_owned(),
    ];
    // prefer the managed copy when present
    if let Ok(m) = crate::binaries::manager::load_manifest() {
        if let Some(p) =
            crate::binaries::manager::resolve_tool_path(&m, crate::binaries::sources::Tool::YtDlp)
        {
            argv[0] = p.to_string_lossy().into_owned();
        }
    }

    let mut child = crate::engine::process::spawn(&argv).map_err(|e| e.to_string())?;
    let mut rx = crate::engine::process::stream_lines(&mut child).map_err(|e| e.to_string())?;

    let mut extractor_id: Option<(String, String)> = None;
    let mut title: Option<String> = None;

    while title.is_none() {
        match rx.recv().await {
            Some((true, line)) => {
                let t = line.trim().to_owned();
                if t.is_empty() {
                    continue;
                }
                if extractor_id.is_none() {
                    if let Some((ex, vid)) = t.split_once(' ') {
                        if !ex.is_empty() && !vid.is_empty() {
                            extractor_id = Some((ex.to_owned(), vid.to_owned()));
                        }
                    }
                } else {
                    title = Some(t);
                }
            }
            Some((false, line)) => {
                let t = line.trim();
                if t.starts_with("ERROR:") {
                    let _ = child.kill().await;
                    return Err(t.to_owned());
                }
            }
            None => break,
        }
    }
    let _ = child.kill().await;
    let _ = child.inner.wait().await;

    match extractor_id {
        Some((extractor, id)) => Ok(ResolvedIdentity {
            extractor,
            id,
            title,
        }),
        None => Err("could not resolve identity (no output from yt-dlp)".into()),
    }
}
