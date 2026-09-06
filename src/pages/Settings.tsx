import { SavedFlash } from "../components/SavedFlash";
import ToolRow from "../components/ToolRow";
import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { appResetData, type ResetReport } from "../lib/ipc";
import { useAppUpdate } from "../lib/appUpdate";
import { useBinaries } from "../stores/binaries";
import { useQueue } from "../stores/queue";
import { useSettings } from "../stores/settings";

export default function SettingsPage() {
  const { manifest } = useBinaries();
  const { settings, update } = useSettings();

  return (
    <div className="mx-auto max-w-[860px] px-5 pt-4 pb-9">
      <div className="card">
        <div className="card-h">
          <h2>tools</h2>
          <SavedFlash />
        </div>
        <div className="card-b fgrid">
          {manifest ? (
            <>
              <ToolRow status={manifest.ytDlp} />
              <ToolRow status={manifest.ffmpeg} />
            </>
          ) : (
            <>
              <label>yt-dlp</label>
              <div className="hint">loading…</div>
              <label>ffmpeg</label>
              <div className="hint">loading…</div>
            </>
          )}
          <label></label>
          <div className="hint">
            update = download latest build (~90 mb), verify sha-256, swap atomically. never automatic.
          </div>
          <label>app updates</label>
          <AppUpdateRow />
          <label></label>
          <div className="row flex items-center gap-2">
            <span className="hint">first-run wizard</span>
            <button
              className="btn sm"
              onClick={() => useBinaries.getState().setWizardOpen(true)}
            >
              replay…
            </button>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-h">
          <h2>downloads</h2>
          <SavedFlash />
        </div>
        <div className="card-b fgrid">
          <label>output folder</label>
          <div className="row flex items-center gap-2">
            <input
              type="text"
              className="grow"
              value={settings.destination ?? ""}
              placeholder="e.g. C:\Users\you\Downloads"
              onChange={(e) => void update({ destination: e.target.value })}
            />
          </div>
          <label>concurrent</label>
          <div className="row flex items-center gap-2">
            <select
              style={{ width: 70 }}
              value={settings.concurrency ?? 2}
              onChange={(e) => void update({ concurrency: Number(e.target.value) })}
            >
              {[1, 2, 3, 4].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
            <span className="hint">2 recommended</span>
          </div>
          <label>archive file</label>
          <div className="row flex items-center gap-2">
            <input
              type="text"
              className="grow"
              value={settings.archivePath ?? ""}
              placeholder="%APPDATA%\ytdlp-gui\downloaded.txt"
              onChange={(e) => void update({ archivePath: e.target.value })}
            />
          </div>
          <label></label>
          <div className="warn">⚠ editing downloaded.txt changes what counts as already downloaded</div>
        </div>
      </div>

      <div className="card">
        <div className="card-h">
          <h2>app</h2>
        </div>
        <div className="card-b fgrid">
          <label>version</label>
          <VersionRow />
          <div className="row flex items-center gap-2">
            <span className="hint">ytdlp-gui · windows x64</span>
          </div>
          <label>license</label>
          <div className="row flex items-center">
            <span className="hint">unlicense — do whatever</span>
          </div>
          <label>reset</label>
          <ResetRow />
        </div>
      </div>
    </div>
  );
}

/** d69: destructive reset, double-confirmed in place. removes queue,
 * history, settings and the default-path downloaded.txt; managed binaries
 * in bin/ always survive (re-downloadable tooling, ~150 mb) and a custom
 * archive path is never touched (it may be the user's cross-tool archive).
 * the archive is called out by name in the confirm — D32 spirit: nothing
 * destructive happens silently. */
function ResetRow() {
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<ResetReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const rep = await appResetData();
      setReport(rep);
      setArmed(false);
      // the stores hold pre-reset snapshots — reload settings + queue so the
      // ui reflects the wiped state without a restart
      await useSettings.getState().load();
      await useQueue.getState().load();
    } catch (e) {
      setError(String(e).replace(/^.*"message":"([^"]+)".*$/s, "$1"));
    } finally {
      setBusy(false);
    }
  };

  if (report) {
    return (
      <div className="hint">
        reset done — {report.jobsCleared} queued, {report.historyCleared} history,
        settings{report.archiveRemoved ? ", downloaded.txt" : ""}
        {report.archiveWasCustom ? " (custom archive kept)" : ""} removed. binaries kept.
      </div>
    );
  }

  if (!armed) {
    return (
      <div className="row flex items-center gap-2">
        <button className="btn sm" onClick={() => setArmed(true)}>
          reset app data…
        </button>
        <span className="hint">queue, history, settings, archive — bin/ stays</span>
        {error && <span className="warn">{error}</span>}
      </div>
    );
  }

  return (
    <div className="row flex flex-col gap-1">
      <div className="warn">
        ⚠ permanently deletes the queue, history, settings and downloaded.txt
        (the download archive — re-downloading already-fetched items will
        re-fetch them). managed yt-dlp/ffmpeg in bin/ are kept. a custom
        archive path is never touched.
      </div>
      <div className="row flex items-center gap-2">
        <button className="btn sm" disabled={busy} onClick={() => setArmed(false)}>
          cancel
        </button>
        <button className="btn sm danger" disabled={busy} onClick={() => void run()}>
          {busy ? "resetting…" : "delete everything — final confirm"}
        </button>
      </div>
    </div>
  );
}

/** Real app version from the Tauri runtime — never a hardcoded literal,
 * so it stays truthful after an in-app update. */
function useAppVersion(): string | null {
  const [version, setVersion] = useState<string | null>(null);
  useEffect(() => {
    void getVersion().then(setVersion).catch(() => setVersion(null));
  }, []);
  return version;
}

function VersionRow() {
  const version = useAppVersion();
  return (
    <div className="row flex items-center gap-2">
      <span className="numm">{version ? `v${version}` : "v?"}</span>
    </div>
  );
}

/** §6 tools card, app-updates row: version · check now · one-click install. */
function AppUpdateRow() {
  const { phase, error, update, received, total, startInstall } = useAppUpdate();
  const appVersion = useAppVersion();

  let hint: string;
  switch (phase) {
    case "checking":
      hint = "checking…";
      break;
    case "up-to-date":
      hint = "up to date ✓";
      break;
    case "available":
      hint = `update available → ${update?.version ?? "?"}`;
      break;
    case "downloading": {
      const pct =
        total != null && total > 0 ? `${Math.min(100, (received / total) * 100).toFixed(0)}%` : "…";
      hint = `downloading ${pct}`;
      break;
    }
    case "installing":
      hint = "installing — restarting…";
      break;
    case "error":
      hint = `update check failed: ${error ?? "?"}`;
      break;
    default:
      hint = "checks on launch and every 6 h";
  }

  const busy = phase === "checking" || phase === "downloading" || phase === "installing";

  return (
    // C6: same stable pattern as ToolRow — version cell fixed-width,
    // actions right, status message never reflows the version.
    <div className="toolrow">
      <div className="toolrow-main">
        <span className="numm tool-version">{appVersion ?? "v?"}</span>
        <span className="grow" />
        <button
          className={"btn sm" + (phase === "available" ? " primary" : "")}
          disabled={busy}
          onClick={() => {
            if (phase === "available") {
              void startInstall();
            } else {
              void useAppUpdate.getState().checkNow(true);
            }
          }}
        >
          {phase === "available" ? "update & restart" : "check now"}
        </button>
      </div>
      <div className={phase === "error" ? "toolrow-msg warn" : "toolrow-msg hint"}>{hint}</div>
    </div>
  );
}
