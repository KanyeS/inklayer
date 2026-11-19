import type { LiveAnnotation, LiveInit } from "../lib/live";

/** A comment on this page, and the project it belongs to. */
export type PageAnnotation = LiveAnnotation & { projectId: string };

/** The panel's tabs. */
export type View = "comments" | "activity" | "inbox";

/**
 * What the panel's views need from the session that owns them. Views build DOM from this and the data they're given;
 * all state changes go back through these calls, so the session stays the one place state lives.
 */
export interface PanelContext {
  readonly init: LiveInit;
  /** A change is being saved: buttons that change things are disabled meanwhile. */
  readonly busy: boolean;
  /** Redraws the panel and bubbles. */
  render(): void;
  /** Runs a change (shows "busy", reports errors), then reloads the page's comments. */
  mutate(action: () => Promise<unknown>): void;
  /** Shows a short message under the panel's header for a few seconds. */
  flashNote(text: string): void;
  /** Shows an error in the comments view until the next successful change. */
  showError(message: string): void;
  /** Whether a comment is one of those on this page. */
  isOnThisPage(annotationId: string): boolean;
  /** Selects a comment on this page and switches to the comments list. */
  showOnPage(annotationId: string): void;
}

/** The web viewer's address for a doc. */
export function docUrl(serverUrl: string, organizationId: string, docId: string): string {
  return `${serverUrl}/orgs/${encodeURIComponent(organizationId)}/docs/${encodeURIComponent(docId)}`;
}
