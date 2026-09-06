import { useEffect, useState } from "react";
import TabBar from "./components/TabBar";
import FirstRunWizard from "./components/FirstRunWizard";
import UpdateBanner from "./components/UpdateBanner";
import { ConfirmDialogHost } from "./components/ConfirmDialog";
import HomePage from "./pages/Home";
import HistoryPage from "./pages/History";
import SettingsPage from "./pages/Settings";
import { attachAppUpdatePolling } from "./lib/appUpdate";
import { attachSmoothScroll } from "./lib/smoothScroll";
import { useUi } from "./stores/ui";
import { useBinaries } from "./stores/binaries";
import { useSettings } from "./stores/settings";
import { useQueue, attachEngineCounts } from "./stores/queue";

export default function App() {
  const page = useUi((s) => s.page);
  const { loaded, wizardOpen } = useBinaries();
  const loadSettings = useSettings((s) => s.load);
  const loadQueue = useQueue((s) => s.load);
  const [queueError, setQueueError] = useState<string | null>(null);

  // m5 bootstrap: app-update polling (launch-only since D81, §8)
  useEffect(() => attachAppUpdatePolling(), []);

  // d82: wheel smoothing — makes long-list positioning legible. demo
  // knob: EASE in smoothScroll.ts (0.16 = quick attack, short glide).
  useEffect(() => attachSmoothScroll(), []);

  // m2/m3 bootstrap: settings, binary status + wizard gate, queue mirror,
  // event subscriptions. no ipc probe display — the engine status is real now.
  useEffect(() => {
    let unEngine: (() => void) | undefined;
    void loadSettings();
    void useBinaries.getState().attach();
    void attachEngineCounts().then((un) => {
      unEngine = un;
    });
    void useBinaries
      .getState()
      .refresh()
      .then(() => {
        const s = useBinaries.getState();
        const dismissed = useSettings.getState().settings.wizardDismissed;
        if (s.manifest && !s.manifest.ready && !dismissed) {
          s.setWizardOpen(true);
        }
      });
    void useQueue
      .getState()
      .attach()
      .catch((e) => setQueueError(String(e)));
    void loadQueue().catch((e) => setQueueError(String(e)));
    return () => {
      unEngine?.();
    };
  }, [loadSettings, loadQueue]);

  // §6 keyboard polish: ctrl+v focuses the composer from anywhere —
  // EXCEPT when the keystroke lands in a text field (d80): the global
  // shortcut hijacked pastes into the history search box (and any other
  // input), teleporting the user to home instead of pasting. when the
  // target is already editable, the paste must simply paste.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.key !== "v") return;
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable ||
          target.closest("input, textarea, [contenteditable]"))
      )
        return;
      useUi.getState().setPage("home");
      // the composer mounts *after* the page switch re-renders — focusing
      // synchronously grabs nothing (found by the e2e checklist, S14).
      // two frames: one for the react commit, one for effects to settle.
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          const el = document.querySelector<HTMLTextAreaElement>(".card-b textarea");
          el?.focus();
        }),
      );
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="app h-full flex flex-col">
      <TabBar />
      <main className="scrollpane flex-1 min-h-0 overflow-y-auto">
        {page === "home" && <HomePage />}
        {page === "history" && <HistoryPage />}
        {page === "settings" && <SettingsPage />}
      </main>
      {queueError && (
        <div className="warn" style={{ padding: "2px 14px 6px" }}>
          queue: {queueError}
        </div>
      )}
      <UpdateBanner />
      {loaded && wizardOpen && <FirstRunWizard />}
      <ConfirmDialogHost />
    </div>
  );
}
