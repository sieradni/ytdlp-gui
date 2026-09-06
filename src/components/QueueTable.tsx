import { useEffect, useRef, useState } from "react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { useQueue, type SortKey } from "../stores/queue";
import type { Job } from "../lib/ipc";

/** C7: reveal-in-explorer whenever a real file exists behind the row
 * (done, skipped, or error-with-file). async probe like history's —
 * a vanished file quietly hides the affordance instead of erroring. */
function useFileExists(p: string | null): boolean {
  const [exists, setExists] = useState(false);
  useEffect(() => {
    let live = true;
    if (!p) {
      setExists(false);
      return;
    }
    import("../lib/ipc").then(({ fileExists }) =>
      fileExists(p)
        .then((ok) => {
          if (live) setExists(ok);
        })
        .catch(() => {
          if (live) setExists(false);
        }),
    );
    return () => {
      live = false;
    };
  }, [p]);
  return exists;
}

function fmtSpeed(bps: number | null): string {
  if (!bps) return "";
  const mb = bps / 1048576;
  return `${mb >= 10 ? mb.toFixed(0) : mb.toFixed(1)} MB/s`;
}

function fmtEta(sec: number | null): string {
  if (sec == null) return "";
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/** contextual row actions (§6 actions matrix; D29 sticky-right glyphs). */
function Actions({ job }: { job: Job }) {
  const { stop, retry, remove, toggleExpanded } = useQueue();
  const open = useQueue((s) => s.expanded.has(job.id));
  const busy = job.state === "downloading" || job.state === "post";
  const fileExists = useFileExists(job.finalPath);
  return (
    <div className="actions-cell">
      {fileExists && (
        <button
          className="iconbtn"
          title="show in explorer"
          onClick={() => void revealItemInDir(job.finalPath!).catch(() => {})}
        >
          ❋
        </button>
      )}
      {(job.state === "downloading" || job.state === "post" || job.state === "queued") && (
        <button className="iconbtn" title="stop — keeps partial files" onClick={() => void stop(job.id)}>
          ■
        </button>
      )}
      {(job.state === "stopped" || job.state === "error") && (
        <button className="iconbtn" title="retry" onClick={() => void retry(job.id)}>
          ↻
        </button>
      )}
      {!busy && (
        <button
          className="iconbtn danger"
          title="remove from queue — file & history kept"
          onClick={() => void remove(job.id)}
        >
          ✕
        </button>
      )}
      <button
        className="iconbtn chev"
        title="output"
        onClick={() => toggleExpanded(job.id)}
      >
        {open ? "▾" : "▸"}
      </button>
    </div>
  );
}

function LogRow({ job }: { job: Job }) {
  const open = useQueue((s) => s.expanded.has(job.id));
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (open && ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [open, job.output.length]);
  if (!open) return null;
  return (
    <tr className="log-row">
      <td colSpan={6}>
        <div className="logwrap" ref={ref}>
          {job.output.map((l, i) => (
            <div key={i} style={l.startsWith("ERROR") ? { color: "var(--red)" } : undefined}>
              {l}
            </div>
          ))}
        </div>
      </td>
    </tr>
  );
}

/** C3: the hover card is a real interaction surface — it stays while the
 * pointer is on IT (not just the row), hides after a 300 ms grace when the
 * pointer leaves both, and carries its own actions. the old version died
 * with the row's mouseout (even when moving INTO the card), so tooltips
 * "flashed away" the moment the pointer crossed the gap. text is
 * selectable (C4); path gets double-click-to-copy. */
function HoverCard({
  job,
  anchor,
  onIntent,
}: {
  job: Job;
  anchor: HTMLElement;
  onIntent: (inside: boolean) => void;
}) {
  const r = anchor.getBoundingClientRect();
  const fileExists = useFileExists(job.finalPath);
  const [copied, setCopied] = useState(false);
  const style: React.CSSProperties = {
    position: "fixed",
    zIndex: 60,
    width: 440,
    maxWidth: "calc(100vw - 24px)",
    left: Math.min(r.right + 10, window.innerWidth - 452),
    top: Math.min(r.top, window.innerHeight - 220),
    background: "var(--bg-2)",
    border: "1px solid var(--amber-border)",
    borderRadius: 6,
    boxShadow: "0 14px 40px rgba(0,0,0,.55)",
    padding: "10px 12px",
    fontSize: 11.5,
    lineHeight: 1.55,
  };
  const copyPath = () => {
    if (!job.finalPath) return;
    void navigator.clipboard.writeText(job.finalPath);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };
  return (
    <div
      style={style}
      className="hovercard-shown"
      onMouseEnter={() => onIntent(true)}
      onMouseLeave={() => onIntent(false)}
    >
      <div style={{ fontWeight: 700, fontSize: 12.5, marginBottom: 4, overflowWrap: "anywhere" }}>
        {job.title ?? "fetching…"}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "82px 1fr", gap: "2px 10px", color: "var(--muted)" }}>
        <span>source</span>
        <span style={{ color: "var(--text)", overflowWrap: "anywhere" }}>{job.url}</span>
        <span>status</span>
        <span style={{ color: "var(--text)" }}>{job.state}{job.error ? ` — ${job.error}` : ""}</span>
        {job.itemsTotal != null && (
          <>
            <span>playlist</span>
            <span style={{ color: "var(--text)" }}>
              {job.itemsDone ?? 0} / {job.itemsTotal} items
            </span>
          </>
        )}
        <span>destination</span>
        <span
          style={{ color: "var(--text)", overflowWrap: "anywhere", cursor: job.finalPath ? "text" : undefined }}
          title={job.finalPath ? "double-click to copy" : undefined}
          onDoubleClick={copyPath}
        >
          {job.finalPath ?? "(not yet)"}
        </span>
      </div>
      {(fileExists || job.finalPath) && (
        <div style={{ display: "flex", gap: 6, justifyContent: "flex-end", marginTop: 8 }}>
          {fileExists && (
            <button
              className="btn sm ghost"
              onClick={() => void revealItemInDir(job.finalPath!).catch(() => {})}
            >
              show in explorer
            </button>
          )}
          <button className="btn sm ghost" onClick={copyPath} disabled={!job.finalPath}>
            {copied ? "copied ✓" : "copy path"}
          </button>
        </div>
      )}
    </div>
  );
}

function Row({ job, index }: { job: Job; index: number }) {
  const { toggleExpanded } = useQueue();
  // C3 hover model: enter opens after a short dwell; leaving the row starts
  // a 300 ms grace timer that the CARD cancels by reporting intent — moving
  // the pointer across the gap (or onto the card) never closes it. leaving
  // both, or opening the log row, closes immediately.
  const [hoverJob, setHoverJob] = useState<Job | null>(null);
  const dwellTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const graceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cardIntent = useRef(false);
  const rowRef = useRef<HTMLTableRowElement>(null);
  const open = useQueue((s) => s.expanded.has(job.id));
  // completion feedback in-place (§6): a one-shot row flash when a job lands
  // on done — quiet enough to not demand attention, per the design language.
  const [doneFlash, setDoneFlash] = useState(false);
  const prevState = useRef(job.state);
  useEffect(() => {
    const was = prevState.current;
    prevState.current = job.state;
    if (was !== "done" && job.state === "done") {
      setDoneFlash(true);
      const t = setTimeout(() => setDoneFlash(false), 1500);
      return () => clearTimeout(t);
    }
  }, [job.state]);

  const clearTimers = () => {
    if (dwellTimer.current) clearTimeout(dwellTimer.current);
    if (graceTimer.current) clearTimeout(graceTimer.current);
    dwellTimer.current = null;
    graceTimer.current = null;
  };
  const closeCard = () => {
    clearTimers();
    cardIntent.current = false;
    setHoverJob(null);
  };
  const onRowEnter = () => {
    clearTimers();
    dwellTimer.current = setTimeout(() => {
      if (rowRef.current) setHoverJob(job);
    }, 350);
  };
  const onRowLeave = () => {
    if (dwellTimer.current) clearTimeout(dwellTimer.current);
    dwellTimer.current = null;
    graceTimer.current = setTimeout(() => {
      if (!cardIntent.current) setHoverJob(null);
    }, 300);
  };
  const onCardIntent = (inside: boolean) => {
    cardIntent.current = inside;
    if (inside) {
      if (graceTimer.current) clearTimeout(graceTimer.current);
      graceTimer.current = null;
    } else {
      closeCard();
    }
  };

  return (
    <>
      <tr
        ref={rowRef}
        className="qrow"
        data-status={job.state}
        data-flash={doneFlash ? "done" : undefined}
        onMouseEnter={onRowEnter}
        onMouseLeave={onRowLeave}
      >
        <td className="idx">{index + 1}</td>
        <td>
          <div
            className="t-title"
            onClick={() => toggleExpanded(job.id)}
            style={{ cursor: "pointer" }}
          >
            {job.title ?? `fetching… ${job.url}`}
          </div>
          <div className="t-meta">
            {job.error ?? (job.skipped ? "already downloaded — skipped" : job.url)}
          </div>
        </td>
        <td>
          <div className="flex items-center gap-2">
            <div className="progress" style={{ flex: 1 }}>
              <div
                style={{
                  // playlist jobs: the bar tracks overall items-done, not the
                  // current item's byte percent (D54); fetching shows an
                  // indeterminate pulse — never a stale percent (d61)
                  width: `${
                    job.state === "fetching"
                      ? 0
                      : job.itemsTotal != null
                        ? ((job.itemsDone ?? 0) / job.itemsTotal) * 100
                        : (job.pct ?? 0)
                  }%`,
                }}
              />
            </div>
            <span className="numm">
              {job.itemsTotal != null
                ? `${job.itemsDone ?? 0}/${job.itemsTotal}`
                : job.state === "fetching"
                  ? // d61: honest liveness — the identity probe is running;
                    // show elapsed seconds, never a fake percent
                    `resolving… ${Math.floor((job.fetchMs ?? 0) / 1000)}s`
                  : job.pct != null
                    ? `${Math.round(job.pct)}%`
                    : "—"}
            </span>
          </div>
        </td>
        <td className="numm">{fmtSpeed(job.speedBps) || "—"}</td>
        <td className="numm">{fmtEta(job.etaSec) || "—"}</td>
        <td className="actions-cell">
          <Actions job={job} />
        </td>
      </tr>
      <LogRow job={job} />
      {hoverJob && rowRef.current && (
        <HoverCard job={hoverJob} anchor={rowRef.current} onIntent={onCardIntent} />
      )}
      {/* open state re-derived so log rows track expansion */}
      {open ? null : null}
    </>
  );
}

const SORT_LABELS: Record<SortKey, string> = {
  _order: "queue order",
  title: "title",
  format: "format",
  status: "status",
  pct: "progress",
  speed: "speed",
  eta: "eta",
};

export default function QueueTable() {
  const { sorted, sortKey, sortDir, cycleSort, paused, pause, resume, load, loaded } = useQueue();
  const [menuOpen, setMenuOpen] = useState(false);
  const jobs = sorted();

  useEffect(() => {
    if (!loaded) void load();
  }, [loaded, load]);

  const active = jobs.filter((j) => j.state === "downloading" || j.state === "post").length;

  return (
    <div className="card">
      <div className="card-h">
        <h2>queue</h2>
        <div className="flex items-center gap-2">
          <button className="btn sm" onClick={() => void (paused ? resume() : pause())}>
            {paused ? "resume" : "pause"}
          </button>
          <button
            className="btn sm ghost"
            onClick={() =>
              void Promise.all(
                jobs.filter((j) => j.state === "done").map((j) => useQueue.getState().remove(j.id)),
              )
            }
          >
            clear done
          </button>
          <span className="grow" />
          <div style={{ position: "relative" }}>
            <button className="btn sm ghost" onClick={() => setMenuOpen((v) => !v)}>
              sort: {SORT_LABELS[sortKey]}{" "}
              {sortKey === "_order" ? "▾" : sortDir === "asc" ? "↑" : "↓"}
            </button>
            {menuOpen && (
              <div
                style={{
                  position: "absolute",
                  right: 0,
                  top: "calc(100% + 4px)",
                  zIndex: 40,
                  background: "var(--bg-2)",
                  border: "1px solid var(--border)",
                  borderRadius: 6,
                  boxShadow: "0 10px 30px rgba(0,0,0,.5)",
                  padding: 6,
                  minWidth: 190,
                }}
              >
                {(Object.keys(SORT_LABELS) as SortKey[]).map((k) => (
                  <button
                    key={k}
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      width: "100%",
                      textAlign: "left",
                      fontSize: 12,
                      color: k === sortKey ? "var(--amber)" : "var(--text)",
                      background: "none",
                      border: "none",
                      padding: "5px 8px",
                      cursor: "pointer",
                    }}
                    onClick={() => {
                      cycleSort(k);
                      setMenuOpen(false);
                    }}
                  >
                    {SORT_LABELS[k]}
                    {k === sortKey && sortKey !== "_order" && (sortDir === "asc" ? "↑" : "↓")}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
      <div style={{ height: 400, display: "flex", flexDirection: "column" }}>
        <div style={{ overflow: "auto", flex: 1, minHeight: 0 }}>
          <table>
            <colgroup>
              <col style={{ width: 34 }} />
              <col />
              <col style={{ width: 150 }} />
              <col style={{ width: 72 }} />
              <col style={{ width: 56 }} />
              <col style={{ width: 104 }} />
            </colgroup>
            <thead>
              <tr>
                <th onClick={() => cycleSort("_order")}>#</th>
                <th onClick={() => cycleSort("title")}>
                  item
                  {sortKey === "title" && <span className="dir">{sortDir === "asc" ? "▲" : "▼"}</span>}
                </th>
                <th onClick={() => cycleSort("pct")}>
                  progress
                  {sortKey === "pct" && <span className="dir">{sortDir === "asc" ? "▲" : "▼"}</span>}
                </th>
                <th onClick={() => cycleSort("speed")}>
                  speed
                  {sortKey === "speed" && <span className="dir">{sortDir === "asc" ? "▲" : "▼"}</span>}
                </th>
                <th onClick={() => cycleSort("eta")}>
                  eta
                  {sortKey === "eta" && <span className="dir">{sortDir === "asc" ? "▲" : "▼"}</span>}
                </th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {jobs.length === 0 && (
                <tr>
                  <td colSpan={6} className="hint" style={{ padding: "14px 12px" }}>
                    {active > 0 ? "" : "nothing queued — paste urls above"}
                  </td>
                </tr>
              )}
              {jobs.map((j, i) => (
                <Row key={j.id} job={j} index={i} />
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
