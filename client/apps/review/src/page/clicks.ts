/**
 * In recordings, each click shows as a ring that grows and fades where it happened, so people watching the video see
 * what was pressed (Playwright's video has no pointer). The helper turns it on for recording contexts by setting
 * CLICKS_FLAG before the page loads. Unit-tested: test/clicks.test.ts.
 */

export const CLICKS_FLAG = "__inklayerReviewClicks";

const RING_MS = 700;
const SIZE = 28;

export function showClicks(doc: Document = document): void {
  doc.addEventListener("pointerdown", (e) => ring(doc, e.clientX, e.clientY), { capture: true, passive: true });
}

/** Draws one ring at a point in the window, and removes it once it has faded. */
export function ring(doc: Document, x: number, y: number): HTMLElement {
  const el = doc.createElement("div");
  el.setAttribute("aria-hidden", "true");
  el.dataset.inklayerClick = "";
  Object.assign(el.style, {
    position: "fixed",
    left: `${x - SIZE / 2}px`,
    top: `${y - SIZE / 2}px`,
    width: `${SIZE}px`,
    height: `${SIZE}px`,
    borderRadius: "50%",
    border: "3px solid #f59e0b",
    background: "rgba(245, 158, 11, 0.25)",
    pointerEvents: "none",
    zIndex: "2147483647",
    boxSizing: "border-box",
  });
  (doc.body ?? doc.documentElement).append(el);
  const done = () => el.remove();
  if (typeof el.animate === "function") {
    el.animate(
      [
        { transform: "scale(0.6)", opacity: 1 },
        { transform: "scale(1.8)", opacity: 0 },
      ],
      { duration: RING_MS, easing: "ease-out" },
    ).onfinish = done;
  } else {
    setTimeout(done, RING_MS);
  }
  return el;
}
