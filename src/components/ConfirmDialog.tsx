/**
 * app-owned confirm dialog (replaces windows-native message boxes, m7-b).
 *
 * why: the D59/D60 overwrite confirmations popped an OS task dialog —
 * off-brand, unstyled, and unreliable to automate. this renders in-app on
 * the design tokens, plays a short two-note chime (WebAudio, generated —
 * no asset), and exposes data-* hooks the e2e driver can click
 * deterministically.
 *
 * api mirrors the old ask(): a module-level promise the caller awaits; the
 * dialog mounts in App so it overlays every page and the wizard.
 */

import { useEffect, useRef, useState } from "react";

interface ConfirmSpec {
  title: string;
  body: string;
  confirmLabel: string;
  cancelLabel: string;
  kind: "warning" | "info";
}

interface ConfirmState extends ConfirmSpec {
  resolve: (ok: boolean) => void;
  /** which __cdlg request this modal instance answers (id-scoped ground truth) */
  reqId?: number;
}

let openConfirm: ((spec: ConfirmSpec) => Promise<boolean>) | null = null;

/** page-side ground truth for drivers: the live request and, once set, its
 * resolution. e2e (and any automation) resolves from THIS instead of the
 * click's return value — a lost CDP response can then never deadlock a
 * poller that already clicked. state persists across module reloads (HMR),
 * so a stale pre-reload resolution is dropped by its old id. */
declare global {
  interface Window {
    __cdlg?: { id: number; state: "open" | "resolved"; ok?: boolean };
    /** last resolution — tiny permanent diagnostic surface for drivers */
    __cdlgLast?: { ok: boolean; t: number; stack: string };
    /** module-level lifecycle log — registration, requests, resolutions.
     * permanent: cheap, capped, and the only truthful record of which
     * module instance owns the host (e2e automation depends on it). */
    __cdlgLog?: { ev: string; t: number; id?: number }[];
  }
}
let reqSeq = 0;
const logEv = (ev: string, id?: number) => {
  try {
    const log = (window.__cdlgLog ??= []);
    log.push({ ev, t: Date.now() % 1000000, id });
    if (log.length > 100) log.splice(0, log.length - 100);
  } catch { /* diagnostics never break the dialog */ }
};

/** promise-based confirm — await this where the native `ask()` used to be. */
export function confirmDialog(spec: Omit<ConfirmSpec, "kind"> & { kind?: ConfirmSpec["kind"] }): Promise<boolean> {
  if (!openConfirm) {
    // dialog host not mounted (must never happen — App mounts it) — fail
    // safe: treat as cancel so no destructive action runs unconfirmed.
    logEv("no-host");
    console.error("confirmDialog: host not mounted");
    return Promise.resolve(false);
  }
  const id = ++reqSeq;
  logEv("req", id);
  window.__cdlg = { id, state: "open" };
  return openConfirm({ kind: "warning", ...spec });
}

/** two-note chime, generated in WebAudio — no asset, ~0 bundle cost.
 * pleasant G5→C6 marimba-ish pluck; respects reduced motion (silent). */
export function playChime(): void {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  try {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const now = ctx.currentTime;
    for (const [freq, at, dur] of [
      [784.0, 0.0, 0.16], // G5
      [1046.5, 0.09, 0.22], // C6
    ] as const) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, now + at);
      gain.gain.exponentialRampToValueAtTime(0.12, now + at + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + at + dur);
      osc.connect(gain).connect(ctx.destination);
      osc.start(now + at);
      osc.stop(now + at + dur + 0.05);
    }
    // close the context once the tail decays — don't leak one per dialog
    setTimeout(() => void ctx.close().catch(() => {}), 600);
  } catch {
    // audio is garnish; never let it break the dialog
  }
}

export function ConfirmDialogHost() {
  const [state, setState] = useState<ConfirmState | null>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    logEv("host-reg");
    openConfirm = (spec) =>
      new Promise<boolean>((resolve) => {
        playChime();
        logEv("open", window.__cdlg?.id);
        setState({ ...spec, resolve, reqId: window.__cdlg?.id });
      });
    return () => {
      logEv("host-unreg");
      openConfirm = null;
    };
  }, []);

  // focus lands on cancel (the safe default for a destructive confirm);
  // Enter therefore cancels — the safest default for a destructive action.
  useEffect(() => {
    if (state) cancelRef.current?.focus();
  }, [state]);

  if (!state) return null;

  // resolve + publish ground truth. invoked only from REAL user events
  // (click / escape / backdrop), so drivers reading __cdlg.state can trust
  // "resolved" means the dialog genuinely closed.
  const finish = (ok: boolean) => {
    logEv("finish", window.__cdlg?.id);
    window.__cdlgLast = {
      ok,
      t: Date.now(),
      stack: new Error().stack?.split("\n").slice(1, 4).join(" | ") ?? "",
    };
    // id-scoped: publish the resolution and LEAVE it (the next request
    // replaces the slot). clearing here raced every driver — the resolved
    // state lasted one microtask, unobservable. a durable record is the
    // whole point of page-side ground truth.
    if (state.reqId !== undefined) {
      const g = window.__cdlg;
      if (g && g.id === state.reqId && g.state === "open") {
        window.__cdlg = { id: g.id, state: "resolved", ok };
      }
    }
    state.resolve(ok);
    setState(null);
  };

  return (
    <div
      className="cdlg-overlay"
      data-testid="confirm-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) finish(false); // backdrop click = cancel
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") finish(false);
      }}
      role="presentation"
    >
      <div
        className="cdlg"
        data-testid="confirm-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-label={state.title}
      >
        <div className="cdlg-title">
          <span className={`cdlg-icon ${state.kind}`} aria-hidden="true">
            {state.kind === "warning" ? "⚠" : "i"}
          </span>
          {state.title}
        </div>
        <div className="cdlg-body">{state.body}</div>
        <div className="cdlg-actions">
          <button
            ref={cancelRef}
            className="btn"
            data-dialog-action="cancel"
            onClick={() => finish(false)}
          >
            {state.cancelLabel}
          </button>
          <button
            className={`btn ${state.kind === "warning" ? "danger" : "primary"}`}
            data-dialog-action="confirm"
            onClick={() => finish(true)}
          >
            {state.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
