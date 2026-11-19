import type { Tool } from "@inklayer/overlay";
import type { ActivityItem, LinkedIssue } from "../lib/live";

/** Text shown in the live panel, and the fixed choices it offers. */

/** What a comment-activity entry says the person did. */
export const ACTIVITY_VERBS: Readonly<Record<string, string>> = {
  created: "commented",
  updated: "edited a comment",
  resolved: "resolved a comment",
  reopened: "reopened a comment",
  deleted: "deleted a comment",
  signed_in: "signed in",
  sign_in_refused: "Sign-in refused",
  error: "Server error",
  replied: "replied to a comment",
};

/** What a doc-activity entry says the person did. */
export const DOC_VERBS: Readonly<Record<string, string>> = {
  created: "created a doc",
  edited: "edited a doc",
  renamed: "renamed a doc",
  moved: "moved a doc",
  deleted: "deleted a doc",
};

/** The activity filter's names for each kind of entry. */
export const KIND_LABELS: Readonly<Record<ActivityItem["kind"], string>> = {
  comments: "Comments",
  docs: "Docs",
  signins: "Sign-ins",
  errors: "Errors",
};

/** Issue trackers by name. */
export const TRACKER_NAMES: Readonly<Record<LinkedIssue["kind"], string>> = {
  github: "GitHub",
  jira: "Jira",
  linear: "Linear",
};

/** The colours a new comment can be drawn in. The first is the default. */
export const COLORS = ["#f59e0b", "#ef4444", "#3b82f6", "#10b981", "#8b5cf6"] as const;

/** The drawing tools, in the order the panel shows them. */
export const TOOLS: readonly { tool: Tool; label: string; title: string }[] = [
  { tool: "select", label: "Select", title: "Select comments" },
  { tool: "pin", label: "Pin", title: "Pin a comment to a point" },
  { tool: "element", label: "Element", title: "Outline an element" },
  { tool: "highlight", label: "Text", title: "Highlight text (select it with the mouse)" },
  { tool: "rect", label: "Box", title: "Draw a box" },
  { tool: "arrow", label: "Arrow", title: "Draw an arrow" },
  { tool: "ink", label: "Draw", title: "Draw freehand" },
];

/** What to do next with a drawing tool picked but nothing drawn yet. */
export function toolHint(tool: Tool): string {
  if (tool === "highlight") return "Select some text on the page.";
  if (tool === "pin" || tool === "element") return "Click something on the page.";
  return "Drag on the page.";
}
