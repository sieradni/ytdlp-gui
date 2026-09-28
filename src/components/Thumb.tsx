import { useEffect, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";

/**
 * d93: row thumbnail. the src is an app-data png (remote art fetched when
 * the identity resolves, or locally extracted art — embedded cover / video
 * frame — from the done sweep), served through the tauri asset protocol
 * (csp img-src already whitelists asset:; the scope allows $APPDATA/**).
 * the img fades in only when loaded, so cache-missing rows never flash a
 * broken-image glyph — the letter chip renders underneath instead.
 */
export function Thumb({ src, title }: { src: string | null; title: string | null }) {
  const [loaded, setLoaded] = useState(false);
  const assetSrc = src ? convertFileSrc(src) : null;
  // reset the fade when the art changes (remote fetch → local swap at done)
  useEffect(() => setLoaded(false), [assetSrc]);
  return (
    <span className="thumb" aria-hidden="true">
      {assetSrc && (
        <img
          src={assetSrc}
          alt=""
          className="thumb-img"
          style={loaded ? undefined : { opacity: 0 }}
          onLoad={() => setLoaded(true)}
          onError={() => setLoaded(false)}
          draggable={false}
        />
      )}
      {!loaded && (
        <span className="thumb-fallback">
          {(title ?? "").trim().charAt(0).toUpperCase() || "·"}
        </span>
      )}
    </span>
  );
}
