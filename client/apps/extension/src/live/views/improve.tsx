/** @jsxImportSource preact */
import type { ComponentChild } from "preact";
import type { ImproveControls, ImproveHint } from "../improve";

/** The Improve button beside a comment box's Save, and the line under it (Undo, or what went wrong). */

const stop = (e: Event) => e.stopPropagation();

export function improveButton(c: ImproveControls): ComponentChild {
  return (
    <button
      type="button"
      className="improve"
      disabled={c.busy}
      title="Rewrite this comment with Claude Code on this computer, using your own Claude plan"
      onClick={(e) => {
        stop(e);
        c.onImprove();
      }}
    >
      {c.busy ? "Improving…" : "Improve"}
    </button>
  );
}

export function improveNote(c: ImproveControls): ComponentChild {
  if (c.error)
    return (
      <p className="improve-note error" role="alert">
        {c.error}
      </p>
    );
  if (!c.canUndo) return null;
  return (
    <p className="improve-note">
      Rewritten by Claude.{" "}
      <button
        type="button"
        className="link"
        onClick={(e) => {
          stop(e);
          c.onUndo();
        }}
      >
        Undo
      </button>
    </p>
  );
}

/** Under the comment box while the helper isn't set up: "✨ Improve with Claude: set up · Don't show this". */
export function improveHint(h: ImproveHint): ComponentChild {
  return (
    <p className="improve-hint">
      <span aria-hidden="true">✨ </span>
      <button
        type="button"
        className="link"
        title="Opens the setup in a new tab. It needs Claude Code on this computer."
        onClick={(e) => {
          stop(e);
          h.onSetUp();
        }}
      >
        Improve with Claude: set up
      </button>
      {" · "}
      <button
        type="button"
        className="link"
        onClick={(e) => {
          stop(e);
          h.onHide();
        }}
      >
        Don't show this
      </button>
    </p>
  );
}
