import { create } from "zustand";
import { settingsGet, settingsSave, type Settings } from "../lib/ipc";

interface SettingsState {
  settings: Settings;
  loaded: boolean;
  /** "saved ✓" flash timestamp (D24) — 0 = hidden */
  savedAt: number;
  load: () => Promise<void>;
  update: (patch: Partial<Settings>) => Promise<void>;
}

const DEFAULTS: Settings = {
  wizardDismissed: false,
  destination: null,
  concurrency: null,
  archivePath: null,
};

/**
 * settings autosave (D24): every change saves immediately, no save button;
 * the UI flashes "saved ✓" off `savedAt`.
 */
export const useSettings = create<SettingsState>((set, get) => ({
  settings: DEFAULTS,
  loaded: false,
  savedAt: 0,

  load: async () => {
    const settings = { ...DEFAULTS, ...(await settingsGet()) };
    set({ settings, loaded: true });
  },

  update: async (patch) => {
    const settings = { ...get().settings, ...patch };
    set({ settings });
    await settingsSave(settings);
    set({ savedAt: Date.now() });
  },
}));
