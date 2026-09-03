import { SavedFlash } from "../components/SavedFlash";
import ToolRow from "../components/ToolRow";
import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { useAppUpdate } from "../lib/appUpdate";
import { useBinaries } from "../stores/binaries";
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
          <div className="row flex items-center gap-2">
            <span className="numm">v2.0.0-alpha.1</span>
            <span className="hint">ytdlp-gui · windows x64</span>
          </div>
          <label>license</label>
          <div className="row flex items-center">
            <span className="hint">unlicense — do whatever</span>
          </div>
        </div>
      </div>
    </div>
  );
}

/** §6 tools card, app-updates row: version · check now · one-click install. */
function AppUpdateRow() {
  const { phase, error, update, received, total, startInstall } = useAppUpdate();
  const [appVersion, setAppVersion] = useState<string | null>(null);
  useEffect(() => {
    void getVersion().then(setAppVersion).catch(() => setAppVersion(null));
  }, []);

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
    <div className="row flex items-center gap-2">
      <span className="numm">{appVersion ?? "v?"}</span>
      <button
        className="btn sm"
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
      <span className={phase === "error" ? "warn" : "hint"}>{hint}</span>
    </div>
  );
}
