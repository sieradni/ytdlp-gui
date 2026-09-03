import { useState } from "react";
import {
  binariesCheckLatest,
  binariesSetCustomPath,
  binariesUpdate,
  type Tool,
  type ToolStatus,
} from "../lib/ipc";
import { useBinaries } from "../stores/binaries";

/**
 * one row of the settings → tools card (§6): installed version, check,
 * update. "update = download latest build, verify sha-256, swap atomically.
 * never automatic." ffmpeg's update is strictly user-initiated (D20).
 */
export default function ToolRow({ status }: { status: ToolStatus }) {
  const refresh = useBinaries((s) => s.refresh);
  const availableTag = useBinaries((s) => s.availableTags[status.tool]);
  const [busy, setBusy] = useState<"" | "check" | "update">("");
  const [msg, setMsg] = useState<string | null>(null);
  const tool = status.tool as Tool;

  const check = async () => {
    setBusy("check");
    setMsg(null);
    try {
      const after = await binariesCheckLatest(tool);
      setMsg(
        after.latestTag && after.latestTag !== status.version
          ? `latest: ${after.latestTag}`
          : "up to date",
      );
      await refresh();
    } catch (e) {
      setMsg(String(e));
    } finally {
      setBusy("");
    }
  };

  const update = async () => {
    setBusy("update");
    setMsg(null);
    try {
      const res = await binariesUpdate(tool);
      setMsg(res.staged ? "installed — swaps in on next launch" : `updated to ${res.version}`);
      await refresh();
    } catch (e) {
      setMsg(String(e));
    } finally {
      setBusy("");
    }
  };

  const setCustom = async () => {
    const p = window.prompt(
      `full path to your own ${tool} binary (empty to go back to managed):`,
      status.path ?? "",
    );
    if (p === null) return;
    await binariesSetCustomPath(tool, p.trim() || null);
    await refresh();
  };

  const badge = availableTag ?? (status.latestTag && status.latestTag !== status.version ? status.latestTag : null);

  return (
    <>
      <label>{status.tool}</label>
      <div className="row flex flex-wrap items-center gap-2">
        {status.installed ? (
          <span className="numm">{status.version}</span>
        ) : (
          <span className="hint">not installed</span>
        )}
        {status.custom && <span className="hint">· custom path</span>}
        {status.staged && <span className="warn">· staged — swaps in on next launch</span>}
        {badge && !status.custom && (
          <span className="warn">→ {badge} available</span>
        )}
        <button className="btn sm" onClick={check} disabled={busy !== ""}>
          check
        </button>
        <button
          className={"btn sm" + (badge ? " primary" : "")}
          onClick={update}
          disabled={busy !== "" || !status.installed}
          title="download latest build, verify, swap atomically — never automatic"
        >
          update
        </button>
        <button className="btn sm ghost" onClick={setCustom} title="point at your own copy (scoop, PATH) — disables managed updates">
          custom…
        </button>
        {msg && <span className="hint">{msg}</span>}
      </div>
    </>
  );
}
