import { useEffect, useState } from "react";
import TabBar from "./components/TabBar";
import FirstRunWizard from "./components/FirstRunWizard";
import HomePage from "./pages/Home";
import HistoryPage from "./pages/History";
import SettingsPage from "./pages/Settings";
import { useUi } from "./stores/ui";
import { useBinaries } from "./stores/binaries";
import { useSettings } from "./stores/settings";
import { ping } from "./lib/ipc";

export default function App() {
  const page = useUi((s) => s.page);
  const [backend, setBackend] = useState<string>("backend: …");
  const { loaded, wizardOpen } = useBinaries();
  const loadSettings = useSettings((s) => s.load);

  // m1 typed-ipc probe: proves the bridge end to end on every launch.
  useEffect(() => {
    let alive = true;
    ping("m1")
      .then((pong) => {
        if (alive) setBackend(`backend: ok (${pong.message})`);
      })
      .catch((e) => {
        if (alive) setBackend(`backend: error (${String(e)})`);
      });
    return () => {
      alive = false;
    };
  }, []);

  // m2 bootstrap: settings load, binary status, event subscriptions,
  // first-run wizard gate (§4).
  useEffect(() => {
    void loadSettings();
    void useBinaries.getState().attach();
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
  }, [loadSettings]);

  return (
    <div className="app h-full flex flex-col">
      <TabBar />
      <main className="flex-1 min-h-0 overflow-y-auto">
        {page === "home" && <HomePage />}
        {page === "history" && <HistoryPage />}
        {page === "settings" && <SettingsPage />}
      </main>
      {/* temporary m1 probe — replaced by real engine status in m3 */}
      <div className="hint" style={{ padding: "2px 14px 6px" }}>
        {backend}
      </div>
      {loaded && wizardOpen && <FirstRunWizard />}
    </div>
  );
}
