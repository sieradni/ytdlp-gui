import { useUi, type PageId } from "../stores/ui";
import { useEngineStatus } from "../stores/engine";

const TABS: { id: PageId; label: string }[] = [
  { id: "home", label: "home" },
  { id: "history", label: "history" },
  { id: "settings", label: "settings" },
];

/**
 * top tab bar (D12). right side shows engine status only (D25) —
 * no tool versions here, those live in settings → tools.
 */
export default function TabBar() {
  const page = useUi((s) => s.page);
  const setPage = useUi((s) => s.setPage);
  const engine = useEngineStatus();

  return (
    <header
      className="flex-none flex items-center gap-1 h-8 px-3"
      style={{ background: "var(--bg-1)", borderBottom: "1px solid var(--border)" }}
    >
      {TABS.map((t) => (
        <button
          key={t.id}
          className={"tab-btn" + (page === t.id ? " active" : "")}
          onClick={() => setPage(t.id)}
        >
          {t.label}
        </button>
      ))}
      <div className="ml-auto text-[11px]" style={{ color: "var(--faint)" }}>
        {engine}
      </div>
    </header>
  );
}
