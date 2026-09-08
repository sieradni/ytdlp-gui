import { useEffect, useMemo, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { confirmDialog } from "./ConfirmDialog";
import { useQueue } from "../stores/queue";
import { useSettings } from "../stores/settings";
import { migrationStatus, overwriteTargets, type AudioFormat, type JobOptions, type PlaylistMode } from "../lib/ipc";
import { buildPreviewArgs, classifyPreviewArgv, displayArgv, type CmdToken } from "../lib/cmdPreview";
// d88: the D19 mirror moved to its own module (history + the queue's retry
// read it; importing a component for one variable dragged the composer into
// every consumer's graph). this file keeps writing through setComposerOptions.
import { setComposerOptions } from "../lib/composeMirror";
import { defaultOptions } from "../lib/defaults";

const FORMAT_NOTES: Partial<Record<AudioFormat, string>> = {
  best: "",
  mp3: "re-encode: universal compatibility, larger than opus at same quality",
  m4a: "re-encode: aac — plays everywhere, good for cars and older devices",
  opus: "re-encode: best size/quality for music",
  vorbis: "re-encode: open codec, less universal than opus/mp3",
  flac: "re-encode to lossless container: quality is limited by the source — lossless on bandcamp, lossy on youtube (~130–160k). bigger file, not better sound",
  alac: "re-encode to apple lossless: same caveat — limited by the lossy source on most sites",
  wav: "re-encode: uncompressed, very large files from a lossy source",
  mka: "remux: container swap only — stream copy, lossless and near-instant",
  mp4container: "remux: container swap only — stream copy, lossless and near-instant",
};

const PLAYLIST_HINTS: Record<PlaylistMode, string> = {
  single: "ignores the list part of the url",
  all: "downloads every item, playlist order",
  firstn: "first n items from the start of the playlist",
};

export default function Composer() {
  const { settings } = useSettings();
  const add = useQueue((s) => s.add);
  const [urls, setUrls] = useState("");
  const [dest, setDest] = useState(settings.destination ?? "");
  // settings load async — adopt the stored destination once it arrives,
  // unless the user already typed a destination this session.
  const [destTouched, setDestTouched] = useState(false);
  useEffect(() => {
    const stored = settings.destination;
    if (!destTouched && stored && !dest) setDest(stored);
  }, [settings.destination, destTouched, dest]);

  const [advOpen, setAdvOpen] = useState(false);
  const [feedback, setFeedback] = useState<{
    queued: number;
    dupes: number;
    invalid: [string, string][];
    overwriteCancelled?: boolean;
  } | null>(null);
  const [copied, setCopied] = useState(false);

  // d85 — the home destination is a home setting: once the user edits it
  // (or picks via browse), it saves to settings immediately, so reloads,
  // re-downloads (D19) and the settings page all agree. the pre-edit
  // adoption from settings stays one-way (this field may still follow the
  // setting until first touched).
  const saveDest = (v: string) => {
    setDestTouched(true);
    setDest(v);
    void useSettings.getState().update({ destination: v.trim() ? v : null });
  };

  const [opts, setOpts] = useState<JobOptions>({ ...defaultOptions(), cookies: { kind: "none", browser: null, file: null } });
  const settingsLoaded = useSettings((s) => s.loaded);

  const patch = (p: Partial<JobOptions>) => {
    touched.current = true;
    // event-handler-only helper: the closure `opts` is the committed state
    // here, so a plain set is correct — and keeps every side effect (mirror
    // write, settings persist) OUT of the state updater, which react runs
    // during render ("cannot update a component while rendering a different
    // component", caught live by the e2e run's console relay).
    const next = { ...opts, ...p };
    setOpts(next);
    setComposerOptions(next); // keep the D19 mirror in sync
    // d86: advanced options persist — a cookie source chosen once survives
    // relaunch. overwrite is excluded (destructive, per-action by design).
    const { overwrite: _ow, ...persist } = next;
    void useSettings.getState().update({ composeOpts: persist as JobOptions });
  };

  // d86: seed the composer from persisted options once settings have
  // loaded (they load async at app boot — seeding at mount would read
  // defaults). priority: user's persisted compose options > one-shot v1
  // migration > defaults. respects the touched latch.
  const seededCompose = useRef(false);
  useEffect(() => {
    if (seededCompose.current || !settingsLoaded) return;
    seededCompose.current = true;
    const saved = useSettings.getState().settings.composeOpts;
    if (saved && !touched.current) {
      setOpts((o) => {
        // saved never carries overwrite (stripped at persist time); re-add
        // the live default so the shape stays a full JobOptions
        const next: JobOptions = { ...o, ...saved, overwrite: o.overwrite };
        setComposerOptions(next);
        return next;
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settingsLoaded]);

  // §11 migration: once, on mount, adopt the migrated v1 composer defaults —
  // but never after the user has touched a control this session, and never
  // over options the user persisted themselves (d86: those win — otherwise
  // the migration would clobber saved cookies on every launch of a migrated
  // profile).
  const touched = useRef(false);
  useEffect(() => {
    void migrationStatus().then((report) => {
      if (!report?.migratedOptions || touched.current) return;
      if (useSettings.getState().settings.composeOpts) return;
      setOpts((o) => {
        const next = { ...o, ...report.migratedOptions! };
        setComposerOptions(next);
        return next;
      });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // d83 — the queue click used to pay the d60 overwrite gate's probe latency
  // inline (memo-cold single-video urls: a full yt-dlp round-trip, capped at
  // 2.5 s), which read as “stuck input”. the probe is now pre-warmed as the
  // user types (debounced 500 ms, memoized — a warm gate resolves in ~0 ms),
  // and the click's own race cap drops 2500 → 1200 ms so a cold probe can
  // never hold the click more than about a second. the engine still reports
  // the truth per d28 when the gate races out.
  const warmedUrls = useRef("");
  useEffect(() => {
    if (opts.playlistMode !== "single") return;
    const t = setTimeout(() => {
      const singles = urls
        .split(/[\n,;]+/)
        .map((l) => l.trim())
        .filter(Boolean);
      if (!singles.length) return;
      const sig = singles.join("\n");
      if (sig === warmedUrls.current) return; // already warm
      warmedUrls.current = sig;
      overwriteTargets(singles, true, opts.skipDownloaded).catch(() => {});
    }, 500);
    return () => clearTimeout(t);
  }, [urls, opts.playlistMode, opts.skipDownloaded]);

  const urlCount = urls.split("\n").filter((l) => l.trim()).length;
  const note = opts.dlType === "audio" ? FORMAT_NOTES[opts.audioFormat] ?? "" : "";

  const previewArgv = useMemo(
    () => buildPreviewArgs(opts, dest || "<destination>", opts.skipDownloaded ? "<archive>" : null),
    [opts, dest],
  );
  const argv = useMemo(() => displayArgv(previewArgv), [previewArgv]);
  // C5: classified tokens drive the tiered, color-coded preview
  const tokens = useMemo(() => classifyPreviewArgv(previewArgv), [previewArgv]);
  const [showPlumbing, setShowPlumbing] = useState(false);

  const pickFolder = async (current: string) => {
    const picked = await open({ directory: true, defaultPath: current || undefined });
    return typeof picked === "string" ? picked : null;
  };

  const queue = async () => {
    const lines = urls.split(/[\n,;]+/);
    // d60 — same gate as history's ↻, at queue time: single-video jobs that
    // would land on an existing destination file confirm first. over-asks
    // are impossible (exact id match), under-asks only when the probe
    // errors (the engine surfaces that anyway). playlists are excluded —
    // yt-dlp's --download-archive already covers their re-runs.
    let queueOpts = opts;
    if (opts.playlistMode === "single" && !opts.overwrite) {
      const singles = lines.map((l) => l.trim()).filter(Boolean);
      let targets: Awaited<ReturnType<typeof overwriteTargets>> = [];
      try {
        // the gate must never stall the queue click on a slow/unreachable
        // url (yt-dlp's generic extractor waits ~20s on a connect timeout):
        // race the probe with a bounded cap — unresolvable-in-time = queue
        // anyway. d89: the engine's pre-spawn gate is the race-free backstop,
        // so a miss here lands as a clear refusal row, never a silent
        // overwrite or a silent no-op skip.
        targets = await Promise.race([
          overwriteTargets(singles, true, opts.skipDownloaded).catch(() => []),
          new Promise<Awaited<ReturnType<typeof overwriteTargets>>>((r) => setTimeout(() => r([]), 2500)),
        ]);
      } catch {
        targets = []; // probe unavailable → queue unguarded (engine reports)
      }
      if (targets.length > 0) {
        const list = targets.map((t) => `“${t.name}”`).join("\n");
        // m7-b: in-app confirm (chime + modal) replaces the windows task dialog
        const ok = await confirmDialog({
          title: "file already exists",
          body: `${list} already exists in the destination.\n\nQueuing replaces it with a fresh download (metadata re-embedded) using the current composer settings.`,
          confirmLabel: "overwrite",
          cancelLabel: "cancel",
        });
        if (!ok) {
          setFeedback({ queued: 0, dupes: 0, invalid: [], overwriteCancelled: true });
          return;
        }
        // per-call only: the composer's visible state (and the D19 mirror,
        // which must keep reflecting it) stay untouched
        queueOpts = { ...opts, overwrite: true };
      }
    }
    const fb = await add(lines, queueOpts, dest || undefined);
    setFeedback({
      queued: fb.jobs.length,
      dupes: fb.duplicatesSkipped,
      invalid: fb.invalid,
    });
    // accepted lines clear; invalid stay for fixing (§5.2)
    if (fb.invalid.length === 0) {
      setUrls("");
    } else {
      const bad = new Set(fb.invalid.map(([line]) => line.trim()));
      setUrls((u) =>
        u
          .split(/[\n,;]+/)
          .filter((l) => !bad.has(l.trim()))
          .join("\n"),
      );
    }
  };

  const webmWarn = opts.dlType === "video" && opts.container === "webm";
  // d88: wav can't hold embedded art either (yt-dlp errors the job, not a
  // graceful skip) — the engine now skips the flag; the ui must say why.
  const wavWarn = opts.dlType === "audio" && opts.audioFormat === "wav" && opts.coverMode !== "none";
  const isVideo = opts.dlType === "video";

  return (
    <div className="card">
      <div className="card-h">
        <h2>add downloads</h2>
        <span className="hint">one url per line · enter to queue</span>
      </div>
      <div className="card-b">
        <textarea
          rows={2}
          value={urls}
          onChange={(e) => setUrls(e.target.value)}
          onKeyDown={(e) => {
            // enter queues (§6 keyboard/ux polish); shift+enter inserts a
            // newline for multi-line pastes. IME compositions must not be
            // hijacked (isComposing). empty composer: no-op, no feedback
            // spam.
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              if (urlCount > 0) void queue();
            }
          }}
          placeholder="https://www.youtube.com/watch?v=…"
        />

        <div className="fgrid" style={{ marginTop: 10 }}>
          <label>destination</label>
          <div className="flex items-center gap-2 min-w-0">
            <input
              type="text"
              className="grow"
              value={dest}
              placeholder="windows downloads folder (default set in settings)"
              onChange={(e) => saveDest(e.target.value)}
            />
            <button
              className="btn sm"
              onClick={async () => {
                const picked = await pickFolder(dest);
                if (picked) saveDest(picked);
              }}
            >
              …
            </button>
          </div>

          <label>type</label>
          <div className="flex items-center">
            <div className="seg">
              <button className={!isVideo ? "on" : ""} onClick={() => patch({ dlType: "audio", coverMode: "square" })}>
                audio
              </button>
              <button className={isVideo ? "on" : ""} onClick={() => patch({ dlType: "video", coverMode: "original" })}>
                video
              </button>
            </div>
          </div>

          {!isVideo && (
            <>
              <label>convert to</label>
              <div className="flex items-center min-w-0">
                <select
                  className="grow"
                  style={{ maxWidth: 290 }}
                  value={opts.audioFormat}
                  onChange={(e) => patch({ audioFormat: e.target.value as AudioFormat })}
                >
                  <optgroup label="no conversion">
                    <option value="best">keep original (no processing)</option>
                  </optgroup>
                  <optgroup label="re-encode (ffmpeg)">
                    <option value="mp3">mp3</option>
                    <option value="m4a">m4a / aac</option>
                    <option value="opus">opus</option>
                    <option value="vorbis">vorbis</option>
                    <option value="flac">flac (lossless)</option>
                    <option value="alac">alac (lossless)</option>
                    <option value="wav">wav (uncompressed)</option>
                  </optgroup>
                  <optgroup label="remux (lossless, instant)">
                    <option value="mka">mka container</option>
                    <option value="mp4container">mp4 container</option>
                  </optgroup>
                </select>
              </div>
              {note && (
                <div className="hint" style={{ gridColumn: "1/-1" }}>
                  {note}
                </div>
              )}
              {wavWarn && (
                <div className="warn" style={{ gridColumn: "1/-1" }}>
                  wav can't hold cover art — art will be skipped
                </div>
              )}
            </>
          )}

          <label>cover art</label>
          <div className="flex items-center gap-2 flex-wrap">
            <select
              value={opts.coverMode}
              onChange={(e) => patch({ coverMode: e.target.value as JobOptions["coverMode"] })}
            >
              <option value="square">square (embed)</option>
              <option value="original">original shape (embed)</option>
              <option value="custom">custom size…</option>
              <option value="none">none</option>
            </select>
            {opts.coverMode === "custom" && (
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  style={{ width: 58 }}
                  value={opts.coverW}
                  onChange={(e) => patch({ coverW: Number(e.target.value) || 0 })}
                />
                <span className="hint">×</span>
                <input
                  type="text"
                  style={{ width: 58 }}
                  value={opts.coverH}
                  onChange={(e) => patch({ coverH: Number(e.target.value) || 0 })}
                />
              </div>
            )}
          </div>

          {isVideo && (
            <>
              <label>max resolution</label>
              <div className="flex items-center gap-2">
                <select
                  value={opts.maxResolution}
                  onChange={(e) => patch({ maxResolution: e.target.value })}
                >
                  {["best", "4320p", "2160p", "1440p", "1080p", "720p", "480p", "360p"].map((r) => (
                    <option key={r}>{r}</option>
                  ))}
                </select>
                <span className="hint">cap — picks best at or below it</span>
              </div>

              <label>container</label>
              <div className="flex items-center gap-2">
                <select
                  value={opts.container}
                  onChange={(e) => patch({ container: e.target.value as JobOptions["container"] })}
                >
                  <option value="mp4">mp4</option>
                  <option value="mkv">mkv</option>
                  <option value="webm">webm</option>
                </select>
                {webmWarn && (
                  <span className="warn">webm can't embed thumbnails — cover art will be skipped</span>
                )}
              </div>

              <label>audio in video</label>
              <div className="flex items-center gap-2 min-w-0">
                <select
                  value={opts.audioPref}
                  onChange={(e) => patch({ audioPref: e.target.value as JobOptions["audioPref"] })}
                >
                  <option value="opus">opus — smaller, some players can't play it</option>
                  <option value="aac">aac — universal compatibility</option>
                </select>
                <span className="hint">{opts.container === "webm" && opts.audioPref === "aac" ? "webm can't hold aac — opus is used regardless" : "picks the audio stream; other sites may serve different ones"}</span>
              </div>
            </>
          )}

          <label>playlists</label>
          <div className="flex items-center gap-2 flex-wrap">
            <div className="seg">
              {(["single", "all", "firstn"] as const).map((m) => (
                <button
                  key={m}
                  className={opts.playlistMode === m ? "on" : ""}
                  onClick={() => patch({ playlistMode: m })}
                >
                  {m === "single" ? "single video only" : m === "all" ? "entire playlist" : "first n…"}
                </button>
              ))}
            </div>
            {opts.playlistMode === "firstn" && (
              <input
                type="text"
                style={{ width: 54 }}
                value={opts.playlistN}
                onChange={(e) => patch({ playlistN: Number(e.target.value) || 1 })}
              />
            )}
            <span className="hint">{PLAYLIST_HINTS[opts.playlistMode]}</span>
          </div>

          <label>skip downloaded</label>
          <div className="flex items-center gap-2">
            <label className="toggle">
              <input
                type="checkbox"
                checked={opts.skipDownloaded}
                onChange={(e) => patch({ skipDownloaded: e.target.checked })}
              />
              <span className="track" />
            </label>
            <span className="hint">record in downloaded archive</span>
          </div>
        </div>

        <div className="divider" />

        {/* C5: the redesigned command preview — two tiers, color roles.
         * amber = flags you chose (they change your result), dim = engine
         * plumbing (collapsed until asked), green = values, red =
         * destructive. argument order among these flags does not matter;
         * this is the exact argv, so it is always truthful. text is
         * selectable (C4); the copy button copies the exact line. */}
        <CmdPreview
          tokens={tokens}
          plain={argv}
          showPlumbing={showPlumbing}
          onTogglePlumbing={() => setShowPlumbing((v) => !v)}
          copied={copied}
          onCopy={() => {
            void navigator.clipboard.writeText(argv);
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          }}
        />

        <div className="flex items-center gap-2" style={{ marginTop: 10 }}>
          <button className="btn primary" onClick={queue}>
            queue downloads
          </button>
          <button
            className="btn ghost"
            onClick={() => {
              setUrls("");
              setFeedback(null);
            }}
          >
            clear
          </button>
          <button className="btn ghost" onClick={() => setAdvOpen((v) => !v)}>
            advanced {advOpen ? "▴" : "▾"}
          </button>
          <span className="grow" />
          <span className="hint">
            {urlCount} {urlCount === 1 ? "url" : "urls"}
          </span>
        </div>

        {feedback && (
          <div
            style={{
              marginTop: 8,
              border: "1px solid var(--amber-border)",
              borderRadius: 4,
              padding: "8px 10px",
            }}
          >
            <span style={{ fontSize: 12 }}>
              {feedback.overwriteCancelled
                ? "queueing cancelled — file already exists (nothing queued)"
                : `${feedback.queued} queued · ${feedback.dupes} duplicates skipped · ${feedback.invalid.length} invalid`}
            </span>
            {feedback.invalid.map(([line, reason]) => (
              <div key={line} className="warn" style={{ overflowWrap: "anywhere" }}>
                ✕ {line} — {reason}
              </div>
            ))}
          </div>
        )}

        {advOpen && (
          <>
            <div className="divider" />
            <div className="fgrid">
              <label>subtitles</label>
              <input
                type="text"
                placeholder="language codes, comma-separated (empty = none)"
                value={opts.subtitleLangs.join(",")}
                onChange={(e) =>
                  patch({
                    subtitleLangs: e.target.value
                      .split(",")
                      .map((s) => s.trim())
                      .filter(Boolean),
                  })
                }
              />
              <label></label>
              <div className="flex items-center gap-2">
                <label className="toggle">
                  <input
                    type="checkbox"
                    checked={opts.autoCaptions}
                    onChange={(e) => patch({ autoCaptions: e.target.checked })}
                  />
                  <span className="track" />
                </label>
                <span className="hint">auto captions</span>
              </div>
              <label>cookies</label>
              <div className="flex items-center gap-2 min-w-0">
                <select
                  style={{ maxWidth: 180 }}
                  value={opts.cookies.kind}
                  onChange={(e) =>
                    patch({
                      cookies: {
                        ...opts.cookies,
                        kind: e.target.value as JobOptions["cookies"]["kind"],
                        // d84: entering a mode must be complete — the browser
                        // dropdown only sets its value on change, so switching
                        // to "from browser…" used to leave browser=null: no
                        // flag in the preview and none at run time
                        ...(e.target.value === "frombrowser" && !opts.cookies.browser
                          ? { browser: "firefox" }
                          : {}),
                      },
                    })
                  }
                >
                  <option value="none">don't use</option>
                  <option value="frombrowser">from browser…</option>
                  <option value="file">cookies.txt file…</option>
                </select>
                {opts.cookies.kind === "frombrowser" && (
                  <select
                    className="grow"
                    style={{ maxWidth: 140 }}
                    value={opts.cookies.browser ?? "firefox"}
                    onChange={(e) => patch({ cookies: { ...opts.cookies, browser: e.target.value } })}
                  >
                    {["firefox", "chrome", "edge", "brave", "chromium", "opera", "safari"].map((b) => (
                      <option key={b}>{b}</option>
                    ))}
                  </select>
                )}
                {opts.cookies.kind === "file" && (
                  <button
                    className="btn sm"
                    onClick={async () => {
                      const picked = await open({
                        multiple: false,
                        filters: [{ name: "cookies.txt", extensions: ["txt"] }],
                      });
                      if (typeof picked === "string") patch({ cookies: { ...opts.cookies, file: picked } });
                    }}
                  >
                    {opts.cookies.file ? "file chosen ✓" : "choose file…"}
                  </button>
                )}
                <span className="hint">exports your browser session — sensitive, never saved</span>
              </div>
              <label>sponsorblock</label>
              <div className="flex items-center gap-2 flex-wrap">
                {["sponsor", "selfpromo", "interaction", "intro", "outro", "preview", "filler"].map((c) => (
                  <label key={c} className="flex items-center gap-1 hint" style={{ fontSize: 12 }}>
                    <input
                      type="checkbox"
                      checked={opts.sponsorblock.includes(c)}
                      onChange={(e) =>
                        patch({
                          sponsorblock: e.target.checked
                            ? [...opts.sponsorblock, c]
                            : opts.sponsorblock.filter((x) => x !== c),
                        })
                      }
                    />
                    {c}
                  </label>
                ))}
              </div>
              <label>extra args</label>
              <div>
                <input
                  type="text"
                  placeholder="passed to yt-dlp as-is"
                  onChange={(e) =>
                    patch({
                      extraArgs: e.target.value.match(/(?:[^\s"]+"[^"]*"?)+|(?:\S+)/g) ?? [],
                    })
                  }
                />
                <div className="warn" style={{ marginTop: 4 }}>
                  ⚠ wrong flags here can break downloads
                </div>
              </div>
              <label>output template</label>
              <input
                type="text"
                placeholder="%(title)s [%(id)s].%(ext)s"
                onChange={(e) => patch({ outputTemplate: e.target.value || null })}
              />
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/** C5: tiered, color-coded command preview. tier "user" always shows;
 * tier "plumbing" collapses behind the toggle. roles: amber user flags,
 * dim plumbing, green values, red destructive. */
function CmdPreview(props: {
  tokens: CmdToken[];
  plain: string;
  showPlumbing: boolean;
  onTogglePlumbing: () => void;
  copied: boolean;
  onCopy: () => void;
}) {
  const visible = props.tokens.filter((t) => props.showPlumbing || t.tier === "user");
  const plumbingCount = props.tokens.filter((t) => t.tier === "plumbing").length;
  return (
    <div className="cmdprev">
      <div className="cmdprev-head">
        <span className="hint">command preview — the exact argv</span>
        <span className="grow" />
        {plumbingCount > 0 && (
          <button className="btn sm ghost" onClick={props.onTogglePlumbing}>
            {props.showPlumbing ? "hide engine details" : `show engine details (${plumbingCount})`}
          </button>
        )}
        <button className="btn sm ghost" onClick={props.onCopy}>
          {props.copied ? "copied ✓" : "copy"}
        </button>
      </div>
      <div className="cmd-preview cmdprev-body">
        {visible.map((t, i) => (
          <span key={i} className={`cmdtok cmdtok-${t.role}`}>
            {t.text.includes(" ")
              ? `"${t.text.replace(/"/g, '\\"')}"`
              : t.text}{" "}
          </span>
        ))}
        {props.copied && <span className="cmdtok-copied">— copied</span>}
      </div>
    </div>
  );
}
