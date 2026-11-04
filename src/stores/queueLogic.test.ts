// d102 — the "row stuck at pending" fix, proved without a webview: these tests
// never deliver an event. They drive the real reconcile tick and the real merge
// against simulated backend snapshots, so convergence is shown to be a property
// of the shipped code rather than of the push stream.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Job, JobState } from "../lib/ipc.ts";
import { createReconcileLoop, mergeRows, needsReconcile, progressOf, RECONCILE_MS } from "./queueLogic.ts";

function job(over: Partial<Job> & { state: JobState }): Job {
  return {
    id: "j1",
    url: "https://example.invalid/track",
    title: null,
    format: null,
    finalPath: null,
    thumb: null,
    pct: null,
    speedBps: null,
    etaSec: null,
    error: null,
    skipped: false,
    itemsDone: null,
    itemsTotal: null,
    items: [],
    output: [],
    createdAt: 1,
    ...over,
  };
}

test("no events: an in-flight row reaches 100%/done on the periodic tick alone", () => {
  // exactly what a minimized/suspended webview misses: the whole stream. every
  // sample below arrives only because a tick pulled it.
  const timeline: Array<Partial<Job> & { state: JobState }> = [
    { state: "queued" },
    { state: "fetching", fetchMs: 2000 },
    { state: "downloading", pct: 12 },
    { state: "downloading", pct: 37 },
    { state: "downloading", pct: 71 },
    { state: "post" },
    { state: "done", pct: 100 },
  ];
  let shown: Job[] = [];
  let pulls = 0;
  let step = 0;
  const loop = createReconcileLoop({
    getJobs: () => shown,
    pull: () => {
      pulls++;
      // live:false — the db-only path, i.e. the stream is silent/dead
      shown = mergeRows([job(timeline[step])], shown, { live: false });
      step++;
    },
  });

  // mount: the app pulls once when the view appears, so the first row exists
  // before any tick. everything after it must come from the timer alone.
  shown = mergeRows([job(timeline[0])], shown, { live: false });
  step = 1;
  const labels: string[] = [progressOf(shown[0]).label];
  const widths: number[] = [progressOf(shown[0]).pct ?? 0];
  for (let i = 1; i < timeline.length; i++) {
    assert.equal(loop.tick(), true, `tick ${i} must pull while the row is in flight`);
    const cell = progressOf(shown[0]);
    labels.push(cell.label);
    widths.push(cell.pct ?? 0);
  }

  assert.deepEqual(labels, [
    "queued",
    "resolving… 2s",
    "12%",
    "37%",
    "71%",
    "processing",
    "100%",
  ]);
  for (let i = 1; i < widths.length; i++) {
    assert.ok(widths[i] >= widths[i - 1], `bar went backwards at step ${i}: ${widths[i - 1]} → ${widths[i]}`);
  }
  assert.equal(pulls, timeline.length - 1, "every later sample came from a tick, not an event");

  const end = progressOf(shown[0]);
  assert.equal(shown[0].state, "done");
  assert.equal(end.pct, 100, "a finished row must show a full bar, not an empty one");
  assert.equal(end.label, "100%");
  assert.equal(end.tone, "done");

  // and the loop stops costing pulls once nothing is in flight
  const before = pulls;
  assert.equal(loop.tick(), false);
  assert.equal(pulls, before);
});

test("terminal rows name their phase and keep their meaning", () => {
  const failed = progressOf(job({ state: "error", pct: 42 }));
  assert.equal(failed.label, "failed");
  assert.equal(failed.tone, "error");
  assert.equal(failed.pct, 42, "a failure keeps how far it got");

  const stopped = progressOf(job({ state: "stopped", pct: 58 }));
  assert.equal(stopped.label, "stopped");
  assert.equal(stopped.tone, "stopped");
  assert.equal(stopped.pct, 58, "a stop keeps its resume point");

  const skipped = progressOf(job({ state: "done", skipped: true, pct: 100 }));
  assert.equal(skipped.label, "skipped");
  assert.equal(skipped.pct, 100);

  assert.equal(progressOf(job({ state: "duplicate" })).label, "duplicate");
  assert.equal(progressOf(job({ state: "done", pct: 100 })).label, "100%");
});

test("a stale snapshot can neither roll the bar nor the phase backwards", () => {
  // out-of-order response mid-flight: the db's throttled write lags the row
  const mid = mergeRows(
    [job({ state: "downloading", pct: 41 })],
    [job({ state: "downloading", pct: 62 })],
    { live: false },
  );
  assert.equal(mid[0].pct, 62, "a lagging snapshot must not drag the bar back to 41%");
  assert.equal(progressOf(mid[0]).label, "62%");

  // a snapshot that predates the terminal state
  const stale = mergeRows(
    [job({ state: "downloading", pct: 40 })],
    [job({ state: "done", pct: 100 })],
    { live: false },
  );
  assert.equal(stale[0].state, "done", "a done row must never fall back to downloading");
  assert.equal(progressOf(stale[0]).label, "100%");
  assert.equal(progressOf(stale[0]).pct, 100);

  // same guarantee while the stream is fresh
  const liveMid = mergeRows(
    [job({ state: "downloading", pct: 41 })],
    [job({ state: "downloading", pct: 62 })],
    { live: true },
  );
  assert.equal(liveMid[0].pct, 62);

  // a db row without a percent must not erase a known one
  const nullPct = mergeRows(
    [job({ state: "downloading", pct: null })],
    [job({ state: "downloading", pct: 62 })],
    { live: false },
  );
  assert.equal(nullPct[0].pct, 62);
});

test("the tick is periodic, armed once, and idle queues cost nothing", () => {
  const timers: Array<() => void> = [];
  let cleared = 0;
  let pulls = 0;
  let current = [job({ state: "downloading", pct: 10 })];
  const loop = createReconcileLoop({
    getJobs: () => current,
    pull: () => {
      pulls++;
    },
    setInterval: (fn, ms) => {
      assert.equal(ms, RECONCILE_MS, "the reconcile cadence is one second");
      timers.push(fn);
      return 1;
    },
    clearInterval: () => {
      cleared++;
    },
  });

  loop.start();
  loop.start(); // idempotent — a remount must not arm a second timer
  assert.equal(timers.length, 1);

  timers[0]();
  assert.equal(pulls, 1, "an armed tick pulls while a row is in flight");

  current = [job({ state: "done", pct: 100 })];
  timers[0]();
  assert.equal(pulls, 1, "an idle queue must not spend a pull");

  loop.stop();
  assert.equal(cleared, 1);
  loop.stop();
  assert.equal(cleared, 1, "stop is idempotent");

  // the active set itself: queued/fetching/downloading/post converge, the
  // terminal ones do not need to
  for (const s of ["queued", "fetching", "downloading", "post"] as JobState[]) {
    assert.equal(needsReconcile([job({ state: s })]), true, `${s} must be reconciled`);
  }
  for (const s of ["done", "stopped", "error", "duplicate"] as JobState[]) {
    assert.equal(needsReconcile([job({ state: s })]), false, `${s} must not trigger pulls`);
  }
});
