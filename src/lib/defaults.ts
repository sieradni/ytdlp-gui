import type { JobOptions } from "./ipc";

/**
 * composer defaults (§6 home). the composer seeds from these; re-download
 * (D19) queues with the same defaults since it bypasses the composer state.
 */
export function defaultOptions(): JobOptions {
  return {
    dlType: "audio",
    audioFormat: "best",
    coverMode: "square",
    coverW: 640,
    coverH: 640,
    maxResolution: "best",
    container: "mp4",
    audioPref: "opus",
    playlistMode: "single",
    playlistN: 10,
    skipDownloaded: true,
    cookies: { kind: "none", browser: null, file: null },
    subtitleLangs: [],
    autoCaptions: false,
    sponsorblock: [],
    extraArgs: [],
    outputTemplate: null,
  };
}
