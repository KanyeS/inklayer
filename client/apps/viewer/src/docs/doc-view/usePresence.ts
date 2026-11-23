import type { EditorView } from "@codemirror/view";
import type { DocEditor } from "@inklayer/docs/editor";
import { PresenceLayer } from "@inklayer/overlay";
import { type RefObject, useEffect } from "react";
import type { AwarenessUser, DocSession } from "../collab";
import { presenceStatus } from "./docViewText";

type Pointer = { pos: number; dx: number; dy: number };

/**
 * Where someone's pointer is, in document coordinates, or null when they have none in the text.
 * Pointers are kept as a text position plus an offset, so they land on the same words at any window size.
 */
export function pointerAt(session: DocSession, view: EditorView | null | undefined, peerId: string) {
  if (!view) return null;
  for (const [clientId, state] of session.awareness.getStates()) {
    if (clientId === session.doc.clientID) continue;
    if ((state.user as AwarenessUser | undefined)?.peerId !== peerId) continue;
    const pointer = state.pointer as Pointer | null | undefined;
    const coords = pointer ? view.coordsAtPos(Math.min(pointer.pos, view.state.doc.length)) : null;
    return coords && pointer
      ? { x: coords.left + pointer.dx + window.scrollX, y: coords.top + pointer.dy + window.scrollY }
      : null;
  }
  return null;
}

/** Scrolls so that someone's pointer is in the middle of the screen, if they have one in the text. */
export function scrollToPointer(session: DocSession, view: EditorView | null | undefined, peerId: string): void {
  const at = pointerAt(session, view, peerId);
  if (at)
    window.scrollTo({
      left: Math.max(0, at.x - window.innerWidth / 2),
      top: Math.max(0, at.y - window.innerHeight / 2),
      behavior: "smooth",
    });
}

/**
 * Others' pointers, drawn with the same layer as live cursors on web pages. The layer's floating avatar pill is left
 * out: pinned to the window's top-right corner it covered the app bar's account menu (and so Sign out). The doc
 * header shows the status and who's here instead.
 */
export function usePresence(session: DocSession, editorRef: RefObject<DocEditor | null>, enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    const layer = new PresenceLayer(document, { avatars: false });

    /** Puts each person's pointer where it is in the text. */
    const place = () => {
      const view = editorRef.current?.view;
      for (const [clientId, state] of session.awareness.getStates()) {
        if (clientId === session.doc.clientID) continue;
        const peerId = (state.user as AwarenessUser | undefined)?.peerId;
        if (peerId) layer.placeAt(peerId, pointerAt(session, view, peerId));
      }
    };
    const sync = () => {
      layer.setStatus(presenceStatus(session.status), session.error);
      layer.setPeers([...session.peers.values()]);
      place();
    };
    let frame = 0;
    const placeSoon = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        place();
      });
    };

    const off = session.subscribe(sync);
    session.awareness.on("change", placeSoon);
    session.text.observe(placeSoon);
    window.addEventListener("resize", placeSoon);
    sync();
    return () => {
      off();
      session.awareness.off("change", placeSoon);
      session.text.unobserve(placeSoon);
      window.removeEventListener("resize", placeSoon);
      cancelAnimationFrame(frame);
      layer.destroy();
    };
  }, [session, editorRef, enabled]);
}
