# ytdlp-gui

modern windows gui for yt-dlp (v2 rewrite of `gui.py` — see `docs/V2_DESIGN.md`).

stack: **tauri 2 · react 18 · typescript · vite · tailwind v4 · zustand**.

## development

```sh
pnpm install        # once
pnpm tauri dev      # dev app with hot reload
```

the frontend alone (browser, no tauri shell): `pnpm dev`.

## checks

```sh
pnpm typecheck          # tsc --noEmit
pnpm build              # tsc + vite production build (frontend dist/)
cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings
cargo fmt --check --manifest-path src-tauri/Cargo.toml
```

## milestones

m1 scaffold+shell · m2 binary manager · m3 queue parity · m4 metadata+migration ·
m5 update+packaging · m6 polish · m7 "first real install" (engine truth, installer
& lifecycle, app-owned dialogs, design pass — D61–D73) — full plan in
`docs/V2_DESIGN.md` (§12).

v1 (`gui.py`) stays untouched until v2 reaches feature parity (D32).

## releases (m5, §8–9)

pushing a tag `v*` runs `.github/workflows/release.yml`: tauri-action builds the
unsigned nsis installer, signs the updater artifacts, and attaches `latest.json`
to the github release — the in-app updater polls that file (launch + 6 h).

ci (`.github/workflows/ci.yml`) runs the same gates as the local `## checks` on
every push and pr.

first-release setup (one-time, operator):

1. `pnpm tauri signer generate -w ~/.tauri/ytdlp-gui.key` — creates the
   minisign pair.
2. add repo secrets `TAURI_SIGNING_PRIVATE_KEY` (+ optional `_PASSWORD`).
3. paste the **public** key into `tauri.conf.json` → `plugins.updater.pubkey`
   (replacing the D56 placeholder) and set `bundle.createUpdaterArtifacts: true`
   in the same commit — until then release builds publish no updater artifacts
   at all, so ci can never publish a broken `latest.json`.
4. tag `v0.0.1` (or the real version) and let the workflow publish.
