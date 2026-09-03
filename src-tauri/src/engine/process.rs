//! tokio process wrapper (§5): one command per job, argv only (never a
//! shell), stdout/stderr line-streamed to the parser.

use std::process::Stdio;

use tokio::io::{AsyncBufReadExt, BufReader};
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

/// stream stdout and stderr lines over one channel; the bool marks stdout.
/// yt-dlp writes errors to stderr, so both feed the expando row.
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

    let tx_out = tx.clone();
    tokio::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if tx_out.send((true, line)).is_err() {
                break;
            }
        }
    });

    tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if tx.send((false, line)).is_err() {
                break;
            }
        }
    });

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
