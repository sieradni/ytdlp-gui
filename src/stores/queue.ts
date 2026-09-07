import { create } from "zustand";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  jobAdd,
  jobRemove,
  jobRetry,
  jobStop,
  queueList,
  queuePause,
  queueResume,
  type Job,
  type JobOptions,
  type JobState,
} from "../lib/ipc";

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

interface QueueState {
  jobs: Job[];
  loaded: boolean;
  paused: boolean;
  sortKey: SortKey;
  sortDir: SortDir;
  expanded: Set<string>;
  error: string | null;

  load: () => Promise<void>;
  /** derived sorted view — new items insert at their sorted position */
  sorted: () => Job[];
  setSort: (key: SortKey, dir?: SortDir) => void;
  cycleSort: (key: SortKey) => void;
  toggleExpanded: (id: string) => void;

  add: (urls: string[], options: JobOptions, destination?: string) => Promise<AddFeedbackLike>;
  stop: (id: string) => Promise<void>;
  retry: (id: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
  pause: () => Promise<void>;
  resume: () => Promise<void>;

  /** wire job:update / job:log / queue:changed; returns unlisten fns */
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
    const jobs = await queueList();
    set({ jobs, loaded: true });
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
    await get().load();
    return fb;
  },
  stop: async (id) => {
    await jobStop(id);
    await get().load();
  },
  retry: async (id) => {
    await jobRetry(id);
    await get().load();
  },
  remove: async (id) => {
    await jobRemove(id);
    await get().load();
  },
  pause: async () => set({ paused: await queuePause() }),
  resume: async () => set({ paused: await queueResume() }),

  attach: async () => {
    const onJobUpdate = await listen<Partial<Job> & { id: string; state?: JobState }>(
      "job:update",
      (e) => {
        const p = e.payload;
        // terminal states carry the authoritative row (output log included —
        // the log event stream only covers the download phase, so fetch-phase
        // errors and skips would otherwise render an empty expando; found by
        // the e2e checklist, S12). reload once per terminal transition.
        const terminal = p.state === "done" || p.state === "error" || p.state === "stopped" || p.state === "duplicate";
        if (terminal) {
          void get().load();
          return;
        }
        set((s) => ({
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
            return {
              ...j,
              state,
              pct: clearProgress ? null : (p.pct ?? j.pct),
              speedBps: clearProgress ? null : "speedBps" in p ? (p.speedBps ?? null) : j.speedBps,
              etaSec: clearProgress ? null : "etaSec" in p ? (p.etaSec ?? null) : j.etaSec,
              // the fetch ticker drives this; it must never overwrite a
              // previously known pct with something stale
              fetchMs: "fetchMs" in p ? (p.fetchMs ?? null) : j.fetchMs,
              title: p.title ?? j.title,
              finalPath: p.finalPath ?? j.finalPath,
              error: "error" in p ? (p.error ?? null) : j.error,
              skipped: p.skipped ?? j.skipped,
              itemsDone: "itemsDone" in p ? (p.itemsDone ?? null) : j.itemsDone,
              itemsTotal: "itemsTotal" in p ? (p.itemsTotal ?? null) : j.itemsTotal,
            };
          }),
        }));
      },
    );
    const onJobLog = await listen<{ id: string; line: string }>("job:log", (e) => {
      // the terminal reload above supersedes log-appends for terminal events;
      // live appends stay for the streaming phases (downloading/post)
      set((s) => ({
        jobs: s.jobs.map((j) =>
          j.id === e.payload.id
            ? { ...j, output: [...j.output.slice(-499), e.payload.line] }
            : j,
        ),
      }));
    });
    return [onJobUpdate, onJobLog];
  },
}));

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
    // holding a stale "fetching" row forever.
    void useQueue.getState().load();
  });
}
