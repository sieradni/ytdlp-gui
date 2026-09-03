import { useCallback, useEffect, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { historyImportArchive, historyList, historyRelink, jobAdd, type HistoryRow } from "../lib/ipc";
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
    await jobAdd([row.url], currentOptions);
    await load(query || undefined);
  };

  return (
    <div className="mx-auto max-w-[860px] px-5 pt-4 pb-9">
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
        <div style={{ overflowX: "auto" }}>
          <table>
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
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div
          className="card-b flex items-center flex-wrap"
          style={{ borderTop: "1px solid var(--border)" }}
        >
          <span className="hint">{rows.length} entries</span>
          <span className="grow" />
          {importMsg && <span className="hint">{importMsg}</span>}
          <button
            className="btn sm ghost"
            onClick={async () => {
              const { appPaths } = await import("../lib/ipc");
              const p = await appPaths();
              await revealItemInDir(p.archivePath);
            }}
          >
            open archive
          </button>
          <button
            className="btn sm ghost"
            onClick={async () => {
              const picked = await openDialog({
                multiple: false,
                filters: [{ name: "downloaded.txt", extensions: ["txt"] }],
              });
              if (typeof picked === "string") {
                const res = await historyImportArchive(picked);
                setImportMsg(`imported ${res.idsImported} ids — archive: ${res.archivePath}`);
                await load(query || undefined);
              }
            }}
          >
            import v1…
          </button>
          <span className="hint" style={{ width: "100%" }}>
            ⚠ editing downloaded.txt changes what counts as already downloaded
          </span>
        </div>
      </div>
    </div>
  );
}
