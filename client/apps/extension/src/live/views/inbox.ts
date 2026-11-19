import { h } from "@inklayer/overlay";
import { INBOX_TEXT, inboxActor, inboxItemUrl } from "../../lib/inbox-text";
import type { Inbox, InboxItem } from "../../lib/notifications";
import { call, messageOf } from "../call";
import type { PanelContext } from "../context";
import { timeAgo } from "../format";

interface InboxState {
  data: Inbox | null;
  loading: boolean;
  error: string;
}

/**
 * The notifications tab: mentions, replies and resolved comments for you, newest first. A comment on this page opens
 * here; anything else in a new tab.
 */
export class InboxView {
  readonly #ctx: PanelContext;
  #state: InboxState | null = null;
  /** Unread notifications, kept up to date by the background's once-a-minute check (via storage). */
  unread = 0;

  constructor(ctx: PanelContext) {
    this.#ctx = ctx;
  }

  /** Whether the inbox has been opened and isn't loading now (so it can be refreshed). */
  get idle(): boolean {
    return this.#state !== null && !this.#state.loading;
  }

  async load(): Promise<void> {
    const previous = this.#state?.data ?? null;
    this.#state = { data: previous, loading: true, error: "" };
    this.#ctx.render();
    try {
      this.#state = { data: await call<Inbox>({ type: "live.inbox" }), loading: false, error: "" };
    } catch (e) {
      this.#state = { data: previous, loading: false, error: messageOf(e) };
    }
    this.#ctx.render();
  }

  parts(): Node[] {
    const state = this.#state;
    const box = state?.data;
    const head = h(
      "div",
      { className: "row inbox-head" },
      h("strong", { textContent: this.unread ? `${this.unread} unread` : "All read" }),
    );
    if (this.unread > 0) {
      head.append(
        h("button", {
          className: "link",
          textContent: "Mark all read",
          disabled: this.#ctx.busy,
          onclick: () =>
            void call({ type: "live.inboxRead" })
              .then(() => this.load())
              .catch((e: unknown) => this.#ctx.showError(messageOf(e))),
        }),
      );
    }
    const parts: Node[] = [head];
    if (state?.error) parts.push(h("p", { className: "error", textContent: state.error }));
    const list = h("ol", { className: "list inbox" });
    for (const item of box?.items ?? []) list.append(this.#item(item, box?.serverUrl ?? ""));
    if (box && box.items.length === 0) {
      list.append(
        h("li", {
          className: "empty",
          textContent:
            "Nothing yet. You'll hear here when someone mentions you, replies in your threads or resolves your comments.",
        }),
      );
    }
    parts.push(list);
    if (state?.loading && !box) parts.push(h("p", { className: "hint", textContent: "Loading…" }));
    return parts;
  }

  #item(item: InboxItem, serverUrl: string): HTMLLIElement {
    const verb = INBOX_TEXT[item.kind] ?? item.kind;
    const who = inboxActor(item);
    const annotationId = item.annotationId;
    const here = annotationId !== null && this.#ctx.isOnThisPage(annotationId);
    const li = h(
      "li",
      {
        className: item.read ? "item read" : "item unread",
        title: here ? "Show this comment on the page" : "Open in Inklayer",
      },
      h(
        "div",
        { className: "meta" },
        !item.read && h("span", { className: "unread-dot", role: "img", ariaLabel: "unread" }),
        who && h("strong", { textContent: who, title: item.actor?.fullName ?? "" }),
        h("span", { textContent: who ? ` ${verb}` : verb }),
        h("span", {
          className: "muted grow-left",
          textContent: timeAgo(item.createdAt),
          title: new Date(item.createdAt).toLocaleString(),
        }),
      ),
      h("p", { className: "body clamp", textContent: item.preview }),
    );
    if (item.where) li.append(h("div", { className: "muted where", textContent: here ? "On this page" : item.where }));
    li.onclick = () => {
      if (!item.read) void call({ type: "live.inboxRead", ids: [item.id] }).catch(() => undefined);
      if (here) return this.#ctx.showOnPage(annotationId);
      window.open(inboxItemUrl(item, serverUrl), "_blank", "noopener");
    };
    return li;
  }
}
