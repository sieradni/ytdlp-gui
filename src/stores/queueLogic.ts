// d102 — the convergence rules, extracted so they can be driven without a
// webview, an engine or an event stream. `src/stores/queue.ts` wires these to
// zustand/ipc; the rules themselves are pure (types only), which is what makes
// "a row still converges when NO event is delivered" a unit test instead of a
// manual claim.
import type { Job, JobState } from "../lib/ipc";

export const ACTIVE_STATES: ReadonlySet<JobState> = new Set<JobState>([
  "queued",
  "fetching",
  "downloading",
  "post",
]);

export const TERMINAL_STATES: ReadonlySet<JobState> = new Set<JobState>([
  "done",
  "stopped",
  "error",
  "duplicate",
]);

/** monotonic phase order — a stale snapshot may not move a row backwards. */
export const STATE_RANK: Record<JobState, number> = {
  queued: 0,
  fetching: 1,
  downloading: 2,
  post: 3,
  done: 4,
  stopped: 4,
  error: 4,
  duplicate: 4,
};

/** reconcile cadence while something is in flight (idle costs no ipc). */
export const RECONCILE_MS = 1000;

/** how long the event stream may stay quiet before the db is presumed to be
 * the only truth we have. */
export const EVENT_FRESH_MS = 2500;

/** the furthest any writer has seen the bar — never null unless both are. */
function maxPct(a: number | null, b: number | null): number | null {
  if (a == null) return b;
  if (b == null) return a;
  return Math.max(a, b);
}

/**
 * Merge a pulled snapshot into the rows already on screen.
 *
 * Two invariants, both learned from the "stuck at pending" report:
 *  - **state never regresses.** The db is written by the engine one step ahead
 *    of the event stream, but responses can still arrive out of order; a
 *    snapshot that ranks below what is displayed is discarded wholesale.
 *  - **progress never regresses within a phase.** Whether or not the stream is
 *    fresh, the bar shows the furthest value either source has reported. A
 *    reconcile tick therefore cannot animate the row backwards — which is the
 *    bug that would appear if the db's ≤500 ms flush lagged the live patch.
 *
 * While the stream is fresh its byte values win (they are finer-grained than
 * the throttled db write); once it is quiet the db wins for everything except
 * the two invariants above.
 */
export function mergeRows(rows: Job[], prevJobs: Job[], opts: { live: boolean }): Job[] {
  if (prevJobs.length === 0) return rows;
  const before = new Map(prevJobs.map((j) => [j.id, j]));
  return rows.map((row) => {
    const prev = before.get(row.id);
    if (!prev) return row;
    if (row.state !== prev.state) {
      // equal rank but a different terminal state (done → error) is a real
      // correction: take the db. a LOWER rank is a stale snapshot: keep the
      // row on screen untouched.
      return STATE_RANK[row.state] < STATE_RANK[prev.state] ? prev : row;
    }
    const pct = maxPct(prev.pct, row.pct);
    if (!opts.live) {
      // stream quiet: the db's state/items/output are the only truth left,
      // but the bar keeps the furthest value it ever showed
      return { ...row, pct, thumb: row.thumb ?? prev.thumb };
    }
    return {
      ...row,
      pct,
      speedBps: prev.speedBps ?? row.speedBps,
      etaSec: prev.etaSec ?? row.etaSec,
      fetchMs: prev.fetchMs ?? row.fetchMs,
      itemTitle: prev.itemTitle ?? row.itemTitle,
      // the db only carries track records at a run boundary; mid-run the live
      // upserts are the fuller list
      items: row.items.length > 0 ? row.items : prev.items,
      output: row.output.length >= prev.output.length ? row.output : prev.output,
      thumb: row.thumb ?? prev.thumb,
    };
  });
}

/** does this queue need a pull right now? (idle queues cost nothing) */
export function needsReconcile(jobs: Job[]): boolean {
  return jobs.some((j) => ACTIVE_STATES.has(j.state));
}

export interface ReconcileLoop {
  /** arm the periodic tick; returns nothing (stop() disarms) */
  start: () => void;
  stop: () => void;
  /** one tick: pull iff something is in flight. true when it pulled. */
  tick: () => boolean;
}

/**
 * The periodic reconcile. This is the mechanism that makes convergence
 * independent of the event stream: every tick, if anything is in flight, pull
 * the authoritative rows. `queue.ts` wires `pull` to the store's coalesced
 * `sync`; the test wires it to a fake backend and delivers no events at all.
 */
export function createReconcileLoop(opts: {
  getJobs: () => Job[];
  pull: () => void;
  intervalMs?: number;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
}): ReconcileLoop {
  const setI = opts.setInterval ?? ((fn, ms) => globalThis.setInterval(fn, ms));
  const clearI = opts.clearInterval ?? ((h) => globalThis.clearInterval(h as number));
  let handle: unknown = null;
  const tick = () => {
    if (!needsReconcile(opts.getJobs())) return false;
    opts.pull();
    return true;
  };
  return {
    tick,
    start: () => {
      if (handle != null) return;
      handle = setI(tick, opts.intervalMs ?? RECONCILE_MS);
    },
    stop: () => {
      if (handle == null) return;
      clearI(handle);
      handle = null;
    },
  };
}

/** d100: the progress cell is the item's own instrument — it names the phase
 * instead of implying it, so a queued song can never read as if it were
 * downloading, and a finished one can never read as if it were still pending.
 * playlist jobs keep their item counter (D54); byte percent only exists while
 * bytes are actually moving (a stale percent is never shown, d61). */
export function progressOf(job: Job): {
  pct: number | null;
  label: string;
  tone: string;
  indeterminate?: boolean;
} {
  if (job.itemsTotal != null) {
    const done = job.itemsDone ?? 0;
    return { pct: (done / job.itemsTotal) * 100, label: `${done}/${job.itemsTotal}`, tone: job.state };
  }
  switch (job.state) {
    case "fetching":
      // honest liveness — the identity probe is running; elapsed seconds,
      // never a fake percent
      return {
        pct: null,
        label: `resolving… ${Math.floor((job.fetchMs ?? 0) / 1000)}s`,
        tone: "fetching",
        indeterminate: true,
      };
    case "downloading":
      return job.pct != null
        ? { pct: job.pct, label: `${Math.round(job.pct)}%`, tone: "downloading" }
        : { pct: null, label: "starting…", tone: "downloading", indeterminate: true };
    case "post":
      return { pct: 100, label: "processing", tone: "post" };
    case "done":
      return { pct: 100, label: job.skipped ? "skipped" : "100%", tone: "done" };
    case "stopped":
      // a stop keeps how far it got — it is the resume point, not a failure
      return { pct: job.pct, label: "stopped", tone: "stopped" };
    case "duplicate":
      return { pct: null, label: "duplicate", tone: "duplicate" };
    case "error":
      return { pct: job.pct, label: "failed", tone: "error" };
    default:
      return { pct: 0, label: "queued", tone: "queued" };
  }
}
