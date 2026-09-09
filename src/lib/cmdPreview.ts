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
    // d92: both size fields — youtube exposes exact total_bytes (sabr), most
    // other sites only total_bytes_estimate; the engine takes the first non-NA
    "download:__P__%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.eta)s",
  );
  argv.push("--print", "after_move:filepath");
  // per-item playlist index print (mirrors ENGINE_FLAGS; see args.rs —
  // the console counter line is suppressed under the progress template)
  argv.push("--print", "pre_process:__I__%(playlist_index)s|%(n_entries)s|%(playlist_count)s");
  // playlist-level total: fires even when every item is archive-skipped
  argv.push("--print", "playlist:__T__%(playlist_count)s");

  if (archive) {
    argv.push("--download-archive", archive);
  }

  if (opts.playlistMode === "single") argv.push("--no-playlist");
  else if (opts.playlistMode === "firstn") {
    argv.push("--playlist-end", String(Math.max(1, opts.playlistN)));
  }

  argv.push("-P", dest);

  if (opts.dlType === "audio") {
    argv.push("-f", "ba/b", "-x");
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
  // D59 mirror of engine/args.rs: explicit overwrite grant → --force-overwrites
  if (opts.overwrite) argv.push("--force-overwrites");

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

// ---------------------------------------------------------------------------
// C5: tier + role classification for the redesigned command preview.
//
// two visually separated tiers: what the user asked for (format, destination,
// playlist, cookies, subtitles — flags that change their result) vs engine
// plumbing (progress template, prints, archive internals — collapsed behind
// "show engine details"). roles drive color: amber = user flags, dim =
// plumbing, green = values, red = destructive (--force-overwrites).
// classification walks the REAL argv, so the preview can never drift from
// what runs.
// ---------------------------------------------------------------------------

export type CmdTokenRole = "prog" | "user" | "plumbing" | "destructive" | "value";
export interface CmdToken {
  text: string;
  role: CmdTokenRole;
  /** which preview tier a token belongs to (values inherit their flag's) */
  tier: "user" | "plumbing";
}

/** engine-internal flags — always appended by the app, never user-chosen */
const PLUMBING_FLAGS = new Set([
  "--newline",
  "--progress",
  "--no-simulate",
  "--progress-template",
  "--print",
  "--download-archive",
  "--embed-metadata",
]);

/** user-facing flags the composer builds */
const USER_FLAGS = new Set([
  "--no-playlist",
  "--playlist-end",
  "-P",
  "-f",
  "-x",
  "--audio-format",
  "--embed-thumbnail",
  "--ppa",
  "--merge-output-format",
  "--sub-langs",
  "--write-subs",
  "--write-auto-subs",
  "--sponsorblock-remove",
  "-o",
  "--cookies-from-browser",
  "--cookies",
]);

/** flags that consume exactly one value token */
const VALUE_ARITY = new Set([
  "--progress-template",
  "--print",
  "--download-archive",
  "--playlist-end",
  "-P",
  "-f",
  "--audio-format",
  "--ppa",
  "--merge-output-format",
  "--sub-langs",
  "--sponsorblock-remove",
  "-o",
  "--cookies-from-browser",
  "--cookies",
]);

/** classify the exact preview argv into colorable tokens. unknown flags
 * (extraArgs) classify as user — the worst case is a value rendered amber
 * instead of green, never a wrong command. */
export function classifyPreviewArgv(argv: string[]): CmdToken[] {
  const tokens: CmdToken[] = [];
  let pendingTier: "user" | "plumbing" | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    let role: CmdTokenRole;
    let tier: "user" | "plumbing" = "user";
    if (i === 0) {
      role = "prog";
    } else if (a === "--force-overwrites") {
      role = "destructive";
    } else if (PLUMBING_FLAGS.has(a)) {
      role = "plumbing";
      tier = "plumbing";
    } else if (USER_FLAGS.has(a) || a.startsWith("-")) {
      role = "user";
    } else {
      role = "value";
      tier = pendingTier ?? "user";
    }
    tokens.push({ text: a, role, tier });
    pendingTier =
      role === "user" || role === "plumbing"
        ? VALUE_ARITY.has(a)
          ? tier
          : null
        : null;
  }
  return tokens;
}
