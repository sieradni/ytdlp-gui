import { invoke } from "@tauri-apps/api/core";

/**
 * typed ipc wrappers (§7). every milestone adds its commands here so the
 * frontend never calls raw strings.
 */

// ---------------------------------------------------------------------------
// m1 probe — remove when the shell probe goes away
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
// settings (§7; autosave per D24)
// ---------------------------------------------------------------------------

export interface Settings {
  wizardDismissed: boolean;
  destination: string | null;
  concurrency: number | null;
  archivePath: string | null;
  /** one-shot v1 migration marker (D55) — must round-trip through saves */
  migratedFromV1: boolean;
}

export const settingsGet = () => invoke<Settings>("settings_get");
export const settingsSave = (settings: Settings) => invoke<void>("settings_save", { settings });

// ---------------------------------------------------------------------------
// composer options — mirrors src-tauri/src/engine/args.rs (D19: one shape)
// ---------------------------------------------------------------------------

export type DlType = "audio" | "video";
export type AudioFormat =
  | "best"
  | "mp3"
  | "m4a"
  | "opus"
  | "vorbis"
  | "flac"
  | "alac"
  | "wav"
  | "mka"
  | "mp4container";
export type CoverMode = "square" | "original" | "custom" | "none";
export type PlaylistMode = "single" | "all" | "firstn";
export type VideoContainer = "mp4" | "mkv" | "webm";
export type VideoAudioPref = "opus" | "aac";
export type CookieKind = "none" | "frombrowser" | "file";

export interface CookieSource {
  kind: CookieKind;
  browser: string | null;
  file: string | null;
}

export interface JobOptions {
  dlType: DlType;
  audioFormat: AudioFormat;
  coverMode: CoverMode;
  coverW: number;
  coverH: number;
  maxResolution: string;
  container: VideoContainer;
  audioPref: VideoAudioPref;
  playlistMode: PlaylistMode;
  playlistN: number;
  skipDownloaded: boolean;
  /** D59: explicit overwrite grant for re-downloads onto existing files. */
  overwrite: boolean;
  cookies: CookieSource;
  subtitleLangs: string[];
  autoCaptions: boolean;
  sponsorblock: string[];
  extraArgs: string[];
  outputTemplate: string | null;
}

// ---------------------------------------------------------------------------
// jobs / queue (m3, §5)
// ---------------------------------------------------------------------------

export type JobState =
  | "queued"
  | "fetching"
  | "downloading"
  | "post"
  | "done"
  | "stopped"
  | "error"
  | "duplicate";

export interface Job {
  id: string;
  url: string;
  state: JobState;
  title: string | null;
  format: string | null;
  finalPath: string | null;
  pct: number | null;
  speedBps: number | null;
  etaSec: number | null;
  error: string | null;
  skipped: boolean;
  /** playlist progress (D33): items done / total; null for single videos */
  itemsDone: number | null;
  itemsTotal: number | null;
  /** d61: ms elapsed in the fetch phase (live ticker while resolving) */
  fetchMs?: number | null;
  output: string[];
  createdAt: number;
}

export interface AddFeedback {
  jobs: Job[];
  invalid: [string, string][];
  duplicatesSkipped: number;
}

export const jobAdd = (urls: string[], options: JobOptions, destination?: string) =>
  invoke<AddFeedback>("job_add", { urls, options, destination: destination ?? null });
export const jobStop = (id: string) => invoke<void>("job_stop", { id });
export const jobRetry = (id: string) => invoke<void>("job_retry", { id });
export const jobRemove = (id: string) => invoke<void>("job_remove", { id });
/** D59: server-side existence probe for the re-download confirm gate
 * (renderer has no fs access; the dialog plugin opens, not probes). */
export const fileExists = (path: string) => invoke<boolean>("file_exists", { path });
export const queueList = () => invoke<Job[]>("queue_list");

/** d60: which urls would overwrite existing destination files if queued
 * now (single-video mode only; playlists are excluded by design). the
 * composer offers the same overwrite/cancel dialog the history gate does. */
export interface OverwriteTarget {
  url: string;
  name: string;
  dest: string;
}
export const overwriteTargets = (urls: string[], playlistSingle: boolean, skipDownloaded: boolean) =>
  invoke<OverwriteTarget[]>("overwrite_targets", { urls, playlistSingle, skipDownloaded });
export const queuePause = () => invoke<boolean>("queue_pause");
export const queueResume = () => invoke<boolean>("queue_resume");

// ---------------------------------------------------------------------------
// metadata (§7, D44) + history (§5.3)
// ---------------------------------------------------------------------------

export interface ResolvedIdentity {
  extractor: string;
  id: string;
  title: string | null;
}

export const metadataResolve = (url: string) =>
  invoke<ResolvedIdentity>("metadata_resolve", { url });

export interface HistoryRow {
  extractor: string;
  vid: string;
  url: string | null;
  title: string | null;
  channel: string | null;
  durationSec: number | null;
  sizeBytes: number | null;
  format: string | null;
  finalPath: string | null;
  error: string | null;
  downloadedAt: number;
}

export const historyList = (filter?: string) =>
  invoke<HistoryRow[]>("history_list", { filter: filter ?? null });
export const historyImportArchive = (path: string, copy?: boolean) =>
  invoke<{ idsImported: number; archivePath: string }>("history_import_archive", {
    path,
    copy: copy ?? null,
  });
export const historyRelink = (id: string, path: string | null) =>
  invoke<void>("history_relink", { id, path });

/** d64: archive↔history reconciliation — backfills missing rows, reports
 * both asymmetries. idempotent; safe to run any time. */
export interface ReconcileReport {
  idsInArchive: number;
  rowsBackfilled: number;
  rowsWithoutUrl: number;
}
export const archiveReconcile = () =>
  invoke<ReconcileReport>("archive_reconcile");

// ---------------------------------------------------------------------------
// app paths + version (§7)
// ---------------------------------------------------------------------------

export interface AppPaths {
  archivePath: string;
  binDir: string;
}

export const appPaths = () => invoke<AppPaths>("app_paths");

// ---------------------------------------------------------------------------
// v1 migration (§11, D43) — what this launch's one-shot migration found
// ---------------------------------------------------------------------------

export interface MigrationReport {
  configApplied: boolean;
  droppedKeys: string[];
  historySeeded: number;
  archivePath: string | null;
  v1YtDlpPath: string | null;
  v1FfmpegPath: string | null;
  migratedOptions: JobOptions | null;
}

export const migrationStatus = () => invoke<MigrationReport | null>("migration_status");

export interface AppVersions {
  app: string;
  ytDlp: string | null;
  ffmpeg: string | null;
}

export const appVersion = () => invoke<AppVersions>("app_version");
