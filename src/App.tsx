import { useEffect, useState } from "react";
import TabBar from "./components/TabBar";
import FirstRunWizard from "./components/FirstRunWizard";
import UpdateBanner from "./components/UpdateBanner";
import HomePage from "./pages/Home";
import HistoryPage from "./pages/History";
import SettingsPage from "./pages/Settings";
import { attachAppUpdatePolling } from "./lib/appUpdate";
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

  // m5 bootstrap: app-update polling (launch + 6 h, §8)
  useEffect(() => attachAppUpdatePolling(), []);

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

  // §6 keyboard polish: ctrl+v focuses the composer from anywhere
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "v") {
        useUi.getState().setPage("home");
        const el = document.querySelector<HTMLTextAreaElement>(".card-b textarea");
        el?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="app h-full flex flex-col">
      <TabBar />
      <main className="flex-1 min-h-0 overflow-y-auto">
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
    </div>
  );
}
