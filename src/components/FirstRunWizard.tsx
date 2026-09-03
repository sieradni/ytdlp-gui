import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import {
  binariesInstall,
  binariesSetCustomPath,
  migrationStatus,
  type MigrationReport,
  type Tool,
} from "../lib/ipc";
import { useBinaries } from "../stores/binaries";
import { useSettings } from "../stores/settings";

/**
 * first-run wizard (§4): overlay — not a pop-up window (D11).
 * 1. detect existing yt-dlp/ffmpeg on PATH → "use my own copies"
 * 2. one-click download with live progress
 * replayable from settings → tools (replay link).
 */
export default function FirstRunWizard() {
  const { wizardOpen, setWizardOpen, setBusy, refresh } = useBinaries();
  const [phase, setPhase] = useState<"detect" | "downloading" | "done" | "error">("detect");
  const [error, setError] = useState<string | null>(null);
  const [doneMsg, setDoneMsg] = useState("✓ installed and verified");
  const [v1, setV1] = useState<MigrationReport | null>(null);
  const progress = useBinaries((s) => s.progress);

  // §11: the migration may have found v1 binaries — offer them here as the
  // custom-binary alternative to downloading (D40), never auto-applied.
  useEffect(() => {
    void migrationStatus().then((r) => {
      if (r && (r.v1YtDlpPath || r.v1FfmpegPath)) setV1(r);
    });
  }, []);

  if (!wizardOpen) return null;

  const startDownload = async () => {
    setPhase("downloading");
    setError(null);
    useBinaries.getState().setError(null);
    setBusy("both");
    try {
      await binariesInstall();
      await refresh();
      setDoneMsg("✓ installed and verified");
      setPhase("done");
      // auto-dismiss shortly after success
      setTimeout(() => {
        useBinaries.getState().setWizardOpen(false);
        void markWizardDismissed();
      }, 1200);
    } catch (e) {
      setPhase("error");
      setError(String(e));
    } finally {
      setBusy(null);
    }
  };

  const useV1Copies = async () => {
    if (!v1) return;
    if (v1.v1YtDlpPath) await binariesSetCustomPath("yt-dlp", v1.v1YtDlpPath);
    if (v1.v1FfmpegPath) await binariesSetCustomPath("ffmpeg", v1.v1FfmpegPath);
    await refresh();
    setDoneMsg("✓ using your v1 copies — managed updates off (D40)");
    setPhase("done");
  };

  const useOwn = async (tool: Tool) => {
    // escape hatch inline: pick a PATH copy by file dialog (D40)
    const picked = await open({
      multiple: false,
      directory: false,
      filters: [{ name: "executables", extensions: ["exe"] }],
    });
    if (typeof picked !== "string") return;
    await binariesSetCustomPath(tool, picked);
    await refresh();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: "rgba(0,0,0,.6)" }}>
      <div
        className="w-[440px] max-w-[92vw]"
        style={{
          background: "var(--bg-2)",
          border: "1px solid var(--amber-border)",
          borderRadius: 6,
          boxShadow: "0 14px 40px rgba(0,0,0,.55)",
        }}
      >
        <div className="card-h">
          <h2>first-run setup</h2>
          <span className="hint">yt-dlp + ffmpeg, verified, ~95 mb</span>
        </div>
        <div className="card-b">
          {phase === "detect" && (
            <>
              <p className="hint" style={{ marginBottom: 10 }}>
                the app manages its own copies of yt-dlp and ffmpeg in app-data — nothing
                installed system-wide, updates are one click and never automatic (ffmpeg).
              </p>
              <div className="row" style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <button className="btn primary" onClick={startDownload}>
                  download yt-dlp &amp; ffmpeg
                </button>
                <button className="btn" onClick={() => useOwn("yt-dlp")}>
                  use my yt-dlp…
                </button>
                <button className="btn" onClick={() => useOwn("ffmpeg")}>
                  use my ffmpeg…
                </button>
                <span className="grow" />
                <button
                  className="btn ghost"
                  onClick={() => {
                    setWizardOpen(false);
                    void markWizardDismissed();
                  }}
                >
                  later
                </button>
              {v1 && (v1.v1YtDlpPath || v1.v1FfmpegPath) && (
                <div
                  className="row"
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    flexWrap: "wrap",
                    marginTop: 10,
                    paddingTop: 8,
                    borderTop: "1px solid var(--border)",
                  }}
                >
                  <span className="hint" style={{ overflowWrap: "anywhere" }}>
                    found your v1 setup{v1.droppedKeys.length === 0 ? "" : " (some options unmapped)"}:
                    {v1.v1YtDlpPath ? " yt-dlp ✓" : ""}
                    {v1.v1FfmpegPath ? " ffmpeg ✓" : ""}
                  </span>
                  <button className="btn sm" onClick={() => void useV1Copies()}>
                    use v1 copies
                  </button>
                </div>
              )}
              </div>
            </>
          )}

          {phase === "downloading" && (
            <div style={{ display: "grid", gap: 10 }}>
              {(["yt-dlp", "ffmpeg"] as const).map((tool) => {
                const p = progress[tool];
                const pct =
                  p && p.total ? Math.min(100, Math.round((p.received / p.total) * 100)) : null;
                return (
                  <div key={tool}>
                    <div className="row" style={{ display: "flex", justifyContent: "space-between" }}>
                      <span style={{ fontSize: 12 }}>{tool}</span>
                      <span className="numm">
                        {pct !== null
                          ? `${pct}%`
                          : p
                            ? `${(p.received / 1048576).toFixed(1)} mb`
                            : "starting…"}
                      </span>
                    </div>
                    <div className="progress" style={{ marginTop: 4 }}>
                      <div style={{ width: `${pct ?? 4}%` }} />
                    </div>
                  </div>
                );
              })}
              <p className="hint">download → sha-256 verify → atomic swap into app-data\bin</p>
            </div>
          )}

          {phase === "done" && (
            <p style={{ color: "var(--green)", fontSize: 12 }}>{doneMsg}</p>
          )}

          {phase === "error" && (
            <>
              <p className="warn">download failed</p>
              <p className="hint" style={{ overflowWrap: "anywhere" }}>
                {error}
              </p>
              <div className="row" style={{ display: "flex", gap: 8, marginTop: 10 }}>
                <button className="btn primary" onClick={startDownload}>
                  retry
                </button>
                <button className="btn ghost" onClick={() => setPhase("detect")}>
                  back
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/** mark the wizard dismissed so it doesn't auto-open next launch */
async function markWizardDismissed() {
  const s = useSettings.getState();
  if (!s.settings.wizardDismissed) {
    await s.update({ wizardDismissed: true });
  }
}
