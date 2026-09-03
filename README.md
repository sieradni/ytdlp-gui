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
m5 update+packaging · m6 polish — full plan in `docs/V2_DESIGN.md` (§12).

v1 (`gui.py`) stays untouched until v2 reaches feature parity (D32).
