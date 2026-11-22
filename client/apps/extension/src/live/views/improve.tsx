/** @jsxImportSource preact */
import type { ComponentChild } from "preact";
import type { ImproveControls } from "../improve";

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
