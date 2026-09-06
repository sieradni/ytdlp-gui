/**
 * app self-update (§8): tauri-plugin-updater checks the configured endpoint
 * (minisign-verified latest.json), plugin-process performs the relaunch.
 *
 * lifecycle: idle → checking → available | up-to-date → downloading (x%)
 * → installing (relaunch) | error. checks on launch only (d81: the 6 h
 * interval was removed — a download manager doesn't need a background
 * poller; "check now" is always available).
 * all failures land in `error` and never crash the ui — the updater is
 * strictly a background convenience (D30).
 */

import { create } from "zustand";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

export type AppUpdatePhase =
  | "idle"
  | "checking"
  | "up-to-date"
  | "available"
  | "downloading"
  | "installing"
  | "error";

interface AppUpdateState {
  phase: AppUpdatePhase;
  /** update payload while available/downloading (holds version + body) */
  update: Update | null;
  /** bytes downloaded / total when total is known */
  received: number;
  total: number | null;
  error: string | null;
  /** "update & restart" was clicked — banner must stay visible until relaunch */
  installing: boolean;

  checkNow: (manual: boolean) => Promise<void>;
  startInstall: () => Promise<void>;
}

const LAUNCH_CHECK_DELAY_MS = 4_000;

export const useAppUpdate = create<AppUpdateState>((set, get) => ({
  phase: "idle",
  update: null,
  received: 0,
  total: null,
  error: null,
  installing: false,

  checkNow: async (manual) => {
    // never overlap a running check/download; a manual check preempts the
    // "up-to-date" lull so the settings button always gives feedback.
    const s = get();
    if (s.phase === "checking" || s.phase === "downloading" || s.phase === "installing") {
      return;
    }
    set({ phase: "checking", error: null });
    try {
      const update = await check();
      if (update) {
        set({ phase: "available", update });
      } else {
        set({ phase: "up-to-date", update: null });
        // auto polls shouldn't leave the phase stuck on "up-to-date" forever —
        // it renders no banner either way; return to idle after a short lull.
        if (!manual) {
          setTimeout(() => {
            if (get().phase === "up-to-date") set({ phase: "idle" });
          }, 30_000);
        }
      }
    } catch (e) {
      // offline / endpoint 404 (dev builds, alpha period) are normal here
      set({ phase: "error", error: String(e) });
    }
  },

  startInstall: async () => {
    const update = get().update;
    if (!update) return;
    set({ phase: "downloading", received: 0, total: null, installing: true });
    try {
      await update.downloadAndInstall((event) => {
        switch (event.event) {
          case "Started":
            set({
              phase: "downloading",
              total: event.data.contentLength ?? null,
              received: 0,
            });
            break;
          case "Progress":
            set((s) => ({
              phase: "downloading",
              received: s.received + event.data.chunkLength,
            }));
            break;
          case "Finished":
            // the installer is staged; relaunch replaces the app while
            // running (§8). keep the banner up via `installing` until then.
            set({ phase: "installing" });
            break;
        }
      });
      await relaunch();
      // relaunch exits the process; if it somehow returns, surface it
      set({ phase: "error", error: "relaunch did not exit" });
    } catch (e) {
      set({ phase: "error", error: String(e), installing: false });
    }
  },
}));

/** launch-only check (d81). returns a cleanup fn. */
export function attachAppUpdatePolling(): () => void {
  // small startup delay so the check never competes with first paint
  const launchTimer = setTimeout(
    () => void useAppUpdate.getState().checkNow(false),
    LAUNCH_CHECK_DELAY_MS,
  );
  return () => {
    clearTimeout(launchTimer);
  };
}
