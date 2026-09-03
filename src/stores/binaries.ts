import { create } from "zustand";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  binariesStatus,
  type BinaryManifest,
  type BinariesProgress,
} from "../lib/ipc";

interface Progress {
  received: number;
  total: number | null;
}

interface BinariesState {
  manifest: BinaryManifest | null;
  loaded: boolean;
  /** first-run wizard / replay is visible */
  wizardOpen: boolean;
  /** tool currently downloading: tool name or "both" — null when idle */
  busy: string | null;
  progress: Record<string, Progress>;
  error: string | null;
  /** tags seen via "update:available" events */
  availableTags: Record<string, string>;

  refresh: () => Promise<void>;
  setWizardOpen: (open: boolean) => void;
  setBusy: (busy: string | null) => void;
  setError: (error: string | null) => void;
  applyProgress: (p: BinariesProgress) => void;
  markAvailable: (tool: string, tag: string) => void;
  /** wire "binaries:progress" + "update:available"; returns unlisten fns */
  attach: () => Promise<UnlistenFn[]>;
}

export const useBinaries = create<BinariesState>((set, get) => ({
  manifest: null,
  loaded: false,
  wizardOpen: false,
  busy: null,
  progress: {},
  error: null,
  availableTags: {},

  refresh: async () => {
    try {
      const manifest = await binariesStatus();
      set({ manifest, loaded: true });
    } catch (e) {
      set({ error: String(e), loaded: true });
    }
  },

  setWizardOpen: (wizardOpen) => set({ wizardOpen }),
  setBusy: (busy) => set({ busy }),
  setError: (error) => set({ error }),

  applyProgress: (p) =>
    set((s) => ({
      progress: { ...s.progress, [p.tool]: { received: p.received, total: p.total } },
    })),

  markAvailable: (tool, tag) =>
    set((s) => ({ availableTags: { ...s.availableTags, [tool]: tag } })),

  attach: async () => {
    const un1 = await listen<BinariesProgress>("binaries:progress", (e) =>
      get().applyProgress(e.payload),
    );
    const un2 = await listen<{ tool: string; to: string }>("update:available", (e) =>
      get().markAvailable(e.payload.tool, e.payload.to),
    );
    return [un1, un2];
  },
}));
