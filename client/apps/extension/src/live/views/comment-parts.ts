import { commentParts, encodeMentions, h, nothing, stopPropagation } from "@inklayer/overlay";
import type { TrackerChoice } from "../../lib/live";
import { personTitle } from "../../lib/people";
import { sizeDiffers } from "../../lib/viewportMatch";
import { call } from "../call";
import { docUrl, type PageAnnotation, type PanelContext } from "../context";
import { contextSummary, networkLine, timeAgo } from "../format";
import { TRACKER_NAMES } from "../labels";
import { loadScreenshot, paint } from "../page-io";
import { pickedIn, withSuggestions } from "../suggestions";

/** Where a reply box is: in a bubble next to the mark, or in the panel's list. Each keeps its own draft. */
export type ReplyPlace = "bubble" | "panel";

export interface CommentPartsOptions {
  /** Whether the user can comment (and so reply, resolve, create issues) in a project. */
  canCommentIn(projectId: string): boolean;
  /** The organisation a project belongs to, for doc and people suggestions. */
  organizationOf(projectId: string): string | null;
  /** Where an enlarged screenshot is shown. */
  lightboxParent: ParentNode;
  /** "Match their size" was pressed on a comment. */
  matchSize(annotationId: string, width: number, height: number | null, zoom: number | null): void;
}

const HTTPS = /^https:\/\//;

/**
 * The pieces a comment is shown with, shared by its entry in the panel and its bubble next to the mark: the text with
 * links, screenshot, page details, issues, replies and the reply box. Each returns an empty node when there's nothing
 * to show, so callers can append them unconditionally.
 */
export class CommentParts {
  readonly #ctx: PanelContext;
  readonly #options: CommentPartsOptions;
  /** Reply boxes, kept across re-renders so typing isn't lost. Keyed by place and comment id. */
  readonly #replyInputs = new Map<string, HTMLTextAreaElement>();
  /** Each project's connected issue trackers, loaded the first time a comment there is shown. */
  readonly #trackers = new Map<string, TrackerChoice[] | "loading">();

  constructor(ctx: PanelContext, options: CommentPartsOptions) {
    this.#ctx = ctx;
    this.#options = options;
  }

  /** Whether a reply is being written in a comment's bubble (so the bubble shouldn't close). */
  hasReplyDraft(place: ReplyPlace, annotationId: string): boolean {
    return Boolean(this.#replyInputs.get(`${place}:${annotationId}`)?.value.trim());
  }

  /** Text from a comment or one of its replies, with its @mentions and [[doc]] links. Built with text nodes only. */
  linkedText(text: string, a: PageAnnotation): HTMLParagraphElement {
    const { features, serverUrl } = this.#ctx.init;
    const p = h("p", { className: "body" });
    for (const part of commentParts(text, a.docLinks ?? [], a.people ?? [])) {
      if ("text" in part) {
        p.append(part.text);
      } else if ("mention" in part) {
        p.append(
          h("span", { className: "mention", textContent: `@${part.mention}`, title: part.fullName ?? part.mention }),
        );
      } else if (!features.docs) {
        p.append(`[[${part.shown}]]`); // with docs turned off, [[links]] are just text
      } else if (part.docId) {
        p.append(
          h("a", {
            className: "doclink",
            href: docUrl(serverUrl, a.organizationId, part.docId),
            target: "_blank",
            rel: "noopener",
            textContent: part.shown,
            title: `Open the doc "${part.link}"`,
            onclick: stopPropagation,
          }),
        );
      } else {
        p.append(
          h("span", {
            className: "doclink missing",
            textContent: part.shown,
            title: `There's no doc called "${part.link}" yet`,
          }),
        );
      }
    }
    return p;
  }

  /** The comment's own text. */
  body(a: PageAnnotation): HTMLParagraphElement {
    return this.linkedText(a.body, a);
  }

  /** The screenshot, drawn on a canvas (images from the extension can't be blocked by the page's content policy). Click to enlarge. */
  screenshot(a: PageAnnotation): Node {
    if (!this.#ctx.init.features.bugContext || !a.hasScreenshot) return nothing();
    const canvas = h("canvas", { className: "shot", title: "Screenshot when this was commented: click to enlarge" });
    void loadScreenshot(a.id).then((bitmap) => (bitmap ? paint(canvas, bitmap) : canvas.remove()));
    canvas.addEventListener("click", (e) => {
      e.stopPropagation();
      void loadScreenshot(a.id).then((bitmap) => bitmap && this.#enlarge(bitmap));
    });
    return canvas;
  }

  #enlarge(bitmap: ImageBitmap): void {
    const canvas = h("canvas", { className: "shot-large" });
    paint(canvas, bitmap);
    const box = h("div", { className: "lightbox", title: "Click to close", onclick: () => box.remove() }, canvas);
    this.#options.lightboxParent.append(box);
  }

  /** Issues made from the comment, and "Create issue" when the project has trackers connected. */
  issues(a: PageAnnotation): Node {
    if (!this.#ctx.init.features.issueTrackers) return nothing();
    const row = h("div", { className: "issues", onclick: stopPropagation });
    for (const issue of a.issues ?? []) {
      if (!HTTPS.test(issue.url)) continue;
      const name = TRACKER_NAMES[issue.kind];
      row.append(
        h("a", {
          className: `issue ${issue.state}`,
          href: issue.url,
          target: "_blank",
          rel: "noopener noreferrer",
          title: `${name} ${issue.key} (${issue.state})`,
          textContent: `${issue.state === "open" ? "●" : "✓"} ${name} ${issue.key}`,
        }),
      );
    }
    const trackers = this.#options.canCommentIn(a.projectId) ? this.#trackersIn(a.projectId) : [];
    const create = this.#createIssue(a, trackers);
    if (create) row.append(create);
    return row.childElementCount ? row : nothing();
  }

  /** A button (one tracker) or a menu (several) to create an issue from the comment; null with none connected. */
  #createIssue(a: PageAnnotation, trackers: TrackerChoice[]): HTMLElement | null {
    const createIn = (connectionId: string) =>
      this.#ctx.mutate(() => call({ type: "live.issue", annotationId: a.id, connectionId }));
    const [only] = trackers;
    if (trackers.length === 1 && only) {
      return h("button", {
        className: "link",
        textContent: "Create issue",
        title: `Create an issue in ${TRACKER_NAMES[only.kind]}: ${only.name}`,
        disabled: this.#ctx.busy,
        onclick: () => createIn(only.id),
      });
    }
    if (trackers.length < 2) return null;
    const pick = h(
      "select",
      { className: "issue-pick", title: "Create an issue from this comment", disabled: this.#ctx.busy },
      h("option", { value: "", textContent: "Create issue in…" }),
      ...trackers.map((t) => h("option", { value: t.id, textContent: `${TRACKER_NAMES[t.kind]}: ${t.name}` })),
    );
    pick.addEventListener("change", () => {
      if (pick.value) createIn(pick.value);
    });
    return pick;
  }

  #trackersIn(projectId: string): TrackerChoice[] {
    const known = this.#trackers.get(projectId);
    if (known === undefined) {
      this.#trackers.set(projectId, "loading");
      void call<TrackerChoice[]>({ type: "live.trackers", projectId })
        .then((choices) => {
          this.#trackers.set(projectId, choices);
          if (choices.length) this.#ctx.render();
        })
        .catch(() => this.#trackers.set(projectId, []));
    }
    return Array.isArray(known) ? known : [];
  }

  /** "Made at 390px wide · you're at 1440px", with a button to see the page at their size. */
  size(a: PageAnnotation): Node {
    const width = a.viewportWidth ?? 0;
    const height = a.context?.viewportHeight ?? null;
    if (!sizeDiffers(width, innerWidth)) return nothing();
    return h(
      "div",
      { className: "row size", onclick: stopPropagation },
      h("span", {
        className: "muted",
        textContent: `Made at ${width}px wide · you're at ${innerWidth}px`,
        title:
          "Pages often lay out differently at other widths, so the comment may be about a layout you aren't seeing.",
      }),
      h("button", {
        className: "link",
        textContent: "Match their size",
        disabled: this.#ctx.busy,
        title: height
          ? `Resize this window so the page is ${width}×${height}`
          : `Resize this window so the page is ${width}px wide`,
        onclick: () => this.#options.matchSize(a.id, width, height, a.context?.zoom ?? null),
      }),
    );
  }

  /** Browser, window size, the element, console errors and failed requests, folded away. */
  details(a: PageAnnotation): Node {
    const c = a.context;
    if (!this.#ctx.init.features.bugContext || !c) return nothing();
    const details = h(
      "details",
      { className: "context", onclick: stopPropagation },
      h("summary", { textContent: contextSummary(c) }),
    );
    if (c.selector) details.append(h("p", { className: "muted", textContent: `Element: ${c.selector}` }));
    if (c.console.length) {
      const lines = c.console.map((e) =>
        h("li", { className: e.level === "error" ? "error" : "", textContent: `${e.level}: ${e.message}` }),
      );
      details.append(h("ul", {}, ...lines));
    }
    if (c.network.length) {
      details.append(h("ul", {}, ...c.network.map((n) => h("li", { textContent: networkLine(n) }))));
    }
    return details;
  }

  /** The thread, oldest first, with "Delete" on replies the user may delete. */
  replies(a: PageAnnotation): HTMLUListElement {
    const list = h("ul", { className: "replies" });
    for (const r of a.replies ?? []) {
      const meta = h(
        "div",
        { className: "meta" },
        h("strong", { textContent: r.author.displayName || "Someone", title: personTitle(r.author) }),
        h("span", { className: "muted", textContent: ` ${timeAgo(r.createdAt)}` }),
      );
      if (r.canDelete) {
        const remove = (e: Event) => {
          e.stopPropagation();
          if (window.confirm("Delete this reply?")) {
            this.#ctx.mutate(() => call({ type: "live.replyDelete", id: r.id, version: r.version }));
          }
        };
        meta.append(
          " ",
          h("button", { className: "link danger", textContent: "Delete", disabled: this.#ctx.busy, onclick: remove }),
        );
      }
      list.append(h("li", { className: "reply" }, meta, this.linkedText(r.body, a)));
    }
    return list;
  }

  /** A box to reply in a comment's thread. Enter sends; Shift+Enter starts a new line; [[ suggests docs. */
  replyBox(a: PageAnnotation, place: ReplyPlace): HTMLElement {
    const key = `${place}:${a.id}`;
    let input = this.#replyInputs.get(key);
    if (!input) {
      input = this.#newReplyInput(a.id);
      this.#replyInputs.set(key, input);
    }
    return withSuggestions(input, () => this.#options.organizationOf(a.projectId), this.#ctx.init.features.docs);
  }

  #newReplyInput(annotationId: string): HTMLTextAreaElement {
    const box = h("textarea", {
      className: "reply-box",
      placeholder: "Reply… (Enter to send)",
      rows: 1,
      onclick: stopPropagation,
    });
    box.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" || e.shiftKey || e.isComposing) return;
      e.preventDefault();
      const body = encodeMentions(box.value.trim(), pickedIn(box));
      if (!body) return;
      box.value = "";
      this.#ctx.mutate(() =>
        call({ type: "live.reply", annotationId, body }).catch((error: unknown) => {
          box.value = body; // keep what they wrote
          throw error;
        }),
      );
    });
    return box;
  }
}
