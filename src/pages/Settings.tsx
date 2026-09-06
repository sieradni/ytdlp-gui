import { SavedFlash } from "../components/SavedFlash";
import ToolRow from "../components/ToolRow";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { appResetData, effectiveDestination, type ResetReport } from "../lib/ipc";
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
          <OutputFolderRow />
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
          <div className="row flex items-center gap-2 min-w-0">
            <ArchiveReveal />
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-h">
          <h2>app</h2>
        </div>
        {/* d77: clean label/value rows — the old fgrid let a free-standing
            hint div land in the label column and misalign the card. */}
        <div className="card-b">
          <div className="app-row">
            <span className="app-key">version</span>
            <span className="row flex items-center gap-2">
              <VersionRow />
              <span className="hint">ytdlp-gui · windows x64</span>
            </span>
          </div>
          <div className="app-row">
            <span className="app-key">license</span>
            <span className="hint">apache license 2.0</span>
          </div>
          <div className="app-row" style={{ alignItems: "flex-start" }}>
            <span className="app-key" style={{ paddingTop: 2 }}>
              reset
            </span>
            <ResetRow />
          </div>
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
        settings{report.archiveRemoved ? ", archive" : ""} removed. binaries kept.
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
        ⚠ permanently deletes the queue, history, settings and the download
        archive (app-data\downloaded.txt — re-downloading already-fetched
        items will re-fetch them). managed yt-dlp/ffmpeg in bin/ are kept.
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

/** d81: the output-folder field is never empty — it shows the path downloads
 * actually use (the setting, or the effective windows-downloads fallback when
 * unset). editing sets the setting; clearing falls back to the real default
 * (shown as the value again), and the picker is the full explorer dialog. */
function OutputFolderRow() {
  const { settings, update } = useSettings();
  const [fallback, setFallback] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);

  useEffect(() => {
    let alive = true;
    void effectiveDestination().then((p) => {
      if (alive) setFallback(p);
    });
    return () => {
      alive = false;
    };
  }, []);

  const value = settings.destination?.trim() ? settings.destination : (fallback ?? "");
  const isFallback = !settings.destination?.trim();

  const pick = async () => {
    setPicking(true);
    try {
      const picked = await openDialog({ directory: true, multiple: false, defaultPath: value || undefined });
      if (typeof picked === "string") await update({ destination: picked });
    } finally {
      setPicking(false);
    }
  };

  return (
    <div className="row flex items-center gap-2 min-w-0">
      <input
        type="text"
        className="grow"
        value={value}
        style={isFallback ? { color: "var(--muted)" } : undefined}
        title={isFallback ? "default — no custom output folder is set; edit to override" : undefined}
        onChange={(e) => void update({ destination: e.target.value })}
      />
      <button className="btn sm" disabled={picking} onClick={() => void pick()}>
        browse…
      </button>
    </div>
  );
}

/** d81: the archive lives at a fixed app-data path; settings just offers
 * the reveal affordance (import/export live on the history page). */
function ArchiveReveal() {
  const [path, setPath] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    void import("../lib/ipc").then(({ appPaths }) =>
      appPaths().then((p) => {
        if (alive) setPath(p.archivePath);
      }),
    );
    return () => {
      alive = false;
    };
  }, []);
  return (
    <>
      <button
        className="btn sm ghost"
        onClick={() => path && void revealItemInDir(path)}
        disabled={!path}
      >
        reveal archive
      </button>
      {path && <span className="hint" style={{ overflowWrap: "anywhere" }}>{path}</span>}
    </>
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
      hint = "checks on launch";
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
