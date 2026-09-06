import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
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
/** d77/d81: the "latest" line answers "what would I update to?". btbN's
 * rolling release is literally tagged `latest` — echoing the tag shows
 * `latest: latest`, which identifies nothing. the publish date (captured
 * at check time) is the honest identity; tagged releases keep their tag. */
function latestDisplay(tag: string, published: string | null): string {
  if (tag === "latest") {
    return published ? `nightly ${published.slice(0, 10)}` : "rolling release (btbn)";
  }
  return tag;
}

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
      // informational only — availability is the badge (record_check); for
      // btbN the tag is literally "latest" so never compare it to the version
      setMsg(
        after.latestTag
          ? `latest: ${latestDisplay(after.latestTag, after.latestPublished ?? null)}`
          : null,
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
    // custom-binary escape hatch (D40). cancel keeps the managed binary;
    // picking a file points the app at it and disables managed updates.
    const picked = await open({
      multiple: false,
      directory: false,
      filters: [{ name: "executables", extensions: ["exe"] }],
    });
    if (typeof picked !== "string") return;
    await binariesSetCustomPath(tool, picked);
    await refresh();
  };

  // badge comes only from a real update:available signal (record_check).
  // btbN's rolling tag is "latest" while the installed version string is a
  // build number — comparing them would show a permanent false badge.
  const badge = availableTag ?? null;

  return (
    <>
      <label>{status.tool}</label>
      {/* C1/C6: stable columns — version never reflows when badges or
          messages appear (the "number on both sides" bug was the version
          wrapping around a growing inline row); message gets its own line. */}
      <div className="toolrow">
        <div className="toolrow-main">
          {status.installed ? (
            <span className="numm tool-version" title={status.path ?? undefined}>
              {status.version}
            </span>
          ) : (
            <span className="hint tool-version">not installed</span>
          )}
          {status.custom && <span className="hint">· custom path</span>}
          {status.staged && (
            // d65: staged is a first-class step, not a footnote — the badge
            // said "update available" while the version row kept the old
            // number because windows locks the running exe. say exactly what
            // finishes it.
            <span className="warn">restart the app to finish the update</span>
          )}
          {badge && !status.custom && !status.staged && (
            <span className="warn">→ {badge} available</span>
          )}
          <span className="grow" />
          <button className="btn sm" onClick={check} disabled={busy !== ""}>
            check
          </button>
          <button
            className={"btn sm" + (badge ? " primary" : "")}
            onClick={update}
            disabled={busy !== "" || !status.installed}
            title="download and install the latest build — never automatic"
          >
            update
          </button>
          <button
            className="btn sm ghost"
            onClick={setCustom}
            title="point at your own copy (scoop, PATH) — disables managed updates"
          >
            custom…
          </button>
        </div>
        <div className="toolrow-msg hint">
          {msg
            ? msg
            : status.lastChecked
              ? `last checked ${new Date(status.lastChecked * 1000).toLocaleString()}${status.latestTag ? ` · latest: ${latestDisplay(status.latestTag, status.latestPublished ?? null)}` : ""}`
              : "never checked"}
        </div>
      </div>
    </>
  );
}
