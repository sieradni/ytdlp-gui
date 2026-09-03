import type { JobOptions } from "./ipc";

/**
 * live command preview (§6): exact argv as it will run, rebuilt on every
 * change. mirrors engine/args.rs — kept in sync by its snapshot tests.
 */
export function buildPreviewArgs(opts: JobOptions, dest: string, archive?: string | null): string[] {
  const argv: string[] = ["yt-dlp"];

  argv.push("--newline", "--progress", "--no-simulate");
  argv.push(
    "--progress-template",
    "download:__P__%(progress.downloaded_bytes)s|%(progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.eta)s",
  );
  argv.push("--print", "after_move:filepath");

  if (archive) {
    argv.push("--download-archive", archive);
  }

  if (opts.playlistMode === "single") argv.push("--no-playlist");
  else if (opts.playlistMode === "firstn") {
    argv.push("--playlist-end", String(Math.max(1, opts.playlistN)));
  }

  argv.push("-P", dest);

  if (opts.dlType === "audio") {
    argv.push("-f", "ba", "-x");
    if (opts.audioFormat !== "best") argv.push("--audio-format", opts.audioFormat);
    pushCover(argv, opts);
  } else {
    const cap =
      opts.maxResolution === "best" ? "" : `[height<=${opts.maxResolution.replace("p", "")}]`;
    const audio = opts.audioPref === "aac" ? "[ext=m4a]" : "";
    const fmt =
      cap === ""
        ? `bv*+ba${audio}/bv*+ba/b`
        : `bv*${cap}+ba${audio}/bv*${cap}+ba/b${cap}/b`;
    argv.push("-f", fmt);
    argv.push("--merge-output-format", opts.container);
    pushCover(argv, opts);
  }

  argv.push("--embed-metadata");

  if (opts.subtitleLangs.length) {
    argv.push("--sub-langs", opts.subtitleLangs.join(","));
    argv.push("--write-subs");
  }
  if (opts.autoCaptions) argv.push("--write-auto-subs");
  if (opts.sponsorblock.length) {
    argv.push("--sponsorblock-remove", opts.sponsorblock.join(","));
  }
  if (opts.outputTemplate) argv.push("-o", opts.outputTemplate);

  if (opts.cookies.kind === "frombrowser" && opts.cookies.browser) {
    argv.push("--cookies-from-browser", opts.cookies.browser);
  } else if (opts.cookies.kind === "file" && opts.cookies.file) {
    argv.push("--cookies", opts.cookies.file);
  }

  argv.push(...opts.extraArgs);
  return argv;
}

function pushCover(argv: string[], opts: JobOptions) {
  switch (opts.coverMode) {
    case "none":
      break;
    case "original":
      argv.push("--embed-thumbnail");
      break;
    case "square":
      argv.push("--embed-thumbnail");
      argv.push("--ppa", "ThumbnailsConvertor+ffmpeg_o:-c:v png -vf crop=ih");
      break;
    case "custom":
      if (opts.coverW > 0 && opts.coverH > 0) {
        argv.push("--embed-thumbnail");
        argv.push("--ppa", `ThumbnailsConvertor+ffmpeg_o:-c:v png -vf scale=${opts.coverW}:${opts.coverH}`);
      }
      break;
  }
}

/** shellish display (quoted where needed) — display only, never executed. */
export function displayArgv(argv: string[]): string {
  return argv
    .map((a) => (/^[\w./:\\@%|=<>^,+-]+$/.test(a) ? a : `"${a.replace(/"/g, '\\"')}"`))
    .join(" ");
}
