/** @jsxImportSource preact */
import type { ComponentChild } from "preact";
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

  parts(): ComponentChild {
    const state = this.#state;
    const box = state?.data;
    const markAll = () =>
      void call({ type: "live.inboxRead" })
        .then(() => this.load())
        .catch((e: unknown) => this.#ctx.showError(messageOf(e)));
    return (
      <>
        <div className="row inbox-head">
          <strong>{this.unread ? `${this.unread} unread` : "All read"}</strong>
          {this.unread > 0 && (
            <button type="button" className="link" disabled={this.#ctx.busy} onClick={markAll}>
              Mark all read
            </button>
          )}
        </div>
        {state?.error && <p className="error">{state.error}</p>}
        <ol className="list inbox">
          {(box?.items ?? []).map((item) => this.#item(item, box?.serverUrl ?? ""))}
          {box?.items.length === 0 && (
            <li className="empty">
              Nothing yet. You'll hear here when someone mentions you, replies in your threads or resolves your
              comments.
            </li>
          )}
        </ol>
        {state?.loading && !box && <p className="hint">Loading…</p>}
      </>
    );
  }

  #item(item: InboxItem, serverUrl: string): ComponentChild {
    const verb = INBOX_TEXT[item.kind] ?? item.kind;
    const who = inboxActor(item);
    const annotationId = item.annotationId;
    const here = annotationId !== null && this.#ctx.isOnThisPage(annotationId);
    const open = () => {
      if (!item.read) void call({ type: "live.inboxRead", ids: [item.id] }).catch(() => undefined);
      if (here) return this.#ctx.showOnPage(annotationId);
      window.open(inboxItemUrl(item, serverUrl), "_blank", "noopener");
    };
    return (
      <li
        key={item.id}
        className={item.read ? "item read" : "item unread"}
        title={here ? "Show this comment on the page" : "Open in Inklayer"}
        onClick={open}
      >
        <div className="meta">
          {!item.read && <span className="unread-dot" role="img" aria-label="unread" />}
          {who && <strong title={item.actor?.fullName ?? ""}>{who}</strong>}
          <span>{who ? ` ${verb}` : verb}</span>
          <span className="muted grow-left" title={new Date(item.createdAt).toLocaleString()}>
            {timeAgo(item.createdAt)}
          </span>
        </div>
        <p className="body clamp">{item.preview}</p>
        {item.where && <div className="muted where">{here ? "On this page" : item.where}</div>}
      </li>
    );
  }
}
