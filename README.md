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
& lifecycle, app-owned dialogs, design pass — D61–D84) — full plan in
`docs/V2_DESIGN.md` (§12).

v1 (`gui.py`) stays untouched until v2 reaches feature parity (D32).

## releases (m5, §8–9)

pushing a tag `v*` runs `.github/workflows/release.yml`: tauri-action builds the
nsis installer, signs the updater artifacts with the repo's minisign key, and
attaches `latest.json` to the github release — the in-app updater polls that
file (launch + 6 h) and verifies signatures before installing (D56).

**alpha-testing the updater:** the updater's endpoint resolves via github's
`releases/latest` URL, which only ever points at a **non-prerelease** release.
ci publishes every tag as a prerelease (safe default), so after tagging an
alpha meant for real update testing, run:

```
gh release edit v2.0.0-alpha.N --prerelease=false --latest
```

until then the app shows "update check failed: could not fetch a valid release
json" — that is the endpoint 404ing, not a broken pipeline. older alphas that
never became "latest" simply never receive update offers (by design).

ci (`.github/workflows/ci.yml`) runs the same gates as the local `## checks` on
every push and pr.

updater signing (done, m7 close-out — for reference):

1. `pnpm tauri signer generate -w ~/.tauri/ytdlp-gui.key` — creates the
   password-encrypted minisign pair (private key + password stay in
   `~/.tauri/` on the operator machine; **back both up** — losing either
   permanently breaks future in-app updates).
2. repo secrets set via `gh secret set`: `TAURI_SIGNING_PRIVATE_KEY` = the
   **raw key file text** (not base64 — the bundler decodes base64 itself),
   `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` = the key password.
3. the **base64 public key** is pinned in `tauri.conf.json` →
   `plugins.updater.pubkey`, and `bundle.createUpdaterArtifacts: true`.

releases are versioned `v2.0.0-alpha.N` prereleases until ga.
