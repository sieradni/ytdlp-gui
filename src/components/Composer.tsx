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

/** the intake verdict (§5.2): what happened to the paste, in the user's terms.
 * one shape per outcome so the surface can never render a half-filled card
 * (`dupes: 0, invalid: [], cancelled: undefined` was a card with no story). */
type IntakeFeedback =
  | { kind: "pending" }
  | { kind: "invalid"; lines: [string, string][]; dupes: number; restored: boolean }
  | { kind: "duplicates"; dupes: number }
  | { kind: "cancelled"; restored: boolean }
  | { kind: "failed"; message: string; restored: boolean };

/** an ipc rejection is not always a string: tauri can hand back an `Error`, a
 * bare string, or a serde object. none of them may reach the user as
 * "[object Object]" or "Error: Error: …". */
function readableError(e: unknown): string {
  let raw: unknown = e;
  if (e instanceof Error) raw = e.message;
  else if (e && typeof e === "object") {
    const m = (e as { message?: unknown }).message;
    raw = typeof m === "string" ? m : JSON.stringify(e);
  }
  const msg = String(raw ?? "")
    .replace(/^Error:\s*/, "")
    .trim();
  return msg || "no reason given";
}

export default function Composer() {
  const { settings } = useSettings();
  const add = useQueue((s) => s.add);
  const [urls, setUrls] = useState("");
  // did the user edit the box after submitting? a programmatic restore of the
  // rejected lines must never overwrite new typing, and the verdict must not
  // claim a restore that did not happen (ref, not state: restore reads it in
  // the same tick the submission resolves).
  const typedSince = useRef(false);
  const [dest, setDest] = useState(settings.destination ?? "");
  // settings load async — adopt the stored destination once it arrives,
  // unless the user already typed a destination this session.
  const [destTouched, setDestTouched] = useState(false);
  useEffect(() => {
    const stored = settings.destination;
    if (!destTouched && stored && !dest) setDest(stored);
  }, [settings.destination, destTouched, dest]);

  const [advOpen, setAdvOpen] = useState(false);
  // intake verdict — only the part the queue rows CANNOT show: lines it
  // refused (with reasons), urls that were already queued, and cancellations.
  // an accepted url is its own receipt: it appears in the queue with its own
  // state and progress, which is where the user watches it from here on
  // (d100 — "1 queued" was a second copy of a row that just appeared).
  const [feedback, setFeedback] = useState<IntakeFeedback | null>(null);
  // one submission at a time — a disabled button alone cannot stop the enter
  // key, and a double submit would queue the same paste twice.
  const [busy, setBusy] = useState(false);
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
    // enter-mashing must not queue the same paste twice while the gate or the
    // engine round-trip is still running.
    if (busy) return;
    const typed = urls;
    const lines = typed.split(/[\n,;]+/);
    if (!lines.some((l) => l.trim())) return; // empty composer: no-op
    // d100 — accepted urls leave the box the instant you press queue. the
    // textarea is INPUT, not a status surface: the item's life (queued →
    // fetching → downloading → done) belongs to its queue row, and a second
    // copy lingering here read as if the song were still waiting in the
    // composer. it also stops the overwrite probe below (a cold url can spend
    // up to 2.5 s there) from holding the user's text hostage.
    setUrls("");
    typedSince.current = false;
    // the verdict is the receipt for the click and it lands in the same frame:
    // the overwrite gate and the engine round-trip take a second or two, and
    // silence during that window is indistinguishable from being ignored.
    setBusy(true);
    setFeedback({ kind: "pending" });
    // hand the text back only when the user hasn't started typing something
    // new in the meantime — their keystrokes always win over a restore. the
    // verdict reports the real outcome (see `restored`) rather than assuming.
    let restored = false;
    const restore = (text: string) => {
      if (typedSince.current) return;
      setUrls(text);
      restored = true;
    };
    let added = false;
    try {
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
            // nothing was queued and nothing was rejected: the text belongs
            // back in the box, exactly as it was
            restore(typed);
            setFeedback({ kind: "cancelled", restored });
            return;
          }
          // per-call only: the composer's visible state (and the D19 mirror,
          // which must keep reflecting it) stay untouched
          queueOpts = { ...opts, overwrite: true };
        }
      }
      let fb: Awaited<ReturnType<typeof add>>;
      try {
        fb = await add(lines, queueOpts, dest || undefined);
        added = true;
      } catch (e) {
        // the engine refused the whole batch — the text must not vanish with it
        restore(typed);
        setFeedback({ kind: "failed", message: readableError(e), restored });
        return;
      }
      // a rejected line is the user's text to fix: it goes back in the box,
      // never mixed with the accepted ones (§5.2). accepted items are already
      // queue rows — the list is the acknowledgement.
      if (fb.invalid.length > 0) {
        restore(fb.invalid.map(([line]) => line.trim()).join("\n"));
        setFeedback({ kind: "invalid", lines: fb.invalid, dupes: fb.duplicatesSkipped, restored });
      } else if (fb.duplicatesSkipped > 0) {
        setFeedback({ kind: "duplicates", dupes: fb.duplicatesSkipped });
      } else {
        setFeedback(null); // every line became a row — the queue is the receipt
      }
    } catch (e) {
      // a throw outside the add round-trip (the confirm dialog, a gate fault)
      // still owes the user an answer and must never lose their text
      if (!added) restore(typed);
      setFeedback({ kind: "failed", message: readableError(e), restored });
    } finally {
      setBusy(false);
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
          onChange={(e) => {
            // typing means the rejected text is no longer what the box holds,
            // so a verdict about the previous paste must not linger. the
            // programmatic restore writes state directly and cannot clear its
            // own message.
            typedSince.current = true;
            setUrls(e.target.value);
            setFeedback((f) => (f && f.kind !== "pending" ? null : f));
          }}
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
          aria-invalid={feedback?.kind === "invalid" || feedback?.kind === "failed" ? true : undefined}
        />

        {/* §5.2 verdict: directly under the textarea — the place the eye is
            already at after enter. it used to render below every option on
            the card, which on a short window is off-screen, so a rejected
            paste read as silence. */}
        {feedback && <IntakeVerdict feedback={feedback} onDismiss={() => setFeedback(null)} />}

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
          <button className="btn primary" onClick={queue} disabled={busy}>
            {busy ? "queueing…" : "queue downloads"}
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

/** §5.2's rejection surface. one card per outcome, and every card says what
 * happened AND what to do next — an error the user cannot act on is a dead
 * end, and an error that is not where the user is looking is not an error at
 * all. live region: screen readers announce it the moment it lands. */
function IntakeVerdict({ feedback, onDismiss }: { feedback: IntakeFeedback; onDismiss: () => void }) {
  if (feedback.kind === "pending") {
    return (
      <div className="intake" data-tone="pending" role="status" aria-live="polite">
        checking the link…
      </div>
    );
  }
  const close = (
    <button className="intake-x" onClick={onDismiss} title="dismiss" aria-label="dismiss">
      ✕
    </button>
  );
  const head = (title: string) => (
    <div className="intake-head">
      <span className="intake-title">{title}</span>
      <span className="grow" />
      {close}
    </div>
  );

  if (feedback.kind === "duplicates") {
    return (
      <div className="intake" data-tone="notice" role="status">
        {head(
          feedback.dupes === 1
            ? "already in the queue"
            : `all ${feedback.dupes} are already in the queue`,
        )}
        <div className="intake-next">nothing new was added</div>
      </div>
    );
  }
  if (feedback.kind === "cancelled") {
    return (
      <div className="intake" data-tone="notice" role="status">
        {head("nothing queued")}
        <div className="intake-next">
          the file already exists — press queue downloads again to replace it
        </div>
      </div>
    );
  }
  if (feedback.kind === "failed") {
    return (
      <div className="intake" role="alert">
        {head("couldn't queue")}
        <div className="intake-line">{feedback.message}</div>
        <div className="intake-next">
          {feedback.restored
            ? "your text is back in the box — nothing was lost"
            : "the text you typed since was kept — nothing was lost"}
        </div>
      </div>
    );
  }
  // invalid: the line could not become a row. the reason is the engine's own
  // words (d101 keeps line and reason as separate fields so a reason that
  // echoes the line cannot read as a stutter).
  const n = feedback.lines.length;
  return (
    <div className="intake" role="alert">
      <div className="intake-head">
        <span className="intake-title">
          {n === 1 ? "1 line couldn't be queued" : `${n} lines couldn't be queued`}
        </span>
        {feedback.dupes > 0 && (
          <span className="intake-sub">
            {feedback.dupes === 1 ? "1 other was already queued" : `${feedback.dupes} others were already queued`}
          </span>
        )}
        <span className="grow" />
        {close}
      </div>
      {feedback.lines.map(([line, reason]) => (
        <div key={line} className="intake-line">
          <div className="intake-src">
            <span className="intake-mark" aria-hidden="true">
              ✕
            </span>{" "}
            {line}
          </div>
          <div className="intake-reason">{reason}</div>
        </div>
      ))}
      <div className="intake-next">
        {feedback.restored
          ? "the rejected line is back in the box — fix it and press enter again"
          : "the text you typed since was kept — the rejected line was not restored"}
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
