# ytdlp-gui

Windows desktop GUI for [yt-dlp](https://github.com/yt-dlp/yt-dlp). Paste URLs, pick options, queue downloads.

Stack: Tauri 2 · React 18 · TypeScript · Vite · Tailwind v4 · Zustand · SQLite.

## Features

- **Queue:** multiple URLs at once, pause / resume / retry / stop, concurrency 1–4, live progress with speed / ETA and per-job logs.
- **Formats:** audio (mp3 / m4a / opus / vorbis / flac / alac / wav) or video (mp4 / mkv / webm) with resolution cap, subtitles, cover art, playlist selection (single / all / first N).
- **Power options:** cookies (none / browser / file), SponsorBlock, custom output template, extra yt-dlp args, color-coded command preview.
- **Dedupe:** skip-downloaded archive, duplicate detection, overwrite confirmation.
- **History:** searchable, re-download, show-in-folder / relink, archive import / export / sync (`downloaded.txt`).
- **Self-managing tools:** first-run wizard downloads verified yt-dlp + ffmpeg into the app data dir; per-tool check / update, custom-path override, v1 (`gui.py`) config + archive migration.
- **Self-updating app:** checks on launch (plus manual check in Settings), signature-verified install + restart.

## Install

1. Download the NSIS installer from [Releases](https://github.com/sieradni/ytdlp-gui/releases/latest).
2. Run it (current-user, no admin needed).
3. On first launch the wizard installs yt-dlp + ffmpeg automatically.

No manual yt-dlp / ffmpeg setup required.

## Use

1. Paste one URL per line, pick destination and options.
2. `Queue downloads`, watch progress in Home.
3. Find past downloads in History; app settings and tool updates in Settings.

Data lives in `%APPDATA%\ytdlp-gui\` (`settings.json`, `history.db`, `downloaded.txt`, `bin\`). Reset is available in Settings (keeps `bin\`).

## Development

```sh
pnpm install        # once
pnpm tauri dev      # full app with hot reload
pnpm dev            # frontend only (browser, no Tauri shell)
```

Checks (also run in CI on every push / PR):

```sh
pnpm typecheck          # tsc --noEmit
pnpm build              # tsc + vite build
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo test --manifest-path src-tauri/Cargo.toml
```

`gui.py` is the legacy v1 client, kept untouched; v2 migrates its config and archive on first run.

## Releases

Pushing a tag `v*` runs `.github/workflows/release.yml`: builds the NSIS installer, signs the updater artifacts, and publishes the GitHub release with `latest.json` for the in-app updater. Versions are `v2.0.0-alpha.N` until GA.

## License

Apache-2.0 — see [LICENSE](LICENSE).
