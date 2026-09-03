import { useEffect, useRef, useState } from "react";
import { useSettings } from "../stores/settings";

/** inline "saved ✓" flash (D24) — appears ~1.2 s after each autosave. */
export function SavedFlash() {
  const savedAt = useSettings((s) => s.savedAt);
  const [visible, setVisible] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!savedAt) return;
    setVisible(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setVisible(false), 1200);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [savedAt]);

  if (!visible) return <span />;
  return (
    <span style={{ color: "var(--green)", fontSize: 11, marginLeft: "auto" }}>saved ✓</span>
  );
}
