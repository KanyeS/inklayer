import type { EditorView } from "@codemirror/view";
import type { Awareness } from "y-protocols/awareness";
import type * as Y from "yjs";
import type { WikiLink } from "../docMarkdown";

/** What the docs editor needs from the app around it, and what it gives back. */

export interface PersonLookup {
  id: string;
  displayName: string;
  fullName: string;
}

export interface EditorHooks {
  /** People in the organisation whose name matches, for @ suggestions. */
  people?(query: string): Promise<PersonLookup[]>;
  /** Name and real name for a mentioned person, once known. */
  person?(id: string): { displayName: string; fullName: string } | undefined;
  /** Docs that [[ suggests. */
  titles(): { title: string; folder: string }[];
  openLink(link: WikiLink, newTab: boolean): void;
  openComment(id: string): void;
  /** A short label for a linked comment, once known. */
  commentLabel(id: string): string | undefined;
  /** A short label for a linked task ([[task:WEB-12]]), once known. */
  taskLabel?(key: string): string | undefined;
  openTask?(key: string, newTab: boolean): void;
  /** Tasks that [[task: suggests, by key or title. */
  tasks?(query: string): Promise<{ key: string; title: string; detail?: string }[]>;
  /** Where this person's pointer is in the text, for others to see; null when it leaves. */
  onPointer(pointer: { pos: number; dx: number; dy: number } | null): void;
}

export interface DocEditor {
  view: EditorView;
  setEditable(editable: boolean): void;
  /** Redraws comment chips after their labels load. */
  refreshChips(): void;
  destroy(): void;
}

/**
 * What the editor needs from a doc session: the shared text, everyone's carets (awareness), and whether this person may
 * edit. A live DocSession (the viewer's collab.ts) provides them; so can a local Y.Doc, as on the showcase site.
 */
export interface EditorSession {
  text: Y.Text;
  awareness: Awareness;
  canEdit: boolean;
}
