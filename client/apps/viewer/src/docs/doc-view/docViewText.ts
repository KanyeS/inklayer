import type { SessionStatus } from "../collab";
import type { CommentInfo } from "../docsApi";

/**
 * The doc view's decisions that don't need React: what the save status says, what a linked comment's chip says, and
 * how ticking a task changes the text. Unit-tested in test/docViewText.test.ts.
 */

/** What the header says about saving, e.g. "Live · saved automatically". */
export function statusLabel(status: SessionStatus, canEdit: boolean): string {
  switch (status) {
    case "live":
      return canEdit ? "Live · saved automatically" : "Live · read only";
    case "connecting":
      return "Connecting…";
    case "closed":
      return "Closed";
    case "offline":
      return "Offline · edits kept";
  }
}

/** The colour of the status dot. */
export function statusDotClass(status: SessionStatus): string {
  if (status === "live") return "bg-emerald-500";
  if (status === "connecting") return "bg-amber-500";
  return "bg-muted-foreground";
}

/** The presence layer only knows live, connecting and offline; a closed session counts as offline. */
export function presenceStatus(status: SessionStatus): "live" | "connecting" | "offline" {
  return status === "live" || status === "connecting" ? status : "offline";
}

/** How long a comment chip's preview of the comment can be. */
const CHIP_PREVIEW_CHARS = 60;

/** A linked comment's chip in the editor: "Author: start of the comment…", or why it can't be shown. */
export function commentChipLabel(comment: CommentInfo | null): string {
  if (!comment) return "Comment you can't see";
  const preview = comment.body.slice(0, CHIP_PREVIEW_CHARS);
  return `${comment.author.displayName}: ${preview}${comment.body.length > CHIP_PREVIEW_CHARS ? "…" : ""}`;
}

/** The header line of a linked comment's card in reading view. */
export function commentCardHeading(comment: CommentInfo): string {
  return `💬 ${comment.author.displayName} · ${comment.projectName}${comment.status === "Resolved" ? " · resolved" : ""}`;
}

const TASK_BOX = /\[( |x|X)\]/;

/**
 * The doc's text with the task on `line` ticked or unticked, or null if that line doesn't exist. Only the first
 * checkbox on the line changes.
 */
export function setTaskChecked(text: string, line: number, checked: boolean): string | null {
  const lines = text.split("\n");
  const current = lines[line];
  if (!Number.isInteger(line) || current === undefined) return null;
  lines[line] = current.replace(TASK_BOX, checked ? "[x]" : "[ ]");
  return lines.join("\n");
}

/** The heading's text as it appears in the editor (with its #s) or reading view, for finding it on the page. */
export function headingText(elementText: string): string {
  return elementText.replace(/^#+\s*/, "").trim();
}
