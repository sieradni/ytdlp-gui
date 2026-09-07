import { useCallback, useEffect, useState } from "react";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { choiceDialog, confirmDialog } from "../components/ConfirmDialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  appPaths,
  archiveExport,
  archiveRemove,
  archiveReconcile,
  e2eArtifactsRemove,
  e2eArtifactsReport,
  fileExists,
  historyImportArchive,
  historyList,
  historyRelink,
  jobAdd,
  type ArtifactReport,
  type HistoryRow,
} from "../lib/ipc";
import { currentOptions } from "../components/Composer";

function fmtSize(bytes: number | null): string {
  if (bytes == null) return "—";
  const mb = bytes / 1048576;
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} gb` : `${Math.round(mb)} mb`;
}

function fmtDur(sec: number | null): string {
  if (sec == null) return "—";
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
    : `${m}:${String(s).padStart(2, "0")}`;
}

function fmtDate(unix: number): string {
  const d = new Date(unix * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const rowKey = (row: HistoryRow) => `${row.extractor} ${row.vid}`;

export default function HistoryPage() {
  const [rows, setRows] = useState<HistoryRow[]>([]);
  const [query, setQuery] = useState("");
  const [importMsg, setImportMsg] = useState<string | null>(null);
  /** rows whose file vanished (reveal failed) — offer locate… (§6) */
  const [moved, setMoved] = useState<Set<string>>(new Set());

  const load = useCallback(async (filter?: string) => {
    setRows(await historyList(filter));
  }, []);

  // d69 one-time cleanup: alpha.2 profiles may hold e2e rows (the campaign
  // shared the installed app's data dir). probe once per mount; the banner
  // only exists when contamination is found, and removal is an explicit click.
  const [artifacts, setArtifacts] = useState<ArtifactReport | null>(null);
  useEffect(() => {
    void e2eArtifactsReport()
      .then((rep) => {
        if (rep.jobs.length + rep.history.length > 0) setArtifacts(rep);
      })
      .catch(() => {}); // probe failures never block the page
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // F5 refreshes history (§6 keyboard/ux polish)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "F5") {
        e.preventDefault();
        void load(query || undefined);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [load, query]);

  const showInFolder = async (row: HistoryRow) => {
    if (!row.finalPath) return;
    try {
      await revealItemInDir(row.finalPath);
    } catch {
      // the app never follows files silently — flip to "moved?" + locate…
      setMoved((prev) => new Set(prev).add(rowKey(row)));
    }
  };

  const locate = async (row: HistoryRow) => {
    const picked = await openDialog({ multiple: false });
    if (typeof picked === "string") {
      await historyRelink(rowKey(row), picked);
      setMoved((prev) => {
        const next = new Set(prev);
        next.delete(rowKey(row));
        return next;
      });
      await load(query || undefined);
    }
  };

  const reDownload = async (row: HistoryRow) => {
    if (!row.url) return;
    // D19: re-download = new job with the composer's CURRENT options —
    // "what queue would do if I pasted this url now". currentOptions is a
    // module-level mirror that survives tab switches (pages unmount on
    // switch, so a DOM probe would wrongly report "never opened home"); it
    // holds defaults until the composer has rendered once. destination is
    // resolved by job_add from the stored setting (or the os downloads dir).
    //
    // D59: with the target file present, yt-dlp skips the download AND the
    // postprocessors, then the engine's always-on --embed-metadata still runs
    // its pass over the cover-tagged file — which errors for opus (e2e
    // live-reproduced: "Postprocessing: Conversion failed!", 0-byte .temp).
    // so a re-download onto an existing file is gated: probe the row's last
    // known file server-side, confirm before overwriting (job then carries
    // --force-overwrites and redownloads cleanly), or cancel with a hint.
    // a different composer format resolves to a different target name, which
    // does not collide — the probe is exact-path, so no over-asking.
    let overwrite = false;
    if (row.finalPath && (await fileExists(row.finalPath))) {
      const name = row.finalPath.split(/[\\/]/).pop() ?? row.finalPath;
      // m7-b: in-app confirm (chime + modal) replaces the windows task dialog
      const ok = await confirmDialog({
        title: "file already exists",
        body: `“${name}” already exists on disk.\n\nRe-download replaces it with a fresh download (metadata re-embedded) using the current composer settings.`,
        confirmLabel: "overwrite",
        cancelLabel: "cancel",
      });
      if (!ok) {
        setImportMsg("re-download cancelled — file already exists (nothing queued)");
        return;
      }
      overwrite = true;
    }
    // d63: ↻ means **force re-download** — it bypasses the engine's archive
    // pre-check for this job only (the engine's own archive-append stays
    // idempotent, so the archive never drifts). without this, a granted
    // overwrite dialog was followed by the engine's "already in downloaded
    // archive" skip — the dialog promised what the engine then refused.
    // the composer default (respect the archive) is unchanged.
    await jobAdd([row.url], {
      ...currentOptions,
      overwrite,
      skipDownloaded: false,
    });
    await load(query || undefined);
  };

  return (
    <div className="page mx-auto max-w-[860px] px-5 pt-4 pb-9">
      {artifacts && (
        <div className="card" style={{ borderColor: "var(--amber, #b8860b)" }}>
          <div className="card-h">
            <h2>test data found</h2>
          </div>
          <div className="card-b">
            <div className="hint">
              this profile contains {artifacts.jobs.length} queued-download and
              {" "}
              {artifacts.history.length} history entries pointing into the e2e
              test sandbox (left behind by pre-alpha.3 test runs that shared the
              installed app's data folder). they are not real downloads.
            </div>
            <div className="row flex items-center gap-2" style={{ marginTop: 8 }}>
              <button
                className="btn sm danger"
                onClick={async () => {
                  await e2eArtifactsRemove();
                  setArtifacts(null);
                  await load();
                }}
              >
                remove test data
              </button>
              <span className="hint">your real downloads are never touched</span>
            </div>
          </div>
        </div>
      )}
      <div className="card">
        <div className="card-h">
          <h2>history</h2>
          <div className="flex items-center gap-2">
            <input
              type="text"
              placeholder="search title, channel, url…"
              style={{ width: 210 }}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void load(query || undefined)}
            />
            <button className="btn sm" onClick={() => void load(query || undefined)}>
              search
            </button>
          </div>
        </div>
        {/* d76: bounded like the queue table — the page (and its footer
            buttons) stay reachable on a 2k-entry history; the header sticks. */}
        <div className="hist-scroll">
          <table className="hist-table">
            <colgroup>
              <col />
              <col style={{ width: 130 }} />
              <col style={{ width: 72 }} />
              <col style={{ width: 60 }} />
              <col style={{ width: 130 }} />
              <col style={{ width: 90 }} />
            </colgroup>
            <thead>
              <tr>
                <th>title</th>
                <th>channel</th>
                <th>size</th>
                <th>dur</th>
                <th>downloaded</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr>
                  <td colSpan={6} className="hint" style={{ padding: "14px 12px" }}>
                    no history yet — downloads appear here
                  </td>
                </tr>
              )}
              {rows.map((row) => {
                const isMoved = moved.has(rowKey(row));
                return (
                  <tr key={rowKey(row)}>
                    <td>
                      <div className="t-title">{row.title ?? rowKey(row)}</div>
                      <div className="t-meta">
                        {row.extractor}
                        {isMoved && ' · '}
                        {isMoved && <span className="warn">moved?</span>}
                      </div>
                    </td>
                    <td className="t-meta">{row.channel ?? "—"}</td>
                    <td className="numm">{fmtSize(row.sizeBytes)}</td>
                    <td className="numm">{fmtDur(row.durationSec)}</td>
                    <td className="numm">{fmtDate(row.downloadedAt)}</td>
                    <td className="actions-cell">
                      {isMoved || !row.finalPath ? (
                        <button
                          className="iconbtn"
                          title="locate… — re-link the moved file"
                          onClick={() => void locate(row)}
                        >
                          🔍
                        </button>
                      ) : (
                        <button
                          className="iconbtn"
                          title="show in folder — history keeps the last known path"
                          onClick={() => void showInFolder(row)}
                        >
                          📁
                        </button>
                      )}
                      <button
                        className="iconbtn"
                        title={
                          row.url
                            ? "download again — uses current composer settings & destination"
                            : "source url unknown (imported id) — paste the url in the composer"
                        }
                        style={row.url ? undefined : { opacity: 0.35, cursor: "default" }}
                        onClick={() => void reDownload(row)}
                      >
                        ↻
                      </button>
                      {/* d87: remove the ARCHIVE entry — re-queueing will
                          download again. history keeps the row. */}
                      <button
                        className="iconbtn"
                        title="remove from archive — re-downloading this item will download it again; history keeps the entry"
                        onClick={() => void removeFromArchive(row)}
                      >
                        ✕
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {/* d76: the action bar lives OUTSIDE the scroll region — always visible. */}
        <div
          className="card-b flex items-center flex-wrap gap-2"
          style={{ borderTop: "1px solid var(--border)" }}
        >
          <span className="hint">{rows.length} entries</span>
          <span className="grow" />
          {importMsg && <span className="hint hist-msg">{importMsg}</span>}
          <button className="btn sm ghost" onClick={() => void importArchive()}>
            import archive…
          </button>
          <button
            className="btn sm ghost"
            onClick={() => void exportArchive()}
            title="copy the app's archive to a file of your choosing — for backups or other tools"
          >
            export archive…
          </button>
          <button
            className="btn sm ghost"
            onClick={() => void reconcile()}
            title="adds history rows for archive entries the db doesn't know (d64) — never removes anything. needed only after hand-editing the archive file."
          >
            sync history from archive
          </button>
          <button
            className="btn sm ghost"
            onClick={async () => {
              const p = await appPaths();
              await revealItemInDir(p.archivePath);
            }}
            title="reveal the app's own downloaded.txt in explorer"
          >
            reveal archive
          </button>
        </div>
      </div>
    </div>
  );

  async function importArchive() {
    const picked = await openDialog({
      multiple: false,
      filters: [{ name: "downloaded.txt", extensions: ["txt"] }],
    });
    if (typeof picked !== "string") return;
    // d75: the app copies the file into its own archive — the user picks
    // what that means. the picked file itself is never modified.
    const mode = await choiceDialog({
      title: "import archive",
      body: `“${picked.split(/[\\/]/).pop()}” will be copied into the app's own archive (${(await appPaths()).archivePath}). your file is not modified.`,
      options: [
        {
          value: "merge",
          label: "merge — keep everything",
          description: "the app archive keeps all its entries and gains the ones it's missing",
          primary: true,
        },
        {
          value: "replace",
          label: "replace — use this file's contents",
          description:
            "the app archive is emptied of its current entries and takes this file's instead",
        },
      ],
      cancelLabel: "cancel",
    });
    if (mode == null) return;
    const res = await historyImportArchive(picked, mode as "merge" | "replace");
    setImportMsg(
      `${res.idsImported === 0 ? "no new" : res.idsImported} entries added to history · archive: ${res.archiveAdded} ${mode === "replace" ? "entries" : "new entries"}`,
    );
    await load(query || undefined);
  }

  async function exportArchive() {
    const picked = await saveDialog({
      title: "export archive as…",
      defaultPath: "downloaded.txt",
      filters: [{ name: "downloaded.txt", extensions: ["txt"] }],
    });
    if (typeof picked !== "string") return;
    const n = await archiveExport(picked);
    setImportMsg(`exported ${n} entries → ${picked}`);
  }

  async function reconcile() {
    const r = await archiveReconcile();
    setImportMsg(
      r.rowsBackfilled > 0
        ? `synced: ${r.rowsBackfilled} archive entries added to history (${r.idsInArchive} in archive)`
        : `history is up to date — ${r.idsInArchive} archive entries known`,
    );
    await load(query || undefined);
  }

  // d87: remove this item from the app-owned archive — the next queue of
  // the same url downloads again instead of skipping. the history row stays
  // (it records that a download happened); only the skip-marker goes.
  async function removeFromArchive(row: HistoryRow) {
    const ok = await confirmDialog({
      title: "remove from archive",
      body: `“${row.title ?? `${row.extractor} ${row.vid}`}” will be removed from the download archive.\n\nQueuing this item again will download it again. The history entry stays. The existing file on disk is not touched.`,
      confirmLabel: "remove",
      cancelLabel: "cancel",
    });
    if (!ok) return;
    const removed = await archiveRemove([[row.extractor, row.vid]]);
    setImportMsg(
      removed > 0
        ? `removed from archive — queuing “${row.title ?? row.vid}” will download again`
        : "entry was not in the archive (nothing removed)",
    );
  }
}
