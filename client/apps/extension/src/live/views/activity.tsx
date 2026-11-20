/** @jsxImportSource preact */
import { stopPropagation } from "@inklayer/overlay";
import type { ComponentChild } from "preact";
import type { ActivityItem, ActivityPage } from "../../lib/live";
import { personTitle } from "../../lib/people";
import { call, messageOf } from "../call";
import { docUrl, type PanelContext } from "../context";
import { timeAgo } from "../format";
import { ACTIVITY_VERBS, DOC_VERBS, KIND_LABELS } from "../labels";

type Kind = ActivityItem["kind"];

/** The activity log as shown in the panel: loaded only when the Activity tab is first opened. */
interface ActivityState {
  items: ActivityItem[];
  kinds: Kind[];
  nextBefore: string | null;
  thisSite: boolean;
  kind: Kind | null;
  loading: boolean;
  error: string;
}

const WEB_ADDRESS = /^https?:\/\//;

/** What an activity entry says happened, e.g. "edited a doc". Unknown actions show as they are. */
export function activityVerb(item: Pick<ActivityItem, "kind" | "action">): string {
  return (item.kind === "docs" ? DOC_VERBS[item.action] : ACTIVITY_VERBS[item.action]) ?? item.action;
}

/** The Activity tab: what happened on this site (comments) or everywhere (comments, docs, sign-ins, errors). */
export class ActivityView {
  readonly #ctx: PanelContext;
  #state: ActivityState | null = null;

  constructor(ctx: PanelContext) {
    this.#ctx = ctx;
  }

  /** Loads the log the first time the tab is opened; later visits keep what's loaded. */
  open(): void {
    if (this.#state) return;
    this.#state = {
      items: [],
      kinds: ["comments"],
      nextBefore: null,
      thisSite: true,
      kind: null,
      loading: false,
      error: "",
    };
    void this.#load(false);
  }

  /** Loads the first page of the log, or the next (older) page when `more` is true. */
  async #load(more: boolean): Promise<void> {
    const state = this.#state;
    if (!state || state.loading) return;
    state.loading = true;
    state.error = "";
    this.#ctx.render();
    try {
      const page = await call<ActivityPage>({
        type: "live.activity",
        thisSite: state.thisSite,
        ...(state.kind ? { kind: state.kind } : {}),
        ...(more && state.nextBefore ? { before: state.nextBefore } : {}),
      });
      state.items = more ? [...state.items, ...page.items] : page.items;
      state.kinds = page.kinds;
      state.nextBefore = page.nextBefore;
    } catch (e) {
      state.error = messageOf(e);
    }
    state.loading = false;
    this.#ctx.render();
  }

  /** The tab's content: filters, the list, and "Show older". Null until the tab is first opened. */
  parts(): ComponentChild {
    const state = this.#state;
    if (!state) return null;
    return (
      <>
        {this.#filters(state)}
        {state.error && <p className="error">{state.error}</p>}
        <ol className="list activity">
          {state.items.map((item) => this.#item(item))}
          {state.items.length === 0 && !state.loading && (
            <li className="empty">{state.thisSite ? "No activity on this site yet." : "No activity yet."}</li>
          )}
        </ol>
        {state.loading ? (
          <p className="hint">Loading…</p>
        ) : (
          state.nextBefore && (
            <button type="button" className="link" onClick={() => void this.#load(true)}>
              Show older
            </button>
          )
        )}
      </>
    );
  }

  /** "This site / Everywhere", and the kind of activity when looking everywhere. */
  #filters(state: ActivityState): ComponentChild {
    const onScope = (e: Event) => {
      state.thisSite = (e.currentTarget as HTMLSelectElement).value === "site";
      if (state.thisSite) state.kind = null; // site activity is comments only
      void this.#load(false);
    };
    const onKind = (e: Event) => {
      state.kind = ((e.currentTarget as HTMLSelectElement).value || null) as Kind | null;
      void this.#load(false);
    };
    return (
      <div className="row filters">
        <select title="Which activity to show" value={state.thisSite ? "site" : "all"} onChange={onScope}>
          <option value="site">This site ({location.host})</option>
          <option value="all">Everywhere</option>
        </select>
        {!state.thisSite && state.kinds.length > 1 && (
          <select title="Type of activity" value={state.kind ?? ""} onChange={onKind}>
            <option value="">All types</option>
            {state.kinds.map((k) => (
              <option key={k} value={k}>
                {KIND_LABELS[k]}
              </option>
            ))}
          </select>
        )}
      </div>
    );
  }

  #item(item: ActivityItem): ComponentChild {
    const who = item.actor?.displayName || item.actor?.email || "";
    const verb = activityVerb(item);
    // A comment on this page: clicking it shows the comment.
    const annotationId = item.annotationId;
    const here = annotationId !== null && this.#ctx.isOnThisPage(annotationId);
    const docHref =
      item.kind === "docs" && item.docId && item.organizationId && item.action !== "deleted"
        ? docUrl(this.#ctx.init.serverUrl, item.organizationId, item.docId)
        : null;
    return (
      <li
        key={item.id}
        className={`item activity-${item.kind}${here ? " here" : ""}`}
        title={here ? "Show this comment on the page" : undefined}
        onClick={here ? () => this.#ctx.showOnPage(annotationId) : undefined}
      >
        <div className="meta">
          {who && <strong title={item.actor ? personTitle(item.actor) : ""}>{who}</strong>}
          <span className={item.kind === "errors" ? "error" : ""}>{who ? ` ${verb}` : verb}</span>
          <span className="muted grow-left" title={new Date(item.occurredAt).toLocaleString()}>
            {timeAgo(item.occurredAt)}
          </span>
        </div>
        {item.detail && <p className={item.kind === "errors" ? "body error-detail" : "body"}>{item.detail}</p>}
        {docHref && (
          <div className="muted where">
            <a href={docHref} target="_blank" rel="noopener" onClick={stopPropagation}>
              Open doc
            </a>
          </div>
        )}
        {item.pageUrl && WEB_ADDRESS.test(item.pageUrl) && this.#where(item.pageUrl, item.projectName)}
      </li>
    );
  }

  /** The page an entry happened on, linked, and its project. */
  #where(pageUrl: string, projectName: string | null): ComponentChild {
    const url = new URL(pageUrl);
    return (
      <div className="muted where">
        <a href={pageUrl} target="_blank" rel="noopener noreferrer" title={pageUrl} onClick={stopPropagation}>
          {url.host + url.pathname}
        </a>
        {projectName ? ` · ${projectName}` : ""}
      </div>
    );
  }
}
