import { useAppUpdate } from "../lib/appUpdate";

/**
 * §8: "app polls on launch + 6h → in-app banner → 'update & restart'".
 * rendered below the tab bar while an update is available or installing;
 * disappears when the update lands or the phase resets. (dismiss is an m6
 * candidate — not promised by §8, so not implemented yet)
 */
export default function UpdateBanner() {
  const { phase, update, received, total, installing, startInstall } = useAppUpdate();

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

  if (phase === "available" && update) {
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
      </div>
    );
  }

  return null;
}
