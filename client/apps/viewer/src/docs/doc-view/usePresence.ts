import type { DocEditor } from "@inklayer/docs/editor";
import { PresenceLayer } from "@inklayer/overlay";
import { type RefObject, useEffect } from "react";
import type { AwarenessUser, DocSession } from "../collab";
import { presenceStatus } from "./docViewText";

type Pointer = { pos: number; dx: number; dy: number };

/** Others' pointers and the avatar pill, drawn with the same layer as live cursors on web pages. */
export function usePresence(session: DocSession, editorRef: RefObject<DocEditor | null>, enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    const layer = new PresenceLayer(document);

    /** Puts each person's pointer where it is in the text (pointers are kept as a text position plus an offset). */
    const place = () => {
      const view = editorRef.current?.view;
      for (const [clientId, state] of session.awareness.getStates()) {
        if (clientId === session.doc.clientID) continue;
        const user = state.user as AwarenessUser | undefined;
        const pointer = state.pointer as Pointer | null | undefined;
        if (!user?.peerId) continue;
        const coords = view && pointer ? view.coordsAtPos(Math.min(pointer.pos, view.state.doc.length)) : null;
        const at =
          coords && pointer
            ? { x: coords.left + pointer.dx + window.scrollX, y: coords.top + pointer.dy + window.scrollY }
            : null;
        layer.placeAt(user.peerId, at);
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
