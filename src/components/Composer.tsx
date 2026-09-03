import { useEffect, useMemo, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { useQueue } from "../stores/queue";
import { useSettings } from "../stores/settings";
import { migrationStatus, type AudioFormat, type JobOptions, type PlaylistMode } from "../lib/ipc";
import { buildPreviewArgs, displayArgv } from "../lib/cmdPreview";
import { defaultOptions } from "../lib/defaults";

/**
 * the composer's live options, mirrored module-level so history's
 * re-download (D19: "what queue would do if I pasted this url now") can
 * reuse exactly what the user currently sees configured — not stored
 * per-history settings. falls back to defaults when home was never opened.
 */
export let currentOptions: JobOptions = defaultOptions();

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
  } | null>(null);
  const [copied, setCopied] = useState(false);

  const [opts, setOpts] = useState<JobOptions>({ ...defaultOptions(), cookies: { kind: "none", browser: null, file: null } });

  const patch = (p: Partial<JobOptions>) =>
    setOpts((o) => {
      const next = { ...o, ...p };
      currentOptions = next; // keep the D19 mirror in sync
      touched.current = true;
      return next;
    });

  // §11 migration: once, on mount, adopt the migrated v1 composer defaults —
  // but never after the user has touched a control this session.
  const touched = useRef(false);
  useEffect(() => {
    void migrationStatus().then((report) => {
      if (!report?.migratedOptions || touched.current) return;
      setOpts((o) => {
        const next = { ...o, ...report.migratedOptions! };
        currentOptions = next;
        return next;
      });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const urlCount = urls.split("\n").filter((l) => l.trim()).length;
  const note = opts.dlType === "audio" ? FORMAT_NOTES[opts.audioFormat] ?? "" : "";

  const argv = useMemo(
    () =>
      displayArgv(
        buildPreviewArgs(opts, dest || "<destination>", opts.skipDownloaded ? "<archive>" : null),
      ),
    [opts, dest],
  );

  const pickFolder = async (current: string) => {
    const picked = await open({ directory: true, defaultPath: current || undefined });
    return typeof picked === "string" ? picked : null;
  };

  const queue = async () => {
    const lines = urls.split(/[\n,;]+/);
    const fb = await add(lines, opts, dest || undefined);
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
  const isVideo = opts.dlType === "video";

  return (
    <div className="card">
      <div className="card-h">
        <h2>add downloads</h2>
        <span className="hint">one url per line · playlists expand · enter to queue</span>
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
              onChange={(e) => {
                setDestTouched(true);
                setDest(e.target.value);
              }}
            />
            <button
              className="btn sm"
              onClick={async () => {
                const picked = await pickFolder(dest);
                if (picked) setDest(picked);
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
                <span className="hint">picks the audio stream; other sites may serve different ones</span>
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

        <div
          className="cmd-preview"
          title="click to copy"
          onClick={() => {
            void navigator.clipboard.writeText(displayArgv(buildPreviewArgs(opts, dest || ".", opts.skipDownloaded ? "." : null)));
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          }}
        >
          {argv}
          {copied && <span style={{ color: "var(--green)" }}> — copied</span>}
        </div>

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
              {feedback.queued} queued · {feedback.dupes} duplicates skipped ·{" "}
              {feedback.invalid.length} invalid
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
                      cookies: { ...opts.cookies, kind: e.target.value as JobOptions["cookies"]["kind"] },
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
