import { create } from "zustand";

/**
 * engine status line for the tab bar (§6 chrome, D25).
 * real counts arrive in m3 via "queue:changed" events — components
 * subscribe here, so updates re-render the tab bar automatically.
 */
interface EngineState {
  status: string;
  setStatus: (status: string) => void;
}

export const useEngine = create<EngineState>((set) => ({
  status: "engine idle",
  setStatus: (status) => set({ status }),
}));
