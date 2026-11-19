import { h, stopPropagation } from "@inklayer/overlay";
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

  /** The tab's content: filters, the list, and "Show older". */
  parts(): Node[] {
    const state = this.#state;
    if (!state) return [];
    const parts: Node[] = [this.#filters(state)];
    if (state.error) parts.push(h("p", { className: "error", textContent: state.error }));
    const list = h("ol", { className: "list activity" });
    for (const item of state.items) list.append(this.#item(item));
    if (state.items.length === 0 && !state.loading) {
      const empty = state.thisSite ? "No activity on this site yet." : "No activity yet.";
      list.append(h("li", { className: "empty", textContent: empty }));
    }
    parts.push(list);
    if (state.loading) parts.push(h("p", { className: "hint", textContent: "Loading…" }));
    else if (state.nextBefore) {
      parts.push(h("button", { className: "link", textContent: "Show older", onclick: () => void this.#load(true) }));
    }
    return parts;
  }

  /** "This site / Everywhere", and the kind of activity when looking everywhere. */
  #filters(state: ActivityState): HTMLElement {
    const scope = h(
      "select",
      {
        title: "Which activity to show",
        onchange: () => {
          state.thisSite = scope.value === "site";
          if (state.thisSite) state.kind = null; // site activity is comments only
          void this.#load(false);
        },
      },
      h("option", { value: "site", textContent: `This site (${location.host})`, selected: state.thisSite }),
      h("option", { value: "all", textContent: "Everywhere", selected: !state.thisSite }),
    );
    const filters = h("div", { className: "row filters" }, scope);
    if (state.thisSite || state.kinds.length < 2) return filters;

    const kind = h(
      "select",
      {
        title: "Type of activity",
        onchange: () => {
          state.kind = (kind.value || null) as Kind | null;
          void this.#load(false);
        },
      },
      h("option", { value: "", textContent: "All types", selected: !state.kind }),
      ...state.kinds.map((k) => h("option", { value: k, textContent: KIND_LABELS[k], selected: state.kind === k })),
    );
    filters.append(kind);
    return filters;
  }

  #item(item: ActivityItem): HTMLLIElement {
    const who = item.actor?.displayName || item.actor?.email || "";
    const verb = activityVerb(item);
    const line = h(
      "div",
      { className: "meta" },
      who && h("strong", { textContent: who, title: item.actor ? personTitle(item.actor) : "" }),
      h("span", { className: item.kind === "errors" ? "error" : "", textContent: who ? ` ${verb}` : verb }),
      h("span", {
        className: "muted grow-left",
        textContent: timeAgo(item.occurredAt),
        title: new Date(item.occurredAt).toLocaleString(),
      }),
    );
    const li = h("li", { className: `item activity-${item.kind}` }, line);
    if (item.detail) {
      const className = item.kind === "errors" ? "body error-detail" : "body";
      li.append(h("p", { className, textContent: item.detail }));
    }
    if (item.kind === "docs" && item.docId && item.organizationId && item.action !== "deleted") {
      const href = docUrl(this.#ctx.init.serverUrl, item.organizationId, item.docId);
      li.append(
        h(
          "div",
          { className: "muted where" },
          h("a", { href, target: "_blank", rel: "noopener", textContent: "Open doc", onclick: stopPropagation }),
        ),
      );
    }
    if (item.pageUrl && WEB_ADDRESS.test(item.pageUrl)) li.append(this.#where(item.pageUrl, item.projectName));

    // A comment on this page: clicking it shows the comment.
    const annotationId = item.annotationId;
    if (annotationId && this.#ctx.isOnThisPage(annotationId)) {
      li.classList.add("here");
      li.title = "Show this comment on the page";
      li.onclick = () => this.#ctx.showOnPage(annotationId);
    }
    return li;
  }

  /** The page an entry happened on, linked, and its project. */
  #where(pageUrl: string, projectName: string | null): HTMLElement {
    const url = new URL(pageUrl);
    return h(
      "div",
      { className: "muted where" },
      h("a", {
        href: pageUrl,
        target: "_blank",
        rel: "noopener noreferrer",
        textContent: url.host + url.pathname,
        title: pageUrl,
        onclick: stopPropagation,
      }),
      projectName ? ` · ${projectName}` : "",
    );
  }
}
