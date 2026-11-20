import type { InboxResponse, NotificationResponse } from "@inklayer/api";
import { Button } from "@inklayer/ui/components/button";
import { Bell } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { timeAgo } from "@/lib/format";
import { navigate } from "@/lib/router";

type InboxItem = NotificationResponse;

const KIND_TEXT: Record<InboxItem["kind"], string> = {
  mention: "mentioned you",
  reply: "replied",
  resolved: "resolved your comment",
  issue_closed: "An issue linked to your comment was closed",
  issue_comment: "New comment on a linked issue",
};

/** Notifications that come from a tracker, not a person: no name in front. */
const FROM_TRACKER = new Set<InboxItem["kind"]>(["issue_closed", "issue_comment"]);

/** The in-app inbox: a bell with the unread count, and the recent notifications. Checks for new ones every minute. */
export function NotificationBell() {
  const [inbox, setInbox] = useState<InboxResponse>({ unread: 0, items: [] });
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  const load = useCallback(
    () =>
      void api
        .get("/api/notifications", { params: { query: { limit: 20 } } })
        .then(setInbox)
        .catch(() => undefined),
    [],
  );
  useEffect(() => {
    load();
    const timer = window.setInterval(() => document.visibilityState === "visible" && load(), 60_000);
    return () => window.clearInterval(timer);
  }, [load]);

  // Close when clicking elsewhere.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open]);

  const go = async (item: InboxItem) => {
    setOpen(false);
    if (!item.read) await api.post("/api/notifications/read", { body: { ids: [item.id] } }).catch(() => undefined);
    load();
    navigate(
      item.annotationId
        ? `/comments/${item.annotationId}`
        : item.docId
          ? `/orgs/${item.organizationId}/docs/${item.docId}`
          : "/",
    );
  };

  return (
    <div ref={box} className="relative">
      <Button
        variant="ghost"
        size="icon"
        className="relative size-9"
        aria-label={`Notifications${inbox.unread ? `, ${inbox.unread} unread` : ""}`}
        onClick={() => setOpen(!open)}
      >
        <Bell />
        {inbox.unread > 0 && (
          <span className="absolute -top-0.5 -right-0.5 min-w-4 rounded-full bg-primary px-1 text-[10px] leading-4 font-semibold text-primary-foreground">
            {inbox.unread > 99 ? "99+" : inbox.unread}
          </span>
        )}
      </Button>
      {open && (
        <div className="absolute right-0 z-20 mt-2 w-80 rounded-2xl border bg-popover p-2 text-popover-foreground shadow-xl">
          <div className="flex items-center justify-between px-2 pb-1">
            <span className="text-sm font-semibold">Notifications</span>
            {inbox.unread > 0 && (
              <Button
                variant="link"
                size="sm"
                className="h-auto px-0"
                onClick={async () => {
                  await api.post("/api/notifications/read", { body: { all: true } });
                  load();
                }}
              >
                Mark all read
              </Button>
            )}
          </div>
          {inbox.items.length === 0 ? (
            <p className="px-2 py-6 text-center text-sm text-muted-foreground">
              Nothing yet. You'll hear about mentions, replies and resolved comments here.
            </p>
          ) : (
            <ul className="max-h-96 overflow-y-auto">
              {inbox.items.map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    onClick={() => void go(item)}
                    className={`w-full rounded-xl px-2 py-2 text-left hover:bg-muted ${item.read ? "opacity-70" : ""}`}
                  >
                    <span className="block text-sm">
                      {!item.read && (
                        <span
                          role="img"
                          aria-label="unread"
                          className="mr-1.5 inline-block size-2 rounded-full bg-primary"
                        />
                      )}
                      {FROM_TRACKER.has(item.kind) ? (
                        KIND_TEXT[item.kind]
                      ) : (
                        <>
                          <strong title={item.actor?.fullName}>{item.actor?.displayName ?? "Someone"}</strong>{" "}
                          {KIND_TEXT[item.kind]}
                        </>
                      )}
                    </span>
                    <span className="mt-0.5 line-clamp-2 block text-sm text-muted-foreground">{item.preview}</span>
                    <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                      {item.where} · {timeAgo(item.createdAt)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
