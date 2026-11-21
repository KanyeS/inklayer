import { call } from "./call";
import type { PageAnnotation } from "./context";
import { draftBody, draftOf, type TextDraft } from "./suggestions";
import type { CommentActions } from "./views/comment";

export interface CommentActionHost {
  /** Runs a change through the background, then reloads the page's comments. */
  mutate(action: () => Promise<unknown>): void;
  /** The comment being edited and its text, or null when not editing. */
  setEditing(editing: { id: string; draft: TextDraft } | null): void;
}

/** What the buttons on one comment do: resolve or reopen, delete, and edit its text. */
export function commentActions(a: PageAnnotation, host: CommentActionHost): CommentActions {
  const update = (change: { status: "Open" | "Resolved" } | { body: string }) =>
    host.mutate(() => call({ type: "live.update", id: a.id, version: a.version, ...change }));
  return {
    setResolved: (resolved) => update({ status: resolved ? "Resolved" : "Open" }),
    remove: () => host.mutate(() => call({ type: "live.delete", id: a.id, version: a.version })),
    startEdit: () => host.setEditing({ id: a.id, draft: draftOf(a.body, a.people ?? []) }),
    saveEdit: (draft) => {
      host.setEditing(null);
      update({ body: draftBody(draft) });
    },
    cancelEdit: () => host.setEditing(null),
  };
}
