import { useEngineCounts } from "./queue";

/**
 * engine status line for the tab bar (§6 chrome, D25):
 * "n active · m queued" / "engine idle".
 */
export function useEngineStatus(): string {
  const counts = useEngineCounts((s) => s.counts);
  if (!counts) return "engine idle";
  const { active, queued } = counts;
  if (active > 0) return `${active} active · ${queued} queued`;
  if (queued > 0) return `${queued} queued`;
  return "engine idle";
}
