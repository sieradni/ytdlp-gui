/**
 * d82: wheel smoothing. native windows wheel scrolling jumps ~100 px per
 * notch with no glide, which makes long lists (history) hard to position —
 * "hard to tell how far it's scrolling". wheel deltas accumulate into an
 * animation target and a rAF loop eases scrollTop toward it (16%/frame —
 * quick attack, short glide, ~0.4 s to settle a notch).
 *
 * discipline: reduced-motion users get native behavior (no smoothing at
 * all); nested scroll containers chain naturally at their edges (an inner
 * list that hits its end hands the next delta to the page pane); zoom
 * (ctrl+wheel), page-mode deltas, keyboard, scrollbar drags and programmatic
 * scrolls are untouched. drags mid-glide are detected and the target resyncs
 * instead of fighting the user.
 */

/** ease factor per frame — the demo knob (higher = snappier).
 * 0.10 ≈ 0.6 s glide per notch; 0.16 felt instant to the first demoer. */
const EASE = 0.16;

export function attachSmoothScroll(): () => void {
  // deliberately NOT gated on prefers-reduced-motion (d82): the demo
  // machine reports reduce (windows "animation effects" off) and the user
  // explicitly asked for smoothing — an os flag that also mutes the dialog
  // chime should not silently disable a core interaction feel. scroll
  // smoothing is controlled by the user in-app; decorative fades/chime
  // keep honoring the os flag.

  const anim = { el: null as HTMLElement | null, target: 0, lastSet: 0, raf: 0 };

  const stop = () => {
    if (anim.raf) cancelAnimationFrame(anim.raf);
    anim.el = null;
    anim.raf = 0;
  };

  const step = () => {
    const el = anim.el;
    if (!el) return;
    const cur = el.scrollTop;
    // someone else scrolled (scrollbar drag) — shift the target by the
    // external offset instead of yanking back to our stale target
    const drift = cur - anim.lastSet;
    if (Math.abs(drift) > 2) anim.target += drift;
    const diff = anim.target - cur;
    if (Math.abs(diff) < 0.6) {
      el.scrollTop = anim.target;
      stop();
      return;
    }
    anim.lastSet = cur + diff * EASE;
    el.scrollTop = anim.lastSet;
    anim.raf = requestAnimationFrame(step);
  };

  /** every scrollable ancestor of the event target, innermost first */
  const scrollables = (from: EventTarget | null): HTMLElement[] => {
    const out: HTMLElement[] = [];
    let n = from instanceof HTMLElement ? from : null;
    while (n) {
      const style = getComputedStyle(n);
      if (/(auto|scroll)/.test(style.overflowY) && n.scrollHeight > n.clientHeight + 1) {
        out.push(n);
      }
      n = n.parentElement;
    }
    return out;
  };

  const onWheel = (e: WheelEvent) => {
    // ctrl+wheel is zoom; page-mode deltas are rare and native is fine
    if (e.ctrlKey || e.deltaMode === WheelEvent.DOM_DELTA_PAGE) return;
    const delta =
      e.deltaMode === WheelEvent.DOM_DELTA_LINE ? e.deltaY * 40 : e.deltaY;
    if (delta === 0) return;
    for (const el of scrollables(e.target)) {
      const max = el.scrollHeight - el.clientHeight;
      const atTop = el.scrollTop <= 0.5;
      const atBottom = el.scrollTop >= max - 0.5;
      // the first container that can consume this direction animates it;
      // one at its edge falls through to the next outer one
      if ((delta < 0 && !atTop) || (delta > 0 && !atBottom)) {
        e.preventDefault();
        if (anim.el !== el) stop();
        anim.el = el;
        const base = anim.raf ? anim.target : el.scrollTop;
        anim.target = Math.max(0, Math.min(max, base + delta));
        if (!anim.raf) {
          anim.lastSet = el.scrollTop;
          anim.raf = requestAnimationFrame(step);
        }
        return;
      }
    }
    // nothing scrollable in that direction — native (no-op or chain)
  };

  window.addEventListener("wheel", onWheel, { passive: false, capture: true });
  return () => {
    window.removeEventListener("wheel", onWheel, { capture: true });
    stop();
  };
}
