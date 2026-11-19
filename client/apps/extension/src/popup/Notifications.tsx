import { Button } from "@inklayer/ui/components/button";
import { cn } from "@inklayer/ui/lib/utils";
import { useCallback, useEffect, useState } from "react";
import { INBOX_TEXT, inboxActor, inboxItemUrl } from "@/lib/inbox-text";
import { send } from "@/lib/messages";
import type { Inbox, InboxItem } from "@/lib/notifications";
import { openInNewTab } from "./browser";

/** Recent notifications; opening one marks it read and opens it in the web app. */
export function Notifications() {
  const [box, setBox] = useState<Inbox | null>(null);
  const load = useCallback(
    () =>
      void send({ type: "notifications" })
        .then(setBox)
        .catch(() => setBox(null)),
    [],
  );
  useEffect(load, [load]);
  if (!box || box.items.length === 0) return null;

  const open = async (item: InboxItem) => {
    await send({ type: "notificationsRead", ids: [item.id] });
    await openInNewTab(inboxItemUrl(item, box.serverUrl));
  };
  const markAllRead = async () => {
    await send({ type: "notificationsRead" });
    load();
  };

  return (
    <section className="flex flex-col gap-1 border-t pt-3">
      <div className="flex items-center justify-between">
        <h2 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
          Notifications {box.unread > 0 && `(${box.unread})`}
        </h2>
        {box.unread > 0 && (
          <Button variant="link" size="sm" className="h-auto px-0" onClick={() => void markAllRead()}>
            Mark all read
          </Button>
        )}
      </div>
      <ul className="flex max-h-56 flex-col gap-1 overflow-y-auto">
        {box.items.map((item) => (
          <li key={item.id}>
            <NotificationButton item={item} onOpen={() => void open(item)} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function NotificationButton({ item, onOpen }: { item: InboxItem; onOpen: () => void }) {
  const who = inboxActor(item);
  const verb = INBOX_TEXT[item.kind] ?? item.kind;
  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn("w-full rounded-lg px-2 py-1.5 text-left hover:bg-muted", item.read && "opacity-70")}
    >
      <span className="block text-xs">
        {!item.read && (
          <span
            role="img"
            aria-label="unread"
            className="mr-1 inline-block size-1.5 rounded-full bg-primary align-middle"
          />
        )}
        {who ? (
          <>
            <strong title={item.actor?.fullName}>{who}</strong> {verb}
          </>
        ) : (
          verb
        )}
      </span>
      <span className="line-clamp-2 text-xs text-muted-foreground">{item.preview}</span>
    </button>
  );
}
