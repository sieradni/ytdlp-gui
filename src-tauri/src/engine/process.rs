//! tokio process wrapper (§5): one command per job, argv only (never a
//! shell), stdout/stderr line-streamed to the parser.

use std::process::Stdio;

use tokio::io::AsyncReadExt;
use tokio::process::Command;

use crate::error::AppResult;

pub struct Child {
    pub inner: tokio::process::Child,
}

impl Child {
    /// kill the child (stop ■ semantics: keep .part files — killing the
    /// process is enough; yt-dlp leaves partials on disk).
    ///
    /// windows: `kill` alone terminates the process, but any piped stdout/
    /// stderr reader task keeps waiting on a pipe whose write ends were held
    /// by (now-dead) yt-dlp and its child ffmpeg — which are NOT in the job
    /// object, so the pipe never closes and `rx.recv()` never returns. kill
    /// with a `taskkill /T` fallback so the whole tree (yt-dlp + spawned
    /// ffmpeg) dies and the streams close. without this, pressing ■ leaves
    /// the job stuck in `downloading` forever.
    pub async fn kill(&mut self) {
        #[cfg(windows)]
        {
            if let Some(pid) = self.inner.id() {
                let _ = tokio::process::Command::new("taskkill")
                    .args(["/PID", &pid.to_string(), "/T", "/F"])
                    .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
                    .output()
                    .await;
            }
        }
        let _ = self.inner.kill().await;
    }
}

/// spawn `argv` with piped stdout/stderr. argv[0] is the program.
pub fn spawn(argv: &[String]) -> std::io::Result<Child> {
    let mut cmd = Command::new(&argv[0]);
    cmd.args(&argv[1..])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    no_window(&mut cmd);
    Ok(Child {
        inner: cmd.spawn()?,
    })
}

/// d83: one split-at-newline UTF-8 loop with a lossy flush of the trailing
/// partial. `AsyncBufReadExt::lines()` DROPS a line containing invalid utf-8
/// (silently: the iteration just ends, mid-stream) — live-verified 2026-09:
/// yt-dlp on windows writes bot-gate stderr in the console codepage, so the
/// “you’re not a bot” ERROR (cp1252 0x92 apostrophe) made the whole identity
/// probe look like “no output from yt-dlp”. lossy-decoding that byte to U+FFFD
/// keeps the line — and every `ERROR:`-prefixed diagnosis — reachable.
async fn pump<R: tokio::io::AsyncRead + Unpin>(
    mut rdr: R,
    tx: tokio::sync::mpsc::UnboundedSender<(bool, String)>,
    stdout: bool,
) {
    let mut buf: Vec<u8> = Vec::with_capacity(8 * 1024);
    let mut chunk = [0u8; 4096];
    loop {
        match rdr.read(&mut chunk).await {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                buf.extend_from_slice(&chunk[..n]);
                while let Some(pos) = buf.iter().position(|&b| b == b'\n') {
                    let mut line: Vec<u8> = buf.drain(..pos + 1).collect();
                    if line.ends_with(b"\n") {
                        line.pop();
                    }
                    if line.ends_with(b"\r") {
                        line.pop();
                    }
                    if tx
                        .send((stdout, String::from_utf8_lossy(&line).into_owned()))
                        .is_err()
                    {
                        return;
                    }
                }
            }
        }
    }
    if !buf.is_empty() {
        // final line without a newline (yt-dlp's progress carriage-return
        // frames usually end in \r, but a truncated last line is possible)
        let line = buf.trim_ascii_end();
        if !line.is_empty() {
            let _ = tx.send((stdout, String::from_utf8_lossy(line).into_owned()));
        }
    }
}

/// stream stdout and stderr lines over one channel; the bool marks stdout.
/// yt-dlp writes errors to stderr, so both feed the expando row.
/// d83: invalid-utf-8 lines are lossy-decoded (U+FFFD), never dropped —
/// see `pump`.
pub fn stream_lines(
    child: &mut Child,
) -> AppResult<tokio::sync::mpsc::UnboundedReceiver<(bool, String)>> {
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel();

    let stdout = child
        .inner
        .stdout
        .take()
        .ok_or_else(|| crate::error::other("no stdout"))?;
    let stderr = child
        .inner
        .stderr
        .take()
        .ok_or_else(|| crate::error::other("no stderr"))?;

    tokio::spawn(pump(stdout, tx.clone(), true));
    tokio::spawn(pump(stderr, tx, false));

    Ok(rx)
}

#[cfg(windows)]
fn no_window(cmd: &mut Command) {
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
}

#[cfg(not(windows))]
fn no_window(_cmd: &mut Command) {}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn spawns_and_streams_lines() {
        // windows-targeted app but keep the test runnable anywhere via cmd
        let argv = if cfg!(windows) {
            vec!["cmd".to_owned(), "/C".to_owned(), "echo hello".to_owned()]
        } else {
            vec!["echo".to_owned(), "hello".to_owned()]
        };
        let mut child = spawn(&argv).unwrap();
        let mut rx = stream_lines(&mut child).unwrap();
        let mut got = None;
        while got.is_none() {
            match rx.recv().await {
                Some((true, line)) => got = Some(line),
                Some((false, _)) => continue,
                None => break,
            }
        }
        assert_eq!(got.as_deref(), Some("hello"));
        let _ = child.kill().await;
    }

    /// d83: yt-dlp on windows writes stderr in the console codepage — the
    /// live-captured bot-gate error carries cp1252 0x92 (“you’re”).
    /// AsyncBufReadExt::lines() silently DROPS such a line, which made the
    /// identity probe report “no output from yt-dlp”. the pump must lossy-
    /// decode it (U+FFFD) and keep delivering the line.
    #[cfg(windows)]
    #[tokio::test]
    async fn invalid_utf8_line_is_lossy_decoded_not_dropped() {
        // write the byte directly so no shell quoting can re-encode it:
        // "ERROR: [youtube] x: Sign in to confirm you<0x92>re not a bot"
        let p = std::env::temp_dir().join(format!("ytdlp-d83-{}.bin", std::process::id()));
        std::fs::write(
            &p,
            b"ERROR: [youtube] x: Sign in to confirm you\x92re not a bot\n",
        )
        .unwrap();
        let argv = vec![
            "powershell".to_owned(),
            "-NoProfile".to_owned(),
            "-Command".to_owned(),
            format!(
                "$s=[IO.File]::OpenRead('{}'); $e=[Console]::OpenStandardError(); $s.CopyTo($e); $s.Close()",
                p.to_string_lossy().replace('\\', "/")
            ),
        ];
        let mut child = spawn(&argv).unwrap();
        let mut rx = stream_lines(&mut child).unwrap();
        let mut got: Option<String> = None;
        while got.is_none() {
            match rx.recv().await {
                Some((false, line)) => got = Some(line),
                Some((true, _)) => continue,
                None => break,
            }
        }
        let _ = child.kill().await;
        let _ = std::fs::remove_file(&p);
        let line = got.expect("the ERROR line must survive invalid utf-8");
        assert!(line.starts_with("ERROR:"), "got: {line}");
        assert!(line.contains("Sign in to confirm you"), "got: {line}");
        assert!(
            line.contains('\u{FFFD}'),
            "the cp1252 byte must appear as U+FFFD"
        );
        // everything after the bad byte survives too (the old lines() dropped
        // the WHOLE line, losing the actionable tail)
        assert!(line.ends_with("re not a bot"), "got: {line}");
    }

    #[tokio::test]
    async fn exit_status_visible_after_stream() {
        let argv = if cfg!(windows) {
            vec!["cmd".to_owned(), "/C".to_owned(), "exit 0".to_owned()]
        } else {
            vec!["true".to_owned()]
        };
        let mut child = spawn(&argv).unwrap();
        let mut rx = stream_lines(&mut child).unwrap();
        while rx.recv().await.is_some() {}
        let status = child.inner.wait().await.unwrap();
        assert!(status.success());
    }
}
