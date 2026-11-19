import { useCallback, useMemo, useRef, useSyncExternalStore } from "react";
import type { DocSession } from "../collab";

/** Re-renders when the session's status, people or access change, and returns a snapshot of them. */
export function useSessionState(session: DocSession | null) {
  const version = useRef(0);
  const subscribe = useCallback(
    (listener: () => void) => {
      if (!session) return () => undefined;
      return session.subscribe(() => {
        version.current++;
        listener();
      });
    },
    [session],
  );
  const v = useSyncExternalStore(subscribe, () => version.current);
  return useMemo(
    () =>
      session
        ? {
            status: session.status,
            canEdit: session.canEdit,
            loaded: session.loaded,
            error: session.error,
            peers: [...session.peers.values()],
            v,
          }
        : null,
    [session, v],
  );
}
