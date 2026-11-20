import { createEditor, type DocEditor } from "@inklayer/docs/editor";
import { type RefObject, useCallback, useEffect, useRef } from "react";
import { lookupPeople } from "@/lib/api";
import { navigate } from "@/lib/router";
import type { DocSession } from "../collab";
import { type DocTree, docPath } from "../docsApi";
import { FormatToolbar } from "../FormatToolbar";
import { createFromLink, resolveLink } from "../links";
import { loadComment } from "./comments";
import type { Mode } from "./DocHeader";
import { DocReading } from "./DocReading";
import { commentChipLabel } from "./docViewText";
import { usePresence } from "./usePresence";

type PersonName = { displayName: string; fullName: string };
type PersonLookup = PersonName & { id: string };

export interface DocBodyProps {
  orgId: string;
  session: DocSession;
  tree: DocTree;
  mode: Mode;
  canEdit: boolean;
  /** Comments the doc links to, for their chips' labels. */
  commentLinks: string[];
  onTag: (tag: string) => void;
  onTreeChanged: () => Promise<void>;
  liveCursors: boolean;
  /** People @mentioned in the doc. */
  people: PersonLookup[];
  /** Set to the editor while editing, for the formatting toolbar and the cheat sheet. */
  editorRef: RefObject<DocEditor | null>;
  onGuide: () => void;
}

/** The doc's text: the live editor (with the formatting toolbar) while editing, or the reading view. */
export function DocBody(props: DocBodyProps) {
  const { orgId, session, tree, mode, canEdit, commentLinks, onTreeChanged, editorRef } = props;
  const host = useRef<HTMLDivElement>(null);
  // Names for <@id> mentions: those in the doc, plus anyone picked from @ suggestions here.
  const names = useRef(new Map<string, PersonName>());
  for (const p of props.people) names.current.set(p.id.toLowerCase(), p);
  const treeRef = useRef(tree);
  treeRef.current = tree;
  const labels = useRef(new Map<string, string>());

  /** Opens a [[link]]: creates the doc first if it doesn't exist yet (and the user may). */
  const openLink = useCallback(
    async (target: string | null, resolvedId: string | null, newTab: boolean) => {
      let id = resolvedId;
      if (!id && target && canEdit) {
        id = (await createFromLink(orgId, target)).id;
        await onTreeChanged();
      }
      if (!id) return;
      if (newTab) window.open(docPath(orgId, id), "_blank", "noopener");
      else navigate(docPath(orgId, id));
    },
    [orgId, canEdit, onTreeChanged],
  );

  // Labels for comment chips.
  useEffect(() => {
    for (const id of commentLinks) {
      void loadComment(id).then((c) => {
        labels.current.set(id, commentChipLabel(c));
        editorRef.current?.refreshChips();
      });
    }
  }, [commentLinks, editorRef]);

  // The editor, with others' carets and pointers.
  useEffect(() => {
    if (mode !== "edit" || !host.current) return;
    const editor = createEditor(host.current, session, {
      titles: () => treeRef.current.docs,
      openLink: (link, newTab) =>
        void openLink(link.target, resolveLink(treeRef.current.docs, link)?.id ?? null, newTab),
      openComment: (id) => navigate(`/comments/${id}`),
      commentLabel: (id) => labels.current.get(id),
      people: async (q) => {
        const found = await lookupPeople(orgId, q).catch(() => []);
        for (const p of found) names.current.set(p.id.toLowerCase(), p);
        return found;
      },
      person: (id) => names.current.get(id),
      onPointer: (pointer) => session.awareness.setLocalStateField("pointer", pointer),
    });
    editorRef.current = editor;
    return () => {
      session.awareness.setLocalStateField("pointer", null);
      editor.destroy();
      editorRef.current = null;
    };
  }, [mode, session, openLink, orgId, editorRef]);

  useEffect(() => editorRef.current?.setEditable(canEdit), [canEdit, editorRef]);

  usePresence(session, editorRef, props.liveCursors);

  if (mode === "read") {
    return (
      <DocReading
        orgId={orgId}
        session={session}
        tree={tree}
        canEdit={canEdit}
        onTag={props.onTag}
        openLink={openLink}
        person={(id) => names.current.get(id)}
      />
    );
  }
  return (
    <>
      {canEdit && <FormatToolbar view={() => editorRef.current?.view} onGuide={props.onGuide} />}
      <div ref={host} className="doc-editor min-h-[50vh]" />
    </>
  );
}
