import { invoke } from "@tauri-apps/api/core";

/**
 * typed ipc wrappers (§7). every milestone adds its commands here so the
 * frontend never calls raw strings.
 */

// ---------------------------------------------------------------------------
// m1 probe — removed when m3 lands real engine status
// ---------------------------------------------------------------------------

export interface Pong {
  message: string;
  pingCount: number;
}

export function ping(message?: string): Promise<Pong> {
  return invoke<Pong>("ping", { message });
}

// ---------------------------------------------------------------------------
// binaries (m2, §4)
// ---------------------------------------------------------------------------

export type Tool = "yt-dlp" | "ffmpeg";

export interface ToolStatus {
  tool: Tool;
  installed: boolean;
  version: string | null;
  path: string | null;
  custom: boolean;
  updateAvailable: boolean;
  latestTag: string | null;
  staged: boolean;
}

export interface BinaryManifest {
  ytDlp: ToolStatus;
  ffmpeg: ToolStatus;
  /** both tools usable — gates the first-run wizard */
  ready: boolean;
}

export interface InstallResult {
  tool: Tool;
  version: string;
  source: string;
  sha256: string;
  staged: boolean;
}

export interface BinariesProgress {
  tool: string;
  received: number;
  total: number | null;
}

export const binariesStatus = () => invoke<BinaryManifest>("binaries_status");
export const binariesInstall = () => invoke<InstallResult[]>("binaries_install");
export const binariesUpdate = (tool: Tool) => invoke<InstallResult>("binaries_update", { tool });
export const binariesCheckLatest = (tool: Tool) =>
  invoke<ToolStatus>("binaries_check_latest", { tool });
export const binariesSetCustomPath = (tool: Tool, path: string | null) =>
  invoke<ToolStatus>("binaries_set_custom_path", { tool, path });

// ---------------------------------------------------------------------------
// settings (m2 minimal; autosave per D24)
// ---------------------------------------------------------------------------

export interface Settings {
  wizardDismissed: boolean;
  destination: string | null;
  concurrency: number | null;
  archivePath: string | null;
}

export const settingsGet = () => invoke<Settings>("settings_get");
export const settingsSave = (settings: Settings) => invoke<void>("settings_save", { settings });

// ---------------------------------------------------------------------------
// appVersion (§7)
// ---------------------------------------------------------------------------

export interface AppVersions {
  app: string;
  ytDlp: string | null;
  ffmpeg: string | null;
}

export const appVersion = () => invoke<AppVersions>("app_version");
