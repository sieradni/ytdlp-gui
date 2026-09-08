// d88: the D19 "current composer options" mirror, extracted from
// Composer.tsx into a leaf module. History (and now the queue store's retry)
// read it, and importing a component for a single variable dragged the whole
// composer subtree into every consumer's import graph — a mirror is a value,
// not a component. written by the composer on every option change (including
// seeding); read by history's ↻ and the queue's ↻.
//
// it holds defaults until the composer has rendered once (pages unmount on
// tab switch; the module survives). destination is deliberately NOT mirrored:
// it persists to settings on every keystroke and the engine resolves the same
// fallback chain for both add and retry.
import type { JobOptions } from "./ipc";
import { defaultOptions } from "./defaults";

export let currentOptions: JobOptions = defaultOptions();

export const setComposerOptions = (next: JobOptions) => {
  currentOptions = next;
};
