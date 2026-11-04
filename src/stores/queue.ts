import { create } from "zustand";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  jobAdd,
  jobItemDelete,
  jobRemove,
  jobRetryOptions,
  jobStop,
  queueList,
  queuePause,
  queueResume,
  type ItemDeleteResult,
  type Job,
  type JobItem,
  type JobOptions,
  type JobState,
} from "../lib/ipc";
// d88: retry re-queues with the composer's CURRENT options — the mirror is
// written by the composer on every change (see lib/composeMirror.ts).
import { currentOptions } from "../lib/composeMirror";
// d102: the convergence rules (phase order, merge, reconcile tick, progress
// labels) live in ./queueLogic so they can be driven with no events at all;
// this file only wires them to zustand + ipc.
import { createReconcileLoop, EVENT_FRESH_MS, mergeRows, TERMINAL_STATES } from "./queueLogic";

// ---------------------------------------------------------------------------
// sorting (§6): header click cycles asc ▲ → desc ▼ → default; default =
// insertion order; sort is a live view; ties break stably by insertion.
// ---------------------------------------------------------------------------

export type SortKey = "_order" | "title" | "format" | "status" | "pct" | "speed" | "eta";
export type SortDir = "asc" | "desc";

export const STATUS_ORDER: JobState[] = [
  "downloading",
  "post",
  "fetching",
  "queued",
  "done",
  "stopped",
  "error",
  "duplicate",
];

const statusRank = (s: JobState) => STATUS_ORDER.indexOf(s);

function compareJobs(a: Job, b: Job, key: SortKey, dir: SortDir): number {
  if (key === "_order") return 0; // insertion order == stored order
  const mul = dir === "asc" ? 1 : -1;
  // format sort reads job.format (hidden column — menu-only sort, D21)
  const getters: Record<Exclude<SortKey, "_order">, (j: Job) => string | number | null> = {
    title: (j) => j.title,
    format: (j) => j.format,
    status: (j) => statusRank(j.state),
    pct: (j) => j.pct,
    speed: (j) => j.speedBps,
    eta: (j) => j.etaSec,
  };
  const get = getters[key];
  const av = get(a);
  const bv = get(b);
  if (av == null && bv == null) return 0;
  if (av == null) return 1; // missing values sort last regardless of dir
  if (bv == null) return -1;
  if (typeof av === "string" && typeof bv === "string") {
    return av.localeCompare(bv) * mul;
  }
  return ((av as number) - (bv as number)) * mul;
}

// ---------------------------------------------------------------------------
// d100 — live truth: the event stream is the fast path, the database is the
// truth. rows used to depend on events alone: a burst the webview slept
// through (minimized window, laptop suspend, a mid-render stall) left a song
// sitting at `queued` while it downloaded and finished, and nothing ever
// asked again — the row only repainted when the NEXT queue action happened to
// pull the list. convergence is now structural: every state change pulls the
// authoritative rows, anything in flight is reconciled once a second, and
// returning to the window pulls immediately. a lost event can delay truth by
// a second; it can no longer freeze it.
// ---------------------------------------------------------------------------


/** last time a job:update landed — decides whether live progress is fresher
 * than the db's throttled (≤500 ms) flush. */
let lastEventAt = 0;

/** coalesced pull bookkeeping: focus + visibility + interval + several state
 * events can all land in the same second. */
let syncInFlight: Promise<void> | null = null;
let syncAgain = false;

/** the wired listener set, memoized so StrictMode's double-mount can't
 * register two of everything (each would also run its own interval). */
let attached: Promise<UnlistenFn[]> | null = null;

interface QueueState {
  jobs: Job[];
  loaded: boolean;
  paused: boolean;
  sortKey: SortKey;
  sortDir: SortDir;
  expanded: Set<string>;
  error: string | null;

  load: () => Promise<void>;
  /** coalesced load — the only pull the ui triggers outside of `add` */
  sync: () => Promise<void>;
  /** derived sorted view — new items insert at their sorted position */
  sorted: () => Job[];
  setSort: (key: SortKey, dir?: SortDir) => void;
  cycleSort: (key: SortKey) => void;
  toggleExpanded: (id: string) => void;

  add: (urls: string[], options: JobOptions, destination?: string) => Promise<AddFeedbackLike>;
  stop: (id: string) => Promise<void>;
  retry: (id: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
  /** d97: delete finished tracks from a playlist job (one or many) */
  deleteItems: (id: string, vids: string[]) => Promise<ItemDeleteResult>;
  pause: () => Promise<void>;
  resume: () => Promise<void>;

  /** wire job:update / job:log / queue:changed + the reconcile loop;
   * returns a teardown (detaching is idempotent, so a remount re-wires). */
  attach: () => Promise<UnlistenFn[]>;
}

export interface AddFeedbackLike {
  jobs: Job[];
  invalid: [string, string][];
  duplicatesSkipped: number;
}

export const useQueue = create<QueueState>((set, get) => ({
  jobs: [],
  loaded: false,
  paused: false,
  sortKey: "_order",
  sortDir: "asc",
  expanded: new Set<string>(),
  error: null,

  load: async () => {
    const rows = await queueList();
    set((s) => {
      // d100: merge, never blind-replace. the db row is authoritative for
      // state (it is the engine's own write, one step ahead of the event);
      // the event stream is fresher for the bytes, so within an unchanged
      // phase the live values win — otherwise a 1 s reconcile would drag the
      // bar backwards to the last 500 ms flush. when the stream goes quiet
      // (the case that used to freeze rows) the db wins wholesale.
      // d102: mergeRows owns both invariants — state never regresses, and the
      // bar never regresses within a phase (see ./queueLogic).
      return {
        jobs: mergeRows(rows, s.jobs, { live: Date.now() - lastEventAt < EVENT_FRESH_MS }),
        loaded: true,
      };
    });
  },

  sync: () => {
    if (syncInFlight) {
      syncAgain = true; // re-run once more after the in-flight pull
      return syncInFlight;
    }
    syncInFlight = (async () => {
      try {
        do {
          syncAgain = false;
          await get().load();
        } while (syncAgain);
      } finally {
        syncInFlight = null;
      }
    })();
    return syncInFlight;
  },

  sorted: () => {
    const { jobs, sortKey, sortDir } = get();
    // d85: _order is a REAL direction now — default newest-first (the fresh
    // paste is the thing you're watching); the # header flips to oldest-first.
    // active jobs stay pinned above finished ones in both.
    if (sortKey === "_order") {
      const mul = sortDir === "desc" ? -1 : 1;
      return [...jobs].sort(
        (a, b) =>
          statusRank(a.state) - statusRank(b.state) || // active first, BOTH dirs
          (b.createdAt - a.createdAt) * mul ||
          b.id.localeCompare(a.id) * mul,
      );
    }
    return [...jobs]
      .map((j, i) => ({ j, i }))
      .sort((x, y) => {
        const c = compareJobs(x.j, y.j, sortKey, sortDir);
        // stable ties by insertion sequence (§6)
        return c !== 0 ? c : x.i - y.i;
      })
      .map((x) => x.j);
  },

  setSort: (key, dir = "asc") => set({ sortKey: key, sortDir: dir }),
  /** header click cycle: asc → desc → default (§6). for _order the "default"
   * IS a direction (newest-first), so the cycle is just a flip. */
  cycleSort: (key) => {
    const { sortKey, sortDir } = get();
    if (sortKey !== key) {
      set({ sortKey: key, sortDir: key === "_order" ? "desc" : "asc" });
    } else if (sortKey === "_order") {
      set({ sortDir: sortDir === "desc" ? "asc" : "desc" });
    } else if (sortDir === "asc") {
      set({ sortKey: key, sortDir: "desc" });
    } else {
      set({ sortKey: "_order", sortDir: "desc" });
    }
  },

  toggleExpanded: (id) =>
    set((s) => {
      const expanded = new Set(s.expanded);
      if (expanded.has(id)) expanded.delete(id);
      else expanded.add(id);
      return { expanded };
    }),

  add: async (urls, options, destination) => {
    const fb = await jobAdd(urls, options, destination);
    // the new rows are on screen before the composer reports back — the
    // intake surface hands the url over to the queue (§5.2/d100)
    await get().sync();
    return fb;
  },
  stop: async (id) => {
    await jobStop(id);
    await get().sync();
  },
  retry: async (id) => {
    // d88: "retry" must mean what the user expects — the job re-queues with
    // the composer's live options/destination, so turning on cookies or
    // changing the format BEFORE pressing retry actually applies. the
    // engine sweeps the original destination's partial artifacts if the
    // destination changed (never the finished file). destination is
    // resolved server-side through the same chain as job_add.
    await jobRetryOptions(id, currentOptions);
    await get().sync();
  },
  remove: async (id) => {
    await jobRemove(id);
    await get().sync();
  },
  deleteItems: async (id, vids) => {
    const res = await jobItemDelete(id, vids);
    await get().sync();
    return res;
  },
  pause: async () => set({ paused: await queuePause() }),
  resume: async () => set({ paused: await queueResume() }),

  attach: () => {
    if (!attached) attached = wire();
    return attached;
  },
}));

/** the event wiring + convergence loop (d100). one instance per webview; the
 * returned teardown clears the listeners and re-arms `attached`. */
async function wire(): Promise<UnlistenFn[]> {
  // d94: `item` (singular) is one just-completed track; `items` a full
  // replacement snapshot (post-stop). both are outside Partial<Job>.
  const onJobUpdate = await listen<
    Partial<Job> & { id: string; state?: JobState; item?: JobItem; items?: JobItem[] }
  >(
    "job:update",
    (e) => {
      lastEventAt = Date.now();
      const p = e.payload;
      // d100: a state change is a pull boundary — the db row is the authority
      // (it also carries the output log, items and final path that the event
      // may omit). progress is still patched in place below, so the bar stays
      // smooth between pulls. terminal events reload as they always have; a
      // lost one is now caught by the reconcile loop instead of waiting for
      // the user's next queue action.
      if (p.state != null && TERMINAL_STATES.has(p.state)) {
        void useQueue.getState().sync();
        return;
      }
      useQueue.setState((s) => ({
        jobs: s.jobs.map((j) => {
          if (j.id !== p.id) return j;
          // d61: state transitions are **monotonic** — a late/stale event
          // (udp packets of the same 200ms stream can arrive reordered
          // through the ipc bridge) must never downgrade the visible state:
          // the "green 100% while fetching" ghost from the alpha.2 install
          // was a stale fetching patch landing after progress/terminal
          // updates. progress fields are cleared when a state regress was
          // suppressed so stale pct can't linger under a newer state.
          const STATE_RANK: Record<JobState, number> = {
            queued: 0,
            fetching: 1,
            downloading: 2,
            post: 3,
            done: 4,
            stopped: 4,
            error: 4,
            duplicate: 4,
          };
          const incoming = (p.state ?? j.state) as JobState;
          const staleDowngrade =
            p.state != null && STATE_RANK[p.state] < STATE_RANK[j.state];
          const state = staleDowngrade ? j.state : incoming;
          const clearProgress = staleDowngrade;
          // d94/ADVERSARIAL-REVIEW: the track list is REAL-TIME. the engine
          // emits either one completed item (`item`) as its file lands or a
          // full snapshot (`items`) after a stop; both merge into the job
          // immediately instead of waiting for the terminal reload.
          let items = j.items ?? [];
          if (p.item) {
            const upsert = p.item as JobItem;
            items = items.some((it) => it.vid === upsert.vid)
              ? items.map((it) => (it.vid === upsert.vid ? { ...it, ...upsert } : it))
              : [...items, upsert].sort((a, b) => a.idx - b.idx || a.vid.localeCompare(b.vid));
          } else if (p.items) {
            items = p.items as JobItem[];
          }
          return {
            ...j,
            state,
            items,
            pct: clearProgress ? null : (p.pct ?? j.pct),
            speedBps: clearProgress ? null : "speedBps" in p ? (p.speedBps ?? null) : j.speedBps,
            etaSec: clearProgress ? null : "etaSec" in p ? (p.etaSec ?? null) : j.etaSec,
            // the fetch ticker drives this; it must never overwrite a
            // previously known pct with something stale
            fetchMs: "fetchMs" in p ? (p.fetchMs ?? null) : j.fetchMs,
            title: p.title ?? j.title,
            finalPath: p.finalPath ?? j.finalPath,
            // d93: the background thumb fetch emits its path when done;
            // sticky — a later event without a thumb never erases one
            thumb: p.thumb ?? j.thumb,
            // d94: "now downloading item N" — surfaces in the row's meta
            itemTitle: "itemTitle" in p ? (p.itemTitle ?? null) : j.itemTitle ?? null,
            error: "error" in p ? (p.error ?? null) : j.error,
            skipped: p.skipped ?? j.skipped,
            itemsDone: "itemsDone" in p ? (p.itemsDone ?? null) : j.itemsDone,
            itemsTotal: "itemsTotal" in p ? (p.itemsTotal ?? null) : j.itemsTotal,
          };
        }),
      }));
      // the db is what the row must ultimately agree with (d100)
      if (p.state != null) void useQueue.getState().sync();
    },
  );
  const onJobLog = await listen<{ id: string; line: string }>("job:log", (e) => {
    // the terminal reload above supersedes log-appends for terminal events;
    // live appends stay for the streaming phases (downloading/post)
    useQueue.setState((s) => ({
      jobs: s.jobs.map((j) =>
        j.id === e.payload.id
          ? { ...j, output: [...j.output.slice(-499), e.payload.line] }
          : j,
      ),
    }));
  });

  // while anything is in flight, reconcile against the engine once a second:
  // the webview can miss a burst (minimize, suspend, stall) and that missed
  // `done` is exactly the "still pending until I queue something" report.
  // idle queues cost one timer tick and no ipc.
  const reconcile = createReconcileLoop({
    getJobs: () => useQueue.getState().jobs,
    pull: () => void useQueue.getState().sync(),
  });
  reconcile.start();

  // coming back to the window (or un-hiding it) is the moment a stale list is
  // most visible, and the cheapest place to prove otherwise.
  const pull = () => void useQueue.getState().sync();
  const onVisible = () => {
    if (document.visibilityState === "visible") pull();
  };
  window.addEventListener("focus", pull);
  document.addEventListener("visibilitychange", onVisible);

  const teardown = () => {
    attached = null;
    reconcile.stop();
    window.removeEventListener("focus", pull);
    document.removeEventListener("visibilitychange", onVisible);
    onJobUpdate();
    onJobLog();
  };
  return [teardown];
}

/** engine status seam — components subscribe; queue:changed updates it. */
interface EngineCounts {
  active: number;
  queued: number;
}
interface EngineStore {
  counts: EngineCounts | null;
  setCounts: (c: EngineCounts | null) => void;
}
export const useEngineCounts = create<EngineStore>((set) => ({
  counts: null,
  setCounts: (counts) => set({ counts }),
}));

export async function attachEngineCounts(): Promise<UnlistenFn> {
  return listen<{ active: number; queued: number }>("queue:changed", (e) => {
    useEngineCounts.getState().setCounts(e.payload);
    // d85: the tab-bar counter was the only consumer — but the engine fires
    // this on every state change INCLUDING terminal ones, so it doubles as a
    // guaranteed re-pull: a webview that slept through a job:update burst
    // (laptop sleep, renderer stall) still converges to the truth instead of
    // holding a stale "fetching" row forever. d100: coalesced, so event
    // storms (and the reconcile loop) can't stack pulls.
    void useQueue.getState().sync();
  });
}
