/** @jsxImportSource preact */
import type { ComponentChild } from "preact";
import type { ImproveUsage } from "../../lib/claude-helper";
import type { ImproveControls, ImproveHint } from "../improve";

/**
 * The Improve button beside a comment box's Save, the line under it (working, Undo, or what went wrong), and the box
 * itself while Claude works on it: locked (inert, so it can't be typed in, focused or saved from) with a shimmer.
 */

const stop = (e: Event) => e.stopPropagation();

export function improveButton(c: ImproveControls): ComponentChild {
  return (
    <button
      type="button"
      className={c.busy ? "improve busy" : "improve"}
      disabled={c.busy}
      aria-busy={c.busy}
      title="Rewrite this comment with Claude Code on this computer, using your own Claude plan"
      onClick={(e) => {
        stop(e);
        c.onImprove();
      }}
    >
      {c.busy && <span className="spinner" aria-hidden="true" />}
      {c.busy ? "Improving…" : "Improve"}
    </button>
  );
}

/** The comment box, locked while Claude rewrites what's in it. */
export function improveArea(input: ComponentChild, c: ImproveControls | null | undefined): ComponentChild {
  if (!c) return input;
  return (
    <div className={c.busy ? "improve-area improving" : "improve-area"} inert={c.busy} aria-busy={c.busy}>
      {input}
    </div>
  );
}

export function improveNote(c: ImproveControls): ComponentChild {
  if (c.busy)
    return (
      <p className="improve-note" role="status">
        ✨ Claude is rewriting your comment…
      </p>
    );
  if (c.error)
    return (
      <p className="improve-note error" role="alert">
        {c.error}
      </p>
    );
  if (!c.canUndo) return null;
  return (
    <p className="improve-note">
      Rewritten by Claude
      {c.usage && (
        <span
          className="improve-usage"
          title="On a Claude plan this counts towards your plan's limits; the cost is what it would be on an API key."
        >
          {` · ${usageText(c.usage)}`}
        </span>
      )}
      .{" "}
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

/** "Sonnet 4.6 · 9,120 tokens · ≈$0.030 at API prices · 6.6 s": what a rewrite used. */
export function usageText(u: ImproveUsage): string {
  const parts: string[] = [];
  const model = modelName(u.model);
  if (model) parts.push(model);
  parts.push(`${(u.inputTokens + u.outputTokens).toLocaleString("en")} tokens`);
  if (u.costUsd !== null) parts.push(`≈${costText(u.costUsd)} at API prices`);
  if (u.durationMs !== null) parts.push(`${(u.durationMs / 1000).toFixed(1)} s`);
  return parts.join(" · ");
}

/** claude-sonnet-4-6 → Sonnet 4.6; anything else as it is. */
function modelName(model: string | null): string | null {
  if (!model) return null;
  const known = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-|$)/.exec(model);
  if (!known?.[1]) return model;
  const family = known[1].charAt(0).toUpperCase() + known[1].slice(1);
  return `${family} ${known[2]}${known[3] ? `.${known[3]}` : ""}`;
}

function costText(usd: number): string {
  if (usd < 0.001) return "<$0.001";
  return `$${usd < 0.1 ? usd.toFixed(3) : usd.toFixed(2)}`;
}
