import { useState } from "react";
import { useAppUpdate } from "../lib/appUpdate";

/**
 * §8: "app polls on launch + 6h → in-app banner → 'update & restart'".
 * rendered below the tab bar while an update is available or installing;
 * disappears when the update lands or the phase resets. the available
 * banner is dismissible (m6): the poll re-announces on the next 6h cycle,
 * so dismissing is a defer, not a block — §8's "polls every 6h" keeps the
 * contract honest. the installing banner is not dismissible (the app is
 * about to restart; hiding progress would look like a freeze).
 */
export default function UpdateBanner() {
  const { phase, update, received, total, installing, startInstall } = useAppUpdate();
  const [dismissed, setDismissed] = useState(false);

  if (installing || phase === "downloading") {
    const pct = total != null && total > 0 ? Math.min(100, (received / total) * 100) : null;
    return (
      <div className="update-banner" role="status">
        <span className="numm">
          updating{pct != null ? ` · ${pct.toFixed(0)}%` : "…"}
        </span>
        {pct != null && (
          <div className="progress" style={{ width: 160 }}>
            <div style={{ width: `${pct}%` }} />
          </div>
        )}
      </div>
    );
  }

  if (phase === "available" && update && !dismissed) {
    return (
      <div className="update-banner" role="status">
        <span>
          update available <span className="numm">{update.version}</span>
          {update.body ? <span className="hint"> — {update.body}</span> : null}
        </span>
        <span className="grow" />
        <button className="btn sm" onClick={() => void startInstall()}>
          update &amp; restart
        </button>
        <button
          className="btn sm ghost"
          title="hide until the next check (6 h)"
          onClick={() => setDismissed(true)}
        >
          ✕
        </button>
      </div>
    );
  }

  return null;
}
